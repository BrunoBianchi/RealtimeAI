// Pure core: Specialized Mini-Agent profile + Deep-Reading Mini-Compact +
// Autonomous in-memory BM25 RAG engine for interview cultural-fit alignment,
// persona coherence, and grounded document retrieval.
#pragma once

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "rtai/json_min.hpp"
#include "rtai/text_util.hpp"

namespace rtai {

struct RagDocument {
    std::string name;
    std::string path;
    std::string content;
    // Dashboard tag: "resume", "project", "job", "company", "material", "doc"...
    std::string tag;
};

// Who a document is about. Only Candidate documents are "my experience";
// Company/Job material is interview context and must never be told as a
// story of mine (a "Nubank_cultura.pdf" uploaded as material is not a
// project I built).
enum class RagDocKind { Candidate, Company, Job };

inline const char* to_string(RagDocKind k) noexcept {
    switch (k) {
        case RagDocKind::Company: return "company";
        case RagDocKind::Job: return "job";
        default: return "candidate";
    }
}

struct MiniAgentProfile {
    // Same fast model the dashboard uses for its analysis pass: the 72B model
    // used before kept dropping the stream on long inputs (12030 resets).
    static constexpr const char* kCompactAnalysisModel = "qwen/qwen3.6-flash";
    static constexpr const char* kCompactAnalysisEffort = "none";

    std::string id;
    std::string name;
    std::string company;
    std::string role;
    std::string job_description;
    std::string calendar_event;
    std::string company_dossier;
    std::string custom_instructions;
    std::string mini_compact; // Deep-reading executive summary & topic map always sent to the prompt
    // Fingerprint of the inputs the stored mini_compact was generated from
    // (see MiniAgentRag::source_fingerprint): lets the app skip the deep
    // reading pass when nothing changed since the last one.
    std::string mini_compact_fingerprint;
    std::string stage{"Active"};
    std::string next_interview_date;
    std::string next_interview_time;
    std::string next_focus;
    std::string playbook_name{"Standard STAR"};
    std::string playbook_answer_length{"Balanced"}; // "Concise", "Balanced", "Thorough"
    std::string playbook_behavioral_structure{"Auto"}; // "Auto", "STAR", "CAR", "PAR", "Direct"
    bool playbook_lead_with_answer{true};
    bool playbook_name_tradeoffs{false};
    std::string answer_language{"pt-BR"};
    std::string coding_language;
    std::vector<std::string> goal_memory_strengths;
    std::vector<std::string> goal_memory_improve;
    std::vector<RagDocument> documents;

    [[nodiscard]] bool empty() const noexcept {
        return text::trim(name).empty() &&
               text::trim(company).empty() &&
               text::trim(role).empty() &&
               text::trim(job_description).empty() &&
               text::trim(company_dossier).empty() &&
               text::trim(custom_instructions).empty() &&
               text::trim(mini_compact).empty() &&
               documents.empty();
    }

    static std::string slugify(std::string_view s) {
        const std::string folded = text::fold(text::trim(s));
        std::string out;
        bool last_dash = false;
        for (unsigned char c : folded) {
            if (std::isalnum(c)) {
                out.push_back(static_cast<char>(c));
                last_dash = false;
            } else if (!out.empty() && !last_dash) {
                out.push_back('-');
                last_dash = true;
            }
        }
        while (!out.empty() && out.back() == '-') out.pop_back();
        if (out.empty()) out = "sessao-agente";
        if (out.size() > 48) out.resize(48);
        return out;
    }

    [[nodiscard]] std::string to_json() const {
        json::Writer w;
        w.begin_object()
            .field("id", id.empty() ? slugify(name.empty() ? company : name) : id)
            .field("name", name)
            .field("company", company)
            .field("role", role)
            .field("job_description", job_description)
            .field("calendar_event", calendar_event)
            .field("company_dossier", company_dossier)
            .field("company_research", company_dossier)
            .field("custom_instructions", custom_instructions)
            .field("extra_instructions", custom_instructions)
            .field("mini_compact", mini_compact)
            .field("mini_compact_fingerprint", mini_compact_fingerprint)
            .field("stage", stage)
            .field("next_interview_date", next_interview_date)
            .field("next_interview_time", next_interview_time)
            .field("next_focus", next_focus)
            .field("playbook_name", playbook_name)
            .field("playbook_answer_length", playbook_answer_length)
            .field("playbook_behavioral_structure", playbook_behavioral_structure)
            .field("playbook_lead_with_answer", playbook_lead_with_answer)
            .field("playbook_name_tradeoffs", playbook_name_tradeoffs)
            .field("answer_language", answer_language)
            .field("coding_language", coding_language);

        // Nested playbook object for frontend parity
        w.key("playbook").begin_object()
            .field("name", playbook_name)
            .field("answer_length", playbook_answer_length)
            .field("behavioral_structure", playbook_behavioral_structure)
            .field("lead_with_answer", playbook_lead_with_answer)
            .field("name_tradeoffs", playbook_name_tradeoffs)
            .end_object();

        // Nested response_defaults
        w.key("response_defaults").begin_object()
            .field("answer_language", answer_language)
            .field("coding_language", coding_language)
            .end_object();

        // Nested next_interview
        w.key("next_interview").begin_object()
            .field("date", next_interview_date)
            .field("time", next_interview_time)
            .end_object();

        // Nested goal_memory
        w.key("goal_memory").begin_object();
        w.key("strengths").begin_array();
        for (const auto& s : goal_memory_strengths) w.string_value(s);
        w.end_array();
        w.key("improve").begin_array();
        for (const auto& s : goal_memory_improve) w.string_value(s);
        w.end_array();
        w.end_object();

        w.key("documents").begin_array();
        for (const auto& d : documents) {
            w.begin_object()
                .field("name", d.name)
                .field("title", d.name)
                .field("path", d.path)
                .field("tag", !d.tag.empty() ? d.tag : (d.path.empty() ? "doc" : d.path))
                .field("content", d.content)
                .end_object();
        }
        w.end_array().end_object();
        return std::move(w).str();
    }

    static std::optional<MiniAgentProfile> from_json(std::string_view raw) {
        auto parsed = json::Parser::parse(raw);
        if (!parsed || !parsed->is_object()) return std::nullopt;
        const auto& root = *parsed;
        MiniAgentProfile p;
        p.id = root["id"].as_string();
        p.name = root["name"].as_string();
        p.company = root["company"].as_string();
        p.role = root["role"].as_string();
        p.job_description = root["job_description"].as_string();
        p.calendar_event = root["calendar_event"].as_string();
        p.company_dossier = root["company_dossier"].as_string();
        if (p.company_dossier.empty()) {
            p.company_dossier = root["company_research"].as_string();
        }
        p.custom_instructions = root["custom_instructions"].as_string();
        if (p.custom_instructions.empty()) {
            p.custom_instructions = root["extra_instructions"].as_string();
        }
        p.mini_compact = root["mini_compact"].as_string();
        p.mini_compact_fingerprint = root["mini_compact_fingerprint"].as_string();

        p.stage = root["stage"].as_string();
        if (p.stage.empty()) p.stage = "Active";

        p.next_interview_date = root["next_interview_date"].as_string();
        p.next_interview_time = root["next_interview_time"].as_string();
        if (root["next_interview"].is_object()) {
            const auto& ni = root["next_interview"];
            if (p.next_interview_date.empty()) p.next_interview_date = ni["date"].as_string();
            if (p.next_interview_time.empty()) p.next_interview_time = ni["time"].as_string();
        }

        p.next_focus = root["next_focus"].as_string();

        p.playbook_name = root["playbook_name"].as_string();
        p.playbook_answer_length = root["playbook_answer_length"].as_string();
        p.playbook_behavioral_structure = root["playbook_behavioral_structure"].as_string();
        p.playbook_lead_with_answer = root["playbook_lead_with_answer"].as_bool(true);
        p.playbook_name_tradeoffs = root["playbook_name_tradeoffs"].as_bool(false);

        // The flat fields are what the dashboard edits; the nested "playbook"
        // object is only a fallback for files that lack them.
        if (root["playbook"].is_object()) {
            const auto& pb = root["playbook"];
            if (p.playbook_name.empty()) p.playbook_name = pb["name"].as_string();
            if (p.playbook_answer_length.empty()) p.playbook_answer_length = pb["answer_length"].as_string();
            if (p.playbook_behavioral_structure.empty()) p.playbook_behavioral_structure = pb["behavioral_structure"].as_string();
            if (!root["playbook_lead_with_answer"].is_bool() && pb["lead_with_answer"].is_bool())
                p.playbook_lead_with_answer = pb["lead_with_answer"].as_bool();
            if (!root["playbook_name_tradeoffs"].is_bool() && pb["name_tradeoffs"].is_bool())
                p.playbook_name_tradeoffs = pb["name_tradeoffs"].as_bool();
        }
        if (p.playbook_name.empty()) p.playbook_name = "Standard STAR";
        if (p.playbook_answer_length.empty()) p.playbook_answer_length = "Balanced";
        if (p.playbook_behavioral_structure.empty()) p.playbook_behavioral_structure = "Auto";

        p.answer_language = root["answer_language"].as_string();
        p.coding_language = root["coding_language"].as_string();
        if (root["response_defaults"].is_object()) {
            const auto& rd = root["response_defaults"];
            if (p.answer_language.empty()) p.answer_language = rd["answer_language"].as_string();
            if (p.coding_language.empty()) p.coding_language = rd["coding_language"].as_string();
        }
        if (p.answer_language.empty()) p.answer_language = "pt-BR";

        if (root["goal_memory"].is_object()) {
            const auto& gm = root["goal_memory"];
            if (gm["strengths"].is_array()) {
                for (std::size_t i = 0; i < gm["strengths"].size(); ++i) {
                    const std::string s = gm["strengths"].at(i).as_string();
                    if (!s.empty()) p.goal_memory_strengths.push_back(s);
                }
            }
            if (gm["improve"].is_array()) {
                for (std::size_t i = 0; i < gm["improve"].size(); ++i) {
                    const std::string s = gm["improve"].at(i).as_string();
                    if (!s.empty()) p.goal_memory_improve.push_back(s);
                }
            }
        }

        const auto& docs = root["documents"];
        if (docs.is_array()) {
            for (std::size_t i = 0; i < docs.size(); ++i) {
                const auto& item = docs.at(i);
                if (!item.is_object()) continue;
                RagDocument d;
                d.name = item["name"].as_string();
                if (d.name.empty()) d.name = item["title"].as_string();
                d.path = item["path"].as_string();
                d.tag = item["tag"].as_string();
                if (d.path.empty()) d.path = d.tag;
                d.content = item["content"].as_string();
                // The sample resume older dashboards put in the starter goal is
                // not the user's: never index it (it was inherited by new goals).
                if (text::trim(d.content).rfind(
                        "Engenheiro de Software com foco em sistemas de tempo real (C++20, Node.js, Python, Rust)", 0) == 0) {
                    continue;
                }
                if (!d.name.empty() || !d.content.empty()) {
                    p.documents.push_back(std::move(d));
                }
            }
        }
        if (p.id.empty()) p.id = slugify(p.name.empty() ? p.company : p.name);
        return p;
    }
};

struct RagChunk {
    std::size_t index{0};
    std::string source;
    std::string topic_summary;
    std::string text;
    // Stemmed term -> frequency (see MiniAgentRag::stem). Stemming lets
    // "implementei"/"implementação"/"implementation" or "projeto"/"project"
    // meet without the old O(vocabulary) prefix scan per query term.
    std::unordered_map<std::string, int> term_freq;
    std::size_t token_count{0};
    bool is_cultural_or_company{false};
    bool is_candidate_project{false};
    RagDocKind kind{RagDocKind::Candidate};
    // How much the chunk reads like a STAR story (actions, results, numbers):
    // picks the story to anchor a behavioral answer when no word matches.
    int story_score{0};
    // Precomputed once at index time so a query never re-folds every chunk
    // (the old code folded all chunk texts on every project-citing query).
    std::string folded_text;
    std::string folded_source;
    std::size_t doc_id{0};    // which document/section the chunk came from
    std::size_t doc_pos{0};   // position of the chunk inside that document
};

struct RagDecision {
    bool needed{false};
    double top_score{0.0};
    std::string reason;
    std::vector<const RagChunk*> chunks;
};

// What the interviewer is asking for; decides which material leads.
struct QueryIntent {
    bool company{false};     // why us / culture / values / what we do
    bool behavioral{false};  // "tell me about a time", conflict, deadline...
    bool technical{false};   // MY projects / experience / stack ("como você fez X?")
    bool intro{false};       // "fale sobre você", "tell me about yourself"
    // Everything else (concepts, logistics, opinions) is a direct question:
    // it is answered on its own and only borrows a file excerpt that is
    // really about the same subject.
    [[nodiscard]] bool direct() const noexcept { return !company && !behavioral && !technical && !intro; }
};

class MiniAgentRag {
public:
    MiniAgentRag() = default;
    explicit MiniAgentRag(MiniAgentProfile profile) { set_profile(std::move(profile)); }

