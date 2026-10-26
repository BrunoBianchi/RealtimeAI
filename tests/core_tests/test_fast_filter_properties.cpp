// Property-based tests for the Hot_Path fast filter of the Decision_Policy
// (src/core/include/rtai/decision_policy.hpp). The project ships GoogleTest
// only (no dedicated PBT runtime), so the property is checked by sampling the
// input space with a seeded std::mt19937 over many trials plus the exact
// boundary cases the requirement calls out (5 words and 6 words, with and
// without question structure). A fixed seed keeps failures reproducible; a
// reported counterexample can be replayed by hand.
#include <gtest/gtest.h>

#include <random>
#include <string>
#include <string_view>
#include <vector>

#include "rtai/decision_policy.hpp"
#include "rtai/text_util.hpp"

using namespace rtai;

// Property 3: o filtro rápido aprova sse (>5 palavras E estrutura de pergunta).
// For any interim text, DecisionPolicy::fast_filter(interim) is true if and
// only if text::word_count(interim) > 5 AND DecisionPolicy::looks_like_question
// (interim). The two building blocks are already-public pure functions, so the
// reference side of the biconditional is computed independently of fast_filter's
// own implementation rather than merely restating it.
//
// Strategy: generate interims by assembling a random number of tokens drawn
// from three pools — plain filler words, interrogative lead words that make a
// sentence look like a question, and a trailing "?" marker — so both the
// word-count axis and the question-structure axis are varied independently and
// land on either side of the >5-words boundary. A seeded std::mt19937 keeps any
// counterexample reproducible.
//
// **Validates: Requirements 1.4**
namespace {

// A spread of plain content words (folded, no accents) that are neither
// interrogatives nor small talk, so they move the word count without turning
// the text into a question on their own.
const std::vector<std::string>& filler_words() {
    static const std::vector<std::string> w = {
        "cliente", "projeto", "equipe", "sistema", "contrato", "mercado",
        "produto", "processo", "reuniao", "proposta", "entrega", "modelo",
        "codigo", "dados", "servidor", "cliente", "relatorio", "analise"};
    return w;
}

// Interrogative lead words taken from the policy's own interrogative set; a
// sentence that starts with one of these looks like a question even without a
// trailing "?".
const std::vector<std::string>& interrogative_leads() {
    static const std::vector<std::string> w = {
        "como", "qual", "quando", "onde", "quanto", "quem", "porque",
        "what", "how", "why", "when", "where", "who", "which"};
    return w;
}

} // namespace

TEST(FastFilterProperties, ApprovesIffMoreThanFiveWordsAndQuestion) {
    std::mt19937 rng(0xFA57F117u);
    std::uniform_int_distribution<int> word_count_dist(0, 12); // straddles the >5 boundary
    std::bernoulli_distribution make_question(0.5);
    std::bernoulli_distribution trailing_q(0.5);
    std::uniform_int_distribution<std::size_t> filler_idx(0, filler_words().size() - 1);
    std::uniform_int_distribution<std::size_t> lead_idx(0, interrogative_leads().size() - 1);

    constexpr int kTrials = 30000;
    for (int t = 0; t < kTrials; ++t) {
        const int n = word_count_dist(rng);
        const bool want_question_lead = make_question(rng);

        std::vector<std::string> tokens;
        tokens.reserve(static_cast<std::size_t>(n) + 1);
        for (int i = 0; i < n; ++i) {
            if (i == 0 && want_question_lead) {
                tokens.push_back(interrogative_leads()[lead_idx(rng)]);
            } else {
                tokens.push_back(filler_words()[filler_idx(rng)]);
            }
        }

        std::string interim;
        for (std::size_t i = 0; i < tokens.size(); ++i) {
            if (i != 0) interim.push_back(' ');
            interim += tokens[i];
        }
        // Independently append a question mark some of the time; combined with
        // the interrogative lead this exercises all four structure/no-structure
        // combinations against the word-count axis.
        if (trailing_q(rng) && !interim.empty()) interim.push_back('?');

        // Independent reference: recompute the two conjuncts directly from the
        // public building blocks, never from fast_filter itself.
        const bool enough_words = text::word_count(interim) > 5;
        const bool is_question = DecisionPolicy::looks_like_question(interim);
        const bool expected = enough_words && is_question;

        DecisionPolicy policy;
        EXPECT_EQ(policy.fast_filter(interim), expected)
            << "trial " << t << " interim=[" << interim << "]"
            << " words=" << text::word_count(interim)
            << " enough_words=" << enough_words
            << " is_question=" << is_question;
    }
}

// Boundary cases the requirement names explicitly: exactly 5 words and exactly
// 6 words, each with and without question structure. The filter must reject at
// 5 words even when the text is a question (5 is NOT > 5), and approve at 6
// words only when the text is also a question.
TEST(FastFilterProperties, BoundaryAtFiveAndSixWords) {
    DecisionPolicy policy;

    // Exactly 5 words, with question structure (interrogative lead + "?"):
    // fails the word-count conjunct (5 is not > 5), so rejected.
    {
        const std::string s = "como voce faz o deploy?";
        ASSERT_EQ(text::word_count(s), 5u);
        ASSERT_TRUE(DecisionPolicy::looks_like_question(s));
        EXPECT_FALSE(policy.fast_filter(s)) << s;
    }
    // Exactly 5 words, no question structure: rejected on both conjuncts.
    {
        const std::string s = "cliente fechou contrato do projeto";
        ASSERT_EQ(text::word_count(s), 5u);
        ASSERT_FALSE(DecisionPolicy::looks_like_question(s));
        EXPECT_FALSE(policy.fast_filter(s)) << s;
    }
    // Exactly 6 words, with question structure: both conjuncts hold -> approved.
    {
        const std::string s = "como voce faz o deploy disso?";
        ASSERT_EQ(text::word_count(s), 6u);
        ASSERT_TRUE(DecisionPolicy::looks_like_question(s));
        EXPECT_TRUE(policy.fast_filter(s)) << s;
    }
    // Exactly 6 words, no question structure: word count passes but the
    // question conjunct fails -> rejected.
    {
        const std::string s = "cliente fechou contrato do projeto novo";
        ASSERT_EQ(text::word_count(s), 6u);
        ASSERT_FALSE(DecisionPolicy::looks_like_question(s));
        EXPECT_FALSE(policy.fast_filter(s)) << s;
    }

    // A 6-word interrogative WITHOUT a trailing "?": the interrogative lead
    // alone is enough structure, so it is still approved at 6 words.
    {
        const std::string s = "qual o prazo para a entrega";
        ASSERT_EQ(text::word_count(s), 6u);
        ASSERT_TRUE(DecisionPolicy::looks_like_question(s));
        EXPECT_TRUE(policy.fast_filter(s)) << s;
    }
    // A long (>5 words) statement ending with a period: plenty of words but no
    // question structure -> rejected.
    {
        const std::string s = "o cliente fechou o contrato ontem.";
        ASSERT_GT(text::word_count(s), 5u);
        ASSERT_FALSE(DecisionPolicy::looks_like_question(s));
        EXPECT_FALSE(policy.fast_filter(s)) << s;
    }
    // Empty and whitespace-only interims: zero words, never approved.
    {
        EXPECT_FALSE(policy.fast_filter("")) << "empty";
        EXPECT_FALSE(policy.fast_filter("   \t\n")) << "whitespace-only";
    }
}
