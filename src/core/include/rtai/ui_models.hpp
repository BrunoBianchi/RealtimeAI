// Pure core: platform-independent models behind the overlay HUD, kept here
// so they are unit-tested on any OS:
//   * TranscriptStrip  - recent speech of both lanes, cut into short phrase
//                        "pills" for the live strip under the toolbar;
//   * LineEdit         - single-line text editing (chat box), UTF-16 so it
//                        maps 1:1 onto Win32 WM_CHAR / DirectWrite positions;
//   * pick_density     - responsive breakpoints: the richest toolbar variant
//                        whose measured width fits.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "rtai/interfaces.hpp"
#include "rtai/text_util.hpp"

// Glanceable HUD constants (Req 1)
// The reference HUD is a wide, glanceable card. Keep enough room for the
// action bar labels while still allowing a compact layout on small displays.
constexpr float kHudW = 860.0f;
constexpr float kMinW = 420.0f;
constexpr float kMaxW = 1100.0f;
constexpr float kAnchorTopMinDIP = 8.0f;
constexpr float kAnchorTopMaxDIP = 10.0f;
constexpr float kMaxHeightFractionMin = 0.1f;
constexpr float kMaxHeightFractionMax = 1.0f;
constexpr float kMaxHeightFractionDefault = 0.6f;

// Pulse_Bar height band in DIP (Req 13.1, 13.5): RMS 0.0 -> 2 DIP, >=1.0 -> 24 DIP.
constexpr float kPulseBarMinDIP = 2.0f;
constexpr float kPulseBarMaxDIP = 24.0f;

namespace rtai::ui {

// ---------------------------------------------------------------------------
// TranscriptStrip
// ---------------------------------------------------------------------------

struct StripChunk {
    AudioSource source{AudioSource::Loopback};
    std::string text;
    bool live{false};          // still being spoken (interim)
    bool speaker_change{false}; // first chunk of a run by this speaker
};

class TranscriptStrip {
public:
    explicit TranscriptStrip(std::size_t max_items = 16) : max_items_(max_items) {}

    // Mirrors TranscriptUpdateEvent: `text` is the whole live text of the
    // lane's open turn, or the final text when `closed`.
    void on_update(AudioSource src, const std::string& text, bool closed) {
        Item* open = nullptr;
        for (auto it = items_.rbegin(); it != items_.rend(); ++it) {
            if (it->source == src) {
                if (!it->closed) open = &*it;
                break;
            }
        }
        if (text::trim(text).empty()) {
            // Interim cleared (e.g. turn discarded): drop the open item.
            if (open && !closed) {
                for (auto it = items_.begin(); it != items_.end(); ++it) {
                    if (&*it == open) {
                        items_.erase(it);
                        break;
                    }
                }
            }
            return;
        }
        if (open) {
            open->text = text;
            open->closed = closed;
        } else {
            items_.push_back(Item{src, text, closed});
            while (items_.size() > max_items_) items_.pop_front();
        }
        ++version_;
    }

    void clear() {
        items_.clear();
        ++version_;
    }

    [[nodiscard]] bool empty() const noexcept { return items_.empty(); }
    [[nodiscard]] std::uint64_t version() const noexcept { return version_; }

    // Phrase chunks, oldest first. A chunk ends at sentence punctuation or
    // when adding the next word would pass `max_chars` (code points).
    [[nodiscard]] std::vector<StripChunk> chunks(std::size_t max_chars = 24) const {
        std::vector<StripChunk> out;
        const Item* prev = nullptr;
        for (const auto& item : items_) {
            const bool change = !prev || prev->source != item.source;
            bool first = true;
            std::string cur;
            std::size_t cur_len = 0;
            auto flush = [&] {
                if (cur.empty()) return;
                out.push_back(StripChunk{item.source, cur, !item.closed, change && first});
                first = false;
                cur.clear();
                cur_len = 0;
            };
            for (const auto& w : words(item.text)) {
                const std::size_t wl = text::utf8_length(w);
                if (!cur.empty() && cur_len + 1 + wl > max_chars) flush();
                if (!cur.empty()) {
                    cur.push_back(' ');
                    ++cur_len;
                }
                cur += w;
                cur_len += wl;
                const char last = w.back();
                if (last == '.' || last == '?' || last == '!' || last == ';') flush();
            }
            flush();
            prev = &item;
        }
        return out;
    }

private:
    struct Item {
        AudioSource source;
        std::string text;
        bool closed;
    };

