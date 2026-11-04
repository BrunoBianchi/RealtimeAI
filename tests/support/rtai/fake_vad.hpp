// Test-only (tests/support) — deterministic IVadGate with scripted probabilities.
#pragma once

#include <cstddef>
#include <vector>

#include "rtai/interfaces.hpp"

namespace rtai {

// Returns scripted probabilities in order, looping. The loudness-based gate
// the app uses is EnergyVadGate (rtai/energy_vad.hpp).
class FakeVadGate : public IVadGate {
public:
    explicit FakeVadGate(std::size_t window = 512) : window_(window) {}

    // Scripted mode: supply a sequence of probabilities to return in order.
    void set_script(std::vector<float> probs) {
        script_ = std::move(probs);
        idx_ = 0;
    }

    [[nodiscard]] std::size_t window_samples() const noexcept override { return window_; }

    [[nodiscard]] float process_window(std::span<const std::int16_t> /*window*/) override {
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
};

} // namespace rtai
