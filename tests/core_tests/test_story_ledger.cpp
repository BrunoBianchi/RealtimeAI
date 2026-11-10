// Story ledger (rtai/story_ledger.hpp): what was already claimed stays for
// the whole session, on any subject, and reaches the next session of the
// same goal. Also json::patch_top_level, which stores it in the goal file
// without touching the dashboard's fields.
#include <gtest/gtest.h>

#include <string>

#include "rtai/copilot_prompt.hpp"
#include "rtai/json_min.hpp"
#include "rtai/story_ledger.hpp"

using namespace rtai;

namespace {

const char* kQ1 = "Conte sobre um projeto onde você trabalhou em equipe.";
const char* kA1 =
    "Trabalho bem em equipe quando o objetivo está claro. Um exemplo foi o hackathon da Ninja Startup, onde eu "
    "liderei o alinhamento técnico com **WebSocket** e Docker e ganhamos o primeiro lugar.";
const char* kQ2 = "Por que você quer trabalhar no iFood?";
const char* kA2 = "Porque o iFood resolve logística em escala, que é o que eu mais gosto de fazer.";

} // namespace

TEST(StoryLedger, EmptyLedgerRendersNothing) {
    StoryLedger l;
    EXPECT_TRUE(l.empty());
    EXPECT_EQ(l.render(), "");
    EXPECT_EQ(l.persistable(), "");
    EXPECT_FALSE(l.needs_compaction());
}

TEST(StoryLedger, KeepsEveryAnswerAcrossSubjects) {
    StoryLedger l;
    EXPECT_TRUE(l.add(kQ1, kA1));
    EXPECT_TRUE(l.add(kQ2, kA2)); // another subject: the first story stays
    const std::string r = l.render();
    EXPECT_NE(r.find("Ninja Startup"), std::string::npos) << r;
    EXPECT_NE(r.find("iFood resolve"), std::string::npos) << r;
    EXPECT_LT(r.find("Ninja Startup"), r.find("iFood resolve")) << "oldest first";
    EXPECT_EQ(r.find("**"), std::string::npos) << "bold marks are not part of what was said";
}

TEST(StoryLedger, IgnoresEmptyAnswersAndUpdatesARepeatedQuestion) {
    StoryLedger l;
    EXPECT_FALSE(l.add(kQ1, "   "));
    EXPECT_FALSE(l.add("", kA1));
    l.add(kQ1, "Primeira versão.");
    l.add(kQ1, "Segunda versão.");
    EXPECT_EQ(l.size(), 1u);
    EXPECT_NE(l.render().find("Segunda versão."), std::string::npos);
    EXPECT_EQ(l.render().find("Primeira versão."), std::string::npos);
}

TEST(StoryLedger, OpeningCutsAtASentenceEnd) {
    const std::string a = "Sim, usei Kafka por dois anos. No TechFinance eu desenhei o pipeline de eventos que "
                          "processava os pagamentos e reduzi a latência com particionamento por conta do cliente.";
    const std::string o = StoryLedger::opening(a, 60);
    EXPECT_EQ(o, "Sim, usei Kafka por dois anos.");
    // No sentence end early enough: cut with an ellipsis, never mid code point.
    const std::string long_one = "Ação ação ação ação ação ação ação ação ação ação ação ação ação ação ação";
    const std::string cut = StoryLedger::opening(long_one, 30);
    EXPECT_LE(cut.size(), 33u);
    EXPECT_EQ(cut.substr(cut.size() - 3), "...");
    EXPECT_FALSE(text::sanitize_utf8(cut).empty());
}

TEST(StoryLedger, LatestEntryAlwaysFitsAndOldOnesDropFromThePrompt) {
    StoryLedgerConfig cfg;
    cfg.prompt_chars = 420;
    StoryLedger l{cfg};
    for (int i = 0; i < 6; ++i) {
        l.add("Pergunta número " + std::to_string(i) + "?",
              "Resposta " + std::to_string(i) + " com o projeto P" + std::to_string(i) + " e um resultado claro.");
    }
    const std::string r = l.render();
    EXPECT_NE(r.find("projeto P5"), std::string::npos) << r;
    EXPECT_EQ(r.find("projeto P0"), std::string::npos) << r;
    EXPECT_LE(r.size(), 420u + 200u);
    EXPECT_TRUE(l.needs_compaction());
}

TEST(StoryLedger, CompactionFoldsOlderEntriesIntoTheSummary) {
    StoryLedgerConfig cfg;
    cfg.prompt_chars = 420;
    StoryLedger l{cfg};
    for (int i = 0; i < 6; ++i) {
        l.add("Pergunta número " + std::to_string(i) + "?",
              "Resposta " + std::to_string(i) + " com o projeto P" + std::to_string(i) + " e um resultado claro.");
    }
    const auto job = l.compaction_job("[Você] Na verdade foram três meses, não dois.\n");
    EXPECT_EQ(job.covered, 4u);
    ASSERT_EQ(job.messages.size(), 2u);
    EXPECT_NE(job.messages[1].content.find("projeto P0"), std::string::npos);
    EXPECT_EQ(job.messages[1].content.find("projeto P5"), std::string::npos) << "the two latest stay verbatim";
    EXPECT_NE(job.messages[1].content.find("três meses"), std::string::npos) << "what was really said goes along";

    l.set_summary(job.covered, "Usei os projetos P0 a P3 para falar de entrega e prazo.");
    const std::string r = l.render();
    EXPECT_NE(r.find("P0 a P3"), std::string::npos) << r;
    EXPECT_NE(r.find("projeto P4"), std::string::npos) << r;
    EXPECT_NE(r.find("projeto P5"), std::string::npos) << r;
    EXPECT_FALSE(l.needs_compaction());
    // A summary for a state that no longer exists is ignored.
    l.set_summary(2, "resumo antigo");
    EXPECT_EQ(l.render().find("resumo antigo"), std::string::npos);
}

