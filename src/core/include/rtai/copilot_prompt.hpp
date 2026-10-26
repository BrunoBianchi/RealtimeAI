// Pure core: conversation memory and the prompt sent to the LLM.
//
// Design choices that fix the "question drift" seen in the reference
// screenshot (transcript "Have you worked for Microsoft?" displayed as
// "Why do you want to work for Microsoft?"):
//   * the trigger utterance is shown in the overlay VERBATIM from the
//     transcript; the model never gets to rewrite the question;
//   * the prompt quotes the literal utterance and tells the model not to
//     paraphrase it and not to invent facts/experiences.
#pragma once

#include <algorithm>
#include <cctype>
#include <deque>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "rtai/audio_format.hpp"
#include "rtai/decision_policy.hpp"
#include "rtai/llm.hpp"
#include "rtai/text_util.hpp"
#include "rtai/turn_assembler.hpp"

namespace rtai {

// Rolling window of closed turns used as LLM context.
class ConversationLog {
public:
    explicit ConversationLog(std::size_t max_turns = 60) : max_turns_(max_turns) {}

    void add(const Turn& t) {
        turns_.push_back(t);
        while (turns_.size() > max_turns_) turns_.pop_front();
    }

    // "[Outros] ..." / "[Você] ..." lines, oldest first, keeping the most
    // recent lines that fit in max_chars.
    [[nodiscard]] std::string render(std::size_t max_chars) const {
        std::vector<std::string> lines;
        std::size_t total = 0;
        for (auto it = turns_.rbegin(); it != turns_.rend(); ++it) {
            std::string line = std::string("[") + speaker_tag(it->source) + "] " + it->text;
            if (total + line.size() + 1 > max_chars && !lines.empty()) break;
            total += line.size() + 1;
            lines.push_back(std::move(line));
        }
        std::string out;
        for (auto it = lines.rbegin(); it != lines.rend(); ++it) {
            out += *it;
            out.push_back('\n');
        }
        return out;
    }

    [[nodiscard]] std::optional<Turn> last_from(AudioSource s) const {
        for (auto it = turns_.rbegin(); it != turns_.rend(); ++it) {
            if (it->source == s) return *it;
        }
        return std::nullopt;
    }

    // Renders only the turns spoken by `s` (e.g. AudioSource::Microphone for
    // the candidate's own spoken answers "[Você]"), oldest first within budget.
    [[nodiscard]] std::string render_source(AudioSource s, std::size_t max_chars) const {
        std::vector<std::string> lines;
        std::size_t total = 0;
        for (auto it = turns_.rbegin(); it != turns_.rend(); ++it) {
            if (it->source != s) continue;
            std::string line = std::string("[") + speaker_tag(it->source) + "] " + it->text;
            if (total + line.size() + 1 > max_chars && !lines.empty()) break;
            total += line.size() + 1;
            lines.push_back(std::move(line));
        }
        std::string out;
        for (auto it = lines.rbegin(); it != lines.rend(); ++it) {
            out += *it;
            out.push_back('\n');
        }
        return out;
    }

    [[nodiscard]] std::optional<Turn> last() const {
        if (turns_.empty()) return std::nullopt;
        return turns_.back();
    }

    [[nodiscard]] std::size_t size() const noexcept { return turns_.size(); }

