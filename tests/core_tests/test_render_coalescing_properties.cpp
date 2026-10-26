// Property-based tests for the pure redraw-coalescing scheduler behind the
// UI_Bridge (src/core/include/rtai/render_coalescer.hpp). The production
// coalescing lives in the Win32 OverlayWindow (invalidate() + the 16 ms
// kTimerRender/kTimerAnim timer): the first visible delta of a generation (or a
// commit) renders immediately, later deltas of the same generation set
// render_pending and are flushed by the single 16 ms timer — at most one render
// per 16 ms. RenderCoalescer is a faithful, platform-free model of that exact
// rule, so the scheduling invariants can be checked by PBT.
//
// The project ships GoogleTest only (no dedicated PBT runtime), so each
// property is checked by sampling the input space with a seeded std::mt19937
// over many trials plus the exact boundary cases the requirement names. A fixed
// seed keeps failures reproducible; a reported counterexample can be replayed
// by hand.
#include <gtest/gtest.h>

#include <algorithm>
#include <cstdint>
#include <random>
#include <vector>

#include "rtai/render_coalescer.hpp"

using namespace rtai;

namespace {

// Drive the coalescer over a sorted stream of delta arrival timestamps, letting
// the 16 ms timer fire whenever it is due between arrivals, then flush the
// trailing frame. Returns the times of every render actually emitted, in
// chronological order. `first_is_immediate` reflects the overlay: the first
// delta of a fresh generation renders immediately.
//
// This is written independently of RenderCoalescer's internals — it only
// replays arrivals and advances the clock, exactly as the UI thread would —
// so the test is not a restatement of the implementation.
std::vector<std::int64_t> replay_deltas(const std::vector<std::int64_t>& arrivals_ms,
                                        std::int64_t window_ms) {
    RenderCoalescer rc(window_ms);
    rc.reset_generation();
    std::vector<std::int64_t> renders;

    for (std::size_t i = 0; i < arrivals_ms.size(); ++i) {
        const std::int64_t now = arrivals_ms[i];
        // Before handling this arrival, let any deferred frame that is already
        // due fire — the timer runs independently of arrivals.
        const RenderEvent due = rc.tick(now);
        if (due.cause == RenderCause::Timer) renders.push_back(due.at_ms);

        const RenderEvent r = rc.on_delta(now);
        if (r.cause != RenderCause::None) renders.push_back(r.at_ms);
    }

    // End of the burst: the trailing deferred frame must still fire (no dropped
    // final frame). Model the timer firing at its due time.
    const RenderEvent tail = rc.flush();
    if (tail.cause == RenderCause::Timer) renders.push_back(tail.at_ms);

    std::sort(renders.begin(), renders.end());
    return renders;
}

// The maximum number of renders whose timestamps fall inside any half-open
// window [t, t + window_ms). Since renders are sorted, a sliding window over
// the sorted vector finds the densest window.
std::size_t max_renders_in_window(const std::vector<std::int64_t>& renders,
                                  std::int64_t window_ms) {
    std::size_t best = 0;
    std::size_t lo = 0;
    for (std::size_t hi = 0; hi < renders.size(); ++hi) {
        while (renders[hi] - renders[lo] >= window_ms) ++lo;
        best = std::max(best, hi - lo + 1);
    }
    return best;
}

} // namespace

// ---------------------------------------------------------------------------
// Property 13: Coalescência limita a 1 redesenho por janela de 16 ms.
// ---------------------------------------------------------------------------
// For ANY stream of delta arrival timestamps of the same generation, the number
// of renders scheduled within any 16 ms window is at most 1, AND at least one
// render happens after the last delta (the trailing frame is never dropped).
//
// Strategy: generate random strictly-increasing arrival streams (random count,
// random inter-arrival gaps spanning well below and well above 16 ms so bursts
// and spaced deltas are both exercised), replay them through the coalescer, and
// check both halves of the invariant on the emitted render timeline. A seeded
// std::mt19937 keeps counterexamples reproducible.
//
// **Validates: Requirements 5.3**
TEST(RenderCoalescingProperties, AtMostOneRenderPer16msAndNoDroppedFinalFrame) {
    constexpr std::int64_t kWindow = 16;
    std::mt19937 rng(0xC0A1E5Cu);
    std::uniform_int_distribution<int> count_dist(1, 60);
    // Inter-arrival gaps: mostly small (sub-16 ms bursts) with occasional large
    // jumps so renders land in distinct windows too.
    std::uniform_int_distribution<int> gap_small(0, 20);
    std::uniform_int_distribution<int> gap_big(20, 300);
    std::bernoulli_distribution big_gap(0.2);
    std::uniform_int_distribution<int> start_dist(0, 10000);

    constexpr int kTrials = 20000;
    for (int t = 0; t < kTrials; ++t) {
        const int n = count_dist(rng);
        std::vector<std::int64_t> arrivals;
        arrivals.reserve(static_cast<std::size_t>(n));
        std::int64_t now = start_dist(rng);
        for (int i = 0; i < n; ++i) {
            now += big_gap(rng) ? gap_big(rng) : gap_small(rng);
            arrivals.push_back(now);
        }

        const std::vector<std::int64_t> renders = replay_deltas(arrivals, kWindow);

        // (a) At most one render per 16 ms window (Req 5.3). An empty render
        // list is impossible here because the first delta always renders.
        ASSERT_FALSE(renders.empty()) << "trial " << t << " n=" << n;
        const std::size_t dense = max_renders_in_window(renders, kWindow);
        EXPECT_LE(dense, 1u)
            << "trial " << t << " n=" << n
            << ": " << dense << " renders inside a " << kWindow << " ms window";

        // (b) At least one render AFTER the last delta — the trailing frame is
        // never dropped. For the first delta (which renders immediately at its
        // own timestamp) the >= holds; for coalesced streams the flushed timer
        // lands strictly after the last arrival.
        const std::int64_t last_delta = arrivals.back();
        EXPECT_GE(renders.back(), last_delta)
            << "trial " << t << " n=" << n << ": no render after the last delta";
    }
}

