#include "rtai/e5_embedder.hpp"

#include <onnxruntime_cxx_api.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <fstream>
#include <sstream>

#include "rtai/unigram_tokenizer.hpp"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace rtai {

namespace {

bool read_file(const std::string& path, std::string& out) {
#ifdef _WIN32
    const int n = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, nullptr, 0);
    std::wstring w(n > 0 ? static_cast<std::size_t>(n - 1) : 0, L'\0');
    if (n > 1) MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, w.data(), n);
    std::ifstream f(w, std::ios::binary);
#else
    std::ifstream f(path, std::ios::binary);
#endif
    if (!f) return false;
    std::ostringstream ss;
    ss << f.rdbuf();
    out = ss.str();
    return true;
}

std::uint64_t file_size(const std::string& path) {
#ifdef _WIN32
    const int n = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, nullptr, 0);
    std::wstring w(n > 0 ? static_cast<std::size_t>(n - 1) : 0, L'\0');
    if (n > 1) MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, w.data(), n);
    std::ifstream f(w, std::ios::binary | std::ios::ate);
#else
    std::ifstream f(path, std::ios::binary | std::ios::ate);
#endif
    return f ? static_cast<std::uint64_t>(f.tellg()) : 0;
}

} // namespace

struct OnnxE5Embedder::Impl {
    Ort::Env env{ORT_LOGGING_LEVEL_WARNING, "rtai_e5"};
    Ort::SessionOptions so;
    std::unique_ptr<Ort::Session> session;
    Ort::MemoryInfo mem{Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault)};
    UnigramTokenizer tok;
    Options opts;
    std::string id;
    std::size_t dim{0};
    bool pooled{false}; // output is already [1, dim]

    std::vector<std::string> in_names, out_names;
    std::vector<const char*> in_ptrs;
    const char* out_ptr{nullptr};
    std::vector<std::int64_t> ids, mask, types;
};

OnnxE5Embedder::OnnxE5Embedder() : impl_(std::make_unique<Impl>()) {}
OnnxE5Embedder::~OnnxE5Embedder() = default;

std::unique_ptr<OnnxE5Embedder> OnnxE5Embedder::create(const Options& opts, std::string* error) {
    auto fail = [&](std::string m) -> std::unique_ptr<OnnxE5Embedder> {
        if (error) *error = std::move(m);
        return nullptr;
    };
    std::unique_ptr<OnnxE5Embedder> e(new OnnxE5Embedder());
    Impl& im = *e->impl_;
    im.opts = opts;

    std::string tj;
    if (!read_file(opts.tokenizer_path, tj)) return fail("tokenizer not found: " + opts.tokenizer_path);
    auto tok = UnigramTokenizer::from_tokenizer_json(tj);
    if (!tok) return fail("tokenizer.json is not a Unigram tokenizer");
    im.tok = std::move(*tok);
    const std::uint64_t model_bytes = file_size(opts.model_path);
    if (model_bytes == 0) return fail("model not found: " + opts.model_path);

    try {
        im.so.SetIntraOpNumThreads(std::max(1, opts.threads));
        im.so.SetInterOpNumThreads(1);
        im.so.SetExecutionMode(ExecutionMode::ORT_SEQUENTIAL);
        im.so.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
#ifdef _WIN32
        const int n = MultiByteToWideChar(CP_UTF8, 0, opts.model_path.c_str(), -1, nullptr, 0);
        std::wstring w(n > 0 ? static_cast<std::size_t>(n - 1) : 0, L'\0');
        if (n > 1) MultiByteToWideChar(CP_UTF8, 0, opts.model_path.c_str(), -1, w.data(), n);
        im.session = std::make_unique<Ort::Session>(im.env, w.c_str(), im.so);
#else
        im.session = std::make_unique<Ort::Session>(im.env, opts.model_path.c_str(), im.so);
#endif
        Ort::AllocatorWithDefaultOptions alloc;
        for (std::size_t i = 0; i < im.session->GetInputCount(); ++i)
            im.in_names.emplace_back(im.session->GetInputNameAllocated(i, alloc).get());
        for (std::size_t i = 0; i < im.session->GetOutputCount(); ++i)
            im.out_names.emplace_back(im.session->GetOutputNameAllocated(i, alloc).get());
        for (const auto& s : im.in_names) {
            if (s != "input_ids" && s != "attention_mask" && s != "token_type_ids")
                return fail("unexpected model input: " + s);
            im.in_ptrs.push_back(s.c_str());
        }
        if (std::find(im.in_names.begin(), im.in_names.end(), "input_ids") == im.in_names.end())
            return fail("model has no input_ids input");
        // Prefer the token states (we pool them ourselves); accept a pooled output.
        std::size_t out_i = 0;
        for (std::size_t i = 0; i < im.out_names.size(); ++i) {
            if (im.out_names[i] == "last_hidden_state" || im.out_names[i] == "token_embeddings") { out_i = i; break; }
            if (im.out_names[i] == "sentence_embedding") out_i = i;
        }
        im.out_ptr = im.out_names[out_i].c_str();
        const auto shape = im.session->GetOutputTypeInfo(out_i).GetTensorTypeAndShapeInfo().GetShape();
        im.pooled = shape.size() == 2;
        if (!shape.empty() && shape.back() > 0) im.dim = static_cast<std::size_t>(shape.back());
    } catch (const Ort::Exception& ex) {
        return fail(std::string("onnxruntime: ") + ex.what());
    }
    im.id = "multilingual-e5/" + std::to_string(model_bytes) + "/" + std::to_string(im.tok.vocab_size());
    if (im.dim == 0) {
        std::vector<float> probe;
        if (!e->embed("probe", true, probe)) return fail("model did not produce an embedding");
        im.dim = probe.size();
    }
    return e;
}

