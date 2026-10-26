// Task 10.3 (automatable subset) — Finalize -> dashboard timing with a mocked
// Cold_Path network, driven entirely at the pure-core level.
//
// WHAT THIS FILE COVERS
// ------------------------------------------------------------------
// Task 10.3 asks to measure, with the network mocked, that the Finalize action
// reaches a rendered post-interview dashboard within ~300 ms, and to confirm
// the window styles (WS_EX_* / SetWindowDisplayAffinity) are untouched on the
// mode switch (Req 9.5, 9.6).
//
// The end-to-end ~300 ms VISUAL timing (live Direct2D renderer painting the
// Score_Rings + Instant_Feedback) and the real window-style preservation need
// the running app and are documented in tests/overlay_tests/MANUAL_CHECKLIST.md
// (M8). The automatable core of Req 9.5 is the ENGINE path: from the moment
// finalize_session() is called to the moment the engine publishes
// OverlayModeEvent{PostInterviewReport} to its sink — i.e. the point at which
// the overlay would switch modes and render the dashboard. The overlay only
// renders when that event arrives, so if the engine produces it well within
// ~300 ms against a fast (mocked) Cold_Path client, the remaining budget is the
// renderer's, verified by hand.
//
// A FAKE IAnalyticsClient resolves on_done(true, canned JevReport) almost
// immediately on a worker thread (mirroring the real two-parallel-calls client
// that returns on a Cold_Path worker). This isolates the engine path: it
// asserts the orchestrator adds NO artificial delay between the Finalize input
// and the published mode switch. The fake is the network mock the task calls
// for; the engine routes the worker-thread callback back onto its inbox before
// publishing, so the whole hop is exercised.
//
// Req 9.6 (styles unchanged on mode switch) is asserted at the Win32 level in
// tests/overlay_tests/test_overlay_win32.cpp (StylesUnchangedOnModeSwitch),
// which captures GetWindowLong(GWL_EXSTYLE) + GetWindowDisplayAffinity before
// and after a PostInterviewReport switch; see that file and the checklist.

#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <functional>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

#include "fake_websocket.hpp" // eventually()
#include "rtai/analytics_client.hpp"
#include "rtai/copilot_engine.hpp"
#include "rtai/overlay_mode.hpp"
#include "rtai/scripted_llm.hpp"
#include "rtai/session_transcript.hpp"

using namespace rtai;
using namespace std::chrono_literals;
using rtai::testing::eventually;

namespace {

// A test double for the Cold_Path IAnalyticsClient. It mirrors the real
// JevAnalyticsClient contract: finalize() returns immediately and the
// all-or-nothing callback fires on a SEPARATE worker thread (never the
// orchestrator thread), with ok == true and a fully-populated JevReport — the
// double-success join. An optional small delay models the mocked network
// round-trip without the real WinHTTP/HTTP-2 stack.
class FakeAnalyticsClient final : public IAnalyticsClient {
public:
    struct Options {
        bool ok{true};                           // double-success when true
        std::chrono::milliseconds delay{0ms};     // mocked network latency
        JevReport report{canned_report()};        // what on_done delivers
    };

    FakeAnalyticsClient() : FakeAnalyticsClient(Options{}) {}
    explicit FakeAnalyticsClient(Options opts) : opts_(std::move(opts)) {}
    ~FakeAnalyticsClient() override {
        for (auto& t : threads_) if (t.joinable()) t.join();
    }

    void finalize(const SessionTranscript& transcript,
                  std::function<void(bool ok, JevReport report)> on_done) override {
        (void)transcript; // the engine owns it; the mock does not touch the net
        ++calls_;
        auto opts = opts_;
        std::lock_guard<std::mutex> lk(mu_);
        // Resolve on a worker thread, exactly like the real client's join.
        threads_.emplace_back([opts, on_done = std::move(on_done)] {
            if (opts.delay.count() > 0) std::this_thread::sleep_for(opts.delay);
            if (on_done) on_done(opts.ok, opts.report);
        });
    }

    int calls() const { return calls_.load(); }

