#include "rtai/session_store.hpp"

#include <algorithm>
#include <cstdio>
#include <ctime>
#include <random>
#include <sstream>
#include <system_error>
#include <type_traits>
#include <variant>

#include "rtai/text_util.hpp"

namespace rtai {

namespace fs = std::filesystem;

namespace {

constexpr const char* kVersion = "0.2.0";

const char* source_key(AudioSource s) {
    return s == AudioSource::Microphone ? "voce" : "outros";
}

const char* source_label(const std::string& key) {
    return key == "voce" ? "You" : "Others";
}

std::tm local_tm(std::time_t t) {
    std::tm tm{};
#ifdef _WIN32
    localtime_s(&tm, &t);
#else
    localtime_r(&t, &tm);
#endif
    return tm;
}

std::tm utc_tm(std::time_t t) {
    std::tm tm{};
#ifdef _WIN32
    gmtime_s(&tm, &t);
#else
    gmtime_r(&t, &tm);
#endif
    return tm;
}

// "+HH:MM"/"-HH:MM". strftime's %z is not portable on Windows CRTs (older
// msvcrt prints the zone *name*) and mktime-based tricks inherit the CRT's
// DST guesses, so the offset is the difference between the broken-down local
// and UTC times of the same instant (localtime already applied the OS rules).
std::string utc_offset(std::time_t now) {
    const std::tm l = local_tm(now);
    const std::tm g = utc_tm(now);
    int day_diff = l.tm_yday - g.tm_yday;
    if (l.tm_year != g.tm_year) day_diff = l.tm_year > g.tm_year ? 1 : -1;
    long off = static_cast<long>(day_diff) * 1440 + (l.tm_hour - g.tm_hour) * 60L + (l.tm_min - g.tm_min);
    const char sign = off < 0 ? '-' : '+';
    if (off < 0) off = -off;
    off %= 24 * 60; // real offsets are within +-14:00
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%c%02ld:%02ld", sign, off / 60, off % 60);
    return buf;
}

std::string fmt_clock(std::int64_t ms) {
    if (ms < 0) ms = 0;
    const std::int64_t s = ms / 1000;
    char buf[32];
    if (s >= 3600) {
        std::snprintf(buf, sizeof(buf), "%lld:%02lld:%02lld", static_cast<long long>(s / 3600),
                      static_cast<long long>((s / 60) % 60), static_cast<long long>(s % 60));
    } else {
        std::snprintf(buf, sizeof(buf), "%02lld:%02lld", static_cast<long long>(s / 60),
                      static_cast<long long>(s % 60));
    }
    return buf;
}

// "0,8 s" (pt-BR decimal comma).
std::string fmt_seconds(std::int64_t ms) {
    const std::int64_t tenths = (ms + 50) / 100;
    return std::to_string(tenths / 10) + "." + std::to_string(tenths % 10) + " s";
}

std::string quote_block(const std::string& text) {
    std::string out;
    std::size_t start = 0;
    while (start <= text.size()) {
        std::size_t end = text.find('\n', start);
        if (end == std::string::npos) end = text.size();
        std::string line = text.substr(start, end - start);
        out += line.empty() ? ">\n" : "> " + line + "\n";
        start = end + 1;
    }
    return out;
}

const char* state_pt(const std::string& s) {
    if (s == "connected") return "connected";
    if (s == "connecting") return "connecting";
    if (s == "reconnecting") return "reconnecting";
    if (s == "error") return "error";
    if (s == "closed") return "closed";
    return "idle";
}

const char* reason_pt(const std::string& r) {
    if (r == "question") return "question";
    if (r == "keyword") return "keyword";
    if (r == "long_turn") return "long turn";
    if (r == "manual") return "manual";
    if (r == "chat") return "chat";
    if (r == "screenshot") return "screen";
    if (r == "recap") return "recap";
    if (r == "follow_up") return "follow-up";
    return r.c_str();
}

void write_text_file_atomic(const fs::path& path, const std::string& content) {
    fs::path tmp = path;
    tmp += ".tmp";
    {
        std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
        f << content;
    }
    std::error_code ec;
    fs::rename(tmp, path, ec);
    if (ec) {
        std::ofstream f(path, std::ios::binary | std::ios::trunc);
        f << content;
        fs::remove(tmp, ec);
    }
}

} // namespace

// ---------------------------------------------------------------------------

SessionStore::SessionStore(SessionStoreConfig cfg) : cfg_(std::move(cfg)) {}

SessionStore::~SessionStore() { close("destroyed"); }

std::int64_t SessionStore::now_ms() const {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() -
                                                                 cfg_.session_start).count();
}

fs::path SessionStore::markdown_path() const {
    fs::path p = jsonl_path_;
    p.replace_extension(".md");
    return p;
}