    static std::vector<std::string> words(const std::string& s) {
        std::vector<std::string> out;
        std::size_t i = 0;
        while (i < s.size()) {
            while (i < s.size() && text::is_space(s[i])) ++i;
            std::size_t j = i;
            while (j < s.size() && !text::is_space(s[j])) ++j;
            if (j > i) out.emplace_back(s.substr(i, j - i));
            i = j;
        }
        return out;
    }

    std::size_t max_items_;
    std::deque<Item> items_;
    std::uint64_t version_{0};
};

// ---------------------------------------------------------------------------
// LineEdit
// ---------------------------------------------------------------------------

class LineEdit {
public:
    explicit LineEdit(std::size_t max_len = 2000) : max_len_(max_len) {}

    [[nodiscard]] const std::u16string& text() const noexcept { return text_; }
    [[nodiscard]] std::size_t caret() const noexcept { return caret_; }
    [[nodiscard]] bool all_selected() const noexcept { return all_selected_ && !text_.empty(); }
    [[nodiscard]] bool empty() const noexcept { return text_.empty(); }

    void clear() {
        text_.clear();
        caret_ = 0;
        all_selected_ = false;
    }

    void set_text(std::u16string t) {
        text_ = std::move(t);
        if (text_.size() > max_len_) text_.resize(max_len_);
        caret_ = text_.size();
        all_selected_ = false;
    }

    // Inserts typed or pasted text. Control characters are dropped and line
    // breaks become spaces (single-line field).
    void insert(std::u16string_view s) {
        if (all_selected()) clear();
        all_selected_ = false;
        std::u16string clean;
        for (char16_t c : s) {
            if (c == u'\r') continue;
            if (c == u'\n' || c == u'\t') c = u' ';
            if (c < 0x20 || c == 0x7F) continue;
            clean.push_back(c);
        }
        const std::size_t room = max_len_ > text_.size() ? max_len_ - text_.size() : 0;
        if (clean.size() > room) {
            clean.resize(room);
            if (!clean.empty() && is_high(clean.back())) clean.pop_back(); // don't split a pair
        }
        text_.insert(caret_, clean);
        caret_ += clean.size();
    }

    void backspace() {
        if (all_selected()) {
            clear();
            return;
        }
        if (caret_ == 0) return;
        const std::size_t from = prev_pos(caret_);
        text_.erase(from, caret_ - from);
        caret_ = from;
    }

    void del() {
        if (all_selected()) {
            clear();
            return;
        }
        if (caret_ >= text_.size()) return;
        text_.erase(caret_, next_pos(caret_) - caret_);
    }

    // Ctrl+Backspace: delete the word before the caret.
    void delete_word_back() {
        if (all_selected()) {
            clear();
            return;
        }
        std::size_t i = caret_;
        while (i > 0 && text_[i - 1] == u' ') --i;
        while (i > 0 && text_[i - 1] != u' ') --i;
        text_.erase(i, caret_ - i);
        caret_ = i;
    }

    void left() {
        all_selected_ = false;
        if (caret_ > 0) caret_ = prev_pos(caret_);
    }
    void right() {
        all_selected_ = false;
        if (caret_ < text_.size()) caret_ = next_pos(caret_);
    }
    void home() {
        all_selected_ = false;
        caret_ = 0;
    }
    void end() {
        all_selected_ = false;
        caret_ = text_.size();
    }
    void select_all() {
        all_selected_ = true;
        caret_ = text_.size();
    }
    void set_caret(std::size_t pos) {
        all_selected_ = false;
        caret_ = std::min(pos, text_.size());
        if (caret_ > 0 && caret_ < text_.size() && is_low(text_[caret_]) && is_high(text_[caret_ - 1])) --caret_;
    }

private:
    static bool is_high(char16_t c) { return c >= 0xD800 && c <= 0xDBFF; }
    static bool is_low(char16_t c) { return c >= 0xDC00 && c <= 0xDFFF; }
    std::size_t prev_pos(std::size_t p) const {
        if (p >= 2 && is_low(text_[p - 1]) && is_high(text_[p - 2])) return p - 2;
        return p - 1;
    }
    std::size_t next_pos(std::size_t p) const {
        if (p + 1 < text_.size() && is_high(text_[p]) && is_low(text_[p + 1])) return p + 2;
        return p + 1;
    }

