#include "rtai/winhttp_websocket.hpp"

#include <windows.h>
#include <winhttp.h>

#include <atomic>
#include <chrono>
#include <vector>

#include "rtai/winhttp_util.hpp"

namespace rtai {

namespace {

using win::HInternet;

constexpr std::size_t kMaxMessageBytes = 4 * 1024 * 1024;

std::string describe_upgrade_failure(DWORD status, const std::string& dg_error,
                                     const std::string& body) {
    std::string base;
    switch (status) {
        case 400: base = "Deepgram rejected the parameters (HTTP 400)"; break;
        case 401: base = "Deepgram rejected the key (HTTP 401): check [deepgram] api_key in config.ini"; break;
        case 402: base = "No Deepgram credits left (HTTP 402)"; break;
        case 403: base = "Key not allowed to stream (HTTP 403)"; break;
        case 429: base = "Deepgram rate limit (HTTP 429)"; break;
        default:  base = "WebSocket upgrade failed (HTTP " + std::to_string(status) + ")"; break;
    }
    std::string extra = !dg_error.empty() ? dg_error : body.substr(0, 200);
    if (!extra.empty()) base += ": " + extra;
    return base;
}

class WinHttpWebSocket final : public IWebSocket {
public:
    WinHttpWebSocket(HInternet session, HInternet connection, HINTERNET ws)
        : session_(std::move(session)), connection_(std::move(connection)), ws_(ws) {
        buf_.resize(64 * 1024);
    }

    ~WinHttpWebSocket() override {
        // DeepgramStream guarantees the reader thread has been joined before
        // destruction, so closing the handle here cannot race a receive.
        close(WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS, {});
        if (ws_) WinHttpCloseHandle(ws_);
        ws_ = nullptr;
    }

    bool send_text(std::string_view text, std::string& error) override {
        const DWORD rc = WinHttpWebSocketSend(ws_, WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE,
                                              const_cast<char*>(text.data()),
                                              static_cast<DWORD>(text.size()));
        if (rc != NO_ERROR) {
            error = win::winhttp_error_text(rc);
            return false;
        }
        return true;
    }

    bool send_binary(const void* data, std::size_t bytes, std::string& error) override {
        const DWORD rc = WinHttpWebSocketSend(ws_, WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE,
                                              const_cast<void*>(data), static_cast<DWORD>(bytes));
        if (rc != NO_ERROR) {
            error = win::winhttp_error_text(rc);
            return false;
        }
        return true;
    }

    bool receive(WsMessage& out, std::string& error) override {
        out.data.clear();
        for (;;) {
            DWORD read = 0;
            WINHTTP_WEB_SOCKET_BUFFER_TYPE type{};
            const auto t0 = std::chrono::steady_clock::now();
            const DWORD rc = WinHttpWebSocketReceive(ws_, buf_.data(), static_cast<DWORD>(buf_.size()),
                                                     &read, &type);
            if (rc == ERROR_WINHTTP_TIMEOUT && !closing_.load() && out.data.empty()) {
                // Defensive: Deepgram is legitimately silent for long periods
                // (we disable the receive timeout after the upgrade). If a
                // timeout still surfaces after a real wait, keep listening; if
                // it comes back instantly the handle is dead, so give up.
                if (std::chrono::steady_clock::now() - t0 >= std::chrono::milliseconds(500)) continue;
            }
            if (rc != NO_ERROR) {
                error = win::winhttp_error_text(rc);
                return false;
            }
            switch (type) {
                case WINHTTP_WEB_SOCKET_UTF8_FRAGMENT_BUFFER_TYPE:
                case WINHTTP_WEB_SOCKET_BINARY_FRAGMENT_BUFFER_TYPE:
                    out.data.append(buf_.data(), read);
                    if (out.data.size() > kMaxMessageBytes) {
                        error = "server message too large";
                        return false;
                    }
                    continue;
                case WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE:
                    out.data.append(buf_.data(), read);
                    out.type = WsMessageType::Text;
                    return true;
                case WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE:
                    out.data.append(buf_.data(), read);
                    out.type = WsMessageType::Binary;
                    return true;
                case WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE: {
                    USHORT status = 0;
                    BYTE reason[WINHTTP_WEB_SOCKET_MAX_CLOSE_REASON_LENGTH] = {};
                    DWORD reason_len = 0;
                    if (WinHttpWebSocketQueryCloseStatus(ws_, &status, reason, sizeof(reason),
                                                         &reason_len) == NO_ERROR) {
                        out.close_code = status;
                        out.close_reason.assign(reinterpret_cast<const char*>(reason), reason_len);
                    }
                    out.type = WsMessageType::Close;
                    return true;
                }
                default:
                    continue;
            }
        }
    }

