// text_util, suggestion formatting, the UI wake queue and the async log.
#include <gtest/gtest.h>

#include <atomic>
#include <cstdio>
#include <random>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "rtai/async_log.hpp"
#include "rtai/suggestion_format.hpp"
#include "rtai/text_util.hpp"
#include "rtai/wake_queue.hpp"

using namespace rtai;

TEST(TextUtil, FoldsAccentsAndCase) {
    EXPECT_EQ(text::fold("Você Já ORÇAMENTO? Ação"), "voce ja orcamento? acao");
}

TEST(TextUtil, SanitizesInvalidUtf8) {
    EXPECT_EQ(text::sanitize_utf8("ok"), "ok");
    EXPECT_EQ(text::sanitize_utf8("ol\xC3\xA1"), "ol\xC3\xA1");
    EXPECT_EQ(text::sanitize_utf8("a\xFF" "b"), "a\xEF\xBF\xBD" "b");
    EXPECT_EQ(text::sanitize_utf8("trunc\xE2\x82"), "trunc\xEF\xBF\xBD\xEF\xBF\xBD");
}

TEST(TextUtil, TruncatesOnCodePointBoundaries) {
    const std::string s = "açaí";               // a ç(2) a í(2) = 6 bytes
    EXPECT_EQ(text::truncate_utf8(s, 2), "a");  // never cuts inside 'ç'
    EXPECT_EQ(text::tail_utf8(s, 3), "a\xC3\xAD"); // "aí"
    EXPECT_EQ(text::tail_utf8(s, 1), "");            // never starts inside 'í'
}

TEST(TextUtil, WordHelpers) {
    EXPECT_EQ(text::word_count("  um  dois\ttres\n"), 3u);
    EXPECT_TRUE(text::contains_word("qual o preco final", "preco"));
    EXPECT_FALSE(text::contains_word("precos", "preco"));
    EXPECT_TRUE(text::starts_with_word("por que nao", "por que"));
    EXPECT_FALSE(text::starts_with_word("porque sim", "por"));
    EXPECT_EQ(text::split_list(" a, b ,,c "), (std::vector<std::string>{"a", "b", "c"}));
    EXPECT_EQ(text::join_space(" a ", " b "), "a b");
}

TEST(SuggestionFormat, ParsesBulletsLabelsAndBold) {
    const auto lines = format_suggestion(
        "- Nosso prazo é de **4 a 6 semanas**.\n"
        "• Posso enviar a proposta hoje\n"
        "\n"
        "Insight: cliente com orçamento aprovado\n"
        "Ações: confirmar usuários; agendar demo");
    ASSERT_EQ(lines.size(), 4u);
    EXPECT_EQ(lines[0].kind, FormattedLine::Kind::Bullet);
    ASSERT_EQ(lines[0].segments.size(), 3u);
    EXPECT_FALSE(lines[0].segments[0].bold);
    EXPECT_TRUE(lines[0].segments[1].bold);
    EXPECT_EQ(lines[0].segments[1].text, "4 a 6 semanas");
    EXPECT_EQ(lines[1].kind, FormattedLine::Kind::Bullet);
    EXPECT_EQ(lines[1].plain(), "Posso enviar a proposta hoje");
    EXPECT_EQ(lines[2].kind, FormattedLine::Kind::Label);
    EXPECT_TRUE(lines[2].segments[0].bold);
    EXPECT_EQ(lines[2].segments[0].text, "Insight:");
    EXPECT_EQ(lines[3].plain(), "Ações: confirmar usuários; agendar demo");
}

TEST(SuggestionFormat, UnclosedBoldWhileStreamingHasNoAsterisks) {
    const auto lines = format_suggestion("- Prazo de **4 sem", /*streaming=*/true);
    ASSERT_EQ(lines.size(), 1u);
    EXPECT_EQ(lines[0].plain(), "Prazo de 4 sem");
    EXPECT_TRUE(lines[0].segments.back().bold);
}

TEST(SuggestionFormat, UnclosedBoldNonStreamingIsLiteral) {
    // Req 5.6: opening "**" without a closing pair renders as literal asterisks.
    const auto lines = format_suggestion("- Prazo de **4 sem");
    ASSERT_EQ(lines.size(), 1u);
    EXPECT_EQ(lines[0].plain(), "Prazo de **4 sem");
    for (const auto& seg : lines[0].segments) EXPECT_FALSE(seg.bold);
}

TEST(SuggestionFormat, BlankBodyProducesEmptyList) {
    // Req 5.2: empty / whitespace-only input yields no lines.
    EXPECT_TRUE(format_suggestion("").empty());
    EXPECT_TRUE(format_suggestion("   \n\t  \n").empty());
}

