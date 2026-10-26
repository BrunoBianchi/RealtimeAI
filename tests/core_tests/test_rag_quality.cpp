// RAG quality on a realistic goal: a résumé, two project write-ups, a company
// culture deck uploaded as "material", the job description and the dossier.
// Each test pins one failure seen in the field:
//   * company material was treated as "my project" (and the company name
//     became a "project term", so "why Nubank?" looked like a project question);
//   * every >=4-letter word of a document's first lines became a project term
//     ("prazo", "maior", "pessoas"), pulling the wrong project;
//   * behavioral questions were answered from the company dossier because
//     "time"/"equipe" counted as company keywords;
//   * the playbook was cut off the Mini-Compact when there were many files;
//   * the company was shown as a URL in the prompt;
//   * the deep compact was recomputed on every launch.
#include <gtest/gtest.h>

#include <algorithm>
#include <string>
#include <vector>

#include "rtai/copilot_prompt.hpp"
#include "rtai/decision_policy.hpp"
#include "rtai/mini_agent.hpp"

using namespace rtai;

namespace {

RagDocument doc(std::string name, std::string tag, std::string content) {
    RagDocument d;
    d.name = std::move(name);
    d.path = tag;
    d.tag = std::move(tag);
    d.content = std::move(content);
    return d;
}

MiniAgentProfile nubank_goal() {
    MiniAgentProfile p;
    p.id = "nubank";
    p.name = "NUBANK - Estágio";
    p.company = "https://estagio.nubank.com.br/";
    p.role = "Estágio em Engenharia de Software";
    p.job_description =
        "Buscamos estudantes para o programa de estágio em Engenharia de Software. Você vai trabalhar em squads "
        "com Clojure, Kotlin e microsserviços na AWS, escrevendo testes e participando de code review. "
        "Requisitos: lógica de programação, vontade de aprender, comunicação clara.";
    p.company_dossier =
        "O Nubank é uma plataforma de serviços financeiros digitais com mais de 100 milhões de clientes. "
        "Valores: clientes que nos amam fanaticamente; pensamos e agimos como donos; desafiamos o status quo. "
        "Stack: Clojure, Datomic, Kafka.";
    p.custom_instructions = "Sou estudante de Engenharia de Computação na UNIFEI, formatura prevista para jul/2028.";
    p.documents.push_back(doc("Curriculo_Bruno.pdf", "resume",
        "Bruno Raiado Bianchi\n"
        "Engenharia de Computação - UNIFEI, previsão jul/2028\n"
        "EXPERIÊNCIA\n"
        "Midea - Engenheiro de Software (jun/2026 - atual): automação do call center com IA generativa e CNNs. "
        "Node.js, React e Python. Conduzo reuniões de alinhamento e modelagem.\n"
        "Fiverr - Freelancer Full-Stack (jan/2022 - atual): bots para Discord com mais de US$ 5.000 em receita.\n"
        "Vertis Solutions - Engenheiro de Machine Learning (out/2024 - jun/2025): pipelines em Python para grandes "
        "volumes de dados e monitoramento de redes 5G.\n"
        "PRÊMIOS\nVencedor do TechLab 2025 com o TechFinance App."));
    p.documents.push_back(doc("TechFinance.md", "project",
        "TechFinance App\n"
        "WebApp de gestão financeira desenvolvido em equipe de 4 pessoas no TechLab 2025. Fiquei responsável pelo "
        "backend em Node.js e PostgreSQL. O prazo era de 3 semanas e o escopo mudou na segunda semana.\n"
        "Eu propus cortar o módulo de metas e usar regras de palavras-chave em vez de ML para caber no prazo.\n"
        "Resultado: entregamos o MVP no prazo, com categorização funcionando em 82% das transações de teste, "
        "e vencemos o TechLab 2025."));
    p.documents.push_back(doc("Kubernetes_5G.md", "material",
        "IA para Kubernetes em redes 5G\n"
        "Projeto de P&D na Vertis Solutions. Construí pipelines em Python com Prometheus e treinei modelos LSTM. "
        "O maior desafio foi o volume de dados: milhões de amostras por dia. Particionei por janela de tempo.\n"
        "Resultado: detecção de anomalias cerca de 10 minutos antes do pico."));
    p.documents.push_back(doc("Nubank_cultura.pdf", "material",
        "Cultura Nubank\n"
        "O Nubank nasceu em 2013 para combater a complexidade do sistema financeiro. Missão: devolver às pessoas "
        "o controle sobre suas vidas financeiras. O Nubank valoriza ownership e foco no cliente."));
    return p;
}

bool has_source(const RagDecision& d, const std::string& src) {
    return std::any_of(d.chunks.begin(), d.chunks.end(), [&](const RagChunk* c) { return c->source == src; });
}

bool all_candidate(const RagDecision& d) {
    return std::all_of(d.chunks.begin(), d.chunks.end(), [](const RagChunk* c) { return c->is_candidate_project; });
}

} // namespace

