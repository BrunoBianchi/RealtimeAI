// Integration test: real WinHTTP WebSocket adapter + DeepgramStream against a
// local Deepgram-like server (run under Wine or on Windows).
#include <chrono>
#include <cstdio>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "rtai/deepgram_stream.hpp"
#include "rtai/winhttp_websocket.hpp"

using namespace rtai;
using namespace std::chrono_literals;

int main(int argc, char** argv) {
    const std::string scenario = argc > 1 ? argv[1] : "keepalive";
    const int port = argc > 2 ? std::atoi(argv[2]) : 8765;
    const auto silence = std::chrono::seconds(argc > 3 ? std::atoi(argv[3]) : 25);
    DeepgramStreamConfig cfg;
    cfg.params.host = "127.0.0.1";
    cfg.port = static_cast<std::uint16_t>(port);
    cfg.secure = false;
    cfg.api_key = "test-key";
    cfg.source = AudioSource::Loopback;
    cfg.keepalive_interval = scenario == "nokeepalive" ? std::chrono::milliseconds(60000)
                                                       : std::chrono::milliseconds(3000);
    cfg.backoff.initial = 200ms;
    cfg.backoff.max = 2000ms;

    const auto t0 = std::chrono::steady_clock::now();
    auto ts = [&] {
        return std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    };
    std::mutex mu;
    DeepgramStream s{cfg, std::make_shared<WinHttpWebSocketFactory>()};
    s.set_status_callback([&](const TransportStatus& st) {
        std::lock_guard<std::mutex> lk(mu);
        std::printf("[client %6.2fs] link %s: %s\n", ts(), to_string(st.state), st.detail.c_str());
        std::fflush(stdout);
    });
    int finals = 0, from_finalize = 0;
    s.open([&](const TranscriptEvent& ev) {
        std::lock_guard<std::mutex> lk(mu);
        if (ev.is_final) ++finals;
        if (ev.from_finalize) ++from_finalize;
        std::printf("[client %6.2fs] transcript%s: %s\n", ts(), ev.from_finalize ? " (from_finalize)" : "",
                    ev.text.c_str());
        std::fflush(stdout);
    });

    for (int i = 0; i < 200 && !s.connected(); ++i) std::this_thread::sleep_for(20ms);
    std::vector<std::int16_t> window(512, 900);
    auto speak = [&](int windows) {
        for (int i = 0; i < windows; ++i) {
            s.send_audio(window);
            std::this_thread::sleep_for(32ms); // real-time pace
        }
        s.mark_silence();
    };
    speak(31); // ~1 s
    std::printf("[client %6.2fs] silence for %llds (VAD gate closed)\n", ts(),
                static_cast<long long>(silence.count()));
    std::fflush(stdout);
    std::this_thread::sleep_for(silence);
    speak(16); // ~0.5 s after the silence
    std::this_thread::sleep_for(1500ms);
    s.close();
    const auto st = s.stats();
    std::printf("RESULT scenario=%s finals=%d from_finalize=%d keepalives_sent=%llu finalizes_sent=%llu "
                "reconnects=%u audio_bytes_sent=%llu dropped_samples=%llu final_state=%s\n",
                scenario.c_str(), finals, from_finalize,
                static_cast<unsigned long long>(st.keepalives_sent),
                static_cast<unsigned long long>(st.finalizes_sent), st.reconnects,
                static_cast<unsigned long long>(st.audio_bytes_sent),
                static_cast<unsigned long long>(st.dropped_samples), to_string(s.state()));
    return 0;
}
