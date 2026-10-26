// Turn assembly, trigger policy, prompt and the copilot orchestrator.
#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <mutex>
#include <thread>
#include <vector>

#include "fake_websocket.hpp" // eventually()
#include "rtai/copilot_engine.hpp"
#include "rtai/copilot_prompt.hpp"
#include "rtai/decision_policy.hpp"
#include "rtai/mini_agent.hpp"
#include "rtai/scripted_llm.hpp"
#include "rtai/turn_assembler.hpp"

using namespace rtai;
using namespace std::chrono_literals;
using rtai::testing::eventually;

namespace {

TranscriptEvent final_ev(AudioSource s, std::string text, bool from_finalize = false,
                         bool speech_final = false) {
    TranscriptEvent e{s, std::move(text), true, 0};
    e.from_finalize = from_finalize;
    e.speech_final = speech_final;
    return e;
}

TranscriptEvent interim_ev(AudioSource s, std::string text) {
    return TranscriptEvent{s, std::move(text), false, 0};
}

TranscriptEvent turn_end(AudioSource s) {
    TranscriptEvent e{};
    e.source = s;
    e.kind = TranscriptKind::LocalTurnEnd;
    return e;
}

} // namespace

// ---------------------------------------------------------------- turns
TEST(TurnAssembler, FinalizeClosesTurnWithAllFinals) {
    TurnAssembler ta;
    EXPECT_TRUE(ta.on_event(interim_ev(AudioSource::Loopback, "qual"), 0).empty());
    EXPECT_TRUE(ta.on_event(final_ev(AudioSource::Loopback, "Qual é o prazo"), 100).empty());
    EXPECT_EQ(ta.live_text(AudioSource::Loopback), "Qual é o prazo");
    EXPECT_TRUE(ta.on_event(interim_ev(AudioSource::Loopback, "de entrega"), 150).empty());
    EXPECT_EQ(ta.live_text(AudioSource::Loopback), "Qual é o prazo de entrega");
    auto turns = ta.on_event(final_ev(AudioSource::Loopback, "de entrega?", true), 300);
    ASSERT_EQ(turns.size(), 1u);
    EXPECT_EQ(turns[0].text, "Qual é o prazo de entrega?");
    EXPECT_EQ(turns[0].source, AudioSource::Loopback);
    EXPECT_EQ(turns[0].start_ms, 0);
    EXPECT_EQ(turns[0].end_ms, 300);
    EXPECT_FALSE(ta.has_open_turn(AudioSource::Loopback));
}

TEST(TurnAssembler, SpeechFinalAloneDoesNotSplitTurn) {
    TurnAssembler ta;
    EXPECT_TRUE(ta.on_event(final_ev(AudioSource::Loopback, "Como vocês", false, true), 0).empty());
    EXPECT_TRUE(ta.on_event(final_ev(AudioSource::Loopback, "tratam a LGPD?", false, true), 400).empty());
    // Local VAD end + speech_final on the last final => closes immediately.
    auto turns = ta.on_event(turn_end(AudioSource::Loopback), 700);
    ASSERT_EQ(turns.size(), 1u);
    EXPECT_EQ(turns[0].text, "Como vocês tratam a LGPD?");
}

TEST(TurnAssembler, BoundaryGraceClosesWhenFinalizeNeverAnswers) {
    TurnAssemblerConfig cfg;
    cfg.boundary_grace_ms = 600;
    TurnAssembler ta{cfg};
    ta.on_event(final_ev(AudioSource::Loopback, "Tudo certo"), 0);
    ta.on_event(interim_ev(AudioSource::Loopback, "com o contrato"), 50);
    EXPECT_TRUE(ta.on_event(turn_end(AudioSource::Loopback), 100).empty());
    EXPECT_TRUE(ta.tick(600).empty());
    auto turns = ta.tick(700);
    ASSERT_EQ(turns.size(), 1u);
    EXPECT_EQ(turns[0].text, "Tudo certo com o contrato"); // unfinalized interim kept
}

TEST(TurnAssembler, StaleTimeoutClosesWithoutLocalBoundary) {
    TurnAssemblerConfig cfg;
    cfg.stale_ms = 2000;
    TurnAssembler ta{cfg};
    ta.on_event(final_ev(AudioSource::Microphone, "Deixa eu ver aqui"), 1000);
    EXPECT_TRUE(ta.tick(2900).empty());
    auto turns = ta.tick(3000);
    ASSERT_EQ(turns.size(), 1u);
    EXPECT_EQ(turns[0].source, AudioSource::Microphone);
}

TEST(TurnAssembler, LanesAreIndependent) {
    TurnAssembler ta;
    ta.on_event(final_ev(AudioSource::Loopback, "Pergunta dos outros"), 0);
    ta.on_event(final_ev(AudioSource::Microphone, "minha fala"), 10);
    auto t1 = ta.on_event(final_ev(AudioSource::Microphone, "", true), 20);
    ASSERT_EQ(t1.size(), 1u);
    EXPECT_EQ(t1[0].text, "minha fala");
    EXPECT_EQ(ta.live_text(AudioSource::Loopback), "Pergunta dos outros");
}

// ---------------------------------------------------------------- policy
TEST(DecisionPolicy, DetectsQuestionsInPortugueseAndEnglish) {
    EXPECT_TRUE(DecisionPolicy::looks_like_question("Qual é o prazo de entrega?"));
    EXPECT_TRUE(DecisionPolicy::looks_like_question("Como vocês fazem a integração com o ERP"));
    EXPECT_TRUE(DecisionPolicy::looks_like_question("Certo. E quanto custa a licença anual"));
    EXPECT_TRUE(DecisionPolicy::looks_like_question("Então, você já trabalhou com Kubernetes"));
    EXPECT_TRUE(DecisionPolicy::looks_like_question("É possível integrar com o SAP"));
    EXPECT_TRUE(DecisionPolicy::looks_like_question("Have you worked for Microsoft"));
    EXPECT_TRUE(DecisionPolicy::looks_like_question("So, could you walk me through it"));
    EXPECT_FALSE(DecisionPolicy::looks_like_question("Perfeito, vamos seguir com a proposta."));
    EXPECT_FALSE(DecisionPolicy::looks_like_question("Thanks, that makes sense."));
}

