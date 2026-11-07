#pragma once
// Pure timing helper for the "speech end to first visible text" measurement
// (speech_end_to_visible_ms in the session JSONL). No clock and no state.
#include <cstdint>
#include <deque>

namespace rtai {

// The VAD's commit edge fires after this much silence (commit_silence_frames in
// frame_vad.hpp), so the speech itself ended this long before the edge.
inline constexpr std::int64_t kVadCommitSilenceMs = 120;

// A speech end this soon after the first visible text still belongs to the same
// question: speculation can show text before the local VAD reports the silence.
// A later one is the interviewer talking again while the answer streams.
inline constexpr std::int64_t kSpeechEndLookaheadMs = 500;

// `speech_ends` holds speech end times in ascending order, on the same clock as
// `first_visible_ms`. Returns first_visible_ms minus the speech end of the same
// question (negative when the text came first), or -1 without data. A real
// result of exactly -1 is reported as 0 so it can't be mistaken for no data.
[[nodiscard]] inline std::int64_t speech_end_to_visible(const std::deque<std::int64_t>& speech_ends,
                                                        std::int64_t first_visible_ms) noexcept {
    if (first_visible_ms < 0) return -1;
    bool found = false;
    std::int64_t end = 0;
    for (const std::int64_t e : speech_ends) {
        if (e <= first_visible_ms) {
            end = e;
            found = true;
        } else {
            if (e - first_visible_ms <= kSpeechEndLookaheadMs) {
                end = e;
                found = true;
            }
            break;
        }
    }
    if (!found) return -1;
    const std::int64_t delta = first_visible_ms - end;
    return delta == -1 ? 0 : delta;
}

} // namespace rtai
