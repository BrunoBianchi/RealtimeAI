// Property-based and unit tests for RAG Grounding & Candidate Project distinction.
// Validates: Requirements 1.3, 1.4, 2.3, 2.4, 3.3
//
// Property 1 (Bug Condition):
// When a query cites a candidate project (e.g. "Midea", "TechFinance"), the RAG
// MUST retrieve chunks from that candidate project (is_candidate_project == true),
// and MUST NOT anchor on the target-company dossier (is_cultural_or_company == true).
//
// Property 2 (Preservation):
// When no candidate project is cited, RAG decision via BM25 and fallback paths
// behaves identically to the original implementation.
#include <gtest/gtest.h>

#include <algorithm>
#include <random>
#include <string>
#include <string_view>
#include <vector>

#include "rtai/mini_agent.hpp"

using namespace rtai;

namespace {

MiniAgentProfile make_test_profile() {
    MiniAgentProfile p;
    p.id = "test-agent-tako";
    p.name = "Bruno";
    p.company = "Tako";
    p.role = "Software Engineer";
    p.job_description = "Vaga de Engenharia de Software na Tako. Requisitos: C++, Python, sistemas distribuídos.";
    p.company_dossier =
        "Dossiê Tako: Plataforma de folha de pagamento determinística e integração eSocial para médias empresas.\n"
        "A Tako automatiza o fechamento de folha de pagamento com cálculo em tempo real e integração direta com a Receita Federal.\n"
        "Nossos clientes corporativos e industriais utilizam a entrega da Tako para eliminar retrabalho de RH e DP.";

    RagDocument doc1;
    doc1.name = "TechFinance";
    doc1.path = "techfinance.txt";
    doc1.content =
        "TechFinance: projeto e competição de consolidação contábil no TechLab 2025 desenvolvido por Bruno.\n"
        "Arquitetura em microsserviços com pipeline de processamento em lote e conciliação bancária automatizada.\n"
        "O time organizou as entregas via Kanban com sprints de duas semanas e foco em mitigação de riscos técnicos.";
    p.documents.push_back(std::move(doc1));

    RagDocument doc2;
    doc2.name = "Midea";
    doc2.path = "midea.txt";
    doc2.content =
        "Projeto Midea: PoC de Speech-to-Text na UNIFEI em parceria com a Midea Carrier para transcrição de chamadas da operação industrial.\n"
        "Desenvolvido pipeline de áudio em tempo real com transcrição acústica e análise de sentimento em fábrica.\n"
        "A equipe integrou modelos de IA com microfones industriais para redução de ruído e documentação de turnos.";
    p.documents.push_back(std::move(doc2));

    return p;
}

} // namespace

// ===========================================================================
// Task 1 / Property 1: Bug Condition Exploration Tests (MUST FAIL on unfixed code)
// ===========================================================================

// Exploration Test 1: cites_candidate_project detection and candidate_project_terms
// Expected behavior: candidate projects from profile documents ("TechFinance", "Midea")
// must be extracted as project terms, and queries citing them must be identified.
// On UNFIXED code: candidate_project_terms() is empty, cites_candidate_project() returns false.
TEST(RagGroundingProperties, CitesCandidateProjectDetection) {
    const MiniAgentProfile prof = make_test_profile();
    MiniAgentRag rag{prof};

    const auto& terms = rag.candidate_project_terms();
    // Expected behavior: project terms contain folded versions of "techfinance" and "midea"
    EXPECT_FALSE(terms.empty())
        << "COUNTEREXAMPLE: candidate_project_terms() is empty on unfixed code!";

    const bool has_midea = std::find(terms.begin(), terms.end(), "midea") != terms.end();
    EXPECT_TRUE(has_midea)
        << "COUNTEREXAMPLE: 'midea' term missing from candidate_project_terms()!";

    // Query citing Midea
    const std::string q_midea = "Passando ao projeto de transcrição e análise de áudio em parceria com a Midea.";
    EXPECT_TRUE(rag.cites_candidate_project(q_midea))
        << "COUNTEREXAMPLE: cites_candidate_project failed to detect 'Midea' in query!";

    // Query citing TechFinance
    const std::string q_tech = "Pensando agora na competição em que desenvolveu o Tech Finance, como você decidiu?";
    EXPECT_TRUE(rag.cites_candidate_project(q_tech))
        << "COUNTEREXAMPLE: cites_candidate_project failed to detect 'Tech Finance' in query!";

    // Query with no candidate project
    const std::string q_none = "Qual é o prazo de implantação da folha de pagamento da Tako?";
    EXPECT_FALSE(rag.cites_candidate_project(q_none));
}

