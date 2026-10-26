// Property-based tests for the pure endpoint-selection / retry logic of the
// Dual-Path Hot_Path transport (src/net/include/rtai/winhttp_llm_client.hpp):
// choose_endpoint(attempt, opts) and is_retryable(LlmFailure). The project
// ships GoogleTest only (no dedicated PBT runtime), so each property is checked
// by sampling the input space with a seeded std::mt19937 over many trials plus
// the exact boundary cases the requirement names. A fixed seed keeps failures
// reproducible; a reported counterexample can be replayed by hand.
//
// This file is NEW (task 4.4) and owns its own TEST suites so it never collides
// with the shared test_jev_properties.cpp that other tasks extend.

#include <gtest/gtest.h>

#include <array>
#include <cstdint>
#include <random>
#include <string>

#include "rtai/winhttp_llm_client.hpp"

using namespace rtai;

namespace {

// All five LlmFailure values, so a property can quantify over the whole enum
// rather than a hand-picked subset.
constexpr std::array<LlmFailure, 5> kAllFailures = {
    LlmFailure::None,
    LlmFailure::Timeout,
    LlmFailure::Connect,
    LlmFailure::Server5xx,
    LlmFailure::Client4xx,
};

// Independent reference oracle for retryability, written from the requirement
// text (Req 4.2: retryable iff Timeout, Connect, or Server5xx) rather than by
// restating the implementation. A failover happens iff the failure is
// retryable; a Client4xx (and None) must NOT switch providers.
bool oracle_is_retryable(LlmFailure f) {
    switch (f) {
        case LlmFailure::Timeout:
        case LlmFailure::Connect:
        case LlmFailure::Server5xx:
            return true;
        case LlmFailure::None:
        case LlmFailure::Client4xx:
            return false;
    }
    return false;
}

// A distinctive options value so the test confirms choose_endpoint returns the
// caller's actual primary/fallback (by identity and by content), not some
// default-constructed endpoint.
WinHttpLlmOptions make_opts() {
    WinHttpLlmOptions o;
    o.primary = LlmEndpoint{"api.cerebras.ai", "/v1/chat/completions", "qwen-3.8-27b", "pk"};
    o.fallback = LlmEndpoint{"api.groq.com", "/v1/chat/completions", "llama-3.3-70b-versatile", "fk"};
    return o;
}

// Model the failover decision the worker (task 4.2) makes: on a failed attempt
// it retries (advances to the fallback) iff the failure is retryable. The
// resulting endpoint is selected by choose_endpoint for the chosen attempt.
const LlmEndpoint& failover_target(LlmFailure primary_failure, const WinHttpLlmOptions& o) {
    const int next_attempt = is_retryable(primary_failure) ? 1 : 0;
    return choose_endpoint(next_attempt, o);
}

} // namespace

// Property 11 (part A): endpoint selection is attempt-indexed — attempt 0 always
// selects the primary (Cerebras) and any attempt >= 1 selects the fallback
// (Groq). Checked over random attempts spanning 0, 1, and well beyond.
//
// **Validates: Requirements 4.2**
TEST(EndpointSelectionProps, ChooseEndpointIsAttemptIndexed) {
    std::mt19937 rng(0xE4D9011u);
    const WinHttpLlmOptions o = make_opts();

    // attempt 0 is the primary, by identity (same object) and by content.
    EXPECT_EQ(&choose_endpoint(0, o), &o.primary);
    EXPECT_EQ(choose_endpoint(0, o).host, "api.cerebras.ai");
    EXPECT_EQ(choose_endpoint(0, o).model, "qwen-3.8-27b");

    // Any attempt >= 1 is the fallback, by identity and by content.
    std::uniform_int_distribution<int> attempt_dist(1, 1000000);
    constexpr int kTrials = 20000;
    for (int t = 0; t < kTrials; ++t) {
        const int attempt = attempt_dist(rng);
        const LlmEndpoint& chosen = choose_endpoint(attempt, o);
        EXPECT_EQ(&chosen, &o.fallback) << "trial " << t << " attempt=" << attempt;
        EXPECT_EQ(chosen.host, "api.groq.com") << "trial " << t << " attempt=" << attempt;
        EXPECT_EQ(chosen.model, "llama-3.3-70b-versatile")
            << "trial " << t << " attempt=" << attempt;
        // The primary is never reached for a non-zero attempt.
        EXPECT_NE(&chosen, &o.primary) << "trial " << t << " attempt=" << attempt;
    }
}