// ------------------------------------------------------- classification

TEST(RagQuality, CompanyMaterialIsNotMyExperience) {
    MiniAgentRag rag{nubank_goal()};
    EXPECT_EQ(rag.document_kind(0), RagDocKind::Candidate); // résumé
    EXPECT_EQ(rag.document_kind(1), RagDocKind::Candidate); // project
    EXPECT_EQ(rag.document_kind(2), RagDocKind::Candidate); // first-person write-up tagged "material"
    EXPECT_EQ(rag.document_kind(3), RagDocKind::Company);   // culture deck

    const std::string profile = rag.session_profile_block();
    const auto mine = profile.find("EXCLUSIVAMENTE os dos DOCUMENTOS DO RAG (");
    ASSERT_NE(mine, std::string::npos);
    const std::string mine_line = profile.substr(mine, profile.find('\n', mine) - mine);
    EXPECT_EQ(mine_line.find("Nubank_cultura.pdf"), std::string::npos) << mine_line;
    EXPECT_NE(mine_line.find("TechFinance.md"), std::string::npos);
    EXPECT_NE(profile.find("Material sobre a empresa/vaga (Nubank_cultura.pdf)"), std::string::npos);
}

TEST(RagQuality, ClassifiesByTagNameAndContent) {
    const std::vector<std::string> nubank{"nubank"};
    EXPECT_EQ(MiniAgentRag::classify_document(doc("x.pdf", "resume", "qualquer"), nubank), RagDocKind::Candidate);
    EXPECT_EQ(MiniAgentRag::classify_document(doc("x.pdf", "job", "qualquer"), nubank), RagDocKind::Job);
    EXPECT_EQ(MiniAgentRag::classify_document(doc("Vaga_backend.txt", "material", "requisitos"), nubank),
              RagDocKind::Job);
    EXPECT_EQ(MiniAgentRag::classify_document(
                  doc("valores.md", "material", "O Nubank acredita em X. No Nubank, os times..."), nubank),
              RagDocKind::Company);
    // Mentions the company but is written in first person: it is mine.
    EXPECT_EQ(MiniAgentRag::classify_document(
                  doc("notas.md", "material", "Eu desenvolvi um app parecido com o Nubank e liderei o time. "
                                              "Fiz o backend. O Nubank inspirou o design."),
                  nubank),
              RagDocKind::Candidate);
}

TEST(RagQuality, CompanyLabelFromUrlOrGoalName) {
    MiniAgentRag rag{nubank_goal()};
    EXPECT_EQ(rag.company_label(), "Nubank");
    const std::string profile = rag.session_profile_block();
    EXPECT_NE(profile.find("A empresa (Nubank)"), std::string::npos);
    EXPECT_EQ(profile.find("A empresa (https://"), std::string::npos);

    MiniAgentProfile p;
    p.name = "ITAÚ - Estágio TI";
    MiniAgentRag by_name{p};
    EXPECT_EQ(by_name.company_label(), "Itaú");

    MiniAgentProfile q;
    q.company = "Mercado Livre";
    MiniAgentRag plain{q};
    EXPECT_EQ(plain.company_label(), "Mercado Livre");
}

// ------------------------------------------------------- project terms

