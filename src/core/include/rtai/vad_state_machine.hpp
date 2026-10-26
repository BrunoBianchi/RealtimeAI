// Pure core — speech-activity hysteresis over raw VAD probabilities.
#pragma once

#include <cstdint>

namespace rtai {

// Converts a stream of per-window speech probabilities (from Silero or a fake)
// into speech-active decisions with hysteresis so we don't flap at the
// threshold and don't clip trailing words.
//
//   * Rises to "speech" after >= activation_windows consecutive windows above
//     start_threshold.
//   * Falls to "silence" only after >= hangover_windows consecutive windows
//     below stop_threshold (the hangover keeps the tail of a word).
//
// Separate start/stop thresholds give classic Schmitt-trigger behaviour.
struct VadConfig {
    float start_threshold{0.5f};   // prob above this counts toward activation
    float stop_threshold{0.35f};   // prob below this counts toward deactivation
    std::uint32_t activation_windows{1}; // windows above start before SPEECH
    std::uint32_t hangover_windows{12};  // ~384 ms at 32 ms/window before SILENCE
};

class VadStateMachine {
public:
    explicit VadStateMachine(VadConfig cfg = {}) noexcept : cfg_(cfg) {}

    // Feed one window's probability; returns true if speech is currently
    // active (frame should be forwarded to the transport). Also reports
    // whether this call caused a turn to *close* (speech -> silence edge),
    // which the pipeline uses to mark silence to the transport.
    struct Decision {
        bool speech_active{false};
        bool turn_closed{false}; // true exactly on the active->inactive edge
        bool turn_opened{false}; // true exactly on the inactive->active edge
    };

    Decision update(float probability) noexcept {
        Decision d{};
        if (speech_) {
            if (probability < cfg_.stop_threshold) {
                if (++below_ >= cfg_.hangover_windows) {
                    speech_ = false;
                    below_ = 0;
                    above_ = 0;
                    d.turn_closed = true;
                }
            } else {
                below_ = 0; // reset hangover on any above-stop window
            }
        } else {
            if (probability >= cfg_.start_threshold) {
                if (++above_ >= cfg_.activation_windows) {
                    speech_ = true;
                    above_ = 0;
                    below_ = 0;
                    d.turn_opened = true;
                }
            } else {
                above_ = 0;
            }
        }
        d.speech_active = speech_;
        return d;
    }

    void reset() noexcept {
        speech_ = false;
        above_ = 0;
        below_ = 0;
    }

    [[nodiscard]] bool speech_active() const noexcept { return speech_; }

private:
    VadConfig cfg_;
    bool speech_{false};
    std::uint32_t above_{0};
    std::uint32_t below_{0};
};

} // namespace rtai