// Exploration Test 2 (Symptom B — projectMisground):
// When the recruiter asks about the Midea project:
// Query: "Passando ao projeto em parceria com a Midea, o que mudou para a operação industrial depois que começaram a usar a entrega?"
// Expected behavior: RAG retrieves chunks belonging to Midea (is_candidate_project == true),
// and does NOT anchor on the target company (Tako dossier, is_cultural_or_company == true).
// On UNFIXED code: "operacao", "industrial", "entrega", "parceria" trigger cultural bonuses on
// the Tako company dossier, returning Tako chunks instead of Midea!
TEST(RagGroundingProperties, ProjectMisgroundExploration) {
    const MiniAgentProfile prof = make_test_profile();
    MiniAgentRag rag{prof};

    const std::string query =
        "Passando ao projeto em parceria com a Midea, o que mudou para a operação industrial depois que começaram a usar a entrega?";

    const RagDecision dec = rag.decide_rag_for_query(query, 4);

    ASSERT_TRUE(dec.needed) << "RAG expansion was not requested for project query";
    ASSERT_FALSE(dec.chunks.empty()) << "No chunks retrieved for project query";

    // Expected behavior: the top chunk MUST be from the Midea document
    const RagChunk* top_chunk = dec.chunks.front();
    EXPECT_EQ(top_chunk->source, "Midea")
        << "COUNTEREXAMPLE (Symptom B): Top chunk belongs to '" << top_chunk->source
        << "' instead of candidate project 'Midea'!";

    EXPECT_TRUE(top_chunk->is_candidate_project)
        << "COUNTEREXAMPLE: Top chunk is not marked as is_candidate_project!";

    EXPECT_FALSE(top_chunk->is_cultural_or_company)
        << "COUNTEREXAMPLE: Top chunk is incorrectly marked as is_cultural_or_company!";

    // None of the retrieved chunks should be target-company dossier chunks
    for (const RagChunk* ch : dec.chunks) {
        EXPECT_FALSE(ch->is_cultural_or_company)
            << "COUNTEREXAMPLE: Retrieved chunks include target company dossier chunk: " << ch->text;
    }
}

// Exploration Test 3: Truncated query arriving with project term in context
// When the recruiter question mentions TechFinance, TechFinance chunks must be retrieved.
TEST(RagGroundingProperties, TechFinanceGroundingExploration) {
    const MiniAgentProfile prof = make_test_profile();
    MiniAgentRag rag{prof};

    const std::string query =
        "Pensando agora na competição em que desenvolveu o Tech Finance, como você decidiu o que fazer primeiro?";

    const RagDecision dec = rag.decide_rag_for_query(query, 4);

    ASSERT_TRUE(dec.needed) << "RAG expansion was not requested for TechFinance query";
    ASSERT_FALSE(dec.chunks.empty()) << "No chunks retrieved for TechFinance query";

    const RagChunk* top = dec.chunks.front();
    EXPECT_EQ(top->source, "TechFinance")
        << "COUNTEREXAMPLE: Top chunk belongs to '" << top->source
        << "' instead of candidate project 'TechFinance'!";
    EXPECT_TRUE(top->is_candidate_project);
}

// ===========================================================================
// Task 2 / Property 2: Preservation Property Tests (MUST PASS on unfixed code)
// ===========================================================================

// Preservation 3: Queries with no candidate project cited
// For all queries where no candidate project is mentioned, RAG behavior must be
// identical to existing BM25 and fallback behavior.
TEST(RagGroundingProperties, PreservationQueriesWithoutCandidateProject) {
    const MiniAgentProfile prof = make_test_profile();
    MiniAgentRag rag{prof};

    const std::vector<std::string> standard_queries = {
        "Qual é o prazo de implantação da folha de pagamento?",
        "Como funciona a cultura da empresa e o trabalho em equipe?",
        "Quais são os valores fundamentais da Tako?",
        "Qual a política de segurança da informação?"
    };

    for (const auto& q : standard_queries) {
        // Must not cite candidate projects
        EXPECT_FALSE(rag.cites_candidate_project(q));

        const RagDecision dec = rag.decide_rag_for_query(q, 4);
        // Decision reason and need must be preserved
        if (q.find("cultura") != std::string::npos || q.find("equipe") != std::string::npos) {
            EXPECT_TRUE(dec.needed);
            EXPECT_FALSE(dec.chunks.empty());
        }
    }
}

// Preservation: Empty documents / no profile
TEST(RagGroundingProperties, PreservationEmptyProfile) {
    MiniAgentRag empty_rag;
    EXPECT_TRUE(empty_rag.candidate_project_terms().empty());
    EXPECT_FALSE(empty_rag.cites_candidate_project("qualquer pergunta"));

    const RagDecision dec = empty_rag.decide_rag_for_query("como funciona?", 4);
    EXPECT_FALSE(dec.needed);
    EXPECT_TRUE(dec.chunks.empty());
}

