// Pure core latency instrumentation — no <windows.h>.
//
// The actual high-resolution clock source is injected so that `core` stays
// platform-free and testable. On Windows the app wires QueryPerformanceCounter;
// tests wire a deterministic fake clock.
#pragma once

#include <array>
#include <cstdint>
#include <string_view>

namespace rtai {

// Named stages we measure along the hot path. Kept small and fixed so the
// metrics store is a plain array (no map, no allocation).
enum class Stage : std::uint8_t {
    CaptureToVad = 0,   // device read tick -> VAD decision
    VadToSend = 1,      // VAD passed -> bytes handed to transport
    TurnCloseToFinal = 2, // transport turn close -> first final transcript
    Count = 3,
};

constexpr std::string_view stage_name(Stage s) noexcept {
    switch (s) {
        case Stage::CaptureToVad:     return "capture->vad";
        case Stage::VadToSend:        return "vad->send";
        case Stage::TurnCloseToFinal: return "turnclose->final";
        case Stage::Count:            return "count";
    }
    return "?";
}

// Abstract monotonic tick source. ticks() must be monotonic and high-res.
// ticks_per_second() converts ticks to real time.
class IClock {
public:
    virtual ~IClock() = default;
    [[nodiscard]] virtual std::uint64_t ticks() const noexcept = 0;
    [[nodiscard]] virtual std::uint64_t ticks_per_second() const noexcept = 0;
};

// Rolling min/max/last/count/sum aggregator for one stage. No allocation,
// no locking (one writer per source lane). Values stored in ticks; convert
// to ms via the owning MetricsRegistry which holds the clock frequency.
struct StageStats {
    std::uint64_t count{0};
    std::uint64_t sum_ticks{0};
    std::uint64_t min_ticks{UINT64_MAX};
    std::uint64_t max_ticks{0};
    std::uint64_t last_ticks{0};

    void record(std::uint64_t delta_ticks) noexcept {
        ++count;
        sum_ticks += delta_ticks;
        last_ticks = delta_ticks;
        if (delta_ticks < min_ticks) min_ticks = delta_ticks;
        if (delta_ticks > max_ticks) max_ticks = delta_ticks;
    }
};

// Fixed-size registry: one StageStats per Stage. Thread-affinity is the
// caller's responsibility (one lane writes its own stages).
class MetricsRegistry {
public:
    explicit MetricsRegistry(std::uint64_t ticks_per_second) noexcept
        : ticks_per_second_(ticks_per_second ? ticks_per_second : 1) {}

    void record(Stage s, std::uint64_t delta_ticks) noexcept {
        stats_[static_cast<std::size_t>(s)].record(delta_ticks);
    }

    [[nodiscard]] const StageStats& stats(Stage s) const noexcept {
        return stats_[static_cast<std::size_t>(s)];
    }

    [[nodiscard]] std::uint64_t ticks_per_second() const noexcept { return ticks_per_second_; }

    [[nodiscard]] double to_ms(std::uint64_t ticks) const noexcept {
        return (static_cast<double>(ticks) * 1000.0) / static_cast<double>(ticks_per_second_);
    }

    [[nodiscard]] double avg_ms(Stage s) const noexcept {
        const auto& st = stats(s);
        if (st.count == 0) return 0.0;
        return to_ms(st.sum_ticks / st.count);
    }

private:
    std::uint64_t ticks_per_second_;
    std::array<StageStats, static_cast<std::size_t>(Stage::Count)> stats_{};
};

// RAII span timer: records the elapsed ticks into a registry stage on scope
// exit. Cheap; no heap use. Intended for setup paths and per-frame use where
// the two timestamps are naturally available.
class ScopedLatency {
public:
    ScopedLatency(const IClock& clock, MetricsRegistry& reg, Stage stage) noexcept
        : clock_(clock), reg_(reg), stage_(stage), start_(clock.ticks()) {}

    ~ScopedLatency() { reg_.record(stage_, clock_.ticks() - start_); }

    ScopedLatency(const ScopedLatency&) = delete;
    ScopedLatency& operator=(const ScopedLatency&) = delete;

private:
    const IClock& clock_;
    MetricsRegistry& reg_;
    Stage stage_;
    std::uint64_t start_;
};

} // namespace rtai
