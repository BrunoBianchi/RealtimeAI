// Pure core: small UTF-8 helpers shared by the copilot (question detection,
// keyword matching), the session log and the overlay. No <windows.h>.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace rtai::text {

// Length of the UTF-8 sequence starting with lead byte `c`, or 0 if `c` is not
// a valid lead byte.
inline std::size_t utf8_seq_len(unsigned char c) noexcept {
    if (c < 0x80) return 1;
    if (c >= 0xC2 && c <= 0xDF) return 2;
    if (c >= 0xE0 && c <= 0xEF) return 3;
    if (c >= 0xF0 && c <= 0xF4) return 4;
    return 0;
}

// Replaces invalid UTF-8 sequences with U+FFFD so the text is always safe to
// put in JSON requests and to convert to UTF-16 for DirectWrite.
inline std::string sanitize_utf8(std::string_view in) {
    std::string out;
    out.reserve(in.size());
    std::size_t i = 0;
    while (i < in.size()) {
        const auto c = static_cast<unsigned char>(in[i]);
        const std::size_t n = utf8_seq_len(c);
        bool ok = n != 0 && i + n <= in.size();
        if (ok && n > 1) {
            for (std::size_t k = 1; k < n; ++k) {
                const auto cc = static_cast<unsigned char>(in[i + k]);
                if ((cc & 0xC0) != 0x80) { ok = false; break; }
            }
            if (ok) {
                const auto c1 = static_cast<unsigned char>(in[i + 1]);
                // Reject overlongs and surrogates.
                if (c == 0xE0 && c1 < 0xA0) ok = false;
                if (c == 0xED && c1 >= 0xA0) ok = false;
                if (c == 0xF0 && c1 < 0x90) ok = false;
                if (c == 0xF4 && c1 >= 0x90) ok = false;
            }
        }
        if (ok) {
            out.append(in.substr(i, n));
            i += n;
        } else {
            out += "\xEF\xBF\xBD";
            ++i;
        }
    }
    return out;
}

// Lowercases ASCII and folds Latin-1 accented letters (UTF-8 C3 80..C3 BF) to
// their ASCII base, e.g. "Você Já ORÇAMENTO?" -> "voce ja orcamento?".
// Other bytes pass through unchanged. Used only for matching, never display.
inline std::string fold(std::string_view in) {
    // Index = code point - 0xC0, for U+00C0..U+00FF.
    static const char* const kFold[64] = {
        "a", "a", "a", "a", "a", "a", "ae", "c", "e", "e", "e", "e", "i", "i", "i", "i",
        "d", "n", "o", "o", "o", "o", "o", "x", "o", "u", "u", "u", "u", "y", "th", "ss",
        "a", "a", "a", "a", "a", "a", "ae", "c", "e", "e", "e", "e", "i", "i", "i", "i",
        "d", "n", "o", "o", "o", "o", "o", "/", "o", "u", "u", "u", "u", "y", "th", "y",
    };
    std::string out;
    out.reserve(in.size());
    for (std::size_t i = 0; i < in.size(); ++i) {
        const auto c = static_cast<unsigned char>(in[i]);
        if (c < 0x80) {
            out.push_back((c >= 'A' && c <= 'Z') ? static_cast<char>(c - 'A' + 'a')
                                                 : static_cast<char>(c));
        } else if (c == 0xC3 && i + 1 < in.size()) {
            const auto c1 = static_cast<unsigned char>(in[i + 1]);
            if (c1 >= 0x80 && c1 <= 0xBF) {
                out += kFold[c1 - 0x80];
                ++i;
            } else {
                out.push_back(static_cast<char>(c));
            }
        } else {
            out.push_back(static_cast<char>(c));
        }
    }
    return out;
}

// Number of code points in a UTF-8 string (continuation bytes skipped).
inline std::size_t utf8_length(std::string_view s) noexcept {
    std::size_t n = 0;
    for (unsigned char c : s) {
        if ((c & 0xC0) != 0x80) ++n;
    }
    return n;
}

inline bool is_space(char c) noexcept {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v';
}

inline std::string trim(std::string_view s) {
    std::size_t b = 0, e = s.size();
    while (b < e && is_space(s[b])) ++b;
    while (e > b && is_space(s[e - 1])) --e;
    return std::string(s.substr(b, e - b));
}

