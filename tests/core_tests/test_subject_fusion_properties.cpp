// Property-based and unit tests for Subject Fusion & Context-Aware Trigger Resolution.
// Validates: Requirements 1.1, 1.2, 2.1, 2.2, 3.1, 3.2, 3.4, 3.6
//
// Property 1 (Bug Condition):
// When two consecutive Loopback turns occur where prev carries the subject and
// curr is a follow-up question within the fusion window (< 6000 ms), the trigger
// sent to the LLM on BOTH the speculative path and the closed-turn path MUST
// contain the subject from prev AND the utterance from curr.
//
// Property 2 (Preservation):
// For all non-subject-bearing inputs (single-clause, small-talk, out-of-window,
// or mic turns), the trigger is untouched (equals curr byte-for-byte), and existing
// TurnAssembler stitching (< 1200 ms) and DecisionPolicy semantics are preserved.
#include <gtest/gtest.h>

#include <chrono>
#include <memory>
#include <mutex>
#include <random>
#include <string>
#include <string_view>
#include <vector>

#include "fake_websocket.hpp"
#include "rtai/copilot_engine.hpp"
#include "rtai/decision_policy.hpp"
#include "rtai/scripted_llm.hpp"
#include "rtai/subject_fusion.hpp"
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

CopilotConfig speculative_engine_config() {
    CopilotConfig cfg;
    cfg.tick = 5ms;
    cfg.decision.cooldown_ms = 0;
    cfg.turns.boundary_grace_ms = 450;
    cfg.turns.speculative_pause_ms = 0; // immediate speculative candidate on interim
    cfg.allow_speculative = true;
    return cfg;
}

std::shared_ptr<ScriptedLlmClient> make_test_llm() {
    ScriptedLlmClient::Options o;
    o.reply = "- Resposta de teste para sugestao do copiloto.";
    o.first_token_delay = 2ms;
    o.token_delay = 2ms;
    return std::make_shared<ScriptedLlmClient>(o);
}

} // namespace

// ===========================================================================
// Task 1 / Property 1: Bug Condition Exploration Tests (MUST FAIL on unfixed code)
// ===========================================================================

// Symptom A (multiClauseSplit on speculative path):
// When the recruiter asks a question split into two clauses:
// Prev: "Pensando agora na competição em que desenvolveu o Tech Finance" (closed)
// Curr interim: "como você decidiu o que fazer primeiro?" (gap ~ 600 ms)
// Expected behavior: the LLM request triggered on the speculative path MUST
// contain the subject ("Tech Finance") AND the follow-up text ("como você decidiu o que fazer primeiro?").
// Counterexample on unfixed code: speculative path uses only the raw interim,
// completely losing "Tech Finance".
TEST(SubjectFusionProperties, SpeculativePathEnrichesSubjectBearingTurn) {
    auto llm = make_test_llm();
    CopilotEngine engine{speculative_engine_config(), llm};
    auto col = std::make_shared<Collector>();
    engine.add_sink([col](const EngineEvent& e) { (*col)(e); });
    engine.start();

    // Turn 1: subject-bearing utterance from recruiter [Outros]
    const std::string turn1_text = "Pensando agora na competição em que desenvolveu o Tech Finance";
    engine.on_transcript(final_ev(AudioSource::Loopback, turn1_text, true, true));
    ASSERT_TRUE(eventually([&] {
        return !col->all<TurnEvent>().empty();
    }, 1500ms)) << "Turn 1 did not close in time";

    // Gap between clauses (~600 ms, within 6000 ms fusion window)
    std::this_thread::sleep_for(50ms);

    // Turn 2: second clause arrives as interim, triggering speculation
    const std::string turn2_interim = "como você decidiu o que fazer primeiro?";
    engine.on_transcript(interim_ev(AudioSource::Loopback, turn2_interim));

    // Speculative candidate must fire
    ASSERT_TRUE(eventually([&] {
        return !col->all<SpeculativeCandidateEvent>().empty();
    }, 2000ms)) << "Speculative candidate never fired";

    // Wait for the LLM request to be dispatched
    ASSERT_TRUE(eventually([&] {
        return llm->started() > 0;
    }, 2000ms)) << "LLM request was not dispatched";

    engine.stop();
    llm->shutdown(1s);

    // Check what was sent to the LLM as the trigger on the speculative path:
    const LlmRequest req = llm->last_request();
    ASSERT_GE(req.messages.size(), 2u);
    const auto& user_msg = req.messages[1].content;
    const std::string marker = "Fala que disparou a resposta (transcrição literal, pode ser só o último pedaço):\n\"";
    const auto pos = user_msg.find(marker);
    ASSERT_NE(pos, std::string::npos);
    const std::string trigger_in_prompt = user_msg.substr(pos + marker.size());

    // On UNFIXED code: enter_speculating / on_speculative passes c.text directly
    // without calling enrich_trigger_with_subject, so trigger_in_prompt is ONLY
    // "como você decidiu o que fazer primeiro?\"" and is missing "Tech Finance"!
    EXPECT_NE(trigger_in_prompt.find("Tech Finance"), std::string::npos)
        << "COUNTEREXAMPLE (Symptom A): Speculative trigger is missing subject 'Tech Finance'! Trigger in prompt was: "
        << trigger_in_prompt;
    EXPECT_NE(trigger_in_prompt.find("como você decidiu"), std::string::npos)
        << "Speculative trigger is missing follow-up utterance!";
}

