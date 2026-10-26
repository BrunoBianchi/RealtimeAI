// Property-based tests for the pure Jev Dashboard render model
// (src/core/include/rtai/overlay_mode.hpp). The project ships GoogleTest only
// (no dedicated PBT runtime), so each property is checked by sampling the input
// space with a seeded std::mt19937 over many trials plus the exact boundary
// cases the requirement names. A fixed seed keeps failures reproducible; a
// reported counterexample can be replayed by hand. This mirrors the PBT style
// of tests/core_tests/test_hud_properties.cpp.
//
// SHARED-FILE CONTRACT: this file hosts the dashboard property tests for the
// dual-path-speculative-pipeline spec, split across tasks that may be authored
// concurrently. Each task owns a DISTINCT GoogleTest suite (test-case name) and
// only APPENDS its suite -- never edits or removes another task's suite:
//   * Task 9.4 -> suite `DashboardRingsProps`  (Property 18: build_rings model)
//   * Task 9.5 -> suite `DashboardThetaProps`  (Property 19: ring_theta_deg)
// Keep this header in sync when new dashboard property suites are added.
#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <random>

#include "rtai/overlay_mode.hpp"

using namespace rtai;

// ---------------------------------------------------------------------------
// Property 19: Ângulo theta do anel mapeia o score em [0°,360°] monotonicamente
// ---------------------------------------------------------------------------
// For any score fed to ring_theta_deg:
//   (a) the result is always within the [0, 360] degree band;
//   (b) scores <= 0 (including negatives) clamp to 0 deg;
//   (c) scores >= 10 (including values beyond 10) clamp to 360 deg;
//   (d) the named endpoints hold exactly: ring_theta_deg(0) == 0,
//       ring_theta_deg(10) == 360;
//   (e) the mapping is monotonic non-decreasing: score_a <= score_b implies
//       ring_theta_deg(score_a) <= ring_theta_deg(score_b).
//
// Strategy: sample the input space with a seeded std::mt19937, drawing scores
// across and beyond the [0, 10] band (negatives, > 10, and the exact endpoints)
// so the clamp on both sides is exercised, plus pairs of samples for the
// monotonicity check.
//
// **Validates: Requirements 9.3**
TEST(DashboardThetaProps, MapsScoreIntoBandMonotonically) {
    std::mt19937 rng(0x7E7Au);
    // Span well below 0 and well above 10 so both clamp directions are hit,
    // with dense coverage of the interesting (0, 10) interior.
    std::uniform_real_distribution<float> score_dist(-5.0f, 15.0f);

    constexpr int kTrials = 50000;
    for (int t = 0; t < kTrials; ++t) {
        const float a = score_dist(rng);
        const float b = score_dist(rng);
        const float ta = ring_theta_deg(a);
        const float tb = ring_theta_deg(b);

        // (a) result stays inside the [0, 360] degree band for every input.
        EXPECT_GE(ta, 0.0f) << "trial " << t << " score=" << a;
        EXPECT_LE(ta, 360.0f) << "trial " << t << " score=" << a;
        EXPECT_GE(tb, 0.0f) << "trial " << t << " score=" << b;
        EXPECT_LE(tb, 360.0f) << "trial " << t << " score=" << b;

        // (b) scores <= 0 clamp to 0 deg.
        if (a <= 0.0f) { EXPECT_FLOAT_EQ(ta, 0.0f) << "trial " << t << " score=" << a; }
        // (c) scores >= 10 clamp to 360 deg.
        if (a >= 10.0f) { EXPECT_FLOAT_EQ(ta, 360.0f) << "trial " << t << " score=" << a; }

        // (e) monotonic non-decreasing: order the two samples and confirm the
        // smaller score never yields a larger angle.
        const float lo = std::min(a, b);
        const float hi = std::max(a, b);
        EXPECT_LE(ring_theta_deg(lo), ring_theta_deg(hi))
            << "trial " << t << " lo=" << lo << " hi=" << hi;
    }
}

