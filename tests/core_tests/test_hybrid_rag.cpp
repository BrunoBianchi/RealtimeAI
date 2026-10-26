// Hybrid RAG (BM25 + dense embeddings fused by Reciprocal Rank Fusion).
// The dense side is optional and time-boxed: without it, or when it does not
// answer within its budget, retrieval must be exactly the BM25 path.
#include <gtest/gtest.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <functional>
#include <map>
#include <string>
#include <thread>
#include <vector>

#include "rtai/dense_rag.hpp"
#include "rtai/mini_agent.hpp"
#include "rtai/unigram_tokenizer.hpp"
#include "rtai/ini.hpp"
#include "rtai/settings.hpp"

using namespace rtai;
using namespace std::chrono_literals;

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

std::vector<std::string> sources(const RagDecision& d) {
    std::vector<std::string> out;
    for (const auto* c : d.chunks) out.push_back(c->source);
    return out;
}

// Index of the first chunk whose embedded text contains `needle`.
std::size_t chunk_with(const MiniAgentRag& rag, const std::string& needle) {
    const auto passages = rag.dense_passages();
    for (std::size_t i = 0; i < passages.size(); ++i)
        if (passages[i].find(needle) != std::string::npos) return i;
    ADD_FAILURE() << "no chunk with " << needle;
    return 0;
}

// Scripted dense side: fixed hits per question.
class ScriptedDense final : public IDenseSearch {
public:
    std::map<std::string, std::vector<DenseHit>> hits;
    int calls{0};
    std::vector<DenseHit> search(std::string_view q, std::size_t k) override {
        ++calls;
        auto it = hits.find(std::string(q));
        if (it == hits.end()) return {};
        auto v = it->second;
        if (v.size() > k) v.resize(k);
        return v;
    }
};

// Deterministic toy embedder: hashed bag of stems plus a few "topic"
// dimensions, so paraphrases without shared words still land close.
class ToyEmbedder final : public IEmbedder {
public:
    std::atomic<int> passage_calls{0};
    std::atomic<int> query_calls{0};
    std::chrono::milliseconds delay{0};
    std::size_t dim() const noexcept override { return 64; }
    std::string model_id() const override { return "toy-64"; }
    bool embed(std::string_view text, bool is_query, std::vector<float>& out) override {
        (is_query ? query_calls : passage_calls)++;
        if (delay.count() > 0) std::this_thread::sleep_for(delay);
        out.assign(64, 0.0f);
        for (const auto& t : MiniAgentRag::tokenize(text)) {
            int topic = -1;
            if (t == "prazo" || t == "deadl" || t == "relog" || t == "corre" || t == "press") topic = 0;
            if (t == "volum" || t == "milho" || t == "dado" || t == "data") topic = 1;
            if (topic >= 0) out[static_cast<std::size_t>(topic)] += 3.0f;
            out[8 + dense::fnv1a(t) % 56] += 1.0f;
        }
        return true;
    }
};

} // namespace

// ------------------------------------------------------------ fusion rules

TEST(HybridRag, WithoutDenseHitsRetrievalIsExactlyBm25) {
    MiniAgentRag plain{nubank_goal()};
    MiniAgentRag hybrid{nubank_goal()};
    auto dense = std::make_shared<ScriptedDense>(); // answers nothing
    hybrid.attach_dense(dense);
    for (const char* q : {"Me conta de uma vez que você teve um prazo apertado.", "Por que o Nubank?",
                          "Qual foi o maior desafio técnico do TechFinance?", "Fale sobre você.",
                          "Qual a diferença entre processo e thread?", "Oi, tudo bem?"}) {
        const auto a = plain.decide_rag_for_query(q, 5);
        const auto b = hybrid.decide_rag_for_query(q, 5);
        EXPECT_EQ(sources(a), sources(b)) << q;
        EXPECT_EQ(a.needed, b.needed) << q;
        EXPECT_FALSE(b.hybrid) << q;
    }
    EXPECT_GT(dense->calls, 0);
}