TEST(RagQuality, ProjectTermsAreNamesNotOrdinaryWords) {
    MiniAgentRag rag{nubank_goal()};
    const auto& terms = rag.candidate_project_terms();
    auto has = [&](const char* t) { return std::find(terms.begin(), terms.end(), t) != terms.end(); };
    EXPECT_TRUE(has("techfinance"));
    EXPECT_TRUE(has("midea"));
    EXPECT_TRUE(has("vertis"));
    EXPECT_TRUE(has("kubernetes"));
    for (const char* w : {"nubank", "prazo", "maior", "pessoas", "resultado", "projeto", "software", "dados",
                          "estagio", "cultura"}) {
        EXPECT_FALSE(has(w)) << w;
    }
    EXPECT_FALSE(has("bruno")) << "my own name is not a project";
    EXPECT_FALSE(has("bruno raiado bianchi"));
    EXPECT_TRUE(has("techfinance app")) << "a project heading is not a person's name";
    EXPECT_FALSE(rag.cites_candidate_project("Por que você quer trabalhar no Nubank?"));
    EXPECT_FALSE(rag.cites_candidate_project("Qual foi o maior prazo que você enfrentou?"));
    EXPECT_TRUE(rag.cites_candidate_project("Me fala do seu trabalho na Midea."));
}

// ------------------------------------------------------- retrieval by intent

TEST(RagQuality, WhyUsIsAnsweredFromCompanyMaterialFirst) {
    MiniAgentRag rag{nubank_goal()};
    const auto dec = rag.decide_rag_for_query("Por que você quer trabalhar no Nubank?", 5);
    ASSERT_TRUE(dec.needed);
    ASSERT_FALSE(dec.chunks.empty());
    EXPECT_TRUE(dec.chunks.front()->is_cultural_or_company) << dec.chunks.front()->source;
    // ...and still brings one of my real stories to connect with.
    EXPECT_TRUE(std::any_of(dec.chunks.begin(), dec.chunks.end(),
                            [](const RagChunk* c) { return c->is_candidate_project; }));
    const std::string block = rag.retrieve_block("Por que você quer trabalhar no Nubank?");
    EXPECT_LT(block.find("[SOBRE A EMPRESA/VAGA"), block.find("[SOBRE MIM"));
}

TEST(RagQuality, BehavioralQuestionLeadsWithMyStoryNotTheDossier) {
    MiniAgentRag rag{nubank_goal()};
    for (const char* q : {"Me conta de uma vez que você teve um prazo apertado.",
                          "Conte uma situação em que você trabalhou em equipe sob pressão.",
                          "Tell me about a time you dealt with a lot of data."}) {
        const auto dec = rag.decide_rag_for_query(q, 5);
        ASSERT_TRUE(dec.needed) << q;
        ASSERT_FALSE(dec.chunks.empty()) << q;
        EXPECT_TRUE(dec.chunks.front()->is_candidate_project) << q << " -> " << dec.chunks.front()->source;
    }
    const auto deadline = rag.decide_rag_for_query("Me conta de uma vez que você teve um prazo apertado.", 5);
    EXPECT_EQ(deadline.chunks.front()->source, "TechFinance.md");
}

TEST(RagQuality, CitedProjectDoesNotMixInAnotherProject) {
    MiniAgentRag rag{nubank_goal()};
    const auto dec = rag.decide_rag_for_query("Qual foi o maior desafio técnico do TechFinance?", 5);
    ASSERT_FALSE(dec.chunks.empty());
    EXPECT_EQ(dec.chunks.front()->source, "TechFinance.md");
    EXPECT_FALSE(has_source(dec, "Kubernetes_5G.md")) << "a different project rode along";
    EXPECT_FALSE(has_source(dec, "Nubank_cultura.pdf"));
}

TEST(RagQuality, ResumeLineFoundByEmployerName) {
    MiniAgentRag rag{nubank_goal()};
    const auto dec = rag.decide_rag_for_query("Me fala sobre o seu trabalho na Midea.", 5);
    ASSERT_FALSE(dec.chunks.empty());
    EXPECT_NE(dec.chunks.front()->text.find("Midea"), std::string::npos);
    EXPECT_TRUE(all_candidate(dec));
}