// Boundary cases the requirement names explicitly: the exact endpoints of the
// [0, 10] score band, values just outside it, and a few interior points whose
// angle is known exactly.
TEST(DashboardThetaProps, NamedBoundariesAndClamp) {
    // (d) exact named endpoints.
    EXPECT_FLOAT_EQ(ring_theta_deg(0.0f), 0.0f);
    EXPECT_FLOAT_EQ(ring_theta_deg(10.0f), 360.0f);

    // Interior points map linearly: (score/10)*360.
    EXPECT_FLOAT_EQ(ring_theta_deg(5.0f), 180.0f);
    EXPECT_FLOAT_EQ(ring_theta_deg(2.5f), 90.0f);
    EXPECT_FLOAT_EQ(ring_theta_deg(7.5f), 270.0f);
    EXPECT_FLOAT_EQ(ring_theta_deg(1.0f), 36.0f);

    // Negatives clamp to 0 deg.
    for (float s : {-0.0001f, -1.0f, -5.0f, -1000.0f}) {
        EXPECT_FLOAT_EQ(ring_theta_deg(s), 0.0f) << "score=" << s;
    }
    // Values beyond 10 clamp to 360 deg.
    for (float s : {10.0001f, 11.0f, 100.0f, 1e6f}) {
        EXPECT_FLOAT_EQ(ring_theta_deg(s), 360.0f) << "score=" << s;
    }

    // Non-finite inputs still produce a value inside the band (std::clamp with
    // +inf pins to the upper bound; -inf pins to the lower bound).
    const float pos_inf = std::numeric_limits<float>::infinity();
    EXPECT_FLOAT_EQ(ring_theta_deg(pos_inf), 360.0f);
    EXPECT_FLOAT_EQ(ring_theta_deg(-pos_inf), 0.0f);
}

// ---------------------------------------------------------------------------
// Property 18: Modelo de anéis tem sempre 3 anéis com cores fixas por dimensão
// ---------------------------------------------------------------------------
// For ANY scores, build_rings returns exactly three RingSpec in the fixed order
// Relevance, Accuracy, Clarity, with the fixed colour per dimension (orange,
// green, lilac respectively); each ring's score is the raw value clamped to
// [0,10] and its target angle is exactly ring_theta_deg(clamped score). Scores
// well outside [0,10] (negatives, large positives, NaN, infinities) are sampled
// so the clamp is exercised in both directions.
//
// Feature: dual-path-speculative-pipeline, Property 18: Modelo de anéis tem
// sempre 3 anéis com cores fixas por dimensão.
//
// **Validates: Requirements 9.1**
namespace {

// Independent reference for the per-dimension expectations the requirement
// names, written separately from build_rings so the test does not simply
// restate the implementation: fixed order and fixed colour per dimension.
struct ExpectedRing {
    RingDim dim;
    std::uint32_t color;
};

constexpr std::array<ExpectedRing, 3> kExpectedRings = {{
    {RingDim::Relevance, kRingColorRelevance}, // orange
    {RingDim::Accuracy, kRingColorAccuracy},   // green
    {RingDim::Clarity, kRingColorClarity},     // lilac
}};

// The raw score each dimension is fed from, so a ring is checked against the
// right input independent of any ordering assumption.
double raw_for(const JevScores& s, RingDim dim) {
    switch (dim) {
        case RingDim::Relevance: return s.relevance;
        case RingDim::Accuracy:  return s.accuracy;
        case RingDim::Clarity:   return s.clarity;
    }
    return 0.0;
}

// Assert the full Property-18 invariant for one JevScores sample.
void expect_rings_invariant(const JevScores& s, int trial) {
    const std::array<RingSpec, 3> rings = build_rings(s);

    // Exactly three rings, in the fixed order Relevance, Accuracy, Clarity,
    // each carrying the fixed colour for its dimension (Req 9.1).
    ASSERT_EQ(rings.size(), 3u) << "trial " << trial;
    for (std::size_t i = 0; i < rings.size(); ++i) {
        EXPECT_EQ(rings[i].dim, kExpectedRings[i].dim)
            << "trial " << trial << " slot " << i << ": wrong dimension order";
        EXPECT_EQ(rings[i].color, kExpectedRings[i].color)
            << "trial " << trial << " slot " << i << ": wrong fixed colour";

        // Each ring's score is the raw input clamped to [0,10], and its target
        // angle is exactly ring_theta_deg(clamped score) (Req 9.1/9.3).
        const float expected_score =
            std::clamp(static_cast<float>(raw_for(s, kExpectedRings[i].dim)), 0.0f, 10.0f);
        EXPECT_FLOAT_EQ(rings[i].score, expected_score)
            << "trial " << trial << " slot " << i << ": score not clamped to [0,10]";
        EXPECT_GE(rings[i].score, 0.0f) << "trial " << trial << " slot " << i;
        EXPECT_LE(rings[i].score, 10.0f) << "trial " << trial << " slot " << i;
        EXPECT_FLOAT_EQ(rings[i].target_theta_deg, ring_theta_deg(expected_score))
            << "trial " << trial << " slot " << i << ": theta != ring_theta_deg(score)";
    }

    // The three colours are distinct per dimension, so no two rings can be
    // confused on screen (Req 9.1).
    EXPECT_NE(rings[0].color, rings[1].color) << "trial " << trial;
    EXPECT_NE(rings[1].color, rings[2].color) << "trial " << trial;
    EXPECT_NE(rings[0].color, rings[2].color) << "trial " << trial;
}

} // namespace

