// Property-based tests for the pure Cold_Path pieces of rtai::JevAnalyticsClient
// (src/net/include/rtai/jev_analytics_client.hpp). The project ships GoogleTest
// only (no dedicated PBT runtime), so each property is checked by sampling the
// input space with a seeded std::mt19937 over many trials plus the exact
// boundary cases the requirement names. A fixed seed keeps failures
// reproducible; a reported counterexample can be replayed by hand.
//
// This file is SHARED between task 8.4 (request schema — suite JevRequestProps)
// and task 8.5 (response round-trip — suite JevResponseProps). Each task owns a
// distinct TEST suite so the two can be appended independently without
// colliding; add new suites rather than overwriting what is already here.

#include <gtest/gtest.h>

#include <array>
#include <cmath>
#include <optional>
#include <random>
#include <string>
#include <string_view>
#include <vector>

#include "rtai/audio_format.hpp"
#include "rtai/jev_analytics_client.hpp"
#include "rtai/json_min.hpp"
#include "rtai/session_transcript.hpp"
#include "rtai/text_util.hpp"
#include "rtai/turn_assembler.hpp"

using namespace rtai;

namespace {

// clamp(value, 0, 10): the exact contract parse_engine_response applies to
// every score. Written independently of the implementation so the test is a
// genuine oracle rather than a restatement.
double expected_clamp(double v) {
    if (v < 0.0) return 0.0;
    if (v > 10.0) return 10.0;
    return v;
}

// Build a Jev Engine API response body with the project's json_min Writer —
// a direct JSON object carrying the three score fields the parser reads. Using
// double_value mirrors how a real numeric payload is serialized (fixed
// precision), so the round-trip is checked against the actually-wire value.
std::string build_response_body(double relevance, double accuracy, double clarity) {
    json::Writer w;
    w.begin_object();
    w.field_double("relevance_score", relevance, 6);
    w.field_double("accuracy_score", accuracy, 6);
    w.field_double("clarity_score", clarity, 6);
    w.end_object();
    return std::move(w).str();
}

// The score the parser will see after the writer serializes `v` at the given
// precision: double_value(v, 6) rounds to 6 fractional digits, so the oracle
// must clamp that same serialized value, not the pre-serialization double.
double serialized_then_clamped(double v) {
    const std::string body = [&] {
        json::Writer w;
        w.begin_object();
        w.field_double("x", v, 6);
        w.end_object();
        return std::move(w).str();
    }();
    auto parsed = json::Parser::parse(body);
    const double round_tripped = (*parsed)["x"].as_number(0.0);
    return expected_clamp(round_tripped);
}

} // namespace

// ---------------------------------------------------------------------------
// Property 16: Response da Jev Engine API faz round-trip de pontuações
// clampadas.
// ---------------------------------------------------------------------------
// For any score values (including out-of-range negatives, values > 10, and
// in-range values), serializing them into a direct JSON response body and
// feeding it to parse_engine_response yields JevScores whose each field equals
// clamp(value, 0, 10). Malformed input (non-object JSON, garbage) yields
// std::nullopt. Each score is independent, so all three are varied together.
//
// **Validates: Requirements 7.3**
TEST(JevResponseProps, ScoresRoundTripClampedToZeroTen) {
    std::mt19937 rng(0x5C0E5u);
    // Span well below 0 and well above 10 so both clamp directions are hit, with
    // dense coverage of the in-range [0, 10] interior and the exact endpoints.
    std::uniform_real_distribution<double> score_dist(-50.0, 60.0);

    constexpr int kTrials = 20000;
    for (int t = 0; t < kTrials; ++t) {
        const double rel = score_dist(rng);
        const double acc = score_dist(rng);
        const double cla = score_dist(rng);

        const std::string body = build_response_body(rel, acc, cla);
        const std::optional<JevScores> parsed =
            JevAnalyticsClient::parse_engine_response(body);

        // A well-formed object always parses.
        ASSERT_TRUE(parsed.has_value())
            << "trial " << t << " body=" << body;

        // Every score equals clamp(serialized_value, 0, 10): never below 0,
        // never above 10, and equal to the clamped wire value in range.
        EXPECT_DOUBLE_EQ(parsed->relevance, serialized_then_clamped(rel))
            << "trial " << t << " rel=" << rel;
        EXPECT_DOUBLE_EQ(parsed->accuracy, serialized_then_clamped(acc))
            << "trial " << t << " acc=" << acc;
        EXPECT_DOUBLE_EQ(parsed->clarity, serialized_then_clamped(cla))
            << "trial " << t << " cla=" << cla;

        // The clamp band is respected regardless of the input.
        EXPECT_GE(parsed->relevance, 0.0);
        EXPECT_LE(parsed->relevance, 10.0);
        EXPECT_GE(parsed->accuracy, 0.0);
        EXPECT_LE(parsed->accuracy, 10.0);
        EXPECT_GE(parsed->clarity, 0.0);
        EXPECT_LE(parsed->clarity, 10.0);
    }
}

