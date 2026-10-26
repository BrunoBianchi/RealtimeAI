#include <gtest/gtest.h>

#include "rtai/audio_format.hpp"
#include "rtai/audio_frame.hpp"

using namespace rtai;

TEST(AudioFormat, RejectsZeroSampleRate) {
    EXPECT_THROW((AudioFormat{0, 2, SampleFormat::Float32}), std::invalid_argument);
}

TEST(AudioFormat, RejectsZeroChannels) {
    EXPECT_THROW((AudioFormat{48000, 0, SampleFormat::Float32}), std::invalid_argument);
}

TEST(AudioFormat, Pcm16ByteMath) {
    AudioFormat f{16000, 1, SampleFormat::Pcm16};
    EXPECT_EQ(f.bytes_per_sample(), 2);
    EXPECT_EQ(f.bytes_per_frame(), 2);        // mono
    EXPECT_EQ(f.byte_size(160), 320u);        // 10 ms @ 16 kHz mono PCM16
}

TEST(AudioFormat, Float32StereoByteMath) {
    AudioFormat f{48000, 2, SampleFormat::Float32};
    EXPECT_EQ(f.bytes_per_sample(), 4);
    EXPECT_EQ(f.bytes_per_frame(), 8);        // 2ch * 4 bytes
    EXPECT_EQ(f.byte_size(480), 3840u);       // 10 ms @ 48 kHz stereo float
}

TEST(AudioFormat, DeepgramTarget) {
    AudioFormat f = AudioFormat::deepgram_target();
    EXPECT_EQ(f.sample_rate(), 16000u);
    EXPECT_EQ(f.channels(), 1);
    EXPECT_EQ(f.format(), SampleFormat::Pcm16);
}

TEST(AudioSource, SpeakerTags) {
    EXPECT_STREQ(speaker_tag(AudioSource::Microphone), "Você");
    EXPECT_STREQ(speaker_tag(AudioSource::Loopback), "Outros");
}

TEST(AudioFrameView, HoldsViewAndMetadata) {
    std::vector<std::int16_t> buf{1, 2, 3, 4};
    PcmFrame frame{std::span<const std::int16_t>(buf), AudioSource::Loopback, 12345};
    EXPECT_EQ(frame.frame_count(), 4u);
    EXPECT_FALSE(frame.empty());
    EXPECT_EQ(frame.source(), AudioSource::Loopback);
    EXPECT_EQ(frame.capture_ticks(), 12345u);
}
