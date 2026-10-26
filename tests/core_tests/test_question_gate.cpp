// "Ele envia coisas que não fazem sentido ou não a sentença inteira": what
// reaches the automatic answer must be a complete question. These cases are
// the shapes live speech takes (fragments, declaratives that start like
// questions, fillers, noise, small talk).
#include <gtest/gtest.h>

#include <random>
#include <string>
#include <vector>

#include "rtai/question_gate.hpp"

using namespace rtai;

namespace {

QuestionAssessment A(const std::string& s, bool ctx = false, bool final = false) {
    return assess_question(s, ctx, final);
}

} // namespace

// --------------------------------------------------------------- complete

TEST(QuestionGate, ExplicitQuestionsAreReadyAtOnce) {
    for (const char* q : {"Qual foi o maior desafio do TechFinance?", "Você já trabalhou com Kafka?",
                          "What was your biggest challenge?", "Por que você quer trabalhar no Nubank?",
                          "Como você lidaria com um conflito no time?"}) {
        const auto a = A(q);
        EXPECT_EQ(a.verdict, QuestionVerdict::Ready) << q << " / " << a.reason;
        EXPECT_TRUE(a.explicit_question) << q;
    }
}

TEST(QuestionGate, RequestsWithoutQuestionMarkAreReadyAfterASettlePause) {
    for (const char* q : {"Me conta sobre um projeto em que você teve um prazo apertado",
                          "Fale um pouco sobre você.", "Tell me about a time you failed.",
                          "Me fala do seu projeto", "Você já trabalhou com Kafka",
                          "Legal. E qual tecnologia você usou nesse projeto",
                          "Sabe me dizer quanto tempo levou a migração",
                          "Walk me through your resume", "Conte uma situação em que você errou."}) {
        const auto a = A(q);
        EXPECT_EQ(a.verdict, QuestionVerdict::Ready) << q << " / " << a.reason;
        EXPECT_FALSE(a.explicit_question) << q << ": no '?', so the engine waits a short settle pause";
    }
}

TEST(QuestionGate, QuestionThenExtraContextIsStillAQuestion) {
    const auto a = A("Qual sua experiência com Kafka? Porque aqui a gente usa muito.");
    EXPECT_EQ(a.verdict, QuestionVerdict::Ready) << a.reason;
    EXPECT_TRUE(a.explicit_question);
}

TEST(QuestionGate, ShortFollowUpsNeedTheConversationBeforeThem) {
    EXPECT_EQ(A("E por quê?", true).verdict, QuestionVerdict::Ready);
    EXPECT_EQ(A("E por quê?", false).verdict, QuestionVerdict::Drop);
    EXPECT_EQ(A("Como assim?", true).verdict, QuestionVerdict::Ready);
    // Without '?' a follow-up waits for the pause, then goes.
    EXPECT_EQ(A("E por quê", true).verdict, QuestionVerdict::Wait);
    EXPECT_EQ(A("E por quê", true, true).verdict, QuestionVerdict::Ready);
    EXPECT_EQ(A("Me fala disso", true, true).verdict, QuestionVerdict::Ready);
    EXPECT_EQ(A("Me fala disso", false, true).verdict, QuestionVerdict::Drop);
}

// --------------------------------------------------------------- fragments

TEST(QuestionGate, FragmentsWaitForTheRest) {
    for (const char* q : {"Me conta sobre um projeto em que você", "Qual foi o maior", "Qual é a sua experiência com",
                          "Qual é a sua experiência com?", "Me conta do seu projeto, tipo", "Me fala,", "Me conta",
                          "E qual foi o resultado que a gente", "Tell me about the", "Qual é o nome do seu",
                          "Como você resolveu o problema de..."}) {
        const auto a = A(q);
        EXPECT_EQ(a.verdict, QuestionVerdict::Wait) << q << " / " << a.reason;
    }
}

TEST(QuestionGate, AFragmentThatNeverGrowsIsDroppedUnlessItHasSubstance) {
    EXPECT_EQ(A("Qual foi o maior", false, true).verdict, QuestionVerdict::Drop);
    EXPECT_EQ(A("Me conta sobre um projeto em que você", false, true).verdict, QuestionVerdict::Drop);
    EXPECT_EQ(A("Me conta", false, true).verdict, QuestionVerdict::Drop);
    // Lots of subject already: the trailing word is likely an STT slip.
    EXPECT_EQ(A("Como você escalou o pipeline de dados do Kubernetes com", false, true).verdict,
              QuestionVerdict::Ready);
}

// --------------------------------------------------------------- not questions

TEST(QuestionGate, DeclarativesThatStartLikeQuestionsAreDropped) {
    for (const char* q : {"Como eu disse, aqui a gente usa Kafka e Clojure.",
                          "Quando a gente contrata estagiários, eles passam por um onboarding.",
                          "O que a gente espera de você é proatividade.", "What we do here is build payment systems.",
                          "Como você sabe, o Nubank é uma empresa grande.",
                          "Você vai ver que aqui o ritmo é bem rápido.",
                          "Bom, a nossa empresa trabalha com pagamentos e tem muitos clientes no Brasil e no México."}) {
        const auto a = A(q);
        EXPECT_EQ(a.verdict, QuestionVerdict::Drop) << q << " / " << a.reason;
    }
}

TEST(QuestionGate, FirstPersonInsideARealQuestionIsNotAStatement) {
    for (const char* q : {"Por que eu deveria te contratar", "Por que eu pagaria trinta por cento a mais",
                          "Por que a gente escolheria você e não outro candidato", "Why should we hire you"}) {
        EXPECT_EQ(A(q).verdict, QuestionVerdict::Ready) << q << " / " << A(q).reason;
    }
    for (const char* q : {"Porque aqui a gente usa muito Kafka.", "Quando eu entrei aqui, o time era pequeno.",
                          "O que eu quero dizer é que o prazo é curto.", "Como já falei, a vaga é remota.",
                          "Como vocês viram, o produto é grande."}) {
        EXPECT_EQ(A(q).verdict, QuestionVerdict::Drop) << q << " / " << A(q).reason;
    }
}

