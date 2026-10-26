// Pure core types — no <windows.h>, no third-party deps.
#pragma once

#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <string>

namespace rtai {

// Which physical source a frame came from. Drives the transcript tag.
enum class AudioSource : std::uint8_t {
    Microphone = 0, // tagged "Você"
    Loopback = 1,   // tagged "Outros"
};

constexpr const char* to_string(AudioSource s) noexcept {
    switch (s) {
        case AudioSource::Microphone: return "Microphone";
        case AudioSource::Loopback:   return "Loopback";
    }
    return "Unknown";
}

// The human-facing tag used in the aggregated transcript.
// Display label (HUD, console, saved sessions). speaker_tag() below is the
// tag the prompts are written around ("[Você]"/"[Outros]") and stays as is.
constexpr const char* speaker_label(AudioSource s) noexcept {
    return s == AudioSource::Microphone ? "You" : "Others";
}

constexpr const char* speaker_tag(AudioSource s) noexcept {
    switch (s) {
        case AudioSource::Microphone: return "Você";
        case AudioSource::Loopback:   return "Outros";
    }
    return "?";
}

// Sample format of a PCM stream. We only ever feed Deepgram 16 kHz mono PCM16,
// but capture devices report their own format, so this type is general.
enum class SampleFormat : std::uint8_t {
    Float32 = 0, // IEEE float, typical of WASAPI shared-mode capture
    Pcm16 = 1,   // signed 16-bit, what Deepgram linear16 expects
};

// Describes a PCM audio format. Immutable value type; validated on construction.
class AudioFormat {
public:
    AudioFormat(std::uint32_t sample_rate, std::uint16_t channels, SampleFormat format)
        : sample_rate_(sample_rate), channels_(channels), format_(format) {
        if (sample_rate == 0) {
            throw std::invalid_argument("AudioFormat: sample_rate must be > 0");
        }
        if (channels == 0) {
            throw std::invalid_argument("AudioFormat: channels must be > 0");
        }
    }

    [[nodiscard]] std::uint32_t sample_rate() const noexcept { return sample_rate_; }
    [[nodiscard]] std::uint16_t channels() const noexcept { return channels_; }
    [[nodiscard]] SampleFormat format() const noexcept { return format_; }

    [[nodiscard]] std::uint16_t bytes_per_sample() const noexcept {
        switch (format_) {
            case SampleFormat::Float32: return 4;
            case SampleFormat::Pcm16:   return 2;
        }
        return 0;
    }

    // Bytes occupied by one frame = all channels for a single sample instant.
    [[nodiscard]] std::uint32_t bytes_per_frame() const noexcept {
        return static_cast<std::uint32_t>(bytes_per_sample()) * channels_;
    }

    // Number of bytes for `frame_count` sample instants.
    [[nodiscard]] std::size_t byte_size(std::size_t frame_count) const noexcept {
        return static_cast<std::size_t>(bytes_per_frame()) * frame_count;
    }

    // The canonical format Deepgram Nova-3 is configured for in this project.
    static AudioFormat deepgram_target() { return AudioFormat{16000, 1, SampleFormat::Pcm16}; }

    friend bool operator==(const AudioFormat& a, const AudioFormat& b) noexcept {
        return a.sample_rate_ == b.sample_rate_ && a.channels_ == b.channels_ &&
               a.format_ == b.format_;
    }

private:
    std::uint32_t sample_rate_;
    std::uint16_t channels_;
    SampleFormat format_;
};

} // namespace rtai