TEST(StoryLedger, PriorSessionsComeFirstAndPersistableCarriesThisOne) {
    StoryLedger a;
    a.add(kQ1, kA1);
    const std::string stored = a.persistable();
    EXPECT_NE(stored.find("Ninja Startup"), std::string::npos);

    StoryLedger b;
    b.set_prior(stored);
    EXPECT_FALSE(b.empty());
    b.add(kQ2, kA2);
    const std::string r = b.render();
    EXPECT_NE(r.find("Em entrevistas anteriores para esta vaga"), std::string::npos) << r;
    EXPECT_LT(r.find("Ninja Startup"), r.find("iFood resolve")) << r;
    // The next session keeps both.
    EXPECT_NE(b.persistable().find("iFood resolve"), std::string::npos);
}

TEST(StoryLedger, GoesFirstInThePromptOnAnySubject) {
    StoryLedger l;
    l.add(kQ1, kA1);
    PromptConfig cfg;
    const auto with = build_copilot_messages(cfg, "", kQ2, TriggerReason::Question, {}, true, {}, l.render());
    EXPECT_EQ(with[1].content.rfind("LIVRO DA HISTÓRIA", 0), 0u) << with[1].content;
    EXPECT_NE(with[1].content.find("Ninja Startup"), std::string::npos);
    EXPECT_LT(with[1].content.find("Ninja Startup"), with[1].content.find("TRECHOS RECUPERADOS"));
    const auto without = build_copilot_messages(cfg, "", kQ2, TriggerReason::Question, {}, true);
    EXPECT_EQ(without[1].content.find("LIVRO DA HISTÓRIA"), std::string::npos);
    EXPECT_EQ(with[0].content, without[0].content) << "the system message stays byte-stable (prompt cache)";

    ActionInput in;
    in.reason = TriggerReason::Chat;
    in.text = "Resume o que eu já falei.";
    const auto act = build_action_messages(cfg, "", in, {}, l.render());
    EXPECT_NE(act.back().content.find("LIVRO DA HISTÓRIA"), std::string::npos);
    EXPECT_NE(act[0].content.find("LIVRO DA HISTÓRIA"), std::string::npos) << "the rule names a block that exists";
}

TEST(SystemPromptPersona, OneLengthSourceAndOnePersona) {
    const std::string p = copilot_system_prompt();
    EXPECT_NE(p.find("MESMA PERSONA DO INÍCIO AO FIM"), std::string::npos);
    EXPECT_NE(p.find("LIVRO DA HISTÓRIA"), std::string::npos);
    EXPECT_NE(p.find("siga a do PLAYBOOK DESTA ENTREVISTA"), std::string::npos);
    EXPECT_NE(p.find("responda às duas"), std::string::npos);
}

// ------------------------------------------------------------- json patch

TEST(JsonPatch, ReplacesAndAddsWithoutTouchingOtherFields) {
    const std::string raw =
        "{\n  \"id\": \"nubank\",\n  \"archived\": true,\n  \"checklist_state\": {\"a\": [1, 2, \"x,}\"]},\n"
        "  \"mini_compact\": \"velho \\\"texto\\\"\",\n  \"documents\": []\n}\n";
    const auto out = json::patch_top_level(
        raw, {{"mini_compact", json::quote("novo")}, {"story_ledger", json::quote("linha 1\nlinha 2")}});
    ASSERT_TRUE(out.has_value());
    const auto v = json::Parser::parse(*out);
    ASSERT_TRUE(v.has_value()) << *out;
    EXPECT_EQ((*v)["mini_compact"].as_string(), "novo");
    EXPECT_EQ((*v)["story_ledger"].as_string(), "linha 1\nlinha 2");
    EXPECT_EQ((*v)["id"].as_string(), "nubank");
    EXPECT_TRUE((*v)["archived"].as_bool());
    EXPECT_EQ((*v)["checklist_state"]["a"].at(2).as_string(), "x,}");
    EXPECT_NE(out->find("\"checklist_state\": {\"a\": [1, 2, \"x,}\"]}"), std::string::npos) << "bytes kept";
}

TEST(JsonPatch, EmptyObjectAndInvalidInput) {
    const auto out = json::patch_top_level("{}", {{"a", "1"}});
    ASSERT_TRUE(out.has_value());
    EXPECT_EQ(*out, "{\"a\":1}");
    EXPECT_FALSE(json::patch_top_level("not json", {{"a", "1"}}).has_value());
    EXPECT_FALSE(json::patch_top_level("[1,2]", {{"a", "1"}}).has_value());
    // A nested key with the same name is not the top-level field.
    const auto nested = json::patch_top_level("{\"x\":{\"a\":0}}", {{"a", "2"}});
    ASSERT_TRUE(nested.has_value());
    EXPECT_EQ(*nested, "{\"x\":{\"a\":0},\"a\":2}");
}