    std::u16string text_;
    std::size_t caret_{0};
    bool all_selected_{false};
    std::size_t max_len_;
};

// ---------------------------------------------------------------------------
// Responsive density
// ---------------------------------------------------------------------------

// widths[i] = width the row needs at density i, from richest (0) to most
// compact (n-1). Returns the richest density that fits; the most compact one
// when none does.
inline std::size_t pick_density(float available, const std::vector<float>& widths) {
    for (std::size_t i = 0; i < widths.size(); ++i) {
        if (widths[i] <= available) return i;
    }
    return widths.empty() ? 0 : widths.size() - 1;
}

// ---------------------------------------------------------------------------
// Small animation helpers (UI thread)
// ---------------------------------------------------------------------------

// Exponential approach: moves `cur` toward `target` with a time constant of
// `tau_ms`; returns true while still moving.
inline bool approach(float& cur, float target, float dt_ms, float tau_ms, float epsilon = 0.002f) {
    if (tau_ms <= 0.0f) {
        cur = target;
        return false;
    }
    const float k = 1.0f - std::exp(-dt_ms / tau_ms);
    cur += (target - cur) * k;
    if (std::fabs(target - cur) < epsilon) {
        cur = target;
        return false;
    }
    return true;
}

inline float clamp_width(float w) { return std::clamp(w, kMinW, kMaxW); }
inline float clamp_height_fraction(float f) { return std::clamp(f, kMaxHeightFractionMin, kMaxHeightFractionMax); }
inline float window_height(float content_h, float frac, float work_h) { return std::min(content_h, clamp_height_fraction(frac) * work_h); }

// Maps a capture RMS level to a Pulse_Bar micro-bar height in DIP (Req 13.1,
// 13.5). Pure, monotonic non-decreasing in `rms`: RMS <= 0.0 (or unavailable /
// NaN) -> 2 DIP; RMS >= 1.0 -> 24 DIP; linear interpolation in between. NaN is
// treated as unavailable and floors to the minimum so a bad level never
// collapses or spikes the bar.
inline float pulse_bar_height(float rms) {
    if (std::isnan(rms) || rms <= 0.0f) return kPulseBarMinDIP;
    if (rms >= 1.0f) return kPulseBarMaxDIP;
    return kPulseBarMinDIP + rms * (kPulseBarMaxDIP - kPulseBarMinDIP);
}

// ---------------------------------------------------------------------------
// Top-Center anchoring and multi-monitor placement (Req 1.1, 1.4, 1.5, 1.9)
// ---------------------------------------------------------------------------

// Win32-free geometry so the anchoring math is unit-tested on any OS. The
// overlay bridges these to POINT / RECT in overlay_window.cpp: Win32 RECT is
// {left, top, right, bottom} and these match it field-for-field so the
// conversion is a plain copy.
struct UiPoint {
    int x{0};
    int y{0};
};

struct UiRect {
    int left{0};
    int top{0};
    int right{0};
    int bottom{0};

