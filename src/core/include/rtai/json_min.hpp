// Pure core: a minimal, dependency-free JSON reader/writer for Deepgram and
// OpenRouter messages and for the session log. This is intentionally small:
// it parses the subset we need (objects, arrays, strings, numbers, bools,
// null) and writes compact JSON. It is NOT a general-purpose or
// security-hardened parser; inputs come from Deepgram/OpenRouter and from our
// own session files.
//
// Rationale (see README): keeping JSON here (vs Windows.Data.Json) keeps
// `core` free of <windows.h> and fully unit-testable without WinRT.
#pragma once

#include <charconv>
#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace rtai::json {

class Value;
using Array = std::vector<Value>;
using Object = std::map<std::string, Value>;

class Value {
public:
    enum class Type { Null, Bool, Number, String, Array, Object };

    Value() : type_(Type::Null) {}
    Value(bool b) : type_(Type::Bool), bool_(b) {}
    Value(double n) : type_(Type::Number), num_(n) {}
    Value(std::string s) : type_(Type::String), str_(std::move(s)) {}
    Value(Array a) : type_(Type::Array), arr_(std::make_shared<Array>(std::move(a))) {}
    Value(Object o) : type_(Type::Object), obj_(std::make_shared<Object>(std::move(o))) {}

    [[nodiscard]] Type type() const noexcept { return type_; }
    [[nodiscard]] bool is_object() const noexcept { return type_ == Type::Object; }
    [[nodiscard]] bool is_array() const noexcept { return type_ == Type::Array; }
    [[nodiscard]] bool is_string() const noexcept { return type_ == Type::String; }
    [[nodiscard]] bool is_number() const noexcept { return type_ == Type::Number; }
    [[nodiscard]] bool is_bool() const noexcept { return type_ == Type::Bool; }
    [[nodiscard]] bool is_null() const noexcept { return type_ == Type::Null; }

    [[nodiscard]] bool as_bool(bool def = false) const noexcept {
        return type_ == Type::Bool ? bool_ : def;
    }
    [[nodiscard]] double as_number(double def = 0.0) const noexcept {
        return type_ == Type::Number ? num_ : def;
    }
    [[nodiscard]] const std::string& as_string() const noexcept {
        static const std::string empty;
        return type_ == Type::String ? str_ : empty;
    }

    // Object field access; returns a null Value if absent/not-an-object.
    [[nodiscard]] const Value& operator[](std::string_view key) const noexcept {
        static const Value null_value;
        if (type_ != Type::Object || !obj_) return null_value;
        auto it = obj_->find(std::string(key));
        return it == obj_->end() ? null_value : it->second;
    }

    [[nodiscard]] bool has(std::string_view key) const noexcept {
        return type_ == Type::Object && obj_ && obj_->find(std::string(key)) != obj_->end();
    }

    // Array element access; returns null Value if out of range/not-an-array.
    [[nodiscard]] const Value& at(std::size_t i) const noexcept {
        static const Value null_value;
        if (type_ != Type::Array || !arr_ || i >= arr_->size()) return null_value;
        return (*arr_)[i];
    }
    [[nodiscard]] std::size_t size() const noexcept {
        if (type_ == Type::Array && arr_) return arr_->size();
        if (type_ == Type::Object && obj_) return obj_->size();
        return 0;
    }

private:
    Type type_;
    bool bool_{false};
    double num_{0.0};
    std::string str_;
    std::shared_ptr<Array> arr_;
    std::shared_ptr<Object> obj_;
};

// Parser. Returns std::nullopt on malformed input.
class Parser {
public:
    static std::optional<Value> parse(std::string_view text) {
        Parser p(text);
        p.skip_ws();
        auto v = p.parse_value(0);
        if (!v) return std::nullopt;
        p.skip_ws();
        if (p.pos_ != p.text_.size()) return std::nullopt; // trailing garbage
        return v;
    }

private:
    explicit Parser(std::string_view t) : text_(t) {}

    // Nesting guard: our payloads are shallow; refuse pathological input
    // instead of overflowing the stack.
    static constexpr int kMaxDepth = 64;

    std::string_view text_;
    std::size_t pos_{0};

    void skip_ws() {
        while (pos_ < text_.size()) {
            char c = text_[pos_];
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') ++pos_;
            else break;
        }
    }

    [[nodiscard]] bool eof() const { return pos_ >= text_.size(); }
    [[nodiscard]] char peek() const { return text_[pos_]; }

