// Pure core: what the copilot already answered, sent back with the next
// question so the candidate keeps one persona across follow-ups.
//
// The memory holds one thread: the exchanges about the current subject.
//   * A follow-up on the same subject ("e como você escalou isso?", "por que
//     Docker?") gets the thread back: verbatim while it is small, then a
//     compact summary of the older exchanges (written off the live path by a
//     background model) plus the latest exchange verbatim.
//   * A question on another subject gets nothing, and its answer starts a new
//     thread, so an old story never leaks into an unrelated answer.
//
// Single-threaded: the engine calls it only from its orchestrator thread.
#pragma once

#include <cstddef>
#include <cstdint>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "rtai/llm.hpp"
#include "rtai/text_util.hpp"

namespace rtai {

struct AnswerMemoryConfig {
    // The thread is sent as-is up to this size; past it, the older exchanges
    // are compacted into a summary.
    std::size_t verbatim_budget_chars{1600};
    // Each stored answer is cut here (the gist is in the first sentences).
    std::size_t answer_chars{700};
    // Upper bound of the summary kept for a thread.
    std::size_t summary_chars{900};
    // Exchanges kept per thread; the oldest are dropped once summarized.
    std::size_t max_exchanges{8};
};

class AnswerMemory {
public:
    struct Exchange {
        std::string question;
        std::string answer;
    };
    enum class Kind : std::uint8_t { None, Verbatim, Summary };
    struct Context {
        Kind kind{Kind::None};
        std::string text; // ready to paste in the prompt; empty for None
    };

    explicit AnswerMemory(AnswerMemoryConfig cfg = {}) : cfg_(cfg) {}

    // True when `question` (plus the interviewer's recent lines) continues the
    // current thread: an explicit follow-up cue, or enough shared subject words.
    [[nodiscard]] bool continues_thread(std::string_view question, std::string_view recent = {}) const {
        if (exchanges_.empty() && summary_.empty()) return false;
        if (has_follow_up_cue(question)) return true;
        std::set<std::string> asked = keywords(question);
        for (auto& w : keywords(recent)) asked.insert(w);
        // Long, specific words (tools, project and company names) weigh more
        // than short ones; generic interview words do not count at all.
        int score = 0;
        for (const auto& w : asked) {
            if (thread_words_.count(w)) score += w.size() >= 6 ? 2 : 1;
        }
        return score >= 2;
    }

    // Records a finished answer. On another subject, it starts a new thread.
    void add(std::string question, std::string answer) {
        question = text::trim(question);
        answer = text::truncate_utf8(text::trim(answer), cfg_.answer_chars);
        if (question.empty() || answer.empty()) return;
        if (!continues_thread(question)) start_thread();
        for (auto& w : keywords(question)) thread_words_.insert(w);
        for (auto& w : keywords(answer)) thread_words_.insert(w);
        exchanges_.push_back(Exchange{std::move(question), std::move(answer)});
        // Only exchanges already folded into the summary may be dropped.
        while (exchanges_.size() > cfg_.max_exchanges && covered_ > 0) {
            exchanges_.erase(exchanges_.begin());
            --covered_;
        }
    }

    // What to send with a new question: nothing when the subject changed.
    [[nodiscard]] Context for_question(std::string_view question, std::string_view recent = {}) const {
        if (!continues_thread(question, recent)) return {};
        return render();
    }

    // The whole thread regardless of subject: for explicit requests about the
    // conversation (chat with the copilot, recap, follow-up questions).
    [[nodiscard]] Context render() const {
        Context out;
        if (exchanges_.empty() && summary_.empty()) return out;
        const std::size_t first = summary_.empty() ? verbatim_start() : covered_;
        std::string body;
        if (!summary_.empty()) {
            out.kind = Kind::Summary;
            body += "Resumo do que eu já respondi sobre este assunto:\n" + summary_ + "\n";
        } else {
            out.kind = Kind::Verbatim;
        }
        if (first < exchanges_.size()) {
            body += summary_.empty() ? "Respostas que eu já dei sobre este assunto:\n"
                                     : "Depois disso:\n";
            for (std::size_t i = first; i < exchanges_.size(); ++i) {
                body += "- Pergunta: " + exchanges_[i].question + "\n  Minha resposta: " + exchanges_[i].answer + "\n";
            }
        }
        out.text = std::move(body);
        return out;
    }

