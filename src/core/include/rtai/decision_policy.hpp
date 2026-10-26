// Pure core: decides when a closed turn deserves an automatic suggestion.
// Rules first (cheap, predictable, testable); a model-based judge can be put
// in front of this later behind the same evaluate() call.
//
// Not thread-safe: owned by the copilot engine's orchestrator thread.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "rtai/text_util.hpp"
#include "rtai/turn_assembler.hpp"

namespace rtai {

// Question/Keyword/LongTurn come from the automatic policy; the rest are
// explicit user actions from the overlay (buttons, hotkeys, chat).
enum class TriggerReason : std::uint8_t {
    None, Question, Keyword, LongTurn, Manual, Chat, Screenshot, Recap, FollowUp
};

constexpr const char* to_string(TriggerReason r) noexcept {
    switch (r) {
        case TriggerReason::None:     return "none";
        case TriggerReason::Question: return "question";
        case TriggerReason::Keyword:  return "keyword";
        case TriggerReason::LongTurn: return "long_turn";
        case TriggerReason::Manual:   return "manual";
        case TriggerReason::Chat:       return "chat";
        case TriggerReason::Screenshot: return "screenshot";
        case TriggerReason::Recap:      return "recap";
        case TriggerReason::FollowUp:   return "follow_up";
    }
    return "?";
}

// Human label for the overlay/markdown/console.
constexpr const char* label_pt(TriggerReason r) noexcept {
    switch (r) {
        case TriggerReason::None:     return "";
        case TriggerReason::Question: return "question";
        case TriggerReason::Keyword:  return "keyword";
        case TriggerReason::LongTurn: return "long turn";
        case TriggerReason::Manual:   return "manual";
        case TriggerReason::Chat:       return "chat";
        case TriggerReason::Screenshot: return "screen";
        case TriggerReason::Recap:      return "recap";
        case TriggerReason::FollowUp:   return "follow-up";
    }
    return "";
}

inline std::vector<std::string> default_trigger_keywords() {
    // Folded (lowercase, no accents). Sales/meeting oriented; override with
    // RTAI_KEYWORDS.
    return {"preco", "precos", "valor", "custo", "orcamento", "desconto", "prazo",
            "contrato", "concorrente", "concorrencia", "integracao", "seguranca",
            "lgpd", "garantia", "implantacao", "price", "pricing", "cost", "budget",
            "discount", "deadline", "timeline", "contract", "competitor",
            "integration", "security", "onboarding"};
}

struct DecisionConfig {
    bool auto_enabled{true};
    AudioSource trigger_source{AudioSource::Loopback}; // "Outros"
    std::size_t min_words{2};
    std::int64_t cooldown_ms{2500};
    bool on_question{true};
    bool on_keyword{true};
    bool on_long_turn{false};
    std::size_t long_turn_words{28};
    std::vector<std::string> keywords{default_trigger_keywords()};
    // When the cooldown would otherwise drop a valid question, enqueue it
    // instead (default true). Reduces "perdeu a pergunta" gaps.
    bool enqueue_on_cooldown{true};
    // Implicit requests: declarative turns that carry a keyword and are long
    // enough are treated as needing a suggestion even without "?".
    bool implicit_keyword_request{true};
    std::size_t implicit_keyword_min_words{8};
};

class DecisionPolicy {
public:
    explicit DecisionPolicy(DecisionConfig cfg = {}) : cfg_(std::move(cfg)) {
        for (auto& k : cfg_.keywords) k = text::fold(text::trim(k));
    }

    void set_auto(bool on) { cfg_.auto_enabled = on; }

    // Hot_Path fast filter (Req 1.4): approves an interim for a speculative
    // turn only when it has MORE than 5 words AND looks like a question.
    // Stricter than would_trigger(): no keyword/long-turn, no cooldown.
    [[nodiscard]] bool fast_filter(std::string_view interim) const {
        return text::word_count(interim) > 5 && looks_like_question(interim);
    }

