// DeepgramStream behaviour against the in-memory FakeServer: KeepAlive during
// silence, single-writer guarantee under contention, Finalize ordering,
// reconnect + backlog replay, fatal errors, watchdog and graceful close.
// Run this binary under ThreadSanitizer to validate the locking.
#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <mutex>
#include <thread>
#include <vector>

#include "fake_websocket.hpp"
#include "rtai/deepgram_stream.hpp"

using namespace rtai;
using namespace rtai::testing;
using namespace std::chrono_literals;

namespace {

DeepgramStreamConfig fast_config() {
    DeepgramStreamConfig cfg;
    cfg.api_key = "test-key";
    cfg.source = AudioSource::Loopback;
    cfg.keepalive_interval = 1000ms; // tests override when they care
    cfg.backoff.initial = 10ms;
    cfg.backoff.max = 40ms;
    cfg.close_timeout = 500ms;
    return cfg;
}

std::vector<std::int16_t> pcm(std::size_t n, std::int16_t v = 1000) {
    return std::vector<std::int16_t>(n, v);
}

struct StatusLog {
    std::mutex mu;
    std::vector<LinkState> states;
    std::vector<std::string> details;
    void add(const TransportStatus& s) {
        std::lock_guard<std::mutex> lk(mu);
        states.push_back(s.state);
        details.push_back(s.detail);
    }
    bool saw(LinkState st) {
        std::lock_guard<std::mutex> lk(mu);
        for (auto s : states) if (s == st) return true;
        return false;
    }
    LinkState last() {
        std::lock_guard<std::mutex> lk(mu);
        return states.empty() ? LinkState::Idle : states.back();
    }
};

} // namespace

TEST(DeepgramStream, BuildsAuthorizedRequest) {
    auto srv = std::make_shared<FakeServer>();
    auto factory = std::make_shared<FakeWsFactory>(srv);
    auto cfg = fast_config();
    cfg.params.language = "multi";
    DeepgramStream s{cfg, factory};
    s.open([](const TranscriptEvent&) {});
    ASSERT_TRUE(eventually([&] { return s.connected(); }));
    s.close();
    std::lock_guard<std::mutex> lk(srv->mu);
    EXPECT_EQ(factory->last_request.host, "api.deepgram.com");
    EXPECT_NE(factory->last_request.path.find("model=nova-3"), std::string::npos);
    EXPECT_NE(factory->last_request.path.find("language=multi"), std::string::npos);
    ASSERT_EQ(factory->last_request.headers.size(), 1u);
    EXPECT_EQ(factory->last_request.headers[0].second, "Token test-key");
}

TEST(DeepgramStream, KeepAliveFiresDuringSilenceWithoutAnyAudioOrServerTraffic) {
    // Reproduces the original bug: nothing is sent and the server never
    // answers (idle loopback). KeepAlive must still go out on its own timer.
    auto srv = std::make_shared<FakeServer>();
    auto cfg = fast_config();
    cfg.keepalive_interval = 40ms;
    DeepgramStream s{cfg, std::make_shared<FakeWsFactory>(srv)};
    s.open([](const TranscriptEvent&) {});
    ASSERT_TRUE(eventually([&] { return s.connected(); }));
    std::this_thread::sleep_for(300ms);
    s.close();
    const auto keepalives = srv->count_text(R"({"type":"KeepAlive"})");
    EXPECT_GE(keepalives, 3u);
    EXPECT_EQ(s.stats().keepalives_sent, keepalives);
    EXPECT_EQ(srv->connect_count(), 1); // connection never dropped
}

