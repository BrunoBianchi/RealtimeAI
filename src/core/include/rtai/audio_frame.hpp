// Pure core types — no <windows.h>, no third-party deps.
#pragma once

#include <cstdint>
#include <span>

#include "rtai/audio_format.hpp"

namespace rtai {

// A non-owning view over a block of captured/resampled audio plus the source
// tag and a capture timestamp. The buffer is owned by a ring buffer / pool;
// AudioFrame never allocates and must not outlive the backing storage.
//
// On the hot path we pass these by value (cheap: a pointer + sizes + tag).
template <typename Sample>
class AudioFrameView {
public:
    AudioFrameView() = default;

    AudioFrameView(std::span<const Sample> samples, AudioSource source,
                   std::uint64_t capture_ticks) noexcept
        : samples_(samples), source_(source), capture_ticks_(capture_ticks) {}

    [[nodiscard]] std::span<const Sample> samples() const noexcept { return samples_; }
    [[nodiscard]] std::size_t frame_count() const noexcept { return samples_.size(); }
    [[nodiscard]] bool empty() const noexcept { return samples_.empty(); }
    [[nodiscard]] AudioSource source() const noexcept { return source_; }

    // High-resolution tick (QueryPerformanceCounter on Windows) captured as
    // close to device read as possible; used for end-to-end latency metrics.
    [[nodiscard]] std::uint64_t capture_ticks() const noexcept { return capture_ticks_; }

private:
    std::span<const Sample> samples_{};
    AudioSource source_{AudioSource::Microphone};
    std::uint64_t capture_ticks_{0};
};

using FloatFrame = AudioFrameView<float>;  // interleaved float as captured
using PcmFrame = AudioFrameView<std::int16_t>; // 16 kHz mono PCM16 for Deepgram

} // namespace rtai