TEST(HybridRag, ParaphraseWithNoSharedWordIsFoundByMeaning) {
    MiniAgentRag rag{nubank_goal()};
    const std::string q = "Quando foi que você precisou correr contra o relógio?";
    const auto before = rag.decide_rag_for_query(q, 5);
    auto dense = std::make_shared<ScriptedDense>();
    dense->hits[q] = {{chunk_with(rag, "O prazo era de 3 semanas"), 0.87f}};
    rag.attach_dense(dense);
    const auto dec = rag.decide_rag_for_query(q, 5);
    EXPECT_TRUE(dec.hybrid);
    ASSERT_FALSE(dec.chunks.empty());
    EXPECT_EQ(dec.chunks.front()->source, "TechFinance.md");
    EXPECT_FALSE(has_source(before, "TechFinance.md") && before.chunks.front()->source == "TechFinance.md")
        << "test premise: BM25 alone should not lead with this story";
}

TEST(HybridRag, CitedProjectStillFiltersDenseHits) {
    MiniAgentRag rag{nubank_goal()};
    const std::string q = "Qual foi o maior desafio técnico do projeto de Kubernetes?";
    auto dense = std::make_shared<ScriptedDense>();
    dense->hits[q] = {{chunk_with(rag, "O prazo era de 3 semanas"), 0.95f},
                      {chunk_with(rag, "Cultura Nubank"), 0.93f},
                      {chunk_with(rag, "O maior desafio foi o volume"), 0.90f}};
    rag.attach_dense(dense);
    const auto dec = rag.decide_rag_for_query(q, 5);
    ASSERT_FALSE(dec.chunks.empty());
    EXPECT_EQ(dec.chunks.front()->source, "Kubernetes_5G.md");
    EXPECT_FALSE(has_source(dec, "TechFinance.md")) << "another project rode along via the dense side";
    EXPECT_FALSE(has_source(dec, "Nubank_cultura.pdf"));
}

TEST(HybridRag, StoryQuestionNeverAnchorsOnCompanyMaterialViaDense) {
    MiniAgentRag rag{nubank_goal()};
    const std::string q = "Conte uma situação difícil que você superou.";
    auto dense = std::make_shared<ScriptedDense>();
    dense->hits[q] = {{chunk_with(rag, "Cultura Nubank"), 0.95f}, {chunk_with(rag, "O prazo era de 3 semanas"), 0.88f}};
    rag.attach_dense(dense);
    const auto dec = rag.decide_rag_for_query(q, 5);
    ASSERT_FALSE(dec.chunks.empty());
    EXPECT_TRUE(dec.chunks.front()->is_candidate_project) << dec.chunks.front()->source;
    EXPECT_FALSE(has_source(dec, "Nubank_cultura.pdf"));
}

TEST(HybridRag, WeakSimilarityIsIgnored) {
    MiniAgentRag plain{nubank_goal()};
    MiniAgentRag rag{nubank_goal()};
    const std::string q = "Qual a diferença entre processo e thread?";
    auto dense = std::make_shared<ScriptedDense>();
    dense->hits[q] = {{chunk_with(rag, "O prazo era de 3 semanas"), 0.76f}};
    rag.attach_dense(dense);
    const auto dec = rag.decide_rag_for_query(q, 5);
    EXPECT_FALSE(dec.hybrid);
    EXPECT_EQ(sources(dec), sources(plain.decide_rag_for_query(q, 5)));
    EXPECT_TRUE(dec.chunks.empty());
}

TEST(HybridRag, DirectQuestionNeedsAStrongerMatch) {
    MiniAgentRag rag{nubank_goal()};
    const std::string q = "Como funciona a detecção de picos de tráfego?";
    auto dense = std::make_shared<ScriptedDense>();
    const std::size_t k8s = chunk_with(rag, "detecção de anomalias");
    dense->hits[q] = {{k8s, 0.81f}};
    rag.attach_dense(dense);
    EXPECT_FALSE(rag.decide_rag_for_query(q, 5).hybrid) << "0.81 is below 0.80 + 0.03 for a direct question";
    dense->hits[q] = {{k8s, 0.86f}};
    const auto dec = rag.decide_rag_for_query(q, 5);
    EXPECT_TRUE(dec.hybrid);
    EXPECT_TRUE(has_source(dec, "Kubernetes_5G.md"));
}

TEST(HybridRag, ExactNamesStillLeadWhenDenseDisagrees) {
    MiniAgentRag rag{nubank_goal()};
    const std::string q = "Me conta de uma vez que você teve um prazo apertado.";
    auto dense = std::make_shared<ScriptedDense>();
    // Dense prefers the 5G story; BM25 has TechFinance first. Both lists
    // agree on nothing else: BM25's higher weight keeps its leader.
    dense->hits[q] = {{chunk_with(rag, "O maior desafio foi o volume"), 0.84f}};
    rag.attach_dense(dense);
    const auto dec = rag.decide_rag_for_query(q, 5);
    EXPECT_TRUE(dec.hybrid);
    ASSERT_FALSE(dec.chunks.empty());
    EXPECT_EQ(dec.chunks.front()->source, "TechFinance.md");
}

