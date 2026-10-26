#include "rtai/winhttp_llm_client.hpp"

#include <windows.h>
#include <winhttp.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <vector>

#include "rtai/openrouter_protocol.hpp"
#include "rtai/sse_parser.hpp"
#include "rtai/version.hpp"
#include "rtai/winhttp_util.hpp"

namespace rtai {

namespace {

struct CallImpl final : ILlmCall {
    std::atomic<bool> cancelled{false};
    std::atomic<bool> done{false};
    // Req 4.6 (RST_STREAM + connection reuse): cancel() is cooperative — it
    // only raises this flag. It deliberately does NOT touch any WinHTTP handle
    // (closing a synchronous request handle from another thread is a documented
    // race). The owning worker observes the flag between reads and closes ONLY
    // its own request (stream) handle; over HTTP/2 that emits RST_STREAM for
    // the stream while the shared session keeps the TCP/TLS connection pooled
    // for the next generation. abort_shadow() in the engine drives this path.
    void cancel() override { cancelled.store(true); }
    [[nodiscard]] bool finished() const override { return done.load(); }
};

// Authorization header for a bearer key (`api_key`), plus optional OpenRouter
// attribution. `streaming` adds the JSON/SSE content negotiation.
std::wstring auth_headers(std::string_view api_key, const WinHttpLlmOptions& o, bool streaming) {
    std::wstring h = L"Authorization: Bearer " + win::widen(api_key) + L"\r\n";
    if (streaming) {
        h += L"Content-Type: application/json\r\n";
        h += L"Accept: text/event-stream\r\n";
    }
    if (!o.title.empty()) h += L"X-Title: " + win::widen(o.title) + L"\r\n";
    if (!o.referer.empty()) h += L"HTTP-Referer: " + win::widen(o.referer) + L"\r\n";
    return h;
}

std::wstring request_headers(const WinHttpLlmOptions& o, bool streaming) {
    return auth_headers(o.api_key, o, streaming);
}

// Maps an HTTP status to a failover class (Req 4.2): 5xx is retryable, 4xx is
// not (surfaces the error), anything else (success/unknown) is None here.
LlmFailure classify_status(int status) {
    if (status >= 500 && status <= 599) return LlmFailure::Server5xx;
    if (status >= 400 && status <= 499) return LlmFailure::Client4xx;
    return LlmFailure::None;
}

// Maps a WinHTTP transport error code to a failover class (Req 4.2). Timeouts
// are retryable timeouts; connect/DNS/TLS/reset are retryable connection
// errors; a cancelled operation is reported as a connection class but the
// caller short-circuits on the cooperative cancel flag before using it.
LlmFailure classify_winhttp_error(DWORD code) {
    switch (code) {
        case ERROR_WINHTTP_TIMEOUT:
            return LlmFailure::Timeout;
        case ERROR_WINHTTP_NAME_NOT_RESOLVED:
        case ERROR_WINHTTP_CANNOT_CONNECT:
        case ERROR_WINHTTP_CONNECTION_ERROR:
        case ERROR_WINHTTP_SECURE_FAILURE:
        case ERROR_WINHTTP_INVALID_SERVER_RESPONSE:
            return LlmFailure::Connect;
        default:
            return LlmFailure::Connect; // treat unknown transport faults as retryable
    }
}

// A fallback provider is only usable with its own key (an empty key would just
// add a failed round trip before the error is shown).
bool has_fallback(const WinHttpLlmOptions& o) { return !o.fallback.host.empty() && !o.fallback.api_key.empty(); }

// "/openai/v1/chat/completions" -> "/openai/v1/models": a cheap authenticated
// GET on the same host, used to open/keep the TLS connection.
std::string models_path(const std::string& chat_path) {
    const std::string tail = "chat/completions";
    if (chat_path.size() >= tail.size() &&
        chat_path.compare(chat_path.size() - tail.size(), tail.size(), tail) == 0) {
        return chat_path.substr(0, chat_path.size() - tail.size()) + "models";
    }
    return "/v1/models";
}

// One host the keep-alive worker keeps warm.
struct WarmTarget {
    std::string host;
    std::string key;
    std::wstring method;
    std::string path;
    bool drain{false};      // read the (small) body so the connection is reused
    bool immediately{true}; // first ping at start-up (no other warm-up covers it)
};

// Outcome of a single endpoint attempt: the stream result plus the failover
// classification the worker uses to decide whether to fall over (Req 4.2).
struct AttemptOutcome {
    LlmResult res;
    LlmFailure failure{LlmFailure::None};
    bool any_content{false};
};

} // namespace

struct WinHttpLlmClient::Shared {
    std::mutex mu;
    std::condition_variable cv;
    int active{0};
    bool shutting_down{false};
    std::vector<std::weak_ptr<CallImpl>> calls;
    // Shared session owns the HTTP/2 connection pool: pooled keep-alive TCP/TLS
    // connections are reused between calls. This is the wide-scope handle that
    // SURVIVES any single call's cancellation (Req 4.6) — a per-call cancel
    // tears down only that call's request/connect handles, never this session,
    // so cancelling a stream (RST_STREAM over HTTP/2) leaves the connection warm
    // for the next generation. Closed in ~Shared, i.e. only after every worker
    // (and the keep-alive thread) released its shared_ptr reference.
    win::HInternet session;
    std::string session_error;
    // Keep-alive worker (Req 4.5): a single background thread fires a light
    // application ping every keep_alive_ms so the TCP/TLS 1.3 connection to the
    // primary stays warm between suggestions. Owned by `shared_` so it outlives
    // the client surface and can be joined deterministically at shutdown.
    std::thread keep_alive;
};

WinHttpLlmClient::WinHttpLlmClient(WinHttpLlmOptions opts)
    : opts_(std::move(opts)), shared_(std::make_shared<Shared>()) {
    shared_->session.reset(win::open_session(L"RealTimeAI/" RTAI_VERSION_WSTRING L" (WinHTTP)"));
    if (!shared_->session) {
        shared_->session_error = "WinHttpOpen: " + win::winhttp_error_text(GetLastError());
        return;
    }
    WinHttpSetTimeouts(shared_->session.get(), opts_.resolve_timeout_ms, opts_.connect_timeout_ms,
                       opts_.send_timeout_ms, opts_.receive_timeout_ms);
    win::enable_modern_tls(shared_->session.get());
    // Prefer HTTP/2: multiplexed streams, RST_STREAM on cancel keeps TLS hot.
    DWORD http2 = WINHTTP_PROTOCOL_FLAG_HTTP2;
    WinHttpSetOption(shared_->session.get(), WINHTTP_OPTION_ENABLE_HTTP_PROTOCOL, &http2, sizeof(http2));
    // Faster cold connects, plus HTTP/2 PINGs between questions on the live client.
    win::enable_low_latency(shared_->session.get(),
                            opts_.keep_alive ? static_cast<DWORD>(opts_.keep_alive_ms) : 0);

    // Keep the connections warm (Req 4.1/4.5): the direct primary endpoint, or
    // OpenRouter in single-host mode, plus a configured fallback provider. An
    // idle TLS connection is dropped by the server after a while; without the
    // ping the first question after a quiet stretch would pay DNS + TCP + TLS
    // (often 100-300 ms) before any token.
    if (opts_.keep_alive && (!opts_.primary.host.empty() || opts_.host == "openrouter.ai" || has_fallback(opts_)))
        start_keep_alive();
}

WinHttpLlmClient::~WinHttpLlmClient() { shutdown(std::chrono::milliseconds(1500)); }

// Keep-alive worker (Req 4.5): sleeps in short slices so shutdown is prompt,
// and sends a cheap GET to the primary host whenever should_ping() says a
// keep_alive_ms interval has elapsed. A ping failure is non-fatal — the next
// real request re-establishes the connection on its own.
void WinHttpLlmClient::start_keep_alive() {
    // Hosts to keep warm: the live endpoint, then the fallback provider so a
    // failover does not pay a cold handshake either.
    std::vector<WarmTarget> targets;
    if (!opts_.primary.host.empty()) {
        targets.push_back({opts_.primary.host, opts_.primary.api_key, L"HEAD", models_path(opts_.primary.path), false, true});
    } else if (opts_.host == "openrouter.ai") {
        // warm_up() already opens this connection at start-up.
        targets.push_back({opts_.host, opts_.api_key, L"GET", "/api/v1/key", true, false});
    }
    if (has_fallback(opts_) && (targets.empty() || targets.front().host != opts_.fallback.host)) {
        targets.push_back({opts_.fallback.host, opts_.fallback.api_key, L"HEAD", models_path(opts_.fallback.path), false, true});
    }
    if (targets.empty()) return;

    {
        std::lock_guard<std::mutex> lk(shared_->mu);
        if (shared_->shutting_down) return;
        ++shared_->active;
    }
    shared_->keep_alive = std::thread([sh = shared_, opts = opts_, targets = std::move(targets)] {
        using clock = std::chrono::steady_clock;
        auto now_ms = [] {
            return std::chrono::duration_cast<std::chrono::milliseconds>(
                       clock::now().time_since_epoch()).count();
        };
        auto ping = [&](const WarmTarget& t) {
            if (!sh->session) return;
            win::HInternet conn(WinHttpConnect(sh->session.get(), win::widen(t.host).c_str(), opts.port, 0));
            if (!conn) return;
            win::HInternet hreq(WinHttpOpenRequest(conn.get(), t.method.c_str(), win::widen(t.path).c_str(),
                                                   nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                                   opts.secure ? WINHTTP_FLAG_SECURE : 0));
            if (!hreq) return;
            const std::wstring headers = auth_headers(t.key, opts, false);
            if (WinHttpSendRequest(hreq.get(), headers.c_str(), static_cast<DWORD>(-1L),
                                   WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
                WinHttpReceiveResponse(hreq.get(), nullptr) && t.drain) {
                (void)win::read_body(hreq.get(), 4096);
            }
        };

        // Start-up warm-up: the first question must not pay DNS + TCP + TLS.
        const std::int64_t start = now_ms();
        std::vector<std::int64_t> last_ping(targets.size(), start);
        for (std::size_t i = 0; i < targets.size(); ++i) {
            if (!targets[i].immediately) continue;
            {
                std::lock_guard<std::mutex> lk(sh->mu);
                if (sh->shutting_down) break;
            }
            ping(targets[i]);
            last_ping[i] = now_ms();
        }

        for (;;) {
            {
                std::unique_lock<std::mutex> lk(sh->mu);
                // Wake early on shutdown; otherwise re-check at a coarse cadence.
                sh->cv.wait_for(lk, std::chrono::milliseconds(500), [&] { return sh->shutting_down; });
                if (sh->shutting_down) break;
            }
            // Light application ping over the HTTP/2 session: it reuses the
            // pooled TLS connection, so the next generation pays no handshake.
            for (std::size_t i = 0; i < targets.size(); ++i) {
                const std::int64_t t = now_ms();
                if (!should_ping(t, last_ping[i], opts.keep_alive_ms)) continue;
                last_ping[i] = t;
                ping(targets[i]);
            }
        }
        {
            std::lock_guard<std::mutex> lk(sh->mu);
            --sh->active;
        }
        sh->cv.notify_all();
    });
}

std::shared_ptr<ILlmCall> WinHttpLlmClient::start(LlmRequest request, LlmCallbacks cb) {
    auto call = std::make_shared<CallImpl>();
    {
        std::lock_guard<std::mutex> lk(shared_->mu);
        if (shared_->shutting_down) {
            LlmResult r;
            r.status = LlmStatus::Cancelled;
            call->done = true;
            if (cb.on_done) cb.on_done(r);
            return call;
        }
        ++shared_->active;
        std::erase_if(shared_->calls, [](const std::weak_ptr<CallImpl>& w) { return w.expired(); });
        shared_->calls.push_back(call);
    }

    std::thread([sh = shared_, call, opts = opts_, req = std::move(request), cb = std::move(cb)]() mutable {
        const auto t0 = std::chrono::steady_clock::now();
        auto elapsed = [&] {
            return std::chrono::duration_cast<std::chrono::milliseconds>(
                       std::chrono::steady_clock::now() - t0).count();
        };

        // One attempt against a single host/path/model over the shared HTTP/2
        // session. Streams deltas through cb.on_delta and classifies any
        // failure so the caller can decide whether to fall over (Req 4.2/4.4).
        // host_label names the provider in error text.
        //
        // Handle ownership (Req 4.6): `conn` and `hreq` below are local to this
        // attempt and owned solely by this worker thread. `hreq` is the HTTP/2
        // request (stream) handle; `conn` is a connect handle multiplexed over
        // the shared session's pooled connection. The session itself
        // (sh->session) is NOT owned here and is never closed on this path.
        // When the cooperative cancel flag is seen between reads the attempt
        // returns, and explicit_cancel_teardown() (below) closes `hreq` first
        // — that emits RST_STREAM for the stream over HTTP/2 — then `conn`,
        // while the pooled TCP/TLS connection stays warm in sh->session for the
        // next generation (no new handshake).
        auto run_attempt = [&](const std::string& host, std::uint16_t port, bool secure,
                               const std::string& path, const std::wstring& headers,
                               const std::string& body,
                               const std::string& host_label) -> AttemptOutcome {
            AttemptOutcome out;
            out.res.status = LlmStatus::Completed;
            auto fail = [&](std::string msg, LlmFailure f) {
                out.res.status = call->cancelled.load() ? LlmStatus::Cancelled : LlmStatus::Failed;
                out.res.error = std::move(msg);
                out.failure = f;
            };

            if (!sh->session) { fail(sh->session_error, LlmFailure::Connect); return out; }
            win::HInternet conn(WinHttpConnect(sh->session.get(), win::widen(host).c_str(), port, 0));
            if (!conn) {
                const DWORD err = GetLastError();
                fail("WinHttpConnect: " + win::winhttp_error_text(err), classify_winhttp_error(err));
                return out;
            }
            win::HInternet hreq(WinHttpOpenRequest(conn.get(), L"POST", win::widen(path).c_str(),
                                                   nullptr, WINHTTP_NO_REFERER,
                                                   WINHTTP_DEFAULT_ACCEPT_TYPES,
                                                   secure ? WINHTTP_FLAG_SECURE : 0));
            if (!hreq) {
                fail("WinHttpOpenRequest: " + win::winhttp_error_text(GetLastError()),
                     LlmFailure::Connect);
                return out;
            }

            // Cooperative cancel teardown (Req 4.6): close ONLY the request
            // (stream) handle. Over HTTP/2 that sends RST_STREAM for this
            // stream; the connect handle and the shared session's pooled
            // TCP/TLS connection are left intact so the next generation reuses
            // the warm connection with no handshake. Resetting the owned
            // win::HInternet is idempotent; the later RAII close on `conn` and
            // on an already-reset `hreq` is a no-op.
            auto cancel_stream = [&]() -> AttemptOutcome& {
                out.res.status = LlmStatus::Cancelled;
                hreq.reset(); // RST_STREAM now; session/connection stay pooled
                return out;
            };

            if (call->cancelled.load()) return cancel_stream();
            if (!WinHttpSendRequest(hreq.get(), headers.c_str(), static_cast<DWORD>(-1L),
                                    const_cast<char*>(body.data()), static_cast<DWORD>(body.size()),
                                    static_cast<DWORD>(body.size()), 0)) {
                const DWORD err = GetLastError();
                fail("sending to " + host_label + " failed: " + win::winhttp_error_text(err),
                     classify_winhttp_error(err));
                return out;
            }
            if (!WinHttpReceiveResponse(hreq.get(), nullptr)) {
                const DWORD err = GetLastError();
                fail(host_label + " did not respond: " + win::winhttp_error_text(err),
                     classify_winhttp_error(err));
                return out;
            }
            const DWORD status = win::query_status(hreq.get());
            out.res.http_status = static_cast<int>(status);
            if (status != 200) {
                // 4xx surfaces the error and does NOT fall over; 5xx is retryable.
                fail(openrouter::parse_error_body(static_cast<int>(status),
                                                  win::read_body(hreq.get(), 64 * 1024)),
                     classify_status(static_cast<int>(status)));
                return out;
            }

            SseParser sse;
            std::vector<char> buf(16 * 1024);
            bool got_done = false, stream_error = false;
            for (;;) {
                if (call->cancelled.load()) return cancel_stream();
                DWORD avail = 0;
                if (!WinHttpQueryDataAvailable(hreq.get(), &avail)) {
                    const DWORD err = GetLastError();
                    fail("stream interrupted: " + win::winhttp_error_text(err),
                         classify_winhttp_error(err));
                    return out;
                }
                if (call->cancelled.load()) return cancel_stream();
                // avail == 0: probe with 1 byte; ReadData returning 0 is EOF.
                const DWORD want = avail ? std::min<DWORD>(avail, static_cast<DWORD>(buf.size())) : 1;
                DWORD read = 0;
                if (!WinHttpReadData(hreq.get(), buf.data(), want, &read)) {
                    const DWORD err = GetLastError();
                    fail("stream interrupted: " + win::winhttp_error_text(err),
                         classify_winhttp_error(err));
                    return out;
                }
                if (read == 0) break; // end of response
                sse.feed(std::string_view(buf.data(), read), [&](const SseParser::Event& ev) {
                    if (got_done || stream_error) return;
                    const auto c = openrouter::parse_chunk(ev.data);
                    if (!c.valid) return;
                    if (c.done) { got_done = true; return; }
                    if (!c.error.empty()) {
                        stream_error = true;
                        out.res.error = c.error;
                        return;
                    }
                    if (!c.content.empty() && !call->cancelled.load()) {
                        if (out.res.ttft_ms < 0) out.res.ttft_ms = elapsed();
                        out.any_content = true;
                        if (cb.on_delta) cb.on_delta(c.content);
                    }
                    if (!c.finish_reason.empty()) out.res.finish_reason = c.finish_reason;
                });
                if (got_done || stream_error) break;
            }
            if (stream_error) {
                // A mid-stream provider error with no content yet is retryable
                // (server-side); once content streamed we keep the partial.
                out.res.status = LlmStatus::Failed;
                if (!out.any_content) out.failure = LlmFailure::Server5xx;
            } else if (!out.any_content) {
                fail(out.res.finish_reason == "length"
                         ? "Token limit reached before answer completed (reasoning too long)"
                         : "The model returned no content",
                     LlmFailure::Server5xx);
            }
            return out;
        };

        AttemptOutcome final_out;
        if (opts.primary.host.empty()) {
            LlmRequest active_req = req;
            if (active_req.max_tokens < 1500) active_req.max_tokens = 1500;
            if (active_req.reasoning_effort.empty() || active_req.reasoning_effort == "minimal") {
                active_req.reasoning_effort = "none";
            }
            const std::wstring headers = request_headers(opts, true);
            const std::string sort = opts.host == "openrouter.ai" ? opts.openrouter_provider_sort : std::string();
            const std::string body = openrouter::build_request_body(active_req, false, sort);
            final_out = run_attempt(opts.host, opts.port, opts.secure, opts.path, headers, body,
                                    "OpenRouter");

            // AUTO-RECOVERY: If token limit was reached before any content streamed
            // (e.g. model spent tokens on internal CoT), immediately retry once with reasoning
            // explicitly disabled ("none") and doubled token budget (>= 2500)
            if (!final_out.any_content && final_out.res.finish_reason == "length" && !call->cancelled.load()) {
                LlmRequest retry_req = active_req;
                retry_req.reasoning_effort = "none";
                retry_req.max_tokens = std::max(active_req.max_tokens * 2, 2500);
                const std::string retry_body = openrouter::build_request_body(retry_req, false, sort);
                final_out = run_attempt(opts.host, opts.port, opts.secure, opts.path, headers, retry_body,
                                        "OpenRouter (retry without reasoning)");
            }

            // AUTO-FAILOVER: If OpenRouter failed (network/5xx/out of credit) and fallback endpoint is configured (e.g. Cerebras)
            if (final_out.res.status == LlmStatus::Failed && has_fallback(opts) && !call->cancelled.load()) {
                const LlmEndpoint& ep = opts.fallback;
                LlmRequest fb_req = active_req;
                if (!ep.model.empty()) fb_req.model = ep.model;
                fb_req.max_tokens = std::max(active_req.max_tokens, 1500);
                fb_req.reasoning_effort = "none";
                const std::wstring fb_headers = auth_headers(ep.api_key, opts, true);
                const bool cerebras = (ep.host == "api.cerebras.ai");
                const std::string fb_body = openrouter::build_request_body(fb_req, cerebras);
                final_out = run_attempt(ep.host, opts.port, opts.secure, ep.path, fb_headers, fb_body,
                                        "fallback provider (" + ep.host + ")");
            }
        } else {
            // Direct generation path: attempt 0 -> primary (Cerebras), and on a
            // retryable failure -> fallback (Groq).
            for (int attempt = 0; attempt < 2; ++attempt) {
                if (call->cancelled.load()) { final_out.res.status = LlmStatus::Cancelled; break; }
                const LlmEndpoint& ep = choose_endpoint(attempt, opts);
                if (ep.host.empty() || (attempt > 0 && ep.api_key.empty())) break; // no fallback configured
                LlmRequest r = req;
                if (!ep.model.empty()) r.model = ep.model; // per-endpoint model (Req 4.1/4.2)
                r.max_tokens = std::max(r.max_tokens, 1500);
                if (r.reasoning_effort.empty() || r.reasoning_effort == "minimal") r.reasoning_effort = "none";
                // Cerebras/Groq use the OpenAI-compatible schema, but
                // Cerebras expects top-level `reasoning_effort` rather than
                // OpenRouter's nested `reasoning` object.
                const std::wstring headers = auth_headers(ep.api_key, opts, true);
                const bool cerebras = ep.host == "api.cerebras.ai";
                if (!cerebras) r.reasoning_effort.clear();
                const std::string body = openrouter::build_request_body(r, cerebras);
                const std::string label = attempt == 0 ? "primary provider (Cerebras)"
                                                       : "fallback provider (Groq)";
                final_out = run_attempt(ep.host, opts.port, opts.secure, ep.path, headers, body,
                                        label);

                // Auto-recovery if token limit reached before content
                if (!final_out.any_content && final_out.res.finish_reason == "length" && !call->cancelled.load()) {
                    LlmRequest retry_r = r;
                    retry_r.reasoning_effort = "none";
                    retry_r.max_tokens = std::max(r.max_tokens * 2, 2500);
                    const std::string retry_body = openrouter::build_request_body(retry_r, cerebras);
                    final_out = run_attempt(ep.host, opts.port, opts.secure, ep.path, headers, retry_body,
                                            label + " (retry without reasoning)");
                }

                // Stop on success, cancellation, or a non-retryable failure
                // (4xx / content already streamed). Only a retryable failure on
                // the primary advances to the fallback (Req 4.2).
                if (final_out.res.status != LlmStatus::Failed) break;
                if (!is_retryable(final_out.failure)) break;
            }
        }

        LlmResult& res = final_out.res;
        if (call->cancelled.load() && res.status == LlmStatus::Completed) res.status = LlmStatus::Cancelled;
        res.total_ms = elapsed();
        if (cb.on_done) cb.on_done(res);
        call->done = true;
        {
            std::lock_guard<std::mutex> lk(sh->mu);
            --sh->active;
        }
        sh->cv.notify_all();
    }).detach();

    return call;
}

void WinHttpLlmClient::warm_up(std::function<void(bool, std::string)> on_result) {
    {
        std::lock_guard<std::mutex> lk(shared_->mu);
        if (shared_->shutting_down) return;
        ++shared_->active;
    }
    std::thread([sh = shared_, opts = opts_, on_result = std::move(on_result)] {
        bool ok = true;
        std::string msg;
        if (!sh->session) {
            ok = false;
            msg = sh->session_error;
        } else {
            win::HInternet conn(WinHttpConnect(sh->session.get(), win::widen(opts.host).c_str(),
                                               opts.port, 0));
            win::HInternet hreq(conn ? WinHttpOpenRequest(conn.get(), L"GET", L"/api/v1/key", nullptr,
                                                          WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                                          opts.secure ? WINHTTP_FLAG_SECURE : 0)
                                     : nullptr);
            const std::wstring headers = request_headers(opts, false);
            if (hreq && WinHttpSendRequest(hreq.get(), headers.c_str(), static_cast<DWORD>(-1L),
                                           WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
                WinHttpReceiveResponse(hreq.get(), nullptr)) {
                const DWORD status = win::query_status(hreq.get());
                const std::string body = win::read_body(hreq.get(), 16 * 1024);
                if (status == 401 || status == 403) {
                    ok = false;
                    msg = openrouter::parse_error_body(static_cast<int>(status), body);
                } else if (status == 200) {
                    msg = "OpenRouter conectado";
                } else {
                    msg = "OpenRouter answered HTTP " + std::to_string(status) + " when validating the key";
                }
            } else {
                // Network trouble is not fatal: calls retry on their own.
                msg = "could not pre-connect to OpenRouter: " +
                      win::winhttp_error_text(GetLastError());
            }
        }
        if (on_result) on_result(ok, msg);
        {
            std::lock_guard<std::mutex> lk(sh->mu);
            --sh->active;
        }
        sh->cv.notify_all();
    }).detach();
}

void WinHttpLlmClient::shutdown(std::chrono::milliseconds wait) {
    std::vector<std::shared_ptr<CallImpl>> live;
    {
        std::lock_guard<std::mutex> lk(shared_->mu);
        shared_->shutting_down = true;
        for (auto& w : shared_->calls) {
            if (auto c = w.lock()) live.push_back(std::move(c));
        }
        shared_->calls.clear();
    }
    for (auto& c : live) c->cancel();
    // Wake the keep-alive worker so it observes shutting_down and exits its
    // sleep slice promptly instead of after the current 500 ms wait.
    shared_->cv.notify_all();
    {
        std::unique_lock<std::mutex> lk(shared_->mu);
        // Workers still blocked in a read after `wait` keep `shared_` alive by
        // themselves and exit on their own; nothing they touch is freed here.
        shared_->cv.wait_for(lk, wait, [&] { return shared_->active == 0; });
    }
    // Join the keep-alive worker so its thread object is not left joinable when
    // Shared is destroyed. It owns a reference to `shared_`, so it is safe to
    // join even past `wait`; it exits as soon as it sees shutting_down.
    if (shared_->keep_alive.joinable()) shared_->keep_alive.join();
}

} // namespace rtai
