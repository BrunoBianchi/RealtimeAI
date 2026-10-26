#include "rtai/deepgram_stream.hpp"

#include <algorithm>
#include <deque>
#include <exception>
#include <utility>

namespace rtai {

namespace {

std::string ms_text(std::chrono::milliseconds d) {
    return std::to_string(d.count()) + " ms";
}

} // namespace

DeepgramStream::DeepgramStream(DeepgramStreamConfig cfg,
                               std::shared_ptr<IWebSocketFactory> factory,
                               const IClock* clock)
    : cfg_(std::move(cfg)),
      factory_(std::move(factory)),
      clock_(clock),
      epoch_(Clock::now()),
      queue_(cfg_.max_backlog_samples, cfg_.max_frame_samples) {
    request_.host = cfg_.params.host;
    request_.port = cfg_.port;
    request_.secure = cfg_.secure;
    request_.path = dg::build_listen_path(cfg_.params);
    request_.headers.emplace_back("Authorization", "Token " + cfg_.api_key);
}

DeepgramStream::~DeepgramStream() {
    close();
}

std::int64_t DeepgramStream::now_ms() const {
    return std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - epoch_).count();
}

DeepgramStream::Clock::time_point DeepgramStream::at_ms(std::int64_t ms) const {
    return epoch_ + std::chrono::milliseconds(ms);
}

// ---------------------------------------------------------------------------
// Public API (any thread)
// ---------------------------------------------------------------------------

void DeepgramStream::open(TranscriptCallback cb) {
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (opened_ || stop_) return;
        opened_ = true;
        cb_ = std::move(cb);
    }
    writer_ = std::thread([this] { writer_main(); });
}

void DeepgramStream::send_audio(std::span<const std::int16_t> pcm) {
    if (pcm.empty()) return;
    std::size_t dropped = 0;
    {
        // Short critical section: copy ~1 KB into the FIFO. The lock is never
        // held across network I/O, so the capture thread can't be stalled by a
        // slow socket.
        std::lock_guard<std::mutex> lk(mu_);
        if (stop_) return;
        dropped = queue_.push_audio(pcm);
    }
    if (dropped) dropped_samples_.fetch_add(dropped);
    cv_.notify_one();
}

void DeepgramStream::mark_silence() {
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (stop_) return;
        queue_.push_finalize(); // ordered after all audio queued before it
    }
    cv_.notify_one();
}

void DeepgramStream::close() {
    {
        std::lock_guard<std::mutex> lk(mu_);
        stop_ = true;
    }
    cv_.notify_all();

    // Called from our own callback threads: cannot join ourselves. The writer
    // still observes stop_ and shuts down on its own.
    const auto self = std::this_thread::get_id();
    if (self == writer_id_.load() || self == reader_id_.load()) return;

    std::lock_guard<std::mutex> jl(join_mu_);
    if (writer_.joinable()) writer_.join();
}

void DeepgramStream::set_status_callback(StatusCallback cb) {
    std::lock_guard<std::mutex> lk(status_mu_);
    status_cb_ = std::move(cb);
}

