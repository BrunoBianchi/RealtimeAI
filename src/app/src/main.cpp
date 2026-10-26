// RealTimeAI: visible, consented real-time meeting copilot.
//
// Modes:
//   (default)   Live: WASAPI mic ("Você") + loopback ("Outros") -> VAD ->
//               Deepgram Nova-3 (resilient WebSocket) -> copilot engine ->
//               OpenRouter suggestions -> overlay HUD + session files.
//   --demo      No hardware/network: scripted two-sided conversation +
//               scripted LLM, same engine/overlay/persistence. Good for UI checks.
//   --console   No overlay: transcript, suggestions and link status are
//               printed to the console (works with --demo too).
//   --no-save   Don't write session files.
//   --server    Headless engine for an external client: no overlay, JSON
//               lines on stdout (events) and stdin (commands), logs on
//               stderr. See rtai/server_protocol.hpp. Works with --demo.
//
// Configuration: %LOCALAPPDATA%\RealTimeAI\config.ini (created on first run,
// API keys encrypted with DPAPI). Environment variables (DEEPGRAM_API_KEY,
// OPENROUTER_API_KEY, RTAI_*) are used when a config field is empty.
//   --config             open config.ini in Notepad and exit
//   --config-file PATH   use another config file (or RTAI_CONFIG)
#include <windows.h>
#include <shlobj.h>

#include <atomic>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include <type_traits>
#include <variant>
#include <vector>

#include "rtai/async_log.hpp"
#include "rtai/config_win.hpp"
#include "rtai/settings.hpp"
#include "rtai/copilot_engine.hpp"
#include "rtai/deepgram_transport.hpp"
#include "rtai/demo_conversation.hpp"
#include "rtai/fake_transport.hpp"
#include "rtai/fake_vad.hpp"
#include "rtai/latency.hpp"
#include "rtai/line_channel.hpp"
#include "rtai/low_latency_win.hpp"
#include "rtai/overlay_window.hpp"
#include "rtai/qpc_clock.hpp"
#include "rtai/scripted_llm.hpp"
#include "rtai/server_protocol.hpp"
#include "rtai/session_store.hpp"
#include "rtai/source_pipeline.hpp"
#include "rtai/stdio_server.hpp"
#include "rtai/text_util.hpp"
#include "rtai/url.hpp"
#include "rtai/wasapi_capture.hpp"
#include "rtai/wav_file_source.hpp"
#include "rtai/winhttp_llm_client.hpp"
#include "rtai/web_search.hpp"
#include "rtai/mini_agent.hpp"
#include "rtai/session_studio_gui.hpp"
#include "rtai/transcript_export.hpp"

#include <fstream>

#ifdef RTAI_HAVE_ONNX
#include "rtai/silero_vad.hpp"
#endif
#ifdef RTAI_HAVE_EMBEDDINGS
#include "rtai/e5_embedder.hpp"
#endif
#include "rtai/dense_rag.hpp"

using namespace rtai;
namespace fs = std::filesystem;

namespace {

// ---------------------------------------------------------------------------
// Environment / paths
// ---------------------------------------------------------------------------

// Environment variables are read as UTF-16 and converted to UTF-8, so paths
// and values with accents survive (getenv would use the ANSI code page).
std::wstring wenv(const wchar_t* name) {
    const DWORD n = GetEnvironmentVariableW(name, nullptr, 0);
    if (n == 0) return {};
    std::wstring v(n, L'\0');
    const DWORD got = GetEnvironmentVariableW(name, v.data(), n);
    v.resize(got < n ? got : 0);
    return v;
}

std::string env(const char* name) {
    const std::wstring wname(name, name + std::char_traits<char>::length(name)); // ASCII names
    const std::wstring w = wenv(wname.c_str());
    if (w.empty()) return {};
    const int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0,
                                      nullptr, nullptr);
    std::string s(static_cast<std::size_t>(n > 0 ? n : 0), '\0');
    if (n > 0) WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr);
    return s;
}

std::string path_utf8(const fs::path& p) {
    const auto u = p.u8string();
    return std::string(u.begin(), u.end());
}

fs::path path_from_utf8(const std::string& s) {
    return fs::path(std::u8string(s.begin(), s.end()));
}

fs::path local_app_dir() {
    PWSTR path = nullptr;
    fs::path out;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &path)) && path) {
        out = fs::path(path) / L"RealTimeAI";
    } else {
        out = fs::temp_directory_path() / L"RealTimeAI";
    }
    if (path) CoTaskMemFree(path);
    return out;
}

