// Windows process tuning for a real-time assistant. App layer only.
//
// Two Windows defaults add latency to every wait in the pipeline (engine
// ticks, turn/commit deadlines, the 12 ms embedding budget, WinHTTP timers,
// the overlay's 16 ms frame timer):
//
//   * the system timer ticks every 15.6 ms, so a 20 ms wait really lasts
//     ~31 ms and a 12 ms one ~16 ms. timeBeginPeriod(1) asks for 1 ms ticks
//     for as long as this process runs (per-process since Windows 10 2004);
//   * Windows 11 puts a process whose windows are not in the foreground into
//     EcoQoS (efficiency cores, lower clocks) and may ignore its timer
//     request. The copilot is exactly that process: the user is looking at
//     the meeting app while the overlay works. Opting out keeps it on full
//     speed. Both calls are best effort: older builds simply ignore them.
#pragma once

#include <windows.h>
#include <timeapi.h>

namespace rtai::win {

// RAII: 1 ms system timer resolution while alive.
class TimerResolution {
public:
    explicit TimerResolution(UINT period_ms = 1) noexcept {
        if (timeBeginPeriod(period_ms) == TIMERR_NOERROR) period_ms_ = period_ms;
    }
    ~TimerResolution() {
        if (period_ms_ != 0) timeEndPeriod(period_ms_);
    }
    TimerResolution(const TimerResolution&) = delete;
    TimerResolution& operator=(const TimerResolution&) = delete;

    [[nodiscard]] bool active() const noexcept { return period_ms_ != 0; }

private:
    UINT period_ms_{0};
};

// Opts the process out of EcoQoS / execution-speed throttling and (Windows 11)
// of "ignore timer resolution while occluded". Returns true when applied.
inline bool disable_power_throttling() noexcept {
#ifdef PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION
    constexpr ULONG kIgnoreTimerResolution = PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION;
#else
    constexpr ULONG kIgnoreTimerResolution = 0x4;
#endif
    PROCESS_POWER_THROTTLING_STATE state{};
    state.Version = PROCESS_POWER_THROTTLING_CURRENT_VERSION;
    state.StateMask = 0; // 0 = throttling OFF for every bit in ControlMask
    state.ControlMask = PROCESS_POWER_THROTTLING_EXECUTION_SPEED | kIgnoreTimerResolution;
    if (SetProcessInformation(GetCurrentProcess(), ProcessPowerThrottling, &state, sizeof(state))) return true;
    // Windows 10 does not know the timer bit and rejects the whole mask.
    state.ControlMask = PROCESS_POWER_THROTTLING_EXECUTION_SPEED;
    return SetProcessInformation(GetCurrentProcess(), ProcessPowerThrottling, &state, sizeof(state)) != FALSE;
}

} // namespace rtai::win