// Property 13, second half stated sharply for multi-delta streams: whenever
// MORE than one delta arrives, the final content is flushed strictly after the
// last delta (a deferred timer frame), so the last token is always painted.
//
// **Validates: Requirements 5.3**
TEST(RenderCoalescingProperties, TrailingDeltaAlwaysFlushedAfterLastDelta) {
    constexpr std::int64_t kWindow = 16;
    std::mt19937 rng(0x5EEDF1u);
    std::uniform_int_distribution<int> count_dist(2, 40);
    std::uniform_int_distribution<int> gap_dist(0, 40);
    std::uniform_int_distribution<int> start_dist(0, 5000);

    constexpr int kTrials = 20000;
    for (int t = 0; t < kTrials; ++t) {
        const int n = count_dist(rng);
        std::vector<std::int64_t> arrivals;
        arrivals.reserve(static_cast<std::size_t>(n));
        std::int64_t now = start_dist(rng);
        for (int i = 0; i < n; ++i) {
            // Strictly increasing so "the last delta" is unambiguous.
            now += gap_dist(rng) + 1;
            arrivals.push_back(now);
        }

        const std::vector<std::int64_t> renders = replay_deltas(arrivals, kWindow);
        const std::int64_t last_delta = arrivals.back();

        // The first render is immediate at arrivals[0]; the last render is the
        // flushed deferred frame, which must sit strictly after the last delta
        // (its due time is last_pending_delta + window). Since at least one
        // delta followed the immediate first render, a deferred frame exists.
        EXPECT_GT(renders.back(), last_delta)
            << "trial " << t << " n=" << n
            << ": trailing frame not flushed strictly after the last delta";

        // And the dense-window bound still holds.
        EXPECT_LE(max_renders_in_window(renders, kWindow), 1u) << "trial " << t;
    }
}

// Deterministic boundary cases the requirement names explicitly.
TEST(RenderCoalescingProperties, BoundaryCases) {
    constexpr std::int64_t kWindow = 16;

    // Single delta: renders immediately exactly once, at its own timestamp.
    {
        const auto r = replay_deltas({1000}, kWindow);
        ASSERT_EQ(r.size(), 1u);
        EXPECT_EQ(r[0], 1000);
    }

    // A tight burst entirely inside one 16 ms window: first delta renders
    // immediately, the rest coalesce into exactly ONE deferred frame — two
    // renders total, and no window holds more than one.
    {
        const auto r = replay_deltas({0, 1, 2, 3, 4, 5}, kWindow);
        ASSERT_EQ(r.size(), 2u) << "immediate + one coalesced frame";
        EXPECT_EQ(r[0], 0);          // immediate
        EXPECT_EQ(r[1], 1 + kWindow);// deferred timer armed by the 2nd delta (t=1)
        EXPECT_LE(max_renders_in_window(r, kWindow), 1u);
    }

    // Deltas spaced far apart (> 16 ms): the first renders immediately, each
    // later one arms its own timer that fires before the next arrives, so every
    // delta gets its own frame — still at most one per window.
    {
        const auto r = replay_deltas({0, 100, 200, 300}, kWindow);
        // 1 immediate (t=0) + 3 deferred (116, 216, 316).
        ASSERT_EQ(r.size(), 4u);
        EXPECT_EQ(r[0], 0);
        EXPECT_EQ(r[1], 100 + kWindow);
        EXPECT_EQ(r[2], 200 + kWindow);
        EXPECT_EQ(r[3], 300 + kWindow);
        EXPECT_LE(max_renders_in_window(r, kWindow), 1u);
        EXPECT_GT(r.back(), 300); // flushed after the last delta
    }

    // Two deltas exactly one window apart: first immediate at 0, second arms a
    // timer at 16, flushed at 32 — two renders, each in its own window.
    {
        const auto r = replay_deltas({0, kWindow}, kWindow);
        ASSERT_EQ(r.size(), 2u);
        EXPECT_EQ(r[0], 0);
        EXPECT_EQ(r[1], kWindow + kWindow);
        EXPECT_LE(max_renders_in_window(r, kWindow), 1u);
    }

    // A commit renders immediately regardless of pending deltas and supersedes
    // any armed timer (the promoted buffer is the up-to-date frame).
    {
        RenderCoalescer rc(kWindow);
        rc.reset_generation();
        const RenderEvent first = rc.on_delta(10); // immediate
        EXPECT_EQ(first.cause, RenderCause::Immediate);
        const RenderEvent d2 = rc.on_delta(12);    // arms a timer
        EXPECT_EQ(d2.cause, RenderCause::None);
        EXPECT_TRUE(rc.pending());
        const RenderEvent commit = rc.on_commit(13);
        EXPECT_EQ(commit.cause, RenderCause::Immediate);
        EXPECT_FALSE(rc.pending()) << "commit supersedes the pending deferred frame";
    }

    // New generation: after reset_generation(), the next delta renders
    // immediately again (first visible delta of the new generation).
    {
        RenderCoalescer rc(kWindow);
        rc.reset_generation();
        EXPECT_EQ(rc.on_delta(0).cause, RenderCause::Immediate);
        EXPECT_EQ(rc.on_delta(2).cause, RenderCause::None); // coalesced
        rc.reset_generation();
        EXPECT_EQ(rc.on_delta(50).cause, RenderCause::Immediate) << "new generation renders now";
    }
}
