// Pure core — redraw coalescing scheduler for the UI_Bridge (Req 5.2/5.3).
//
// The production coalescing lives in the Win32 OverlayWindow
// (src/overlay/src/overlay_window.cpp): the first visible delta of a
// generation (or a commit) forces an immediate render, while subsequent deltas
// of the same generation set `render_pending` and are flushed by the 16 ms
// animation/render timer (kTimerAnim / kTimerRender) — at most one render per
// 16 ms window. That logic is entangled with HWND/SetTimer, so the *scheduling
// rule itself* is modeled here as a pure, platform-free helper that the overlay
// can adopt and that PBT can exercise directly (mirroring the FrameVad /
// UserSpeechGate pattern of lifting numeric/timing logic into the pure core).
//
// The model intentionally reproduces the exact Win32 behaviour of invalidate()
// + the 16 ms timer:
//   * on_commit()      -> render NOW (time-until-first-token = 0 on promotion)
//   * first delta of a generation -> render NOW
//   * later deltas of the same generation -> arm a one-shot 16 ms timer if one
//     is not already pending; if a timer is already armed the delta is folded
//     into that pending frame (no second timer), so a burst of deltas inside a
//     16 ms window collapses to a single deferred render.
//   * the timer firing clears `pending` and performs exactly one render.
//
// This guarantees the two halves of Property 13: at most one render per 16 ms
// window, and at least one render after the last delta (the final pending timer
// always fires, so no trailing frame is dropped).
//
// Not thread-safe: in production every call happens on the UI thread.
#pragma once

#include <cstdint>

namespace rtai {

// Why a render was emitted — useful for assertions and for the overlay to pick
// the immediate vs. deferred path.
enum class RenderCause : std::uint8_t {
    None,       // nothing rendered by this step
    Immediate,  // first delta of a generation, or a commit: rendered now
    Timer,      // deferred frame flushed by the 16 ms timer
};

// A single redraw the scheduler decided to perform, tagged with the time it
// happens and why. Callers collect these to check the coalescing invariants.
struct RenderEvent {
    std::int64_t at_ms{0};
    RenderCause cause{RenderCause::None};
};

// Pure model of the OverlayWindow redraw scheduler. One instance per overlay;
// `reset_generation()` on a new speculative generation so the next delta takes
// the immediate path (mirroring "first SuggestionDeltaEvent of a generation").
class RenderCoalescer {
public:
    // The coalescing window in milliseconds (kTimerRender / kTimerAnim = 16 ms,
    // i.e. ~60 fps). Configurable only to keep the type testable; production
    // uses 16.
    explicit RenderCoalescer(std::int64_t window_ms = 16) noexcept
        : window_ms_(window_ms > 0 ? window_ms : 1) {}

    std::int64_t window_ms() const noexcept { return window_ms_; }

    // True while a deferred render has been armed but not yet flushed. Mirrors
    // the overlay's `render_pending` flag.
    bool pending() const noexcept { return pending_; }

    // When the currently-armed deferred render will fire (only meaningful while
    // pending()).
    std::int64_t pending_due_ms() const noexcept { return pending_due_ms_; }

    // Start a fresh generation: the next delta renders immediately, just like
    // the first visible delta of a new speculative generation. Any in-flight
    // deferred timer stays armed (it will still flush the previous content),
    // matching the overlay, where a new generation does not cancel the pending
    // frame.
    void reset_generation() noexcept { first_delta_seen_ = false; }

    // A commit promotes the shadow buffer: render immediately (Req 5.2). The
    // immediate render also satisfies any pending deferred frame, so the timer
    // is cleared — the just-emitted frame is the up-to-date one.
    RenderEvent on_commit(std::int64_t now_ms) noexcept {
        pending_ = false;
        first_delta_seen_ = true; // a visible generation is now on screen
        return RenderEvent{now_ms, RenderCause::Immediate};
    }

    // A streaming delta arrived at `now_ms`. The first delta of a generation
    // renders immediately (Req 5.2); every later delta of the same generation
    // is coalesced (Req 5.3): it arms a single 16 ms timer, or folds into the
    // already-armed one.
    //
    // Returns the immediate render when one happens, or RenderCause::None when
    // the delta was folded into a pending deferred frame.
    RenderEvent on_delta(std::int64_t now_ms) noexcept {
        if (!first_delta_seen_) {
            first_delta_seen_ = true;
            // An immediate render supersedes any stale pending frame.
            pending_ = false;
            return RenderEvent{now_ms, RenderCause::Immediate};
        }
        if (!pending_) {
            pending_ = true;
            // One-shot timer armed 16 ms from now (SetTimer(..., 16, ...)).
            pending_due_ms_ = now_ms + window_ms_;
        }
        // else: a timer is already armed — fold this delta into it (the overlay
        // early-returns from invalidate() when render_pending is already set).
        return RenderEvent{now_ms, RenderCause::None};
    }

    // Advance the clock to `now_ms`: if an armed deferred render is now due,
    // fire it exactly once and clear the pending flag. Returns the flushed
    // RenderEvent, or RenderCause::None when nothing was due.
    RenderEvent tick(std::int64_t now_ms) noexcept {
        if (pending_ && now_ms >= pending_due_ms_) {
            pending_ = false;
            return RenderEvent{pending_due_ms_, RenderCause::Timer};
        }
        return RenderEvent{now_ms, RenderCause::None};
    }

    // Flush any outstanding deferred render unconditionally (end of a burst /
    // stream). Guarantees the trailing frame is never dropped: at least one
    // render happens after the last delta. Returns the flushed RenderEvent, or
    // RenderCause::None when nothing was pending.
    RenderEvent flush() noexcept {
        if (pending_) {
            pending_ = false;
            return RenderEvent{pending_due_ms_, RenderCause::Timer};
        }
        return RenderEvent{pending_due_ms_, RenderCause::None};
    }

private:
    std::int64_t window_ms_{16};
    std::int64_t pending_due_ms_{0};
    bool pending_{false};
    bool first_delta_seen_{false};
};

} // namespace rtai