// Fragile-heuristic counterexample:
// Today's inline heuristic uses `pf.find("no ") != npos`.
// A non-subject utterance such as "o time economizou tempo no onboarding" triggers
// a false-positive match because of "no " in the middle of a past-tense sentence.
// Expected behavior: is_subject_bearing MUST return false.
// Counterexample on unfixed code: returns true due to raw substring search.
TEST(SubjectFusionProperties, FragileSubstringHeuristicFalseMatch) {
    const std::string non_subject = "o time economizou tempo no onboarding";
    // Expected behavior: this is a plain past-tense statement, NOT introducing a topic/subject.
    // On UNFIXED code, pf.find("no ") matches "no onboarding", returning true!
    EXPECT_FALSE(is_subject_bearing(non_subject))
        << "COUNTEREXAMPLE (Fragile Heuristic): 'o time economizou tempo no onboarding' falsely matched as subject-bearing!";
}

// Scoped PBT for expected subject fusion:
// For any subject-bearing prev turn and curr turn within the fusion window (< 6000 ms),
// enrich_trigger_with_subject MUST contain both the subject and curr.
TEST(SubjectFusionProperties, SubjectFusionRandomizedPairs) {
    std::mt19937 rng(0x5EED0F01u);

    const std::vector<std::pair<std::string, std::string>> subject_bearing_cases = {
        {"Pensando agora no Tech Finance", "Tech Finance"},
        {"Sobre o projeto Midea", "Midea"},
        {"Passando ao projeto de transcrição", "projeto de transcrição"},
        {"Falando da arquitetura do sistema", "arquitetura"},
        {"Considerando a competição", "competição"}
    };

    const std::vector<std::string> follow_up_questions = {
        "como você decidiu o que fazer primeiro?",
        "qual foi o principal desafio técnico?",
        "quais métricas você acompanhou?",
        "como a equipe dividiu as tarefas?"
    };

    std::uniform_int_distribution<std::size_t> subj_dist(0, subject_bearing_cases.size() - 1);
    std::uniform_int_distribution<std::size_t> q_dist(0, follow_up_questions.size() - 1);
    std::uniform_int_distribution<std::int64_t> gap_dist(50, 4000); // well within 6000ms

    constexpr int kTrials = 50;
    for (int t = 0; t < kTrials; ++t) {
        const auto& [prev_text, expected_keyword] = subject_bearing_cases[subj_dist(rng)];
        const auto& curr_text = follow_up_questions[q_dist(rng)];
        const std::int64_t gap = gap_dist(rng);

        Turn prev;
        prev.source = AudioSource::Loopback;
        prev.text = prev_text;
        prev.start_ms = 0;
        prev.end_ms = 1000;

        const std::string enriched = enrich_trigger_with_subject(prev, curr_text, gap);

        EXPECT_NE(enriched.find(expected_keyword), std::string::npos)
            << "trial " << t << ": enriched trigger missing keyword '" << expected_keyword << "'";
        EXPECT_NE(enriched.find(curr_text), std::string::npos)
            << "trial " << t << ": enriched trigger missing curr utterance";
    }
}

// ===========================================================================
// Task 2 / Property 2: Preservation Property Tests (MUST PASS on unfixed code)
// ===========================================================================