TEST(QuestionGate, FillersNoiseAndSmallTalkAreDropped) {
    for (const char* q : {"Hum, é, então, tipo", "é é é é é", "Legal, bacana, entendi.", "Tudo bem? Está me ouvindo?",
                          "Can you hear me?", "O quê?", "Opa, testando, tudo bem?", "ok ok ok ok", "Ahn.",
                          "Bom dia, tudo bem com você?"}) {
        const auto a = A(q, true);
        EXPECT_EQ(a.verdict, QuestionVerdict::Drop) << q << " / " << a.reason;
    }
}

TEST(QuestionGate, NumbersAndDottedNamesDoNotSplitSentences) {
    // "5.000" and "Node.js" must not cut the question in two.
    const auto a = A("Como você chegou a US$ 5.000 de receita com o bot em Node.js?");
    EXPECT_EQ(a.verdict, QuestionVerdict::Ready) << a.reason;
    EXPECT_TRUE(a.explicit_question);
}

// --------------------------------------------------------------- joining

TEST(QuestionGate, FragmentsAreJoinedWithoutTheRepeatedSeam) {
    EXPECT_EQ(join_fragments({"Me conta sobre", "sobre o projeto de Kubernetes"}),
              "Me conta sobre o projeto de Kubernetes");
    EXPECT_EQ(join_fragments({"Qual foi o maior", "desafio?"}), "Qual foi o maior desafio?");
    EXPECT_EQ(join_fragments({"Tell me about", "about a time you failed."}), "Tell me about a time you failed.");
    EXPECT_EQ(join_fragments({"Qual é a sua experiência", "Experiência com Kafka?"}),
              "Qual é a sua experiência com Kafka?");
    EXPECT_EQ(join_fragments({"", "  Me fala  ", "", "do projeto"}), "Me fala do projeto");
    // A real repetition inside the new piece is kept (only the seam is cut).
    EXPECT_EQ(join_fragments({"Por quê?", "Por que você saiu?"}), "Por quê? Por que você saiu?")
        << "different punctuation: not a seam";
}

TEST(QuestionGate, JoinedFragmentsBecomeOneCompleteQuestion) {
    const std::string joined = join_fragments({"Me conta sobre um projeto em que você", "teve um prazo apertado"});
    EXPECT_EQ(A(joined).verdict, QuestionVerdict::Ready);
}

TEST(QuestionGate, GreetingsAndCallChecksWithExtraWordsAreSmallTalk) {
    for (const char* q : {"Fala, tudo bem?", "Oi, tudo bem com você?", "Está me ouvindo bem?", "Can you hear me okay?",
                          "Consegue ver minha tela?", "Opa, boa tarde, tudo certo por aí?"}) {
        EXPECT_EQ(A(q, true).verdict, QuestionVerdict::Drop) << q << " / " << A(q, true).reason;
    }
    // A real question that starts with a greeting word is still a question.
    EXPECT_EQ(A("Como vai o projeto de dados?").verdict, QuestionVerdict::Ready);
    EXPECT_EQ(A("Bom, me fala do seu projeto de Kubernetes.").verdict, QuestionVerdict::Ready);
}

TEST(QuestionGate, ContentWordCount) {
    EXPECT_EQ(content_word_count("porque aqui a gente usa muito Kafka"), 2u);
    EXPECT_EQ(content_word_count("tá, tá bom"), 0u);
    EXPECT_EQ(content_word_count("de 5G"), 1u);
}

// Whatever the STT produces, the gate answers with a valid verdict and the
// joiner never produces double spaces or loses the last fragment's words.
TEST(QuestionGate, RandomUtterancesNeverBreakIt) {
    const std::vector<std::string> pool = {"Qual", "foi", "o", "maior", "desafio", "?", ",", ".", "...", "Me",
                                           "conta", "sobre", "você", "Você", "já", "usou", "Kafka", "5.000",
                                           "Node.js", "é", "tipo", "né", "que", "de", "a", "gente", "Como",
                                           "eu", "disse", "Tell", "me", "about", "time", "why", "\xC3\xA7",
                                           "\xE2\x80\xA6", "!", "\n", "projeto", "Midea", "em", "com"};
    std::mt19937 rng(1234);
    for (int i = 0; i < 4000; ++i) {
        std::string s;
        const int n = static_cast<int>(rng() % 14);
        for (int k = 0; k < n; ++k) {
            if (!s.empty() && rng() % 3) s.push_back(' ');
            s += pool[rng() % pool.size()];
        }
        for (bool ctx : {false, true}) {
            for (bool fin : {false, true}) {
                const auto a = assess_question(s, ctx, fin);
                ASSERT_TRUE(a.verdict == QuestionVerdict::Ready || a.verdict == QuestionVerdict::Wait ||
                            a.verdict == QuestionVerdict::Drop);
                ASSERT_FALSE(a.reason.empty()) << s;
                if (fin) {
                    ASSERT_NE(a.verdict, QuestionVerdict::Wait) << "final never waits: " << s;
                }
                if (a.explicit_question) {
                    ASSERT_EQ(a.verdict, QuestionVerdict::Ready) << s;
                }
            }
        }
        const std::string j = join_fragments({s, "e o resultado foi bom"});
        ASSERT_EQ(j.find("  "), std::string::npos) << j;
        ASSERT_NE(j.find("resultado foi bom"), std::string::npos) << j;
    }
}