bool SessionStore::is_open() const {
    std::lock_guard<std::mutex> lk(mu_);
    return open_ && !closed_;
}

std::string SessionStore::make_session_id() {
    const std::tm tm = local_tm(std::time(nullptr));
    char buf[64];
    std::strftime(buf, sizeof(buf), "%Y-%m-%d_%H-%M-%S", &tm);
    std::random_device rd;
    char suffix[8];
    std::snprintf(suffix, sizeof(suffix), "%04x", static_cast<unsigned>(rd() & 0xFFFF));
    return std::string(buf) + "_" + suffix;
}

std::string SessionStore::iso8601_now() {
    const std::time_t now = std::time(nullptr);
    const std::tm tm = local_tm(now);
    char buf[64];
    std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S", &tm);
    return std::string(buf) + utc_offset(now);
}

bool SessionStore::open(const SessionMeta& meta, std::string* error) {
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (open_) return true;
    }
    std::error_code ec;
    fs::create_directories(cfg_.dir, ec);
    if (ec) {
        if (error) *error = "could not create " + cfg_.dir.string() + ": " + ec.message();
        return false;
    }
    const std::string id = meta.id.empty() ? make_session_id() : meta.id;
    jsonl_path_ = cfg_.dir / (id + ".jsonl");
    out_.open(jsonl_path_, std::ios::binary | std::ios::app);
    if (!out_) {
        if (error) *error = "could not open " + jsonl_path_.string();
        return false;
    }

    json::Writer w;
    w.begin_object()
        .field("type", "session_start")
        .field_int("t", 0)
        .field("id", id)
        .field("started_at", meta.started_at.empty() ? iso8601_now() : meta.started_at)
        .field("mode", meta.mode)
        .field("stt_model", meta.stt_model)
        .field("language", meta.language)
        .field("llm_model", meta.llm_model)
        .field("version", kVersion)
        .end_object();
    out_ << w.str() << '\n';
    out_.flush();
    lines_written_.fetch_add(1);

    {
        std::lock_guard<std::mutex> lk(mu_);
        open_ = true;
    }
    writer_ = std::thread([this] { writer_main(); });
    return true;
}

void SessionStore::enqueue(std::string line) {
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (!open_ || stop_) return;
        pending_.push_back(std::move(line));
    }
    cv_.notify_one();
}

void SessionStore::on_event(const EngineEvent& ev) {
    if (auto line = to_json_line(ev)) enqueue(std::move(*line));
}

void SessionStore::writer_main() {
    for (;;) {
        std::deque<std::string> batch;
        bool stopping = false;
        {
            std::unique_lock<std::mutex> lk(mu_);
            cv_.wait(lk, [&] { return stop_ || !pending_.empty(); });
            batch.swap(pending_);
            stopping = stop_;
        }
        for (const auto& line : batch) {
            out_ << line << '\n';
        }
        if (!batch.empty()) {
            out_.flush(); // hand data to the OS after every batch
            if (out_) lines_written_.fetch_add(batch.size());
            else {
                write_errors_.fetch_add(batch.size());
                out_.clear();
            }
        }
        if (stopping) break;
    }
}

void SessionStore::close(const std::string& reason) {
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (!open_ || closed_) return;
        closed_ = true;
        json::Writer w;
        w.begin_object()
            .field("type", "session_end")
            .field_int("t", now_ms())
            .field("reason", reason)
            .field("ended_at", iso8601_now())
            .end_object();
        pending_.push_back(std::move(w).str());
        stop_ = true;
    }
    cv_.notify_all();
    if (writer_.joinable()) writer_.join();
    out_.flush();
    out_.close();

    if (cfg_.export_markdown) {
        try {
            write_text_file_atomic(markdown_path(), render_markdown(load(jsonl_path_)));
        } catch (...) {
            write_errors_.fetch_add(1);
        }
    }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

