// Pure core — maps a device's reported PCM parameters to the resampler
// configuration. Kept here (not in the WASAPI adapter) so it's unit-testable
// without <windows.h>.
#pragma once

#include <cstdint>

#include "rtai/resampler.hpp"

namespace rtai {

struct DeviceFormatInfo {
    std::uint32_t sample_rate{48000};
    std::uint16_t channels{2};
    bool is_float{true};
};

// Build a resampler that converts this device's stream to 16 kHz mono PCM16.
inline PcmResampler make_resampler_for(const DeviceFormatInfo& info) {
    return PcmResampler{info.sample_rate, info.channels};
}

// Whether the device needs resampling at all (rate differs from 16 kHz target
// or it isn't already mono). Downmix still needed if channels > 1.
inline bool needs_resampling(const DeviceFormatInfo& info) {
    return info.sample_rate != PcmResampler::kTargetRate || info.channels != 1;
}

} // namespace rtai
