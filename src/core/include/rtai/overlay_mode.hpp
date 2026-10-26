// Pure core: platform-independent models for the two overlay modes and the
// post-interview Jev Dashboard, kept here so they are unit-tested on any OS
// (no <windows.h>, no Direct2D):
//   * OverlayMode   - LiveCopilot (streaming suggestions) vs the post-interview
//                     report. The transition is driven by OverlayModeEvent
//                     (see copilot_events.hpp), published only on the Cold_Path
//                     double-success.
//   * JevScores / JevReport - the all-or-nothing result of the Cold_Path: three
//                     0..10 scores plus the three Instant_Feedback lines. The
//                     net JevAnalyticsClient fills these in; defining them here
//                     keeps rtai_core free of any net dependency while letting
//                     OverlayModeEvent carry the report.
//   * RingDim / RingSpec / build_rings / ring_theta_deg - the pure render model
//                     for the three Score_Rings: always exactly three rings in a
//                     fixed order with a fixed colour per dimension, and the
//                     target sweep angle in [0 deg, 360 deg].
#pragma once

#include <algorithm>
#include <array>
#include <cstdint>
#include <string>

namespace rtai {

// Two overlay modes (Req 9.1). LiveCopilot is the default streaming HUD; the
// overlay only switches to PostInterviewReport when the Cold_Path succeeds on
// both of its parallel calls.
enum class OverlayMode : std::uint8_t { LiveCopilot, PostInterviewReport };

// Cold_Path scores, each on a 0..10 scale (Req 7.3). Produced by the Jev Engine
// API and clamped on parse.
struct JevScores {
    double relevance{0.0};
    double accuracy{0.0};
    double clarity{0.0};
};

// Full post-interview report: the three scores plus the Instant_Feedback block,
// normalized to exactly three lines (Req 9.4).
struct JevReport {
    JevScores scores;
    std::array<std::string, 3> feedback_lines;
};

// The three dashboard dimensions, in fixed display order (Req 9.1).
enum class RingDim : std::uint8_t { Relevance, Accuracy, Clarity };

// Fixed colour per dimension as 0xRRGGBB (Req 9.1):
//   Relevance -> orange, Accuracy -> green, Clarity -> lilac.
constexpr std::uint32_t kRingColorRelevance = 0xFF9500u; // orange
constexpr std::uint32_t kRingColorAccuracy  = 0x34C759u; // green
constexpr std::uint32_t kRingColorClarity   = 0xBF5AF2u; // lilac

// Render spec for one Score_Ring.
struct RingSpec {
    RingDim dim{RingDim::Relevance};
    float score{0.0f};            // 0..10 (clamped)
    std::uint32_t color{0u};      // fixed per dimension (Req 9.1)
    float target_theta_deg{0.0f}; // (score/10)*360, in [0 deg, 360 deg] (Req 9.3)
};

// Target sweep angle for a score, clamped to [0 deg, 360 deg] (Req 9.3):
// 0 -> 0 deg, 10 -> 360 deg, monotone in between. Scores outside [0,10] clamp
// to the endpoints.
[[nodiscard]] inline float ring_theta_deg(float score) noexcept {
    const float c = std::clamp(score, 0.0f, 10.0f);
    return (c / 10.0f) * 360.0f;
}

// Build the three rings in fixed order (Relevance, Accuracy, Clarity) with the
// fixed colour per dimension (Req 9.1). Always returns exactly three rings; each
// score is clamped to [0,10] and its target angle precomputed (Req 9.3).
[[nodiscard]] inline std::array<RingSpec, 3> build_rings(const JevScores& s) {
    const auto spec = [](RingDim dim, double raw, std::uint32_t color) {
        const float score = std::clamp(static_cast<float>(raw), 0.0f, 10.0f);
        return RingSpec{dim, score, color, ring_theta_deg(score)};
    };
    return {
        spec(RingDim::Relevance, s.relevance, kRingColorRelevance),
        spec(RingDim::Accuracy, s.accuracy, kRingColorAccuracy),
        spec(RingDim::Clarity, s.clarity, kRingColorClarity),
    };
}

} // namespace rtai