    // Compaction is due when the exchanges not yet in the summary no longer
    // fit the verbatim budget and at least two of them can be folded.
    [[nodiscard]] bool needs_compaction() const {
        return exchanges_.size() >= covered_ + 2 && verbatim_chars(covered_) > cfg_.verbatim_budget_chars;
    }

    // The request for the background model: fold everything but the latest
    // exchange into the summary. `covered` is what set_summary() will cover.
    struct CompactionJob {
        std::uint64_t thread{0};
        std::size_t covered{0};
        std::vector<ChatMessage> messages;
    };
    [[nodiscard]] CompactionJob compaction_job() const {
        CompactionJob job;
        job.thread = thread_;
        job.covered = exchanges_.empty() ? 0 : exchanges_.size() - 1;
        std::string user;
        if (!summary_.empty()) user += "Resumo anterior:\n" + summary_ + "\n\n";
        user += "Novas perguntas e respostas:\n";
        for (std::size_t i = covered_; i < job.covered; ++i) {
            user += "- Pergunta: " + exchanges_[i].question + "\n  Resposta: " + exchanges_[i].answer + "\n";
        }
        job.messages = {
            ChatMessage{"system",
                        "Você resume, para o próprio candidato, o que ele já respondeu nesta entrevista sobre um "
                        "assunto, para ele continuar coerente nas próximas perguntas. Escreva em primeira pessoa, "
                        "em até 6 linhas curtas: os fatos que eu afirmei (projeto, meu papel, tecnologias, números, "
                        "decisões, resultados) e a posição que eu defendi. Use só o que está nas respostas, sem "
                        "inventar nem opinar. Mantenha nomes e números exatamente como estão. Sem títulos.",
                        {}},
            ChatMessage{"user", std::move(user), {}}};
        return job;
    }

    // Stores a summary written for `thread` up to `covered` exchanges. A
    // summary for an older thread (the subject changed meanwhile) is dropped.
    void set_summary(std::uint64_t thread, std::size_t covered, std::string summary) {
        summary = text::truncate_utf8(text::trim(summary), cfg_.summary_chars);
        if (thread != thread_ || summary.empty() || covered <= covered_ || covered > exchanges_.size()) return;
        summary_ = std::move(summary);
        covered_ = covered;
        while (exchanges_.size() > cfg_.max_exchanges && covered_ > 0) {
            exchanges_.erase(exchanges_.begin());
            --covered_;
        }
    }

    void clear() { start_thread(); }

    [[nodiscard]] std::uint64_t thread() const noexcept { return thread_; }
    [[nodiscard]] std::size_t size() const noexcept { return exchanges_.size(); }
    [[nodiscard]] const std::string& summary() const noexcept { return summary_; }

    // "e como...", "esse projeto", "você mencionou": the question points back
    // at something already said.
    [[nodiscard]] static bool has_follow_up_cue(std::string_view question) {
        const std::string q = " " + text::fold(question) + " ";
        static constexpr std::string_view kCues[] = {
            " isso ", " disso ", " nisso ", " esse projeto", " este projeto", " nesse projeto", " neste projeto",
            " desse projeto", " deste projeto", " nesse caso", " neste caso", " nessa ", " nesse ", " naquele ",
            " voce comentou", " voce mencionou", " voce falou", " voce disse", " voce citou", " como voce disse",
            " e como ", " e por que", " e porque", " e qual", " e quais", " e o que", " e se ", " me fala mais",
            " fala mais", " conta mais", " me conta mais", " mais detalhes", " detalhar", " detalha ", " aprofund",
            " voltando ", " sobre esse", " sobre essa", " sobre isso",
            " you mentioned", " you said", " that project", " this project", " tell me more", " elaborate",
            " go deeper", " dig into", " and how ", " and why ", " why did you", " how did you"};
        for (std::string_view cue : kCues) {
            if (q.find(cue) != std::string::npos) return true;
        }
        return false;
    }

