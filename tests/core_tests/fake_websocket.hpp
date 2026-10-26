// Test double for IWebSocket/IWebSocketFactory: an in-memory "Deepgram"
// that records every frame, detects concurrent sends (which WinHTTP would
// reject), and can simulate drops, silence, fatal upgrade errors and replies.
#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "rtai/websocket.hpp"

namespace rtai::testing {

struct FakeServer {
    struct Frame {
        int conn{0};
        bool text{false};
        std::string data;      // text frames only
        std::size_t bytes{0};
    };

    std::mutex mu;
    std::condition_variable cv;

    // ---- behaviour knobs (set before open()) ----
    std::deque<WsConnectResult> connect_failures; // consumed one per attempt
    bool gate_connect{false};                     // block connect() until release_connect()
    bool reply_to_audio{true};                    // send a Results message per reply_every_bytes
    std::size_t reply_every_bytes{1024};
    std::string reply_text{"ola"};
    bool reply_to_finalize{true};
    bool close_on_closestream{true};
    int break_after_frames_on_first_conn{-1};     // simulate a network drop

    // ---- observations ----
    int connects{0};
    std::vector<Frame> frames;
    std::atomic<int> concurrent_send_violations{0};
    std::atomic<int> concurrent_receive_violations{0};

    void release_connect() {
        std::lock_guard<std::mutex> lk(mu);
        gate_connect = false;
        cv.notify_all();
    }

    std::size_t count_text(const std::string& s) {
        std::lock_guard<std::mutex> lk(mu);
        std::size_t n = 0;
        for (const auto& f : frames) if (f.text && f.data == s) ++n;
        return n;
    }
    std::size_t binary_bytes() {
        std::lock_guard<std::mutex> lk(mu);
        std::size_t n = 0;
        for (const auto& f : frames) if (!f.text) n += f.bytes;
        return n;
    }
    std::vector<Frame> snapshot() {
        std::lock_guard<std::mutex> lk(mu);
        return frames;
    }
    int connect_count() {
        std::lock_guard<std::mutex> lk(mu);
        return connects;
    }
};

class FakeWebSocket final : public IWebSocket {
public:
    FakeWebSocket(std::shared_ptr<FakeServer> srv, int conn) : srv_(std::move(srv)), conn_(conn) {}

    bool send_text(std::string_view text, std::string& error) override {
        SendGuard g(*this);
        if (!check_open(error)) return false;
        record(true, std::string(text), text.size());
        if (text == R"({"type":"Finalize"})" && srv_->reply_to_finalize) {
            push(R"({"type":"Results","is_final":true,"speech_final":false,"from_finalize":true,)"
                 R"("channel":{"alternatives":[{"transcript":"fim do turno","confidence":0.9}]}})");
        } else if (text == R"({"type":"CloseStream"})" && srv_->close_on_closestream) {
            push(R"({"type":"Metadata","request_id":"req-1"})");
            push_close(1000, "");
        }
        return true;
    }

    bool send_binary(const void* /*data*/, std::size_t bytes, std::string& error) override {
        SendGuard g(*this);
        if (!check_open(error)) return false;
        record(false, {}, bytes);
        if (srv_->reply_to_audio) {
            audio_since_reply_ += bytes;
            if (audio_since_reply_ >= srv_->reply_every_bytes) {
                audio_since_reply_ = 0;
                push(std::string(R"({"type":"Results","is_final":true,"channel":{"alternatives":[{"transcript":")") +
                     srv_->reply_text + R"(","confidence":0.95}]}})");
            }
        }
        return true;
    }

    bool receive(WsMessage& out, std::string& error) override {
        if (in_receive_.fetch_add(1) != 0) srv_->concurrent_receive_violations.fetch_add(1);
        std::unique_lock<std::mutex> lk(mu_);
        cv_.wait(lk, [&] { return !inbox_.empty() || closed_ || broken_; });
        bool ok = false;
        if (!inbox_.empty()) {
            out = std::move(inbox_.front());
            inbox_.pop_front();
            ok = true;
        } else {
            error = broken_ ? "conexao resetada (fake)" : "cancelado por close() (fake)";
        }
        in_receive_.fetch_sub(1);
        return ok;
    }

    void close(std::uint16_t /*code*/, std::string_view /*reason*/) override {
        std::lock_guard<std::mutex> lk(mu_);
        closed_ = true;
        cv_.notify_all();
    }

