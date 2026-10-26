#include "rtai/copilot_engine.hpp"
#include "rtai/mini_agent.hpp"
#include "rtai/question_gate.hpp"

#include <algorithm>
#include <cctype>
#include "rtai/session_transcript.hpp"
#include "rtai/subject_fusion.hpp"

#include <atomic>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <thread>
#include <unordered_map>
#include <variant>
#include <vector>

namespace rtai {

namespace {

struct InTranscript { TranscriptEvent ev; std::int64_t t; };
struct InStatus { TransportStatus st; std::int64_t t; };
struct InManual { std::int64_t t; };
struct InPause { bool paused; int source; std::int64_t t; };
struct InAction { TriggerReason reason; std::string text; std::string image; std::int64_t t; };
struct InFeedback { std::uint64_t id; int vote; std::int64_t t; };
struct InClearChat {};
struct InNotice { NoticeLevel level; std::string text; std::int64_t t; };
struct InLlmDone { std::uint64_t id; LlmResult res; std::string text; std::int64_t first_visible_ms{-1}; };
// The first words of an automatic answer arrived while its card was still
// hidden: `skip` when they are "[SKIP]" (the model saw no question).
struct InHoldDecided { std::uint64_t id; bool skip; };

struct InAutoToggle { bool enabled; std::int64_t t; };
struct InModeToggle { bool enabled; std::int64_t t; };
struct InMicRms { float rms; float threshold; std::int64_t t; };
struct InPtt { bool down; std::int64_t t; };
// Shadow Streaming inputs (Req 2.1/2.3/2.5). The acoustic FrameVad on the
// capture thread drives speculation/commit independently of Deepgram, and
// speech_final closes the commit race. Behavioral handling lands in 2.2-2.4;
// here they exist so the variant/dispatch compiles.
struct InVadSpeculate { AudioSource source; float rms; std::int64_t t; };
struct InVadCommitSilence { AudioSource source; std::int64_t t; };
struct InSpeechFinal { AudioSource source; std::int64_t t; };
// Shadow token delta delivered off the LLM worker thread, carrying the
// generation captured at speculation start so stale deltas are gated out
// (Req 2.5). Handled on the orchestrator thread via on_shadow_delta.
struct InShadowDelta { std::uint64_t gen; std::string text; };
// Completion of a speculative generation, routed onto the orchestrator so the
// shadow state is never touched from an LLM worker thread. A generation that
// finishes while still hidden is kept until the commit publishes it.
struct InShadowDone { std::uint64_t gen; LlmResult res; std::string text; };
// Cold_Path (Req 7.1): the Finalize action asks the analytics client to score
// the session. InFinalize starts it on the orchestrator thread (so it reads the
// engine-owned SessionTranscript safely); InFinalizeDone routes the client's
// all-or-nothing callback — which fires on a Cold_Path worker thread — back
// onto the inbox so the OverlayModeEvent is published from the single
// orchestrator thread (Req 8.3).
struct InFinalize { std::int64_t t; };
struct InFinalizeDone { bool ok; JevReport report; std::int64_t t; };
using Input = std::variant<InTranscript, InStatus, InManual, InPause, InNotice, InLlmDone, InAction,
                           InFeedback, InClearChat, InAutoToggle, InModeToggle, InMicRms, InPtt,
                           InVadSpeculate, InVadCommitSilence, InSpeechFinal, InShadowDelta,
                           InShadowDone, InFinalize, InFinalizeDone, InHoldDecided>;

// Shadow Streaming state (Req 2.1). Formalizes the implicit shadow lifecycle
// (speculate -> commit -> abort) that today lives in shadow/promote/cancel.
enum class ShadowState : std::uint8_t { Idle, Speculating, Committed, Aborted };

// Why a speculation committed (Req 2.2/3.1-3.3). The commit fires on the first
// of {Deepgram speech_final, 120 ms of absolute local silence, closed turn that
// matches the speculative text}; Timeout is the fallback deadline guard. Carried
// for observability so later phases (task 2.4) can wire the named triggers.
enum class CommitCause : std::uint8_t { SpeechFinal, LocalSilence, Timeout, TurnMatch };

constexpr std::size_t kMaxChatTurns = 8;
constexpr std::size_t kMaxChatAnswerChars = 1500;
// Persona memory: the last few answers are enough for coherence; more only
// inflates the prompt (and the time to first token).
constexpr std::size_t kMaxDeliveredAnswers = 4;
constexpr std::size_t kMaxDeliveredAnswerChars = 400;
// A question split by a breath pause arrives as two closed turns. When the
// first piece already triggered an answer and the second piece follows within
// this window (nobody else spoke), the answer is redone for the whole question.
constexpr std::int64_t kContinuationWindowMs = 2500;
// A speculation still counts as "the same question" when the final text only
// adds up to this many words and no new question word.
constexpr std::size_t kMaxExtraWordsSameQuestion = 6;

// Fallback deadline for the Speculating->Committed commit (Req 3.1/3.3). The
// commit normally fires on the first of {speech_final, 120 ms of absolute local
// silence}; this timeout bounds the wait so a dropped close still commits.
constexpr std::int64_t kCommitTimeoutMs = 120;

// Question gate: a held question is answered (or dropped) at the latest this
// long after its first fragment, even if the interviewer never stops talking.
constexpr std::int64_t kMaxQuestionHoldMs = 8000;
// A candidate turn this short ("uhum", "sim, claro") does not end the
// interviewer's question.
constexpr std::size_t kBackchannelMaxWords = 3;
// What the interviewer said right before the question (not a question
// itself) goes with it to the model, up to this size.
constexpr std::size_t kMaxHeldContextChars = 400;
// Manual trigger ("Answer" hotkey): the interviewer's turns this close
// together are read as one utterance, so a question split by the STT is
// answered whole and not just its last piece.
constexpr std::int64_t kManualFragmentGapMs = 6000;
constexpr std::size_t kManualMaxTurns = 4;
constexpr std::size_t kManualMaxChars = 700;

// Folded words only (punctuation and repeated spaces dropped), so the interim
// "qual e o prazo de implantacao e o custo" still matches the final
// "Qual é o prazo de implantação, e o custo?".
inline std::string norm_words(const std::string& in) {
    const std::string f = text::fold(in);
    std::string out;
    out.reserve(f.size());
    bool space = false;
    for (unsigned char c : f) {
        const bool word = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c >= 0x80;
        if (word) {
            if (space && !out.empty()) out.push_back(' ');
            out.push_back(static_cast<char>(c));
            space = false;
        } else {
            space = true;
        }
    }
    return out;
}

// Speculative match tolerance: prefix + containment over normalized words.
inline bool speculative_match(const std::string& speculative, const std::string& real) {
    const std::string sf = norm_words(speculative);
    const std::string rf = norm_words(real);
    if (sf.empty() || rf.empty()) return false;
    if (rf == sf) return true;
    if (rf.rfind(sf, 0) == 0) return true; // real extends speculative
    if (sf.rfind(rf, 0) == 0) return true; // speculative was longer (rare)
    if (rf.find(sf) != std::string::npos || sf.find(rf) != std::string::npos) return true;
    return false;
}

// True when `real` goes on past `speculative` with a NEW question part
// ("...projeto Midea" -> "...projeto Midea, e qual foi o maior desafio?") or
// with many more words: an answer built on the speculative text would only
// cover half of what was asked.
inline bool extension_adds_question(const std::string& speculative, const std::string& real) {
    const std::string sf = norm_words(speculative);
    const std::string rf = norm_words(real);
    if (sf.empty() || rf.size() <= sf.size()) return false;
    std::string tail;
    if (rf.rfind(sf, 0) == 0) {
        tail = rf.substr(sf.size());
    } else if (const auto pos = rf.find(sf); pos != std::string::npos) {
        tail = rf.substr(0, pos) + " " + rf.substr(pos + sf.size());
    } else {
        return false;
    }
    tail = text::trim(tail);
    if (tail.empty()) return false;
    if (text::word_count(tail) > kMaxExtraWordsSameQuestion) return true;
    // The speculative answer (and the RAG search behind it) only knew the
    // first part. It is redone when the rest changes WHAT is asked:
    //  * the first part was left hanging ("...sobre o seu projeto de");
    //  * the rest names something (a project, a tool, "5G", "CRM");
    //  * the rest adds 3+ content words.
    // Short qualifiers ("em produção?", "para a equipe toda?") keep it.
    {
        static const char* const kDangling[] = {"de", "do", "da", "dos", "das", "sobre", "com", "no", "na", "nos",
                                                "nas", "em", "o", "a", "os", "as", "um", "uma", "seu", "sua",
                                                "para", "pra", "por", "e", "ou", "que", "of", "the", "a", "an",
                                                "about", "with", "in", "on", "your", "and", "or", "to", "for"};
        const auto last_space = sf.rfind(' ');
        const std::string last_word = last_space == std::string::npos ? sf : sf.substr(last_space + 1);
        for (const char* d : kDangling) if (last_word == d) return true;
    }
    if (MiniAgentRag::tokenize(tail).size() >= 3) return true;
    if (rf.rfind(sf, 0) == 0) {
        // Same words, original case: count the speculative words and look at
        // what follows them in `real`.
        std::size_t skip = 0;
        for (char c : sf) if (c == ' ') ++skip;
        ++skip;
        std::size_t idx = 0;
        std::string w;
        auto names_something = [](const std::string& word) {
            bool upper = false, digit = false;
            for (unsigned char c : word) {
                if (std::isupper(c)) upper = true;
                if (std::isdigit(c)) digit = true;
            }
            return upper || (digit && word.size() >= 2);
        };
        for (std::size_t i = 0; i <= real.size(); ++i) {
            const unsigned char c = i < real.size() ? static_cast<unsigned char>(real[i]) : ' ';
            const bool word_char = std::isalnum(c) || c >= 0x80;
            if (word_char) {
                w.push_back(static_cast<char>(c));
            } else if (!w.empty()) {
                if (idx++ >= skip && names_something(w)) return true;
                w.clear();
            }
        }
    }
    for (const char* q : {"como", "qual", "quais", "quando", "onde", "por que", "porque", "quanto", "quantos",
                          "quantas", "quem", "o que", "what", "how", "why", "when", "where", "which", "who"}) {
        if (text::contains_word(tail, q)) return true;
    }
    return false;
}

inline bool ends_as_question(const std::string& t) {
    const std::string s = text::trim(t);
    return !s.empty() && s.back() == '?';
}

// Per-call state shared by the orchestrator and the LLM worker thread.
struct CallCtx {
    std::uint64_t id{0};
    std::atomic<bool> cancelled{false};
    // Written only on the LLM worker thread (under hold_mu); the orchestrator
    // reads it under hold_mu to show a held card.
    std::string text;
    // Engine-clock time of the first token shown on the card (-1 = none yet).
    std::atomic<std::int64_t> first_visible_ms{-1};
    // Automatic answer: the card stays hidden until the first words show it
    // is a real answer and not "[SKIP]".
    std::mutex hold_mu;
    bool holding{false};
    bool decision_posted{false};
};

constexpr std::size_t lane_index(AudioSource s) { return static_cast<std::size_t>(s); }

} // namespace

struct CopilotEngine::Impl : std::enable_shared_from_this<Impl> {
    Impl(CopilotConfig c, std::shared_ptr<ILlmClient> l, std::shared_ptr<IAnalyticsClient> a)
        : cfg(std::move(c)), llm(std::move(l)), analytics(std::move(a)), turns(cfg.turns),
          policy(cfg.decision) {}

