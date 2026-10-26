// Pure core: the copilot orchestrator (event-driven, speculative prefill).
//
// Speculative path: TurnAssembler emits SpeculativeCandidate on stable interim
// (~110ms pause). Engine starts a shadow LLM call immediately; when the real
// Turn closes, if text matches (prefix/levenshtein tolerant) the shadow is
// promoted (tokens already buffered => 0ms perceived TTFT), else RST_STREAM.

//
//   transport reader threads ─┐
//   capture threads (turn end)├─> inbox ─> orchestrator thread ─> sinks
//   UI thread (hotkeys) ──────┘     (TurnAssembler, DecisionPolicy,
//                                    ConversationLog, LLM calls)
//   LLM worker threads ── token deltas ───────────────────────> sinks
//
// * Every input method is thread-safe and non-blocking (enqueue + notify), so
//   neither the network threads nor the UI thread ever wait on the copilot.
// * All copilot state is owned by ONE orchestrator thread: no locks inside the
//   logic, nothing to race.
// * Latest wins: a new trigger cancels the suggestion still streaming.
// * Sinks must be thread-safe and non-blocking (overlay queue, session store
//   queue, async console log). They are fixed before start().
#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <functional>

#include "rtai/analytics_client.hpp"
#include "rtai/copilot_events.hpp"
#include "rtai/copilot_prompt.hpp"
#include "rtai/decision_policy.hpp"
#include "rtai/llm.hpp"
#include "rtai/turn_assembler.hpp"

namespace rtai {

struct CopilotConfig {
    DecisionConfig decision{};
    TurnAssemblerConfig turns{};
    PromptConfig prompt{};
    std::string model{"google/gemini-3.1-flash-lite"};
    int max_tokens{1500};
    double temperature{0.3};
    std::string reasoning_effort{"none"};
    std::function<std::string(std::string_view)> web_search;
    // Production disables speculative answers so a mid-sentence Deepgram
    // interim cannot replace the complete closed turn.
    bool allow_speculative{true};
    // Question gate (rtai/question_gate.hpp): an automatic answer only for a
    // complete question. The interviewer's fragments up to `fragment_gap_ms`
    // apart are one utterance; a request without '?' waits `question_settle_ms`
    // for more speech; a phrase cut mid-way waits up to `question_hold_ms` for
    // the rest.
    bool question_gate{true};
    std::int64_t question_settle_ms{450};
    std::int64_t question_hold_ms{1800};
    std::int64_t fragment_gap_ms{2500};
    // Automatic answers may come back as "[SKIP]" (the model saw nothing to
    // answer): their card only appears once the first words show a real answer.
    bool allow_skip{true};
    std::chrono::steady_clock::time_point session_start{std::chrono::steady_clock::now()};
    std::chrono::milliseconds tick{20};
};

class CopilotEngine {
public:
    using Sink = std::function<void(const EngineEvent&)>;

    // `llm` may be null: transcripts and turns still flow, suggestions are off.
    CopilotEngine(CopilotConfig cfg, std::shared_ptr<ILlmClient> llm);
    // Overload wiring the Cold_Path (Req 7.1/7.5/8.1-8.3). `analytics` may be
    // null: live suggestions still work but finalize_session() becomes a no-op.
    CopilotEngine(CopilotConfig cfg, std::shared_ptr<ILlmClient> llm,
                  std::shared_ptr<IAnalyticsClient> analytics);
    ~CopilotEngine();

    CopilotEngine(const CopilotEngine&) = delete;
    CopilotEngine& operator=(const CopilotEngine&) = delete;

    void add_sink(Sink sink); // before start()
    void start();
    // Idempotent. After it returns no sink is invoked anymore, so the objects
    // behind the sinks (overlay, store) can be destroyed safely.
    void stop();

    // ---- thread-safe, non-blocking inputs ----
    void on_transcript(const TranscriptEvent& ev);
    void on_link_status(const TransportStatus& st);
    // Pin on Speak (Req 9.1): one microphone RMS sample (0..1) with its
    // detection threshold. Frames of AudioSource::Microphone feed the engine's
    // UserSpeechGate; continuous voice >= 300 ms (or a held push-to-talk key)
    // pins the current card so a new suggestion is enqueued instead of
    // replacing it. `now_ms` defaults to the engine clock.
    void on_mic_rms(float rms, float threshold = 0.02f);
    // Push-to-talk state for the speech gate (held => pin the card).
    void set_ptt(bool down);
    // ---- local acoustic VAD inputs (Hot_Path, Req 1.5/1.6/3.1-3.3) ----
    // Driven by the FrameVad on each WASAPI capture thread, independently of
    // any Deepgram event. All three are thread-safe and non-blocking (they
    // enqueue + notify, never waiting on the orchestrator) so the capture
    // thread is never stalled. `t_ms` defaults to the engine clock like the
    // other inputs.
    //
    // 110 ms of continuous local silence reached on `source`, with the current
    // interim already approved by the fast filter on the capture side: ask the
    // engine to start a speculative generation (Req 1.5/1.6). `rms` is the
    // frame RMS at the edge, carried for observability.
    void on_vad_speculate(AudioSource source, float rms, std::int64_t t_ms = -1);
    // 120 ms of absolute local silence reached on `source`: closes the
    // Speculating->Committed race from the acoustic side (Req 3.1/3.3).
    void on_vad_commit_silence(AudioSource source, std::int64_t t_ms = -1);
    // Deepgram-independent speech_final signal from the capture/STT layer, if a
    // caller wants to drive the InSpeechFinal commit path directly (Req 3.2).
    // The InTranscript speech_final path already covers Deepgram; this is the
    // explicit entry point mirroring the other VAD inputs.
    void on_speech_final(AudioSource source, std::int64_t t_ms = -1);
    void request_suggestion();               // manual trigger (hotkey)
    // Finalize action (button / hotkey): kicks off the Cold_Path (Req 7.1).
    // While the two parallel calls are in flight, and on any failure/timeout,
    // the overlay stays in LiveCopilot (nothing is published that switches
    // mode). Only on the double-success join does the engine publish
    // OverlayModeEvent{PostInterviewReport, report} (Req 7.5/8.1-8.3). No-op
    // when no analytics client was injected or the transcript is empty.
    void finalize_session();
    // Explicit overlay actions: Chat (text required), Screenshot (image
    // data URL, optional text), Recap, FollowUp. Latest wins, like suggestions.
    void request_action(TriggerReason reason, std::string text = {}, std::string image_url = {});
    void rate_suggestion(std::uint64_t id, int vote); // +1 / -1 / 0
    void clear_chat();                       // forget the chat thread
    // Announce a privacy pause; source -1 = all lanes.
    void set_paused(bool paused, int source = -1);
    void notify(NoticeLevel level, std::string text);
    void set_auto_answer(bool enabled);
    [[nodiscard]] bool auto_answer() const noexcept;
    void set_transcription_only(bool on);
    [[nodiscard]] bool transcription_only() const noexcept;
    [[nodiscard]] SessionTranscript session_transcript() const;

    [[nodiscard]] bool llm_enabled() const noexcept;
    [[nodiscard]] std::int64_t now_ms() const;
    [[nodiscard]] const CopilotConfig& config() const noexcept;

private:
    struct Impl;
    std::shared_ptr<Impl> impl_;
};

} // namespace rtai