std::optional<std::string> SessionStore::to_json_line(const EngineEvent& ev) {
    json::Writer w;
    bool keep = true;
    std::visit(
        [&](const auto& e) {
            using T = std::decay_t<decltype(e)>;
            if constexpr (std::is_same_v<T, TurnEvent>) {
                w.begin_object()
                    .field("type", "turn")
                    .field_int("t", e.turn.end_ms)
                    .field_int("t0", e.turn.start_ms)
                    .field("src", source_key(e.turn.source))
                    .key("seq").uint_value(e.turn.seq)
                    .field("text", e.turn.text)
                    .end_object();
            } else if constexpr (std::is_same_v<T, SuggestionDoneEvent>) {
                w.begin_object()
                    .field("type", "suggestion")
                    .field_int("t", e.t_ms)
                    .key("id").uint_value(e.id)
                    .field("status", to_string(e.status))
                    .field("reason", to_string(e.reason))
                    .field("trigger", e.trigger_text)
                    .field("text", e.text)
                    .field("model", e.model)
                    .field_int("ttft_ms", e.ttft_ms)
                    .field_int("total_ms", e.total_ms)
                    .field_int("visible_ms", e.visible_ms);
                if (!e.error.empty()) w.field("error", e.error);
                if (!e.interpreted_question.empty()) w.field("understood", e.interpreted_question);
                w.end_object();
            } else if constexpr (std::is_same_v<T, LaneStatusEvent>) {
                w.begin_object()
                    .field("type", "link")
                    .field_int("t", e.t_ms)
                    .field("src", source_key(e.status.source))
                    .field("state", to_string(e.status.state))
                    .field("detail", e.status.detail)
                    .key("reconnects").uint_value(e.status.reconnects)
                    .key("dropped_ms").uint_value(e.status.dropped_audio_ms)
                    .field_int("http", e.status.http_status)
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
                    .field_bool("paused", e.paused);
                if (e.source >= 0) w.field("src", source_key(static_cast<AudioSource>(e.source)));
                w.end_object();
            } else if constexpr (std::is_same_v<T, FeedbackEvent>) {
                w.begin_object()
                    .field("type", "feedback")
                    .field_int("t", e.t_ms)
                    .key("id").uint_value(e.id)
                    .field_int("vote", e.vote)
                    .end_object();
            } else {
                keep = false; // live text and token deltas are not persisted
            }
        },
        ev);
    if (!keep) return std::nullopt;
    return std::move(w).str();
}