TEST(RagQuality, UnknownTechKeepsCompanyAndMineApart) {
    MiniAgentRag rag{nubank_goal()};
    const std::string block = rag.retrieve_block("Você já trabalhou com Clojure?");
    // Clojure only exists in the company/job material: it must be labeled as
    // such, so the model says I have not used it instead of claiming it.
    const auto theirs = block.find("[SOBRE A EMPRESA/VAGA");
    ASSERT_NE(theirs, std::string::npos);
    const auto clojure = block.find("Clojure");
    ASSERT_NE(clojure, std::string::npos);
    EXPECT_GT(clojure, theirs);
    const auto mine = block.find("[SOBRE MIM");
    if (mine != std::string::npos && mine > theirs) { EXPECT_LT(clojure, mine); }
}

TEST(RagQuality, SmallTalkDoesNotRetrieve) {
    MiniAgentRag rag{nubank_goal()};
    EXPECT_FALSE(rag.decide_rag_for_query("Opa, testando, tudo bem?", 5).needed);
    EXPECT_FALSE(rag.decide_rag_for_query("Está me ouvindo bem?", 5).needed);
}

TEST(RagQuality, ProjectNamedEarlierBoostsButDoesNotHideANewTopic) {
    MiniAgentRag rag{nubank_goal()};
    // Follow-up with no subject of its own: the project from the previous line leads.
    const auto follow = rag.decide_rag_for_query("E qual foi o resultado?", 5, "Vamos falar do Kubernetes 5G.");
    ASSERT_FALSE(follow.chunks.empty());
    EXPECT_EQ(follow.chunks.front()->source, "Kubernetes_5G.md");
    // New question with its own subject: the earlier project must not hide it.
    const auto fresh = rag.decide_rag_for_query("Me conta de uma vez que você teve um prazo apertado.", 5,
                                                "Vamos falar do Kubernetes 5G.");
    EXPECT_TRUE(has_source(fresh, "TechFinance.md"));
}

// ------------------------------------------------------- chunking

TEST(RagQuality, ChunksNeverStartOrEndMidWord) {
    MiniAgentProfile p = nubank_goal();
    std::string long_doc = "Projeto Longo\n";
    for (int i = 0; i < 40; ++i) {
        long_doc += "Implementei a etapa " + std::to_string(i) + " do pipeline de dados com testes automatizados. ";
    }
    p.documents.push_back(doc("Longo.md", "project", long_doc));
    MiniAgentRag rag{p};
    const auto dec = rag.decide_rag_for_query("Me fala do Projeto Longo e do pipeline.", 8);
    ASSERT_GE(dec.chunks.size(), 2u);
    for (const RagChunk* c : dec.chunks) {
        if (c->source != "Longo.md") continue;
        EXPECT_LE(c->text.size(), 600u);
        const char last = c->text.back();
        EXPECT_TRUE(last == '.' || last == '!' || last == '?') << "ends mid-sentence: ..." << c->text.substr(c->text.size() - 30);
        EXPECT_TRUE(std::isupper(static_cast<unsigned char>(c->text.front()))) << c->text.substr(0, 30);
    }
}

TEST(RagQuality, HardCutNeverSplitsACharacter) {
    MiniAgentProfile p;
    std::string blob;
    for (int i = 0; i < 700; ++i) blob += "ç"; // 1400 bytes, no space, no punctuation
    p.documents.push_back(doc("blob.md", "project", blob));
    MiniAgentRag rag{p};
    ASSERT_GE(rag.chunk_count(), 2u);
    const auto chunks = rag.retrieve_chunks("blob", 8);
    for (const RagChunk* c : chunks) {
        EXPECT_LE(c->text.size(), 600u);
        EXPECT_EQ(c->text.size() % 2, 0u) << "a 2-byte character was split";
        EXPECT_NE(static_cast<unsigned char>(c->text.front()) & 0xC0, 0x80u);
    }
}

// ------------------------------------------------------- session profile

