// Pure core — IAudioCaptureSource backed by a WAV file, streamed at real-time
// pace. Lets the whole pipeline run with no hardware. Supports PCM16 and
// IEEE-float WAV; emits interleaved float to match the capture contract.
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include "rtai/audio_format.hpp"
#include "rtai/interfaces.hpp"

namespace rtai {

// Monotonic tick clock abstraction is injected so capture timestamps use the
// same clock as the rest of the pipeline.
class WavFileCaptureSource : public IAudioCaptureSource {
public:
    // tick_now: returns current ticks; ticks_per_second: clock frequency.
    WavFileCaptureSource(std::string path, AudioSource source,
                         std::function<std::uint64_t()> tick_now,
                         std::uint64_t ticks_per_second,
                         bool realtime_pace = true);
    ~WavFileCaptureSource() override;

    [[nodiscard]] AudioFormat format() const override { return *format_; }
    [[nodiscard]] AudioSource source() const noexcept override { return source_; }

    void start(FrameCallback cb) override;
    void stop() override;

    // Block until the file has been fully streamed (demo/test convenience).
    void wait_until_done();

private:
    void load();      // parse WAV into float samples
    void run();       // streaming thread body

    std::string path_;
    AudioSource source_;
    std::function<std::uint64_t()> tick_now_;
    std::uint64_t ticks_per_second_;
    bool realtime_pace_;

    std::optional<AudioFormat> format_;
    std::vector<float> samples_;        // interleaved float
    std::uint32_t wav_sample_rate_{0};
    std::uint16_t wav_channels_{0};

    FrameCallback cb_;
    std::thread thread_;
    std::atomic<bool> running_{false};
    std::atomic<bool> done_{false};
};

} // namespace rtai
