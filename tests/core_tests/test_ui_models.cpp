// Platform-independent pieces of the native overlay: SVG icon paths,
// arc -> Bezier conversion, transcript chips, chat line edit, responsiveness.
#include <gtest/gtest.h>

#include <cmath>
#include <limits>
#include <random>
#include <string>

#include "rtai/icon_paths.hpp"
#include "rtai/svg_path.hpp"
#include "rtai/ui_models.hpp"

using namespace rtai;

TEST(SvgPath, ParsesRelativeCommandsArcsAndShorthands) {
    auto cmds = svg::parse_path("M12 2a3 3 0 0 0-3 3v7h1Z");
    ASSERT_TRUE(cmds);
    ASSERT_EQ(cmds->size(), 5u);
    EXPECT_EQ((*cmds)[1].kind, svg::Cmd::Kind::Arc);
    EXPECT_FLOAT_EQ((*cmds)[1].p.x, 9.0f);
    EXPECT_FLOAT_EQ((*cmds)[1].p.y, 5.0f);
    EXPECT_FLOAT_EQ((*cmds)[2].p.y, 12.0f); // v7 -> line
    EXPECT_FLOAT_EQ((*cmds)[3].p.x, 10.0f); // lowercase h is relative: 9 + 1
}

TEST(SvgPath, CompactNumbersFlagsAndImplicitLineto) {
    auto cmds = svg::parse_path("M1.5.5l-.5-1a1 1 0 011 1M0 0 2 2");
    ASSERT_TRUE(cmds);
    EXPECT_FLOAT_EQ((*cmds)[0].p.x, 1.5f);
    EXPECT_FLOAT_EQ((*cmds)[0].p.y, 0.5f);
    EXPECT_FLOAT_EQ((*cmds)[1].p.x, 1.0f);
    EXPECT_FLOAT_EQ((*cmds)[1].p.y, -0.5f);
    EXPECT_TRUE((*cmds)[2].sweep);
    EXPECT_FALSE((*cmds)[2].large_arc);
    EXPECT_EQ(cmds->back().kind, svg::Cmd::Kind::Line); // "2 2" after M is a lineto
}

TEST(SvgPath, SmoothCurvesReflectControlPoint) {
    auto cmds = svg::parse_path("M0 0C1 1 2 1 3 0S5 -1 6 0");
    ASSERT_TRUE(cmds);
    EXPECT_FLOAT_EQ((*cmds)[2].c1.x, 4.0f);
    EXPECT_FLOAT_EQ((*cmds)[2].c1.y, -1.0f);
}

TEST(SvgPath, RejectsMalformedInput) {
    EXPECT_FALSE(svg::parse_path("L1 1"));
    EXPECT_FALSE(svg::parse_path("M1"));
    EXPECT_FALSE(svg::parse_path("M0 0 A1 1 0 2 0 1 1"));
}

TEST(SvgPath, ArcBecomesCubicsOnTheCircle) {
    // Lucide draws dots/circles as two half arcs: "M11 12A1 1 0 1 0 13 12A1 1 0 1 0 11 12Z".
    auto cmds = svg::parse_path("M11 12A1 1 0 1 0 13 12");
    ASSERT_TRUE(cmds);
    const auto segs = svg::arc_to_cubics((*cmds)[0].p, (*cmds)[1]);
    ASSERT_GE(segs.size(), 2u);
    EXPECT_FLOAT_EQ(segs.back().p.x, 13.0f);
    EXPECT_FLOAT_EQ(segs.back().p.y, 12.0f);
    // Sample the Beziers: every point must be ~1 away from the center (12,12),
    // and a half circle with sweep=0 from left to right goes through y=13
    // (y grows downward, counter-clockwise on screen).
    svg::Pt p0 = (*cmds)[0].p;
    float max_err = 0.0f, max_y = -1e9f;
    for (const auto& s : segs) {
        for (int i = 0; i <= 10; ++i) {
            const float t = static_cast<float>(i) / 10.0f, u = 1 - t;
            const float x = u * u * u * p0.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t * t * t * s.p.x;
            const float y = u * u * u * p0.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t * t * t * s.p.y;
            max_err = std::max(max_err, std::fabs(std::hypot(x - 12.0f, y - 12.0f) - 1.0f));
            max_y = std::max(max_y, y);
        }
        p0 = s.p;
    }
    EXPECT_LT(max_err, 0.01f);
    EXPECT_NEAR(max_y, 13.0f, 0.01f);
}

