// Pure core: wire protocol between the engine process (rtai_app.exe --server)
// and an external client (another UI, a test harness, automation). Optional:
// the native overlay is the main UI. One JSON object per line, UTF-8, "\n".
//
//   engine -> UI (stdout)                     UI -> engine (stdin)
//   {"type":"hello", ...}                     {"cmd":"answer"}
//   {"type":"status","src":"outros",...}      {"cmd":"chat","text":"..."}
//   {"type":"live","src":..,"text":..}        {"cmd":"screenshot","image":"data:...","text":""}
//   {"type":"turn", ...}                      {"cmd":"recap"} / {"cmd":"followup"}
//   {"type":"answer_start", ...}              {"cmd":"pause","src":"voce|outros|all","paused":true}
//   {"type":"answer_delta","id":3,"text":..}  {"cmd":"rate","id":3,"vote":1}
//   {"type":"answer_done", ...}               {"cmd":"clear_chat"}
//   {"type":"notice","level":..,"text":..}    {"cmd":"set_config","values":[{"section","key","value"}]}
//   {"type":"pause","paused":..,"src":..}     {"cmd":"open_config"}
//   {"type":"level","voce":0.4,...}           {"cmd":"quit"}
//   {"type":"bye", ...}
//
// stdout carries ONLY protocol lines; logs go to stderr. EOF on stdin means
// the UI is gone and the engine shuts down (saving the session).
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <type_traits>
#include <variant>
#include <vector>

#include "rtai/copilot_events.hpp"
#include "rtai/json_min.hpp"
#include "rtai/text_util.hpp"

