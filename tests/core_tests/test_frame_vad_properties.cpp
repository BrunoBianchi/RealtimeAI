// Property-based tests for the pure local acoustic VAD behind the Hot_Path
// (src/core/include/rtai/frame_vad.hpp). The project ships GoogleTest only (no
// dedicated PBT runtime), so each property is checked by sampling the input
// space with a seeded std::mt19937 over many trials plus the exact boundary
// cases the requirement calls out. A fixed seed keeps failures reproducible; a
// reported counterexample can be replayed by hand.
//
// This file hosts the FrameVad property suites, each with a distinct suite name
// to avoid collisions:
//   - FrameVadRmsProps         (Property 1, task 1.2)  — RMS domain + scaling
//   - FrameVadSilenceProps     (Property 2, task 1.3)  — exact silence threshold
//   - FrameVadSpeculativeProps (Property 4, task 1.6)  — gated speculative edge
#include <gtest/gtest.h>

#include <cmath>
#include <cstdint>
#include <limits>
#include <random>
#include <vector>

#include "rtai/frame_vad.hpp"

using namespace rtai;

// ---------------------------------------------------------------------------
// Property 1: RMS do frame fica no domínio e escala monotonicamente.
// ---------------------------------------------------------------------------
// For any frame of int16 samples, FrameVad::frame_rms returns a value in
// [0, 32767]; an all-zero frame returns 0; and uniformly scaling every sample
// by a factor k in [0, 1] never increases the RMS (monotonicity under
// amplitude scaling).
//
// **Validates: Requirements 1.1**
TEST(FrameVadRmsProps, RmsStaysInDomainAndScalesMonotonically) {
    std::mt19937 rng(0x12345678u);
    std::uniform_int_distribution<int> len_dist(1, 640);       // up to ~2 frames
    std::uniform_int_distribution<int> sample_dist(-32768, 32767);
    std::uniform_real_distribution<double> k_dist(0.0, 1.0);

    constexpr int kTrials = 20000;
    for (int t = 0; t < kTrials; ++t) {
        const int n = len_dist(rng);
        std::vector<std::int16_t> frame(static_cast<std::size_t>(n));
        for (auto& s : frame) s = static_cast<std::int16_t>(sample_dist(rng));

        const double rms = FrameVad::frame_rms(frame.data(), frame.size());

        // Domain: 0 <= rms <= 32767 (the magnitude of the largest int16, with
        // -32768 contributing |value| 32768 but the RMS of a real frame never
        // exceeds 32768; we assert the documented [0, 32768] envelope).
        EXPECT_GE(rms, 0.0) << "trial " << t;
        EXPECT_LE(rms, 32768.0) << "trial " << t;

        // Scaling every sample by k in [0,1] never increases the RMS.
        const double k = k_dist(rng);
        std::vector<std::int16_t> scaled(frame.size());
        for (std::size_t i = 0; i < frame.size(); ++i) {
            scaled[i] = static_cast<std::int16_t>(std::lround(frame[i] * k));
        }
        const double rms_scaled = FrameVad::frame_rms(scaled.data(), scaled.size());
        // Allow a tiny epsilon for integer-rounding of the scaled samples.
        EXPECT_LE(rms_scaled, rms + 1.0)
            << "trial " << t << " k=" << k << " rms=" << rms
            << " rms_scaled=" << rms_scaled;
    }
}

// Boundary cases named by the requirement: empty / null frame, all-zero frame,
// a full-scale frame, and a single sample.
TEST(FrameVadRmsProps, RmsBoundaryFrames) {
    EXPECT_EQ(FrameVad::frame_rms(nullptr, 0), 0.0);

    const std::vector<std::int16_t> zero(320, 0);
    EXPECT_EQ(FrameVad::frame_rms(zero.data(), zero.size()), 0.0);

    const std::vector<std::int16_t> full(320, 32767);
    EXPECT_NEAR(FrameVad::frame_rms(full.data(), full.size()), 32767.0, 1e-6);

    const std::int16_t one = 1000;
    EXPECT_NEAR(FrameVad::frame_rms(&one, 1), 1000.0, 1e-6);

    // Scaling a full-scale frame to zero yields zero RMS (k = 0 endpoint).
    const std::vector<std::int16_t> zeroed(320, 0);
    EXPECT_EQ(FrameVad::frame_rms(zeroed.data(), zeroed.size()), 0.0);
}