    CopilotConfig cfg;
    std::shared_ptr<ILlmClient> llm;
    // Cold_Path client (Req 7.1). May be null: finalize_session() is then a
    // no-op. rtai_core depends only on the IAnalyticsClient interface — the
    // concrete JevAnalyticsClient (rtai_net) is injected at the app layer.
    std::shared_ptr<IAnalyticsClient> analytics;
    std::vector<Sink> sinks; // immutable after start()

    // Publishing barrier: LLM worker threads publish deltas directly; stop()
    // flips `accepting` under the exclusive lock so that once it returns no
    // sink can still be running.
    std::shared_mutex publish_mu;
    bool accepting{true};

    std::mutex mu;
    std::condition_variable cv;
    std::deque<Input> inbox; // guarded by mu
    bool stop_requested{false};
    bool started{false};
    std::once_flag stop_once;
    std::thread thread;

    // ---- orchestrator-only state ----
    TurnAssembler turns;
    DecisionPolicy policy;
    ConversationLog convo;
    // Session-wide accumulator of every closed turn of both lanes, fed in
    // on_turn right after publish(TurnEvent{turn}) and before trigger
    // evaluation; the Cold_Path (Jev dashboard) renders it at Finalize time
    // (Req 6.1/6.2/6.3).
    mutable std::mutex transcript_mu_;
    SessionTranscript transcript_;
    std::uint64_t next_id{0};
    bool auto_answer{true};
    std::atomic<bool> transcription_only_{false};

    // Pin on Speak (Req 9): the speech gate and the pending suggestions that
    // could not replace the visible card. `last_card_ms` marks when the current
    // card was published; the 4000 ms window reuses DecisionPolicy's cooldown.
    UserSpeechGate gate;
    std::deque<SuggestionStartedEvent> pending; // máx 5, FIFO (Req 9.5)
    std::int64_t last_card_ms{-1};
    static constexpr std::size_t kMaxPending = 5;

    struct Meta {
        std::string trigger;
        TriggerReason reason{TriggerReason::None};
        AudioSource source{AudioSource::Loopback};
        std::string question; // chat/screenshot: what goes into the chat thread
        // Everything the model was shown (prompt text), for the grounding
        // post-check of numbers in the answer.
        std::string grounding;
        std::int64_t shown_ms{-1}; // when the card became visible
        // false while an automatic answer waits for its first words.
        bool shown{true};
        SuggestionStartedEvent pending_start{};
    };
    std::deque<ChatTurn> chat;
    std::deque<ChatTurn> delivered_answers_;
    struct Active {
        std::uint64_t id{0};
        std::shared_ptr<ILlmCall> call;
        std::shared_ptr<CallCtx> ctx;
    };
    std::optional<Active> active;
    std::unordered_map<std::uint64_t, Meta> meta;
    std::string last_live[2];

    // Speculative shadow: runs in parallel, can be promoted on hit.
    struct Shadow {
        ShadowState state{ShadowState::Idle}; // explicit lifecycle (Req 2.1)
        std::uint64_t id{0};
        std::string speculative_text;
        AudioSource source{AudioSource::Loopback};
        TriggerReason reason{TriggerReason::None};
        std::string keyword;
        std::shared_ptr<ILlmCall> call;
        std::shared_ptr<CallCtx> ctx;
        std::string shadow_buffer_; // tokens retained while Speculating (Req 2.1)
        // The hidden generation already finished (fast models often do before
        // the question closes): kept here and published right after commit.
        bool finished{false};
        LlmResult final_res;
        std::string final_text;
        std::int64_t first_visible_ms{-1};
        std::uint64_t active_id{0}; // visible suggestion id after commit (Req 2.6)
        std::int64_t started_ms{0};
        std::int64_t commit_deadline_ms{-1}; // commit fallback timeout (Req 3.1)
        // false while a committed automatic answer waits for its first words.
        bool revealed{true};
    };
    std::optional<Shadow> shadow;
    // Monotonic generation gate for speculative tokens (Req 2.3/2.5).
    std::uint64_t generation_id_{0};

    // Last automatic answer started from a closed [Outros] turn: lets a
    // question split in two turns be answered as a whole (on_turn).
    struct LastAuto {
        std::uint64_t turn_seq{0};
        std::string trigger;
    };
    LastAuto last_auto_;

    // Question gate (rtai/question_gate.hpp): the interviewer's closed turns
    // that are not answered yet. An unfinished phrase waits for the rest; a
    // complete request without '?' waits a short settle pause; statements
    // stay as context for the question that follows them.
    struct HeldQuestion {
        std::vector<std::string> parts; // open fragments of the question, oldest first
        std::string context;            // statements right before it
        std::string prefix;             // subject fused from earlier turns
        AudioSource source{AudioSource::Loopback};
        std::int64_t first_start_ms{0};
        std::int64_t last_end_ms{0};
        std::uint64_t last_seq{0};
        std::int64_t due_ms{-1}; // settle/hold deadline; -1 = kept only to join what comes next
        bool ready{false};       // complete request: answer at due_ms
        bool has_context{false}; // there was conversation before it
    };
    std::optional<HeldQuestion> held_q_;

    // The interviewer's utterance around one closed turn or interim.
    struct Utterance {
        std::string assess;             // open fragments + this text: what the gate judges
        std::string trigger;            // + what came right before: what the model answers
        std::vector<std::string> parts; // open fragments + this text
        bool chained{false};
    };

    // Cold_Path guard (Req 7.5): true from the moment finalize() is kicked off
    // until its callback resolves, so a second Finalize while the two parallel
    // calls are still in flight is ignored rather than fanning out twice.
    bool finalize_in_flight_{false};

    std::int64_t now_ms() const {
        return std::chrono::duration_cast<std::chrono::milliseconds>(
                   std::chrono::steady_clock::now() - cfg.session_start).count();
    }

    void publish(const EngineEvent& e) {
        std::shared_lock<std::shared_mutex> lk(publish_mu);
        if (!accepting) return;
        for (auto& s : sinks) {
            try { s(e); } catch (...) { /* a failing sink must not stop the others */ }
        }
    }

    // Req 5.1/5.4: the Event_Bus is driven purely by std::condition_variable.
    // post() enqueues an Input and wakes the orchestrator with notify_one() so
    // a published event reaches the consumer with no polling latency. There is
    // NO fixed sleep_for(50ms) in the event path.
    void post(Input in) {
        {
            std::lock_guard<std::mutex> lk(mu);
            if (stop_requested) return;
            inbox.push_back(std::move(in));
        }
        cv.notify_one();
    }

    // ------------------------------------------------------------------
    void run() {
        // Req 5.1/5.4: the consumer blocks on cv.wait_until(next_tick, pred) and
        // is woken immediately by post()'s notify_one() whenever an event lands.
        // cfg.tick (50 ms) is NOT a polling sleep for the event path — it serves
        // only as the periodic clock deadline for the TurnAssembler tick below.
        auto next_tick = std::chrono::steady_clock::now() + cfg.tick;
        for (;;) {
            std::deque<Input> batch;
            {
                std::unique_lock<std::mutex> lk(mu);
                cv.wait_until(lk, next_tick, [&] { return stop_requested || !inbox.empty(); });
                if (stop_requested) break;
                batch.swap(inbox);
            }
            for (auto& in : batch) {
                std::visit([&](auto& v) { handle(v); }, in);
            }
            if (std::chrono::steady_clock::now() >= next_tick) {
                for (auto& t : turns.tick(now_ms())) on_turn(t);
                if (!transcription_only_.load()) {
                    for (auto& c : turns.poll_speculative(now_ms())) on_speculative(c);
                }
                // Req 3.1: fallback commit guard. If neither speech_final nor
                // 120 ms of local silence closed the race, the deadline still
                // commits the pending speculation so the buffer becomes visible.
                if (shadow && shadow->state == ShadowState::Speculating &&
                    shadow->commit_deadline_ms >= 0 && now_ms() >= shadow->commit_deadline_ms) {
                    maybe_commit(CommitCause::Timeout, now_ms());
                }
                // Req 9.6: the 4000 ms window may expire with no further mic
                // frames, so release pending suggestions on the periodic tick.
                maybe_release_pending(now_ms());
                check_held(now_ms());
                next_tick = std::chrono::steady_clock::now() + cfg.tick;
            }
        }
    }

    void handle(InTranscript& in) {
        const auto closed = turns.on_event(in.ev, in.t);
        if (in.ev.kind == TranscriptKind::Transcript) {
            publish_live(in.ev.source, in.t);
            // Interim growth on the SAME lane aborts a hidden speculation whose
            // text no longer matches what is being said. Only a speculation
            // still Speculating is affected: a committed answer is on the card
            // and must not be killed because someone (e.g. the candidate, on
            // the other lane) started talking.
            if (shadow && shadow->state == ShadowState::Speculating && shadow->source == in.ev.source &&
                !in.ev.is_final && !text::trim(in.ev.text).empty()) {
                const std::string live = turns.live_text(in.ev.source);
                if (!live.empty()) {
                    const std::string enriched_live = live_utterance(live, in.ev.source, in.t).trigger;
                    if (!speculative_match(shadow->speculative_text, enriched_live)) {
                        const std::uint64_t sid = shadow->id;
                        abort_shadow();
                        publish(SpeculativeMissEvent{sid, now_ms()});
                    }
                }
            }
            // Req 3.1/3.2: Deepgram speech_final closes the commit race when it
            // arrives first for a shadow still Speculating on the same source.
            if (in.ev.speech_final && shadow &&
                shadow->state == ShadowState::Speculating && shadow->source == in.ev.source) {
                maybe_commit(CommitCause::SpeechFinal, in.t);
            }
        }
        for (const auto& t : closed) on_turn(t);
        if (in.ev.kind == TranscriptKind::Transcript && !in.ev.is_final) {
            if (!transcription_only_.load()) {
                for (auto& c : turns.poll_speculative(now_ms())) on_speculative(c);
            }
        }
    }

