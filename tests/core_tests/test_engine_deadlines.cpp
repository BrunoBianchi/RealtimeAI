// Deadline-driven orchestrator: timer steps (turn close, speculation, commit
// fallback) run at their exact deadline instead of the next periodic tick.
#include <gtest/gtest.h>

#include <chrono>
#include <memory>
#include <mutex>
#include <vector>

#include "fake_websocket.hpp" // eventually()
#include "rtai/copilot_engine.hpp"
#include "rtai/turn_assembler.hpp"

using namespace rtai;
using namespace std::chrono_literals;
using rtai::testing::eventually;

namespace {

TranscriptEvent final_ev(AudioSource s, std::string text) { return TranscriptEvent{s, std::move(text), true, 0}; }
TranscriptEvent interim_ev(AudioSource s, std::string text) { return TranscriptEvent{s, std::move(text), false, 0}; }
TranscriptEvent turn_end(AudioSource s) {
    TranscriptEvent e{};
    e.source = s;
    e.kind = TranscriptKind::LocalTurnEnd;
    return e;
}

} // namespace

// ---------------------------------------------------------------- TurnAssembler

TEST(TurnDeadline, NothingPendingWhenIdle) {
    TurnAssembler ta;
    EXPECT_EQ(ta.next_deadline_ms(), -1);
}

TEST(TurnDeadline, BoundaryGraceIsTheDeadline) {
    TurnAssemblerConfig cfg;
    cfg.boundary_grace_ms = 450;
    TurnAssembler ta{cfg};
    ta.on_event(final_ev(AudioSource::Loopback, "Tudo certo com o contrato"), 0);
    ta.on_event(turn_end(AudioSource::Loopback), 100);
    EXPECT_EQ(ta.next_deadline_ms(), 550);
    EXPECT_TRUE(ta.tick(549).empty());
    EXPECT_EQ(ta.tick(550).size(), 1u); // closes exactly at the deadline
    EXPECT_EQ(ta.next_deadline_ms(), -1);
}

TEST(TurnDeadline, StableInterimAndStaleFinal) {
    TurnAssemblerConfig cfg;
    cfg.speculative_pause_ms = 160;
    cfg.stale_ms = 1400;
    TurnAssembler ta{cfg};
    ta.on_event(interim_ev(AudioSource::Loopback, "qual foi o maior desafio"), 1000);
    EXPECT_EQ(ta.next_deadline_ms(), 1160); // speculation on a stable interim
    ta.on_event(final_ev(AudioSource::Loopback, "Qual foi o maior desafio?"), 1200);
    EXPECT_EQ(ta.next_deadline_ms(), 2600); // stale close of an unclosed final
}

TEST(TurnDeadline, SkipsDeadlinesAlreadyChecked) {
    TurnAssemblerConfig cfg;
    cfg.boundary_grace_ms = 300;
    TurnAssembler ta{cfg};
    ta.on_event(final_ev(AudioSource::Loopback, "Primeira parte"), 0);
    ta.on_event(turn_end(AudioSource::Loopback), 0);
    ta.on_event(interim_ev(AudioSource::Microphone, "uma fala do candidato aqui"), 100);
    EXPECT_EQ(ta.next_deadline_ms(), 260);    // mic speculation (100 + 160)
    EXPECT_EQ(ta.next_deadline_ms(260), 300); // then the loopback grace
    EXPECT_EQ(ta.next_deadline_ms(300), -1);
}

// ---------------------------------------------------------------- engine

namespace {

struct TurnClock {
    std::mutex mu;
    std::vector<Turn> turns;
    void operator()(const EngineEvent& e) {
        if (const auto* t = std::get_if<TurnEvent>(&e)) {
            std::lock_guard<std::mutex> lk(mu);
            turns.push_back(t->turn);
        }
    }
    std::size_t count() {
        std::lock_guard<std::mutex> lk(mu);
        return turns.size();
    }
};

} // namespace

TEST(EngineDeadline, TurnClosesAtGraceNotAtNextTick) {
    CopilotConfig cfg;
    cfg.tick = 2000ms;                 // a periodic tick alone would close it ~2 s late
    cfg.turns.boundary_grace_ms = 60;
    auto clock = std::make_shared<TurnClock>();
    CopilotEngine engine{cfg, nullptr};
    engine.add_sink([clock](const EngineEvent& e) { (*clock)(e); });
    engine.start();

    engine.on_transcript(final_ev(AudioSource::Loopback, "Me conta sobre o projeto"));
    const auto t0 = std::chrono::steady_clock::now();
    engine.on_transcript(turn_end(AudioSource::Loopback));
    ASSERT_TRUE(eventually([&] { return clock->count() == 1; }, 1500ms));
    const auto waited = std::chrono::steady_clock::now() - t0;
    engine.stop();

    EXPECT_GE(waited, 55ms);
    EXPECT_LT(waited, 600ms) << "the turn waited for the periodic tick";
}
