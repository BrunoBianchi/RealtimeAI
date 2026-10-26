// Cold_Path — JevAnalyticsClient threaded body (task 8.2).
//
// Task 8.1 established the pure, header-inline builders/parsers in
// jev_analytics_client.hpp. This file implements `finalize()`: at Finalize time
// it fans out to TWO parallel WinHTTP workers on distinct threads and joins
// them all-or-nothing (Req 7.1):
//
//   Worker 1 (Jev Engine API, Req 7.2/7.3): POSTs build_engine_request() and
//     reads the response as DIRECT JSON (no SSE), parsed by
//     parse_engine_response(); governed by engine_timeout_ms (Req 8.1).
//   Worker 2 (synthetic feedback, Req 7.4/9.4): POSTs build_feedback_request()
//     (<=80 tokens) over the OpenAI-compatible chat endpoint, accumulates the
//     streamed content and reduces it to exactly 3 lines via
//     normalize_feedback(); governed by feedback_timeout_ms (Req 8.2).
//
// Join (Req 8.3/8.4): on_done(true, report) ONLY when BOTH workers succeeded
// within their own timeouts; on ANY failure/timeout the partial result from
// the other worker is discarded and on_done(false, {}) is reported, so the
// overlay never renders a partial dashboard and stays in LiveCopilot.
//
// The two workers share the project's WinHTTP infrastructure (one session with
// HTTP/2 + modern TLS enabled); each gets its own connection/request handles
// and its own receive timeout. All handles are owned and closed by the worker
// that created them — WinHTTP forbids closing a handle from another thread for
// synchronous requests.
#include "rtai/jev_analytics_client.hpp"

#include <windows.h>
#include <winhttp.h>

#include <algorithm>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "rtai/openrouter_protocol.hpp"
#include "rtai/sse_parser.hpp"
#include "rtai/version.hpp"
#include "rtai/winhttp_util.hpp"