    void handle(InStatus& in) { publish(LaneStatusEvent{in.st, in.t}); }

    void handle(InPause& in) { publish(PauseEvent{in.paused, in.source, in.t}); }

    void handle(InFeedback& in) { publish(FeedbackEvent{in.id, in.vote, in.t}); }

    void handle(InClearChat&) {
        chat.clear();
        delivered_answers_.clear();
    }

    void handle(InAutoToggle& in) {
        auto_answer = in.enabled;
        cfg.decision.auto_enabled = in.enabled;
        policy.set_auto(in.enabled);
        if (!in.enabled) held_q_.reset();
        publish(AutoAnswerStateEvent{in.enabled, in.t});
    }

    void handle(InModeToggle& in) {
        if (in.enabled) {
            cancel_active();
            abort_shadow();
            pending.clear();
            held_q_.reset();
        }
        publish(TranscriptionModeEvent{in.enabled, in.t});
    }

    void handle(InMicRms& in) {
        gate.on_mic_rms(in.rms, in.threshold, in.t);
        maybe_release_pending(in.t);
    }

    void handle(InPtt& in) {
        gate.ptt_down = in.down;
        if (!in.down) maybe_release_pending(in.t);
    }

    // Req 2.1/1.3/1.5: the acoustic FrameVad signalled 110 ms of local silence.
    // Enter Speculating only when the current interim passes the fast filter
    // (>5 words + question structure) and nothing is already in flight.
    void handle(InVadSpeculate& in) {
        if (transcription_only_.load()) return;
        // A previous answer may still be streaming: speculating is hidden and
        // only replaces it on commit, so it doesn't wait for it.
        if (!llm || shadow) return;
        if (in.source != cfg.decision.trigger_source) return;
        std::string interim = turns.live_text(in.source);
        if (cfg.question_gate) {
            // Speculate only on a complete question (with the fragments the
            // interviewer said right before it).
            const Utterance u = live_utterance(interim, in.source, in.t);
            if (text::word_count(u.assess) <= 5) return;
            if (assess_question(u.assess, convo.size() >= 1, false).verdict != QuestionVerdict::Ready) return;
            if (policy.would_trigger(u.assess, in.t, true) == TriggerReason::None) return;
            enter_speculating(SpeculativeCandidate{in.source, std::move(interim), in.t}, TriggerReason::Question,
                              u.trigger);
            return;
        }
        if (!policy.fast_filter(interim)) return; // gate (Req 1.4/1.5)
        if (policy.would_trigger(interim, in.t) == TriggerReason::None) return; // cooldown / small talk
        enter_speculating(SpeculativeCandidate{in.source, std::move(interim), in.t}, TriggerReason::Question);
    }
    // Req 3.1/3.3: 120 ms of absolute local silence closes the commit race.
    // Commit only when a shadow is Speculating for the same source.
    void handle(InVadCommitSilence& in) {
        if (shadow && shadow->state == ShadowState::Speculating && shadow->source == in.source)
            maybe_commit(CommitCause::LocalSilence, in.t);
    }
    // Req 3.1/3.2: Deepgram speech_final closes the commit race whenever it
    // arrives first, for a shadow still Speculating on the same source.
    void handle(InSpeechFinal& in) {
        if (shadow && shadow->state == ShadowState::Speculating && shadow->source == in.source)
            maybe_commit(CommitCause::SpeechFinal, in.t);
    }

    // Shadow token delta routed back from the LLM worker thread (Req 2.4/2.5/2.6).
    void handle(InShadowDelta& in) { on_shadow_delta(in.gen, in.text); }

    // Automatic answer (direct path): its first words decide whether the card
    // is shown at all.
    void handle(InHoldDecided& in) {
        if (!active || active->id != in.id) return; // replaced or cancelled meanwhile
        auto it = meta.find(in.id);
        if (it == meta.end() || it->second.shown) return;
        if (in.skip) {
            // The model saw no question: nothing reaches the screen (the
            // pending InLlmDone finds the card unshown and stays silent).
            if (active->ctx) active->ctx->cancelled.store(true);
            if (active->call) active->call->cancel();
            active.reset();
            return;
        }
        show_held_card(in.id);
    }

    // Speculative generation finished (any status). Stale generations are
    // ignored; a hidden one is parked until commit (or dropped on failure); a
    // committed one completes its visible card.
    void handle(InShadowDone& in) {
        if (!shadow || shadow->id != in.gen) return;
        if (shadow->state == ShadowState::Speculating) {
            if (in.res.status == LlmStatus::Failed || in.res.status == LlmStatus::Cancelled) {
                const std::uint64_t sid = shadow->id;
                if (shadow->ctx) meta.erase(shadow->ctx->id);
                shadow.reset();
                publish(SpeculativeMissEvent{sid, now_ms()});
                return;
            }
            shadow->finished = true;
            shadow->final_res = in.res;
            shadow->final_text = std::move(in.text);
            return;
        }
        if (shadow->state == ShadowState::Committed) {
            InLlmDone done{shadow->active_id, in.res, std::move(in.text), shadow->first_visible_ms};
            handle(done);
        }
    }

    // Req 7.1/7.5: the Finalize action. Hand the engine-owned SessionTranscript
    // to the analytics client and start the two parallel Cold_Path calls. The
    // overlay stays LiveCopilot while they are in flight — nothing is published
    // here that switches mode. No-op without an analytics client, with an empty
    // transcript, or while a previous Finalize is still resolving.
    void handle(InFinalize& in) {
        (void)in;
        if (!analytics || finalize_in_flight_ || transcript_.empty()) return;
        finalize_in_flight_ = true;
        std::weak_ptr<Impl> weak = shared_from_this();
        // on_done fires on a Cold_Path worker thread; route it back onto the
        // inbox so all engine state stays single-threaded (Req 8.3), mirroring
        // how the LLM worker's on_done is posted as an Input.
        analytics->finalize(transcript_, [weak](bool ok, JevReport report) {
            if (auto self = weak.lock()) {
                self->post(InFinalizeDone{ok, std::move(report), self->now_ms()});
            }
        });
    }

    // Req 8.1-8.3: the all-or-nothing join resolved. On the double-success
    // (ok == true) publish OverlayModeEvent{PostInterviewReport, report} so the
    // overlay switches modes and renders the dashboard. On any failure/timeout
    // (ok == false) stay in LiveCopilot and publish nothing that switches mode;
    // the partial result was already discarded by the client (Req 8.4).
    void handle(InFinalizeDone& in) {
        finalize_in_flight_ = false;
        if (!in.ok) return; // stay LiveCopilot, publish nothing (Req 7.5/8.4)
        OverlayModeEvent ev;
        ev.mode = OverlayMode::PostInterviewReport;
        ev.report = std::move(in.report);
        ev.t_ms = in.t;
        publish(ev); // double-success only (Req 8.3)
    }

    void handle(InAction& in) {
        if (transcription_only_.load()) {
            publish(NoticeEvent{NoticeLevel::Info, "Transcription-only mode is on: AI suggestions are off.", in.t});
            return;
        }
        if (!llm) {
            publish(NoticeEvent{NoticeLevel::Warning,
                                "Suggestions are off: add the OpenRouter key in Settings > General.", in.t});
            return;
        }
        if (in.reason == TriggerReason::Chat && text::trim(in.text).empty()) return;
        if ((in.reason == TriggerReason::Recap || in.reason == TriggerReason::FollowUp) && convo.size() == 0 &&
            turns.live_text(AudioSource::Loopback).empty() && turns.live_text(AudioSource::Microphone).empty()) {
            publish(NoticeEvent{NoticeLevel::Info, "There is no conversation yet.", in.t});
            return;
        }
        policy.note_manual(in.t);
        ActionInput ai;
        ai.reason = in.reason;
        ai.text = text::trim(in.text);
        ai.image_url = std::move(in.image);

        std::string shown; // what the overlay shows as the "question"
        switch (in.reason) {
            case TriggerReason::Recap:      shown = "Conversation recap"; break;
            case TriggerReason::FollowUp:   shown = "Follow-up questions"; break;
            case TriggerReason::Screenshot: shown = ai.text.empty() ? std::string("Screenshot") : ai.text; break;
            default:                        shown = ai.text; break;
        }
        std::vector<ChatTurn> thread(chat.begin(), chat.end());
        std::string history = render_history_with_live();
        auto messages = build_action_messages(cfg.prompt, history, ai, thread);
        std::string question;
        if (in.reason == TriggerReason::Chat) question = ai.text;
        else if (in.reason == TriggerReason::Screenshot) question = "[captura de tela] " + ai.text;
        start_request(std::move(shown), AudioSource::Microphone, in.reason, {}, std::move(messages),
                      !ai.image_url.empty(), std::move(question));
    }

    // Closed turns plus what is being said right now, the candidate's own
    // spoken microphone turns ("[Você]"), AND the rolling memory of answers
    // already suggested by the copilot during this session so the AI maintains
    // strict persona coherence and situational awareness.
    std::string render_history_with_answers(bool include_live = true) const {
        std::string h = convo.render(cfg.prompt.max_history_chars);
        if (include_live) {
            for (AudioSource s : {AudioSource::Loopback, AudioSource::Microphone}) {
                const std::string live = turns.live_text(s);
                if (!live.empty()) h += std::string("[") + speaker_tag(s) + "] " + live + " (falando)\n";
            }
        }
        const std::string my_spoken = convo.render_source(AudioSource::Microphone, 1000);
        if (!my_spoken.empty()) {
            h += "\n[Minhas Respostas já Faladas pelo Microfone ([Você]) nesta Entrevista]:\n";
            h += my_spoken;
        }
        if (!delivered_answers_.empty()) {
            h += "\n[Histórico de Respostas já Sugeridas pelo Copiloto nesta Sessão "
                 "(mantenha a mesma persona e coerência com o que já foi respondido)]:\n";
            std::size_t idx = 1;
            for (const auto& da : delivered_answers_) {
                h += "#" + std::to_string(idx++) + " Pergunta/Gatilho: \"" + da.question + "\"\n";
                h += "   Resposta sugerida: " + da.answer + "\n";
            }
        }
        return h;
    }

    std::string render_history_with_live() const {
        return render_history_with_answers(true);
    }