// Boundary cases the requirement names explicitly: the exact clamp endpoints,
// values just outside [0, 10], deep out-of-range, and integer-written scores
// (no fractional part on the wire).
TEST(JevResponseProps, ScoreBoundaryValuesClamp) {
    struct Case { double in; double want; };
    const std::vector<Case> cases = {
        {-1000.0, 0.0}, // deep negative floors to 0
        {-0.0001, 0.0}, // just below 0 floors to 0
        {0.0, 0.0},     // lower endpoint
        {5.0, 5.0},     // mid range passes through
        {5.5, 5.5},     // fractional in range
        {10.0, 10.0},   // upper endpoint
        {10.0001, 10.0},// just above 10 saturates to 10
        {1000.0, 10.0}, // deep positive saturates to 10
    };

    for (const auto& c : cases) {
        const std::string body = build_response_body(c.in, c.in, c.in);
        const auto parsed = JevAnalyticsClient::parse_engine_response(body);
        ASSERT_TRUE(parsed.has_value()) << "in=" << c.in << " body=" << body;
        EXPECT_DOUBLE_EQ(parsed->relevance, c.want) << "in=" << c.in;
        EXPECT_DOUBLE_EQ(parsed->accuracy, c.want) << "in=" << c.in;
        EXPECT_DOUBLE_EQ(parsed->clarity, c.want) << "in=" << c.in;
    }
}

// A well-formed object may omit score fields: a missing field reads as 0.0
// (json_min's as_number default), which is in-range and stays 0.0. An object
// that is otherwise valid but carries extra fields parses fine and ignores the
// extras. Integer-written numbers (no decimal point) also round-trip.
TEST(JevResponseProps, MissingFieldsDefaultToZeroExtrasIgnored) {
    // Empty object: all three scores default to 0.0.
    {
        const auto parsed = JevAnalyticsClient::parse_engine_response("{}");
        ASSERT_TRUE(parsed.has_value());
        EXPECT_DOUBLE_EQ(parsed->relevance, 0.0);
        EXPECT_DOUBLE_EQ(parsed->accuracy, 0.0);
        EXPECT_DOUBLE_EQ(parsed->clarity, 0.0);
    }
    // Only one field present; the other two default to 0.0. Integer literal on
    // the wire (no fractional part) round-trips to 7.
    {
        const auto parsed = JevAnalyticsClient::parse_engine_response(
            R"({"accuracy_score": 7, "unrelated": "x", "nested": {"a": 1}})");
        ASSERT_TRUE(parsed.has_value());
        EXPECT_DOUBLE_EQ(parsed->relevance, 0.0);
        EXPECT_DOUBLE_EQ(parsed->accuracy, 7.0);
        EXPECT_DOUBLE_EQ(parsed->clarity, 0.0);
    }
    // Leading/trailing whitespace is trimmed before parsing (parser uses
    // text::trim); the object still parses.
    {
        const auto parsed = JevAnalyticsClient::parse_engine_response(
            "   \n\t {\"relevance_score\": 9.25}\n  ");
        ASSERT_TRUE(parsed.has_value());
        EXPECT_DOUBLE_EQ(parsed->relevance, 9.25);
    }
}

