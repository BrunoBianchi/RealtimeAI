// Tests for the STAR / grounded-RAG / low-latency slice:
//   * RAG: stemming (PT/EN), weighted follow-up context, relative cut (no
//     unrelated chunks), STAR story fallback, keyterms for Deepgram;
//   * Deepgram: language hints, no_delay and the minimal fallback path;
//   * Engine: split questions answered as a whole, early commit only on a
//     finished question, a hidden generation that already finished completes
//     its card on commit, a committed answer survives the candidate talking,
//     numbers not present in the context raise a warning.
#include <gtest/gtest.h>

#include <algorithm>
#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "fake_websocket.hpp" // eventually()
#include "rtai/copilot_engine.hpp"
#include "rtai/copilot_events.hpp"
#include "rtai/deepgram_protocol.hpp"
#include "rtai/mini_agent.hpp"
#include "rtai/scripted_llm.hpp"
#include "rtai/settings.hpp"
#include "rtai/suggestion_format.hpp"

using namespace rtai;
using namespace std::chrono_literals;
using rtai::testing::eventually;

namespace {

MiniAgentProfile three_project_profile() {
    MiniAgentProfile p;
    p.name = "Bruno";
    p.company = "Acme";
    p.role = "Software Engineer";
    p.company_dossier = "A Acme vende software de logística para transportadoras.";
    p.documents.push_back(RagDocument{
        "Midea", "midea.md",
        "Projeto Midea na UNIFEI: automação do call center com IA generativa.\n"
        "Classificamos as chamadas com uma CNN e geramos respostas com um LLM."});
    p.documents.push_back(RagDocument{
        "PaymentsService", "payments.md",
        "Implemented a Kafka event pipeline for the payments service.\n"
        "The pipeline processed card authorizations with exactly-once delivery."});
    p.documents.push_back(RagDocument{
        "Hackathon", "hackathon.md",
        "Venci o Hackathon Ninja 2026 com um app de finanças pessoais em React."});
    return p;
}

bool has_source(const RagDecision& d, const std::string& src) {
    return std::any_of(d.chunks.begin(), d.chunks.end(),
                       [&](const RagChunk* c) { return c->source == src; });
}

} // namespace

// --------------------------------------------------------------------- RAG

TEST(RagStemming, PortugueseQuestionFindsEnglishDocument) {
    MiniAgentRag rag{three_project_profile()};
    const auto dec = rag.decide_rag_for_query("Como você implementou aquele pipeline de eventos com Kafka?", 4);
    ASSERT_TRUE(dec.needed);
    ASSERT_FALSE(dec.chunks.empty());
    EXPECT_EQ(dec.chunks.front()->source, "PaymentsService");
}

TEST(RagStemming, StemIsSharedByIndexAndQuery) {
    EXPECT_EQ(MiniAgentRag::stem("implementacao"), MiniAgentRag::stem("implemented"));
    EXPECT_EQ(MiniAgentRag::stem("projetos"), MiniAgentRag::stem("project"));
    // Numbers and symbol-bearing tech terms stay exact.
    EXPECT_EQ(MiniAgentRag::stem("2026"), "2026");
    EXPECT_EQ(MiniAgentRag::stem("c++20"), "c++20");
}

TEST(RagSelection, DoesNotPadWithUnrelatedChunks) {
    MiniAgentRag rag{three_project_profile()};
    const std::string block = rag.retrieve_block("Me fale sobre o pipeline Kafka de pagamentos.");
    EXPECT_NE(block.find("Kafka"), std::string::npos);
    // The old composer appended every other chunk until the budget ran out.
    EXPECT_EQ(block.find("Hackathon Ninja"), std::string::npos);
    EXPECT_EQ(block.find("logística"), std::string::npos);
}

TEST(RagSelection, FollowUpUsesInterviewerContextAtLowWeight) {
    MiniAgentRag rag{three_project_profile()};
    // "isso" alone means nothing; the previous interviewer line names Midea.
    const auto dec = rag.decide_rag_for_query("E como você escalou isso?", 4,
                                              "Me conta sobre o projeto Midea na UNIFEI.");
    ASSERT_FALSE(dec.chunks.empty());
    EXPECT_EQ(dec.chunks.front()->source, "Midea");
}

