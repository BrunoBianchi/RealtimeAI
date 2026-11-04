// Pure core: the RealTimeAI cloud backend ("nuvem") contract, client side.
//
// The server is a credential broker, not a media proxy. At engine start the
// app makes ONE call, POST {server}/v1/session, and gets back where to stream
// audio (STT) and where to send completions (LLM), each with a short-lived
// bearer token. Audio then goes straight to the STT provider (Deepgram accepts
// temporary tokens) and the LLM URL is whatever the server picked: an edge
// relay next to the provider or the provider itself. No extra hop sits in the
// per-turn path; the only network cost the cloud adds is that one bootstrap
// call, made in parallel with audio/RAG startup, plus background refreshes.
//
// Signing in is mandatory: every live session starts with this call, which is
// also where the server enforces the plan (Free: one session of up to 15 min,
// once; PRO: 200 min per month). With [servidor] modo = proprio the server
// only grants the session (quota) and the audio/LLM use the user's own keys.
//
// The full HTTP contract is documented in docs/server-api.md. Everything here
// is parsing/validation so it stays platform-free and unit-tested; the WinHTTP
// client lives in src/net (cloud_client.hpp).
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

#include "rtai/json_min.hpp"
#include "rtai/settings.hpp"
#include "rtai/text_util.hpp"
#include "rtai/url.hpp"

