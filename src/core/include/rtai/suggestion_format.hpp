// Pure core: turns the LLM's streamed text into display lines for the HUD.
// New format (HUD 1+3): a primeira linha não vazia é a Headline (tese direta,
// Kind::Headline, Req 5.1), seguida de exatamente 3 bullets com prefixo em
// negrito até ":". A promoção a Headline só ocorre quando a primeira linha não
// é por si um Bullet ou um Label — isto é, quando seria classificada como
// Paragraph; bullets e labels iniciais preservam sua classificação.
// Semântica do flag `streaming` de format_suggestion (Req 5.5/5.6):
//   streaming=false (padrão): "**" de abertura sem par de fechamento na mesma
//     linha vira texto literal "**" (sem negrito) — usado no texto final.
//   streaming=true: "**" órfão renderiza em negrito até o fim da linha,
//     evitando jitter enquanto os deltas ainda chegam ao vivo.
// Entrada vazia ou só de espaços produz uma lista vazia ({}).
#pragma once

#include <string>
#include <string_view>
#include <vector>

#include "rtai/text_util.hpp"

namespace rtai {

struct TextSegment {
    std::string text;
    bool bold{false};
};

struct FormattedLine {
    // Headline: a primeira linha não vazia da resposta (tese direta, Req 5.1),
    // renderizada na cor de destaque a 15.5 DIP. Paragraph permanece para
    // linhas de corpo que não são Headline, Bullet nem Label.
    enum class Kind { Paragraph, Bullet, Label, Headline };
    Kind kind{Kind::Paragraph};
    std::vector<TextSegment> segments;

    [[nodiscard]] std::string plain() const {
        std::string s;
        for (const auto& seg : segments) s += seg.text;
        return s;
    }
};

namespace detail {

inline std::vector<TextSegment> parse_bold(std::string_view s, bool bold_prefix_until_colon, bool streaming = true) {
    std::vector<TextSegment> out;
    auto push = [&](std::string_view t, bool bold) {
        if (t.empty()) return;
        if (!out.empty() && out.back().bold == bold) out.back().text.append(t);
        else out.push_back(TextSegment{std::string(t), bold});
    };
    if (bold_prefix_until_colon) {
        const auto colon = s.find(':');
        if (colon != std::string_view::npos) {
            push(s.substr(0, colon + 1), true);
            s.remove_prefix(colon + 1);
        }
    }
    bool bold = false;
    std::size_t i = 0;
    while (i < s.size()) {
        const auto marker = s.find("**", i);
        if (marker == std::string_view::npos) {
            if (bold && !streaming) {
                push(std::string_view("**"), false);
                push(s.substr(i), false);
            } else {
                push(s.substr(i), bold);
            }
            break;
        }
        push(s.substr(i, marker - i), bold);
        // Non-streaming: a "**" that would OPEN a bold run (bold==false) is only
        // honored when it has a matching closing "**" later on the line; an
        // opening marker with no closer is rendered as a literal "**" (Req 5.6).
        // A "**" that CLOSES an already-open run (bold==true) always toggles
        // bold off — it is the matching close of a properly-formed pair, so it
        // must never be mistaken for an orphan (Req 4.2, 5.5).
        if (!streaming && !bold) {
            const auto closing = s.find("**", marker + 2);
            if (closing == std::string_view::npos) {
                push(std::string_view("**"), false);
                i = marker + 2;
                continue;
            }
        }
        bold = !bold;
        i = marker + 2;
    }
    return out;
}

inline bool starts_with(std::string_view s, std::string_view p) {
    return s.size() >= p.size() && s.compare(0, p.size(), p) == 0;
}

inline bool is_label_line(std::string_view line) {
    // "**Situação:** ...", "**Situação**: ..." and "Situação: ..." are all the
    // same label: ignore the bold markers when matching.
    std::string f;
    for (char c : text::fold(line)) {
        if (c != '*') f.push_back(c);
    }
    while (!f.empty() && f.front() == ' ') f.erase(f.begin());
    for (const char* l : {"insight:", "acoes:", "acao:", "proximos passos:", "proximo passo:",
                          "actions:", "next steps:", "pergunta:", "question:", "sugestao:", "pendencias:",
                          "decisoes:", "suggestion:",
                          // STAR answers (pt / en)
                          "situacao:", "tarefa:", "resultado:", "situation:", "task:",
                          "action:", "result:"}) {
        if (starts_with(f, l)) return true;
    }
    return false;
}

} // namespace detail

inline std::vector<FormattedLine> format_suggestion(std::string_view body, bool streaming = false) {
    std::vector<FormattedLine> lines;
    std::size_t start = 0;
    while (start <= body.size()) {
        std::size_t end = body.find('\n', start);
        if (end == std::string_view::npos) end = body.size();
        std::string raw = text::trim(body.substr(start, end - start));
        start = end + 1;
        if (raw.empty()) continue;

        FormattedLine fl;
        std::string_view content(raw);
        // Markdown headings become labels.
        while (!content.empty() && content.front() == '#') {
            content.remove_prefix(1);
            fl.kind = FormattedLine::Kind::Label;
        }
        while (!content.empty() && content.front() == ' ') content.remove_prefix(1);

        if (fl.kind != FormattedLine::Kind::Label) {
            if (detail::starts_with(content, "- ") || detail::starts_with(content, "* ")) {
                fl.kind = FormattedLine::Kind::Bullet;
                content.remove_prefix(2);
            } else if (detail::starts_with(content, "\xE2\x80\xA2")) { // "•"
                fl.kind = FormattedLine::Kind::Bullet;
                content.remove_prefix(3);
                while (!content.empty() && content.front() == ' ') content.remove_prefix(1);
            } else if (detail::is_label_line(content)) {
                fl.kind = FormattedLine::Kind::Label;
            }
        }
        // A label like "**Ações:** x" shouldn't double-toggle: strip a
        // leading bold marker pair around the label.
        fl.segments = detail::parse_bold(content, fl.kind == FormattedLine::Kind::Label &&
                                                      content.find("**") != 0, streaming);
        if (fl.segments.empty()) continue;
        // Req 5.1: a primeira linha não vazia produzida é a Headline, desde que
        // não seja um Bullet ou Label próprios. O conteúdo (segments) e os
        // bullets com/sem ":" permanecem byte a byte inalterados.
        if (lines.empty() && fl.kind == FormattedLine::Kind::Paragraph) {
            fl.kind = FormattedLine::Kind::Headline;
        }
        lines.push_back(std::move(fl));
    }
    return lines;
}

} // namespace rtai
