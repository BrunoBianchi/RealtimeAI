#include <gtest/gtest.h>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <numbers>
#include <vector>

#include "rtai/fake_transport.hpp"
#include "rtai/fake_vad.hpp"
#include "rtai/latency.hpp"
#include "rtai/source_pipeline.hpp"
#include "rtai/transcript_aggregator.hpp"
#include "rtai/wav_file_source.hpp"
#include "test_clock.hpp"

using namespace rtai;

namespace {

// Write a minimal PCM16 mono WAV file with a sine tone.
std::string write_tone_wav(std::uint32_t rate, double freq, double seconds) {
    const std::size_t frames = static_cast<std::size_t>(rate * seconds);
    std::vector<std::int16_t> pcm(frames);
    for (std::size_t i = 0; i < frames; ++i) {
        const double t = static_cast<double>(i) / rate;
        pcm[i] = static_cast<std::int16_t>(
            0.6 * 32767.0 * std::sin(2.0 * std::numbers::pi * freq * t));
    }

    auto path = std::filesystem::temp_directory_path() /
                ("rtai_tone_" + std::to_string(rate) + ".wav");
    std::ofstream f(path, std::ios::binary);

    auto w32 = [&](std::uint32_t v) { f.write(reinterpret_cast<const char*>(&v), 4); };
    auto w16 = [&](std::uint16_t v) { f.write(reinterpret_cast<const char*>(&v), 2); };

    const std::uint32_t data_bytes = static_cast<std::uint32_t>(pcm.size() * 2);
    f.write("RIFF", 4);
    w32(36 + data_bytes);
    f.write("WAVE", 4);
    f.write("fmt ", 4);
    w32(16);
    w16(1);                       // PCM
    w16(1);                       // mono
    w32(rate);                    // sample rate
    w32(rate * 2);                // byte rate
    w16(2);                       // block align
    w16(16);                      // bits
    f.write("data", 4);
    w32(data_bytes);
    f.write(reinterpret_cast<const char*>(pcm.data()), data_bytes);
    f.close();
    return path.string();
}

} // namespace

TEST(PipelineE2E, WavThroughResamplerVadFakeTransport) {
    FakeClock clock{1'000'000};
    MetricsRegistry metrics{clock.ticks_per_second()};

    // 1 second of 48 kHz tone; energy VAD will treat it as speech.
    const std::string wav = write_tone_wav(48000, 440.0, 1.0);

    WavFileCaptureSource capture{
        wav, AudioSource::Microphone,
        [&clock] { return clock.ticks(); }, clock.ticks_per_second(),
        /*realtime_pace=*/false};

    FakeVadGate vad{512};
    vad.set_energy_mode(0.05f); // tone is loud -> speech

    FakeTransport transport{AudioSource::Microphone};

    // Collect aggregated lines.
    std::vector<TranscriptLine> lines;
    TranscriptAggregator agg{[&](const TranscriptLine& l) { lines.push_back(l); }};

    // When enough audio has been sent, have the fake transport emit interim
    // then final transcripts (ordering assertion).
    transport.set_on_audio([&](std::size_t total, ITranscriptionTransport::TranscriptCallback& cb,
                               AudioSource src) {
        clock.advance(10); // simulate a little processing time
        if (total == 512) cb(TranscriptEvent{src, "ola", false, clock.ticks()});
        if (total == 5120) cb(TranscriptEvent{src, "ola mundo", true, clock.ticks()});
    });

    SourcePipeline pipe{capture, vad, transport, clock, metrics};
    pipe.set_transcript_sink([&](const TranscriptEvent& ev) { agg.on_event(ev); });

    pipe.start();
    capture.wait_until_done();
    pipe.stop();

    // Audio flowed to the transport.
    EXPECT_TRUE(transport.opened());
    EXPECT_GT(transport.total_samples(), 0u);

    // VAD gating sent windows (energy mode keeps the loud tone active).
    EXPECT_GT(transport.audio_calls(), 0u);

    // Transcript events reached the aggregator, interim before final.
    ASSERT_GE(lines.size(), 2u);
    EXPECT_FALSE(lines.front().is_final);
    EXPECT_TRUE(lines.back().is_final);
    EXPECT_EQ(lines.back().tag, "You");
    EXPECT_EQ(lines.back().text, "ola mundo");

    // Latency metrics were populated for the capture->vad stage.
    EXPECT_GT(metrics.stats(Stage::CaptureToVad).count, 0u);

    std::remove(wav.c_str());
}

TEST(PipelineE2E, SilenceIsGatedOut) {
    FakeClock clock{1'000'000};
    MetricsRegistry metrics{clock.ticks_per_second()};

    // Silent WAV (zero amplitude): energy VAD should gate everything out.
    const std::string wav = write_tone_wav(48000, 0.0, 0.5); // sin(0)=0 -> silence

    WavFileCaptureSource capture{
        wav, AudioSource::Loopback,
        [&clock] { return clock.ticks(); }, clock.ticks_per_second(), false};

    FakeVadGate vad{512};
    vad.set_energy_mode(0.05f);

    FakeTransport transport{AudioSource::Loopback};

    SourcePipeline pipe{capture, vad, transport, clock, metrics};
    pipe.start();
    capture.wait_until_done();
    pipe.stop();

    // No speech -> no audio windows forwarded.
    EXPECT_EQ(transport.audio_calls(), 0u);

    std::remove(wav.c_str());
}