    [[nodiscard]] constexpr int width() const noexcept { return right - left; }
    [[nodiscard]] constexpr int height() const noexcept { return bottom - top; }
    [[nodiscard]] constexpr bool contains(UiPoint p) const noexcept {
        return p.x >= left && p.x < right && p.y >= top && p.y < bottom;
    }
};

// Resolved placement for the HUD window, in DIP. `work_area` is the work area
// of the chosen monitor (so callers can clamp height to it, Req 1.6/1.7).
struct AnchorResult {
    int x_dip{0};
    int y_dip{0};
    UiRect work_area{};
};

// Top anchor used by default: keeps the top edge inside the inclusive
// [8, 10] DIP band required by Req 1.1.
inline int clamp_anchor_top(float top_dip = (kAnchorTopMinDIP + kAnchorTopMaxDIP) / 2.0f) {
    const float v = std::clamp(top_dip, kAnchorTopMinDIP, kAnchorTopMaxDIP);
    return static_cast<int>(std::lround(v));
}

// Centers `eff_width` horizontally in `work`, Top-Center, with the top edge in
// the [8, 10] DIP band. x = round((work.width - eff_width) / 2), clamped to the
// work area's left edge so a window wider than the monitor never starts off-screen.
inline AnchorResult top_center(const UiRect& work, float eff_width) {
    const int top = clamp_anchor_top();
    const int x = static_cast<int>(std::lround((static_cast<float>(work.width()) - eff_width) / 2.0f));
    AnchorResult r;
    r.work_area = work;
    r.x_dip = work.left + std::max(0, x);
    r.y_dip = work.top + top;
    return r;
}

// Resolves the HUD position and monitor (Req 1.1, 1.4, 1.5, 1.9):
//   * no persisted center            -> Top-Center of the primary work area;
//   * persisted center on a monitor  -> Top-Center of that monitor's work area;
//   * persisted center off every monitor (monitor_of returns nullopt)
//                                    -> Top-Center of the primary with the
//                                       default width (Req 1.9).
// `monitor_of(center)` returns the work area of the monitor that contains the
// persisted center, or nullopt when no monitor does. It is a callback so the
// math stays Win32-free; the overlay wires it to MonitorFromPoint + GetMonitorInfo.
inline AnchorResult resolve_anchor(std::optional<UiPoint> persisted_center,
                                   float eff_width,
                                   const UiRect& primary_work,
                                   const std::function<std::optional<UiRect>(UiPoint)>& monitor_of) {
    if (!persisted_center) {
        // No persisted position: primary work area, Top-Center (Req 1.5).
        return top_center(primary_work, clamp_width(eff_width));
    }
    std::optional<UiRect> work = monitor_of ? monitor_of(*persisted_center) : std::nullopt;
    if (!work) {
        // Persisted center intersects no monitor: fall back to Top-Center of
        // the primary with default dimensions (Req 1.9).
        return top_center(primary_work, kHudW);
    }
    // Persisted center sits on a monitor: Top-Center of that monitor (Req 1.5).
    return top_center(*work, clamp_width(eff_width));
}

// ---------------------------------------------------------------------------
// Anchor normalization (Req 3.3, 3.4)
// ---------------------------------------------------------------------------

// Exactly 3 anchors are always rendered under the headline. Given the 0..N
// anchors a response actually produced, this returns a vector of exactly 3:
// the available anchors in their original order, with the remaining slots
// filled by empty (default-constructed) anchors. More than 3 are truncated to
// the first 3, keeping the input order. `Anchor` is the caller's own type
// (e.g. std::string or FormattedLine); an empty anchor is a value-initialized
// `Anchor{}`.
inline constexpr std::size_t kAnchorCount = 3;

template <typename Anchor>
[[nodiscard]] std::vector<Anchor> normalize_anchors(const std::vector<Anchor>& available) {
    std::vector<Anchor> out;
    out.reserve(kAnchorCount);
    const std::size_t keep = std::min(available.size(), kAnchorCount);
    for (std::size_t i = 0; i < keep; ++i) out.push_back(available[i]);
    while (out.size() < kAnchorCount) out.emplace_back();
    return out;
}

// ---------------------------------------------------------------------------
// Trigger Lock: frozen question (Req 8)
// ---------------------------------------------------------------------------

// Maximum code points shown in the card header before the question is
// truncated with an ellipsis (Req 8.4). `full` always keeps the complete
// captured text; only `display` is clipped.
inline constexpr std::size_t kFrozenQuestionMaxChars = 280;

// The question that triggered the current answer, frozen in the card header at
// the moment the suggestion fires (SuggestionStartedEvent). Once captured it is
// immutable for the life of the answer: the stream of transcript updates that
// keeps arriving touches only the live strip, never this struct (Req 8.2, 8.3).
// A plain POD so it lives in the flat UI model and is unit tested off Win32.
struct FrozenQuestion {
    std::string full;               // verbatim trigger text, kept complete (Req 8.4)
    std::string display;            // first 280 code points + "…" when longer (Req 8.4)
    bool present{false};            // false -> absence indicator + quote icon (Req 8.5)
    std::uint64_t suggestion_id{0}; // id of the suggestion this question froze for
};

// Builds the display text from the full captured text: the text itself when it
// is at most 280 code points, otherwise the first 280 code points followed by a
// single-character ellipsis "…" (U+2026, UTF-8 E2 80 A6). The cut lands on a
// code-point boundary so multi-byte UTF-8 is never split (Req 8.4).
inline std::string frozen_question_display(std::string_view full) {
    if (text::utf8_length(full) <= kFrozenQuestionMaxChars) return std::string(full);
    // Walk 280 code points in, stepping over whole UTF-8 sequences.
    std::size_t bytes = 0;
    std::size_t cp = 0;
    while (bytes < full.size() && cp < kFrozenQuestionMaxChars) {
        const std::size_t n = text::utf8_seq_len(static_cast<unsigned char>(full[bytes]));
        bytes += (n == 0 ? 1 : n);
        ++cp;
    }
    if (bytes > full.size()) bytes = full.size();
    std::string out(full.substr(0, bytes));
    out += "\xE2\x80\xA6"; // "…"
    return out;
}

// Captures the trigger text of a firing suggestion into a frozen question
// (Req 8.1, 8.4, 8.5). `present` is false when there is no usable question
// (empty or whitespace-only trigger text), so the header shows an absence
// indicator while keeping the quote icon; `display` is cleared in that case and
// `full` preserves whatever was captured verbatim.
inline FrozenQuestion freeze_question(std::string_view trigger_text, std::uint64_t suggestion_id) {
    FrozenQuestion q;
    q.suggestion_id = suggestion_id;
    q.full = std::string(trigger_text);
    q.present = !text::trim(trigger_text).empty();
    q.display = q.present ? frozen_question_display(q.full) : std::string{};
    return q;
}

// Applies a transcript update against a frozen question. The live strip
// consumes the new speech elsewhere; here the question is byte-for-byte
// unchanged, independent of how many updates arrive (Req 8.2, 8.3). Returning
// the input by value makes the "never mutates the frozen question" invariant
// the function's whole observable behavior, so it is directly property-testable.
// A template on the event type keeps this header dependency-light (like
// SuggestionQueue<T>); the overlay/tests pass a real TranscriptUpdateEvent.
template <typename TranscriptEvent>
[[nodiscard]] FrozenQuestion on_transcript_update(const FrozenQuestion& q, const TranscriptEvent&) {
    return q;
}

// ---------------------------------------------------------------------------
// Pending-suggestion queue (Req 9.5)
// ---------------------------------------------------------------------------

// Pin on Speak buffers suggestions that cannot replace the current card yet
// (the user is speaking or the 4000 ms window has not elapsed). The queue is a
// FIFO capped at `kSuggestionQueueCap`: push appends to the back and, once the
// size would exceed the cap, the oldest entry at the front is dropped. The
// design (Data Models) holds SuggestionStartedEvent here; it is kept a template
// on the element type so the FIFO/cap logic is unit-tested outside Win32 with
// any lightweight element. The overlay instantiates
// SuggestionQueue<SuggestionStartedEvent>.
inline constexpr std::size_t kSuggestionQueueCap = 5;

template <typename T>
struct SuggestionQueue {
    std::deque<T> pending;