    void handle(InNotice& in) { publish(NoticeEvent{in.level, std::move(in.text), in.t}); }

    void handle(InManual& in) {
        if (transcription_only_.load()) {
            publish(NoticeEvent{NoticeLevel::Info, "Transcription-only mode is on: AI suggestions are off.", in.t});
            return;
        }
        if (!llm) {
            publish(NoticeEvent{NoticeLevel::Warning,
                                "Suggestions are off: add the OpenRouter key in Settings > General.", in.t});
            return;
        }
        // The interviewer's whole recent utterance: the closed turns said close
        // together plus what is still being said. The STT closes a phrase on
        // every short pause, so the last turn alone is often only the tail of
        // the question ("Não é a questão da cultura da Nubank.").
        AudioSource src = AudioSource::Loopback;
        std::string trigger = recent_interviewer_utterance(AudioSource::Loopback, in.t);
        if (trigger.empty()) {
            if (auto last = convo.last()) {
                trigger = last->text;
                src = last->source;
            }
        }
        // The interviewer's question may be in pieces held by the gate.
        if (held_q_ && !held_q_->parts.empty() && src == held_q_->source) {
            std::vector<std::string> parts = held_q_->parts;
            const std::string live = turns.live_text(held_q_->source);
            if (!live.empty()) parts.push_back(live);
            trigger = text::join_space(held_q_->prefix, text::join_space(held_q_->context, join_fragments(parts)));
        }
        if (trigger.empty()) {
            publish(NoticeEvent{NoticeLevel::Info, "Nothing to answer yet.", in.t});
            return;
        }
        held_q_.reset();
        if (shadow && shadow->state == ShadowState::Speculating) abort_shadow(); // the manual request wins
        policy.note_manual(in.t);
        start_suggestion(std::move(trigger), src, TriggerReason::Manual, {});
    }

    void handle(InLlmDone& in) {
        if (transcription_only_.load()) {
            if (active && active->id == in.id) active.reset();
            if (shadow && shadow->state == ShadowState::Committed && shadow->active_id == in.id)
                shadow.reset();
            for (auto it = promoted_map_.begin(); it != promoted_map_.end();) {
                if (it->second == in.id) it = promoted_map_.erase(it); else ++it;
            }
            meta.erase(in.id);
            return;
        }
        // A hidden automatic answer: "[SKIP]", cancelled or replaced means
        // nothing ever reaches the screen (nor the session log).
        if (auto hit = meta.find(in.id); hit != meta.end() && !hit->second.shown) {
            const bool current = active && active->id == in.id;
            const bool silent = !current || in.res.status == LlmStatus::Cancelled ||
                                (in.res.status == LlmStatus::Completed &&
                                 skip_verdict(in.text) != SkipVerdict::Answer);
            if (silent) {
                meta.erase(hit);
                if (current) active.reset();
                if (shadow && shadow->state == ShadowState::Committed && shadow->active_id == in.id) shadow.reset();
                for (auto pit = promoted_map_.begin(); pit != promoted_map_.end();) {
                    if (pit->second == in.id) pit = promoted_map_.erase(pit); else ++pit;
                }
                return;
            }
            // A real answer (or an error) that finished before it was shown.
            if (shadow && shadow->state == ShadowState::Committed && shadow->active_id == in.id) {
                reveal_shadow();
            } else {
                show_held_card(in.id);
            }
            if (in.first_visible_ms < 0 && !in.text.empty()) in.first_visible_ms = now_ms();
        }
        SuggestionDoneEvent e;
        e.id = in.id;
        e.status = in.res.status;
        e.text = std::move(in.text);
        {
            // "PERGUNTA: ..." header: the question as the model understood it.
            InterpretedAnswer ia = split_interpreted_answer(e.text, true);
            if (ia.has_header) {
                e.interpreted_question = std::move(ia.question);
                e.text = std::move(ia.body);
            }
        }
        e.error = in.res.error;
        e.model = cfg.model;
        e.ttft_ms = in.res.ttft_ms;
        e.total_ms = in.res.total_ms;
        e.t_ms = now_ms();
        std::vector<std::string> unsupported;
        if (auto it = meta.find(in.id); it != meta.end()) {
            e.trigger_text = it->second.trigger;
            e.reason = it->second.reason;
            if (in.first_visible_ms >= 0 && it->second.shown_ms >= 0) {
                e.visible_ms = std::max<std::int64_t>(0, in.first_visible_ms - it->second.shown_ms);
            }
            const TriggerReason rr = it->second.reason;
            const bool answer_like = rr == TriggerReason::Question || rr == TriggerReason::Keyword ||
                                     rr == TriggerReason::LongTurn || rr == TriggerReason::Manual ||
                                     rr == TriggerReason::Chat;
            if (answer_like && in.res.status == LlmStatus::Completed && !it->second.grounding.empty()) {
                unsupported = ungrounded_numbers(e.text, it->second.grounding);
                for (auto& term : ungrounded_terms(e.text, it->second.grounding)) {
                    if (std::find(unsupported.begin(), unsupported.end(), term) == unsupported.end())
                        unsupported.push_back(std::move(term));
                }
            }
            if (in.res.status == LlmStatus::Completed && !e.text.empty()) {
                if (!it->second.question.empty()) {
                    chat.push_back(ChatTurn{it->second.question, text::truncate_utf8(e.text, kMaxChatAnswerChars)});
                    while (chat.size() > kMaxChatTurns) chat.pop_front();
                }
                const std::string q_label = !it->second.question.empty()       ? it->second.question
                                            : !e.interpreted_question.empty() ? e.interpreted_question
                                                                              : it->second.trigger;
                if (!q_label.empty()) {
                    delivered_answers_.push_back(
                        ChatTurn{q_label, text::truncate_utf8(e.text, kMaxDeliveredAnswerChars)});
                    while (delivered_answers_.size() > kMaxDeliveredAnswers) delivered_answers_.pop_front();
                }
            }
            meta.erase(it);
        }
        if (active && active->id == in.id) active.reset();
        // A committed shadow shares its id with the now-finished visible card;
        // clear it so it no longer blocks future speculations (active || shadow).
        if (shadow && shadow->state == ShadowState::Committed && shadow->active_id == in.id)
            shadow.reset();
        // Drop the promoted_map_ entry once the visible card is done.
        for (auto it = promoted_map_.begin(); it != promoted_map_.end();) {
            if (it->second == in.id) it = promoted_map_.erase(it); else ++it;
        }
        publish(e);
        if (!unsupported.empty()) {
            std::string list;
            for (std::size_t i = 0; i < unsupported.size() && i < 4; ++i) {
                if (i) list += ", ";
                list += unsupported[i];
            }
            publish(NoticeEvent{NoticeLevel::Warning,
                                "Check before saying it: " + list +
                                    " is not in your files or in the conversation.",
                                now_ms()});
        }
    }

    // The interviewer's recent utterance on `src` for a manual trigger: the
    // closed turns said close together (a short "uhum" from the other lane in
    // between does not split them) plus the live text still being spoken.
    std::string recent_interviewer_utterance(AudioSource src, std::int64_t now) const {
        std::vector<std::string> parts;
        std::size_t chars = 0;
        const std::string live = text::trim(turns.live_text(src));
        std::int64_t next_start = live.empty() ? now : turns.open_turn_start_ms(src);
        if (next_start < 0) next_start = now;
        const auto& all = convo.all();
        bool first = true;
        for (auto it = all.rbegin(); it != all.rend() && parts.size() < kManualMaxTurns; ++it) {
            if (it->source != src) {
                if (text::word_count(it->text) > kBackchannelMaxWords) break; // the candidate answered
                continue;
            }
            // The newest closed turn always counts (it is what was asked);
            // older ones only while they chain without a long pause.
            if (!(first && live.empty()) && next_start - it->end_ms > kManualFragmentGapMs) break;
            if (chars + it->text.size() > kManualMaxChars && !parts.empty()) break;
            parts.push_back(it->text);
            chars += it->text.size();
            next_start = it->start_ms;
            first = false;
        }
        std::reverse(parts.begin(), parts.end());
        if (!live.empty()) parts.push_back(live);
        return join_fragments(parts);
    }

    // ------------------------------------------------------------------
    void publish_live(AudioSource s, std::int64_t t) {
        std::string live = turns.live_text(s);
        std::string& last = last_live[lane_index(s)];
        if (live == last) return;
        last = live;
        publish(TranscriptUpdateEvent{s, std::move(live), false, t});
    }