TEST(DecisionPolicy, IgnoresCourtesyQuestionsButNotTheRealOneAfterThem) {
    EXPECT_FALSE(DecisionPolicy::looks_like_question("Oi, tudo bem? Vi a proposta que vocês mandaram ontem."));
    EXPECT_FALSE(DecisionPolicy::looks_like_question("Bom dia pessoal, todo mundo me ouve?"
                                                     " Ok, todo mundo me ouve."));
    EXPECT_FALSE(DecisionPolicy::looks_like_question("Hi, how are you doing? Good to see you."));
    EXPECT_FALSE(DecisionPolicy::looks_like_question("Can you hear me? Great."));
    EXPECT_TRUE(DecisionPolicy::looks_like_question("Oi, tudo bem? Qual é o prazo de implantação?"));
    EXPECT_TRUE(DecisionPolicy::looks_like_question("Oi, tudo bem? Como vocês cobram a licença"));
    EXPECT_TRUE(DecisionPolicy::looks_like_question("Por que eu pagaria trinta por cento a mais?"));
    EXPECT_TRUE(DecisionPolicy::looks_like_question("Fala um pouco sobre a integração"));
}

TEST(DecisionPolicy, QuestionMayReplaceKeywordSuggestionInsideCooldown) {
    DecisionConfig cfg;
    cfg.cooldown_ms = 4000;
    DecisionPolicy p{cfg};
    Turn k{AudioSource::Loopback, "O preço de vocês está bem acima da alternativa.", 0, 1000, 1};
    EXPECT_EQ(p.evaluate(k, 1000), TriggerReason::Keyword);
    Turn k2{AudioSource::Loopback, "E o contrato também me preocupa bastante.", 1000, 2000, 2};
    EXPECT_EQ(p.evaluate(k2, 2000), TriggerReason::None); // keyword after keyword: cooldown
    Turn q{AudioSource::Loopback, "Por que eu pagaria trinta por cento a mais?", 2000, 3000, 3};
    EXPECT_EQ(p.evaluate(q, 3000), TriggerReason::Question);
    Turn q2{AudioSource::Loopback, "E qual é o prazo de implantação?", 3000, 4000, 4};
    EXPECT_EQ(p.evaluate(q2, 4000), TriggerReason::None); // question after question: cooldown
    p.note_manual(9000);
    Turn q3{AudioSource::Loopback, "Quanto custa a licença anual?", 9000, 10000, 5};
    EXPECT_EQ(p.evaluate(q3, 10000), TriggerReason::None); // manual starts a full cooldown
}

TEST(DecisionPolicy, TriggersOnOthersQuestionWithCooldown) {
    DecisionConfig cfg;
    cfg.cooldown_ms = 4000;
    DecisionPolicy p{cfg};
    Turn q{AudioSource::Loopback, "Qual é o prazo de implantação?", 0, 1000, 1};
    EXPECT_EQ(p.evaluate(q, 1000), TriggerReason::Question);
    Turn q2{AudioSource::Loopback, "E o suporte, como funciona?", 1500, 3000, 2};
    EXPECT_EQ(p.evaluate(q2, 3000), TriggerReason::None); // cooldown
    EXPECT_EQ(p.evaluate(q2, 5001), TriggerReason::Question);
}

TEST(DecisionPolicy, IgnoresOwnSpeechAndShortTurns) {
    DecisionPolicy p;
    Turn mine{AudioSource::Microphone, "Qual é o prazo de vocês?", 0, 100, 1};
    EXPECT_EQ(p.evaluate(mine, 100), TriggerReason::None);
    Turn short_turn{AudioSource::Loopback, "Certo?", 0, 100, 2};
    EXPECT_EQ(p.evaluate(short_turn, 100), TriggerReason::None);
}

TEST(DecisionPolicy, KeywordsMatchWholeWordsIgnoringAccents) {
    DecisionConfig cfg;
    cfg.keywords = {"Orçamento", "LGPD"};
    DecisionPolicy p{cfg};
    Turn t{AudioSource::Loopback, "Nosso ORCAMENTO para isso está apertado", 0, 100, 1};
    EXPECT_EQ(p.evaluate(t, 100), TriggerReason::Keyword);
    EXPECT_EQ(p.last_keyword(), "orcamento");
    EXPECT_FALSE(p.matched_keyword("orcamentos detalhados").has_value()); // whole word only
}

TEST(DecisionPolicy, AutoCanBeDisabled) {
    DecisionConfig cfg;
    cfg.auto_enabled = false;
    DecisionPolicy p{cfg};
    Turn q{AudioSource::Loopback, "Qual é o prazo de implantação?", 0, 100, 1};
    EXPECT_EQ(p.evaluate(q, 100), TriggerReason::None);
}

// ---------------------------------------------------------------- prompt
TEST(CopilotPrompt, QuotesTriggerVerbatimAndKeepsRecentHistory) {
    ConversationLog log;
    for (int i = 0; i < 50; ++i) {
        log.add(Turn{i % 2 ? AudioSource::Microphone : AudioSource::Loopback,
                     "fala numero " + std::to_string(i), i * 10, i * 10 + 5,
                     static_cast<std::uint64_t>(i)});
    }
    const std::string history = log.render(200);
    EXPECT_LE(history.size(), 200u);
    EXPECT_NE(history.find("fala numero 49"), std::string::npos); // newest kept
    EXPECT_EQ(history.find("fala numero 0\n"), std::string::npos);

    PromptConfig pc;
    pc.user_context = "Produto: RealTime AI. Plano Pro custa R$ 99.";
    auto msgs = build_copilot_messages(pc, history, "Have you worked for Microsoft?",
                                       TriggerReason::Question);
    ASSERT_EQ(msgs.size(), 2u);
    EXPECT_EQ(msgs[0].role, "system");
    EXPECT_NE(msgs[0].content.find("Nunca troque por outra pergunta"), std::string::npos);
    EXPECT_NE(msgs[1].content.find("\"Have you worked for Microsoft?\""), std::string::npos);
    // Static user notes are part of the cacheable system prefix now.
    EXPECT_NE(msgs[0].content.find("Plano Pro"), std::string::npos);
    EXPECT_EQ(msgs[1].content.find("Plano Pro"), std::string::npos);
}

