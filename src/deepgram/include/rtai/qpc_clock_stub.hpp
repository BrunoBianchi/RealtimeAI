// A QueryPerformanceCounter-backed IClock, shared by the Deepgram transport's
// consumers and its integration test. Kept in the deepgram adapter's public
// include so tests can use a real high-resolution clock without pulling in the
// app target.
#pragma once

#include <windows.h>

#include "rtai/latency.hpp"

namespace rtai {

class QpcClockStub : public IClock {
public:
    QpcClockStub() {
        LARGE_INTEGER f;
        QueryPerformanceFrequency(&f);
        freq_ = static_cast<std::uint64_t>(f.QuadPart);
    }
    std::uint64_t ticks() const noexcept override {
        LARGE_INTEGER c;
        QueryPerformanceCounter(&c);
        return static_cast<std::uint64_t>(c.QuadPart);
    }
    std::uint64_t ticks_per_second() const noexcept override { return freq_; }

private:
    std::uint64_t freq_{1};
};

} // namespace rtai