// Preservation 1: Single clause / no subject / gap > window
// For all non-subject-bearing prev (small-talk, empty, out of window > 6000ms, or Microphone),
// enrich_trigger_with_subject MUST return curr byte-for-byte unchanged.
TEST(SubjectFusionProperties, PreservationSingleClauseAndOutOfWindow) {
    std::mt19937 rng(0x5EED0F02u);

    const std::vector<std::string> non_subject_pool = {
        "Beleza.", "Tudo bem?", "Entendi.", "Perfeito.", "Obrigado.",
        "Certo.", "Ok.", "Com certeza.", "Exatamente."
    };

    const std::vector<std::string> curr_questions = {
        "Qual é o prazo de entrega?",
        "Como funciona o onboarding?",
        "Qual o valor da mensalidade?",
        "Quem é o responsável pela equipe?"
    };

    std::uniform_int_distribution<std::size_t> ns_dist(0, non_subject_pool.size() - 1);
    std::uniform_int_distribution<std::size_t> curr_dist(0, curr_questions.size() - 1);

    // Case 1: prev is nullopt -> curr unchanged
    for (const auto& q : curr_questions) {
        EXPECT_EQ(enrich_trigger_with_subject(std::nullopt, q, 500), q);
    }

    // Case 2: prev is from Microphone -> curr unchanged
    for (const auto& q : curr_questions) {
        Turn prev;
        prev.source = AudioSource::Microphone;
        prev.text = "Pensando no Tech Finance";
        EXPECT_EQ(enrich_trigger_with_subject(prev, q, 500), q);
    }

    // Case 3: gap exceeds fusion window (e.g. 8000 ms >= 6000 ms) -> curr unchanged
    for (const auto& q : curr_questions) {
        Turn prev;
        prev.source = AudioSource::Loopback;
        prev.text = "Pensando no Tech Finance";
        EXPECT_EQ(enrich_trigger_with_subject(prev, q, 8000), q);
    }

    // Case 4: negative gap -> curr unchanged
    for (const auto& q : curr_questions) {
        Turn prev;
        prev.source = AudioSource::Loopback;
        prev.text = "Pensando no Tech Finance";
        EXPECT_EQ(enrich_trigger_with_subject(prev, q, -1), q);
    }

    // Case 5: randomized non-subject small-talk
    for (int t = 0; t < 50; ++t) {
        Turn prev;
        prev.source = AudioSource::Loopback;
        prev.text = non_subject_pool[ns_dist(rng)];
        const auto& q = curr_questions[curr_dist(rng)];
        // Even with a small gap, small-talk must not fuse
        EXPECT_EQ(enrich_trigger_with_subject(prev, q, 500), q)
            << "small-talk '" << prev.text << "' was incorrectly fused";
    }
}

// Preservation 2: TurnAssembler stitching unchanged
// Two finals on the same lane before turn close must continue to be assembled/stitched into one turn.
TEST(SubjectFusionProperties, PreservationTurnAssemblerStitching) {
    TurnAssembler ta;
    EXPECT_TRUE(ta.on_event(final_ev(AudioSource::Loopback, "Primeira parte da fala", false, true), 0).empty());
    EXPECT_TRUE(ta.on_event(final_ev(AudioSource::Loopback, "segunda parte da fala", false, true), 400).empty());
    auto turns = ta.on_event(turn_end(AudioSource::Loopback), 700);
    ASSERT_EQ(turns.size(), 1u);
    EXPECT_EQ(turns[0].text, "Primeira parte da fala segunda parte da fala");
}

// Preservation 3: DecisionPolicy evaluation untouched
// Keyword triggers, question detection, and Pin-on-Speak cooldown logic are preserved.
TEST(SubjectFusionProperties, PreservationDecisionPolicyUnchanged) {
    DecisionConfig cfg;
    cfg.auto_enabled = true;
    cfg.cooldown_ms = 4000;
    cfg.keywords = {"orçamento", "contrato"};

    DecisionPolicy policy{cfg};

    Turn t1{AudioSource::Loopback, "Qual é o prazo de entrega previsto?", 0, 1000, 1};
    EXPECT_EQ(policy.evaluate(t1, 1000), TriggerReason::Question);

    // During cooldown, a non-upgraded statement is blocked
    Turn t2{AudioSource::Loopback, "Perfeito, entendido.", 1500, 2000, 2};
    EXPECT_EQ(policy.evaluate(t2, 2000), TriggerReason::None);

    // Keyword match works
    Turn t3{AudioSource::Loopback, "Vamos falar sobre o orçamento do projeto", 6000, 7000, 3};
    EXPECT_EQ(policy.evaluate(t3, 7000), TriggerReason::Keyword);
}
