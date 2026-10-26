// WASAPI capture adapters (mic + loopback). Thin hardware I/O: pulls device
// audio in event-driven mode, converts the device format to interleaved float
// if needed, and invokes the frame callback on the capture thread.
//
// Robustness:
//   * COM and every WASAPI object live on the capture thread (MTA), so the
//     app's UI thread can be STA without cross-apartment surprises.
//   * AUDCLNT_E_DEVICE_INVALIDATED (headset unplugged, driver reset, format
//     change) -> the stream is rebuilt on the current default device.
//   * Default device switched in Windows -> follow it (IMMNotificationClient).
//   * Loopback produces no packets while nothing plays; the loop polls every
//     50 ms anyway, and the Deepgram stream keeps itself alive with KeepAlive.
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <thread>
#include <vector>

#include "rtai/audio_format.hpp"
#include "rtai/frame_vad.hpp"
#include "rtai/interfaces.hpp"
#include "rtai/resampler.hpp"

namespace rtai {

class CopilotEngine; // fed the FrameVad edges; forward-declared to avoid the dep

class WasapiCaptureSource : public IAudioCaptureSource {
public:
    // loopback=true captures the default render device's output (what others
    // play); loopback=false captures the default capture device (microphone).
    WasapiCaptureSource(AudioSource source, bool loopback);
    ~WasapiCaptureSource() override;

    [[nodiscard]] AudioFormat format() const override;
    [[nodiscard]] AudioSource source() const noexcept override { return source_; }

    // Throws std::runtime_error if the device can't be opened.
    void start(FrameCallback cb) override;
    void stop() override;

    // Human-readable device events (recoveries, switches). Set before start();
    // invoked on the capture thread, must not block.
    void set_status_callback(std::function<void(const std::string&)> cb) { status_cb_ = std::move(cb); }

    // Wire the local acoustic VAD (Hot_Path, Req 1.5/1.6). When set, the
    // capture thread resamples each delivered buffer to 16 kHz mono int16,
    // slices it into 20 ms frames and feeds a FrameVad; on a speculative edge
    // (110 ms of local silence) it calls engine->on_vad_speculate() and on a
    // commit edge (120 ms) engine->on_vad_commit_silence(). Those engine
    // methods only enqueue + notify, so the capture thread never blocks, and
    // the signal is independent of any Deepgram event. Set before start();
    // null (the default) disables the local VAD. The engine must outlive this
    // source (it does: lanes are torn down before the engine in main).
    void set_engine(CopilotEngine* engine) noexcept { engine_ = engine; }

    // Optional FrameVad tuning (e.g. a different silence threshold per lane).
    // Set before start(); defaults match the design (110 ms / 120 ms streaks).
    void set_frame_vad_config(const FrameVadConfig& cfg) noexcept { vad_cfg_ = cfg; }

    [[nodiscard]] std::uint64_t glitches() const noexcept { return glitches_.load(); }
    [[nodiscard]] std::uint32_t recoveries() const noexcept { return recoveries_.load(); }
    [[nodiscard]] std::string device_name() const;

private:
    void thread_main(std::promise<void> ready);
    void open_stream();       // device + client + event + capture service (capture thread)
    void close_stream();      // releases the stream objects (capture thread)
    bool reopen_stream();     // close + open + Start; false on failure
    long drain_packets();     // HRESULT
    void deliver(const unsigned char* data, std::uint32_t frames, unsigned long flags,
                 std::uint64_t ticks);
    void status(const std::string& msg);
    // Resample the just-delivered interleaved float buffer to 16 kHz mono
    // int16, slice it into 20 ms frames and feed the FrameVad, dispatching any
    // edge to the engine. Runs on the capture thread; no-op without an engine.
    void feed_frame_vad(std::span<const float> interleaved);

    AudioSource source_;
    bool loopback_;

    FrameCallback cb_;
    std::function<void(const std::string&)> status_cb_;
    std::thread thread_;
    std::atomic<bool> running_{false};

    // Format discovered on the capture thread; read via format().
    mutable std::mutex fmt_mu_;
    std::optional<AudioFormat> format_;
    std::string device_name_;
    std::string last_error_;  // capture thread only
    std::uint32_t device_rate_{0};
    std::uint16_t device_channels_{0};
    std::uint16_t device_bits_{32};
    bool device_is_float_{true};

    // Opaque WASAPI state kept in the .cpp (no COM headers here).
    struct Impl;
    std::unique_ptr<Impl> impl_;

    // Reusable conversion scratch to avoid per-callback allocation.
    std::vector<float> float_scratch_;

    // Local acoustic VAD (Hot_Path). All of this is touched only on the capture
    // thread. `engine_` is a non-owning pointer set before start(); when null
    // the whole FrameVad path is skipped. The resampler is built lazily on the
    // first buffer (and rebuilt after a device switch) to the actual device
    // format, mirroring SourcePipeline, so a 20 ms frame is exactly 320 samples
    // of 16 kHz mono int16 regardless of the device's native rate/channels.
    CopilotEngine* engine_{nullptr};
    FrameVadConfig vad_cfg_{};
    std::optional<FrameVad> vad_;
    std::optional<PcmResampler> vad_resampler_;
    std::vector<std::int16_t> vad_pcm_scratch_;  // resampler output (16 kHz mono)
    std::vector<std::int16_t> vad_frame_accum_;  // builds 20 ms (320-sample) frames
    std::size_t vad_frame_samples_{320};         // samples per 20 ms frame @ 16 kHz

    std::atomic<std::uint64_t> glitches_{0};
    std::atomic<std::uint32_t> recoveries_{0};
};

// Convenience named constructors.
inline std::unique_ptr<IAudioCaptureSource> make_mic_source() {
    return std::make_unique<WasapiCaptureSource>(AudioSource::Microphone, false);
}
inline std::unique_ptr<IAudioCaptureSource> make_loopback_source() {
    return std::make_unique<WasapiCaptureSource>(AudioSource::Loopback, true);
}

} // namespace rtai
