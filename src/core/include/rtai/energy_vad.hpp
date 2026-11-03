// Pure core — loudness-based IVadGate, the fallback when Silero is not
// available (lean build, model missing or [vad] = energia). No model, O(n)
// per window.
#pragma once

#include <cmath>
#include <cstddef>

#include "rtai/interfaces.hpp"

namespace rtai {

// Speech probability from the window's normalized RMS: 0.9 at or above the
// threshold, 0.1 below it, so the VAD state machine's hysteresis still applies.
class EnergyVadGate : public IVadGate {
public:
    explicit EnergyVadGate(std::size_t window = 512, float threshold_rms = 0.01f)
        : window_(window), threshold_(threshold_rms) {}

    [[nodiscard]] std::size_t window_samples() const noexcept override { return window_; }

    [[nodiscard]] float process_window(std::span<const std::int16_t> window) override {
        if (window.empty()) return 0.1f;
        double sum_sq = 0.0;
        for (std::int16_t s : window) {
            const double v = static_cast<double>(s) / 32768.0;
            sum_sq += v * v;
        }
        const double rms = std::sqrt(sum_sq / static_cast<double>(window.size()));
        return rms >= threshold_ ? 0.9f : 0.1f;
    }

    void reset() override {}

private:
    std::size_t window_;
    float threshold_;
};

} // namespace rtai