TEST(HybridRag, HybridDecisionStaysUnderAMillisecondWhenTheQueryIsCached) {
    MiniAgentRag rag{nubank_goal()};
    const std::string q = "Quando foi que você precisou correr contra o relógio?";
    auto dense = std::make_shared<ScriptedDense>();
    dense->hits[q] = {{chunk_with(rag, "O prazo era de 3 semanas"), 0.87f},
                      {chunk_with(rag, "O maior desafio foi o volume"), 0.82f}};
    rag.attach_dense(dense);
    const auto t0 = std::chrono::steady_clock::now();
    constexpr int kRuns = 200;
    for (int i = 0; i < kRuns; ++i) (void)rag.retrieve_block(q, "Vamos falar de prazos.");
    const double avg_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count() / kRuns;
    EXPECT_LT(avg_ms, 1.0);
}

// ------------------------------------------------------- dense search

TEST(DenseSearch, BuildsIndexAndFindsByMeaning) {
    MiniAgentRag rag{nubank_goal()};
    auto emb = std::make_shared<ToyEmbedder>();
    EmbeddingDenseSearch::Options o;
    o.budget = 2000ms;
    auto ds = std::make_shared<EmbeddingDenseSearch>(emb, o);
    ds->build_index(rag.dense_passages());
    ASSERT_TRUE(ds->wait_ready(5s));
    EXPECT_EQ(ds->stats().indexed, rag.chunk_count());
    const auto hits = ds->search("pressão de prazo", 3);
    ASSERT_FALSE(hits.empty());
    EXPECT_NE(rag.dense_passages()[hits.front().index].find("TechFinance"), std::string::npos);
    // Second identical question: served from the cache, no new embedding.
    const int before = emb->query_calls.load();
    (void)ds->search("pressão  de prazo ", 3);
    EXPECT_EQ(emb->query_calls.load(), before);
    EXPECT_GE(ds->stats().cache_hits, 1u);
}

TEST(DenseSearch, IndexCacheSkipsReembeddingUnchangedMaterials) {
    MiniAgentRag rag{nubank_goal()};
    std::map<std::string, std::string> disk;
    auto load = [&](const std::string& fp) -> std::optional<std::string> {
        auto it = disk.find(fp);
        if (it == disk.end()) return std::nullopt;
        return it->second;
    };
    auto store = [&](const std::string& fp, const std::string& bytes) { disk[fp] = bytes; };
    {
        auto emb = std::make_shared<ToyEmbedder>();
        EmbeddingDenseSearch ds(emb);
        ds.build_index(rag.dense_passages(), load, store);
        ASSERT_TRUE(ds.wait_ready(5s));
        EXPECT_EQ(emb->passage_calls.load(), static_cast<int>(rag.chunk_count()));
    }
    ASSERT_EQ(disk.size(), 1u);
    {
        auto emb = std::make_shared<ToyEmbedder>();
        EmbeddingDenseSearch ds(emb);
        ds.build_index(rag.dense_passages(), load, store);
        ASSERT_TRUE(ds.wait_ready(5s));
        EXPECT_EQ(emb->passage_calls.load(), 0);
        EXPECT_TRUE(ds.stats().loaded_from_cache);
    }
    {
        // Edited material: new fingerprint, rebuilt.
        auto p = nubank_goal();
        p.documents[1].content += "\nNova linha.";
        MiniAgentRag edited{p};
        auto emb = std::make_shared<ToyEmbedder>();
        EmbeddingDenseSearch ds(emb);
        ds.build_index(edited.dense_passages(), load, store);
        ASSERT_TRUE(ds.wait_ready(5s));
        EXPECT_FALSE(ds.stats().loaded_from_cache);
    }
}

