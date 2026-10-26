#include "rtai/silero_vad.hpp"

#include <onnxruntime_cxx_api.h>

#include <algorithm>
#include <array>
#include <stdexcept>

namespace rtai {

namespace {
constexpr std::size_t kContext = 64; // samples of left context @ 16 kHz (v5)
} // namespace

// Silero VAD (v4/v5 "silero_vad.onnx") I/O layout:
//   v5 inputs:  input [1, 64 + window] float, state [2, 1, 128] float, sr int64 [1]
//   v4 inputs:  input [1, window], h, c, sr (no context; see the h/c branch)
//   outputs: output [1, 1] float (speech prob), stateN [2, 1, 128] float
// v5 expects each 512-sample window prefixed with the last 64 samples of the
// previous one (see snakers4/silero-vad examples/cpp). Feeding the bare 512
// samples, as this adapter used to, degrades the probabilities and makes the
// gate flap. The exact names vary by version; we read them at load time.
struct SileroVadGate::Impl {
    Ort::Env env{ORT_LOGGING_LEVEL_WARNING, "rtai_silero"};
    Ort::SessionOptions opts;
    std::unique_ptr<Ort::Session> session;
    Ort::MemoryInfo mem{Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault)};

    // Reusable buffers.
    std::vector<float> input;        // [context + window] (v5) or [window] (v4)
    std::vector<float> context;      // last kContext samples of the previous window
    bool v5{false};                  // model has a "state" input
    std::vector<float> state;        // [2*1*128]
    std::vector<float> state_out;    // [2*1*128]
    std::int64_t sr{16000};

    // Names resolved from the model.
    std::vector<std::string> input_names;
    std::vector<std::string> output_names;
    std::vector<const char*> input_name_ptrs;
    std::vector<const char*> output_name_ptrs;
};

SileroVadGate::SileroVadGate(const std::string& model_path, std::size_t window,
                             std::uint32_t sample_rate)
    : impl_(std::make_unique<Impl>()), window_(window), sample_rate_(sample_rate) {
    impl_->opts.SetIntraOpNumThreads(1);
    impl_->opts.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);

#ifdef _WIN32
    std::wstring wpath(model_path.begin(), model_path.end());
    impl_->session = std::make_unique<Ort::Session>(impl_->env, wpath.c_str(), impl_->opts);
#else
    impl_->session = std::make_unique<Ort::Session>(impl_->env, model_path.c_str(), impl_->opts);
#endif

    Ort::AllocatorWithDefaultOptions alloc;
    const size_t n_in = impl_->session->GetInputCount();
    for (size_t i = 0; i < n_in; ++i) {
        auto name = impl_->session->GetInputNameAllocated(i, alloc);
        impl_->input_names.emplace_back(name.get());
    }
    const size_t n_out = impl_->session->GetOutputCount();
    for (size_t i = 0; i < n_out; ++i) {
        auto name = impl_->session->GetOutputNameAllocated(i, alloc);
        impl_->output_names.emplace_back(name.get());
    }
    for (auto& s : impl_->input_names) impl_->input_name_ptrs.push_back(s.c_str());
    for (auto& s : impl_->output_names) impl_->output_name_ptrs.push_back(s.c_str());

    impl_->v5 = std::find(impl_->input_names.begin(), impl_->input_names.end(), "state") !=
                impl_->input_names.end();
    impl_->context.assign(kContext, 0.0f);
    impl_->input.assign((impl_->v5 ? kContext : 0) + window_, 0.0f);
    impl_->state.assign(2 * 128, 0.0f);
    impl_->state_out.assign(2 * 128, 0.0f);
    impl_->sr = sample_rate_;
}

SileroVadGate::~SileroVadGate() = default;

void SileroVadGate::reset() {
    std::fill(impl_->state.begin(), impl_->state.end(), 0.0f);
    std::fill(impl_->context.begin(), impl_->context.end(), 0.0f);
}