    void set_profile(MiniAgentProfile profile) {
        profile_ = std::move(profile);
        company_label_ = derive_company_label(profile_);
        company_terms_ = derive_company_terms(profile_, company_label_);
        rebuild_index();
        if (text::trim(profile_.mini_compact).empty()) {
            profile_.mini_compact = synthesize_deep_mini_compact();
        }
    }

    [[nodiscard]] const MiniAgentProfile& profile() const noexcept { return profile_; }

    // Human name of the target company: "https://estagio.nubank.com.br/"
    // becomes "Nubank", so prompts never say "the company (https://...)".
    [[nodiscard]] const std::string& company_label() const noexcept { return company_label_; }

    [[nodiscard]] const std::vector<std::string>& candidate_project_terms() const noexcept {
        return candidate_project_terms_;
    }

    [[nodiscard]] RagDocKind document_kind(std::size_t i) const noexcept {
        return i < doc_kinds_.size() ? doc_kinds_[i] : RagDocKind::Candidate;
    }

    [[nodiscard]] bool cites_candidate_project(std::string_view query) const {
        return !cited_project_terms(query).empty();
    }

    // Project terms named in the text, exactly or with a transcription slip:
    // "Kubernets", "Vertes", "Tec Finance" still name Kubernetes, Vertis,
    // TechFinance (one edit for names of 6+ letters, two for 9+).
    [[nodiscard]] std::vector<std::string> cited_project_terms(std::string_view text_in) const {
        std::vector<std::string> out;
        if (candidate_project_terms_.empty() || text_in.empty()) return out;
        const std::string qf = text::fold(text_in);
        std::vector<std::string> words;
        {
            std::string w;
            for (unsigned char c : qf) {
                if (std::isalnum(c) || c == '+' || c == '#') w.push_back(static_cast<char>(c));
                else { if (!w.empty()) words.push_back(w); w.clear(); }
            }
            if (!w.empty()) words.push_back(w);
        }
        for (const auto& term : candidate_project_terms_) {
            if (term.empty()) continue;
            if (text::contains_word(qf, term)) { out.push_back(term); continue; }
            const bool multi = term.find(' ') != std::string::npos;
            std::string joined;
            for (char c : term) if (c != ' ') joined.push_back(c);
            if (joined.size() < 6) continue;
            const std::size_t max_d = joined.size() >= 9 ? 2 : 1;
            // Single words, and adjacent word pairs ("tec finance" -> "tecfinance").
            bool hit = false;
            for (std::size_t i = 0; i < words.size() && !hit; ++i) {
                if (!multi && words[i].size() + 2 >= joined.size() && edit_distance_at_most(words[i], joined, max_d)) hit = true;
                if (i + 1 < words.size()) {
                    const std::string pair = words[i] + words[i + 1];
                    if (pair.size() + 2 >= joined.size() && edit_distance_at_most(pair, joined, max_d)) hit = true;
                }
            }
            if (hit) out.push_back(term);
        }
        return out;
    }

    // Bounded Levenshtein distance check.
    static bool edit_distance_at_most(const std::string& a, const std::string& b, std::size_t max_d) {
        const std::size_t n = a.size(), m = b.size();
        if ((n > m ? n - m : m - n) > max_d) return false;
        std::vector<std::size_t> prev(m + 1), cur(m + 1);
        for (std::size_t j = 0; j <= m; ++j) prev[j] = j;
        for (std::size_t i = 1; i <= n; ++i) {
            cur[0] = i;
            std::size_t row_min = cur[0];
            for (std::size_t j = 1; j <= m; ++j) {
                const std::size_t sub = prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1);
                cur[j] = std::min({prev[j] + 1, cur[j - 1] + 1, sub});
                row_min = std::min(row_min, cur[j]);
            }
            if (row_min > max_d) return false;
            std::swap(prev, cur);
        }
        return prev[m] <= max_d;
    }
    [[nodiscard]] std::size_t chunk_count() const noexcept { return chunks_.size(); }

    [[nodiscard]] std::string mini_compact() const {
        std::lock_guard<std::mutex> lk(compact_mu_);
        return profile_.mini_compact;
    }

    void set_mini_compact(std::string compact) {
        std::lock_guard<std::mutex> lk(compact_mu_);
        profile_.mini_compact = std::move(compact);
    }

    // ------------------------------------------------------------------
    // Document classification (also used by the app when inheriting the
    // base résumé from another goal: only Candidate documents travel).
    // ------------------------------------------------------------------
    static RagDocKind classify_document(const RagDocument& d, const std::vector<std::string>& company_terms) {
        const std::string tag = text::fold(d.tag + " " + d.path);
        const std::string name = text::fold(d.name);
        auto has_any = [](const std::string& hay, std::initializer_list<const char*> kws) {
            for (const char* k : kws) if (has_keyword(hay, k)) return true;
            return false;
        };
        if (has_any(tag, {"resume", "cv", "curriculo", "curriculum", "project", "projeto", "portfolio"})) {
            return RagDocKind::Candidate;
        }
        if (has_any(tag, {"job", "vaga", "jd"})) return RagDocKind::Job;
        if (has_any(tag, {"company", "empresa", "dossie", "dossier", "cultura", "culture"})) return RagDocKind::Company;
        if (has_any(name, {"cv", "curriculo", "curriculum", "resume", "portfolio"})) return RagDocKind::Candidate;
        if (has_any(name, {"vaga", "job", "jd", "requisitos"})) return RagDocKind::Job;
        for (const auto& ct : company_terms) {
            if (text::contains_word(name, ct)) return RagDocKind::Company;
        }
        // Content: my own material is written in first person and does not
        // keep naming the target company.
        const std::string body = text::fold(text::truncate_utf8(d.content, 6000));
        int first_person = 0;
        for (const char* w : {"eu", "meu", "minha", "fiz", "desenvolvi", "implementei", "construi", "criei",
                              "liderei", "participei", "trabalhei", "fui", "atuei", "entreguei", "i", "my",
                              "built", "led", "developed", "implemented", "designed"}) {
            first_person += count_word(body, w);
        }
        int company_mentions = 0;
        for (const auto& ct : company_terms) company_mentions += count_word(body, ct);
        if (company_mentions >= 2 && first_person < 2) return RagDocKind::Company;
        return RagDocKind::Candidate;
    }

    // Stable hash of everything the Mini-Compact is generated from.
    [[nodiscard]] std::string source_fingerprint() const {
        std::uint64_t h = 1469598103934665603ULL;
        auto mix = [&](std::string_view s) {
            for (unsigned char c : s) { h ^= c; h *= 1099511628211ULL; }
            h ^= 0xFF; h *= 1099511628211ULL;
        };
        mix(kCompactPromptVersion);
        mix(profile_.company); mix(profile_.role); mix(profile_.job_description);
        mix(profile_.company_dossier); mix(profile_.custom_instructions);
        for (const auto& d : profile_.documents) { mix(d.name); mix(d.tag); mix(d.content); }
        static const char* hex = "0123456789abcdef";
        std::string out(16, '0');
        for (int i = 15; i >= 0; --i) { out[static_cast<std::size_t>(i)] = hex[h & 0xF]; h >>= 4; }
        return out;
    }

    // True when the stored Mini-Compact came from the deep-reading pass over
    // exactly the current inputs: the app can skip calling the model again.
    [[nodiscard]] bool mini_compact_is_current() const {
        return !text::trim(profile_.mini_compact).empty() &&
               profile_.mini_compact_fingerprint == source_fingerprint();
    }

