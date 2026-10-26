// Floating HUD (Win32 + Direct2D/DirectWrite, per-pixel-alpha layered window).
//
// Layout (top to bottom, each a rounded panel, transparent gaps between):
//   * control bar: capture toggles (system audio, mic) with recording dots
//     and level rings, "Responder", "Tela", "Chat", move, collapse, menu,
//     "Encerrar";
//   * menu sheet (when open): summary, follow-up, click-through, config...;
//   * transcript strip: level meter + recent speech as phrase chips;
//   * answer card: history navigation, question, streamed answer with
//     bullets/bold, feedback, and the chat field.
// Width is user-resizable (right edge grip); height follows the content.
// Buttons collapse labels and key hints when the width gets small.
//
// Threading model ("never block the UI thread"):
//   * post() is called from engine/LLM threads. It only pushes into a
//     WakeQueue and, at most once per drain, PostMessage()s the window.
//   * The UI thread drains everything per wake-up, updates a plain model and
//     schedules ONE render through a 16 ms timer, so bursts of token deltas
//     and interim transcripts are coalesced into <= ~60 fps of repaints.
//   * Callbacks only call non-blocking engine methods (enqueue/atomic).
//   * Screenshots are captured on the UI thread (BitBlt) and encoded to JPEG
//     on a worker thread.
//
// Window behaviour: always on top, does not take focus unless the chat field
// is used (then it returns focus to the previous app), not in the taskbar,
// draggable, position and width remembered. It is a normal, visible window:
// no capture exclusion, matching the project's "visible and consented" scope.
//
// Global hotkeys (Ctrl+Alt+...): Enter = answer now, S = screenshot,
// K = chat, Left/Right = history, R = summary, P = pause/resume capture,
// Backspace = clear transcript strip, H = hide/show, T = click-through,
// O = open config.ini, Q = end session.
// Discreet Req 12 combos: Alt+Space and Ctrl+Space = immediate answer from the
// current buffer (empty buffer -> Info notice), Alt+Up/Down = history nav
// (cap 50, end-of-history -> Info notice), Alt+1/2/3 = quick actions (shorter
// bullets / CV example / code+complexity), Alt+H = Modo_Panic toggle.
#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>

#include "rtai/copilot_events.hpp"

namespace rtai {

struct OverlayOptions {
    std::wstring settings_file; // INI used to remember position/width; empty = don't persist
    std::chrono::steady_clock::time_point session_start{std::chrono::steady_clock::now()};
    std::string mode_label{"AO VIVO"};
    bool llm_enabled{true};
    std::string llm_model;
    bool mic_enabled{true};
    bool system_audio_enabled{true};
    bool auto_answer_on{true};
    bool transcription_only_on{false};
    float width_dip{860.0f};
    float max_height_fraction{0.6f}; // answer area cap, fraction of the monitor work area
    // Accent palette (Req 3.6): true -> key terms highlighted in rgb(10,132,255);
    // false -> monochrome palette, key terms in full-opacity white.
    bool palette_accent{true};
    // Stealth & Privacy options
    bool stealth_dock{true};
    bool stealth_activity_monitor{true};
    bool stealth_click_through{false};
    bool stealth_screen_capture{true};
};

// Audio meters polled by the overlay (~20 Hz while visible).
struct OverlayLevels {
    float voce{0}, outros{0};       // 0..1
    bool voce_speaking{false}, outros_speaking{false};
};

struct OverlayCallbacks {
    std::function<void()> on_suggest;
    std::function<void(bool paused)> on_pause;                   // all sources
    std::function<void(int source, bool paused)> on_pause_source; // AudioSource as int
    std::function<void()> on_open_config;
    std::function<void(std::string text)> on_chat;
    std::function<void(std::string image_data_url, std::string text)> on_screenshot;
    std::function<void()> on_recap;
    std::function<void()> on_followup;
    std::function<void(std::uint64_t id, int vote)> on_rate;
    std::function<void()> on_clear_chat;
    std::function<OverlayLevels()> poll_levels;
    std::function<void(bool on)> on_auto_toggle; // auto-answer
    std::function<void(bool on)> on_transcription_only_toggle; // transcription-only mode
    std::function<void(std::string text)> on_suggested_pick;
    // Req 12.5-12.7 quick actions over the current answer, requested from the
    // engine: 1 = shorter bullets, 2 = resume/CV-based example, 3 = code with
    // complexity analysis. `action` is 1, 2 or 3.
    std::function<void(int action)> on_quick_action;
    // Req 12.2: immediate-answer (Alt+Espaço / Ctrl+Espaço) is ignored when the
    // turn-assembler buffer is empty. The engine exposes that state here so the
    // overlay can publish a NoticeEvent{Info} instead of firing an empty
    // request. When unset, the overlay falls back to the transcript strip.
    std::function<bool()> is_buffer_empty;
};

class OverlayWindow {
public:
    OverlayWindow(OverlayOptions opts, OverlayCallbacks callbacks);
    ~OverlayWindow();

    OverlayWindow(const OverlayWindow&) = delete;
    OverlayWindow& operator=(const OverlayWindow&) = delete;

    // UI thread. Returns false (with a reason) if D2D/DirectWrite or the
    // window can't be created.
    bool create(std::string* error = nullptr);

    // Runs the message loop until the window is closed ("Encerrar",
    // Ctrl+Alt+Q, request_close()). Returns the WM_QUIT code.
    int run();

    // ---- any thread ----
    void post(const EngineEvent& ev);
    void request_close();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace rtai
