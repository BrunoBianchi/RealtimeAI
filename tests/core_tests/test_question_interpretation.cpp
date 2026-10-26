// What the copilot understands from the live transcript: the "PERGUNTA:"
// header the answer starts with (the card title, never read aloud) and the
// manual trigger that reads the interviewer's whole recent utterance, not
// only its last piece.
#include <gtest/gtest.h>

#include <atomic>
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
#include "rtai/scripted_llm.hpp"

using namespace rtai;
using namespace std::chrono_literals;
using rtai::testing::eventually;

namespace {

constexpr auto npos = std::string::npos;

// ------------------------------------------------------------ header split

TEST(InterpretedAnswer, SplitsTheUnderstoodQuestionFromTheBody) {
    const auto a = split_interpreted_answer(
        "PERGUNTA: Por que você quer trabalhar na Nubank, além da cultura?\n\nPorque eu quero construir produto.");
    EXPECT_TRUE(a.has_header);
    EXPECT_TRUE(a.header_complete);
    EXPECT_EQ(a.question, "Por que você quer trabalhar na Nubank, além da cultura?");
    EXPECT_EQ(a.body, "Porque eu quero construir produto.");
}

TEST(InterpretedAnswer, ToleratesMarkdownAndEnglish) {
    const auto a = split_interpreted_answer("**PERGUNTA:** Como você lida com prazos?\nEu priorizo.");
    EXPECT_EQ(a.question, "Como você lida com prazos?");
    EXPECT_EQ(a.body, "Eu priorizo.");
    const auto b = split_interpreted_answer("Question: Why Nubank?\n\nBecause...");
    EXPECT_EQ(b.question, "Why Nubank?");
    EXPECT_EQ(b.body, "Because...");
    const auto c = split_interpreted_answer("Pergunta entendida: Qual foi o desafio?\nO desafio era...");
    EXPECT_EQ(c.question, "Qual foi o desafio?");
}

TEST(InterpretedAnswer, HidesTheHeaderWhileItStreams) {
    for (const char* partial : {"PER", "PERGUNTA", "**PERGUNTA:", "PERGUNTA: Por que você quer"}) {
        const auto a = split_interpreted_answer(partial);
        EXPECT_TRUE(a.has_header) << partial;
        EXPECT_FALSE(a.header_complete) << partial;
        EXPECT_TRUE(a.body.empty()) << partial << " leaked into the body";
    }
}

TEST(InterpretedAnswer, AnswersWithoutHeaderPassThrough) {
    for (const char* body : {"Porque eu quero construir produto.", "Pergunta interessante: eu acho que...",
                             "Questions like this...", "[SKIP]", "**Situação:** ok"}) {
        const auto a = split_interpreted_answer(body, true);
        EXPECT_FALSE(a.has_header) << body;
        EXPECT_EQ(a.body, body);
    }
}

TEST(InterpretedAnswer, FinalTextWithoutLineBreakEndsTheQuestionAtTheMark) {
    const auto a = split_interpreted_answer("PERGUNTA: Por que a Nubank? Porque eu quero.", true);
    EXPECT_EQ(a.question, "Por que a Nubank?");
    EXPECT_EQ(a.body, "Porque eu quero.");
}

TEST(InterpretedAnswer, PromptAsksForTheHeaderAndTheInterviewerWindow) {
    const std::string history =
        "[Outros] Por que você quer participar da Nubank?\n[Outros] Não é a questão da cultura da Nubank.\n";
    PromptConfig cfg;
    const auto m = build_copilot_messages(cfg, history, "Não é a questão da cultura da Nubank.",
                                          TriggerReason::Manual);
    const std::string& u = m[1].content;
    const auto w = u.find("FALAS RECENTES DO ENTREVISTADOR");
    ASSERT_NE(w, npos);
    EXPECT_NE(u.find("Por que você quer participar da Nubank?", w), npos);
    EXPECT_NE(u.find("Primeiro a linha PERGUNTA"), npos);
}

// ------------------------------------------------------------- engine flow

TranscriptEvent final_t(AudioSource s, std::string text) {
    TranscriptEvent e{s, std::move(text), true, 0};
    e.from_finalize = true;
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

constexpr const char* kAnswer =
    "PERGUNTA: Por que você quer trabalhar na Nubank, além da cultura?\n\n"
    "Porque eu quero construir produto que chega em milhões de pessoas.";

struct Rig {
    std::shared_ptr<ScriptedLlmClient> llm;
    std::shared_ptr<Sink> sink = std::make_shared<Sink>();
    std::unique_ptr<CopilotEngine> engine;

    Rig() {
        ScriptedLlmClient::Options o;
        o.reply = kAnswer;
        o.first_token_delay = 2ms;
        o.token_delay = 0ms;
        llm = std::make_shared<ScriptedLlmClient>(o);
        CopilotConfig c;
        c.tick = 5ms;
        c.decision.cooldown_ms = 0;
        c.decision.auto_enabled = false; // only the manual "Answer" trigger
        c.decision.keywords.clear();
        c.allow_speculative = false;
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
    void me(const std::string& t) { engine->on_transcript(final_t(AudioSource::Microphone, t)); }
};

TEST(ManualTrigger, AnswersTheWholeSplitQuestionNotJustItsLastPiece) {
    Rig r;
    r.say("Por que você quer participar da Nubank?");
    r.me("Espera aí amor.");
    r.say("Não é e a questão da cultura da Nubank.");
    std::this_thread::sleep_for(60ms);
    r.engine->request_suggestion();
    ASSERT_TRUE(eventually([&] { return !r.sink->all<SuggestionStartedEvent>().empty(); }));
    const std::string trig = r.sink->all<SuggestionStartedEvent>()[0].trigger_text;
    EXPECT_NE(trig.find("Por que você quer participar da Nubank?"), npos) << trig;
    EXPECT_NE(trig.find("cultura da Nubank"), npos) << trig;
    EXPECT_EQ(trig.find("amor"), npos) << "side talk on the other lane is not part of the question: " << trig;
}

TEST(ManualTrigger, TheUnderstoodQuestionIsSeparatedFromTheAnswer) {
    Rig r;
    r.say("Por que você quer participar da Nubank?");
    std::this_thread::sleep_for(40ms);
    r.engine->request_suggestion();
    ASSERT_TRUE(eventually([&] { return !r.sink->all<SuggestionDoneEvent>().empty(); }, 3s));
    const auto done = r.sink->all<SuggestionDoneEvent>()[0];
    EXPECT_EQ(done.interpreted_question, "Por que você quer trabalhar na Nubank, além da cultura?");
    EXPECT_EQ(done.text.rfind("Porque eu quero", 0), 0u) << done.text;
}

} // namespace
