#pragma once
#include "rtai/latency.hpp"

// Deterministic clock for tests: ticks advance only when advance() is called.
class FakeClock : public rtai::IClock {
public:
    explicit FakeClock(std::uint64_t tps = 1'000'000) : tps_(tps) {}
    std::uint64_t ticks() const noexcept override { return now_; }
    std::uint64_t ticks_per_second() const noexcept override { return tps_; }
    void advance(std::uint64_t d) noexcept { now_ += d; }
    void set(std::uint64_t v) noexcept { now_ = v; }
private:
    std::uint64_t tps_;
    mutable std::uint64_t now_{0};
};
