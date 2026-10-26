// Pure core: FIFO of outgoing items for one Deepgram stream (audio + Finalize
// markers), bounded by audio duration. NOT thread-safe by itself; the owning
// DeepgramStream guards it with its mutex and only swaps batches out, so the
// lock is never held during network I/O.
//
// Ordering matters: a Finalize must reach the server after the audio that was
// captured before the turn closed, so audio and markers share one FIFO.
// While offline the queue keeps the most recent `max_audio_samples` of audio
// (drop-oldest) and replays it after reconnecting.
#pragma once

#include <cstddef>
#include <cstdint>
#include <deque>
#include <span>
#include <utility>
#include <vector>

namespace rtai {

class OutboundQueue {
public:
    enum class ItemType : std::uint8_t { Audio, Finalize };

    struct Item {
        ItemType type{ItemType::Audio};
        std::vector<std::int16_t> pcm; // Audio only
    };

    // max_merge_samples bounds how much audio a single queued item (and thus a
    // single binary frame) accumulates; 3200 samples = 200 ms @ 16 kHz.
    explicit OutboundQueue(std::size_t max_audio_samples,
                           std::size_t max_merge_samples = 3200)
        : max_audio_(max_audio_samples), max_merge_(max_merge_samples ? max_merge_samples : 1) {}

    // Appends audio, merging into the tail item when possible. Returns the
    // number of (oldest) samples dropped to respect the cap.
    std::size_t push_audio(std::span<const std::int16_t> pcm) {
        std::size_t off = 0;
        while (off < pcm.size()) {
            if (items_.empty() || items_.back().type != ItemType::Audio ||
                items_.back().pcm.size() >= max_merge_) {
                Item it;
                it.type = ItemType::Audio;
                it.pcm.reserve(max_merge_);
                items_.push_back(std::move(it));
            }
            auto& tail = items_.back().pcm;
            const std::size_t room = max_merge_ - tail.size();
            const std::size_t n = (pcm.size() - off) < room ? (pcm.size() - off) : room;
            tail.insert(tail.end(), pcm.begin() + static_cast<std::ptrdiff_t>(off),
                        pcm.begin() + static_cast<std::ptrdiff_t>(off + n));
            off += n;
            audio_samples_ += n;
        }
        return enforce_cap();
    }

    // Adds a Finalize marker. Consecutive markers collapse into one.
    void push_finalize() {
        if (!items_.empty() && items_.back().type == ItemType::Finalize) return;
        Item it;
        it.type = ItemType::Finalize;
        items_.push_back(std::move(it));
    }

    // Moves everything out (the writer sends it without holding the lock).
    std::deque<Item> take_all() {
        std::deque<Item> out;
        out.swap(items_);
        audio_samples_ = 0;
        return out;
    }

    // Puts unsent items back at the front (after a failed send), preserving
    // order relative to anything queued meanwhile. Returns samples dropped.
    std::size_t push_front(std::deque<Item>&& unsent) {
        for (const auto& it : unsent) {
            if (it.type == ItemType::Audio) audio_samples_ += it.pcm.size();
        }
        for (auto it = unsent.rbegin(); it != unsent.rend(); ++it) {
            items_.push_front(std::move(*it));
        }
        return enforce_cap();
    }

    void clear() {
        items_.clear();
        audio_samples_ = 0;
    }

    [[nodiscard]] bool empty() const noexcept { return items_.empty(); }
    [[nodiscard]] std::size_t audio_samples() const noexcept { return audio_samples_; }
    [[nodiscard]] std::size_t item_count() const noexcept { return items_.size(); }
    [[nodiscard]] std::size_t max_audio_samples() const noexcept { return max_audio_; }

private:
    // Drops the oldest audio until within the cap; Finalize markers are kept.
    std::size_t enforce_cap() {
        if (audio_samples_ <= max_audio_) return 0;
        std::size_t excess = audio_samples_ - max_audio_;
        std::size_t dropped = 0;
        auto it = items_.begin();
        while (excess > 0 && it != items_.end()) {
            if (it->type != ItemType::Audio) { ++it; continue; }
            auto& pcm = it->pcm;
            if (pcm.size() <= excess) {
                excess -= pcm.size();
                dropped += pcm.size();
                audio_samples_ -= pcm.size();
                it = items_.erase(it);
            } else {
                pcm.erase(pcm.begin(), pcm.begin() + static_cast<std::ptrdiff_t>(excess));
                dropped += excess;
                audio_samples_ -= excess;
                excess = 0;
            }
        }
        return dropped;
    }

    std::size_t max_audio_;
    std::size_t max_merge_;
    std::deque<Item> items_;
    std::size_t audio_samples_{0};
};

} // namespace rtai