    // Builds the prompt for the background Deep Reading & Compaction pass over
    // all uploaded documents, instructions, and company dossier.
    [[nodiscard]] std::string build_deep_reading_prompt() const {
        const std::string company = company_label_.empty() ? std::string("(não informada)") : company_label_;
        const std::string role = profile_.role.empty() ? std::string("(não informado)") : profile_.role;
        std::string p;
        p += "Write the MINI-COMPACT in English.\n";
        p += "Leia TODOS os materiais abaixo e gere um MINI-COMPACT fiel para o candidato consultar durante uma "
             "entrevista ao vivo para " + role + " na " + company + ".\n"
             "REGRAS DE FIDELIDADE (ZERO ALUCINAÇÃO):\n"
             "- Use SOMENTE fatos escritos nos materiais. Nunca invente ou presuma tecnologias, números, clientes ou experiências.\n"
             "- Copie números, datas e nomes exatamente como aparecem.\n"
             "- \"ARQUIVO DO CANDIDATO\" é sobre o candidato. \"MATERIAL DA EMPRESA/VAGA\" é sobre a " + company +
             " e NÃO é experiência do candidato: nunca transforme isso em história dele.\n"
             "Formato (texto puro, sem introdução, no máximo 450 palavras):\n"
             "[Quem sou]: formação, experiências (empresa, cargo, período) e stack comprovada, em bullets curtos.\n"
             "[Histórias STAR]: uma linha por experiência/projeto real: Situação | Tarefa | Ação | Resultado "
             "(escreva \"sem métrica no arquivo\" quando não houver número).\n"
             "[Empresa e vaga]: o que a " + company + " faz, valores e requisitos da vaga, e as conexões reais com o meu histórico.\n"
             "[Não consta nos arquivos]: tecnologias e experiências pedidas na vaga que NÃO aparecem nos meus arquivos.\n\n";
        if (!profile_.job_description.empty()) {
            p += "MATERIAL DA EMPRESA/VAGA [Descrição da vaga]:\n" + text::truncate_utf8(profile_.job_description, 2500) + "\n\n";
        }
        if (!profile_.company_dossier.empty()) {
            p += "MATERIAL DA EMPRESA/VAGA [Dossiê da empresa]:\n" + text::truncate_utf8(profile_.company_dossier, 2500) + "\n\n";
        }
        if (!profile_.custom_instructions.empty()) {
            p += "INSTRUÇÕES DO CANDIDATO:\n" + text::truncate_utf8(profile_.custom_instructions, 1500) + "\n\n";
        }
        // Split the document budget fairly so 13 files don't crowd each other out.
        const std::size_t n = std::max<std::size_t>(1, profile_.documents.size());
        const std::size_t per_doc = std::clamp<std::size_t>(48000 / n, 1500, 9000);
        for (std::size_t i = 0; i < profile_.documents.size(); ++i) {
            const auto& d = profile_.documents[i];
            p += std::string(document_kind(i) == RagDocKind::Candidate ? "ARQUIVO DO CANDIDATO" : "MATERIAL DA EMPRESA/VAGA") +
                 " [" + d.name + "]:\n" + text::truncate_utf8(d.content, per_doc) + "\n\n";
        }
        return p;
    }

    // Deterministic local Mini-Compact (used until/unless the background deep
    // reading pass returns): Persona + Key Projects/Facts + Cultural Fit +
    // Topic Map + Playbook. Always sent in the prompt.
    [[nodiscard]] std::string synthesize_deep_mini_compact() const {
        std::string out;
        out.reserve(3600);

        out += "[1. Persona & Alvo da Entrevista]\n";
        if (!company_label_.empty() || !profile_.role.empty()) {
            out += "• Candidato a " + (profile_.role.empty() ? std::string("Especialista") : profile_.role) +
                   (company_label_.empty() ? "" : " na empresa " + company_label_) + ".\n";
        }
        if (!profile_.calendar_event.empty()) {
            out += "• Sessão vinculada ao evento: " + profile_.calendar_event + ".\n";
        }
        if (!text::trim(profile_.job_description).empty()) {
            out += "• Escopo e Requisitos da Vaga: " +
                   text::truncate_utf8(collapse_ws(profile_.job_description), 450) + "\n";
        }

        const std::string instr = text::trim(profile_.custom_instructions);
        if (!instr.empty()) {
            out += "\n[2. Diretrizes de Comportamento & Fit Cultural]\n";
            out += text::truncate_utf8(collapse_ws(instr), 400) + "\n";
        }

        const std::string dossier = text::trim(profile_.company_dossier);
        std::vector<std::size_t> cand_docs, company_docs;
        for (std::size_t i = 0; i < profile_.documents.size(); ++i) {
            (document_kind(i) == RagDocKind::Candidate ? cand_docs : company_docs).push_back(i);
        }
        if (!dossier.empty() || !company_docs.empty()) {
            out += "\n[3. Síntese Real da Empresa & Cultura]\n";
            if (!dossier.empty()) out += text::truncate_utf8(collapse_ws(dossier), 500) + "\n";
            for (std::size_t i : company_docs) {
                const auto& doc = profile_.documents[i];
                out += "• Material [" + doc.name + "] (sobre a empresa/vaga, não é experiência minha): " +
                       extract_high_signal_highlights(doc.content, 220) + "\n";
            }
        }

        if (!cand_docs.empty()) {
            out += "\n[4. Leitura Aprofundada dos Arquivos Enviados (Fatos Reais do Candidato — Não Invente Nada Fora Disso)]\n";
            const std::size_t per_doc = std::clamp<std::size_t>(1500 / cand_docs.size(), 160, 600);
            for (std::size_t i : cand_docs) {
                const auto& doc = profile_.documents[i];
                out += "• Arquivo [" + doc.name + "]: " + extract_high_signal_highlights(doc.content, per_doc) + "\n";
            }
        }

        if (!chunks_.empty()) {
            out += "\n[5. Mapa de Assuntos no RAG (" + std::to_string(chunks_.size()) + " chunks indexados)]\n";
            std::size_t shown = 0;
            std::size_t last_doc = static_cast<std::size_t>(-1);
            for (const auto& ch : chunks_) {
                if (shown >= 8) break;
                if (ch.doc_id == last_doc) continue; // one line per document
                last_doc = ch.doc_id;
                out += "  #" + std::to_string(++shown) + " [" + ch.source + "]: " + ch.topic_summary + "\n";
            }
        }

        if (!text::trim(profile_.next_focus).empty()) {
            out += "\n[6. Next Focus — Foco Específico para esta Sessão]\n";
            out += "• " + text::truncate_utf8(text::trim(profile_.next_focus), 450) + "\n";
        }

        // The playbook is reserved: the material above is trimmed to fit, never it.
        const std::string pb = text::trim(playbook_block());
        constexpr std::size_t kCompactMax = 3600;
        const std::size_t body_max = kCompactMax > pb.size() + 2 ? kCompactMax - pb.size() - 2 : 0;
        return text::trim(text::truncate_utf8(text::trim(out), body_max)) + "\n\n" + pb;
    }

    // The answer playbook of this goal. Always reaches the prompt (it is
    // re-added after any compact that lost it).
    [[nodiscard]] std::string playbook_block() const {
        std::string out = "[7. Diretrizes do Playbook de Resposta (" +
                          (profile_.playbook_name.empty() ? std::string("Standard STAR") : profile_.playbook_name) + ")]\n";
        // STAR is mandatory for every answer (CAR/PAR/Direct playbooks are
        // mapped to STAR): the HUD and the system prompt are built around it.
        out += "• Estrutura comportamental obrigatória: STAR (Situação, Tarefa, Ação, Resultado) em todas as respostas de entrevista.\n";
        // The playbook's style, kept inside the four STAR labels.
        const std::string style = text::fold(profile_.playbook_behavioral_structure + " " + profile_.playbook_name);
        if (has_keyword(style, "executive") || has_keyword(style, "impact")) {
            out += "• Estilo executivo: a primeira frase da Situação já traz o impacto/resultado principal; "
                   "Ação foca em decisões e trade-offs, não em detalhes de implementação.\n";
        } else if (has_keyword(style, "direct") || has_keyword(style, "direto")) {
            out += "• Estilo direto: cada linha STAR com uma única frase curta, sem contexto acessório.\n";
        } else if (count_word(style, "car") > 0 || count_word(style, "par") > 0) {
            out += "• Ênfase no desafio/problema (estilo CAR/PAR): Situação e Tarefa deixam claro o problema; "
                   "mantenha os 4 rótulos STAR.\n";
        }
        if (profile_.playbook_lead_with_answer) {
            out += "• Veredito primeiro: a primeira frase da Situação já deixa clara a resposta direta à pergunta.\n";
        }
        const std::string& len = profile_.playbook_answer_length;
        out += "• Extensão de resposta: " + len + " (" +
               (len == "Concise" ? std::string("60 a 100 palavras, só o essencial") :
                len == "Thorough" ? std::string("150 a 230 palavras, com arquitetura, métricas e trade-offs") :
                std::string("90 a 170 palavras, equilibrando contexto, ações e resultados")) +
               "; isto prevalece sobre o padrão).\n";
        if (profile_.playbook_name_tradeoffs) {
            out += "• Trade-offs: mencione ativamente os prós e contras das escolhas técnicas tomadas.\n";
        }
        if (text::fold(profile_.answer_language) == "auto") {
            out += "• Idioma de resposta: sempre o mesmo idioma em que o entrevistador fez a pergunta.\n";
        } else if (!profile_.answer_language.empty()) {
            out += "• Idioma de resposta preferencial: " + profile_.answer_language +
                   " (se o entrevistador falar em outro idioma, responda no idioma dele).\n";
        }
        if (!profile_.coding_language.empty()) {
            out += "• Linguagem para exemplos de código: " + profile_.coding_language +
                   " (todo código, pseudocódigo ou sintaxe citada sai nesta linguagem).\n";
        } else {
            out += "• Linguagem para exemplos de código: a da vaga; se a vaga não disser, a que mais aparece nos meus arquivos.\n";
        }
        return out;
    }

    // Light stemmer shared by indexing and querying: folded token, plural "s"
    // dropped, then truncated to 5 bytes. Truncation stemming is a well-known
    // cheap baseline for Portuguese and, as a bonus, lines up many PT/EN
    // cognates ("projeto"/"project" -> "proje", "processo"/"process" ->
    // "proce"). Tokens that carry digits or symbols (C++, C#, p99, 2025,
    // nova-3) are kept whole so numbers stay exact.
    static std::string stem(std::string t) {
        for (char c : t) {
            if ((c >= '0' && c <= '9') || c == '+' || c == '#') return t;
        }
        if (t.size() >= 4 && t.back() == 's') t.pop_back();
        if (t.size() > 5) t.resize(5);
        return t;
    }

    // Folds, splits, drops stop words and stems.
    static std::vector<std::string> tokenize(std::string_view input) {
        const std::string folded = text::fold(input);
        std::vector<std::string> tokens;
        std::string cur;
        auto flush = [&]() {
            if (cur.size() >= 2 && !is_stop_word(cur)) {
                tokens.push_back(stem(std::move(cur)));
            }
            cur.clear();
        };
        for (unsigned char c : folded) {
            if (std::isalnum(c) || c == '+' || c == '#') {
                cur.push_back(static_cast<char>(c));
            } else {
                flush();
            }
        }
        flush();
        return tokens;
    }

    [[nodiscard]] QueryIntent classify_query(std::string_view query) const {
        QueryIntent in;
        const std::string f = text::fold(query);
        in.company = is_company_query(f);
        for (const auto& ct : company_terms_) {
            if (text::contains_word(f, ct)) { in.company = true; break; }
        }
        in.intro = is_intro_query(f);
        in.behavioral = !in.intro && is_behavioral_query(f);
        in.technical = !in.intro && is_technical_query(f);
        return in;
    }