// ---------------------------------------------------------------------------
// Malformed inputs yield std::nullopt: anything that is not a JSON object —
// arrays, scalars, trailing garbage, truncated/empty payloads — must fail to
// parse rather than silently returning zeroed scores.
// ---------------------------------------------------------------------------
TEST(JevResponseProps, MalformedInputYieldsNullopt) {
    const std::vector<std::string> malformed = {
        "",                       // empty
        "   ",                    // whitespace only
        "null",                   // JSON null (not an object)
        "true",                   // bool scalar
        "42",                     // number scalar
        "\"a string\"",           // string scalar
        "[1, 2, 3]",              // array, not an object
        "[]",                     // empty array
        "{",                      // truncated object
        "}",                      // stray close brace
        "{\"relevance_score\":}", // missing value
        "{\"relevance_score\": 5", // unterminated object
        "{\"a\": 1} trailing",     // trailing garbage after a valid object
        "{bad json}",             // unquoted key / garbage
        "not json at all",        // pure garbage
        "{\"relevance_score\": 1,}", // trailing comma (parser rejects)
    };

    for (const auto& body : malformed) {
        const auto parsed = JevAnalyticsClient::parse_engine_response(body);
        EXPECT_FALSE(parsed.has_value())
            << "expected nullopt for malformed body=[" << body << "]";
    }
}

// Random malformed fuzz: arrays and scalars built from the writer, plus random
// byte garbage, must never parse as a score object. This complements the named
// cases above by exploring a broader slice of the non-object input space.
TEST(JevResponseProps, RandomNonObjectAndGarbageYieldNullopt) {
    std::mt19937 rng(0xBADF00Du);

    // (a) Well-formed JSON arrays of random numbers — valid JSON, but not an
    // object, so the parser must reject them.
    {
        std::uniform_int_distribution<int> len_dist(0, 6);
        std::uniform_real_distribution<double> num_dist(-100.0, 100.0);
        for (int t = 0; t < 2000; ++t) {
            json::Writer w;
            w.begin_array();
            const int n = len_dist(rng);
            for (int i = 0; i < n; ++i) w.double_value(num_dist(rng), 3);
            w.end_array();
            const std::string body = std::move(w).str();
            EXPECT_FALSE(JevAnalyticsClient::parse_engine_response(body).has_value())
                << "array body=" << body;
        }
    }

    // (b) Random byte garbage. The occasional accidental valid object is
    // vanishingly unlikely over this alphabet, but to stay a strict oracle we
    // only assert nullopt when the bytes do not parse as a JSON object.
    {
        const std::string alphabet = "{}[]:,\"0123456789abcXYZ .-\n\t";
        std::uniform_int_distribution<std::size_t> idx(0, alphabet.size() - 1);
        std::uniform_int_distribution<std::size_t> len_dist(0, 24);
        for (int t = 0; t < 3000; ++t) {
            std::string body;
            const std::size_t n = len_dist(rng);
            body.reserve(n);
            for (std::size_t i = 0; i < n; ++i) body.push_back(alphabet[idx(rng)]);

            const auto parsed = JevAnalyticsClient::parse_engine_response(body);
            if (parsed.has_value()) {
                // If it parsed, the bytes must genuinely be a JSON object; the
                // parser is the source of truth for that classification.
                auto direct = json::Parser::parse(body);
                EXPECT_TRUE(direct && direct->is_object())
                    << "parsed a non-object as scores: body=[" << body << "]";
            }
        }
    }
}

