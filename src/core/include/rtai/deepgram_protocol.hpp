// Pure core: Deepgram streaming protocol. URL construction, control-message
// framing, server-message parsing and the KeepAlive scheduling policy. No I/O
// here; DeepgramStream (core) drives an IWebSocket and the WinHTTP adapter in
// src/net performs the actual socket work.
//
// Protocol notes (developers.deepgram.com, checked 2026-10):
//   * Control messages are JSON *text* frames. Sending them as binary frames
//     is interpreted as audio.
//   * The server closes the socket (NET-0001) if it receives neither audio nor
//     a KeepAlive for ~10 s. Recommended KeepAlive cadence: every 3-5 s.
//   * {"type":"Finalize"} flushes buffered audio and returns finals marked
//     "from_finalize": true (not guaranteed when little audio is buffered).
//   * {"type":"CloseStream"} flushes, sends a Metadata summary and closes.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "rtai/json_min.hpp"

namespace rtai::dg {

// Parameters for a streaming connection. Defaults: Nova-3, linear16, 16 kHz,
// mono, interim results, smart formatting (punctuation helps the copilot spot
// questions) and 300 ms endpointing.
struct StreamParams {
    std::string host{"api.deepgram.com"};
    std::string model{"nova-3"};
    std::string encoding{"linear16"};
    std::uint32_t sample_rate{16000};
    std::uint16_t channels{1};
    bool interim_results{true};
    std::optional<std::string> language; // "multi", "pt-BR", "en"...; omitted if empty
    bool smart_format{true};
    std::optional<int> endpointing_ms{300}; // nullopt: server default; <= 0: "false"
    std::optional<int> utterance_end_ms;    // >= 1000; requires interim_results
    bool vad_events{false};
    std::vector<std::string> keyterms;      // Nova-3 keyterm prompting (product names...)
    // Smart formatting may HOLD a final for up to ~3 s while it waits to
    // format a number/entity. no_delay=true finalizes immediately (formatting
    // is skipped only for those entities; punctuation stays).
    bool no_delay{true};
    // language=multi only: bias (not restrict) detection to these languages,
    // e.g. {"pt", "en"} for interviews that switch between both.
    std::vector<std::string> language_hints;
};

// Percent-encodes everything except RFC 3986 unreserved characters.
inline std::string url_encode(std::string_view s) {
    static const char* hex = "0123456789ABCDEF";
    std::string out;
    out.reserve(s.size());
    for (unsigned char c : s) {
        const bool unreserved = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                                (c >= '0' && c <= '9') || c == '-' || c == '_' ||
                                c == '.' || c == '~';
        if (unreserved) {
            out.push_back(static_cast<char>(c));
        } else {
            out.push_back('%');
            out.push_back(hex[c >> 4]);
            out.push_back(hex[c & 0xF]);
        }
    }
    return out;
}

// Builds the request path + query for the v1 streaming listen endpoint, e.g.
//   /v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1&interim_results=true...
// The scheme is wss; host comes from params.host.
inline std::string build_listen_path(const StreamParams& p) {
    std::string q = "/v1/listen";
    q += "?model=" + url_encode(p.model);
    q += "&encoding=" + url_encode(p.encoding);
    q += "&sample_rate=" + std::to_string(p.sample_rate);
    q += "&channels=" + std::to_string(p.channels);
    q += "&interim_results=";
    q += (p.interim_results ? "true" : "false");
    if (p.language && !p.language->empty()) {
        q += "&language=" + url_encode(*p.language);
    }
    if (p.smart_format) {
        q += "&smart_format=true";
        if (p.no_delay) q += "&no_delay=true";
    }
    if (p.language && *p.language == "multi") {
        for (const auto& h : p.language_hints) {
            if (!h.empty()) q += "&language_hint=" + url_encode(h);
        }
    }
    if (p.endpointing_ms) {
        q += "&endpointing=";
        q += *p.endpointing_ms > 0 ? std::to_string(*p.endpointing_ms) : std::string("false");
    }
    if (p.utterance_end_ms && p.interim_results) {
        const int ms = *p.utterance_end_ms < 1000 ? 1000 : *p.utterance_end_ms;
        q += "&utterance_end_ms=" + std::to_string(ms);
    }
    if (p.vad_events) q += "&vad_events=true";
    for (const auto& k : p.keyterms) {
        if (!k.empty()) q += "&keyterm=" + url_encode(k);
    }
    return q;
}

// Same connection without the optional extras (hints, no_delay, keyterms).
// Used as an automatic fallback when Deepgram answers HTTP 400 to the full
// set, so a rejected optional parameter never leaves the user without STT.
inline std::string build_minimal_listen_path(StreamParams p) {
    p.language_hints.clear();
    p.no_delay = false;
    p.keyterms.clear();
    return build_listen_path(p);
}

// Control messages are JSON text frames (RFC-6455 text), distinct from the
// binary audio frames.
inline std::string keepalive_message() { return R"({"type":"KeepAlive"})"; }
inline std::string finalize_message() { return R"({"type":"Finalize"})"; }
inline std::string close_stream_message() { return R"({"type":"CloseStream"})"; }

// -------------------------------------------------------------------------
// Server messages
// -------------------------------------------------------------------------
enum class MessageKind {
    Invalid,      // not JSON / not an object
    Results,
    UtteranceEnd,
    SpeechStarted,
    Metadata,
    Error,
    Unknown,
};

struct ServerMessage {
    MessageKind kind{MessageKind::Invalid};
    // Results
    std::string transcript;
    bool is_final{false};
    bool speech_final{false};
    bool from_finalize{false};
    double start{0.0};
    double duration{0.0};
    double confidence{0.0};
    // UtteranceEnd (-1 means "already finalized, ignore")
    double last_word_end{0.0};
    // Metadata
    std::string request_id;
    // Error
    std::string error;
};

inline ServerMessage parse_message(std::string_view json_text) {
    ServerMessage m{};
    auto parsed = json::Parser::parse(json_text);
    if (!parsed || !parsed->is_object()) return m;
    const json::Value& root = *parsed;
    const std::string& type = root["type"].as_string();

    if (type == "Results" || (type.empty() && root["channel"]["alternatives"].is_array())) {
        const json::Value& alts = root["channel"]["alternatives"];
        if (!alts.is_array() || alts.size() == 0) { m.kind = MessageKind::Unknown; return m; }
        const json::Value& best = alts.at(0);
        if (!best["transcript"].is_string()) { m.kind = MessageKind::Unknown; return m; }
        m.kind = MessageKind::Results;
        m.transcript = best["transcript"].as_string();
        m.confidence = best["confidence"].as_number(0.0);
        m.is_final = root["is_final"].as_bool(false);
        m.speech_final = root["speech_final"].as_bool(false);
        m.from_finalize = root["from_finalize"].as_bool(false);
        m.start = root["start"].as_number(0.0);
        m.duration = root["duration"].as_number(0.0);
        return m;
    }
    if (type == "UtteranceEnd") {
        m.kind = MessageKind::UtteranceEnd;
        m.last_word_end = root["last_word_end"].as_number(0.0);
        return m;
    }
    if (type == "SpeechStarted") {
        m.kind = MessageKind::SpeechStarted;
        m.start = root["timestamp"].as_number(0.0);
        return m;
    }
    if (type == "Metadata") {
        m.kind = MessageKind::Metadata;
        m.request_id = root["request_id"].as_string();
        return m;
    }
    // Error shapes seen across API versions; parse defensively.
    if (type == "Error" || root.has("err_code") || root.has("err_msg")) {
        m.kind = MessageKind::Error;
        for (const char* k : {"description", "message", "err_msg", "variant", "err_code"}) {
            const std::string& v = root[k].as_string();
            if (!v.empty()) { m.error = v; break; }
        }
        if (m.error.empty()) m.error = "unknown Deepgram error";
        return m;
    }
    m.kind = MessageKind::Unknown;
    return m;
}

// A parsed transcript result from a Deepgram "Results" message (compat API).
struct TranscriptResult {
    bool valid{false};
    bool is_final{false};
    bool speech_final{false};
    std::string transcript; // best alternative's transcript text
};

inline TranscriptResult parse_transcript(std::string_view json_text) {
    TranscriptResult r{};
    const ServerMessage m = parse_message(json_text);
    if (m.kind != MessageKind::Results) return r;
    r.valid = true;
    r.transcript = m.transcript;
    r.is_final = m.is_final;
    r.speech_final = m.speech_final;
    return r;
}

// Close-frame interpretation for logs/UI. Deepgram closes with 1011 on
// timeouts (NET-0000/NET-0001) and 1008 on undecodable audio (DATA-0000).
inline std::string describe_close(std::uint16_t code, std::string_view reason) {
    std::string d = "fechado pelo servidor (" + std::to_string(code);
    if (!reason.empty()) {
        d += " ";
        d += reason;
    }
    d += ")";
    if (reason.find("NET-0001") != std::string_view::npos) {
        d += ": no audio/KeepAlive received within the timeout";
    } else if (reason.find("DATA-0000") != std::string_view::npos) {
        d += ": audio does not match the configured encoding";
    }
    return d;
}

// -------------------------------------------------------------------------
// KeepAlive scheduling policy (pure, idle-based).
//
// A KeepAlive is due whenever nothing (audio or control) has been written for
// `interval`. This covers both cases that used to drop the socket:
//   * the VAD gate is closed (silence), and
//   * WASAPI loopback delivers no packets at all while nothing is playing.
// The stream's writer thread waits on next_due() with a timer, so the policy
// runs even when no audio and no server message ever arrive.
// -------------------------------------------------------------------------
class KeepAlivePolicy {
public:
    // interval in the caller's tick unit (DeepgramStream uses milliseconds).
    explicit KeepAlivePolicy(std::uint64_t interval_ticks = 3000) noexcept
        : interval_(interval_ticks) {}

    // Any frame written to the socket (audio, control, KeepAlive).
    void on_write(std::uint64_t now) noexcept { last_write_ = now; }

    // Compat names used by older call sites/tests.
    void on_audio_sent(std::uint64_t now) noexcept { on_write(now); }
    void on_silence(std::uint64_t /*now*/) noexcept {}

    [[nodiscard]] bool due(std::uint64_t now) const noexcept {
        return now >= last_write_ && now - last_write_ >= interval_;
    }

    // Returns true if a KeepAlive should be sent now (and records the send).
    bool should_send(std::uint64_t now) noexcept {
        if (!due(now)) return false;
        on_write(now);
        return true;
    }

    // Absolute tick at which the next KeepAlive becomes due.
    [[nodiscard]] std::uint64_t next_due() const noexcept { return last_write_ + interval_; }

    [[nodiscard]] std::uint64_t interval() const noexcept { return interval_; }

private:
    std::uint64_t interval_;
    std::uint64_t last_write_{0};
};

} // namespace rtai::dg