// ----------------------------------------------- system prompt instructions
// The live answer starts with the question as understood ("PERGUNTA:") and
// then tells a STAR story as natural speech (no labels), grounded only in the
// session profile, the retrieved chunks and the transcript.
namespace {

std::string to_lower(std::string s) {
    for (auto& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

bool contains(const std::string& haystack, const std::string& needle) {
    return haystack.find(needle) != std::string::npos;
}

} // namespace

TEST(CopilotSystemPrompt, NaturalStarWithUnderstoodQuestionFirst) {
    const std::string p = copilot_system_prompt();
    // Header line with the reconstructed question, PT and EN.
    EXPECT_TRUE(contains(p, "Linha 1: PERGUNTA:"));
    EXPECT_TRUE(contains(p, "QUESTION:"));
    // STAR as flowing speech, labels forbidden.
    EXPECT_TRUE(contains(p, "STAR natural, sem rótulos"));
    EXPECT_TRUE(contains(p, "NÃO escreva os rótulos"));
    EXPECT_FALSE(contains(p, "**Situação:**"));
    const auto t = p.find("é a tese");
    const auto s = p.find("o contexto e o desafio");
    const auto a = p.find("o que EU fiz");
    const auto r = p.find("o resultado com o aprendizado");
    ASSERT_NE(t, std::string::npos);
    ASSERT_NE(s, std::string::npos);
    ASSERT_NE(a, std::string::npos);
    ASSERT_NE(r, std::string::npos);
    EXPECT_LT(t, s);
    EXPECT_LT(s, a);
    EXPECT_LT(a, r);
}

TEST(CopilotSystemPrompt, ReadsChoppyTranscriptAndSideTalk) {
    const std::string p = copilot_system_prompt();
    EXPECT_TRUE(contains(p, "COMO ENTENDER A TRANSCRIÇÃO"));
    EXPECT_TRUE(contains(p, "pode ser só o último pedaço"));
    EXPECT_TRUE(contains(p, "responda à versão corrigida"));
    EXPECT_TRUE(contains(p, "espera aí, amor"));
}

TEST(CopilotSystemPrompt, StarAlsoForTechnicalQuestionsWithoutFakeExperience) {
    const std::string lo = to_lower(copilot_system_prompt());
    EXPECT_TRUE(contains(lo, "pergunta técnica ou conceitual"));
    EXPECT_TRUE(contains(lo, "trade-offs"));
    // No real case in the context: hypothetical, never claimed as experience.
    EXPECT_TRUE(contains(lo, "ainda não vivi isso"));
    EXPECT_TRUE(contains(lo, "sem afirmar experiência"));
}

TEST(CopilotSystemPrompt, ShortSpeakableLength) {
    const std::string lo = to_lower(copilot_system_prompt());
    EXPECT_TRUE(contains(lo, "80 a 150 palavras"));
    EXPECT_TRUE(contains(lo, "frases curtas"));
}

// Use only transcript/context facts; never invent numbers, names, clients or
// experiences; qualitative result when there is no metric.
TEST(CopilotSystemPrompt, InstructsNoInventingFacts) {
    const std::string p = copilot_system_prompt();
    const std::string lo = to_lower(p);
    EXPECT_TRUE(contains(lo, "nunca invente")) << "no-inventing prohibition missing";
    EXPECT_TRUE(contains(lo, "números") && contains(lo, "nomes")
                && contains(lo, "clientes") && contains(lo, "experiências"))
        << "enumerated invented-fact categories missing";
    EXPECT_TRUE(contains(lo, "apenas fatos")) << "facts-only instruction missing";
    EXPECT_TRUE(contains(lo, "sem métrica no contexto"));
    EXPECT_TRUE(contains(lo, "empresa-alvo"));
}

// No candidate-specific facts may be hard-coded in the generic prompt.
TEST(CopilotSystemPrompt, HasNoHardCodedCandidateFacts) {
    const std::string p = copilot_system_prompt();
    EXPECT_FALSE(contains(p, "TechFinance"));
    EXPECT_FALSE(contains(p, "Midea"));
    EXPECT_FALSE(contains(p, "Tako"));
}

// The cached accessor must return the same instructions as the builder.
TEST(CopilotSystemPrompt, StaticAccessorMatchesBuilder) {
    EXPECT_EQ(copilot_system_prompt_static(), copilot_system_prompt());
}

// Split resolvers: the stable session profile goes in the system message (a
// cacheable prefix, identical between questions) and only the per-question
// retrieval goes in the user message.
TEST(CopilotPrompt, SessionProfileInSystemRetrievalInUser) {
    PromptConfig pc;
    int profile_calls = 0;
    std::string seen_q, seen_ctx;
    pc.session_profile = [&] { ++profile_calls; return std::string("PERFIL ESTAVEL XYZ"); };
    pc.rag_retrieve = [&](std::string_view q, std::string_view c) {
        seen_q = std::string(q);
        seen_ctx = std::string(c);
        return std::string("TRECHO SOBRE KAFKA");
    };
    const std::string history = "[Outros] Fale do seu projeto com Kafka.\n[Você] Claro.\n";
    auto a = build_copilot_messages(pc, history, "E como você escalou?", TriggerReason::Question);
    auto b = build_copilot_messages(pc, history, "Outra pergunta?", TriggerReason::Question);
    ASSERT_EQ(a.size(), 2u);
    EXPECT_EQ(a[0].content, b[0].content) << "system prefix must not change between questions";
    EXPECT_NE(a[0].content.find("PERFIL ESTAVEL XYZ"), std::string::npos);
    EXPECT_EQ(a[1].content.find("PERFIL ESTAVEL XYZ"), std::string::npos);
    EXPECT_NE(a[1].content.find("TRECHO SOBRE KAFKA"), std::string::npos);
    EXPECT_EQ(seen_q, "Outra pergunta?");
    // Retrieval context = only the interviewer's lines, not the candidate's.
    EXPECT_NE(seen_ctx.find("Fale do seu projeto com Kafka."), std::string::npos);
    EXPECT_EQ(seen_ctx.find("Claro."), std::string::npos);
    EXPECT_EQ(profile_calls, 2);
    EXPECT_NE(a[1].content.find("STAR natural, sem rótulos"), std::string::npos);
    EXPECT_NE(a[1].content.find("FALAS RECENTES DO ENTREVISTADOR"), std::string::npos);
}

TEST(Grounding, FlagsNumbersAbsentFromContext) {
    const std::string ctx = "Arquitetei o checkout com 45 mil requisições por segundo em 2024. Latência p99 de 18 ms.";
    // Grounded: 45 mil ~ 45.000, 2024, 18; ignored: single digit 3.
    EXPECT_TRUE(ungrounded_numbers("Atendemos 45.000 req/s em 2024 com p99 de 18 ms em 3 etapas.", ctx).empty());
    const auto bad = ungrounded_numbers("Reduzi a latência em 37% e economizei R$ 120 mil.", ctx);
    ASSERT_EQ(bad.size(), 2u);
    EXPECT_EQ(bad[0], "37");
    EXPECT_EQ(bad[1], "120");
}

// ---------------------------------------------------------------- engine
namespace {

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

std::shared_ptr<ScriptedLlmClient> fast_llm(std::chrono::milliseconds token_delay = 1ms) {
    ScriptedLlmClient::Options o;
    o.reply = "- Resposta curta\nInsight: teste";
    o.first_token_delay = 5ms;
    o.token_delay = token_delay;
    return std::make_shared<ScriptedLlmClient>(o);
}

} // namespace

TEST(CopilotEngine, OthersQuestionTriggersSuggestionWithVerbatimTrigger) {
    auto llm = fast_llm();
    CopilotEngine engine{fast_engine_config(), llm};
    auto col = std::make_shared<Collector>();
    engine.add_sink([col](const EngineEvent& e) { (*col)(e); });
    engine.start();

    engine.on_transcript(interim_ev(AudioSource::Loopback, "have you worked"));
    engine.on_transcript(final_ev(AudioSource::Loopback, "Have you worked for Microsoft?", true));

    ASSERT_TRUE(eventually([&] { return !col->all<SuggestionDoneEvent>().empty(); }));
    engine.stop();

    auto started = col->all<SuggestionStartedEvent>();
    ASSERT_EQ(started.size(), 1u);
    EXPECT_EQ(started[0].trigger_text, "Have you worked for Microsoft?"); // never rewritten
    EXPECT_EQ(started[0].reason, TriggerReason::Question);

    auto done = col->all<SuggestionDoneEvent>();
    EXPECT_EQ(done[0].status, LlmStatus::Completed);
    EXPECT_EQ(done[0].text, "- Resposta curta\nInsight: teste");
    EXPECT_EQ(done[0].trigger_text, "Have you worked for Microsoft?");

    std::string streamed;
    for (const auto& d : col->all<SuggestionDeltaEvent>()) streamed += d.text;
    EXPECT_EQ(streamed, done[0].text);

    const auto req = llm->last_request();
    ASSERT_EQ(req.messages.size(), 2u);
    EXPECT_NE(req.messages[1].content.find("\"Have you worked for Microsoft?\""), std::string::npos);

    EXPECT_EQ(col->all<TurnEvent>().size(), 1u);
    EXPECT_FALSE(col->all<TranscriptUpdateEvent>().empty());
}

TEST(CopilotEngine, OwnSpeechDoesNotTriggerAutomatically) {
    auto llm = fast_llm();
    CopilotEngine engine{fast_engine_config(), llm};
    auto col = std::make_shared<Collector>();
    engine.add_sink([col](const EngineEvent& e) { (*col)(e); });
    engine.start();
    engine.on_transcript(final_ev(AudioSource::Microphone, "Qual é o prazo de vocês?", true));
    ASSERT_TRUE(eventually([&] { return col->all<TurnEvent>().size() == 1; }));
    std::this_thread::sleep_for(50ms);
    engine.stop();
    EXPECT_TRUE(col->all<SuggestionStartedEvent>().empty());
    EXPECT_EQ(llm->started(), 0);
}

TEST(CopilotEngine, ManualTriggerUsesTextStillBeingSpoken) {
    auto llm = fast_llm();
    CopilotEngine engine{fast_engine_config(), llm};
    auto col = std::make_shared<Collector>();
    engine.add_sink([col](const EngineEvent& e) { (*col)(e); });
    engine.start();
    engine.on_transcript(final_ev(AudioSource::Loopback, "Quanto custa"));
    engine.on_transcript(interim_ev(AudioSource::Loopback, "a licença anual"));
    ASSERT_TRUE(eventually([&] { return !col->all<TranscriptUpdateEvent>().empty(); }));
    engine.request_suggestion();
    ASSERT_TRUE(eventually([&] { return !col->all<SuggestionStartedEvent>().empty(); }));
    engine.stop();
    auto started = col->all<SuggestionStartedEvent>();
    EXPECT_EQ(started[0].trigger_text, "Quanto custa a licença anual");
    EXPECT_EQ(started[0].reason, TriggerReason::Manual);
}

TEST(CopilotEngine, NewTriggerCancelsStreamingSuggestion) {
    ScriptedLlmClient::Options o;
    o.reply = std::string(200, 'x') + " fim";
    o.first_token_delay = 1ms;
    o.token_delay = 20ms;
    // One "word" per 20 ms -> long enough to be interrupted.
    o.reply.clear();
    for (int i = 0; i < 100; ++i) o.reply += "palavra ";
    auto llm = std::make_shared<ScriptedLlmClient>(o);
    CopilotEngine engine{fast_engine_config(), llm};
    auto col = std::make_shared<Collector>();
    engine.add_sink([col](const EngineEvent& e) { (*col)(e); });
    engine.start();

    engine.on_transcript(final_ev(AudioSource::Loopback, "Qual é o prazo de entrega?", true));
    ASSERT_TRUE(eventually([&] { return !col->all<SuggestionDeltaEvent>().empty(); }));
    engine.on_transcript(final_ev(AudioSource::Loopback, "E quanto custa a licença?", true));
    ASSERT_TRUE(eventually([&] { return col->all<SuggestionStartedEvent>().size() == 2; }));
    ASSERT_TRUE(eventually([&] {
        for (const auto& d : col->all<SuggestionDoneEvent>()) {
            if (d.id == 1) return true;
        }
        return false;
    }));
    engine.stop();
    llm->shutdown(1s);

    for (const auto& d : col->all<SuggestionDoneEvent>()) {
        if (d.id == 1) {
            EXPECT_EQ(d.status, LlmStatus::Cancelled);
            EXPECT_EQ(d.trigger_text, "Qual é o prazo de entrega?");
        }
    }
}

TEST(CopilotEngine, WithoutLlmStillPublishesTurnsAndWarnsOnManual) {
    CopilotEngine engine{fast_engine_config(), nullptr};
    auto col = std::make_shared<Collector>();
    engine.add_sink([col](const EngineEvent& e) { (*col)(e); });
    engine.start();
    EXPECT_FALSE(engine.llm_enabled());
    engine.on_transcript(final_ev(AudioSource::Loopback, "Qual é o prazo de entrega?", true));
    engine.request_suggestion();
    ASSERT_TRUE(eventually([&] { return !col->all<NoticeEvent>().empty(); }));
    engine.stop();
    EXPECT_EQ(col->all<TurnEvent>().size(), 1u);
    EXPECT_TRUE(col->all<SuggestionStartedEvent>().empty());
}

TEST(CopilotEngine, LocalTurnEndClosesTurnAfterGrace) {
    auto llm = fast_llm();
    CopilotEngine engine{fast_engine_config(), llm};
    auto col = std::make_shared<Collector>();
    engine.add_sink([col](const EngineEvent& e) { (*col)(e); });
    engine.start();
    engine.on_transcript(final_ev(AudioSource::Loopback, "Vocês têm suporte em português"));
    engine.on_transcript(turn_end(AudioSource::Loopback));
    ASSERT_TRUE(eventually([&] { return !col->all<SuggestionDoneEvent>().empty(); }));
    engine.stop();
    EXPECT_EQ(col->all<TurnEvent>()[0].turn.text, "Vocês têm suporte em português");
}

TEST(CopilotEngine, LinkStatusAndPauseArePublishedAndStopIsIdempotent) {
    CopilotEngine engine{fast_engine_config(), nullptr};
    auto col = std::make_shared<Collector>();
    engine.add_sink([col](const EngineEvent& e) { (*col)(e); });
    engine.start();
    TransportStatus st;
    st.source = AudioSource::Microphone;
    st.state = LinkState::Reconnecting;
    st.detail = "conexão perdida";
    engine.on_link_status(st);
    engine.set_paused(true);
    ASSERT_TRUE(eventually([&] {
        return !col->all<LaneStatusEvent>().empty() && !col->all<PauseEvent>().empty();
    }));
    engine.stop();
    engine.stop();
    const auto n = col->events.size();
    engine.on_transcript(final_ev(AudioSource::Loopback, "depois do stop", true));
    std::this_thread::sleep_for(30ms);
    EXPECT_EQ(col->events.size(), n); // nothing published after stop()
}

// ------------------------------------------- Pin on Speak: enqueue/replace
// Task 13.2 / Req 9.4, 9.6. The engine's route_suggestion() either replaces the
// visible card or enqueues a pending suggestion (SuggestionStartedEvent with
// enqueue == true) when the user is speaking (UserSpeechGate::should_pin()) or
// the 4000 ms window since the current card has not elapsed. When the window
// expires with no speech, the oldest pending suggestion is released
// (republished with enqueue == false and a fresh LLM call) so it replaces the
// card. A sub-300 ms voice burst never pins, so the current card survives.
namespace {

// Pin-on-Speak config: a small cooldown doubles as the 4000 ms "window" and the
// DecisionPolicy cooldown, so the tests can exercise both in well under a
// second while keeping the timing relationships intact.
CopilotConfig pin_engine_config(std::int64_t window_ms) {
    CopilotConfig cfg;
    cfg.tick = 10ms;
    cfg.decision.cooldown_ms = window_ms;
    cfg.turns.boundary_grace_ms = 50;
    return cfg;
}

} // namespace

// (1) Speech pins the current card: while should_pin() is true a new trigger is
// enqueued (enqueue == true) instead of replacing the visible card.
TEST(CopilotEngine, SpeechPinsCardSoNewTriggerIsEnqueued) {
    auto llm = fast_llm();
    CopilotEngine engine{pin_engine_config(150), llm};
    auto col = std::make_shared<Collector>();
    engine.add_sink([col](const EngineEvent& e) { (*col)(e); });
    engine.start();

    // First question fires a card normally (enqueue == false), opening the
    // window and starting one LLM call.
    engine.on_transcript(final_ev(AudioSource::Loopback, "Qual é o prazo de implantação?", true));
    ASSERT_TRUE(eventually([&] { return col->all<SuggestionStartedEvent>().size() == 1; }));
    EXPECT_FALSE(col->all<SuggestionStartedEvent>()[0].enqueue);

    // Hold push-to-talk: should_pin() is now true regardless of mic level.
    engine.set_ptt(true);

    // Wait past the DecisionPolicy cooldown so a second question is allowed to
    // fire, then publish it. Because the user is "speaking", it must be
    // enqueued rather than replace the card the user is reading aloud.
    std::this_thread::sleep_for(200ms);
    engine.on_transcript(final_ev(AudioSource::Loopback, "E quanto custa a licença anual?", true));

    ASSERT_TRUE(eventually([&] { return col->all<SuggestionStartedEvent>().size() == 2; }));
    // Keep push-to-talk held through stop(): while the user is speaking the
    // queued suggestion must stay pinned and never be promoted, so no third
    // SuggestionStartedEvent may appear.
    engine.stop();
    engine.set_ptt(false);

    auto started = col->all<SuggestionStartedEvent>();
    ASSERT_EQ(started.size(), 2u);
    EXPECT_FALSE(started[0].enqueue);
    EXPECT_TRUE(started[1].enqueue) << "a card the user reads aloud must not be replaced";
    EXPECT_EQ(started[1].trigger_text, "E quanto custa a licença anual?");
    EXPECT_EQ(started[1].reason, TriggerReason::Question);
    // The pinned suggestion is queued, not sent to the model: only the first
    // card ever reached the LLM.
    EXPECT_EQ(llm->started(), 1);
}

// (2) Window expiry promotes a pending suggestion: once the window elapses with
// no speech, the queued suggestion is released (enqueue == false) and started.
TEST(CopilotEngine, WindowExpiryReleasesPendingSuggestion) {
    auto llm = fast_llm();
    CopilotEngine engine{pin_engine_config(150), llm};
    auto col = std::make_shared<Collector>();
    engine.add_sink([col](const EngineEvent& e) { (*col)(e); });
    engine.start();

    engine.on_transcript(final_ev(AudioSource::Loopback, "Qual é o prazo de implantação?", true));
    ASSERT_TRUE(eventually([&] { return col->all<SuggestionStartedEvent>().size() == 1; }));

    // Pin with PTT and enqueue a second suggestion past the policy cooldown.
    engine.set_ptt(true);
    std::this_thread::sleep_for(200ms);
    engine.on_transcript(final_ev(AudioSource::Loopback, "E quanto custa a licença anual?", true));
    ASSERT_TRUE(eventually([&] {
        auto s = col->all<SuggestionStartedEvent>();
        return s.size() == 2 && s[1].enqueue;
    }));

    // Release speech. With no voice and the window elapsed, the periodic tick
    // (maybe_release_pending) republishes the queued suggestion so it replaces
    // the card: a third SuggestionStartedEvent, this time with enqueue == false
    // and backed by a real LLM call.
    engine.set_ptt(false);
    ASSERT_TRUE(eventually([&] {
        auto s = col->all<SuggestionStartedEvent>();
        return s.size() == 3;
    }));
    ASSERT_TRUE(eventually([&] { return llm->started() == 2; }));
    engine.stop();

    auto started = col->all<SuggestionStartedEvent>();
    ASSERT_EQ(started.size(), 3u);
    EXPECT_TRUE(started[1].enqueue);
    EXPECT_FALSE(started[2].enqueue) << "the released pending suggestion replaces the card";
    EXPECT_EQ(started[2].trigger_text, "E quanto custa a licença anual?");
    // The released suggestion actually reaches the model and completes.
    ASSERT_TRUE(eventually([&] { return !col->all<SuggestionDoneEvent>().empty(); }));
}

// (3) Short voice (< 300 ms) keeps the current card: a brief mic burst never
// makes should_pin() true, so once the window elapses the next trigger replaces
// the card normally (enqueue == false) instead of being pinned.
TEST(CopilotEngine, ShortVoiceDoesNotPinCurrentCard) {
    auto llm = fast_llm();
    CopilotEngine engine{pin_engine_config(120), llm};
    auto col = std::make_shared<Collector>();
    engine.add_sink([col](const EngineEvent& e) { (*col)(e); });
    engine.start();

    engine.on_transcript(final_ev(AudioSource::Loopback, "Qual é o prazo de implantação?", true));
    ASSERT_TRUE(eventually([&] { return col->all<SuggestionStartedEvent>().size() == 1; }));

    // A voice burst shorter than 300 ms: feed a couple of above-threshold mic
    // frames spanning well under 300 ms. The gate requires continuous voice for
    // >= 300 ms, so it never activates.
    engine.on_mic_rms(0.5f, 0.02f);
    std::this_thread::sleep_for(60ms);
    engine.on_mic_rms(0.5f, 0.02f);
    std::this_thread::sleep_for(60ms);
    engine.on_mic_rms(0.0f, 0.02f); // silence ends the short burst

    // Let the DecisionPolicy cooldown and the 4000 ms window both elapse. With
    // no pin active, the next question replaces the card normally.
    std::this_thread::sleep_for(180ms);
    engine.on_transcript(final_ev(AudioSource::Loopback, "E quanto custa a licença anual?", true));
    ASSERT_TRUE(eventually([&] { return col->all<SuggestionStartedEvent>().size() == 2; }));
    engine.stop();

    auto started = col->all<SuggestionStartedEvent>();
    ASSERT_EQ(started.size(), 2u);
    EXPECT_FALSE(started[0].enqueue);
    EXPECT_FALSE(started[1].enqueue) << "a sub-300 ms burst must not pin the card";
    EXPECT_EQ(started[1].trigger_text, "E quanto custa a licença anual?");
    // Both cards were real suggestions sent to the model; nothing was queued.
    EXPECT_EQ(llm->started(), 2);
}

TEST(MiniAgentRag, ProfileJsonRoundTripAndBm25Retrieval) {
    MiniAgentProfile p;
    p.name = "Entrevista Backend - Nubank";
    p.company = "Nubank";
    p.role = "Senior Software Engineer";
    p.calendar_event = "Entrevista Técnica - Nubank (22/10 14:00)";
    p.company_dossier = "Foco obsessivo no cliente, arquitetura em Clojure e Kafka, autonomia de squads.";
    p.custom_instructions = "Use método STAR e destaque experiência com sistemas financeiros distribuídos.";
    p.documents.push_back(RagDocument{
        "curriculo.md", "curriculo.md",
        "No Itaú liderei a migração do motor de pagamentos PIX usando Kafka e Go com latência p99 de 18 ms."
    });
    p.documents.push_back(RagDocument{
        "vaga.txt", "vaga.txt",
        "Requisitos da vaga: experiência com Kubernetes, observabilidade OpenTelemetry e resiliência em nuvem AWS."
    });

    const std::string json_str = p.to_json();
    auto restored = MiniAgentProfile::from_json(json_str);
    ASSERT_TRUE(restored.has_value());
    EXPECT_EQ(restored->company, "Nubank");
    EXPECT_EQ(restored->role, "Senior Software Engineer");
    ASSERT_EQ(restored->documents.size(), 2u);

    MiniAgentRag rag(*restored);
    EXPECT_GE(rag.chunk_count(), 3u);

    // Query about PIX / Kafka should rank curriculo.md first
    const auto chunks = rag.retrieve_chunks("Como foi sua experiência com pagamentos PIX e Kafka?", 2);
    ASSERT_FALSE(chunks.empty());
    EXPECT_NE(chunks[0]->text.find("PIX"), std::string::npos);

    // Full composed context includes company, cultural fit instructions, and RAG chunks
    PromptConfig pcfg;
    pcfg.dynamic_rag = [&rag](std::string_view q) { return rag.compose_context_for_query(q); };
    const auto msgs = build_copilot_messages(pcfg, "", "Como você trabalhou com Kafka no PIX?", TriggerReason::Question);
    ASSERT_EQ(msgs.size(), 2u);
    EXPECT_NE(msgs[1].content.find("Nubank"), std::string::npos);
    EXPECT_NE(msgs[1].content.find("PIX"), std::string::npos);
    EXPECT_NE(msgs[1].content.find("STAR"), std::string::npos);
}

TEST(MiniAgentRag, DeepMiniCompactAlwaysSentAndRagDecidesAutonomously) {
    MiniAgentProfile p;
    p.name = "Entrevista Arquitetura - Mercado Livre";
    p.company = "Mercado Livre";
    p.role = "Staff Software Engineer";
    p.company_dossier = "Cultura de empreendedorismo, escala continental e alta disponibilidade.";
    p.custom_instructions = "Mantenha a persona de Staff Engineer focada em resiliência e trade-offs claros.";
    p.documents.push_back(RagDocument{
        "projeto_checkout.md", "projeto_checkout.md",
        "Arquitetei o serviço de Checkout Distribuído em Go e DynamoDB suportando 45 mil requisições por segundo na Black Friday com zero downtime."
    });

    MiniAgentRag rag(p);
    const std::string compact = rag.mini_compact();
    EXPECT_NE(compact.find("[1. Persona & Alvo da Entrevista]"), std::string::npos);
    EXPECT_NE(compact.find("[4. Leitura Aprofundada dos Arquivos Enviados"), std::string::npos);
    EXPECT_NE(compact.find("[5. Mapa de Assuntos no RAG"), std::string::npos);
    EXPECT_NE(compact.find("Checkout Distribuído"), std::string::npos);

    // 1. Short turn that does not require extra RAG chunks -> Mini-Compact is STILL present,
    //    and autonomous RAG decision marks needed = false.
    const auto dec_short = rag.decide_rag_for_query("ok obrigado");
    EXPECT_FALSE(dec_short.needed);
    const std::string ctx_short = rag.compose_context_for_query("ok obrigado");
    EXPECT_NE(ctx_short.find("MINI-COMPACT SEMPRE PRESENTE"), std::string::npos);
    EXPECT_NE(ctx_short.find("DECISÃO AUTÔNOMA DO RAG"), std::string::npos);

    // 2. Specific technical question -> Mini-Compact is present AND RAG autonomously expands chunks.
    const auto dec_tech = rag.decide_rag_for_query("Como você desenhou o serviço de Checkout em DynamoDB para a Black Friday?");
    EXPECT_TRUE(dec_tech.needed);
    EXPECT_FALSE(dec_tech.chunks.empty());
    const std::string ctx_tech = rag.compose_context_for_query("Como você desenhou o serviço de Checkout em DynamoDB para a Black Friday?");
    EXPECT_NE(ctx_tech.find("MINI-COMPACT SEMPRE PRESENTE"), std::string::npos);
    EXPECT_NE(ctx_tech.find("Trechos recuperados dos arquivos enviados"), std::string::npos);
    EXPECT_NE(ctx_tech.find("45 mil"), std::string::npos);
}

TEST(CopilotEngine, ReusesConversationAndPriorDeliveredAnswersForPersonaCoherence) {
    auto llm = fast_llm();
    CopilotEngine engine{fast_engine_config(), llm};
    auto col = std::make_shared<Collector>();
    engine.add_sink([col](const EngineEvent& e) { (*col)(e); });
    engine.start();

    // Turn 1: Interviewer asks first question -> copilot generates answer #1
    engine.on_transcript(final_ev(AudioSource::Loopback, "Qual foi o principal projeto que você liderou recentemente?", true));
    ASSERT_TRUE(eventually([&] { return col->all<SuggestionDoneEvent>().size() == 1; }));

    // Candidate speaks in between
    engine.on_transcript(final_ev(AudioSource::Microphone, "Eu liderei a migração do motor PIX.", true));
    ASSERT_TRUE(eventually([&] { return col->all<TurnEvent>().size() == 2; }));

    // Turn 2: Interviewer asks follow-up question -> prompt MUST contain both the conversation
    // transcript AND the previously delivered suggestion #1 so persona & facts stay coherent.
    engine.on_transcript(final_ev(AudioSource::Loopback, "E quais foram os maiores desafios técnicos dessa migração?", true));
    ASSERT_TRUE(eventually([&] { return col->all<SuggestionDoneEvent>().size() == 2; }));
    engine.stop();

    const auto req = llm->last_request();
    ASSERT_EQ(req.messages.size(), 2u);
    EXPECT_NE(req.messages[1].content.find("[Outros] Qual foi o principal projeto que você liderou recentemente?"), std::string::npos);
    EXPECT_NE(req.messages[1].content.find("[Você] Eu liderei a migração do motor PIX."), std::string::npos);
    EXPECT_NE(req.messages[1].content.find("[Minhas Respostas já Faladas pelo Microfone ([Você]) nesta Entrevista"), std::string::npos);
    EXPECT_NE(req.messages[1].content.find("[Histórico de Respostas já Sugeridas pelo Copiloto nesta Sessão"), std::string::npos);
    EXPECT_NE(req.messages[1].content.find("Resposta curta"), std::string::npos);
}

TEST(MiniAgentRag, Sol61MediumConfigAndElectronDashboardSchemaCompatibility) {
    EXPECT_STREQ(MiniAgentProfile::kCompactAnalysisModel, "qwen/qwen3.6-flash");
    EXPECT_STREQ(MiniAgentProfile::kCompactAnalysisEffort, "none");

    const char* electron_json = R"({
      "id": "entrevista-tako",
      "name": "Entrevista com IA",
      "company": "https://tako.ai/pt/",
      "role": "Engenheiro de IA",
      "job_description": "Agentes de IA e RAG de baixa latência",
      "extra_instructions": "Responda com método STAR sem inventar fatos.",
      "company_research": "Plataforma Tako AI voltada a automação inteligente.",
      "documents": [
        {
          "title": "Curriculo_Bruno.pdf",
          "tag": "resume",
          "content": "Desenvolvi o projeto RealTimeAI em C++20 com WASAPI, Deepgram Nova-3 e RAG local."
        }
      ]
    })";