    // Probe without side effects: would this text trigger? `is_question`
    // (the engine's question gate verdict) replaces looks_like_question().
    [[nodiscard]] TriggerReason would_trigger(const std::string& text, std::int64_t now_ms,
                                              std::optional<bool> is_question = std::nullopt) const {
        Turn fake; fake.text = text; fake.source = cfg_.trigger_source;
        // copy cooldown check without mutating last_trigger_ms_
        if (!cfg_.auto_enabled) return TriggerReason::None;
        if (text::word_count(text) < cfg_.min_words) return TriggerReason::None;
        if (is_small_talk(text::fold(text))) return TriggerReason::None;
        std::string core = text::fold(text);
        strip_fillers(core);
        if (core.empty()) return TriggerReason::None;
        if (now_ms >= 0 && last_trigger_ms_ >= 0 && now_ms - last_trigger_ms_ < cfg_.cooldown_ms) return TriggerReason::None;
        if (cfg_.on_question && (is_question ? *is_question : looks_like_question(text))) return TriggerReason::Question;
        if (cfg_.on_keyword) {
            for (const auto& k : cfg_.keywords) if (!k.empty() && text::contains_word(text::fold(text), k)) return TriggerReason::Keyword;
        }
        if (cfg_.implicit_keyword_request && text::word_count(text) >= cfg_.implicit_keyword_min_words) {
            for (const auto& k : cfg_.keywords) if (!k.empty() && text::contains_word(text::fold(text), k)) return TriggerReason::Keyword;
        }
        if (cfg_.on_long_turn && text::word_count(text) >= cfg_.long_turn_words) return TriggerReason::LongTurn;
        return TriggerReason::None;
    }

    [[nodiscard]] std::string probe_keyword(const std::string& text) const {
        auto kw = matched_keyword(text);
        return kw ? *kw : std::string{};
    }

    // Evaluates a closed turn; records the trigger (cooldown) when it fires.
    // `is_question`: the engine's question gate already decided whether the
    // turn is a complete question (nullopt: looks_like_question() decides).
    TriggerReason evaluate(const Turn& turn, std::int64_t now_ms, std::optional<bool> is_question = std::nullopt) {
        last_keyword_.clear();
        if (!cfg_.auto_enabled || turn.source != cfg_.trigger_source) return TriggerReason::None;
        const std::size_t words = text::word_count(turn.text);
        if (words < cfg_.min_words) return TriggerReason::None;
        TriggerReason r = TriggerReason::None;
        if (cfg_.on_question && (is_question ? *is_question : looks_like_question(turn.text))) {
            r = TriggerReason::Question;
        } else if (cfg_.on_keyword) {
            if (auto k = matched_keyword(turn.text)) {
                last_keyword_ = *k;
                r = TriggerReason::Keyword;
            }
        }
        if (r == TriggerReason::None && cfg_.implicit_keyword_request && words >= cfg_.implicit_keyword_min_words) {
            if (auto k = matched_keyword(turn.text)) {
                last_keyword_ = *k;
                r = TriggerReason::Keyword;
            }
        }
        if (r == TriggerReason::None && cfg_.on_long_turn && words >= cfg_.long_turn_words) {
            r = TriggerReason::LongTurn;
        }
        if (r == TriggerReason::None) return r;
        if (last_trigger_ms_ >= 0 && now_ms - last_trigger_ms_ < cfg_.cooldown_ms) {
            // A real question right after a keyword-only suggestion is what
            // the user needs answered: it may replace it inside the cooldown.
            const bool upgrade = r == TriggerReason::Question && last_reason_ == TriggerReason::Keyword;
            if (!upgrade) {
                last_keyword_.clear();
                return TriggerReason::None;
            }
        }
        last_trigger_ms_ = now_ms;
        last_reason_ = r;
        return r;
    }

    // A manual request also starts the cooldown, so the turn that is still
    // being finalized doesn't immediately trigger a duplicate.
    void note_manual(std::int64_t now_ms) {
        last_trigger_ms_ = now_ms;
        last_reason_ = TriggerReason::Manual;
    }

