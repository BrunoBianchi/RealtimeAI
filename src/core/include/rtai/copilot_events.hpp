// Pure core: events published by the copilot engine to its sinks (overlay,
// session store, console log). This is the seam between the engine (server
// side: capture, STT, LLM, persistence) and its clients (overlay HUD today;
// any external UI later, since every event serializes to JSON in the session
// log format).
#pragma once

#include <cstdint>
#include <string>
#include <variant>

#include "rtai/decision_policy.hpp"
#include "rtai/interfaces.hpp"
#include "rtai/llm.hpp"
#include "rtai/overlay_mode.hpp"
#include "rtai/turn_assembler.hpp"

namespace rtai {

enum class NoticeLevel : std::uint8_t { Info, Warning, Error };

constexpr const char* to_string(NoticeLevel l) noexcept {
    switch (l) {
        case NoticeLevel::Info:    return "info";
        case NoticeLevel::Warning: return "warning";
        case NoticeLevel::Error:   return "error";
    }
    return "?";
}

struct LaneStatusEvent {
    TransportStatus status;
    std::int64_t t_ms{0};
};

// Live text for one lane: committed finals of the open turn + interim.
struct TranscriptUpdateEvent {
    AudioSource source{AudioSource::Loopback};
    std::string text;
    bool turn_closed{false}; // true when `text` is a just-closed turn
    std::int64_t t_ms{0};
};

struct TurnEvent {
    Turn turn;
};

struct SuggestionStartedEvent {
    std::uint64_t id{0};
    std::string trigger_text; // verbatim transcript, never LLM-rewritten
    AudioSource trigger_source{AudioSource::Loopback};
    TriggerReason reason{TriggerReason::None};
    std::string keyword;
    std::string model;
    bool has_image{false};    // screenshot attached
    // Pin on Speak (Req 9.2, 9.5): set when the engine decided this suggestion
    // must NOT replace the visible card right now (the user is speaking or we
    // are still inside the 4000 ms window). The overlay pushes it onto its
    // SuggestionQueue and shows the "nova pergunta" pill instead of swapping
    // the card. When the engine later releases a pending suggestion because the
    // window expired without speech, it republishes the same event with
    // `enqueue == false` so the overlay promotes it.
    bool enqueue{false};
    std::int64_t t_ms{0};
};

struct SuggestionDeltaEvent {
    std::uint64_t id{0};
    std::string text; // appended to the suggestion body
};

struct SuggestionDoneEvent {
    std::uint64_t id{0};
    LlmStatus status{LlmStatus::Completed};
    std::string text;  // full body (without the "PERGUNTA:" header line)
    std::string error;
    std::string trigger_text;
    // The question as the answer model understood it ("PERGUNTA:" line);
    // empty when the model wrote no header (chat, recap, older prompts).
    std::string interpreted_question;
    TriggerReason reason{TriggerReason::None};
    std::string model;
    std::int64_t ttft_ms{-1};
    std::int64_t total_ms{0};
    std::int64_t t_ms{0};
    // Perceived latency: from the moment the card appeared (question closed or
    // speculation committed) to the first answer text on it. 0 when a
    // speculative buffer was already full at commit. -1 = no text shown.
    std::int64_t visible_ms{-1};
};

struct NoticeEvent {
    NoticeLevel level{NoticeLevel::Info};
    std::string text;
    std::int64_t t_ms{0};
};

struct PauseEvent {
    bool paused{false};
    int source{-1}; // -1 = all lanes, else static_cast<int>(AudioSource)
    std::int64_t t_ms{0};
};

// Thumbs up/down given in the overlay to a suggestion (persisted).
struct FeedbackEvent {
    std::uint64_t id{0};
    int vote{0}; // +1, -1, 0 = removed
    std::int64_t t_ms{0};
};

// Speculative prefetch hit/miss: emitted when interim stabilizes before turn close.
struct SpeculativeCandidateEvent {
    AudioSource source{AudioSource::Loopback};
    std::string text;
    std::int64_t t_ms{0};
};

struct SpeculativeHitEvent {
    std::uint64_t shadow_id{0};
    std::uint64_t promoted_id{0};
    std::int64_t t_ms{0};
};

struct SpeculativeMissEvent {
    std::uint64_t shadow_id{0};
    std::int64_t t_ms{0};
};

struct AutoAnswerStateEvent {
    bool enabled{false};
    std::int64_t t_ms{0};
};

struct TranscriptionModeEvent {
    bool enabled{false};
    std::int64_t t_ms{0};
};

// Cold_Path (Jev Dashboard) mode transition: published only on the all-or-nothing
// double-success of the two parallel analytics calls. The overlay stays in
// LiveCopilot while the calls are in flight and on any failure; it switches to
// PostInterviewReport and renders `report` only when this event arrives.
struct OverlayModeEvent {
    OverlayMode mode{OverlayMode::LiveCopilot};
    JevReport report;
    std::int64_t t_ms{0};
};

using EngineEvent = std::variant<LaneStatusEvent, TranscriptUpdateEvent, TurnEvent,
                                 SuggestionStartedEvent, SuggestionDeltaEvent,
                                 SuggestionDoneEvent, NoticeEvent, PauseEvent, FeedbackEvent,
                                 SpeculativeCandidateEvent, SpeculativeHitEvent, SpeculativeMissEvent,
                                 AutoAnswerStateEvent, TranscriptionModeEvent, OverlayModeEvent>;

} // namespace rtai
