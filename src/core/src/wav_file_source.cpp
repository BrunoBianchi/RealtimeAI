#include "rtai/wav_file_source.hpp"

#include <chrono>
#include <cstring>
#include <fstream>
#include <stdexcept>

namespace rtai {

namespace {
std::uint32_t read_u32(const unsigned char* p) {
    return static_cast<std::uint32_t>(p[0]) | (static_cast<std::uint32_t>(p[1]) << 8) |
           (static_cast<std::uint32_t>(p[2]) << 16) | (static_cast<std::uint32_t>(p[3]) << 24);
}
std::uint16_t read_u16(const unsigned char* p) {
    return static_cast<std::uint16_t>(p[0]) | (static_cast<std::uint16_t>(p[1]) << 8);
}
} // namespace

WavFileCaptureSource::WavFileCaptureSource(std::string path, AudioSource source,
                                           std::function<std::uint64_t()> tick_now,
                                           std::uint64_t ticks_per_second,
                                           bool realtime_pace)
    : path_(std::move(path)), source_(source), tick_now_(std::move(tick_now)),
      ticks_per_second_(ticks_per_second), realtime_pace_(realtime_pace) {
    load();
}

WavFileCaptureSource::~WavFileCaptureSource() { stop(); }

void WavFileCaptureSource::load() {
    std::ifstream f(path_, std::ios::binary);
    if (!f) throw std::runtime_error("WavFileCaptureSource: cannot open " + path_);
    std::vector<unsigned char> bytes((std::istreambuf_iterator<char>(f)),
                                     std::istreambuf_iterator<char>());
    if (bytes.size() < 44) throw std::runtime_error("WavFileCaptureSource: file too small");
    if (std::memcmp(bytes.data(), "RIFF", 4) != 0 ||
        std::memcmp(bytes.data() + 8, "WAVE", 4) != 0) {
        throw std::runtime_error("WavFileCaptureSource: not a RIFF/WAVE file");
    }

    // Walk chunks to find "fmt " and "data".
    std::uint16_t audio_format = 0, channels = 0, bits = 0;
    std::uint32_t sample_rate = 0;
    const unsigned char* data_ptr = nullptr;
    std::uint32_t data_size = 0;

    std::size_t pos = 12;
    while (pos + 8 <= bytes.size()) {
        const unsigned char* chunk = bytes.data() + pos;
        std::uint32_t chunk_size = read_u32(chunk + 4);
        const unsigned char* body = chunk + 8;
        if (std::memcmp(chunk, "fmt ", 4) == 0 && chunk_size >= 16) {
            audio_format = read_u16(body);
            channels = read_u16(body + 2);
            sample_rate = read_u32(body + 4);
            bits = read_u16(body + 14);
        } else if (std::memcmp(chunk, "data", 4) == 0) {
            data_ptr = body;
            data_size = chunk_size;
            if (body + data_size > bytes.data() + bytes.size()) {
                data_size = static_cast<std::uint32_t>(bytes.data() + bytes.size() - body);
            }
        }
        pos += 8 + chunk_size + (chunk_size & 1u); // chunks are word-aligned
    }

    if (channels == 0 || sample_rate == 0 || data_ptr == nullptr) {
        throw std::runtime_error("WavFileCaptureSource: missing fmt/data chunk");
    }

    wav_channels_ = channels;
    wav_sample_rate_ = sample_rate;

    // Convert to interleaved float. Support PCM16 (1) and IEEE float (3).
    if (audio_format == 1 && bits == 16) {
        const std::size_t n = data_size / 2;
        samples_.resize(n);
        for (std::size_t i = 0; i < n; ++i) {
            std::int16_t s = static_cast<std::int16_t>(read_u16(data_ptr + i * 2));
            samples_[i] = static_cast<float>(s) / 32768.0f;
        }
    } else if (audio_format == 3 && bits == 32) {
        const std::size_t n = data_size / 4;
        samples_.resize(n);
        std::memcpy(samples_.data(), data_ptr, n * 4);
    } else {
        throw std::runtime_error("WavFileCaptureSource: unsupported WAV encoding "
                                 "(need PCM16 or float32)");
    }

    format_ = AudioFormat{wav_sample_rate_, wav_channels_, SampleFormat::Float32};
}

void WavFileCaptureSource::start(FrameCallback cb) {
    cb_ = std::move(cb);
    running_ = true;
    done_ = false;
    thread_ = std::thread([this] { run(); });
}

void WavFileCaptureSource::run() {
    // Emit in ~20 ms chunks to mimic a real capture callback cadence.
    const std::size_t frames_per_chunk =
        static_cast<std::size_t>(wav_sample_rate_) / 50; // 20 ms
    const std::size_t samples_per_chunk = frames_per_chunk * wav_channels_;
    const auto chunk_duration = std::chrono::microseconds(20000);

    std::size_t offset = 0;
    while (running_ && offset < samples_.size()) {
        const std::size_t remaining = samples_.size() - offset;
        const std::size_t n = remaining < samples_per_chunk ? remaining : samples_per_chunk;
        if (cb_) {
            cb_(std::span<const float>(samples_.data() + offset, n),
                tick_now_ ? tick_now_() : 0);
        }
        offset += n;
        if (realtime_pace_) std::this_thread::sleep_for(chunk_duration);
    }
    done_ = true;
}

void WavFileCaptureSource::stop() {
    running_ = false;
    if (thread_.joinable()) thread_.join();
}

void WavFileCaptureSource::wait_until_done() {
    if (thread_.joinable()) thread_.join();
}

} // namespace rtai
