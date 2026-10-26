// multilingual-e5 (ONNX, int8) sentence embedder for the hybrid RAG.
//
// Runs fully on the local CPU: tokenizer (SentencePiece Unigram from the
// model's tokenizer.json) -> ONNX Runtime -> mean pooling -> L2 norm.
// Queries use the "query: " prefix and passages "passage: ", as the model
// was trained. Inputs are truncated (64 tokens for a question, 256 for a
// chunk) because cost grows with length and the chunks are <= 600 bytes.
#pragma once

#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "rtai/dense_rag.hpp"

namespace rtai {

class OnnxE5Embedder final : public IEmbedder {
public:
    struct Options {
        std::string model_path;      // model_quantized.onnx (UTF-8 path)
        std::string tokenizer_path;  // tokenizer.json
        int threads{2};              // intra-op threads: small, the audio threads come first
        std::size_t max_query_tokens{64};
        std::size_t max_passage_tokens{256};
    };

    // nullptr (and *error) when the model or tokenizer cannot be loaded.
    static std::unique_ptr<OnnxE5Embedder> create(const Options& opts, std::string* error = nullptr);

    ~OnnxE5Embedder() override;

    [[nodiscard]] std::size_t dim() const noexcept override;
    [[nodiscard]] std::string model_id() const override;
    bool embed(std::string_view text, bool is_query, std::vector<float>& out) override;

private:
    OnnxE5Embedder();
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace rtai