TEST(RagSelection, BehavioralQuestionAlwaysGetsARealStory) {
    MiniAgentRag rag{three_project_profile()};
    // Nothing in the files talks about conflict: the STAR answer still needs a
    // real project to anchor on instead of an invented one.
    const auto dec = rag.decide_rag_for_query("Conte uma situação de conflito no time e como resolveu.", 4);
    ASSERT_TRUE(dec.needed);
    EXPECT_TRUE(std::any_of(dec.chunks.begin(), dec.chunks.end(),
                            [](const RagChunk* c) { return c->is_candidate_project; }));
}

TEST(RagSelection, ProjectCitedOnlyInContextStillPrioritized) {
    MiniAgentRag rag{three_project_profile()};
    const auto dec = rag.decide_rag_for_query("Qual foi o maior desafio?", 4, "Vamos falar do Hackathon.");
    ASSERT_FALSE(dec.chunks.empty());
    EXPECT_TRUE(has_source(dec, "Hackathon"));
}

TEST(RagSessionProfile, ListsRealDocumentsAndNoHardCodedExamples) {
    MiniAgentRag rag{three_project_profile()};
    const std::string block = rag.session_profile_block("Notas do config.");
    EXPECT_NE(block.find("Midea, PaymentsService, Hackathon"), std::string::npos);
    EXPECT_NE(block.find("Acme"), std::string::npos);
    EXPECT_NE(block.find("MINI-COMPACT SEMPRE PRESENTE"), std::string::npos);
    EXPECT_NE(block.find("Notas do config."), std::string::npos);
    EXPECT_EQ(block.find("TechFinance"), std::string::npos);
    EXPECT_EQ(block.find("Tako"), std::string::npos);
    // Stable: identical on every call (cacheable system prefix).
    EXPECT_EQ(block, rag.session_profile_block("Notas do config."));
}

TEST(RagKeyterms, PicksProperNounsAcronymsAndTechTerms) {
    MiniAgentProfile p;
    p.company = "Acme";
    p.documents.push_back(RagDocument{
        "Curriculo_Bruno.pdf", "cv",
        "Desenvolvi o RealTimeAI em C++20 com WASAPI e Deepgram. Usei AWS no projeto. "
        "Depois integrei o Deepgram ao HUD."});
    MiniAgentRag rag{p};
    const auto kt = rag.extract_keyterms(30);
    auto has = [&](const std::string& t) { return std::find(kt.begin(), kt.end(), t) != kt.end(); };
    EXPECT_TRUE(has("Acme"));
    EXPECT_TRUE(has("Curriculo Bruno"));
    EXPECT_TRUE(has("RealTimeAI"));
    EXPECT_TRUE(has("C++20"));
    EXPECT_TRUE(has("WASAPI"));
    EXPECT_TRUE(has("Deepgram"));
    EXPECT_TRUE(has("AWS"));
    EXPECT_FALSE(has("Desenvolvi")) << "sentence-initial capital is an ordinary word";
    EXPECT_FALSE(has("Depois"));
}

// ---------------------------------------------------------------- Deepgram

TEST(DeepgramParams, MultiSendsHintsAndNoDelay) {
    dg::StreamParams p;
    p.language = "multi";
    p.language_hints = {"pt", "en"};
    p.keyterms = {"RealTimeAI"};
    const std::string path = dg::build_listen_path(p);
    EXPECT_NE(path.find("language_hint=pt"), std::string::npos);
    EXPECT_NE(path.find("language_hint=en"), std::string::npos);
    EXPECT_NE(path.find("no_delay=true"), std::string::npos);
    const std::string minimal = dg::build_minimal_listen_path(p);
    EXPECT_EQ(minimal.find("language_hint"), std::string::npos);
    EXPECT_EQ(minimal.find("no_delay"), std::string::npos);
    EXPECT_EQ(minimal.find("keyterm"), std::string::npos);
    EXPECT_NE(minimal.find("language=multi"), std::string::npos);
}

TEST(DeepgramParams, HintsOnlyWithMulti) {
    dg::StreamParams p;
    p.language = "pt-BR";
    p.language_hints = {"pt", "en"};
    EXPECT_EQ(dg::build_listen_path(p).find("language_hint"), std::string::npos);
}

