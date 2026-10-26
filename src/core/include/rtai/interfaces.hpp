// Pure core interfaces that isolate hardware (WASAPI), model (ONNX) and
// network (WinHTTP) behind testable abstractions. No <windows.h>.
#pragma once

#include <cstdint>
#include <functional>
#include <span>
#include <string>
#include <string_view>

#include "rtai/audio_format.hpp"
#include "rtai/audio_frame.hpp"

namespace rtai {

// -------------------------------------------------------------------------
// Capture source: produces interleaved float frames in the device's native
// format. Implemented by WASAPI adapters and by the WAV file fake.
// -------------------------------------------------------------------------
class IAudioCaptureSource {
public:
    virtual ~IAudioCaptureSource() = default;

    // Callback invoked on the capture thread with a non-owning view of freshly
    // captured samples (interleaved, native device format). The callback must
    // not block and must not retain the span past the call.
    using FrameCallback = std::function<void(std::span<const float> interleaved,
                                             std::uint64_t capture_ticks)>;

    // The device's current format. Valid from the first frame callback on and
    // may change after a device switch (re-read it on the capture thread).
    [[nodiscard]] virtual AudioFormat format() const = 0;
    [[nodiscard]] virtual AudioSource source() const noexcept = 0;

    // Begin capture; frames are delivered via `cb` until stop().
    virtual void start(FrameCallback cb) = 0;
    virtual void stop() = 0;
};

// -------------------------------------------------------------------------
// VAD gate: given 16 kHz mono PCM windows, decides whether speech is active.
// Implemented by the ONNX Silero adapter and by a deterministic fake.
// -------------------------------------------------------------------------
class IVadGate {
public:
    virtual ~IVadGate() = default;

    // Window size (in samples) the gate expects, e.g. 512 @ 16 kHz.
    [[nodiscard]] virtual std::size_t window_samples() const noexcept = 0;

    // Feed exactly window_samples() PCM16 samples; returns the raw speech
    // probability in [0,1]. State is maintained across calls.
    [[nodiscard]] virtual float process_window(std::span<const std::int16_t> window) = 0;

    // Reset internal recurrent state (e.g. between sessions).
    virtual void reset() = 0;
};

// -------------------------------------------------------------------------
// Transcription transport: streams PCM16 to an STT provider and surfaces
// transcript events. Implemented by the Deepgram stream and a fake.
// -------------------------------------------------------------------------
enum class TranscriptKind : std::uint8_t {
    Transcript = 0,   // a Results payload (interim or final)
    UtteranceEnd = 1, // server-side gap detection (utterance_end_ms)
    SpeechStarted = 2,// server-side VAD event (vad_events=true)
    LocalTurnEnd = 3, // our own VAD closed the turn (emitted by SourcePipeline)
};

struct TranscriptEvent {
    AudioSource source{AudioSource::Microphone};
    std::string text;
    bool is_final{false};
    // tick captured when this event was produced locally (for latency metrics)
    std::uint64_t recv_ticks{0};

    // Extended fields. Kept after the original four so existing aggregate
    // initializers such as TranscriptEvent{src, "text", true, 0} still work.
    TranscriptKind kind{TranscriptKind::Transcript};
    bool speech_final{false};   // Deepgram endpointing detected end of speech
    bool from_finalize{false};  // result produced by our Finalize message
    double start_s{0.0};        // audio-stream time (VAD-gated, so compressed)
    double duration_s{0.0};
    double confidence{0.0};
};

// Connection health, surfaced to the overlay and the session log.
enum class LinkState : std::uint8_t {
    Idle = 0,
    Connecting = 1,
    Connected = 2,
    Reconnecting = 3,
    Error = 4,   // non-retryable (bad key, no credits, bad params)
    Closed = 5,
};

constexpr const char* to_string(LinkState s) noexcept {
    switch (s) {
        case LinkState::Idle:         return "idle";
        case LinkState::Connecting:   return "connecting";
        case LinkState::Connected:    return "connected";
        case LinkState::Reconnecting: return "reconnecting";
        case LinkState::Error:        return "error";
        case LinkState::Closed:       return "closed";
    }
    return "?";
}

struct TransportStatus {
    AudioSource source{AudioSource::Microphone};
    LinkState state{LinkState::Idle};
    std::string detail;            // human-readable reason (pt-BR)
    std::uint32_t reconnects{0};   // successful reconnections so far
    std::uint64_t dropped_audio_ms{0};
    int http_status{0};            // last HTTP status from the upgrade, if any
};

class ITranscriptionTransport {
public:
    virtual ~ITranscriptionTransport() = default;

    using TranscriptCallback = std::function<void(const TranscriptEvent&)>;
    using StatusCallback = std::function<void(const TransportStatus&)>;

    // Open and pre-warm the connection. Must not block on the network: real
    // transports connect in the background and keep retrying.
    virtual void open(TranscriptCallback cb) = 0;

    // Send a block of 16 kHz mono PCM16 audio. Called from the capture thread;
    // must be non-blocking and thread-safe with respect to the other methods.
    virtual void send_audio(std::span<const std::int16_t> pcm) = 0;

    // Signal a turn boundary (local VAD closed the turn). Real transports send
    // Deepgram's Finalize, ordered after all audio sent before this call.
    virtual void mark_silence() = 0;

    // Graceful close (flush + CloseStream + socket close). Idempotent. Must not
    // be called from inside the transcript/status callbacks.
    virtual void close() = 0;

    // Optional connection-health notifications. Register before open().
    virtual void set_status_callback(StatusCallback /*cb*/) {}
};

} // namespace rtai