    void on_turn(const Turn& turn) {
        // Drop duplicate closed turns on the same lane (e.g. repeated finals)
        if (auto last_closed = convo.last_from(turn.source)) {
            if (last_closed->text == turn.text && std::abs(turn.start_ms - last_closed->start_ms) < 2000) {
                return;
            }
        }

        convo.add(turn);
        last_live[lane_index(turn.source)].clear();
        publish(TranscriptUpdateEvent{turn.source, turn.text, true, turn.end_ms});
        publish(TurnEvent{turn});
        // Feed the session transcript for every closed turn of both lanes,
        // right after publishing the TurnEvent and before any speculative
        // match / trigger evaluation (Req 6.1/6.2/6.3).
        {
            std::lock_guard<std::mutex> lk(transcript_mu_);
            transcript_.append(turn);
        }

        if (transcription_only_.load()) return;

        const bool gated = cfg.question_gate && llm && cfg.decision.auto_enabled;
        if (gated && turn.source != cfg.decision.trigger_source) {
            // The candidate answered (more than a short "uhum"): what the
            // interviewer left open is over.
            if (held_q_ && text::word_count(turn.text) > kBackchannelMaxWords) resolve_held(turn.end_ms, true);
            return;
        }

        // Context-Aware Trigger Resolution: enrich trigger with full subject / premise from prior turn(s)
        std::optional<Turn> prev_loopback;
        const auto& all_turns = convo.all();
        if (all_turns.size() >= 2) {
            prev_loopback = collect_loopback_context(all_turns, all_turns.size() - 1, turn.start_ms);
        }
        const std::int64_t gap = prev_loopback ? (turn.start_ms - prev_loopback->end_ms) : -1;
        const std::string enriched_trigger = enrich_trigger_with_subject(prev_loopback, turn.text, gap);
        const std::string fusion_prefix =
            (prev_loopback && enriched_trigger != turn.text) ? prev_loopback->text : std::string{};

        // The interviewer's utterance: this turn joined to the fragments said
        // right before it, judged by the question gate.
        const bool has_context = all_turns.size() >= 2;
        const Utterance u = gated ? utterance_for(turn.text, turn.source, turn.start_ms, enriched_trigger)
                                  : Utterance{turn.text, enriched_trigger, {turn.text}, false};
        const QuestionAssessment qa = gated ? assess_question(u.assess, has_context, false) : QuestionAssessment{};
        const std::string& trigger_text = u.trigger;

        // Speculative match/divergence at turn close (Req 3.4).
        if (shadow && turn.source == shadow->source) {
            const bool matches = speculative_match(shadow->speculative_text, trigger_text);
            const bool grew = matches && extension_adds_question(shadow->speculative_text, trigger_text);
            if (shadow->state == ShadowState::Committed) {
                // Already committed early (speech_final / local silence): the
                // answer is on the card. A matching close is confirmation.
                if (matches && !grew) {
                    last_auto_ = LastAuto{turn.seq, shadow->speculative_text};
                    held_q_.reset();
                    return;
                }
                if (grew) {
                    // The question went on after the early commit: the card
                    // only answers its first half. Redo it for the whole
                    // question right away (latest wins, no cooldown), unless
                    // the rest is still coming.
                    abort_shadow();
                    if (gated && qa.verdict == QuestionVerdict::Wait) {
                        hold_utterance(u, turn, false, has_context, fusion_prefix);
                        return;
                    }
                    if (!gated || qa.verdict == QuestionVerdict::Ready) {
                        held_q_.reset();
                        policy.record_trigger(TriggerReason::Question, turn.end_ms);
                        start_suggestion(trigger_text, turn.source, TriggerReason::Question, {});
                        last_auto_ = LastAuto{turn.seq, trigger_text};
                        return;
                    }
                }
                // A diverging close is a different utterance: normal policy below.
            } else if (shadow->state == ShadowState::Speculating) {
                if (matches && !grew) {
                    if (!gated || (qa.verdict == QuestionVerdict::Ready && qa.explicit_question)) {
                        // Named transition: Speculating -> Committed. The closed
                        // turn text is the authoritative trigger (Req 3.4 match).
                        shadow->speculative_text = trigger_text;
                        held_q_.reset();
                        commit_shadow(CommitCause::TurnMatch);
                        last_auto_ = LastAuto{turn.seq, trigger_text};
                        return; // committed; no further trigger for this turn
                    }
                    if (qa.verdict == QuestionVerdict::Ready) {
                        // A complete request without '?': keep generating
                        // hidden and show it after the settle pause, unless
                        // the interviewer goes on.
                        shadow->speculative_text = trigger_text;
                        hold_utterance(u, turn, true, has_context, fusion_prefix);
                        return;
                    }
                    // Half a question, or not a question: never shown.
                }
                // Diverged or grew into a bigger question: abort (gen++, stream
                // cancelled, buffer discarded, visible card untouched) and let
                // the closed turn start a fresh generation (Req 3.4 diverge).
                const std::uint64_t sid = shadow->id;
                abort_shadow();
                publish(SpeculativeMissEvent{sid, now_ms()});
            }
        }

        if (gated) {
            gated_decision(u, qa, turn, fusion_prefix, has_context);
            return;
        }

        // Split question: "Me conta do projeto Midea" <pause> "e qual foi o
        // maior desafio?". The first piece (no '?') already got an answer; the
        // second piece arrives right after, nobody else spoke and the user is
        // not talking. Answer the whole question instead of half of it.
        if (llm && cfg.decision.auto_enabled && turn.source == cfg.decision.trigger_source &&
            last_auto_.turn_seq != 0 && all_turns.size() >= 2 && !gate.should_pin()) {
            const Turn& prev = all_turns[all_turns.size() - 2];
            const bool continues = prev.seq == last_auto_.turn_seq && prev.source == turn.source &&
                                   turn.start_ms - prev.end_ms <= kContinuationWindowMs &&
                                   !ends_as_question(last_auto_.trigger) &&
                                   text::word_count(turn.text) >= 2 &&
                                   !DecisionPolicy::is_small_talk(text::fold(turn.text));
            if (continues) {
                const std::string merged =
                    norm_words(enriched_trigger).find(norm_words(last_auto_.trigger)) != std::string::npos
                        ? enriched_trigger
                        : text::join_space(last_auto_.trigger, turn.text);
                policy.record_trigger(TriggerReason::Question, turn.end_ms);
                start_suggestion(merged, turn.source, TriggerReason::Question, {});
                last_auto_ = LastAuto{turn.seq, merged};
                return;
            }
        }

        // The question-after-keyword upgrade lives inside evaluate(): it is the
        // only path that returns a trigger while still inside the cooldown, and
        // it is preserved here untouched.
        const TriggerReason r = policy.evaluate(turn, turn.end_ms);
        if (r != TriggerReason::None && llm) {
            if (route_suggestion(enriched_trigger, turn.source, r, policy.last_keyword(), turn.end_ms)) {
                last_auto_ = LastAuto{turn.seq, enriched_trigger};
            }
        } else if (r == TriggerReason::None && llm && policy.config().enqueue_on_cooldown) {
            const TriggerReason pr = policy.probe_reason_ignoring_cooldown(turn.text);
            if (pr != TriggerReason::None && turn.source == policy.config().trigger_source) {
                const std::string kw = policy.probe_keyword(turn.text);
                enqueue_suggestion(turn.text, turn.source, pr, kw, turn.end_ms);
            }
        }
    }

    // ------------------------------------------------------------------
    // Question gate: is what the interviewer said a complete question?

    bool may_skip(TriggerReason r) const { return cfg.allow_skip && r == TriggerReason::Question; }

    // Interviewer fragments close together are one utterance.
    bool chains_with_held(AudioSource src, std::int64_t start_ms) const {
        return held_q_ && held_q_->source == src && start_ms >= 0 &&
               start_ms - held_q_->last_end_ms <= cfg.fragment_gap_ms;
    }

    // `text` (a closed turn or the live interim that started at `start_ms`)
    // joined to the held fragments before it; `enriched` (subject fusion) is
    // the trigger when nothing is held.
    Utterance utterance_for(const std::string& text_in, AudioSource src, std::int64_t start_ms,
                            const std::string& enriched) const {
        Utterance u;
        if (chains_with_held(src, start_ms)) {
            u.parts = held_q_->parts;
            u.parts.push_back(text_in);
            u.assess = join_fragments(u.parts);
            u.trigger = text::join_space(held_q_->prefix, text::join_space(held_q_->context, u.assess));
            u.chained = true;
        } else {
            u.parts = {text_in};
            u.assess = text_in;
            u.trigger = enriched;
        }
        return u;
    }

    // Same for the live text of the open turn on `src` at time `t`.
    Utterance live_utterance(const std::string& live, AudioSource src, std::int64_t t) const {
        auto prev_lb = collect_loopback_context(convo.all(), convo.size(), t);
        const std::int64_t g = prev_lb ? (t - prev_lb->end_ms) : -1;
        const std::string enriched = enrich_trigger_with_subject(prev_lb, live, g);
        const std::int64_t start = turns.open_turn_start_ms(src);
        return utterance_for(live, src, start >= 0 ? start : t, enriched);
    }

    // Holds `u` (ending with `turn`): `ready` waits the settle pause before
    // answering, otherwise it waits for the rest of the phrase.
    void hold_utterance(const Utterance& u, const Turn& turn, bool ready, bool has_context,
                        const std::string& prefix_if_new) {
        HeldQuestion h;
        if (u.chained && held_q_) {
            h.prefix = held_q_->prefix;
            h.context = held_q_->context;
            h.first_start_ms = held_q_->first_start_ms;
            h.has_context = held_q_->has_context;
        } else {
            h.prefix = prefix_if_new;
            h.first_start_ms = turn.start_ms;
            h.has_context = has_context;
        }
        h.parts = u.parts;
        h.source = turn.source;
        h.last_end_ms = turn.end_ms;
        h.last_seq = turn.seq;
        h.ready = ready;
        h.due_ms = turn.end_ms + (ready ? cfg.question_settle_ms : cfg.question_hold_ms);
        held_q_ = std::move(h);
    }

    // Not a question: what was said stays as context for the question that
    // may follow it ("Aqui a gente usa Kafka." "Você já trabalhou com isso?").
    void keep_as_context(const Utterance& u, const Turn& turn, bool has_context, const std::string& prefix_if_new) {
        HeldQuestion h;
        if (u.chained && held_q_) {
            h.prefix = held_q_->prefix;
            h.context = held_q_->context;
            h.first_start_ms = held_q_->first_start_ms;
            h.has_context = held_q_->has_context;
        } else {
            h.prefix = prefix_if_new;
            h.first_start_ms = turn.start_ms;
            h.has_context = has_context;
        }
        h.context = text::tail_utf8(text::join_space(h.context, u.assess), kMaxHeldContextChars);
        h.source = turn.source;
        h.last_end_ms = turn.end_ms;
        h.last_seq = turn.seq;
        held_q_ = std::move(h);
    }

    // A complete question from the interviewer: answered like any automatic
    // trigger (cooldown, Pin on Speak).
    void fire_question(const std::string& trigger, AudioSource src, std::int64_t now, std::uint64_t seq) {
        Turn t;
        t.source = src;
        t.text = trigger;
        t.start_ms = now;
        t.end_ms = now;
        t.seq = seq;
        const TriggerReason r = policy.evaluate(t, now, true);
        if (r != TriggerReason::None) {
            if (route_suggestion(trigger, src, r, policy.last_keyword(), now)) last_auto_ = LastAuto{seq, trigger};
        } else if (policy.config().enqueue_on_cooldown &&
                   policy.would_trigger(trigger, -1, true) != TriggerReason::None) {
            enqueue_suggestion(trigger, src, TriggerReason::Question, {}, now);
        }
    }