TEST(DeepgramStream, NoKeepAliveWhileAudioFlows) {
    auto srv = std::make_shared<FakeServer>();
    auto cfg = fast_config();
    cfg.keepalive_interval = 200ms;
    DeepgramStream s{cfg, std::make_shared<FakeWsFactory>(srv)};
    s.open([](const TranscriptEvent&) {});
    ASSERT_TRUE(eventually([&] { return s.connected(); }));
    const auto chunk = pcm(160);
    for (int i = 0; i < 40; ++i) { // ~400 ms of steady audio
        s.send_audio(chunk);
        std::this_thread::sleep_for(10ms);
    }
    const auto keepalives = srv->count_text(R"({"type":"KeepAlive"})");
    s.close();
    EXPECT_EQ(keepalives, 0u);
}

TEST(DeepgramStream, FinalizeIsOrderedAfterPrecedingAudio) {
    auto srv = std::make_shared<FakeServer>();
    srv->reply_to_audio = false;
    DeepgramStream s{fast_config(), std::make_shared<FakeWsFactory>(srv)};
    s.open([](const TranscriptEvent&) {});
    ASSERT_TRUE(eventually([&] { return s.connected(); }));

    const auto a = pcm(512);
    s.send_audio(a);
    s.send_audio(a);
    s.send_audio(a);
    s.mark_silence();
    s.send_audio(a);
    s.close();

    const auto frames = srv->snapshot();
    std::size_t before = 0, after = 0;
    bool seen_finalize = false;
    for (const auto& f : frames) {
        if (f.text && f.data == R"({"type":"Finalize"})") { seen_finalize = true; continue; }
        if (!f.text) (seen_finalize ? after : before) += f.bytes;
    }
    ASSERT_TRUE(seen_finalize);
    EXPECT_EQ(before, 3u * 512u * 2u);
    EXPECT_EQ(after, 512u * 2u);
    EXPECT_EQ(s.stats().finalizes_sent, 1u);
}

TEST(DeepgramStream, SingleWriterUnderConcurrentAudioAndControl) {
    auto srv = std::make_shared<FakeServer>();
    auto cfg = fast_config();
    cfg.keepalive_interval = 5ms; // KeepAlives interleave with everything else
    cfg.max_backlog_samples = 16000 * 600;
    DeepgramStream s{cfg, std::make_shared<FakeWsFactory>(srv)};
    std::atomic<int> events{0};
    s.open([&](const TranscriptEvent&) { events.fetch_add(1); });
    ASSERT_TRUE(eventually([&] { return s.connected(); }));

    constexpr int kChunks = 3000;
    constexpr std::size_t kSamples = 160;
    std::thread producer([&] {
        const auto c = pcm(kSamples);
        for (int i = 0; i < kChunks; ++i) {
            s.send_audio(c);
            if (i % 200 == 0) std::this_thread::sleep_for(1ms);
        }
    });
    std::thread controller([&] {
        for (int i = 0; i < 300; ++i) {
            s.mark_silence();
            if (i % 30 == 0) std::this_thread::sleep_for(1ms);
        }
    });
    std::thread observer([&] {
        for (int i = 0; i < 500; ++i) (void)s.stats();
    });
    producer.join();
    controller.join();
    observer.join();
    s.close();

    EXPECT_EQ(srv->concurrent_send_violations.load(), 0);
    EXPECT_EQ(srv->concurrent_receive_violations.load(), 0);
    EXPECT_EQ(srv->binary_bytes(), kChunks * kSamples * 2);
    EXPECT_EQ(s.stats().dropped_samples, 0u);
    EXPECT_GT(events.load(), 0);
    // CloseStream is the very last frame.
    const auto frames = srv->snapshot();
    ASSERT_FALSE(frames.empty());
    EXPECT_TRUE(frames.back().text);
    EXPECT_EQ(frames.back().data, R"({"type":"CloseStream"})");
}