    void close(std::uint16_t code, std::string_view reason) override {
        if (closing_.exchange(true)) return;
        // Cancels a receive pending on the reader thread and performs the
        // close handshake (bounded by WINHTTP_OPTION_WEB_SOCKET_CLOSE_TIMEOUT).
        const DWORD len = static_cast<DWORD>(reason.size() > WINHTTP_WEB_SOCKET_MAX_CLOSE_REASON_LENGTH
                                                 ? WINHTTP_WEB_SOCKET_MAX_CLOSE_REASON_LENGTH
                                                 : reason.size());
        WinHttpWebSocketClose(ws_, code, len ? const_cast<char*>(reason.data()) : nullptr, len);
    }

private:
    HInternet session_;
    HInternet connection_;
    HINTERNET ws_{nullptr};
    std::vector<char> buf_;
    std::atomic<bool> closing_{false};
};

} // namespace

WinHttpWebSocketFactory::WinHttpWebSocketFactory(WinHttpWebSocketOptions opts)
    : opts_(std::move(opts)) {}

std::unique_ptr<IWebSocket> WinHttpWebSocketFactory::connect(const WsConnectRequest& request,
                                                             WsConnectResult& result) {
    result = WsConnectResult{};
    auto fail = [&](const char* step, DWORD code, bool retryable = true) -> std::unique_ptr<IWebSocket> {
        result.ok = false;
        result.retryable = retryable;
        result.error = std::string(step) + ": " + win::winhttp_error_text(code);
        return nullptr;
    };

    HInternet session(win::open_session(opts_.user_agent.c_str()));
    if (!session) return fail("WinHttpOpen", GetLastError());
    WinHttpSetTimeouts(session.get(), opts_.resolve_timeout_ms, opts_.connect_timeout_ms,
                       opts_.send_timeout_ms, opts_.handshake_receive_timeout_ms);
    win::enable_modern_tls(session.get());
    win::enable_low_latency(session.get()); // faster (re)connects to Deepgram

    const std::wstring host = win::widen(request.host);
    HInternet connection(WinHttpConnect(session.get(), host.c_str(), request.port, 0));
    if (!connection) return fail("WinHttpConnect", GetLastError());

    const std::wstring path = win::widen(request.path);
    HInternet req(WinHttpOpenRequest(connection.get(), L"GET", path.c_str(), nullptr,
                                     WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                     request.secure ? WINHTTP_FLAG_SECURE : 0));
    if (!req) return fail("WinHttpOpenRequest", GetLastError());

    if (!WinHttpSetOption(req.get(), WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, nullptr, 0)) {
        return fail("WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET", GetLastError(), false);
    }
    for (const auto& [name, value] : request.headers) {
        const std::wstring line = win::widen(name + ": " + value);
        WinHttpAddRequestHeaders(req.get(), line.c_str(), static_cast<DWORD>(-1L),
                                 WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE);
    }

    if (!WinHttpSendRequest(req.get(), WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA,
                            0, 0, 0)) {
        return fail("WinHttpSendRequest", GetLastError());
    }
    if (!WinHttpReceiveResponse(req.get(), nullptr)) {
        return fail("WinHttpReceiveResponse", GetLastError());
    }

    const DWORD status = win::query_status(req.get());
    result.http_status = static_cast<int>(status);
    result.request_id = win::query_header(req.get(), L"dg-request-id");
    if (status != 101) {
        const std::string dg_error = win::query_header(req.get(), L"dg-error");
        const std::string body = win::read_body(req.get(), 4096);
        result.ok = false;
        result.retryable = status == 408 || status == 429 || status >= 500;
        result.error = describe_upgrade_failure(status, dg_error, body);
        return nullptr;
    }

    // From here on the socket may legitimately stay quiet for minutes: lift
    // the handshake receive timeout before upgrading (option inheritance is
    // undocumented, so it is also set on the WebSocket handle below).
    DWORD infinite = 0;
    WinHttpSetOption(req.get(), WINHTTP_OPTION_RECEIVE_TIMEOUT, &infinite, sizeof(infinite));

    HINTERNET ws = WinHttpWebSocketCompleteUpgrade(req.get(), 0);
    if (!ws) return fail("WinHttpWebSocketCompleteUpgrade", GetLastError());
    req.reset(); // the WebSocket handle is independent from here on

    WinHttpSetOption(ws, WINHTTP_OPTION_RECEIVE_TIMEOUT, &infinite, sizeof(infinite));
#ifdef WINHTTP_OPTION_WEB_SOCKET_CLOSE_TIMEOUT
    DWORD close_timeout = opts_.close_timeout_ms;
    WinHttpSetOption(ws, WINHTTP_OPTION_WEB_SOCKET_CLOSE_TIMEOUT, &close_timeout,
                     sizeof(close_timeout));
#endif

    result.ok = true;
    return std::make_unique<WinHttpWebSocket>(std::move(session), std::move(connection), ws);
}

} // namespace rtai