// Property 7: a primeira linha não vazia é a Headline.
// For ANY non-empty response text whose first non-empty line is a plain
// paragraph (not a bullet "- "/"* "/"•", not a markdown heading "#", and not a
// known label prefix like "Insight:"/"Ações:"/"Pergunta:"), the first
// FormattedLine produced by format_suggestion is classified Kind::Headline and
// its plain() text corresponds to that first non-empty line (the trimmed first
// non-empty line, with the leading paragraph left byte-for-byte intact).
//
// The project ships GoogleTest only, so the property is sampled with a seeded
// std::mt19937 over many trials — a fixed seed keeps any counterexample
// reproducible. The generator builds the first non-empty line out of plain
// word tokens (letters/digits/spaces, no ':', no "**", no leading marker),
// which the parser classifies as Paragraph and therefore promotes to Headline,
// and prefixes it with a random run of blank/whitespace-only lines plus random
// trailing body lines (bullets, labels, paragraphs) that must not affect which
// line is the Headline.
//
// **Validates: Requirements 5.1**
namespace {

// An independent oracle for the parser's per-line normalization of a plain
// paragraph: trim the raw line, then strip any leading spaces. The generator
// below never emits a leading '#', bullet marker, ':' or "**" on the first
// line, so no heading/label/bold stripping applies and this equals the
// Headline's plain() text.
std::string expected_headline_plain(std::string_view raw_first_line) {
    std::string t = text::trim(raw_first_line);
    std::size_t i = 0;
    while (i < t.size() && t[i] == ' ') ++i;
    return t.substr(i);
}

} // namespace

TEST(SuggestionFormatProperties, FirstNonEmptyPlainLineIsHeadline) {
    std::mt19937 rng(0x5EAD11u);

    // Word characters for a plain paragraph: letters and digits only. No ':'
    // (would split a label term), no '*'/'-'/'#'/'•' leading marker, no "**".
    const std::string word_chars =
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    std::uniform_int_distribution<std::size_t> word_idx(0, word_chars.size() - 1);
    std::uniform_int_distribution<int> words_dist(1, 8);
    std::uniform_int_distribution<int> wlen_dist(1, 10);
    std::uniform_int_distribution<int> lead_blanks_dist(0, 4);
    std::uniform_int_distribution<int> trailing_dist(0, 4);
    std::uniform_int_distribution<int> indent_dist(0, 3);
    std::uniform_int_distribution<int> blank_kind(0, 2);
    std::uniform_int_distribution<int> body_kind(0, 3);

    auto make_word = [&]() {
        std::string w;
        const int n = wlen_dist(rng);
        for (int i = 0; i < n; ++i) w.push_back(word_chars[word_idx(rng)]);
        return w;
    };
    // A plain paragraph line: words joined by single spaces, optionally indented.
    auto make_paragraph = [&]() {
        std::string line(static_cast<std::size_t>(indent_dist(rng)), ' ');
        const int n = words_dist(rng);
        for (int i = 0; i < n; ++i) {
            if (i) line.push_back(' ');
            line += make_word();
        }
        return line;
    };

    constexpr int kTrials = 20000;
    for (int t = 0; t < kTrials; ++t) {
        std::string body;

        // A random run of blank / whitespace-only lines before the headline:
        // these are skipped by the parser, so the first NON-EMPTY line is the
        // paragraph we build next.
        const int lead = lead_blanks_dist(rng);
        for (int i = 0; i < lead; ++i) {
            switch (blank_kind(rng)) {
                case 0: break;                 // truly empty line
                case 1: body += "   "; break;  // spaces only
                default: body += "\t "; break; // mixed whitespace
            }
            body.push_back('\n');
        }

        // The first non-empty line: a plain paragraph that must become Headline.
        const std::string first_line = make_paragraph();
        body += first_line;

        // Random trailing body lines (bullets, labels, more paragraphs) that
        // must not change which line is the Headline.
        const int trailing = trailing_dist(rng);
        for (int i = 0; i < trailing; ++i) {
            body.push_back('\n');
            switch (body_kind(rng)) {
                case 0: body += "- " + make_paragraph(); break;        // bullet
                case 1: body += "Insight: " + make_paragraph(); break; // label
                case 2: body += make_paragraph(); break;               // paragraph
                default: body += "\xE2\x80\xA2 " + make_paragraph(); break; // "•" bullet
            }
        }

        const auto lines = format_suggestion(body);

        // A non-empty response with a non-empty first line always yields at
        // least one FormattedLine.
        ASSERT_FALSE(lines.empty())
            << "trial " << t << " body=[" << body << "]";

        // The first produced line is the Headline (Req 5.1) ...
        EXPECT_EQ(lines[0].kind, FormattedLine::Kind::Headline)
            << "trial " << t << " body=[" << body << "]";

        // ... and it corresponds to the first non-empty line of the input.
        EXPECT_EQ(lines[0].plain(), expected_headline_plain(first_line))
            << "trial " << t << " first_line=[" << first_line << "]";
    }
}