    // A representative Cold_Path result: three in-range scores and exactly
    // three Instant_Feedback lines (Req 9.4).
    static JevReport canned_report() {
        JevReport r;
        r.scores = JevScores{8.5, 7.0, 9.25};
        r.feedback_lines = {"Boa estrutura na resposta.",
                            "Traga uma métrica concreta.",
                            "Conclua com o impacto no negócio."};
        return r;
    }

private:
    Options opts_;
    std::atomic<int> calls_{0};
    std::mutex mu_;
    std::vector<std::thread> threads_;
};

struct Collector {
    std::mutex mu;
    std::vector<EngineEvent> events;
    void operator()(const EngineEvent& e) {
        std::lock_guard<std::mutex> lk(mu);
        events.push_back(e);
    }
    template <class T>
    std::vector<T> all() {
        std::lock_guard<std::mutex> lk(mu);
        std::vector<T> out;
        for (const auto& e : events) {
            if (const T* p = std::get_if<T>(&e)) out.push_back(*p);
        }
        return out;
    }
};

CopilotConfig fast_engine_config() {
    CopilotConfig cfg;
    cfg.tick = 10ms;
    cfg.decision.cooldown_ms = 0;
    cfg.turns.boundary_grace_ms = 50;
    return cfg;
}

std::shared_ptr<ScriptedLlmClient> fast_llm() {
    ScriptedLlmClient::Options o;
    o.reply = "- Resposta curta\nInsight: teste";
    o.first_token_delay = 5ms;
    o.token_delay = 1ms;
    return std::make_shared<ScriptedLlmClient>(o);
}

TranscriptEvent final_ev(AudioSource s, std::string text, bool from_finalize = false) {
    TranscriptEvent e{s, std::move(text), true, 0};
    e.from_finalize = from_finalize;
    return e;
}

// Feeds one closed interviewer turn so the engine's SessionTranscript is
// non-empty — finalize_session() is a no-op on an empty transcript.
void seed_one_turn(CopilotEngine& engine, Collector& col) {
    engine.on_transcript(final_ev(AudioSource::Loopback, "Me fale sobre um desafio técnico recente", true));
    ASSERT_TRUE(eventually([&] { return !col.all<TurnEvent>().empty(); }));
}

} // namespace

// Req 9.5 (engine path): with the Cold_Path network mocked, the time from
// finalize_session() to the published OverlayModeEvent{PostInterviewReport} —
// the trigger that makes the overlay switch modes and render the dashboard — is
// well within the ~300 ms budget. The mock resolves fast, so what this asserts
// is that the ENGINE adds no artificial delay on the Finalize path: the
// worker-thread callback is routed back onto the inbox and published promptly.
TEST(FinalizeTiming, FinalizePublishesModeSwitchWellWithinBudget) {
    auto llm = fast_llm();
    auto analytics = std::make_shared<FakeAnalyticsClient>();
    CopilotEngine engine{fast_engine_config(), llm, analytics};
    auto col = std::make_shared<Collector>();
    engine.add_sink([col](const EngineEvent& e) { (*col)(e); });
    engine.start();

    seed_one_turn(engine, *col);

    const auto t0 = std::chrono::steady_clock::now();
    engine.finalize_session();
    ASSERT_TRUE(eventually([&] { return !col->all<OverlayModeEvent>().empty(); }, 2000ms));
    const auto t1 = std::chrono::steady_clock::now();
    engine.stop();

    const auto elapsed_ms =
        std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();

    auto modes = col->all<OverlayModeEvent>();
    ASSERT_EQ(modes.size(), 1u);
    EXPECT_EQ(modes[0].mode, OverlayMode::PostInterviewReport)
        << "double-success must switch the overlay to the dashboard";
    // The report carried by the event is the full canned result (never partial).
    EXPECT_DOUBLE_EQ(modes[0].report.scores.relevance, 8.5);
    EXPECT_DOUBLE_EQ(modes[0].report.scores.accuracy, 7.0);
    EXPECT_DOUBLE_EQ(modes[0].report.scores.clarity, 9.25);
    EXPECT_EQ(modes[0].report.feedback_lines[0], "Boa estrutura na resposta.");

    // Engine path budget. The ~300 ms target in task 10.3 is the end-to-end
    // VISUAL budget (engine + live renderer). The engine's own share must be a
    // small fraction of it; 150 ms is a generous ceiling that still catches any
    // accidental sleep-based delay on the Finalize path while tolerating CI
    // scheduling jitter (the eventually() poll granularity alone is ~2 ms).
    EXPECT_LT(elapsed_ms, 150)
        << "Req 9.5: Finalize -> mode switch took " << elapsed_ms
        << " ms; the engine path must leave ample room inside the ~300 ms budget";
    EXPECT_EQ(analytics->calls(), 1);
}

