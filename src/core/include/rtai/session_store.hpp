// Pure core: session persistence.
//
// * Append-only JSONL, one record per line (turns, suggestions, link status,
//   notices, pauses). Interim transcripts and token deltas are NOT stored.
// * on_event() is a non-blocking sink: it serializes and enqueues; a dedicated
//   writer thread does all file I/O and flushes after every batch, so a crash
//   loses at most the batch in flight and a torn last line is skipped on load.
// * close() writes session_end and exports a readable Markdown next to it.
// * recover_incomplete() finalizes sessions that never got a session_end
//   (crash, power loss, killed console) on the next start.
#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include "rtai/copilot_events.hpp"
#include "rtai/json_min.hpp"

namespace rtai {

struct SessionMeta {
    std::string id;
    std::string started_at; // ISO-8601 local time with offset
    std::string mode;       // "live" | "demo"
    std::string stt_model;
    std::string language;
    std::string llm_model;
};

struct SessionStoreConfig {
    std::filesystem::path dir;
    bool export_markdown{true};
    std::chrono::steady_clock::time_point session_start{std::chrono::steady_clock::now()};
};

class SessionStore {
public:
    explicit SessionStore(SessionStoreConfig cfg);
    ~SessionStore();

    SessionStore(const SessionStore&) = delete;
    SessionStore& operator=(const SessionStore&) = delete;

    // Creates the directory and file, writes session_start, starts the writer.
    bool open(const SessionMeta& meta, std::string* error = nullptr);

    // Engine sink: thread-safe and non-blocking.
    void on_event(const EngineEvent& ev);

    // Writes session_end, flushes, stops the writer and exports Markdown.
    // Idempotent.
    void close(const std::string& reason = "normal");

    [[nodiscard]] bool is_open() const;
    [[nodiscard]] const std::filesystem::path& jsonl_path() const noexcept { return jsonl_path_; }
    [[nodiscard]] std::filesystem::path markdown_path() const;
    [[nodiscard]] std::uint64_t lines_written() const noexcept { return lines_written_.load(); }
    [[nodiscard]] std::uint64_t write_errors() const noexcept { return write_errors_.load(); }

    // ---- static helpers (also used by recovery and tests) ----
    static std::string make_session_id();  // e.g. 2026-10-20_21-50-03_7f3a
    static std::string iso8601_now();      // e.g. 2026-10-20T21:50:03-03:00
    static std::optional<std::string> to_json_line(const EngineEvent& ev);
    static std::vector<json::Value> load(const std::filesystem::path& file,
                                         std::size_t* bad_lines = nullptr);
    static std::string render_markdown(const std::vector<json::Value>& records);
    static int recover_incomplete(const std::filesystem::path& dir,
                                  const std::filesystem::path& skip = {});

private:
    void writer_main();
    void enqueue(std::string line);
    [[nodiscard]] std::int64_t now_ms() const;

    SessionStoreConfig cfg_;
    std::filesystem::path jsonl_path_;

    mutable std::mutex mu_;
    std::condition_variable cv_;
    std::deque<std::string> pending_; // guarded by mu_
    bool open_{false};                // guarded by mu_
    bool stop_{false};                // guarded by mu_
    bool closed_{false};              // guarded by mu_

    std::ofstream out_;               // writer thread only (after open)
    std::thread writer_;
    std::atomic<std::uint64_t> lines_written_{0};
    std::atomic<std::uint64_t> write_errors_{0};
};

} // namespace rtai
