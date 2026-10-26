// Pure core: OpenRouter chat-completions wire format (OpenAI-compatible).
//   POST https://openrouter.ai/api/v1/chat/completions, "stream": true
//   SSE "data: {json}" chunks with choices[0].delta.content, ending with
//   "data: [DONE]"; ": OPENROUTER PROCESSING" comments keep the stream alive.
//   Errors before streaming: HTTP status + {"error":{"code","message"}}.
//   Errors mid-stream: HTTP 200 + a chunk with a top-level "error" and
//   finish_reason "error".
#pragma once

#include <string>
#include <string_view>

#include "rtai/json_min.hpp"
#include "rtai/llm.hpp"
#include "rtai/text_util.hpp"

namespace rtai::openrouter {

inline std::string cerebras_reasoning_effort(const LlmRequest& req) {
    if (req.model == "qwen-3.8-27b") {
        if (req.reasoning_effort == "low" || req.reasoning_effort == "medium" ||
            req.reasoning_effort == "high" || req.reasoning_effort == "none") {
            return req.reasoning_effort;
        }
        return "none";
    }
    if (req.model == "gpt-oss-120b") {
        if (req.reasoning_effort == "low" || req.reasoning_effort == "medium" ||
            req.reasoning_effort == "high") {
            return req.reasoning_effort;
        }
        return "low";
    }
    return req.reasoning_effort.empty() ? "none" : req.reasoning_effort;
}

// `provider_sort` (OpenRouter only): "latency" asks the router to try the
// provider with the lowest latency first instead of load-balancing by price.
inline std::string build_request_body(const LlmRequest& req, bool cerebras_compatible = false,
                                      std::string_view provider_sort = {}) {
    json::Writer w;
    w.begin_object();
    w.field("model", req.model);
    w.key("messages").begin_array();
    for (const auto& m : req.messages) {
        w.begin_object();
        w.field("role", m.role);
        if (m.images.empty()) {
            w.field("content", text::sanitize_utf8(m.content));
        } else {
            // OpenAI-style multimodal content parts.
            w.key("content").begin_array();
            w.begin_object();
            w.field("type", "text");
            w.field("text", text::sanitize_utf8(m.content));
            w.end_object();
            for (const auto& url : m.images) {
                w.begin_object();
                w.field("type", "image_url");
                w.key("image_url").begin_object();
                w.field("url", url);
                w.end_object();
                w.end_object();
            }
            w.end_array();
        }
        w.end_object();
    }
    w.end_array();
    w.field_bool("stream", true);
    w.field_int("max_tokens", req.max_tokens);
    w.field_double("temperature", req.temperature, 2);
    if (cerebras_compatible) {
        // Cerebras expects the OpenAI-compatible reasoning_effort parameter,
        // not OpenRouter's nested reasoning object. "none" is important for
        // Qwen: reasoning is enabled at high effort by default and can consume
        // the entire completion budget before visible answer tokens arrive.
        w.field("reasoning_effort", cerebras_reasoning_effort(req));
    } else if (!req.reasoning_effort.empty()) {
        w.key("reasoning").begin_object();
        w.field("effort", req.reasoning_effort);
        w.field_bool("exclude", true); // we only display the answer
        w.end_object();
    }
    if (!cerebras_compatible && !provider_sort.empty()) {
        w.key("provider").begin_object();
        w.field("sort", std::string(provider_sort));
        w.end_object();
    }
    w.end_object();
    return std::move(w).str();
}

struct Chunk {
    bool valid{false};
    bool done{false};          // "[DONE]"
    std::string content;       // choices[0].delta.content
    std::string finish_reason; // choices[0].finish_reason
    std::string error;         // mid-stream error message
};

inline std::string error_message_from(const json::Value& err) {
    if (err.is_string()) return err.as_string();
    std::string msg = err["message"].as_string();
    const json::Value& code = err["code"];
    if (code.is_number()) {
        msg += " (" + std::to_string(static_cast<long long>(code.as_number())) + ")";
    } else if (code.is_string() && !code.as_string().empty()) {
        msg += " (" + code.as_string() + ")";
    }
    return msg.empty() ? std::string("provider error") : msg;
}

inline Chunk parse_chunk(std::string_view data) {
    Chunk c;
    const std::string trimmed = text::trim(data);
    if (trimmed == "[DONE]") {
        c.valid = true;
        c.done = true;
        return c;
    }
    auto parsed = json::Parser::parse(trimmed);
    if (!parsed || !parsed->is_object()) return c;
    const json::Value& root = *parsed;
    c.valid = true;
    if (root.has("error")) c.error = error_message_from(root["error"]);
    const json::Value& choice = root["choices"].at(0);
    c.content = choice["delta"]["content"].as_string();
    c.finish_reason = choice["finish_reason"].as_string();
    if (c.error.empty() && c.finish_reason == "error") c.error = "the provider ended with an error";
    return c;
}

// Error body of a non-200 response.
inline std::string parse_error_body(int http_status, std::string_view body) {
    std::string prefix = "HTTP " + std::to_string(http_status);
    switch (http_status) {
        case 401: prefix = "OpenRouter rejected the key (HTTP 401): check [llm] api_key in config.ini"; break;
        case 402: prefix = "No OpenRouter credits left (HTTP 402)"; break;
        case 429: prefix = "OpenRouter rate limit (HTTP 429)"; break;
        default: break;
    }
    auto parsed = json::Parser::parse(text::trim(body));
    if (parsed && parsed->is_object() && parsed->has("error")) {
        return prefix + ": " + error_message_from((*parsed)["error"]);
    }
    const std::string snippet = text::truncate_utf8(text::trim(body), 200);
    return snippet.empty() ? prefix : prefix + ": " + snippet;
}

} // namespace rtai::openrouter
