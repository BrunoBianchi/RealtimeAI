// Pure core: asynchronous line logger. Engine/network threads must never block
// on stdout: on Windows a console in "selection" mode (QuickEdit click) stops
// writes until the user presses a key, which used to freeze the thread that
// printed. Here producers only enqueue; one logger thread writes.
#pragma once

#include <condition_variable>
#include <cstdio>
#include <deque>
#include <mutex>
#include <string>
#include <thread>

namespace rtai {

class AsyncLog {
public:
    explicit AsyncLog(std::FILE* out = stdout, std::size_t max_pending = 2000)
        : out_(out), max_pending_(max_pending), thread_([this] { run(); }) {}

    ~AsyncLog() { stop(); }

    // Also append every line to `f` (log file). Call before logging starts.
    void set_tee(std::FILE* f) {
        std::lock_guard<std::mutex> lk(mu_);
        tee_ = f;
    }

    AsyncLog(const AsyncLog&) = delete;
    AsyncLog& operator=(const AsyncLog&) = delete;

    // Thread-safe, non-blocking. Drops the oldest lines if the console is
    // stuck for long (bounded memory).
    void line(std::string s) {
        {
            std::lock_guard<std::mutex> lk(mu_);
            if (stopped_) return;
            if (pending_.size() >= max_pending_) {
                pending_.pop_front();
                ++dropped_;
            }
            pending_.push_back(std::move(s));
        }
        cv_.notify_one();
    }

    // Flushes what is queued and joins the thread. Idempotent.
    void stop() {
        {
            std::lock_guard<std::mutex> lk(mu_);
            if (stopped_) return;
            stopped_ = true;
        }
        cv_.notify_all();
        if (thread_.joinable()) thread_.join();
    }

private:
    void run() {
        for (;;) {
            std::deque<std::string> batch;
            std::size_t dropped = 0;
            bool stopping = false;
            {
                std::unique_lock<std::mutex> lk(mu_);
                cv_.wait(lk, [&] { return stopped_ || !pending_.empty(); });
                batch.swap(pending_);
                dropped = dropped_;
                dropped_ = 0;
                stopping = stopped_;
            }
            std::FILE* tee = nullptr;
            {
                std::lock_guard<std::mutex> lk(mu_);
                tee = tee_;
            }
            if (dropped) std::fprintf(out_, "[log] %zu linhas descartadas (console travado)\n", dropped);
            for (const auto& s : batch) {
                std::fputs(s.c_str(), out_);
                std::fputc('\n', out_);
                if (tee) {
                    std::fputs(s.c_str(), tee);
                    std::fputc('\n', tee);
                }
            }
            std::fflush(out_);
            if (tee) std::fflush(tee);
            if (stopping) break;
        }
    }

    std::FILE* out_;
    std::size_t max_pending_;
    std::mutex mu_;
    std::condition_variable cv_;
    std::deque<std::string> pending_;
    std::size_t dropped_{0};
    std::FILE* tee_{nullptr};
    bool stopped_{false};
    std::thread thread_; // last: starts after the other members exist
};

} // namespace rtai