TEST(RagQuality, PlaybookSurvivesManyDocuments) {
    MiniAgentProfile p = nubank_goal();
    p.playbook_answer_length = "Concise";
    for (int i = 0; i < 13; ++i) {
        std::string body = "Projeto " + std::to_string(i) + "\n";
        for (int k = 0; k < 30; ++k) body += "Desenvolvi a funcionalidade " + std::to_string(k) + " com testes. ";
        p.documents.push_back(doc("Projeto" + std::to_string(i) + ".md", "project", body));
    }
    MiniAgentRag rag{p};
    const std::string compact = rag.synthesize_deep_mini_compact();
    EXPECT_NE(compact.find("[7. Diretrizes do Playbook"), std::string::npos) << "playbook cut off the compact";
    const std::string profile = rag.session_profile_block();
    EXPECT_NE(profile.find("60 a 100 palavras"), std::string::npos);
    // The prompt builder truncates the profile at max_context_chars: the
    // rules and the playbook come first so they are never what gets cut.
    PromptConfig cfg;
    EXPECT_LT(profile.find("PLAYBOOK DESTA ENTREVISTA"), cfg.max_context_chars);
    EXPECT_LT(profile.find("MINI-COMPACT SEMPRE PRESENTE"), cfg.max_context_chars);
}

TEST(RagQuality, StoredCompactPlaybookIsNotDuplicated) {
    MiniAgentProfile p = nubank_goal();
    MiniAgentRag first{p};
    p.mini_compact = first.synthesize_deep_mini_compact(); // contains section [7]
    MiniAgentRag rag{p};
    const std::string profile = rag.session_profile_block();
    const auto a = profile.find("[7. Diretrizes do Playbook");
    ASSERT_NE(a, std::string::npos);
    EXPECT_EQ(profile.find("[7. Diretrizes do Playbook", a + 1), std::string::npos);
}

TEST(RagQuality, DeepReadingPromptLabelsWhoEachFileIsAbout) {
    MiniAgentRag rag{nubank_goal()};
    const std::string p = rag.build_deep_reading_prompt();
    EXPECT_NE(p.find("ARQUIVO DO CANDIDATO [TechFinance.md]"), std::string::npos);
    EXPECT_NE(p.find("MATERIAL DA EMPRESA/VAGA [Nubank_cultura.pdf]"), std::string::npos);
    EXPECT_NE(p.find("na Nubank"), std::string::npos);
    EXPECT_EQ(p.find("https://"), std::string::npos);
    // The 82% metric must reach the model verbatim.
    EXPECT_NE(p.find("82%"), std::string::npos);
}

TEST(RagQuality, CompactFingerprintSkipsUnchangedMaterials) {
    MiniAgentProfile p = nubank_goal();
    MiniAgentRag rag{p};
    EXPECT_FALSE(rag.mini_compact_is_current()) << "no fingerprint stored yet";

    p.mini_compact = "[Quem sou] resumo do modelo";
    p.mini_compact_fingerprint = rag.source_fingerprint();
    const auto roundtrip = MiniAgentProfile::from_json(p.to_json());
    ASSERT_TRUE(roundtrip.has_value());
    EXPECT_EQ(roundtrip->mini_compact_fingerprint, p.mini_compact_fingerprint);
    MiniAgentRag same{*roundtrip};
    EXPECT_TRUE(same.mini_compact_is_current());

    MiniAgentProfile changed = *roundtrip;
    changed.documents[1].content += "\nNovo detalhe.";
    MiniAgentRag after_edit{changed};
    EXPECT_FALSE(after_edit.mini_compact_is_current());
}

TEST(RagQuality, TagSurvivesJsonRoundTrip) {
    const auto roundtrip = MiniAgentProfile::from_json(nubank_goal().to_json());
    ASSERT_TRUE(roundtrip.has_value());
    EXPECT_EQ(roundtrip->documents[3].tag, "material");
    MiniAgentRag rag{*roundtrip};
    EXPECT_EQ(rag.document_kind(3), RagDocKind::Company);
}

// ------------------------------------------------------- question focus
// "Às vezes ele não entende a pergunta e responde coisas do RAG aleatórias."

