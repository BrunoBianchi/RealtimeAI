#include "rtai/deepgram_transport.hpp"

#include <chrono>

#include "rtai/winhttp_websocket.hpp"

namespace rtai {

namespace {

DeepgramStreamConfig from_simple(DeepgramConfig cfg) {
    DeepgramStreamConfig out;
    out.params = std::move(cfg.params);
    out.api_key = std::move(cfg.api_key);
    out.source = cfg.source;
    out.keepalive_interval = std::chrono::milliseconds(cfg.keepalive_ms ? cfg.keepalive_ms : 3000);
    return out;
}

} // namespace

DeepgramTransport::DeepgramTransport(DeepgramConfig cfg, const IClock& clock)
    : DeepgramTransport(from_simple(std::move(cfg)), clock) {}

DeepgramTransport::DeepgramTransport(DeepgramStreamConfig cfg, const IClock& clock)
    : stream_(std::make_unique<DeepgramStream>(std::move(cfg),
                                               std::make_shared<WinHttpWebSocketFactory>(),
                                               &clock)) {}

DeepgramTransport::~DeepgramTransport() {
    if (stream_) stream_->close();
}

} // namespace rtai