    [[nodiscard]] const std::string& last_keyword() const noexcept { return last_keyword_; }
    [[nodiscard]] const DecisionConfig& config() const noexcept { return cfg_; }

    static bool looks_like_question(std::string_view raw) {
        const std::string f = text::fold(raw);
        // Check every sentence: "Certo. Como voces fazem X". Courtesy
        // questions ("Oi, tudo bem?", "Can you hear me?") don't count.
        std::size_t start = 0;
        while (start < f.size()) {
            std::size_t end = f.find_first_of(".!?;\n", start);
            if (end == std::string::npos) end = f.size();
            const bool asked = end < f.size() && f[end] == '?';
            std::string s = text::trim(std::string_view(f).substr(start, end - start));
            start = end + 1;
            if (s.empty() || is_small_talk(s)) continue;
            if (asked) return true;
            // Check before and after stripping fillers: "e possivel..." starts
            // with the filler "e " but is itself an interrogative.
            for (int pass = 0; pass < 2; ++pass) {
                for (const char* q : kInterrogatives) {
                    if (text::starts_with_word(s, q)) return true;
                }
                strip_fillers(s);
            }
        }
        return false;
    }

    // Greetings and call-check phrases (folded sentence, no end punctuation).
    static bool is_small_talk(std::string s) {
        static const char* const kGreetings[] = {"oi", "ola", "opa", "hey", "hi", "hello", "bom dia",
                                                 "boa tarde", "boa noite", "e ai", "fala", "pessoal",
                                                 "gente", "good morning", "good afternoon"};
        static const char* const kSmallTalk[] = {
            "tudo bem", "tudo bom", "tudo certo", "tudo tranquilo", "tudo joia", "como vai",
            "como vai voce", "como voce esta", "como voces estao", "como esta", "beleza", "td bem",
            "me ouve", "me escuta", "esta me ouvindo", "estao me ouvindo", "consegue me ouvir",
            "conseguem me ouvir", "da pra me ouvir", "da pra ouvir", "esta me vendo", "estao me vendo",
            "how are you", "how are you doing", "how is it going", "hows it going", "how have you been",
            "can you hear me", "can you see me", "you there", "are you there", "all good"};
        bool again = true;
        while (again) {
            again = false;
            while (!s.empty() && (s.front() == ',' || s.front() == ' ')) s.erase(s.begin());
            for (const char* g : kGreetings) {
                if (text::starts_with_word(s, g)) {
                    s = text::trim(std::string_view(s).substr(std::string_view(g).size()));
                    again = true;
                    break;
                }
            }
        }
        while (!s.empty() && (s.back() == ',' || s.back() == ' ')) s.pop_back();
        if (s.empty()) return true;
        for (const char* t : kSmallTalk) {
            if (s == t) return true;
        }
        // Short audio checks: "todo mundo me ouve", "can everyone hear me".
        static const char* const kCallCheck[] = {"me ouve", "me ouvem", "me ouvindo", "me escuta",
                                                 "me escutam", "me vendo", "me veem", "hear me", "see me"};
        if (text::word_count(s) <= 5) {
            for (const char* c : kCallCheck) {
                const std::string_view cv(c);
                if (s.size() >= cv.size() && s.compare(s.size() - cv.size(), cv.size(), cv) == 0) return true;
            }
        }
        return false;
    }

    // Probe ignoring cooldown — used to enqueue when cooldown would otherwise drop.
    [[nodiscard]] TriggerReason probe_reason_ignoring_cooldown(const std::string& text) const {
        return would_trigger(text, -1);
    }
    void record_trigger(TriggerReason r, std::int64_t now_ms, std::string kw = {}) {
        last_trigger_ms_ = now_ms;
        last_reason_ = r;
        last_keyword_ = std::move(kw);
    }

