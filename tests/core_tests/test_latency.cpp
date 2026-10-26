#include <gtest/gtest.h>

#include "rtai/latency.hpp"
#include "test_clock.hpp"

using namespace rtai;

TEST(Latency, RecordsMinMaxAvg) {
    MetricsRegistry reg{1'000'000}; // 1 tick = 1 microsecond
    reg.record(Stage::CaptureToVad, 1000); // 1 ms
    reg.record(Stage::CaptureToVad, 3000); // 3 ms
    const auto& st = reg.stats(Stage::CaptureToVad);
    EXPECT_EQ(st.count, 2u);
    EXPECT_EQ(st.min_ticks, 1000u);
    EXPECT_EQ(st.max_ticks, 3000u);
    EXPECT_NEAR(reg.avg_ms(Stage::CaptureToVad), 2.0, 1e-6);
    EXPECT_NEAR(reg.to_ms(1000), 1.0, 1e-6);
}

TEST(Latency, ScopedTimerRecordsElapsed) {
    FakeClock clock{1'000'000};
    MetricsRegistry reg{clock.ticks_per_second()};
    {
        ScopedLatency s{clock, reg, Stage::VadToSend};
        clock.advance(2500); // 2.5 ms
    }
    EXPECT_EQ(reg.stats(Stage::VadToSend).count, 1u);
    EXPECT_NEAR(reg.avg_ms(Stage::VadToSend), 2.5, 1e-6);
}

TEST(Latency, StageNames) {
    EXPECT_EQ(stage_name(Stage::CaptureToVad), "capture->vad");
    EXPECT_EQ(stage_name(Stage::VadToSend), "vad->send");
    EXPECT_EQ(stage_name(Stage::TurnCloseToFinal), "turnclose->final");
}
