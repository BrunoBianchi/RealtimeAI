#include <gtest/gtest.h>

#include <atomic>
#include <thread>
#include <vector>

#include "rtai/ring_buffer.hpp"

using namespace rtai;

TEST(RingBuffer, PushPopRoundTrip) {
    SpscRingBuffer<int> rb{8};
    int in[] = {1, 2, 3, 4};
    EXPECT_EQ(rb.push(std::span<const int>(in, 4)), 4u);
    EXPECT_EQ(rb.size(), 4u);
    int out[4] = {};
    EXPECT_EQ(rb.pop(std::span<int>(out, 4)), 4u);
    EXPECT_EQ(out[0], 1);
    EXPECT_EQ(out[3], 4);
    EXPECT_EQ(rb.size(), 0u);
}

TEST(RingBuffer, RespectsCapacityOnFull) {
    SpscRingBuffer<int> rb{4};
    int in[] = {1, 2, 3, 4, 5, 6};
    const std::size_t pushed = rb.push(std::span<const int>(in, 6));
    EXPECT_EQ(pushed, 4u); // one slot reserved; capacity() == 4
    EXPECT_EQ(rb.capacity(), 4u);
}

TEST(RingBuffer, WrapsAround) {
    SpscRingBuffer<int> rb{4};
    int a[] = {1, 2, 3};
    rb.push(std::span<const int>(a, 3));
    int tmp[3];
    rb.pop(std::span<int>(tmp, 3)); // drain, advance tail
    int b[] = {4, 5, 6};
    EXPECT_EQ(rb.push(std::span<const int>(b, 3)), 3u); // wraps
    int out[3];
    EXPECT_EQ(rb.pop(std::span<int>(out, 3)), 3u);
    EXPECT_EQ(out[0], 4);
    EXPECT_EQ(out[2], 6);
}

TEST(RingBuffer, SpscConcurrentTransfer) {
    SpscRingBuffer<int> rb{1024};
    constexpr int N = 100000;
    std::thread producer([&] {
        int next = 0;
        while (next < N) {
            int batch[32];
            int count = 0;
            while (count < 32 && next + count < N) { batch[count] = next + count; ++count; }
            std::size_t done = 0;
            while (done < static_cast<std::size_t>(count)) {
                done += rb.push(std::span<const int>(batch + done, count - done));
            }
            next += count;
        }
    });

    std::vector<int> received;
    received.reserve(N);
    int out[64];
    while (static_cast<int>(received.size()) < N) {
        std::size_t n = rb.pop(std::span<int>(out, 64));
        for (std::size_t i = 0; i < n; ++i) received.push_back(out[i]);
    }
    producer.join();

    ASSERT_EQ(static_cast<int>(received.size()), N);
    for (int i = 0; i < N; ++i) EXPECT_EQ(received[i], i);
}