namespace rtai::cloud {

// Default API base URL baked into official builds (CMake -DRTAI_SERVER_URL=...).
// Empty in a plain open-source build: the app then only runs on the user's own
// keys unless [servidor] url is set.
#ifdef RTAI_SERVER_URL
inline constexpr const char* kDefaultServerUrl = RTAI_SERVER_URL;
#else
inline constexpr const char* kDefaultServerUrl = "";
#endif

inline constexpr int kApiVersion = 1;

// One streaming target handed out by the server.
struct Endpoint {
    std::string url;   // wss://... for STT, https://.../chat/completions for LLM
    std::string token; // sent as "Authorization: Bearer <token>"
    std::string model;
    [[nodiscard]] bool valid() const { return !url.empty() && !token.empty(); }
};

struct Session {
    std::string session_id;
    std::int64_t expires_at_s{0};   // unix seconds; 0 = server did not say
    int refresh_after_s{240};       // when to fetch fresh credentials in background
    Endpoint stt;
    std::string stt_extra_query;    // appended to the listen query (e.g. "tag=sess_x")
    Endpoint llm;
    Endpoint llm_fallback;          // optional; used when the primary fails fast
    std::string background_model;   // summaries/compaction; empty = llm.model
    std::string plan;               // "free" | "pro": shown in the UI
    std::int64_t minutes_left{-1};  // -1 = unlimited / unknown
    std::int64_t max_session_s{-1}; // longest this session may run; -1 = plan default
    std::string notice;             // optional pt-BR message for the HUD
    [[nodiscard]] bool has_credentials() const { return stt.valid(); }
};

// Plan rules. The server is the authority (it refuses /v1/session with 402
// when the quota is gone and sends minutes_left/max_session_s); these are the
// client-side defaults used when a field is missing, so a session can never
// run unbounded.
struct PlanRules {
    const char* id;
    const char* label;
    std::int64_t minutes;         // quota per period
    bool monthly;                 // false = lifetime (one-time trial)
    int max_sessions;             // -1 = unlimited
    std::int64_t max_session_min; // longest single session
};

inline constexpr PlanRules kFreePlan{"free", "Free", 15, false, 1, 15};
inline constexpr PlanRules kProPlan{"pro", "PRO", 200, true, -1, 200};

inline const PlanRules& plan_rules(std::string_view plan) {
    const std::string p = text::fold(text::trim(plan));
    return (p == "pro" || p == "premium") ? kProPlan : kFreePlan;
}

// Seconds this session may last: the server's max_session_s, capped by the
// minutes left in the plan; plan default when the server sent neither.
inline std::int64_t session_budget_s(const Session& s) {
    const PlanRules& rules = plan_rules(s.plan);
    std::int64_t budget = s.max_session_s > 0 ? s.max_session_s : rules.max_session_min * 60;
    if (s.minutes_left >= 0) {
        const std::int64_t left = s.minutes_left * 60;
        if (left < budget) budget = left;
    }
    return budget < 0 ? 0 : budget;
}

// When to warn before the plan limit ends the session.
inline std::int64_t budget_warning_s(std::int64_t budget_s) {
    return budget_s > 120 ? budget_s - 60 : budget_s / 2;
}

// Own: the user's keys, session still granted (and counted) by the server.
// Cloud: server credentials. Local: no account and no server at all
// ([servidor] modo = local, the open-source mode).
enum class Backend : std::uint8_t { Own, Cloud, Local };

constexpr const char* to_string(Backend b) noexcept {
    switch (b) {
        case Backend::Cloud: return "nuvem";
        case Backend::Local: return "local";
        case Backend::Own:   break;
    }
    return "proprio";
}

// Extra wait before each answer in local mode (no plan). Shown to the user in
// the dashboard and the HUD; PRO answers start without it.
inline constexpr int kLocalAnswerDelayMs = 500;

// Base URL actually used: config/env value, else the compiled default.
// Trailing slashes are dropped so paths can be appended.
inline std::string effective_base_url(const Settings& s) {
    std::string u = text::trim(s.server_url.empty() ? std::string(kDefaultServerUrl) : s.server_url);
    while (!u.empty() && u.back() == '/') u.pop_back();
    return u;
}

// A server to sign in to is known (config/env or the build default).
inline bool server_known(const Settings& s) { return parse_url(effective_base_url(s)).ok; }

// Signed in: a device token and a server. Required for any live session.
inline bool signed_in(const Settings& s) { return !s.server_token.empty() && server_known(s); }

// Where the audio and the LLM go: [servidor] modo = local skips the server
// entirely; proprio uses the user's own keys once signed in; auto/nuvem
// (default) use the server credentials.
inline Backend choose_backend(const Settings& s) {
    const std::string mode = text::fold(text::trim(s.server_mode));
    if (mode == "local" || mode == "offline") return Backend::Local;
    if (mode == "proprio" || mode == "own") return Backend::Own;
    return Backend::Cloud;
}

inline bool local_mode(const Settings& s) { return choose_backend(s) == Backend::Local; }

struct SessionRequest {
    std::string app_version;
    std::string language;   // [deepgram] idioma
    std::string model;      // preferred live model (server may override)
    std::string region;     // [servidor] regiao; empty = server decides (GeoIP/anycast)
    std::string agent_id;   // active goal, for server-side analytics only
    bool credentials{true}; // false = own keys: the server only grants the session
};

inline std::string build_session_request(const SessionRequest& r) {
    std::string b = "{\"api\":" + std::to_string(kApiVersion);
    b += ",\"client\":\"engine\"";
    b += ",\"app_version\":" + json::quote(r.app_version);
    b += ",\"platform\":\"windows\"";
    if (!r.language.empty()) b += ",\"language\":" + json::quote(r.language);
    if (!r.model.empty()) b += ",\"model\":" + json::quote(r.model);
    if (!r.region.empty() && text::fold(r.region) != "auto") b += ",\"region\":" + json::quote(r.region);
    if (!r.agent_id.empty()) b += ",\"agent_id\":" + json::quote(r.agent_id);
    b += r.credentials ? ",\"credentials\":true" : ",\"credentials\":false";
    b += ",\"capabilities\":{\"stt\":[\"deepgram-ws\"],\"llm\":[\"openai-chat-sse\"]}";
    b += "}";
    return b;
}

namespace detail {

inline bool scheme_is(std::string_view url, std::string_view a, std::string_view b) {
    return url.substr(0, a.size()) == a || url.substr(0, b.size()) == b;
}

inline Endpoint read_endpoint(const json::Value& v) {
    Endpoint e;
    e.url = v["url"].as_string();
    e.token = v["token"].as_string();
    e.model = v["model"].as_string();
    return e;
}

} // namespace detail

// Parses the POST /v1/session response. Returns nullopt with a pt-BR reason in
// `error` when anything needed to stream is missing or malformed.
// require_credentials=false (own keys): stt/llm may be absent.
inline std::optional<Session> parse_session(std::string_view body, std::string& error,
                                            bool require_credentials = true) {
    auto root = json::Parser::parse(body);
    if (!root || !root->is_object()) {
        error = "invalid server response";
        return std::nullopt;
    }
    const json::Value& r = *root;
    if (r.has("error")) {
        const auto& e = r["error"];
        error = e.is_string() ? e.as_string() : e["message"].as_string();
        if (error.empty()) error = "the server refused the session";
        return std::nullopt;
    }
    Session s;
    s.session_id = r["session_id"].as_string();
    s.expires_at_s = static_cast<std::int64_t>(r["expires_at"].as_number(0));
    {
        const double ra = r["refresh_after_s"].as_number(240);
        s.refresh_after_s = ra < 15 ? 15 : (ra > 3600 ? 3600 : static_cast<int>(ra));
    }
    s.stt = detail::read_endpoint(r["stt"]);
    s.stt_extra_query = r["stt"]["extra_query"].as_string();
    s.llm = detail::read_endpoint(r["llm"]);
    s.llm_fallback = detail::read_endpoint(r["llm"]["fallback"]);
    s.background_model = r["llm"]["background_model"].as_string();
    s.plan = r["account"]["plan"].as_string();
    s.minutes_left = static_cast<std::int64_t>(r["account"]["minutes_left"].as_number(-1));
    s.max_session_s = static_cast<std::int64_t>(r["account"]["max_session_s"].as_number(-1));
    s.notice = r["notice"].as_string();

    if (s.minutes_left == 0) {
        error = "your plan has no minutes left";
        return std::nullopt;
    }
    if (!require_credentials && s.stt.url.empty()) {
        s.stt = {};
        s.llm = {};
        s.llm_fallback = {};
        return s;
    }
    if (!s.stt.valid() || !detail::scheme_is(s.stt.url, "wss://", "ws://") || !parse_url(s.stt.url).ok) {
        error = "the server did not send a valid transcription endpoint";
        return std::nullopt;
    }
    // LLM is optional (transcription-only plans); when present it must be usable.
    if (!s.llm.url.empty() &&
        (!s.llm.valid() || !detail::scheme_is(s.llm.url, "https://", "http://") || !parse_url(s.llm.url).ok)) {
        error = "the server sent an invalid AI endpoint";
        return std::nullopt;
    }
    // The fallback slot of the LLM client is HTTPS-only.
    if (!s.llm_fallback.url.empty() &&
        (!s.llm_fallback.valid() || s.llm_fallback.url.substr(0, 8) != "https://" ||
         !parse_url(s.llm_fallback.url).ok)) {
        s.llm_fallback = {}; // a broken fallback is dropped, never fatal
    }
    return s;
}

// Splits the STT URL into what DeepgramStream needs: host/port/secure and the
// listen path (query parameters are still built by the engine).
struct SttTarget {
    std::string host;
    std::uint16_t port{443};
    bool secure{true};
    std::string path{"/v1/listen"};
};

inline std::optional<SttTarget> stt_target(const Session& s) {
    const ParsedUrl u = parse_url(s.stt.url);
    if (!u.ok) return std::nullopt;
    SttTarget t;
    t.host = u.host;
    t.port = u.port;
    t.secure = u.secure;
    std::string p = u.path;
    if (const auto q = p.find('?'); q != std::string::npos) p.resize(q);
    if (p.empty() || p == "/") p = "/v1/listen";
    t.path = p;
    return t;
}

// Seconds until credentials should be refreshed, never below 15 s and always
// at least 30 s before they expire.
inline int refresh_delay_s(const Session& s, std::int64_t now_unix_s) {
    int d = s.refresh_after_s;
    if (s.expires_at_s > 0) {
        const std::int64_t until_expiry = s.expires_at_s - now_unix_s - 30;
        if (until_expiry < d) d = static_cast<int>(until_expiry);
    }
    return d < 15 ? 15 : d;
}

// JSON body for POST /v1/session/{id}/end (fire-and-forget at shutdown).
struct SessionEnd {
    std::int64_t duration_s{0};
    std::int64_t stt_audio_s{0};
    int answers{0};
    std::int64_t avg_ttft_ms{-1};
};

inline std::string build_session_end(const SessionEnd& e) {
    std::string b = "{\"duration_s\":" + std::to_string(e.duration_s);
    b += ",\"stt_audio_s\":" + std::to_string(e.stt_audio_s);
    b += ",\"answers\":" + std::to_string(e.answers);
    if (e.avg_ttft_ms >= 0) b += ",\"avg_ttft_ms\":" + std::to_string(e.avg_ttft_ms);
    b += "}";
    return b;
}

} // namespace rtai::cloud
