// The question gate wired into the engine ("ele envia coisas que não fazem
// sentido ou não a sentença inteira"): an automatic answer only for a
// complete question, the interviewer's fragments joined into one, statements
// kept as context for the question after them, and "[SKIP]" answers (the
// model saw no question) never shown.
#include <gtest/gtest.h>

#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "fake_websocket.hpp" // eventually()
#include "rtai/copilot_engine.hpp"
#include "rtai/copilot_events.hpp"
#include "rtai/copilot_prompt.hpp"
#include "rtai/decision_policy.hpp"
#include "rtai/scripted_llm.hpp"

using namespace rtai;
using namespace std::chrono_literals;
using rtai::testing::eventually;

namespace {

TranscriptEvent interim(AudioSource s, std::string text) { return TranscriptEvent{s, std::move(text), false, 0}; }
TranscriptEvent final_t(AudioSource s, std::string text) {
    TranscriptEvent e{s, std::move(text), true, 0};
    e.from_finalize = true; // closes the turn at once
    return e;
}

struct Sink {
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

// Interview mode (a goal is loaded): no sales keywords, quick timings.
CopilotConfig cfg_gate(bool speculative = false) {
    CopilotConfig c;
    c.tick = 5ms;
    c.decision.cooldown_ms = 0;
    c.decision.keywords.clear();
    c.turns.boundary_grace_ms = 40;
    c.turns.speculative_pause_ms = 40;
    c.allow_speculative = speculative;
    c.question_settle_ms = 150;
    c.question_hold_ms = 300;
    c.fragment_gap_ms = 2000;
    return c;
}

struct Rig {
    std::shared_ptr<ScriptedLlmClient> llm;
    std::shared_ptr<Sink> sink = std::make_shared<Sink>();
    std::unique_ptr<CopilotEngine> engine;

