// Pure core: turns Deepgram results into conversational turns ("falas").
//
// A turn is closed when the speaker has really stopped:
//   * a final arrives with from_finalize (our VAD closed the turn and Deepgram
//     flushed), or
//   * our VAD closed the turn (LocalTurnEnd) and the last final already carried
//     speech_final, or
//   * LocalTurnEnd + boundary_grace_ms elapsed (Finalize isn't guaranteed to
//     answer when little audio was buffered), or
//   * Deepgram's UtteranceEnd (if enabled), or
//   * nothing new for stale_ms (VAD never closed, e.g. constant background
//     noise on the mic).
// Deepgram's speech_final alone does NOT close a turn: with 300 ms endpointing
// it fires on short mid-sentence pauses and would split questions in half.
//
// Not thread-safe: owned by the copilot engine's single orchestrator thread.
#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "rtai/interfaces.hpp"
#include "rtai/text_util.hpp"

namespace rtai {

struct Turn {
    AudioSource source{AudioSource::Loopback};
    std::string text;
    std::int64_t start_ms{0}; // session clock
    std::int64_t end_ms{0};
    std::uint64_t seq{0};
};

struct SpeculativeCandidate {
    AudioSource source{AudioSource::Loopback};
    std::string text;
    std::int64_t t_ms{0};
};

struct TurnAssemblerConfig {
    // 450 ms of boundary grace: allows natural pauses between clauses
    // (e.g. "Pensando agora no Tech Finance... qual foi a 1ª entrega?")
    // without prematurely splitting the recruiter's single question into two.
    std::int64_t boundary_grace_ms{450};
    std::int64_t stale_ms{1400};
    std::int64_t speculative_pause_ms{160};
    std::int64_t endpointing_ms{300};
};

class TurnAssembler {
public:
    explicit TurnAssembler(TurnAssemblerConfig cfg = {}) : cfg_(cfg) {}

    // Feed one event at session time now_ms; returns turns closed by it.
    std::vector<Turn> on_event(const TranscriptEvent& ev, std::int64_t now_ms) {
        std::vector<Turn> out;
        Lane& l = lane(ev.source);
        switch (ev.kind) {
            case TranscriptKind::Transcript:
                if (ev.is_final) {
                    if (!text::trim(ev.text).empty()) {
                        if (l.start_ms < 0) l.start_ms = now_ms;
                        l.committed = text::join_space(l.committed, ev.text);
                        l.last_final_ms = now_ms;
                    }
                    l.interim.clear();
                    l.last_final_speech_final = ev.speech_final;
                    l.last_interim_ms = -1;
                    l.speculative_fired = false;
                    if (ev.from_finalize) {
                        close(ev.source, now_ms, out);
                    }
                } else {
                    std::string trimmed = text::trim(ev.text);
                    if (trimmed != l.interim) {
                        l.interim = trimmed;
                        if (!l.interim.empty() && l.start_ms < 0) l.start_ms = now_ms;
                        l.last_interim_ms = now_ms;
                        l.speculative_fired = false;
                    }
                }
                break;
            case TranscriptKind::UtteranceEnd:
                close(ev.source, now_ms, out);
                break;
            case TranscriptKind::LocalTurnEnd:
                l.boundary_ms = now_ms;
                if (l.last_final_speech_final) {
                    close(ev.source, now_ms, out);
                }
                break;
            case TranscriptKind::SpeechStarted:
                break;
        }
        return out;
    }

    // Periodic check. The engine calls it on its tick and as soon as
    // next_deadline_ms() is reached, so a turn closes on time instead of up to
    // one tick late.
    std::vector<Turn> tick(std::int64_t now_ms) {
        std::vector<Turn> out;
        for (AudioSource s : {AudioSource::Microphone, AudioSource::Loopback}) {
            Lane& l = lane(s);
            if (l.boundary_ms >= 0) {
                const std::int64_t grace = effective_grace(l);
                if (now_ms - l.boundary_ms >= grace) {
                    close(s, now_ms, out);
                }
            } else if (l.boundary_ms < 0 && !l.committed.empty() && l.interim.empty() &&
                       now_ms - l.last_final_ms >= cfg_.stale_ms) {
                close(s, now_ms, out);
            }
        }
        return out;
    }