TEST(SvgPath, ArcRadiusIsScaledUpWhenTooSmall) {
    svg::Cmd a;
    a.kind = svg::Cmd::Kind::Arc;
    a.rx = a.ry = 0.5f; // too small for a 4-unit chord: scaled to 2
    a.p = {4, 0};
    const auto segs = svg::arc_to_cubics({0, 0}, a);
    ASSERT_FALSE(segs.empty());
    EXPECT_FLOAT_EQ(segs.back().p.x, 4.0f);
}

TEST(SvgPath, EveryBundledIconParses) {
    std::size_t paths = 0;
    for (const auto& icon : icons::kIcons) {
        bool any = false;
        for (const auto& d : icon.paths) {
            if (d.empty()) continue;
            any = true;
            ++paths;
            EXPECT_TRUE(svg::parse_path(d).has_value()) << icon.name << ": " << d;
        }
        EXPECT_TRUE(any) << icon.name;
    }
    EXPECT_GT(paths, 60u);
}

TEST(TranscriptStrip, ChunksPhrasesAndMarksSpeakerChanges) {
    ui::TranscriptStrip st;
    st.on_update(AudioSource::Loopback, "Your pricing is significantly higher than the alternative.", true);
    st.on_update(AudioSource::Microphone, "Entendo. Posso explicar", false);
    const auto c = st.chunks(24);
    ASSERT_GE(c.size(), 4u);
    EXPECT_EQ(c[0].source, AudioSource::Loopback);
    EXPECT_TRUE(c[0].speaker_change);
    for (const auto& x : c) EXPECT_LE(text::utf8_length(x.text), 24u) << x.text;
    EXPECT_EQ(c.back().source, AudioSource::Microphone);
    EXPECT_TRUE(c.back().live);
    // "Entendo." ends a sentence: its own chip.
    bool found = false;
    for (const auto& x : c) found = found || x.text == "Entendo.";
    EXPECT_TRUE(found);
}

TEST(TranscriptStrip, OpenItemIsUpdatedNotDuplicatedAndCapped) {
    ui::TranscriptStrip st(3);
    st.on_update(AudioSource::Loopback, "Qual", false);
    st.on_update(AudioSource::Loopback, "Qual é o", false);
    st.on_update(AudioSource::Loopback, "Qual é o prazo?", true);
    auto c = st.chunks();
    ASSERT_EQ(c.size(), 1u);
    EXPECT_EQ(c[0].text, "Qual é o prazo?");
    EXPECT_FALSE(c[0].live);
    for (int i = 0; i < 5; ++i) st.on_update(AudioSource::Microphone, "fala " + std::to_string(i), true);
    c = st.chunks();
    EXPECT_EQ(c.size(), 3u); // capped
    EXPECT_EQ(c.back().text, "fala 4");
    st.on_update(AudioSource::Loopback, "x", false);
    st.on_update(AudioSource::Loopback, "", false); // interim discarded
    EXPECT_EQ(st.chunks().back().text, "fala 4");
    st.clear();
    EXPECT_TRUE(st.empty());
}

TEST(TranscriptStrip, CountsCodePointsNotBytes) {
    ui::TranscriptStrip st;
    st.on_update(AudioSource::Loopback, "ação ação ação ação ação ação", true); // 4 cp per word
    for (const auto& x : st.chunks(10)) EXPECT_LE(text::utf8_length(x.text), 10u);
}

TEST(LineEdit, EditsWithCaretAndSurrogatePairs) {
    ui::LineEdit e;
    e.insert(u"olá mundo");
    e.left();
    e.left();
    e.backspace();
    EXPECT_EQ(e.text(), u"olá mudo");
    e.end();
    e.insert(u" \U0001F600"); // emoji: surrogate pair
    EXPECT_EQ(e.text().size(), 11u);
    e.backspace(); // removes the whole pair
    EXPECT_EQ(e.text(), u"olá mudo ");
    e.home();
    e.del();
    EXPECT_EQ(e.text(), u"lá mudo ");
    e.end();
    e.delete_word_back();
    EXPECT_EQ(e.text(), u"lá ");
}

TEST(LineEdit, PasteIsSanitizedAndSelectAllReplaces) {
    ui::LineEdit e(10);
    e.insert(u"a\r\nb\tc\x01");
    EXPECT_EQ(e.text(), u"a b c");
    e.select_all();
    EXPECT_TRUE(e.all_selected());
    e.insert(u"novo texto longo demais");
    EXPECT_EQ(e.text(), u"novo texto"); // max length
    e.select_all();
    e.backspace();
    EXPECT_TRUE(e.empty());
}

