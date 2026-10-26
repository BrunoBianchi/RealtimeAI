// Property-based tests for the pure SessionTranscript accumulator
// (src/core/include/rtai/session_transcript.hpp). The project ships GoogleTest
// only (no dedicated PBT runtime), so each property is checked by sampling the
// input space with a seeded std::mt19937 over many trials plus the exact
// boundary cases the requirement calls out. A fixed seed keeps failures
// reproducible; a reported counterexample can be replayed by hand.
#include <gtest/gtest.h>

#include <cstdint>
#include <random>
#include <string>
#include <vector>

#include "rtai/audio_format.hpp"
#include "rtai/session_transcript.hpp"
#include "rtai/turn_assembler.hpp"

using namespace rtai;

namespace {

// The track a closed Turn must map to, written independently of
// SessionTranscript::append so the test does not simply restate the mapping it
// is checking: Loopback is the interviewer lane, every other source is the
// candidate lane (Req 6.1/6.2).
TranscriptTrack expected_track(AudioSource s) {
    return s == AudioSource::Loopback ? TranscriptTrack::Interviewer
                                      : TranscriptTrack::Candidate;
}

// Build a random source Turn. Text spans the empty string, pure whitespace,
// ASCII punctuation and high (multibyte UTF-8) bytes so the verbatim guarantee
// is exercised against byte values that could be mangled by naive copies.
// Timestamps and seq are monotonic non-decreasing across the sequence, modeling
// real closed turns; the accumulator must not depend on their magnitude.
Turn random_turn(std::mt19937& rng, std::int64_t& clock, std::uint64_t& seq) {
    static const std::string word_chars =
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    static const std::string sep_chars = " \t\n.,;:!?-()[]{}'\"/@#";
    static const unsigned char high_bytes[] = {0x80u, 0xC3u, 0xA9u, 0xE2u, 0x9Cu, 0xFFu};

    std::uniform_int_distribution<int> kind_dist(0, 99);
    std::uniform_int_distribution<std::size_t> word_idx(0, word_chars.size() - 1);
    std::uniform_int_distribution<std::size_t> sep_idx(0, sep_chars.size() - 1);
    std::uniform_int_distribution<std::size_t> high_idx(
        0, (sizeof(high_bytes) / sizeof(high_bytes[0])) - 1);
    std::uniform_int_distribution<int> len_dist(0, 60);
    std::bernoulli_distribution loopback(0.5);
    std::uniform_int_distribution<int> dt_dist(0, 500);
    std::uniform_int_distribution<int> dur_dist(0, 2000);

    auto random_char = [&]() -> char {
        const int k = kind_dist(rng);
        if (k < 55) return word_chars[word_idx(rng)];
        if (k < 90) return sep_chars[sep_idx(rng)];
        return static_cast<char>(high_bytes[high_idx(rng)]);
    };

    Turn t;
    t.source = loopback(rng) ? AudioSource::Loopback : AudioSource::Microphone;
    const int n = len_dist(rng);
    t.text.reserve(static_cast<std::size_t>(n));
    for (int i = 0; i < n; ++i) t.text.push_back(random_char());
    clock += dt_dist(rng);
    t.start_ms = clock;
    clock += dur_dist(rng);
    t.end_ms = clock;
    t.seq = ++seq;
    return t;
}

} // namespace

// Property 14: Append do transcript preserva faixa, ordem e texto verbatim.
// For any generated sequence of closed Turns (random source, random text,
// non-decreasing timestamps/seq), after appending every one of them in order:
//   (a) the accumulator holds exactly as many entries as were appended;
//   (b) each entry's track is the Loopback->Interviewer / Microphone->Candidate
//       mapping of the source Turn (Req 6.1/6.2);
//   (c) the entries appear in the same order they were appended, i.e. the
//       chronological order of turn closure is preserved (Req 6.3);
//   (d) each entry's text is byte-for-byte identical to the source turn's text,
//       and start_ms/end_ms/seq are carried through unchanged (Req 6.4).
//
// **Validates: Requirements 6.1, 6.2, 6.3, 6.4**
TEST(SessionTranscriptProperties, AppendPreservesTrackOrderAndVerbatimText) {
    std::mt19937 rng(0x7A5C7Bu);
    std::uniform_int_distribution<int> count_dist(0, 40);

    constexpr int kTrials = 20000;
    for (int trial = 0; trial < kTrials; ++trial) {
        const int n = count_dist(rng);

        // Keep an independent copy of every Turn fed, so the expected track,
        // order and bytes are compared against the inputs rather than against
        // the accumulator's own state.
        std::vector<Turn> fed;
        fed.reserve(static_cast<std::size_t>(n));

        SessionTranscript transcript;
        std::int64_t clock = 0;
        std::uint64_t seq = 0;
        for (int i = 0; i < n; ++i) {
            Turn t = random_turn(rng, clock, seq);
            fed.push_back(t);
            transcript.append(t);
        }

        const std::vector<TranscriptTurn>& out = transcript.turns();

        // (a) one recorded entry per appended turn, in a 1:1 correspondence.
        ASSERT_EQ(out.size(), fed.size()) << "trial " << trial << " n=" << n;
        EXPECT_EQ(transcript.size(), fed.size()) << "trial " << trial;
        EXPECT_EQ(transcript.empty(), fed.empty()) << "trial " << trial;

        for (std::size_t i = 0; i < fed.size(); ++i) {
            // (b) track mapping Loopback->Interviewer / Microphone->Candidate.
            EXPECT_EQ(out[i].track, expected_track(fed[i].source))
                << "trial " << trial << " index " << i
                << " source=" << to_string(fed[i].source);

            // (c)+(d) order preserved and text/metadata verbatim: entry i is the
            // i-th appended turn, byte-for-byte.
            EXPECT_EQ(out[i].text, fed[i].text)
                << "trial " << trial << " index " << i << " text mismatch";
            EXPECT_EQ(out[i].start_ms, fed[i].start_ms) << "trial " << trial << " index " << i;
            EXPECT_EQ(out[i].end_ms, fed[i].end_ms) << "trial " << trial << " index " << i;
            EXPECT_EQ(out[i].seq, fed[i].seq) << "trial " << trial << " index " << i;
        }
    }
}