inline std::size_t word_count(std::string_view s) {
    std::size_t n = 0;
    bool in_word = false;
    for (char c : s) {
        if (is_space(c)) {
            in_word = false;
        } else if (!in_word) {
            in_word = true;
            ++n;
        }
    }
    return n;
}

// Keeps at most `max_bytes` from the start, cutting on a code point boundary.
inline std::string truncate_utf8(std::string_view s, std::size_t max_bytes) {
    if (s.size() <= max_bytes) return std::string(s);
    std::size_t cut = max_bytes;
    while (cut > 0 && (static_cast<unsigned char>(s[cut]) & 0xC0) == 0x80) --cut;
    return std::string(s.substr(0, cut));
}

// Keeps at most `max_bytes` from the end, starting on a code point boundary.
inline std::string tail_utf8(std::string_view s, std::size_t max_bytes) {
    if (s.size() <= max_bytes) return std::string(s);
    std::size_t start = s.size() - max_bytes;
    while (start < s.size() && (static_cast<unsigned char>(s[start]) & 0xC0) == 0x80) ++start;
    return std::string(s.substr(start));
}

inline bool is_word_char(char c) noexcept {
    const auto u = static_cast<unsigned char>(c);
    return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || u >= 0x80;
}

// Whole-word search inside already-folded text. `needle` may contain spaces
// ("por que"); boundaries are checked only at its ends.
inline bool contains_word(std::string_view folded_text, std::string_view needle) {
    if (needle.empty()) return false;
    std::size_t pos = 0;
    while ((pos = folded_text.find(needle, pos)) != std::string_view::npos) {
        const bool left_ok = pos == 0 || !is_word_char(folded_text[pos - 1]);
        const std::size_t end = pos + needle.size();
        const bool right_ok = end >= folded_text.size() || !is_word_char(folded_text[end]);
        if (left_ok && right_ok) return true;
        pos += 1;
    }
    return false;
}

inline bool starts_with_word(std::string_view folded_text, std::string_view word) {
    if (folded_text.size() < word.size()) return false;
    if (folded_text.compare(0, word.size(), word) != 0) return false;
    return folded_text.size() == word.size() || !is_word_char(folded_text[word.size()]);
}

// Splits on a single-character separator and trims each piece; drops empties.
inline std::vector<std::string> split_list(std::string_view s, char sep = ',') {
    std::vector<std::string> out;
    std::size_t start = 0;
    while (start <= s.size()) {
        std::size_t end = s.find(sep, start);
        if (end == std::string_view::npos) end = s.size();
        std::string piece = trim(s.substr(start, end - start));
        if (!piece.empty()) out.push_back(std::move(piece));
        start = end + 1;
    }
    return out;
}

// Joins a and b with a single space, trimming both.
inline std::string join_space(std::string_view a, std::string_view b) {
    std::string ta = trim(a), tb = trim(b);
    if (ta.empty()) return tb;
    if (tb.empty()) return ta;
    return ta + " " + tb;
}

// Extracts sentence-level questions (ending in '?') from text. Returns
// trimmed, non-empty entries, deduped by folded form.
inline std::vector<std::string> extract_questions(std::string_view s) {
    std::vector<std::string> out;
    std::size_t i = 0;
    while (i < s.size()) {
        std::size_t q = s.find('?', i);
        if (q == std::string_view::npos) break;
        std::size_t ls = s.rfind('\n', q);
        if (ls == std::string_view::npos) ls = 0; else ++ls;
        std::size_t lb = q;
        while (lb > ls && s[lb-1] == '?' ) --lb;
        // expand left to sentence start
        std::size_t st = ls;
        for (std::size_t k = q; k > ls; --k) {
            char c = s[k-1];
            if (c == '.' || c == '!' || c == '\n') { st = k; break; }
        }
        std::string qstr = trim(s.substr(st, q - st + 1));
        if (!qstr.empty() && word_count(qstr) >= 3) {
            bool dup = false;
            std::string f = fold(qstr);
            for (auto& o : out) if (fold(o) == f) { dup = true; break; }
            if (!dup) out.push_back(std::move(qstr));
        }
        i = q + 1;
    }
    return out;
}

} // namespace rtai::text