    // Appends `e` to the back; when the size passes the cap, discards the
    // oldest entries from the front so at most `kSuggestionQueueCap` remain.
    void push(T e) {
        pending.push_back(std::move(e));
        while (pending.size() > kSuggestionQueueCap) pending.pop_front();
    }

    [[nodiscard]] std::size_t size() const noexcept { return pending.size(); }
    [[nodiscard]] bool empty() const noexcept { return pending.empty(); }
};

// ---------------------------------------------------------------------------
// Jitter-free streaming buffer (Req 6.2, 6.5, 6.6)
// ---------------------------------------------------------------------------

// A word separator is whitespace or ASCII punctuation. Deltas arrive mid-word
// during streaming, so we only ever confirm text up to the last separator and
// hold the trailing (possibly partial) word in `pending` until its own
// separator — or the end of the stream — arrives. This is what keeps a half
// word from flickering at the edge of the card.
inline bool is_word_separator(char c) noexcept {
    const auto u = static_cast<unsigned char>(c);
    if (u >= 0x80) return false; // multibyte UTF-8 lead/continuation: part of a word
    if (text::is_space(c)) return true;
    // ASCII punctuation ranges (everything printable that is not 0-9/A-Z/a-z).
    return (u >= 0x21 && u <= 0x2F) || (u >= 0x3A && u <= 0x40) ||
           (u >= 0x5B && u <= 0x60) || (u >= 0x7B && u <= 0x7E);
}

// Splits streamed text into `committed` (always ends at a word separator, so
// it only holds whole words) and `pending` (the trailing run with no separator
// yet). `commit_words` appends a delta then moves everything up to and
// including the last separator into `committed`; `complete` flushes whatever is
// left so the final text is byte-for-byte the concatenation of every delta.
struct StreamBuffer {
    std::string committed; // only ends in a word separator (Req 6.2, 6.5)
    std::string pending;   // trailing run without a separator, retained (Req 6.2)