    // Speculative pre-fire without closing: stable interim -> candidate.
    std::vector<SpeculativeCandidate> poll_speculative(std::int64_t now_ms) {
        std::vector<SpeculativeCandidate> out;
        for (AudioSource s : {AudioSource::Microphone, AudioSource::Loopback}) {
            Lane& l = lane(s);
            if (l.speculative_fired) continue;
            if (l.boundary_ms >= 0) continue;
            const std::string live = text::join_space(l.committed, l.interim);
            if (live.empty() || text::word_count(live) < 3) continue;
            if (l.last_interim_ms < 0) continue;
            if (now_ms - l.last_interim_ms < cfg_.speculative_pause_ms) continue;
            if (live == l.last_speculative_text) continue;
            l.speculative_fired = true;
            l.last_speculative_text = live;
            out.push_back(SpeculativeCandidate{s, live, now_ms});
        }
        return out;
    }

    // Earliest session time later than `after_ms` at which tick() or
    // poll_speculative() can produce something (a grace/stale close or a
    // stable-interim candidate); -1 when nothing is pending. Conservative:
    // waking at it may find nothing to do. Deadlines at or before `after_ms`
    // were already checked by the caller and are skipped.
    [[nodiscard]] std::int64_t next_deadline_ms(std::int64_t after_ms = -1) const noexcept {
        std::int64_t next = -1;
        auto take = [&next, after_ms](std::int64_t t) {
            if (t > after_ms && (next < 0 || t < next)) next = t;
        };
        for (const Lane& l : lanes_) {
            if (l.boundary_ms >= 0) {
                take(l.boundary_ms + effective_grace(l));
                continue; // a closing lane neither goes stale nor speculates
            }
            if (!l.committed.empty() && l.interim.empty() && l.last_final_ms >= 0) take(l.last_final_ms + cfg_.stale_ms);
            if (!l.speculative_fired && l.last_interim_ms >= 0) take(l.last_interim_ms + cfg_.speculative_pause_ms);
        }
        return next;
    }

    // Committed finals of the open turn plus the current interim: what the
    // overlay shows live and what a manual trigger answers to.
    [[nodiscard]] std::string live_text(AudioSource s) const {
        const Lane& l = lanes_[static_cast<std::size_t>(s)];
        return text::join_space(l.committed, l.interim);
    }

    // Session time the open turn on `s` started (-1: no open turn).
    [[nodiscard]] std::int64_t open_turn_start_ms(AudioSource s) const {
        const Lane& l = lanes_[static_cast<std::size_t>(s)];
        return (l.committed.empty() && l.interim.empty()) ? -1 : l.start_ms;
    }

    [[nodiscard]] bool has_open_turn(AudioSource s) const {
        const Lane& l = lanes_[static_cast<std::size_t>(s)];
        return !l.committed.empty() || !l.interim.empty();
    }

private:
    struct Lane {
        std::string committed;
        std::string interim;
        std::int64_t start_ms{-1};
        std::int64_t last_final_ms{-1};
        std::int64_t boundary_ms{-1};
        bool last_final_speech_final{false};
        std::int64_t last_interim_ms{-1};
        bool speculative_fired{false};
        std::string last_speculative_text;
    };

    Lane& lane(AudioSource s) { return lanes_[static_cast<std::size_t>(s)]; }

    static bool ends_with_terminator(const std::string& s) {
        std::string t = text::trim(s);
        if (t.empty()) return false;
        const char c = t.back();
        return c == '?' || c == '.' || c == '!' || c == ';' || c == ':';
    }

    std::int64_t effective_grace(const Lane& /*l*/) const {
        return cfg_.boundary_grace_ms;
    }

    void close(AudioSource s, std::int64_t now_ms, std::vector<Turn>& out) {
        Lane& l = lane(s);
        std::string full = text::trim(text::join_space(l.committed, l.interim));
        if (!full.empty()) {
            // Deduplication & Stitching:
            // 1. If this exact text is identical to the immediately preceding turn on the same lane, ignore it.
            // 2. If the immediately preceding turn ended very recently (< 1200ms) on the same lane, and this turn
            //    completes a sentence or was split by a breath pause, stitch them together into one complete turn!
            if (!out.empty() && out.back().source == s && out.back().text == full) {
                l = Lane{};
                return;
            }
            if (!out.empty() && out.back().source == s && (now_ms - out.back().end_ms < 1200)) {
                out.back().text = text::join_space(out.back().text, full);
                out.back().end_ms = now_ms;
                l = Lane{};
                return;
            }
            Turn t;
            t.source = s;
            t.text = std::move(full);
            t.start_ms = l.start_ms >= 0 ? l.start_ms : now_ms;
            t.end_ms = now_ms;
            t.seq = ++seq_;
            out.push_back(std::move(t));
        }
        l = Lane{};
    }

    TurnAssemblerConfig cfg_;
    std::array<Lane, 2> lanes_{};
    std::uint64_t seq_{0};
};

} // namespace rtai
