// Pure core: is what the interviewer just said a complete question worth an
// automatic answer?
//
// The decision policy fires on anything that LOOKS like a question: a '?' or
// an interrogative/request word at the start of a sentence. On live speech
// that is not enough:
//   * the STT closes a phrase after ~100 ms of silence, so a question often
//     arrives in pieces ("Me conta sobre um projeto em que você" ... "teve um
//     prazo apertado") and the first piece got its own (nonsense) answer;
//   * declaratives start with the same words ("Como eu disse, a gente usa
//     Kafka", "Quando a gente contrata...", "What we do here is...");
//   * noise and fillers ("é... tipo... né", "hum, é é é") came through.
//
// assess_question() looks at the whole utterance (the interviewer's
// fragments joined) and answers:
//   Ready - a complete question/request. `explicit_question` (it ends in '?')
//           means answer now; otherwise answer after a short settle pause,
//           in case the interviewer was only taking a breath.
//   Wait  - it stops mid-phrase ("...sobre o seu projeto de", "...que você",
//           "Qual foi o maior"): wait for the rest.
//   Drop  - a statement, small talk, filler or noise: no automatic answer.
// With `final` (no more speech came), a Wait becomes Ready or Drop.
#pragma once

#include <algorithm>
#include <cstddef>
#include <initializer_list>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "rtai/text_util.hpp"