std::size_t OnnxE5Embedder::dim() const noexcept { return impl_->dim; }
std::string OnnxE5Embedder::model_id() const { return impl_->id; }

bool OnnxE5Embedder::embed(std::string_view text, bool is_query, std::vector<float>& out) {
    Impl& im = *impl_;
    std::string input = is_query ? "query: " : "passage: ";
    input.append(text);
    im.ids = im.tok.encode(input, is_query ? im.opts.max_query_tokens : im.opts.max_passage_tokens);
    const std::int64_t len = static_cast<std::int64_t>(im.ids.size());
    im.mask.assign(im.ids.size(), 1);
    im.types.assign(im.ids.size(), 0);
    const std::array<std::int64_t, 2> shape{1, len};
    try {
        std::vector<Ort::Value> inputs;
        inputs.reserve(im.in_names.size());
        for (const auto& name : im.in_names) {
            std::vector<std::int64_t>& buf = name == "input_ids" ? im.ids : name == "attention_mask" ? im.mask : im.types;
            inputs.push_back(Ort::Value::CreateTensor<std::int64_t>(im.mem, buf.data(), buf.size(), shape.data(), shape.size()));
        }
        auto outputs = im.session->Run(Ort::RunOptions{nullptr}, im.in_ptrs.data(), inputs.data(), inputs.size(),
                                       &im.out_ptr, 1);
        if (outputs.empty() || !outputs[0].IsTensor()) return false;
        const auto oshape = outputs[0].GetTensorTypeAndShapeInfo().GetShape();
        const float* data = outputs[0].GetTensorData<float>();
        if (oshape.empty()) return false;
        const std::size_t d = static_cast<std::size_t>(oshape.back());
        out.assign(d, 0.0f);
        if (oshape.size() == 2) {
            std::copy(data, data + d, out.begin());
        } else if (oshape.size() == 3) {
            // Mean pooling over the tokens (single sequence: every mask bit is 1).
            const std::size_t t = static_cast<std::size_t>(oshape[1]);
            for (std::size_t i = 0; i < t; ++i)
                for (std::size_t j = 0; j < d; ++j) out[j] += data[i * d + j];
            const float inv = t ? 1.0f / static_cast<float>(t) : 0.0f;
            for (float& x : out) x *= inv;
        } else {
            return false;
        }
    } catch (const Ort::Exception&) {
        return false;
    }
    dense::l2_normalize(out);
    return true;
}

} // namespace rtai
