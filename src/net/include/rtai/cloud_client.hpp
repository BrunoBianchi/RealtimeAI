// WinHTTP client for the lipcue.com cloud backend (credential broker).
//
// Lifecycle (see docs/server-api.md):
//   * fetch()      blocking POST /v1/session; the app runs it on a worker
//                  thread right at start-up, overlapped with audio/RAG init;
//   * start_refresh() background thread that renews the credentials before
//                  they expire, so a Deepgram reconnect never waits for us;
//   * stt_authorization() cheap, lock-protected read of the cached token for
//                  DeepgramStream (force=true fetches synchronously after a 401);
//   * end_session() fire-and-forget POST /v1/session/{id}/end at shutdown.
//
// The HTTP session (and its TLS connection) is reused across calls.
#pragma once

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>

#include "rtai/cloud_session.hpp"

namespace rtai {

struct CloudClientOptions {
    std::string base_url;   // https://api.example.com (no trailing slash)
    std::string token;      // device token from the sign-in
    cloud::SessionRequest request;
    int timeout_ms{4000};   // per phase (resolve/connect/send/receive)
};

class CloudClient {
public:
    explicit CloudClient(CloudClientOptions opts);
    ~CloudClient();
    CloudClient(const CloudClient&) = delete;
    CloudClient& operator=(const CloudClient&) = delete;

    // Blocking. On success the session is cached and returned; on failure
    // `error` has a pt-BR reason and `http_status` the server status (0 = network).
    std::optional<cloud::Session> fetch(std::string& error, int* http_status = nullptr);

    // Renews credentials in the background (refresh_after_s / expires_at).
    void start_refresh();

    [[nodiscard]] std::optional<cloud::Session> current() const;

    // "Bearer <stt token>" for DeepgramStreamConfig::authorization.
    std::string stt_authorization(bool force_refresh);

    // Fire-and-forget usage report; waits at most `wait` for it to go out.
    void end_session(const cloud::SessionEnd& e, std::chrono::milliseconds wait);

    void stop();

private:
    struct Http;
    std::optional<cloud::Session> fetch_locked_out(std::string& error, int* http_status);
    void refresh_main();

    CloudClientOptions opts_;
    std::shared_ptr<Http> http_; // shared with the end_session worker

    mutable std::mutex mu_;
    std::condition_variable cv_;
    std::optional<cloud::Session> session_; // guarded by mu_
    bool stop_{false};                      // guarded by mu_
    std::mutex fetch_mu_;                   // one bootstrap/refresh at a time
    std::thread refresher_;
};

} // namespace rtai
