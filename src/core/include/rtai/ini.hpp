// Pure core: tiny INI reader/rewriter for config.ini.
//   [secao]
//   chave = valor        ; comentário   # também comentário
// Keys and sections are case-insensitive; values are trimmed and may be
// quoted ("..."). rewrite_value() edits one value in place and keeps every
// other line (comments, blank lines, order) byte for byte.
#pragma once

#include <functional>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "rtai/text_util.hpp"

namespace rtai::ini {

inline std::string lower(std::string_view s) {
    std::string out(s);
    for (char& c : out) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    }
    return out;
}

// Splits text into lines without their line terminators; remembers whether
// the file used CRLF so rewrites keep the same style.
inline std::vector<std::string> split_lines(std::string_view text, bool* crlf = nullptr) {
    std::vector<std::string> lines;
    bool saw_crlf = false;
    std::size_t start = 0;
    while (start < text.size()) {
        std::size_t end = text.find('\n', start);
        if (end == std::string_view::npos) end = text.size();
        std::string line(text.substr(start, end - start));
        if (!line.empty() && line.back() == '\r') {
            line.pop_back();
            saw_crlf = true;
        }
        lines.push_back(std::move(line));
        start = end + 1;
    }
    if (crlf) *crlf = saw_crlf;
    return lines;
}

struct ParsedLine {
    enum class Kind { Other, Section, KeyValue } kind{Kind::Other};
    std::string section; // Section
    std::string key;     // KeyValue (lowercase)
    std::string value;   // KeyValue (trimmed, unquoted)
    std::size_t value_begin{0}, value_end{0}; // raw value span inside the line
};

inline ParsedLine parse_line(const std::string& raw) {
    ParsedLine p;
    std::size_t b = 0;
    while (b < raw.size() && text::is_space(raw[b])) ++b;
    // UTF-8 BOM on the first line.
    if (raw.compare(b, 3, "\xEF\xBB\xBF") == 0) b += 3;
    if (b >= raw.size() || raw[b] == ';' || raw[b] == '#') return p;
    if (raw[b] == '[') {
        const auto close = raw.find(']', b);
        if (close == std::string::npos) return p;
        p.kind = ParsedLine::Kind::Section;
        p.section = lower(text::trim(std::string_view(raw).substr(b + 1, close - b - 1)));
        return p;
    }
    const auto eq = raw.find('=', b);
    if (eq == std::string::npos) return p;
    p.kind = ParsedLine::Kind::KeyValue;
    p.key = lower(text::trim(std::string_view(raw).substr(b, eq - b)));
    std::size_t vb = eq + 1;
    while (vb < raw.size() && text::is_space(raw[vb])) ++vb;
    std::size_t ve = raw.size();
    if (vb < raw.size() && raw[vb] == '"') {
        const auto q = raw.find('"', vb + 1);
        if (q != std::string::npos) {
            p.value = raw.substr(vb + 1, q - vb - 1);
            p.value_begin = vb;
            p.value_end = q + 1;
            return p;
        }
    }
    // Inline comment: " ;" or " #" after the value.
    for (std::size_t i = vb; i < raw.size(); ++i) {
        if ((raw[i] == ';' || raw[i] == '#') && i > vb && text::is_space(raw[i - 1])) {
            ve = i;
            break;
        }
    }
    while (ve > vb && text::is_space(raw[ve - 1])) --ve;
    p.value = raw.substr(vb, ve - vb);
    p.value_begin = vb;
    p.value_end = ve;
    return p;
}

class File {
public:
    static File parse(std::string_view text) {
        File f;
        std::string section;
        for (const auto& line : split_lines(text)) {
            const ParsedLine p = parse_line(line);
            if (p.kind == ParsedLine::Kind::Section) section = p.section;
            else if (p.kind == ParsedLine::Kind::KeyValue) f.values_[section][p.key] = p.value;
        }
        return f;
    }

    [[nodiscard]] std::optional<std::string> get(std::string_view section, std::string_view key) const {
        auto s = values_.find(lower(section));
        if (s == values_.end()) return std::nullopt;
        auto k = s->second.find(lower(key));
        if (k == s->second.end()) return std::nullopt;
        return k->second;
    }

