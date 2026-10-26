// Pure core: exponential backoff with jitter for reconnect loops.
#pragma once

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <random>

namespace rtai {

struct BackoffConfig {
    std::chrono::milliseconds initial{250};
    std::chrono::milliseconds max{10000};
    double multiplier{2.0};
    // Fraction of each delay that is randomized downwards: the delay is drawn
    // from [base * (1 - jitter), base]. Spreads reconnects of the two lanes
    // (and of many clients) so they don't hammer the server in lockstep.
    double jitter{0.5};
};

class ExponentialBackoff {
public:
    explicit ExponentialBackoff(BackoffConfig cfg = {},
                                std::uint64_t seed = std::random_device{}())
        : cfg_(cfg), rng_(seed) {}

    // Delay before the next attempt; advances the attempt counter.
    std::chrono::milliseconds next() {
        double base = static_cast<double>(cfg_.initial.count());
        for (std::uint32_t i = 0; i < attempts_ && base < static_cast<double>(cfg_.max.count()); ++i) {
            base *= cfg_.multiplier;
        }
        base = std::min(base, static_cast<double>(cfg_.max.count()));
        const double j = std::clamp(cfg_.jitter, 0.0, 1.0);
        std::uniform_real_distribution<double> dist(1.0 - j, 1.0);
        ++attempts_;
        return std::chrono::milliseconds(static_cast<std::int64_t>(base * dist(rng_)));
    }

    void reset() noexcept { attempts_ = 0; }
    [[nodiscard]] std::uint32_t attempts() const noexcept { return attempts_; }

private:
    BackoffConfig cfg_;
    std::mt19937_64 rng_;
    std::uint32_t attempts_{0};
};

} // namespace rtai