    auto parsed = MiniAgentProfile::from_json(electron_json);
    ASSERT_TRUE(parsed.has_value());
    EXPECT_EQ(parsed->id, "entrevista-tako");
    EXPECT_EQ(parsed->company, "https://tako.ai/pt/");
    EXPECT_EQ(parsed->job_description, "Agentes de IA e RAG de baixa latência");
    EXPECT_EQ(parsed->custom_instructions, "Responda com método STAR sem inventar fatos.");
    EXPECT_EQ(parsed->company_dossier, "Plataforma Tako AI voltada a automação inteligente.");
    ASSERT_EQ(parsed->documents.size(), 1u);
    EXPECT_EQ(parsed->documents[0].name, "Curriculo_Bruno.pdf");

    MiniAgentRag rag(*parsed);
    const std::string ctx = rag.compose_context_for_query("Fale sobre o seu projeto em C++20");
    EXPECT_NE(ctx.find("REGRA DE OURO ANTI-ALUCINAÇÃO"), std::string::npos);
    EXPECT_NE(ctx.find("RealTimeAI"), std::string::npos);
    EXPECT_NE(ctx.find("Curriculo_Bruno.pdf"), std::string::npos);
}

// ===========================================================================
// Two-turn integration flow and context switch (Task 4.4 / Requirements 2.1 - 2.5)
// ===========================================================================

