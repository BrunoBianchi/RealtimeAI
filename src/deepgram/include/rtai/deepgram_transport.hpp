// Deepgram Nova-3 transport for Windows: DeepgramStream (core: threads,
// KeepAlive timer, Finalize, reconnect, backlog) wired to the WinHTTP
// WebSocket adapter (src/net). Kept as a thin class so the app and the live
// integration test keep their original construction API.
#pragma once

#include <cstdint>
#include <memory>
#include <string>

#include "rtai/deepgram_stream.hpp"
#include "rtai/interfaces.hpp"
#include "rtai/latency.hpp"

namespace rtai {

// Simple config (original API). The API key is read from env/config by the
// caller and passed here; never hard-coded.
struct DeepgramConfig {
    dg::StreamParams params;
    std::string api_key;
    AudioSource source{AudioSource::Microphone};
    // KeepAlive interval in milliseconds (idle time before a KeepAlive).
    std::uint64_t keepalive_ms{3000};
};

class DeepgramTransport final : public ITranscriptionTransport {
public:
    DeepgramTransport(DeepgramConfig cfg, const IClock& clock);
    // Full control over reconnect/backlog/watchdog tuning.
    DeepgramTransport(DeepgramStreamConfig cfg, const IClock& clock);
    ~DeepgramTransport() override;

    void open(TranscriptCallback cb) override { stream_->open(std::move(cb)); }
    void send_audio(std::span<const std::int16_t> pcm) override { stream_->send_audio(pcm); }
    void mark_silence() override { stream_->mark_silence(); }
    void close() override { stream_->close(); }
    void set_status_callback(StatusCallback cb) override { stream_->set_status_callback(std::move(cb)); }

    [[nodiscard]] bool connected() const noexcept { return stream_->connected(); }
    [[nodiscard]] LinkState state() const noexcept { return stream_->state(); }
    [[nodiscard]] DeepgramStream::Stats stats() const { return stream_->stats(); }

private:
    std::unique_ptr<DeepgramStream> stream_;
};

} // namespace rtai