namespace rtai {

namespace {

// Split accumulated feedback text into non-empty, trimmed lines, preserving
// order. normalize_feedback() then pads/truncates to exactly three (Req 9.4).
std::vector<std::string> split_feedback_lines(const std::string& text) {
    std::vector<std::string> lines;
    std::istringstream in(text);
    std::string raw;
    while (std::getline(in, raw)) {
        std::string line = text::trim(raw);
        // Drop a leading list marker ("- ", "* ", "1. ") if the model added one.
        if (line.size() >= 2 && (line[0] == '-' || line[0] == '*') && line[1] == ' ') {
            line = text::trim(std::string_view(line).substr(2));
        }
        if (!line.empty()) lines.push_back(std::move(line));
    }
    return lines;
}

// Opens a session with HTTP/2 + modern TLS enabled and the four coarse timeouts
// set so a stalled connect/resolve/send cannot outlive the worker. The
// per-stream gap is enforced separately via the receive timeout argument.
win::HInternet open_worker_session(int receive_timeout_ms) {
    win::HInternet session(win::open_session(L"RealTimeAI/" RTAI_VERSION_WSTRING L" (WinHTTP; Jev)"));
    if (!session) return session;
    // resolve/connect/send are bounded by the worker timeout too; receive is
    // the max gap between body chunks before we give up on this worker.
    WinHttpSetTimeouts(session.get(), 3000, 4000, 5000, receive_timeout_ms);
    win::enable_modern_tls(session.get());
    DWORD http2 = WINHTTP_PROTOCOL_FLAG_HTTP2;
    WinHttpSetOption(session.get(), WINHTTP_OPTION_ENABLE_HTTP_PROTOCOL, &http2, sizeof(http2));
    return session;
}

// Builds the request handle for a POST to `endpoint` on `conn`.
win::HInternet open_post(HINTERNET conn, const LlmEndpoint& endpoint) {
    return win::HInternet(WinHttpOpenRequest(conn, L"POST", win::widen(endpoint.path).c_str(),
                                             nullptr, WINHTTP_NO_REFERER,
                                             WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE));
}

// Worker 1 — Jev Engine API. Returns parsed scores on success, nullopt on any
// failure/timeout (Req 7.2/7.3/8.1). Read as direct JSON, never SSE.
std::optional<JevScores> run_engine_worker(const LlmEndpoint& endpoint, int timeout_ms,
                                           const std::string& body) {
    win::HInternet session = open_worker_session(timeout_ms);
    if (!session) return std::nullopt;
    win::HInternet conn(WinHttpConnect(session.get(), win::widen(endpoint.host).c_str(),
                                       INTERNET_DEFAULT_HTTPS_PORT, 0));
    if (!conn) return std::nullopt;
    win::HInternet req = open_post(conn.get(), endpoint);
    if (!req) return std::nullopt;

    std::wstring headers = L"Content-Type: application/json\r\n";
    headers += L"Accept: application/json\r\n";
    if (!endpoint.api_key.empty()) {
        headers += L"Authorization: Bearer " + win::widen(endpoint.api_key) + L"\r\n";
    }

    if (!WinHttpSendRequest(req.get(), headers.c_str(), static_cast<DWORD>(-1L),
                            const_cast<char*>(body.data()), static_cast<DWORD>(body.size()),
                            static_cast<DWORD>(body.size()), 0)) {
        return std::nullopt;
    }
    if (!WinHttpReceiveResponse(req.get(), nullptr)) return std::nullopt;
    if (win::query_status(req.get()) != 200) return std::nullopt;

    const std::string response = win::read_body(req.get(), 256 * 1024);
    return JevAnalyticsClient::parse_engine_response(response); // clamps / nullopt if malformed
}

// Worker 2 — synthetic feedback. build_feedback_request() emits an OpenAI
// chat-completions body with "stream": true, so the response is SSE; we
// accumulate choices[0].delta.content and reduce it to exactly three lines
// (Req 7.4/9.4). Returns nullopt on any failure/timeout (Req 8.2).
std::optional<std::array<std::string, 3>> run_feedback_worker(const LlmEndpoint& endpoint,
                                                              int timeout_ms,
                                                              const std::string& body) {
    win::HInternet session = open_worker_session(timeout_ms);
    if (!session) return std::nullopt;
    win::HInternet conn(WinHttpConnect(session.get(), win::widen(endpoint.host).c_str(),
                                       INTERNET_DEFAULT_HTTPS_PORT, 0));
    if (!conn) return std::nullopt;
    win::HInternet req = open_post(conn.get(), endpoint);
    if (!req) return std::nullopt;

    std::wstring headers = L"Content-Type: application/json\r\n";
    headers += L"Accept: text/event-stream\r\n";
    if (!endpoint.api_key.empty()) {
        headers += L"Authorization: Bearer " + win::widen(endpoint.api_key) + L"\r\n";
    }

    if (!WinHttpSendRequest(req.get(), headers.c_str(), static_cast<DWORD>(-1L),
                            const_cast<char*>(body.data()), static_cast<DWORD>(body.size()),
                            static_cast<DWORD>(body.size()), 0)) {
        return std::nullopt;
    }
    if (!WinHttpReceiveResponse(req.get(), nullptr)) return std::nullopt;
    if (win::query_status(req.get()) != 200) return std::nullopt;

    SseParser sse;
    std::string content;
    bool stream_error = false;
    std::vector<char> buf(16 * 1024);
    for (;;) {
        DWORD avail = 0;
        if (!WinHttpQueryDataAvailable(req.get(), &avail)) return std::nullopt;
        const DWORD want = avail ? std::min<DWORD>(avail, static_cast<DWORD>(buf.size())) : 1;
        DWORD read = 0;
        if (!WinHttpReadData(req.get(), buf.data(), want, &read)) return std::nullopt;
        if (read == 0) break; // end of response
        sse.feed(std::string_view(buf.data(), read), [&](const SseParser::Event& ev) {
            const auto c = openrouter::parse_chunk(ev.data);
            if (!c.valid || c.done) return;
            if (!c.error.empty()) {
                stream_error = true;
                return;
            }
            content += c.content;
        });
    }
    if (stream_error) return std::nullopt;

    const std::vector<std::string> lines = split_feedback_lines(content);
    if (lines.empty()) return std::nullopt; // produced no usable feedback
    return JevAnalyticsClient::normalize_feedback(lines);
}

} // namespace

void JevAnalyticsClient::finalize(const SessionTranscript& transcript,
                                  std::function<void(bool ok, JevReport report)> on_done) {
    // Build both request bodies on the calling thread while the transcript is
    // guaranteed alive, so the workers capture plain strings and never touch
    // the SessionTranscript (owned by the orchestrator thread) concurrently.
    const std::string engine_body = build_engine_request(transcript);
    const std::string feedback_body = build_feedback_request(transcript, opts_.feedback_max_tokens);

    std::thread([opts = opts_, engine_body = std::move(engine_body),
                 feedback_body = std::move(feedback_body),
                 on_done = std::move(on_done)]() mutable {
        // Each call runs on its own thread with its own timeout (Req 7.1).
        std::optional<JevScores> scores;
        std::optional<std::array<std::string, 3>> feedback;

        std::thread engine_thread([&] {
            scores = run_engine_worker(opts.engine_api, opts.engine_timeout_ms, engine_body);
        });
        std::thread feedback_thread([&] {
            feedback = run_feedback_worker(opts.feedback, opts.feedback_timeout_ms, feedback_body);
        });

        // Join all-or-nothing: wait for BOTH before deciding (Req 8.3/8.4).
        engine_thread.join();
        feedback_thread.join();

        const bool engine_ok = scores.has_value();
        const bool feedback_ok = feedback.has_value();

        // final_mode() == PostInterviewReport iff both succeeded. On any
        // failure/timeout the partial result is discarded and never rendered.
        if (final_mode(engine_ok, feedback_ok) == OverlayMode::PostInterviewReport) {
            JevReport report;
            report.scores = *scores;
            report.feedback_lines = *feedback;
            if (on_done) on_done(true, std::move(report));
        } else if (on_done) {
            on_done(false, JevReport{}); // discard partials (Req 8.4)
        }
    }).detach();
}

} // namespace rtai
