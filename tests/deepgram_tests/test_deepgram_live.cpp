// Env-gated integration test against Deepgram Nova-3.
//
// Requires:
//   DEEPGRAM_API_KEY  — a valid key (otherwise the test is SKIPPED)
//   a speech WAV      — RTAI_SPEECH_WAV env var, or assets/sample_speech.wav
//                       bundled next to this test. A synthetic tone will NOT
//                       produce words, so we require real speech audio and
//                       skip honestly if none is available.
#include <gtest/gtest.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <filesystem>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "rtai/deepgram_transport.hpp"
#include "rtai/qpc_clock_stub.hpp"
#include "rtai/resampler.hpp"
#include "rtai/wav_file_source.hpp"

using namespace rtai;

namespace {
std::string get_env(const char* n) {
    char* buf = nullptr; size_t len = 0;
    if (_dupenv_s(&buf, &len, n) == 0 && buf) { std::string v(buf); free(buf); return v; }
    return {};
}

std::string find_speech_wav() {
    std::string env = get_env("RTAI_SPEECH_WAV");
    if (!env.empty() && std::filesystem::exists(env)) return env;
#ifdef RTAI_TEST_ASSET_DIR
    auto bundled = std::filesystem::path(RTAI_TEST_ASSET_DIR) / "sample_speech.wav";
    if (std::filesystem::exists(bundled)) return bundled.string();
#endif
    return {};
}
} // namespace

TEST(DeepgramLive, TranscribesSpeechWavToFinal) {
    const std::string key = get_env("DEEPGRAM_API_KEY");
    if (key.empty()) {
        GTEST_SKIP() << "DEEPGRAM_API_KEY not set; skipping live integration test.";
    }
    const std::string wav = find_speech_wav();
    if (wav.empty()) {
        GTEST_SKIP() << "No speech WAV (set RTAI_SPEECH_WAV or add "
                        "assets/sample_speech.wav); skipping.";
    }

    QpcClockStub clock;

    DeepgramConfig cfg;
    cfg.api_key = key;
    cfg.source = AudioSource::Microphone;
    DeepgramTransport tx{cfg, clock};

    std::mutex mu;
    std::condition_variable cv;
    std::vector<std::string> interims;
    std::string final_text;
    bool got_final = false;
    bool saw_interim_before_final = false;

    tx.open([&](const TranscriptEvent& ev) {
        std::lock_guard<std::mutex> lk(mu);
        if (!ev.is_final) {
            if (!ev.text.empty()) interims.push_back(ev.text);
        } else {
            if (!interims.empty()) saw_interim_before_final = true;
            if (!ev.text.empty()) { final_text = ev.text; got_final = true; cv.notify_all(); }
        }
    });

    // Load the WAV, resample to 16 kHz mono PCM16 (real core resampler) and
    // stream it in ~20 ms chunks as the live pipeline would.
    WavFileCaptureSource src{wav, AudioSource::Microphone,
                             [&clock] { return clock.ticks(); },
                             clock.ticks_per_second(), /*realtime=*/false};
    PcmResampler resampler{src.format().sample_rate(), src.format().channels()};

    std::vector<std::int16_t> pcm;
    src.start([&](std::span<const float> interleaved, std::uint64_t) {
        std::vector<std::int16_t> out(resampler.max_output_samples(
            interleaved.size() / src.format().channels()));
        const std::size_t n = resampler.process(interleaved, out);
        for (std::size_t i = 0; i < n; ++i) pcm.push_back(out[i]);
    });
    src.wait_until_done();

    // Send in 20 ms frames (320 samples @ 16 kHz) at real-time-ish pace.
    constexpr std::size_t frame = 320;
    for (std::size_t off = 0; off < pcm.size(); off += frame) {
        const std::size_t n = (std::min)(frame, pcm.size() - off);
        tx.send_audio(std::span<const std::int16_t>(pcm.data() + off, n));
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    tx.mark_silence();

    // Wait up to 10 s for a final transcript.
    {
        std::unique_lock<std::mutex> lk(mu);
        cv.wait_for(lk, std::chrono::seconds(10), [&] { return got_final; });
    }
    tx.close();

    EXPECT_TRUE(got_final) << "No final transcript received from Deepgram.";
    EXPECT_FALSE(final_text.empty());
    // Interim-before-final is expected with interim_results=true, but we don't
    // hard-fail on it since timing can vary.
    if (!saw_interim_before_final) {
        GTEST_LOG_(INFO) << "No interim seen before final (timing-dependent).";
    }
}
