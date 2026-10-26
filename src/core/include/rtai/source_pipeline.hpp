// Pure core: wires one source lane end to end:
//   IAudioCaptureSource -> resampler -> VAD gate -> (gate open) -> transport
// and records per-stage latency. No <windows.h>; all collaborators injected.
//
// Threading: on_capture() runs on the capture thread (single producer per
// lane). The transport is non-blocking (DeepgramStream only enqueues), so the
// capture thread never waits on the network. on_transcript() runs on the
// transport's reader thread; the state shared between the two is atomic.
#pragma once

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <vector>

#include "rtai/interfaces.hpp"
#include "rtai/latency.hpp"
#include "rtai/resampler.hpp"
#include "rtai/vad_state_machine.hpp"

namespace rtai {

class SourcePipeline {
public:
    SourcePipeline(IAudioCaptureSource& capture, IVadGate& vad,
                   ITranscriptionTransport& transport, const IClock& clock,
                   MetricsRegistry& metrics, VadConfig vad_cfg = {})
        : capture_(capture), vad_(vad), transport_(transport), clock_(clock),
          metrics_(metrics), state_(vad_cfg) {
        window_ = vad_.window_samples();
        window_accum_.reserve(window_ * 2);
        set_preroll_windows(8); // ~256 ms at 512 samples/window
    }

    // Audio kept while the gate is closed and sent right before the first
    // speech window, so the onset of a word isn't clipped by VAD latency.
    // Call before start().
    void set_preroll_windows(std::size_t n) {
        preroll_cap_ = n;
        preroll_.assign(n * window_, 0);
        preroll_head_ = 0;
        preroll_count_ = 0;
    }

    // Route transcript events (and LocalTurnEnd markers) to the copilot/UI.
    // Call before start(); the sink is invoked from the transport's reader
    // thread and from the capture thread, so it must be thread-safe.
    void set_transcript_sink(std::function<void(const TranscriptEvent&)> sink) {
        transcript_sink_ = std::move(sink);
    }

    // Optional: called on the capture thread for every VAD window with the
    // gate state (speech active or not). Used to tell the copilot that the
    // user is talking (Pin on Speak) with the same Silero decision that feeds
    // Deepgram, so typing or fan noise doesn't count as speech. Must be
    // non-blocking. Call before start().
    void set_vad_listener(std::function<void(bool speech_active)> listener) {
        vad_listener_ = std::move(listener);
    }

    void start() {
        // Open the transport first so transcript callbacks are wired. It
        // connects in the background; audio is queued until it's up.
        transport_.open([this](const TranscriptEvent& ev) { on_transcript(ev); });

        // The resampler is built lazily on the capture thread because the
        // device format is only known once the stream is initialized there.
        capture_.start([this](std::span<const float> interleaved, std::uint64_t ticks) {
            on_capture(interleaved, ticks);
        });
    }

    void stop() {
        capture_.stop();
        transport_.close();
    }

    // Privacy pause: audio is dropped before it reaches the network. An open
    // turn is closed (Finalize) so the transcript doesn't hang. Thread-safe.
    void set_paused(bool paused) noexcept { paused_.store(paused); }
    [[nodiscard]] bool paused() const noexcept { return paused_.load(); }

    [[nodiscard]] AudioSource source() const noexcept { return capture_.source(); }

    // UI meter, any thread: input level 0..1 (dBFS -60..0, fast attack, slow
    // release) and whether the VAD currently considers it speech.
    [[nodiscard]] float level() const noexcept { return level_.load(std::memory_order_relaxed); }
    [[nodiscard]] bool speaking() const noexcept { return speaking_.load(std::memory_order_relaxed); }

private:
    // Called on the capture thread with interleaved float samples.
    void on_capture(std::span<const float> interleaved, std::uint64_t capture_ticks) {
        const AudioFormat fmt = capture_.format();
        // (Re)build the resampler on the first callback and whenever the
        // device format changes (e.g. after a default-device switch).
        if (!resampler_ || resampler_->input_rate() != fmt.sample_rate() ||
            resampler_->input_channels() != fmt.channels()) {
            resampler_.emplace(fmt.sample_rate(), fmt.channels());
            const std::size_t max_in_frames = fmt.sample_rate() / 10; // 100 ms
            pcm_scratch_.assign(resampler_->max_output_samples(max_in_frames) + window_, 0);
        }
        const std::size_t frames = interleaved.size() / fmt.channels();
        const std::size_t needed = resampler_->max_output_samples(frames);
        if (pcm_scratch_.size() < needed) pcm_scratch_.resize(needed); // oversized packet (rare)

        // 1) Resample to 16 kHz mono PCM16 (no allocation; into scratch).
        const std::size_t produced = resampler_->process(interleaved, pcm_scratch_);

        update_level(produced);

        if (paused_.load(std::memory_order_relaxed)) {
            level_.store(0.0f, std::memory_order_relaxed);
            speaking_.store(false, std::memory_order_relaxed);
            if (state_.speech_active()) {
                state_.reset();
                close_turn();
            }
            window_accum_.clear();
            preroll_count_ = 0;
            return;
        }

        // 2) Accumulate into VAD-window-sized chunks and run the gate.
        for (std::size_t i = 0; i < produced; ++i) {
            window_accum_.push_back(pcm_scratch_[i]);
            if (window_accum_.size() < window_) continue;

            const std::span<const std::int16_t> window(window_accum_.data(), window_);
            const float prob = vad_.process_window(window);

            // Latency: capture tick -> VAD decision for this window.
            if (capture_ticks != 0) {
                metrics_.record(Stage::CaptureToVad, clock_.ticks() - capture_ticks);
            }

            const auto decision = state_.update(prob);

            if (decision.turn_opened) flush_preroll();

            if (decision.speech_active) {
                // 3) Forward the window to the transport (non-blocking enqueue).
                const std::uint64_t t_send = clock_.ticks();
                transport_.send_audio(window);
                metrics_.record(Stage::VadToSend, clock_.ticks() - t_send);
            } else {
                push_preroll(window);
            }

            if (decision.turn_closed) close_turn();
            speaking_.store(decision.speech_active, std::memory_order_relaxed);
            if (vad_listener_) vad_listener_(decision.speech_active);

            window_accum_.clear();
        }
    }

