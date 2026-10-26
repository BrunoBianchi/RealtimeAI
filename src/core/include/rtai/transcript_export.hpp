#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "rtai/llm.hpp"
#include "rtai/session_transcript.hpp"

namespace rtai {

enum class TranscriptExportFormat : std::uint8_t { Txt, Md };

// Monta o conteúdo do Transcript_Export a partir do SessionTranscript, verbatim
// e em ordem cronológica de fechamento (Req 4.3/4.4). .txt = render() direto;
// .md = cabeçalho leve + render(). Função pura, testável sem I/O.
[[nodiscard]] inline std::string build_transcript_export(const SessionTranscript& t,
                                                         TranscriptExportFormat fmt) {
    const std::string body = t.render();
    if (fmt == TranscriptExportFormat::Txt) {
        return body;
    }
    std::string md = "# Session Transcript\n\n";
    md += body;
    return md;
}

// Monta as mensagens da ÚNICA chamada de IA do Session_Summary (Req 5.1/5.3).
// System prompt em pt-BR orientado a resumo fiel da chamada; user = render().
[[nodiscard]] inline std::vector<ChatMessage> build_summary_request(const SessionTranscript& t) {
    std::vector<ChatMessage> msgs;
    msgs.reserve(2);
    msgs.push_back(ChatMessage{
        "system",
        "You summarize meetings and interviews clearly, objectively and faithfully to what was said. "
        "Write an executive summary of the call in English: the topics discussed, the main answers/decisions "
        "and the next steps. Do not invent anything that was not said.",
        {}
    });
    msgs.push_back(ChatMessage{
        "user",
        t.render(),
        {}
    });
    return msgs;
}

} // namespace rtai