std::vector<json::Value> SessionStore::load(const fs::path& file, std::size_t* bad_lines) {
    std::vector<json::Value> out;
    std::size_t bad = 0;
    std::ifstream f(file, std::ios::binary);
    std::string line;
    while (std::getline(f, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (text::trim(line).empty()) continue;
        auto v = json::Parser::parse(line);
        if (v && v->is_object()) out.push_back(std::move(*v));
        else ++bad; // e.g. a line torn by a crash mid-write
    }
    if (bad_lines) *bad_lines = bad;
    return out;
}

// ---------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------

std::string SessionStore::render_markdown(const std::vector<json::Value>& records) {
    std::string id, started_at, mode, stt, lang, llm, end_reason;
    std::int64_t duration = 0;
    std::size_t turns_voce = 0, turns_outros = 0, sugg_ok = 0, sugg_cancel = 0, sugg_fail = 0;
    std::uint64_t reconnects = 0;
    bool ended = false;

    std::string body;
    for (const auto& r : records) {
        const std::string& type = r["type"].as_string();
        const auto t = static_cast<std::int64_t>(r["t"].as_number(0));
        duration = std::max(duration, t);
        if (type == "session_start") {
            id = r["id"].as_string();
            started_at = r["started_at"].as_string();
            mode = r["mode"].as_string();
            stt = r["stt_model"].as_string();
            lang = r["language"].as_string();
            llm = r["llm_model"].as_string();
        } else if (type == "session_end") {
            ended = true;
            end_reason = r["reason"].as_string();
        } else if (type == "turn") {
            const std::string src = r["src"].as_string();
            (src == "voce" ? turns_voce : turns_outros)++;
            const auto t0 = static_cast<std::int64_t>(r["t0"].as_number(static_cast<double>(t)));
            body += "**[" + fmt_clock(t0) + "] " + source_label(src) + ":** " +
                    r["text"].as_string() + "\n\n";
        } else if (type == "suggestion") {
            const std::string status = r["status"].as_string();
            if (status == "completed") ++sugg_ok;
            else if (status == "cancelled") ++sugg_cancel;
            else ++sugg_fail;
            std::string head = "**Suggestion [" + fmt_clock(t) + "]**";
            const std::string reason = r["reason"].as_string();
            if (!reason.empty()) head += " · " + std::string(reason_pt(reason));
            const auto ttft = static_cast<std::int64_t>(r["ttft_ms"].as_number(-1));
            if (ttft >= 0) head += " · 1st token in " + fmt_seconds(ttft);
            const auto visible = static_cast<std::int64_t>(r["visible_ms"].as_number(-1));
            if (visible >= 0) head += " · on screen in " + fmt_seconds(visible);
            if (status == "cancelled") head += " · interrupted";
            if (status == "failed") head += " · failed";
            std::string block = head + "\n";
            const std::string& trigger = r["trigger"].as_string();
            if (!trigger.empty()) {
                const char* label = reason == "chat" ? "Chat" : (reason == "screenshot" ? "Screen" : "Question");
                block += std::string(label) + ": \"" + trigger + "\"\n";
                const std::string& understood = r["understood"].as_string();
                if (!understood.empty()) block += "Understood: \"" + understood + "\"\n";
                block += "\n";
            }
            const std::string& text = r["text"].as_string();
            if (!text.empty()) block += text + "\n";
            const std::string& err = r["error"].as_string();
            if (!err.empty()) block += "Error: " + err + "\n";
            body += quote_block(text::trim(block)) + "\n";
        } else if (type == "link") {
            const std::string state = r["state"].as_string();
            if (state == "reconnecting" || state == "error") {
                if (state == "reconnecting") ++reconnects;
                body += "*[" + fmt_clock(t) + "] Connection " + source_label(r["src"].as_string()) +
                        ": " + state_pt(state) + " (" + r["detail"].as_string() + ")*\n\n";
            }
        } else if (type == "pause") {
            const std::string& src = r["src"].as_string();
            std::string what = r["paused"].as_bool() ? "Capture paused" : "Capture resumed";
            if (!src.empty()) what += " (" + std::string(source_label(src)) + ")";
            body += std::string("*[") + fmt_clock(t) + "] " + what + "*\n\n";
        } else if (type == "feedback") {
            const auto vote = static_cast<int>(r["vote"].as_number(0));
            if (vote != 0) {
                body += std::string("*[") + fmt_clock(t) + "] Suggestion rating: " +
                        (vote > 0 ? "helpful" : "not helpful") + "*\n\n";
            }
        } else if (type == "notice") {
            const std::string& level = r["level"].as_string();
            if (level != "info") {
                body += "*[" + fmt_clock(t) + "] Notice: " + r["text"].as_string() + "*\n\n";
            }
        }
    }

    std::string title = started_at.size() >= 16 ? started_at.substr(0, 10) + " " + started_at.substr(11, 5)
                                                : (id.empty() ? std::string("undated") : id);
    std::string md = "# Session " + title + "\n\n";
    if (!started_at.empty()) md += "- Started: " + started_at + "\n";
    md += "- Duration: " + fmt_clock(duration) + "\n";
    if (!mode.empty()) md += "- Mode: " + std::string(mode == "demo" ? "demo" : "live") + "\n";
    if (!stt.empty()) md += "- STT: " + stt + (lang.empty() ? "" : " (" + lang + ")") + "\n";
    md += "- LLM: " + (llm.empty() ? std::string("off") : llm) + "\n";
    if (!ended) md += "- Ended: not recorded\n";
    else if (end_reason == "recovered") md += "- Ended: recovered after an unexpected exit\n";
    else md += "- Ended: " + end_reason + "\n";
    md += "\n## Timeline\n\n";
    md += body.empty() ? std::string("(no speech recorded)\n\n") : body;
    md += "## Summary\n\n";
    md += "- Turns: " + std::to_string(turns_voce + turns_outros) + " (You " +
          std::to_string(turns_voce) + ", Others " + std::to_string(turns_outros) + ")\n";
    md += "- Suggestions: " + std::to_string(sugg_ok + sugg_cancel + sugg_fail) + " (completed " +
          std::to_string(sugg_ok) + ", interrupted " + std::to_string(sugg_cancel) +
          ", failed " + std::to_string(sugg_fail) + ")\n";
    md += "- Reconnects: " + std::to_string(reconnects) + "\n";
    return md;
}

int SessionStore::recover_incomplete(const fs::path& dir, const fs::path& skip) {
    std::error_code ec;
    if (!fs::is_directory(dir, ec)) return 0;
    int recovered = 0;
    for (const auto& entry : fs::directory_iterator(dir, ec)) {
        if (!entry.is_regular_file(ec) || entry.path().extension() != ".jsonl") continue;
        if (!skip.empty() && fs::equivalent(entry.path(), skip, ec)) continue;
        auto records = load(entry.path());
        if (records.empty()) continue;
        fs::path md = entry.path();
        md.replace_extension(".md");
        const bool ended = records.back()["type"].as_string() == "session_end";
        if (ended && fs::exists(md, ec)) continue;
        if (!ended) {
            std::int64_t last_t = 0;
            for (const auto& r : records) {
                last_t = std::max(last_t, static_cast<std::int64_t>(r["t"].as_number(0)));
            }
            json::Writer w;
            w.begin_object()
                .field("type", "session_end")
                .field_int("t", last_t)
                .field("reason", "recovered")
                .field("ended_at", iso8601_now())
                .end_object();
            {
                // A torn last line (no '\n') must not swallow our record.
                std::ofstream f(entry.path(), std::ios::binary | std::ios::app);
                f << '\n' << w.str() << '\n';
            }
            records = load(entry.path());
            ++recovered;
        }
        try {
            write_text_file_atomic(md, render_markdown(records));
        } catch (...) {
        }
    }
    return recovered;
}

} // namespace rtai
