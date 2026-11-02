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
    std::string plan;               // "free", "pro"...: shown in the UI
    std::int64_t minutes_left{-1};  // -1 = unlimited / unknown
    std::string notice;             // optional pt-BR message for the HUD
};

enum class Backend : std::uint8_t { Own, Cloud };

constexpr const char* to_string(Backend b) noexcept {
    return b == Backend::Cloud ? "nuvem" : "proprio";
}

// Base URL actually used: config/env value, else the compiled default.
// Trailing slashes are dropped so paths can be appended.
inline std::string effective_base_url(const Settings& s) {
    std::string u = text::trim(s.server_url.empty() ? std::string(kDefaultServerUrl) : s.server_url);
    while (!u.empty() && u.back() == '/') u.pop_back();
    return u;
}

// [servidor] modo: "proprio" never uses the cloud; "nuvem" requires it; "auto"
// (default) uses it when signed in (token present) and a server is known.
inline Backend choose_backend(const Settings& s) {
    const std::string mode = text::fold(text::trim(s.server_mode));
    if (mode == "proprio" || mode == "own" || mode == "local") return Backend::Own;
    const bool usable = !s.server_token.empty() && parse_url(effective_base_url(s)).ok;
    if (mode == "nuvem" || mode == "cloud") return usable ? Backend::Cloud : Backend::Own;
    return usable ? Backend::Cloud : Backend::Own;
}

// True when the user explicitly asked for the cloud, so a failed bootstrap is
// an error instead of a silent fallback to own keys.
inline bool cloud_required(const Settings& s) {
    const std::string mode = text::fold(text::trim(s.server_mode));
    return mode == "nuvem" || mode == "cloud";
}

struct SessionRequest {
    std::string app_version;
    std::string language;   // [deepgram] idioma
    std::string model;      // preferred live model (server may override)
    std::string region;     // [servidor] regiao; empty = server decides (GeoIP/anycast)
    std::string agent_id;   // active goal, for server-side analytics only
    bool demo{false};
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
inline std::optional<Session> parse_session(std::string_view body, std::string& error) {
    auto root = json::Parser::parse(body);
    if (!root || !root->is_object()) {
        error = "resposta do servidor inválida";
        return std::nullopt;
    }
    const json::Value& r = *root;
    if (r.has("error")) {
        const auto& e = r["error"];
        error = e.is_string() ? e.as_string() : e["message"].as_string();
        if (error.empty()) error = "o servidor recusou a sessão";
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
    s.notice = r["notice"].as_string();

    if (!s.stt.valid() || !detail::scheme_is(s.stt.url, "wss://", "ws://") || !parse_url(s.stt.url).ok) {
        error = "o servidor não enviou um endpoint de transcrição válido";
        return std::nullopt;
    }
    // LLM is optional (transcription-only plans); when present it must be usable.
    if (!s.llm.url.empty() &&
        (!s.llm.valid() || !detail::scheme_is(s.llm.url, "https://", "http://") || !parse_url(s.llm.url).ok)) {
        error = "o servidor enviou um endpoint de IA inválido";
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
