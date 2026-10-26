// ILlmClient for OpenRouter over WinHTTP (synchronous API, one worker thread
// per call). Streaming uses WinHttpQueryDataAvailable + WinHttpReadData so
// tokens are handed over as soon as they arrive (WinHttpReadData alone tries
// to fill the whole buffer first).
//
// Cancellation is cooperative: the worker checks the flag between reads and
// closes its own handles. Handles are never closed from another thread
// (WinHTTP documents that as a race for synchronous requests). OpenRouter
// sends ": OPENROUTER PROCESSING" comments, so reads return regularly even
// before the first token. The session is shared so pooled TLS connections are
// reused between suggestions (lower time-to-first-token).
//
// RST_STREAM / connection-reuse invariant (Req 4.6): ILlmCall::cancel() is
// cooperative. It only flips the per-call cancel flag; the worker owns its
// request (stream) handle and tears down ONLY that handle when it sees the
// flag between reads. Over HTTP/2 closing the request handle emits a
// RST_STREAM for that stream while the underlying TCP/TLS 1.3 connection stays
// in the session's connection pool. abort_shadow() in the engine calls
// cancel() this way, so the next generation reuses the warm connection with no
// new handshake. The connection pool and session live at a wider scope
// (WinHttpLlmClient::Shared::session) that survives any single call's
// cancellation — see Shared in the .cpp.
#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>

#include "rtai/llm.hpp"

namespace rtai {

// ---------------------------------------------------------------------------
// LlmEndpoint — one direct HTTP/2 chat-completions target (host/path/model/key).
// Shared with the Cold_Path analytics client (jev_analytics_client.hpp, task
// 8.1): whichever header is included first defines it, the other skips it via
// this guard so the two definitions never clash (single ODR definition). Keep
// the struct identical in both headers.
// ---------------------------------------------------------------------------
#ifndef RTAI_LLM_ENDPOINT_DEFINED
#define RTAI_LLM_ENDPOINT_DEFINED
struct LlmEndpoint {
    std::string host;                    // "api.cerebras.ai" | "api.groq.com"
    std::string path{"/v1/chat/completions"};
    std::string model;                   // "qwen-3.8-27b" | "gpt-oss-120b"
    std::string api_key;
};
#endif // RTAI_LLM_ENDPOINT_DEFINED

// Classification of a failed LLM attempt, driving the failover decision (Req
// 4.2). Timeout/Connect/Server5xx are retryable (fall over to the fallback
// provider); Client4xx (auth/validation) is NOT — it surfaces the error
// instead of silently switching providers.
enum class LlmFailure : std::uint8_t {
    None,       // no failure (success)
    Timeout,    // first-byte / receive timeout
    Connect,    // resolve / connect / TLS failure, unexpected RST
    Server5xx,  // provider returned a 5xx status
    Client4xx,  // provider returned a 4xx status (do NOT fail over)
};

struct WinHttpLlmOptions {
    std::string api_key;
    // Any OpenAI-compatible chat-completions endpoint works (OpenRouter by
    // default; OpenAI, a local Ollama/LM Studio, a corporate proxy...).
    std::string host{"openrouter.ai"};
    std::uint16_t port{443};
    bool secure{true};
    std::string path{"/api/v1/chat/completions"};
    std::string referer;            // optional OpenRouter app attribution
    std::string title{"RealTimeAI"};
    int resolve_timeout_ms{3000};
    int connect_timeout_ms{4000};
    int send_timeout_ms{5000};
    // Direct HTTP/2 transport (Req 4.1/4.2/4.5). Primary = Cerebras, fallback =
    // Groq; OpenRouter is kept off the critical path. The worker (task 4.2)
    // selects between these via choose_endpoint().
    LlmEndpoint primary{"api.cerebras.ai", "/v1/chat/completions", "qwen-3.8-27b", ""};
    LlmEndpoint fallback{"api.groq.com", "/v1/chat/completions", "llama-3.3-70b-versatile", ""};
    int first_byte_timeout_ms{1200}; // fast primary failure -> failover (Req 4.2)
    int receive_timeout_ms{15000};   // max gap between stream chunks
    int keep_alive_ms{25000};        // keep-alive ping interval (Req 4.5)
    // OpenRouter routing preference sent with every request to openrouter.ai
    // ("latency" = lowest time-to-first-token provider first). Empty = omit.
    std::string openrouter_provider_sort{"latency"};
    // Background keep-alive pinger (see start_keep_alive). Off for secondary
    // clients that are not on the live answer path.
    bool keep_alive{true};
};

// ---------------------------------------------------------------------------
// Pure endpoint-selection / retry / keep-alive logic (no network; unit and
// property testable off Win32). Used by the worker (task 4.2).
// ---------------------------------------------------------------------------

// Req 4.2: attempt 0 -> primary (Cerebras); any later attempt -> fallback
// (Groq). The caller only advances to the fallback after a retryable failure.
[[nodiscard]] inline const LlmEndpoint& choose_endpoint(int attempt,
                                                        const WinHttpLlmOptions& o) noexcept {
    return attempt == 0 ? o.primary : o.fallback;
}

// Req 4.2: retryable iff the failure is a timeout, a connection error, or a
// 5xx. A 4xx (and None) never triggers a provider switch.
[[nodiscard]] inline bool is_retryable(LlmFailure f) noexcept {
    return f == LlmFailure::Timeout || f == LlmFailure::Connect || f == LlmFailure::Server5xx;
}

// Req 4.5: a keep-alive ping is due once at least `interval_ms` has elapsed
// since the last ping (true iff now - last >= interval).
[[nodiscard]] inline bool should_ping(std::int64_t now_ms, std::int64_t last_ping_ms,
                                      int interval_ms) noexcept {
    return (now_ms - last_ping_ms) >= interval_ms;
}

class WinHttpLlmClient final : public ILlmClient {
public:
    explicit WinHttpLlmClient(WinHttpLlmOptions opts);
    ~WinHttpLlmClient() override;

    std::shared_ptr<ILlmCall> start(LlmRequest request, LlmCallbacks callbacks) override;
    void shutdown(std::chrono::milliseconds wait) override;
    [[nodiscard]] std::string name() const override { return "OpenRouter"; }

    // OpenRouter only: opens a TLS connection early (GET /api/v1/key) so the
    // first suggestion doesn't pay the handshake, and validates the key. Runs
    // on its own thread; `on_result(ok, message)` reports the outcome.
    void warm_up(std::function<void(bool ok, std::string message)> on_result);

    struct Shared;

private:
    // Launches the keep-alive worker (Req 4.5): pings the direct primary
    // endpoint, or OpenRouter itself in single-host mode, so the TLS/HTTP2
    // connection is already open when a question arrives (no handshake on
    // the hot path). Other single-host endpoints (local Ollama...) are skipped.
    void start_keep_alive();

    WinHttpLlmOptions opts_;
    std::shared_ptr<Shared> shared_;
};

} // namespace rtai
