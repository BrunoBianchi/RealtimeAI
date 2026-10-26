// Silero VAD via ONNX Runtime C++ API. Implements IVadGate: feeds a 16 kHz
// mono PCM window and returns the speech probability. The Ort::Session and
// input/output tensors are created once and reused; recurrent state (h/c or
// the newer "state" tensor) is carried across calls. Hysteresis is NOT here —
// that lives in core's VadStateMachine.
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "rtai/interfaces.hpp"

namespace rtai {

class SileroVadGate : public IVadGate {
public:
    // model_path: path to silero_vad.onnx. window: samples per inference
    // (512 @ 16 kHz is Silero's expected frame). sample_rate fixed at 16 kHz.
    explicit SileroVadGate(const std::string& model_path, std::size_t window = 512,
                           std::uint32_t sample_rate = 16000);
    ~SileroVadGate() override;

    [[nodiscard]] std::size_t window_samples() const noexcept override { return window_; }
    [[nodiscard]] float process_window(std::span<const std::int16_t> window) override;
    void reset() override;

private:
    struct Impl;                 // hides Ort:: types from this header
    std::unique_ptr<Impl> impl_;
    std::size_t window_;
    std::uint32_t sample_rate_;
};

} // namespace rtai