TEST(Responsive, PicksRichestDensityThatFits) {
    EXPECT_EQ(ui::pick_density(800, {760, 600, 400}), 0u);
    EXPECT_EQ(ui::pick_density(700, {760, 600, 400}), 1u);
    EXPECT_EQ(ui::pick_density(300, {760, 600, 400}), 2u);
    float x = 0.0f;
    int steps = 0;
    while (ui::approach(x, 1.0f, 16.0f, 60.0f)) ++steps;
    EXPECT_EQ(x, 1.0f);
    EXPECT_GT(steps, 3);
    EXPECT_LT(steps, 60);
}

// --- Property 2: clamp_height_fraction keeps the fraction in [0.1, 1.0] and is
// idempotent (Validates: Requirements 1.7). No external PBT library is wired
// into the core tests, so the property is exercised by sweeping a wide, dense
// range of inputs (well below the lower bound, across the band, well past the
// upper bound, plus the exact edges and non-finite values) and asserting the
// universal clamp/idempotence invariants on every one.
TEST(ClampHeightFraction, Property2_ClampsToBandAndIsIdempotent) {
    const float lo = kMaxHeightFractionMin; // 0.1
    const float hi = kMaxHeightFractionMax; // 1.0

    auto check = [&](float f) {
        const float r = ui::clamp_height_fraction(f);
        // Result always lands inside the inclusive band [0.1, 1.0].
        EXPECT_GE(r, lo) << "input=" << f;
        EXPECT_LE(r, hi) << "input=" << f;
        // Out-of-band inputs snap to the nearest limit (Req 1.7).
        if (f < lo) { EXPECT_FLOAT_EQ(r, lo) << "input=" << f; }
        if (f > hi) { EXPECT_FLOAT_EQ(r, hi) << "input=" << f; }
        // In-band inputs pass through unchanged.
        if (f >= lo && f <= hi) { EXPECT_FLOAT_EQ(r, f) << "input=" << f; }
        // Idempotent: clamping an already-clamped value is a no-op.
        EXPECT_FLOAT_EQ(ui::clamp_height_fraction(r), r) << "input=" << f;
    };

    // Dense sweep from well below the lower bound to well above the upper one.
    for (int i = -500; i <= 2000; ++i) check(static_cast<float>(i) / 1000.0f);

    // Explicit edges and nearby values (inclusive bounds, Req 1.7).
    for (float f : {0.0f, lo, hi, 0.09999f, 0.10001f, 0.6f, 0.99999f, 1.00001f,
                    -1.0f, -100.0f, 5.0f, 1000.0f})
        check(f);
}

// ---------------------------------------------------------------------------
// Property 1: clamp_width keeps the width in [460, 540] and is idempotent.
// Validates: Requirements 1.3
//
// For any width w (inside, below or above the range):
//   * clamp_width(w) lands in [460, 540];
//   * w < 460 clamps to exactly 460; w > 540 clamps to exactly 540;
//   * w already in range is returned unchanged;
//   * clamp_width is idempotent: clamp_width(clamp_width(w)) == clamp_width(w).
// Random inputs are drawn across below/inside/above the band plus the exact
// boundaries, so every branch of the clamp is exercised many times.
// ---------------------------------------------------------------------------
TEST(ClampWidthProperty, StaysInRangeAndIsIdempotent) {
    std::mt19937 rng(0xC1A3Du);
    // Spread well past the band on both sides to hit the below/above branches,
    // including absurd values that should still saturate cleanly to a limit.
    std::uniform_real_distribution<float> any(-5000.0f, 5000.0f);

    auto check = [](float w) {
        const float c = ui::clamp_width(w);
        // In range.
        EXPECT_GE(c, kMinW) << "w=" << w;
        EXPECT_LE(c, kMaxW) << "w=" << w;
        // Saturation to the nearest limit.
        if (w < kMinW) {
            EXPECT_FLOAT_EQ(c, kMinW) << "w=" << w;
        } else if (w > kMaxW) {
            EXPECT_FLOAT_EQ(c, kMaxW) << "w=" << w;
        } else {
            EXPECT_FLOAT_EQ(c, w) << "w=" << w; // already in range: unchanged
        }
        // Idempotence.
        EXPECT_FLOAT_EQ(ui::clamp_width(c), c) << "w=" << w;
    };

    // Many random inputs across the whole real line around the band.
    for (int i = 0; i < 20000; ++i) check(any(rng));

    // Boundary and well-known values: the inclusive limits, the default width,
    // and extremes must all behave.
    for (float w : {kMinW, kMaxW, kHudW, 459.999f, 460.0f, 460.001f, 539.999f,
                    540.0f, 540.001f, 0.0f, -1.0f, 1e6f, -1e6f}) {
        check(w);
    }
}

