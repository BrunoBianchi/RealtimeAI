// Pure core: ILlmClient decorator that holds every request for a fixed delay
// before handing it to the wrapped client. Used by local mode (no plan,
// cloud::kLocalAnswerDelayMs); PRO and Free sessions never go through it.
//
// One timer thread for all calls. A call cancelled while it waits never
// reaches the wrapped client and gets on_done(Cancelled) from the timer
// thread. The reported ttft/total include the wait, so latency numbers stay
// honest.
#pragma once

#include <chrono>
#include <condition_variable>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>

#include "rtai/llm.hpp"

namespace rtai {

class DelayedLlmClient final : public ILlmClient {
public:
    DelayedLlmClient(std::shared_ptr<ILlmClient> inner, std::chrono::milliseconds delay)
        : inner_(std::move(inner)), delay_(delay), shared_(std::make_shared<Shared>()) {
        timer_ = std::thread([s = shared_, inner = inner_] { run(*s, inner); });
    }
    ~DelayedLlmClient() override { shutdown(std::chrono::milliseconds(2000)); }

    DelayedLlmClient(const DelayedLlmClient&) = delete;
    DelayedLlmClient& operator=(const DelayedLlmClient&) = delete;

    std::shared_ptr<ILlmCall> start(LlmRequest request, LlmCallbacks callbacks) override {
        auto call = std::make_shared<Call>(shared_);
        call->request = std::move(request);
        call->delay = delay_;
        call->queued_at = std::chrono::steady_clock::now();
        auto on_done = std::move(callbacks.on_done);
        callbacks.on_done = [call, on_done = std::move(on_done)](const LlmResult& r) {
            LlmResult out = r;
            const auto wait = std::chrono::duration_cast<std::chrono::milliseconds>(call->delay).count();
            if (out.ttft_ms >= 0) out.ttft_ms += wait;
            out.total_ms += wait;
            {
                std::lock_guard<std::mutex> lk(call->shared->mu);
                call->done = true;
            }
            if (on_done) on_done(out);
        };
        call->callbacks = std::move(callbacks);
        {
            std::lock_guard<std::mutex> lk(shared_->mu);
            if (!shared_->stopping) {
                shared_->pending.push_back(call);
                shared_->cv.notify_all();
                return call;
            }
        }
        LlmResult r;
        r.status = LlmStatus::Cancelled;
        call->callbacks.on_done(r);
        return call;
    }

    void shutdown(std::chrono::milliseconds wait) override {
        {
            std::lock_guard<std::mutex> lk(shared_->mu);
            if (shared_->stopping && !timer_.joinable()) return;
            shared_->stopping = true;
            shared_->cv.notify_all();
        }
        if (timer_.joinable()) timer_.join();
        if (inner_) inner_->shutdown(wait);
    }

    [[nodiscard]] std::string name() const override {
        return (inner_ ? inner_->name() : std::string("llm")) + " (local mode)";
    }

private:
    struct Shared;

    struct Call final : ILlmCall {
        explicit Call(std::shared_ptr<Shared> s) : shared(std::move(s)) {}
        void cancel() override {
            std::shared_ptr<ILlmCall> started;
            {
                std::lock_guard<std::mutex> lk(shared->mu);
                cancelled = true;
                started = inner;
                shared->cv.notify_all();
            }
            if (started) started->cancel();
        }
        [[nodiscard]] bool finished() const override {
            std::lock_guard<std::mutex> lk(shared->mu);
            return done;
        }

        std::shared_ptr<Shared> shared;
        LlmRequest request;
        LlmCallbacks callbacks;
        std::chrono::milliseconds delay{0};
        std::chrono::steady_clock::time_point queued_at;
        std::shared_ptr<ILlmCall> inner; // set once handed to the wrapped client
        bool cancelled{false};
        bool done{false};
    };

    struct Shared {
        std::mutex mu;
        std::condition_variable cv;
        std::deque<std::shared_ptr<Call>> pending; // FIFO: same delay for all
        bool stopping{false};
    };

    static void cancelled_now(const std::shared_ptr<Call>& c) {
        LlmResult r;
        r.status = LlmStatus::Cancelled;
        c->callbacks.on_done(r);
    }

    static void run(Shared& s, const std::shared_ptr<ILlmClient>& inner) {
        std::unique_lock<std::mutex> lk(s.mu);
        for (;;) {
            if (s.stopping) {
                auto left = std::move(s.pending);
                s.pending.clear();
                lk.unlock();
                for (auto& c : left) cancelled_now(c);
                return;
            }
            if (s.pending.empty()) {
                s.cv.wait(lk);
                continue;
            }
            auto c = s.pending.front();
            if (c->cancelled) {
                s.pending.pop_front();
                lk.unlock();
                cancelled_now(c);
                lk.lock();
                continue;
            }
            const auto due = c->queued_at + c->delay;
            if (std::chrono::steady_clock::now() < due) {
                s.cv.wait_until(lk, due);
                continue;
            }
            s.pending.pop_front();
            lk.unlock();
            auto started = inner ? inner->start(std::move(c->request), c->callbacks) : nullptr;
            lk.lock();
            c->inner = started;
            const bool cancel_now = c->cancelled && started;
            if (!started && !c->done) {
                lk.unlock();
                LlmResult r;
                r.status = LlmStatus::Failed;
                r.error = "no LLM client";
                c->callbacks.on_done(r);
                lk.lock();
            } else if (cancel_now) {
                lk.unlock();
                started->cancel();
                lk.lock();
            }
        }
    }

    std::shared_ptr<ILlmClient> inner_;
    std::chrono::milliseconds delay_;
    std::shared_ptr<Shared> shared_;
    std::thread timer_;
};

} // namespace rtai