TEST(DeepgramStream, ReconnectsAfterDropAndReplaysQueuedAudio) {
    auto srv = std::make_shared<FakeServer>();
    srv->break_after_frames_on_first_conn = 5;
    auto cfg = fast_config();
    DeepgramStream s{cfg, std::make_shared<FakeWsFactory>(srv)};
    StatusLog log;
    s.set_status_callback([&](const TransportStatus& st) { log.add(st); });
    s.open([](const TranscriptEvent&) {});
    ASSERT_TRUE(eventually([&] { return s.connected(); }));

    constexpr int kChunks = 60;
    const auto c = pcm(320);
    for (int i = 0; i < kChunks; ++i) {
        s.send_audio(c);
        std::this_thread::sleep_for(2ms);
    }
    ASSERT_TRUE(eventually([&] { return srv->connect_count() >= 2 && s.connected(); }));
    s.close();

    EXPECT_EQ(srv->binary_bytes(), static_cast<std::size_t>(kChunks) * 320u * 2u)
        << "audio captured during the outage must be replayed, not lost";
    EXPECT_GE(s.stats().reconnects, 1u);
    EXPECT_TRUE(log.saw(LinkState::Reconnecting));
    EXPECT_EQ(log.last(), LinkState::Closed);
}

TEST(DeepgramStream, OfflineBacklogKeepsNewestAudioWithinCap) {
    auto srv = std::make_shared<FakeServer>();
    srv->gate_connect = true; // connect() blocks until released
    srv->reply_to_audio = false;
    auto cfg = fast_config();
    cfg.max_backlog_samples = 1600; // 100 ms
    cfg.max_frame_samples = 320;
    DeepgramStream s{cfg, std::make_shared<FakeWsFactory>(srv)};
    s.open([](const TranscriptEvent&) {});

    std::vector<std::int16_t> chunk(320);
    for (int i = 0; i < 20; ++i) {
        std::fill(chunk.begin(), chunk.end(), static_cast<std::int16_t>(i));
        s.send_audio(chunk); // 6400 samples total while "offline"
    }
    srv->release_connect();
    ASSERT_TRUE(eventually([&] { return srv->binary_bytes() >= 1600u * 2u; }));
    s.close();

    EXPECT_EQ(srv->binary_bytes(), 1600u * 2u);
    EXPECT_EQ(s.stats().dropped_samples, 6400u - 1600u);
}

TEST(DeepgramStream, FatalUpgradeErrorStopsRetrying) {
    auto srv = std::make_shared<FakeServer>();
    WsConnectResult unauthorized;
    unauthorized.http_status = 401;
    unauthorized.retryable = false;
    unauthorized.error = "Deepgram recusou a chave (HTTP 401)";
    srv->connect_failures.push_back(unauthorized);
    DeepgramStream s{fast_config(), std::make_shared<FakeWsFactory>(srv)};
    StatusLog log;
    s.set_status_callback([&](const TransportStatus& st) { log.add(st); });
    s.open([](const TranscriptEvent&) {});
    ASSERT_TRUE(eventually([&] { return s.state() == LinkState::Error; }));
    std::this_thread::sleep_for(150ms);
    EXPECT_EQ(srv->connect_count(), 1);
    const auto t0 = std::chrono::steady_clock::now();
    s.close();
    EXPECT_LT(std::chrono::steady_clock::now() - t0, 500ms);
}

TEST(DeepgramStream, RetryableConnectFailuresBackOffThenConnect) {
    auto srv = std::make_shared<FakeServer>();
    WsConnectResult busy;
    busy.http_status = 503;
    busy.retryable = true;
    busy.error = "HTTP 503";
    srv->connect_failures = {busy, busy};
    DeepgramStream s{fast_config(), std::make_shared<FakeWsFactory>(srv)};
    s.open([](const TranscriptEvent&) {});
    ASSERT_TRUE(eventually([&] { return s.connected(); }));
    EXPECT_EQ(srv->connect_count(), 3);
    EXPECT_EQ(s.stats().connect_failures, 2u);
    s.close();
}