namespace rtai::server {

constexpr int kProtocolVersion = 1;

inline const char* src_key(AudioSource s) noexcept {
    return s == AudioSource::Microphone ? "voce" : "outros";
}

// ---------------------------------------------------------------------------
// engine -> UI
// ---------------------------------------------------------------------------

struct Hello {
    bool mode{false};          // Mode_State (Transcription_Only_Mode)
    std::string app_mode;      // "live" | "demo"
    bool ready{true};          // false: setup needed (see `needs`)
    std::string needs;         // "deepgram_key" when the STT key is missing
    bool llm{false};
    std::string model;
    std::string language;
    bool auto_suggest{true};
    bool mic{true};
    bool system_audio{true};
    bool has_deepgram_key{false};
    bool has_llm_key{false};
    std::string llm_url;
    std::string config_path;
    std::string session_path;  // .jsonl being written, empty if not saving
    std::string app_version;   // engine build version ("2.1.0-beta.3"), lets the UI spot a mismatch
};

inline std::string encode_hello(const Hello& h) {
    json::Writer w;
    w.begin_object()
        .field("type", "hello")
        .field_int("version", kProtocolVersion)
        .field_bool("mode", h.mode)
        .field("app_mode", h.app_mode.empty() ? (h.ready ? "live" : "setup") : h.app_mode)
        .field_bool("ready", h.ready)
        .field("needs", h.needs)
        .field_bool("llm", h.llm)
        .field("model", h.model)
        .field("language", h.language)
        .field_bool("auto_suggest", h.auto_suggest)
        .field_bool("mic", h.mic)
        .field_bool("system_audio", h.system_audio)
        .field_bool("has_deepgram_key", h.has_deepgram_key)
        .field_bool("has_llm_key", h.has_llm_key)
        .field("llm_url", h.llm_url)
        .field("config_path", h.config_path)
        .field("session_path", h.session_path)
        .field("app_version", h.app_version)
        .end_object();
    return std::move(w).str();
}

struct Levels {
    float voce{0}, outros{0};
    bool voce_speaking{false}, outros_speaking{false};
    bool voce_active{false}, outros_active{false}; // lane exists and is capturing
};

inline std::string encode_levels(const Levels& l) {
    json::Writer w;
    w.begin_object()
        .field("type", "level")
        .field_double("voce", l.voce, 2)
        .field_double("outros", l.outros, 2)
        .field_bool("voce_speaking", l.voce_speaking)
        .field_bool("outros_speaking", l.outros_speaking)
        .field_bool("voce_active", l.voce_active)
        .field_bool("outros_active", l.outros_active)
        .end_object();
    return std::move(w).str();
}

inline std::string encode_bye(const std::string& jsonl, const std::string& markdown) {
    json::Writer w;
    w.begin_object().field("type", "bye").field("session", jsonl).field("summary", markdown).end_object();
    return std::move(w).str();
}

inline std::string encode_summary(bool ok, std::string_view text, std::string_view export_path) {
    json::Writer w;
    w.begin_object()
        .field("type", "summary")
        .field_bool("ok", ok)
        .field("text", text)
        .field("export", export_path)
        .end_object();
    return std::move(w).str();
}

inline std::string encode_simple(std::string_view type, std::string_view field, std::string_view value) {
    json::Writer w;
    w.begin_object().field("type", type).field(field, value).end_object();
    return std::move(w).str();
}

// Returns an empty string for events the UI doesn't need (feedback echoes).
inline std::string encode_event(const EngineEvent& ev) {
    json::Writer w;
    bool keep = true;
    std::visit(
        [&](const auto& e) {
            using T = std::decay_t<decltype(e)>;
            if constexpr (std::is_same_v<T, LaneStatusEvent>) {
                w.begin_object()
                    .field("type", "status")
                    .field_int("t", e.t_ms)
                    .field("src", src_key(e.status.source))
                    .field("state", to_string(e.status.state))
                    .field("detail", e.status.detail)
                    .field_int("reconnects", e.status.reconnects)
                    .field_int("http", e.status.http_status)
                    .end_object();
            } else if constexpr (std::is_same_v<T, TranscriptUpdateEvent>) {
                w.begin_object()
                    .field("type", "live")
                    .field_int("t", e.t_ms)
                    .field("src", src_key(e.source))
                    .field("text", e.text)
                    .field_bool("closed", e.turn_closed)
                    .end_object();
            } else if constexpr (std::is_same_v<T, TurnEvent>) {
                w.begin_object()
                    .field("type", "turn")
                    .field("src", src_key(e.turn.source))
                    .field("text", e.turn.text)
                    .field_int("start", e.turn.start_ms)
                    .field_int("end", e.turn.end_ms)
                    .key("seq").uint_value(e.turn.seq)
                    .end_object();
            } else if constexpr (std::is_same_v<T, SuggestionStartedEvent>) {
                w.begin_object()
                    .field("type", "answer_start")
                    .field_int("t", e.t_ms)
                    .key("id").uint_value(e.id)
                    .field("trigger", e.trigger_text)
                    .field("src", src_key(e.trigger_source))
                    .field("reason", to_string(e.reason))
                    .field("keyword", e.keyword)
                    .field("model", e.model)
                    .field_bool("image", e.has_image)
                    .end_object();
            } else if constexpr (std::is_same_v<T, SuggestionDeltaEvent>) {
                w.begin_object()
                    .field("type", "answer_delta")
                    .key("id").uint_value(e.id)
                    .field("text", e.text)
                    .end_object();
            } else if constexpr (std::is_same_v<T, SuggestionDoneEvent>) {
                w.begin_object()
                    .field("type", "answer_done")
                    .field_int("t", e.t_ms)
                    .key("id").uint_value(e.id)
                    .field("status", to_string(e.status))
                    .field("text", e.text)
                    .field("error", e.error)
                    .field("reason", to_string(e.reason))
                    .field_int("ttft", e.ttft_ms)
                    .field_int("total", e.total_ms)
                    .field_int("visible", e.visible_ms)
                    .field("understood", e.interpreted_question)
                    .end_object();
            } else if constexpr (std::is_same_v<T, NoticeEvent>) {
                w.begin_object()
                    .field("type", "notice")
                    .field_int("t", e.t_ms)
                    .field("level", to_string(e.level))
                    .field("text", e.text)
                    .end_object();
            } else if constexpr (std::is_same_v<T, PauseEvent>) {
                w.begin_object()
                    .field("type", "pause")
                    .field_int("t", e.t_ms)
                    .field_bool("paused", e.paused)
                    .field("src", e.source < 0 ? "all" : src_key(static_cast<AudioSource>(e.source)))
                    .end_object();
            } else if constexpr (std::is_same_v<T, TranscriptionModeEvent>) {
                w.begin_object()
                    .field("type", "mode")
                    .field_bool("on", e.enabled)
                    .end_object();
            } else {
                keep = false;
            }
        },
        ev);
    return keep ? std::move(w).str() : std::string();
}

// ---------------------------------------------------------------------------
// UI -> engine
// ---------------------------------------------------------------------------

struct ConfigValue {
    std::string section, key, value;
};

struct Command {
    enum class Kind {
        Answer, Chat, Screenshot, Recap, FollowUp, Pause, Rate, ClearChat, SetConfig, OpenConfig, Quit, SetMode
    } kind{Kind::Answer};
    std::string text;
    std::string image;          // data URL
    int source{-1};             // pause: -1 all, else AudioSource
    bool paused{false};
    bool mode_on{false};
    std::uint64_t id{0};        // rate
    int vote{0};
    std::vector<ConfigValue> values;
};

// Images arrive as data URLs; anything else (file://, http://) is refused so
// the UI can't make the engine fetch arbitrary resources.
inline bool is_image_data_url(std::string_view s) {
    return s.rfind("data:image/png;base64,", 0) == 0 || s.rfind("data:image/jpeg;base64,", 0) == 0 ||
           s.rfind("data:image/webp;base64,", 0) == 0;
}

inline std::optional<Command> parse_command(std::string_view line, std::string* error = nullptr) {
    auto fail = [&](const char* why) -> std::optional<Command> {
        if (error) *error = why;
        return std::nullopt;
    };
    auto parsed = json::Parser::parse(text::trim(line));
    if (!parsed || !parsed->is_object()) return fail("invalid JSON");
    const json::Value& v = *parsed;
    const std::string& cmd = v["cmd"].as_string();
    Command c;
    if (cmd == "answer") {
        c.kind = Command::Kind::Answer;
    } else if (cmd == "chat") {
        c.kind = Command::Kind::Chat;
        c.text = text::sanitize_utf8(text::truncate_utf8(text::trim(v["text"].as_string()), 4000));
        if (c.text.empty()) return fail("chat without text");
    } else if (cmd == "screenshot") {
        c.kind = Command::Kind::Screenshot;
        c.image = v["image"].as_string();
        c.text = text::sanitize_utf8(text::truncate_utf8(text::trim(v["text"].as_string()), 4000));
        if (!is_image_data_url(c.image)) return fail("screenshot without a data:image/...;base64 image");
    } else if (cmd == "recap") {
        c.kind = Command::Kind::Recap;
    } else if (cmd == "followup") {
        c.kind = Command::Kind::FollowUp;
    } else if (cmd == "pause") {
        c.kind = Command::Kind::Pause;
        c.paused = v["paused"].as_bool();
        const std::string& s = v["src"].as_string();
        if (s == "voce") c.source = static_cast<int>(AudioSource::Microphone);
        else if (s == "outros") c.source = static_cast<int>(AudioSource::Loopback);
        else if (s.empty() || s == "all") c.source = -1;
        else return fail("src must be voce, outros or all");
    } else if (cmd == "rate") {
        c.kind = Command::Kind::Rate;
        const double id = v["id"].as_number(-1);
        if (id < 1) return fail("rate without id");
        c.id = static_cast<std::uint64_t>(id);
        const double vote = v["vote"].as_number(0);
        c.vote = vote > 0 ? 1 : (vote < 0 ? -1 : 0);
    } else if (cmd == "clear_chat") {
        c.kind = Command::Kind::ClearChat;
    } else if (cmd == "set_config") {
        c.kind = Command::Kind::SetConfig;
        const json::Value& arr = v["values"];
        for (std::size_t i = 0; i < arr.size(); ++i) {
            const json::Value& e = arr.at(i);
            ConfigValue cv{text::trim(e["section"].as_string()), text::trim(e["key"].as_string()),
                           text::trim(e["value"].as_string())};
            if (cv.section.empty() || cv.key.empty()) return fail("set_config: section/key vazios");
            // One line per value: no newline may sneak into config.ini.
            if (cv.value.find_first_of("\r\n") != std::string::npos) return fail("set_config: value with a line break");
            c.values.push_back(std::move(cv));
        }
        if (c.values.empty()) return fail("set_config without values");
    } else if (cmd == "open_config") {
        c.kind = Command::Kind::OpenConfig;
    } else if (cmd == "set_mode") {
        c.kind = Command::Kind::SetMode;
        c.mode_on = v["on"].as_bool();
    } else if (cmd == "quit") {
        c.kind = Command::Kind::Quit;
    } else {
        return fail("comando desconhecido");
    }
    return c;
}

// Splits a byte stream into lines; keeps the incomplete tail. Lines longer
// than `max_line` are dropped (a screenshot is ~0.5 MB, so the cap is high).
class LineSplitter {
public:
    explicit LineSplitter(std::size_t max_line = 16 * 1024 * 1024) : max_line_(max_line) {}

    template <class F>
    void feed(std::string_view bytes, F&& on_line) {
        std::size_t start = 0;
        for (std::size_t i = 0; i < bytes.size(); ++i) {
            if (bytes[i] != '\n') continue;
            append(bytes.substr(start, i - start));
            if (!overflow_) {
                if (!buf_.empty() && buf_.back() == '\r') buf_.pop_back();
                if (!buf_.empty()) on_line(std::string_view(buf_));
            }
            buf_.clear();
            overflow_ = false;
            start = i + 1;
        }
        append(bytes.substr(start));
    }

private:
    void append(std::string_view s) {
        if (overflow_) return;
        if (buf_.size() + s.size() > max_line_) {
            overflow_ = true;
            buf_.clear();
            return;
        }
        buf_.append(s);
    }

    std::size_t max_line_;
    std::string buf_;
    bool overflow_{false};
};

} // namespace rtai::server
