// Pure core: SentencePiece-Unigram tokenizer (XLM-RoBERTa vocabulary, as
// used by multilingual-e5), loaded from a Hugging Face tokenizer.json.
//
// Follows the tokenizer.json pipeline of multilingual-e5-small:
//   normalizer:     whitespace collapsed (the precompiled NFKC map is not
//                   replicated: transcripts and extracted text are already
//                   composed, and the rare difference only changes a piece)
//   pre-tokenizer:  Metaspace ("▁" replaces spaces, prefix always added)
//   model:          Unigram, best segmentation by Viterbi over piece scores
//   post-processor: <s> ... </s>
#pragma once

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace rtai {

class UnigramTokenizer {
public:
    struct Piece {
        std::int32_t id;
        float score;
    };

    UnigramTokenizer() = default;

    // vocab[i] = (piece, score); the id of a piece is its position.
    UnigramTokenizer(std::vector<std::pair<std::string, float>> vocab, std::int32_t unk_id) : unk_id_(unk_id) {
        pieces_.reserve(vocab.size() * 2);
        float min_score = 0.0f;
        for (std::size_t i = 0; i < vocab.size(); ++i) {
            auto& [p, sc] = vocab[i];
            if (p.empty()) continue;
            min_score = std::min(min_score, sc);
            max_piece_bytes_ = std::max(max_piece_bytes_, p.size());
            pieces_.emplace(std::move(p), Piece{static_cast<std::int32_t>(i), sc});
        }
        unk_score_ = min_score - 10.0f;
        vocab_size_ = vocab.size();
        auto id_of = [&](const char* t, std::int32_t fallback) {
            auto it = pieces_.find(t);
            return it != pieces_.end() ? it->second.id : fallback;
        };
        bos_id_ = id_of("<s>", 0);
        eos_id_ = id_of("</s>", 2);
        pad_id_ = id_of("<pad>", 1);
    }

    [[nodiscard]] bool empty() const noexcept { return pieces_.empty(); }
    [[nodiscard]] std::size_t vocab_size() const noexcept { return vocab_size_; }
    [[nodiscard]] std::int32_t pad_id() const noexcept { return pad_id_; }

    // Token ids with <s> and </s>, at most `max_len` in total.
    [[nodiscard]] std::vector<std::int64_t> encode(std::string_view text, std::size_t max_len = 512) const {
        std::vector<std::int64_t> ids;
        ids.push_back(bos_id_);
        const std::size_t body_max = max_len >= 2 ? max_len - 2 : 0;
        // Split on whitespace; each word gets the "▁" prefix (Metaspace).
        std::size_t i = 0;
        std::string word;
        while (i < text.size() && ids.size() - 1 < body_max) {
            while (i < text.size() && is_space(static_cast<unsigned char>(text[i]))) ++i;
            if (i >= text.size()) break;
            std::size_t j = i;
            while (j < text.size() && !is_space(static_cast<unsigned char>(text[j]))) ++j;
            word.assign("\xE2\x96\x81"); // U+2581
            for (std::size_t k = i; k < j; ++k) {
                const unsigned char c = static_cast<unsigned char>(text[k]);
                if (c < 0x20 || c == 0x7F) continue; // control characters are dropped
                word.push_back(static_cast<char>(c));
            }
            encode_word(word, ids, body_max + 1);
            i = j;
        }
        if (ids.size() > body_max + 1) ids.resize(body_max + 1);
        ids.push_back(eos_id_);
        return ids;
    }

    // Reads the "model" section of a tokenizer.json (Unigram only).
    static std::optional<UnigramTokenizer> from_tokenizer_json(std::string_view json) {
        const std::size_t model = json.find("\"model\"");
        if (model == std::string_view::npos) return std::nullopt;
        std::int32_t unk = 3;
        if (const std::size_t u = json.find("\"unk_id\"", model); u != std::string_view::npos) {
            std::size_t p = json.find(':', u);
            if (p != std::string_view::npos) {
                ++p;
                while (p < json.size() && (json[p] == ' ' || json[p] == '\n' || json[p] == '\r' || json[p] == '\t')) ++p;
                if (p < json.size() && json[p] >= '0' && json[p] <= '9') unk = static_cast<std::int32_t>(std::strtol(json.data() + p, nullptr, 10));
            }
        }
        const std::size_t vk = json.find("\"vocab\"", model);
        if (vk == std::string_view::npos) return std::nullopt;
        std::size_t p = json.find('[', vk);
        if (p == std::string_view::npos) return std::nullopt;
        ++p;
        std::vector<std::pair<std::string, float>> vocab;
        vocab.reserve(260000);
        auto ws = [&] {
            while (p < json.size() && (json[p] == ' ' || json[p] == '\n' || json[p] == '\r' || json[p] == '\t' || json[p] == ',')) ++p;
        };
        for (;;) {
            ws();
            if (p >= json.size()) return std::nullopt;
            if (json[p] == ']') break;
            if (json[p] != '[') return std::nullopt;
            ++p;
            ws();
            std::string piece;
            if (!parse_string(json, p, piece)) return std::nullopt;
            ws();
            char* end = nullptr;
            const std::string num(json.substr(p, std::min<std::size_t>(32, json.size() - p)));
            const float sc = std::strtof(num.c_str(), &end);
            if (end == num.c_str()) return std::nullopt;
            p += static_cast<std::size_t>(end - num.c_str());
            ws();
            if (p >= json.size() || json[p] != ']') return std::nullopt;
            ++p;
            vocab.emplace_back(std::move(piece), sc);
        }
        if (vocab.empty()) return std::nullopt;
        return UnigramTokenizer(std::move(vocab), unk);
    }

private:
    static bool is_space(unsigned char c) noexcept { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; }

    static std::size_t utf8_len(unsigned char c) noexcept {
        if (c < 0x80) return 1;
        if ((c >> 5) == 0x6) return 2;
        if ((c >> 4) == 0xE) return 3;
        if ((c >> 3) == 0x1E) return 4;
        return 1;
    }

    static void put_utf8(std::string& out, std::uint32_t cp) {
        if (cp < 0x80) out.push_back(static_cast<char>(cp));
        else if (cp < 0x800) { out.push_back(static_cast<char>(0xC0 | (cp >> 6))); out.push_back(static_cast<char>(0x80 | (cp & 0x3F))); }
        else if (cp < 0x10000) { out.push_back(static_cast<char>(0xE0 | (cp >> 12))); out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F))); out.push_back(static_cast<char>(0x80 | (cp & 0x3F))); }
        else { out.push_back(static_cast<char>(0xF0 | (cp >> 18))); out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F))); out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F))); out.push_back(static_cast<char>(0x80 | (cp & 0x3F))); }
    }

    static bool parse_string(std::string_view s, std::size_t& p, std::string& out) {
        if (p >= s.size() || s[p] != '"') return false;
        ++p;
        auto hex4 = [&](std::uint32_t& v) {
            if (p + 4 > s.size()) return false;
            v = 0;
            for (int k = 0; k < 4; ++k) {
                const char c = s[p++];
                v <<= 4;
                if (c >= '0' && c <= '9') v |= static_cast<std::uint32_t>(c - '0');
                else if (c >= 'a' && c <= 'f') v |= static_cast<std::uint32_t>(c - 'a' + 10);
                else if (c >= 'A' && c <= 'F') v |= static_cast<std::uint32_t>(c - 'A' + 10);
                else return false;
            }
            return true;
        };
        while (p < s.size()) {
            const char c = s[p++];
            if (c == '"') return true;
            if (c != '\\') { out.push_back(c); continue; }
            if (p >= s.size()) return false;
            const char e = s[p++];
            switch (e) {
                case 'n': out.push_back('\n'); break;
                case 't': out.push_back('\t'); break;
                case 'r': out.push_back('\r'); break;
                case 'b': out.push_back('\b'); break;
                case 'f': out.push_back('\f'); break;
                case 'u': {
                    std::uint32_t cp = 0;
                    if (!hex4(cp)) return false;
                    if (cp >= 0xD800 && cp <= 0xDBFF && p + 6 <= s.size() && s[p] == '\\' && s[p + 1] == 'u') {
                        p += 2;
                        std::uint32_t lo = 0;
                        if (!hex4(lo)) return false;
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    }
                    put_utf8(out, cp);
                    break;
                }
                default: out.push_back(e); break; // \" \\ \/
            }
        }
        return false;
    }

    // Viterbi over byte positions that start a UTF-8 character.
    void encode_word(const std::string& w, std::vector<std::int64_t>& ids, std::size_t cap) const {
        const std::size_t n = w.size();
        constexpr float kNeg = -std::numeric_limits<float>::infinity();
        std::vector<float> best(n + 1, kNeg);
        std::vector<std::int32_t> best_id(n + 1, -1);
        std::vector<std::size_t> best_start(n + 1, 0);
        best[0] = 0.0f;
        std::string key;
        for (std::size_t i = 0; i < n; i += utf8_len(static_cast<unsigned char>(w[i]))) {
            if (best[i] == kNeg) continue;
            const std::size_t clen = std::min(utf8_len(static_cast<unsigned char>(w[i])), n - i);
            bool any = false;
            for (std::size_t len = clen; i + len <= n && len <= max_piece_bytes_;) {
                key.assign(w, i, len);
                if (auto it = pieces_.find(key); it != pieces_.end()) {
                    any = true;
                    const float sc = best[i] + it->second.score;
                    if (sc > best[i + len]) {
                        best[i + len] = sc;
                        best_id[i + len] = it->second.id;
                        best_start[i + len] = i;
                    }
                }
                if (i + len >= n) break;
                len += utf8_len(static_cast<unsigned char>(w[i + len]));
            }
            if (!any || best[i + clen] == kNeg) {
                const float sc = best[i] + unk_score_;
                if (sc > best[i + clen]) {
                    best[i + clen] = sc;
                    best_id[i + clen] = unk_id_;
                    best_start[i + clen] = i;
                }
            }
        }
        std::vector<std::int32_t> rev;
        for (std::size_t e = n; e > 0;) {
            rev.push_back(best_id[e]);
            e = best_start[e];
        }
        // Consecutive unknowns become one <unk> (fuse_unk).
        std::int32_t prev = -2;
        for (auto it = rev.rbegin(); it != rev.rend(); ++it) {
            if (*it == unk_id_ && prev == unk_id_) continue;
            if (ids.size() >= cap) return;
            ids.push_back(*it);
            prev = *it;
        }
    }

    std::unordered_map<std::string, Piece> pieces_;
    std::size_t max_piece_bytes_{1};
    std::size_t vocab_size_{0};
    std::int32_t unk_id_{3};
    std::int32_t bos_id_{0};
    std::int32_t eos_id_{2};
    std::int32_t pad_id_{1};
    float unk_score_{-100.0f};
};

} // namespace rtai