// --- Property 5: the window height is the minimum of content and ceiling
// (Validates: Requirements 1.6). The ceiling is clamp_height_fraction(frac) *
// work_h, so window_height never exceeds it and equals min(content, ceiling)
// for every content height. As with Property 2, no external PBT library is
// wired into the core tests, so the property is exercised by sweeping a wide,
// dense grid of (content_h, frac, work_h) triples -- content below, at and
// above the ceiling; fractions below, inside and above the [0.1, 1.0] band; and
// a range of work-area heights -- plus explicit edges, and asserting the
// min/never-exceeds-the-ceiling invariant on every one.
TEST(WindowHeight, Property5_IsMinOfContentAndCeiling) {
    auto check = [&](float content_h, float frac, float work_h) {
        const float ceiling = ui::clamp_height_fraction(frac) * work_h;
        const float h = ui::window_height(content_h, frac, work_h);
        // It is exactly min(content, ceiling).
        EXPECT_FLOAT_EQ(h, std::min(content_h, ceiling))
            << "content=" << content_h << " frac=" << frac << " work=" << work_h;
        // It never exceeds the ceiling (the clamped-fraction share of work_h).
        EXPECT_LE(h, ceiling)
            << "content=" << content_h << " frac=" << frac << " work=" << work_h;
        // It never exceeds the content either (min of the two).
        EXPECT_LE(h, content_h)
            << "content=" << content_h << " frac=" << frac << " work=" << work_h;
        // When the content is below the ceiling the window hugs the content;
        // otherwise it is capped at the ceiling.
        if (content_h <= ceiling) EXPECT_FLOAT_EQ(h, content_h)
            << "content=" << content_h << " frac=" << frac << " work=" << work_h;
        else EXPECT_FLOAT_EQ(h, ceiling)
            << "content=" << content_h << " frac=" << frac << " work=" << work_h;
    };

    // Dense grid: work-area heights, fractions spanning below/inside/above the
    // [0.1, 1.0] band, and content heights from 0 up past the tallest ceiling.
    for (float work_h : {600.0f, 900.0f, 1080.0f, 1440.0f, 2160.0f}) {
        for (int fi = -3; fi <= 13; ++fi) {
            const float frac = static_cast<float>(fi) / 10.0f; // -0.3 .. 1.3
            for (int ci = 0; ci <= 2400; ci += 25) {
                check(static_cast<float>(ci), frac, work_h);
            }
        }
    }

    // Explicit edges: content exactly at the ceiling, zero content, the default
    // fraction, and the clamped band limits.
    check(0.0f, 0.6f, 1080.0f);
    check(648.0f, 0.6f, 1080.0f);   // content == ceiling (0.6 * 1080)
    check(647.0f, 0.6f, 1080.0f);   // just under the ceiling -> hugs content
    check(649.0f, 0.6f, 1080.0f);   // just over the ceiling  -> capped
    check(5000.0f, 1.0f, 1080.0f);  // tall content, max fraction -> full work_h
    check(5000.0f, -1.0f, 1080.0f); // frac below band clamps to 0.1 * work_h
    check(5000.0f, 2.0f, 1080.0f);  // frac above band clamps to 1.0 * work_h
}

