#include "rtai/resampler.hpp"

#include <algorithm>
#include <cmath>

namespace rtai {

namespace {

constexpr double kPi = 3.14159265358979323846;

// Modified Bessel function of the first kind, order 0 (power series).
double bessel_i0(double x) {
    double sum = 1.0;
    double term = 1.0;
    const double q = (x * x) / 4.0;
    for (int k = 1; k < 64; ++k) {
        term *= q / (static_cast<double>(k) * static_cast<double>(k));
        sum += term;
        if (term < sum * 1e-17) break;
    }
    return sum;
}

} // namespace

PcmResampler::PcmResampler(std::uint32_t input_rate, std::uint16_t input_channels)
    : input_rate_(input_rate), input_channels_(input_channels) {
    if (input_rate == 0) throw std::invalid_argument("PcmResampler: input_rate 0");
    if (input_channels == 0) throw std::invalid_argument("PcmResampler: channels 0");
    step_ = static_cast<double>(input_rate_) / static_cast<double>(kTargetRate);
    passthrough_ = (input_rate_ == kTargetRate);
    if (passthrough_) return;

    // Cutoff in cycles per input sample: 90% of the lower of the two Nyquists.
    const double nyq = 0.5 * std::min(1.0, 1.0 / step_);
    const double fc = kCutoffFraction * nyq;
    // Half-width in input samples so that the sinc has kZeroCrossings per side.
    half_ = static_cast<std::size_t>(std::ceil(kZeroCrossings / (2.0 * fc)));
    taps_ = 2 * half_;

    const double i0_beta = bessel_i0(kKaiserBeta);
    const double n = static_cast<double>(half_);
    auto kernel = [&](double x) {
        const double ax = std::abs(x);
        if (ax >= n) return 0.0;
        const double r = ax / n;
        const double w = bessel_i0(kKaiserBeta * std::sqrt(1.0 - r * r)) / i0_beta;
        const double arg = 2.0 * fc * x;
        const double s = (std::abs(arg) < 1e-12) ? 1.0 : std::sin(kPi * arg) / (kPi * arg);
        return 2.0 * fc * s * w;
    };

    // Row p is for fractional offset frac = p / kPhases. Tap j multiplies the
    // input sample at (pos - 2N + 1 + j); its distance from the output centre
    // (pos + frac - N) is x = N - 1 - j + frac. Each row is normalised to unit
    // DC gain so constant input is reproduced exactly at every phase.
    table_.assign(static_cast<std::size_t>(kPhases + 1) * taps_, 0.0f);
    for (std::uint32_t p = 0; p <= kPhases; ++p) {
        const double frac = static_cast<double>(p) / kPhases;
        double sum = 0.0;
        std::vector<double> row(taps_);
        for (std::size_t j = 0; j < taps_; ++j) {
            row[j] = kernel(n - 1.0 - static_cast<double>(j) + frac);
            sum += row[j];
        }
        float* dst = &table_[static_cast<std::size_t>(p) * taps_];
        for (std::size_t j = 0; j < taps_; ++j) dst[j] = static_cast<float>(row[j] / sum);
    }

    std::size_t ring = 1;
    while (ring < taps_ + 1) ring <<= 1;
    hist_.assign(ring, 0.0f);
    hist_mask_ = ring - 1;
}

// FIR output whose window ends at input index `pos` (the newest sample used),
// with fractional offset frac_num / kTargetRate.
float PcmResampler::filter_at(std::uint64_t pos, std::uint64_t frac_num) const noexcept {
    const double fpos = static_cast<double>(frac_num) * kPhases / kTargetRate;
    std::uint32_t p0 = static_cast<std::uint32_t>(fpos);
    if (p0 >= kPhases) p0 = kPhases - 1;
    const float t = static_cast<float>(fpos - p0);
    const float* r0 = &table_[static_cast<std::size_t>(p0) * taps_];
    const float* r1 = r0 + taps_;

    // pos - 2N + 1 may be "negative" near stream start: unsigned wrap plus the
    // mask lands on ring slots still holding the primed first sample.
    const std::uint64_t base = pos + 1 - taps_;
    float a0 = 0.0f;
    float a1 = 0.0f;
    for (std::size_t j = 0; j < taps_; ++j) {
        const float x = hist_[(base + j) & hist_mask_];
        a0 += r0[j] * x;
        a1 += r1[j] * x;
    }
    return a0 + t * (a1 - a0);
}

std::size_t PcmResampler::process(std::span<const float> input,
                                  std::span<std::int16_t> out) noexcept {
    const std::uint16_t ch = input_channels_;
    const std::size_t frames = input.size() / ch;
    std::size_t written = 0;

    for (std::size_t f = 0; f < frames; ++f) {
        // Downmix this frame to mono.
        float mono = 0.0f;
        const std::size_t base = f * ch;
        for (std::uint16_t c = 0; c < ch; ++c) mono += input[base + c];
        mono /= static_cast<float>(ch);

        if (passthrough_) {
            if (written < out.size()) out[written++] = to_pcm16(mono);
            continue;
        }

        if (!primed_) {
            std::fill(hist_.begin(), hist_.end(), mono);
            primed_ = true;
        }
        const std::uint64_t n = in_count_++;
        hist_[n & hist_mask_] = mono;

        // Output m sits at input position m * step (exact rational arithmetic,
        // so no drift over long sessions) and is emitted once that sample has
        // arrived. The FIR is centred N frames earlier: that's the fixed delay.
        for (;;) {
            const std::uint64_t num = out_index_ * input_rate_;
            const std::uint64_t pos = num / kTargetRate;
            if (pos > n) break;
            const std::uint64_t frac = num % kTargetRate;
            if (written < out.size()) {
                out[written++] = to_pcm16(filter_at(pos, frac));
            }
            // If out is full (caller ignored max_output_samples) the sample is
            // dropped but the timeline stays consistent.
            ++out_index_;
        }
    }

    return written;
}

} // namespace rtai
