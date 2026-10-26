// Pure core — merges transcript events from both source lanes into a single
// ordered, tagged stream for display ("Você" vs "Outros").
#pragma once

#include <functional>
#include <mutex>
#include <string>

#include "rtai/audio_format.hpp"
#include "rtai/interfaces.hpp"

namespace rtai {

// A line ready for display. interim lines are replaced in place by the UI
// until a final arrives for the same source.
struct TranscriptLine {
    AudioSource source{AudioSource::Microphone};
    std::string tag;   // "Você" / "Outros"
    std::string text;
    bool is_final{false};
};

class TranscriptAggregator {
public:
    using LineCallback = std::function<void(const TranscriptLine&)>;

    explicit TranscriptAggregator(LineCallback cb) : cb_(std::move(cb)) {}

    // Called by each lane's transport callback (from different threads).
    // Only transcript payloads become lines; turn markers are ignored here.
    void on_event(const TranscriptEvent& ev) {
        if (ev.kind != TranscriptKind::Transcript) return;
        TranscriptLine line{};
        line.source = ev.source;
        line.tag = speaker_label(ev.source);
        line.text = ev.text;
        line.is_final = ev.is_final;
        {
            std::lock_guard<std::mutex> lk(mu_);
            if (cb_) cb_(line);
        }
    }

private:
    LineCallback cb_;
    std::mutex mu_;
};

} // namespace rtai
