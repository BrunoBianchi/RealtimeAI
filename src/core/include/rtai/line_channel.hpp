// Pure core: ordered, non-blocking line output for the --server protocol.
// Engine sinks run on the orchestrator and LLM threads; they only enqueue.
// One writer thread pushes lines to the pipe (stdout). If the UI stops
// reading, the pipe fills and only the writer thread blocks; the queue is
// bounded by dropping "droppable" lines (audio levels) first and, as a last
// resort, the oldest lines.
#pragma once

#include <condition_variable>
#include <cstddef>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>

namespace rtai {

class LineChannel {
public:
    // `write` gets one complete line INCLUDING its trailing '\n' (one buffer,
    // one write call) and returns false when the pipe is broken.
    using WriteFn = std::function<bool(std::string_view)>;

    explicit LineChannel(WriteFn write, std::size_t max_pending = 20000)
        : write_(std::move(write)), max_pending_(max_pending), thread_([this] { run(); }) {}

    ~LineChannel() { stop(); }

    LineChannel(const LineChannel&) = delete;
    LineChannel& operator=(const LineChannel&) = delete;

    void send(std::string line, bool droppable = false) {
        if (line.empty()) return;
        {
            std::lock_guard<std::mutex> lk(mu_);
            if (stopped_ || broken_) return;
            if (pending_.size() >= max_pending_) {
                if (droppable) {
                    ++dropped_;
                    return;
                }
                drop_one_locked();
            }
            pending_.push_back(Item{std::move(line), droppable});
        }
        cv_.notify_one();
    }

    // Writes what is queued, then joins. Idempotent.
    void stop() {
        {
            std::lock_guard<std::mutex> lk(mu_);
            if (stopped_) return;
            stopped_ = true;
        }
        cv_.notify_all();
        if (thread_.joinable()) thread_.join();
    }

    [[nodiscard]] bool broken() const {
        std::lock_guard<std::mutex> lk(mu_);
        return broken_;
    }

    [[nodiscard]] std::size_t dropped() const {
        std::lock_guard<std::mutex> lk(mu_);
        return dropped_;
    }

private:
    struct Item {
        std::string line;
        bool droppable{false};
    };

    void drop_one_locked() {
        for (auto it = pending_.begin(); it != pending_.end(); ++it) {
            if (it->droppable) {
                pending_.erase(it);
                ++dropped_;
                return;
            }
        }
        pending_.pop_front();
        ++dropped_;
    }

    void run() {
        std::string buf;
        for (;;) {
            std::deque<Item> batch;
            bool stopping = false;
            {
                std::unique_lock<std::mutex> lk(mu_);
                cv_.wait(lk, [&] { return stopped_ || !pending_.empty(); });
                batch.swap(pending_);
                stopping = stopped_;
            }
            for (auto& item : batch) {
                buf.assign(item.line);
                buf.push_back('\n');
                if (!write_(std::string_view(buf))) {
                    std::lock_guard<std::mutex> lk(mu_);
                    broken_ = true;
                    pending_.clear();
                    return;
                }
            }
            if (stopping) {
                std::lock_guard<std::mutex> lk(mu_);
                if (pending_.empty()) return;
            }
        }
    }

    WriteFn write_;
    std::size_t max_pending_;
    mutable std::mutex mu_;
    std::condition_variable cv_;
    std::deque<Item> pending_;
    std::size_t dropped_{0};
    bool stopped_{false};
    bool broken_{false};
    std::thread thread_; // last
};

} // namespace rtai
