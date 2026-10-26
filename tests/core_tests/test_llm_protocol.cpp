#include <gtest/gtest.h>

#include <string>
#include <vector>

#include "rtai/json_min.hpp"
#include "rtai/openrouter_protocol.hpp"
#include "rtai/sse_parser.hpp"
#include "rtai/url.hpp"

using namespace rtai;

TEST(SseParser, ParsesEventsSplitAcrossArbitraryChunks) {
    const std::string stream =
        ": OPENROUTER PROCESSING\n\n"
        "data: {\"a\":1}\n\n"
        "data: {\"b\":2}\r\n\r\n"
        "event: custom\ndata: line1\ndata: line2\n\n"
        "data: [DONE]\n\n";
    // Feed one byte at a time: worst case for boundary handling.
    SseParser p;
    std::vector<SseParser::Event> events;
    std::vector<std::string> comments;
    for (char c : stream) {
        p.feed(std::string_view(&c, 1),
               [&](const SseParser::Event& e) { events.push_back(e); },
               [&](std::string_view cm) { comments.emplace_back(cm); });
    }
    ASSERT_EQ(events.size(), 4u);
    EXPECT_EQ(events[0].data, "{\"a\":1}");
    EXPECT_EQ(events[1].data, "{\"b\":2}");
    EXPECT_EQ(events[2].event, "custom");
    EXPECT_EQ(events[2].data, "line1\nline2");
    EXPECT_EQ(events[3].data, "[DONE]");
    ASSERT_EQ(comments.size(), 1u);
    EXPECT_EQ(comments[0], "OPENROUTER PROCESSING");
}

TEST(SseParser, HandlesCrLfSplitBetweenChunks) {
    SseParser p;
    std::vector<std::string> data;
    auto on = [&](const SseParser::Event& e) { data.push_back(e.data); };
    p.feed("data: x\r", on);
    p.feed("\n\r", on);
    p.feed("\n", on);
    ASSERT_EQ(data.size(), 1u);
    EXPECT_EQ(data[0], "x");
}

TEST(OpenRouter, BuildsStreamingRequestBody) {
    LlmRequest req;
    req.model = "google/gemini-3.1-flash-lite";
    req.messages = {{"system", "sys \"quoted\""}, {"user", "olá\nmundo"}};
    req.max_tokens = 300;
    req.temperature = 0.25;
    req.reasoning_effort = "minimal";
    const std::string body = openrouter::build_request_body(req);
    auto v = json::Parser::parse(body);
    ASSERT_TRUE(v.has_value()) << body;
    EXPECT_EQ((*v)["model"].as_string(), "google/gemini-3.1-flash-lite");
    EXPECT_TRUE((*v)["stream"].as_bool());
    EXPECT_EQ((*v)["max_tokens"].as_number(), 300);
    EXPECT_NEAR((*v)["temperature"].as_number(), 0.25, 1e-9);
    EXPECT_EQ((*v)["reasoning"]["effort"].as_string(), "minimal");
    EXPECT_EQ((*v)["messages"].size(), 2u);
    EXPECT_EQ((*v)["messages"].at(0)["content"].as_string(), "sys \"quoted\"");
    EXPECT_EQ((*v)["messages"].at(1)["content"].as_string(), "olá\nmundo");
}

TEST(OpenRouter, OmitsReasoningWhenEmptyAndSanitizesUtf8) {
    LlmRequest req;
    req.model = "m";
    req.messages = {{"user", std::string("bad \xC3 byte")}};
    const std::string body = openrouter::build_request_body(req);
    EXPECT_EQ(body.find("reasoning"), std::string::npos);
    EXPECT_NE(body.find("bad \xEF\xBF\xBD byte"), std::string::npos);
}

TEST(Cerebras, UsesTopLevelReasoningEffortAndDisablesDefaultThinking) {
    LlmRequest req;
    req.model = "qwen-3.8-27b";
    req.messages = {{"user", "responda somente: pronto"}};
    req.max_tokens = 450;
    const std::string body = openrouter::build_request_body(req, true);
    auto v = json::Parser::parse(body);
    ASSERT_TRUE(v.has_value()) << body;
    EXPECT_EQ((*v)["reasoning_effort"].as_string(), "none");
    EXPECT_FALSE((*v)["reasoning"].is_object());
}

TEST(Cerebras, NormalizesLegacyMinimalReasoningValue) {
    LlmRequest qwen;
    qwen.model = "qwen-3.8-27b";
    qwen.reasoning_effort = "minimal";
    auto qwen_json = json::Parser::parse(openrouter::build_request_body(qwen, true));
    ASSERT_TRUE(qwen_json.has_value());
    EXPECT_EQ((*qwen_json)["reasoning_effort"].as_string(), "none");

    LlmRequest gpt;
    gpt.model = "gpt-oss-120b";
    gpt.reasoning_effort = "minimal";
    auto gpt_json = json::Parser::parse(openrouter::build_request_body(gpt, true));
    ASSERT_TRUE(gpt_json.has_value());
    EXPECT_EQ((*gpt_json)["reasoning_effort"].as_string(), "low");
}

TEST(OpenRouter, ParsesDeltaDoneAndMidStreamError) {
    auto c = openrouter::parse_chunk(R"({"id":"x","choices":[{"delta":{"content":"Olá"},"finish_reason":null}]})");
    ASSERT_TRUE(c.valid);
    EXPECT_EQ(c.content, "Olá");
    EXPECT_TRUE(c.error.empty());

    auto done = openrouter::parse_chunk("[DONE]");
    EXPECT_TRUE(done.done);

    auto fin = openrouter::parse_chunk(R"({"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"total_tokens":10}})");
    EXPECT_EQ(fin.finish_reason, "stop");

    auto err = openrouter::parse_chunk(
        R"({"id":"x","object":"chat.completion.chunk","error":{"code":502,"message":"Provider disconnected"},"choices":[{"delta":{"content":""},"finish_reason":"error"}]})");
    EXPECT_EQ(err.error, "Provider disconnected (502)");
}

TEST(OpenRouter, ParsesErrorBodies) {
    EXPECT_EQ(openrouter::parse_error_body(401, R"({"error":{"code":401,"message":"No auth credentials found"}})"),
              "OpenRouter rejected the key (HTTP 401): check [llm] api_key in config.ini: No auth credentials found (401)");
    EXPECT_EQ(openrouter::parse_error_body(503, "upstream down"), "HTTP 503: upstream down");
}

TEST(Url, ParsesHttpsAndHttpEndpoints) {
    auto a = parse_url("https://openrouter.ai/api/v1/chat/completions");
    ASSERT_TRUE(a.ok);
    EXPECT_TRUE(a.secure);
    EXPECT_EQ(a.host, "openrouter.ai");
    EXPECT_EQ(a.port, 443);
    EXPECT_EQ(a.path, "/api/v1/chat/completions");

    auto b = parse_url("http://localhost:11434/v1/chat/completions");
    ASSERT_TRUE(b.ok);
    EXPECT_FALSE(b.secure);
    EXPECT_EQ(b.host, "localhost");
    EXPECT_EQ(b.port, 11434);

    EXPECT_FALSE(parse_url("ftp://x").ok);
    EXPECT_FALSE(parse_url("https://host:99999/").ok);
    EXPECT_FALSE(parse_url("https://:443/").ok);
    EXPECT_EQ(parse_url("https://api.openai.com").path, "/");
}