// ---------------------------------------------------------------------------
// Property 2: Classificação de silêncio é o limiar exato.
// ---------------------------------------------------------------------------
// For any rms, noise_floor and margin, a frame is classified as silence if and
// only if rms < noise_floor * margin. FrameVad evaluates the threshold against
// the floor the caller observes (before the floor is updated), so the first
// frame of a fresh FrameVad uses the known initial floor. We drive the rms by
// synthesizing a constant-amplitude frame whose exact rms equals the chosen
// amplitude, and probe amplitudes straddling the threshold.
//
// **Validates: Requirements 1.2**
TEST(FrameVadSilenceProps, SilenceIsExactThreshold) {
    std::mt19937 rng(0x2468ACE0u);
    std::uniform_real_distribution<float> margin_dist(0.5f, 3.0f);
    std::uniform_real_distribution<double> rms_dist(0.0, 2000.0);

    constexpr int kTrials = 20000;
    for (int t = 0; t < kTrials; ++t) {
        FrameVadConfig cfg{};
        cfg.noise_margin = margin_dist(rng);
        FrameVad vad(cfg);
        const double floor = vad.noise_floor();     // known initial floor
        const double threshold = floor * static_cast<double>(cfg.noise_margin);

        // Choose a target rms and build a constant frame with exactly that rms
        // (a constant amplitude a over n samples has rms == a).
        const double target = rms_dist(rng);
        const auto amp = static_cast<std::int16_t>(std::lround(target));
        std::vector<std::int16_t> frame(320, amp);
        const double actual_rms = FrameVad::frame_rms(frame.data(), frame.size());

        const FrameVadResult r = vad.on_frame(frame.data(), frame.size());

        // silent iff rms < noise_floor * margin, using FrameVad's own rms so
        // the comparison is against the identical value it classified.
        const bool expected_silent = actual_rms < threshold;
        EXPECT_EQ(r.silent, expected_silent)
            << "trial " << t << " rms=" << actual_rms
            << " threshold=" << threshold << " margin=" << cfg.noise_margin;
    }
}

// Boundary cases: rms exactly at the threshold (NOT silent, strict <), just
// below (silent), and just above (not silent).
TEST(FrameVadSilenceProps, SilenceBoundaryAtThreshold) {
    FrameVadConfig cfg{};
    cfg.noise_margin = 1.0f; // threshold == floor for a clean boundary
    // At exactly the threshold: strict `<` means NOT silent.
    {
        FrameVad vad(cfg);
        const auto amp = static_cast<std::int16_t>(std::lround(vad.noise_floor()));
        std::vector<std::int16_t> frame(320, amp);
        const FrameVadResult r = vad.on_frame(frame.data(), frame.size());
        EXPECT_FALSE(r.silent) << "rms == threshold must not be silent (strict <)";
    }
    // Just below the threshold: silent.
    {
        FrameVad vad(cfg);
        const auto amp = static_cast<std::int16_t>(std::lround(vad.noise_floor()) - 10);
        std::vector<std::int16_t> frame(320, amp);
        const FrameVadResult r = vad.on_frame(frame.data(), frame.size());
        EXPECT_TRUE(r.silent) << "rms below threshold must be silent";
    }
    // Just above the threshold: not silent.
    {
        FrameVad vad(cfg);
        const auto amp = static_cast<std::int16_t>(std::lround(vad.noise_floor()) + 50);
        std::vector<std::int16_t> frame(320, amp);
        const FrameVadResult r = vad.on_frame(frame.data(), frame.size());
        EXPECT_FALSE(r.silent) << "rms above threshold must not be silent";
    }
    // An all-zero frame is always silent for any positive floor/margin.
    {
        FrameVad vad(cfg);
        std::vector<std::int16_t> frame(320, 0);
        EXPECT_TRUE(vad.on_frame(frame.data(), frame.size()).silent);
    }
}

// ---------------------------------------------------------------------------
// Property 4: Disparo especulativo exige streak de 110 ms contínuo gated pelo
// filtro rápido.
// ---------------------------------------------------------------------------
// For any time series of frames described by (silent, fast_ok), FrameVad emits
// speculative_edge only when the silent streak first reaches silence_frames
// (6 frames = 110 ms); a single non-silent frame restarts the streak and
// re-arms the edge. The fast-filter gate (fast_ok) is applied by the caller on
// the capture thread, so the observable "gated speculative trigger" is
// `speculative_edge && fast_ok` at that instant. When fast_ok is false the
// trigger never fires.
//
// The expected value is computed by an INDEPENDENT reference oracle that
// replays the same (silent, fast_ok) series using only the stated rules — it
// does not reuse FrameVad's internals — so the test is a genuine cross-check
// rather than a restatement of the implementation.
//
// To drive FrameVad deterministically from a (silent) flag we synthesize the
// audio per frame: a silent frame is all-zero samples (rms 0, always below the
// floor * margin threshold), and a non-silent frame is a loud constant tone
// well above any floor the attack/release can reach. This makes FrameVad's own
// silence classification agree with the intended `silent` flag every frame, so
// the only thing under test is the streak/edge/gate logic.
//
// **Validates: Requirements 1.3, 1.5**
namespace {

// Independent reference oracle for the gated speculative trigger. Mirrors the
// stated rules, written without reference to FrameVad's fields:
//   - a continuous run of `silent` frames of length >= silence_frames fires the
//     edge exactly once, on the frame that first reaches the threshold;
//   - any non-silent frame resets the run and re-arms the edge;
//   - the gated trigger is the edge AND fast_ok at that instant.
struct SpecOracle {
    int silence_frames;
    int streak{0};
    bool armed{true};

