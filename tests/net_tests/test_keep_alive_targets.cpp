// Which hosts the keep-alive worker pings. In cloud mode the relay is the live
// host, so it must stay warm between questions; other single-host endpoints
// (a local Ollama...) must not get pings they never asked for.

#include <gtest/gtest.h>

#include "rtai/winhttp_llm_client.hpp"

namespace {

using rtai::keep_alive_targets;
using rtai::LlmEndpoint;
using rtai::WinHttpLlmOptions;

WinHttpLlmOptions relay_options() {
    WinHttpLlmOptions o;
    o.api_key = "llm_token";
    o.host = "relay.example.com";
    o.port = 80;
    o.secure = false;
    o.path = "/v1/llm/chat/completions";
    o.primary = LlmEndpoint{};
    o.fallback = LlmEndpoint{};
    return o;
}

TEST(KeepAliveTargets, RelayIsPingedWithHeadOnModelsRightAway) {
    WinHttpLlmOptions o = relay_options();
    o.keep_alive_relay = true;
    const auto targets = keep_alive_targets(o);
    ASSERT_EQ(targets.size(), 1u);
    EXPECT_EQ(targets[0].host, "relay.example.com");
    EXPECT_EQ(targets[0].method, L"HEAD");
    EXPECT_EQ(targets[0].path, "/v1/llm/models");
    EXPECT_TRUE(targets[0].immediately);
    EXPECT_FALSE(targets[0].drain);
}

TEST(KeepAliveTargets, AnyOtherSingleHostIsLeftAlone) {
    EXPECT_TRUE(keep_alive_targets(relay_options()).empty());
}

TEST(KeepAliveTargets, RelayFallbackOnTheSameHostIsNotPingedTwice) {
    WinHttpLlmOptions o = relay_options();
    o.keep_alive_relay = true;
    o.fallback = LlmEndpoint{"relay.example.com", "/v1/llm/chat/completions", "alt", "llm_token"};
    EXPECT_EQ(keep_alive_targets(o).size(), 1u);
}

TEST(KeepAliveTargets, DirectPrimaryStaysFirst) {
    WinHttpLlmOptions o = relay_options();
    o.primary = LlmEndpoint{"api.cerebras.ai", "/v1/chat/completions", "m", "k"};
    const auto targets = keep_alive_targets(o);
    ASSERT_EQ(targets.size(), 1u);
    EXPECT_EQ(targets[0].host, "api.cerebras.ai");
    EXPECT_EQ(targets[0].method, L"HEAD");
    EXPECT_EQ(targets[0].path, "/v1/models");
    EXPECT_TRUE(targets[0].immediately);
}

TEST(KeepAliveTargets, OpenRouterSingleHostKeepsItsDrainedGet) {
    WinHttpLlmOptions o = relay_options();
    o.host = "openrouter.ai";
    o.path = "/api/v1/chat/completions";
    const auto targets = keep_alive_targets(o);
    ASSERT_EQ(targets.size(), 1u);
    EXPECT_EQ(targets[0].method, L"GET");
    EXPECT_EQ(targets[0].path, "/api/v1/key");
    EXPECT_TRUE(targets[0].drain);
    EXPECT_FALSE(targets[0].immediately);
}

TEST(KeepAliveTargets, FallbackProviderIsKeptWarmToo) {
    WinHttpLlmOptions o = relay_options();
    o.host = "openrouter.ai";
    o.fallback = LlmEndpoint{"api.cerebras.ai", "/v1/chat/completions", "m", "k"};
    const auto targets = keep_alive_targets(o);
    ASSERT_EQ(targets.size(), 2u);
    EXPECT_EQ(targets[1].host, "api.cerebras.ai");
    EXPECT_EQ(targets[1].path, "/v1/models");

    // Only a fallback: still warmed, even on a host the worker would skip.
    o.host = "localhost";
    const auto only = keep_alive_targets(o);
    ASSERT_EQ(only.size(), 1u);
    EXPECT_EQ(only[0].host, "api.cerebras.ai");
}

} // namespace