    // Non-empty value or nullopt.
    [[nodiscard]] std::optional<std::string> get_nonempty(std::string_view section, std::string_view key) const {
        auto v = get(section, key);
        if (!v || v->empty()) return std::nullopt;
        return v;
    }

private:
    std::map<std::string, std::map<std::string, std::string>> values_;
};

// Replaces the value of [section] key (first occurrence) using `fn(old)`.
// Returns the new text, or nullopt when the key isn't present or fn returns
// nullopt (no change).
inline std::optional<std::string> rewrite_value(
    std::string_view text, std::string_view section, std::string_view key,
    const std::function<std::optional<std::string>(const std::string&)>& fn) {
    bool crlf = false;
    auto lines = split_lines(text, &crlf);
    const std::string want_section = lower(section), want_key = lower(key);
    std::string current;
    bool changed = false;
    for (auto& line : lines) {
        const ParsedLine p = parse_line(line);
        if (p.kind == ParsedLine::Kind::Section) {
            current = p.section;
        } else if (!changed && p.kind == ParsedLine::Kind::KeyValue && current == want_section &&
                   p.key == want_key) {
            auto nv = fn(p.value);
            if (!nv) return std::nullopt;
            std::string head = line.substr(0, p.value_begin);
            if (!head.empty() && head.back() == '=') head += ' '; // "key =" -> "key = value"
            line = head + *nv + line.substr(p.value_end);
            changed = true;
        }
    }
    if (!changed) return std::nullopt;
    std::string out;
    const char* nl = crlf ? "\r\n" : "\n";
    for (std::size_t i = 0; i < lines.size(); ++i) {
        out += lines[i];
        if (i + 1 < lines.size() || (!text.empty() && text.back() == '\n')) out += nl;
    }
    return out;
}

// Serializes a value for one INI line. Values that would be cut by the
// parser (inline comment markers, edge spaces) are quoted; a value that
// needs quoting but contains '"' or any newline can't be represented.
inline std::optional<std::string> encode_value(std::string_view v) {
    if (v.find_first_of("\r\n") != std::string_view::npos) return std::nullopt;
    const bool edge_space = !v.empty() && (text::is_space(v.front()) || text::is_space(v.back()));
    const bool comment = v.find(';') != std::string_view::npos || v.find('#') != std::string_view::npos;
    const bool leading_quote = !v.empty() && v.front() == '"';
    if (!edge_space && !comment && !leading_quote) return std::string(v);
    if (v.find('"') != std::string_view::npos) return std::nullopt;
    return "\"" + std::string(v) + "\"";
}

// Sets [section] key = value (already encoded). Updates the first existing
// line; otherwise adds the key right after the section header, or appends a
// new section at the end. Keeps the file's line-ending style.
inline std::string upsert_value(std::string_view text, std::string_view section, std::string_view key,
                                const std::string& encoded) {
    if (auto t = rewrite_value(text, section, key,
                               [&](const std::string&) -> std::optional<std::string> { return encoded; })) {
        return *t;
    }
    bool crlf = false;
    auto lines = split_lines(text, &crlf);
    const bool trailing_nl = !text.empty() && text.back() == '\n';
    if (trailing_nl && !lines.empty() && lines.back().empty()) lines.pop_back();
    const std::string want = lower(section);
    const std::string new_line = std::string(key) + " = " + encoded;
    bool inserted = false;
    for (std::size_t i = 0; i < lines.size(); ++i) {
        const ParsedLine p = parse_line(lines[i]);
        if (p.kind == ParsedLine::Kind::Section && p.section == want) {
            lines.insert(lines.begin() + static_cast<std::ptrdiff_t>(i) + 1, new_line);
            inserted = true;
            break;
        }
    }
    if (!inserted) {
        if (!lines.empty() && !lines.back().empty()) lines.emplace_back();
        lines.push_back("[" + std::string(section) + "]");
        lines.push_back(new_line);
    }
    std::string out;
    const char* nl = crlf ? "\r\n" : "\n";
    for (const auto& l : lines) {
        out += l;
        out += nl;
    }
    return out;
}

inline std::optional<bool> parse_bool(std::string_view v) {
    const std::string f = text::fold(text::trim(v));
    if (f == "sim" || f == "s" || f == "true" || f == "1" || f == "on" || f == "yes") return true;
    if (f == "nao" || f == "n" || f == "false" || f == "0" || f == "off" || f == "no") return false;
    return std::nullopt;
}

} // namespace rtai::ini
