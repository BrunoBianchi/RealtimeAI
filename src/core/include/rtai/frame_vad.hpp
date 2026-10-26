// Pure core — local acoustic VAD over 20 ms int16 frames (Hot_Path).
//
// The numeric logic lives in the core (pure, no WASAPI dependency) so it is
// testable by PBT, mirroring the UserSpeechGate pattern. The capture thread
// instantiates one FrameVad per lane and feeds it 20 ms frames; the engine
// receives edges only via enqueue + notify, so on_frame() never blocks.
//
// Not thread-safe: on_frame() is called only on the capture thread.
#pragma once

#include <cmath>
#include <cstddef>
#include <cstdint>

namespace rtai {

// Tuning for the local end-of-speech detector. Defaults assume 16 kHz mono
// audio sliced into 20 ms frames (320 samples).
struct FrameVadConfig {
    int sample_rate_hz{16000};
    int frame_ms{20};                 // 320 samples @ 16 kHz
    int silence_frames{6};            // 6 * 20 ms = 110 ms (Req 1.3)
    int commit_silence_frames{6};     // 120 ms of absolute silence (Req 3.1/3.3) ~= 6 frames
    float noise_margin{1.6f};         // multiplier over the Noise_Floor
    float floor_attack{0.05f};        // smoothing when the floor rises
    float floor_release{0.002f};      // slow decay when it falls
};

// Result of feeding one frame.
struct FrameVadResult {
    double rms{0.0};                  // 0..32767 (Req 1.1)
    bool silent{false};               // rms < noise_floor * margin (Req 1.2)
    bool speculative_edge{false};     // 110 ms of continuous silence reached NOW (Req 1.3)
    bool commit_silence_edge{false};  // 120 ms of absolute silence reached NOW (Req 3.1/3.3)
};

class FrameVad {
public:
    explicit FrameVad(FrameVadConfig cfg = {}) noexcept : cfg_(cfg) {}

    // RMS of one frame of int16 samples (Req 1.1). Pure, no allocation.
    // Domain is [0, 32767]; an all-zero frame returns 0.
    static double frame_rms(const std::int16_t* samples, std::size_t n) noexcept {
        if (samples == nullptr || n == 0) return 0.0;
        double sum_sq = 0.0;
        for (std::size_t i = 0; i < n; ++i) {
            const double s = static_cast<double>(samples[i]);
            sum_sq += s * s;
        }
        return std::sqrt(sum_sq / static_cast<double>(n));
    }

    // Feed one 20 ms frame. Updates the rolling Noise_Floor (attack/release),
    // classifies silence (Req 1.2) and advances the 110 ms and 120 ms streaks,
    // emitting each edge only once per continuous streak.
    FrameVadResult on_frame(const std::int16_t* samples, std::size_t n) noexcept {
        FrameVadResult r{};
        r.rms = frame_rms(samples, n);

        // Silence classification against the current floor (Req 1.2). The
        // threshold is evaluated before the floor is updated so the decision
        // reflects the floor the caller observes via noise_floor().
        const double threshold = noise_floor_ * static_cast<double>(cfg_.noise_margin);
        r.silent = r.rms < threshold;

        // Rolling Noise_Floor: fast attack when the ambient level rises, slow
        // release when it falls, so brief silences don't collapse the floor.
        const double alpha = (r.rms > noise_floor_) ? static_cast<double>(cfg_.floor_attack)
                                                     : static_cast<double>(cfg_.floor_release);
        noise_floor_ += alpha * (r.rms - noise_floor_);

        if (r.silent) {
            ++silent_streak_;
            // 110 ms speculative edge: fire once when the streak first reaches
            // silence_frames (Req 1.3). The gate on the interim text is applied
            // by the caller on the capture thread.
            if (silent_streak_ >= cfg_.silence_frames && !spec_fired_) {
                r.speculative_edge = true;
                spec_fired_ = true;
            }
            // 120 ms commit edge: fire once when the streak first reaches
            // commit_silence_frames (Req 3.1/3.3).
            if (silent_streak_ >= cfg_.commit_silence_frames && !commit_fired_) {
                r.commit_silence_edge = true;
                commit_fired_ = true;
            }
        } else {
            // Any non-silent frame restarts both streaks and re-arms the edges.
            silent_streak_ = 0;
            spec_fired_ = false;
            commit_fired_ = false;
        }
        return r;
    }

    [[nodiscard]] double noise_floor() const noexcept { return noise_floor_; }

    // Called at the start of a new turn: zeroes the per-turn streak state while
    // keeping the learned Noise_Floor estimate.
    void reset() noexcept {
        silent_streak_ = 0;
        spec_fired_ = false;
        commit_fired_ = false;
    }

private:
    FrameVadConfig cfg_;
    double noise_floor_{200.0};       // conservative initial estimate
    int silent_streak_{0};            // consecutive silent frames
    bool spec_fired_{false};          // guards against re-firing the same streak
    bool commit_fired_{false};        // guards against re-firing the commit edge
};

} // namespace rtai