float SileroVadGate::process_window(std::span<const std::int16_t> window) {
    if (window.size() < window_) return 0.0f;

    // int16 -> float [-1,1] into the reusable input buffer, after the
    // 64-sample context for v5 models.
    const std::size_t offset = impl_->v5 ? kContext : 0;
    if (impl_->v5) std::copy(impl_->context.begin(), impl_->context.end(), impl_->input.begin());
    for (std::size_t i = 0; i < window_; ++i) {
        impl_->input[offset + i] = static_cast<float>(window[i]) / 32768.0f;
    }
    if (impl_->v5) {
        std::copy(impl_->input.end() - static_cast<std::ptrdiff_t>(kContext), impl_->input.end(),
                  impl_->context.begin());
    }

    const std::array<std::int64_t, 2> in_shape{1, static_cast<std::int64_t>(impl_->input.size())};
    const std::array<std::int64_t, 3> state_shape{2, 1, 128};
    const std::array<std::int64_t, 1> sr_shape{1};

    std::vector<Ort::Value> inputs;
    inputs.reserve(impl_->input_names.size());

    // Bind by resolved input names so this works across Silero versions that
    // use input/state/sr (v5) vs input/h/c/sr (v4). We assume the common v5
    // layout: [input, state, sr]. If the model has 4 inputs (h/c), we feed the
    // first half of state as h and second as c.
    for (const auto& nm : impl_->input_names) {
        if (nm == "input") {
            inputs.push_back(Ort::Value::CreateTensor<float>(
                impl_->mem, impl_->input.data(), impl_->input.size(),
                in_shape.data(), in_shape.size()));
        } else if (nm == "sr") {
            inputs.push_back(Ort::Value::CreateTensor<std::int64_t>(
                impl_->mem, &impl_->sr, 1, sr_shape.data(), sr_shape.size()));
        } else if (nm == "state") {
            inputs.push_back(Ort::Value::CreateTensor<float>(
                impl_->mem, impl_->state.data(), impl_->state.size(),
                state_shape.data(), state_shape.size()));
        } else if (nm == "h" || nm == "c") {
            // v4 path: split state buffer into h (first 128) and c (next 128).
            const std::array<std::int64_t, 3> hc_shape{1, 1, 128};
            float* base = (nm == "h") ? impl_->state.data() : impl_->state.data() + 128;
            inputs.push_back(Ort::Value::CreateTensor<float>(
                impl_->mem, base, 128, hc_shape.data(), hc_shape.size()));
        } else {
            // Unknown input: feed zeros of the input window shape as a fallback.
            inputs.push_back(Ort::Value::CreateTensor<float>(
                impl_->mem, impl_->input.data(), impl_->input.size(),
                in_shape.data(), in_shape.size()));
        }
    }

    auto outputs = impl_->session->Run(
        Ort::RunOptions{nullptr}, impl_->input_name_ptrs.data(), inputs.data(),
        inputs.size(), impl_->output_name_ptrs.data(), impl_->output_name_ptrs.size());

    // First output is the speech probability. Carry recurrent state from any
    // output that matches the state size.
    float prob = 0.0f;
    if (!outputs.empty()) {
        const float* p = outputs[0].GetTensorData<float>();
        prob = p[0];
    }
    for (std::size_t i = 1; i < outputs.size(); ++i) {
        auto info = outputs[i].GetTensorTypeAndShapeInfo();
        if (info.GetElementCount() == impl_->state.size()) {
            const float* s = outputs[i].GetTensorData<float>();
            std::copy(s, s + impl_->state.size(), impl_->state.begin());
        } else if (info.GetElementCount() == 128) {
            // v4 h/c outputs; pack back into state halves in order.
            const float* s = outputs[i].GetTensorData<float>();
            float* dst = (i == 1) ? impl_->state.data() : impl_->state.data() + 128;
            std::copy(s, s + 128, dst);
        }
    }
    return prob;
}

} // namespace rtai
