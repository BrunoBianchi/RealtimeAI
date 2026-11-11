#pragma once

#include <string_view>

namespace rtai {

enum class CodeTone { Plain, Keyword, Type, String, Number, Comment, Function, Count };

// Lightweight syntax coloring for streamed snippets. Keep an unfinished
// block comment or multiline string open across lines of the same fence.
class CodeHighlighter {
public:
    explicit CodeHighlighter(std::string_view language = {})
        : python_(language == "python" || language == "py"),
          sql_(language == "sql" || language == "postgresql" || language == "mysql" || language == "sqlite"),
          hash_comment_(python_ || language == "bash" || language == "sh" || language == "ruby"),
          unknown_(language.empty() || language == "text") {}

    template <class Emit>
    void line(std::string_view code, Emit emit) {
        while (!code.empty()) {
            if (!end_.empty()) {
                const auto end = code.find(end_);
                const auto count = end == code.npos ? code.size() : end + end_.size();
                emit(code.substr(0, count), open_tone_);
                code.remove_prefix(count);
                if (end != code.npos) end_ = {};
                continue;
            }
            if (((hash_comment_ || unknown_) && code.starts_with('#')) ||
                (sql_ && code.starts_with("--")) ||
                (!python_ && !sql_ && code.starts_with("//"))) {
                emit(code, CodeTone::Comment);
                return;
            }
            if (!python_ && code.starts_with("/*")) {
                open(code, "/*", "*/", CodeTone::Comment, emit);
                continue;
            }
            const char first = code.front();
            if (python_ && (code.starts_with("\"\"\"") || code.starts_with("'''"))) {
                const auto quote = first == '\'' ? std::string_view("'''") : std::string_view("\"\"\"");
                open(code, quote, quote, CodeTone::String, emit);
                continue;
            }
            if (first == '\'' || first == '"' || first == '`') {
                std::size_t len = 1;
                while (len < code.size()) {
                    const char c = code[len++];
                    if (c == '\\' && len < code.size()) ++len;
                    else if (c == first) break;
                }
                emit(code.substr(0, len), CodeTone::String);
                code.remove_prefix(len);
                continue;
            }
            if (word_char(first)) {
                std::size_t len = 1;
                const bool number = digit(first);
                while (len < code.size() && (word_char(code[len]) ||
                       (number && code[len] == '.' && len + 1 < code.size() && digit(code[len + 1])))) ++len;
                auto rest = code.substr(len);
                while (!rest.empty() && (rest.front() == ' ' || rest.front() == '\t')) rest.remove_prefix(1);
                const auto word = code.substr(0, len);
                emit(word, number ? CodeTone::Number : word_tone(word, rest.starts_with('(')));
                code.remove_prefix(len);
                continue;
            }
            emit(code.substr(0, 1), CodeTone::Plain);
            code.remove_prefix(1);
        }
    }

private:
    bool python_;
    bool sql_;
    bool hash_comment_;
    bool unknown_;
    std::string_view end_;
    CodeTone open_tone_{CodeTone::Plain};

    static bool digit(char c) { return c >= '0' && c <= '9'; }
    static bool word_char(char c) {
        return digit(c) || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == '$' ||
               static_cast<unsigned char>(c) >= 128;
    }

    template <class Emit>
    void open(std::string_view& code, std::string_view prefix, std::string_view end, CodeTone tone, Emit& emit) {
        emit(prefix, tone);
        code.remove_prefix(prefix.size());
        end_ = end;
        open_tone_ = tone;
    }

    static bool contains_word(std::string_view list, std::string_view word) {
        for (auto pos = list.find(word); pos != list.npos; pos = list.find(word, pos + 1)) {
            if (pos > 0 && list[pos - 1] == ' ' && pos + word.size() < list.size() &&
                list[pos + word.size()] == ' ') return true;
        }
        return false;
    }

    CodeTone word_tone(std::string_view word, bool call) const {
        char folded[16];
        if (sql_ && word.size() <= sizeof folded) {
            for (std::size_t i = 0; i < word.size(); ++i) {
                const char c = word[i];
                folded[i] = c >= 'A' && c <= 'Z' ? static_cast<char>(c + ('a' - 'A')) : c;
            }
            word = std::string_view(folded, word.size());
        }
        constexpr std::string_view keywords =
            " as async await break case catch class const continue def defer del do else elif enum except export "
            "extends finally fn for foreach from func function go if implements import in interface is lambda let "
            "match mod namespace new nonlocal not and or package pass private protected pub public raise "
            "return static struct super switch this throw throws try type typeof use using val var void "
            "when while with yield mut unsafe default include sizeof instanceof assert delete ";
        constexpr std::string_view sql_keywords =
            " select where join inner left right on group by order having limit distinct union insert update into "
            "values create table set asc desc nulls between over partition offset ";
        constexpr std::string_view types =
            " bool boolean byte char double float int int32 int64 long number short str string String uint usize "
            "size_t auto Any List Map Set Array Object Vec Optional Promise None True False null true false nil "
            "nullptr undefined nullptr_t u8 u16 u32 u64 i8 i16 i32 i64 f32 f64 ";
        if (contains_word(keywords, word) || (sql_ && contains_word(sql_keywords, word))) return CodeTone::Keyword;
        if (contains_word(types, word)) return CodeTone::Type;
        return call ? CodeTone::Function : CodeTone::Plain;
    }
};

} // namespace rtai