TEST(DeepgramStream, GracefulCloseIsIdempotentAndBounded) {
    auto srv = std::make_shared<FakeServer>();
    DeepgramStream s{fast_config(), std::make_shared<FakeWsFactory>(srv)};
    s.open([](const TranscriptEvent&) {});
    ASSERT_TRUE(eventually([&] { return s.connected(); }));
    s.send_audio(pcm(640));
    const auto t0 = std::chrono::steady_clock::now();
    s.close();
    s.close();
    EXPECT_LT(std::chrono::steady_clock::now() - t0, 1s);
    EXPECT_EQ(srv->count_text(R"({"type":"CloseStream"})"), 1u);
    EXPECT_EQ(s.state(), LinkState::Closed);
}

TEST(DeepgramStream, CloseWaitsBoundedTimeWhenServerNeverAnswers) {
    auto srv = std::make_shared<FakeServer>();
    srv->close_on_closestream = false; // server ignores CloseStream
    auto cfg = fast_config();
    cfg.close_timeout = 150ms;
    DeepgramStream s{cfg, std::make_shared<FakeWsFactory>(srv)};
    s.open([](const TranscriptEvent&) {});
    ASSERT_TRUE(eventually([&] { return s.connected(); }));
    const auto t0 = std::chrono::steady_clock::now();
    s.close();
    const auto took = std::chrono::steady_clock::now() - t0;
    EXPECT_GE(took, 140ms);
    EXPECT_LT(took, 1s);
}

TEST(DeepgramStream, WatchdogRecyclesConnectionThatNeverAnswers) {
    auto srv = std::make_shared<FakeServer>();
    srv->reply_to_audio = false;
    auto cfg = fast_config();
    cfg.stale_min_samples = 320;
    cfg.stale_timeout = 100ms;
    DeepgramStream s{cfg, std::make_shared<FakeWsFactory>(srv)};
    s.open([](const TranscriptEvent&) {});
    ASSERT_TRUE(eventually([&] { return s.connected(); }));
    s.send_audio(pcm(640));
    EXPECT_TRUE(eventually([&] { return srv->connect_count() >= 2; }, 2s));
    s.close();
}

TEST(DeepgramStream, DeliversParsedTranscriptsAndFinalizeFlag) {
    auto srv = std::make_shared<FakeServer>();
    srv->reply_every_bytes = 1024;
    DeepgramStream s{fast_config(), std::make_shared<FakeWsFactory>(srv)};
    std::mutex mu;
    std::vector<TranscriptEvent> got;
    s.open([&](const TranscriptEvent& ev) {
        std::lock_guard<std::mutex> lk(mu);
        got.push_back(ev);
    });
    ASSERT_TRUE(eventually([&] { return s.connected(); }));
    s.send_audio(pcm(512));
    s.mark_silence();
    ASSERT_TRUE(eventually([&] {
        std::lock_guard<std::mutex> lk(mu);
        for (const auto& e : got) if (e.from_finalize) return true;
        return false;
    }));
    s.close();
    std::lock_guard<std::mutex> lk(mu);
    ASSERT_FALSE(got.empty());
    EXPECT_EQ(got.front().source, AudioSource::Loopback);
    EXPECT_EQ(got.front().text, "ola");
    EXPECT_TRUE(got.front().is_final);
}

TEST(DeepgramStream, CloseFromInsideCallbackDoesNotDeadlock) {
    auto srv = std::make_shared<FakeServer>();
    auto stream = std::make_unique<DeepgramStream>(fast_config(), std::make_shared<FakeWsFactory>(srv));
    DeepgramStream* raw = stream.get();
    std::atomic<bool> called{false};
    stream->open([&](const TranscriptEvent&) {
        if (!called.exchange(true)) raw->close(); // reader thread
    });
    ASSERT_TRUE(eventually([&] { return stream->connected(); }));
    stream->send_audio(pcm(1024));
    ASSERT_TRUE(eventually([&] { return called.load(); }));
    stream->close(); // test thread joins normally
    EXPECT_EQ(stream->state(), LinkState::Closed);
}