    [[nodiscard]] std::optional<std::string> matched_keyword(std::string_view raw) const {
        const std::string f = text::fold(raw);
        for (const auto& k : cfg_.keywords) {
            if (!k.empty() && text::contains_word(f, k)) return k;
        }
        return std::nullopt;
    }

private:
    // Drops leading discourse fillers ("Então, ...", "So, ...", "E ...").
    static void strip_fillers(std::string& s) {
        static const char* const kFillers[] = {"e", "entao", "ok", "certo", "bom", "ta",
                                               "beleza", "agora", "olha", "tipo", "so",
                                               "and", "okay", "well", "right", "now"};
        bool again = true;
        while (again) {
            again = false;
            for (const char* f : kFillers) {
                const std::string_view fv(f);
                if (s.size() > fv.size() && s.compare(0, fv.size(), fv) == 0 &&
                    (s[fv.size()] == ' ' || s[fv.size()] == ',')) {
                    s = text::trim(std::string_view(s).substr(fv.size()));
                    while (!s.empty() && (s.front() == ',' || s.front() == ' ')) s.erase(s.begin());
                    again = true;
                    break;
                }
            }
        }
    }

    static constexpr const char* kInterrogatives[] = {
        // pt-BR - ampliado
        "como", "qual", "quais", "quando", "onde", "por que", "pra que", "para que", "quanto",
        "quantos", "quantas", "quem", "o que", "que tipo", "voce pode", "voce poderia",
        "voce consegue", "voce ja", "voce tem", "voces podem", "voces tem", "poderia", "consegue",
        "tem como", "teria como", "existe", "e possivel", "me fala", "me conta", "me explica",
        "me diz", "me diga", "pode me dizer", "pode me falar", "pode me explicar",
        "pode falar", "pode explicar", "pode contar", "poderia me dizer", "poderia me explicar",
        "consegue me dizer", "consegue me explicar", "fala um pouco", "fala sobre", "conta um pouco",
        "conta sobre", "explica", "explica como", "descreva", "descreve",
        // Imperative requests are interview questions without "?":
        // "Fale um pouco sobre você.", "Conte uma situação em que...".
        "fale", "conte", "explique", "me fale", "me conte", "comente", "cite", "de um exemplo",
        "da um exemplo", "apresente", "se apresente", "imagine", "suponha",
        "voce acha", "voce acredita", "voce recomenda", "voce sugere", "o que voce",
        "o que voces", "qual voce", "como voce", "por que voce", "quando voce", "me ajuda", "me ajude",
        "pode me ajudar", "poderia me ajudar", "consegue me ajudar",
        // en - expanded
        "what", "how", "why", "when", "where", "who", "which", "can you", "could you",
        "would you", "will you", "do you", "did you", "does", "have you", "has", "are you",
        "is there", "is it", "tell me", "tell me about", "walk me", "describe", "explain",
        "can you tell", "could you tell", "can you explain", "could you explain"};

    DecisionConfig cfg_;
    std::int64_t last_trigger_ms_{-1};
    TriggerReason last_reason_{TriggerReason::None};
    std::string last_keyword_;
};

// Pin on Speak gate (Req 9.1, 9.4): the user is "speaking" when the local mic
// shows continuous voice activity above the detection threshold for >= 300 ms,
// or while a push-to-talk key is held. Consulted by the engine before it
// publishes a SuggestionStartedEvent so a card the user is reading aloud is not
// replaced out from under them. Pure/testable; lives in the core (orchestrator
// thread), not thread-safe.
struct UserSpeechGate {
    bool active{false};
    std::int64_t voiced_since_ms{-1};
    bool ptt_down{false};

    // Feed one mic RMS sample. `active` becomes true only once voice has stayed
    // above `threshold` continuously for at least 300 ms; a sample below the
    // threshold resets the streak and falls back to the push-to-talk state.
    void on_mic_rms(float rms, float threshold, std::int64_t now_ms) {
        if (rms >= threshold) {
            if (voiced_since_ms < 0) voiced_since_ms = now_ms;
            active = (now_ms - voiced_since_ms) >= 300; // Req 9.1
        } else {
            voiced_since_ms = -1;
            active = ptt_down;
        }
    }

    [[nodiscard]] bool should_pin() const noexcept { return active || ptt_down; }
};

} // namespace rtai
