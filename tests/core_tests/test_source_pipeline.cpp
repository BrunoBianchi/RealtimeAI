// SourcePipeline: pre-roll, local turn end marker + Finalize, privacy pause,
// and device format changes.
#include <gtest/gtest.h>

#include <mutex>
#include <vector>

#include "rtai/fake_transport.hpp"
#include "rtai/fake_vad.hpp"
#include "rtai/source_pipeline.hpp"
#include "test_clock.hpp"

using namespace rtai;

namespace {

// Capture source driven synchronously by the test (the test thread plays the
// role of the capture thread).
class ManualCapture final : public IAudioCaptureSource {
public:
    ManualCapture(std::uint32_t rate, std::uint16_t channels) : fmt_(rate, channels, SampleFormat::Float32) {}
    AudioFormat format() const override { return fmt_; }
    AudioSource source() const noexcept override { return AudioSource::Loopback; }
    void start(FrameCallback cb) override { cb_ = std::move(cb); }
    void stop() override {}

    void feed_windows(std::size_t windows, std::size_t window_frames, float value = 0.2f) {
        std::vector<float> buf(windows * window_frames * fmt_.channels(), value);
        cb_(buf, 1);
    }
    void set_format(std::uint32_t rate, std::uint16_t channels) { fmt_ = AudioFormat(rate, channels, SampleFormat::Float32); }

private:
    AudioFormat fmt_;
    FrameCallback cb_;
};

struct Sink {
    std::mutex mu;
    std::vector<TranscriptEvent> events;
    void operator()(const TranscriptEvent& e) {
        std::lock_guard<std::mutex> lk(mu);
        events.push_back(e);
    }
    std::size_t turn_ends() {
        std::lock_guard<std::mutex> lk(mu);
        std::size_t n = 0;
        for (const auto& e : events) n += e.kind == TranscriptKind::LocalTurnEnd;
        return n;
    }
};

VadConfig quick_vad() {
    VadConfig v;
    v.activation_windows = 1;
    v.hangover_windows = 2;
    return v;
}

} // namespace

TEST(SourcePipeline, SendsPrerollBeforeFirstSpeechWindow) {
    FakeClock clock;
    MetricsRegistry metrics{clock.ticks_per_second()};
    ManualCapture cap{16000, 1};
    FakeVadGate vad{512};
    vad.set_script({0.1f, 0.1f, 0.1f, 0.9f});
    FakeTransport tx{AudioSource::Loopback};
    SourcePipeline pipe{cap, vad, tx, clock, metrics, quick_vad()};
    pipe.set_preroll_windows(8);
    pipe.start();

    cap.feed_windows(3, 512); // silence: buffered as pre-roll, nothing sent
    EXPECT_EQ(tx.total_samples(), 0u);
    cap.feed_windows(1, 512); // speech starts: 3 pre-roll windows + current
    EXPECT_EQ(tx.total_samples(), 4u * 512u);
    pipe.stop();
}

TEST(SourcePipeline, PrerollIsBoundedToConfiguredWindows) {
    FakeClock clock;
    MetricsRegistry metrics{clock.ticks_per_second()};
    ManualCapture cap{16000, 1};
    FakeVadGate vad{512};
    std::vector<float> script(20, 0.1f);
    script.push_back(0.9f);
    vad.set_script(script);
    FakeTransport tx{AudioSource::Loopback};
    SourcePipeline pipe{cap, vad, tx, clock, metrics, quick_vad()};
    pipe.set_preroll_windows(4);
    pipe.start();
    cap.feed_windows(21, 512);
    EXPECT_EQ(tx.total_samples(), 5u * 512u); // 4 pre-roll + the speech window
    pipe.stop();
}

TEST(SourcePipeline, TurnCloseSendsFinalizeAndLocalTurnEnd) {
    FakeClock clock;
    MetricsRegistry metrics{clock.ticks_per_second()};
    ManualCapture cap{16000, 1};
    FakeVadGate vad{512};
    vad.set_script({0.9f, 0.9f, 0.1f, 0.1f, 0.1f, 0.1f});
    FakeTransport tx{AudioSource::Loopback};
    SourcePipeline pipe{cap, vad, tx, clock, metrics, quick_vad()};
    Sink sink;
    pipe.set_transcript_sink([&](const TranscriptEvent& e) { sink(e); });
    pipe.start();
    cap.feed_windows(6, 512);
    EXPECT_EQ(tx.silence_marks(), 1u);
    EXPECT_EQ(sink.turn_ends(), 1u);
    // 2 speech + 1 hangover window sent; the closing window is not.
    EXPECT_EQ(tx.total_samples(), 3u * 512u);
    pipe.stop();
}

TEST(SourcePipeline, PauseClosesOpenTurnAndDropsAudio) {
    FakeClock clock;
    MetricsRegistry metrics{clock.ticks_per_second()};
    ManualCapture cap{16000, 1};
    FakeVadGate vad{512};
    vad.set_script({0.9f});
    FakeTransport tx{AudioSource::Loopback};
    SourcePipeline pipe{cap, vad, tx, clock, metrics, quick_vad()};
    Sink sink;
    pipe.set_transcript_sink([&](const TranscriptEvent& e) { sink(e); });
    pipe.start();
    cap.feed_windows(2, 512);
    const std::size_t sent = tx.total_samples();
    EXPECT_GT(sent, 0u);
    pipe.set_paused(true);
    cap.feed_windows(10, 512);
    EXPECT_EQ(tx.total_samples(), sent); // nothing leaves while paused
    EXPECT_EQ(tx.silence_marks(), 1u);   // open turn was finalized
    EXPECT_EQ(sink.turn_ends(), 1u);
    pipe.set_paused(false);
    cap.feed_windows(1, 512);
    EXPECT_GT(tx.total_samples(), sent);
    pipe.stop();
}

TEST(SourcePipeline, RebuildsResamplerWhenDeviceFormatChanges) {
    FakeClock clock;
    MetricsRegistry metrics{clock.ticks_per_second()};
    ManualCapture cap{16000, 1};
    FakeVadGate vad{512};
    vad.set_script({0.9f});
    FakeTransport tx{AudioSource::Loopback};
    SourcePipeline pipe{cap, vad, tx, clock, metrics, quick_vad()};
    pipe.set_preroll_windows(0);
    pipe.start();
    cap.feed_windows(1, 512);
    EXPECT_EQ(tx.total_samples(), 512u);
    cap.set_format(48000, 2); // e.g. user switched to a 48 kHz stereo headset
    cap.feed_windows(1, 1536); // 1536 frames @ 48 kHz = 512 samples @ 16 kHz
    EXPECT_NEAR(static_cast<double>(tx.total_samples()), 1024.0, 1.0);
    pipe.stop();
}