DeepgramStream::Stats DeepgramStream::stats() const {
    Stats s;
    s.audio_bytes_sent = audio_bytes_sent_.load();
    s.keepalives_sent = keepalives_sent_.load();
    s.finalizes_sent = finalizes_sent_.load();
    s.messages_received = messages_received_.load();
    s.dropped_samples = dropped_samples_.load();
    s.reconnects = reconnects_.load();
    s.connect_failures = connect_failures_.load();
    return s;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

void DeepgramStream::publish(LinkState s, std::string detail, int http_status) {
    state_.store(s);
    TransportStatus st;
    st.source = cfg_.source;
    st.state = s;
    st.detail = std::move(detail);
    st.reconnects = reconnects_.load();
    const std::uint32_t rate = cfg_.params.sample_rate ? cfg_.params.sample_rate : 16000;
    st.dropped_audio_ms = dropped_samples_.load() * 1000 / rate;
    st.http_status = http_status;
    std::lock_guard<std::mutex> lk(status_mu_);
    if (status_cb_) {
        try { status_cb_(st); } catch (...) { /* never let a sink kill the stream */ }
    }
}

bool DeepgramStream::wait_for_stop(std::chrono::milliseconds d) {
    std::unique_lock<std::mutex> lk(mu_);
    return cv_.wait_for(lk, d, [this] { return stop_; });
}

void DeepgramStream::wait_until_stop() {
    std::unique_lock<std::mutex> lk(mu_);
    cv_.wait(lk, [this] { return stop_; });
}

void DeepgramStream::emit(const TranscriptEvent& ev) {
    if (!cb_) return;
    try { cb_(ev); } catch (...) { /* keep the reader alive */ }
}

// ---------------------------------------------------------------------------
// Reader thread (one per connection)
// ---------------------------------------------------------------------------

void DeepgramStream::reader_main(IWebSocket* ws) {
    reader_id_.store(std::this_thread::get_id());
    std::string err;
    WsMessage msg;
    for (;;) {
        msg.data.clear();
        msg.close_reason.clear();
        if (!ws->receive(msg, err)) {
            if (err.empty()) err = "connection closed";
            break;
        }
        last_rx_ms_.store(now_ms());
        messages_received_.fetch_add(1);
        if (msg.type == WsMessageType::Close) {
            err = dg::describe_close(msg.close_code, msg.close_reason);
            break;
        }
        if (msg.type == WsMessageType::Text) handle_text(msg.data);
    }
    {
        std::lock_guard<std::mutex> lk(mu_);
        reader_done_ = true;
        reader_error_ = err;
    }
    cv_.notify_all();
    reader_id_.store(std::thread::id{});
}

void DeepgramStream::handle_text(const std::string& text) {
    const dg::ServerMessage m = dg::parse_message(text);
    TranscriptEvent ev{};
    ev.source = cfg_.source;
    ev.recv_ticks = clock_ ? clock_->ticks() : 0;
    switch (m.kind) {
        case dg::MessageKind::Results:
            ev.kind = TranscriptKind::Transcript;
            ev.text = m.transcript;
            ev.is_final = m.is_final;
            ev.speech_final = m.speech_final;
            ev.from_finalize = m.from_finalize;
            ev.start_s = m.start;
            ev.duration_s = m.duration;
            ev.confidence = m.confidence;
            emit(ev);
            break;
        case dg::MessageKind::UtteranceEnd:
            if (m.last_word_end >= 0.0) { // -1 => already finalized, ignore
                ev.kind = TranscriptKind::UtteranceEnd;
                ev.start_s = m.last_word_end;
                emit(ev);
            }
            break;
        case dg::MessageKind::SpeechStarted:
            ev.kind = TranscriptKind::SpeechStarted;
            ev.start_s = m.start;
            emit(ev);
            break;
        case dg::MessageKind::Error:
            publish(state_.load(), "Deepgram: " + m.error);
            break;
        default:
            break; // Metadata / unknown: nothing to surface
    }
}

// ---------------------------------------------------------------------------
// Writer thread: owns the socket
// ---------------------------------------------------------------------------

void DeepgramStream::writer_main() {
    writer_id_.store(std::this_thread::get_id());
    try {
        writer_loop();
    } catch (const std::exception& e) {
        publish(LinkState::Error, std::string("internal stream error: ") + e.what());
    } catch (...) {
        publish(LinkState::Error, "internal stream error");
    }
    writer_id_.store(std::thread::id{});
}

void DeepgramStream::writer_loop() {
    using OQ = OutboundQueue;
    ExponentialBackoff backoff(cfg_.backoff);
    dg::KeepAlivePolicy keepalive(static_cast<std::uint64_t>(cfg_.keepalive_interval.count()));
    const std::int64_t stale_ms = cfg_.stale_timeout.count();

    std::unique_ptr<IWebSocket> ws;
    bool ever_connected = false;
    bool fatal = false;
    Clock::time_point connected_at{};

    // Watchdog bookkeeping (writer-local).
    std::size_t unanswered_samples = 0;
    std::int64_t unanswered_since = -1;
    std::int64_t rx_seen = 0;

    // Closes the current socket, joins its reader and resets shared flags.
    auto teardown = [&](std::uint16_t code) {
        if (ws) ws->close(code, "");
        if (reader_.joinable()) reader_.join();
        ws.reset();
        std::lock_guard<std::mutex> lk(mu_);
        reader_done_ = false;
        reader_error_.clear();
    };

    // Drop the connection and back off. Returns true if stop was requested.
    auto drop_and_backoff = [&](const std::string& reason) -> bool {
        const bool was_stable = Clock::now() - connected_at >= cfg_.stable_after;
        teardown(1001);
        if (was_stable) backoff.reset();
        const auto delay = backoff.next();
        publish(LinkState::Reconnecting, reason + "; reconnecting in " + ms_text(delay));
        return wait_for_stop(delay);
    };

    // Sends `batch` in order; on failure the unsent items (including the one
    // that failed) remain in `batch`.
    auto send_batch = [&](std::deque<OQ::Item>& batch, std::string& err) -> bool {
        while (!batch.empty()) {
            OQ::Item& item = batch.front();
            const std::int64_t t = now_ms();
            if (item.type == OQ::ItemType::Finalize) {
                if (!ws->send_text(dg::finalize_message(), err)) return false;
                finalizes_sent_.fetch_add(1);
            } else if (!item.pcm.empty()) {
                const std::size_t bytes = item.pcm.size() * sizeof(std::int16_t);
                if (!ws->send_binary(item.pcm.data(), bytes, err)) return false;
                audio_bytes_sent_.fetch_add(bytes);
                if (unanswered_samples == 0) unanswered_since = t;
                unanswered_samples += item.pcm.size();
            }
            keepalive.on_write(static_cast<std::uint64_t>(t));
            batch.pop_front();
        }
        return true;
    };

    for (;;) {
        // ------------------------------------------------------------ connect
        if (!ws) {
            bool stopping = false;
            {
                std::lock_guard<std::mutex> lk(mu_);
                stopping = stop_;
                if (stopping) {
                    // Offline at shutdown: whatever is still queued is lost.
                    dropped_samples_.fetch_add(queue_.audio_samples());
                    queue_.clear();
                }
            }
            if (stopping) break;
            if (fatal) {
                wait_until_stop();
                continue;
            }

            publish(ever_connected ? LinkState::Reconnecting : LinkState::Connecting,
                    ever_connected ? "reconnecting to Deepgram" : "connecting to Deepgram");

            WsConnectResult res;
            std::unique_ptr<IWebSocket> fresh;
            try {
                fresh = factory_->connect(request_, res);
            } catch (const std::exception& e) {
                res.error = e.what();
                res.retryable = true;
            }
            if (!fresh) {
                connect_failures_.fetch_add(1);
                const std::string why = res.error.empty() ? "falha ao conectar" : res.error;
                // HTTP 400 = a query parameter was rejected. Retry once with only
                // the essential parameters before giving up for good.
                if (!res.retryable && res.http_status == 400 && !minimal_params_) {
                    const std::string minimal = dg::build_minimal_listen_path(cfg_.params);
                    if (minimal != request_.path) {
                        minimal_params_ = true;
                        request_.path = minimal;
                        publish(LinkState::Connecting,
                                why + "; reconnecting without the optional parameters (language hints, keyterms)",
                                res.http_status);
                        continue;
                    }
                }
                if (!res.retryable) {
                    fatal = true;
                    publish(LinkState::Error, why, res.http_status);
                    continue;
                }
                const auto delay = backoff.next();
                publish(ever_connected ? LinkState::Reconnecting : LinkState::Connecting,
                        why + "; retrying in " + ms_text(delay), res.http_status);
                if (wait_for_stop(delay)) break;
                continue;
            }

            ws = std::move(fresh);
            {
                std::lock_guard<std::mutex> lk(mu_);
                reader_done_ = false;
                reader_error_.clear();
            }
            const std::int64_t t = now_ms();
            last_rx_ms_.store(t);
            rx_seen = t;
            unanswered_samples = 0;
            unanswered_since = -1;
            keepalive.on_write(static_cast<std::uint64_t>(t));
            connected_at = Clock::now();
            if (ever_connected) reconnects_.fetch_add(1);
            ever_connected = true;

            IWebSocket* raw = ws.get();
            reader_ = std::thread([this, raw] { reader_main(raw); });
            publish(LinkState::Connected,
                    res.request_id.empty() ? std::string("conectado")
                                           : "conectado (request " + res.request_id + ")",
                    res.http_status);
        }

        // ---------------------------------------------------- wait for work
        // Any answer from the server re-arms the watchdog.
        {
            const std::int64_t rx = last_rx_ms_.load();
            if (rx > rx_seen) {
                rx_seen = rx;
                unanswered_samples = 0;
                unanswered_since = -1;
            }
        }
        std::int64_t deadline_ms = static_cast<std::int64_t>(keepalive.next_due());
        const bool watchdog_armed =
            unanswered_samples >= cfg_.stale_min_samples && unanswered_since >= 0;
        if (watchdog_armed) deadline_ms = std::min(deadline_ms, unanswered_since + stale_ms);

        std::deque<OQ::Item> batch;
        bool stopping = false;
        bool reader_done = false;
        std::string reader_error;
        {
            std::unique_lock<std::mutex> lk(mu_);
            cv_.wait_until(lk, at_ms(deadline_ms),
                           [this] { return stop_ || reader_done_ || !queue_.empty(); });
            stopping = stop_;
            reader_done = reader_done_;
            reader_error = reader_error_;
            // If the socket died, keep the items queued for the next connection.
            if (!reader_done) batch = queue_.take_all();
        }

        // ------------------------------------------------- connection lost
        if (reader_done) {
            if (stopping) {
                teardown(1000);
                break;
            }
            if (drop_and_backoff(reader_error.empty() ? "connection lost" : reader_error)) break;
            continue;
        }

        // ------------------------------------------------------ send batch
        std::string err;
        if (!send_batch(batch, err)) {
            std::size_t dropped = 0;
            {
                std::lock_guard<std::mutex> lk(mu_);
                dropped = queue_.push_front(std::move(batch));
            }
            if (dropped) dropped_samples_.fetch_add(dropped);
            if (stopping) {
                teardown(1001);
                break;
            }
            if (drop_and_backoff("send failed: " + err)) break;
            continue;
        }

        // ------------------------------------------------- graceful close
        if (stopping) {
            // CloseStream makes Deepgram flush the remaining audio, send the
            // last finals + Metadata, and close. Give it close_timeout.
            if (ws->send_text(dg::close_stream_message(), err)) {
                std::unique_lock<std::mutex> lk(mu_);
                cv_.wait_for(lk, cfg_.close_timeout, [this] { return reader_done_; });
            }
            teardown(1000);
            break;
        }

        const std::int64_t t = now_ms();

        // ------------------------------------------------------- KeepAlive
        if (keepalive.due(static_cast<std::uint64_t>(t))) {
            if (!ws->send_text(dg::keepalive_message(), err)) {
                if (drop_and_backoff("KeepAlive send failed: " + err)) break;
                continue;
            }
            keepalive.on_write(static_cast<std::uint64_t>(t));
            keepalives_sent_.fetch_add(1);
        }

        // -------------------------------------------------------- watchdog
        if (unanswered_samples >= cfg_.stale_min_samples && unanswered_since >= 0 &&
            t - unanswered_since >= stale_ms) {
            if (drop_and_backoff("server silent for " +
                                 std::to_string((t - unanswered_since) / 1000) + " s")) {
                break;
            }
            continue;
        }
    }

    if (ws) teardown(1000);
    {
        // Anything still queued could not be delivered.
        std::lock_guard<std::mutex> lk(mu_);
        dropped_samples_.fetch_add(queue_.audio_samples());
        queue_.clear();
    }
    publish(LinkState::Closed, "encerrado");
}

} // namespace rtai