    // Autonomous RAG decision: determines whether the query needs detailed
    // chunk retrieval beyond the always-present Mini-Compact, and returns only
    // the chunks that genuinely add detail for the current question.
    //
    // `query` is the literal question (full weight). `context` is optional
    // recent dialogue (e.g. the interviewer's previous turns): its terms count
    // at 0.3 so follow-ups like "e como você escalou isso?" still find the
    // project, without the history drowning the actual question.
    [[nodiscard]] RagDecision decide_rag_for_query(std::string_view query,
                                                   std::size_t top_k = 4,
                                                   std::string_view context = {}) const {
        RagDecision dec;
        if (chunks_.empty()) {
            dec.needed = false;
            dec.reason = "Sem chunks adicionais no índice RAG; usando apenas o Mini-Compact.";
            return dec;
        }

        auto q_terms = build_query_terms(query, context);
        const std::size_t primary_terms = tokenize(query).size();
        const QueryIntent intent = classify_query(query);
        const bool story_q = intent.behavioral || intent.technical;
        // A project named in the question filters the retrieval to it. One
        // named only in the previous lines ("Vamos falar do Hackathon." then
        // "Qual foi o maior desafio?") boosts it without hiding the rest: the
        // new question may well be about something else.
        const bool cites_in_query = cites_candidate_project(query);
        const bool cites_in_context = !cites_in_query && !context.empty() && cites_candidate_project(context);
        const bool cites_proj = cites_in_query;

        std::vector<std::string> cited_terms = cites_in_query ? cited_project_terms(query) : std::vector<std::string>{};
        std::vector<std::string> context_terms = cites_in_context ? cited_project_terms(context) : std::vector<std::string>{};

        struct Scored {
            std::size_t idx;
            double score;
        };
        std::vector<Scored> scored;
        scored.reserve(chunks_.size());

        const double n_docs = static_cast<double>(chunks_.size());
        constexpr double k1 = 1.5;
        constexpr double b = 0.75;
        const double avgdl = std::max(1.0, avg_tokens_);
        auto idf_of = [&](const std::string& term) {
            const auto df_it = doc_freq_.find(term);
            const double df = df_it != doc_freq_.end() ? static_cast<double>(df_it->second) : 0.0;
            return std::log(1.0 + (n_docs - df + 0.5) / (df + 0.5));
        };
        // Weight of the question itself (full-weight terms). A chunk that
        // matches only a small share of it ("processo" in "diferença entre
        // processo e thread") is a word collision, not an answer.
        // A project named with a transcription slip searches with its real name.
        for (const auto& term : cited_terms) {
            for (const auto& tk : tokenize(term)) {
                if (std::none_of(q_terms.begin(), q_terms.end(), [&](const WeightedTerm& w) { return w.term == tk; }))
                    q_terms.push_back(WeightedTerm{tk, 1.0});
            }
        }
        double question_mass = 0.0;
        for (const auto& qt : q_terms) {
            if (qt.weight < 1.0) continue;
            // A word that appears in no file ("escolheu", "thread") still
            // counts, at half weight: half a question unmatched is a sign the
            // files are not about it, a single ordinary verb is not.
            const bool known = doc_freq_.count(qt.term) > 0;
            question_mass += known ? idf_of(qt.term) : idf_of(qt.term) * 0.5;
        }

        std::vector<double> coverage(chunks_.size(), 0.0);
        for (std::size_t i = 0; i < chunks_.size(); ++i) {
            const auto& ch = chunks_[i];
            double s = 0.0;
            double covered = 0.0;
            for (const auto& qt : q_terms) {
                auto it = ch.term_freq.find(qt.term);
                if (it == ch.term_freq.end()) continue;
                const double tf = static_cast<double>(it->second);
                const double idf = idf_of(qt.term);
                const double dl = static_cast<double>(ch.token_count);
                s += qt.weight * idf * ((tf * (k1 + 1.0)) / (tf + k1 * (1.0 - b + b * (dl / avgdl))));
                if (qt.weight >= 1.0) covered += idf;
                else if (qt.weight >= 0.5) covered += idf * 0.5; // PT/EN synonym of a question word
            }
            coverage[i] = question_mass > 0.0 ? std::min(1.0, covered / question_mass) : 0.0;
            if (cites_proj) {
                bool chunk_has_cited_term = false;
                for (const auto& ct : cited_terms) {
                    if (chunk_mentions(ch, ct)) {
                        chunk_has_cited_term = true;
                        break;
                    }
                }
                if (ch.is_candidate_project && chunk_has_cited_term) {
                    s += 1.75;
                } else if (ch.is_candidate_project) {
                    // Another story of mine: one story per answer, so a
                    // different project never rides along with the cited one.
                    s = 0.0;
                } else if (ch.is_cultural_or_company && !chunk_has_cited_term && !intent.company) {
                    s = 0.0; // never anchor a candidate-project question on the target company
                }
            } else if (cites_in_context && ch.is_candidate_project &&
                       std::any_of(context_terms.begin(), context_terms.end(), [&](const std::string& ct) {
                           return chunk_mentions(ch, ct);
                       })) {
                s += 1.0;
                if (story_q) s += 0.65;
            } else if (s > 0.0) {
                // Intent decides which side leads: "why us?" is answered with
                // the company material, a "tell me about a time" with my files.
                if (intent.company && ch.is_cultural_or_company) s += 1.25;
                if (story_q && ch.is_candidate_project) s += 0.65;
                if (story_q && !intent.company && ch.is_cultural_or_company) s *= 0.6;
            }
            if (s > 0.0) {
                scored.push_back(Scored{i, s});
            }
        }

        std::stable_sort(scored.begin(), scored.end(),
                         [](const Scored& a, const Scored& b2) { return a.score > b2.score; });

        if (!scored.empty()) {
            dec.top_score = scored.front().score;
        }

        // Relative cut: keep chunks that score at least 30% of the best one
        // (and an absolute floor), so weak keyword collisions don't ride along
        // and mix unrelated facts into the answer.
        // Minimum share of the question a chunk must match. Direct questions
        // (concepts, logistics) are the strictest: an excerpt rides along only
        // when it is about the same subject. A cited project is exempt.
        const double min_coverage = cites_proj ? 0.0 : intent.direct() ? 0.5 : 0.3;
        auto take_ranked = [&](std::size_t limit) {
            const double floor_score = std::max(0.25, dec.top_score * 0.30);
            for (std::size_t i = 0; i < scored.size() && dec.chunks.size() < limit; ++i) {
                const bool context_boosted = cites_in_context && chunks_[scored[i].idx].is_candidate_project &&
                                             scored[i].score >= 1.0;
                if (coverage[scored[i].idx] < min_coverage && !context_boosted) continue;
                if (dec.chunks.empty() || scored[i].score >= floor_score) dec.chunks.push_back(&chunks_[scored[i].idx]);
            }
        };

        const bool any_intent = intent.company || story_q || intent.intro;
        if (cites_proj) {
            dec.needed = true;
            dec.reason = "Pergunta cita projeto do candidato; priorizando chunks do projeto indexado no RAG.";
            take_ranked(top_k);
            if (dec.chunks.empty()) {
                // Fallback for cited project: attach the first chunks of the cited project.
                for (const auto& ch : chunks_) {
                    if (!ch.is_candidate_project) continue;
                    bool matches_term = cited_terms.empty();
                    for (const auto& ct : cited_terms) {
                        if (chunk_mentions(ch, ct)) {
                            matches_term = true;
                            break;
                        }
                    }
                    if (matches_term) {
                        dec.chunks.push_back(&ch);
                        if (dec.chunks.size() >= std::min<std::size_t>(2, top_k)) break;
                    }
                }
            }
        } else if (!scored.empty() && (dec.top_score >= 0.35 || any_intent)) {
            dec.needed = true;
            dec.reason = "Pergunta requer aprofundamento específico nos documentos/dossiê indexados no RAG.";
            take_ranked(top_k);
            if (dec.chunks.empty() && !any_intent) {
                dec.needed = false;
                dec.reason = "Nenhum trecho trata do assunto desta pergunta.";
                return dec;
            }
        } else if ((intent.behavioral || intent.intro) && has_candidate_chunks_) {
            dec.needed = true;
            dec.reason = "Pergunta comportamental/apresentação: anexando as histórias reais do candidato.";
        } else if (primary_terms >= 3 && any_intent) {
            dec.needed = true;
            dec.reason = "Pergunta comportamental sem termo direto: anexando as histórias reais do candidato para o STAR.";
        } else if (intent.company && company_chunks_ > 0) {
            dec.needed = true;
            dec.reason = "Pergunta sobre a empresa: anexando o material da empresa.";
        } else {
            dec.needed = false;
            dec.reason = "O Mini-Compact e o histórico da conversa já cobrem este turno sem necessidade de busca extra no RAG.";
            return dec;
        }

        // Story continuity: a STAR answer usually needs the paragraph right
        // after the best-matching one (the "ação/resultado" often lives there).
        if (!dec.chunks.empty() && dec.chunks.front()->is_candidate_project && dec.chunks.size() < top_k + 1) {
            const RagChunk* top = dec.chunks.front();
            for (const auto& ch : chunks_) {
                if (ch.doc_id == top->doc_id && ch.doc_pos == top->doc_pos + 1) {
                    if (std::find(dec.chunks.begin(), dec.chunks.end(), &ch) == dec.chunks.end()) {
                        dec.chunks.push_back(&ch);
                    }
                    break;
                }
            }
        }

        // "Fale sobre você": the résumé opening (education + experiences).
        if (intent.intro && has_candidate_chunks_) {
            std::vector<const RagChunk*> intro;
            for (std::size_t di = 0; di < profile_.documents.size() && intro.size() < 2; ++di) {
                if (doc_kinds_[di] != RagDocKind::Candidate) continue;
                const auto& d = profile_.documents[di];
                const std::string meta = text::fold(d.tag + " " + d.path + " " + d.name);
                if (!any_keyword(meta, {"resume", "cv", "curriculo", "curriculum"})) continue;
                for (const auto& ch : chunks_) {
                    if (ch.doc_id == di && ch.doc_pos <= 1 && intro.size() < 2) intro.push_back(&ch);
                }
            }
            for (auto it = intro.rbegin(); it != intro.rend(); ++it) {
                if (std::find(dec.chunks.begin(), dec.chunks.end(), *it) == dec.chunks.end())
                    dec.chunks.insert(dec.chunks.begin(), *it);
            }
        }

        // "Why us?" with nothing matched lexically: the company material is
        // still the right grounding (values, mission) for the answer.
        if (intent.company && company_chunks_ > 0 &&
            std::none_of(dec.chunks.begin(), dec.chunks.end(),
                         [](const RagChunk* c) { return c->is_cultural_or_company; })) {
            std::size_t added = 0;
            for (const auto& ch : chunks_) {
                if (added >= 2) break;
                if (ch.kind == RagDocKind::Company && ch.doc_pos == 0) { dec.chunks.push_back(&ch); ++added; }
            }
        }

        // STAR grounding: behavioral/experience questions must be answered with
        // a REAL story. If nothing from the candidate's own files was selected,
        // attach the candidate chunks that read most like a story (actions,
        // results, numbers), from different documents, so the model picks a
        // real one instead of inventing it.
        if ((intent.behavioral || intent.intro || intent.company) && has_candidate_chunks_) {
            const bool has_candidate = std::any_of(dec.chunks.begin(), dec.chunks.end(),
                                                   [](const RagChunk* c) { return c->is_candidate_project; });
            if (!has_candidate) {
                std::size_t added = 0;
                for (const auto& sc : scored) {
                    if (added >= 2) break;
                    if (chunks_[sc.idx].is_candidate_project) {
                        dec.chunks.push_back(&chunks_[sc.idx]);
                        ++added;
                    }
                }
                std::vector<const RagChunk*> stories;
                for (const auto& ch : chunks_) {
                    if (ch.is_candidate_project &&
                        std::find(dec.chunks.begin(), dec.chunks.end(), &ch) == dec.chunks.end()) {
                        stories.push_back(&ch);
                    }
                }
                std::stable_sort(stories.begin(), stories.end(), [](const RagChunk* a, const RagChunk* b2) {
                    return a->story_score > b2->story_score;
                });
                std::vector<std::size_t> used_docs;
                for (const RagChunk* ch : stories) {
                    if (added >= 2) break;
                    if (std::find(used_docs.begin(), used_docs.end(), ch->doc_id) != used_docs.end()) continue;
                    dec.chunks.push_back(ch);
                    used_docs.push_back(ch->doc_id);
                    ++added;
                }
            }
        }
        return dec;
    }

