// Pure core: resilient Deepgram streaming client over an abstract IWebSocket.
//
// Threads (per stream):
//   * caller threads   send_audio()/mark_silence() only append to a bounded
//                      FIFO under a short lock and return immediately. The
//                      WASAPI capture thread never touches the network.
//   * writer thread    the ONLY thread that writes to the socket (audio,
//                      Finalize, KeepAlive, CloseStream) and the only one that
//                      connects/closes. Single writer = no concurrent
//                      WinHttpWebSocketSend (which WinHTTP rejects).
//                      It sleeps on a condition variable with a deadline, so
//                      KeepAlive fires on a timer even when no audio and no
//                      server message ever arrive (silence, idle loopback).
//   * reader thread    blocks in receive(), parses messages and invokes the
//                      transcript callback. Recreated for each connection.
//
// Failure handling: any reader/send failure, server close or a "stale"
// connection (audio sent, no answer for stale_timeout) makes the writer close
// the socket, join the reader and reconnect with exponential backoff + jitter.
// Audio captured meanwhile stays queued (up to max_backlog_samples, oldest
// dropped first) and is replayed after reconnecting. HTTP 400/401/402/403
// during the upgrade are treated as fatal (LinkState::Error, no retry loop).
#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "rtai/backoff.hpp"
#include "rtai/deepgram_protocol.hpp"
#include "rtai/interfaces.hpp"
#include "rtai/latency.hpp"
#include "rtai/outbound_queue.hpp"
#include "rtai/websocket.hpp"

namespace rtai {

struct DeepgramStreamConfig {
    dg::StreamParams params;
    std::string api_key;
    AudioSource source{AudioSource::Microphone};
    // Endpoint (params.host). Override for self-hosted Deepgram or tests.
    std::uint16_t port{443};
    bool secure{true};

    // Idle time after which a KeepAlive is written. Deepgram closes after
    // ~10 s without data; 3 s leaves room for a slow send.
    std::chrono::milliseconds keepalive_interval{3000};

    BackoffConfig backoff{};
    // A connection that lived at least this long resets the backoff.
    std::chrono::milliseconds stable_after{5000};
    // How long close() waits for the server to flush after CloseStream.
    std::chrono::milliseconds close_timeout{2000};

    // Watchdog: if at least stale_min_samples of audio were sent and nothing
    // came back for stale_timeout, the connection is considered dead
    // (half-open TCP, stuck proxy) and is recycled.
    std::chrono::milliseconds stale_timeout{15000};
    std::size_t stale_min_samples{16000 * 3};

    // Offline buffer: 20 s of 16 kHz mono PCM16 (~640 KB).
    std::size_t max_backlog_samples{16000 * 20};
    // Largest binary frame (and queue item): 200 ms.
    std::size_t max_frame_samples{3200};
};

class DeepgramStream final : public ITranscriptionTransport {
public:
    struct Stats {
        std::uint64_t audio_bytes_sent{0};
        std::uint64_t keepalives_sent{0};
        std::uint64_t finalizes_sent{0};
        std::uint64_t messages_received{0};
        std::uint64_t dropped_samples{0};
        std::uint32_t reconnects{0};
        std::uint32_t connect_failures{0};
    };

    // `clock` (optional) stamps TranscriptEvent::recv_ticks for latency metrics.
    DeepgramStream(DeepgramStreamConfig cfg, std::shared_ptr<IWebSocketFactory> factory,
                   const IClock* clock = nullptr);
    ~DeepgramStream() override;

    DeepgramStream(const DeepgramStream&) = delete;
    DeepgramStream& operator=(const DeepgramStream&) = delete;

    void open(TranscriptCallback cb) override;
    void send_audio(std::span<const std::int16_t> pcm) override;
    void mark_silence() override;
    void close() override;
    void set_status_callback(StatusCallback cb) override;

    [[nodiscard]] Stats stats() const;
    [[nodiscard]] LinkState state() const noexcept { return state_.load(); }
    [[nodiscard]] bool connected() const noexcept { return state() == LinkState::Connected; }
    [[nodiscard]] const DeepgramStreamConfig& config() const noexcept { return cfg_; }

private:
    using Clock = std::chrono::steady_clock;

    void writer_main();
    void writer_loop();
    void reader_main(IWebSocket* ws);
    void handle_text(const std::string& text);
    void emit(const TranscriptEvent& ev);
    void publish(LinkState s, std::string detail, int http_status = 0);

    // Interruptible sleep; returns true if stop was requested.
    bool wait_for_stop(std::chrono::milliseconds d);
    void wait_until_stop();

    [[nodiscard]] std::int64_t now_ms() const;
    [[nodiscard]] Clock::time_point at_ms(std::int64_t ms) const;

    DeepgramStreamConfig cfg_;
    std::shared_ptr<IWebSocketFactory> factory_;
    const IClock* clock_;
    WsConnectRequest request_;
    // Writer thread only: request_.path was downgraded to the minimal listen
    // path after Deepgram rejected an optional parameter (HTTP 400).
    bool minimal_params_{false};
    Clock::time_point epoch_;

    TranscriptCallback cb_; // written in open() before any thread reads it

    std::mutex status_mu_;  // serializes status callback invocations
    StatusCallback status_cb_;

    // ---- state shared between caller threads, writer and reader ----
    std::mutex mu_;
    std::condition_variable cv_;
    OutboundQueue queue_;        // guarded by mu_
    bool stop_{false};           // guarded by mu_
    bool opened_{false};         // guarded by mu_
    bool reader_done_{false};    // guarded by mu_
    std::string reader_error_;   // guarded by mu_

    std::mutex join_mu_;         // serializes concurrent close() callers
    std::thread writer_;
    std::thread reader_;         // started/joined only by the writer thread
    std::atomic<std::thread::id> writer_id_{};
    std::atomic<std::thread::id> reader_id_{};

    std::atomic<LinkState> state_{LinkState::Idle};
    std::atomic<std::int64_t> last_rx_ms_{0};

    std::atomic<std::uint64_t> audio_bytes_sent_{0};
    std::atomic<std::uint64_t> keepalives_sent_{0};
    std::atomic<std::uint64_t> finalizes_sent_{0};
    std::atomic<std::uint64_t> messages_received_{0};
    std::atomic<std::uint64_t> dropped_samples_{0};
    std::atomic<std::uint32_t> reconnects_{0};
    std::atomic<std::uint32_t> connect_failures_{0};
};

} // namespace rtai