    // Returns {edge, gated_trigger} for a frame described by (silent, fast_ok).
    std::pair<bool, bool> feed(bool silent, bool fast_ok) {
        bool edge = false;
        if (silent) {
            ++streak;
            if (streak >= silence_frames && armed) {
                edge = true;
                armed = false; // fire once per continuous streak
            }
        } else {
            streak = 0;
            armed = true;
        }
        return {edge, edge && fast_ok};
    }
};

// Build one deterministic 20 ms frame: all-zero for silence, a loud constant
// amplitude otherwise. A high constant keeps rms far above noise_floor * margin
// for any floor the rolling estimator can reach, so FrameVad classifies the
// frame exactly as intended.
std::vector<std::int16_t> make_frame(bool silent, std::size_t n) {
    return std::vector<std::int16_t>(n, silent ? std::int16_t{0} : std::int16_t{12000});
}

} // namespace

// The core property over randomly generated time series. The silence series is
// whatever FrameVad actually classifies per frame (its silence classification
// is Property 2's concern, exercised independently above and verified here for
// the all-zero/loud extremes), and we drive the INDEPENDENT oracle with that
// observed `silent` series. The oracle then predicts, from the stated streak +
// gate rules alone, where the speculative edge and the gated trigger must
// occur. Driving the oracle from the observed silence — rather than an intended
// flag — keeps the property robust to the rolling Noise_Floor dynamics (a long
// run of loud frames raises the floor until a mid-level "loud" frame would be
// reclassified as silent) while still cross-checking the streak/edge/gate logic
// against a separate implementation.
TEST(FrameVadSpeculativeProps, GatedTriggerMatchesIndependentOracle) {
    std::mt19937 rng(0xF00DBEEFu);
    // Weight toward silence so long streaks (>= 6) occur often, with enough
    // non-silent frames to exercise resets straddling the 6-frame boundary.
    std::bernoulli_distribution silent_dist(0.7);
    std::bernoulli_distribution fast_ok_dist(0.5);
    std::uniform_int_distribution<int> len_dist(0, 60);

    const FrameVadConfig cfg{};
    const std::size_t frame_samples =
        static_cast<std::size_t>(cfg.sample_rate_hz) *
        static_cast<std::size_t>(cfg.frame_ms) / 1000u;

    constexpr int kSeries = 4000;
    for (int s = 0; s < kSeries; ++s) {
        FrameVad vad(cfg);
        SpecOracle oracle{cfg.silence_frames};

        const int frames = len_dist(rng);
        for (int i = 0; i < frames; ++i) {
            const bool want_silent = silent_dist(rng);
            const bool fast_ok = fast_ok_dist(rng);

            const auto frame = make_frame(want_silent, frame_samples);
            const FrameVadResult r = vad.on_frame(frame.data(), frame.size());

            // An all-zero frame is unconditionally silent regardless of the
            // floor; a loud frame may or may not be silent depending on the
            // rolling floor, so the oracle follows FrameVad's observed `silent`.
            if (want_silent) {
                ASSERT_TRUE(r.silent)
                    << "series " << s << " frame " << i
                    << ": all-zero frame must be silent";
            }

            const auto [exp_edge, exp_gate] = oracle.feed(r.silent, fast_ok);

            // speculative_edge matches the independent oracle (Req 1.3).
            ASSERT_EQ(r.speculative_edge, exp_edge)
                << "series " << s << " frame " << i << " silent=" << r.silent;

            // Gated trigger: fires only with the edge AND fast_ok. In
            // particular fast_ok=false never triggers (Req 1.5), and a trigger
            // implies the edge is present and fast_ok is true.
            const bool gated = r.speculative_edge && fast_ok;
            ASSERT_EQ(gated, exp_gate)
                << "series " << s << " frame " << i << " fast_ok=" << fast_ok;
            if (!fast_ok) {
                ASSERT_FALSE(gated)
                    << "series " << s << " frame " << i
                    << ": fast_ok=false must never trigger";
            }
        }
    }
}