    // Req 6.2, 6.5: fold the delta into `pending`, then promote everything up
    // to and including the last separator into `committed`, leaving only the
    // partial tail behind so no half word is ever confirmed.
    void commit_words(std::string_view delta) {
        pending.append(delta);
        std::size_t last_sep = std::string::npos;
        for (std::size_t i = pending.size(); i > 0; --i) {
            if (is_word_separator(pending[i - 1])) {
                last_sep = i - 1;
                break;
            }
        }
        if (last_sep == std::string::npos) return; // no whole word yet
        committed.append(pending, 0, last_sep + 1);
        pending.erase(0, last_sep + 1);
    }

    // Req 6.6: on SuggestionCompletedEvent, confirm the retained tail so the
    // final word (which may have no trailing separator) becomes visible.
    void complete() {
        committed += pending;
        pending.clear();
    }

    void clear() noexcept {
        committed.clear();
        pending.clear();
    }

    // Full text seen so far, confirmed plus retained tail. Equal to the
    // concatenation of every delta passed to commit_words.
    [[nodiscard]] std::string full() const { return committed + pending; }
};

// ---------------------------------------------------------------------------
// Answer history and "N of M" navigation (Req 12.3, 15.4/15.5)
// ---------------------------------------------------------------------------

// The history keeps the most recent answers so Alt+Up/Down can walk back
// through them. It is capped at `kMaxHistory` (50, Req 12.3): pushing past the
// cap drops the oldest entry from the front, FIFO. The footer shows the current
// position as "N of M" where N = cursor + 1 and M = items.size(), with the
// invariant 1 <= N <= M <= 999 whenever the history is non-empty (Req 15.4).
// The cursor is always kept inside [0, size - 1] so navigation can never point
// past either end.
//
// Like SuggestionQueue<T>, this is a template on the item type so the cap and
// cursor math are unit-tested outside Win32 with any lightweight element; the
// overlay instantiates History<AnswerCard>. The "N of M" display caps M at 999
// to match the footer budget (Req 15.4); the history itself never holds more
// than kMaxHistory items so M is really bounded by the cap, but the clamp keeps
// the contract explicit for callers.
inline constexpr std::size_t kMaxHistory = 50;
inline constexpr std::size_t kHistoryPositionMax = 999;

// A 1-based position for the footer: `n` in [1, m], `m` in [1, 999]. `present`
// is false for an empty history (nothing to show as "N of M").
struct HistoryPosition {
    std::size_t n{0};       // 1-based current index (cursor + 1)
    std::size_t m{0};       // total count, clamped to [1, 999] when present
    bool present{false};    // false when the history is empty
};

template <typename Item>
struct History {
    std::deque<Item> items;
    std::size_t cursor{0};

    // Appends a new answer at the back and points the cursor at it (the newest
    // answer is what the user just saw). Dropping past the cap removes the
    // oldest entries from the front; the cursor is then re-clamped so it still
    // lands on a valid item (Req 12.3).
    void push(Item item) {
        items.push_back(std::move(item));
        while (items.size() > kMaxHistory) items.pop_front();
        cursor = items.empty() ? 0 : items.size() - 1;
    }

    // Alt+Up: step toward older answers (lower index). No-op at the front.
    void prev() noexcept {
        if (cursor > 0) --cursor;
    }

    // Alt+Down: step toward newer answers (higher index). No-op at the back.
    void next() noexcept {
        if (!items.empty() && cursor + 1 < items.size()) ++cursor;
    }

    [[nodiscard]] std::size_t size() const noexcept { return items.size(); }
    [[nodiscard]] bool empty() const noexcept { return items.empty(); }

    // Re-clamps the cursor into the valid range. Harmless to call after any
    // external mutation of `items`; push/prev/next already keep the invariant.
    void clamp_cursor() noexcept {
        if (items.empty()) {
            cursor = 0;
        } else if (cursor >= items.size()) {
            cursor = items.size() - 1;
        }
    }

    // The footer "N of M" position with N = cursor + 1 and M = size, honoring
    // 1 <= N <= M <= 999. Returns `present == false` for an empty history.
    [[nodiscard]] HistoryPosition position() const noexcept {
        HistoryPosition p;
        if (items.empty()) return p; // present == false, n == m == 0
        const std::size_t cur = cursor < items.size() ? cursor : items.size() - 1;
        const std::size_t m = std::min(items.size(), kHistoryPositionMax);
        std::size_t n = cur + 1;
        if (n > m) n = m; // keep N <= M even if the cursor sits past the clamp
        p.n = n;
        p.m = m;
        p.present = true;
        return p;
    }
};

} // namespace rtai::ui