TEST(SettingsStar, LanguageHintsDefaultAndOverride) {
    const EnvLookup no_env = [](const char*) { return std::string(); };
    const SecretDecoder dec = [](const std::string&) { return std::optional<std::string>(); };
    Settings d = load_settings(ini::File::parse("[deepgram]\nidioma = multi\n"), no_env, dec);
    EXPECT_EQ(d.language_hints, (std::vector<std::string>{"pt", "en"}));
    Settings o = load_settings(ini::File::parse("[deepgram]\ndicas_idioma = es, en\n[turn]\nboundary_grace_ms = 300\n"),
                               no_env, dec);
    EXPECT_EQ(o.language_hints, (std::vector<std::string>{"es", "en"}));
    EXPECT_EQ(o.turn_boundary_grace_ms, 300);
    Settings n = load_settings(ini::File::parse("[deepgram]\ndicas_idioma = nenhuma\n"), no_env, dec);
    EXPECT_TRUE(n.language_hints.empty());
}

// --------------------------------------------------------------- HUD format

TEST(StarFormat, StarLabelsRenderAsLabels) {
    const auto lines = format_suggestion(
        "**Situação:** No projeto Midea.\n**Tarefa:** Reduzir filas.\n**Ação:** Classifiquei chamadas.\n"
        "**Resultado:** Menos espera.");
    ASSERT_EQ(lines.size(), 4u);
    for (const auto& l : lines) EXPECT_EQ(l.kind, FormattedLine::Kind::Label) << l.plain();
    ASSERT_FALSE(lines[0].segments.empty());
    EXPECT_TRUE(lines[0].segments[0].bold);
    EXPECT_EQ(lines[0].segments[0].text, "Situação:");
    const auto en = format_suggestion("Situation: At Acme.\nResult: Faster.");
    ASSERT_EQ(en.size(), 2u);
    EXPECT_EQ(en[0].kind, FormattedLine::Kind::Label);
}

TEST(StarPrompt, ChatAnswersInStar) {
    const std::string p = action_system_prompt(TriggerReason::Chat);
    EXPECT_NE(p.find("STAR natural"), std::string::npos);
    EXPECT_NE(p.find("sem os rótulos"), std::string::npos);
    EXPECT_NE(p.find("Nunca invente"), std::string::npos);
}

// ------------------------------------------------------------------ engine

