// Local mode's answer delay (rtai/delayed_llm.hpp): requests wait, cancels
// during the wait never reach the provider, and the reported latency includes
// the wait.
#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <future>
#include <memory>
#include <string>

#include "rtai/delayed_llm.hpp"
#include "rtai/scripted_llm.hpp"

using namespace rtai;
using namespace std::chrono_literals;

namespace {

std::shared_ptr<ScriptedLlmClient> scripted() {
    ScriptedLlmClient::Options o;
    o.reply = "ok";
    o.first_token_delay = 1ms;
    o.token_delay = 0ms;
    return std::make_shared<ScriptedLlmClient>(o);
}

} // namespace

TEST(DelayedLlm, HoldsTheRequestThenStreamsTheAnswer) {
    auto inner = scripted();
    DelayedLlmClient llm{inner, 120ms};
    std::promise<LlmResult> done;
    std::string text;
    const auto t0 = std::chrono::steady_clock::now();
    std::atomic<long long> first_ms{-1};
    llm.start(LlmRequest{.model = "m"},
              {.on_delta = [&](std::string_view d) {
                   long long expected = -1;
                   first_ms.compare_exchange_strong(expected, std::chrono::duration_cast<std::chrono::milliseconds>(
                                                                  std::chrono::steady_clock::now() - t0).count());
                   text += d;
               },
               .on_done = [&](const LlmResult& r) { done.set_value(r); }});
    auto fut = done.get_future();
    ASSERT_EQ(fut.wait_for(3s), std::future_status::ready);
    const LlmResult r = fut.get();
    EXPECT_EQ(r.status, LlmStatus::Completed);
    EXPECT_FALSE(text.empty());
    EXPECT_GE(first_ms.load(), 110);
    EXPECT_GE(r.total_ms, 120); // the wait is part of the reported latency
    if (r.ttft_ms >= 0) EXPECT_GE(r.ttft_ms, 120);
}

TEST(DelayedLlm, CancelDuringTheWaitNeverReachesTheProvider) {
    auto inner = scripted();
    DelayedLlmClient llm{inner, 300ms};
    std::promise<LlmResult> done;
    std::atomic<int> deltas{0};
    auto call = llm.start(LlmRequest{}, {.on_delta = [&](std::string_view) { ++deltas; },
                                         .on_done = [&](const LlmResult& r) { done.set_value(r); }});
    call->cancel();
    auto fut = done.get_future();
    ASSERT_EQ(fut.wait_for(2s), std::future_status::ready);
    EXPECT_EQ(fut.get().status, LlmStatus::Cancelled);
    EXPECT_TRUE(call->finished());
    std::this_thread::sleep_for(350ms);
    EXPECT_EQ(deltas.load(), 0);
}

TEST(DelayedLlm, ShutdownCancelsWaitingCallsExactlyOnce) {
    auto inner = scripted();
    auto llm = std::make_unique<DelayedLlmClient>(inner, 5s);
    std::atomic<int> dones{0};
    std::atomic<int> cancelled{0};
    for (int i = 0; i < 3; ++i) {
        llm->start(LlmRequest{}, {.on_delta = nullptr, .on_done = [&](const LlmResult& r) {
                                      ++dones;
                                      if (r.status == LlmStatus::Cancelled) ++cancelled;
                                  }});
    }
    const auto t0 = std::chrono::steady_clock::now();
    llm->shutdown(500ms);
    EXPECT_LT(std::chrono::steady_clock::now() - t0, 2s);
    EXPECT_EQ(dones.load(), 3);
    EXPECT_EQ(cancelled.load(), 3);
    // After shutdown a new call is refused right away.
    std::atomic<bool> refused{false};
    llm->start(LlmRequest{}, {.on_delta = nullptr, .on_done = [&](const LlmResult& r) {
                                  refused = r.status == LlmStatus::Cancelled;
                              }});
    EXPECT_TRUE(refused.load());
    llm.reset();
}