    // Backwards-compatible helper returning top-K chunks directly.
    [[nodiscard]] std::vector<const RagChunk*> retrieve_chunks(std::string_view query,
                                                               std::size_t top_k = 4) const {
        auto dec = decide_rag_for_query(query, top_k);
        if (!dec.chunks.empty()) return dec.chunks;
        std::vector<const RagChunk*> fallback;
        for (std::size_t i = 0; i < std::min(top_k, chunks_.size()); ++i) {
            fallback.push_back(&chunks_[i]);
        }
        return fallback;
    }

    // Stable, per-session part of the context: the anti-hallucination rule
    // (with the real document names), the answer playbook, the Mini-Compact
    // and the user's notes. It changes only when the background deep-reading
    // pass finishes, so it goes in the SYSTEM message where providers can
    // cache the prefix. Order matters: if the caller truncates, the notes and
    // the tail of the compact go first, never the rules or the playbook.
    [[nodiscard]] std::string session_profile_block(std::string_view base_user_context = {}) const {
        std::string out;
        out.reserve(6000);
        const std::string company = company_label_.empty() ? std::string("Empresa Alvo") : company_label_;
        out += "=== REGRA DE OURO ANTI-ALUCINAÇÃO (FONTE ÚNICA DE VERDADE DO RAG) ===\n"
               "• DISTINÇÃO CRÍTICA ENTRE EMPRESA-ALVO E PROJETOS DO CANDIDATO:\n"
               "  - A empresa (" + company +
               ") é a EMPRESA ONDE VOCÊ ESTÁ FAZENDO A ENTREVISTA. Você NUNCA trabalhou lá nem criou os produtos dela (a menos que conste explicitamente no currículo).\n";
        auto list_docs = [&](RagDocKind want) {
            std::string names;
            std::size_t n = 0;
            for (std::size_t i = 0; i < profile_.documents.size(); ++i) {
                const auto& d = profile_.documents[i];
                if (d.name.empty() || document_kind(i) != want) continue;
                if (n >= 10) { names += ", ..."; break; }
                if (n++) names += ", ";
                names += d.name;
            }
            return names;
        };
        const std::string mine = list_docs(RagDocKind::Candidate);
        if (!mine.empty()) {
            out += "  - Os SEUS projetos/experiências são EXCLUSIVAMENTE os dos DOCUMENTOS DO RAG (" + mine +
                   "). NUNCA misture seus projetos com produtos da empresa da entrevista, nem fatos de um projeto com outro.\n";
        }
        std::string theirs = list_docs(RagDocKind::Company);
        const std::string job_docs = list_docs(RagDocKind::Job);
        if (!job_docs.empty()) theirs += (theirs.empty() ? "" : ", ") + job_docs;
        if (!theirs.empty()) {
            out += "  - Material sobre a empresa/vaga (" + theirs +
                   ") é contexto da entrevista: use para conectar com a " + company +
                   ", NUNCA como experiência sua.\n";
        }
        out += "• PROIBIDO INVENTAR FATOS: tudo sobre o candidato, seus projetos, stacks e métricas "
               "DEVE vir exclusivamente do MINI-COMPACT e dos TRECHOS RECUPERADOS (ou do que [Você] já falou na transcrição). "
               "Se um detalhe não estiver escrito, NÃO afirme que ele existe.\n\n";

        std::string current_compact = mini_compact();
        std::string compact = text::trim(current_compact.empty() ? synthesize_deep_mini_compact() : current_compact);
        // Older stored compacts may end in a truncated playbook; the playbook
        // is always re-added in full below, before the compact.
        const auto pb_pos = compact.find("[7. Diretrizes do Playbook");
        if (pb_pos != std::string::npos) compact = text::trim(compact.substr(0, pb_pos));

        out += "=== PLAYBOOK DESTA ENTREVISTA ===\n" + playbook_block() + "\n";
        if (!compact.empty()) {
            out += "=== MINI-COMPACT SEMPRE PRESENTE (PERSONA, PROJETOS, FIT CULTURAL & MAPA DE ASSUNTOS) ===\n";
            out += text::truncate_utf8(compact, 3600) + "\n";
        }
        const std::string base = text::trim(base_user_context);
        if (!base.empty()) {
            out += "\n=== NOTAS ADICIONAIS DO CONFIG ===\n";
            out += text::truncate_utf8(base, 2500) + "\n";
        }
        return text::trim(out);
    }

    // Per-question part of the context: the retrieved chunks (only the
    // relevant ones, deduplicated, within budget), split by who they are
    // about so the model never tells company material as my experience.
    [[nodiscard]] std::string retrieve_block(std::string_view query, std::string_view context = {},
                                             std::size_t max_chars = 3200) const {
        const RagDecision dec = decide_rag_for_query(query, 5, context);
        const QueryIntent intent = classify_query(query);
        std::string out = "=== DECISÃO AUTÔNOMA DO RAG ===\n";
        out += "Tipo de pergunta: " + std::string(intent_guidance(intent, cites_candidate_project(query), asks_about_me(query))) + "\n";
        if (!dec.needed || dec.chunks.empty()) {
            if (asks_about_me(query)) {
                out += "Nenhum trecho dos meus arquivos responde a isto. Use só o que está no perfil da sessão e na conversa; "
                       "se o fato não estiver lá, NÃO invente: diga com naturalidade que não tenho esse detalhe agora "
                       "ou responda de forma geral, sem afirmar experiência, número, empresa ou data.\n";
            } else {
                out += "Nenhum trecho específico para esta fala: use o perfil da sessão e a conversa.\n";
            }
            return text::trim(out);
        }
        out += "Trechos recuperados dos arquivos enviados (use só o que está escrito):\n";
        std::vector<const RagChunk*> mine, theirs;
        for (const RagChunk* ch : dec.chunks) (ch->is_candidate_project ? mine : theirs).push_back(ch);
        const bool company_first = intent.company && !cites_candidate_project(query);

        std::size_t budget = max_chars > out.size() ? max_chars - out.size() : 0;
        auto emit = [&](const std::vector<const RagChunk*>& group, const char* heading) {
            if (group.empty() || budget < 120) return;
            const std::string h = std::string(heading) + "\n";
            out += h;
            budget = budget > h.size() ? budget - h.size() : 0;
            for (const RagChunk* ch : group) {
                std::string entry = "• (" + ch->source + ") " + ch->text + "\n";
                if (entry.size() > budget) {
                    if (budget > 200) {
                        out += text::truncate_utf8(entry, budget) + "\n";
                        budget = 0;
                    }
                    return;
                }
                out += entry;
                budget -= entry.size();
            }
        };
        const char* kMine = "[SOBRE MIM: meus arquivos, fatos que posso afirmar]";
        const char* kTheirs = "[SOBRE A EMPRESA/VAGA: contexto da entrevista, não é experiência minha]";
        if (company_first) {
            emit(theirs, kTheirs);
            emit(mine, kMine);
        } else {
            emit(mine, kMine);
            emit(theirs, kTheirs);
        }
        return text::trim(out);
    }

    // One line telling the model what kind of answer the question wants, so
    // the retrieved excerpts serve the question instead of replacing it.
    static const char* intent_guidance(const QueryIntent& in, bool cites_project, bool about_me = false) {
        if (cites_project) return "sobre um projeto/experiência meu citado: use os trechos desse projeto e nada de outros.";
        if (in.intro) return "apresentação pessoal: resuma formação e experiências dos trechos [SOBRE MIM], sem detalhar um projeto só.";
        if (in.company) return "sobre a empresa/motivação: use [SOBRE A EMPRESA/VAGA] e conecte com no máximo um fato meu.";
        if (in.behavioral) return "comportamental: escolha UMA história dos trechos [SOBRE MIM] que realmente combine com a pergunta; se nenhuma combinar, responda como hipótese sem inventar experiência.";
        if (in.technical) return "sobre minha experiência técnica: use o projeto dos trechos que trata exatamente disso; se nenhum tratar, diga que ainda não fiz isso em projeto.";
        if (about_me) return "pessoal/direta sobre mim: responda direto com fatos do perfil e dos trechos; o que não estiver escrito eu não afirmo.";
        return "direta/conceitual: responda à pergunta com conhecimento correto; NÃO traga projetos meus a menos que um trecho trate exatamente do assunto.";
    }

    // Full context for a turn (kept for callers that want one block):
    // session profile (always) + per-question retrieval.
    [[nodiscard]] std::string compose_context_for_query(std::string_view query,
                                                        std::string_view base_user_context = {},
                                                        std::size_t max_chars = 9600) const {
        std::string out = session_profile_block(base_user_context);
        out += "\n\n";
        out += retrieve_block(query);
        return text::truncate_utf8(text::trim(out), max_chars);
    }

