#include <gtest/gtest.h>

#include <algorithm>
#include <cmath>
#include <numbers>
#include <vector>

#include "rtai/resampler.hpp"

using namespace rtai;

namespace {
// Generate an interleaved stereo float sine at `freq` Hz for `frames` frames.
std::vector<float> stereo_sine(std::uint32_t rate, double freq, std::size_t frames,
                               float amp = 0.5f) {
    std::vector<float> out(frames * 2);
    for (std::size_t i = 0; i < frames; ++i) {
        const double t = static_cast<double>(i) / rate;
        const float v = amp * static_cast<float>(std::sin(2.0 * std::numbers::pi * freq * t));
        out[i * 2] = v;      // L
        out[i * 2 + 1] = v;  // R
    }
    return out;
}
} // namespace

TEST(Resampler, OutputLength48kTo16k) {
    PcmResampler r{48000, 2};
    // 4800 input frames (100 ms) -> ~1600 output samples (100 ms @ 16 kHz).
    auto in = stereo_sine(48000, 440.0, 4800);
    std::vector<std::int16_t> out(r.max_output_samples(4800));
    const std::size_t n = r.process(in, out);
    EXPECT_NEAR(static_cast<double>(n), 1600.0, 2.0);
}

TEST(Resampler, MonoDownmixAveragesChannels) {
    // Left = +1.0, Right = -1.0 -> mono average 0 -> PCM 0.
    PcmResampler r{48000, 2};
    std::vector<float> in(48000 * 2 / 10); // 100 ms
    for (std::size_t i = 0; i < in.size() / 2; ++i) {
        in[i * 2] = 1.0f;
        in[i * 2 + 1] = -1.0f;
    }
    std::vector<std::int16_t> out(r.max_output_samples(in.size() / 2));
    const std::size_t n = r.process(in, out);
    ASSERT_GT(n, 0u);
    for (std::size_t i = 0; i < n; ++i) {
        EXPECT_NEAR(out[i], 0, 1);
    }
}

TEST(Resampler, FullScaleAmplitudePreserved) {
    // Constant +1.0 on both channels -> mono +1.0 -> PCM near +32767.
    PcmResampler r{48000, 2};
    std::vector<float> in(48000 * 2 / 10, 1.0f);
    std::vector<std::int16_t> out(r.max_output_samples(in.size() / 2));
    const std::size_t n = r.process(in, out);
    ASSERT_GT(n, 0u);
    // Skip the very first sample (partial box) and check steady state.
    for (std::size_t i = 1; i < n; ++i) {
        EXPECT_GT(out[i], 32000);
    }
}

TEST(Resampler, HandlesNon48kRate) {
    PcmResampler r{44100, 2};
    auto in = stereo_sine(44100, 300.0, 4410); // 100 ms
    std::vector<std::int16_t> out(r.max_output_samples(4410));
    const std::size_t n = r.process(in, out);
    // 44100 -> 16000 over 100 ms ~ 1600 samples.
    EXPECT_NEAR(static_cast<double>(n), 1600.0, 3.0);
}

TEST(Resampler, StreamingChunksStitch) {
    // Feeding one 100 ms buffer vs two 50 ms buffers should yield ~same count.
    PcmResampler whole{48000, 2};
    auto in = stereo_sine(48000, 440.0, 4800);
    std::vector<std::int16_t> out_whole(whole.max_output_samples(4800));
    const std::size_t n_whole = whole.process(in, out_whole);

    PcmResampler split{48000, 2};
    std::vector<std::int16_t> out_split(whole.max_output_samples(4800) + 4);
    std::span<const float> first(in.data(), 2400 * 2);
    std::span<const float> second(in.data() + 2400 * 2, 2400 * 2);
    std::size_t n1 = split.process(first, std::span<std::int16_t>(out_split.data(), out_split.size()));
    std::size_t n2 = split.process(second, std::span<std::int16_t>(out_split.data() + n1, out_split.size() - n1));
    EXPECT_NEAR(static_cast<double>(n1 + n2), static_cast<double>(n_whole), 1.0);
}

TEST(Resampler, NoAllocationDuringProcess) {
    // Reusing the same output buffer across calls must not grow/allocate.
    PcmResampler r{48000, 2};
    auto in = stereo_sine(48000, 440.0, 4800);
    std::vector<std::int16_t> out(r.max_output_samples(4800));
    const auto* data_before = out.data();
    for (int i = 0; i < 100; ++i) {
        r.process(in, out);
    }
    EXPECT_EQ(out.data(), data_before); // buffer never reallocated
}

namespace {
// RMS of the PCM16 output (as float in [-1, 1]), skipping a warm-up prefix.
double rms_pcm(const std::vector<std::int16_t>& pcm, std::size_t n, std::size_t skip) {
    double acc = 0.0;
    std::size_t cnt = 0;
    for (std::size_t i = skip; i < n; ++i) {
        const double v = pcm[i] / 32767.0;
        acc += v * v;
        ++cnt;
    }
    return cnt ? std::sqrt(acc / static_cast<double>(cnt)) : 0.0;
}

// Output RMS / input RMS (in dB) for a stereo sine at `freq` through `rate`.
double gain_db(std::uint32_t rate, double freq) {
    PcmResampler r{rate, 2};
    const std::size_t frames = rate / 2; // 500 ms
    const float amp = 0.5f;
    auto in = stereo_sine(rate, freq, frames, amp);
    std::vector<std::int16_t> out(r.max_output_samples(frames));
    const std::size_t n = r.process(in, out);
    const double out_rms = rms_pcm(out, n, 400); // skip 25 ms
    const double in_rms = amp / std::sqrt(2.0);
    return 20.0 * std::log10(std::max(out_rms, 1e-9) / in_rms);
}
} // namespace

