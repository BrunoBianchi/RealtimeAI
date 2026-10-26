// Overlay-facing core: user actions (chat, screenshot, recap, follow-up),
// feedback, multimodal requests, SVG icon paths and the UI models.
#include <gtest/gtest.h>

#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "fake_websocket.hpp" // eventually()
#include "rtai/copilot_engine.hpp"
#include "rtai/json_min.hpp"
#include "rtai/openrouter_protocol.hpp"
#include "rtai/scripted_llm.hpp"
#include "rtai/session_store.hpp"

using namespace rtai;
using namespace std::chrono_literals;
using rtai::testing::eventually;

namespace {

struct Sink {
    std::mutex mu;
    std::vector<EngineEvent> events;
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

CopilotConfig cfg_fast() {
    CopilotConfig c;
    c.tick = 10ms;
    c.decision.cooldown_ms = 0;
    c.turns.boundary_grace_ms = 50;
    return c;
}

std::shared_ptr<ScriptedLlmClient> llm_fast(std::string reply = "- ok") {
    ScriptedLlmClient::Options o;
    o.reply = std::move(reply);
    o.first_token_delay = 2ms;
    o.token_delay = 1ms;
    return std::make_shared<ScriptedLlmClient>(o);
}

struct Rig {
    std::shared_ptr<ScriptedLlmClient> llm;
    std::unique_ptr<CopilotEngine> engine;
    std::shared_ptr<Sink> sink = std::make_shared<Sink>();
    explicit Rig(std::shared_ptr<ScriptedLlmClient> l = llm_fast()) : llm(std::move(l)) {
        engine = std::make_unique<CopilotEngine>(cfg_fast(), llm);
        auto s = sink;
        engine->add_sink([s](const EngineEvent& e) {
            std::lock_guard<std::mutex> lk(s->mu);
            s->events.push_back(e);
        });
        engine->start();
    }
    ~Rig() { engine->stop(); }
    void say(AudioSource src, const std::string& text) {
        TranscriptEvent e{src, text, true, 0};
        e.from_finalize = true;
        engine->on_transcript(e);
    }
    std::size_t done() { return sink->all<SuggestionDoneEvent>().size(); }
};

} // namespace

// ---------------------------------------------------------------- actions
TEST(CopilotActions, ChatSendsTypedQuestionWithTranscriptContext) {
    Rig r;
    r.say(AudioSource::Microphone, "Nosso plano básico custa 300 reais");
    ASSERT_TRUE(eventually([&] { return r.sink->all<TurnEvent>().size() == 1; }));
    r.engine->request_action(TriggerReason::Chat, "  quanto eu falei que custa o plano?  ");
    ASSERT_TRUE(eventually([&] { return r.done() == 1; }));
    auto started = r.sink->all<SuggestionStartedEvent>();
    ASSERT_EQ(started.size(), 1u);
    EXPECT_EQ(started[0].reason, TriggerReason::Chat);
    EXPECT_EQ(started[0].trigger_text, "quanto eu falei que custa o plano?");
    EXPECT_FALSE(started[0].has_image);
    const auto req = r.llm->last_request();
    ASSERT_GE(req.messages.size(), 2u);
    EXPECT_NE(req.messages[0].content.find("pedido que o usuário digitou"), std::string::npos);
    const auto& user = req.messages.back().content;
    EXPECT_NE(user.find("[Você] Nosso plano básico custa 300 reais"), std::string::npos);
    EXPECT_NE(user.find("Minha pergunta: quanto eu falei que custa o plano?"), std::string::npos);
}

TEST(CopilotActions, ChatKeepsThreadOfEarlierExchanges) {
    Rig r{llm_fast("- resposta um")};
    r.engine->request_action(TriggerReason::Chat, "primeira pergunta");
    ASSERT_TRUE(eventually([&] { return r.done() == 1; }));
    r.engine->request_action(TriggerReason::Chat, "e a segunda?");
    ASSERT_TRUE(eventually([&] { return r.done() == 2; }));
    auto req = r.llm->last_request();
    // system, earlier user, earlier assistant, new user
    ASSERT_EQ(req.messages.size(), 4u);
    EXPECT_EQ(req.messages[1].content, "primeira pergunta");
    EXPECT_EQ(req.messages[2].role, "assistant");
    EXPECT_EQ(req.messages[2].content, "- resposta um");
    r.engine->clear_chat();
    r.engine->request_action(TriggerReason::Chat, "terceira");
    ASSERT_TRUE(eventually([&] { return r.done() == 3; }));
    EXPECT_EQ(r.llm->last_request().messages.size(), 2u);
}

TEST(CopilotActions, EmptyChatIsIgnoredAndRecapNeedsConversation) {
    Rig r;
    r.engine->request_action(TriggerReason::Chat, "   ");
    r.engine->request_action(TriggerReason::Recap);
    ASSERT_TRUE(eventually([&] { return !r.sink->all<NoticeEvent>().empty(); }));
    std::this_thread::sleep_for(30ms);
    EXPECT_TRUE(r.sink->all<SuggestionStartedEvent>().empty());
    EXPECT_EQ(r.sink->all<NoticeEvent>()[0].text, "There is no conversation yet.");
}

TEST(CopilotActions, RecapAndFollowUpUseTheirOwnPrompts) {
    Rig r;
    r.say(AudioSource::Loopback, "Precisamos fechar até sexta");
    ASSERT_TRUE(eventually([&] { return r.sink->all<TurnEvent>().size() == 1; }));
    r.engine->request_action(TriggerReason::Recap);
    ASSERT_TRUE(eventually([&] { return r.done() >= 1; }));
    EXPECT_NE(r.llm->last_request().messages[0].content.find("resuma a conversa"), std::string::npos);
    EXPECT_EQ(r.sink->all<SuggestionStartedEvent>().back().trigger_text, "Conversation recap");
    r.engine->request_action(TriggerReason::FollowUp);
    ASSERT_TRUE(eventually([&] { return r.done() >= 2; }));
    EXPECT_NE(r.llm->last_request().messages[0].content.find("3 perguntas"), std::string::npos);
}

TEST(CopilotActions, ScreenshotAttachesImageAndIncludesLiveSpeech) {
    Rig r;
    TranscriptEvent interim{AudioSource::Loopback, "e esse gráfico aqui", false, 0};
    r.engine->on_transcript(interim);
    ASSERT_TRUE(eventually([&] { return !r.sink->all<TranscriptUpdateEvent>().empty(); }));
    r.engine->request_action(TriggerReason::Screenshot, "", "data:image/jpeg;base64,AAAA");
    ASSERT_TRUE(eventually([&] { return r.done() == 1; }));
    auto started = r.sink->all<SuggestionStartedEvent>();
    EXPECT_TRUE(started[0].has_image);
    EXPECT_EQ(started[0].trigger_text, "Screenshot");
    const auto req = r.llm->last_request();
    ASSERT_EQ(req.messages.back().images.size(), 1u);
    EXPECT_EQ(req.messages.back().images[0], "data:image/jpeg;base64,AAAA");
    EXPECT_NE(req.messages.back().content.find("[Outros] e esse gráfico aqui (falando)"), std::string::npos);
}

TEST(CopilotActions, FeedbackAndPerSourcePauseArePublished) {
    Rig r;
    r.engine->rate_suggestion(7, -1);
    r.engine->set_paused(true, static_cast<int>(AudioSource::Microphone));
    ASSERT_TRUE(eventually([&] {
        return !r.sink->all<FeedbackEvent>().empty() && !r.sink->all<PauseEvent>().empty();
    }));
    EXPECT_EQ(r.sink->all<FeedbackEvent>()[0].id, 7u);
    EXPECT_EQ(r.sink->all<FeedbackEvent>()[0].vote, -1);
    EXPECT_EQ(r.sink->all<PauseEvent>()[0].source, static_cast<int>(AudioSource::Microphone));
}

TEST(CopilotActions, WithoutLlmActionsWarn) {
    CopilotEngine engine{cfg_fast(), nullptr};
    auto sink = std::make_shared<Sink>();
    engine.add_sink([sink](const EngineEvent& e) {
        std::lock_guard<std::mutex> lk(sink->mu);
        sink->events.push_back(e);
    });
    engine.start();
    engine.request_action(TriggerReason::Chat, "oi");
    ASSERT_TRUE(eventually([&] { return !sink->all<NoticeEvent>().empty(); }));
    engine.stop();
    EXPECT_NE(sink->all<NoticeEvent>()[0].text.find("OpenRouter key in Settings"), std::string::npos);
}

TEST(SessionStoreActions, FeedbackAndActionLabelsReachMarkdown) {
    FeedbackEvent fb{3, 1, 1200};
    auto line = SessionStore::to_json_line(fb);
    ASSERT_TRUE(line);
    auto v = json::Parser::parse(*line);
    ASSERT_TRUE(v);
    EXPECT_EQ((*v)["type"].as_string(), "feedback");
    EXPECT_EQ((*v)["vote"].as_number(), 1.0);

    PauseEvent p{true, static_cast<int>(AudioSource::Microphone), 500};
    auto pv = json::Parser::parse(*SessionStore::to_json_line(p));
    EXPECT_EQ((*pv)["src"].as_string(), "voce");

    SuggestionDoneEvent d;
    d.id = 3;
    d.reason = TriggerReason::Chat;
    d.trigger_text = "quanto custa?";
    d.text = "- 300";
    d.t_ms = 1000;
    std::vector<json::Value> recs;
    recs.push_back(*json::Parser::parse(*SessionStore::to_json_line(d)));
    recs.push_back(*v);
    recs.push_back(*pv);
    const std::string md = SessionStore::render_markdown(recs);
    EXPECT_NE(md.find("Chat: \"quanto custa?\""), std::string::npos);
    EXPECT_NE(md.find("Suggestion rating: helpful"), std::string::npos);
    EXPECT_NE(md.find("Capture paused (You)"), std::string::npos);
}

// ---------------------------------------------------------------- multimodal
TEST(OpenRouterMultimodal, ImagesBecomeContentParts) {
    LlmRequest req;
    req.model = "m";
    req.messages.push_back(ChatMessage{"system", "s", {}});
    req.messages.push_back(ChatMessage{"user", "veja", {"data:image/jpeg;base64,QUJD"}});
    auto v = json::Parser::parse(openrouter::build_request_body(req));
    ASSERT_TRUE(v);
    const auto& msgs = (*v)["messages"];
    EXPECT_EQ(msgs.at(0)["content"].as_string(), "s");
    const auto& parts = msgs.at(1)["content"];
    ASSERT_TRUE(parts.is_array());
    EXPECT_EQ(parts.at(0)["type"].as_string(), "text");
    EXPECT_EQ(parts.at(0)["text"].as_string(), "veja");
    EXPECT_EQ(parts.at(1)["type"].as_string(), "image_url");
    EXPECT_EQ(parts.at(1)["image_url"]["url"].as_string(), "data:image/jpeg;base64,QUJD");
}