// Property 11 (part B): is_retryable is true EXACTLY for Timeout, Connect, and
// Server5xx, and false for Client4xx and None. Quantified over the whole enum
// against an independent oracle.
//
// **Validates: Requirements 4.2**
TEST(EndpointSelectionProps, IsRetryableMatchesOracleOverAllFailures) {
    for (LlmFailure f : kAllFailures) {
        EXPECT_EQ(is_retryable(f), oracle_is_retryable(f))
            << "failure value=" << static_cast<int>(f);
    }
}

// Property 11 (part C): the failover decision. Starting on the primary, a
// retryable failure (Timeout/Connect/Server5xx) advances to the fallback
// (Groq); a Client4xx failure does NOT switch providers (stays on the primary,
// Cerebras), and neither does None. Verified over all LlmFailure values with a
// random (but unused-for-the-decision) attempt noise channel to confirm the
// decision depends only on the failure class.
//
// **Validates: Requirements 4.2**
TEST(EndpointSelectionProps, FailoverSwitchesProviderIffRetryable) {
    std::mt19937 rng(0xFA1105Eu);
    const WinHttpLlmOptions o = make_opts();

    constexpr int kTrials = 20000;
    for (int t = 0; t < kTrials; ++t) {
        const LlmFailure f = kAllFailures[rng() % kAllFailures.size()];
        const LlmEndpoint& target = failover_target(f, o);

        if (oracle_is_retryable(f)) {
            // Retryable -> fail over to the Groq fallback.
            EXPECT_EQ(&target, &o.fallback)
                << "trial " << t << " failure=" << static_cast<int>(f);
            EXPECT_EQ(target.host, "api.groq.com")
                << "trial " << t << " failure=" << static_cast<int>(f);
        } else {
            // Not retryable (Client4xx / None) -> stay on the Cerebras primary,
            // no provider switch.
            EXPECT_EQ(&target, &o.primary)
                << "trial " << t << " failure=" << static_cast<int>(f);
            EXPECT_EQ(target.host, "api.cerebras.ai")
                << "trial " << t << " failure=" << static_cast<int>(f);
        }
    }
}

// Boundary cases the requirement names explicitly: the attempt boundary (0 vs
// 1) and each individual failure class driving the failover decision.
//
// **Validates: Requirements 4.2**
TEST(EndpointSelectionProps, NamedBoundaryCases) {
    const WinHttpLlmOptions o = make_opts();

    // Attempt boundary: 0 -> primary, 1 -> fallback.
    EXPECT_EQ(choose_endpoint(0, o).host, "api.cerebras.ai");
    EXPECT_EQ(choose_endpoint(1, o).host, "api.groq.com");

    // Retryable classes each fail over to Groq.
    EXPECT_TRUE(is_retryable(LlmFailure::Timeout));
    EXPECT_TRUE(is_retryable(LlmFailure::Connect));
    EXPECT_TRUE(is_retryable(LlmFailure::Server5xx));
    EXPECT_EQ(&failover_target(LlmFailure::Timeout, o), &o.fallback);
    EXPECT_EQ(&failover_target(LlmFailure::Connect, o), &o.fallback);
    EXPECT_EQ(&failover_target(LlmFailure::Server5xx, o), &o.fallback);

    // A 4xx is NOT retryable: it surfaces the error and keeps Cerebras (no
    // provider switch). None is likewise non-retryable.
    EXPECT_FALSE(is_retryable(LlmFailure::Client4xx));
    EXPECT_FALSE(is_retryable(LlmFailure::None));
    EXPECT_EQ(&failover_target(LlmFailure::Client4xx, o), &o.primary);
    EXPECT_EQ(&failover_target(LlmFailure::None, o), &o.primary);
}