TEST(DenseSearch, SlowEmbeddingNeverBlocksPastTheBudget) {
    MiniAgentRag rag{nubank_goal()};
    auto emb = std::make_shared<ToyEmbedder>();
    EmbeddingDenseSearch::Options o;
    o.budget = 5ms;
    o.warm_up = false;
    auto ds = std::make_shared<EmbeddingDenseSearch>(emb, o);
    ds->build_index(rag.dense_passages());
    ASSERT_TRUE(ds->wait_ready(5s));
    emb->delay = 60ms;
    const auto t0 = std::chrono::steady_clock::now();
    const auto hits = ds->search("pressão de prazo", 3);
    const auto waited = std::chrono::steady_clock::now() - t0;
    EXPECT_TRUE(hits.empty());
    EXPECT_LT(waited, 40ms);
    EXPECT_EQ(ds->stats().timeouts, 1u);
    // The late embedding lands in the cache: the next call (the commit after
    // a speculation) gets it for free.
    std::this_thread::sleep_for(150ms);
    const auto t1 = std::chrono::steady_clock::now();
    EXPECT_FALSE(ds->search("pressão de prazo", 3).empty());
    EXPECT_LT(std::chrono::steady_clock::now() - t1, 5ms);
}

TEST(DenseSearch, ZeroBudgetUsesOnlyPrefetchedQueries) {
    MiniAgentRag rag{nubank_goal()};
    auto emb = std::make_shared<ToyEmbedder>();
    EmbeddingDenseSearch::Options o;
    o.budget = std::chrono::microseconds(0);
    auto ds = std::make_shared<EmbeddingDenseSearch>(emb, o);
    ds->build_index(rag.dense_passages());
    ASSERT_TRUE(ds->wait_ready(5s));
    ds->prefetch("volume de dados");
    for (int i = 0; i < 200 && ds->search("volume de dados", 3).empty(); ++i) std::this_thread::sleep_for(2ms);
    EXPECT_FALSE(ds->search("volume de dados", 3).empty());
    EXPECT_TRUE(ds->search("uma pergunta nunca vista", 3).empty());
}

TEST(DenseSearch, NotReadyMeansBm25Only) {
    MiniAgentRag plain{nubank_goal()};
    MiniAgentRag rag{nubank_goal()};
    auto emb = std::make_shared<ToyEmbedder>();
    auto ds = std::make_shared<EmbeddingDenseSearch>(emb);
    rag.attach_dense(ds); // index never built
    const char* q = "Me conta de uma vez que você teve um prazo apertado.";
    EXPECT_EQ(sources(rag.decide_rag_for_query(q, 5)), sources(plain.decide_rag_for_query(q, 5)));
    EXPECT_EQ(ds->stats().not_ready, 1u);
}

TEST(DenseIndexFile, RoundTripAndFingerprintCheck) {
    DenseIndex idx(3);
    ASSERT_TRUE(idx.add({1, 0, 0}));
    ASSERT_TRUE(idx.add({0, 1, 0}));
    EXPECT_FALSE(idx.add({1, 0}));
    const std::string fp = dense::fingerprint("m", {"a", "b"});
    EXPECT_NE(fp, dense::fingerprint("m", {"a", "c"}));
    EXPECT_NE(fp, dense::fingerprint("n", {"a", "b"}));
    const std::string bytes = idx.serialize(fp);
    auto back = DenseIndex::deserialize(bytes, fp);
    ASSERT_TRUE(back.has_value());
    EXPECT_EQ(back->size(), 2u);
    const auto hits = back->top_k({0, 1, 0}, 1);
    ASSERT_EQ(hits.size(), 1u);
    EXPECT_EQ(hits[0].index, 1u);
    EXPECT_FALSE(DenseIndex::deserialize(bytes, "other").has_value());
    EXPECT_FALSE(DenseIndex::deserialize(bytes.substr(0, bytes.size() - 1), fp).has_value());
}

// ------------------------------------------------------------ tokenizer

TEST(UnigramTokenizer, ViterbiPicksTheBestSegmentation) {
    // ids: 0 <s>, 1 <pad>, 2 </s>, 3 <unk>
    std::vector<std::pair<std::string, float>> v = {
        {"<s>", 0}, {"<pad>", 0}, {"</s>", 0}, {"<unk>", 0},
        {"\xE2\x96\x81", -2.0f},          // 4 ▁
        {"\xE2\x96\x81" "pro", -3.0f},    // 5 ▁pro
        {"jeto", -3.0f},                  // 6
        {"\xE2\x96\x81" "projeto", -4.0f},// 7 ▁projeto (beats ▁pro + jeto: -4 > -6)
        {"p", -5.0f}, {"r", -5.0f}, {"o", -5.0f}, {"j", -5.0f}, {"e", -5.0f}, {"t", -5.0f}, // 8..13
        {"\xC3\xA7\xC3\xA3o", -2.5f},     // 14 ção
        {"\xE2\x96\x81" "a", -2.0f},      // 15 ▁a
    };
    UnigramTokenizer tok(v, 3);
    EXPECT_EQ(tok.encode("projeto"), (std::vector<std::int64_t>{0, 7, 2}));
    EXPECT_EQ(tok.encode("  a   projeto "), (std::vector<std::int64_t>{0, 15, 7, 2}));
    EXPECT_EQ(tok.encode("ação"), (std::vector<std::int64_t>{0, 15, 14, 2})) << "multi-byte pieces";
    // Unknown characters fuse into one <unk>.
    EXPECT_EQ(tok.encode("a\xE6\xBC\xA2\xE5\xAD\x97"), (std::vector<std::int64_t>{0, 15, 3, 2}));
    // Truncation keeps <s> ... </s>.
    const auto t = tok.encode("a a a a a a", 4);
    EXPECT_EQ(t, (std::vector<std::int64_t>{0, 15, 15, 2}));
}