// ===========================================================================
// Task 8.4 — Property 15: request schema (suite JevRequestProps).
// ===========================================================================
namespace {

// Builds a Turn for a transcript. Text is kept ASCII (printable + newline/tab)
// so render() is already valid UTF-8 and the build_engine_request sanitize step
// is a no-op -- that lets the test assert state == render() byte-for-byte while
// still exercising characters the JSON writer must escape (", \\, \n, \t).
Turn make_request_turn(AudioSource src, std::string text, std::uint64_t seq) {
    Turn t;
    t.source = src;
    t.text = std::move(text);
    t.start_ms = static_cast<std::int64_t>(seq) * 1000;
    t.end_ms = t.start_ms + 500;
    t.seq = seq;
    return t;
}

// The expected score keys and choice keys, in the order build_engine_request
// emits them.
constexpr std::array<std::string_view, 3> kScoreKeys = {
    "relevance_score", "accuracy_score", "clarity_score"};
constexpr std::array<std::string_view, 2> kChoiceKeys = {"domain", "interview_type"};

// Asserts that `req` (output of build_engine_request) parses as valid JSON and
// matches the Property 15 schema for `t`: a "state" field equal to the rendered
// transcript, and a "questions" array holding EXACTLY the three score items
// (0..10) and two choice items, in order.
void expect_valid_engine_request(const std::string& req, const SessionTranscript& t,
                                 int trial) {
    // (1) Parses as valid JSON (object at the root).
    auto parsed = json::Parser::parse(text::trim(req));
    ASSERT_TRUE(parsed.has_value()) << "trial " << trial << ": request is not valid JSON\n" << req;
    const json::Value& root = *parsed;
    ASSERT_TRUE(root.is_object()) << "trial " << trial << ": root is not a JSON object";

    // (2) "state" carries the full verbatim transcript. build_engine_request
    // runs render() through sanitize_utf8; for ASCII input that is a no-op, so
    // the parsed value equals render() exactly. Assert against the sanitized
    // render so the invariant holds for any input, ASCII or not.
    ASSERT_TRUE(root.has("state")) << "trial " << trial << ": missing \"state\"";
    EXPECT_TRUE(root["state"].is_string()) << "trial " << trial << ": \"state\" is not a string";
    EXPECT_EQ(root["state"].as_string(), text::sanitize_utf8(t.render()))
        << "trial " << trial << ": \"state\" is not the rendered transcript";

    // (3) "questions" is an array with exactly 5 entries.
    ASSERT_TRUE(root.has("questions")) << "trial " << trial << ": missing \"questions\"";
    const json::Value& questions = root["questions"];
    ASSERT_TRUE(questions.is_array()) << "trial " << trial << ": \"questions\" is not an array";
    ASSERT_EQ(questions.size(), 5u)
        << "trial " << trial << ": expected exactly 5 questions (3 score + 2 choice)";

    // (4) First three are the score items, in order, with min 0 / max 10.
    for (std::size_t i = 0; i < kScoreKeys.size(); ++i) {
        const json::Value& q = questions.at(i);
        ASSERT_TRUE(q.is_object()) << "trial " << trial << " question " << i << " not an object";
        EXPECT_EQ(q["key"].as_string(), kScoreKeys[i])
            << "trial " << trial << " score key at index " << i;
        EXPECT_EQ(q["type"].as_string(), "score")
            << "trial " << trial << " type at index " << i;
        EXPECT_EQ(q["min"].as_number(-1.0), 0.0) << "trial " << trial << " min at index " << i;
        EXPECT_EQ(q["max"].as_number(-1.0), 10.0) << "trial " << trial << " max at index " << i;
    }

    // (5) Last two are the choice items, in order.
    for (std::size_t i = 0; i < kChoiceKeys.size(); ++i) {
        const json::Value& q = questions.at(kScoreKeys.size() + i);
        ASSERT_TRUE(q.is_object())
            << "trial " << trial << " choice question " << i << " not an object";
        EXPECT_EQ(q["key"].as_string(), kChoiceKeys[i])
            << "trial " << trial << " choice key at index " << i;
        EXPECT_EQ(q["type"].as_string(), "choice")
            << "trial " << trial << " type for choice at index " << i;
    }

    // (6) Schema independence: the "questions" block is fixed and does NOT
    // depend on the transcript content -- exactly 3 score keys and 2 choice
    // keys regardless of how many turns the transcript holds.
    int score_items = 0;
    int choice_items = 0;
    for (std::size_t i = 0; i < questions.size(); ++i) {
        const std::string& type = questions.at(i)["type"].as_string();
        if (type == "score") ++score_items;
        else if (type == "choice") ++choice_items;
    }
    EXPECT_EQ(score_items, 3) << "trial " << trial << ": expected 3 score items";
    EXPECT_EQ(choice_items, 2) << "trial " << trial << ": expected 2 choice items";
}

} // namespace

