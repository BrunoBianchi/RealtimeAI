// Pure core — accumulates every closed turn of a session in RAM so the
// Cold_Path (Jev dashboard) can score the full conversation at Finalize time.
//
// Owned by the copilot engine's single orchestrator thread; not thread-safe.
// Fed from `on_turn(const Turn&)` right after `publish(TurnEvent{turn})`, for
// every closed turn of both lanes, before trigger evaluation.
//
// Track mapping (Req 6.1/6.2):
//   AudioSource::Loopback   -> TranscriptTrack::Interviewer ("entrevistador")
//   AudioSource::Microphone -> TranscriptTrack::Candidate   ("candidato")
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "rtai/audio_format.hpp"
#include "rtai/turn_assembler.hpp"

namespace rtai {

// Which conversational role a closed turn belongs to.
enum class TranscriptTrack : std::uint8_t {
    Interviewer, // Loopback lane ("Outros")
    Candidate,   // Microphone lane ("Você")
};

// pt-BR label for a track, used when rendering the full transcript.
constexpr const char* track_tag(TranscriptTrack t) noexcept {
    switch (t) {
        case TranscriptTrack::Interviewer: return "Interviewer";
        case TranscriptTrack::Candidate:   return "Candidate";
    }
    return "?";
}

// One closed turn recorded verbatim (Req 6.4).
struct TranscriptTurn {
    TranscriptTrack track{TranscriptTrack::Interviewer};
    std::string text;              // verbatim, idêntico ao turno fechado (Req 6.4)
    std::int64_t start_ms{0};
    std::int64_t end_ms{0};
    std::uint64_t seq{0};
};

// In-RAM accumulator owned by the orchestrator thread (not thread-safe).
class SessionTranscript {
public:
    // Appends a closed turn preserving chronological order (Req 6.1/6.2/6.3)
    // and the verbatim text (Req 6.4). Loopback maps to Interviewer, every
    // other source (Microphone) maps to Candidate.
    void append(const Turn& t) {
        turns_.push_back(TranscriptTurn{
            t.source == AudioSource::Loopback ? TranscriptTrack::Interviewer
                                              : TranscriptTrack::Candidate, // Req 6.1/6.2
            t.text, t.start_ms, t.end_ms, t.seq});                          // Req 6.4 verbatim
    }

    [[nodiscard]] const std::vector<TranscriptTurn>& turns() const noexcept {
        return turns_;
    }

    [[nodiscard]] bool empty() const noexcept { return turns_.empty(); }
    [[nodiscard]] std::size_t size() const noexcept { return turns_.size(); }

    // Full text for the Jev "state" field: one labeled line per turn, in the
    // chronological order they were closed, with the verbatim turn text
    // preserved byte-for-byte.
    [[nodiscard]] std::string render() const {
        std::string out;
        for (const TranscriptTurn& t : turns_) {
            out += track_tag(t.track);
            out += ": ";
            out += t.text;
            out += '\n';
        }
        return out;
    }

private:
    std::vector<TranscriptTurn> turns_;
};

} // namespace rtai