    // Subject words: folded, 4+ letters, minus stopwords and the vocabulary
    // every interview question shares ("projeto", "experiência"...).
    [[nodiscard]] static std::set<std::string> keywords(std::string_view s) {
        static const std::set<std::string> kSkip = {
            // pt
            "como", "voce", "voces", "qual", "quais", "sobre", "para", "pela", "pelo", "pelas", "pelos", "isso",
            "essa", "esse", "este", "esta", "isto", "aqui", "quando", "onde", "porque", "entao", "ainda", "tambem",
            "muito", "muita", "mais", "menos", "fazer", "feito", "fala", "falar", "conte", "conta", "contar",
            "descreva", "explique", "pode", "poderia", "seria", "teria", "tinha", "foram", "estava", "sendo",
            "sido", "coisa", "algum", "alguma", "alguns", "algumas", "cada", "todo", "toda", "todos", "todas",
            "nosso", "nossa", "minha", "meus", "minhas", "suas", "seus", "dele", "dela", "eles", "elas", "gente",
            "exemplo", "vezes", "teve", "tenho", "tive", "fiz", "usou", "usei", "usar", "uma", "umas", "depois",
            "antes", "durante", "entre", "outro", "outra", "outros", "outras", "mesmo", "mesma", "assim", "nunca",
            "sempre", "bem", "pouco", "melhor", "maior", "principal", "forma", "maneira", "jeito", "parte",
            "projeto", "projetos", "experiencia", "experiencias", "trabalho", "trabalhou", "trabalhar", "trabalhei",
            "empresa", "empresas", "vaga", "desafio", "desafios", "situacao", "resposta", "pergunta", "solucao",
            "solucoes", "desenvolver", "desenvolveu", "desenvolvi", "criar", "criou", "criei", "resultado",
            "resultados", "problema", "problemas", "aprender", "aprendeu", "aprendi", "aprendizado", "lidar",
            "lidou", "precisou", "precisei", "imagine", "acha", "pensa", "considera", "porque", "motivo",
            "equipe", "time", "times", "pessoa", "pessoas", "ideia", "ideias", "dias", "anos", "momento", "algo",
            // en
            "what", "when", "where", "which", "there", "their", "about", "would", "could", "should", "tell",
            "more", "with", "that", "this", "have", "from", "your", "they", "them", "then", "than", "into",
            "been", "were", "does", "make", "made", "time", "some", "describe", "explain", "project", "projects",
            "experience", "work", "worked", "working", "company", "challenge", "situation", "solution", "team",
            "problem", "result", "results", "learn", "learned", "example", "thing", "things", "something"};
        std::set<std::string> out;
        const std::string f = text::fold(s);
        std::string w;
        auto flush = [&] {
            if (w.size() >= 4 && !kSkip.count(w)) out.insert(w);
            w.clear();
        };
        for (char ch : f) {
            const auto c = static_cast<unsigned char>(ch);
            if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c >= 0x80) w.push_back(ch);
            else flush();
        }
        flush();
        return out;
    }

private:
    void start_thread() {
        exchanges_.clear();
        summary_.clear();
        thread_words_.clear();
        covered_ = 0;
        ++thread_;
    }

    [[nodiscard]] std::size_t verbatim_chars(std::size_t from) const {
        std::size_t n = 0;
        for (std::size_t i = from; i < exchanges_.size(); ++i) n += exchanges_[i].question.size() + exchanges_[i].answer.size();
        return n;
    }

    // Without a summary yet, the newest exchanges that fit the budget (the
    // latest one always goes).
    [[nodiscard]] std::size_t verbatim_start() const {
        std::size_t used = 0;
        std::size_t i = exchanges_.size();
        while (i > 0) {
            const std::size_t n = exchanges_[i - 1].question.size() + exchanges_[i - 1].answer.size();
            if (used + n > cfg_.verbatim_budget_chars && i < exchanges_.size()) break;
            used += n;
            --i;
        }
        return i;
    }

    AnswerMemoryConfig cfg_;
    std::vector<Exchange> exchanges_;
    std::set<std::string> thread_words_;
    std::string summary_;
    std::size_t covered_{0};  // exchanges_[0, covered_) are folded into summary_
    std::uint64_t thread_{0};
};

} // namespace rtai