TEST(RagFocus, ConceptAndLogisticsQuestionsDoNotPullMyProjects) {
    MiniAgentRag rag{nubank_goal()};
    for (const char* q : {"Qual a diferença entre processo e thread?", "Como funciona um índice em banco de dados?",
                          "O que é polimorfismo?", "Qual sua pretensão salarial?",
                          "Você tem alguma pergunta para nós?"}) {
        const auto dec = rag.decide_rag_for_query(q, 5);
        EXPECT_TRUE(dec.chunks.empty()) << q << " pulled " << (dec.chunks.empty() ? "" : dec.chunks.front()->source);
        const std::string block = rag.retrieve_block(q);
        const bool typed = block.find("Tipo de pergunta: direta/conceitual") != std::string::npos ||
                           block.find("Tipo de pergunta: pessoal/direta sobre mim") != std::string::npos;
        EXPECT_TRUE(typed) << q << "\n" << block;
    }
}

TEST(RagFocus, ConceptQuestionKeepsAnExcerptThatIsReallyAboutIt) {
    MiniAgentRag rag{nubank_goal()};
    // The files do talk about this exact subject: the excerpt is relevant.
    const auto dec = rag.decide_rag_for_query("O que é detecção de anomalias com LSTM?", 5);
    ASSERT_FALSE(dec.chunks.empty());
    EXPECT_EQ(dec.chunks.front()->source, "Kubernetes_5G.md");
}

TEST(RagFocus, IntroBringsTheResume) {
    MiniAgentRag rag{nubank_goal()};
    for (const char* q : {"Fale um pouco sobre você.", "Tell me about yourself."}) {
        const auto dec = rag.decide_rag_for_query(q, 5);
        ASSERT_FALSE(dec.chunks.empty()) << q;
        EXPECT_EQ(dec.chunks.front()->source, "Curriculo_Bruno.pdf") << q;
        EXPECT_NE(rag.retrieve_block(q).find("Tipo de pergunta: apresentação pessoal"), std::string::npos);
    }
}

TEST(RagFocus, ShortBehavioralQuestionStillGetsRealStories) {
    MiniAgentRag rag{nubank_goal()};
    const auto dec = rag.decide_rag_for_query("Conte uma situação em que você errou.", 5);
    ASSERT_TRUE(dec.needed);
    EXPECT_TRUE(all_candidate(dec));
    EXPECT_GE(dec.chunks.size(), 1u);
    EXPECT_NE(rag.retrieve_block("Conte uma situação em que você errou.").find("Tipo de pergunta: comportamental"),
              std::string::npos);
}

TEST(RagFocus, MotivationQuestionFindsTheLineThatAnswersIt) {
    MiniAgentRag rag{nubank_goal()};
    const auto dec = rag.decide_rag_for_query("Por que você escolheu Engenharia de Computação?", 5);
    ASSERT_FALSE(dec.chunks.empty());
    EXPECT_NE(dec.chunks.front()->text.find("Engenharia de Computação"), std::string::npos);
}

TEST(RagFocus, ImperativeRequestsAreQuestions) {
    for (const char* q : {"Fale um pouco sobre você.", "Conte uma situação em que você errou.",
                          "Explique o que é uma API REST.", "Me fale do seu projeto mais difícil.",
                          "Imagine que o sistema caiu em produção."}) {
        DecisionPolicy pol;
        Turn t;
        t.text = q;
        t.source = AudioSource::Loopback;
        EXPECT_EQ(pol.evaluate(t, 100000), TriggerReason::Question) << q;
    }
}

TEST(RagFocus, InterviewStatementsDoNotTriggerWithoutSalesKeywords) {
    DecisionConfig cfg;
    cfg.keywords.clear(); // what the app does when an interview goal is loaded
    DecisionPolicy pol{cfg};
    Turn t;
    t.text = "Aqui no Nubank a gente tem muita preocupação com segurança e prazo.";
    t.source = AudioSource::Loopback;
    EXPECT_EQ(pol.evaluate(t, 100000), TriggerReason::None);
}