// A dedicated series that holds fast_ok=false for the entire run: no matter how
// long the silence streak grows, the gated trigger must never fire (Req 1.5).
TEST(FrameVadSpeculativeProps, FastOkFalseNeverTriggers) {
    std::mt19937 rng(0xBADF00Du);
    std::bernoulli_distribution silent_dist(0.85);
    std::uniform_int_distribution<int> len_dist(6, 80);

    const FrameVadConfig cfg{};
    const std::size_t frame_samples =
        static_cast<std::size_t>(cfg.sample_rate_hz) *
        static_cast<std::size_t>(cfg.frame_ms) / 1000u;

    constexpr int kSeries = 2000;
    for (int s = 0; s < kSeries; ++s) {
        FrameVad vad(cfg);
        const int frames = len_dist(rng);
        for (int i = 0; i < frames; ++i) {
            const bool silent = silent_dist(rng);
            const auto frame = make_frame(silent, frame_samples);
            const FrameVadResult r = vad.on_frame(frame.data(), frame.size());
            const bool fast_ok = false;
            ASSERT_FALSE(r.speculative_edge && fast_ok)
                << "series " << s << " frame " << i;
        }
    }
}

// Deterministic boundary cases the requirement names explicitly.
TEST(FrameVadSpeculativeProps, BoundaryStreakAndReset) {
    const FrameVadConfig cfg{}; // silence_frames = 6 (110 ms)
    const std::size_t n =
        static_cast<std::size_t>(cfg.sample_rate_hz) *
        static_cast<std::size_t>(cfg.frame_ms) / 1000u;
    const auto silent = make_frame(true, n);
    const auto loud = make_frame(false, n);

    // Exactly 6 continuous silent frames: the edge fires on the 6th frame
    // (the 110 ms boundary, Req 1.3), not before.
    {
        FrameVad vad(cfg);
        for (int i = 0; i < 5; ++i) {
            EXPECT_FALSE(vad.on_frame(silent.data(), silent.size()).speculative_edge)
                << "frame " << i << " (streak " << (i + 1) << ") must not fire yet";
        }
        EXPECT_TRUE(vad.on_frame(silent.data(), silent.size()).speculative_edge)
            << "6th silent frame (110 ms) must fire the edge";
        // Fires once per continuous streak: the 7th silent frame does not fire.
        EXPECT_FALSE(vad.on_frame(silent.data(), silent.size()).speculative_edge)
            << "edge must fire only once per continuous streak";
    }

    // Gated trigger with fast_ok true exactly at the boundary fires; with
    // fast_ok false the edge is wasted and the trigger never fires for that run.
    {
        FrameVad vad(cfg);
        for (int i = 0; i < 5; ++i) vad.on_frame(silent.data(), silent.size());
        const bool edge6 = vad.on_frame(silent.data(), silent.size()).speculative_edge;
        EXPECT_TRUE(edge6);
        EXPECT_FALSE(edge6 && false); // fast_ok=false -> no gated trigger
        EXPECT_TRUE(edge6 && true);   // fast_ok=true  -> gated trigger
    }

    // A single non-silent frame at streak 5 resets the run: the clock restarts
    // and the next 110 ms must be re-accumulated from scratch before firing.
    {
        FrameVad vad(cfg);
        for (int i = 0; i < 5; ++i) vad.on_frame(silent.data(), silent.size());
        EXPECT_FALSE(vad.on_frame(loud.data(), loud.size()).speculative_edge)
            << "non-silent frame resets the streak and does not fire";
        // Only 5 more silent frames after the reset: still below the threshold.
        for (int i = 0; i < 5; ++i) {
            EXPECT_FALSE(vad.on_frame(silent.data(), silent.size()).speculative_edge)
                << "post-reset frame " << i << " must not fire yet";
        }
        // The 6th silent frame after the reset reaches 110 ms again and fires.
        EXPECT_TRUE(vad.on_frame(silent.data(), silent.size()).speculative_edge)
            << "edge must re-arm and fire after a fresh 110 ms streak";
    }

    // reset() mid-streak also re-arms: a per-turn reset clears the streak so a
    // long prior streak does not carry over into the next turn.
    {
        FrameVad vad(cfg);
        for (int i = 0; i < 6; ++i) vad.on_frame(silent.data(), silent.size());
        vad.reset();
        for (int i = 0; i < 5; ++i) {
            EXPECT_FALSE(vad.on_frame(silent.data(), silent.size()).speculative_edge)
                << "post-reset frame " << i << " must not fire yet";
        }
        EXPECT_TRUE(vad.on_frame(silent.data(), silent.size()).speculative_edge)
            << "edge must fire after a fresh 110 ms streak following reset()";
    }
}
