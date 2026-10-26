// Pure core — deterministic IVadGate for tests and demo mode.
#pragma once

#include <cmath>
#include <cstddef>
#include <vector>

#include "rtai/interfaces.hpp"

namespace rtai {

// Returns scripted probabilities in order, looping. If energy_mode is set,
// instead returns a probability derived from the window RMS (cheap, no model),
// which lets the file-demo path gate on actual loudness without ONNX.
class FakeVadGate : public IVadGate {
public:
    explicit FakeVadGate(std::size_t window = 512) : window_(window) {}

    // Scripted mode: supply a sequence of probabilities to return in order.
    void set_script(std::vector<float> probs) {
        script_ = std::move(probs);
        idx_ = 0;
        energy_mode_ = false;
    }

    // Energy mode: derive probability from normalized RMS of the window.
    void set_energy_mode(float threshold_rms = 0.01f) {
        energy_mode_ = true;
        energy_threshold_ = threshold_rms;
    }

    [[nodiscard]] std::size_t window_samples() const noexcept override { return window_; }

    [[nodiscard]] float process_window(std::span<const std::int16_t> window) override {
        if (energy_mode_) {
            double sum_sq = 0.0;
            for (std::int16_t s : window) {
                const double v = static_cast<double>(s) / 32768.0;
                sum_sq += v * v;
            }
            const double rms = window.empty() ? 0.0 : std::sqrt(sum_sq / window.size());
            // Map RMS to a pseudo-probability around the threshold.
            return rms >= energy_threshold_ ? 0.9f : 0.1f;
        }
        if (script_.empty()) return 0.0f;
        const float p = script_[idx_ % script_.size()];
        ++idx_;
        return p;
    }

    void reset() override { idx_ = 0; }

private:
    std::size_t window_;
    std::vector<float> script_;
    std::size_t idx_{0};
    bool energy_mode_{false};
    float energy_threshold_{0.01f};
};

} // namespace rtai