TEST(RagFocus, PromptPutsTheQuestionFirstAndHandlesNonQuestions) {
    const std::string sys = copilot_system_prompt();
    EXPECT_NE(sys.find("FOCO NA PERGUNTA"), std::string::npos);
    EXPECT_NE(sys.find("Nunca traga um projeto só porque ele aparece"), std::string::npos);
    EXPECT_LT(sys.find("FOCO NA PERGUNTA"), sys.find("ZERO INVENÇÃO"));
    PromptConfig cfg;
    const auto kw = build_copilot_messages(cfg, "", "Nosso time usa Kafka.", TriggerReason::Keyword, "kafka");
    EXPECT_NE(kw[1].content.find("Esta fala não é uma pergunta"), std::string::npos);
    const auto q = build_copilot_messages(cfg, "", "Como você usou Kafka?", TriggerReason::Question);
    EXPECT_EQ(q[1].content.find("Esta fala não é uma pergunta"), std::string::npos);
    EXPECT_NE(q[1].content.find("Primeiro a linha PERGUNTA"), std::string::npos);
}

TEST(RagFocus, MisheardProjectNamesStillFindTheProject) {
    MiniAgentRag rag{nubank_goal()};
    const auto k = rag.decide_rag_for_query("Me fala do projeto de Kubernets.", 5);
    ASSERT_FALSE(k.chunks.empty());
    EXPECT_EQ(k.chunks.front()->source, "Kubernetes_5G.md");
    const auto t = rag.decide_rag_for_query("Como foi o Tec Finance?", 5);
    ASSERT_FALSE(t.chunks.empty());
    EXPECT_EQ(t.chunks.front()->source, "TechFinance.md");
    // A short ordinary word close to a short name is not a citation.
    EXPECT_FALSE(rag.cites_candidate_project("Você trabalha com mídia social?"));
}

TEST(RagFocus, QuestionAboutMeWithNothingInTheFilesForbidsInventing) {
    MiniAgentRag rag{nubank_goal()};
    const std::string block = rag.retrieve_block("Você já morou fora do Brasil?");
    EXPECT_NE(block.find("Nenhum trecho dos meus arquivos responde a isto"), std::string::npos) << block;
    EXPECT_NE(block.find("NÃO invente"), std::string::npos);
    EXPECT_NE(block.find("pessoal/direta sobre mim"), std::string::npos);
}

// ------------------------------------------------------- playbook

TEST(RagQuality, EditedPlaybookFieldsWinOverStaleNestedCopy) {
    // What a goal looked like after "Executive STAR applied": flat fields
    // edited, nested copy still on the old playbook.
    const char* json = R"J({
      "id": "nubank", "company": "Nubank",
      "playbook_name": "Executive STAR", "playbook_answer_length": "Concise",
      "playbook_behavioral_structure": "Executive STAR (Impact-first)",
      "playbook_lead_with_answer": false, "playbook_name_tradeoffs": true,
      "playbook": {"name": "Standard STAR", "answer_length": "Balanced", "behavioral_structure": "STAR",
                   "lead_with_answer": true, "name_tradeoffs": false},
      "answer_language": "en-US", "coding_language": "Python",
      "response_defaults": {"answer_language": "pt-BR", "coding_language": ""}
    })J";
    const auto p = MiniAgentProfile::from_json(json);
    ASSERT_TRUE(p.has_value());
    EXPECT_EQ(p->playbook_name, "Executive STAR");
    EXPECT_EQ(p->playbook_answer_length, "Concise");
    EXPECT_FALSE(p->playbook_lead_with_answer);
    EXPECT_TRUE(p->playbook_name_tradeoffs);
    EXPECT_EQ(p->answer_language, "en-US");
    EXPECT_EQ(p->coding_language, "Python");

    MiniAgentRag rag{*p};
    const std::string profile = rag.session_profile_block();
    EXPECT_NE(profile.find("(Executive STAR)"), std::string::npos);
    EXPECT_NE(profile.find("60 a 100 palavras"), std::string::npos);
    EXPECT_NE(profile.find("Estilo executivo"), std::string::npos);
    EXPECT_EQ(profile.find("Veredito primeiro"), std::string::npos) << "lead_with_answer was turned off";
    EXPECT_NE(profile.find("Trade-offs"), std::string::npos);
    EXPECT_NE(profile.find("Idioma de resposta preferencial: en-US"), std::string::npos);
    EXPECT_NE(profile.find("Linguagem para exemplos de código: Python"), std::string::npos);
}