// ===========================================================================
// Property 12 (task 4.5): keep-alive timing for the Dual-Path Hot_Path
// transport. should_ping(now_ms, last_ping_ms, interval_ms) is the pure clock
// predicate behind the 25 s Keep_Alive_Ping (Req 4.5): a ping is due iff at
// least `interval_ms` has elapsed since the last ping, i.e. true iff
// now - last >= interval. These properties live in their own KeepAliveProps
// suite so they sit beside the related pure-transport selection tests above
// without colliding with any other suite's names.
// ===========================================================================

namespace {

// Independent reference oracle for the keep-alive predicate, written straight
// from the requirement text (Req 4.5: due iff now - last >= interval) rather
// than by restating should_ping's body, so the property is a genuine check and
// not a tautology. Uses a widened signed type for the subtraction to reason
// about the result without worrying about int64 overflow in the test itself.
bool oracle_should_ping(std::int64_t now_ms, std::int64_t last_ping_ms, int interval_ms) {
    return (now_ms - last_ping_ms) >= static_cast<std::int64_t>(interval_ms);
}

// The production keep-alive interval the worker arms (keep_alive_ms default).
constexpr int kKeepAliveMs = 25000;

} // namespace

// Property 12 (part A): should_ping agrees with the independent oracle across a
// randomized space of (now, last, interval) triples, including now < last
// (clock that appears to go backwards) which must never report a ping due.
//
// **Validates: Requirements 4.5**
TEST(KeepAliveProps, ShouldPingMatchesOracleOverRandomTriples) {
    std::mt19937 rng(0x25A11E0u);
    // `last` spans a wide absolute range; `now` is drawn as last + a signed
    // delta that straddles the interval boundary in both directions (and goes
    // negative), so the >= comparison is exercised just below, at, and above
    // the threshold as well as for a backwards clock.
    std::uniform_int_distribution<std::int64_t> last_dist(0, 5'000'000'000LL);
    std::uniform_int_distribution<std::int64_t> delta_dist(-60000, 60000);
    std::uniform_int_distribution<int> interval_dist(1, 60000);

    constexpr int kTrials = 50000;
    for (int t = 0; t < kTrials; ++t) {
        const std::int64_t last = last_dist(rng);
        const std::int64_t now = last + delta_dist(rng);
        const int interval = interval_dist(rng);

        EXPECT_EQ(should_ping(now, last, interval),
                  oracle_should_ping(now, last, interval))
            << "trial " << t << " now=" << now << " last=" << last
            << " interval=" << interval;
    }
}

// Property 12 (part B): with the production interval of 25 s, should_ping is
// exactly a step at the 25000 ms boundary — false for every elapsed time below
// 25000, true at 25000 and everything above. Sampled densely around the edge.
//
// **Validates: Requirements 4.5**
TEST(KeepAliveProps, TwentyFiveSecondIntervalIsAnExactStepAtBoundary) {
    std::mt19937 rng(0x2500ED9u);
    // Anchor `last` anywhere so the predicate is confirmed to depend only on
    // the elapsed difference, not on the absolute clock value.
    std::uniform_int_distribution<std::int64_t> last_dist(0, 5'000'000'000LL);
    // Elapsed times concentrated around the 25000 ms edge, plus the full span.
    std::uniform_int_distribution<std::int64_t> elapsed_dist(24000, 26000);

    constexpr int kTrials = 50000;
    for (int t = 0; t < kTrials; ++t) {
        const std::int64_t last = last_dist(rng);
        const std::int64_t elapsed = elapsed_dist(rng);
        const std::int64_t now = last + elapsed;

        const bool expected = elapsed >= kKeepAliveMs;
        EXPECT_EQ(should_ping(now, last, kKeepAliveMs), expected)
            << "trial " << t << " elapsed=" << elapsed << " last=" << last;
    }
}

// Property 12 (part C): a simulated session timeline. Advance a clock in
// arbitrary steps and fire a ping (resetting last_ping) whenever should_ping is
// true at the 25 s interval. Every gap between consecutive fired pings is
// >= 25000 ms, and whenever a ping is NOT fired the elapsed time since the last
// ping is strictly < 25000 ms — so pings are spaced at least 25 s apart and the
// predicate never skips a due ping.
//
// **Validates: Requirements 4.5**
TEST(KeepAliveProps, SimulatedTimelineSpacesPingsAtLeast25Seconds) {
    std::mt19937 rng(0x7147E11u);
    // Step sizes mix small sub-interval advances (so many checks fall below the
    // threshold) with large jumps (so a single step can cross multiple
    // intervals), exercising both the "not yet due" and "overdue" paths.
    std::uniform_int_distribution<int> small_step(0, 8000);
    std::uniform_int_distribution<int> big_step(0, 90000);
    std::bernoulli_distribution take_big(0.25);
    std::uniform_int_distribution<int> ticks_dist(1, 200);

    constexpr int kTimelines = 2000;
    for (int s = 0; s < kTimelines; ++s) {
        std::int64_t now = std::uniform_int_distribution<std::int64_t>(0, 1'000'000)(rng);
        std::int64_t last_ping = now; // session starts with a ping just sent
        std::int64_t prev_fire = now; // clock value of the previous fired ping

        const int ticks = ticks_dist(rng);
        for (int i = 0; i < ticks; ++i) {
            now += take_big(rng) ? big_step(rng) : small_step(rng);

            if (should_ping(now, last_ping, kKeepAliveMs)) {
                // The predicate only fires once the full interval has elapsed.
                EXPECT_GE(now - last_ping, kKeepAliveMs)
                    << "timeline " << s << " tick " << i;
                // Consecutive fired pings are spaced at least 25 s apart.
                EXPECT_GE(now - prev_fire, kKeepAliveMs)
                    << "timeline " << s << " tick " << i;
                prev_fire = now;
                last_ping = now; // ping sent -> reset the keep-alive clock
            } else {
                // Not firing is only correct while strictly under the interval.
                EXPECT_LT(now - last_ping, kKeepAliveMs)
                    << "timeline " << s << " tick " << i;
            }
        }
    }
}

// Boundary cases the requirement names explicitly: the exact 25000 ms edge
// (true), one millisecond short at 24999 (false), one past at 25001 (true),
// plus a zero-elapsed and a backwards-clock degenerate case.
//
// **Validates: Requirements 4.5**
TEST(KeepAliveProps, NamedBoundaryCases) {
    // Exactly at the interval: a ping is due (>= is inclusive).
    EXPECT_TRUE(should_ping(25000, 0, kKeepAliveMs));
    // One millisecond short: not yet due.
    EXPECT_FALSE(should_ping(24999, 0, kKeepAliveMs));
    // One millisecond past: due.
    EXPECT_TRUE(should_ping(25001, 0, kKeepAliveMs));

    // The boundary holds at an arbitrary, non-zero last_ping anchor too.
    EXPECT_TRUE(should_ping(1'000'000 + 25000, 1'000'000, kKeepAliveMs));
    EXPECT_FALSE(should_ping(1'000'000 + 24999, 1'000'000, kKeepAliveMs));
    EXPECT_TRUE(should_ping(1'000'000 + 25001, 1'000'000, kKeepAliveMs));

    // No time elapsed: never due.
    EXPECT_FALSE(should_ping(5000, 5000, kKeepAliveMs));
    // Backwards clock (now < last): never due.
    EXPECT_FALSE(should_ping(0, 25000, kKeepAliveMs));
}