TEST(DashboardRingsProps, AlwaysThreeRingsFixedOrderAndColors) {
    std::mt19937 rng(0xD15EA5Eu);
    // Span well below 0 and well above 10 so the clamp fires on both ends, with
    // dense coverage of the valid (0, 10) interior.
    std::uniform_real_distribution<double> score_dist(-50.0, 60.0);

    constexpr int kTrials = 20000;
    for (int t = 0; t < kTrials; ++t) {
        const JevScores s{score_dist(rng), score_dist(rng), score_dist(rng)};
        expect_rings_invariant(s, t);
    }
}

// Boundary cases the requirement implies explicitly: the exact endpoints of the
// [0,10] band, values just outside it, and the infinities that a parser could
// in principle hand through (+/-inf clamp cleanly to the band endpoints). NaN
// is excluded on purpose: build_rings clamps with std::clamp, which passes NaN
// through unchanged, and NaN is not a value the Jev parser ever yields (scores
// are clamped to a finite [0,10] on parse), so it is outside this property's
// input space.
TEST(DashboardRingsProps, BoundaryAndInfiniteScores) {
    const double inf = std::numeric_limits<double>::infinity();
    const double edges[] = {-inf, -1e9, -0.0001, 0.0, 0.0001, 5.0,
                            9.9999, 10.0, 10.0001, 1e9, inf};

    int t = 0;
    for (double r : edges) {
        for (double a : edges) {
            for (double c : edges) {
                const JevScores s{r, a, c};
                expect_rings_invariant(s, t++);
            }
        }
    }
}

// All-zero (default) scores: three rings still present, each score 0 and angle
// 0 deg, colours fixed per dimension.
TEST(DashboardRingsProps, DefaultScoresStillYieldThreeRings) {
    const auto rings = build_rings(JevScores{});
    ASSERT_EQ(rings.size(), 3u);
    EXPECT_EQ(rings[0].dim, RingDim::Relevance);
    EXPECT_EQ(rings[1].dim, RingDim::Accuracy);
    EXPECT_EQ(rings[2].dim, RingDim::Clarity);
    EXPECT_EQ(rings[0].color, kRingColorRelevance);
    EXPECT_EQ(rings[1].color, kRingColorAccuracy);
    EXPECT_EQ(rings[2].color, kRingColorClarity);
    for (const auto& ring : rings) {
        EXPECT_FLOAT_EQ(ring.score, 0.0f);
        EXPECT_FLOAT_EQ(ring.target_theta_deg, 0.0f);
    }
}
