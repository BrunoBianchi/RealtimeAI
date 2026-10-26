// Smoke test for the rtai_net test target. Keeps net_tests buildable and green
// until the Cold_Path property tests (tasks 8.4-8.7) replace/extend it. It also
// confirms the target links rtai_net by calling a pure, network-free piece of
// the Jev analytics client.

#include <gtest/gtest.h>

#include "rtai/jev_analytics_client.hpp"

namespace {

// Req 8.3/8.4: PostInterviewReport only when BOTH parallel calls succeed;
// any failure keeps the overlay in LiveCopilot. This is the all-or-nothing
// join, verified here as a link + sanity check (full property test: task 8.6).
TEST(NetSmoke, FinalModeIsPostReportOnlyWhenBothSucceed) {
    using rtai::JevAnalyticsClient;
    using rtai::OverlayMode;

    EXPECT_EQ(JevAnalyticsClient::final_mode(true, true),
              OverlayMode::PostInterviewReport);
    EXPECT_EQ(JevAnalyticsClient::final_mode(true, false),
              OverlayMode::LiveCopilot);
    EXPECT_EQ(JevAnalyticsClient::final_mode(false, true),
              OverlayMode::LiveCopilot);
    EXPECT_EQ(JevAnalyticsClient::final_mode(false, false),
              OverlayMode::LiveCopilot);
}

} // namespace