    std::optional<Value> parse_value(int depth) {
        if (depth > kMaxDepth) return std::nullopt;
        skip_ws();
        if (eof()) return std::nullopt;
        char c = peek();
        switch (c) {
            case '{': return parse_object(depth + 1);
            case '[': return parse_array(depth + 1);
            case '"': {
                auto s = parse_string();
                if (!s) return std::nullopt;
                return Value(std::move(*s));
            }
            case 't': case 'f': return parse_bool();
            case 'n': return parse_null();
            default:
                if (c == '-' || (c >= '0' && c <= '9')) return parse_number();
                return std::nullopt;
        }
    }

    std::optional<Value> parse_object(int depth) {
        ++pos_; // consume '{'
        Object obj;
        skip_ws();
        if (!eof() && peek() == '}') { ++pos_; return Value(std::move(obj)); }
        while (true) {
            skip_ws();
            if (eof() || peek() != '"') return std::nullopt;
            auto key = parse_string();
            if (!key) return std::nullopt;
            skip_ws();
            if (eof() || peek() != ':') return std::nullopt;
            ++pos_;
            auto val = parse_value(depth);
            if (!val) return std::nullopt;
            obj.insert_or_assign(std::move(*key), std::move(*val));
            skip_ws();
            if (eof()) return std::nullopt;
            char c = peek();
            if (c == ',') { ++pos_; continue; }
            if (c == '}') { ++pos_; break; }
            return std::nullopt;
        }
        return Value(std::move(obj));
    }

    std::optional<Value> parse_array(int depth) {
        ++pos_; // consume '['
        Array arr;
        skip_ws();
        if (!eof() && peek() == ']') { ++pos_; return Value(std::move(arr)); }
        while (true) {
            auto val = parse_value(depth);
            if (!val) return std::nullopt;
            arr.push_back(std::move(*val));
            skip_ws();
            if (eof()) return std::nullopt;
            char c = peek();
            if (c == ',') { ++pos_; continue; }
            if (c == ']') { ++pos_; break; }
            return std::nullopt;
        }
        return Value(std::move(arr));
    }

    static void append_utf8(std::string& out, std::uint32_t cp) {
        if (cp < 0x80) {
            out.push_back(static_cast<char>(cp));
        } else if (cp < 0x800) {
            out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else if (cp < 0x10000) {
            out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else {
            out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        }
    }

    bool read_hex4(std::uint32_t& code) {
        if (pos_ + 4 > text_.size()) return false;
        code = 0;
        for (int i = 0; i < 4; ++i) {
            char h = text_[pos_++];
            code <<= 4;
            if (h >= '0' && h <= '9') code |= static_cast<unsigned>(h - '0');
            else if (h >= 'a' && h <= 'f') code |= static_cast<unsigned>(h - 'a' + 10);
            else if (h >= 'A' && h <= 'F') code |= static_cast<unsigned>(h - 'A' + 10);
            else return false;
        }
        return true;
    }

    std::optional<std::string> parse_string() {
        ++pos_; // consume opening quote
        std::string out;
        while (!eof()) {
            char c = text_[pos_++];
            if (c == '"') return out;
            if (c == '\\') {
                if (eof()) return std::nullopt;
                char e = text_[pos_++];
                switch (e) {
                    case '"': out.push_back('"'); break;
                    case '\\': out.push_back('\\'); break;
                    case '/': out.push_back('/'); break;
                    case 'b': out.push_back('\b'); break;
                    case 'f': out.push_back('\f'); break;
                    case 'n': out.push_back('\n'); break;
                    case 'r': out.push_back('\r'); break;
                    case 't': out.push_back('\t'); break;
                    case 'u': {
                        std::uint32_t code = 0;
                        if (!read_hex4(code)) return std::nullopt;
                        // Combine UTF-16 surrogate pairs (emoji etc.) into one
                        // code point so the output is valid UTF-8, not CESU-8.
                        if (code >= 0xD800 && code <= 0xDBFF && pos_ + 6 <= text_.size() &&
                            text_[pos_] == '\\' && text_[pos_ + 1] == 'u') {
                            const std::size_t save = pos_;
                            pos_ += 2;
                            std::uint32_t low = 0;
                            if (read_hex4(low) && low >= 0xDC00 && low <= 0xDFFF) {
                                code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                            } else {
                                pos_ = save;
                                code = 0xFFFD;
                            }
                        } else if (code >= 0xD800 && code <= 0xDFFF) {
                            code = 0xFFFD; // lone surrogate
                        }
                        append_utf8(out, code);
                        break;
                    }
                    default: return std::nullopt;
                }
            } else {
                out.push_back(c);
            }
        }
        return std::nullopt; // unterminated
    }

    std::optional<Value> parse_number() {
        std::size_t start = pos_;
        if (!eof() && peek() == '-') ++pos_;
        while (!eof()) {
            char c = peek();
            if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' ||
                c == '+' || c == '-') {
                ++pos_;
            } else {
                break;
            }
        }
        try {
            // std::stod uses the "C" locale unless the program calls
            // setlocale(); this project never does.
            return Value(std::stod(std::string(text_.substr(start, pos_ - start))));
        } catch (...) {
            return std::nullopt;
        }
    }

    std::optional<Value> parse_bool() {
        if (text_.compare(pos_, 4, "true") == 0) { pos_ += 4; return Value(true); }
        if (text_.compare(pos_, 5, "false") == 0) { pos_ += 5; return Value(false); }
        return std::nullopt;
    }

    std::optional<Value> parse_null() {
        if (text_.compare(pos_, 4, "null") == 0) { pos_ += 4; return Value(); }
        return std::nullopt;
    }
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

// Appends `s` as a quoted JSON string. UTF-8 bytes are passed through as-is
// (valid JSON); control characters are escaped.
inline void append_quoted(std::string& out, std::string_view s) {
    static const char* hex = "0123456789abcdef";
    out.push_back('"');
    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            default:
                if (c < 0x20) {
                    out += "\\u00";
                    out.push_back(hex[c >> 4]);
                    out.push_back(hex[c & 0xF]);
                } else {
                    out.push_back(static_cast<char>(c));
                }
        }
    }
    out.push_back('"');
}

