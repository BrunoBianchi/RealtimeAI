// Pure core — ITranscriptionTransport fake for tests/demo. Instead of talking
// to Deepgram, it echoes scripted transcript events and counts audio bytes and
// KeepAlive/silence marks so tests can assert pipeline behaviour.
#pragma once

#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <vector>

#include "rtai/interfaces.hpp"

namespace rtai {

class FakeTransport : public ITranscriptionTransport {
public:
    explicit FakeTransport(AudioSource source) : source_(source) {}

    // Optional hook: called with the running total of PCM samples sent; lets a
    // test/demo emit scripted transcripts at chosen points.
    using OnAudioHook = std::function<void(std::size_t total_samples_sent,
                                           ITranscriptionTransport::TranscriptCallback& cb,
                                           AudioSource src)>;
    void set_on_audio(OnAudioHook hook) { on_audio_ = std::move(hook); }

    void open(TranscriptCallback cb) override {
        std::lock_guard<std::mutex> lk(mu_);
        cb_ = std::move(cb);
        opened_ = true;
    }

    void send_audio(std::span<const std::int16_t> pcm) override {
        std::lock_guard<std::mutex> lk(mu_);
        total_samples_ += pcm.size();
        ++audio_calls_;
        if (on_audio_ && cb_) on_audio_(total_samples_, cb_, source_);
    }

    void mark_silence() override {
        std::lock_guard<std::mutex> lk(mu_);
        ++silence_marks_;
    }

    void close() override {
        std::lock_guard<std::mutex> lk(mu_);
        closed_ = true;
    }

    // Test helper: push a transcript event through the callback.
    void emit(std::string text, bool is_final) {
        std::lock_guard<std::mutex> lk(mu_);
        if (cb_) cb_(TranscriptEvent{source_, std::move(text), is_final, 0});
    }

    // Accessors for assertions.
    std::size_t total_samples() { std::lock_guard<std::mutex> lk(mu_); return total_samples_; }
    std::size_t audio_calls() { std::lock_guard<std::mutex> lk(mu_); return audio_calls_; }
    std::size_t silence_marks() { std::lock_guard<std::mutex> lk(mu_); return silence_marks_; }
    bool opened() { std::lock_guard<std::mutex> lk(mu_); return opened_; }
    bool closed() { std::lock_guard<std::mutex> lk(mu_); return closed_; }

private:
    AudioSource source_;
    std::mutex mu_;
    TranscriptCallback cb_;
    OnAudioHook on_audio_;
    std::size_t total_samples_{0};
    std::size_t audio_calls_{0};
    std::size_t silence_marks_{0};
    bool opened_{false};
    bool closed_{false};
};

} // namespace rtai