TEST(RagQuality, NestedPlaybookStillReadWhenFlatFieldsAreMissing) {
    const auto p = MiniAgentProfile::from_json(
        R"({"id":"x","company":"Acme","playbook":{"name":"Technical Deep Dive","answer_length":"Thorough",)"
        R"("behavioral_structure":"CAR","lead_with_answer":false,"name_tradeoffs":true}})");
    ASSERT_TRUE(p.has_value());
    EXPECT_EQ(p->playbook_name, "Technical Deep Dive");
    EXPECT_EQ(p->playbook_answer_length, "Thorough");
    EXPECT_FALSE(p->playbook_lead_with_answer);
    MiniAgentRag rag{*p};
    const std::string pb = rag.playbook_block();
    EXPECT_NE(pb.find("150 a 230 palavras"), std::string::npos);
    EXPECT_NE(pb.find("estilo CAR/PAR"), std::string::npos);
    EXPECT_NE(pb.find("STAR"), std::string::npos) << "the HUD format stays STAR";
}

TEST(RagQuality, CodingLanguageAutoFollowsTheJob) {
    MiniAgentProfile p = nubank_goal();
    p.coding_language.clear();
    MiniAgentRag rag{p};
    EXPECT_NE(rag.playbook_block().find("Linguagem para exemplos de código: a da vaga"), std::string::npos);
}

// ------------------------------------------------------- prompt

TEST(RagQuality, SystemPromptExplainsLabelsSmallTalkAndUnknownTech) {
    const std::string p = copilot_system_prompt();
    EXPECT_NE(p.find("[SOBRE MIM]"), std::string::npos);
    EXPECT_NE(p.find("[SOBRE A EMPRESA/VAGA]"), std::string::npos);
    EXPECT_NE(p.find("Cumprimento, teste de áudio ou logística"), std::string::npos);
    EXPECT_NE(p.find("ainda não usei X em projeto"), std::string::npos);
    EXPECT_NE(p.find("salvo se o PLAYBOOK definir outra extensão"), std::string::npos);
}

TEST(RagQuality, FullPromptCarriesProfileRetrievalAndLiteralQuestion) {
    auto rag = std::make_shared<MiniAgentRag>(nubank_goal());
    PromptConfig cfg;
    cfg.session_profile = [rag] { return rag->session_profile_block(); };
    cfg.rag_retrieve = [rag](std::string_view q, std::string_view recent) { return rag->retrieve_block(q, recent); };
    const std::string q = "Me conta de uma vez que você teve um prazo apertado.";
    // The greeting names me: my name must not be read as a project and hide
    // the story that answers the question.
    const auto msgs = build_copilot_messages(cfg, "[Outros] Oi Bruno, vamos começar.\n", q, TriggerReason::Question);
    ASSERT_EQ(msgs.size(), 2u);
    EXPECT_NE(msgs[0].content.find("PLAYBOOK DESTA ENTREVISTA"), std::string::npos);
    EXPECT_NE(msgs[0].content.find("A empresa (Nubank)"), std::string::npos);
    EXPECT_NE(msgs[1].content.find("[SOBRE MIM"), std::string::npos);
    EXPECT_NE(msgs[1].content.find("(TechFinance.md)"), std::string::npos);
    EXPECT_NE(msgs[1].content.find("82%"), std::string::npos) << "the real metric must reach the model";
    EXPECT_NE(msgs[1].content.find("\"" + q + "\""), std::string::npos);
    // A number the files support passes the grounding check; an invented one does not.
    const std::string grounding = msgs[0].content + msgs[1].content;
    EXPECT_TRUE(ungrounded_numbers("Entregamos com 82% de acerto em 3 semanas.", grounding).empty());
    EXPECT_FALSE(ungrounded_numbers("Reduzimos o custo em 47%.", grounding).empty());
}
