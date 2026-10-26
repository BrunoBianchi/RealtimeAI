// Cold_Path — Jev analytics client. At Finalize time it fires two parallel
// WinHTTP calls (Jev Engine API for scores + a synthetic <=80-token feedback)
// and joins them all-or-nothing: the post-interview dashboard only appears
// when BOTH succeed; any failure/timeout discards the partial result and keeps
// the overlay in LiveCopilot.
//
// This header carries the PURE, network-free pieces (builders/parsers and the
// all-or-nothing mode decision) so they are unit/property testable off Win32,
// mirroring the project's pure-core style. The threaded `finalize()` body lives
// in jev_analytics_client.cpp (task 8.2).
//
// Req 7.2/7.3/7.4, 8.1-8.4, 9.4.
#pragma once

#include <algorithm>
#include <array>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "rtai/analytics_client.hpp"
#include "rtai/json_min.hpp"
#include "rtai/llm.hpp"
#include "rtai/openrouter_protocol.hpp"
#include "rtai/session_transcript.hpp"
#include "rtai/text_util.hpp"

namespace rtai {

// ---------------------------------------------------------------------------
// LlmEndpoint — shared with the direct HTTP/2 transport (winhttp_llm_client,
// task 4.1). Whichever header is included first defines it; the other skips it
// via this guard so the two definitions never clash (single ODR definition).
// ---------------------------------------------------------------------------
#ifndef RTAI_LLM_ENDPOINT_DEFINED
#define RTAI_LLM_ENDPOINT_DEFINED
struct LlmEndpoint {
    std::string host;                    // "api.cerebras.ai" | "api.groq.com"
    std::string path{"/v1/chat/completions"};
    std::string model;                   // "llama-3.3-70b" | "llama-3.3-70b-versatile"
    std::string api_key;
};
#endif // RTAI_LLM_ENDPOINT_DEFINED

// OverlayMode, JevScores and JevReport are the pure Cold_Path result types.
// They live in rtai/overlay_mode.hpp (pulled in via analytics_client.hpp) so
// rtai_core can carry them on OverlayModeEvent without any net dependency; this
// header reuses those single definitions rather than redeclaring them.

// Configuration for the two parallel Cold_Path calls.
struct JevClientOptions {
    LlmEndpoint engine_api;        // Jev Engine API (direct JSON, no SSE)
    LlmEndpoint feedback;          // synthetic feedback (<=80 tokens)
    int engine_timeout_ms{8000};   // Req 8.1
    int feedback_timeout_ms{6000}; // Req 8.2
    int feedback_max_tokens{80};   // Req 7.4
};

// Concrete Cold_Path client (rtai_net). Implements the core IAnalyticsClient
// seam so the CopilotEngine can drive it without depending on rtai_net.
class JevAnalyticsClient : public IAnalyticsClient {
public:
    explicit JevAnalyticsClient(JevClientOptions opts) : opts_(std::move(opts)) {}
    ~JevAnalyticsClient() override = default;

    // Req 7.1: fires TWO parallel WinHttp calls on distinct threads.
    // on_done(ok, report): ok == true ONLY if both completed successfully
    // (Req 8.3); on any failure/timeout the partial result is discarded
    // (Req 8.4) and ok == false. Body lives in jev_analytics_client.cpp (8.2).
    void finalize(const SessionTranscript& transcript,
                  std::function<void(bool ok, JevReport report)> on_done) override;

    // -----------------------------------------------------------------------
    // Pure builders/parsers (no network; unit/property testable).
    // -----------------------------------------------------------------------

    // Req 7.2: Jev Engine API request. A "state" field carrying the full
    // verbatim transcript plus a "questions" array: three type:"score" items
    // (relevance/accuracy/clarity, min 0 max 10) and two type:"choice" items
    // (domain, interview_type).
    [[nodiscard]] static std::string build_engine_request(const SessionTranscript& t) {
        json::Writer w;
        w.begin_object();
        w.field("state", text::sanitize_utf8(t.render()));
        w.key("questions").begin_array();
        append_score_question(w, "relevance_score");
        append_score_question(w, "accuracy_score");
        append_score_question(w, "clarity_score");
        append_choice_question(w, "domain");
        append_choice_question(w, "interview_type");
        w.end_array();
        w.end_object();
        return std::move(w).str();
    }

    // Req 7.3: parse the Jev Engine API response read as direct JSON (no SSE).
    // Each score is clamped to [0,10]. Returns std::nullopt when the payload is
    // malformed (not a JSON object).
    [[nodiscard]] static std::optional<JevScores> parse_engine_response(std::string_view body) {
        auto parsed = json::Parser::parse(text::trim(body));
        if (!parsed || !parsed->is_object()) return std::nullopt;
        const json::Value& root = *parsed;
        JevScores s;
        s.relevance = clamp_score(root["relevance_score"].as_number(0.0));
        s.accuracy = clamp_score(root["accuracy_score"].as_number(0.0));
        s.clarity = clamp_score(root["clarity_score"].as_number(0.0));
        return s;
    }

    // Req 7.4: synthetic-feedback request as a standard OpenAI chat-completions
    // body with max_tokens capped at <= 80. Reuses the OpenRouter/OpenAI wire
    // builder already in the project.
    [[nodiscard]] static std::string build_feedback_request(const SessionTranscript& t,
                                                            int max_tokens) {
        LlmRequest req;
        req.max_tokens = std::clamp(max_tokens, 1, 80); // Req 7.4 (<=80)
        req.temperature = 0.3;
        req.messages.push_back(ChatMessage{
            "system",
            "You are an interview evaluator. Reply in English with exactly "
            "3 short lines of feedback, one per line, without numbering.",
            {}});
        req.messages.push_back(ChatMessage{"user", t.render(), {}});
        return openrouter::build_request_body(req);
    }

    // Req 9.4: Instant_Feedback normalized to EXACTLY three lines — present
    // lines kept in order, missing lines padded with "", excess truncated.
    // Same contract as ui::normalize_anchors, already tested in the project.
    [[nodiscard]] static std::array<std::string, 3> normalize_feedback(
        const std::vector<std::string>& lines) {
        std::array<std::string, 3> out; // value-initialized to three empty strings
        const std::size_t keep = std::min<std::size_t>(lines.size(), 3);
        for (std::size_t i = 0; i < keep; ++i) out[i] = lines[i];
        return out;
    }

    // Req 8.1-8.4: all-or-nothing join. PostInterviewReport ONLY when both the
    // engine and the feedback calls succeeded; otherwise stay in LiveCopilot.
    [[nodiscard]] static OverlayMode final_mode(bool engine_ok, bool feedback_ok) noexcept {
        return (engine_ok && feedback_ok) ? OverlayMode::PostInterviewReport
                                          : OverlayMode::LiveCopilot;
    }

private:
    static double clamp_score(double v) noexcept { return std::clamp(v, 0.0, 10.0); }

    static void append_score_question(json::Writer& w, std::string_view key) {
        w.begin_object();
        w.field("key", key);
        w.field("type", "score");
        w.field_int("min", 0);
        w.field_int("max", 10);
        w.end_object();
    }

    static void append_choice_question(json::Writer& w, std::string_view key) {
        w.begin_object();
        w.field("key", key);
        w.field("type", "choice");
        w.end_object();
    }

    JevClientOptions opts_;
};

} // namespace rtai
