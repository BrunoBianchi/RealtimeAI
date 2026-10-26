// Pure core: streaming LLM client abstraction. The copilot engine depends on
// this; Windows provides WinHttpLlmClient (OpenRouter), tests/demo use
// ScriptedLlmClient.
#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace rtai {

struct ChatMessage {
    std::string role; // "system" | "user" | "assistant"
    std::string content;
    // Image URLs sent with the message (vision models); usually
    // "data:image/jpeg;base64,...". Empty for text-only messages.
    std::vector<std::string> images{};
};

struct LlmRequest {
    std::string model;
    std::vector<ChatMessage> messages;
    int max_tokens{450};
    double temperature{0.3};
    std::string reasoning_effort; // e.g. "minimal"; empty = don't send
};

enum class LlmStatus : std::uint8_t { Completed, Cancelled, Failed };

constexpr const char* to_string(LlmStatus s) noexcept {
    switch (s) {
        case LlmStatus::Completed: return "completed";
        case LlmStatus::Cancelled: return "cancelled";
        case LlmStatus::Failed:    return "failed";
    }
    return "?";
}

struct LlmResult {
    LlmStatus status{LlmStatus::Completed};
    std::string finish_reason;
    std::string error;
    int http_status{0};
    std::int64_t ttft_ms{-1};  // time to first token
    std::int64_t total_ms{0};
};

// Contract for implementations:
//   * callbacks run on a client-owned thread (exception: a client that is
//     already shutting down may call on_done(Cancelled) from start() itself);
//   * on_delta is not called after cancel() returns (checked before each call);
//   * on_done is called exactly once per call, also when cancelled or failed.
struct LlmCallbacks {
    std::function<void(std::string_view delta)> on_delta;
    std::function<void(const LlmResult&)> on_done;
};

class ILlmCall {
public:
    virtual ~ILlmCall() = default;
    virtual void cancel() = 0;
    [[nodiscard]] virtual bool finished() const = 0;
};

class ILlmClient {
public:
    virtual ~ILlmClient() = default;

    // Starts a streaming completion without blocking.
    virtual std::shared_ptr<ILlmCall> start(LlmRequest request, LlmCallbacks callbacks) = 0;

    // Cancels everything in flight and waits up to `wait` for the threads.
    virtual void shutdown(std::chrono::milliseconds wait) = 0;

    [[nodiscard]] virtual std::string name() const = 0;
};

} // namespace rtai
