// Pure core: the story ledger. Everything the candidate already claimed in
// this interview, kept for the whole session and across sessions of the same
// goal, so every answer tells the same story: same project, same role, same
// numbers, same opinion.
//
// How it differs from the answer memory (rtai/answer_memory.hpp): the memory
// holds one thread in detail and is wiped when the subject changes; the
// ledger holds one short line per answer and is never wiped. It goes in every
// answer prompt, on any subject.
//
//   * add(): one entry per finished answer: the question as understood and the
//     opening sentences of the answer (the thesis and the story it picked).
//   * Past its budget, a background model folds the older entries into a
//     summary of facts (compaction_job / set_summary), off the live path.
//   * prior(): what earlier sessions of the same goal left (persistable()).
//
// The JS port is Browser/Home/src/lib/live/storyLedger.js; both are checked
// against tests/fixtures/live_parity/ledger.json.
//
// Single-threaded: the engine calls it only from its orchestrator thread.
#pragma once

#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

#include "rtai/llm.hpp"
#include "rtai/text_util.hpp"

namespace rtai {

struct StoryLedgerConfig {
    // Each entry keeps this much of the answer (its first sentences).
    std::size_t entry_chars{260};
    // Each entry keeps this much of the question.
    std::size_t question_chars{160};
    // What render() may send with a prompt.
    std::size_t prompt_chars{1400};
    // Upper bound of the summary of older entries.
    std::size_t summary_chars{800};
    // Upper bound of what earlier sessions left.
    std::size_t prior_chars{500};
    // Entries kept; the oldest are dropped once summarized.
    std::size_t max_entries{16};
};

class StoryLedger {
public:
    struct Entry {
        std::string question;
        std::string said;
    };

    explicit StoryLedger(StoryLedgerConfig cfg = {}) : cfg_(cfg) {}

    // What earlier sessions of this goal left (the stored persistable()).
    void set_prior(std::string_view prior) { prior_ = text::truncate_utf8(text::trim(prior), cfg_.prior_chars); }
    [[nodiscard]] const std::string& prior() const noexcept { return prior_; }

    // Records a finished answer. Returns false when there was nothing to keep.
    bool add(std::string_view question, std::string_view answer) {
        std::string q = text::truncate_utf8(one_line(question), cfg_.question_chars);
        std::string a = opening(answer, cfg_.entry_chars);
        if (q.empty() || a.empty()) return false;
        // The same question again (a retry, a rephrase of the card): keep the
        // newest wording only.
        if (!entries_.empty() && entries_.back().question == q) {
            entries_.back().said = std::move(a);
            return true;
        }
        entries_.push_back(Entry{std::move(q), std::move(a)});
        while (entries_.size() > cfg_.max_entries && covered_ > 0) {
            entries_.erase(entries_.begin());
            --covered_;
        }
        return true;
    }

    [[nodiscard]] bool empty() const noexcept { return entries_.empty() && summary_.empty() && prior_.empty(); }
    [[nodiscard]] std::size_t size() const noexcept { return entries_.size(); }
    [[nodiscard]] const std::string& summary() const noexcept { return summary_; }

    // Ready to paste in the prompt; empty when nothing was said yet. Earlier
    // sessions first, then the summary, then the newest entries that fit (the
    // latest one always goes).
    [[nodiscard]] std::string render() const { return render_within(cfg_.prompt_chars); }

    // What the next session of the same goal should know: this session's
    // facts, one block of text.
    [[nodiscard]] std::string persistable() const {
        std::string out;
        if (!prior_.empty()) out += prior_ + "\n";
        if (!summary_.empty()) out += summary_ + "\n";
        for (std::size_t i = covered_; i < entries_.size(); ++i) out += line(entries_[i]);
        return text::tail_utf8(text::trim(out), cfg_.prior_chars);
    }

    // Compaction is due when the entries not yet in the summary no longer fit.
    [[nodiscard]] bool needs_compaction() const {
        if (entries_.size() < covered_ + 3) return false;
        std::size_t n = 0;
        for (std::size_t i = covered_; i < entries_.size(); ++i) n += line(entries_[i]).size();
        const std::size_t fixed = (prior_.empty() ? 0 : prior_.size() + 40) + (summary_.empty() ? 0 : summary_.size() + 40);
        return fixed + n > cfg_.prompt_chars;
    }

    struct CompactionJob {
        std::size_t covered{0};
        std::vector<ChatMessage> messages;
    };