TEST(CopilotEngineIntegration, TwoTurnSubjectFusionBothPaths) {
    auto llm = fast_llm();
    CopilotConfig cfg = fast_engine_config();
    cfg.allow_speculative = true;
    cfg.turns.speculative_pause_ms = 0; // immediate speculative candidate
    CopilotEngine engine{cfg, llm};
    auto col = std::make_shared<Collector>();
    engine.add_sink([col](const EngineEvent& e) { (*col)(e); });
    engine.start();

    // Turn 1: subject-bearing utterance from recruiter
    const std::string subject_turn = "Pensando agora na competição em que desenvolveu o Tech Finance";
    engine.on_transcript(final_ev(AudioSource::Loopback, subject_turn, true, true));
    ASSERT_TRUE(eventually([&] { return !col->all<TurnEvent>().empty(); }));

    // Turn 2: interim arriving within fusion window
    const std::string follow_up = "como você decidiu o que fazer primeiro?";
    engine.on_transcript(interim_ev(AudioSource::Loopback, follow_up));

    // Speculative candidate fired
    ASSERT_TRUE(eventually([&] { return !col->all<SpeculativeCandidateEvent>().empty(); }));
    const auto spec_cands = col->all<SpeculativeCandidateEvent>();
    ASSERT_FALSE(spec_cands.empty());
    // The overlay candidate event displays the literal trigger utterance:
    EXPECT_EQ(spec_cands.front().text, follow_up);

    // Assert the LLM request generated on the speculative path contains the subject
    ASSERT_TRUE(eventually([&] { return llm->started() > 0; }));
    LlmRequest spec_req = llm->last_request();
    ASSERT_GE(spec_req.messages.size(), 2u);
    EXPECT_NE(spec_req.messages[1].content.find("Tech Finance"), std::string::npos)
        << "Speculative LLM request missing subject!";
    EXPECT_NE(spec_req.messages[1].content.find("como você decidiu o que fazer primeiro?"), std::string::npos)
        << "Speculative LLM request missing follow-up utterance!";

    // Turn 2 closes: matches speculative trigger
    engine.on_transcript(final_ev(AudioSource::Loopback, follow_up, true, true));
    ASSERT_TRUE(eventually([&] { return !col->all<SuggestionDoneEvent>().empty(); }));

    engine.stop();
    llm->shutdown(1s);
}

