// Windows side of the --server protocol: raw UTF-8 bytes over the stdio pipes
// the client process created (no CRT text-mode translation, no console code page).
#pragma once

#include <windows.h>

#include <atomic>
#include <functional>
#include <string>
#include <string_view>

#include "rtai/server_protocol.hpp"

namespace rtai::stdio {

// Blocking write of the whole buffer; false when the UI closed the pipe.
inline bool write_stdout(std::string_view bytes) {
    HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
    if (out == nullptr || out == INVALID_HANDLE_VALUE) return false;
    while (!bytes.empty()) {
        DWORD wrote = 0;
        const DWORD chunk = bytes.size() > (1u << 20) ? (1u << 20) : static_cast<DWORD>(bytes.size());
        if (!WriteFile(out, bytes.data(), chunk, &wrote, nullptr) || wrote == 0) return false;
        bytes.remove_prefix(wrote);
    }
    return true;
}

// Reads stdin on its own thread and calls on_line for each complete line.
// on_eof runs once when the pipe closes (UI gone) or breaks; it is NOT called
// after stop(). stop() interrupts a blocked ReadFile with CancelSynchronousIo.
class StdinReader {
public:
    using OnLine = std::function<void(std::string_view)>;
    using OnEof = std::function<void()>;

    StdinReader(OnLine on_line, OnEof on_eof) : on_line_(std::move(on_line)), on_eof_(std::move(on_eof)) {}
    ~StdinReader() { stop(); }

    StdinReader(const StdinReader&) = delete;
    StdinReader& operator=(const StdinReader&) = delete;

    bool start() {
        thread_ = CreateThread(nullptr, 0, &StdinReader::entry, this, 0, nullptr);
        return thread_ != nullptr;
    }

    void stop() {
        if (!thread_) return;
        stopping_.store(true);
        // A blocked synchronous ReadFile on a pipe is cancelled; retry a few
        // times in case the thread was between calls.
        for (int i = 0; i < 20; ++i) {
            CancelSynchronousIo(thread_);
            if (WaitForSingleObject(thread_, 50) == WAIT_OBJECT_0) break;
        }
        CloseHandle(thread_);
        thread_ = nullptr;
    }

private:
    static DWORD WINAPI entry(LPVOID self) {
        static_cast<StdinReader*>(self)->run();
        return 0;
    }

    void run() {
        HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
        std::string buf(64 * 1024, '\0');
        server::LineSplitter splitter;
        while (!stopping_.load()) {
            DWORD got = 0;
            if (!ReadFile(in, buf.data(), static_cast<DWORD>(buf.size()), &got, nullptr) || got == 0) break;
            splitter.feed(std::string_view(buf.data(), got), [&](std::string_view line) {
                if (!stopping_.load()) on_line_(line);
            });
        }
        if (!stopping_.load() && on_eof_) on_eof_();
    }

    OnLine on_line_;
    OnEof on_eof_;
    HANDLE thread_{nullptr};
    std::atomic<bool> stopping_{false};
};

} // namespace rtai::stdio
