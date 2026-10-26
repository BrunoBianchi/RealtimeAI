#include <gtest/gtest.h>

#include <string>
#include <vector>

#include "rtai/mini_agent.hpp"

using namespace rtai;

TEST(GoalWorkspaceProperties, ProfileSerializationRoundTrip) {
    MiniAgentProfile p;
    p.id = "nubank-senior";
    p.name = "Nubank — Senior Engineer";
    p.company = "Nubank";
    p.role = "Senior Software Engineer";
    p.job_description = "Arquitetura distribuída e alta resiliência.";
    p.company_dossier = "Cultura baseada em dados e autonomia.";
    p.custom_instructions = "Foque no formato STAR e cite métricas.";
    p.stage = "Interviewing";
    p.next_interview_date = "2026-10-25";
    p.next_interview_time = "15:00";
    p.next_focus = "Concisão em respostas de system design.";
    p.playbook_name = "Executivo STAR";
    p.playbook_answer_length = "Concise";
    p.playbook_behavioral_structure = "STAR";
    p.playbook_lead_with_answer = true;
    p.playbook_name_tradeoffs = true;
    p.answer_language = "pt-BR";
    p.coding_language = "TypeScript";
    p.goal_memory_strengths = {"Clareza técnica", "Ownership forte"};
    p.goal_memory_improve = {"Evitar rodeios no contexto", "Citar números antes"};
    p.documents.push_back(RagDocument{"curriculo.md", "resume", "10 anos de experiência em C++ e Node"});

    const std::string json = p.to_json();
    auto roundtrip = MiniAgentProfile::from_json(json);
    ASSERT_TRUE(roundtrip.has_value());

    EXPECT_EQ(roundtrip->id, p.id);
    EXPECT_EQ(roundtrip->name, p.name);
    EXPECT_EQ(roundtrip->company, p.company);
    EXPECT_EQ(roundtrip->role, p.role);
    EXPECT_EQ(roundtrip->stage, "Interviewing");
    EXPECT_EQ(roundtrip->next_interview_date, "2026-10-25");
    EXPECT_EQ(roundtrip->next_interview_time, "15:00");
    EXPECT_EQ(roundtrip->next_focus, "Concisão em respostas de system design.");
    EXPECT_EQ(roundtrip->playbook_name, "Executivo STAR");
    EXPECT_EQ(roundtrip->playbook_answer_length, "Concise");
    EXPECT_EQ(roundtrip->playbook_behavioral_structure, "STAR");
    EXPECT_TRUE(roundtrip->playbook_lead_with_answer);
    EXPECT_TRUE(roundtrip->playbook_name_tradeoffs);
    EXPECT_EQ(roundtrip->answer_language, "pt-BR");
    EXPECT_EQ(roundtrip->coding_language, "TypeScript");
    ASSERT_EQ(roundtrip->goal_memory_strengths.size(), 2u);
    EXPECT_EQ(roundtrip->goal_memory_strengths[0], "Clareza técnica");
    ASSERT_EQ(roundtrip->goal_memory_improve.size(), 2u);
    EXPECT_EQ(roundtrip->goal_memory_improve[0], "Evitar rodeios no contexto");
    ASSERT_EQ(roundtrip->documents.size(), 1u);
}

TEST(GoalWorkspaceProperties, BackwardCompatibilityWithLegacyJson) {
    const std::string legacy_json = R"({
        "id": "legacy-agent",
        "company": "Google",
        "role": "Staff Engineer",
        "job_description": "Cloud infra",
        "documents": []
    })";

    auto parsed = MiniAgentProfile::from_json(legacy_json);
    ASSERT_TRUE(parsed.has_value());
    EXPECT_EQ(parsed->id, "legacy-agent");
    EXPECT_EQ(parsed->company, "Google");
    // Defaults for new Goal Workspace fields
    EXPECT_EQ(parsed->stage, "Active");
    EXPECT_TRUE(parsed->next_interview_date.empty());
    EXPECT_TRUE(parsed->next_interview_time.empty());
    EXPECT_TRUE(parsed->next_focus.empty());
    EXPECT_EQ(parsed->playbook_name, "Standard STAR");
    EXPECT_EQ(parsed->playbook_answer_length, "Balanced");
    EXPECT_EQ(parsed->playbook_behavioral_structure, "Auto");
    EXPECT_TRUE(parsed->playbook_lead_with_answer);
    EXPECT_FALSE(parsed->playbook_name_tradeoffs);
    EXPECT_EQ(parsed->answer_language, "pt-BR");
}

TEST(GoalWorkspaceProperties, PlaybookAndNextFocusInjectedInMiniCompact) {
    MiniAgentProfile p;
    p.company = "Stripe";
    p.role = "Backend Tech Lead";
    p.next_focus = "Enfatizar liderança e decisões difíceis de arquitetura.";
    p.playbook_name = "Direto & Assertivo";
    p.playbook_answer_length = "Concise";
    p.playbook_behavioral_structure = "STAR";
    p.playbook_lead_with_answer = true;
    p.playbook_name_tradeoffs = true;
    p.answer_language = "pt-BR";
    p.coding_language = "Go";

    MiniAgentRag rag(p);
    const std::string compact = rag.synthesize_deep_mini_compact();

    EXPECT_NE(compact.find("[6. Next Focus — Foco Específico para esta Sessão]"), std::string::npos);
    EXPECT_NE(compact.find("Enfatizar liderança"), std::string::npos);
    EXPECT_NE(compact.find("[7. Diretrizes do Playbook de Resposta (Direto & Assertivo)]"), std::string::npos);
    EXPECT_NE(compact.find("Estrutura comportamental obrigatória: STAR"), std::string::npos);
    EXPECT_NE(compact.find("Veredito primeiro"), std::string::npos);
    EXPECT_NE(compact.find("Trade-offs"), std::string::npos);
    EXPECT_NE(compact.find("Linguagem para exemplos de código: Go"), std::string::npos);
}