    // The gate's decision on the interviewer's closed turn `turn` (utterance
    // `u`): answer now, wait for more, or keep it as context.
    void gated_decision(const Utterance& u, const QuestionAssessment& qa, const Turn& turn,
                        const std::string& fusion_prefix, bool has_context) {
        const auto& all_turns = convo.all();
        // Split question: "Me conta do projeto Midea" <pause> "e qual foi o
        // maior desafio?". The first piece already got an answer; the second
        // arrives right after, nobody else spoke and the user is not talking.
        // Answer the whole question instead of half of it.
        if (!u.chained && last_auto_.turn_seq != 0 && all_turns.size() >= 2 && !gate.should_pin()) {
            const Turn& prev = all_turns[all_turns.size() - 2];
            const bool continues = prev.seq == last_auto_.turn_seq && prev.source == turn.source &&
                                   turn.start_ms - prev.end_ms <= kContinuationWindowMs &&
                                   !ends_as_question(last_auto_.trigger) &&
                                   text::word_count(turn.text) >= 2 &&
                                   !DecisionPolicy::is_small_talk(text::fold(turn.text));
            if (continues && qa.verdict == QuestionVerdict::Wait) {
                // "...e qual foi o": wait for the rest, then answer it all.
                hold_utterance(u, turn, false, has_context, last_auto_.trigger);
                return;
            }
            if (continues && (qa.verdict == QuestionVerdict::Ready || content_word_count(turn.text) >= 2)) {
                const std::string merged =
                    norm_words(u.trigger).find(norm_words(last_auto_.trigger)) != std::string::npos
                        ? u.trigger
                        : text::join_space(last_auto_.trigger, turn.text);
                held_q_.reset();
                policy.record_trigger(TriggerReason::Question, turn.end_ms);
                start_suggestion(merged, turn.source, TriggerReason::Question, {});
                last_auto_ = LastAuto{turn.seq, merged};
                return;
            }
        }
        if (qa.verdict == QuestionVerdict::Ready && qa.explicit_question) {
            held_q_.reset();
            fire_question(u.trigger, turn.source, turn.end_ms, turn.seq);
            return;
        }
        if (qa.verdict == QuestionVerdict::Ready) {
            // A complete request without '?': a short pause in case the
            // interviewer goes on; the answer is generated meanwhile, hidden.
            hold_utterance(u, turn, true, has_context, fusion_prefix);
            if (cfg.allow_speculative && !shadow) {
                enter_speculating(SpeculativeCandidate{turn.source, turn.text, turn.end_ms}, TriggerReason::Question,
                                  u.trigger);
            }
            return;
        }
        if (qa.verdict == QuestionVerdict::Wait) {
            hold_utterance(u, turn, false, has_context, fusion_prefix);
            return;
        }
        // Not a question: it stays as context for what comes next, and the
        // keyword/long-turn rules still apply (sales calls).
        keep_as_context(u, turn, has_context, fusion_prefix);
        Turn st = turn;
        st.text = u.assess;
        const TriggerReason r = policy.evaluate(st, turn.end_ms, false);
        if (r != TriggerReason::None) {
            if (route_suggestion(u.trigger, turn.source, r, policy.last_keyword(), turn.end_ms)) {
                last_auto_ = LastAuto{turn.seq, u.trigger};
                held_q_.reset();
            }
        } else if (policy.config().enqueue_on_cooldown) {
            const TriggerReason pr = policy.would_trigger(u.assess, -1, false);
            if (pr != TriggerReason::None) {
                enqueue_suggestion(u.trigger, turn.source, pr, policy.probe_keyword(u.assess), turn.end_ms);
            }
        }
    }

    // The held utterance will not grow any more (the pause ran out, or the
    // candidate started talking): answer it if it is a question.
    void resolve_held(std::int64_t now, bool candidate_spoke) {
        if (!held_q_) return;
        HeldQuestion h = std::move(*held_q_);
        held_q_.reset();
        if (h.parts.empty()) return; // only context, nothing was asked
        const std::string asked = join_fragments(h.parts);
        const bool ready =
            h.ready || assess_question(asked, h.has_context, true).verdict == QuestionVerdict::Ready;
        const bool shadow_here =
            shadow && shadow->state == ShadowState::Speculating && shadow->source == h.source;
        if (!ready) {
            if (shadow_here) {
                const std::uint64_t sid = shadow->id;
                abort_shadow();
                publish(SpeculativeMissEvent{sid, now_ms()});
            }
            // Keep the unfinished phrase: a late "...teve um prazo apertado"
            // still completes it. Not after the candidate spoke, though.
            if (!candidate_spoke) {
                h.due_ms = -1;
                h.ready = false;
                held_q_ = std::move(h);
            }
            return;
        }
        const std::string trigger = text::join_space(h.prefix, text::join_space(h.context, asked));
        if (shadow_here && speculative_match(shadow->speculative_text, trigger) &&
            !extension_adds_question(shadow->speculative_text, trigger)) {
            shadow->speculative_text = trigger;
            commit_shadow(CommitCause::TurnMatch);
            last_auto_ = LastAuto{h.last_seq, trigger};
            return;
        }
        if (shadow_here) {
            const std::uint64_t sid = shadow->id;
            abort_shadow();
            publish(SpeculativeMissEvent{sid, now_ms()});
        }
        fire_question(trigger, h.source, now, h.last_seq);
    }

    // Settle/hold deadlines of the held question (orchestrator tick).
    void check_held(std::int64_t now) {
        if (!held_q_) return;
        if (transcription_only_.load() || !cfg.decision.auto_enabled || !llm) {
            held_q_.reset();
            return;
        }
        const bool talking = turns.has_open_turn(held_q_->source);
        if (held_q_->due_ms < 0) {
            // Kept only to join what comes next: forget it once nothing can.
            if (!talking && now - held_q_->last_end_ms > cfg.fragment_gap_ms) held_q_.reset();
            return;
        }
        if (now < held_q_->due_ms) return;
        // The interviewer is talking again: the next closed turn decides.
        if (talking && now - held_q_->first_start_ms < kMaxQuestionHoldMs) {
            held_q_->due_ms = now + 100;
            return;
        }
        resolve_held(now, false);
    }

    // Shows a held automatic answer (direct path) with the text received so
    // far; later deltas stream straight to the card.
    void show_held_card(std::uint64_t id) {
        auto it = meta.find(id);
        if (it == meta.end() || it->second.shown) return;
        it->second.shown = true;
        SuggestionStartedEvent ev = it->second.pending_start;
        ev.t_ms = now_ms();
        last_card_ms = ev.t_ms;
        it->second.shown_ms = ev.t_ms;
        publish(ev);
        if (active && active->id == id && active->ctx) {
            std::lock_guard<std::mutex> lk(active->ctx->hold_mu);
            if (!active->ctx->text.empty()) {
                active->ctx->first_visible_ms.store(ev.t_ms);
                publish(SuggestionDeltaEvent{id, active->ctx->text});
            }
            active->ctx->holding = false;
        }
    }

    // Shows a committed speculation's card: started card, hit, and the text
    // buffered so far.
    void reveal_shadow() {
        if (!shadow || shadow->state != ShadowState::Committed || shadow->revealed) return;
        shadow->revealed = true;
        const std::uint64_t pid = shadow->active_id;
        SuggestionStartedEvent ev;
        ev.id = pid;
        ev.trigger_text = shadow->speculative_text;
        ev.trigger_source = shadow->source;
        ev.reason = shadow->reason;
        ev.keyword = shadow->keyword;
        ev.model = cfg.model;
        ev.t_ms = now_ms();
        last_card_ms = ev.t_ms; // opens the Pin-on-Speak window (Req 9)
        meta[pid].shown_ms = ev.t_ms;
        meta[pid].shown = true;
        publish(ev);

        publish(SpeculativeHitEvent{shadow->id, pid, now_ms()});

        // Promote the hidden buffer as the first visible content (Req 2.2).
        if (!shadow->shadow_buffer_.empty()) {
            shadow->first_visible_ms = ev.t_ms;
            publish(SuggestionDeltaEvent{pid, shadow->shadow_buffer_});
        }
    }

    // Pin on Speak (Req 9.1, 9.5, 9.6). A fired trigger either replaces the
    // visible card or is enqueued when the user is speaking / we are still
    // inside the 4000 ms window since the current card appeared. Returns true
    // when the suggestion started (card replaced), false when it was queued.
    bool route_suggestion(std::string trigger, AudioSource src, TriggerReason reason,
                          std::string keyword, std::int64_t now) {
        const std::int64_t window = cfg.decision.cooldown_ms;
        // evaluate() only returns a trigger while still inside the cooldown for
        // the question-after-keyword upgrade; that upgrade must REPLACE the
        // keyword card (never enqueue), so it bypasses the window gate. Speech
        // still pins it: if the user is actually talking we enqueue regardless.
        const bool is_upgrade = reason == TriggerReason::Question && last_card_ms >= 0 && window > 0 &&
                                (now - last_card_ms) < window;
        const bool inside_window =
            !is_upgrade && last_card_ms >= 0 && window > 0 && (now - last_card_ms) < window;
        if (gate.should_pin() || inside_window) {
            // Do not swap the card: build the suggestion but mark it to enqueue
            // on the overlay side (SuggestionQueue, máx 5, FIFO).
            enqueue_suggestion(std::move(trigger), src, reason, std::move(keyword), now);
            return false;
        }
        // start_request() records last_card_ms via now_ms() when it publishes.
        start_suggestion(std::move(trigger), src, reason, std::move(keyword));
        return true;
    }

    void enqueue_suggestion(std::string trigger, AudioSource src, TriggerReason reason,
                            std::string keyword, std::int64_t now) {
        SuggestionStartedEvent ev;
        ev.id = ++next_id;
        ev.trigger_text = std::move(trigger);
        ev.trigger_source = src;
        ev.reason = reason;
        ev.keyword = std::move(keyword);
        ev.model = cfg.model;
        ev.enqueue = true;
        ev.t_ms = now;
        pending.push_back(std::move(ev));
        while (pending.size() > kMaxPending) pending.pop_front(); // FIFO cap (Req 9.5)
        publish(pending.back());
    }

    // Req 9.6: when the 4000 ms window expires and the user is not speaking,
    // release the oldest pending suggestion so it replaces the current card.
    void maybe_release_pending(std::int64_t now) {
        if (transcription_only_.load() || pending.empty() || !llm) return;
        if (gate.should_pin()) return;
        const std::int64_t window = cfg.decision.cooldown_ms;
        if (last_card_ms >= 0 && window > 0 && (now - last_card_ms) < window) return;
        SuggestionStartedEvent next = std::move(pending.front());
        pending.pop_front();
        // start_request() records last_card_ms and opens a fresh 4000 ms window.
        start_suggestion(next.trigger_text, next.trigger_source, next.reason, next.keyword);
    }

    void cancel_active() {
        if (!active) return;
        active->ctx->cancelled.store(true);
        if (active->call) active->call->cancel();
        active.reset();
    }

    std::unordered_map<std::uint64_t, std::uint64_t> promoted_map_;

    static std::string grounding_of(const std::vector<ChatMessage>& messages) {
        std::string g;
        for (const auto& m : messages) {
            g += m.content;
            g.push_back('\n');
        }
        return g;
    }

