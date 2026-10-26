// Pure core — single-producer / single-consumer lock-free ring buffer.
// Fixed capacity, pre-allocated, no allocation after construction. Used to
// hand audio from the WASAPI capture thread to the resample/VAD stage without
// blocking the audio callback.
#pragma once

#include <atomic>
#include <cstddef>
#include <span>
#include <vector>

namespace rtai {

template <typename T>
class SpscRingBuffer {
public:
    // capacity is rounded conceptually to hold `capacity` elements; one slot is
    // reserved to distinguish full from empty.
    explicit SpscRingBuffer(std::size_t capacity)
        : buf_(capacity + 1), cap_(capacity + 1) {}

    // Producer side: push up to src.size() elements; returns the number
    // actually written (may be < src.size() if the buffer is near full).
    std::size_t push(std::span<const T> src) noexcept {
        const std::size_t head = head_.load(std::memory_order_relaxed);
        const std::size_t tail = tail_.load(std::memory_order_acquire);
        std::size_t free_space = (tail + cap_ - head - 1) % cap_;
        std::size_t n = src.size() < free_space ? src.size() : free_space;
        for (std::size_t i = 0; i < n; ++i) {
            buf_[(head + i) % cap_] = src[i];
        }
        head_.store((head + n) % cap_, std::memory_order_release);
        return n;
    }

    // Consumer side: pop up to dst.size() elements; returns number read.
    std::size_t pop(std::span<T> dst) noexcept {
        const std::size_t tail = tail_.load(std::memory_order_relaxed);
        const std::size_t head = head_.load(std::memory_order_acquire);
        std::size_t available = (head + cap_ - tail) % cap_;
        std::size_t n = dst.size() < available ? dst.size() : available;
        for (std::size_t i = 0; i < n; ++i) {
            dst[i] = buf_[(tail + i) % cap_];
        }
        tail_.store((tail + n) % cap_, std::memory_order_release);
        return n;
    }

    [[nodiscard]] std::size_t size() const noexcept {
        const std::size_t head = head_.load(std::memory_order_acquire);
        const std::size_t tail = tail_.load(std::memory_order_acquire);
        return (head + cap_ - tail) % cap_;
    }

    [[nodiscard]] std::size_t capacity() const noexcept { return cap_ - 1; }

private:
    std::vector<T> buf_;
    std::size_t cap_;
    std::atomic<std::size_t> head_{0}; // producer writes
    std::atomic<std::size_t> tail_{0}; // consumer writes
};

} // namespace rtai