    void update_level(std::size_t produced) {
        if (produced == 0) return;
        double sum = 0.0;
        for (std::size_t i = 0; i < produced; ++i) {
            const double v = pcm_scratch_[i] / 32768.0;
            sum += v * v;
        }
        const double rms = std::sqrt(sum / static_cast<double>(produced));
        const double db = rms > 1e-6 ? 20.0 * std::log10(rms) : -120.0;
        const float target = static_cast<float>(std::clamp((db + 60.0) / 60.0, 0.0, 1.0));
        const float prev = level_.load(std::memory_order_relaxed);
        const float next = target > prev ? target : prev * 0.85f + target * 0.15f;
        level_.store(next, std::memory_order_relaxed);
    }

    void push_preroll(std::span<const std::int16_t> window) {
        if (preroll_cap_ == 0) return;
        std::copy(window.begin(), window.end(),
                  preroll_.begin() + static_cast<std::ptrdiff_t>(preroll_head_ * window_));
        preroll_head_ = (preroll_head_ + 1) % preroll_cap_;
        if (preroll_count_ < preroll_cap_) ++preroll_count_;
    }

    void flush_preroll() {
        for (std::size_t k = 0; k < preroll_count_; ++k) {
            const std::size_t idx = (preroll_head_ + preroll_cap_ - preroll_count_ + k) % preroll_cap_;
            transport_.send_audio(std::span<const std::int16_t>(preroll_.data() + idx * window_, window_));
        }
        preroll_count_ = 0;
    }

    void close_turn() {
        turn_close_tick_.store(clock_.ticks());
        awaiting_final_.store(true);
        transport_.mark_silence(); // Deepgram Finalize, ordered after the audio
        if (transcript_sink_) {
            TranscriptEvent ev{};
            ev.source = capture_.source();
            ev.kind = TranscriptKind::LocalTurnEnd;
            ev.recv_ticks = clock_.ticks();
            transcript_sink_(ev);
        }
    }

    // Transport reader thread.
    void on_transcript(const TranscriptEvent& ev) {
        if (ev.kind == TranscriptKind::Transcript && ev.is_final && awaiting_final_.exchange(false)) {
            const std::uint64_t t = turn_close_tick_.load();
            if (t != 0) metrics_.record(Stage::TurnCloseToFinal, clock_.ticks() - t);
        }
        if (transcript_sink_) transcript_sink_(ev);
    }

    IAudioCaptureSource& capture_;
    IVadGate& vad_;
    ITranscriptionTransport& transport_;
    const IClock& clock_;
    MetricsRegistry& metrics_;

    VadStateMachine state_;
    std::optional<PcmResampler> resampler_; // built lazily on the capture thread
    std::size_t window_{512};

    std::vector<std::int16_t> pcm_scratch_;   // resampler output scratch
    std::vector<std::int16_t> window_accum_;  // builds VAD-sized windows

    std::vector<std::int16_t> preroll_;       // ring of preroll_cap_ windows
    std::size_t preroll_cap_{0};
    std::size_t preroll_head_{0};
    std::size_t preroll_count_{0};

    std::atomic<bool> paused_{false};
    std::atomic<float> level_{0.0f};
    std::atomic<bool> speaking_{false};
    std::atomic<std::uint64_t> turn_close_tick_{0};
    std::atomic<bool> awaiting_final_{false};

    std::function<void(const TranscriptEvent&)> transcript_sink_;
    std::function<void(bool)> vad_listener_;
};

} // namespace rtai
