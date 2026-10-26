// Pure core: multi-producer queue drained by one consumer (the UI thread),
// with wake-up coalescing. Producers never block on the consumer: push() takes
// a short lock and calls `wake` only when no wake is already pending, so a
// burst of 200 token deltas costs one PostMessage, not 200, and the UI thread
// drains everything in one go.
#pragma once

#include <functional>
#include <mutex>
#include <utility>
#include <vector>

namespace rtai {

template <class T>
class WakeQueue {
public:
    using WakeFn = std::function<void()>;

    WakeQueue() = default;
    explicit WakeQueue(WakeFn wake) : wake_(std::move(wake)) {}

    // Replace (or clear with nullptr) the wake function. After this returns,
    // the old function is never called again.
    void set_wake(WakeFn wake) {
        std::lock_guard<std::mutex> lk(mu_);
        wake_ = std::move(wake);
    }

    void push(T item) {
        std::lock_guard<std::mutex> lk(mu_);
        items_.push_back(std::move(item));
        if (!wake_pending_ && wake_) {
            wake_pending_ = true;
            // Called under the lock so set_wake(nullptr) is a hard barrier.
            // Must be non-blocking (PostMessage is).
            wake_();
        }
    }

    // Consumer: takes everything queued so far and re-arms the wake.
    std::vector<T> drain() {
        std::vector<T> out;
        std::lock_guard<std::mutex> lk(mu_);
        out.swap(items_);
        wake_pending_ = false;
        return out;
    }

    [[nodiscard]] std::size_t size() const {
        std::lock_guard<std::mutex> lk(mu_);
        return items_.size();
    }

private:
    mutable std::mutex mu_;
    std::vector<T> items_;
    WakeFn wake_;
    bool wake_pending_{false};
};

} // namespace rtai