    // Req 2.1: Idle -> Speculating. Bumps the generation gate, starts the LLM
    // generation hidden, arms the commit fallback deadline and tells the
    // overlay to show "Generating answer...". Every token and the completion
    // are routed back through the inbox (on_shadow_delta / InShadowDone) gated
    // by the captured generation (Req 2.5): the shadow is only ever touched on
    // the orchestrator thread, and a later abort (gen++) silently discards any
    // in-flight deltas.
    // `trigger`: the question to answer when it is more than c.text (the
    // fragments joined by the question gate); empty = c.text with its subject.
    void enter_speculating(const SpeculativeCandidate& c, TriggerReason reason, std::string trigger = {}) {
        if (!llm) return;
        const std::uint64_t gen = ++generation_id_;

        std::string enriched = std::move(trigger);
        if (enriched.empty()) {
            auto prev_lb = collect_loopback_context(convo.all(), convo.size(), c.t_ms);
            const std::int64_t gap = prev_lb ? (c.t_ms - prev_lb->end_ms) : -1;
            enriched = enrich_trigger_with_subject(prev_lb, c.text, gap);
        }
        const std::string keyword = policy.probe_keyword(c.text);

        auto messages = build_copilot_messages(cfg.prompt, render_history_with_answers(),
                                               enriched, reason, keyword, may_skip(reason));
        const std::uint64_t sid = ++next_id;
        meta[sid] = Meta{enriched, reason, c.source, {}, grounding_of(messages), -1};

        auto ctx = std::make_shared<CallCtx>();
        ctx->id = sid;
        std::weak_ptr<Impl> weak = shared_from_this();

        Shadow sh;
        sh.state = ShadowState::Speculating;
        sh.id = gen;
        sh.speculative_text = enriched;
        sh.source = c.source;
        sh.reason = reason;
        sh.keyword = keyword;
        sh.ctx = ctx;
        sh.started_ms = c.t_ms;
        sh.commit_deadline_ms = now_ms() + kCommitTimeoutMs; // commit fallback (Req 3.1)

        LlmRequest req{cfg.model, std::move(messages), effective_max_tokens(), cfg.temperature,
                       effective_reasoning()};
        LlmCallbacks cb;
        cb.on_delta = [weak, ctx, gen](std::string_view d) {
            if (ctx->cancelled.load()) return;
            ctx->text.append(d);
            if (auto self = weak.lock()) self->post(InShadowDelta{gen, std::string(d)});
        };
        cb.on_done = [weak, ctx, gen](const LlmResult& r) {
            LlmResult res = r;
            if (ctx->cancelled.load() && res.status == LlmStatus::Completed) res.status = LlmStatus::Cancelled;
            if (auto self = weak.lock()) self->post(InShadowDone{gen, res, ctx->text});
        };
        try {
            sh.call = llm->start(std::move(req), std::move(cb));
        } catch (...) {
            meta.erase(sid);
            return;
        }
        // Overlay shows "Generating answer..." while the buffer fills hidden.
        publish(SpeculativeCandidateEvent{c.source, c.text, c.t_ms});
        shadow = std::move(sh);
    }

    int effective_max_tokens() const { return std::max(cfg.max_tokens, 1500); }
    std::string effective_reasoning() const {
        return (cfg.reasoning_effort.empty() || cfg.reasoning_effort == "minimal") ? "none" : cfg.reasoning_effort;
    }

    // Req 2.4/2.5/2.6: a delta from a stale generation is dropped; during
    // Speculating it accrues hidden in shadow_buffer_; after Committed it is
    // appended to the visible answer.
    void on_shadow_delta(std::uint64_t gen, std::string_view d) {
        if (transcription_only_.load() || !shadow || gen != generation_id_ || shadow->id != gen) return; // discard (Req 2.5)
        if (shadow->state == ShadowState::Speculating) {
            shadow->shadow_buffer_.append(d);                      // hidden (Req 2.1/2.4)
        } else if (shadow->state == ShadowState::Committed) {
            if (!shadow->revealed) {
                // Committed automatic answer still waiting for its first words.
                shadow->shadow_buffer_.append(d);
                const SkipVerdict v = skip_verdict(shadow->shadow_buffer_);
                if (v == SkipVerdict::Skip) {
                    const std::uint64_t sid = shadow->id;
                    abort_shadow();
                    publish(SpeculativeMissEvent{sid, now_ms()});
                } else if (v == SkipVerdict::Answer) {
                    reveal_shadow();
                }
                return;
            }
            if (shadow->first_visible_ms < 0) shadow->first_visible_ms = now_ms();
            publish(SuggestionDeltaEvent{shadow->active_id, std::string(d)}); // visible append (Req 2.6)
        }
    }

    // Req 3.1-3.3: early commit on {Deepgram speech_final, local silence,
    // fallback deadline}. The answer is only shown early when the live text is
    // clearly a finished question (ends with '?') and is still the question
    // the speculation was built on; if the speaker went on with a new question
    // part, the speculation restarts (hidden) on the longer text; otherwise the
    // closed turn (on_turn) commits it a few hundred ms later. This keeps the
    // early commit from showing an answer to half a question.
    void maybe_commit(CommitCause cause, std::int64_t now) {
        if (!shadow || shadow->state != ShadowState::Speculating) return;
        const AudioSource src = shadow->source;
        const std::string live_raw = text::trim(turns.live_text(src));
        if (live_raw.empty()) return; // lane just closed: on_turn decides with the final text
        const Utterance u = live_utterance(live_raw, src, now);
        const std::string& live = u.trigger;
        if (!speculative_match(shadow->speculative_text, live)) {
            const std::uint64_t sid = shadow->id;
            abort_shadow();
            publish(SpeculativeMissEvent{sid, now_ms()});
            return;
        }
        if (extension_adds_question(shadow->speculative_text, live)) {
            const TriggerReason reason = shadow->reason;
            abort_shadow();
            // Speculate again on the longer text, if it is still a question.
            if (!cfg.question_gate || reason != TriggerReason::Question ||
                assess_question(u.assess, convo.size() >= 1, false).verdict == QuestionVerdict::Ready) {
                enter_speculating(SpeculativeCandidate{src, live_raw, now}, reason, live);
            }
            return;
        }
        if (!ends_as_question(live) && !ends_as_question(shadow->speculative_text)) {
            if (cause == CommitCause::Timeout) shadow->commit_deadline_ms = -1; // wait for close
            return;
        }
        if (cfg.question_gate) {
            // Only a finished question ('?') is shown before the turn closes.
            const QuestionAssessment qa = assess_question(u.assess, convo.size() >= 1, false);
            if (qa.verdict != QuestionVerdict::Ready || !qa.explicit_question) {
                if (cause == CommitCause::Timeout) shadow->commit_deadline_ms = -1;
                return;
            }
        }
        if (norm_words(live).size() > norm_words(shadow->speculative_text).size()) {
            shadow->speculative_text = live; // the card shows the fuller question
        }
        commit_shadow(cause);
    }

    // Req 2.2/2.6: Speculating -> Committed. Promotes the hidden shadow_buffer_
    // to the UI as the first visible content in <=16 ms: opens a visible card
    // (SuggestionStartedEvent), publishes SpeculativeHitEvent, flushes the
    // buffer as the first SuggestionDeltaEvent, and rewires the in-flight
    // call's bookkeeping so subsequent deltas of the SAME generation flow
    // through on_shadow_delta (state Committed) and the final
    // SuggestionDoneEvent still fires. If the hidden generation already
    // finished, the card is completed right away.
    void commit_shadow(CommitCause cause) {
        (void)cause; // carried for observability
        if (!shadow || shadow->state != ShadowState::Speculating) return;
        // An automatic answer that is "[SKIP]": the model saw no question.
        const bool hold = may_skip(shadow->reason);
        if (hold) {
            const SkipVerdict v = skip_verdict(shadow->finished ? shadow->final_text : shadow->shadow_buffer_);
            if (v == SkipVerdict::Skip || (shadow->finished && v != SkipVerdict::Answer)) {
                const std::uint64_t sid = shadow->id;
                abort_shadow();
                publish(SpeculativeMissEvent{sid, now_ms()});
                return;
            }
        }
        shadow->state = ShadowState::Committed;

        // Any previously visible active card is superseded by the committed
        // speculation.
        cancel_active();

        const std::uint64_t pid = ++next_id;
        const std::uint64_t spec_id = shadow->ctx ? shadow->ctx->id : 0;
        Meta m{shadow->speculative_text, shadow->reason, shadow->source, {}, {}, -1};
        if (auto it = meta.find(spec_id); it != meta.end()) { m = it->second; meta.erase(it); }
        m.trigger = shadow->speculative_text;
        m.shown = false;
        meta[pid] = std::move(m);
        if (spec_id != 0) promoted_map_[spec_id] = pid;

        shadow->active_id = pid; // subsequent deltas publish under this id (Req 2.6)
        if (shadow->ctx) shadow->ctx->id = pid;
        active = Active{pid, shadow->call, shadow->ctx};

        // An automatic answer shows once its first words prove it is one
        // (on_shadow_delta / InShadowDone decide when they are not in yet).
        shadow->revealed = false;
        if (hold && skip_verdict(shadow->finished ? shadow->final_text : shadow->shadow_buffer_) !=
                        SkipVerdict::Answer) {
            return;
        }
        reveal_shadow();

        if (shadow && shadow->finished) {
            // Generation completed while hidden: the buffer is the whole
            // answer. Close the card now (resets shadow and active).
            InLlmDone done{pid, shadow->final_res, shadow->final_text, shadow->first_visible_ms};
            handle(done);
        }
    }

    // Req 2.3/3.4: Speculating/Committed -> Aborted. Bumps the generation gate
    // (invalidating any in-flight tokens via on_shadow_delta), discards the
    // hidden buffer, cancels the remote call over HTTP/2 (RST_STREAM) and drops
    // the shadow WITHOUT touching the visible card (no flicker).
    void abort_shadow() {
        if (!shadow) return;
        ++generation_id_;                         // invalidate in-flight tokens (Req 2.3/2.5)
        const std::uint64_t spec_id = shadow->ctx ? shadow->ctx->id : 0;
        const bool was_committed = shadow->state == ShadowState::Committed;
        shadow->state = ShadowState::Aborted;
        shadow->shadow_buffer_.clear();           // discard hidden buffer (Req 2.3)
        if (shadow->ctx) shadow->ctx->cancelled.store(true);
        if (shadow->call) shadow->call->cancel(); // RST_STREAM (Req 2.3/4.6)
        if (spec_id != 0 && !was_committed) meta.erase(spec_id);
        if (was_committed && active && active->id == shadow->active_id) {
            // The committed card is being replaced: forget its bookkeeping.
            meta.erase(shadow->active_id);
            active.reset();
        }
        shadow.reset();                           // visible card untouched (no flicker)
    }