namespace {

TranscriptEvent interim(AudioSource s, std::string text) { return TranscriptEvent{s, std::move(text), false, 0}; }
TranscriptEvent final_t(AudioSource s, std::string text, bool from_finalize = true, bool speech_final = false) {
    TranscriptEvent e{s, std::move(text), true, 0};
    e.from_finalize = from_finalize;
    e.speech_final = speech_final;
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

CopilotConfig cfg_fast() {
    CopilotConfig c;
    c.tick = 5ms;
    c.decision.cooldown_ms = 0;
    c.turns.boundary_grace_ms = 40;
    c.turns.speculative_pause_ms = 40;
    return c;
}

std::shared_ptr<ScriptedLlmClient> llm_with(std::string reply, std::chrono::milliseconds first = 2ms,
                                            std::chrono::milliseconds per = 1ms) {
    ScriptedLlmClient::Options o;
    o.reply = std::move(reply);
    o.first_token_delay = first;
    o.token_delay = per;
    return std::make_shared<ScriptedLlmClient>(o);
}

} // namespace

TEST(EngineSplitQuestion, SecondHalfReanswersTheWholeQuestion) {
    CopilotConfig c = cfg_fast();
    c.allow_speculative = false;
    auto llm = llm_with("**Situação:** ok", 2ms, 1ms);
    CopilotEngine engine{c, llm};
    auto sink = std::make_shared<Sink>();
    engine.add_sink([sink](const EngineEvent& e) { (*sink)(e); });
    engine.start();

    // First piece: an interrogative opening with no '?' (cut by a pause).
    engine.on_transcript(final_t(AudioSource::Loopback, "Me conta como foi o projeto Midea"));
    ASSERT_TRUE(eventually([&] { return sink->all<SuggestionStartedEvent>().size() == 1; }));
    std::this_thread::sleep_for(60ms);
    engine.on_transcript(final_t(AudioSource::Loopback, "e qual foi o maior desafio?"));
    ASSERT_TRUE(eventually([&] { return sink->all<SuggestionStartedEvent>().size() == 2; }));
    engine.stop();
    llm->shutdown(1s);

    const auto started = sink->all<SuggestionStartedEvent>();
    EXPECT_FALSE(started[1].enqueue);
    EXPECT_NE(started[1].trigger_text.find("projeto Midea"), std::string::npos) << started[1].trigger_text;
    EXPECT_NE(started[1].trigger_text.find("maior desafio?"), std::string::npos) << started[1].trigger_text;
    EXPECT_NE(llm->last_request().messages.back().content.find("maior desafio?"), std::string::npos);
}

TEST(EngineSplitQuestion, CompleteQuestionsStaySeparate) {
    CopilotConfig c = cfg_fast();
    c.allow_speculative = false;
    auto llm = llm_with("ok");
    CopilotEngine engine{c, llm};
    auto sink = std::make_shared<Sink>();
    engine.add_sink([sink](const EngineEvent& e) { (*sink)(e); });
    engine.start();
    engine.on_transcript(final_t(AudioSource::Loopback, "Qual é o prazo de implantação?"));
    ASSERT_TRUE(eventually([&] { return sink->all<SuggestionStartedEvent>().size() == 1; }));
    std::this_thread::sleep_for(60ms);
    engine.on_transcript(final_t(AudioSource::Loopback, "Quanto custa a licença anual?"));
    ASSERT_TRUE(eventually([&] { return sink->all<SuggestionStartedEvent>().size() == 2; }));
    engine.stop();
    llm->shutdown(1s);
    EXPECT_EQ(sink->all<SuggestionStartedEvent>()[1].trigger_text, "Quanto custa a licença anual?");
}

TEST(EngineSpeculation, HiddenGenerationThatFinishedCompletesTheCardOnCommit) {
    auto llm = llm_with("**Situação:** resposta pronta antes do fim da pergunta.", 1ms, 0ms);
    CopilotEngine engine{cfg_fast(), llm};
    auto sink = std::make_shared<Sink>();
    engine.add_sink([sink](const EngineEvent& e) { (*sink)(e); });
    engine.start();

    engine.on_transcript(interim(AudioSource::Loopback, "Como voces fazem o onboarding de novos clientes"));
    ASSERT_TRUE(eventually([&] { return !sink->all<SpeculativeCandidateEvent>().empty(); }));
    ASSERT_TRUE(eventually([&] { return llm->started() >= 1; }));
    std::this_thread::sleep_for(80ms); // the scripted model is done long before the close
    engine.on_transcript(final_t(AudioSource::Loopback, "Como voces fazem o onboarding de novos clientes?"));
    ASSERT_TRUE(eventually([&] { return !sink->all<SuggestionDoneEvent>().empty(); }))
        << "a generation that finished while hidden must still complete its card";
    const auto done = sink->all<SuggestionDoneEvent>().front();
    EXPECT_EQ(done.status, LlmStatus::Completed);
    EXPECT_EQ(done.text, "**Situação:** resposta pronta antes do fim da pergunta.");
    EXPECT_EQ(done.visible_ms, 0) << "the whole answer was on screen at commit";

    // And the engine is free to speculate again (no stuck shadow/active).
    engine.on_transcript(interim(AudioSource::Loopback, "Qual e o prazo de entrega do primeiro modulo"));
    ASSERT_TRUE(eventually([&] { return sink->all<SpeculativeCandidateEvent>().size() >= 2; }));
    engine.stop();
    llm->shutdown(1s);
}

TEST(EngineSpeculation, CommittedAnswerSurvivesTheCandidateTalking) {
    auto llm = llm_with("**Situação:** uma resposta longa que ainda esta chegando no HUD palavra por palavra.", 2ms,
                        15ms);
    CopilotEngine engine{cfg_fast(), llm};
    auto sink = std::make_shared<Sink>();
    engine.add_sink([sink](const EngineEvent& e) { (*sink)(e); });
    engine.start();

    engine.on_transcript(interim(AudioSource::Loopback, "Qual e o prazo de implantacao do projeto"));
    ASSERT_TRUE(eventually([&] { return !sink->all<SpeculativeCandidateEvent>().empty(); }));
    engine.on_transcript(final_t(AudioSource::Loopback, "Qual e o prazo de implantacao do projeto?"));
    ASSERT_TRUE(eventually([&] { return !sink->all<SpeculativeHitEvent>().empty(); }));
    // The candidate starts answering while the card is still streaming.
    engine.on_transcript(interim(AudioSource::Microphone, "entao o prazo que a gente"));
    ASSERT_TRUE(eventually([&] { return !sink->all<SuggestionDoneEvent>().empty(); }, 5000ms));
    engine.stop();
    llm->shutdown(1s);
    EXPECT_EQ(sink->all<SuggestionDoneEvent>().front().status, LlmStatus::Completed)
        << "a mic interim must not cancel the visible answer";
}

TEST(EngineSpeculation, SpeechFinalCommitsEarlyOnlyOnAFinishedQuestion) {
    auto llm = llm_with("**Situação:** ok", 2ms, 2ms);
    CopilotEngine engine{cfg_fast(), llm};
    auto sink = std::make_shared<Sink>();
    engine.add_sink([sink](const EngineEvent& e) { (*sink)(e); });
    engine.start();

    engine.on_transcript(interim(AudioSource::Loopback, "Qual e o prazo de implantacao do projeto"));
    ASSERT_TRUE(eventually([&] { return !sink->all<SpeculativeCandidateEvent>().empty(); }));
    // speech_final mid-turn without '?': maybe a breath pause, keep waiting.
    engine.on_transcript(final_t(AudioSource::Loopback, "Qual e o prazo de implantacao do projeto", false, true));
    std::this_thread::sleep_for(60ms);
    EXPECT_TRUE(sink->all<SpeculativeHitEvent>().empty()) << "committed on half a question";
    // The question is finished: commit before the turn even closes.
    engine.on_transcript(final_t(AudioSource::Loopback, "em producao?", false, true));
    ASSERT_TRUE(eventually([&] { return !sink->all<SpeculativeHitEvent>().empty(); }));
    EXPECT_TRUE(sink->all<TurnEvent>().empty()) << "early commit happens before the turn closes";
    engine.stop();
    llm->shutdown(1s);
}

TEST(EngineSpeculation, QuestionThatGrowsIsReansweredInFull) {
    auto llm = llm_with("**Situação:** ok", 2ms, 2ms);
    CopilotEngine engine{cfg_fast(), llm};
    auto sink = std::make_shared<Sink>();
    engine.add_sink([sink](const EngineEvent& e) { (*sink)(e); });
    engine.start();

    engine.on_transcript(interim(AudioSource::Loopback, "Como foi trabalhar no projeto Midea na UNIFEI"));
    ASSERT_TRUE(eventually([&] { return !sink->all<SpeculativeCandidateEvent>().empty(); }));
    engine.on_transcript(final_t(AudioSource::Loopback,
                                 "Como foi trabalhar no projeto Midea na UNIFEI e qual foi o maior desafio tecnico?"));
    ASSERT_TRUE(eventually([&] { return !sink->all<SuggestionDoneEvent>().empty(); }));
    engine.stop();
    llm->shutdown(1s);
    const auto started = sink->all<SuggestionStartedEvent>();
    ASSERT_FALSE(started.empty());
    EXPECT_NE(started.back().trigger_text.find("maior desafio tecnico?"), std::string::npos)
        << started.back().trigger_text;
    EXPECT_NE(llm->last_request().messages.back().content.find("maior desafio tecnico?"), std::string::npos);
}

// "Ele entende errado": the speculative answer was built on "Me fala sobre o
// seu projeto" and kept when the interviewer finished with "de Kubernetes em
// redes 5G" (5 more words, no interrogative). The answer, and the RAG search
// behind it, never knew which project was asked.
TEST(EngineSpeculation, QuestionCompletedWithContentIsReansweredInFull) {
    auto llm = llm_with("**Situação:** ok", 2ms, 2ms);
    CopilotEngine engine{cfg_fast(), llm};
    auto sink = std::make_shared<Sink>();
    engine.add_sink([sink](const EngineEvent& e) { (*sink)(e); });
    engine.start();

    engine.on_transcript(interim(AudioSource::Loopback, "Me fala sobre o seu projeto"));
    ASSERT_TRUE(eventually([&] { return !sink->all<SpeculativeCandidateEvent>().empty(); }));
    engine.on_transcript(final_t(AudioSource::Loopback, "Me fala sobre o seu projeto de Kubernetes em redes 5G"));
    ASSERT_TRUE(eventually([&] {
        const auto done = sink->all<SuggestionDoneEvent>();
        return !done.empty() && done.back().trigger_text.find("Kubernetes") != std::string::npos;
    }));
    engine.stop();
    llm->shutdown(1s);
    EXPECT_NE(llm->last_request().messages.back().content.find("Kubernetes em redes 5G"), std::string::npos);
}

TEST(EngineSpeculation, FillerEndingKeepsTheSpeculativeAnswer) {
    auto llm = llm_with("**Situação:** ok", 2ms, 2ms);
    CopilotEngine engine{cfg_fast(), llm};
    auto sink = std::make_shared<Sink>();
    engine.add_sink([sink](const EngineEvent& e) { (*sink)(e); });
    engine.start();

    engine.on_transcript(interim(AudioSource::Loopback, "Me fala sobre o seu projeto de Kubernetes"));
    ASSERT_TRUE(eventually([&] { return !sink->all<SpeculativeCandidateEvent>().empty(); }));
    engine.on_transcript(final_t(AudioSource::Loopback, "Me fala sobre o seu projeto de Kubernetes, por favor"));
    ASSERT_TRUE(eventually([&] { return !sink->all<SuggestionDoneEvent>().empty(); }));
    engine.stop();
    llm->shutdown(1s);
    EXPECT_EQ(llm->started(), 1) << "a filler must not throw away a finished answer";
}

TEST(Grounding, FlagsNamesAndToolsMissingFromContext) {
    const std::string ctx = "Construí pipelines em Python com Prometheus na Vertis Solutions. TechFinance App.";
    const auto bad = ungrounded_terms(
        "**Situação:** Na Stripe, usei Kafka e Python.\n**Ação:** Implementei uma API REST no TechFinance.", ctx);
    EXPECT_NE(std::find(bad.begin(), bad.end(), "Stripe"), bad.end());
    EXPECT_NE(std::find(bad.begin(), bad.end(), "Kafka"), bad.end());
    EXPECT_EQ(std::find(bad.begin(), bad.end(), "Python"), bad.end()) << "in the files";
    EXPECT_EQ(std::find(bad.begin(), bad.end(), "TechFinance"), bad.end());
    EXPECT_EQ(std::find(bad.begin(), bad.end(), "API"), bad.end()) << "generic term";
    EXPECT_EQ(std::find(bad.begin(), bad.end(), "Implementei"), bad.end()) << "label start is not a name";
    EXPECT_EQ(std::find(bad.begin(), bad.end(), "Situação"), bad.end());
}

TEST(EngineGrounding, WarnsAboutNumbersMissingFromContext) {
    CopilotConfig c = cfg_fast();
    c.allow_speculative = false;
    c.prompt.user_context = "Projeto Midea: reduzi o tempo de espera das chamadas em 18%.";
    auto llm = llm_with("**Resultado:** reduzi a espera em 18% e o custo em 37%.");
    CopilotEngine engine{c, llm};
    auto sink = std::make_shared<Sink>();
    engine.add_sink([sink](const EngineEvent& e) { (*sink)(e); });
    engine.start();
    engine.on_transcript(final_t(AudioSource::Loopback, "Qual foi o resultado do projeto Midea?"));
    ASSERT_TRUE(eventually([&] {
        for (const auto& n : sink->all<NoticeEvent>()) {
            if (n.level == NoticeLevel::Warning && n.text.find("37") != std::string::npos) return true;
        }
        return false;
    }));
    engine.stop();
    llm->shutdown(1s);
    for (const auto& n : sink->all<NoticeEvent>()) {
        EXPECT_EQ(n.text.find("18"), std::string::npos) << "18% is in the context: " << n.text;
    }
}
