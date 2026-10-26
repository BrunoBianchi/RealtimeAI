// Pure core: minimal WebSocket client abstraction. DeepgramStream owns all the
// threading/reconnect logic against this interface; the WinHTTP adapter
// (src/net) implements it on Windows and tests use an in-memory fake.
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace rtai {

struct WsConnectRequest {
    std::string host;
    std::uint16_t port{443};
    std::string path;                                          // path + query
    std::vector<std::pair<std::string, std::string>> headers;  // e.g. Authorization
    bool secure{true};
};

struct WsConnectResult {
    bool ok{false};
    int http_status{0};       // status of the upgrade response, 0 if none
    bool retryable{true};     // false for 400/401/402/403 (fixing needs a human)
    std::string error;        // human-readable reason (pt-BR)
    std::string request_id;   // server request id (dg-request-id), if any
};

enum class WsMessageType : std::uint8_t { Text, Binary, Close };

struct WsMessage {
    WsMessageType type{WsMessageType::Text};
    std::string data;
    std::uint16_t close_code{0};
    std::string close_reason;
};

// Threading contract (enforced by DeepgramStream, relied upon by adapters):
//   * send_text/send_binary/close are only ever called from ONE thread (the
//     stream's writer). WinHTTP rejects a second concurrent send with
//     ERROR_INVALID_OPERATION, so there is exactly one writer by design.
//   * receive() is only ever called from ONE other thread (the reader).
//   * close() must unblock a receive() pending on the reader thread (WinHTTP:
//     WinHttpWebSocketClose cancels it with ERROR_WINHTTP_OPERATION_CANCELLED).
//   * The object is destroyed only after the reader thread has been joined.
class IWebSocket {
public:
    virtual ~IWebSocket() = default;

    virtual bool send_text(std::string_view text, std::string& error) = 0;
    virtual bool send_binary(const void* data, std::size_t bytes, std::string& error) = 0;

    // Blocks until one complete message (fragments reassembled) or a close
    // frame arrives. Returns false on transport error/cancellation.
    virtual bool receive(WsMessage& out, std::string& error) = 0;

    // Starts the close handshake and cancels a pending receive. Idempotent.
    virtual void close(std::uint16_t code, std::string_view reason) = 0;
};

class IWebSocketFactory {
public:
    virtual ~IWebSocketFactory() = default;

    // Blocking connect + upgrade. Returns nullptr on failure (details in
    // `result`). Implementations must bound the time spent (timeouts).
    virtual std::unique_ptr<IWebSocket> connect(const WsConnectRequest& request,
                                                WsConnectResult& result) = 0;
};

} // namespace rtai
