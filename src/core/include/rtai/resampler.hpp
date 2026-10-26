// Pure core — no <windows.h>, no allocation on the hot path.
#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <stdexcept>
#include <vector>

#include "rtai/audio_format.hpp"

namespace rtai {

// Converts interleaved IEEE-float input (any sample rate, any channel count)
// to 16 kHz mono signed-16-bit PCM.
//
// Design for the hot path:
//   * No allocation per call: the caller supplies the output buffer, and the
//     filter table + history ring are built once in the constructor.
//   * Stereo (or N-channel) -> mono downmix by averaging channels.
//   * Band-limited resampling with a Kaiser-windowed sinc FIR evaluated at the
//     exact fractional input position of every output sample (polyphase table
//     with linear interpolation between phases). This handles integer ratios
//     (48k -> 16k) and non-integer ones (44.1k, 24k from Bluetooth headsets in
//     call mode, 22.05k) with the same quality; the old box filter let a lot of
//     4-8 kHz energy alias back into the speech band on non-integer ratios.
//   * Cutoff at 90% of the lower Nyquist (7.2 kHz when downsampling to 16k),
//     16 zero crossings per side, ~59 dB stopband. Each output costs about
//     2 * 2 * N multiply-adds (N = 40 at 48 kHz), which is negligible at 16 kHz.
//   * Fixed group delay of N input frames (< 1 ms at 48 kHz). The history is
//     primed with the first sample so stream start and DC stay clean.
//   * 16 kHz input skips the filter entirely (downmix + convert only).
class PcmResampler {
public:
    static constexpr std::uint32_t kTargetRate = 16000;

    PcmResampler(std::uint32_t input_rate, std::uint16_t input_channels);

    [[nodiscard]] std::uint32_t input_rate() const noexcept { return input_rate_; }
    [[nodiscard]] std::uint16_t input_channels() const noexcept { return input_channels_; }

    // Worst-case number of output samples for a given number of input frames.
    [[nodiscard]] std::size_t max_output_samples(std::size_t input_frames) const noexcept {
        if (input_frames == 0) return 0;
        return static_cast<std::size_t>(static_cast<double>(input_frames) / step_) + 1;
    }

    // Convert `input` (interleaved float, input_channels_ per frame) into `out`
    // (mono PCM16 @ 16 kHz). Returns the number of PCM samples written.
    // `out` must have room for max_output_samples(input.size()/channels).
    // No allocation; carries filter history and output phase across calls so
    // streaming chunks stitch seamlessly (bit-identical to one big call).
    std::size_t process(std::span<const float> input, std::span<std::int16_t> out) noexcept;

    // Clear streaming state (history, phase, input/output counters).
    void reset() noexcept {
        in_count_ = 0;
        out_index_ = 0;
        primed_ = false;
    }

private:
    static constexpr std::uint32_t kPhases = 256;       // table resolution
    static constexpr double kZeroCrossings = 16.0;      // per side
    static constexpr double kCutoffFraction = 0.90;     // of the lower Nyquist
    static constexpr double kKaiserBeta = 5.5;          // ~59 dB stopband

    static std::int16_t to_pcm16(float sample) noexcept {
        // Clamp to [-1, 1] then scale. 32767 avoids asymmetric overflow at +1.
        if (sample > 1.0f) sample = 1.0f;
        if (sample < -1.0f) sample = -1.0f;
        return static_cast<std::int16_t>(sample * 32767.0f);
    }

    float filter_at(std::uint64_t pos, std::uint64_t frac_num) const noexcept;

    std::uint32_t input_rate_;
    std::uint16_t input_channels_;
    double step_;          // input frames per output sample
    bool passthrough_;     // input already at 16 kHz

    std::size_t half_{0};          // N: taps per side
    std::size_t taps_{0};          // 2N
    std::vector<float> table_;     // (kPhases + 1) rows x taps_, each row sums to 1
    std::vector<float> hist_;      // power-of-two ring of mono input samples
    std::uint64_t hist_mask_{0};

    // Streaming state.
    std::uint64_t in_count_{0};    // mono input frames pushed so far
    std::uint64_t out_index_{0};   // index of the next output sample
    bool primed_{false};
};

} // namespace rtai