    // Stable interim on the trigger lane (TurnAssembler::poll_speculative):
    // the same generation-gated speculation as the acoustic VAD path.
    void on_speculative(const SpeculativeCandidate& c) {
        if (transcription_only_.load() || !cfg.allow_speculative || !llm) return;
        if (c.source != cfg.decision.trigger_source) return;
        if (shadow) return;
        if (cfg.question_gate) {
            // The question gate decides what is a question (with the
            // fragments the interviewer said right before this one).
            const Utterance u = live_utterance(c.text, c.source, c.t_ms);
            const QuestionAssessment qa = assess_question(u.assess, convo.size() >= 1, false);
            const TriggerReason r = policy.would_trigger(u.assess, c.t_ms, qa.verdict == QuestionVerdict::Ready);
            if (r == TriggerReason::None) return;
            enter_speculating(c, r, u.trigger);
            return;
        }
        const TriggerReason r = policy.would_trigger(c.text, c.t_ms);
        if (r == TriggerReason::None) return;
        enter_speculating(c, r);
    }

    void start_suggestion(std::string trigger, AudioSource src, TriggerReason reason,
                          std::string keyword) {
        if (!llm) return;
        std::string research;
        // Web search is blocking: only an explicit manual request may pay for
        // it, never the automatic hot path.
        const std::string folded_trigger = text::fold(trigger);
        const bool asks_for_current_info =
            folded_trigger.find("atual") != std::string::npos ||
            folded_trigger.find("recent") != std::string::npos ||
            folded_trigger.find("hoje") != std::string::npos ||
            folded_trigger.find("latest") != std::string::npos ||
            folded_trigger.find("current") != std::string::npos;
        if (cfg.web_search && asks_for_current_info && reason == TriggerReason::Manual)
            research = cfg.web_search(trigger);
        auto messages = build_copilot_messages(cfg.prompt, render_history_with_answers(),
                                               trigger, reason, keyword, may_skip(reason));
        if (!research.empty()) {
            messages.back().content += "\n\nPesquisa recente na internet:\n" + research +
                                       "\nUse somente como contexto auxiliar.";
        }
        start_request(std::move(trigger), src, reason, std::move(keyword), std::move(messages), false, {});
    }

    void start_request(std::string trigger, AudioSource src, TriggerReason reason, std::string keyword,
                       std::vector<ChatMessage> messages, bool has_image, std::string question) {
        if (!llm) return;
        cancel_active();

        const std::uint64_t id = ++next_id;
        meta[id] = Meta{trigger, reason, src, std::move(question), grounding_of(messages), -1};

        SuggestionStartedEvent started_ev;
        started_ev.id = id;
        started_ev.trigger_text = trigger;
        started_ev.trigger_source = src;
        started_ev.reason = reason;
        started_ev.keyword = keyword;
        started_ev.model = cfg.model;
        started_ev.has_image = has_image;
        started_ev.t_ms = now_ms();
        // An automatic answer shows its card only once its first words prove
        // it is an answer ("[SKIP]" never reaches the screen).
        const bool hold = may_skip(reason);
        if (hold) {
            meta[id].shown = false;
            meta[id].pending_start = started_ev;
        } else {
            last_card_ms = started_ev.t_ms;
            meta[id].shown_ms = started_ev.t_ms;
            publish(started_ev);
        }

        LlmRequest req;
        req.model = cfg.model;
        req.max_tokens = effective_max_tokens();
        req.temperature = cfg.temperature;
        req.reasoning_effort = effective_reasoning();
        req.messages = std::move(messages);

        auto ctx = std::make_shared<CallCtx>();
        ctx->id = id;
        ctx->holding = hold;
        std::weak_ptr<Impl> weak = shared_from_this();

        LlmCallbacks cb;
        cb.on_delta = [weak, ctx](std::string_view d) {
            if (ctx->cancelled.load()) return;
            auto self = weak.lock();
            {
                std::lock_guard<std::mutex> lk(ctx->hold_mu);
                ctx->text.append(d);
                if (ctx->holding) {
                    // Hidden until the first words decide: answer or "[SKIP]".
                    if (!ctx->decision_posted) {
                        const SkipVerdict v = skip_verdict(ctx->text);
                        if (v != SkipVerdict::Undecided) {
                            ctx->decision_posted = true;
                            if (self) self->post(InHoldDecided{ctx->id, v == SkipVerdict::Skip});
                        }
                    }
                    return;
                }
            }
            if (self && !self->transcription_only_.load()) {
                if (ctx->first_visible_ms.load() < 0) ctx->first_visible_ms.store(self->now_ms());
                self->publish(SuggestionDeltaEvent{ctx->id, std::string(d)});
            }
        };
        cb.on_done = [weak, ctx](const LlmResult& r) {
            LlmResult res = r;
            if (ctx->cancelled.load() && res.status == LlmStatus::Completed) {
                res.status = LlmStatus::Cancelled;
            }
            if (auto self = weak.lock()) {
                self->post(InLlmDone{ctx->id, res, ctx->text, ctx->first_visible_ms.load()});
            }
        };

        std::shared_ptr<ILlmCall> call;
        try {
            call = llm->start(std::move(req), std::move(cb));
        } catch (const std::exception& ex) {
            LlmResult res;
            res.status = LlmStatus::Failed;
            res.error = ex.what();
            post(InLlmDone{id, res, {}, -1});
            return;
        }
        active = Active{id, std::move(call), std::move(ctx)};
    }
};

// ---------------------------------------------------------------------------

CopilotEngine::CopilotEngine(CopilotConfig cfg, std::shared_ptr<ILlmClient> llm)
    : impl_(std::make_shared<Impl>(std::move(cfg), std::move(llm), nullptr)) {}

CopilotEngine::CopilotEngine(CopilotConfig cfg, std::shared_ptr<ILlmClient> llm,
                             std::shared_ptr<IAnalyticsClient> analytics)
    : impl_(std::make_shared<Impl>(std::move(cfg), std::move(llm), std::move(analytics))) {}

CopilotEngine::~CopilotEngine() { stop(); }

void CopilotEngine::add_sink(Sink sink) {
    std::lock_guard<std::mutex> lk(impl_->mu);
    if (impl_->started) return; // sinks are immutable once running
    impl_->sinks.push_back(std::move(sink));
}

void CopilotEngine::start() {
    {
        std::lock_guard<std::mutex> lk(impl_->mu);
        if (impl_->started || impl_->stop_requested) return;
        impl_->started = true;
    }
    Impl* self = impl_.get();
    impl_->thread = std::thread([self] { self->run(); });
}

void CopilotEngine::stop() {
    std::call_once(impl_->stop_once, [this] {
        {
            std::lock_guard<std::mutex> lk(impl_->mu);
            impl_->stop_requested = true;
        }
        impl_->cv.notify_all();
        if (impl_->thread.joinable()) impl_->thread.join();
        impl_->cancel_active(); // orchestrator is gone; safe to touch its state
        std::unique_lock<std::shared_mutex> lk(impl_->publish_mu);
        impl_->accepting = false;
    });
}

void CopilotEngine::on_transcript(const TranscriptEvent& ev) {
    impl_->post(InTranscript{ev, impl_->now_ms()});
}

void CopilotEngine::on_link_status(const TransportStatus& st) {
    impl_->post(InStatus{st, impl_->now_ms()});
}

void CopilotEngine::on_mic_rms(float rms, float threshold) {
    impl_->post(InMicRms{rms, threshold, impl_->now_ms()});
}

void CopilotEngine::set_ptt(bool down) { impl_->post(InPtt{down, impl_->now_ms()}); }

// Local acoustic VAD entry points (Req 1.5/1.6/3.1-3.3). Each posts the
// matching Input onto the inbox and returns immediately (enqueue + notify), so
// the WASAPI capture thread that calls these is never blocked. A negative t_ms
// means "stamp with the engine clock", like the other non-blocking inputs.
void CopilotEngine::on_vad_speculate(AudioSource source, float rms, std::int64_t t_ms) {
    impl_->post(InVadSpeculate{source, rms, t_ms < 0 ? impl_->now_ms() : t_ms});
}

void CopilotEngine::on_vad_commit_silence(AudioSource source, std::int64_t t_ms) {
    impl_->post(InVadCommitSilence{source, t_ms < 0 ? impl_->now_ms() : t_ms});
}

void CopilotEngine::on_speech_final(AudioSource source, std::int64_t t_ms) {
    impl_->post(InSpeechFinal{source, t_ms < 0 ? impl_->now_ms() : t_ms});
}

void CopilotEngine::request_suggestion() { impl_->post(InManual{impl_->now_ms()}); }

void CopilotEngine::finalize_session() { impl_->post(InFinalize{impl_->now_ms()}); }

void CopilotEngine::set_paused(bool paused, int source) {
    impl_->post(InPause{paused, source, impl_->now_ms()});
}

void CopilotEngine::request_action(TriggerReason reason, std::string text, std::string image_url) {
    impl_->post(InAction{reason, std::move(text), std::move(image_url), impl_->now_ms()});
}

void CopilotEngine::rate_suggestion(std::uint64_t id, int vote) {
    impl_->post(InFeedback{id, vote, impl_->now_ms()});
}

void CopilotEngine::clear_chat() { impl_->post(InClearChat{}); }

void CopilotEngine::notify(NoticeLevel level, std::string text) {
    impl_->post(InNotice{level, std::move(text), impl_->now_ms()});
}

void CopilotEngine::set_auto_answer(bool enabled) { impl_->post(InAutoToggle{enabled, impl_->now_ms()}); }

bool CopilotEngine::auto_answer() const noexcept { return impl_->auto_answer; }

void CopilotEngine::set_transcription_only(bool on) {
    bool expected = !on;
    if (!impl_->transcription_only_.compare_exchange_strong(expected, on)) {
        return;
    }
    impl_->post(InModeToggle{on, impl_->now_ms()});
}

bool CopilotEngine::transcription_only() const noexcept { return impl_->transcription_only_.load(); }

SessionTranscript CopilotEngine::session_transcript() const {
    std::lock_guard<std::mutex> lk(impl_->transcript_mu_);
    return impl_->transcript_;
}

bool CopilotEngine::llm_enabled() const noexcept { return impl_->llm != nullptr; }

std::int64_t CopilotEngine::now_ms() const { return impl_->now_ms(); }

const CopilotConfig& CopilotEngine::config() const noexcept { return impl_->cfg; }

} // namespace rtai