// Boundary cases the requirement names explicitly: an empty session (nothing
// appended), a single turn on each lane, a turn with empty text, and
// interleaved lanes whose closure order must be preserved exactly.
TEST(SessionTranscriptProperties, AppendBoundaryCases) {
    // Empty session: no entries, empty() true, rendered text is empty.
    {
        SessionTranscript transcript;
        EXPECT_TRUE(transcript.empty());
        EXPECT_EQ(transcript.size(), 0u);
        EXPECT_TRUE(transcript.turns().empty());
        EXPECT_EQ(transcript.render(), std::string{});
    }

    // Single Loopback turn -> Interviewer, verbatim text.
    {
        SessionTranscript transcript;
        Turn t;
        t.source = AudioSource::Loopback;
        t.text = "Fale sobre um projeto desafiador.";
        t.start_ms = 100;
        t.end_ms = 2500;
        t.seq = 1;
        transcript.append(t);
        ASSERT_EQ(transcript.size(), 1u);
        EXPECT_EQ(transcript.turns()[0].track, TranscriptTrack::Interviewer);
        EXPECT_EQ(transcript.turns()[0].text, t.text);
        EXPECT_EQ(transcript.turns()[0].seq, 1u);
    }

    // Single Microphone turn -> Candidate.
    {
        SessionTranscript transcript;
        Turn t;
        t.source = AudioSource::Microphone;
        t.text = "Trabalhei numa migracao de banco de dados.";
        t.seq = 1;
        transcript.append(t);
        ASSERT_EQ(transcript.size(), 1u);
        EXPECT_EQ(transcript.turns()[0].track, TranscriptTrack::Candidate);
        EXPECT_EQ(transcript.turns()[0].text, t.text);
    }

    // Empty-text turn is still recorded verbatim (the accumulator never filters).
    {
        SessionTranscript transcript;
        Turn t;
        t.source = AudioSource::Microphone;
        t.text = "";
        transcript.append(t);
        ASSERT_EQ(transcript.size(), 1u);
        EXPECT_EQ(transcript.turns()[0].track, TranscriptTrack::Candidate);
        EXPECT_EQ(transcript.turns()[0].text, std::string{});
    }

    // Interleaved lanes: the chronological order of closure (append order) is
    // preserved exactly, independent of source. Also pins the render() layout:
    // one labeled line per turn, verbatim text, in append order.
    {
        SessionTranscript transcript;
        const std::vector<std::pair<AudioSource, std::string>> script = {
            {AudioSource::Loopback, "Pergunta um?"},
            {AudioSource::Microphone, "Resposta um."},
            {AudioSource::Loopback, "Pergunta dois?"},
            {AudioSource::Loopback, "Complemento da pergunta."},
            {AudioSource::Microphone, "Resposta dois."},
        };
        std::uint64_t seq = 0;
        for (const auto& [src, txt] : script) {
            Turn t;
            t.source = src;
            t.text = txt;
            t.seq = ++seq;
            transcript.append(t);
        }
        ASSERT_EQ(transcript.size(), script.size());
        for (std::size_t i = 0; i < script.size(); ++i) {
            const TranscriptTrack want = script[i].first == AudioSource::Loopback
                                             ? TranscriptTrack::Interviewer
                                             : TranscriptTrack::Candidate;
            EXPECT_EQ(transcript.turns()[i].track, want) << "index " << i;
            EXPECT_EQ(transcript.turns()[i].text, script[i].second) << "index " << i;
        }

        const std::string expected_render =
            "Interviewer: Pergunta um?\n"
            "Candidate: Resposta um.\n"
            "Interviewer: Pergunta dois?\n"
            "Interviewer: Complemento da pergunta.\n"
            "Candidate: Resposta dois.\n";
        EXPECT_EQ(transcript.render(), expected_render);
    }
}