    // Keyterms for Deepgram STT boosting: company, role, document/project
    // names and the distinctive proper nouns/tech terms of the documents,
    // ranked by how often they appear (sentence-initial capitals are ignored,
    // they are usually ordinary words like "Desenvolvi").
    [[nodiscard]] std::vector<std::string> extract_keyterms(std::size_t max_terms = 30) const {
        std::vector<std::string> terms;
        std::set<std::string> seen;
        auto add = [&](std::string_view raw) {
            std::string t = text::trim(raw);
            while (!t.empty() && (t.back() == '.' || t.back() == ',' || t.back() == ':' || t.back() == ')')) t.pop_back();
            if (t.size() < 2 || t.size() > 36) return;
            const std::string f = text::fold(t);
            if (is_stop_word(f)) return;
            if (seen.insert(f).second) terms.push_back(std::move(t));
        };
        auto strip_ext = [](std::string n) {
            const auto dot = n.rfind('.');
            if (dot != std::string::npos && dot > 0 && n.size() - dot <= 5) n.resize(dot);
            for (char& c : n) if (c == '_' || c == '-') c = ' ';
            return n;
        };
        if (!profile_.company.empty() && profile_.company.find("://") == std::string::npos) add(profile_.company);
        if (!profile_.role.empty()) add(profile_.role);
        for (const auto& doc : profile_.documents) {
            if (!doc.name.empty()) add(strip_ext(doc.name));
        }

        std::map<std::string, std::pair<int, std::string>> freq; // folded -> (count, original)
        auto consider = [&](const std::string& word, bool sentence_start) {
            if (word.size() < 2 || word.size() > 24) return;
            bool has_digit_or_sym = false, has_upper = false, inner_upper = false, all_upper = true;
            for (std::size_t i = 0; i < word.size(); ++i) {
                const unsigned char c = static_cast<unsigned char>(word[i]);
                if (std::isdigit(c) || c == '+' || c == '#') has_digit_or_sym = true;
                if (std::isupper(c)) { has_upper = true; if (i > 0) inner_upper = true; }
                if (std::islower(c)) all_upper = false;
            }
            const bool acronym = all_upper && has_upper && word.size() >= 2 && word.size() <= 6;
            const bool camel = inner_upper && !all_upper;
            const bool proper = has_upper && std::isupper(static_cast<unsigned char>(word[0])) && !sentence_start;
            const bool tech = has_digit_or_sym && has_upper;
            if (!(acronym || camel || proper || tech)) return;
            const std::string f = text::fold(word);
            if (is_stop_word(f)) return;
            auto& e = freq[f];
            if (e.first == 0) e.second = word;
            ++e.first;
        };
        for (const auto& doc : profile_.documents) {
            std::string word;
            bool sentence_start = true;
            bool next_sentence_start = true;
            for (std::size_t i = 0; i <= doc.content.size(); ++i) {
                const unsigned char c = i < doc.content.size() ? static_cast<unsigned char>(doc.content[i]) : ' ';
                if (std::isalnum(c) || c >= 0x80 || c == '+' || c == '#') {
                    if (word.empty()) sentence_start = next_sentence_start;
                    word.push_back(static_cast<char>(c));
                } else {
                    if (!word.empty()) {
                        consider(word, sentence_start);
                        next_sentence_start = false;
                        word.clear();
                    }
                    if (c == '.' || c == '!' || c == '?' || c == '\n' || c == ':' || c == '|' || c == '-' || c == '*') {
                        next_sentence_start = true;
                    }
                }
            }
        }
        std::vector<std::pair<int, std::string>> ranked;
        ranked.reserve(freq.size());
        for (auto& [f, e] : freq) ranked.emplace_back(e.first, e.second);
        std::stable_sort(ranked.begin(), ranked.end(),
                         [](const auto& a, const auto& b2) { return a.first > b2.first; });
        for (const auto& [count, original] : ranked) {
            if (terms.size() >= max_terms) break;
            add(original);
        }
        if (terms.size() > max_terms) terms.resize(max_terms);
        return terms;
    }

private:
    struct WeightedTerm {
        std::string term;
        double weight;
    };

    // PT<->EN equivalences on stems, so a question in one language still finds
    // the material written in the other (interviews switch language often).
    static const std::vector<std::vector<std::string>>& synonym_groups() {
        static const std::vector<std::vector<std::string>> g = {
            {"desaf", "chall"},          // desafio / challenge
            {"lider", "leade", "lead"},  // liderança / leadership / lead
            {"equip", "team"},           // equipe / team
            {"escal", "scala", "scale"}, // escalabilidade / scalability / scale
            {"banco", "datab"},          // banco de dados / database
            {"falha", "failu", "erro", "error", "mista"}, // falha, erro / failure, error, mistake
            {"prazo", "deadl"},          // prazo / deadline
            {"arqui", "archi"},          // arquitetura / architecture
            {"desem", "perfo"},          // desempenho / performance
            {"apren", "learn"},          // aprendizado / learning
            {"melho", "impro"},          // melhoria / improvement
            {"comun", "commu"},          // comunicação / communication
            {"suces", "succe"},          // sucesso / success
            {"segur", "secur"},          // segurança / security
            {"dado", "data"},            // dados / data
            {"usuar", "user"},           // usuário / user
            {"cresc", "growt"},          // crescimento / growth
            {"decis", "decid"},          // decisão / decide, decision
            {"teste", "testi", "test"},  // testes / testing
            {"confl"},                   // conflito / conflict (same stem)
        };
        return g;
    }

    static std::vector<WeightedTerm> build_query_terms(std::string_view primary, std::string_view context) {
        std::vector<WeightedTerm> out;
        auto find = [&](const std::string& t) -> WeightedTerm* {
            for (auto& w : out) if (w.term == t) return &w;
            return nullptr;
        };
        auto put = [&](const std::string& t, double w) {
            if (auto* e = find(t)) { e->weight = std::max(e->weight, w); return; }
            out.push_back(WeightedTerm{t, w});
        };
        for (const auto& t : tokenize(primary)) put(t, 1.0);
        if (!context.empty()) {
            for (const auto& t : tokenize(context)) put(t, 0.3);
        }
        const std::size_t base_n = out.size();
        for (std::size_t i = 0; i < base_n; ++i) {
            const std::string t = out[i].term;
            const double w = out[i].weight * 0.5;
            for (const auto& grp : synonym_groups()) {
                if (std::find(grp.begin(), grp.end(), t) == grp.end()) continue;
                for (const auto& syn : grp) {
                    if (syn != t && !find(syn)) out.push_back(WeightedTerm{syn, w});
                }
            }
        }
        return out;
    }

    static std::string extract_high_signal_highlights(std::string_view content, std::size_t max_len) {
        std::string out;
        std::size_t start = 0;
        while (start <= content.size() && out.size() < max_len) {
            std::size_t end = content.find('\n', start);
            if (end == std::string_view::npos) end = content.size();
            std::string line = text::trim(content.substr(start, end - start));
            start = end + 1;
            if (line.size() < 4) continue;
            if (!out.empty()) out += " | ";
            out += line;
        }
        return text::truncate_utf8(out, max_len);
    }

    static std::string summarize_chunk_topic(std::string_view chunk_text) {
        std::string first_line = text::trim(chunk_text);
        const auto nl = first_line.find('\n');
        if (nl != std::string::npos && nl > 12) {
            first_line = text::trim(first_line.substr(0, nl));
        }
        return text::truncate_utf8(first_line, 90);
    }

    static bool is_stop_word(std::string_view w) {
        static const std::set<std::string_view> stops = {
            "de", "da", "do", "das", "dos", "em", "no", "na", "nos", "nas",
            "um", "uma", "para", "por", "com", "sem", "que", "qual", "quais",
            "como", "onde", "quando", "voce", "seu", "sua", "seus", "suas",
            "mais", "menos", "muito", "isso", "isto", "esse", "essa", "este",
            "esta", "foi", "era", "ser", "sao", "tem", "ter", "sobre", "the",
            "and", "for", "with", "that", "this", "from", "your", "have", "what",
            "how", "why", "can", "you", "are", "was", "were",
            // conversational / question scaffolding that would match any chunk
            "eu", "me", "mim", "meu", "minha", "meus", "minhas", "pra", "pro", "ao", "aos",
            "os", "as", "se", "ja", "la", "ai", "ne", "ok", "entao", "tambem", "algum", "alguma",
            "fale", "fala", "conte", "conta", "diga", "explique", "explica", "descreva", "vez",
            "exemplo", "situacao", "momento", "pouco", "gostaria", "poderia", "pode",
            "tell", "about", "describe", "give", "example", "situation", "share", "walk",
            "did", "do", "does", "an", "in", "on", "of", "to", "it", "is", "be", "me", "my",
            "we", "our", "us", "they", "them", "there",
            // conversational fillers that end a sentence without changing it
            "favor", "please", "assim", "tipo", "certo", "beleza", "entendeu", "sabe", "tal", "hein", "okay"
        };
        return stops.count(w) > 0;
    }

    static constexpr const char* kCompactPromptVersion = "compact-v2";

    // Does the chunk mention a project term? "tech finance" (as the
    // interviewer says it) also matches "TechFinance" (as the file writes it).
    static bool chunk_mentions(const RagChunk& ch, const std::string& term) {
        if (text::contains_word(ch.folded_text, term) || text::contains_word(ch.folded_source, term)) return true;
        if (term.find(' ') == std::string::npos) return false;
        std::string joined;
        for (char c : term) if (c != ' ') joined.push_back(c);
        return text::contains_word(ch.folded_text, joined) || text::contains_word(ch.folded_source, joined);
    }

    // Keyword match at the START of a word, on folded text: "motiv" matches
    // "motivação", "time" matches "time" but not "sometime"/"tempo", and a
    // phrase ("por que voce quer") must appear as written.
    static bool has_keyword(std::string_view folded, std::string_view kw) {
        if (kw.empty()) return false;
        std::size_t pos = 0;
        while ((pos = folded.find(kw, pos)) != std::string_view::npos) {
            const bool left_ok = pos == 0 || !text::is_word_char(folded[pos - 1]);
            if (left_ok) return true;
            pos += 1;
        }
        return false;
    }

    // Whole-word occurrences of `w` in folded text.
    static int count_word(std::string_view folded, std::string_view w) {
        if (w.empty()) return 0;
        int n = 0;
        std::size_t pos = 0;
        while ((pos = folded.find(w, pos)) != std::string_view::npos) {
            const bool left_ok = pos == 0 || !text::is_word_char(folded[pos - 1]);
            const std::size_t end = pos + w.size();
            const bool right_ok = end >= folded.size() || !text::is_word_char(folded[end]);
            if (left_ok && right_ok) ++n;
            pos = end;
        }
        return n;
    }

    static std::string collapse_ws(std::string_view s) {
        std::string out;
        out.reserve(s.size());
        bool space = false;
        for (char c : s) {
            if (text::is_space(c)) {
                space = !out.empty();
            } else {
                if (space) out.push_back(' ');
                space = false;
                out.push_back(c);
            }
        }
        return out;
    }

    static bool is_generic_company_word(std::string_view w) {
        static const std::set<std::string_view> g = {
            "www", "com", "br", "org", "net", "io", "ai", "app", "co", "pt", "en", "jobs", "job", "careers",
            "carreiras", "career", "estagio", "estagios", "vagas", "vaga", "trabalhe", "conosco", "talentos",
            "internship", "intern", "programa", "program", "processo", "seletivo", "entrevista", "interview",
            "software", "engineer", "engineering", "engenharia", "engenheiro", "desenvolvedor", "developer",
            "dev", "tecnologia", "technology", "brasil", "brazil", "ltda", "inc", "sa", "group", "grupo",
            "the", "de", "da", "do", "and", "http", "https", "html", "pt-br", "gupy", "lever", "greenhouse"};
        return g.count(w) > 0;
    }