// --- Property 4: resolve_anchor selects the correct monitor and falls back to
// the primary (Validates: Requirements 1.5, 1.9). For any persisted center and
// any set of monitors, resolve_anchor must use the work area of the monitor
// that contains the persisted center (looked up via the monitor_of callback);
// when no monitor contains the center (monitor_of returns nullopt) it falls
// back to Top-Center of the primary work area with the default width (kHudW).
// No external PBT library is wired into the core tests, so the property is
// exercised with a mock monitor_of over a randomized set of disjoint monitors
// and many random persisted centers -- some landing on a monitor, some in the
// gaps between them -- plus explicit edge cases, asserting the
// selection/fallback invariant on every one.
TEST(ResolveAnchor, Property4_SelectsContainingMonitorElseFallsBackToPrimary) {
    using rtai::ui::AnchorResult;
    using rtai::ui::resolve_anchor;
    using rtai::ui::UiPoint;
    using rtai::ui::UiRect;

    // The primary monitor's work area, used for the no-position and no-match
    // fallbacks. Kept distinct from the secondary monitors below so a fallback
    // to the primary is unmistakable.
    const UiRect primary{0, 0, 1920, 1040};

    // A handful of disjoint secondary monitors at various offsets, none
    // overlapping the primary or each other, so "the monitor containing a
    // point" is unambiguous.
    const std::vector<UiRect> monitors = {
        primary,
        UiRect{1920, 0, 3840, 1040},      // right of primary
        UiRect{-1280, 0, 0, 1024},        // left of primary
        UiRect{200, 1040, 1480, 2000},    // below, narrower
        UiRect{5000, 5000, 5800, 5600},   // far away island
    };

    // Mock monitor_of: returns the work area of the first monitor whose
    // rectangle contains the point, or nullopt when the point lands in a gap.
    // This is exactly the contract the overlay implements with
    // MonitorFromPoint + GetMonitorInfo.
    auto monitor_of = [&monitors](UiPoint p) -> std::optional<UiRect> {
        for (const auto& m : monitors) {
            if (m.contains(p)) return m;
        }
        return std::nullopt;
    };

    // The top edge always lands in the inclusive [8, 10] DIP band (Req 1.1),
    // whichever monitor is chosen; x centers the effective width in the chosen
    // work area (clamped so a too-wide window never starts off-screen).
    auto expect_top_center = [](const AnchorResult& r, const UiRect& work, float eff_w) {
        EXPECT_GE(r.y_dip - work.top, 8);
        EXPECT_LE(r.y_dip - work.top, 10);
        const int x = static_cast<int>(std::lround((static_cast<float>(work.width()) - eff_w) / 2.0f));
        EXPECT_EQ(r.x_dip, work.left + std::max(0, x))
            << "work.left=" << work.left << " work.w=" << work.width() << " eff=" << eff_w;
        EXPECT_EQ(r.work_area.left, work.left);
        EXPECT_EQ(r.work_area.top, work.top);
        EXPECT_EQ(r.work_area.right, work.right);
        EXPECT_EQ(r.work_area.bottom, work.bottom);
    };

    std::mt19937 rng(0x4047C0DEu);
    std::uniform_int_distribution<int> px(-2000, 6200);
    std::uniform_int_distribution<int> py(-500, 6000);
    // Effective widths across and beyond the [460, 540] band; resolve_anchor
    // clamps the width before centering (default kHudW is used on fallback).
    std::uniform_real_distribution<float> ew(300.0f, 700.0f);

    for (int i = 0; i < 20000; ++i) {
        const UiPoint center{px(rng), py(rng)};
        const float eff = ew(rng);
        const AnchorResult r = resolve_anchor(center, eff, primary, monitor_of);

        const auto hit = monitor_of(center);
        if (hit) {
            // Persisted center on a monitor: Top-Center of THAT monitor's work
            // area, using the clamped effective width (Req 1.5).
            expect_top_center(r, *hit, ui::clamp_width(eff));
        } else {
            // Persisted center off every monitor: Top-Center of the primary
            // with the default width (Req 1.9).
            expect_top_center(r, primary, kHudW);
        }
    }

    // Explicit cases pinning each branch.
    // (a) Center squarely inside the right-hand monitor -> that monitor.
    {
        const AnchorResult r = resolve_anchor(UiPoint{2880, 500}, 480.0f, primary, monitor_of);
        expect_top_center(r, monitors[1], ui::clamp_width(480.0f));
    }
    // (b) Center inside the left-hand monitor -> that monitor.
    {
        const AnchorResult r = resolve_anchor(UiPoint{-640, 500}, 500.0f, primary, monitor_of);
        expect_top_center(r, monitors[2], ui::clamp_width(500.0f));
    }
    // (c) Center in a gap between monitors (no containment) -> primary, kHudW.
    {
        const AnchorResult r = resolve_anchor(UiPoint{4200, 3000}, 500.0f, primary, monitor_of);
        expect_top_center(r, primary, kHudW);
    }
    // (d) Center inside the primary itself -> primary with the given width.
    {
        const AnchorResult r = resolve_anchor(UiPoint{960, 520}, 520.0f, primary, monitor_of);
        expect_top_center(r, primary, ui::clamp_width(520.0f));
    }
    // (e) A null monitor_of callback behaves like "no monitor matched" for a
    // persisted center -> primary fallback with the default width (Req 1.9).
    {
        const AnchorResult r =
            resolve_anchor(UiPoint{100, 100}, 500.0f, primary, nullptr);
        expect_top_center(r, primary, kHudW);
    }
}