std::string read_text_file(const fs::path& p, std::size_t max_bytes) {
    std::ifstream f(p, std::ios::binary);
    if (!f) return {};
    std::string s((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    if (s.size() >= 3 && static_cast<unsigned char>(s[0]) == 0xEF &&
        static_cast<unsigned char>(s[1]) == 0xBB && static_cast<unsigned char>(s[2]) == 0xBF) {
        s.erase(0, 3); // UTF-8 BOM
    }
    return text::sanitize_utf8(text::truncate_utf8(s, max_bytes));
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

struct AppConfig {
    bool demo{false};
    bool console{false};
    bool save{true};
    bool open_config_only{false};
    bool server{false};
    bool no_launcher{true};
    std::string agent_id;
    fs::path config_path;
    Settings st;                    // everything from config.ini / env
    std::string context_text;
    fs::path app_dir;
    fs::path exe_dir;
    fs::path session_dir;
    fs::path silero_model;
    std::vector<std::string> notes; // shown as notices after start
};

fs::path exe_directory() {
    std::wstring buf(MAX_PATH, L'\0');
    for (;;) {
        const DWORD n = GetModuleFileNameW(nullptr, buf.data(), static_cast<DWORD>(buf.size()));
        if (n < buf.size()) {
            buf.resize(n);
            break;
        }
        buf.resize(buf.size() * 2);
    }
    return fs::path(buf).parent_path();
}

AppConfig load_config(int argc, char** argv) {
    AppConfig c;
    std::string config_override;
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        if (a == "--demo") c.demo = true;
        else if (a == "--console" || a == "--no-overlay") c.console = true;
        else if (a == "--server") { c.server = true; }
        else if (a == "--no-save") c.save = false;
        else if (a == "--config") c.open_config_only = true;
        else if (a == "--no-launcher") c.no_launcher = true;
        else if (a == "--studio" || a == "--launcher") c.no_launcher = false;
        else if (a == "--agent" && i + 1 < argc) c.agent_id = argv[++i];
        else if (a == "--config-file" && i + 1 < argc) config_override = argv[++i];
    }
    if (c.agent_id.empty()) c.agent_id = env("RTAI_AGENT");
    c.app_dir = local_app_dir();
    c.exe_dir = exe_directory();
    if (config_override.empty()) config_override = env("RTAI_CONFIG");
    c.config_path = config_override.empty() ? c.app_dir / L"config.ini" : path_from_utf8(config_override);

    const EnvLookup env_lookup = [](const char* name) { return env(name); };
    std::string err;
    if (!wincfg::ensure_config(c.config_path, env_lookup, &err)) c.notes.push_back(err);
    const int protected_keys = wincfg::protect_plaintext_keys(c.config_path);
    if (protected_keys > 0) {
        c.notes.push_back(std::to_string(protected_keys) +
                          " API key(s) encrypted in config.ini for your Windows user.");
    }
    const ini::File file = ini::File::parse(wincfg::read_file(c.config_path));
    c.st = load_settings(file, env_lookup, [](const std::string& v) { return wincfg::unprotect(v); });
    for (const auto& w : c.st.warnings) c.notes.push_back("config.ini " + w);

    if (!c.st.save_sessions) c.save = false;
    c.session_dir = c.st.session_dir.empty() ? c.app_dir / L"sessions" : path_from_utf8(c.st.session_dir);
    c.silero_model = c.st.silero_model.empty() ? c.exe_dir / L"silero_vad.onnx" : path_from_utf8(c.st.silero_model);
    if (!c.st.context_file.empty()) {
        c.context_text = read_text_file(path_from_utf8(c.st.context_file), 16 * 1024);
        if (c.context_text.empty()) c.notes.push_back("arquivo_contexto is empty or was not found: " + c.st.context_file);
    }
    return c;
}

// ---------------------------------------------------------------------------
// Console output (async: never blocks engine threads)
// ---------------------------------------------------------------------------

std::string ts(std::int64_t ms) {
    char buf[32];
    const long long s = ms / 1000;
    std::snprintf(buf, sizeof(buf), "%02lld:%02lld", s / 60, s % 60);
    return buf;
}

void print_event(AsyncLog& log, const EngineEvent& ev, bool verbose) {
    std::visit(
        [&](const auto& e) {
            using T = std::decay_t<decltype(e)>;
            if constexpr (std::is_same_v<T, TurnEvent>) {
                log.line("[" + ts(e.turn.start_ms) + "] " + speaker_label(e.turn.source) + ": " + e.turn.text);
            } else if constexpr (std::is_same_v<T, TranscriptUpdateEvent>) {
                if (verbose && !e.turn_closed && !e.text.empty()) {
                    log.line(std::string("   (~") + speaker_label(e.source) + ") " + e.text);
                }
            } else if constexpr (std::is_same_v<T, SuggestionStartedEvent>) {
                log.line(std::string("   >> suggestion (") + label_pt(e.reason) + ") for: \"" + e.trigger_text + "\"");
            } else if constexpr (std::is_same_v<T, SuggestionDoneEvent>) {
                if (e.status == LlmStatus::Completed) {
                    std::string s = "   << ready";
                    if (e.ttft_ms >= 0) s += " (1st token " + std::to_string(e.ttft_ms) + " ms)";
                    if (e.visible_ms >= 0) s += " (on screen " + std::to_string(e.visible_ms) + " ms after the question)";
                    log.line(s);
                    if (verbose) log.line(e.text);
                } else if (e.status == LlmStatus::Failed) {
                    log.line("   << failed: " + e.error);
                }
            } else if constexpr (std::is_same_v<T, LaneStatusEvent>) {
                log.line(std::string("[Deepgram ") + speaker_label(e.status.source) + "] " +
                         to_string(e.status.state) + ": " + e.status.detail);
            } else if constexpr (std::is_same_v<T, NoticeEvent>) {
                log.line(std::string("[") + to_string(e.level) + "] " + e.text);
            } else if constexpr (std::is_same_v<T, PauseEvent>) {
                log.line(e.paused ? "[capture paused]" : "[capture resumed]");
            }
        },
        ev);
}

void print_metrics(AsyncLog& log, const MetricsRegistry& m, const std::string& lane) {
    log.line("--- latency (" + lane + ") ---");
    for (int i = 0; i < static_cast<int>(Stage::Count); ++i) {
        const auto s = static_cast<Stage>(i);
        const auto& st = m.stats(s);
        if (st.count == 0) continue;
        char buf[160];
        std::snprintf(buf, sizeof(buf), "  %s: avg=%.2fms min=%.2fms max=%.2fms n=%llu",
                      std::string(stage_name(s)).c_str(), m.avg_ms(s), m.to_ms(st.min_ticks),
                      m.to_ms(st.max_ticks), static_cast<unsigned long long>(st.count));
        log.line(buf);
    }
}

// ---------------------------------------------------------------------------
// Ctrl+C / console close
// ---------------------------------------------------------------------------

std::atomic<OverlayWindow*> g_overlay{nullptr};
HANDLE g_stop_event = nullptr;
HANDLE g_done_event = nullptr;

BOOL WINAPI on_console_ctrl(DWORD type) {
    switch (type) {
        case CTRL_C_EVENT:
        case CTRL_BREAK_EVENT:
        case CTRL_CLOSE_EVENT:
        case CTRL_LOGOFF_EVENT:
        case CTRL_SHUTDOWN_EVENT:
            if (auto* o = g_overlay.load()) o->request_close();
            if (g_stop_event) SetEvent(g_stop_event);
            if (type != CTRL_C_EVENT && type != CTRL_BREAK_EVENT && g_done_event) {
                // The process dies when we return: give main ~4.5 s to save.
                WaitForSingleObject(g_done_event, 4500);
            }
            return TRUE;
        default:
            return FALSE;
    }
}

void prepare_console() {
    SetConsoleOutputCP(CP_UTF8);
    // QuickEdit "selection" freezes console writes until a key is pressed.
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    DWORD mode = 0;
    if (in && GetConsoleMode(in, &mode)) {
        SetConsoleMode(in, (mode | ENABLE_EXTENDED_FLAGS) & ~static_cast<DWORD>(ENABLE_QUICK_EDIT_MODE));
    }
}

void enable_per_monitor_dpi() {
    using Fn = BOOL(WINAPI*)(DPI_AWARENESS_CONTEXT);
    if (HMODULE user32 = GetModuleHandleW(L"user32.dll")) {
        if (auto fn = reinterpret_cast<Fn>(reinterpret_cast<void*>(
                GetProcAddress(user32, "SetProcessDpiAwarenessContext")))) {
            fn(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
    }
}

// The demo feeds a synthetic tone, which Silero (correctly) rejects as
// non-speech, so the demo always uses the energy gate.
std::unique_ptr<IVadGate> make_vad(AsyncLog& log, const AppConfig& cfg, bool allow_silero = true) {
#ifdef RTAI_HAVE_ONNX
    std::error_code ec;
    if (allow_silero && cfg.st.vad == "silero") {
        if (fs::exists(cfg.silero_model, ec)) {
            try {
                // ORT takes the path as std::string (converted per char on Windows).
                auto gate = std::make_unique<SileroVadGate>(cfg.silero_model.string(), 512, 16000);
                log.line("VAD: Silero (" + path_utf8(cfg.silero_model) + ")");
                return gate;
            } catch (const std::exception& e) {
                log.line(std::string("Silero did not load (") + e.what() + "); using the energy VAD.");
            }
        } else {
            log.line("Silero model not found at " + path_utf8(cfg.silero_model) + "; using the energy VAD.");
        }
    }
#else
    (void)log;
    (void)allow_silero;
#endif
    auto fake = std::make_unique<FakeVadGate>(512);
    fake->set_energy_mode(static_cast<float>(cfg.st.energy_threshold));
    return fake;
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

struct Lane {
    std::string name;
    std::unique_ptr<IAudioCaptureSource> capture;
    std::unique_ptr<IVadGate> vad;
    std::unique_ptr<ITranscriptionTransport> transport;
    std::unique_ptr<MetricsRegistry> metrics;
    std::unique_ptr<SourcePipeline> pipe;
    bool started{false};
};

DeepgramStreamConfig deepgram_config(const AppConfig& cfg, AudioSource src) {
    DeepgramStreamConfig dc;
    dc.api_key = cfg.st.deepgram_key;
    dc.source = src;
    dc.params.language = cfg.st.language;
    dc.params.keyterms = cfg.st.keyterms;
    if (dc.params.keyterms.size() > 50) dc.params.keyterms.resize(50); // keep the URL/keyterm budget sane
    dc.params.endpointing_ms = cfg.st.endpointing_ms; // 0 => endpointing=false
    const bool multi = text::fold(text::trim(cfg.st.language)) == "multi";
    if (multi) {
        // Deepgram recommends endpointing=100 for code-switching. The old
        // template default (300) is treated as "not tuned"; any other value
        // the user wrote is kept.
        if (cfg.st.endpointing_ms == 300) dc.params.endpointing_ms = 100;
        dc.params.language_hints = cfg.st.language_hints;
    }
    dc.params.no_delay = true; // finals are never held back for number formatting
    return dc;
}

// ---------------------------------------------------------------------------
// --server helpers
// ---------------------------------------------------------------------------

server::Hello make_hello(const AppConfig& cfg, bool llm_on, const std::string& model, bool transcription_mode = false) {
    server::Hello h;
    h.mode = transcription_mode;
    h.app_mode = cfg.demo ? "demo" : "live";
    h.llm = llm_on;
    h.model = model;
    h.language = cfg.st.language;
    h.auto_suggest = cfg.st.auto_suggest;
    h.mic = cfg.st.mic_enabled;
    h.system_audio = cfg.st.loopback_enabled;
    h.has_deepgram_key = !cfg.st.deepgram_key.empty();
    h.has_llm_key = !cfg.st.llm_key.empty();
    h.llm_url = cfg.st.llm_url;
    h.config_path = path_utf8(cfg.config_path);
    return h;
}

// set_config / open_config are handled the same way in setup and live mode.
// Returns true when the config changed (the UI restarts the engine).
bool handle_config_command(const AppConfig& cfg, const server::Command& c, LineChannel& out, AsyncLog& log) {
    if (c.kind == server::Command::Kind::OpenConfig) {
        wincfg::open_in_notepad(cfg.config_path);
        return false;
    }
    std::vector<wincfg::UiValue> values;
    for (const auto& v : c.values) values.push_back({v.section, v.key, v.value});
    std::string err;
    if (wincfg::apply_values(cfg.config_path, values, &err)) {
        log.line("config.ini updated by the UI (" + std::to_string(values.size()) + " value(s))");
        out.send(server::encode_simple("config_saved", "path", path_utf8(cfg.config_path)));
        return true;
    }
    log.line("set_config refused: " + err);
    json::Writer w;
    w.begin_object().field("type", "config_error").field("error", err).end_object();
    out.send(std::move(w).str());
    return false;
}

bool open_settings_popup(const fs::path& path) {
    return gui::open_settings_gui(path, [](const char* name) { return env(name); });
}

// ---------------------------------------------------------------------------
// Hybrid RAG (BM25 + local multilingual-e5 embeddings)
// ---------------------------------------------------------------------------
// Everything heavy (250k-piece vocabulary, ONNX session, passage index) loads
// on a background thread; retrieval runs BM25-only until it is ready, and
// afterwards each question waits at most [rag] orcamento_ms for its vector.
struct HybridRagLoader {
    std::shared_ptr<DeferredDenseSearch> slot = std::make_shared<DeferredDenseSearch>();
    std::thread thread;
    ~HybridRagLoader() {
        if (thread.joinable()) thread.join();
    }
};

// Remote kill switch: flags-active.json written by the dashboard
// ({"flags": {"hybrid_rag": false}}). Missing file or flag = allowed.
bool hybrid_flag_allows(const fs::path& app_dir) {
    std::error_code ec;
    const fs::path p = app_dir / L"flags-active.json";
    if (!fs::exists(p, ec)) return true;
    const auto doc = json::Parser::parse(read_text_file(p, 256 * 1024));
    if (!doc) return true;
    const auto& v = (*doc)["flags"]["hybrid_rag"];
    return !(v.is_bool() && !v.as_bool(true));
}

std::unique_ptr<HybridRagLoader> start_hybrid_rag(AsyncLog& log, const AppConfig& cfg, MiniAgentRag& rag) {
    if (!cfg.st.rag_hybrid || rag.chunk_count() == 0) return nullptr;
    if (!hybrid_flag_allows(cfg.app_dir)) {
        log.line("Hybrid RAG: off by feature flag (BM25 only).");
        return nullptr;
    }
#ifndef RTAI_HAVE_EMBEDDINGS
    (void)log; (void)cfg; (void)rag;
    return nullptr;
#else
    const fs::path dir = cfg.st.embed_model_dir.empty()
                             ? cfg.app_dir / L"models" / L"multilingual-e5-small"
                             : path_from_utf8(cfg.st.embed_model_dir);
    std::error_code ec;
    fs::path model = dir / L"model_quantized.onnx";
    if (!fs::exists(model, ec)) model = dir / L"onnx" / L"model_quantized.onnx";
    const fs::path tokenizer = dir / L"tokenizer.json";
    if (!fs::exists(model, ec) || !fs::exists(tokenizer, ec)) {
        log.line("Hybrid RAG: embedding model not found in " + path_utf8(dir) +
                 " (run scripts\\windows\\download-embeddings-model.bat). Using BM25 only.");
        return nullptr;
    }
#ifdef _WIN32
    // onnxruntime.dll is delay-loaded: load OUR copy (never the older one in
    // System32) and stay BM25-only if it is missing.
    if (!LoadLibraryExW((cfg.exe_dir / L"onnxruntime.dll").c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH)) {
        log.line("Hybrid RAG: onnxruntime.dll not found next to the program. Using BM25 only.");
        return nullptr;
    }
#endif
    auto loader = std::make_unique<HybridRagLoader>();
    MiniAgentRag::DenseOptions dopts;
    dopts.min_score = static_cast<float>(cfg.st.embed_min_score);
    rag.attach_dense(loader->slot, dopts);

    OnnxE5Embedder::Options eo;
    eo.model_path = path_utf8(model);
    eo.tokenizer_path = path_utf8(tokenizer);
    eo.threads = cfg.st.embed_threads;
    EmbeddingDenseSearch::Options so;
    so.budget = std::chrono::milliseconds(cfg.st.embed_budget_ms);
    std::string id = rag.profile().id.empty() ? MiniAgentProfile::slugify(rag.profile().name) : rag.profile().id;
    if (id.empty()) id = "default";
    const fs::path cache_file = cfg.app_dir / L"models" / L"cache" / path_from_utf8(id + ".emb");
    std::vector<std::string> passages = rag.dense_passages();
    std::shared_ptr<DeferredDenseSearch> slot = loader->slot;

    loader->thread = std::thread([&log, eo, so, cache_file, passages = std::move(passages), slot]() mutable {
        const auto t0 = std::chrono::steady_clock::now();
        std::string err;
        std::shared_ptr<IEmbedder> emb = OnnxE5Embedder::create(eo, &err);
        if (!emb) {
            log.line("Hybrid RAG: could not load the embedding model (" + err + "). Using BM25 only.");
            return;
        }
        auto search = std::make_shared<EmbeddingDenseSearch>(emb, so);
        auto load = [cache_file](const std::string&) -> std::optional<std::string> {
            std::error_code e;
            if (!fs::exists(cache_file, e)) return std::nullopt;
            return read_text_file(cache_file, 64 * 1024 * 1024);
        };
        auto store = [cache_file](const std::string&, const std::string& bytes) {
            std::error_code e;
            fs::create_directories(cache_file.parent_path(), e);
            wincfg::write_file_atomic(cache_file, bytes);
        };
        search->build_index(std::move(passages), load, store);
        // Waiting here is off the live path: this is the loader thread.
        if (!search->wait_ready(std::chrono::minutes(5))) {
            log.line("Hybrid RAG: the passage index did not finish. Using BM25 only.");
            return;
        }
        slot->set(search);
        const auto st = search->stats();
        const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        char buf[160];
        std::snprintf(buf, sizeof buf, "Hybrid RAG: ready (%zu excerpts, %s, %.0f ms).", st.indexed,
                      st.loaded_from_cache ? "index from cache" : "index built", ms);
        log.line(buf);
    });
    return loader;
#endif
}

// No Deepgram key yet: tell the UI and only accept configuration commands.
int run_setup_mode(const AppConfig& cfg, LineChannel& out, AsyncLog& log) {
    server::Hello h = make_hello(cfg, false, cfg.st.model);
    h.ready = false;
    h.needs = "deepgram_key";
    out.send(server::encode_hello(h));
    for (const auto& n : cfg.notes) {
        json::Writer w;
        w.begin_object().field("type", "notice").field("level", "info").field("text", n).end_object();
        out.send(std::move(w).str());
    }
    stdio::StdinReader reader(
        [&](std::string_view line) {
            std::string err;
            auto c = server::parse_command(line, &err);
            if (!c) {
                log.line("invalid command: " + err);
                return;
            }
            if (c->kind == server::Command::Kind::SetConfig || c->kind == server::Command::Kind::OpenConfig) {
                handle_config_command(cfg, *c, out, log);
            } else if (c->kind == server::Command::Kind::Quit) {
                SetEvent(g_stop_event);
            }
        },
        [] { SetEvent(g_stop_event); });
    reader.start();
    log.line("Setup mode: the Deepgram key is missing (" + path_utf8(cfg.config_path) + ")");
    WaitForSingleObject(g_stop_event, INFINITE);
    reader.stop();
    out.send(server::encode_bye("", ""));
    out.stop();
    log.stop();
    return 0;
}

} // namespace

// ===========================================================================

// Log file next to the sessions: %LOCALAPPDATA%\RealTimeAI\logs\rtai.log
// (started over when it passes 5 MB).
std::FILE* open_log_file(const fs::path& app_dir) {
    std::error_code ec;
    const fs::path dir = app_dir / L"logs";
    fs::create_directories(dir, ec);
    const fs::path p = dir / L"rtai.log";
    const bool big = fs::exists(p, ec) && fs::file_size(p, ec) > 5u * 1024 * 1024;
    std::FILE* f = _wfopen(p.c_str(), big ? L"wb" : L"ab");
    if (f) {
        SYSTEMTIME st{};
        GetLocalTime(&st);
        std::fprintf(f, "\n=== %04u-%02u-%02u %02u:%02u:%02u ===\n", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute,
                     st.wSecond);
    }
    return f;
}

// When the exe was opened by itself (double click, `start`), the console is
// ours alone: hide it while the overlay is up. A console shared with a
// terminal stays visible.
void hide_own_console() {
    DWORD pids[4];
    if (GetConsoleProcessList(pids, 4) == 1) {
        if (HWND c = GetConsoleWindow()) ShowWindow(c, SW_HIDE);
    }
}

int run_app(AppConfig cfg) {
    AsyncLog log(cfg.server ? stderr : stdout);
    std::FILE* log_file = open_log_file(cfg.app_dir);
    if (log_file) log.set_tee(log_file);
    // --server: protocol lines only on stdout, written by one thread.
    std::unique_ptr<LineChannel> out;
    if (cfg.server) {
        out = std::make_unique<LineChannel>([](std::string_view s) { return stdio::write_stdout(s); });
    }
    QpcClock clock;

    if (cfg.open_config_only) {
        enable_per_monitor_dpi();
        open_settings_popup(cfg.config_path);
        std::cout << "Config: " << path_utf8(cfg.config_path) << "\n";
        return 0;
    }

    // ---------------- Pre-Session Studio & Mini-Agent Loading ----------------
    std::shared_ptr<MiniAgentRag> agent_rag;
    fs::path loaded_agent_path;
    if (!cfg.console && !cfg.server && !cfg.no_launcher) {
        enable_per_monitor_dpi();
        const EnvLookup env_lookup = [](const char* name) { return env(name); };
        auto launch = gui::open_session_studio_gui(cfg.app_dir, cfg.config_path, cfg.st, env_lookup, cfg.demo);
        if (!launch.proceed) {
            return 0;
        }
        cfg.demo = launch.run_demo;
        if (!launch.agent.empty()) {
            agent_rag = std::make_shared<MiniAgentRag>(launch.agent);
        }
    } else {
        // Load the Mini-Agent configured by the Electron Dashboard (via --agent <id>,
        // config.ini [sessao] ultimo_agente, or the newest .json in %LOCALAPPDATA%\RealTimeAI\agents).
        const fs::path agents_dir = cfg.app_dir / L"agents";
        std::string target_id = !cfg.agent_id.empty() ? cfg.agent_id : cfg.st.last_agent;
        fs::path agent_path;
        std::error_code ec;
        if (!target_id.empty()) {
            const fs::path candidate = agents_dir / path_from_utf8(target_id + ".json");
            if (fs::exists(candidate, ec)) agent_path = candidate;
        }
        if (agent_path.empty() && fs::exists(agents_dir, ec)) {
            fs::file_time_type newest_time{};
            bool has_newest = false;
            for (const auto& entry : fs::directory_iterator(agents_dir, ec)) {
                if (entry.is_regular_file() && entry.path().extension() == L".json") {
                    const auto wt = entry.last_write_time(ec);
                    if (!has_newest || wt > newest_time) {
                        newest_time = wt;
                        agent_path = entry.path();
                        has_newest = true;
                    }
                }
            }
        }
        if (!agent_path.empty()) {
            loaded_agent_path = agent_path;
            const std::string raw = read_text_file(agent_path, 16 * 1024 * 1024);
            if (auto prof = MiniAgentProfile::from_json(raw); prof && !prof->empty()) {
                // If this agent was created without re-attaching the candidate's base
                // Resume/Project files, automatically inherit them from the newest agent
                // in %LOCALAPPDATA%\RealTimeAI\agents that has uploaded documents so the
                // AI NEVER lacks the candidate's real RAG context during an interview.
                if (prof->documents.empty() && fs::exists(agents_dir, ec)) {
                    fs::file_time_type best_time{};
                    bool found_docs = false;
                    std::vector<RagDocument> inherited_docs;
                    for (const auto& entry : fs::directory_iterator(agents_dir, ec)) {
                        if (!entry.is_regular_file() || entry.path().extension() != L".json") continue;
                        const std::string other_raw = read_text_file(entry.path(), 16 * 1024 * 1024);
                        if (auto other_prof = MiniAgentProfile::from_json(other_raw);
                            other_prof && !other_prof->documents.empty()) {
                            // Only the candidate's own files (résumé, projects) travel
                            // between goals: another company's culture deck or job
                            // description would be told as "my experience" here.
                            const MiniAgentRag other_rag(*other_prof);
                            std::vector<RagDocument> mine;
                            for (std::size_t di = 0; di < other_prof->documents.size(); ++di) {
                                if (other_rag.document_kind(di) == RagDocKind::Candidate) {
                                    mine.push_back(other_prof->documents[di]);
                                }
                            }
                            const auto wt = entry.last_write_time(ec);
                            if (!mine.empty() && (!found_docs || wt > best_time)) {
                                best_time = wt;
                                inherited_docs = std::move(mine);
                                found_docs = true;
                            }
                        }
                    }
                    if (!inherited_docs.empty()) {
                        prof->documents = std::move(inherited_docs);
                        wincfg::write_file_atomic(agent_path, prof->to_json());
                    }
                }
                agent_rag = std::make_shared<MiniAgentRag>(*prof);
                std::string label = prof->name.empty() ? prof->company : prof->name;
                if (!prof->company.empty() && prof->name != prof->company) {
                    label += " (" + prof->company + ")";
                }
                cfg.notes.push_back("Active goal: " + label + " · " +
                                    std::to_string(agent_rag->profile().documents.size()) + " doc(s) · " +
                                    std::to_string(agent_rag->chunk_count()) + " RAG chunks + Mini-Compact");
                if (!prof->next_interview_date.empty()) {
                    std::string sched = "Next interview: " + prof->next_interview_date;
                    if (!prof->next_interview_time.empty()) sched += " at " + prof->next_interview_time;
                    cfg.notes.push_back(sched);
                }
                if (!prof->next_focus.empty()) {
                    cfg.notes.push_back("Next Focus: " + prof->next_focus);
                }
                if (!prof->playbook_name.empty()) {
                    cfg.notes.push_back("Playbook: " + prof->playbook_name + " (" + prof->playbook_answer_length + ", " + prof->playbook_behavioral_structure + ")");
                }
            }
        }
    }
    if (agent_rag) {
        for (const auto& kt : agent_rag->extract_keyterms(30)) {
            if (std::find(cfg.st.keyterms.begin(), cfg.st.keyterms.end(), kt) == cfg.st.keyterms.end()) {
                cfg.st.keyterms.push_back(kt);
            }
        }
    }

    std::unique_ptr<HybridRagLoader> hybrid_rag;
    if (agent_rag && !cfg.demo) hybrid_rag = start_hybrid_rag(log, cfg, *agent_rag);

    const auto session_start = std::chrono::steady_clock::now();

    if (!cfg.demo && cfg.st.deepgram_key.empty() && out) {
        return run_setup_mode(cfg, *out, log);
    }
    if (!cfg.demo && cfg.st.deepgram_key.empty()) {
        enable_per_monitor_dpi();
        if (open_settings_popup(cfg.config_path)) {
            const EnvLookup env_lookup = [](const char* name) { return env(name); };
            const ini::File file = ini::File::parse(wincfg::read_file(cfg.config_path));
            cfg.st = load_settings(file, env_lookup, [](const std::string& v) { return wincfg::unprotect(v); });
        }
        if (cfg.st.deepgram_key.empty()) {
            return 2;
        }
    }

    // ---------------- LLM ----------------
    std::shared_ptr<ILlmClient> llm;
    std::shared_ptr<WinHttpLlmClient> openrouter;
    std::shared_ptr<WinHttpLlmClient> openrouter_sol_client;
    if (cfg.demo) {
        ScriptedLlmClient::Options so;
        so.reply_for = [agent_rag](const LlmRequest& r) {
            std::string base = demo_reply_for(r);
            if (agent_rag && !base.empty()) {
                const auto& p = agent_rag->profile();
                std::string header;
                if (!p.company.empty() || !p.role.empty()) {
                    header = "**[Active context: " + (p.company.empty() ? p.name : p.company) +
                             (p.role.empty() ? "" : " · " + p.role) + "]**\n";
                }
                return header + base;
            }
            return base;
        };
        llm = std::make_shared<ScriptedLlmClient>(so);
    } else if (!cfg.st.cerebras_key.empty() || !cfg.st.llm_key.empty()) {
        const bool model_is_openrouter = cfg.st.model.find('/') != std::string::npos;
        const bool use_cerebras = !cfg.st.cerebras_key.empty() &&
                                  (!model_is_openrouter || cfg.st.llm_key.empty());
        const std::string effective_llm_url = use_cerebras
            ? "https://api.cerebras.ai/v1/chat/completions"
            : (model_is_openrouter || cfg.st.llm_url.find("cerebras.ai") != std::string::npos
                   ? "https://openrouter.ai/api/v1/chat/completions"
                   : cfg.st.llm_url);
        const ParsedUrl url = parse_url(effective_llm_url);
        if (!url.ok) {
            std::cerr << "[llm] invalid url in config.ini: " << effective_llm_url << "\n";
            return 2;
        }
        WinHttpLlmOptions lo;
        lo.api_key = use_cerebras ? cfg.st.cerebras_key : cfg.st.llm_key;
        lo.host = url.host;
        lo.port = url.port;
        lo.secure = url.secure;
        lo.path = url.path;
        if (use_cerebras) {
            lo.primary = LlmEndpoint{"api.cerebras.ai", "/v1/chat/completions",
                                     cfg.st.model == "llama-3.3-70b" ? "qwen-3.8-27b" : cfg.st.model,
                                     cfg.st.cerebras_key};
            const std::string groq_key = !cfg.st.groq_key.empty() ? cfg.st.groq_key : env("GROQ_API_KEY");
            if (!groq_key.empty()) {
                lo.fallback = LlmEndpoint{"api.groq.com", "/openai/v1/chat/completions",
                                          "llama-3.3-70b-versatile", groq_key};
            } else {
                lo.fallback = LlmEndpoint{};
            }
        } else {
            // An explicitly configured custom/OpenRouter URL uses the
            // single-host path. If a Cerebras key is also present, configure it
            // as the fallback so that any OpenRouter outage automatically recovers!
            lo.primary = LlmEndpoint{};
            if (!cfg.st.cerebras_key.empty()) {
                lo.fallback = LlmEndpoint{"api.cerebras.ai", "/v1/chat/completions",
                                          "qwen-3.8-27b", cfg.st.cerebras_key};
            } else {
                lo.fallback = LlmEndpoint{};
            }
        }
        openrouter = std::make_shared<WinHttpLlmClient>(lo);
        llm = openrouter;

        // Dedicated OpenRouter client for lightweight AI Analysis, Deep Reading & Compaction
        // using model "qwen/qwen3.6-flash" at "none" effort for zero latency & no token waste.
        const std::string or_key = !cfg.st.llm_key.empty() ? cfg.st.llm_key : env("OPENROUTER_API_KEY");
        if (!or_key.empty()) {
            WinHttpLlmOptions sol_opts;
            sol_opts.api_key = or_key;
            sol_opts.host = "openrouter.ai";
            sol_opts.port = 443;
            sol_opts.secure = true;
            sol_opts.path = "/api/v1/chat/completions";
            sol_opts.primary = LlmEndpoint{};
            sol_opts.fallback = LlmEndpoint{};
            sol_opts.keep_alive = false;           // background work, not the live path
            sol_opts.openrouter_provider_sort.clear();
            openrouter_sol_client = std::make_shared<WinHttpLlmClient>(sol_opts);
        } else {
            openrouter_sol_client = openrouter;
        }
    }

    // ---------------- copilot engine ----------------
    CopilotConfig cc;
    cc.session_start = session_start;
    cc.model = cfg.st.model;
    cc.reasoning_effort = (cfg.st.reasoning.empty() || cfg.st.reasoning == "minimal") ? "none" : cfg.st.reasoning;
    cc.max_tokens = std::max(cfg.st.max_tokens, 1500);
    cc.web_search = nullptr;
    cc.allow_speculative = true;
    cc.temperature = cfg.st.temperature;
    cc.prompt.user_context = cfg.context_text;
    if (agent_rag) {
        // Stable profile -> system message (cacheable prefix); per-question
        // retrieval -> user message. Both are in-memory and take well under
        // a millisecond, so they never delay the request.
        cc.prompt.session_profile = [agent_rag, base_ctx = cfg.context_text]() {
            return agent_rag->session_profile_block(base_ctx);
        };
        cc.prompt.rag_retrieve = [agent_rag, &log](std::string_view q, std::string_view recent) {
            MiniAgentRag::RetrievalTrace tr;
            std::string block = agent_rag->retrieve_block(q, recent, 3200, &tr);
            if (agent_rag->has_dense()) {
                char buf[160];
                std::snprintf(buf, sizeof buf, "   RAG: %s, %zu excerpt(s), %zu by meaning only, %.2f ms",
                              tr.hybrid ? "hybrid" : "bm25", tr.chunks, tr.dense_only, tr.ms);
                log.line(buf);
            }
            return block;
        };
    }
    if (cfg.st.turn_boundary_grace_ms >= 0) cc.turns.boundary_grace_ms = cfg.st.turn_boundary_grace_ms;
    if (cfg.st.turn_stale_ms >= 0) cc.turns.stale_ms = cfg.st.turn_stale_ms;
    if (cfg.st.turn_speculative_pause_ms >= 0) cc.turns.speculative_pause_ms = cfg.st.turn_speculative_pause_ms;
    cc.decision.auto_enabled = cfg.st.auto_suggest;
    cc.decision.cooldown_ms = static_cast<std::int64_t>(cfg.st.cooldown_s) * 1000;
    if (!cfg.st.keywords.empty()) {
        cc.decision.keywords = cfg.st.keywords;
    } else if (agent_rag) {
        // Interview goal: the built-in trigger words are for sales calls
        // ("prazo", "segurança", "valor"...). In an interview they fired on the
        // interviewer's statements and produced a STAR answer to nothing.
        // Questions (including "Fale sobre...", "Conte...") still trigger.
        cc.decision.keywords.clear();
    }
    auto engine = std::make_shared<CopilotEngine>(cc, llm);

    // Deep-Reading & Compaction pass ("Leitura Aprofundada & Mini-Compact"):
    // analyzes and compacts all RAG documents, company dossier, and instructions
    // in the background without adding any latency to the live hot path. It
    // runs only when the materials changed since the stored compact was made
    // (fingerprint), so a session with the same goal starts with it ready.
    std::shared_ptr<ILlmCall> deep_compact_call;
    auto deep_compact_buf = std::make_shared<std::string>();
    if (agent_rag && openrouter_sol_client && !cfg.demo &&
        (!agent_rag->profile().documents.empty() || !agent_rag->profile().company_dossier.empty()) &&
        !agent_rag->mini_compact_is_current()) {
        LlmRequest dreq;
        dreq.model = MiniAgentProfile::kCompactAnalysisModel; // "qwen/qwen3.6-flash"
        dreq.max_tokens = 1400;
        dreq.temperature = 0.10;
        dreq.reasoning_effort = MiniAgentProfile::kCompactAnalysisEffort; // "none"
        dreq.messages = {
            ChatMessage{"system",
                        "Você é um analisador de alta fidelidade que prepara um candidato para uma entrevista ao vivo. "
                        "Extraia e compacte EXCLUSIVAMENTE fatos presentes nos materiais, sem jamais inventar "
                        "tecnologias, empresas, métricas ou projetos, e sem confundir material da empresa com "
                        "experiência do candidato.",
                        {}},
            ChatMessage{"user", agent_rag->build_deep_reading_prompt(), {}}
        };
        std::weak_ptr<CopilotEngine> weak_eng = engine;
        LlmCallbacks dcb;
        dcb.on_delta = [deep_compact_buf](std::string_view d) {
            deep_compact_buf->append(d);
        };
        dcb.on_done = [agent_rag, deep_compact_buf, weak_eng, loaded_agent_path](const LlmResult& r) {
            const std::string trimmed_buf = text::trim(*deep_compact_buf);
            if (r.status == LlmStatus::Completed && !trimmed_buf.empty()) {
                // The model's compact replaces the local one (the playbook and
                // the anti-hallucination rules are added by session_profile_block).
                const std::string final_compact = text::truncate_utf8(trimmed_buf, 3600);
                agent_rag->set_mini_compact(final_compact);
                if (!loaded_agent_path.empty()) {
                    MiniAgentProfile updated_prof = agent_rag->profile();
                    updated_prof.mini_compact = final_compact;
                    updated_prof.mini_compact_fingerprint = agent_rag->source_fingerprint();
                    wincfg::write_file_atomic(loaded_agent_path, updated_prof.to_json());
                }
                if (auto eng = weak_eng.lock()) {
                    eng->notify(NoticeLevel::Info,
                                "Mini-Compact updated from your materials (" +
                                std::string(MiniAgentProfile::kCompactAnalysisModel) + ").");
                }
            } else {
                std::string err = r.error.empty() ? (r.status == LlmStatus::Cancelled ? "cancelled" : "empty response") : r.error;
                if (auto eng = weak_eng.lock()) {
                    eng->notify(NoticeLevel::Warning,
                                "Deep Mini-Compact unavailable (model '" +
                                std::string(MiniAgentProfile::kCompactAnalysisModel) +
                                "' failed: " + err + "); using the local summary.");
                }
            }
        };
        try {
            deep_compact_call = openrouter_sol_client->start(std::move(dreq), std::move(dcb));
        } catch (...) {}
    }

    // ---------------- session persistence ----------------
    std::unique_ptr<SessionStore> store;
    if (cfg.save) {
        const int recovered = SessionStore::recover_incomplete(cfg.session_dir);
        if (recovered > 0) {
            log.line("Previous sessions recovered: " + std::to_string(recovered));
        }
        SessionStoreConfig sc;
        sc.dir = cfg.session_dir;
        sc.session_start = session_start;
        store = std::make_unique<SessionStore>(sc);
        SessionMeta meta;
        meta.mode = cfg.demo ? "demo" : "live";
        meta.stt_model = "nova-3";
        meta.language = cfg.st.language;
        meta.llm_model = llm ? cc.model : std::string();
        std::string err;
        if (store->open(meta, &err)) {
            SessionStore* s = store.get();
            engine->add_sink([s](const EngineEvent& e) { s->on_event(e); });
        } else {
            log.line("Session saving disabled: " + err);
            store.reset();
        }
    }

    engine->add_sink([&log, verbose = cfg.console && !cfg.server](const EngineEvent& e) {
        print_event(log, e, verbose);
    });
    if (out) {
        LineChannel* o = out.get();
        engine->add_sink([o](const EngineEvent& e) { o->send(server::encode_event(e)); });
    }

    // ---------------- transcription-only mode export and summary ----------------
    auto summary_pending = std::make_shared<std::atomic<bool>>(engine->transcription_only());
    auto summary_in_flight = std::make_shared<std::atomic<bool>>(false);
    auto summary_mu = std::make_shared<std::mutex>();
    auto summary_cv = std::make_shared<std::condition_variable>();

    auto write_transcript_file = [](const fs::path& path, const std::string& content, std::string* error = nullptr) -> bool {
        std::error_code ec;
        fs::create_directories(path.parent_path(), ec);
        if (ec) {
            if (error) *error = ec.message();
            return false;
        }
        std::ofstream ofs(path, std::ios::binary);
        if (!ofs) {
            if (error) *error = "could not open the file for writing";
            return false;
        }
        ofs.write(content.data(), static_cast<std::streamsize>(content.size()));
        if (!ofs) {
            if (error) *error = "could not write the file";
            return false;
        }
        return true;
    };

    auto trigger_export_and_summary = [&](bool wait_for_completion) {
        SessionTranscript t = engine->session_transcript();
        if (t.empty()) {
            log.line("Transcription-only mode ended with no speech recorded.");
            return;
        }

        const std::string sid = SessionStore::make_session_id();
        const fs::path export_path = cfg.session_dir / ("transcricao_" + sid + ".txt");
        const std::string content = build_transcript_export(t, TranscriptExportFormat::Txt);

        std::string write_err;
        const bool written = write_transcript_file(export_path, content, &write_err);
        const std::string export_str = written ? path_utf8(export_path) : "";

        if (!written) {
            log.line("Could not export the transcript (" + write_err + "); kept in memory.");
            engine->notify(NoticeLevel::Error, "Could not save the transcript file. The transcript is kept in memory.");
        } else {
            log.line("Transcript exported: " + export_str);
        }

        if (!openrouter_sol_client || cfg.demo) {
            if (out) out->send(server::encode_summary(false, "", export_str));
            if (written) {
                engine->notify(NoticeLevel::Info, "Transcript exported to: " + export_str);
            }
            return;
        }

        summary_in_flight->store(true);
        auto accumulated_text = std::make_shared<std::string>();

        LlmRequest sreq;
        sreq.model = "qwen/qwen3.6-flash";
        sreq.messages = build_summary_request(t);
        sreq.max_tokens = 900;
        sreq.temperature = 0.3;
        sreq.reasoning_effort = "minimal";

        LlmCallbacks scb;
        scb.on_delta = [accumulated_text](std::string_view d) {
            accumulated_text->append(d);
        };
        scb.on_done = [out_ptr = out.get(), &log, engine, export_str, accumulated_text, summary_in_flight, summary_cv, summary_mu](const LlmResult& res) {
            const bool ok = (res.status == LlmStatus::Completed && !accumulated_text->empty());
            if (ok) {
                if (out_ptr) out_ptr->send(server::encode_summary(true, *accumulated_text, export_str));
                log.line("Call summary generated by the AI.");
                engine->notify(NoticeLevel::Info, "Call summary generated.");
            } else {
                if (out_ptr) out_ptr->send(server::encode_summary(false, "", export_str));
                log.line("AI summary failed: " + res.error);
                engine->notify(NoticeLevel::Warning, "The summary could not be generated; the transcript was exported.");
            }
            {
                std::lock_guard<std::mutex> lk(*summary_mu);
                summary_in_flight->store(false);
            }
            summary_cv->notify_all();
        };

        try {
            openrouter_sol_client->start(std::move(sreq), std::move(scb));
        } catch (const std::exception& ex) {
            log.line("Could not start the AI summary: " + std::string(ex.what()));
            if (out) out->send(server::encode_summary(false, "", export_str));
            engine->notify(NoticeLevel::Warning, "The summary could not be generated; the transcript was exported.");
            summary_in_flight->store(false);
        }

        if (wait_for_completion && summary_in_flight->load()) {
            std::unique_lock<std::mutex> lk(*summary_mu);
            summary_cv->wait_for(lk, std::chrono::seconds(8), [&] { return !summary_in_flight->load(); });
        }
    };

    engine->add_sink([summary_pending, trigger_export_and_summary](const EngineEvent& e) {
        if (const auto* m = std::get_if<TranscriptionModeEvent>(&e)) {
            if (m->enabled) {
                summary_pending->store(true);
            } else if (summary_pending->exchange(false)) {
                trigger_export_and_summary(false);
            }
        }
    });

    // ---------------- lanes ----------------
    std::vector<std::unique_ptr<Lane>> lanes;
    // Scripted two-sided conversation for --demo (drives the UI without
    // audio); paused flags per source apply to it as well.
    std::unique_ptr<DemoConversation> demo_talk;
    std::atomic<bool> src_paused[2] = {false, false};
    std::atomic<bool> demo_speaking[2] = {false, false};
    auto set_paused = [&lanes, &src_paused, engine](bool paused, int src) {
        for (auto& l : lanes) {
            if (l->pipe && (src < 0 || static_cast<int>(l->pipe->source()) == src)) l->pipe->set_paused(paused);
        }
        for (int i = 0; i < 2; ++i) {
            if (src < 0 || src == i) src_paused[i].store(paused);
        }
        engine->set_paused(paused, src);
    };
    // Audio meters (UI thread of the overlay and the --server meter thread).
    auto snapshot_levels = [&lanes, &src_paused, &demo_talk, &demo_speaking]() {
        server::Levels lv;
        for (auto& l : lanes) {
            if (!l->pipe || !l->started) continue;
            const bool mic = l->pipe->source() == AudioSource::Microphone;
            (mic ? lv.voce : lv.outros) = l->pipe->level();
            (mic ? lv.voce_speaking : lv.outros_speaking) = l->pipe->speaking();
            (mic ? lv.voce_active : lv.outros_active) = !src_paused[static_cast<int>(l->pipe->source())].load();
        }
        if (demo_talk) {
            const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                                std::chrono::steady_clock::now().time_since_epoch()).count();
            for (int i = 0; i < 2; ++i) {
                const bool on = demo_speaking[i].load() && !src_paused[i].load();
                const float wobble = 0.5f + 0.5f * std::sin(static_cast<float>(ms) / 90.0f + static_cast<float>(i * 2));
                const float lvl = on ? 0.45f + 0.4f * wobble : 0.03f;
                (i == 0 ? lv.voce : lv.outros) = lvl;
                (i == 0 ? lv.voce_speaking : lv.outros_speaking) = on;
                (i == 0 ? lv.voce_active : lv.outros_active) = !src_paused[i].load();
            }
        }
        return lv;
    };

    // ---------------- overlay ----------------
    std::unique_ptr<OverlayWindow> overlay;
    if (!cfg.console) {
        enable_per_monitor_dpi();
        OverlayOptions oo;
        std::error_code ec;
        fs::create_directories(cfg.app_dir, ec);
        oo.settings_file = (cfg.app_dir / L"overlay.ini").wstring();
        oo.session_start = session_start;
        oo.mode_label = cfg.demo ? "DEMO" : "LIVE";
        if (agent_rag && !agent_rag->profile().company.empty()) {
            oo.mode_label += " · " + agent_rag->profile().company;
        } else if (agent_rag && !agent_rag->profile().name.empty()) {
            oo.mode_label += " · " + agent_rag->profile().name;
        }
        oo.llm_enabled = llm != nullptr;
        oo.llm_model = cc.model;
        oo.width_dip = static_cast<float>(cfg.st.overlay_width);
        oo.mic_enabled = cfg.demo || cfg.st.mic_enabled;
        oo.system_audio_enabled = cfg.demo || cfg.st.loopback_enabled;
        oo.auto_answer_on = cfg.st.auto_suggest;
        oo.transcription_only_on = engine->transcription_only();
        oo.max_height_fraction = static_cast<float>(cfg.st.overlay_max_height_pct) / 100.0f;
        oo.stealth_dock = cfg.st.stealth_dock;
        oo.stealth_activity_monitor = cfg.st.stealth_activity_monitor;
        oo.stealth_click_through = cfg.st.stealth_click_through;
        oo.stealth_screen_capture = cfg.st.stealth_screen_capture;
        if (cfg.st.stealth_activity_monitor) {
            SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);
            HWND con = GetConsoleWindow();
            if (con) ShowWindow(con, SW_HIDE);
        }
        OverlayCallbacks ocb;
        ocb.on_suggest = [engine] { engine->request_suggestion(); };
        ocb.on_pause = [&set_paused](bool p) { set_paused(p, -1); };
        ocb.on_pause_source = [&set_paused](int src, bool p) { set_paused(p, src); };
        ocb.on_chat = [engine](std::string text) { engine->request_action(TriggerReason::Chat, std::move(text)); };
        ocb.on_screenshot = [weak = std::weak_ptr<CopilotEngine>(engine)](std::string image, std::string text) {
            // Called from the overlay's JPEG worker thread.
            if (auto e = weak.lock()) e->request_action(TriggerReason::Screenshot, std::move(text), std::move(image));
        };
        ocb.on_recap = [engine] { engine->request_action(TriggerReason::Recap); };
        ocb.on_followup = [engine] { engine->request_action(TriggerReason::FollowUp); };
        ocb.on_rate = [engine](std::uint64_t id, int vote) { engine->rate_suggestion(id, vote); };
        ocb.on_clear_chat = [engine] { engine->clear_chat(); };
        ocb.poll_levels = [&snapshot_levels] {
            const server::Levels lv = snapshot_levels();
            return OverlayLevels{lv.voce, lv.outros, lv.voce_speaking, lv.outros_speaking};
        };
        ocb.on_auto_toggle = [engine](bool on) { engine->set_auto_answer(on); };
        ocb.on_transcription_only_toggle = [engine](bool on) { engine->set_transcription_only(on); };
        ocb.on_suggested_pick = [engine](std::string text) { engine->request_action(TriggerReason::Chat, std::move(text)); };
        // Req 12.5-12.7 quick actions over the current answer: reformulate as a
        // Chat turn with an explicit instruction (1 = shorter bullets, 2 =
        // CV-based example, 3 = code + complexity analysis).
        ocb.on_quick_action = [engine](int action) {
            const char* prompt = nullptr;
            switch (action) {
                case 1: prompt = "Rewrite the previous answer as a shorter STAR (up to 70 words) without changing the facts. Keep the language of the conversation."; break;
                case 2: prompt = "Give a practical example from my resume for the previous answer. Keep the language of the conversation."; break;
                case 3: prompt = "Write code for the previous answer with a complexity analysis (time and space). Keep the language of the conversation."; break;
                default: return;
            }
            engine->request_action(TriggerReason::Chat, prompt);
        };
        ocb.on_open_config = [path = cfg.config_path, engine, o = out.get()] {
            // Launched by the dashboard: its Settings page is the one place to
            // configure everything, so ask it to come forward there.
            if (o) {
                o->send(server::encode_simple("open_settings", "section", "general"));
                return;
            }
            if (open_settings_popup(path)) {
                engine->notify(NoticeLevel::Info,
                               "Settings saved. Restart the app to apply the new keys.");
            }
        };
        overlay = std::make_unique<OverlayWindow>(oo, ocb);
        std::string err;
        if (overlay->create(&err)) {
            OverlayWindow* o = overlay.get();
            engine->add_sink([o](const EngineEvent& e) { o->post(e); });
            g_overlay.store(o);
            hide_own_console();
        } else {
            log.line("Overlay unavailable (" + err + "); continuing in the console.");
            overlay.reset();
        }
    }

    if (out) {
        server::Hello h = make_hello(cfg, llm != nullptr, cc.model, engine ? engine->transcription_only() : false);
        if (store) h.session_path = path_utf8(store->jsonl_path());
        out->send(server::encode_hello(h));
    }
    engine->start();
    log.line("Config: " + path_utf8(cfg.config_path) + "");
    if (!cfg.st.deepgram_key_source.empty()) log.line("Deepgram key: " + cfg.st.deepgram_key_source);
    if (!cfg.st.llm_key_source.empty()) log.line("LLM key: " + cfg.st.llm_key_source);
    for (const auto& n : cfg.notes) {
        engine->notify(n.find("config.ini [") == 0 ? NoticeLevel::Warning : NoticeLevel::Info, n);
    }
    if (!llm) {
        engine->notify(NoticeLevel::Warning,
                       "Suggestions are off: add the OpenRouter key in Settings > General.");
    }
    if (openrouter && parse_url(cfg.st.llm_url).host == "openrouter.ai") {
        std::weak_ptr<CopilotEngine> weak = engine;
        openrouter->warm_up([weak](bool ok, std::string msg) {
            if (auto e = weak.lock()) e->notify(ok ? NoticeLevel::Info : NoticeLevel::Error, std::move(msg));
        });
    }

    if (cfg.demo) {
        for (AudioSource s : {AudioSource::Microphone, AudioSource::Loopback}) {
            TransportStatus st;
            st.source = s;
            st.state = LinkState::Connected;
            st.detail = "demo (no network)";
            engine->on_link_status(st);
        }
        demo_talk = std::make_unique<DemoConversation>();
        std::weak_ptr<CopilotEngine> weak = engine;
        demo_talk->start(
            [weak, &src_paused](const TranscriptEvent& ev) {
                if (src_paused[static_cast<int>(ev.source)].load()) return;
                if (auto e = weak.lock()) e->on_transcript(ev);
            },
            [&demo_speaking](AudioSource s, bool on) { demo_speaking[static_cast<int>(s)].store(on); });
    } else {
        for (AudioSource s : {AudioSource::Microphone, AudioSource::Loopback}) {
            if (s == AudioSource::Microphone && !cfg.st.mic_enabled) continue;
            if (s == AudioSource::Loopback && !cfg.st.loopback_enabled) continue;
            auto lane = std::make_unique<Lane>();
            lane->name = s == AudioSource::Microphone ? "mic/You" : "loopback/Others";
            auto wasapi = std::make_unique<WasapiCaptureSource>(s, s == AudioSource::Loopback);
            std::weak_ptr<CopilotEngine> weak = engine;
            const std::string who = s == AudioSource::Microphone ? "Microphone: " : "System audio: ";
            wasapi->set_status_callback([weak, who](const std::string& msg) {
                if (auto e = weak.lock()) e->notify(NoticeLevel::Warning, who + msg);
            });
            // Local acoustic VAD on the capture thread (Req 1.5/1.6): the lanes
            // are torn down before the engine below, so this raw pointer stays
            // valid for the capture thread's lifetime. The engine methods only
            // enqueue + notify, so the capture thread never blocks.
            wasapi->set_engine(engine.get());
            lane->capture = std::move(wasapi);
            lane->vad = make_vad(log, cfg);
            auto tx = std::make_unique<DeepgramTransport>(deepgram_config(cfg, s), clock);
            tx->set_status_callback([weak](const TransportStatus& st) {
                if (auto e = weak.lock()) e->on_link_status(st);
            });
            lane->transport = std::move(tx);
            lanes.push_back(std::move(lane));
        }
    }

    for (auto& lane : lanes) {
        lane->metrics = std::make_unique<MetricsRegistry>(clock.ticks_per_second());
        lane->pipe = std::make_unique<SourcePipeline>(*lane->capture, *lane->vad, *lane->transport, clock,
                                                      *lane->metrics);
        std::weak_ptr<CopilotEngine> weak = engine;
        lane->pipe->set_transcript_sink([weak](const TranscriptEvent& ev) {
            if (auto e = weak.lock()) e->on_transcript(ev);
        });
        if (lane->pipe->source() == AudioSource::Microphone) {
            // Pin on Speak: while the user is talking (Silero gate open on the
            // mic) a new automatic answer is queued instead of replacing the
            // card they are reading aloud. Posted every window while speaking
            // (the gate needs 300 ms of continuous voice) and once on the edge.
            auto was_active = std::make_shared<std::atomic<bool>>(false);
            lane->pipe->set_vad_listener([weak, was_active](bool active) {
                if (!active && !was_active->exchange(false)) return;
                if (active) was_active->store(true);
                if (auto e = weak.lock()) e->on_mic_rms(active ? 1.0f : 0.0f, 0.5f);
            });
        }
        try {
            lane->pipe->start();
            lane->started = true;
        } catch (const std::exception& e) {
            engine->notify(NoticeLevel::Error, lane->name + " did not start: " + e.what());
            lane->transport->close();
        }
    }

    log.line(cfg.demo ? "== RealTimeAI demo (no hardware/network) =="
                      : "== RealTimeAI live: You = microphone, Others = system audio ==");
    if (store) log.line("Session: " + path_utf8(store->jsonl_path()));

    // ---------------- main loop ----------------
    if (out) {
        // Commands from the UI. The reader thread is stopped before the lanes
        // and the engine go away, so these references stay valid.
        stdio::StdinReader reader(
            [&](std::string_view line) {
                std::string err;
                auto c = server::parse_command(line, &err);
                if (!c) {
                    log.line("invalid command: " + err);
                    return;
                }
                using K = server::Command::Kind;
                switch (c->kind) {
                    case K::Answer: engine->request_suggestion(); break;
                    case K::Chat: engine->request_action(TriggerReason::Chat, c->text); break;
                    case K::Screenshot:
                        engine->request_action(TriggerReason::Screenshot, c->text, std::move(c->image));
                        break;
                    case K::Recap: engine->request_action(TriggerReason::Recap); break;
                    case K::FollowUp: engine->request_action(TriggerReason::FollowUp); break;
                    case K::Pause: set_paused(c->paused, c->source); break;
                    case K::Rate: engine->rate_suggestion(c->id, c->vote); break;
                    case K::ClearChat: engine->clear_chat(); break;
                    case K::SetMode: engine->set_transcription_only(c->mode_on); break;
                    case K::SetConfig:
                    case K::OpenConfig: handle_config_command(cfg, *c, *out, log); break;
                    case K::Quit:
                        SetEvent(g_stop_event);
                        if (overlay) overlay->request_close();
                        break;
                }
            },
            [&] {
                SetEvent(g_stop_event);
                if (overlay) overlay->request_close();
            }); // UI closed the pipe
        reader.start();

        // Audio meters for the UI (~10 Hz, droppable lines).
        std::atomic<bool> meters_on{true};
        std::thread meters([&] {
            while (meters_on.load()) {
                const server::Levels lv = snapshot_levels();
                out->send(server::encode_levels(lv), /*droppable=*/true);
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            }
        });

        if (overlay) {
            log.line("Server mode + overlay on. Ctrl+Alt+Enter answers, Ctrl+Alt+M transcription-only mode, Ctrl+Alt+Q quits.");
            overlay->run();
            g_overlay.store(nullptr);
            SetEvent(g_stop_event);
        } else {
            log.line("Server mode: waiting for UI commands on stdin.");
            WaitForSingleObject(g_stop_event, INFINITE);
        }
        reader.stop();
        meters_on = false;
        meters.join();
        if (demo_talk) demo_talk->stop();
    } else if (overlay) {
        log.line("Overlay on. Ctrl+Alt+Enter answers, Ctrl+Alt+S screen, Ctrl+Alt+K chat, Ctrl+Alt+Q quits.");
        overlay->run();
        g_overlay.store(nullptr);
    } else if (cfg.demo) {
        // Console demo: wait for the WAV to finish and the suggestion to stream.
        while (demo_talk && !demo_talk->finished() && WaitForSingleObject(g_stop_event, 100) == WAIT_TIMEOUT) {
        }
        WaitForSingleObject(g_stop_event, 4000);
    } else {
        log.line("Press Enter (or Ctrl+C) to quit.");
        std::thread([] {
            std::string dummy;
            std::getline(std::cin, dummy);
            SetEvent(g_stop_event);
        }).detach();
        WaitForSingleObject(g_stop_event, INFINITE);
    }

    // ---------------- orderly shutdown ----------------
    if (demo_talk) demo_talk->stop();
    // 1) Stop capture and flush/close each Deepgram stream, lanes in parallel
    //    (each close waits up to ~2 s for the server's final results).
    std::vector<std::thread> stoppers;
    for (auto& lane : lanes) {
        if (!lane->started) continue;
        SourcePipeline* p = lane->pipe.get();
        stoppers.emplace_back([p] { p->stop(); });
    }
    for (auto& t : stoppers) t.join();
    // 2) Let the engine close pending turns, then stop it (no sink calls after).
    std::this_thread::sleep_for(std::chrono::milliseconds(150));
    engine->stop();
    if (summary_pending->exchange(false)) {
        trigger_export_and_summary(true);
    } else if (summary_in_flight->load()) {
        std::unique_lock<std::mutex> lk(*summary_mu);
        summary_cv->wait_for(lk, std::chrono::seconds(8), [&] { return !summary_in_flight->load(); });
    }
    // 3) Cancel in-flight LLM calls.
    if (llm) llm->shutdown(std::chrono::milliseconds(1500));
    // 4) Persist.
    if (store) {
        store->close("normal");
        log.line("Session saved: " + path_utf8(store->jsonl_path()));
        log.line("Summary: " + path_utf8(store->markdown_path()));
    }
    overlay.reset();
    if (out) {
        out->send(store ? server::encode_bye(path_utf8(store->jsonl_path()), path_utf8(store->markdown_path()))
                        : server::encode_bye("", ""));
    }

    for (auto& lane : lanes) {
        if (lane->metrics) print_metrics(log, *lane->metrics, lane->name);
        if (auto* dg = dynamic_cast<DeepgramTransport*>(lane->transport.get())) {
            const auto s = dg->stats();
            log.line("  deepgram: " + std::to_string(s.audio_bytes_sent / 32000) + " s of audio, " +
                     std::to_string(s.keepalives_sent) + " KeepAlive, " + std::to_string(s.finalizes_sent) +
                     " Finalize, " + std::to_string(s.reconnects) + " reconnects, " +
                     std::to_string(s.dropped_samples / 16) + " ms dropped");
        }
        if (auto* w = dynamic_cast<WasapiCaptureSource*>(lane->capture.get())) {
            log.line("  capture: " + std::to_string(w->glitches()) + " glitches, " +
                     std::to_string(w->recoveries()) + " device reopens");
        }
    }
    if (out) out->stop();
    log.stop();
    if (log_file) std::fclose(log_file);
    return 0;
}

int main(int argc, char** argv) {
    // Real-time scheduling for the whole run: 1 ms timers and no EcoQoS.
    const rtai::win::TimerResolution timer_resolution(1);
    rtai::win::disable_power_throttling();
    prepare_console();
    g_stop_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    g_done_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    SetConsoleCtrlHandler(on_console_ctrl, TRUE);

    int rc = 1;
    try {
        rc = run_app(load_config(argc, argv));
    } catch (const std::exception& e) {
        std::cerr << "Fatal error: " << e.what() << "\n";
    }
    if (g_done_event) SetEvent(g_done_event);
    return rc;
}