// Property 15: Request da Jev Engine API contém `state` e o esquema de
// `questions`. For ANY SessionTranscript, build_engine_request produces valid
// JSON whose "state" equals the rendered transcript and whose "questions" array
// holds exactly the three type:"score" items (relevance/accuracy/clarity, min 0
// max 10) and the two type:"choice" items (domain, interview_type), in order.
//
// Strategy: generate random transcripts -- random turn counts over both lanes
// with random ASCII text that includes the characters the JSON writer must
// escape (quotes, backslashes, newlines, tabs) -- and assert the schema holds
// after parsing the output back with the project's json_min reader.
//
// **Validates: Requirements 7.2**
TEST(JevRequestProps, ContainsStateAndQuestionsSchema) {
    std::mt19937 rng(0x7E57A11u);
    std::uniform_int_distribution<int> turn_count_dist(0, 12);
    std::uniform_int_distribution<int> text_len_dist(0, 60);
    std::uniform_int_distribution<int> src_dist(0, 1);

    // ASCII alphabet weighted toward words but deliberately including the bytes
    // the JSON writer escapes, so the round-trip exercises escaping.
    const std::string alphabet =
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 "
        ".,;:!?-()pergunta "   // whole words bias a question-ish shape
        "\"\\\n\t";            // characters the writer must escape
    std::uniform_int_distribution<std::size_t> alpha_idx(0, alphabet.size() - 1);

    constexpr int kTrials = 5000;
    for (int trial = 0; trial < kTrials; ++trial) {
        SessionTranscript transcript;
        const int turns = turn_count_dist(rng);
        for (int i = 0; i < turns; ++i) {
            const int n = text_len_dist(rng);
            std::string text;
            text.reserve(static_cast<std::size_t>(n));
            for (int k = 0; k < n; ++k) text.push_back(alphabet[alpha_idx(rng)]);
            const AudioSource src =
                src_dist(rng) == 0 ? AudioSource::Loopback : AudioSource::Microphone;
            transcript.append(
                make_request_turn(src, std::move(text), static_cast<std::uint64_t>(i + 1)));
        }

        const std::string req = JevAnalyticsClient::build_engine_request(transcript);
        expect_valid_engine_request(req, transcript, trial);
    }
}

// Boundary cases the property names explicitly: an empty transcript, a single
// turn on each lane, and text that is nothing but characters the JSON writer
// must escape. Each must still yield the exact 3-score / 2-choice schema and a
// "state" that round-trips to the rendered transcript.
TEST(JevRequestProps, BoundaryTranscripts) {
    // Empty transcript -> state is "", schema still exactly 3 score + 2 choice.
    {
        SessionTranscript t;
        const std::string req = JevAnalyticsClient::build_engine_request(t);
        auto parsed = json::Parser::parse(text::trim(req));
        ASSERT_TRUE(parsed.has_value());
        EXPECT_EQ((*parsed)["state"].as_string(), "");
        expect_valid_engine_request(req, t, -1);
    }
    // One interviewer turn and one candidate turn, plain text.
    {
        SessionTranscript t;
        t.append(make_request_turn(AudioSource::Loopback, "Tell me about yourself", 1));
        t.append(make_request_turn(AudioSource::Microphone, "I am a software engineer", 2));
        const std::string req = JevAnalyticsClient::build_engine_request(t);
        auto parsed = json::Parser::parse(text::trim(req));
        ASSERT_TRUE(parsed.has_value());
        // render() labels each turn by track; state must equal it verbatim.
        EXPECT_EQ((*parsed)["state"].as_string(), t.render());
        expect_valid_engine_request(req, t, -2);
    }
    // Text made only of escape-triggering bytes must still round-trip cleanly.
    {
        SessionTranscript t;
        t.append(make_request_turn(AudioSource::Loopback, "\"\\\n\t\"", 1));
        const std::string req = JevAnalyticsClient::build_engine_request(t);
        auto parsed = json::Parser::parse(text::trim(req));
        ASSERT_TRUE(parsed.has_value());
        EXPECT_EQ((*parsed)["state"].as_string(), t.render());
        expect_valid_engine_request(req, t, -3);
    }
}