    // Folds everything but the two latest entries into the summary. `spoken`:
    // what the candidate really said on the microphone; it wins over what the
    // copilot suggested.
    [[nodiscard]] CompactionJob compaction_job(std::string_view spoken = {}) const {
        CompactionJob job;
        job.covered = entries_.size() > 2 ? entries_.size() - 2 : 0;
        std::string user;
        if (!summary_.empty()) user += "Fatos já registrados:\n" + summary_ + "\n\n";
        user += "Novas respostas:\n";
        for (std::size_t i = covered_; i < job.covered; ++i) user += line(entries_[i]);
        const std::string mic = text::trim(spoken);
        if (!mic.empty()) {
            user += "\nO que eu falei de fato no microfone (vale mais que a resposta sugerida quando forem diferentes):\n";
            user += text::tail_utf8(mic, 900) + "\n";
        }
        job.messages = {
            ChatMessage{"system",
                        "Você mantém o registro do que um candidato já afirmou numa entrevista, para ele nunca se "
                        "contradizer nas próximas respostas. Escreva em primeira pessoa, em até 8 linhas curtas, uma "
                        "afirmação por linha: qual projeto ou história eu usei para cada tema, meu papel, as "
                        "tecnologias, os números e as opiniões que eu defendi. Junte o que já estava registrado com "
                        "as novas respostas, sem repetir. Use só o que está escrito, sem inventar nem opinar. "
                        "Mantenha nomes e números exatamente como estão. Sem títulos.",
                        {}},
            ChatMessage{"user", std::move(user), {}}};
        return job;
    }

    void set_summary(std::size_t covered, std::string_view summary) {
        std::string s = text::truncate_utf8(text::trim(summary), cfg_.summary_chars);
        if (s.empty() || covered <= covered_ || covered > entries_.size()) return;
        summary_ = std::move(s);
        covered_ = covered;
        while (entries_.size() > cfg_.max_entries && covered_ > 0) {
            entries_.erase(entries_.begin());
            --covered_;
        }
    }

    // The first sentences of an answer within max_chars: the thesis and the
    // story it picked. Cut at a sentence end when one fits.
    [[nodiscard]] static std::string opening(std::string_view answer, std::size_t max_chars) {
        const std::string flat = one_line(answer);
        if (flat.size() <= max_chars) return flat;
        const std::string cut = text::truncate_utf8(flat, max_chars);
        std::size_t end = std::string::npos;
        for (std::size_t i = cut.size(); i-- > 0;) {
            if (cut[i] == '.' || cut[i] == '!' || cut[i] == '?') {
                end = i;
                break;
            }
        }
        // A sentence end in the first third would keep too little.
        if (end != std::string::npos && end >= max_chars / 3) return cut.substr(0, end + 1);
        return text::trim(cut) + "...";
    }

private:
    // One line, single spaces, no Markdown bold.
    [[nodiscard]] static std::string one_line(std::string_view s) {
        std::string out;
        bool space = false;
        for (char c : s) {
            if (c == '*') continue;
            if (c == '\n' || c == '\r' || c == '\t' || c == ' ') {
                space = !out.empty();
                continue;
            }
            if (space) out.push_back(' ');
            space = false;
            out.push_back(c);
        }
        return out;
    }

    [[nodiscard]] static std::string line(const Entry& e) {
        return "- Perguntaram: " + e.question + "\n  Eu disse: " + e.said + "\n";
    }

    [[nodiscard]] std::string render_within(std::size_t budget) const {
        if (empty()) return {};
        std::string head;
        if (!prior_.empty()) head += "Em entrevistas anteriores para esta vaga:\n" + prior_ + "\n";
        if (!summary_.empty()) head += "Nesta entrevista, até aqui:\n" + summary_ + "\n";
        std::vector<std::string> lines;
        std::size_t used = head.size();
        for (std::size_t i = entries_.size(); i-- > covered_;) {
            std::string l = line(entries_[i]);
            if (used + l.size() > budget && !lines.empty()) break;
            used += l.size();
            lines.push_back(std::move(l));
        }
        std::string out = std::move(head);
        if (!lines.empty()) {
            if (!out.empty()) out += "Depois disso:\n";
            for (auto it = lines.rbegin(); it != lines.rend(); ++it) out += *it;
        }
        return out;
    }

    StoryLedgerConfig cfg_;
    std::string prior_;
    std::string summary_;
    std::vector<Entry> entries_;
    std::size_t covered_{0}; // entries_[0..covered_) are in summary_
};

} // namespace rtai