TEST(UnigramTokenizer, ReadsTokenizerJson) {
    const std::string json = R"({"version":"1.0","added_tokens":[{"id":0,"content":"<s>"}],
      "normalizer":null,
      "model":{"type":"Unigram","unk_id":3,"vocab":[["<s>",0.0],["<pad>",0.0],["</s>",0.0],["<unk>",0.0],
        ["▁",-2.5],["▁oi",-3.25],["\"q\"",-9.0],["😀",-7.0]]}})";
    auto tok = UnigramTokenizer::from_tokenizer_json(json);
    ASSERT_TRUE(tok.has_value());
    EXPECT_EQ(tok->vocab_size(), 8u);
    EXPECT_EQ(tok->encode("oi"), (std::vector<std::int64_t>{0, 5, 2}));
    EXPECT_EQ(tok->encode("\xF0\x9F\x98\x80"), (std::vector<std::int64_t>{0, 4, 7, 2})) << "surrogate pair decoded";
    EXPECT_FALSE(UnigramTokenizer::from_tokenizer_json("{}").has_value());
}

// ------------------------------------------------------- app plumbing

TEST(HybridRag, DeferredSearchIsBm25UntilTheModelArrives) {
    MiniAgentRag plain{nubank_goal()};
    MiniAgentRag rag{nubank_goal()};
    auto slot = std::make_shared<DeferredDenseSearch>();
    rag.attach_dense(slot);
    const std::string q = "Quando foi que você precisou correr contra o relógio?";
    MiniAgentRag::RetrievalTrace tr;
    (void)rag.retrieve_block(q, {}, 3200, &tr);
    EXPECT_FALSE(tr.hybrid);
    EXPECT_EQ(sources(rag.decide_rag_for_query(q, 5)), sources(plain.decide_rag_for_query(q, 5)));
    auto dense = std::make_shared<ScriptedDense>();
    dense->hits[q] = {{chunk_with(rag, "O prazo era de 3 semanas"), 0.87f}};
    slot->set(dense);
    const std::string block = rag.retrieve_block(q, {}, 3200, &tr);
    EXPECT_TRUE(tr.hybrid);
    EXPECT_GE(tr.chunks, 1u);
    EXPECT_NE(block.find("TechFinance"), std::string::npos);
    EXPECT_LT(tr.ms, 5.0);
}

TEST(HybridRag, SettingsHaveSafeDefaultsAndValidateInput) {
    const auto s = load_settings(ini::File::parse(default_config_text()), [](const char*) { return std::string(); },
                                 [](const std::string&) -> std::optional<std::string> { return std::nullopt; });
    EXPECT_TRUE(s.warnings.empty());
    EXPECT_TRUE(s.rag_hybrid);
    EXPECT_EQ(s.embed_budget_ms, 12);
    EXPECT_DOUBLE_EQ(s.embed_min_score, 0.80);
    const auto t = load_settings(ini::File::parse("[rag]\nhibrido = nao\norcamento_ms = 0\nsimilaridade_minima = 1.5\n"),
                                 [](const char*) { return std::string(); },
                                 [](const std::string&) -> std::optional<std::string> { return std::nullopt; });
    EXPECT_FALSE(t.rag_hybrid);
    EXPECT_EQ(t.embed_budget_ms, 0);
    EXPECT_DOUBLE_EQ(t.embed_min_score, 0.80);
    EXPECT_FALSE(t.warnings.empty());
    EXPECT_TRUE(is_known_setting("rag", "orcamento_ms"));
}