    // "https://estagio.nubank.com.br/" -> "Nubank"; "Nubank" -> "Nubank";
    // empty company -> taken from the goal name ("NUBANK - Estágio").
    static std::string derive_company_label(const MiniAgentProfile& p) {
        std::string c = text::trim(p.company);
        auto from_host = [](std::string s) -> std::string {
            const auto scheme = s.find("://");
            if (scheme != std::string::npos) s = s.substr(scheme + 3);
            const auto slash = s.find_first_of("/?#");
            if (slash != std::string::npos) s = s.substr(0, slash);
            std::vector<std::string> labels = text::split_list(s, '.');
            std::string best;
            for (const auto& l : labels) {
                const std::string f = text::fold(l);
                if (f.size() < 2 || is_generic_company_word(f)) continue;
                best = l; // the last non-generic label before the TLD
            }
            if (best.empty()) return {};
            best[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(best[0])));
            return best;
        };
        const bool looks_url = c.find("://") != std::string::npos ||
                               (c.find('.') != std::string::npos && c.find(' ') == std::string::npos &&
                                c.size() > 4);
        if (looks_url) c = from_host(c);
        if (c.empty()) {
            std::string n = text::trim(p.name);
            for (const char* sep : {" — ", " - ", " | ", " · ", ":"}) {
                const auto k = n.find(sep);
                if (k != std::string::npos && k > 0) { n = n.substr(0, k); break; }
            }
            n = text::trim(n);
            if (n.find("://") != std::string::npos) n = from_host(n);
            c = n;
        }
        // "NUBANK" -> "Nubank" (all-caps names read as shouting in the prompt).
        bool all_upper = c.size() > 3;
        for (std::size_t i = 0; i < c.size(); ++i) {
            const unsigned char ch = static_cast<unsigned char>(c[i]);
            if (std::islower(ch)) { all_upper = false; break; }
            // Lowercase Latin-1 letters in UTF-8 (C3 A0..BF) also mean mixed case.
            if (ch == 0xC3 && i + 1 < c.size() && static_cast<unsigned char>(c[i + 1]) >= 0xA0) {
                all_upper = false;
                break;
            }
        }
        if (all_upper) {
            bool in_word = false;
            for (std::size_t i = 0; i < c.size(); ++i) {
                const unsigned char ch = static_cast<unsigned char>(c[i]);
                if (ch == 0xC3 && i + 1 < c.size()) {
                    // UTF-8 uppercase Latin-1 letter (À..Þ, not ×): lower it if not word-initial.
                    unsigned char& nx = reinterpret_cast<unsigned char&>(c[i + 1]);
                    if (in_word && nx >= 0x80 && nx <= 0x9E && nx != 0x97) nx = static_cast<unsigned char>(nx + 0x20);
                    in_word = true;
                    ++i;
                } else if (std::isalpha(ch)) {
                    if (in_word) c[i] = static_cast<char>(std::tolower(ch));
                    in_word = true;
                } else {
                    in_word = false;
                }
            }
        }
        return c;
    }

    static std::vector<std::string> derive_company_terms(const MiniAgentProfile& p, const std::string& label) {
        std::vector<std::string> out;
        auto add = [&](std::string_view raw) {
            const std::string f = text::fold(text::trim(raw));
            if (f.size() < 3 || is_generic_company_word(f) || is_stop_word(f)) return;
            if (std::find(out.begin(), out.end(), f) == out.end()) out.push_back(f);
        };
        if (!label.empty()) {
            add(label);
            for (const auto& w : text::split_list(text::fold(label), ' ')) add(w);
        }
        if (p.company.find("://") == std::string::npos) {
            for (const auto& w : text::split_list(text::fold(p.company), ' ')) add(w);
        }
        return out;
    }

    static bool any_keyword(const std::string& f, std::initializer_list<const char*> kws) {
        for (const char* kw : kws) if (has_keyword(f, kw)) return true;
        return false;
    }

    // "Why us", culture, values, mission, what the company does.
    static bool is_company_query(const std::string& f) {
        return any_keyword(f, {"cultura", "valores", "missao", "visao", "proposito", "empresa", "companhia",
                               "por que voce quer", "porque voce quer", "por que quer", "por que escolheu",
                               "por que nos", "por que a gente", "o que voce sabe", "o que sabe sobre",
                               "conhece a", "conhece o", "nosso produto", "nossos produtos", "nosso time",
                               "fit", "culture", "values", "mission", "company", "why do you want",
                               "why us", "why this", "why here", "what do you know", "our product"});
    }

    // The question asks something about me (you/your), not about a concept.
    static bool asks_about_me(std::string_view q) {
        const std::string f = text::fold(q);
        return any_keyword(f, {"voce", "vc", "seu", "sua", "seus", "suas", "te ", "contigo", "your", "you"});
    }

    // Self-introduction.
    static bool is_intro_query(const std::string& f) {
        return any_keyword(f, {"sobre voce", "sobre vc", "se apresent", "apresente se", "apresente-se",
                               "quem e voce", "quem voce e", "sua trajetoria", "sua historia", "seu background",
                               "sua formacao", "seu perfil", "about yourself", "introduce yourself",
                               "your background", "walk me through your resume", "walk me through your cv"});
    }

    // Classic behavioral prompts: answered with a real story of mine.
    static bool is_behavioral_query(const std::string& f) {
        return any_keyword(f, {"conflit", "desafi", "dificuldade", "dificil", "erro", "errou", "falha", "falhou",
                               "fracass", "lider", "liderou", "equipe", "time", "colega", "gestor", "prazo",
                               "pressao", "orgulh", "aprend", "feedback", "critica", "decis", "priori",
                               "cliente", "uma vez", "uma situacao", "situacao em que", "momento em que",
                               "ponto forte", "ponto fraco", "pontos fortes", "pontos fracos", "qualidade",
                               "defeito", "motiv", "iniciativa", "ownership", "dono", "escolh",
                               "conflict", "challeng", "difficult", "mistake", "fail", "lead", "team",
                               "deadline", "pressure", "proud", "learn", "a time", "situation",
                               "strength", "weakness", "disagree", "initiative", "customer"});
    }

    // Questions about MY technical experience: they need a reference to me
    // plus an experience/project word. "Como funciona um índice?" is a
    // concept question and must not pull a random project of mine.
    static bool is_technical_query(const std::string& f) {
        const bool about_me = any_keyword(f, {"voce", "vc", "seu", "sua", "seus", "suas", "your", "you"});
        if (!about_me) return false;
        return any_keyword(f, {"projeto", "experiencia", "trabalhou", "trabalhado", "implementou", "implementar",
                               "desenvolveu", "construiu", "criou", "usou", "utilizou", "atuou", "participou",
                               "liderou", "arquitetura do", "arquitetura da", "stack", "curriculo", "portfolio",
                               "project", "experience", "worked", "built", "developed", "implemented", "used",
                               "how did you", "have you"});
    }

    // How much a chunk reads like a story: action verbs, results, numbers.
    static int compute_story_score(const std::string& folded) {
        int s = 0;
        for (const char* kw : {"desenvolvi", "implementei", "construi", "criei", "liderei", "propus", "resolvi",
                               "otimizei", "automatiz", "entreg", "venc", "reduz", "aument", "melhor",
                               "resultado", "desafio", "aprendi", "responsavel", "estruturei", "conduzo",
                               "conduzi", "migr", "treinei", "built", "led", "improved", "reduced",
                               "delivered", "result", "won"}) {
            if (has_keyword(folded, kw)) ++s;
        }
        for (char c : folded) if (c == '%') { s += 2; break; }
        int digits = 0;
        for (char c : folded) if (c >= '0' && c <= '9') ++digits;
        if (digits >= 2) ++s;
        return s;
    }

    static bool is_generic_project_word(std::string_view w) {
        static const std::set<std::string_view> g = {
            "pdf", "docx", "doc", "txt", "md", "json", "csv", "html", "readme", "curriculo", "curriculum",
            "resume", "cv", "portfolio", "projeto", "projetos", "project", "projects", "documento", "arquivo",
            "material", "notas", "notes", "final", "versao", "version", "novo", "new", "copy", "copia",
            "app", "web", "site", "sistema", "system", "dados", "data", "experiencia", "experiencias",
            "resultado", "resultados", "jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out",
            "nov", "dez", "janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto",
            "setembro", "outubro", "novembro", "dezembro", "atual", "hoje", "brasil", "portugues", "ingles",
            "frances", "espanhol", "english", "the", "and", "for", "software", "hardware", "full", "stack",
            "full stack", "front", "back", "end", "frontend", "backend", "developer", "desenvolvedor", "engineer",
            "engenheiro", "engenharia", "engineering", "machine", "learning", "machine learning", "ciencia",
            "science", "computacao", "computer", "analista", "analyst", "estagio", "estagiario", "intern",
            "trainee", "junior", "pleno", "senior", "lider", "lead", "team", "equipe", "freelancer", "freelance",
            "universidade", "university", "faculdade", "graduacao", "bacharelado", "certified", "certification",
            "certificacao", "associate", "practitioner", "premios", "certificacoes", "idiomas", "experiencia",
            "formacao", "skills", "habilidades", "open", "mock", "cpu", "gpu", "api", "apis"};
        return g.count(w) > 0;
    }

    // Splits a document into chunks of whole lines/sentences (never mid-word
    // or mid-sentence), packed up to kChunkMax. A heading (short first line)
    // is indexed with every chunk of its document, so a paragraph that does
    // not repeat the project name is still found by it.
    void add_text_chunks(const std::string& source_name, std::string_view content, RagDocKind kind,
                         std::size_t doc_id) {
        const std::string cleaned = text::trim(content);
        if (cleaned.empty()) return;
        constexpr std::size_t kChunkMax = 600;

        // 1) Units: non-empty lines; long lines split into sentences; long
        //    sentences split on spaces.
        std::vector<std::string> units;
        auto push_sentences = [&](const std::string& line) {
            if (line.size() <= kChunkMax) { units.push_back(line); return; }
            std::size_t start = 0;
            while (start < line.size()) {
                std::size_t end = std::min(line.size(), start + kChunkMax);
                if (end < line.size()) {
                    std::size_t cut = std::string::npos;
                    for (const char* sep : {". ", "! ", "? ", "; "}) {
                        const std::size_t c = line.rfind(sep, end - 1); // keeps cut + 1 <= end
                        if (c != std::string::npos && c > start + kChunkMax / 3 &&
                            (cut == std::string::npos || c > cut)) cut = c;
                    }
                    if (cut != std::string::npos) {
                        end = cut + 1;
                    } else {
                        const std::size_t sp = line.rfind(' ', end - 1);
                        if (sp != std::string::npos && sp > start + kChunkMax / 3) {
                            end = sp;
                        } else {
                            // No space at all: hard cut, but on a code point boundary.
                            while (end > start + 1 && (static_cast<unsigned char>(line[end]) & 0xC0) == 0x80) --end;
                        }
                    }
                }
                const std::string piece = text::trim(std::string_view(line).substr(start, end - start));
                if (!piece.empty()) units.push_back(piece);
                start = end;
            }
        };
        for (const auto& raw : text::split_list(cleaned, '\n')) {
            const std::string line = text::trim(raw);
            if (!line.empty()) push_sentences(line);
        }
        if (units.empty()) return;

        std::string heading;
        if (units.front().size() <= 80) heading = units.front();

        // 2) Pack units into chunks.
        std::size_t doc_pos = 0;
        auto flush = [&](std::string&& body) {
            body = text::trim(body);
            if (body.empty()) return;
            RagChunk ch;
            ch.index = chunks_.size();
            ch.source = source_name;
            ch.topic_summary = summarize_chunk_topic(body);
            ch.text = std::move(body);
            ch.kind = kind;
            ch.is_candidate_project = kind == RagDocKind::Candidate;
            ch.is_cultural_or_company = !ch.is_candidate_project;
            ch.folded_text = text::fold(ch.text);
            ch.folded_source = text::fold(ch.source);
            ch.story_score = ch.is_candidate_project ? compute_story_score(ch.folded_text) : 0;
            ch.doc_id = doc_id;
            ch.doc_pos = doc_pos++;
            // The source name (and the document heading) is indexed too: a
            // chunk of "TechFinance.md" is about TechFinance even when the
            // paragraph doesn't repeat it.
            std::string index_text = ch.text + " " + ch.source;
            if (!heading.empty() && ch.doc_pos > 0) index_text += " " + heading;
            const auto toks = tokenize(index_text);
            ch.token_count = toks.size();
            for (const auto& t : toks) ++ch.term_freq[t];
            chunks_.push_back(std::move(ch));
        };
        std::string cur;
        for (const auto& u : units) {
            if (!cur.empty() && cur.size() + 1 + u.size() > kChunkMax) {
                flush(std::move(cur));
                cur.clear();
            }
            if (!cur.empty()) cur.push_back('\n');
            cur += u;
        }
        flush(std::move(cur));
    }

    void rebuild_index() {
        chunks_.clear();
        doc_freq_.clear();
        avg_tokens_ = 1.0;
        candidate_project_terms_.clear();
        has_candidate_chunks_ = false;
        company_chunks_ = 0;
        doc_kinds_.clear();

        for (const auto& doc : profile_.documents) {
            doc_kinds_.push_back(classify_document(doc, company_terms_));
        }
        // My own name (the first line of a résumé) is not a project: an
        // interviewer saying "Oi Bruno" must not look like a project question.
        std::set<std::string> my_name;
        for (std::size_t di = 0; di < profile_.documents.size(); ++di) {
            if (doc_kinds_[di] != RagDocKind::Candidate) continue;
            const auto& d = profile_.documents[di];
            const std::string meta = text::fold(d.tag + " " + d.path + " " + d.name);
            if (!any_keyword(meta, {"resume", "cv", "curriculo", "curriculum"})) continue; // only a résumé opens with my name
            const std::string first = text::trim(d.content.substr(0, d.content.find('\n')));
            const auto words = text::split_list(first, ' ');
            if (words.size() < 2 || words.size() > 5 || first.size() > 60) continue;
            bool looks_like_name = true;
            for (const auto& w : words) {
                const std::string ww = text::trim(w);
                if (ww.empty() || !std::isupper(static_cast<unsigned char>(ww[0])) ||
                    std::any_of(ww.begin(), ww.end(), [](char c) { return c >= '0' && c <= '9'; })) {
                    looks_like_name = false;
                    break;
                }
            }
            if (!looks_like_name) continue;
            my_name.insert(text::fold(first));
            for (const auto& w : words) my_name.insert(text::fold(text::trim(w)));
        }
        std::set<std::string> seen_terms;
        auto add_proj_term = [&](std::string_view raw) {
            std::string f = text::fold(text::trim(raw));
            while (!f.empty() && (f.back() == '.' || f.back() == ',' || f.back() == ':' || f.back() == ')')) f.pop_back();
            while (!f.empty() && (f.front() == '(' || f.front() == '"')) f.erase(f.begin());
            if (f.size() < 3 || f.size() > 40) return;
            if (is_stop_word(f) || is_generic_project_word(f)) return;
            if (my_name.count(f)) return;
            for (const auto& w : text::split_list(f, ' ')) {
                if (my_name.count(text::trim(w)) && f.find(' ') != std::string::npos &&
                    text::split_list(f, ' ').size() <= 2) return; // "curriculo bruno"
            }
            for (const auto& ct : company_terms_) {
                if (f == ct || text::contains_word(f, ct)) return; // the target company is never "my project"
            }
            if (seen_terms.insert(f).second) candidate_project_terms_.push_back(f);
        };
        auto strip_ext = [](std::string n) {
            const auto dot = n.rfind('.');
            if (dot != std::string::npos && dot > 0 && n.size() - dot <= 5) n.resize(dot);
            for (char& c : n) if (c == '_' || c == '-') c = ' ';
            return text::trim(n);
        };


        std::size_t doc_id = 0;
        for (std::size_t di = 0; di < profile_.documents.size(); ++di) {
            const auto& doc = profile_.documents[di];
            const RagDocKind kind = doc_kinds_[di];
            if (kind == RagDocKind::Candidate) {
                // Project names: the file name, its words and its CamelCase
                // split ("TechFinance" -> "tech finance"), the heading, and
                // the proper nouns of the text (Midea, Vertis Solutions...).
                if (!text::trim(doc.name).empty()) {
                    const std::string base = strip_ext(doc.name);
                    add_proj_term(base);
                    for (const auto& w : text::split_list(text::fold(base), ' ')) add_proj_term(w);
                    std::string split_camel;
                    for (std::size_t i = 0; i < base.size(); ++i) {
                        if (i > 0 && std::isupper(static_cast<unsigned char>(base[i])) &&
                            std::islower(static_cast<unsigned char>(base[i - 1]))) {
                            split_camel.push_back(' ');
                        }
                        split_camel.push_back(base[i]);
                    }
                    if (split_camel != base) add_proj_term(split_camel);
                }
                const auto first_nl = doc.content.find('\n');
                const std::string first_line = text::trim(doc.content.substr(0, first_nl));
                if (!first_line.empty() && first_line.size() <= 60) add_proj_term(first_line);
                for (const auto& pn : proper_nouns(doc.content)) add_proj_term(pn);
            }
            add_text_chunks(doc.name.empty() ? std::string("Documento") : doc.name, doc.content, kind, doc_id++);
        }
        for (const auto& ch : chunks_) if (ch.is_candidate_project) { has_candidate_chunks_ = true; break; }
        if (!text::trim(profile_.job_description).empty()) {
            add_text_chunks("Descrição da Vaga " + profile_.role, profile_.job_description, RagDocKind::Job, doc_id++);
        }
        if (!text::trim(profile_.company_dossier).empty()) {
            add_text_chunks("Dossiê " + (company_label_.empty() ? std::string("Empresa") : company_label_),
                            profile_.company_dossier, RagDocKind::Company, doc_id++);
        }
        if (!text::trim(profile_.custom_instructions).empty()) {
            // My own notes: facts about me (graduation date, how I want to
            // sound), so they ground answers like a résumé line would.
            add_text_chunks("Instruções do Agente", profile_.custom_instructions, RagDocKind::Candidate, doc_id++);
            for (auto& ch : chunks_) {
                if (ch.source == "Instruções do Agente") ch.story_score = 0; // never the anchor story
            }
        }

        std::size_t total_tokens = 0;
        for (const auto& ch : chunks_) {
            if (ch.kind == RagDocKind::Company) ++company_chunks_;
            total_tokens += ch.token_count;
            for (const auto& [term, _] : ch.term_freq) {
                ++doc_freq_[term];
            }
        }
        if (!chunks_.empty()) {
            avg_tokens_ = static_cast<double>(total_tokens) / static_cast<double>(chunks_.size());
        }
    }

    // Proper nouns, CamelCase words, acronyms (3-6 letters) and tech tokens
    // with digits, skipping sentence-initial capitals ("Desenvolvi").
    static std::vector<std::string> proper_nouns(std::string_view content) {
        std::vector<std::string> out;
        std::string word;
        bool sentence_start = true, next_sentence_start = true;
        // A capital at the start of a line is a name when the line reads like
        // a résumé entry: "Midea - Engenheiro", "Fiverr (2022)", "Vertis | ML".
        auto entry_header_follows = [&](std::size_t i) {
            while (i < content.size() && content[i] == ' ') ++i;
            if (i >= content.size()) return false;
            const unsigned char c = static_cast<unsigned char>(content[i]);
            if (c == '(' || c == '|') return true;
            if (c == '-') return i + 1 < content.size() && content[i + 1] == ' ';
            // en/em dash: E2 80 93 / E2 80 94
            return c == 0xE2 && i + 2 < content.size() && static_cast<unsigned char>(content[i + 1]) == 0x80 &&
                   (static_cast<unsigned char>(content[i + 2]) == 0x93 || static_cast<unsigned char>(content[i + 2]) == 0x94);
        };
        auto consider = [&](const std::string& w, bool at_start) {
            if (w.size() < 3 || w.size() > 24) return;
            bool has_digit = false, has_upper = false, inner_upper = false, all_upper = true;
            for (std::size_t i = 0; i < w.size(); ++i) {
                const unsigned char c = static_cast<unsigned char>(w[i]);
                if (std::isdigit(c)) has_digit = true;
                if (std::isupper(c)) { has_upper = true; if (i > 0) inner_upper = true; }
                if (std::islower(c)) all_upper = false;
            }
            const bool acronym = all_upper && has_upper && w.size() <= 6;
            const bool camel = inner_upper && !all_upper;
            const bool proper = has_upper && std::isupper(static_cast<unsigned char>(w[0])) && !at_start;
            const bool tech = has_digit && has_upper;
            if (acronym || camel || proper || tech) out.push_back(w);
        };
        for (std::size_t i = 0; i <= content.size(); ++i) {
            const unsigned char c = i < content.size() ? static_cast<unsigned char>(content[i]) : ' ';
            if (std::isalnum(c) || c >= 0x80 || c == '+' || c == '#') {
                if (word.empty()) sentence_start = next_sentence_start;
                word.push_back(static_cast<char>(c));
            } else {
                if (!word.empty()) {
                    consider(word, sentence_start && !entry_header_follows(i));
                    next_sentence_start = false;
                    word.clear();
                }
                if (c == '.' || c == '!' || c == '?' || c == '\n' || c == ':' || c == '|' || c == '-' || c == '*' ||
                    c == '(' || c == ',') {
                    // After "-"/":"/"(" a capital usually starts a label, not a name.
                    next_sentence_start = c != ',';
                }
            }
        }
        return out;
    }

    mutable std::mutex compact_mu_;
    MiniAgentProfile profile_;
    std::string company_label_;
    std::vector<std::string> company_terms_;
    std::vector<RagDocKind> doc_kinds_;
    std::vector<RagChunk> chunks_;
    std::unordered_map<std::string, int> doc_freq_;
    double avg_tokens_{1.0};
    std::vector<std::string> candidate_project_terms_;
    bool has_candidate_chunks_{false};
    std::size_t company_chunks_{0};
};

} // namespace rtai
