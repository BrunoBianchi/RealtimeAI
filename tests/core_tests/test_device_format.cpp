#include <gtest/gtest.h>

#include "rtai/device_format.hpp"

using namespace rtai;

TEST(DeviceFormat, Maps48kStereoToResampler) {
    DeviceFormatInfo info{48000, 2, true};
    PcmResampler r = make_resampler_for(info);
    EXPECT_EQ(r.input_rate(), 48000u);
    EXPECT_EQ(r.input_channels(), 2);
    EXPECT_TRUE(needs_resampling(info));
}

TEST(DeviceFormat, Mono16kNeedsNoResampling) {
    DeviceFormatInfo info{16000, 1, false};
    EXPECT_FALSE(needs_resampling(info));
}

TEST(DeviceFormat, Mono48kStillNeedsResampling) {
    DeviceFormatInfo info{48000, 1, true};
    EXPECT_TRUE(needs_resampling(info)); // rate differs even though mono
}

TEST(DeviceFormat, Stereo16kNeedsDownmix) {
    DeviceFormatInfo info{16000, 2, true};
    EXPECT_TRUE(needs_resampling(info)); // channels > 1
}