inline std::string quote(std::string_view s) {
    std::string out;
    out.reserve(s.size() + 2);
    append_quoted(out, s);
    return out;
}

// Small streaming writer for compact JSON. Distinct method names avoid the
// int/double/bool overload ambiguities of a generic value() method.
//
//   Writer w;
//   w.begin_object().key("type").string_value("KeepAlive").end_object();
class Writer {
public:
    Writer& begin_object() { before_value(); out_.push_back('{'); first_.push_back(true); return *this; }
    Writer& end_object() { out_.push_back('}'); first_.pop_back(); return *this; }
    Writer& begin_array() { before_value(); out_.push_back('['); first_.push_back(true); return *this; }
    Writer& end_array() { out_.push_back(']'); first_.pop_back(); return *this; }

    Writer& key(std::string_view k) {
        separator();
        append_quoted(out_, k);
        out_.push_back(':');
        after_key_ = true;
        return *this;
    }

    Writer& string_value(std::string_view s) { before_value(); append_quoted(out_, s); return *this; }
    Writer& bool_value(bool b) { before_value(); out_ += b ? "true" : "false"; return *this; }
    Writer& null_value() { before_value(); out_ += "null"; return *this; }
    Writer& int_value(std::int64_t v) { before_value(); out_ += std::to_string(v); return *this; }
    Writer& uint_value(std::uint64_t v) { before_value(); out_ += std::to_string(v); return *this; }
    Writer& double_value(double v, int precision = 3) {
        before_value();
        char buf[64];
        auto res = std::to_chars(buf, buf + sizeof(buf), v, std::chars_format::fixed, precision);
        if (res.ec == std::errc{}) out_.append(buf, res.ptr);
        else out_ += "0";
        return *this;
    }
    // Insert pre-serialized JSON (caller guarantees validity).
    Writer& raw_value(std::string_view json) { before_value(); out_ += json; return *this; }

    // Convenience: key + value in one call.
    Writer& field(std::string_view k, std::string_view v) { return key(k).string_value(v); }
    Writer& field(std::string_view k, const char* v) { return key(k).string_value(v); }
    Writer& field(std::string_view k, bool v) { return key(k).bool_value(v); }
    Writer& field_bool(std::string_view k, bool v) { return key(k).bool_value(v); }
    Writer& field_int(std::string_view k, std::int64_t v) { return key(k).int_value(v); }
    Writer& field_double(std::string_view k, double v, int precision = 3) {
        return key(k).double_value(v, precision);
    }

    [[nodiscard]] const std::string& str() const& { return out_; }
    [[nodiscard]] std::string str() && { return std::move(out_); }

private:
    void separator() {
        if (!first_.empty()) {
            if (!first_.back()) out_.push_back(',');
            first_.back() = false;
        }
    }
    void before_value() {
        if (after_key_) { after_key_ = false; return; } // value follows its key
        separator();                                    // array element / top level
    }

    std::string out_;
    std::vector<bool> first_;
    bool after_key_{false};
};

} // namespace rtai::json