namespace rtai {

enum class QuestionVerdict { Ready, Wait, Drop };

inline const char* to_string(QuestionVerdict v) noexcept {
    switch (v) {
        case QuestionVerdict::Ready: return "ready";
        case QuestionVerdict::Wait:  return "wait";
        case QuestionVerdict::Drop:  return "drop";
    }
    return "?";
}

struct QuestionAssessment {
    QuestionVerdict verdict{QuestionVerdict::Drop};
    // Ends in '?': the interviewer is done, answer at once.
    bool explicit_question{false};
    std::string reason;
};

namespace qgate {

struct Sentence {
    std::vector<std::string> words; // folded (lowercase, no accents)
    bool asked{false};              // ended with '?'
};

// Splits folded text into sentences of words. '.' inside a token ("5.000",
// "node.js") is not a sentence end; '?' marks the sentence as asked.
inline std::vector<Sentence> split_sentences(std::string_view f) {
    std::vector<Sentence> out;
    Sentence cur;
    std::string w;
    auto flush_word = [&] {
        if (!w.empty()) cur.words.push_back(std::move(w));
        w.clear();
    };
    auto flush_sentence = [&](bool asked) {
        flush_word();
        if (!cur.words.empty()) {
            cur.asked = asked;
            out.push_back(std::move(cur));
        } else if (asked && !out.empty()) {
            out.back().asked = true;
        }
        cur = Sentence{};
    };
    for (std::size_t i = 0; i < f.size(); ++i) {
        const char c = f[i];
        if (text::is_word_char(c) || c == '+' || c == '#') {
            w.push_back(c);
        } else if (c == '?') {
            flush_sentence(true);
        } else if (c == '.' && !w.empty() && i + 1 < f.size() && text::is_word_char(f[i + 1])) {
            w.push_back(c); // 5.000, node.js
        } else if (c == '.' || c == '!' || c == ';' || c == '\n') {
            flush_sentence(false);
        } else {
            flush_word();
        }
    }
    flush_sentence(false);
    return out;
}

inline bool in(const std::set<std::string_view>& s, std::string_view w) { return s.count(w) > 0; }

// Hesitations and conversational glue; they carry no question.
inline const std::set<std::string_view>& fillers() {
    static const std::set<std::string_view> s = {
        "e", "eh", "ah", "ahn", "an", "hum", "hm", "hmm", "humm", "uhm", "uh", "er", "erm", "tipo", "ne",
        "entao", "assim", "bom", "ok", "okay", "beleza", "certo", "legal", "ta", "tah", "pois", "olha",
        "veja", "enfim", "hein", "sim", "claro", "perfeito", "otimo", "show", "bacana", "entendi",
        "agora", "mas", "well", "so", "right", "alright", "yeah", "yes", "and", "but", "great", "cool",
        "nice", "got", "it", "sure", "oi", "ola", "opa"};
    return s;
}

// Words that carry no subject of their own (articles, prepositions,
// pronouns, auxiliaries, the request verbs themselves).
inline const std::set<std::string_view>& no_content() {
    static const std::set<std::string_view> s = {
        // pt
        "o", "a", "os", "as", "um", "uma", "uns", "umas", "de", "do", "da", "dos", "das", "em", "no", "na",
        "nos", "nas", "por", "pelo", "pela", "para", "pra", "pro", "com", "sem", "sobre", "ao", "aos", "num",
        "numa", "e", "ou", "mas", "que", "se", "me", "te", "lhe", "eu", "voce", "vc", "voces", "ele", "ela",
        "isso", "isto", "esse", "essa", "este", "esta", "aquilo", "aquele", "aquela", "seu", "sua", "seus",
        "suas", "meu", "minha", "nosso", "nossa", "qual", "quais", "como", "quando", "onde", "quem", "quanto",
        "quantos", "quantas", "porque", "pq", "ja", "foi", "era", "eram", "ser", "sao", "estar", "esta",
        "estava", "ter", "tem", "tinha", "teve", "fazer", "faz", "fez", "vai", "vou", "ai", "la", "aqui",
        "ali", "tambem", "muito", "muita", "mais", "menos", "bem", "so", "ainda", "pouco", "coisa", "coisas",
        "algo", "alguma", "algum", "gente", "conta", "conte", "contar", "fala", "fale", "falar", "explica",
        "explique", "explicar", "diz", "diga", "dizer", "descreva", "descreve", "pode", "poderia",
        "consegue", "conseguiria", "gostaria", "queria", "quero", "vamos", "favor", "exemplo", "vez",
        "sabe", "dizer", "contar", "disso", "nisso", "daquilo", "dele", "dela",
        // en
        "the", "an", "of", "to", "for", "with", "about", "and", "or", "but", "in", "on", "at", "from",
        "you", "your", "i", "my", "we", "our", "it", "is", "are", "was", "were", "be", "do", "did", "does",
        "have", "has", "had", "what", "how", "why", "when", "where", "who", "which", "can", "could", "would",
        "will", "should", "tell", "give", "explain", "describe", "talk", "share", "walk", "through", "me",
        "us", "this", "that", "some", "something", "please", "time", "example"};
    return s;
}

// Words a phrase cannot end on: the interviewer is still talking.
inline const std::set<std::string_view>& dangling_loose() {
    static const std::set<std::string_view> s = {
        "de", "do", "da", "dos", "das", "no", "na", "nas", "em", "sobre", "com", "sem", "para", "pra", "pro",
        "pros", "pras", "por", "pelo", "pela", "pelos", "pelas", "a", "o", "os", "as", "um", "uma", "uns",
        "umas", "ao", "aos", "num", "numa", "e", "ou", "mas", "que", "se", "seu", "sua", "seus", "suas", "meu",
        "minha", "nosso", "nossa", "esse", "essa", "este", "entre", "ate", "como", "tipo", "cujo", "cuja",
        "qual", "quais",
        // adjectives that still expect their noun ("Qual foi o maior ...")
        "maior", "menor", "melhor", "pior", "principal", "ultimo", "ultima", "primeiro", "primeira",
        "proximo", "proxima", "mesmo", "mesma", "outro", "outra", "cada", "qualquer", "algum", "alguma",
        "todo", "toda", "biggest", "best", "worst", "main", "last", "first", "next", "most",
        "the", "an", "of", "to", "for", "with", "about", "and", "or", "but",
        "in", "on", "at", "from", "your", "my", "our", "their", "is", "are", "was", "were", "like", "than"};
    return s;
}

// Even with a '?' a question cannot end on these ("...experiência com?").
inline const std::set<std::string_view>& dangling_strict() {
    static const std::set<std::string_view> s = {
        "de", "do", "da", "dos", "das", "no", "na", "nas", "em", "sobre", "com", "sem", "para", "pra", "pro",
        "por", "pelo", "pela", "ao", "aos", "num", "numa", "entre", "ate", "the", "an", "of", "to", "for",
        "with", "about", "in", "on", "at", "from"};
    return s;
}

inline bool starts_with(const std::vector<std::string>& w, std::initializer_list<std::string_view> phrase,
                        std::size_t at = 0) {
    if (w.size() < at + phrase.size()) return false;
    std::size_t i = at;
    for (std::string_view p : phrase) {
        if (w[i++] != p) return false;
    }
    return true;
}

// Drops leading fillers/connectors: "E aí, bom, qual foi..." -> "qual foi...".
inline std::vector<std::string> strip_leading(const std::vector<std::string>& w) {
    std::size_t i = 0;
    while (i < w.size() && (in(fillers(), w[i]) || w[i] == "ai")) ++i;
    return std::vector<std::string>(w.begin() + static_cast<std::ptrdiff_t>(i), w.end());
}

// "Como eu disse...", "Quando a gente contrata...", "What we do is...": an
// interrogative opening a statement, not a question. `at` is the first word
// after the interrogative opener.
inline bool declarative_after(const std::vector<std::string>& w, std::size_t at) {
    if (at >= w.size()) return false;
    const std::string& op = w[0];
    // Reasons are asked about anyone: "Por que eu deveria te contratar?",
    // "Por que a gente escolheria você?", "Why should we hire you?".
    if ((at == 2 && (op == "por" || op == "pra" || op == "para")) || op == "why") return false;
    static const std::set<std::string_view> remark = {
        "disse", "falei", "mencionei", "comentei", "expliquei", "coloquei", "conversamos", "falamos",
        "dissemos", "combinamos", "vimos", "sabemos", "said", "mentioned", "told"};
    const std::string& n = w[at];
    std::size_t k = at; // first word after the subject
    bool we = false, i = false;
    if (n == "eu" || n == "i") {
        i = true;
        k = at + 1;
    } else if (n == "nos" || n == "we") {
        we = true;
        k = at + 1;
    } else if (starts_with(w, {"a", "gente"}, at)) {
        we = true;
        k = at + 2;
    }
    auto remark_at = [&](std::size_t j) {
        return j < w.size() && (in(remark, w[j]) || (w[j] == "ja" && j + 1 < w.size() && in(remark, w[j + 1])));
    };
    // "Como eu disse", "Como a gente conversou", "Como já falei", "As I said".
    if (remark_at(at) || remark_at(k)) return true;
    // "Como você sabe", "Como vocês viram", "Como você deve saber", "You know".
    if (starts_with(w, {"voce", "sabe"}, at) || starts_with(w, {"voce", "viu"}, at) ||
        starts_with(w, {"voces", "sabem"}, at) || starts_with(w, {"voces", "viram"}, at) ||
        starts_with(w, {"voce", "deve", "saber"}, at) || starts_with(w, {"o", "senhor"}, at) ||
        starts_with(w, {"you", "know"}, at)) {
        return true;
    }
    // The company talking about itself: "O que a gente faz aqui é...",
    // "Quando a gente contrata...", "What we do here...", "Porque aqui...".
    if (we || n == "nosso" || n == "nossa" || n == "nossos" || n == "nossas" || n == "our" || n == "aqui") return true;
    // "Quando eu entrei aqui...", "Onde eu trabalhava...", "Porque eu acho...".
    if (i && (op == "quando" || op == "onde" || op == "porque" || op == "pq" || op == "when" || op == "where")) {
        return true;
    }
    // "O que eu quero dizer é...", "What I mean is...".
    if (i && k + 1 < w.size() && (w[k] == "quero" || w[k] == "queria" || w[k] == "quis") && w[k + 1] == "dizer") {
        return true;
    }
    if (i && k < w.size() && w[k] == "mean") return true;
    return false;
}

// How many leading words form an interrogative opener (0 = none).
inline std::size_t interrogative_len(const std::vector<std::string>& w) {
    if (w.empty()) return 0;
    static constexpr std::pair<std::string_view, std::string_view> kTwo[] = {
        {"por", "que"}, {"pra", "que"}, {"para", "que"}, {"o", "que"}, {"que", "tipo"},
        {"de", "que"}, {"em", "que"}, {"de", "onde"}, {"com", "quem"}, {"how", "come"}};
    if (w.size() >= 2) {
        for (const auto& two : kTwo) {
            if (w[0] == two.first && w[1] == two.second) return 2;
        }
    }
    static const std::set<std::string_view> one = {
        "como", "qual", "quais", "quando", "onde", "quem", "quanto", "quantos", "quantas", "porque", "pq",
        "what", "how", "why", "when", "where", "who", "which", "whose"};
    return in(one, w[0]) ? 1 : 0;
}

// Request openers: imperatives, "você poderia...", yes/no "você já...".
inline bool request_opener(const std::vector<std::string>& w) {
    if (w.empty()) return false;
    static const std::set<std::string_view> verbs = {
        "conta", "conte", "fala", "fale", "explica", "explique", "descreva", "descreve", "cite", "comente",
        "imagine", "suponha", "apresente", "diga", "diz", "detalhe", "detalha", "compartilhe", "pode",
        "poderia", "consegue", "conseguiria", "existe", "tell", "describe", "explain", "walk", "give",
        "imagine", "suppose", "talk", "share", "can", "could", "would", "will", "do", "did", "does", "have",
        "has", "are", "is", "were", "was", "should", "may"};
    if (in(verbs, w[0])) return true;
    static const std::set<std::string_view> after_me = {
        "conta", "conte", "contar", "fala", "fale", "falar", "explica", "explique", "explicar", "diz", "diga",
        "dizer", "de", "da", "descreve", "descreva", "mostra", "mostre", "detalha", "detalhe"};
    if (w[0] == "me" && w.size() >= 2 && in(after_me, w[1])) return true;
    // "Sabe me dizer...", "Você sabe me explicar..."
    const std::size_t s0 = (w[0] == "voce" || w[0] == "vc") ? 1 : 0;
    if (w.size() >= s0 + 2 && w[s0] == "sabe" && (w[s0 + 1] == "me" || w[s0 + 1] == "dizer" ||
                                                  w[s0 + 1] == "informar" || w[s0 + 1] == "explicar")) {
        return true;
    }
    if (starts_with(w, {"se", "apresente"}) || starts_with(w, {"tem", "como"}) ||
        starts_with(w, {"teria", "como"}) || starts_with(w, {"gostaria", "que"}) ||
        starts_with(w, {"queria", "que"}) || starts_with(w, {"de", "um", "exemplo"}) ||
        starts_with(w, {"da", "um", "exemplo"})) {
        return true;
    }
    if ((w[0] == "voce" || w[0] == "vc" || w[0] == "voces") && w.size() >= 2) {
        static const std::set<std::string_view> yesno = {
            "ja", "tem", "teve", "conhece", "sabe", "acha", "gosta", "usou", "usa", "utilizou", "trabalhou",
            "trabalha", "fez", "faria", "faz", "prefere", "estaria", "lidou", "lidaria", "enfrentou",
            "liderou", "participou", "aprendeu", "considera", "consegue", "conseguiria", "pode", "poderia",
            "teria", "iria", "se", "costuma", "programa", "desenvolveu", "construiu", "implementou", "domina"};
        return in(yesno, w[1]);
    }
    return false;
}

inline bool is_implicit_question(const std::vector<std::string>& w) {
    const std::size_t n = interrogative_len(w);
    if (n > 0) return !declarative_after(w, n);
    return request_opener(w);
}

inline std::size_t content_words(const std::vector<std::string>& w) {
    std::size_t n = 0;
    for (const auto& x : w) {
        const bool digit = std::any_of(x.begin(), x.end(), [](char c) { return c >= '0' && c <= '9'; });
        if (digit || (x.size() >= 3 && !in(no_content(), x) && !in(fillers(), x))) ++n;
    }
    return n;
}

// "Fale sobre você", "Tell me about yourself": complete without a subject word.
inline bool asks_about_the_candidate(const std::vector<std::string>& w) {
    for (std::size_t i = 0; i + 1 < w.size(); ++i) {
        if (w[i] == "sobre" && (w[i + 1] == "voce" || w[i + 1] == "vc" || w[i + 1] == "ti")) return true;
        if (w[i] == "about" && w[i + 1] == "yourself") return true;
        if (w[i] == "se" && w[i + 1] == "apresente") return true;
        if (w[i] == "introduce" && w[i + 1] == "yourself") return true;
    }
    return false;
}

// Follow-ups that are complete on their own words ("E por quê", "Como
// assim?", "E você?", "E o resultado?"). `q` has leading fillers stripped,
// so "e"/"and" is already gone.
inline bool complete_follow_up(const std::vector<std::string>& q) {
    static const std::vector<std::vector<std::string_view>> whole = {
        {"por", "que"}, {"pra", "que"}, {"porque"}, {"pq"}, {"como", "assim"}, {"depois"}, {"voce"}, {"vc"},
        {"o", "resultado"}, {"qual", "o", "resultado"}, {"why"}, {"how", "come"}, {"how", "so"}, {"you"},
        {"then", "what"}, {"what", "then"}, {"the", "result"}, {"what", "happened"}, {"o", "que", "aconteceu"}};
    for (const auto& phrase : whole) {
        if (q.size() == phrase.size() && std::equal(q.begin(), q.end(), phrase.begin())) return true;
    }
    return false;
}

// Short follow-ups that are complete with the conversation before them.
inline bool follow_up_opener(const std::vector<std::string>& q) {
    return complete_follow_up(q) || starts_with(q, {"por", "que"}) || starts_with(q, {"pra", "que"}) ||
           (!q.empty() && (q[0] == "porque" || q[0] == "pq" || q[0] == "why")) ||
           starts_with(q, {"como", "assim"}) || starts_with(q, {"how", "come"}) || starts_with(q, {"how", "so"});
}

// Greetings and call checks ("Tudo bem?", "Está me ouvindo?", "Can you hear me?").
inline bool small_talk_only(const std::vector<std::string>& w) {
    static const std::set<std::string_view> s = {
        "tudo", "bem", "bom", "boa", "certo", "testando", "teste", "testar", "ouvindo", "ouve", "ouvir", "escuta",
        "escutando", "audio", "som", "microfone", "video", "camera", "consegue", "conseguem", "me", "esta",
        "estao", "voce", "voces", "vc", "como", "vai", "vao", "td", "joia", "tranquilo", "dia", "tarde",
        "noite", "tal", "ai", "hear", "see", "can", "you", "me", "how", "are", "doing", "is", "everything",
        "good", "fine", "there", "morning", "afternoon", "evening", "okay", "ok", "going", "it", "s",
        "com", "e", "o", "a", "por", "contigo", "ti", "todos", "pessoal", "galera", "oi", "ola", "opa", "hello",
        "hi", "hey", "everyone", "today", "hoje", "voz", "tela", "screen", "my", "minha", "meu", "aparecendo",
        "funcionando", "aparece", "chegando", "travando", "travou", "caiu", "cortando", "picotando", "alto",
        "direito", "legal", "beleza", "obrigado", "obrigada", "thanks", "thank", "prazer", "nice", "meet",
        "to", "too", "well", "do", "does", "fala", "falando", "ver", "vendo", "enxergando", "conectado",
        "conexao", "internet", "net", "sinal", "work", "working", "audible", "loud", "clear"};
    // At least one word that only small talk uses: "Me fala," is a request
    // that has not started yet, "Fala, tudo bem?" is a greeting.
    static const std::set<std::string_view> core = {
        "tudo", "bem", "bom", "boa", "testando", "teste", "testar", "ouvindo", "ouve", "ouvir", "escuta",
        "escutando", "audio", "som", "microfone", "video", "camera", "joia", "tranquilo", "dia", "tarde",
        "noite", "hear", "doing", "fine", "morning", "afternoon", "evening", "going", "oi", "ola", "opa",
        "hello", "hi", "hey", "tela", "screen", "voz", "aparecendo", "funcionando", "aparece", "chegando",
        "travando", "travou", "caiu", "cortando", "picotando", "conectado", "conexao", "internet", "net",
        "sinal", "obrigado", "obrigada", "thanks", "thank", "prazer", "meet", "audible", "loud", "clear",
        "enxergando", "vendo", "ver", "see", "td", "everything", "good", "working"};
    return !w.empty() && std::all_of(w.begin(), w.end(), [&](const std::string& x) { return in(s, x); }) &&
           std::any_of(w.begin(), w.end(), [&](const std::string& x) { return in(core, x); });
}

// An opened clause with no verb yet: "...que você", "...em que a gente".
inline bool open_clause_at_end(const std::vector<std::string>& all) {
    if (all.size() < 2) return false;
    const std::string& last = all.back();
    const std::string& prev = all[all.size() - 2];
    static const std::set<std::string_view> openers = {"que", "onde", "quando", "se", "cujo", "como", "where",
                                                        "when", "if", "that", "which"};
    static const std::set<std::string_view> subjects = {"voce", "vc", "voces", "eu", "ele", "ela", "gente",
                                                        "nos", "you", "we", "i", "they"};
    if (in(subjects, last) && in(openers, prev)) return true;
    if (last == "gente" && all.size() >= 3 && all[all.size() - 2] == "a" && in(openers, all[all.size() - 3]))
        return true;
    return false;
}

} // namespace qgate

// See the file comment. `has_context`: there was conversation before (short
// follow-ups like "E por quê?" are complete then). `final`: no more speech
// came after this utterance, so it will not grow any more.
inline QuestionAssessment assess_question(std::string_view utterance, bool has_context = false,
                                          bool final = false) {
    using namespace qgate;
    QuestionAssessment out;
    const std::string raw = text::trim(utterance);
    const std::string f = text::fold(raw);
    const auto sentences = split_sentences(f);
    if (sentences.empty()) {
        out.reason = "empty";
        return out;
    }

    std::vector<std::string> all;
    for (const auto& s : sentences) all.insert(all.end(), s.words.begin(), s.words.end());

    // Noise: the same word over and over, or nothing but fillers.
    if (all.size() >= 4) {
        std::set<std::string> uniq(all.begin(), all.end());
        if (uniq.size() * 2 < all.size()) {
            out.reason = "repetitive noise";
            return out;
        }
    }
    if (std::all_of(all.begin(), all.end(), [](const std::string& w) { return in(fillers(), w); })) {
        out.reason = "only fillers";
        return out;
    }

    // The sentence that carries the question: the last one asked ('?') or
    // opened by an interrogative/request (and not a declarative opener).
    int qi = -1;
    bool explicit_q = false;
    for (std::size_t i = 0; i < sentences.size(); ++i) {
        const auto words = strip_leading(sentences[i].words);
        if (words.empty()) continue;
        if (sentences[i].asked) {
            qi = static_cast<int>(i);
            explicit_q = true;
        } else if (is_implicit_question(words)) {
            qi = static_cast<int>(i);
            explicit_q = false;
        }
    }
    if (qi < 0) {
        out.reason = "statement, not a question";
        return out;
    }
    const auto q = strip_leading(sentences[static_cast<std::size_t>(qi)].words);
    if (small_talk_only(q)) {
        out.reason = "small talk";
        return out;
    }
    const std::size_t content = content_words(q);
    const bool about_candidate = asks_about_the_candidate(q);
    const bool q_is_last = static_cast<std::size_t>(qi) + 1 == sentences.size();
    // A '?' question needs a subject, unless it is about the candidate or a
    // follow-up to what was just said ("E por quê?").
    const bool has_subject = content > 0 || about_candidate || (has_context && follow_up_opener(q)) ||
                             q.size() >= 3;

    // Still talking? The utterance ends mid-phrase.
    const bool last_asked = sentences.back().asked;
    const std::string& last_word = all.back();
    char last_char = raw.empty() ? '\0' : raw.back();
    const bool trailing_mark = last_char == ',' || last_char == ':' || last_char == '-' ||
                               (raw.size() >= 3 && (raw.compare(raw.size() - 3, 3, "...") == 0 ||
                                                    raw.compare(raw.size() - 3, 3, "\xE2\x80\xA6") == 0));
    bool dangling = last_asked ? in(dangling_strict(), last_word)
                               : (in(dangling_loose(), last_word) || trailing_mark || open_clause_at_end(all));
    // "E por quê", "Como assim": complete although they end on "que"/"assim".
    if (dangling && q_is_last && !trailing_mark && complete_follow_up(q)) dangling = false;
    if (dangling) {
        if (!final) {
            out.verdict = QuestionVerdict::Wait;
            out.reason = "ends mid-phrase";
        } else if (explicit_q && !q_is_last && has_subject) {
            // The '?' question was complete; only the remark after it was cut.
            out.verdict = QuestionVerdict::Ready;
            out.explicit_question = true;
            out.reason = "complete question; the remark after it was cut";
        } else if (content >= 3) {
            out.verdict = QuestionVerdict::Ready;
            out.reason = "ends mid-phrase but nothing else came; enough content";
        } else {
            out.reason = "ends mid-phrase";
        }
        return out;
    }

    if (explicit_q) {
        if (!has_subject) {
            out.reason = "question with no subject";
            return out;
        }
        out.verdict = QuestionVerdict::Ready;
        out.explicit_question = true;
        out.reason = "complete question";
        return out;
    }

    // Implicit question (no '?'): it needs a subject to be answerable.
    // "Me fala do seu projeto" (one subject word, a full phrase) is enough;
    // "Qual o" or "Me conta" is not yet.
    if (content >= 2 || about_candidate || (content == 1 && q.size() >= 4)) {
        out.verdict = QuestionVerdict::Ready;
        out.reason = "complete request";
        return out;
    }
    if (final) {
        // Nothing else came. With conversation before it, a short request
        // ("Me fala disso", "E por quê") refers to what was just said.
        const bool answerable = has_context && (content >= 1 || follow_up_opener(q) || q.size() >= 3);
        out.verdict = answerable ? QuestionVerdict::Ready : QuestionVerdict::Drop;
        out.reason = answerable ? "short follow-up" : "question opener without a subject";
        return out;
    }
    out.verdict = QuestionVerdict::Wait;
    out.reason = "question opener without a subject yet";
    return out;
}

// Words that carry a subject ("projeto", "Kafka", "5G") in raw text.
inline std::size_t content_word_count(std::string_view raw) {
    std::size_t n = 0;
    for (const auto& s : qgate::split_sentences(text::fold(raw))) n += qgate::content_words(s.words);
    return n;
}

// Joins the interviewer's consecutive fragments into one utterance and drops
// the words the STT repeats at a seam ("me conta sobre" + "sobre o projeto").
inline std::string join_fragments(const std::vector<std::string>& parts) {
    std::string out;
    std::vector<std::string> out_words; // folded words of `out`
    for (const auto& part_raw : parts) {
        const std::string part = text::trim(part_raw);
        if (part.empty()) continue;
        // Split the part into original-case words and their folded forms.
        std::vector<std::string> words;
        {
            std::string w;
            for (char c : part) {
                if (text::is_space(c)) {
                    if (!w.empty()) words.push_back(std::move(w));
                    w.clear();
                } else {
                    w.push_back(c);
                }
            }
            if (!w.empty()) words.push_back(std::move(w));
        }
        auto key = [](const std::string& w) {
            std::string k;
            for (char c : text::fold(w)) if (text::is_word_char(c)) k.push_back(c);
            return k;
        };
        const char prev_end = out.empty() ? '\0' : out.back();
        const bool prev_finished = prev_end == '?' || prev_end == '!';
        std::size_t skip = 0;
        for (std::size_t k = prev_finished ? 0 : std::min<std::size_t>({3, out_words.size(), words.size()});
             k >= 1; --k) {
            bool same = true;
            for (std::size_t i = 0; i < k && same; ++i) {
                same = out_words[out_words.size() - k + i] == key(words[i]);
            }
            if (same) {
                skip = k;
                break;
            }
        }
        // "Qual foi o maior." + "Desafio?": the STT closed the phrase early.
        const bool cut_period = prev_end == '.' && !(out.size() >= 2 && out[out.size() - 2] == '.') &&
                                (skip > 0 || (!out_words.empty() && qgate::in(qgate::dangling_loose(), out_words.back())));
        if (cut_period && skip < words.size()) out.pop_back();
        for (std::size_t i = skip; i < words.size(); ++i) {
            if (!out.empty()) out.push_back(' ');
            out += words[i];
            out_words.push_back(key(words[i]));
        }
    }
    return out;
}

} // namespace rtai