// Boundary cases the property names explicitly: leading blank lines before the
// headline, a leading paragraph followed by a bullet/label (the paragraph is
// the headline, not the bullet), and a single-line response.
TEST(SuggestionFormatProperties, HeadlineBoundaryCases) {
    // Single plain line -> that line is the Headline.
    {
        const auto lines = format_suggestion("Tese direta e curta");
        ASSERT_EQ(lines.size(), 1u);
        EXPECT_EQ(lines[0].kind, FormattedLine::Kind::Headline);
        EXPECT_EQ(lines[0].plain(), "Tese direta e curta");
    }
    // Leading blank / whitespace-only lines are skipped; the first non-empty
    // line is the Headline.
    {
        const auto lines = format_suggestion("\n   \n\t \nMinha tese\n- ancora um");
        ASSERT_EQ(lines.size(), 2u);
        EXPECT_EQ(lines[0].kind, FormattedLine::Kind::Headline);
        EXPECT_EQ(lines[0].plain(), "Minha tese");
        EXPECT_EQ(lines[1].kind, FormattedLine::Kind::Bullet);
    }
    // A plain paragraph followed by a label: the paragraph is the Headline, the
    // label keeps its own kind (the promotion only applies to the first line).
    {
        const auto lines = format_suggestion("Resposta tese\nInsight: detalhe");
        ASSERT_EQ(lines.size(), 2u);
        EXPECT_EQ(lines[0].kind, FormattedLine::Kind::Headline);
        EXPECT_EQ(lines[0].plain(), "Resposta tese");
        EXPECT_EQ(lines[1].kind, FormattedLine::Kind::Label);
    }
    // A leading bullet/label keeps its own kind (per task 3.2): the first line
    // is NOT promoted to Headline when it is itself a bullet or label.
    {
        const auto bullet = format_suggestion("- primeiro item\nsegundo");
        ASSERT_EQ(bullet.size(), 2u);
        EXPECT_EQ(bullet[0].kind, FormattedLine::Kind::Bullet);

        const auto label = format_suggestion("Insight: primeiro\nsegundo");
        ASSERT_EQ(label.size(), 2u);
        EXPECT_EQ(label[0].kind, FormattedLine::Kind::Label);
    }
}

TEST(WakeQueue, CoalescesWakeUpsUntilDrained) {
    std::atomic<int> wakes{0};
    WakeQueue<int> q{[&] { wakes.fetch_add(1); }};
    for (int i = 0; i < 100; ++i) q.push(i);
    EXPECT_EQ(wakes.load(), 1);
    auto items = q.drain();
    EXPECT_EQ(items.size(), 100u);
    q.push(1);
    EXPECT_EQ(wakes.load(), 2);
    q.set_wake(nullptr);
    q.drain();
    q.push(2); // no wake function: must not crash, item still queued
    EXPECT_EQ(wakes.load(), 2);
    EXPECT_EQ(q.size(), 1u);
}

TEST(WakeQueue, ManyProducersOneConsumer) {
    std::atomic<int> wakes{0};
    WakeQueue<int> q{[&] { wakes.fetch_add(1); }};
    std::vector<std::thread> producers;
    for (int t = 0; t < 4; ++t) {
        producers.emplace_back([&] {
            for (int i = 0; i < 1000; ++i) q.push(i);
        });
    }
    std::size_t total = 0;
    std::atomic<bool> done{false};
    std::thread consumer([&] {
        while (!done.load() || q.size() > 0) total += q.drain().size();
    });
    for (auto& p : producers) p.join();
    done.store(true);
    consumer.join();
    EXPECT_EQ(total, 4000u);
}

TEST(AsyncLog, WritesAllLinesInOrder) {
    std::FILE* f = std::tmpfile();
    ASSERT_NE(f, nullptr);
    {
        AsyncLog log{f};
        for (int i = 0; i < 50; ++i) log.line("linha " + std::to_string(i));
        log.stop();
    }
    std::rewind(f);
    char buf[64];
    int n = 0;
    while (std::fgets(buf, sizeof(buf), f)) {
        EXPECT_EQ(std::string(buf), "linha " + std::to_string(n) + "\n");
        ++n;
    }
    EXPECT_EQ(n, 50);
    std::fclose(f);
}
