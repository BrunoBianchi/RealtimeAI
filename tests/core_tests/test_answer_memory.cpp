// Answer memory (rtai/answer_memory.hpp): follow-ups on the same subject get
// what was already answered (verbatim, then a summary plus the latest), a
// question on another subject gets nothing and starts a new thread.
#include <gtest/gtest.h>

#include <string>

#include "rtai/answer_memory.hpp"

using namespace rtai;

namespace {

const char* kQ1 = "Conte sobre um projeto onde você trabalhou em equipe";
const char* kA1 =
    "No hackathon da Ninja Startup eu liderei o alinhamento técnico: definimos uma arquitetura mínima com "
    "WebSocket e Docker e ganhamos o primeiro lugar.";

} // namespace

TEST(AnswerMemory, EmptyMemorySendsNothing) {
    AnswerMemory m;
    EXPECT_EQ(m.for_question("E como você escalou isso?").kind, AnswerMemory::Kind::None);
    EXPECT_FALSE(m.needs_compaction());
}

TEST(AnswerMemory, FollowUpCueGetsTheThreadVerbatim) {
    AnswerMemory m;
    m.add(kQ1, kA1);
    for (const char* q : {"E como você resolveu os conflitos?", "Você mencionou um prêmio, qual foi o critério?",
                          "Me conta mais sobre isso", "Tell me more about that project"}) {
        const auto ctx = m.for_question(q);
        EXPECT_EQ(ctx.kind, AnswerMemory::Kind::Verbatim) << q;
        EXPECT_NE(ctx.text.find("Ninja Startup"), std::string::npos) << q;
        EXPECT_NE(ctx.text.find(kQ1), std::string::npos) << q;
    }
}

TEST(AnswerMemory, SharedSubjectWordsWithoutCueStillCount) {
    AnswerMemory m;
    m.add(kQ1, kA1);
    // "Docker" and "WebSocket" came from the answer: the same story.
    EXPECT_TRUE(m.continues_thread("Por que vocês escolheram Docker e não uma VM?"));
    EXPECT_TRUE(m.continues_thread("Qual foi o papel do WebSocket na arquitetura?"));
    // The interviewer's recent lines may carry the subject when the trigger is a fragment.
    EXPECT_TRUE(m.continues_thread("Por que essa escolha?", "Vocês usaram Docker no hackathon"));
}

TEST(AnswerMemory, AnotherSubjectSendsNothingAndStartsANewThread) {
    AnswerMemory m;
    m.add(kQ1, kA1);
    const std::uint64_t first = m.thread();
    // Generic interview words ("projeto", "solução", "equipe") are not a shared subject.
    const char* other = "Você criou uma solução de IA em um projeto acadêmico?";
    EXPECT_EQ(m.for_question(other).kind, AnswerMemory::Kind::None);
    EXPECT_EQ(m.for_question("Por que você quer trabalhar no iFood?").kind, AnswerMemory::Kind::None);

    m.add(other, "Na Vértice, com a UNIFEI, treinei modelos para detectar falhas em uma rede 5G.");
    EXPECT_NE(m.thread(), first);
    EXPECT_EQ(m.size(), 1u);
    const auto ctx = m.for_question("E como você validou esses modelos?");
    EXPECT_NE(ctx.text.find("UNIFEI"), std::string::npos);
    EXPECT_EQ(ctx.text.find("Ninja Startup"), std::string::npos) << "the old story must not leak";
}

TEST(AnswerMemory, GrowingThreadIsCompactedIntoASummary) {
    AnswerMemoryConfig cfg;
    cfg.verbatim_budget_chars = 300;
    AnswerMemory m(cfg);
    m.add(kQ1, kA1);
    EXPECT_FALSE(m.needs_compaction());
    m.add("E como você resolveu os conflitos com o Docker?", std::string(kA1) + " Padronizamos o ambiente com Docker.");
    m.add("E qual foi o maior aprendizado desse hackathon?", "Aprendi que simplificar o protocolo do WebSocket "
                                                              "entregava valor mais rápido que a arquitetura ideal.");
    ASSERT_TRUE(m.needs_compaction());

    // Before the summary lands, only the newest exchanges that fit are sent.
    auto before = m.for_question("E depois do hackathon?");
    EXPECT_EQ(before.kind, AnswerMemory::Kind::Verbatim);
    EXPECT_NE(before.text.find("maior aprendizado"), std::string::npos);
    EXPECT_EQ(before.text.find(kQ1), std::string::npos);

    // The job folds everything but the latest exchange.
    const auto job = m.compaction_job();
    EXPECT_EQ(job.covered, 2u);
    ASSERT_EQ(job.messages.size(), 2u);
    EXPECT_NE(job.messages[1].content.find(kQ1), std::string::npos);
    EXPECT_EQ(job.messages[1].content.find("maior aprendizado"), std::string::npos);

    m.set_summary(job.thread, job.covered, "Liderei o alinhamento técnico no hackathon da Ninja Startup com Docker.");
    EXPECT_FALSE(m.needs_compaction());
    const auto after = m.for_question("E como isso ajudaria no iFood?");
    EXPECT_EQ(after.kind, AnswerMemory::Kind::Summary);
    EXPECT_NE(after.text.find("Liderei o alinhamento técnico"), std::string::npos);
    EXPECT_NE(after.text.find("maior aprendizado"), std::string::npos) << "the latest exchange stays verbatim";
    EXPECT_EQ(after.text.find(kQ1), std::string::npos) << "older exchanges are only in the summary";
}

TEST(AnswerMemory, StaleSummaryFromAnOldThreadIsIgnored) {
    AnswerMemoryConfig cfg;
    cfg.verbatim_budget_chars = 100;
    AnswerMemory m(cfg);
    m.add(kQ1, kA1);
    m.add("E como você resolveu os conflitos com o Docker?", kA1);
    const auto job = m.compaction_job();
    m.add("Por que você quer trabalhar no iFood?", "Porque quero aplicar IA em logística com impacto real.");
    m.set_summary(job.thread, job.covered, "Resumo do hackathon.");
    EXPECT_TRUE(m.summary().empty());
    EXPECT_EQ(m.size(), 1u);
}

TEST(AnswerMemory, ClearForgetsEverything) {
    AnswerMemory m;
    m.add(kQ1, kA1);
    m.clear();
    EXPECT_EQ(m.size(), 0u);
    EXPECT_EQ(m.render().kind, AnswerMemory::Kind::None);
}
