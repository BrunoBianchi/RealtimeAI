// IWebSocketFactory over WinHTTP (synchronous WebSocket API + Schannel TLS).
// All threading/reconnect policy lives in core (DeepgramStream); this adapter
// only performs I/O and honours the IWebSocket threading contract:
//   * one writer thread calls send_*/close, one reader thread calls receive;
//   * close() uses WinHttpWebSocketClose, the documented way to cancel a
//     pending synchronous receive (ERROR_WINHTTP_OPERATION_CANCELLED). We never
//     WinHttpCloseHandle a handle another thread may still be using.
#pragma once

#include <memory>
#include <string>

#include "rtai/websocket.hpp"

namespace rtai {

struct WinHttpWebSocketOptions {
    std::wstring user_agent{L"RealTimeAI/0.2 (WinHTTP)"};
    int resolve_timeout_ms{5000};
    int connect_timeout_ms{8000};
    int send_timeout_ms{10000};
    int handshake_receive_timeout_ms{15000}; // only for the HTTP upgrade
    unsigned long close_timeout_ms{2000};     // WinHttpWebSocketClose handshake wait
};

class WinHttpWebSocketFactory final : public IWebSocketFactory {
public:
    explicit WinHttpWebSocketFactory(WinHttpWebSocketOptions opts = {});

    std::unique_ptr<IWebSocket> connect(const WsConnectRequest& request,
                                        WsConnectResult& result) override;

private:
    WinHttpWebSocketOptions opts_;
};

} // namespace rtai