// Speech band survives on the integer and the non-integer ratios.
TEST(Resampler, PassbandFlat48k) {
    EXPECT_NEAR(gain_db(48000, 1000.0), 0.0, 0.3);
    EXPECT_NEAR(gain_db(48000, 3400.0), 0.0, 0.3);
    EXPECT_NEAR(gain_db(48000, 6000.0), 0.0, 0.5);
}

TEST(Resampler, PassbandFlat44k1) {
    EXPECT_NEAR(gain_db(44100, 1000.0), 0.0, 0.3);
    EXPECT_NEAR(gain_db(44100, 3400.0), 0.0, 0.3);
    EXPECT_NEAR(gain_db(44100, 6000.0), 0.0, 0.5);
}

TEST(Resampler, PassbandFlat24k) {
    // Bluetooth headsets in call mode (e.g. AirPods) often run at 24 kHz.
    EXPECT_NEAR(gain_db(24000, 1000.0), 0.0, 0.3);
    EXPECT_NEAR(gain_db(24000, 3400.0), 0.0, 0.3);
    EXPECT_NEAR(gain_db(24000, 6000.0), 0.0, 0.5);
}

// Content above 8 kHz must not fold back into the speech band.
TEST(Resampler, RejectsAliasing48k) {
    EXPECT_LT(gain_db(48000, 12000.0), -45.0); // would alias to 4 kHz
    EXPECT_LT(gain_db(48000, 9500.0), -45.0);  // would alias to 6.5 kHz
}

TEST(Resampler, RejectsAliasing44k1) {
    EXPECT_LT(gain_db(44100, 12000.0), -45.0);
    EXPECT_LT(gain_db(44100, 9500.0), -45.0);
}

TEST(Resampler, RejectsAliasing24k) {
    EXPECT_LT(gain_db(24000, 10000.0), -45.0); // would alias to 6 kHz
    EXPECT_LT(gain_db(24000, 11000.0), -45.0); // would alias to 5 kHz
}

TEST(Resampler, UpsamplesLowRateInput) {
    // 8 kHz narrowband input still produces the right length and keeps the tone.
    PcmResampler r{8000, 1};
    std::vector<float> in(800);
    for (std::size_t i = 0; i < in.size(); ++i)
        in[i] = 0.5f * static_cast<float>(std::sin(2.0 * std::numbers::pi * 1000.0 * i / 8000.0));
    std::vector<std::int16_t> out(r.max_output_samples(in.size()));
    const std::size_t n = r.process(in, out);
    EXPECT_NEAR(static_cast<double>(n), 1600.0, 2.0);
    EXPECT_NEAR(rms_pcm(out, n, 100), 0.5 / std::sqrt(2.0), 0.02);
}

TEST(Resampler, Native16kIsPassthrough) {
    PcmResampler r{16000, 1};
    std::vector<float> in{0.0f, 0.25f, -0.5f, 1.0f};
    std::vector<std::int16_t> out(r.max_output_samples(in.size()));
    ASSERT_EQ(r.process(in, out), 4u);
    EXPECT_EQ(out[1], static_cast<std::int16_t>(0.25f * 32767.0f));
    EXPECT_EQ(out[3], 32767);
}

TEST(Resampler, OddChunkSizesAreBitIdentical) {
    // Streaming in irregular chunks must give exactly the same samples as one
    // big call (WASAPI hands over buffers of varying size).
    auto in = stereo_sine(44100, 700.0, 44100 / 4);
    PcmResampler whole{44100, 2};
    std::vector<std::int16_t> a(whole.max_output_samples(in.size() / 2));
    const std::size_t na = whole.process(in, a);

    PcmResampler split{44100, 2};
    std::vector<std::int16_t> b(a.size() + 64);
    std::size_t nb = 0, off = 0;
    const std::size_t sizes[] = {1, 7, 441, 13, 1000, 2, 333};
    for (std::size_t k = 0; off < in.size() / 2; ++k) {
        const std::size_t len = std::min(sizes[k % 7], in.size() / 2 - off);
        std::span<const float> chunk(in.data() + off * 2, len * 2);
        std::vector<std::int16_t> tmp(split.max_output_samples(len));
        const std::size_t got = split.process(chunk, tmp);
        ASSERT_LE(got, tmp.size());
        std::copy(tmp.begin(), tmp.begin() + got, b.begin() + nb);
        nb += got;
        off += len;
    }
    ASSERT_EQ(na, nb);
    for (std::size_t i = 0; i < na; ++i) ASSERT_EQ(a[i], b[i]) << "at " << i;
}

TEST(Resampler, ResetRestartsCleanly) {
    auto in = stereo_sine(48000, 440.0, 4800);
    PcmResampler r{48000, 2};
    std::vector<std::int16_t> a(r.max_output_samples(4800)), b(a.size());
    const std::size_t na = r.process(in, a);
    r.reset();
    const std::size_t nb = r.process(in, b);
    ASSERT_EQ(na, nb);
    EXPECT_EQ(a, b);
}