    [[nodiscard]] const std::deque<Turn>& all() const noexcept { return turns_; }

private:
    std::size_t max_turns_;
    std::deque<Turn> turns_;
};

struct PromptConfig {
    // Free-form notes the user loads from RTAI_CONTEXT_FILE: product facts,
    // pricing, agenda, objections playbook, interview prep notes...
    std::string user_context;
    // Legacy single-block resolver (query -> whole context). Honored when the
    // split resolvers below are not set.
    std::function<std::string(std::string_view)> dynamic_rag;
    // Stable, per-session block (anti-hallucination rule, Mini-Compact, notes).
    // Goes into the SYSTEM message right after the static rules, so the whole
    // prefix is identical between questions and providers with prompt caching
    // (OpenRouter/Gemini/OpenAI/DeepSeek...) skip re-reading it: lower TTFT.
    std::function<std::string()> session_profile;
    // Per-question retrieval: (literal question, recent interviewer lines) ->
    // retrieved chunks. Goes into the USER message.
    std::function<std::string(std::string_view, std::string_view)> rag_retrieve;
    std::size_t max_context_chars{6000};
    // Smaller history = fewer prompt tokens = faster first token. 3500 chars
    // is ~10 turns, enough for follow-ups and persona coherence.
    std::size_t max_history_chars{3500};
};

// The live answer format. The model first writes ONE line with the question
// as it understood it from the (choppy) live transcript, then the answer: a
// STAR story told as natural speech, without Situation/Task/Action/Result
// labels. Grounding rules come before style rules because inventing facts is
// worse than any formatting slip.
//
// Why the "PERGUNTA:" line: the STT closes phrases after ~100 ms of silence,
// so the trigger is often just the tail of what was asked ("Não é a questão
// da cultura da Nubank." after "Por que você quer entrar na Nubank?"). The
// model reconstructs the whole question from the recent interviewer lines and
// says what it understood; the overlay shows that line as the card title.
inline std::string copilot_system_prompt() {
    return
        "Você é um copiloto de entrevista em tempo real. O candidato está AO VIVO e vai ler sua resposta "
        "num HUD pequeno, em voz alta, em primeira pessoa. Ele precisa bater o olho e saber o que dizer.\n"
        "\n"
        "FORMATO DA SAÍDA (obrigatório):\n"
        "Linha 1: PERGUNTA: a pergunta do entrevistador como você entendeu, completa e clara, em uma frase, "
        "no idioma dele (em inglês, use QUESTION:).\n"
        "Linha 2: em branco.\n"
        "Depois: a resposta que eu vou falar.\n"
        "\n"
        "COMO ENTENDER A TRANSCRIÇÃO (ela é imperfeita):\n"
        "- O texto vem de um STT ao vivo: frases picadas em vários turnos, palavras trocadas por outras de som "
        "parecido, pontuação errada e repetições (\"é e a\", \"o o\").\n"
        "- A fala do gatilho pode ser só o último pedaço da pergunta. Junte com as FALAS RECENTES DO ENTREVISTADOR "
        "para reconstruir o pedido inteiro. Exemplo: \"Por que você quer participar da Nubank?\" seguido de "
        "\"Não é a questão da cultura da Nubank.\" vira \"Por que você quer trabalhar na Nubank, além da cultura?\".\n"
        "- Correção ou complemento (\"não é isso\", \"não só\", \"mas e...\", \"quero dizer\", \"fora isso\") "
        "muda ou estreita a pergunta anterior: responda à versão corrigida. Se ele excluiu um motivo ou tema, "
        "não use esse motivo como argumento principal.\n"
        "- Ignore o que não é para mim: conversa paralela com outra pessoa (\"espera aí, amor\", \"já vou\", "
        "\"pode deixar\"), ruído, cumprimentos e comentários soltos.\n"
        "- Corrija pelo contexto palavras claramente mal transcritas (nome da empresa, da tecnologia, do projeto), "
        "sem inventar assunto novo.\n"
        "- A linha PERGUNTA tem que ser fiel ao sentido do que foi dito. Nunca troque por outra pergunta.\n"
        "\n"
        "COMO RESPONDER (STAR natural, sem rótulos):\n"
        "- Texto corrido para falar, em primeira pessoa, em 1 ou 2 parágrafos curtos. NÃO escreva os rótulos "
        "Situação, Tarefa, Ação, Resultado (nem Situation, Task, Action, Result), nem listas.\n"
        "- A primeira frase responde direto à pergunta: é a tese. Depois vem a história real que prova a tese, "
        "seguindo a ordem STAR de forma fluida: o contexto e o desafio, o que EU fiz e por quê (decisões e "
        "trade-offs), e o resultado com o aprendizado. A última frase amarra de volta na pergunta, e na empresa "
        "quando a pergunta for sobre ela.\n"
        "- Use conectores de fala: \"Um exemplo foi quando...\", \"O desafio era...\", \"O que eu fiz foi...\", "
        "\"No fim...\", \"Por isso...\".\n"
        "- A história tem que servir à pergunta. Pergunta de motivação (\"por que essa empresa\", \"por que essa vaga\"): "
        "a tese é o motivo concreto ligado à empresa ou à vaga (use os trechos [SOBRE A EMPRESA/VAGA]) e a história "
        "entra só como prova de que eu tenho fit com isso.\n"
        "- Pergunta técnica ou conceitual: a tese é a resposta direta ao conceito; depois como funciona, componentes, "
        "trade-offs e, só se um trecho tratar exatamente disso, onde eu usei.\n"
        "- Sem caso real no contexto: diga que ainda não vivi isso em um projeto e explique como eu abordaria, "
        "tudo hipotético, sem afirmar experiência.\n"
        "- \"Você já usou X?\" com X fora dos meus arquivos: diga com honestidade que ainda não usei X em projeto e "
        "conecte com a experiência real mais próxima que está nos trechos.\n"
        "- De 80 a 150 palavras, salvo se o PLAYBOOK definir outra extensão. Frases curtas, fáceis de falar. "
        "No máximo 2 termos-chave em **negrito**.\n"
        "- Cumprimento, teste de áudio ou logística (\"tudo bem?\", \"está me ouvindo?\", \"podemos começar?\"): "
        "depois da linha PERGUNTA, 1 frase curta e natural.\n"
        "\n"
        "FOCO NA PERGUNTA (antes de tudo):\n"
        "- Responda exatamente ao que foi pedido, cobrindo todas as partes. Os trechos e o perfil são apoio, não o assunto.\n"
        "- Siga a linha \"Tipo de pergunta\" dos trechos recuperados.\n"
        "- Só use uma história ou projeto se ela responde diretamente à pergunta. Nunca traga um projeto só porque "
        "ele aparece nos trechos ou no perfil; trecho sem relação com a pergunta deve ser ignorado.\n"
        "\n"
        "ZERO INVENÇÃO:\n"
        "- Use apenas fatos do PERFIL DA SESSÃO, dos TRECHOS RECUPERADOS e do que [Você] já falou na transcrição.\n"
        "- Trechos marcados [SOBRE MIM] são fatos meus. Trechos [SOBRE A EMPRESA/VAGA] são contexto: use para conectar "
        "com a empresa, nunca como algo que eu fiz.\n"
        "- Nunca invente números, nomes, clientes, empresas, cargos, datas, tecnologias ou experiências. "
        "Números e nomes só aparecem se estiverem escritos no contexto, exatamente como estão lá.\n"
        "- Sem métrica no contexto, o resultado é qualitativo e sem número.\n"
        "- A empresa-alvo é onde estou sendo entrevistado: nunca diga que construí produtos dela.\n"
        "- No máximo uma história por resposta; não misture fatos de projetos diferentes.\n"
        "- Mantenha a mesma persona e não contradiga o que [Você] já falou nem as respostas já sugeridas.\n"
        "\n"
        "IDIOMA E ESTILO:\n"
        "- Responda no idioma em que [Outros] perguntou.\n"
        "- Não use travessão.";
}

inline const std::string& copilot_system_prompt_static() {
    static const std::string s = copilot_system_prompt();
    return s;
}

namespace detail {

// The interviewer's recent lines from a rendered history ("[Outros] ..."),
// newest kept, used as low-weight retrieval context for follow-ups.
inline std::string interviewer_tail(const std::string& history, std::size_t max_chars) {
    std::vector<std::string_view> lines;
    std::size_t start = 0;
    const std::string_view h(history);
    while (start < h.size()) {
        std::size_t end = h.find('\n', start);
        if (end == std::string_view::npos) end = h.size();
        const std::string_view line = h.substr(start, end - start);
        if (line.rfind("[Outros] ", 0) == 0) lines.push_back(line.substr(9));
        start = end + 1;
    }
    std::string out;
    for (auto it = lines.rbegin(); it != lines.rend(); ++it) {
        if (out.size() + it->size() + 1 > max_chars && !out.empty()) break;
        out.insert(0, std::string(*it) + "\n");
    }
    return out;
}

inline std::string with_profile(std::string system, const PromptConfig& cfg) {
    std::string profile;
    if (cfg.session_profile) {
        profile = text::trim(cfg.session_profile());
    } else if (!cfg.dynamic_rag) {
        const std::string notes = text::trim(cfg.user_context);
        if (!notes.empty()) profile = "=== NOTAS DO USUÁRIO ===\n" + notes;
    }
    if (!profile.empty()) {
        system += "\n\n=== PERFIL DA SESSÃO (os únicos fatos permitidos sobre mim) ===\n";
        system += text::truncate_utf8(profile, cfg.max_context_chars);
    }
    return system;
}

inline std::string retrieved_context(const PromptConfig& cfg, const std::string& question,
                                     const std::string& history) {
    if (cfg.rag_retrieve) {
        return text::trim(cfg.rag_retrieve(question, interviewer_tail(history, 600)));
    }
    if (cfg.dynamic_rag) {
        // Legacy resolver: combine the question with the recent dialogue so
        // follow-ups ("e como você escalou isso?") still find the project.
        const std::string q = history.empty() ? question : (question + "\n" + text::tail_utf8(history, 550));
        return text::truncate_utf8(text::trim(cfg.dynamic_rag(q)), cfg.max_context_chars);
    }
    return {};
}

} // namespace detail

// Automatic answers may be "[SKIP]": the model saw nothing to answer (a cut
// phrase, a remark, noise, talk with someone else). The engine reads the
// first characters before showing the card.
enum class SkipVerdict { Undecided, Skip, Answer };

inline SkipVerdict skip_verdict(std::string_view text) {
    std::size_t i = 0;
    while (i < text.size() && (text::is_space(text[i]) || text[i] == '*' || text[i] == '`' || text[i] == '"' ||
                               text[i] == '\'' || text[i] == '[' || text[i] == '_')) {
        ++i;
    }
    const std::string_view t = text.substr(i);
    static constexpr std::string_view kTag = "SKIP";
    for (std::size_t k = 0; k < kTag.size(); ++k) {
        if (k >= t.size()) return SkipVerdict::Undecided;
        char c = t[k];
        if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
        if (c != kTag[k]) return SkipVerdict::Answer;
    }
    if (t.size() == kTag.size()) return SkipVerdict::Undecided; // "SKIP" or "SKIPPED..."?
    const char next = t[kTag.size()];
    const bool letter = (next >= 'a' && next <= 'z') || (next >= 'A' && next <= 'Z');
    return letter ? SkipVerdict::Answer : SkipVerdict::Skip;
}

inline std::vector<ChatMessage> build_copilot_messages(const PromptConfig& cfg,
                                                       const std::string& history,
                                                       const std::string& trigger_text,
                                                       TriggerReason reason,
                                                       const std::string& keyword = {},
                                                       bool allow_skip = false) {
    std::string system = detail::with_profile(copilot_system_prompt_static(), cfg);

    std::string user;
    const std::string ctx = detail::retrieved_context(cfg, trigger_text, history);
    user += "TRECHOS RECUPERADOS PARA ESTA PERGUNTA:\n";
    user += ctx.empty() ? std::string("(nenhum trecho específico; use só o perfil da sessão e a conversa)") : ctx;
    user += "\n\nTranscrição recente (mais antiga primeiro):\n";
    user += history.empty() ? std::string("(vazia)\n")
                            : text::tail_utf8(history, cfg.max_history_chars);
    // The interviewer's last lines on their own: the question is usually spread
    // over them (the STT closes a phrase on every short pause).
    const std::string window = detail::interviewer_tail(history, 600);
    if (!window.empty()) {
        user += "\nFALAS RECENTES DO ENTREVISTADOR (podem estar picadas ou mal transcritas; a pergunta pode estar "
                "espalhada entre elas):\n";
        user += window;
    }
    user += "\nGatilho: ";
    switch (reason) {
        case TriggerReason::Question: user += "pergunta"; break;
        case TriggerReason::Keyword:  user += "palavra-chave \"" + keyword + "\""; break;
        case TriggerReason::LongTurn: user += "fala longa"; break;
        case TriggerReason::Manual:   user += "pedido manual do usuário"; break;
        case TriggerReason::None:     user += "nenhum"; break;
        default:                      user += "pedido do usuário"; break;
    }
    user += "\nFala que disparou a resposta (transcrição literal, pode ser só o último pedaço):\n\"";
    user += trigger_text;
    user += "\"\n\n";
    if (reason == TriggerReason::Keyword || reason == TriggerReason::LongTurn) {
        // Not a question: a STAR story here would be an answer to nothing.
        user += "Esta fala não é uma pergunta. Escreva a linha PERGUNTA com o que ele está pedindo ou comentando. "
                "Se ela pedir algo de mim (uma experiência, uma opinião), responda em STAR natural; "
                "senão, sugira 1 a 2 frases curtas para eu reagir ou uma pergunta para eu fazer de volta.";
    } else {
        user += "Primeiro a linha PERGUNTA (a pergunta inteira, reconstruída a partir das falas recentes do entrevistador), "
                "depois a resposta em STAR natural, sem rótulos, no idioma da pergunta, só com fatos do perfil, "
                "dos trechos relevantes e da conversa.";
        if (allow_skip) {
            // Automatic trigger: nobody asked for this card, so a non-question
            // must not become an answer.
            user += "\nSe esta fala NÃO for uma pergunta ou um pedido para mim (frase cortada sem sentido, comentário, "
                    "ruído, conversa com outra pessoa), escreva somente [SKIP] e nada mais. Na dúvida, responda.";
        }
    }
    return {ChatMessage{"system", std::move(system), {}}, ChatMessage{"user", std::move(user), {}}};
}

// ---------------------------------------------------------------------------
// The "PERGUNTA:" / "QUESTION:" header the live answer starts with. The
// overlay shows it as the card title (what the copilot understood) and strips
// it from the body the candidate reads aloud; the engine stores it as the
// question of the answer. Answers without the header are passed through.
// ---------------------------------------------------------------------------
struct InterpretedAnswer {
    // The text starts with the header (or a prefix of it while streaming).
    bool has_header{false};
    // The header line is finished (newline seen, or the stream ended).
    bool header_complete{false};
    std::string question; // header content, trimmed ("" when none)
    std::string body;     // the answer without the header
};

namespace detail {

// Leading spaces and Markdown decoration before the header word.
inline std::size_t header_lead(std::string_view s) {
    std::size_t i = 0;
    while (i < s.size() && (text::is_space(s[i]) || s[i] == '*' || s[i] == '_' || s[i] == '#' || s[i] == '>')) ++i;
    return i;
}

inline std::string strip_md_decoration(std::string_view s) {
    std::string t = text::trim(s);
    while (!t.empty() && (t.front() == '*' || t.front() == '_')) t.erase(t.begin());
    while (!t.empty() && (t.back() == '*' || t.back() == '_')) t.pop_back();
    return text::trim(t);
}

} // namespace detail

// `final`: the stream ended, so a header without a newline is still complete
// (the question then ends at its first '?').
inline InterpretedAnswer split_interpreted_answer(std::string_view text_in, bool final = false) {
    InterpretedAnswer out;
    const std::size_t lead = detail::header_lead(text_in);
    const std::string_view t = text_in.substr(lead);
    static constexpr std::string_view kTags[] = {"pergunta entendida", "pergunta", "question"};
    std::size_t tag_len = 0;
    bool partial = false;
    for (std::string_view tag : kTags) {
        const std::size_t n = std::min(tag.size(), t.size());
        bool same = true;
        for (std::size_t i = 0; i < n && same; ++i) {
            char c = t[i];
            if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
            same = c == tag[i];
        }
        if (!same) continue;
        if (t.size() < tag.size()) {
            partial = true; // "PERG" while streaming
            continue;
        }
        // The tag is followed (after optional "**") by ':'.
        std::size_t j = tag.size();
        while (j < t.size() && (t[j] == '*' || t[j] == '_' || t[j] == ' ')) ++j;
        if (j >= t.size()) {
            partial = true;
            continue;
        }
        if (t[j] == ':') {
            tag_len = j + 1;
            break;
        }
    }
    if (tag_len == 0) {
        if (partial && !final) {
            out.has_header = true; // could still become the header: show nothing yet
            return out;
        }
        out.body = std::string(text_in);
        return out;
    }
    out.has_header = true;
    const std::string_view rest = t.substr(tag_len);
    const std::size_t nl = rest.find('\n');
    if (nl == std::string_view::npos) {
        if (!final) return out; // header still streaming
        // No line break at all: the question ends at its first '?'.
        const std::size_t q = rest.find('?');
        if (q != std::string_view::npos) {
            out.question = detail::strip_md_decoration(rest.substr(0, q + 1));
            out.body = text::trim(rest.substr(q + 1));
        } else {
            out.question = detail::strip_md_decoration(rest);
        }
        out.header_complete = true;
        return out;
    }
    out.question = detail::strip_md_decoration(rest.substr(0, nl));
    out.header_complete = true;
    std::string_view body = rest.substr(nl + 1);
    while (!body.empty() && (body.front() == '\n' || body.front() == '\r' || body.front() == ' ')) body.remove_prefix(1);
    out.body = std::string(body);
    return out;
}

// ---------------------------------------------------------------------------
// Explicit user actions from the overlay: chat, screenshot, recap, follow-up.
// ---------------------------------------------------------------------------

struct ActionInput {
    TriggerReason reason{TriggerReason::Chat};
    std::string text;      // typed question (chat/screenshot), may be empty
    std::string image_url; // data:image/jpeg;base64,... (screenshot)
};

// One earlier chat/screenshot exchange, replayed so follow-up questions in
// the chat keep their thread ("e o segundo ponto?").
struct ChatTurn {
    std::string question;
    std::string answer;
};

inline std::string action_system_prompt(TriggerReason r) {
    std::string p =
        "Você é um copiloto de entrevista em tempo real. Sua resposta aparece num HUD pequeno "
        "na tela do usuário enquanto a conversa acontece. A transcrição tem duas origens: "
        "[Você] é o usuário (o candidato) e [Outros] são os demais participantes.\n\n";
    switch (r) {
        case TriggerReason::Recap:
            p += "Tarefa: resuma a conversa até agora para o usuário.\n"
                 "Formato (texto puro, sem títulos): até 4 bullets curtos com os pontos principais.\n"
                 "Decisões: uma linha, separadas por \";\". Omita se não houver.\n"
                 "Pendências: uma linha com o que ficou em aberto. Omita se não houver.\n";
            break;
        case TriggerReason::FollowUp:
            p += "Tarefa: sugira 3 perguntas curtas que o usuário pode fazer agora a [Outros] para "
                 "avançar a conversa (entender necessidade, prazo, decisão, próximos passos).\n"
                 "Formato: 3 bullets, cada um com uma pergunta pronta para falar, no idioma da conversa.\n";
            break;
        case TriggerReason::Screenshot:
            p += "O usuário anexou uma captura da própria tela. Use a imagem junto com a transcrição "
                 "para ajudar no que for relevante agora: se houver pergunta do usuário, responda a ela; "
                 "senão, diga em poucas linhas o que importa na tela e o que o usuário pode dizer ou fazer.\n"
                 "Formato: texto puro, até 6 bullets curtos. Se for uma pergunta de entrevista, responda em STAR natural "
                 "(texto corrido, sem rótulos).\n";
            break;
        default:
            p += "Tarefa: atenda ao pedido que o usuário digitou.\n"
                 "- Se for uma pergunta de entrevista, um pedido de exemplo ou de reformulação da resposta, "
                 "responda em STAR natural: texto corrido em primeira pessoa, sem os rótulos Situação/Tarefa/Ação/Resultado, "
                 "começando pela resposta direta e contando a história real (contexto, o que eu fiz, resultado) "
                 "como prova, até 150 palavras.\n"
                 "- Se o pedido for código, responda com o código e uma linha de complexidade.\n";
            break;
    }
    p += "\nRegras:\n"
         "- Mantenha a mesma persona do candidato, reutilizando a conversa e o [Histórico de Respostas já Sugeridas pelo Copiloto] para total consistência.\n"
         "- Use apenas fatos da transcrição, do PERFIL DA SESSÃO, dos TRECHOS RECUPERADOS e da imagem (se houver). "
         "Se a informação não estiver lá, diga isso em uma linha e não invente.\n"
         "- Nunca invente números, nomes, clientes ou experiências do usuário.\n"
         "- Responda no idioma da pergunta do usuário (ou da conversa, se não houver pergunta).\n"
         "- Não use travessão. Use **negrito** só nos rótulos ou em no máximo 2 termos-chave.";
    return p;
}

inline std::vector<ChatMessage> build_action_messages(const PromptConfig& cfg, const std::string& history,
                                                      const ActionInput& in,
                                                      const std::vector<ChatTurn>& chat = {}) {
    std::vector<ChatMessage> msgs;
    msgs.push_back(ChatMessage{"system", detail::with_profile(action_system_prompt(in.reason), cfg), {}});

    std::string ctx_block;
    const bool wants_retrieval = in.reason == TriggerReason::Chat || in.reason == TriggerReason::Screenshot;
    if (wants_retrieval) {
        const std::string ctx = detail::retrieved_context(cfg, in.text, history);
        ctx_block += "TRECHOS RECUPERADOS PARA ESTE PEDIDO:\n";
        ctx_block += ctx.empty() ? std::string("(nenhum)") : ctx;
        ctx_block += "\n\n";
    }
    ctx_block += "Transcrição recente (mais antiga primeiro):\n";
    ctx_block += history.empty() ? std::string("(vazia)\n") : text::tail_utf8(history, cfg.max_history_chars);

    const bool threaded = in.reason == TriggerReason::Chat || in.reason == TriggerReason::Screenshot;
    if (threaded && !chat.empty()) {
        // Earlier exchanges first, then the new question with fresh context.
        for (const auto& t : chat) {
            msgs.push_back(ChatMessage{"user", t.question, {}});
            msgs.push_back(ChatMessage{"assistant", t.answer, {}});
        }
    }

    std::string user = ctx_block;
    switch (in.reason) {
        case TriggerReason::Recap:
            user += "\nPedido: resumo da conversa até agora.";
            break;
        case TriggerReason::FollowUp:
            user += "\nPedido: perguntas de follow-up para eu fazer agora.";
            break;
        case TriggerReason::Screenshot:
            user += "\nCaptura da minha tela anexada.";
            user += in.text.empty() ? std::string("\nPedido: o que é relevante aqui?")
                                    : "\nMinha pergunta: " + in.text;
            break;
        default:
            user += "\nMinha pergunta: " + in.text;
            break;
    }
    ChatMessage m{"user", std::move(user), {}};
    if (!in.image_url.empty()) m.images.push_back(in.image_url);
    msgs.push_back(std::move(m));
    return msgs;
}

// ---------------------------------------------------------------------------
// Grounding post-check: numbers in the answer (2+ digits, %, money, years)
// that appear nowhere in the material the model was given. A cheap, local
// guard against invented metrics; the engine surfaces them as a warning so
// the candidate doesn't say a number that isn't in their files.
// ---------------------------------------------------------------------------
namespace detail {

inline std::vector<std::string> numbers_in(std::string_view s) {
    std::vector<std::string> out;
    std::string cur;
    for (std::size_t i = 0; i <= s.size(); ++i) {
        const char c = i < s.size() ? s[i] : ' ';
        if (c >= '0' && c <= '9') {
            cur.push_back(c);
        } else if ((c == '.' || c == ',') && !cur.empty() && i + 1 < s.size() && s[i + 1] >= '0' &&
                   s[i + 1] <= '9') {
            cur.push_back(c);
        } else {
            if (!cur.empty()) out.push_back(cur);
            cur.clear();
        }
    }
    return out;
}

// Digits only, trailing zeros dropped: "45.000", "45000" and "45" (as in
// "45 mil") all normalize to "45"; lenient on purpose (warn, never block).
inline std::string number_core(std::string_view n) {
    std::string d;
    for (char c : n) if (c >= '0' && c <= '9') d.push_back(c);
    while (d.size() > 1 && d.back() == '0') d.pop_back();
    return d;
}

} // namespace detail

inline std::vector<std::string> ungrounded_numbers(std::string_view answer, std::string_view grounding) {
    std::vector<std::string> known;
    for (const auto& n : detail::numbers_in(grounding)) known.push_back(detail::number_core(n));
    std::vector<std::string> out;
    for (const auto& n : detail::numbers_in(answer)) {
        std::string digits;
        for (char c : n) if (c >= '0' && c <= '9') digits.push_back(c);
        if (digits.size() < 2) continue; // "3 passos", "2 semanas": too noisy to flag
        const std::string core = detail::number_core(n);
        if (std::find(known.begin(), known.end(), core) != known.end()) continue;
        if (std::find(out.begin(), out.end(), n) == out.end()) out.push_back(n);
    }
    return out;
}

// Names and technical terms in the answer that appear nowhere in what the
// model was given (profile, excerpts, conversation): a cheap guard against
// invented employers, products and tools. Like the number check, it warns
// and never blocks. Generic terms that need no source are ignored.
inline std::vector<std::string> ungrounded_terms(std::string_view answer, std::string_view grounding) {
    static const char* const kGeneric[] = {
        "star", "situacao", "tarefa", "acao", "resultado", "situation", "task", "action", "result",
        "pergunta", "question", "entendida",
        "api", "apis", "rest", "http", "https", "sql", "nosql", "json", "xml", "cpu", "gpu", "ram", "mvp",
        "ia", "ai", "ml", "ok", "ui", "ux", "kpi", "kpis", "sla", "slo", "crud", "poc", "faq", "ceo", "cto",
        "qa", "ci", "cd", "devops", "scrum", "kanban", "agile", "eu", "nos", "minha", "meu", "ainda"};
    const std::string g = text::fold(grounding);
    std::vector<std::string> out;
    std::string word;
    bool sentence_start = true, next_start = true;
    auto consider = [&](const std::string& w, bool at_start) {
        if (w.size() < 3 || w.size() > 30) return;
        bool upper0 = std::isupper(static_cast<unsigned char>(w[0])) != 0;
        bool inner_upper = false, all_upper = true, digit = false, alpha = false;
        for (std::size_t i = 0; i < w.size(); ++i) {
            const unsigned char c = static_cast<unsigned char>(w[i]);
            if (std::isupper(c) && i > 0) inner_upper = true;
            if (std::islower(c)) all_upper = false;
            if (std::isdigit(c)) digit = true;
            if (std::isalpha(c)) alpha = true;
        }
        const bool acronym = all_upper && alpha && w.size() <= 8;
        const bool camel = inner_upper && !all_upper;
        const bool proper = upper0 && !at_start;
        const bool tech = digit && alpha;
        if (!(acronym || camel || proper || tech)) return;
        const std::string f = text::fold(w);
        for (const char* gw : kGeneric) if (f == gw) return;
        if (text::contains_word(g, f)) return;
        if (std::find(out.begin(), out.end(), w) == out.end()) out.push_back(w);
    };
    for (std::size_t i = 0; i <= answer.size(); ++i) {
        const unsigned char c = i < answer.size() ? static_cast<unsigned char>(answer[i]) : ' ';
        if (std::isalnum(c) || c >= 0x80 || c == '+' || c == '#') {
            if (word.empty()) sentence_start = next_start;
            word.push_back(static_cast<char>(c));
        } else {
            if (!word.empty()) {
                consider(word, sentence_start);
                next_start = false;
                word.clear();
            }
            // Sentence and label starts ("**Ação:** Implementei") are not names.
            if (c == '.' || c == '!' || c == '?' || c == '\n' || c == ':' || c == '*' || c == '"' || c == '(')
                next_start = true;
        }
    }
    return out;
}

} // namespace rtai