    explicit Rig(CopilotConfig c, std::string reply = "**Situação:** ok") {
        ScriptedLlmClient::Options o;
        o.reply = std::move(reply);
        o.first_token_delay = 2ms;
        o.token_delay = 1ms;
        llm = std::make_shared<ScriptedLlmClient>(o);
        engine = std::make_unique<CopilotEngine>(c, llm);
        auto s = sink;
        engine->add_sink([s](const EngineEvent& e) { (*s)(e); });
        engine->start();
    }
    ~Rig() {
        engine->stop();
        llm->shutdown(1s);
    }
    void say(const std::string& t) { engine->on_transcript(final_t(AudioSource::Loopback, t)); }
    void reply(const std::string& t) { engine->on_transcript(final_t(AudioSource::Microphone, t)); }
    std::vector<SuggestionStartedEvent> cards() { return sink->all<SuggestionStartedEvent>(); }
};

constexpr auto npos = std::string::npos;

} // namespace

TEST(QuestionFlow, HalfAQuestionWaitsForTheRest) {
    Rig r(cfg_gate());
    r.say("Me conta sobre um projeto em que você");
    std::this_thread::sleep_for(120ms);
    EXPECT_TRUE(r.cards().empty()) << "half a question got an answer";
    r.say("teve um prazo apertado");
    ASSERT_TRUE(eventually([&] { return r.cards().size() == 1; }));
    EXPECT_NE(r.cards()[0].trigger_text.find("projeto em que você teve um prazo apertado"), npos)
        << r.cards()[0].trigger_text;
    std::this_thread::sleep_for(100ms);
    EXPECT_EQ(r.cards().size(), 1u) << "one question, one answer";
}

TEST(QuestionFlow, AFragmentThatNeverEndsGetsNoAnswer) {
    Rig r(cfg_gate());
    r.say("Qual foi o maior");
    std::this_thread::sleep_for(500ms); // longer than the hold
    EXPECT_TRUE(r.cards().empty());
    EXPECT_EQ(r.llm->started(), 0);
}

TEST(QuestionFlow, StatementsFillersAndSmallTalkGetNoAnswer) {
    Rig r(cfg_gate());
    r.say("Como eu disse, aqui a gente usa Kafka e Clojure.");
    r.say("Hum, é, então, tipo");
    r.say("Tudo bem? Está me ouvindo?");
    std::this_thread::sleep_for(400ms);
    EXPECT_TRUE(r.cards().empty());
    EXPECT_EQ(r.llm->started(), 0);
}

TEST(QuestionFlow, ARequestWithoutQuestionMarkWaitsTheSettlePause) {
    CopilotConfig c = cfg_gate();
    c.question_settle_ms = 250;
    Rig r(c);
    const auto t0 = std::chrono::steady_clock::now();
    r.say("Me fala do seu projeto de Kubernetes");
    ASSERT_TRUE(eventually([&] { return r.cards().size() == 1; }));
    EXPECT_GE(std::chrono::steady_clock::now() - t0, 200ms) << "answered before the settle pause";
}

TEST(QuestionFlow, ARequestThatGoesOnIsAnsweredAsAWhole) {
    CopilotConfig c = cfg_gate();
    c.question_settle_ms = 400;
    Rig r(c);
    r.say("Me fala do seu projeto de Kubernetes");
    std::this_thread::sleep_for(100ms);
    r.say("e quais foram os resultados?");
    ASSERT_TRUE(eventually([&] { return !r.cards().empty(); }));
    std::this_thread::sleep_for(500ms);
    const auto cards = r.cards();
    ASSERT_EQ(cards.size(), 1u);
    EXPECT_NE(cards[0].trigger_text.find("Kubernetes"), npos) << cards[0].trigger_text;
    EXPECT_NE(cards[0].trigger_text.find("resultados?"), npos) << cards[0].trigger_text;
}

TEST(QuestionFlow, WhatWasSaidRightBeforeTheQuestionGoesWithIt) {
    Rig r(cfg_gate());
    r.say("Aqui a gente usa muito Kafka e Clojure.");
    std::this_thread::sleep_for(60ms);
    r.say("Você já trabalhou com isso?");
    ASSERT_TRUE(eventually([&] { return r.cards().size() == 1; }));
    const std::string t = r.cards()[0].trigger_text;
    EXPECT_NE(t.find("Kafka e Clojure"), npos) << t;
    EXPECT_NE(t.find("trabalhou com isso?"), npos) << t;
    EXPECT_NE(r.llm->last_request().messages.back().content.find("Kafka e Clojure"), npos);
}

TEST(QuestionFlow, ShortBackchannelDoesNotBreakTheQuestion) {
    Rig r(cfg_gate());
    r.say("Me conta sobre um projeto em que você");
    std::this_thread::sleep_for(60ms);
    r.reply("uhum");
    std::this_thread::sleep_for(60ms);
    r.say("teve um prazo apertado");
    ASSERT_TRUE(eventually([&] { return r.cards().size() == 1; }));
    EXPECT_NE(r.cards()[0].trigger_text.find("em que você teve um prazo apertado"), npos)
        << r.cards()[0].trigger_text;
}

TEST(QuestionFlow, TheCandidateStartingToTalkEndsTheSettlePause) {
    CopilotConfig c = cfg_gate();
    c.question_settle_ms = 3000;
    Rig r(c);
    r.say("Me fala do seu projeto de Kubernetes");
    std::this_thread::sleep_for(80ms);
    EXPECT_TRUE(r.cards().empty());
    r.reply("Então, o projeto de Kubernetes foi assim");
    ASSERT_TRUE(eventually([&] { return r.cards().size() == 1; }, 1500ms));
}

TEST(QuestionFlow, NoSpeculationOnHalfAQuestion) {
    Rig r(cfg_gate(true));
    r.engine->on_transcript(interim(AudioSource::Loopback, "Me conta sobre um projeto em que você"));
    std::this_thread::sleep_for(200ms);
    EXPECT_EQ(r.llm->started(), 0) << "speculated on half a question";
}

TEST(QuestionFlow, SkipAnswerNeverReachesTheScreen) {
    Rig r(cfg_gate(), "[SKIP]");
    r.say("Qual foi o maior desafio do projeto?");
    ASSERT_TRUE(eventually([&] { return r.llm->started() == 1; }));
    std::this_thread::sleep_for(200ms);
    EXPECT_TRUE(r.cards().empty());
    EXPECT_TRUE(r.sink->all<SuggestionDeltaEvent>().empty());
    EXPECT_TRUE(r.sink->all<SuggestionDoneEvent>().empty()) << "nor the session log";
}

TEST(QuestionFlow, SkipAnswerFromASpeculationNeverReachesTheScreen) {
    Rig r(cfg_gate(true), "[SKIP]");
    r.engine->on_transcript(interim(AudioSource::Loopback, "Qual foi o maior desafio do projeto"));
    ASSERT_TRUE(eventually([&] { return r.llm->started() >= 1; }));
    std::this_thread::sleep_for(60ms);
    r.say("Qual foi o maior desafio do projeto?");
    std::this_thread::sleep_for(250ms);
    EXPECT_TRUE(r.cards().empty());
    EXPECT_TRUE(r.sink->all<SpeculativeHitEvent>().empty());
    EXPECT_TRUE(r.sink->all<SuggestionDoneEvent>().empty());
}

TEST(QuestionFlow, RealAnswersStillStreamWithTheirCard) {
    Rig r(cfg_gate(), "**Situação:** no projeto de dados, o prazo era curto.");
    r.say("Qual foi o maior desafio do projeto?");
    ASSERT_TRUE(eventually([&] { return !r.sink->all<SuggestionDoneEvent>().empty(); }));
    const auto cards = r.cards();
    ASSERT_EQ(cards.size(), 1u);
    std::string body;
    for (const auto& d : r.sink->all<SuggestionDeltaEvent>()) {
        EXPECT_EQ(d.id, cards[0].id);
        body += d.text;
    }
    EXPECT_EQ(body, "**Situação:** no projeto de dados, o prazo era curto.") << "no text lost while the card was held";
    EXPECT_EQ(r.sink->all<SuggestionDoneEvent>()[0].status, LlmStatus::Completed);
}

TEST(QuestionFlow, OnlyAutomaticAnswersMaySkip) {
    Rig r(cfg_gate());
    r.say("Qual foi o maior desafio do projeto?");
    ASSERT_TRUE(eventually([&] { return !r.sink->all<SuggestionDoneEvent>().empty(); }));
    EXPECT_NE(r.llm->last_request().messages.back().content.find("[SKIP]"), npos);
    r.engine->request_suggestion();
    ASSERT_TRUE(eventually([&] { return r.llm->started() == 2; }));
    EXPECT_EQ(r.llm->last_request().messages.back().content.find("[SKIP]"), npos)
        << "a manual request is always answered";
}

TEST(QuestionFlow, ManualRequestTakesTheWholeHeldQuestion) {
    CopilotConfig c = cfg_gate();
    c.question_hold_ms = 5000;
    Rig r(c);
    r.say("Me conta sobre um projeto");
    r.say("em que você");
    std::this_thread::sleep_for(60ms);
    r.engine->request_suggestion();
    ASSERT_TRUE(eventually([&] { return r.cards().size() == 1; }));
    EXPECT_NE(r.cards()[0].trigger_text.find("Me conta sobre um projeto em que você"), npos)
        << r.cards()[0].trigger_text;
}

TEST(QuestionFlow, GateOffKeepsTheOldBehaviour) {
    CopilotConfig c = cfg_gate();
    c.question_gate = false;
    Rig r(c);
    r.say("Como eu disse, aqui a gente usa Kafka e Clojure.");
    ASSERT_TRUE(eventually([&] { return r.cards().size() == 1; }));
}

TEST(DecisionPolicyGate, TheGateVerdictReplacesTheQuestionHeuristic) {
    DecisionConfig dc;
    dc.cooldown_ms = 0;
    dc.keywords.clear();
    DecisionPolicy p(dc);
    Turn t;
    t.source = AudioSource::Loopback;
    t.text = "Como eu disse, aqui a gente usa Kafka.";
    EXPECT_EQ(p.evaluate(t, 1000), TriggerReason::Question) << "the old heuristic: starts with 'como'";
    EXPECT_EQ(p.evaluate(t, 2000, false), TriggerReason::None);
    t.text = "Você já trabalhou com Kafka";
    EXPECT_EQ(p.evaluate(t, 3000, true), TriggerReason::Question);
    EXPECT_EQ(p.would_trigger("Como eu disse, aqui a gente usa Kafka.", -1, false), TriggerReason::None);
    EXPECT_EQ(p.would_trigger("Me fala do projeto", -1, true), TriggerReason::Question);
}

TEST(SkipSentinel, ReadsTheFirstWords) {
    EXPECT_EQ(skip_verdict(""), SkipVerdict::Undecided);
    EXPECT_EQ(skip_verdict("  "), SkipVerdict::Undecided);
    EXPECT_EQ(skip_verdict("[SK"), SkipVerdict::Undecided);
    EXPECT_EQ(skip_verdict("[SKIP"), SkipVerdict::Undecided);
    EXPECT_EQ(skip_verdict("[SKIP]"), SkipVerdict::Skip);
    EXPECT_EQ(skip_verdict("**[SKIP]**"), SkipVerdict::Skip);
    EXPECT_EQ(skip_verdict(" skip."), SkipVerdict::Skip);
    EXPECT_EQ(skip_verdict("**S"), SkipVerdict::Undecided);
    EXPECT_EQ(skip_verdict("**Situação:** ok"), SkipVerdict::Answer);
    EXPECT_EQ(skip_verdict("**Situation:** ok"), SkipVerdict::Answer);
    EXPECT_EQ(skip_verdict("Skills que usei"), SkipVerdict::Answer);
    EXPECT_EQ(skip_verdict("SKIPPED"), SkipVerdict::Answer);
    EXPECT_EQ(skip_verdict("Ainda não vivi isso"), SkipVerdict::Answer);
}

TEST(SkipSentinel, OnlyOfferedWhenAsked) {
    PromptConfig pc;
    const auto with = build_copilot_messages(pc, "", "Qual foi o desafio?", TriggerReason::Question, {}, true);
    const auto without = build_copilot_messages(pc, "", "Qual foi o desafio?", TriggerReason::Question, {}, false);
    EXPECT_NE(with.back().content.find("[SKIP]"), npos);
    EXPECT_EQ(without.back().content.find("[SKIP]"), npos);
    EXPECT_EQ(with.front().content, without.front().content) << "the cached system prefix does not change";
}
