// Pure core: Subject fusion and Context-Aware Trigger Resolution for multi-clause questions.
// Unifies the trigger resolution between closed-turn and speculative paths.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "rtai/text_util.hpp"
#include "rtai/turn_assembler.hpp"

namespace rtai {

struct FusionConfig {
    std::int64_t fusion_window_ms{6000};
};

// Returns true if the recruiter turn introduces a topic/subject intended for
// a subsequent follow-up question. Matches anchor words as whole tokens
// (via text::contains_word / text::starts_with_word, never raw substring).
inline bool is_subject_bearing(std::string_view text) noexcept {
    const std::string trimmed = text::trim(text);
    if (trimmed.empty()) return false;

    const std::string folded = text::fold(trimmed);

// Filter out common acknowledgements / small-talk (both PT and EN)
    if (folded == "beleza" || folded == "beleza." ||
        folded == "tudo bem" || folded == "tudo bem?" ||
        folded == "entendi" || folded == "entendi." ||
        folded == "perfeito" || folded == "perfeito." ||
        folded == "obrigado" || folded == "obrigado." ||
        folded == "certo" || folded == "certo." ||
        folded == "ok" || folded == "ok." ||
        folded == "com certeza" || folded == "exatamente" ||
        folded == "valeu" || folded == "valeu." ||
        folded == "show" || folded == "show." ||
        folded == "tranquilo" || folded == "tranquilo." ||
        folded == "okay" || folded == "okay." ||
        folded == "cool" || folded == "cool." ||
        folded == "great" || folded == "great." ||
        folded == "sure" || folded == "sure." ||
        folded == "awesome" || folded == "awesome." ||
        folded == "alright" || folded == "alright." ||
        folded == "all right" || folded == "all right." ||
        folded == "got it" || folded == "got it." ||
        folded == "makes sense" || folded == "makes sense." ||
        folded == "understood" || folded == "understood." ||
        folded == "yes" || folded == "yes." ||
        folded == "yeah" || folded == "yeah." ||
        folded == "yep" || folded == "yep." ||
        folded == "thanks" || folded == "thanks." ||
        folded == "thank you" || folded == "thank you." ||
        folded == "no problem" || folded == "sounds good" || folded == "sounds good.") {
        return false;
    }

    // Anchor words that introduce a topic / project subject in PT and EN
    static constexpr const char* kAnchors[] = {
        "pensando", "pensa", "sobre", "projeto", "competicao",
        "passando", "falando", "considerando", "arquitetura", "sistema",
        "desafio", "problema", "cenario", "experiencia",
        "thinking", "think", "about", "regarding", "project", "competition",
        "speaking", "talking", "considering", "architecture", "system",
        "challenge", "problem", "scenario", "experience", "pipeline",
        "service", "infrastructure", "design", "workflow"
    };

    for (const char* anchor : kAnchors) {
        if (text::contains_word(folded, anchor)) {
            return true;
        }
    }

    // Common topic / premise starters
    static constexpr const char* kStarters[] = {
        "dado que", "assumindo que", "quando voce", "durante", "olhando para",
        "em termos de", "em relacao a", "em relação a",
        "given that", "assuming that", "when you", "during", "looking at",
        "in terms of", "with respect to", "as for"
    };
    for (const char* starter : kStarters) {
        if (std::string_view(folded).rfind(starter, 0) == 0) {
            if (!trimmed.empty() && trimmed.back() == '?') return false;
            return true;
        }
    }

    // Topic prepositions: only when starting the utterance and followed by content
    // e.g. "No Tech Finance...", "Na Midea...", "Em relação a...", "In our architecture...", "At your last company..."
    static constexpr const char* kPrepositions[] = {
        "no", "na", "em", "da", "do", "sobre", "para",
        "in", "at", "on", "for", "with", "regarding", "about"
    };

    for (const char* prep : kPrepositions) {
        if (text::starts_with_word(folded, prep)) {
            // Must have substantive content (>= 2 words) and not be an already complete question
            if (text::word_count(folded) >= 2) {
                // Check if it's already a complete question
                if (!trimmed.empty() && trimmed.back() == '?') {
                    return false;
                }
                return true;
            }
        }
    }

    return false;
}

// Single source of enriched trigger: returns text::join_space(prev->text, curr_text)
// iff prev exists, is from AudioSource::Loopback, is subject-bearing, and gap_ms is within window.
// Otherwise returns std::string(curr_text) exactly.
inline std::string enrich_trigger_with_subject(
    std::optional<Turn> prev,
    std::string_view curr_text,
    std::int64_t gap_ms,
    const FusionConfig& cfg = {}) noexcept {
    if (prev && prev->source == AudioSource::Loopback &&
        gap_ms >= 0 && gap_ms < cfg.fusion_window_ms &&
        is_subject_bearing(prev->text)) {
        return text::join_space(prev->text, curr_text);
    }
    return std::string(curr_text);
}

// Collects consecutive loopback turns from the conversation history immediately preceding
// the current utterance to ensure the LLM receives the entire context of the interviewer's
// message/question, not just a single truncated clause.
template <typename Container>
inline std::optional<Turn> collect_loopback_context(
    const Container& turns,
    std::size_t end_index,
    std::int64_t curr_start_ms,
    const FusionConfig& cfg = {}) noexcept {
    if (turns.empty() || end_index == 0) return std::nullopt;

    std::vector<Turn> context_turns;
    std::int64_t next_start_ms = curr_start_ms;

    for (std::size_t i = end_index; i > 0; --i) {
        const auto& t = turns[i - 1];
        if (t.source != AudioSource::Loopback) break; // candidate turn boundary

        const std::int64_t gap = (next_start_ms >= 0 && t.end_ms >= 0) ? (next_start_ms - t.end_ms) : 0;
        if (gap < 0 || gap >= cfg.fusion_window_ms) break; // outside fusion window

        context_turns.push_back(t);
        next_start_ms = t.start_ms;

        // Cap to at most 4 preceding context turns
        if (context_turns.size() >= 4) break;
    }

    if (context_turns.empty()) return std::nullopt;

    // Check if any collected turn carries subject or substantial topic context
    bool has_substance = false;
    for (const auto& t : context_turns) {
        if (is_subject_bearing(t.text)) {
            has_substance = true;
            break;
        }
    }

    if (!has_substance) {
        if (context_turns.size() == 1) return context_turns.front();
        return std::nullopt;
    }

    // Merge collected turns in chronological order
    Turn merged;
    merged.source = AudioSource::Loopback;
    merged.start_ms = context_turns.back().start_ms;
    merged.end_ms = context_turns.front().end_ms;
    for (auto it = context_turns.rbegin(); it != context_turns.rend(); ++it) {
        merged.text = text::join_space(merged.text, it->text);
    }
    return merged;
}

} // namespace rtai