// ===========================================================================
// Task 8.6 — Property 17: all-or-nothing join (suite JevJoinProps).
// ===========================================================================

// ---------------------------------------------------------------------------
// Property 17: Join tudo-ou-nada decide o modo e nunca renderiza parcial.
// ---------------------------------------------------------------------------
// final_mode(engine_ok, feedback_ok) returns OverlayMode::PostInterviewReport
// IFF BOTH flags are true; every other combination (false/false, true/false,
// false/true) returns OverlayMode::LiveCopilot. That is exactly the
// all-or-nothing contract of Requirement 8:
//   - 8.1/8.2: either call failing (that flag false) keeps LiveCopilot and
//     shows no part of the dashboard;
//   - 8.3: both succeeding is the only transition into PostInterviewReport;
//   - 8.4: because a single failure never yields PostInterviewReport, the
//     partial result from the other call is never rendered.
//
// The decision has a tiny two-boolean domain (four combinations), so the
// property is checked exhaustively over all four inputs AND over a seeded
// random sweep to honor the project's PBT convention. The expected value is
// computed by an independent boolean oracle (engine_ok && feedback_ok), not by
// restating the implementation.
//
// **Validates: Requirements 8.1, 8.2, 8.3, 8.4**
TEST(JevJoinProps, PostInterviewReportIffBothCallsSucceed) {
    // Exhaustive coverage of the full input space: all four (engine, feedback)
    // boolean combinations. PostInterviewReport is reachable only at (1,1).
    for (bool engine_ok : {false, true}) {
        for (bool feedback_ok : {false, true}) {
            const OverlayMode mode =
                JevAnalyticsClient::final_mode(engine_ok, feedback_ok);
            const OverlayMode expected = (engine_ok && feedback_ok)
                                             ? OverlayMode::PostInterviewReport
                                             : OverlayMode::LiveCopilot;
            EXPECT_EQ(mode, expected)
                << "engine_ok=" << engine_ok << " feedback_ok=" << feedback_ok;

            // Restate the invariant as a biconditional so a regression in
            // either direction (false positive OR missed success) is caught.
            const bool is_report = (mode == OverlayMode::PostInterviewReport);
            EXPECT_EQ(is_report, engine_ok && feedback_ok)
                << "engine_ok=" << engine_ok << " feedback_ok=" << feedback_ok;

            // Any single failure must NOT render the report (Req 8.1/8.2/8.4):
            // the mode stays LiveCopilot, so no partial dashboard is shown.
            if (!engine_ok || !feedback_ok) {
                EXPECT_EQ(mode, OverlayMode::LiveCopilot)
                    << "a failing call must keep LiveCopilot: engine_ok="
                    << engine_ok << " feedback_ok=" << feedback_ok;
            }
        }
    }

    // Seeded random sweep over the same two-boolean domain (PBT convention).
    // Redundant with the exhaustive loop by construction, but it exercises the
    // decision under a fresh, reproducible stream of inputs and documents the
    // generator so a counterexample can be replayed by hand.
    std::mt19937 rng(0x101A11u);
    std::bernoulli_distribution flag(0.5);
    constexpr int kTrials = 20000;
    for (int t = 0; t < kTrials; ++t) {
        const bool engine_ok = flag(rng);
        const bool feedback_ok = flag(rng);

        const OverlayMode mode =
            JevAnalyticsClient::final_mode(engine_ok, feedback_ok);
        const OverlayMode expected = (engine_ok && feedback_ok)
                                         ? OverlayMode::PostInterviewReport
                                         : OverlayMode::LiveCopilot;
        ASSERT_EQ(mode, expected)
            << "trial " << t << " engine_ok=" << engine_ok
            << " feedback_ok=" << feedback_ok;

        // PostInterviewReport is reachable exclusively through double success.
        if (mode == OverlayMode::PostInterviewReport) {
            EXPECT_TRUE(engine_ok && feedback_ok)
                << "trial " << t << ": report without both successes";
        }
    }
}