// Even with the mocked network adding a visible round-trip, the published mode
// switch tracks that latency closely — the engine does not pile extra delay on
// top of the client's own time. Models a realistic mocked Cold_Path latency
// (120 ms) and asserts the total stays comfortably under the ~300 ms budget.
TEST(FinalizeTiming, MockedNetworkLatencyStaysUnderBudget) {
    FakeAnalyticsClient::Options ao;
    ao.ok = true;
    ao.delay = 120ms; // mocked network round-trip
    auto llm = fast_llm();
    auto analytics = std::make_shared<FakeAnalyticsClient>(ao);
    CopilotEngine engine{fast_engine_config(), llm, analytics};
    auto col = std::make_shared<Collector>();
    engine.add_sink([col](const EngineEvent& e) { (*col)(e); });
    engine.start();

    seed_one_turn(engine, *col);

    const auto t0 = std::chrono::steady_clock::now();
    engine.finalize_session();
    ASSERT_TRUE(eventually([&] { return !col->all<OverlayModeEvent>().empty(); }, 2000ms));
    const auto t1 = std::chrono::steady_clock::now();
    engine.stop();

    const auto elapsed_ms =
        std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();

    ASSERT_EQ(col->all<OverlayModeEvent>().size(), 1u);
    // The engine overhead on top of the mocked 120 ms latency must be small, so
    // the whole Finalize->switch stays well under the ~300 ms end-to-end target.
    EXPECT_LT(elapsed_ms, 300)
        << "Req 9.5: Finalize -> mode switch took " << elapsed_ms
        << " ms with a 120 ms mocked network; exceeds the ~300 ms budget";
    EXPECT_GE(elapsed_ms, 100)
        << "sanity: the published switch cannot precede the mocked latency";
}

// Req 7.5 / 8.4 timing corollary: a failed (or timed-out) Cold_Path join must
// NOT publish a mode switch — the overlay stays LiveCopilot and nothing renders
// a partial dashboard. There is no "dashboard within 300 ms" to measure on
// failure; the invariant is that no OverlayModeEvent is produced at all.
TEST(FinalizeTiming, FailedJoinNeverPublishesModeSwitch) {
    FakeAnalyticsClient::Options ao;
    ao.ok = false; // a failing/timed-out join
    auto llm = fast_llm();
    auto analytics = std::make_shared<FakeAnalyticsClient>(ao);
    CopilotEngine engine{fast_engine_config(), llm, analytics};
    auto col = std::make_shared<Collector>();
    engine.add_sink([col](const EngineEvent& e) { (*col)(e); });
    engine.start();

    seed_one_turn(engine, *col);
    engine.finalize_session();

    // Give the engine ample time to (not) publish a switch: well past any
    // plausible ~300 ms budget.
    std::this_thread::sleep_for(400ms);
    engine.stop();

    EXPECT_TRUE(col->all<OverlayModeEvent>().empty())
        << "Req 8.4: a failed Cold_Path join must never switch modes";
    EXPECT_EQ(analytics->calls(), 1);
}

// Guard on the no-op paths so the timing tests above rest on the documented
// contract: finalize_session() does nothing (no mode switch, no client call)
// without an analytics client or on an empty transcript.
TEST(FinalizeTiming, NoAnalyticsClientOrEmptyTranscriptIsNoOp) {
    // (a) No analytics client injected.
    {
        auto llm = fast_llm();
        CopilotEngine engine{fast_engine_config(), llm}; // 2-arg ctor, no analytics
        auto col = std::make_shared<Collector>();
        engine.add_sink([col](const EngineEvent& e) { (*col)(e); });
        engine.start();
        seed_one_turn(engine, *col);
        engine.finalize_session();
        std::this_thread::sleep_for(100ms);
        engine.stop();
        EXPECT_TRUE(col->all<OverlayModeEvent>().empty());
    }
    // (b) Analytics client present but the transcript is empty (no turns fed).
    {
        auto llm = fast_llm();
        auto analytics = std::make_shared<FakeAnalyticsClient>();
        CopilotEngine engine{fast_engine_config(), llm, analytics};
        auto col = std::make_shared<Collector>();
        engine.add_sink([col](const EngineEvent& e) { (*col)(e); });
        engine.start();
        engine.finalize_session(); // transcript empty -> no-op
        std::this_thread::sleep_for(100ms);
        engine.stop();
        EXPECT_TRUE(col->all<OverlayModeEvent>().empty());
        EXPECT_EQ(analytics->calls(), 0);
    }
}