TEST(CopilotEngineIntegration, ContextSwitchTargetCompanyVsCandidateProject) {
    MiniAgentProfile prof;
    prof.company = "Tako";
    prof.company_dossier = "Dossiê Tako: Plataforma de folha determinística e eSocial.";
    RagDocument doc;
    doc.name = "Midea";
    doc.content = "PoC de Speech-to-Text na UNIFEI em parceria com a Midea Carrier para transcrição de áudio em fábrica.";
    prof.documents.push_back(std::move(doc));

    MiniAgentRag rag{prof};

    // 1) Target company query
    const std::string q_comp = "Como funciona a folha determinística da empresa?";
    EXPECT_FALSE(rag.cites_candidate_project(q_comp));
    const auto dec_comp = rag.decide_rag_for_query(q_comp, 4);
    ASSERT_FALSE(dec_comp.chunks.empty());
    EXPECT_TRUE(dec_comp.chunks.front()->is_cultural_or_company);

    // 2) Candidate project query
    const std::string q_proj = "Passando ao projeto Midea, como foi a transcrição de áudio?";
    EXPECT_TRUE(rag.cites_candidate_project(q_proj));
    const auto dec_proj = rag.decide_rag_for_query(q_proj, 4);
    ASSERT_FALSE(dec_proj.chunks.empty());
    EXPECT_EQ(dec_proj.chunks.front()->source, "Midea");
    EXPECT_TRUE(dec_proj.chunks.front()->is_candidate_project);
    EXPECT_FALSE(dec_proj.chunks.front()->is_cultural_or_company);

    // Context composition never describes target company product as candidate work
    const std::string ctx = rag.compose_context_for_query(q_proj);
    EXPECT_NE(ctx.find("Midea"), std::string::npos);
    EXPECT_NE(ctx.find("REGRA DE OURO ANTI-ALUCINAÇÃO"), std::string::npos);
    EXPECT_NE(ctx.find("DISTINÇÃO CRÍTICA ENTRE EMPRESA-ALVO E PROJETOS DO CANDIDATO"), std::string::npos);
}