// Boundary / named cases the requirement calls out explicitly, one per
// acceptance criterion, pinned as deterministic checks.
TEST(JevJoinProps, AllOrNothingNamedCases) {
    // Req 8.3: both calls succeed -> the only path to PostInterviewReport.
    EXPECT_EQ(JevAnalyticsClient::final_mode(true, true),
              OverlayMode::PostInterviewReport);

    // Req 8.1: the engine call fails (engine_ok=false) -> stay LiveCopilot,
    // even though the feedback call succeeded (its partial result is discarded,
    // Req 8.4).
    EXPECT_EQ(JevAnalyticsClient::final_mode(false, true),
              OverlayMode::LiveCopilot);

    // Req 8.2: the feedback call fails (feedback_ok=false) -> stay LiveCopilot,
    // even though the engine call succeeded (its partial result is discarded,
    // Req 8.4).
    EXPECT_EQ(JevAnalyticsClient::final_mode(true, false),
              OverlayMode::LiveCopilot);

    // Both fail -> LiveCopilot (the default fallback).
    EXPECT_EQ(JevAnalyticsClient::final_mode(false, false),
              OverlayMode::LiveCopilot);
}

// ===========================================================================
// Task 8.7 — Property 20: Instant_Feedback normalization (suite JevFeedbackProps).
// ===========================================================================
// JevAnalyticsClient::normalize_feedback(const std::vector<std::string>&) maps
// an arbitrary-length list of feedback lines onto EXACTLY three lines (Req 9.4):
// present lines are kept in order, missing lines are padded with "", and any
// excess beyond three is truncated. The reference oracle below restates that
// contract independently of the implementation so the test genuinely checks
// behaviour rather than mirroring the source.
namespace {

// Independent oracle for normalize_feedback: build exactly three slots, copying
// in[i] for i < min(size, 3) and leaving the rest as "". Written without
// reference to the implementation (no std::min on the array, explicit loop) so
// a divergence between the two is a real signal.
std::array<std::string, 3> expected_normalize(const std::vector<std::string>& in) {
    std::array<std::string, 3> out{"", "", ""};
    for (std::size_t i = 0; i < 3 && i < in.size(); ++i) {
        out[i] = in[i];
    }
    return out;
}

// Random printable-ASCII line, including the empty string, spaces and the bytes
// a line might legitimately carry. Length 0 is allowed so "" lines are part of
// the input space (an empty present line is distinct from a padded slot only in
// position, never in value).
std::string random_line(std::mt19937& rng) {
    static const std::string alphabet =
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 "
        ".,;:!?-()\"\\\n\t";
    std::uniform_int_distribution<int> len_dist(0, 24);
    std::uniform_int_distribution<std::size_t> idx(0, alphabet.size() - 1);
    const int n = len_dist(rng);
    std::string s;
    s.reserve(static_cast<std::size_t>(n));
    for (int i = 0; i < n; ++i) s.push_back(alphabet[idx(rng)]);
    return s;
}

} // namespace

