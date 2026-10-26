#include <gtest/gtest.h>

#include <chrono>
#include <vector>

#include "rtai/backoff.hpp"
#include "rtai/outbound_queue.hpp"

using namespace rtai;
using namespace std::chrono_literals;

namespace {
std::vector<std::int16_t> seq(std::size_t n, std::int16_t start) {
    std::vector<std::int16_t> v(n);
    for (std::size_t i = 0; i < n; ++i) v[i] = static_cast<std::int16_t>(start + static_cast<std::int16_t>(i));
    return v;
}
} // namespace

TEST(OutboundQueue, MergesAudioUpToMaxFrame) {
    OutboundQueue q{100000, 1000};
    const auto a = seq(400, 0);
    q.push_audio(a);
    q.push_audio(a);
    q.push_audio(a); // 1200 samples -> items of 1000 + 200
    EXPECT_EQ(q.audio_samples(), 1200u);
    auto items = q.take_all();
    ASSERT_EQ(items.size(), 2u);
    EXPECT_EQ(items[0].pcm.size(), 1000u);
    EXPECT_EQ(items[1].pcm.size(), 200u);
    EXPECT_TRUE(q.empty());
    EXPECT_EQ(q.audio_samples(), 0u);
}

TEST(OutboundQueue, FinalizeSplitsAudioAndCoalesces) {
    OutboundQueue q{100000};
    q.push_audio(seq(10, 0));
    q.push_finalize();
    q.push_finalize(); // coalesced
    q.push_audio(seq(10, 10));
    auto items = q.take_all();
    ASSERT_EQ(items.size(), 3u);
    EXPECT_EQ(items[0].type, OutboundQueue::ItemType::Audio);
    EXPECT_EQ(items[1].type, OutboundQueue::ItemType::Finalize);
    EXPECT_EQ(items[2].type, OutboundQueue::ItemType::Audio);
    EXPECT_EQ(items[2].pcm.front(), 10);
}

TEST(OutboundQueue, CapDropsOldestSamplesFirst) {
    OutboundQueue q{100, 64};
    const std::size_t dropped = q.push_audio(seq(150, 0));
    EXPECT_EQ(dropped, 50u);
    EXPECT_EQ(q.audio_samples(), 100u);
    auto items = q.take_all();
    ASSERT_FALSE(items.empty());
    EXPECT_EQ(items.front().pcm.front(), 50); // newest 100 samples kept
    EXPECT_EQ(items.back().pcm.back(), 149);
}

TEST(OutboundQueue, PushFrontRestoresOrderAndCap) {
    OutboundQueue q{1000, 100};
    q.push_audio(seq(100, 0));
    q.push_finalize();
    auto unsent = q.take_all();
    q.push_audio(seq(50, 500)); // arrived while the send was failing
    const std::size_t dropped = q.push_front(std::move(unsent));
    EXPECT_EQ(dropped, 0u);
    auto items = q.take_all();
    ASSERT_EQ(items.size(), 3u);
    EXPECT_EQ(items[0].pcm.front(), 0);
    EXPECT_EQ(items[1].type, OutboundQueue::ItemType::Finalize);
    EXPECT_EQ(items[2].pcm.front(), 500);
}

TEST(Backoff, GrowsExponentiallyAndCaps) {
    BackoffConfig cfg;
    cfg.initial = 100ms;
    cfg.max = 1000ms;
    cfg.multiplier = 2.0;
    cfg.jitter = 0.0; // deterministic
    ExponentialBackoff b{cfg, 42};
    EXPECT_EQ(b.next(), 100ms);
    EXPECT_EQ(b.next(), 200ms);
    EXPECT_EQ(b.next(), 400ms);
    EXPECT_EQ(b.next(), 800ms);
    EXPECT_EQ(b.next(), 1000ms);
    EXPECT_EQ(b.next(), 1000ms);
    b.reset();
    EXPECT_EQ(b.next(), 100ms);
}

TEST(Backoff, JitterStaysWithinBounds) {
    BackoffConfig cfg;
    cfg.initial = 1000ms;
    cfg.max = 1000ms;
    cfg.jitter = 0.5;
    ExponentialBackoff b{cfg, 7};
    for (int i = 0; i < 200; ++i) {
        const auto d = b.next();
        EXPECT_GE(d, 500ms);
        EXPECT_LE(d, 1000ms);
    }
}