TEST(CopilotEngineIntegration, DeepReadingObservableFallbackOnFailure) {
    MiniAgentProfile prof;
    prof.company = "Tako";
    prof.company_dossier = "Dossiê Tako";
    RagDocument doc;
    doc.name = "Doc1";
    doc.content = "Conteúdo de teste para resumo";
    prof.documents.push_back(std::move(doc));

    auto agent_rag = std::make_shared<MiniAgentRag>(prof);

    auto llm = fast_llm();
    CopilotConfig cfg = fast_engine_config();
    auto engine = std::make_shared<CopilotEngine>(cfg, llm);
    auto col = std::make_shared<Collector>();
    engine->add_sink([col](const EngineEvent& e) { (*col)(e); });
    engine->start();

    // Simulate the deep reading on_done callback failure branch (as wired in main.cpp)
    std::shared_ptr<std::string> deep_compact_buf = std::make_shared<std::string>();
    std::weak_ptr<CopilotEngine> weak_eng = engine;

    auto on_done_sim = [agent_rag, deep_compact_buf, weak_eng](const LlmResult& r) {
        const std::string trimmed_buf = text::trim(*deep_compact_buf);
        if (r.status == LlmStatus::Completed && !trimmed_buf.empty()) {
            std::string combined = trimmed_buf + "\n\n" + agent_rag->synthesize_deep_mini_compact();
            agent_rag->set_mini_compact(text::truncate_utf8(combined, 3400));
            if (auto eng = weak_eng.lock()) {
                eng->notify(NoticeLevel::Info, "Análise & Mini-Compact concluídos.");
            }
        } else {
            std::string err = r.error.empty() ? (r.status == LlmStatus::Cancelled ? "cancelado" : "resposta vazia") : r.error;
            if (auto eng = weak_eng.lock()) {
                eng->notify(NoticeLevel::Warning,
                            "Mini-Compact profundo indisponível (modelo '" +
                            std::string(MiniAgentProfile::kCompactAnalysisModel) +
                            "' falhou: " + err + "); usando resumo sintético local.");
            }
        }
    };

    // Trigger failure simulation
    LlmResult fail_res;
    fail_res.status = LlmStatus::Failed;
    fail_res.error = "model_not_found";
    on_done_sim(fail_res);

    ASSERT_TRUE(eventually([&] {
        auto notices = col->all<NoticeEvent>();
        return !notices.empty() && notices.front().level == NoticeLevel::Warning;
    }));

    const auto notices = col->all<NoticeEvent>();
    EXPECT_NE(notices.front().text.find("Mini-Compact profundo indisponível"), std::string::npos);
    EXPECT_NE(notices.front().text.find("model_not_found"), std::string::npos);
    EXPECT_NE(notices.front().text.find(MiniAgentProfile::kCompactAnalysisModel), std::string::npos);

    engine->stop();
    llm->shutdown(1s);
}