// Property 20: Instant_Feedback normaliza para exatamente 3 linhas preservando
// ordem. For ANY input vector of size k:
//   * the output always has exactly 3 elements (the std::array size);
//   * out[i] == in[i] for every i < min(k, 3)  (present lines, order preserved);
//   * out[i] == "" for every min(k, 3) <= i < 3 (missing lines padded);
//   * lines beyond the third are dropped (truncation).
// Sampled over random vectors of size 0..N with random strings, and matched
// element-by-element against the independent oracle.
//
// **Validates: Requirements 9.4**
TEST(JevFeedbackProps, NormalizesToExactlyThreeLinesPreservingOrder) {
    std::mt19937 rng(0xFEEDBACu);
    // Sizes span below, at, and well above the 3-line target so padding and
    // truncation are both exercised densely.
    std::uniform_int_distribution<std::size_t> size_dist(0, 8);

    constexpr int kTrials = 20000;
    for (int t = 0; t < kTrials; ++t) {
        const std::size_t k = size_dist(rng);
        std::vector<std::string> in;
        in.reserve(k);
        for (std::size_t i = 0; i < k; ++i) in.push_back(random_line(rng));

        const std::array<std::string, 3> out =
            JevAnalyticsClient::normalize_feedback(in);

        // Exactly three elements — guaranteed by the type, asserted for clarity.
        ASSERT_EQ(out.size(), 3u) << "trial " << t;

        const std::size_t keep = std::min<std::size_t>(k, 3);

        // Present lines kept in order.
        for (std::size_t i = 0; i < keep; ++i) {
            EXPECT_EQ(out[i], in[i])
                << "trial " << t << " k=" << k << " index " << i
                << ": present line not preserved in order";
        }
        // Missing lines padded with "".
        for (std::size_t i = keep; i < 3; ++i) {
            EXPECT_EQ(out[i], "")
                << "trial " << t << " k=" << k << " index " << i
                << ": missing slot not padded with empty string";
        }
        // Excess lines (index >= 3) are dropped: nothing in the output ever
        // equals a would-be fourth+ line by position, since the output has no
        // such position. Matched wholesale against the independent oracle.
        EXPECT_EQ(out, expected_normalize(in)) << "trial " << t << " k=" << k;
    }
}

// Boundary cases the property names explicitly: 0, 1, 2, 3, 4 and 5 input
// lines. 0..2 exercise padding, 3 is the exact fit, 4..5 exercise truncation.
// Distinct, recognizable values make an order/truncation regression obvious.
TEST(JevFeedbackProps, NamedLineCountBoundaries) {
    // 0 lines -> three empty slots.
    {
        const auto out = JevAnalyticsClient::normalize_feedback({});
        EXPECT_EQ(out, (std::array<std::string, 3>{"", "", ""}));
    }
    // 1 line -> first slot filled, two padded.
    {
        const auto out = JevAnalyticsClient::normalize_feedback({"L0"});
        EXPECT_EQ(out, (std::array<std::string, 3>{"L0", "", ""}));
    }
    // 2 lines -> first two filled, last padded.
    {
        const auto out = JevAnalyticsClient::normalize_feedback({"L0", "L1"});
        EXPECT_EQ(out, (std::array<std::string, 3>{"L0", "L1", ""}));
    }
    // 3 lines -> exact fit, order preserved, no padding, no truncation.
    {
        const auto out = JevAnalyticsClient::normalize_feedback({"L0", "L1", "L2"});
        EXPECT_EQ(out, (std::array<std::string, 3>{"L0", "L1", "L2"}));
    }
    // 4 lines -> the fourth ("L3") is dropped; first three kept in order.
    {
        const auto out = JevAnalyticsClient::normalize_feedback({"L0", "L1", "L2", "L3"});
        EXPECT_EQ(out, (std::array<std::string, 3>{"L0", "L1", "L2"}));
    }
    // 5 lines -> everything past the third is dropped; order preserved.
    {
        const auto out =
            JevAnalyticsClient::normalize_feedback({"L0", "L1", "L2", "L3", "L4"});
        EXPECT_EQ(out, (std::array<std::string, 3>{"L0", "L1", "L2"}));
    }
    // An empty present line ("") in slot 1 is distinct from a padded slot only
    // by position: with one real line it occupies slot 0 and the pads follow.
    {
        const auto out = JevAnalyticsClient::normalize_feedback({""});
        EXPECT_EQ(out, (std::array<std::string, 3>{"", "", ""}));
    }
}