private:
    struct SendGuard {
        explicit SendGuard(FakeWebSocket& s) : self(s) {
            if (self.in_send_.fetch_add(1) != 0) self.srv_->concurrent_send_violations.fetch_add(1);
            // Widen the race window so overlapping sends would be caught.
            std::this_thread::sleep_for(std::chrono::microseconds(20));
        }
        ~SendGuard() { self.in_send_.fetch_sub(1); }
        FakeWebSocket& self;
    };

    bool check_open(std::string& error) {
        std::lock_guard<std::mutex> lk(mu_);
        if (closed_) { error = "socket fechado (fake)"; return false; }
        if (broken_) { error = "conexao resetada (fake)"; return false; }
        return true;
    }

    void record(bool text, std::string data, std::size_t bytes) {
        bool do_break = false;
        {
            std::lock_guard<std::mutex> lk(srv_->mu);
            srv_->frames.push_back({conn_, text, std::move(data), bytes});
            ++frames_on_conn_;
            do_break = conn_ == 1 && srv_->break_after_frames_on_first_conn >= 0 &&
                       frames_on_conn_ >= srv_->break_after_frames_on_first_conn;
        }
        if (do_break) {
            std::lock_guard<std::mutex> lk(mu_);
            broken_ = true;
            cv_.notify_all();
        }
    }

    void push(std::string text) {
        std::lock_guard<std::mutex> lk(mu_);
        WsMessage m;
        m.type = WsMessageType::Text;
        m.data = std::move(text);
        inbox_.push_back(std::move(m));
        cv_.notify_all();
    }

    void push_close(std::uint16_t code, std::string reason) {
        std::lock_guard<std::mutex> lk(mu_);
        WsMessage m;
        m.type = WsMessageType::Close;
        m.close_code = code;
        m.close_reason = std::move(reason);
        inbox_.push_back(std::move(m));
        cv_.notify_all();
    }

    std::shared_ptr<FakeServer> srv_;
    int conn_;
    std::mutex mu_;
    std::condition_variable cv_;
    std::deque<WsMessage> inbox_;
    bool closed_{false};
    bool broken_{false};
    int frames_on_conn_{0};
    std::size_t audio_since_reply_{0};
    std::atomic<int> in_send_{0};
    std::atomic<int> in_receive_{0};
};

class FakeWsFactory final : public IWebSocketFactory {
public:
    explicit FakeWsFactory(std::shared_ptr<FakeServer> srv) : srv_(std::move(srv)) {}

    std::unique_ptr<IWebSocket> connect(const WsConnectRequest& request,
                                        WsConnectResult& result) override {
        int conn = 0;
        {
            std::unique_lock<std::mutex> lk(srv_->mu);
            last_request = request;
            srv_->cv.wait(lk, [&] { return !srv_->gate_connect; });
            ++srv_->connects;
            if (!srv_->connect_failures.empty()) {
                result = srv_->connect_failures.front();
                srv_->connect_failures.pop_front();
                return nullptr;
            }
            conn = srv_->connects;
        }
        result.ok = true;
        result.http_status = 101;
        result.request_id = "fake-" + std::to_string(conn);
        return std::make_unique<FakeWebSocket>(srv_, conn);
    }

    WsConnectRequest last_request; // guarded by srv_->mu

private:
    std::shared_ptr<FakeServer> srv_;
};

// Polls `pred` until true or timeout.
inline bool eventually(const std::function<bool()>& pred,
                       std::chrono::milliseconds timeout = std::chrono::milliseconds(3000)) {
    const auto end = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < end) {
        if (pred()) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    return pred();
}

} // namespace rtai::testing
