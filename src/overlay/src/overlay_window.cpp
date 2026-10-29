#include "rtai/overlay_window.hpp"

#include <windows.h>
#include <windowsx.h>
#include <d2d1.h>
#include <d2d1helper.h>
#include <dwrite.h>
#include <dwmapi.h>
#pragma comment(lib, "dwmapi.lib")

#include <algorithm>
#include <array>
#include <climits>
#include <cmath>
#include <cstdio>
#include <deque>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <type_traits>
#include <variant>
#include <vector>

#include "rtai/copilot_prompt.hpp"
#include "rtai/decision_policy.hpp"
#include "rtai/icon_paths.hpp"
#include "rtai/screen_capture.hpp"
#include "rtai/suggestion_format.hpp"
#include "rtai/svg_path.hpp"
#include "rtai/text_util.hpp"
#include "rtai/ui_models.hpp"
#include "rtai/wake_queue.hpp"

#ifdef _MSC_VER
#pragma comment(lib, "d2d1.lib")
#pragma comment(lib, "dwrite.lib")
#endif

namespace rtai {

namespace {

constexpr UINT WM_APP_DRAIN = WM_APP + 1;
constexpr UINT WM_APP_SHOT_DONE = WM_APP + 2; // wParam: 1 ok, 0 failed
constexpr UINT_PTR kTimerRender = 1;
constexpr UINT_PTR kTimerClock = 2;
constexpr UINT_PTR kTimerAnim = 3;
constexpr UINT_PTR kTimerShot = 4;

enum HotkeyId : int {
    kHkAnswer = 1, kHkShot, kHkChat, kHkPrev, kHkNext, kHkRecap, kHkPause, kHkClearAnswers,
    kHkClearStrip, kHkHide, kHkClick, kHkConfig, kHkTab, kHkMode, kHkQuit,
    // Discreet Req 12 combos under MOD_ALT (and MOD_CONTROL for Ctrl+Espaço),
    // distinct from the Ctrl+Alt scheme above.
    kHkAnswerNow,   // Alt+Espaço: resposta imediata do buffer atual (Req 12.1/12.2)
    kHkAnswerNow2,  // Ctrl+Espaço: idem (Req 12.1/12.2)
    kHkHistPrev,    // Alt+Seta Cima: resposta anterior no histórico (Req 12.3/12.4)
    kHkHistNext,    // Alt+Seta Baixo: resposta seguinte no histórico (Req 12.3/12.4)
    kHkQuick1,      // Alt+1: versão mais curta em tópicos (Req 12.5)
    kHkQuick2,      // Alt+2: exemplo baseado no currículo (Req 12.6)
    kHkQuick3,      // Alt+3: código + análise de complexidade (Req 12.7)
    kHkPanic,       // Alt+H: toggle Modo_Panic (Req 12.8/12.9, efeito na task 19.2)
    kHkLast
};

// Clickable things. Hit regions are rebuilt on every render.
enum HitId : int {
    kNone = 0, kDragArea, kResize,
    kSrcOutros, kSrcVoce, kBtnAnswer, kBtnShot, kBtnChat, kBtnMove, kBtnCollapse, kBtnMenu, kBtnEnd,
    kMenuRecap, kMenuFollow, kMenuPause, kMenuClick, kMenuHide, kMenuConfig,
    kStripClear, kPrev, kNext, kAnsClear, kAnsExpand, kCopy, kVoteUp, kVoteDown,
    kChatField, kChatSend, kChatClose, kQuickRecap, kQuickFollow, kQuickShot, kQuickChat, kNotice, kBtnNextQuestion,
    kTabSuggested, kTabTranscript, kToggleAuto, kToggleTranscriptionOnly, kChipPickBase, kActionRecap = 600, kActionFollow, kActionAsk, kSuggestedAskBase = 700,
    kStyleConcise = 801, kStyleDetailed = 802, kStyleStar = 803, kFollowUpRowBase = 810
};

// ── HUD de reunião: painel largo, 640-1100px, ancorado no topo-centro ──
constexpr float kMargin = 6.0f;          // borda transparente
constexpr float kGap = 6.0f;             // micro-espaçamento entre zonas
constexpr float kRadius = 6.0f;
constexpr float kUnifiedStripH = 38.0f;  // ControlBar+LiveStrip fundidas (era 46+44)
constexpr float kBarH = 46.0f;           // mantido p/ compat (não usado no modo HUD)
constexpr float kBtnH = 34.0f;
constexpr float kStripH = 44.0f;         // idem
// Width/anchor/height constants and the clamp helpers live in ui_models.hpp
// (rtai::ui) so they are shared with the core unit tests and never duplicated
// here. Global: kHudW=960 (Req 1.2), kMinW=420/kMaxW=1100 (Req 1.3),
// kAnchorTopMinDIP=8/kAnchorTopMaxDIP=10 (Req 1.1), kMaxHeightFraction* (Req 1.7).
// In rtai::ui: clamp_width, clamp_height_fraction, window_height, clamp_anchor_top.
constexpr std::size_t kMaxHistory = 50;  // Req 12 história
constexpr float kHeadlineSize = 15.5f;
constexpr float kBulletSize = 13.5f;
constexpr float kMinAnswerH = 110.0f;    // pré-aloca ao disparar SuggestionStarted

template <class T>
class ComPtr {
public:
    ComPtr() = default;
    ~ComPtr() { reset(); }
    ComPtr(const ComPtr& o) : p_(o.p_) { if (p_) p_->AddRef(); }
    ComPtr& operator=(const ComPtr& o) {
        if (this != &o) {
            if (o.p_) o.p_->AddRef();
            reset();
            p_ = o.p_;
        }
        return *this;
    }
    ComPtr(ComPtr&& o) noexcept : p_(o.p_) { o.p_ = nullptr; }
    ComPtr& operator=(ComPtr&& o) noexcept {
        if (this != &o) {
            reset();
            p_ = o.p_;
            o.p_ = nullptr;
        }
        return *this;
    }
    void reset() {
        if (p_) p_->Release();
        p_ = nullptr;
    }
    T* get() const { return p_; }
    T* operator->() const { return p_; }
    T** put() {
        reset();
        return &p_;
    }
    explicit operator bool() const { return p_ != nullptr; }

private:
    T* p_{nullptr};
};

std::wstring widen(std::string_view s) {
    if (s.empty()) return {};
    const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring w(static_cast<std::size_t>(n > 0 ? n : 0), L'\0');
    if (n > 0) MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
    return w;
}

std::string narrow(std::wstring_view w) {
    if (w.empty()) return {};
    const int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
    std::string s(static_cast<std::size_t>(n > 0 ? n : 0), '\0');
    if (n > 0) WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr);
    return s;
}

std::wstring to_w(const std::u16string& s) { return std::wstring(s.begin(), s.end()); }

D2D1_COLOR_F rgba(int r, int g, int b, float a = 1.0f) {
    return D2D1::ColorF(static_cast<float>(r) / 255.0f, static_cast<float>(g) / 255.0f,
                        static_cast<float>(b) / 255.0f, a);
}

D2D1_COLOR_F with_alpha(D2D1_COLOR_F c, float a) {
    c.a = a;
    return c;
}

struct Palette {
    // Sleek dark neutral charcoal/obsidian palette (Images 3 & 4)
    D2D1_COLOR_F bar = rgba(22, 22, 24, 0.92f);
    D2D1_COLOR_F panel = rgba(18, 18, 20, 0.94f);
    D2D1_COLOR_F border = rgba(255, 255, 255, 0.12f);
    D2D1_COLOR_F border_soft = rgba(255, 255, 255, 0.07f);
    D2D1_COLOR_F btn = rgba(38, 38, 42, 0.95f);
    D2D1_COLOR_F btn_hover = rgba(52, 52, 57, 0.98f);
    D2D1_COLOR_F btn_down = rgba(28, 28, 31, 1.0f);
    D2D1_COLOR_F ghost_hover = rgba(255, 255, 255, 0.10f);
    D2D1_COLOR_F kbd = rgba(255, 255, 255, 0.09f);
    D2D1_COLOR_F chip = rgba(44, 44, 49, 0.94f);
    D2D1_COLOR_F chip_you = rgba(37, 82, 138, 0.78f);
    D2D1_COLOR_F text = rgba(248, 248, 250);
    D2D1_COLOR_F text_sub = rgba(228, 228, 232);
    D2D1_COLOR_F text_you = rgba(214, 232, 255);
    D2D1_COLOR_F muted = rgba(154, 154, 162);
    D2D1_COLOR_F faint = rgba(255, 255, 255, 0.06f);
    D2D1_COLOR_F accent = rgba(59, 130, 246);
    D2D1_COLOR_F accent_soft = rgba(96, 165, 250);
    D2D1_COLOR_F accent_glow = rgba(59, 130, 246, 0.18f);
    D2D1_COLOR_F green = rgba(52, 199, 89);
    D2D1_COLOR_F green_soft = rgba(52, 199, 89, 0.14f);
    D2D1_COLOR_F amber = rgba(255, 179, 64);
    D2D1_COLOR_F amber_soft = rgba(255, 179, 64, 0.12f);
    D2D1_COLOR_F red = rgba(255, 69, 58);
    D2D1_COLOR_F end = rgba(239, 59, 59);
    D2D1_COLOR_F end_hover = rgba(255, 71, 71);
    D2D1_COLOR_F field = rgba(30, 30, 34, 0.92f);
};

std::string seconds_pt(std::int64_t ms) {
    const std::int64_t tenths = (ms + 50) / 100;
    return std::to_string(tenths / 10) + "." + std::to_string(tenths % 10) + "s";
}

// Micro_Footer telemetry (Req 15.2): integer milliseconds, clamped to the
// observable range [0, 600000]. A value outside that range (notably the -1
// sentinel of SuggestionDoneEvent) is reported as the "unavailable" indicator
// so one missing field never blanks out the others (Req 15.3).
[[maybe_unused]] std::string ms_int_pt(std::int64_t ms) {
    if (ms < 0 || ms > 600000) return "—";
    return std::to_string(ms) + " ms";
}

std::string clock_text(std::chrono::steady_clock::duration d) {
    const auto s = std::chrono::duration_cast<std::chrono::seconds>(d).count();
    char buf[32];
    if (s >= 3600) {
        std::snprintf(buf, sizeof(buf), "%lld:%02lld:%02lld", static_cast<long long>(s / 3600),
                      static_cast<long long>((s / 60) % 60), static_cast<long long>(s % 60));
    } else {
        std::snprintf(buf, sizeof(buf), "%02lld:%02lld", static_cast<long long>(s / 60), static_cast<long long>(s % 60));
    }
    return buf;
}

std::string local_hhmm() {
    SYSTEMTIME st{};
    GetLocalTime(&st);
    char buf[16];
    std::snprintf(buf, sizeof(buf), "%02u:%02u", static_cast<unsigned>(st.wHour), static_cast<unsigned>(st.wMinute));
    return buf;
}

[[maybe_unused]] const char* reason_title(TriggerReason r) {
    switch (r) {
        case TriggerReason::Chat:       return "You asked";
        case TriggerReason::Screenshot: return "Screen";
        case TriggerReason::Recap:      return "Summary";
        case TriggerReason::FollowUp:   return "Follow-up";
        case TriggerReason::Keyword:    return "Topic";
        default:                        return "Question";
    }
}

[[maybe_unused]] const char* reason_icon(TriggerReason r) {
    switch (r) {
        case TriggerReason::Chat:       return "message-square";
        case TriggerReason::Screenshot: return "camera";
        case TriggerReason::Recap:      return "scroll-text";
        case TriggerReason::FollowUp:   return "circle-help";
        case TriggerReason::Question:   return "message-circle-question";
        case TriggerReason::Keyword:    return "sparkles";
        default:                        return "message-circle-question";
    }
}

// Key hint: modifiers as text + the final key as text or an icon.
struct KeyHint {
    const wchar_t* mods{L"Ctrl Alt"};
    const wchar_t* key{nullptr};  // text key ("S") or
    const char* icon{nullptr};    // icon key ("corner-down-left")
};

} // namespace

// ===========================================================================

struct OverlayWindow::Impl {
    Impl(OverlayOptions o, OverlayCallbacks c) : opts(std::move(o)), cb(std::move(c)) {
        width = ui::clamp_width(opts.width_dip);
        opts.max_height_fraction = ui::clamp_height_fraction(opts.max_height_fraction);
        auto_answer_on = opts.auto_answer_on;
        transcription_only = opts.transcription_only_on;
        lanes[static_cast<std::size_t>(AudioSource::Microphone)].enabled = opts.mic_enabled;
        lanes[static_cast<std::size_t>(AudioSource::Loopback)].enabled = opts.system_audio_enabled;
    }

    OverlayOptions opts;
    OverlayCallbacks cb;
    Palette pal;

    HWND hwnd{nullptr};
    std::mutex hwnd_mu; // guards hwnd_for_post (read by other threads)
    HWND hwnd_for_post{nullptr};
    WakeQueue<EngineEvent> queue;

    // ---- Direct2D / DirectWrite ----
    ComPtr<ID2D1Factory> d2d;
    ComPtr<IDWriteFactory> dwrite;
    ComPtr<ID2D1DCRenderTarget> rt;
    ComPtr<ID2D1SolidColorBrush> brush;
    ComPtr<ID2D1StrokeStyle> round_stroke;
    ComPtr<IDWriteTextFormat> f_body, f_body_bold, f_ui, f_small, f_small_bold, f_kbd;
    ComPtr<IDWriteInlineObject> ellipsis_small;
    std::map<std::string, std::vector<ComPtr<ID2D1PathGeometry>>> icon_cache;

    // Cache de layouts por bloco (Req 14.4/14.5). Cada bloco lógico (headline,
    // cada âncora, footer, pergunta congelada, labels de botão…) é identificado
    // por uma chave estável = (ponteiro do IDWriteTextFormat + largura máxima +
    // texto). Enquanto o texto e a largura de um bloco não mudam entre quadros,
    // o IDWriteTextLayout é reutilizado sem recriação (Req 14.4). Se a criação
    // falhar, a entrada mantém o último layout válido (Req 14.5). Mutável porque
    // layout() é const — a cache é um detalhe de desempenho, não estado lógico.
    struct LayoutCacheEntry {
        std::wstring text;
        float width{0.0f};
        ComPtr<IDWriteTextLayout> layout;
        bool valid{false};
        bool used{false}; // touched this frame; drives eviction of stale blocks
    };
    mutable std::map<std::string, LayoutCacheEntry> layout_cache;
    // Set by layout() when a layout (re)creation fails this frame. render()
    // reads it to (a) surface the error via set_notice and (b) preserve the
    // previous frame instead of clearing to a blank card (Req 14.5).
    mutable bool layout_failed{false};

    HDC mem_dc{nullptr};
    HBITMAP dib{nullptr};
    HGDIOBJ old_bitmap{nullptr};
    int dib_w{0}, dib_h{0};
    UINT dpi{96};
    float scale{1.0f};
    bool render_pending{false};
    // True once at least one frame has been presented via UpdateLayeredWindow.
    // Lets render() safely preserve the previous frame on a layout failure
    // (Req 14.5) without blanking the very first paint.
    bool have_presented_frame{false};

    // ---- model (UI thread only) ----
    struct LaneView {
        LinkState state{LinkState::Idle};
        std::string detail;
        bool paused{false};
        bool enabled{true};
        float level{0.0f};
        bool speaking{false};
    };
    struct SuggestionView {
        std::uint64_t id{0};
        std::string trigger;
        // Trigger Lock: the question captured verbatim at the firing moment
        // (SuggestionStartedEvent). Immutable for the life of the answer; the
        // transcript stream touches only the strip, never this (Req 8.1-8.5).
        ui::FrozenQuestion frozen;
        std::string body; // committed stream text (Req 6.2/6.5): only whole words while streaming
        ui::StreamBuffer stream; // jitter-free word confirmation (Req 6.2, 6.5, 6.6)
        TriggerReason reason{TriggerReason::None};
        bool has_image{false};
        bool done{false};
        LlmStatus status{LlmStatus::Completed};
        std::string error;
        std::int64_t ttft_ms{-1};
        std::int64_t total_ms{0};
        std::string model;
        std::string clock;
        int vote{0};
        // Jitter-free streaming layout state (Req 6.1, 6.4, 6.7).
        float card_h{kMinAnswerH};        // animated card height, pre-allocated >=2 lines
        float card_h_target{kMinAnswerH}; // target set by render from the measured content
        std::chrono::steady_clock::time_point started_at{}; // SuggestionStartedEvent time
        bool got_delta{false};            // any visible answer text arrived yet
        // The question as the answer model understood it ("PERGUNTA:" line).
        // When present it replaces the raw transcript as the card title.
        std::string understood;
        bool waiting{false};              // 5 s with no delta -> show waiting indicator (Req 6.7)
        // Fade-in of new answer lines (Req 13.3): appear timestamp per rendered
        // body line, indexed by line position. A line absent here is appearing
        // for the first time this frame; its stamp is recorded then and its
        // opacity ramps 0->1 over 200 ms. Indices already present keep their
        // original stamp so a finished line never re-fades.
        std::vector<std::chrono::steady_clock::time_point> line_appear;
    };
    std::array<LaneView, 2> lanes{};
    ui::TranscriptStrip strip{24};
    std::deque<SuggestionView> history;
    std::size_t cursor{0};
    bool follow_latest{true};
    float scroll{0.0f};
    bool user_scrolled{false};
    bool unseen_answer{false};
    bool auto_answer_on{true};
    bool transcription_only{false};
    int answer_tab{0}; // 0 = Suggested, 1 = Transcript
    std::vector<std::string> suggested_questions; // auto-generated follow-ups
    // HUD mode state
    std::string locked_trigger; // Trigger Lock: congela pergunta ao disparar resposta
    std::chrono::steady_clock::time_point locked_at{};
    // Pin on Speak (Req 9.2, 9.3, 9.5, 9.6): the engine flags a firing
    // suggestion with enqueue=true when it must not replace the visible card
    // yet (user speaking or inside the 4000 ms window). Those events are
    // buffered here (FIFO, cap 5) and the "nova pergunta" pill is driven purely
    // off this queue being non-empty. [Tab] (or a click on the pill) pops the
    // front and promotes it into a card. The engine republishes a released
    // pending with enqueue=false when the 4000 ms window expires without
    // speech, so no card-side timer is needed here (Req 9.6).
    ui::SuggestionQueue<SuggestionStartedEvent> pending_queue;
    bool pending_question{false}; // anti-substituição: pílula "Nova pergunta" (espelha !pending_queue.empty())
    std::string pending_question_text;
    bool live_mode{true}; // Stealth HUD vs Setup (Modo_Ao_Vivo / Modo_Setup, Req 7.1-7.5)

    // OverlayMode (task 9.3): LiveCopilot is the streaming HUD; PostInterviewReport
    // is the Cold_Path Jev Dashboard (3 Score_Rings + Instant_Feedback). The mode
    // only flips to PostInterviewReport when an OverlayModeEvent carrying a
    // double-success JevReport arrives (Req 9.1). The switch changes ONLY what
    // render() draws — never the window styles (no-focus-steal, capture exclusion
    // stay exactly as the HUD set them, Req 9.6).
    OverlayMode mode_{OverlayMode::LiveCopilot};
    JevReport report_{};                       // dashboard payload (valid in PostInterviewReport)
    std::array<RingSpec, 3> ring_specs_{};     // fixed order/colour + target_theta_deg (Req 9.1/9.3)
    std::array<float, 3> ring_theta_cur_{};    // animated current sweep, 0 -> target (Req 9.2)

    // Modo_Panic (Req 12.8/12.9): Alt+H collapses the HUD to a near-invisible
    // 8x8 DIP dot and restores the previous geometry on the next press, both in
    // <=50 ms. The window composes per-pixel alpha via UpdateLayeredWindow, so
    // a single window-wide opacity is not available; the design's documented
    // alternative is the 8x8 dot collapse via SetWindowPos, which is instant
    // and fully reversible. We snapshot the exact pre-panic rect so deactivation
    // restores size and position byte-for-byte without a re-anchor.
    struct ModeState {
        bool panic{false};
        float pre_panic_opacity{1.0f}; // reserved; layered window keeps per-pixel alpha
        RECT pre_panic_rect{};         // physical-pixel window rect captured at activation
        bool have_rect{false};
    } mode;

    std::string notice;
    NoticeLevel notice_level{NoticeLevel::Info};
    bool notice_from_lane{false};
    std::chrono::steady_clock::time_point notice_at{};

    // Anti-captura (Req 11.1/11.5): verdadeiro quando
    // SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) foi aplicado com
    // sucesso na criação. Observável pela aplicação para refletir se a janela
    // está excluída da captura de tela/compartilhamento.
    bool capture_excluded{false};

    bool click_through{false};
    bool hidden{false};
    bool collapsed{false};
    bool menu_open{false};
    bool answer_expanded{false};
    float width{kHudW};
    // Work-area height (DIP) of the monitor resolve_anchor last placed us on.
    // The render height ceiling is window_height(content, frac, this) so the
    // window never grows past the chosen monitor's work area (Req 1.6, 1.7).
    float anchor_work_h{800.0f};
    int selected_style{2}; // 0 = Concise, 1 = Detailed, 2 = STAR (Image 5)

    // chat field
    bool chat_open{true};
    bool chat_focused{false};
    ui::LineEdit edit{2000};
    float chat_scroll_x{0.0f};
    HWND prev_foreground{nullptr};
    std::chrono::steady_clock::time_point caret_t0{};

    // screenshot
    bool shot_busy{false};
    std::string shot_text;

    // pointer
    struct Hit {
        D2D1_RECT_F r;
        int id;
        std::wstring tip;
    };
    std::vector<Hit> hits;
    int hover{kNone};
    std::chrono::steady_clock::time_point hover_since{};
    int pressed{kNone};
    bool tracking_leave{false};
    bool resizing{false};
    int resize_start_x{0};
    float resize_start_w{0.0f};
    std::chrono::steady_clock::time_point copied_at{};
    float tooltip_bottom{0.0f};

    // ------------------------------------------------------------------
    bool create(std::string* error);
    bool create_text_formats();
    bool ensure_device();
    void discard_device();
    bool ensure_surface(int w, int h);
    void release_surface();
    void register_hotkeys();
    void unregister_hotkeys();
    void load_state(int& x, int& y);
    void save_state();
    float work_height_dip() const;
    // Top-Center anchoring via the pure rtai::ui::resolve_anchor (Req 1.1, 1.4,
    // 1.5, 1.9). Bridges Win32 POINT/RECT to UiPoint/UiRect, derives the
    // monitor/work area, and moves the window. `use_persisted` picks the
    // monitor from the window's current center (used when re-centering after a
    // width change); otherwise it anchors on the primary.
    void reposition(bool use_persisted);

    void drain();
    // Applies one engine event to the plain model. Returns true when the event
    // warrants an immediate render instead of the coalesced 16 ms frame:
    // the FIRST visible delta of a generation (card's first got_delta flip) or
    // a commit (SpeculativeHitEvent) must push to the HUD with zero perceived
    // latency (Req 5.2); every other delta of the same generation is coalesced
    // by the render timer (Req 5.3).
    bool apply(EngineEvent& e);
    // Starts (or replaces) the visible answer card from a firing suggestion:
    // freezes the trigger question, pre-allocates the card, and appends it to
    // the history, honoring follow-latest. Shared by the direct enqueue=false
    // path and by promoting a queued suggestion on [Tab] (Req 9.3, 9.6).
    void start_suggestion(SuggestionStartedEvent& e);
    void apply_interpreted(SuggestionView& v, const std::string& raw, bool final);
    // Pops the oldest queued suggestion (if any) into a visible card and clears
    // the pill when the queue drains (Req 9.3, 9.6).
    void promote_next_pending();
    void set_notice(NoticeLevel lvl, std::string text, bool from_lane);
    void invalidate();
    void render();
    void on_hotkey(int id);
    void on_click(int id);
    void anim_tick();

    // actions
    void toggle_source(AudioSource s);
    void toggle_pause_all();
    void go_prev();
    void go_next();
    void clear_answers();
    void start_screenshot();
    void finish_screenshot();
    void open_chat(bool focus);
    void focus_chat();
    void blur_chat(bool restore_previous);
    void send_chat();
    void set_click_through(bool on);
    void toggle_hidden();
    void toggle_panic();   // Modo_Panic (Req 12.8/12.9)
    void request_config(); // Modo_Setup/Modo_Ao_Vivo gate (Req 7.1, 7.2, 7.5)
    bool chat_key(WPARAM vk);
    void paste_into_chat();

    static LRESULT CALLBACK wndproc(HWND h, UINT m, WPARAM w, LPARAM l);
    LRESULT handle(UINT m, WPARAM w, LPARAM l);
    int hit_at(float x, float y) const;

    // ---- drawing helpers ----
    ComPtr<IDWriteTextLayout> layout(const std::wstring& s, IDWriteTextFormat* fmt, float max_w,
                                     float max_h = 4000.0f) const;
    ComPtr<IDWriteTextLayout> line_layout(const std::wstring& s, IDWriteTextFormat* fmt, float max_w) const;
    ComPtr<IDWriteTextLayout> rich_layout(const std::vector<TextSegment>& segs, IDWriteTextFormat* fmt,
                                          float max_w) const;
    static float height_of(IDWriteTextLayout* l);
    static float width_of(IDWriteTextLayout* l);
    float text_w(const std::wstring& s, IDWriteTextFormat* fmt) const;
    void fill_round(const D2D1_RECT_F& r, float radius, const D2D1_COLOR_F& c);
    void stroke_round(const D2D1_RECT_F& r, float radius, const D2D1_COLOR_F& c, float w = 1.0f);
    void panel(const D2D1_RECT_F& r, const D2D1_COLOR_F& fill);
    void dot(float cx, float cy, float r, const D2D1_COLOR_F& c);
    void draw_text(IDWriteTextLayout* l, float x, float y, const D2D1_COLOR_F& c);
    void text_centered_v(IDWriteTextLayout* l, float x, float cy, const D2D1_COLOR_F& c);
    const std::vector<ComPtr<ID2D1PathGeometry>>& icon_geometry(const std::string& name);
    void icon(const char* name, float cx, float cy, float size, const D2D1_COLOR_F& c, float stroke = 2.0f);
    void add_hit(const D2D1_RECT_F& r, int id, std::wstring tip = {});
    D2D1_COLOR_F button_fill(int id, bool ghost) const;
    float kbd_width(const KeyHint& k) const;
    void draw_kbd(const KeyHint& k, float x, float cy);
    float button_width(const std::wstring& label, const KeyHint* k, bool with_label, bool with_kbd) const;
    void draw_button(const D2D1_RECT_F& r, int id, const std::wstring& label, const char* icon_name,
                     const KeyHint* k, bool with_label, bool with_kbd, bool ghost = false,
                     const D2D1_COLOR_F* fill_override = nullptr);
    void icon_button(const D2D1_RECT_F& r, int id, const char* icon_name, const std::wstring& tip,
                     const D2D1_COLOR_F* tint = nullptr, bool ghost = true);

    // ---- sections (return the y below them) ----
    float draw_unified_strip(float y); // HUD: ControlBar + strip fundidas (38px)
    float draw_control_bar(float y);   // legacy full bar (setup mode)
    float draw_menu(float y);
    float draw_strip(float y);         // legacy strip
    float draw_answer(float y);
    float draw_notice(float y);
    // PostInterviewReport dashboard (Req 9.1-9.4): three animated Score_Rings on
    // top and the three Instant_Feedback lines beside/under them. Returns the y
    // below the drawn panel.
    float draw_dashboard(float y);
    // One Score_Ring: a full faint track plus a coloured arc swept from 12 o'clock
    // over `theta_deg` degrees, built with ID2D1PathGeometry + AddArc (Req 9.2).
    // The score label sits centred inside and the dimension name below.
    void draw_score_ring(float cx, float cy, float radius, float theta_deg,
                         const D2D1_COLOR_F& color, float score, const wchar_t* label);
    void draw_tooltip(float max_y);
    // Pulse_Bar (Req 13.1, 13.4, 13.5): the single activity indicator while
    // listening — three 12 DIP vertical micro-bars whose heights follow the
    // capture RMS via ui::pulse_bar_height, repainted at 60 fps (kTimerAnim).
    // Replaces the old rotating spinner entirely (Req 13.4). Returns the total
    // drawn width so the strip can lay out the following element.
    float draw_pulse_bar(float x, float cy, float rms, bool available);
    void draw_toggle_level(float x, float cy, float level01, bool active, bool speaking);
    void draw_shimmer(const D2D1_RECT_F& r);
};

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

// First installed family from a preference list; falls back to whatever the
// system collection has, so text never silently disappears.
static std::wstring pick_font_family(IDWriteFactory* dw) {
    ComPtr<IDWriteFontCollection> fonts;
    if (FAILED(dw->GetSystemFontCollection(fonts.put(), FALSE)) || !fonts) return L"Segoe UI";
    for (const wchar_t* name : {L"Segoe UI Variable Text", L"Segoe UI", L"Arial", L"Tahoma", L"DejaVu Sans",
                                L"Liberation Sans"}) {
        UINT32 index = 0;
        BOOL exists = FALSE;
        if (SUCCEEDED(fonts->FindFamilyName(name, &index, &exists)) && exists) return name;
    }
    if (fonts->GetFontFamilyCount() > 0) {
        ComPtr<IDWriteFontFamily> family;
        ComPtr<IDWriteLocalizedStrings> names;
        if (SUCCEEDED(fonts->GetFontFamily(0, family.put())) && SUCCEEDED(family->GetFamilyNames(names.put()))) {
            UINT32 len = 0;
            if (SUCCEEDED(names->GetStringLength(0, &len))) {
                std::wstring n(len + 1, L'\0');
                if (SUCCEEDED(names->GetString(0, n.data(), len + 1))) {
                    n.resize(len);
                    return n;
                }
            }
        }
    }
    return L"Segoe UI";
}

bool OverlayWindow::Impl::create_text_formats() {
    const std::wstring family = pick_font_family(dwrite.get());
    auto make = [&](ComPtr<IDWriteTextFormat>& f, DWRITE_FONT_WEIGHT w, float size) {
        return SUCCEEDED(dwrite->CreateTextFormat(family.c_str(), nullptr, w, DWRITE_FONT_STYLE_NORMAL,
                                                  DWRITE_FONT_STRETCH_NORMAL, size, L"pt-br", f.put()));
    };
    if (!make(f_body, DWRITE_FONT_WEIGHT_NORMAL, kBulletSize)) return false;
    if (!make(f_body_bold, DWRITE_FONT_WEIGHT_SEMI_BOLD, kHeadlineSize)) return false;
    if (!make(f_ui, DWRITE_FONT_WEIGHT_SEMI_BOLD, 13.5f)) return false;
    if (!make(f_small, DWRITE_FONT_WEIGHT_NORMAL, 12.5f)) return false;
    if (!make(f_small_bold, DWRITE_FONT_WEIGHT_SEMI_BOLD, 12.5f)) return false;
    if (!make(f_kbd, DWRITE_FONT_WEIGHT_NORMAL, 11.0f)) return false;
    for (auto* f : {f_ui.get(), f_kbd.get()}) {
        f->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
    }
    dwrite->CreateEllipsisTrimmingSign(f_small.get(), ellipsis_small.put());
    return true;
}

bool OverlayWindow::Impl::create(std::string* error) {
    auto fail = [&](const char* what) {
        if (error) *error = what;
        return false;
    };
    if (FAILED(D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, d2d.put()))) return fail("D2D1CreateFactory failed");
    if (FAILED(DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory),
                                   reinterpret_cast<IUnknown**>(dwrite.put())))) {
        return fail("DWriteCreateFactory failed");
    }
    if (!create_text_formats()) return fail("CreateTextFormat failed");
    const D2D1_STROKE_STYLE_PROPERTIES sp = D2D1::StrokeStyleProperties(
        D2D1_CAP_STYLE_ROUND, D2D1_CAP_STYLE_ROUND, D2D1_CAP_STYLE_ROUND, D2D1_LINE_JOIN_ROUND);
    if (FAILED(d2d->CreateStrokeStyle(sp, nullptr, 0, round_stroke.put()))) return fail("CreateStrokeStyle failed");

    const HINSTANCE inst = GetModuleHandleW(nullptr);
    WNDCLASSEXW wc{};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = &Impl::wndproc;
    wc.hInstance = inst;
    wc.hCursor = LoadCursorW(nullptr, reinterpret_cast<LPCWSTR>(IDC_ARROW));
    wc.lpszClassName = L"RealTimeAI.Overlay";
    RegisterClassExW(&wc); // ERROR_CLASS_ALREADY_EXISTS is fine

    int x = 0, y = 0;
    load_state(x, y);
    DWORD ex_style = WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_NOACTIVATE;
    if (opts.stealth_dock) {
        ex_style |= WS_EX_TOOLWINDOW;
    } else {
        ex_style |= WS_EX_APPWINDOW;
    }
    if (opts.stealth_click_through) {
        ex_style |= WS_EX_TRANSPARENT;
    }
    hwnd = CreateWindowExW(ex_style, wc.lpszClassName,
                           L"RealTimeAI", WS_POPUP, x, y, static_cast<int>(width), 120, nullptr, nullptr, inst, this);
    if (!hwnd) return fail("CreateWindowEx failed");

    dpi = GetDpiForWindow(hwnd);
    if (dpi == 0) dpi = 96;
    scale = static_cast<float>(dpi) / 96.0f;
    {
        std::lock_guard<std::mutex> lk(hwnd_mu);
        hwnd_for_post = hwnd;
    }
    const HWND target = hwnd;
    queue.set_wake([target] { PostMessageW(target, WM_APP_DRAIN, 0, 0); });

    // Invisibilidade no compartilhamento de tela (Win10 2004+, Req 11.1).
    // Aplicada aqui na criação — muito dentro dos 500 ms exigidos. Em sucesso
    // registramos capture_excluded (observável, Req 11.5). Se a API não existe
    // (Windows antigo) ou a chamada falha (Req 11.4), publicamos um aviso e
    // seguimos com a janela totalmente operacional, sem alterar a interação do
    // HUD.
    using SetWDAFn = BOOL(WINAPI*)(HWND, DWORD);
    auto set_wda = reinterpret_cast<SetWDAFn>(
        GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetWindowDisplayAffinity"));
    const DWORD affinity = opts.stealth_screen_capture ? 0x00000011 /* WDA_EXCLUDEFROMCAPTURE */ : 0;
    if (set_wda && set_wda(hwnd, affinity)) {
        capture_excluded = true; // Req 11.5
    } else {
        capture_excluded = false;
        // Req 11.4: aviso não-bloqueante; a janela permanece operacional.
        set_notice(NoticeLevel::Warning,
                   "Capture exclusion is not available on this Windows version: the HUD may "
                   "show up in screen shares.",
                   false);
    }

    // Layered window provides crisp rounded floating panels via per-pixel alpha
    // without a rectangular DWM blur box behind the transparent gaps.

    register_hotkeys();
    SetTimer(hwnd, kTimerClock, 1000, nullptr);
    SetTimer(hwnd, kTimerAnim, 16, nullptr);
    // Top-Center anchoring (Req 1.1, 1.4, 1.5, 1.9). load_state() left the
    // window at the persisted top-left (or primary-centered when none); using
    // that as the persisted center lets resolve_anchor pick the monitor that
    // contains it and re-center Top-Center on that monitor's work area, falling
    // back to the primary when the center is off every monitor.
    reposition(/*use_persisted=*/!opts.settings_file.empty());
    render(); // first frame (sets the layered bitmap and size)
    ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    return true;
}

void OverlayWindow::Impl::register_hotkeys() {
    struct Key { int id; UINT mods; UINT vk; const char* name; };
    // Ctrl+Alt scheme: the base MOD_CONTROL | MOD_ALT is added to each entry's
    // extra mods below.
    const Key keys[] = {
        {kHkAnswer, 0, VK_RETURN, "Enter"}, {kHkShot, 0, 'S', "S"}, {kHkChat, 0, 'K', "K"},
        {kHkPrev, 0, VK_LEFT, "Left arrow"}, {kHkNext, 0, VK_RIGHT, "Right arrow"}, {kHkRecap, 0, 'R', "R"},
        {kHkPause, 0, 'P', "P"}, {kHkClearAnswers, 0, VK_BACK, "Backspace"},
        {kHkClearStrip, MOD_SHIFT, VK_BACK, "Shift+Backspace"}, {kHkHide, 0, 'H', "H"}, {kHkClick, 0, 'T', "T"},
        {kHkConfig, 0, 'O', "O"},
        // [Tab]: promote the next queued suggestion into the visible card and
        // clear the "nova pergunta" pill (Req 9.3). Kept under the shared
        // Ctrl+Alt modifier scheme so it never steals a bare Tab from the
        // interview app.
        {kHkTab, 0, VK_TAB, "Tab"},
        {kHkMode, 0, 'M', "M"},
        {kHkQuit, 0, 'Q', "Q"}};
    std::string failed;
    for (const auto& k : keys) {
        if (!RegisterHotKey(hwnd, k.id, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT | k.mods, k.vk)) {
            failed += failed.empty() ? "" : ", ";
            failed += "Ctrl+Alt+";
            failed += k.name;
        }
    }
    // Req 12 combos: discreet, under MOD_ALT (and MOD_CONTROL for Ctrl+Espaço),
    // with the full modifier set carried in `mods` (plus MOD_NOREPEAT). A
    // failure here names the full conflicting shortcut and leaves the others
    // registered (Req 12.10).
    const Key req12[] = {
        {kHkAnswerNow, MOD_ALT, VK_SPACE, "Alt+Space"},
        {kHkAnswerNow2, MOD_CONTROL, VK_SPACE, "Ctrl+Space"},
        {kHkHistPrev, MOD_ALT, VK_UP, "Alt+Up"},
        {kHkHistNext, MOD_ALT, VK_DOWN, "Alt+Down"},
        {kHkQuick1, MOD_ALT, '1', "Alt+1"},
        {kHkQuick2, MOD_ALT, '2', "Alt+2"},
        {kHkQuick3, MOD_ALT, '3', "Alt+3"},
        {kHkPanic, MOD_ALT, 'H', "Alt+H"}};
    for (const auto& k : req12) {
        if (!RegisterHotKey(hwnd, k.id, k.mods | MOD_NOREPEAT, k.vk)) {
            failed += failed.empty() ? "" : ", ";
            failed += k.name;
        }
    }
    if (!failed.empty()) set_notice(NoticeLevel::Warning, "Shortcut " + failed + " is already used by another app", false);
}

void OverlayWindow::Impl::unregister_hotkeys() {
    for (int id = kHkAnswer; id < kHkLast; ++id) UnregisterHotKey(hwnd, id);
}

void OverlayWindow::Impl::load_state(int& x, int& y) { // Req 1 persistence
    RECT work{};
    SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
    const float work_width = std::max(320.0f, static_cast<float>(work.right - work.left) / scale);
    const float max_fitting_width = std::max(320.0f, work_width - 16.0f);
    auto centered_top = [&] {
        x = (work.left + work.right) / 2 - static_cast<int>(width) / 2;
        y = work.top + ui::clamp_anchor_top(); // topo em [8,10] DIP — zona foveal da webcam (Req 1.1)
    };
    width = std::min(ui::clamp_width(width), max_fitting_width);
    if (opts.settings_file.empty()) {
        width = std::min(kHudW, max_fitting_width);
        centered_top();
        return;
    }
    const wchar_t* f = opts.settings_file.c_str();
    const int sw = static_cast<int>(GetPrivateProfileIntW(L"overlay", L"largura", 0, f));
    if (sw >= static_cast<int>(kMinW) && sw <= static_cast<int>(kMaxW))
        width = std::min(static_cast<float>(sw), max_fitting_width);
    else
        width = std::min(kHudW, max_fitting_width);
    collapsed = GetPrivateProfileIntW(L"overlay", L"recolhido", 0, f) != 0;
    centered_top();
    const int sx = static_cast<int>(GetPrivateProfileIntW(L"overlay", L"x", INT_MIN, f));
    const int sy = static_cast<int>(GetPrivateProfileIntW(L"overlay", L"y", INT_MIN, f));
    if (sx == INT_MIN || sy == INT_MIN) return;
    if (MonitorFromPoint(POINT{sx + 40, sy + 20}, MONITOR_DEFAULTTONULL)) { // still on a connected monitor
        x = sx;
        y = sy;
    }
}

void OverlayWindow::Impl::save_state() {
    if (opts.settings_file.empty() || !hwnd) return;
    RECT r{};
    if (!GetWindowRect(hwnd, &r)) return;
    const wchar_t* f = opts.settings_file.c_str();
    WritePrivateProfileStringW(L"overlay", L"x", std::to_wstring(r.left).c_str(), f);
    WritePrivateProfileStringW(L"overlay", L"y", std::to_wstring(r.top).c_str(), f);
    WritePrivateProfileStringW(L"overlay", L"largura", std::to_wstring(static_cast<int>(width)).c_str(), f);
    WritePrivateProfileStringW(L"overlay", L"recolhido", collapsed ? L"1" : L"0", f);
}

float OverlayWindow::Impl::work_height_dip() const {
    HMONITOR mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    MONITORINFO mi{};
    mi.cbSize = sizeof(mi);
    float h = 800.0f;
    if (GetMonitorInfoW(mon, &mi)) h = static_cast<float>(mi.rcWork.bottom - mi.rcWork.top) / scale;
    return std::max(360.0f, h);
}

// Top-Center anchoring through the pure rtai::ui::resolve_anchor. All the
// Win32-specific bits — querying monitors, converting POINT/RECT — live here;
// the placement math (centering, the 8..10 DIP top band, monitor selection,
// off-monitor fallback) is the shared, unit-tested core (Req 1.1, 1.4, 1.5, 1.9).
//
// Win32 RECT {left,top,right,bottom} maps field-for-field onto ui::UiRect, and
// POINT {x,y} onto ui::UiPoint, so the conversions below are plain copies. Work
// areas are converted to DIP (divided by `scale`) before entering the pure math
// and the resulting DIP position is scaled back to physical pixels for SetWindowPos.
void OverlayWindow::Impl::reposition(bool use_persisted) {
    if (!hwnd) return;

    auto rect_to_dip = [&](const RECT& r) {
        return ui::UiRect{static_cast<int>(std::lround(r.left / scale)),
                          static_cast<int>(std::lround(r.top / scale)),
                          static_cast<int>(std::lround(r.right / scale)),
                          static_cast<int>(std::lround(r.bottom / scale))};
    };

    // Primary monitor work area (DIP): resolve_anchor falls back to it when
    // there is no persisted center or the center sits off every monitor.
    ui::UiRect primary_work{0, 0, 1280, 800};
    if (HMONITOR prim = MonitorFromPoint(POINT{0, 0}, MONITOR_DEFAULTTOPRIMARY)) {
        MONITORINFO mi{};
        mi.cbSize = sizeof(mi);
        if (GetMonitorInfoW(prim, &mi)) primary_work = rect_to_dip(mi.rcWork);
    }

    // monitor_of(center): work area of the monitor containing the persisted
    // center in DIP, or nullopt when the center is off every monitor
    // (MONITOR_DEFAULTTONULL). Wired to MonitorFromPoint + GetMonitorInfo.
    auto monitor_of = [&](ui::UiPoint center) -> std::optional<ui::UiRect> {
        POINT p{static_cast<LONG>(std::lround(center.x * scale)),
                static_cast<LONG>(std::lround(center.y * scale))};
        HMONITOR mon = MonitorFromPoint(p, MONITOR_DEFAULTTONULL);
        if (!mon) return std::nullopt;
        MONITORINFO mi{};
        mi.cbSize = sizeof(mi);
        if (!GetMonitorInfoW(mon, &mi)) return std::nullopt;
        return rect_to_dip(mi.rcWork);
    };

    // The persisted center is the center of the current window rect in DIP.
    std::optional<ui::UiPoint> persisted;
    if (use_persisted) {
        RECT wr{};
        if (GetWindowRect(hwnd, &wr)) {
            persisted = ui::UiPoint{static_cast<int>(std::lround(((wr.left + wr.right) / 2.0) / scale)),
                                    static_cast<int>(std::lround(((wr.top + wr.bottom) / 2.0) / scale))};
        }
    }

    const ui::AnchorResult a = ui::resolve_anchor(persisted, width, primary_work, monitor_of);
    anchor_work_h = std::max(360.0f, static_cast<float>(a.work_area.height()));

    SetWindowPos(hwnd, HWND_TOPMOST, static_cast<int>(std::lround(a.x_dip * scale)),
                 static_cast<int>(std::lround(a.y_dip * scale)), 0, 0,
                 SWP_NOSIZE | SWP_NOACTIVATE);
}

// ---------------------------------------------------------------------------
// Device resources
// ---------------------------------------------------------------------------

bool OverlayWindow::Impl::ensure_device() {
    if (rt) return true;
    const D2D1_RENDER_TARGET_PROPERTIES props = D2D1::RenderTargetProperties(
        D2D1_RENDER_TARGET_TYPE_DEFAULT, D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_PREMULTIPLIED),
        0.0f, 0.0f, D2D1_RENDER_TARGET_USAGE_NONE, D2D1_FEATURE_LEVEL_DEFAULT);
    if (FAILED(d2d->CreateDCRenderTarget(&props, rt.put()))) return false;
    if (FAILED(rt->CreateSolidColorBrush(pal.text, brush.put()))) {
        rt.reset();
        return false;
    }
    // ClearType needs an opaque background; per-pixel alpha => grayscale AA.
    rt->SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
    return true;
}

void OverlayWindow::Impl::discard_device() {
    brush.reset();
    rt.reset();
}

bool OverlayWindow::Impl::ensure_surface(int w, int h) {
    if (mem_dc && dib && w <= dib_w && h <= dib_h) return true;
    release_surface();
    HDC screen = GetDC(nullptr);
    BITMAPINFO bmi{};
    bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bmi.bmiHeader.biWidth = w;
    bmi.bmiHeader.biHeight = -h; // top-down
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;
    void* bits = nullptr;
    dib = CreateDIBSection(screen, &bmi, DIB_RGB_COLORS, &bits, nullptr, 0);
    mem_dc = CreateCompatibleDC(screen);
    ReleaseDC(nullptr, screen);
    if (!dib || !mem_dc) {
        release_surface();
        return false;
    }
    old_bitmap = SelectObject(mem_dc, dib);
    dib_w = w;
    dib_h = h;
    return true;
}

void OverlayWindow::Impl::release_surface() {
    if (mem_dc) {
        if (old_bitmap) SelectObject(mem_dc, old_bitmap);
        DeleteDC(mem_dc);
    }
    if (dib) DeleteObject(dib);
    mem_dc = nullptr;
    dib = nullptr;
    old_bitmap = nullptr;
    dib_w = dib_h = 0;
}

// ---------------------------------------------------------------------------
// Model updates (UI thread)
// ---------------------------------------------------------------------------

void OverlayWindow::Impl::set_notice(NoticeLevel lvl, std::string text, bool from_lane) {
    notice = std::move(text);
    notice_level = lvl;
    notice_from_lane = from_lane;
    notice_at = std::chrono::steady_clock::now();
}

void OverlayWindow::Impl::drain() {
    auto events = queue.drain();
    // Req 5.2/5.3: the UI_Bridge pushes the first visible delta of a generation
    // (and a commit) to the HUD immediately, and coalesces every subsequent
    // delta of the same generation into the 16 ms render timer (<=1 render per
    // 16 ms, 60 fps). We apply the whole batch first so a single render reflects
    // every model change, then render once synchronously if any event in the
    // batch demanded the immediate push; otherwise we fall back to the coalesced
    // frame.
    bool force_immediate = false;
    for (auto& e : events) force_immediate = apply(e) || force_immediate;
    if (events.empty()) return;
    if (force_immediate) {
        // Immediate push: cancel any pending coalesced frame and present now, so
        // the first token / commit is visible within this drain (Req 5.2).
        if (render_pending) {
            KillTimer(hwnd, kTimerRender);
            render_pending = false;
        }
        render();
    } else {
        invalidate(); // coalesce into one frame per 16 ms (Req 5.3)
    }
}

bool OverlayWindow::Impl::apply(EngineEvent& ev) {
    bool force_immediate = false;
    std::visit(
        [&](auto& e) {
            using T = std::decay_t<decltype(e)>;
            if constexpr (std::is_same_v<T, LaneStatusEvent>) {
                auto& lane = lanes[static_cast<std::size_t>(e.status.source)];
                lane.state = e.status.state;
                lane.detail = e.status.detail;
                const std::string who = speaker_label(e.status.source);
                if (e.status.state == LinkState::Error) {
                    set_notice(NoticeLevel::Error, "Deepgram (" + who + "): " + e.status.detail, true);
                } else if (e.status.state == LinkState::Connected && notice_from_lane) {
                    notice.clear();
                }
            } else if constexpr (std::is_same_v<T, TranscriptUpdateEvent>) {
                strip.on_update(e.source, e.text, e.turn_closed);
            } else if constexpr (std::is_same_v<T, SuggestionStartedEvent>) {
                // Pin on Speak (Req 9.2, 9.5): the engine owns the decision of
                // whether this suggestion may replace the visible card. When it
                // flags enqueue=true (user speaking or still inside the 4000 ms
                // window) we buffer the event on the FIFO (cap 5) and raise the
                // "nova pergunta" pill instead of swapping the card. When the
                // window later expires without speech, the engine republishes
                // the released pending with enqueue=false (Req 9.6), which falls
                // through to start_suggestion below and promotes the card — so
                // there is no card-side 4000 ms timer here anymore.
                if (e.enqueue) {
                    pending_queue.push(e);
                    pending_question = true;
                    pending_question_text = e.trigger_text;
                    return;
                }
                start_suggestion(e);
            } else if constexpr (std::is_same_v<T, AutoAnswerStateEvent>) {
                auto_answer_on = e.enabled;
            } else if constexpr (std::is_same_v<T, TranscriptionModeEvent>) {
                transcription_only = e.enabled;
            } else if constexpr (std::is_same_v<T, OverlayModeEvent>) {
                // Cold_Path double-success (Req 8.3/9.1): switch to the Jev
                // Dashboard and keep the report for rendering. Rebuild the pure
                // ring model (fixed order/colour, precomputed target angle, Req
                // 9.1/9.3) and reset each animated sweep to 0 so anim_tick grows
                // theta from 0 -> target_theta_deg over the 16 ms frames (Req
                // 9.2). We ONLY change what is drawn here — no WS_EX_* nor
                // SetWindowDisplayAffinity touch, so no-focus-steal and capture
                // exclusion are preserved exactly as the HUD set them (Req 9.6).
                mode_ = e.mode;
                if (mode_ == OverlayMode::PostInterviewReport) {
                    report_ = std::move(e.report);
                    ring_specs_ = build_rings(report_.scores);
                    ring_theta_cur_ = {0.0f, 0.0f, 0.0f};
                    // Collapsing/chat state is irrelevant to the dashboard; make
                    // sure it is visible and force an immediate first frame so the
                    // dashboard appears within the ~300 ms budget (Req 9.5).
                    collapsed = false;
                    force_immediate = true;
                }
            } else if constexpr (std::is_same_v<T, SpeculativeCandidateEvent>) {
                // show generating hint while shadow streams silently
                (void)e;
            } else if constexpr (std::is_same_v<T, SpeculativeHitEvent>) {
                // Commit (Speculating -> Committed): the engine promotes the
                // hidden shadow buffer as the first visible content. Push it to
                // the HUD immediately rather than waiting for the next frame
                // (Req 5.2), so the perceived time-to-first-token is ~0.
                (void)e;
                force_immediate = true;
            } else if constexpr (std::is_same_v<T, SpeculativeMissEvent>) {
                (void)e;
            } else if constexpr (std::is_same_v<T, SuggestionDeltaEvent>) {
                for (auto it = history.rbegin(); it != history.rend(); ++it) {
                    if (it->id == e.id) {
                        // Req 5.2: the FIRST visible delta of this generation
                        // (the card's got_delta flips false -> true) forces an
                        // immediate render; later deltas of the same card are
                        // coalesced by the 16 ms render timer (Req 5.3).
                        if (!it->got_delta) force_immediate = true;
                        // Req 6.2/6.5: confirm only whole words. commit_words moves
                        // everything up to the last word separator into `committed`
                        // and retains the trailing partial word in `pending`, so a
                        // half word never shows at the card edge. The render path
                        // reads `body`, which mirrors the committed text.
                        it->stream.commit_words(e.text);
                        // The "PERGUNTA:" header becomes the card title and
                        // never shows in the body read aloud.
                        apply_interpreted(*it, it->stream.committed, false);
                        if (it->body.empty()) break; // header still streaming
                        it->got_delta = true;
                        it->waiting = false; // a delta arrived: clear the 5 s wait (Req 6.7)
                        break;
                    }
                }
            } else if constexpr (std::is_same_v<T, SuggestionDoneEvent>) {
                for (auto it = history.rbegin(); it != history.rend(); ++it) {
                    if (it->id == e.id) {
                        it->done = true;
                        it->status = e.status;
                        it->error = e.error;
                        it->ttft_ms = e.ttft_ms;
                        it->total_ms = e.total_ms;
                        it->waiting = false;
                        // Req 6.6: flush the retained tail so the final word (which may
                        // have had no trailing separator) becomes visible, making `body`
                        // byte-for-byte the concatenation of every delta received.
                        it->stream.complete();
                        if (!it->stream.full().empty()) {
                            apply_interpreted(*it, it->stream.full(), true);
                        }
                        if (it->body.empty()) it->body = e.text;
                        if (!e.interpreted_question.empty() && it->understood.empty()) {
                            it->understood = e.interpreted_question;
                            it->frozen = ui::freeze_question(it->understood, it->id);
                        }
                        // auto-generate follow-up questions for the side panel (lightweight local heuristic)
                        if (e.status == LlmStatus::Completed && !e.text.empty()) {
                            suggested_questions.clear();
                            auto qs = text::extract_questions(e.text);
                            if (qs.empty()) qs = text::extract_questions(it->trigger);
                            for (auto& q : qs) {
                                if (suggested_questions.size() >= 4) break;
                                q = text::trim(q);
                                if (q.size() >= 8) suggested_questions.push_back(q);
                            }
                            if (suggested_questions.empty() && !it->trigger.empty()) {
                                // fallback: make the trigger into a question chip
                                std::string t = text::trim(it->trigger);
                                if (!t.empty()) {
                                    if (t.back() != '?') t.push_back('?');
                                    suggested_questions.push_back(t);
                                }
                            }
                        }
                        break;
                    }
                }
            } else if constexpr (std::is_same_v<T, NoticeEvent>) {
                set_notice(e.level, std::move(e.text), false);
            } else if constexpr (std::is_same_v<T, PauseEvent>) {
                for (std::size_t i = 0; i < lanes.size(); ++i) {
                    if (e.source < 0 || static_cast<std::size_t>(e.source) == i) lanes[i].paused = e.paused;
                }
            }
        },
        ev);
    return force_immediate;
}

// Builds the visible answer card from a firing suggestion and appends it to
// the history. Replaces the card only when the engine has already decided the
// suggestion may do so (enqueue=false) — either a fresh suggestion that did not
// need pinning, or a released pending the engine republished when the 4000 ms
// window expired without speech (Req 9.6).
// Splits the "PERGUNTA:" header off the streamed answer: the understood
// question becomes the card title (Trigger Lock keeps the raw transcript in
// `trigger`), the rest is the body.
void OverlayWindow::Impl::apply_interpreted(SuggestionView& v, const std::string& raw, bool final) {
    InterpretedAnswer ia = split_interpreted_answer(raw, final);
    if (!ia.has_header) {
        v.body = raw;
        return;
    }
    if (ia.header_complete && !ia.question.empty() && v.understood != ia.question) {
        v.understood = ia.question;
        v.frozen = ui::freeze_question(v.understood, v.id);
    }
    v.body = std::move(ia.body);
}

void OverlayWindow::Impl::start_suggestion(SuggestionStartedEvent& e) {
    locked_trigger = e.trigger_text;
    locked_at = std::chrono::steady_clock::now();
    SuggestionView s;
    s.id = e.id;
    s.trigger = e.trigger_text; // keep copy in locked_trigger
    // Trigger Lock (Req 8.1, 8.4, 8.5): freeze the trigger verbatim in `full`,
    // drive `display` (<=280 code points + ellipsis), and flag absence
    // (present=false) for a blank/whitespace trigger. Done synchronously in the
    // drain, well within the 200 ms budget.
    s.frozen = ui::freeze_question(e.trigger_text, e.id);
    s.reason = e.reason;
    s.has_image = e.has_image;
    s.model = std::move(e.model);
    s.clock = local_hhmm();
    // Req 6.1: pre-allocate the card at the >=2-line minimum before the first
    // delta. Req 6.7: arm the 5 s no-delta timeout; anim_tick flips `waiting`
    // on without ever shrinking the pre-allocated height.
    s.card_h = kMinAnswerH;
    s.card_h_target = kMinAnswerH;
    s.started_at = std::chrono::steady_clock::now();
    s.got_delta = false;
    s.waiting = false;
    history.push_back(std::move(s));
    while (history.size() > kMaxHistory) {
        history.pop_front();
        if (cursor > 0) --cursor;
    }
    if (follow_latest || history.size() == 1) {
        cursor = history.size() - 1;
        follow_latest = true;
        scroll = 0.0f;
        user_scrolled = false;
    }
    if (collapsed) unseen_answer = true;
}

// Promotes the oldest queued suggestion into the visible card and removes the
// pill once the queue drains (Req 9.3, 9.6). Driven by [Tab] and by a click on
// the pill. No-op when nothing is queued.
void OverlayWindow::Impl::promote_next_pending() {
    if (pending_queue.empty()) {
        pending_question = false;
        return;
    }
    SuggestionStartedEvent next = std::move(pending_queue.pending.front());
    pending_queue.pending.pop_front();
    start_suggestion(next);
    // The pill mirrors the queue: it stays only while more questions wait.
    pending_question = !pending_queue.empty();
    if (!pending_question) pending_question_text.clear();
    else pending_question_text = pending_queue.pending.front().trigger_text;
}

void OverlayWindow::Impl::invalidate() {
    if (!hwnd || render_pending) return;
    render_pending = true;
    SetTimer(hwnd, kTimerRender, 16, nullptr); // coalesce bursts into one frame
}

// Meters, spinner, caret blink and delayed tooltips; cheap when idle.
void OverlayWindow::Impl::anim_tick() {
    if (hidden) return;
    bool dirty = false;
    // Dashboard ring sweep (Req 9.2): in PostInterviewReport each ring's current
    // theta eases from 0 toward its precomputed target_theta_deg on the same
    // 16 ms timer used for the card-growth/pulse animation. ui::approach returns
    // true while it is still moving, which keeps the frame dirty until all three
    // rings have reached their targets.
    if (mode_ == OverlayMode::PostInterviewReport) {
        for (std::size_t i = 0; i < ring_specs_.size(); ++i) {
            if (ui::approach(ring_theta_cur_[i], ring_specs_[i].target_theta_deg, 16.0f, 220.0f, 0.5f)) {
                dirty = true;
            }
        }
        if (dirty) invalidate();
        return; // the live HUD meters/cards are not drawn in dashboard mode
    }
    if (cb.poll_levels) {
        const OverlayLevels lv = cb.poll_levels();
        const float target[2] = {lv.voce, lv.outros};
        const bool speak[2] = {lv.voce_speaking, lv.outros_speaking};
        for (std::size_t i = 0; i < 2; ++i) {
            const float t = lanes[i].paused ? 0.0f : std::clamp(target[i], 0.0f, 1.0f);
            const float before = lanes[i].level;
            ui::approach(lanes[i].level, t, 50.0f, t > before ? 40.0f : 160.0f);
            if (std::fabs(lanes[i].level - before) > 0.01f || lanes[i].speaking != speak[i]) dirty = true;
            lanes[i].speaking = speak[i] && !lanes[i].paused;
        }
    }
    // Req 13.1: the Pulse_Bar wobbles at 60 fps while listening (system audio
    // active with a live level above the floor), so keep repainting even when
    // the smoothed level is momentarily steady.
    {
        const auto& sys = lanes[static_cast<std::size_t>(AudioSource::Loopback)];
        if (sys.enabled && !sys.paused && cb.poll_levels && sys.level > 0.01f) dirty = true;
    }

    SuggestionView* sv = history.empty() ? nullptr : &history[std::min(cursor, history.size() - 1)];
    const auto now = std::chrono::steady_clock::now();
    if (sv && !sv->done) dirty = true;    // streaming: keep repainting while generating
    if (sv) {
        // Req 6.7: 5 s after the start with no delta, show the waiting indicator
        // while holding the pre-allocated minimum height (never shrink).
        if (!sv->done && !sv->got_delta && !sv->waiting &&
            now - sv->started_at >= std::chrono::seconds(5)) {
            sv->waiting = true;
            dirty = true;
        }
        // Req 6.4: expand the card height toward the measured target in ~1-line
        // blocks with an ease-out of ~150 ms. render() sets card_h_target; here we
        // ease card_h toward it. approach() with tau≈150 ms gives the ease-out.
        if (ui::approach(sv->card_h, sv->card_h_target, 16.0f, 150.0f, 0.25f)) dirty = true;
        // Req 13.3: keep repainting while any line is still fading in (0->1 over
        // 200 ms), so the ramp is visible even after the suggestion completes.
        for (const auto& t : sv->line_appear) {
            if (now - t < std::chrono::milliseconds(200)) { dirty = true; break; }
        }
    }
    if (chat_focused || shot_busy) dirty = true;
    if (hover != kNone && now - hover_since > std::chrono::milliseconds(550) &&
        now - hover_since < std::chrono::milliseconds(700)) {
        dirty = true; // tooltip appears
    }
    if (dirty) invalidate();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

void OverlayWindow::Impl::toggle_source(AudioSource s) {
    auto& lane = lanes[static_cast<std::size_t>(s)];
    if (!lane.enabled) {
        set_notice(NoticeLevel::Info,
                   std::string(s == AudioSource::Microphone ? "Microphone" : "System audio") +
                       " is turned off in Settings > General.",
                   false);
        invalidate();
        return;
    }
    lane.paused = !lane.paused;
    if (cb.on_pause_source) cb.on_pause_source(static_cast<int>(s), lane.paused);
    invalidate();
}

void OverlayWindow::Impl::toggle_pause_all() {
    const bool any_running = std::any_of(lanes.begin(), lanes.end(), [](const LaneView& l) { return l.enabled && !l.paused; });
    for (auto& l : lanes) l.paused = any_running;
    if (cb.on_pause) cb.on_pause(any_running);
    invalidate();
}

void OverlayWindow::Impl::go_prev() {
    if (!history.empty() && cursor > 0) {
        --cursor;
        follow_latest = false;
        scroll = 0.0f;
        user_scrolled = false;
        invalidate();
    }
}

void OverlayWindow::Impl::go_next() {
    if (!history.empty() && cursor + 1 < history.size()) {
        ++cursor;
        follow_latest = (cursor + 1 == history.size());
        scroll = 0.0f;
        user_scrolled = false;
        invalidate();
    }
}

void OverlayWindow::Impl::clear_answers() {
    history.clear();
    cursor = 0;
    follow_latest = true;
    scroll = 0.0f;
    user_scrolled = false;
    // Drop any queued "nova pergunta" with the cleared answers so the pill does
    // not outlive the cards it referred to.
    pending_queue.pending.clear();
    pending_question = false;
    pending_question_text.clear();
    if (cb.on_clear_chat) cb.on_clear_chat();
}

// Hide the HUD, wait a frame for DWM, grab the monitor, show again, and
// encode + send on a worker thread.
void OverlayWindow::Impl::start_screenshot() {
    if (shot_busy) return;
    if (!opts.llm_enabled) {
        set_notice(NoticeLevel::Warning, "Screenshot needs the OpenRouter key ([llm] api_key).", false);
        return;
    }
    shot_busy = true;
    shot_text = narrow(to_w(edit.text()));
    if (!shot_text.empty()) edit.clear();
    if (chat_focused) blur_chat(true);
    ShowWindow(hwnd, SW_HIDE);
    SetTimer(hwnd, kTimerShot, 150, nullptr);
}

void OverlayWindow::Impl::finish_screenshot() {
    KillTimer(hwnd, kTimerShot);
    std::string err;
    auto img = capture_monitor(hwnd, 1600, &err);
    if (!hidden) ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    if (!img) {
        shot_busy = false;
        set_notice(NoticeLevel::Error, "Screenshot failed: " + err, false);
        invalidate();
        return;
    }
    auto send = cb.on_screenshot; // copies: the worker never touches Impl
    std::string text = std::move(shot_text);
    HWND notify = hwnd;
    std::thread([img = std::move(*img), send, text, notify]() mutable {
        std::string e;
        auto url = encode_jpeg_data_url(img, 0.82f, &e);
        if (url && send) send(std::move(*url), text);
        // The window may be gone; PostMessage to a dead HWND is harmless.
        PostMessageW(notify, WM_APP_SHOT_DONE, url ? 1 : 0, 0);
    }).detach();
}

void OverlayWindow::Impl::open_chat(bool focus) {
    if (!opts.llm_enabled) {
        set_notice(NoticeLevel::Warning, "Chat needs the OpenRouter key: add it in Settings > General.", false);
        return;
    }
    chat_open = true;
    if (collapsed) collapsed = false;
    if (focus) focus_chat();
}

void OverlayWindow::Impl::focus_chat() {
    const HWND fg = GetForegroundWindow();
    if (fg && fg != hwnd) prev_foreground = fg;
    LONG_PTR ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex & ~static_cast<LONG_PTR>(WS_EX_NOACTIVATE));
    SetForegroundWindow(hwnd);
    SetFocus(hwnd);
    chat_focused = true;
    caret_t0 = std::chrono::steady_clock::now();
}

void OverlayWindow::Impl::blur_chat(bool restore_previous) {
    if (!chat_focused) return;
    chat_focused = false;
    // Zero-Focus-Steal: drop the keyboard focus by reinstating WS_EX_NOACTIVATE
    // first. From here the HUD no longer retains focus regardless of what the
    // restore attempt below does, so every exit path leaves the HUD passive
    // (Req 10.5, 10.6, 10.7).
    LONG_PTR ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE);

    // Restore the previously-focused app window (Req 10.5). SetForegroundWindow
    // returns 0 on failure; when it fails we do NOT retry or keep focus on the
    // HUD (WS_EX_NOACTIVATE is already back), and we surface a Warning notice so
    // the user knows the restore did not happen (Req 10.6). When no previous
    // window was registered, we simply release focus and transfer it nowhere
    // (Req 10.7).
    if (restore_previous && prev_foreground && IsWindow(prev_foreground)) {
        if (!SetForegroundWindow(prev_foreground)) {
            set_notice(NoticeLevel::Warning, "Could not return focus to the previous window.", false);
        }
    }
    prev_foreground = nullptr;
    SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE); // stay above it
}

void OverlayWindow::Impl::send_chat() {
    const std::string text = text::trim(narrow(to_w(edit.text())));
    if (text.empty()) return;
    edit.clear();
    chat_scroll_x = 0.0f;
    follow_latest = true;
    if (cb.on_chat) cb.on_chat(text);
    blur_chat(true);
}

void OverlayWindow::Impl::set_click_through(bool on) {
    click_through = on;
    LONG_PTR ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    ex = on ? (ex | WS_EX_TRANSPARENT) : (ex & ~static_cast<LONG_PTR>(WS_EX_TRANSPARENT));
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex);
    set_notice(NoticeLevel::Info,
               on ? "Click-through on: the HUD ignores clicks (Ctrl+Alt+T to turn off)." : "Click-through off.",
               false);
}

void OverlayWindow::Impl::toggle_hidden() {
    hidden = !hidden;
    if (hidden && chat_focused) blur_chat(true);
    ShowWindow(hwnd, hidden ? SW_HIDE : SW_SHOWNOACTIVATE);
    if (!hidden) SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

// Modo_Panic (Alt+H, Req 12.8/12.9): toggle the Stealth collapse.
//
// Activate (panic off -> on): snapshot the current window rect, release any
// chat focus, and shrink the window to an 8x8 DIP dot anchored at the current
// top-left. SetWindowPos with SWP_NOREDRAW is a single, instant operation
// (<=50 ms) and the layered bitmap is left untouched, so the dot shows only
// the top-left 8x8 DIP of the last frame — effectively invisible. We mark
// `hidden` so the render path and anim_tick stop repainting the full card,
// which would otherwise resize the window back on the next frame.
//
// Deactivate (panic on -> off): restore the exact pre-panic rect and force a
// fresh render, which rebinds the layered bitmap to the full content. Both
// operations are O(1) and complete well under the 50 ms budget.
void OverlayWindow::Impl::toggle_panic() {
    if (!hwnd) return;
    if (!mode.panic) {
        // Activate.
        if (chat_focused) blur_chat(true);
        RECT r{};
        if (GetWindowRect(hwnd, &r)) {
            mode.pre_panic_rect = r;
            mode.have_rect = true;
        }
        mode.panic = true;
        hidden = true; // suppress renders that would resize us back up
        const int dot = std::max(1, static_cast<int>(std::lround(8.0f * scale)));
        SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, dot, dot,
                     SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOREDRAW);
    } else {
        // Deactivate: restore the previous geometry, then re-render.
        mode.panic = false;
        hidden = false;
        if (mode.have_rect) {
            SetWindowPos(hwnd, HWND_TOPMOST, mode.pre_panic_rect.left, mode.pre_panic_rect.top,
                         mode.pre_panic_rect.right - mode.pre_panic_rect.left,
                         mode.pre_panic_rect.bottom - mode.pre_panic_rect.top,
                         SWP_NOACTIVATE);
        }
        render(); // immediate repaint so the restore lands within the 50 ms budget
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
}

// Settings are always reachable. The overlay does not edit them itself: the
// app callback brings the dashboard forward on its Settings page (or, when the
// app runs on its own, opens the settings window). Saving there restarts the
// overlay with the new values.
void OverlayWindow::Impl::request_config() {
    if (cb.on_open_config) {
        cb.on_open_config();
        set_notice(NoticeLevel::Info, "Settings opened.", false);
    } else {
        set_notice(NoticeLevel::Error, "Could not open Settings.", false);
    }
}

void OverlayWindow::Impl::paste_into_chat() {
    if (!OpenClipboard(hwnd)) return;
    if (HANDLE h = GetClipboardData(CF_UNICODETEXT)) {
        if (const auto* p = static_cast<const wchar_t*>(GlobalLock(h))) {
            const std::wstring w(p);
            edit.insert(std::u16string(w.begin(), w.end()));
            GlobalUnlock(h);
        }
    }
    CloseClipboard();
}

// Keyboard while the chat field has focus. Returns true when handled.
bool OverlayWindow::Impl::chat_key(WPARAM vk) {
    const bool ctrl = (GetKeyState(VK_CONTROL) & 0x8000) != 0;
    switch (vk) {
        case VK_RETURN: send_chat(); return true;
        case VK_ESCAPE:
            chat_open = !edit.empty(); // Esc on an empty field closes it
            blur_chat(true);
            return true;
        case VK_BACK: ctrl ? edit.delete_word_back() : edit.backspace(); return true;
        case VK_DELETE: edit.del(); return true;
        case VK_LEFT: edit.left(); return true;
        case VK_RIGHT: edit.right(); return true;
        case VK_HOME: edit.home(); return true;
        case VK_END: edit.end(); return true;
        default: break;
    }
    if (ctrl && vk == 'A') {
        edit.select_all();
        return true;
    }
    if (ctrl && vk == 'V') {
        paste_into_chat();
        return true;
    }
    return false;
}

void OverlayWindow::Impl::on_hotkey(int id) {
    switch (id) {
        case kHkAnswer: if (cb.on_suggest) cb.on_suggest(); follow_latest = true; break;
        case kHkShot: start_screenshot(); break;
        case kHkChat:
            if (hidden) toggle_hidden();
            open_chat(true);
            break;
        case kHkPrev: go_prev(); break;
        case kHkNext: go_next(); break;
        case kHkRecap: if (cb.on_recap) cb.on_recap(); break;
        case kHkPause: toggle_pause_all(); break;
        case kHkClearAnswers: clear_answers(); break;
        case kHkClearStrip: strip.clear(); break;
        case kHkHide: toggle_hidden(); break;
        case kHkClick: set_click_through(!click_through); break;
        case kHkConfig: request_config(); break;
        // [Tab]: show the next queued suggestion and drop the pill (Req 9.3).
        case kHkTab: promote_next_pending(); follow_latest = true; break;
        case kHkMode:
            if (cb.on_transcription_only_toggle) cb.on_transcription_only_toggle(!transcription_only);
            break;
        case kHkQuit: PostMessageW(hwnd, WM_CLOSE, 0, 0); break;
        // Resposta imediata (Alt+Espaço / Ctrl+Espaço, Req 12.1/12.2): com o
        // buffer do montador de turnos vazio, ignora e publica um Info; caso
        // contrário solicita uma resposta do buffer atual. O estado do buffer
        // vem do engine (is_buffer_empty) e cai para a strip de transcrição
        // quando o callback não está ligado.
        case kHkAnswerNow:
        case kHkAnswerNow2: {
            const bool empty = cb.is_buffer_empty ? cb.is_buffer_empty() : strip.empty();
            if (empty) {
                set_notice(NoticeLevel::Info, "Nothing to answer yet: speak or wait for the transcription.", false);
            } else {
                if (cb.on_suggest) cb.on_suggest();
                follow_latest = true;
            }
            break;
        }
        // Navegação de histórico (Alt+Seta Cima/Baixo, Req 12.3/12.4): no fim do
        // histórico mantém a resposta atual e publica um Info.
        case kHkHistPrev:
            if (!history.empty() && cursor > 0) go_prev();
            else set_notice(NoticeLevel::Info, "Start of history.", false);
            break;
        case kHkHistNext:
            if (!history.empty() && cursor + 1 < history.size()) go_next();
            else set_notice(NoticeLevel::Info, "End of history.", false);
            break;
        // Ações rápidas sobre a resposta atual (Alt+1/2/3, Req 12.5-12.7).
        case kHkQuick1: if (cb.on_quick_action) cb.on_quick_action(1); break;
        case kHkQuick2: if (cb.on_quick_action) cb.on_quick_action(2); break;
        case kHkQuick3: if (cb.on_quick_action) cb.on_quick_action(3); break;
        // Modo_Panic (Alt+H, Req 12.8/12.9): colapsa o HUD para um ponto de
        // 8x8 DIP em <=50 ms e, ao reacionar, restaura tamanho/posição
        // anteriores em <=50 ms.
        case kHkPanic: toggle_panic(); break;
        default: break;
    }
    invalidate();
}

void OverlayWindow::Impl::on_click(int id) {
    if (menu_open && id != kBtnMenu && (id < kMenuRecap || id > kMenuConfig)) menu_open = false;
    switch (id) {
        case kSrcOutros: toggle_source(AudioSource::Loopback); break;
        case kSrcVoce: toggle_source(AudioSource::Microphone); break;
        case kBtnAnswer:
            if (cb.on_suggest) cb.on_suggest();
            follow_latest = true;
            invalidate();
            break;
        case kBtnShot: case kQuickShot:
            start_screenshot();
            invalidate();
            break;
        case kBtnChat: case kQuickChat:
            if (chat_open && chat_focused) {
                if (edit.empty()) chat_open = false;
                blur_chat(true);
            } else {
                open_chat(true);
            }
            invalidate();
            break;
        case kBtnCollapse:
            collapsed = !collapsed;
            if (!collapsed) unseen_answer = false;
            if (collapsed && chat_focused) blur_chat(true);
            save_state();
            invalidate();
            break;
        case kBtnMenu: menu_open = !menu_open; break;
        case kBtnEnd: PostMessageW(hwnd, WM_CLOSE, 0, 0); break;
        case kMenuRecap: case kQuickRecap: menu_open = false; if (cb.on_recap) cb.on_recap(); break;
        case kMenuFollow: case kQuickFollow: menu_open = false; if (cb.on_followup) cb.on_followup(); break;
        case kMenuPause: menu_open = false; toggle_pause_all(); break;
        case kMenuClick: menu_open = false; set_click_through(true); break;
        case kMenuHide: menu_open = false; toggle_hidden(); break;
        case kMenuConfig: menu_open = false; request_config(); break;
        case kStripClear:
            strip.clear();
            invalidate();
            break;
        case kPrev:
            go_prev();
            break;
        case kNext:
            go_next();
            break;
        case kAnsClear:
            clear_answers();
            invalidate();
            break;
        case kAnsExpand:
            answer_expanded = !answer_expanded;
            invalidate();
            break;
        case kStyleConcise:
            selected_style = 0;
            if (cb.on_chat) cb.on_chat("Resuma a resposta de forma concisa e direta ao ponto.");
            invalidate();
            break;
        case kStyleDetailed:
            selected_style = 1;
            if (cb.on_chat) cb.on_chat("Detalhe a resposta tecnicamente com foco em arquitetura e trade-offs.");
            invalidate();
            break;
        case kStyleStar:
            selected_style = 2;
            if (cb.on_chat) cb.on_chat("Formule a resposta estritamente no formato STAR (Situação, Tarefa, Ação, Resultado).");
            invalidate();
            break;
        case kChipPickBase:
            if (cb.on_chat) cb.on_chat("Reforce a resposta anterior focando na estrutura STAR.");
            break;
        case kChipPickBase + 1:
            if (cb.on_chat) cb.on_chat("Quais foram os impactos quantitativos e métricas mensuráveis desse resultado?");
            break;
        case kChipPickBase + 2:
            if (cb.on_chat) cb.on_chat("Explique os principais trade-offs técnicos e arquiteturais considerados.");
            break;
        case kChipPickBase + 3:
            if (cb.on_chat) cb.on_chat("Dê um exemplo prático de código ou implementação dessa solução.");
            break;
        case kFollowUpRowBase:
            if (cb.on_chat) cb.on_chat("Como você mensurou as métricas de sucesso dessa entrega na prática?");
            break;
        case kFollowUpRowBase + 1:
            if (cb.on_chat) cb.on_chat("Quais foram os principais desafios técnicos de concorrência ou escala?");
            break;
        case kCopy: {
            if (history.empty()) break;
            const auto& sv = history[std::min(cursor, history.size() - 1)];
            std::wstring w = widen(sv.body);
            if (OpenClipboard(hwnd)) {
                EmptyClipboard();
                if (HGLOBAL g = GlobalAlloc(GMEM_MOVEABLE, (w.size() + 1) * sizeof(wchar_t))) {
                    if (void* p = GlobalLock(g)) {
                        std::copy(w.c_str(), w.c_str() + w.size() + 1, static_cast<wchar_t*>(p));
                        GlobalUnlock(g);
                        if (!SetClipboardData(CF_UNICODETEXT, g)) GlobalFree(g);
                    } else {
                        GlobalFree(g);
                    }
                }
                CloseClipboard();
                copied_at = std::chrono::steady_clock::now();
            }
            break;
        }
        case kVoteUp: case kVoteDown: {
            if (history.empty()) break;
            auto& sv = history[std::min(cursor, history.size() - 1)];
            const int v = id == kVoteUp ? 1 : -1;
            sv.vote = sv.vote == v ? 0 : v;
            if (cb.on_rate) cb.on_rate(sv.id, sv.vote);
            break;
        }
        case kChatField: focus_chat(); break;
        case kChatSend: send_chat(); break;
        case kChatClose:
            chat_open = false;
            blur_chat(true);
            break;
        case kTabSuggested: answer_tab = 0; user_scrolled = false; scroll = 0; break;
        case kTabTranscript: answer_tab = 1; user_scrolled = false; scroll = 0; break;
        case kToggleAuto: {
            auto_answer_on = !auto_answer_on;
            if (cb.on_auto_toggle) cb.on_auto_toggle(auto_answer_on);
            break;
        }
        case kToggleTranscriptionOnly: {
            if (cb.on_transcription_only_toggle) cb.on_transcription_only_toggle(!transcription_only);
            break;
        }
        case kActionRecap: if (cb.on_recap) cb.on_recap(); break;
        case kActionFollow: if (cb.on_followup) cb.on_followup(); break;
        case kActionAsk:
            if (cb.on_suggested_pick && !suggested_questions.empty()) cb.on_suggested_pick(suggested_questions[0]);
            else open_chat(true);
            break;
        case kNotice: notice.clear(); break;
        // Clicking the "nova pergunta" pill promotes the next queued suggestion,
        // same as [Tab] (Req 9.3).
        case kBtnNextQuestion: promote_next_pending(); follow_latest = true; break;
        default:
            if (id >= kChipPickBase && id < kChipPickBase + 8) {
                int idx = id - kChipPickBase;
                if (idx >=0 && idx < (int)suggested_questions.size() && cb.on_suggested_pick)
                    cb.on_suggested_pick(suggested_questions[idx]);
                else if (cb.on_suggested_pick && !history.empty()) {
                    const auto& sv2 = history[std::min(cursor,history.size()-1)];
                    auto qs2 = text::extract_questions(sv2.body);
                    if (qs2.empty()) qs2 = text::extract_questions(sv2.trigger);
                    if (idx >=0 && idx < (int)qs2.size()) cb.on_suggested_pick(qs2[idx]);
                }
            } else if (id >= kSuggestedAskBase && id < kSuggestedAskBase + 8) {
                int idx = id - kSuggestedAskBase;
                if (idx >=0 && idx < (int)suggested_questions.size() && cb.on_suggested_pick)
                    cb.on_suggested_pick(suggested_questions[idx]);
            }
            break;
    }
    invalidate();
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

ComPtr<IDWriteTextLayout> OverlayWindow::Impl::layout(const std::wstring& s, IDWriteTextFormat* fmt, float max_w,
                                                      float max_h) const {
    // Layout cache (Req 14.4/14.5). The cache key identifies a logical text
    // block: the same (format, max width, max height, text) always describes
    // the same block, so while none of those change between frames we hand back
    // the stored IDWriteTextLayout untouched instead of recreating it. The key
    // encodes the format pointer, the two clamp dimensions and the text itself.
    const float w = std::max(1.0f, max_w);
    char head[64];
    std::snprintf(head, sizeof(head), "%p|%.1f|%.1f|", static_cast<const void*>(fmt), w, max_h);
    std::string key(head);
    key += narrow(s);

    auto it = layout_cache.find(key);
    if (it != layout_cache.end() && it->second.valid && it->second.layout) {
        // Req 14.4: identical block between frames reuses the cached layout.
        it->second.used = true;
        return it->second.layout;
    }

    ComPtr<IDWriteTextLayout> l;
    const HRESULT hr =
        dwrite->CreateTextLayout(s.c_str(), static_cast<UINT32>(s.size()), fmt, w, max_h, l.put());
    if (FAILED(hr) || !l) {
        // Req 14.5: keep the last valid cached layout for this block and flag
        // the frame so render() both logs the error and preserves the previous
        // frame (set_notice is non-const, so render() surfaces it).
        layout_failed = true;
        if (it != layout_cache.end() && it->second.layout) return it->second.layout;
        return {};
    }
    layout_cache[key] = LayoutCacheEntry{s, w, l, true, true};
    return l;
}

// Single line, ellipsis when too long. Uses a dedicated max_h (39.5f) so its
// cache entry never collides with multi-line layout() calls.
ComPtr<IDWriteTextLayout> OverlayWindow::Impl::line_layout(const std::wstring& s, IDWriteTextFormat* fmt,
                                                           float max_w) const {
    auto l = layout(s, fmt, max_w, 39.5f);
    if (l) {
        l->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
        DWRITE_TRIMMING trim{DWRITE_TRIMMING_GRANULARITY_CHARACTER, 0, 0};
        l->SetTrimming(&trim, ellipsis_small.get());
    }
    return l;
}

ComPtr<IDWriteTextLayout> OverlayWindow::Impl::rich_layout(const std::vector<TextSegment>& segs, IDWriteTextFormat* fmt,
                                                           float max_w) const {
    std::wstring all;
    std::vector<DWRITE_TEXT_RANGE> bold;
    for (const auto& seg : segs) {
        const std::wstring w = widen(seg.text);
        if (seg.bold && !w.empty()) {
            bold.push_back(DWRITE_TEXT_RANGE{static_cast<UINT32>(all.size()), static_cast<UINT32>(w.size())});
        }
        all += w;
    }
    auto l = layout(all, fmt, max_w);
    if (l) {
        for (const auto& r : bold) l->SetFontWeight(DWRITE_FONT_WEIGHT_SEMI_BOLD, r);
    }
    return l;
}

float OverlayWindow::Impl::height_of(IDWriteTextLayout* l) {
    if (!l) return 0.0f;
    DWRITE_TEXT_METRICS m{};
    l->GetMetrics(&m);
    return m.height;
}

float OverlayWindow::Impl::width_of(IDWriteTextLayout* l) {
    if (!l) return 0.0f;
    DWRITE_TEXT_METRICS m{};
    l->GetMetrics(&m);
    return m.widthIncludingTrailingWhitespace;
}

float OverlayWindow::Impl::text_w(const std::wstring& s, IDWriteTextFormat* fmt) const {
    auto l = layout(s, fmt, 2000.0f, 40.0f);
    return width_of(l.get());
}

void OverlayWindow::Impl::fill_round(const D2D1_RECT_F& r, float radius, const D2D1_COLOR_F& c) {
    brush->SetColor(c);
    rt->FillRoundedRectangle(D2D1::RoundedRect(r, radius, radius), brush.get());
}

void OverlayWindow::Impl::stroke_round(const D2D1_RECT_F& r, float radius, const D2D1_COLOR_F& c, float w) {
    brush->SetColor(c);
    rt->DrawRoundedRectangle(D2D1::RoundedRect(r, radius, radius), brush.get(), w);
}

// Rounded panel with layered shadow, premium blur feel + inner highlight.
void OverlayWindow::Impl::panel(const D2D1_RECT_F& r, const D2D1_COLOR_F& fill) {
    // layered outer shadow
    for (int i = 3; i >= 1; --i) {
        const float g = static_cast<float>(i) * 2.0f;
        const float alpha = 0.07f - static_cast<float>(i - 1) * 0.02f;
        fill_round(D2D1::RectF(r.left - g, r.top - g + 2.0f, r.right + g, r.bottom + g + 2.0f), kRadius + g,
                   rgba(0, 0, 0, alpha));
    }
    fill_round(r, kRadius, fill);
    // outer hairline
    stroke_round(D2D1::RectF(r.left + 0.5f, r.top + 0.5f, r.right - 0.5f, r.bottom - 0.5f), kRadius - 0.5f, pal.border);
    // subtle top inner highlight (glass edge)
    {
        D2D1_ROUNDED_RECT rr = D2D1::RoundedRect(D2D1::RectF(r.left + 1.0f, r.top + 1.0f, r.right - 1.0f, r.top + 1.5f), kRadius - 1.0f, kRadius - 1.0f);
        brush->SetColor(rgba(255, 255, 255, 0.06f));
        rt->DrawRoundedRectangle(rr, brush.get(), 1.0f);
    }
}

void OverlayWindow::Impl::dot(float cx, float cy, float r, const D2D1_COLOR_F& c) {
    brush->SetColor(c);
    rt->FillEllipse(D2D1::Ellipse(D2D1::Point2F(cx, cy), r, r), brush.get());
}

void OverlayWindow::Impl::draw_text(IDWriteTextLayout* l, float x, float y, const D2D1_COLOR_F& c) {
    if (!l) return;
    constexpr D2D1_DRAW_TEXT_OPTIONS kTextOpts =
        static_cast<D2D1_DRAW_TEXT_OPTIONS>(D2D1_DRAW_TEXT_OPTIONS_CLIP | D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT);
    brush->SetColor(c);
    rt->DrawTextLayout(D2D1::Point2F(x, y), l, brush.get(), kTextOpts);
}

void OverlayWindow::Impl::text_centered_v(IDWriteTextLayout* l, float x, float cy, const D2D1_COLOR_F& c) {
    if (!l) return;
    draw_text(l, x, std::round(cy - height_of(l) / 2.0f), c);
}

const std::vector<ComPtr<ID2D1PathGeometry>>& OverlayWindow::Impl::icon_geometry(const std::string& name) {
    auto it = icon_cache.find(name);
    if (it != icon_cache.end()) return it->second;
    std::vector<ComPtr<ID2D1PathGeometry>> geos;
    for (const auto& def : icons::kIcons) {
        if (def.name != name) continue;
        for (const auto& d : def.paths) {
            if (d.empty()) continue;
            auto cmds = svg::parse_path(d);
            if (!cmds) continue;
            ComPtr<ID2D1PathGeometry> g;
            ComPtr<ID2D1GeometrySink> sink;
            if (FAILED(d2d->CreatePathGeometry(g.put())) || FAILED(g->Open(sink.put()))) continue;
            bool open = false;
            svg::Pt start{}, cur{};
            for (const auto& c : *cmds) {
                const auto P = [](svg::Pt p) { return D2D1::Point2F(p.x, p.y); };
                if (c.kind == svg::Cmd::Kind::Move) {
                    if (open) sink->EndFigure(D2D1_FIGURE_END_OPEN);
                    sink->BeginFigure(P(c.p), D2D1_FIGURE_BEGIN_HOLLOW);
                    open = true;
                    start = c.p;
                    cur = c.p;
                    continue;
                }
                if (!open) { // drawing after Z continues from the subpath start
                    sink->BeginFigure(P(start), D2D1_FIGURE_BEGIN_HOLLOW);
                    open = true;
                }
                switch (c.kind) {
                    case svg::Cmd::Kind::Line: sink->AddLine(P(c.p)); break;
                    case svg::Cmd::Kind::Cubic: sink->AddBezier(D2D1::BezierSegment(P(c.c1), P(c.c2), P(c.p))); break;
                    case svg::Cmd::Kind::Quad: sink->AddQuadraticBezier(D2D1::QuadraticBezierSegment(P(c.c1), P(c.p))); break;
                    case svg::Cmd::Kind::Arc:
                        for (const auto& seg : svg::arc_to_cubics(cur, c)) {
                            sink->AddBezier(D2D1::BezierSegment(P(seg.c1), P(seg.c2), P(seg.p)));
                        }
                        break;
                    case svg::Cmd::Kind::Close:
                        sink->EndFigure(D2D1_FIGURE_END_CLOSED);
                        open = false;
                        break;
                    default: break;
                }
                cur = c.p;
            }
            if (open) sink->EndFigure(D2D1_FIGURE_END_OPEN);
            if (SUCCEEDED(sink->Close())) geos.push_back(std::move(g));
        }
        break;
    }
    return icon_cache.emplace(name, std::move(geos)).first->second;
}

// Lucide icons live on a 24x24 grid with 2px strokes; the transform scales
// the stroke with the icon, like the SVG would.
void OverlayWindow::Impl::icon(const char* name, float cx, float cy, float size, const D2D1_COLOR_F& c, float stroke) {
    const auto& geos = icon_geometry(name);
    if (geos.empty()) return;
    const float k = size / 24.0f;
    D2D1_MATRIX_3X2_F old;
    rt->GetTransform(&old);
    rt->SetTransform(D2D1::Matrix3x2F::Scale(k, k) * D2D1::Matrix3x2F::Translation(cx - size / 2, cy - size / 2) * old);
    brush->SetColor(c);
    for (const auto& g : geos) rt->DrawGeometry(g.get(), brush.get(), stroke, round_stroke.get());
    rt->SetTransform(old);
}

void OverlayWindow::Impl::add_hit(const D2D1_RECT_F& r, int id, std::wstring tip) {
    hits.push_back(Hit{r, id, std::move(tip)});
}

D2D1_COLOR_F OverlayWindow::Impl::button_fill(int id, bool ghost) const {
    if (pressed == id && hover == id) return ghost ? rgba(255, 255, 255, 0.06f) : pal.btn_down;
    if (hover == id) return ghost ? pal.ghost_hover : pal.btn_hover;
    return ghost ? rgba(0, 0, 0, 0.0f) : pal.btn;
}

float OverlayWindow::Impl::kbd_width(const KeyHint& k) const {
    float w = 12.0f + text_w(k.mods, f_kbd.get()) + 4.0f;
    if (k.icon) w += 12.0f;
    else if (k.key) w += text_w(k.key, f_kbd.get());
    return w;
}

void OverlayWindow::Impl::draw_kbd(const KeyHint& k, float x, float cy) {
    const float w = kbd_width(k);
    fill_round(D2D1::RectF(x, cy - 10.0f, x + w, cy + 10.0f), 6.0f, pal.kbd);
    auto lm = layout(k.mods, f_kbd.get(), 200.0f, 30.0f);
    text_centered_v(lm.get(), x + 6.0f, cy, pal.muted);
    const float kx = x + 6.0f + width_of(lm.get()) + 4.0f;
    if (k.icon) {
        icon(k.icon, kx + 6.0f, cy, 12.0f, pal.muted, 2.2f);
    } else if (k.key) {
        auto lk = layout(k.key, f_kbd.get(), 60.0f, 30.0f);
        text_centered_v(lk.get(), kx, cy, pal.muted);
    }
}

float OverlayWindow::Impl::button_width(const std::wstring& label, const KeyHint* k, bool with_label,
                                        bool with_kbd) const {
    if (!with_label) return kBtnH; // icon only
    float w = 14.0f + text_w(label, f_ui.get()) + 14.0f;
    if (with_kbd && k) w += kbd_width(*k) + 2.0f;
    return w;
}

void OverlayWindow::Impl::draw_button(const D2D1_RECT_F& r, int id, const std::wstring& label, const char* icon_name,
                                      const KeyHint* k, bool with_label, bool with_kbd, bool ghost,
                                      const D2D1_COLOR_F* fill_override) {
    const D2D1_COLOR_F fill = fill_override ? *fill_override : button_fill(id, ghost);
    fill_round(r, (r.bottom - r.top) / 2.0f, fill);
    const float cy = (r.top + r.bottom) / 2.0f;
    std::wstring tip = label;
    if (k) {
        tip += L"  (";
        tip += k->mods;
        tip += L" ";
        if (k->key) tip += k->key;
        else if (k->icon && std::string(k->icon) == "corner-down-left") tip += L"Enter";
        else if (k->icon && std::string(k->icon) == "arrow-left") tip += L"←";
        else if (k->icon && std::string(k->icon) == "arrow-right") tip += L"→";
        else if (k->icon) tip += L"Backspace";
        tip += L")";
    }
    if (!with_label) {
        if (icon_name) icon(icon_name, (r.left + r.right) / 2.0f, cy, 16.0f, pal.text);
        add_hit(r, id, tip);
        return;
    }
    auto l = layout(label, f_ui.get(), 400.0f, 40.0f);
    text_centered_v(l.get(), r.left + 14.0f, cy, pal.text);
    if (with_kbd && k) draw_kbd(*k, r.left + 14.0f + width_of(l.get()) + 8.0f, cy);
    add_hit(r, id, with_kbd ? std::wstring() : tip);
}

void OverlayWindow::Impl::icon_button(const D2D1_RECT_F& r, int id, const char* icon_name, const std::wstring& tip,
                                      const D2D1_COLOR_F* tint, bool ghost) {
    fill_round(r, std::min(r.right - r.left, r.bottom - r.top) / 2.0f, button_fill(id, ghost));
    icon(icon_name, (r.left + r.right) / 2.0f, (r.top + r.bottom) / 2.0f, 16.0f, tint ? *tint : pal.text);
    add_hit(r, id, tip);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------


float OverlayWindow::Impl::draw_control_bar(float y) {
    const float L = kMargin, R = width - kMargin;
    const D2D1_RECT_F bar = D2D1::RectF(L, y, R, y + kBarH);
    panel(bar, pal.bar);
    add_hit(bar, kDragArea); // empty bar area drags the window (lowest priority)
    const float cy = y + kBarH / 2.0f;

    // ---- capture toggles: system audio ("Outros"), microphone ("Você") ----
    float x = L + 8.0f;
    for (AudioSource s : {AudioSource::Loopback, AudioSource::Microphone}) {
        const auto& lane = lanes[static_cast<std::size_t>(s)];
        const int id = s == AudioSource::Loopback ? kSrcOutros : kSrcVoce;
        const D2D1_RECT_F r = D2D1::RectF(x, cy - 15.0f, x + 30.0f, cy + 15.0f);
        fill_round(r, 15.0f, button_fill(id, true));
        const bool recording = lane.enabled && !lane.paused;
        const float ccx = x + 15.0f;
        if (recording && lane.level > 0.04f) {
            brush->SetColor(with_alpha(pal.green, 0.20f + 0.65f * lane.level));
            rt->DrawEllipse(D2D1::Ellipse(D2D1::Point2F(ccx, cy), 13.5f, 13.5f), brush.get(), 1.5f + lane.level);
        }
        const bool err = lane.state == LinkState::Error;
        const char* ic = s == AudioSource::Loopback ? (recording ? "monitor" : "monitor-off") : (recording ? "mic" : "mic-off");
        icon(ic, ccx, cy, 15.0f, err ? pal.red : (recording ? pal.text : pal.muted));
        if (recording) {
            dot(x + 23.0f, cy - 8.0f, 3.5f, pal.green);
        }
        std::string who = s == AudioSource::Loopback ? "System audio (Others)" : "Microphone (You)";
        std::string st;
        if (!lane.enabled) st = "disabled in config.ini";
        else if (lane.paused) st = "paused · click to resume";
        else if (err) st = "error: " + lane.detail;
        else if (lane.state == LinkState::Connected) st = "recording · click to pause";
        else st = (lane.detail.empty() ? std::string(to_string(lane.state)) : lane.detail) + " · click to pause";
        add_hit(r, id, widen(who + ": " + st));
        x += 34.0f;
    }
    x += 4.0f;

    // Right group in Image 5: Timer, 3-dots, Collapse, Stealth, Move
    float rx = R - 8.0f;
    const std::string timer_str = clock_text(std::chrono::steady_clock::now() - opts.session_start);
    auto ltime = layout(widen(timer_str), f_small_bold.get(), 70.0f, 30.0f);
    const float tw = width_of(ltime.get()) + 26.0f;
    const D2D1_RECT_F tr = D2D1::RectF(rx - tw, cy - 12.5f, rx, cy + 12.5f);
    fill_round(tr, 12.5f, rgba(16, 185, 129, 0.12f));
    stroke_round(tr, 12.5f, rgba(16, 185, 129, 0.35f), 1.0f);
    dot(tr.left + 9.0f, cy, 3.0f, pal.green);
    text_centered_v(ltime.get(), tr.left + 17.0f, cy, pal.green);
    add_hit(tr, kNone, L"Tempo de sessão ao vivo");
    rx -= tw + 8.0f;

    // 3-dots more menu
    icon_button(D2D1::RectF(rx - 26.0f, cy - 13.0f, rx, cy + 13.0f), kBtnMenu, "ellipsis-vertical", L"Mais opções", nullptr, !menu_open);
    rx -= 28.0f;

    // Collapse icon
    icon_button(D2D1::RectF(rx - 26.0f, cy - 13.0f, rx, cy + 13.0f), kBtnCollapse, collapsed ? "maximize-2" : "minimize-2", collapsed ? L"Expandir" : L"Recolher");
    rx -= 28.0f;

    // Stealth icon (eye-off)
    icon_button(D2D1::RectF(rx - 26.0f, cy - 13.0f, rx, cy + 13.0f), kMenuHide, "eye-off", L"Ocultar HUD (Ctrl Alt H)");
    rx -= 28.0f;

    // Move icon (crosshair / drag)
    icon_button(D2D1::RectF(rx - 26.0f, cy - 13.0f, rx, cy + 13.0f), kBtnMove, "move", L"Arrastar HUD");
    rx -= 32.0f;

    // Responsive width budget for action buttons
    const float mid_space = rx - x;
    const bool show_kbd = mid_space > 480.0f;
    const bool show_model = mid_space > 350.0f;

    // 1. Primary White Pill: Answer ⌘ ↵
    {
        const float btn_w = show_kbd ? 112.0f : 84.0f;
        const D2D1_RECT_F r = D2D1::RectF(x, cy - 14.5f, x + btn_w, cy + 14.5f);
        const D2D1_COLOR_F bg = hover == kBtnAnswer ? rgba(255, 255, 255, 1.0f) : rgba(244, 244, 246, 0.96f);
        fill_round(r, 14.5f, bg);
        icon("sparkles", r.left + 14.0f, cy, 14.0f, rgba(12, 13, 16, 1.0f));
        auto l = layout(L"Answer", f_small_bold.get(), 60.0f, 30.0f);
        text_centered_v(l.get(), r.left + 26.0f, cy, rgba(12, 13, 16, 1.0f));
        if (show_kbd) {
            auto kbd = layout(L"⌘ ↵", f_small.get(), 36.0f, 20.0f);
            const float kw = width_of(kbd.get()) + 8.0f;
            const D2D1_RECT_F kr = D2D1::RectF(r.right - kw - 6.0f, cy - 8.5f, r.right - 6.0f, cy + 8.5f);
            fill_round(kr, 4.0f, rgba(0, 0, 0, 0.12f));
            text_centered_v(kbd.get(), kr.left + 4.0f, cy, rgba(12, 13, 16, 0.85f));
        }
        add_hit(r, kBtnAnswer, L"Gerar resposta sugerida (Ctrl Alt Enter)");
        x += btn_w + 6.0f;
    }

    // 2. Secondary Dark Pill: Screenshot ⌘ ⇧ S
    {
        const float btn_w = show_kbd ? 134.0f : 100.0f;
        const D2D1_RECT_F r = D2D1::RectF(x, cy - 14.5f, x + btn_w, cy + 14.5f);
        fill_round(r, 14.5f, button_fill(kBtnShot, false));
        stroke_round(r, 14.5f, pal.border, 1.0f);
        icon("camera", r.left + 14.0f, cy, 14.0f, pal.text);
        auto l = layout(L"Screenshot", f_small.get(), 75.0f, 30.0f);
        text_centered_v(l.get(), r.left + 26.0f, cy, pal.text);
        if (show_kbd) {
            auto kbd = layout(L"⌘ ⇧ S", f_small.get(), 45.0f, 20.0f);
            const float kw = width_of(kbd.get()) + 8.0f;
            const D2D1_RECT_F kr = D2D1::RectF(r.right - kw - 6.0f, cy - 8.5f, r.right - 6.0f, cy + 8.5f);
            fill_round(kr, 4.0f, rgba(255, 255, 255, 0.08f));
            text_centered_v(kbd.get(), kr.left + 4.0f, cy, pal.muted);
        }
        if (shot_busy) {
            fill_round(r, 14.5f, rgba(0, 0, 0, 0.50f));
            const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                                std::chrono::steady_clock::now().time_since_epoch()).count();
            const float mid = (r.left + r.right) / 2.0f;
            for (int i = 0; i < 3; ++i) {
                const float phase = static_cast<float>((ms + i * 400) % 1200) / 1200.0f;
                const float a = 0.3f + 0.7f * 0.5f * (1.0f - std::cos(phase * 6.2831853f));
                dot(mid - 6.0f + static_cast<float>(i) * 6.0f, cy, 2.2f, with_alpha(pal.text, a));
            }
        }
        add_hit(r, kBtnShot, L"Capturar tela e resolver (Ctrl Alt S)");
        x += btn_w + 6.0f;
    }

    // 3. Secondary Dark Pill: Chat ⌘ ⇧ ␣
    {
        const float btn_w = show_kbd ? 104.0f : 72.0f;
        const D2D1_RECT_F r = D2D1::RectF(x, cy - 14.5f, x + btn_w, cy + 14.5f);
        fill_round(r, 14.5f, button_fill(kBtnChat, false));
        stroke_round(r, 14.5f, chat_open ? with_alpha(pal.accent, 0.85f) : pal.border, chat_open ? 1.5f : 1.0f);
        icon("message-square", r.left + 14.0f, cy, 14.0f, pal.text);
        auto l = layout(L"Chat", f_small.get(), 40.0f, 30.0f);
        text_centered_v(l.get(), r.left + 26.0f, cy, pal.text);
        if (show_kbd) {
            auto kbd = layout(L"⌘ ⇧ ␣", f_small.get(), 42.0f, 20.0f);
            const float kw = width_of(kbd.get()) + 8.0f;
            const D2D1_RECT_F kr = D2D1::RectF(r.right - kw - 6.0f, cy - 8.5f, r.right - 6.0f, cy + 8.5f);
            fill_round(kr, 4.0f, rgba(255, 255, 255, 0.08f));
            text_centered_v(kbd.get(), kr.left + 4.0f, cy, pal.muted);
        }
        add_hit(r, kBtnChat, L"Alternar chat de acompanhamento (Ctrl Alt K)");
        x += btn_w + 6.0f;
    }

    // 4. Model Dropdown Pill
    if (show_model && x < rx - 50.0f) {
        std::wstring model_name = L"Claude Sonnet 4.6";
        if (!opts.llm_model.empty()) {
            std::string m = opts.llm_model;
            auto slash = m.find('/');
            if (slash != std::string::npos) m = m.substr(slash + 1);
            if (m.find("claude-3.5-haiku") != std::string::npos || m.find("sonnet") != std::string::npos) model_name = L"Claude Sonnet 4.6";
            else if (m.find("qwen") != std::string::npos) model_name = L"Qwen 3.6 Flash";
            else if (m.find("gpt-4o") != std::string::npos) model_name = L"GPT-5";
            else if (m.find("gemini") != std::string::npos) model_name = L"Gemini 2.5 Flash";
            else model_name = widen(m);
        }
        auto lm = layout(model_name, f_small.get(), 140.0f, 30.0f);
        const float mw = width_of(lm.get());
        const float btn_w = std::min(26.0f + mw + 20.0f, rx - x - 4.0f);
        if (btn_w > 40.0f) {
            const D2D1_RECT_F r = D2D1::RectF(x, cy - 14.5f, x + btn_w, cy + 14.5f);
            fill_round(r, 14.5f, rgba(26, 27, 32, 0.90f));
            stroke_round(r, 14.5f, pal.border, 1.0f);
            icon("settings", r.left + 12.0f, cy, 13.0f, pal.muted);
            rt->PushAxisAlignedClip(D2D1::RectF(r.left + 22.0f, r.top, r.right - 14.0f, r.bottom), D2D1_ANTIALIAS_MODE_ALIASED);
            text_centered_v(lm.get(), r.left + 23.0f, cy, pal.text);
            rt->PopAxisAlignedClip();
            icon("chevron-down", r.right - 9.0f, cy, 11.0f, pal.muted);
            add_hit(r, kMenuConfig, L"Alternar Modelo de IA (Configurações)");
        }
    }

    return bar.bottom;
}

float OverlayWindow::Impl::draw_menu(float y) {
    if (!menu_open) return y;
    const float L = kMargin, R = width - kMargin;
    struct Item { int id; const char* icon; std::wstring label; KeyHint k; bool has_k; };
    const bool any_running = std::any_of(lanes.begin(), lanes.end(), [](const LaneView& l) { return l.enabled && !l.paused; });
    const Item items[] = {
        {kMenuRecap, "scroll-text", L"Conversation summary", {L"Ctrl Alt", L"R", nullptr}, true},
        {kMenuFollow, "circle-help", L"Follow-up questions", {}, false},
        {kMenuPause, any_running ? "pause" : "play", any_running ? L"Pause capture" : L"Resume capture",
         {L"Ctrl Alt", L"P", nullptr}, true},
        {kMenuClick, "mouse-pointer-click", L"Click-through HUD", {L"Ctrl Alt", L"T", nullptr}, true},
        {kMenuHide, "eye-off", L"Hide HUD", {L"Ctrl Alt", L"H", nullptr}, true},
        {kMenuConfig, "settings", L"Settings", {L"Ctrl Alt", L"O", nullptr}, true},
    };
    const float row = 32.0f;
    const float head = 30.0f;
    const float top = y + kGap;
    const D2D1_RECT_F pr = D2D1::RectF(L, top, R, top + 8.0f + head + row * std::size(items) + 8.0f);
    panel(pr, pal.panel);
    add_hit(pr, kDragArea);

    // Header: mode, session clock, lane states.
    auto lane_txt = [&](AudioSource s) {
        const auto& l = lanes[static_cast<std::size_t>(s)];
        if (!l.enabled) return std::string("disabled");
        if (l.paused) return std::string("paused");
        switch (l.state) {
            case LinkState::Connected: return std::string("connected");
            case LinkState::Connecting: return std::string("connecting");
            case LinkState::Reconnecting: return std::string("reconnecting");
            case LinkState::Error: return std::string("error");
            default: return std::string("idle");
        }
    };
    const std::string h = opts.mode_label + " · " + clock_text(std::chrono::steady_clock::now() - opts.session_start) +
                          " · You: " + lane_txt(AudioSource::Microphone) + " · Others: " +
                          lane_txt(AudioSource::Loopback) +
                          (opts.llm_enabled ? " · " + opts.llm_model : std::string(" · no LLM"));
    auto lh = line_layout(widen(h), f_small.get(), R - L - 28.0f);
    text_centered_v(lh.get(), L + 14.0f, top + 8.0f + head / 2.0f, pal.muted);
    brush->SetColor(pal.faint);
    rt->DrawLine(D2D1::Point2F(L + 10.0f, top + 8.0f + head), D2D1::Point2F(R - 10.0f, top + 8.0f + head), brush.get());

    float ry = top + 8.0f + head;
    for (const auto& it : items) {
        const D2D1_RECT_F r = D2D1::RectF(L + 6.0f, ry + 2.0f, R - 6.0f, ry + row - 2.0f);
        fill_round(r, 8.0f, button_fill(it.id, true));
        const float cy = (r.top + r.bottom) / 2.0f;
        icon(it.icon, r.left + 18.0f, cy, 15.0f, pal.text);
        auto l = line_layout(it.label, f_ui.get(), r.right - r.left - 160.0f);
        text_centered_v(l.get(), r.left + 36.0f, cy, pal.text);
        if (it.has_k) draw_kbd(it.k, r.right - 10.0f - kbd_width(it.k), cy);
        add_hit(r, it.id);
        ry += row;
    }
    return pr.bottom;
}

float OverlayWindow::Impl::draw_strip(float y) {
    if (collapsed || !chat_open) return y;
    const float L = kMargin, R = width - kMargin;
    const float strip_h = 42.0f;
    const D2D1_RECT_F sr = D2D1::RectF(L, y + kGap, R, y + kGap + strip_h);
    panel(sr, rgba(18, 19, 23, 0.96f));
    add_hit(sr, kChatField, L"Clique para digitar no chat");
    const float cy = (sr.top + sr.bottom) / 2.0f;

    // Sparkles icon on the left
    icon("sparkles", L + 18.0f, cy, 15.0f, pal.accent_soft);

    // Text field or placeholder
    const float tx = L + 36.0f;
    const float send_w = 66.0f;
    const float close_w = 26.0f;
    const float tw = R - 12.0f - close_w - send_w - 95.0f - tx;

    if (edit.empty()) {
        auto l = line_layout(L"Ask a follow-up or type context...", f_body.get(), tw);
        text_centered_v(l.get(), tx, cy, with_alpha(pal.muted, chat_focused ? 0.75f : 0.95f));
    } else {
        const std::wstring t = to_w(edit.text());
        auto l = layout(t, f_body.get(), 10000.0f, 30.0f);
        if (l) l->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
        float caret_x = 0.0f;
        if (l) {
            FLOAT cxp = 0, cyp = 0;
            DWRITE_HIT_TEST_METRICS hm{};
            l->HitTestTextPosition(static_cast<UINT32>(edit.caret()), FALSE, &cxp, &cyp, &hm);
            caret_x = cxp;
        }
        if (caret_x - chat_scroll_x > tw - 4.0f) chat_scroll_x = caret_x - tw + 4.0f;
        if (caret_x - chat_scroll_x < 0.0f) chat_scroll_x = caret_x;
        if (width_of(l.get()) < tw) chat_scroll_x = 0.0f;
        rt->PushAxisAlignedClip(D2D1::RectF(tx - 2.0f, sr.top, tx + tw + 2.0f, sr.bottom), D2D1_ANTIALIAS_MODE_ALIASED);
        if (!t.empty()) text_centered_v(l.get(), tx - chat_scroll_x, cy, pal.text);
        if (chat_focused) {
            const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - caret_t0).count();
            if ((ms / 530) % 2 == 0) {
                const float cxp = tx - chat_scroll_x + caret_x;
                fill_round(D2D1::RectF(cxp, cy - 9.0f, cxp + 1.5f, cy + 9.0f), 0.5f, pal.text);
            }
        }
        rt->PopAxisAlignedClip();
    }

    // Badges ⌘ K and ⌘ ↵
    float bx = R - close_w - send_w - 90.0f;
    auto lk = layout(L"⌘ K", f_small.get(), 36.0f, 24.0f);
    fill_round(D2D1::RectF(bx, cy - 9.0f, bx + 34.0f, cy + 9.0f), 4.0f, rgba(255, 255, 255, 0.06f));
    stroke_round(D2D1::RectF(bx + 0.5f, cy - 8.5f, bx + 33.5f, cy + 8.5f), 3.5f, pal.border);
    text_centered_v(lk.get(), bx + 6.0f, cy, pal.muted);

    bx += 40.0f;
    auto lret = layout(L"⌘ ↵", f_small.get(), 36.0f, 24.0f);
    fill_round(D2D1::RectF(bx, cy - 9.0f, bx + 34.0f, cy + 9.0f), 4.0f, rgba(255, 255, 255, 0.06f));
    stroke_round(D2D1::RectF(bx + 0.5f, cy - 8.5f, bx + 33.5f, cy + 8.5f), 3.5f, pal.border);
    text_centered_v(lret.get(), bx + 6.0f, cy, pal.muted);

    // Send button (white pill)
    const D2D1_RECT_F send_r = D2D1::RectF(R - close_w - send_w - 6.0f, cy - 13.0f, R - close_w - 6.0f, cy + 13.0f);
    const D2D1_COLOR_F send_bg = hover == kChatSend ? rgba(255, 255, 255, 1.0f) : rgba(244, 244, 246, 0.95f);
    fill_round(send_r, 13.0f, send_bg);
    auto lsend = layout(L"Send ↵", f_small_bold.get(), send_w, 24.0f);
    text_centered_v(lsend.get(), send_r.left + 12.0f, cy, rgba(12, 13, 16, 1.0f));
    add_hit(send_r, kChatSend, L"Enviar mensagem (Enter)");

    // Close button
    const D2D1_RECT_F close_r = D2D1::RectF(R - close_w, cy - 13.0f, R, cy + 13.0f);
    icon_button(close_r, kChatClose, "x", L"Fechar chat (Esc)");

    return sr.bottom;
}

} // namespace rtai
namespace rtai {
float OverlayWindow::Impl::draw_answer(float y) {
    if (collapsed) return y;
    const float L = kMargin, R = width - kMargin;
    const float top_y = y + kGap;
    const float total_w = R - L;
    const float col_gap = 12.0f;
    const float left_w = std::clamp(total_w * 0.38f, 320.0f, 440.0f);
    const float right_x = L + left_w + col_gap;
    const float right_w = R - right_x;

    SuggestionView* sv = history.empty() ? nullptr : &history[std::min(cursor, history.size() - 1)];

    const auto& sys = lanes[static_cast<std::size_t>(AudioSource::Loopback)];
    const auto& mic = lanes[static_cast<std::size_t>(AudioSource::Microphone)];

    const float work_h = work_height_dip();
    float card_h;
    if (answer_expanded) {
        card_h = std::max(480.0f, work_h - top_y - 20.0f);
    } else {
        card_h = std::clamp(work_h * 0.58f, 400.0f, 540.0f);
    }

    const D2D1_RECT_F left_r = D2D1::RectF(L, top_y, L + left_w, top_y + card_h);
    const D2D1_RECT_F right_r = D2D1::RectF(right_x, top_y, R, top_y + card_h);

    // =========================================================================
    // LEFT COLUMN: LIVE TRANSCRIPT
    // =========================================================================
    panel(left_r, rgba(15, 16, 19, 0.96f));

    // 1. Mini top-bar of Left Column
    {
        const float cy = top_y + 18.0f;
        // Equalizer: 3 animated bars
        const float lvl = std::max(sys.level, mic.level);
        const bool speaking = (sys.enabled && !sys.paused && sys.level > 0.03f) || (mic.enabled && !mic.paused && mic.level > 0.03f);
        for (int i = 0; i < 3; ++i) {
            const float h = 4.0f + 12.0f * std::min(1.0f, lvl * (0.6f + i * 0.25f) * 1.5f);
            const float bx = left_r.left + 12.0f + static_cast<float>(i) * 5.5f;
            fill_round(D2D1::RectF(bx, cy - h / 2.0f, bx + 2.5f, cy + h / 2.0f), 1.2f, speaking ? pal.green : with_alpha(pal.green, 0.45f));
        }

        // Language pill: measured dynamically
        std::wstring cur_lang = L"Português";
        auto l_lang = layout(cur_lang, f_small.get(), 100.0f, 20.0f);
        const float ltw = width_of(l_lang.get());
        const float lang_w = 22.0f + ltw + 18.0f;
        const float lang_x = left_r.left + 36.0f;
        const D2D1_RECT_F lang_r = D2D1::RectF(lang_x, cy - 11.0f, lang_x + lang_w, cy + 11.0f);
        fill_round(lang_r, 11.0f, rgba(255, 255, 255, 0.05f));
        stroke_round(lang_r, 11.0f, pal.border, 1.0f);
        icon("globe", lang_r.left + 10.0f, cy, 12.0f, pal.muted);
        text_centered_v(l_lang.get(), lang_r.left + 18.0f, cy, pal.text);
        icon("chevron-down", lang_r.right - 8.0f, cy, 10.0f, pal.muted);
        add_hit(lang_r, kMenuConfig, L"Idioma de transcrição (Configurações)");

        // Right side: Collapse icon and Clear button
        const float icon_w = 22.0f;
        const float clr_w = 64.0f;
        const D2D1_RECT_F min_r = D2D1::RectF(left_r.right - icon_w - 10.0f, cy - 11.0f, left_r.right - 10.0f, cy + 11.0f);
        icon_button(min_r, kBtnCollapse, "minimize-2", L"Recolher");

        const D2D1_RECT_F clr_r = D2D1::RectF(min_r.left - clr_w - 6.0f, cy - 11.0f, min_r.left - 6.0f, cy + 11.0f);
        fill_round(clr_r, 11.0f, button_fill(kStripClear, false));
        auto l_clr = layout(L"Clear", f_small.get(), 30.0f, 20.0f);
        text_centered_v(l_clr.get(), clr_r.left + 8.0f, cy, pal.muted);
        auto l_kclr = layout(L"⇧⌫", f_small.get(), 20.0f, 20.0f);
        text_centered_v(l_kclr.get(), clr_r.right - 20.0f, cy, pal.muted);
        add_hit(clr_r, kStripClear, L"Limpar transcrição (Ctrl Alt Shift Backspace)");
    }

    // 2. Subheader: LIVE TRANSCRIPT | N turns
    const auto chunks = strip.chunks(30);
    {
        const float sub_y = top_y + 44.0f;
        auto l_head = layout(L"LIVE TRANSCRIPT", f_small_bold.get(), 140.0f, 20.0f);
        text_centered_v(l_head.get(), left_r.left + 14.0f, sub_y, rgba(160, 160, 172, 1.0f));

        const std::wstring turns_str = chunks.empty() ? L"0 turns" : widen(std::to_string(chunks.size()) + " turns");
        auto l_turns = layout(turns_str, f_small.get(), 70.0f, 20.0f);
        text_centered_v(l_turns.get(), left_r.right - 14.0f - width_of(l_turns.get()), sub_y, pal.muted);
    }

    // Divider
    brush->SetColor(pal.faint);
    rt->DrawLine(D2D1::Point2F(left_r.left + 12.0f, top_y + 56.0f), D2D1::Point2F(left_r.right - 12.0f, top_y + 56.0f), brush.get());

    // 3. Transcript Feed Area
    const D2D1_RECT_F feed_clip = D2D1::RectF(left_r.left + 12.0f, top_y + 60.0f, left_r.right - 12.0f, left_r.bottom - 36.0f);
    rt->PushAxisAlignedClip(feed_clip, D2D1_ANTIALIAS_MODE_ALIASED);
    {
        float ty = top_y + 64.0f;
        const float fw = feed_clip.right - feed_clip.left;

        if (chunks.empty()) {
            auto l_w1 = layout(L"Aguardando áudio da chamada...", f_small_bold.get(), fw, 20.0f);
            text_centered_v(l_w1.get(), feed_clip.left, ty + 10.0f, pal.text);
            ty += 22.0f;
            auto l_w2 = line_layout(L"O RealTimeAI transcreve a fala do entrevistador (áudio) e a sua (microfone) em tempo real.", f_small.get(), fw);
            text_centered_v(l_w2.get(), feed_clip.left, ty + 6.0f, pal.muted);
            ty += height_of(l_w2.get()) + 20.0f;
        } else {
            for (const auto& ch : chunks) {
                if (ty > feed_clip.bottom - 80.0f) break;
                const bool loopback = ch.source == AudioSource::Loopback;
                const wchar_t* who = loopback ? L"Interviewer" : L"Você";
                auto l_spk = layout(who, f_small_bold.get(), 100.0f, 18.0f);
                text_centered_v(l_spk.get(), feed_clip.left, ty + 6.0f, loopback ? pal.text : pal.accent_soft);
                if (ch.live) {
                    dot(feed_clip.left + width_of(l_spk.get()) + 8.0f, ty + 6.0f, 2.5f, pal.green);
                }
                ty += 18.0f;
                auto l_msg = line_layout(widen(ch.text), f_small.get(), fw);
                text_centered_v(l_msg.get(), feed_clip.left, ty + 6.0f, pal.text_sub);
                ty += height_of(l_msg.get()) + 10.0f;
            }
        }

        // Highlighted Card: Question detected
        const float qbox_h = 60.0f;
        const D2D1_RECT_F qbox = D2D1::RectF(feed_clip.left, ty, feed_clip.right, ty + qbox_h);
        const bool has_q = sv && (!sv->trigger.empty() || !sv->understood.empty());
        fill_round(qbox, 8.0f, has_q ? rgba(16, 185, 129, 0.08f) : rgba(255, 255, 255, 0.03f));
        stroke_round(qbox, 8.0f, has_q ? rgba(16, 185, 129, 0.35f) : pal.border, 1.0f);

        dot(qbox.left + 12.0f, qbox.top + 13.0f, 3.0f, has_q ? pal.green : pal.muted);
        auto l_qbadge = layout(has_q ? L"Pergunta detectada" : L"Aguardando pergunta...", f_small_bold.get(), 160.0f, 20.0f);
        text_centered_v(l_qbadge.get(), qbox.left + 20.0f, qbox.top + 13.0f, has_q ? pal.green : pal.muted);

        std::wstring q_text = has_q
            ? (sv->understood.empty() ? widen(sv->trigger) : widen(sv->understood))
            : L"Pressione Answer (⌘ ↵) para responder à fala atual.";
        auto l_qtxt = layout(q_text, f_small.get(), fw - 20.0f, 34.0f);
        text_centered_v(l_qtxt.get(), qbox.left + 10.0f, qbox.top + 34.0f, has_q ? pal.text : pal.text_sub);
        ty += qbox_h + 10.0f;

        // Bottom listening / transcribing indicator
        const bool active_audio = (sys.enabled && !sys.paused && sys.level > 0.02f) || (mic.enabled && !mic.paused && mic.level > 0.02f);
        dot(feed_clip.left + 6.0f, ty + 8.0f, 3.0f, active_audio ? pal.green : pal.muted);
        auto l_trans = layout(active_audio ? L"transcrevendo..." : L"ouvindo...", f_small.get(), 120.0f, 18.0f);
        text_centered_v(l_trans.get(), feed_clip.left + 14.0f, ty + 8.0f, active_audio ? pal.text : pal.muted);
    }
    rt->PopAxisAlignedClip();

    // 4. Left Column Sticky Footer: SESSION CONTEXT | Edit
    {
        const float foot_y = left_r.bottom - 18.0f;
        brush->SetColor(pal.faint);
        rt->DrawLine(D2D1::Point2F(left_r.left + 12.0f, left_r.bottom - 36.0f), D2D1::Point2F(left_r.right - 12.0f, left_r.bottom - 36.0f), brush.get());

        auto l_ctx = layout(L"SESSION CONTEXT", f_small_bold.get(), 130.0f, 20.0f);
        text_centered_v(l_ctx.get(), left_r.left + 14.0f, foot_y, pal.muted);

        auto l_edit = layout(L"Edit", f_small_bold.get(), 40.0f, 20.0f);
        const float edit_x = left_r.right - 14.0f - width_of(l_edit.get());
        const D2D1_RECT_F edit_r = D2D1::RectF(edit_x - 4.0f, foot_y - 10.0f, left_r.right - 10.0f, foot_y + 10.0f);
        text_centered_v(l_edit.get(), edit_x, foot_y, pal.accent_soft);
        add_hit(edit_r, kMenuConfig, L"Editar contexto e currículo no Dashboard");
    }

    // =========================================================================
    // RIGHT COLUMN: QUESTION + SUGGESTED ANSWER
    // =========================================================================
    panel(right_r, rgba(17, 18, 22, 0.96f));

    // 1. Top Toolbar of Right Column
    {
        const float cy = top_y + 20.0f;
        float rx = right_r.left + 14.0f;

        // Navigation prev / next
        const D2D1_RECT_F prev_r = D2D1::RectF(rx, cy - 11.0f, rx + 44.0f, cy + 11.0f);
        fill_round(prev_r, 4.0f, button_fill(kPrev, false));
        auto l_prev = layout(L"⌘ ←", f_small.get(), 40.0f, 18.0f);
        text_centered_v(l_prev.get(), rx + 6.0f, cy, cursor > 0 ? pal.text : pal.muted);
        add_hit(prev_r, kPrev, L"Resposta anterior (Ctrl Alt ←)");
        rx += 50.0f;

        const std::wstring count_str = history.empty()
            ? L"0 / 0"
            : widen(std::to_string(cursor + 1) + " / " + std::to_string(history.size()));
        auto l_cnt = layout(count_str, f_small.get(), 40.0f, 18.0f);
        text_centered_v(l_cnt.get(), rx, cy, pal.muted);
        rx += 38.0f;

        const D2D1_RECT_F next_r = D2D1::RectF(rx, cy - 11.0f, rx + 44.0f, cy + 11.0f);
        fill_round(next_r, 4.0f, button_fill(kNext, false));
        auto l_next = layout(L"⌘ →", f_small.get(), 40.0f, 18.0f);
        text_centered_v(l_next.get(), rx + 6.0f, cy, (sv && cursor + 1 < history.size()) ? pal.text : pal.muted);
        add_hit(next_r, kNext, L"Próxima resposta (Ctrl Alt →)");
        rx += 56.0f;

        // Segmented Style Tabs: Concise | Detailed | STAR
        const float seg_w = 200.0f;
        const D2D1_RECT_F seg_r = D2D1::RectF(rx, cy - 13.0f, rx + seg_w, cy + 13.0f);
        fill_round(seg_r, 6.0f, rgba(255, 255, 255, 0.04f));
        stroke_round(seg_r, 6.0f, pal.border, 1.0f);

        const float part_w = seg_w / 3.0f;
        for (int i = 0; i < 3; ++i) {
            const D2D1_RECT_F pr = D2D1::RectF(seg_r.left + i * part_w + 1.0f, seg_r.top + 1.0f, seg_r.left + (i + 1) * part_w - 1.0f, seg_r.bottom - 1.0f);
            const bool active = selected_style == i;
            if (active) fill_round(pr, 5.0f, rgba(45, 46, 52, 0.95f));
            const wchar_t* lbls[] = {L"Concise", L"Detailed", L"STAR"};
            auto ls = layout(lbls[i], active ? f_small_bold.get() : f_small.get(), part_w, 20.0f);
            text_centered_v(ls.get(), pr.left + (part_w - width_of(ls.get())) / 2.0f, cy, active ? pal.text : pal.muted);
            add_hit(pr, kStyleConcise + i, lbls[i]);
        }

        // Right buttons: Clear and Expand
        float right_bx = right_r.right - 14.0f - 24.0f;
        icon_button(D2D1::RectF(right_bx, cy - 12.0f, right_bx + 24.0f, cy + 12.0f), kAnsExpand, answer_expanded ? "minimize-2" : "maximize-2", answer_expanded ? L"Recolher" : L"Expandir");
        right_bx -= 30.0f;

        const D2D1_RECT_F clr_r = D2D1::RectF(right_bx - 64.0f, cy - 11.0f, right_bx, cy + 11.0f);
        fill_round(clr_r, 5.0f, button_fill(kAnsClear, false));
        auto l_c = layout(L"Clear ⌘ ⌫", f_small.get(), 62.0f, 18.0f);
        text_centered_v(l_c.get(), clr_r.left + 5.0f, cy, pal.muted);
        add_hit(clr_r, kAnsClear, L"Limpar resposta atual");
    }

    // Divider
    brush->SetColor(pal.faint);
    rt->DrawLine(D2D1::Point2F(right_r.left + 14.0f, top_y + 40.0f), D2D1::Point2F(right_r.right - 14.0f, top_y + 40.0f), brush.get());

    // 2. Section 1: QUESTION
    float sec_y = top_y + 52.0f;
    {
        // Header
        auto l_qhdr = layout(L"QUESTION", f_small_bold.get(), 80.0f, 20.0f);
        text_centered_v(l_qhdr.get(), right_r.left + 14.0f, sec_y, pal.muted);

        // Tag: Motivation / Tech / General / Screenshot
        const float tag_x = right_r.left + 14.0f + width_of(l_qhdr.get()) + 10.0f;
        const wchar_t* tag_lbl = sv ? (sv->reason == TriggerReason::Screenshot ? L"Screenshot" : (sv->reason == TriggerReason::Chat ? L"Chat" : (sv->reason == TriggerReason::FollowUp ? L"Follow-up" : L"Entrevista"))) : L"Entrevista";
        auto l_tag = layout(tag_lbl, f_small.get(), 90.0f, 18.0f);
        const float tw = width_of(l_tag.get()) + 14.0f;
        const D2D1_RECT_F tag_r = D2D1::RectF(tag_x, sec_y - 9.0f, tag_x + tw, sec_y + 9.0f);
        fill_round(tag_r, 4.0f, rgba(255, 255, 255, 0.05f));
        text_centered_v(l_tag.get(), tag_r.left + 7.0f, sec_y, pal.muted);

        // Copy button
        const bool copied_recently = std::chrono::steady_clock::now() - copied_at < std::chrono::milliseconds(1500);
        const D2D1_RECT_F copy_r = D2D1::RectF(right_r.right - 36.0f, sec_y - 10.0f, right_r.right - 14.0f, sec_y + 10.0f);
        icon_button(copy_r, kCopy, copied_recently ? "check" : "copy", copied_recently ? L"Copiado!" : L"Copiar resposta");

        sec_y += 18.0f;
        // Question text
        std::wstring q_text;
        if (sv && sv->reason == TriggerReason::Screenshot) {
            q_text = L"Análise da Tela Capturada e Resolução do Problema";
        } else if (sv && !sv->trigger.empty()) {
            q_text = widen(sv->trigger);
        } else if (sv && !sv->understood.empty()) {
            q_text = widen(sv->understood);
        } else {
            q_text = L"Aguardando pergunta da entrevista...";
        }
        auto l_qtitle = layout(q_text, f_body_bold.get(), right_w - 40.0f, 40.0f);
        text_centered_v(l_qtitle.get(), right_r.left + 14.0f, sec_y + 8.0f, pal.text);
        sec_y += height_of(l_qtitle.get()) + 14.0f;
    }

    // Divider
    brush->SetColor(pal.faint);
    rt->DrawLine(D2D1::Point2F(right_r.left + 14.0f, sec_y), D2D1::Point2F(right_r.right - 14.0f, sec_y), brush.get());
    sec_y += 12.0f;

    // 3. Section 2: SUGGESTED ANSWER
    {
        auto l_anshdr = layout(L"SUGGESTED ANSWER", f_small_bold.get(), 140.0f, 20.0f);
        text_centered_v(l_anshdr.get(), right_r.left + 14.0f, sec_y, pal.muted);

        // Badge: • Ready / • Gerando / • Standby
        const float rdy_x = right_r.left + 14.0f + width_of(l_anshdr.get()) + 10.0f;
        const D2D1_RECT_F rdy_r = D2D1::RectF(rdy_x, sec_y - 9.0f, rdy_x + 65.0f, sec_y + 9.0f);
        const bool is_generating = (sv && !sv->done) || shot_busy;
        const bool is_ready = sv && sv->done && !sv->body.empty();
        fill_round(rdy_r, 4.0f, is_generating ? rgba(245, 158, 11, 0.12f) : (is_ready ? rgba(16, 185, 129, 0.12f) : rgba(255, 255, 255, 0.05f)));
        stroke_round(rdy_r, 4.0f, is_generating ? rgba(245, 158, 11, 0.35f) : (is_ready ? rgba(16, 185, 129, 0.30f) : pal.border), 1.0f);
        dot(rdy_r.left + 8.0f, sec_y, 2.5f, is_generating ? rgba(245, 158, 11, 1.0f) : (is_ready ? pal.green : pal.muted));
        auto l_rdy = layout(is_generating ? L"Gerando" : (is_ready ? L"Ready" : L"Standby"), f_small.get(), 45.0f, 18.0f);
        text_centered_v(l_rdy.get(), rdy_r.left + 16.0f, sec_y, is_generating ? rgba(245, 158, 11, 1.0f) : (is_ready ? pal.green : pal.muted));

        sec_y += 18.0f;

        if (sv && !sv->body.empty()) {
            const auto formatted = format_suggestion(sv->body, !sv->done);
            for (const auto& fl : formatted) {
                if (sec_y > right_r.bottom - 74.0f) break;
                const bool bullet = fl.kind == FormattedLine::Kind::Bullet;
                const float indent = bullet ? 16.0f : 0.0f;
                if (bullet) dot(right_r.left + 18.0f, sec_y + 7.0f, 2.5f, pal.green);
                auto l = rich_layout(fl.segments, f_small.get(), right_w - 30.0f - indent);
                text_centered_v(l.get(), right_r.left + 18.0f + indent, sec_y + 7.0f, pal.text_sub);
                sec_y += std::max(18.0f, height_of(l.get())) + 4.0f;
            }
        } else if (shot_busy) {
            dot(right_r.left + 18.0f, sec_y + 7.0f, 2.5f, rgba(245, 158, 11, 1.0f));
            auto l_load = layout(L"Capturando tela do monitor e enviando para o modelo multimodal...", f_small.get(), right_w - 30.0f, 24.0f);
            text_centered_v(l_load.get(), right_r.left + 26.0f, sec_y + 7.0f, pal.text);
            sec_y += 24.0f;
        } else if (sv && !sv->done) {
            dot(right_r.left + 18.0f, sec_y + 7.0f, 2.5f, pal.green);
            auto l_load = layout(L"Consultando base de conhecimento RAG e formulando resposta técnica...", f_small.get(), right_w - 30.0f, 24.0f);
            text_centered_v(l_load.get(), right_r.left + 26.0f, sec_y + 7.0f, pal.text);
            sec_y += 24.0f;
        } else {
            auto l_empty1 = layout(L"Nenhuma sugestão gerada no momento.", f_small_bold.get(), right_w - 30.0f, 20.0f);
            text_centered_v(l_empty1.get(), right_r.left + 18.0f, sec_y + 7.0f, pal.text);
            sec_y += 20.0f;
            auto l_empty2 = line_layout(L"O copiloto transcreve a conversa e formula respostas com base no currículo ao detectar perguntas. Pressione Answer (⌘ ↵) ou envie uma dúvida no chat acima.", f_small.get(), right_w - 30.0f);
            text_centered_v(l_empty2.get(), right_r.left + 18.0f, sec_y + 6.0f, pal.text_sub);
            sec_y += height_of(l_empty2.get()) + 8.0f;
        }
        sec_y += 8.0f;
    }

    // 4. Section 3: KEY TALKING POINTS
    {
        auto l_pts = layout(L"KEY TALKING POINTS", f_small_bold.get(), 140.0f, 20.0f);
        text_centered_v(l_pts.get(), right_r.left + 14.0f, sec_y, pal.muted);
        sec_y += 16.0f;

        const wchar_t* pills[] = {
            L"Estrutura STAR",
            L"Impacto & Métricas",
            L"Trade-offs Técnicos",
            L"Exemplo Prático"
        };
        float px = right_r.left + 14.0f;
        for (int i = 0; i < 4; ++i) {
            auto lp = layout(pills[i], f_small.get(), 200.0f, 20.0f);
            const float pw = width_of(lp.get()) + 18.0f;
            const D2D1_RECT_F pr = D2D1::RectF(px, sec_y - 10.0f, px + pw, sec_y + 10.0f);
            const bool hov = hover == (kChipPickBase + i);
            fill_round(pr, 10.0f, hov ? rgba(255, 255, 255, 0.10f) : rgba(255, 255, 255, 0.05f));
            stroke_round(pr, 10.0f, hov ? pal.accent_soft : pal.border, 1.0f);
            text_centered_v(lp.get(), px + 9.0f, sec_y, hov ? pal.text : pal.text_sub);
            add_hit(pr, kChipPickBase + i, pills[i]);
            px += pw + 8.0f;
        }
        sec_y += 20.0f;
    }

    // 5. Section 4: LIKELY FOLLOW-UPS
    {
        auto l_fu = layout(L"LIKELY FOLLOW-UPS", f_small_bold.get(), 140.0f, 20.0f);
        text_centered_v(l_fu.get(), right_r.left + 14.0f, sec_y, pal.muted);
        sec_y += 16.0f;

        const wchar_t* fus[] = {
            L"↪  Como você mensurou as métricas de sucesso dessa entrega na prática?",
            L"↪  Quais foram os principais desafios técnicos de concorrência ou escala?"
        };
        for (int i = 0; i < 2; ++i) {
            const D2D1_RECT_F fr = D2D1::RectF(right_r.left + 14.0f, sec_y - 8.0f, right_r.right - 14.0f, sec_y + 12.0f);
            const bool hov = hover == (kFollowUpRowBase + i);
            fill_round(fr, 4.0f, hov ? rgba(255, 255, 255, 0.04f) : rgba(0, 0, 0, 0.0f));
            auto lf = line_layout(fus[i], f_small.get(), right_w - 30.0f);
            text_centered_v(lf.get(), fr.left + 4.0f, sec_y, hov ? pal.text : pal.text_sub);
            add_hit(fr, kFollowUpRowBase + i, fus[i]);
            sec_y += 20.0f;
        }
    }

    return top_y + card_h;
}

// Pulse_Bar (Req 13.1, 13.4, 13.5): three vertical micro-bars, each 12 DIP
// wide, whose heights follow the capture RMS through the pure
// ui::pulse_bar_height mapping (RMS 0 -> 2 DIP, >=1 -> 24 DIP). This is the
// single listening-activity indicator, repainted at 60 fps by kTimerAnim, and
// it fully replaces the old rotating spinner. When the RMS is unavailable all
// three bars stay at the 2 DIP minimum (Req 13.5). A small per-bar phase keeps
// the motion lively without ever dropping below the mapped floor. Returns the
// total width drawn so the caller can advance its layout cursor.
float OverlayWindow::Impl::draw_pulse_bar(float x, float cy, float rms, bool available) {
    constexpr float kBarW = 12.0f;   // Req 13.1: each micro-bar is 12 DIP wide
    constexpr float kBarGap = 4.0f;
    // Unavailable RMS floors to the minimum (Req 13.5); otherwise the mapped
    // height drives a subtle per-bar wave so the three bars are distinguishable.
    const float base = available ? ui::pulse_bar_height(rms) : kPulseBarMinDIP;
    const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::steady_clock::now().time_since_epoch()).count();
    for (int i = 0; i < 3; ++i) {
        float h = base;
        if (available && base > kPulseBarMinDIP) {
            const float phase = static_cast<float>((ms + i * 140) % 560) / 560.0f;
            const float wobble = 0.82f + 0.18f * (0.5f * (1.0f - std::cos(phase * 6.2831853f)));
            h = std::clamp(base * wobble, kPulseBarMinDIP, kPulseBarMaxDIP);
        }
        const float bx = x + static_cast<float>(i) * (kBarW + kBarGap);
        const float a = available && base > kPulseBarMinDIP ? 0.95f : 0.45f;
        fill_round(D2D1::RectF(bx, cy - h / 2.0f, bx + kBarW, cy + h / 2.0f), 3.0f, with_alpha(pal.accent_soft, a));
    }
    return 3.0f * kBarW + 2.0f * kBarGap;
}

// Horizontal top-edge shimmer shown while a suggestion is generating (Req
// 13.2): a 2 DIP band spanning the top edge whose opacity oscillates smoothly
// between 0.04 and 0.12 over a full 1200 ms cycle, continuously.
void OverlayWindow::Impl::draw_shimmer(const D2D1_RECT_F& r) {
    const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::steady_clock::now().time_since_epoch()).count();
    const float t = static_cast<float>(ms % 1200) / 1200.0f; // 0..1 over 1200 ms
    // Cosine ease gives a smooth 0..1 wave; map onto the [0.04, 0.12] band.
    const float wave = 0.5f * (1.0f - std::cos(t * 6.2831853f));
    const float alpha = 0.04f + (0.12f - 0.04f) * wave;
    const D2D1_RECT_F s = D2D1::RectF(r.left, r.top, r.right, r.top + 2.0f);
    fill_round(s, 1.0f, with_alpha(pal.accent_soft, alpha));
}

// Level indicator for one capture toggle: three vertical micro-bars whose
// height tracks `level01` (0..1). An inactive toggle passes level01 == 0, which
// collapses all three bars to the minimum height — a flat 0% meter (Req 2.6).
void OverlayWindow::Impl::draw_toggle_level(float x, float cy, float level01, bool active, bool speaking) {
    const float shape[3] = {0.55f, 1.0f, 0.7f};
    const float lvl = active ? std::clamp(level01, 0.0f, 1.0f) : 0.0f;
    const D2D1_COLOR_F c = !active                ? with_alpha(pal.muted, 0.5f)
                           : speaking             ? pal.green
                                                   : with_alpha(pal.green, 0.5f);
    for (int i = 0; i < 3; ++i) {
        const float h = 3.0f + 11.0f * std::min(1.0f, lvl * shape[i] * 1.4f);
        const float bx = x + static_cast<float>(i) * 5.0f;
        fill_round(D2D1::RectF(bx, cy - h / 2.0f, bx + 3.0f, cy + h / 2.0f), 1.5f, c);
    }
}

// Strip_Unificada (Req 2.3): a 38 DIP glass bar holding exactly two capture
// toggles (system audio = Loopback, microphone = Microphone), each with a
// recording dot + a level meter (Req 2.4-2.6), plus a right-aligned ellipsis
// menu that collapses the configuration (Req 2.7). ui::pick_density() picks
// between icons-only (narrow) and labels + key hints (wide) at the collapse
// threshold (Req 2.8, 2.9).
float OverlayWindow::Impl::draw_unified_strip(float y) {
    const float L = kMargin, R = width - kMargin;
    const D2D1_RECT_F sr = D2D1::RectF(L, y + kGap, R, y + kGap + kUnifiedStripH);
    panel(sr, pal.bar);
    add_hit(sr, kDragArea); // empty strip area drags the window (lowest priority)
    const float cy = (sr.top + sr.bottom) / 2.0f;

    // shimmer on the top edge while a suggestion is still generating (Req 13.2).
    const SuggestionView* sv = history.empty() ? nullptr : &history.back();
    if (sv && !sv->done) draw_shimmer(sr);

    // Two capture toggles. Each needs: a hit rect, an icon, a recording dot and
    // a level meter. At the two richer densities we also draw a label and key
    // hint; the most compact density is icon + dot + meter only (Req 2.8/2.9).
    static const KeyHint k_sys{L"Ctrl Alt", nullptr, "monitor"};
    static const KeyHint k_mic{L"Ctrl Alt", nullptr, "mic"};
    struct Toggle {
        AudioSource src;
        int id;
        const wchar_t* label;
        const KeyHint* k;
    };
    const Toggle toggles[] = {
        {AudioSource::Loopback, kSrcOutros, L"System", &k_sys},
        {AudioSource::Microphone, kSrcVoce, L"Microphone", &k_mic},
    };

    // Fixed glyph cluster per toggle: dot(10) + icon(20) + meter(18) + pad.
    constexpr float kCluster = 10.0f + 20.0f + 18.0f + 8.0f; // ~56 DIP
    const float menu_w = 30.0f;                              // ellipsis button
    const float gap = 8.0f;

    // Candidate widths from richest (labels + key hints) to most compact
    // (icons only) so ui::pick_density can return the first that fits (Req 2.8).
    static const KeyHint k_mode{L"Ctrl Alt", L"M", "file-text"};
    std::vector<float> totals;
    for (std::size_t d = 0; d < 3; ++d) {
        const bool with_label = d < 2;
        const bool with_kbd = d == 0;
        float w = 0.0f;
        for (const auto& t : toggles) {
            w += kCluster;
            if (with_label) w += text_w(t.label, f_small.get()) + 8.0f;
            if (with_kbd) w += kbd_width(*t.k) + 4.0f;
            w += gap;
        }
        const wchar_t* mode_lbl = with_label ? (with_kbd ? L"Transcription only" : L"Transcription") : L"";
        float mw = 20.0f + 16.0f;
        if (with_label) mw += text_w(mode_lbl, f_small.get()) + 8.0f;
        if (with_kbd) mw += kbd_width(k_mode) + 4.0f;
        w += mw + gap;

        totals.push_back(w + menu_w + 2.0f * kMargin + 8.0f);
    }
    const std::size_t d = ui::pick_density(R - L, totals);
    const bool with_label = d < 2;
    const bool with_kbd = d == 0;

    float x = L + 10.0f;
    for (const auto& t : toggles) {
        const auto& lane = lanes[static_cast<std::size_t>(t.src)];
        const bool recording = lane.enabled && !lane.paused; // active toggle (Req 2.5)
        const bool err = lane.state == LinkState::Error;

        // Width of this toggle at the chosen density.
        float tw = kCluster;
        if (with_label) tw += text_w(t.label, f_small.get()) + 8.0f;
        if (with_kbd) tw += kbd_width(*t.k) + 4.0f;
        const D2D1_RECT_F r = D2D1::RectF(x, cy - 15.0f, x + tw, cy + 15.0f);
        fill_round(r, 15.0f, button_fill(t.id, true));

        float gx = x + 6.0f;
        // Recording dot: active state when recording, inactive otherwise (Req 2.5/2.6).
        D2D1_COLOR_F dc = pal.muted;
        if (recording) {
            dc = err ? pal.red
                 : (lane.state == LinkState::Connecting || lane.state == LinkState::Reconnecting) ? pal.amber
                                                                                                   : pal.red;
        }
        dot(gx, cy, recording ? 4.0f : 3.0f, with_alpha(dc, recording ? 1.0f : 0.5f));
        gx += 12.0f;

        // Source icon.
        const char* ic = t.src == AudioSource::Loopback ? (recording ? "monitor" : "monitor-off")
                                                         : (recording ? "mic" : "mic-off");
        icon(ic, gx + 8.0f, cy, 16.0f, err ? pal.red : (recording ? pal.text : pal.muted));
        gx += 20.0f;

        // Level meter: live level when active, flat 0% when inactive (Req 2.5/2.6).
        draw_toggle_level(gx, cy, lane.level, recording, lane.speaking);
        gx += 18.0f;

        if (with_label) {
            auto ll = line_layout(t.label, f_small.get(), tw - (gx - x) - 4.0f);
            text_centered_v(ll.get(), gx + 2.0f, cy, recording ? pal.text : pal.muted);
            gx += text_w(t.label, f_small.get()) + 8.0f;
            if (with_kbd) draw_kbd(*t.k, gx, cy);
        }

        // Tooltip describing the toggle state.
        std::string who = t.src == AudioSource::Loopback ? "System audio (Others)" : "Microphone (You)";
        std::string stt;
        if (!lane.enabled) stt = "disabled in config.ini";
        else if (lane.paused) stt = "paused · click to resume";
        else if (err) stt = "error: " + lane.detail;
        else stt = "recording · click to pause";
        add_hit(r, t.id, widen(who + ": " + stt));
        x += tw + gap;
    }

    // Mode_Toggle: Somente transcrição (Req 1.2, 1.6)
    {
        const bool active = transcription_only;
        const wchar_t* mode_lbl = with_label ? (with_kbd ? L"Transcription only" : L"Transcription") : L"";
        float tw = 20.0f + 14.0f;
        if (with_label) tw += text_w(mode_lbl, f_small.get()) + 8.0f;
        if (with_kbd) tw += kbd_width(k_mode) + 4.0f;

        const D2D1_RECT_F r = D2D1::RectF(x, cy - 15.0f, x + tw, cy + 15.0f);
        fill_round(r, 15.0f, active ? with_alpha(pal.accent, 0.28f) : button_fill(kToggleTranscriptionOnly, true));
        if (active) {
            stroke_round(r, 15.0f, pal.accent, 1.0f);
        }

        float gx = x + 8.0f;
        icon("file-text", gx + 6.0f, cy, 14.0f, active ? pal.accent : pal.muted);
        gx += 18.0f;

        if (with_label) {
            auto ll = line_layout(mode_lbl, f_small.get(), tw - (gx - x) - 4.0f);
            text_centered_v(ll.get(), gx + 2.0f, cy, active ? pal.accent : pal.muted);
            gx += text_w(mode_lbl, f_small.get()) + 8.0f;
            if (with_kbd) draw_kbd(k_mode, gx, cy);
        }

        add_hit(r, kToggleTranscriptionOnly, active ? L"Disable Transcription-Only Mode (Ctrl Alt M)" : L"Enable Transcription-Only Mode (Ctrl Alt M)");
        x += tw + gap;
    }

    // Pulse_Bar (Req 13.1, 13.4, 13.5): the single listening-activity indicator,
    // shown while capturing the interviewer (system audio active). It sits just
    // left of the ellipsis menu and tracks the live loopback RMS at 60 fps. When
    // the RMS is unavailable (no level source or capture paused) the three bars
    // rest at the 2 DIP minimum. No spinning element is drawn in any state.
    {
        const auto& sys = lanes[static_cast<std::size_t>(AudioSource::Loopback)];
        const bool listening = sys.enabled && !sys.paused;
        const bool rms_available = listening && static_cast<bool>(cb.poll_levels);
        const float rms = rms_available ? sys.level : 0.0f;
        constexpr float kPulseW = 3.0f * 12.0f + 2.0f * 4.0f; // matches draw_pulse_bar
        const float px = R - menu_w - 10.0f - kPulseW;
        draw_pulse_bar(px, cy, rms, rms_available);
    }

    // Right-aligned ellipsis menu that collapses the configuration (Req 2.7).
    icon_button(D2D1::RectF(R - menu_w, cy - 15.0f, R, cy + 15.0f), kBtnMenu, "ellipsis-vertical",
                L"Settings", nullptr, !menu_open);

    return sr.bottom;
}

// Draw a single Score_Ring (Req 9.2/9.3): a faint full-circle track and, on top
// of it, the coloured arc swept clockwise from 12 o'clock over `theta_deg`
// degrees. The arc is a geometry built with ID2D1PathGeometry +
// ID2D1GeometrySink::AddArc and stroked (round caps) so partial sweeps look
// clean. A theta of 0 draws no arc; a theta of 360 draws the full circle. The
// numeric score sits centred inside and the dimension name below.
void OverlayWindow::Impl::draw_score_ring(float cx, float cy, float radius, float theta_deg,
                                          const D2D1_COLOR_F& color, float score, const wchar_t* label) {
    const float stroke_w = std::max(4.0f, radius * 0.18f);
    // Faint track behind the arc.
    brush->SetColor(with_alpha(pal.text, 0.10f));
    rt->DrawEllipse(D2D1::Ellipse(D2D1::Point2F(cx, cy), radius, radius), brush.get(), stroke_w);

    const float theta = std::clamp(theta_deg, 0.0f, 360.0f);
    if (theta > 0.1f) {
        const auto polar = [&](float deg) {
            // 0 deg at 12 o'clock, sweeping clockwise.
            const float rad = (deg - 90.0f) * 3.14159265358979323846f / 180.0f;
            return D2D1::Point2F(cx + radius * std::cos(rad), cy + radius * std::sin(rad));
        };
        ComPtr<ID2D1PathGeometry> g;
        ComPtr<ID2D1GeometrySink> sink;
        if (SUCCEEDED(d2d->CreatePathGeometry(g.put())) && SUCCEEDED(g->Open(sink.put()))) {
            const D2D1_POINT_2F start = polar(0.0f);
            sink->BeginFigure(start, D2D1_FIGURE_BEGIN_HOLLOW);
            // A single AddArc cannot represent a full 360 deg sweep (start == end
            // would collapse it), so draw the complete circle as two half-arcs.
            if (theta >= 359.9f) {
                D2D1_ARC_SEGMENT a1{};
                a1.point = polar(180.0f);
                a1.size = D2D1::SizeF(radius, radius);
                a1.rotationAngle = 0.0f;
                a1.sweepDirection = D2D1_SWEEP_DIRECTION_CLOCKWISE;
                a1.arcSize = D2D1_ARC_SIZE_SMALL;
                sink->AddArc(a1);
                D2D1_ARC_SEGMENT a2 = a1;
                a2.point = polar(359.99f);
                sink->AddArc(a2);
            } else {
                D2D1_ARC_SEGMENT arc{};
                arc.point = polar(theta);
                arc.size = D2D1::SizeF(radius, radius);
                arc.rotationAngle = 0.0f;
                arc.sweepDirection = D2D1_SWEEP_DIRECTION_CLOCKWISE;
                arc.arcSize = theta > 180.0f ? D2D1_ARC_SIZE_LARGE : D2D1_ARC_SIZE_SMALL;
                sink->AddArc(arc);
            }
            sink->EndFigure(D2D1_FIGURE_END_OPEN);
            if (SUCCEEDED(sink->Close())) {
                brush->SetColor(color);
                rt->DrawGeometry(g.get(), brush.get(), stroke_w, round_stroke.get());
            }
        }
    }

    // Centred score (one decimal) and the dimension label just below the ring.
    char sbuf[16];
    std::snprintf(sbuf, sizeof(sbuf), "%.1f", static_cast<double>(std::clamp(score, 0.0f, 10.0f)));
    auto ls = layout(widen(sbuf), f_body_bold.get(), radius * 2.0f, radius * 2.0f);
    if (ls) {
        ls->SetTextAlignment(DWRITE_TEXT_ALIGNMENT_CENTER);
        draw_text(ls.get(), cx - radius, cy - height_of(ls.get()) / 2.0f, pal.text);
    }
    auto ll = layout(label, f_small.get(), radius * 2.4f, 30.0f);
    if (ll) {
        ll->SetTextAlignment(DWRITE_TEXT_ALIGNMENT_CENTER);
        draw_text(ll.get(), cx - radius * 1.2f, cy + radius + stroke_w / 2.0f + 4.0f, pal.muted);
    }
}

// PostInterviewReport dashboard (Req 9.1-9.4): three Score_Rings across the top
// (Relevance orange, Accuracy green, Clarity lilac — the fixed order/colour the
// pure build_rings model produced) and the three Instant_Feedback lines beside
// them (here: stacked below, within the HUD column width). Theta animates from 0
// to each ring's target via anim_tick (Req 9.2). This only draws — the window
// styles stay as the HUD set them (Req 9.6).
float OverlayWindow::Impl::draw_dashboard(float y) {
    const float L = kMargin, R = width - kMargin;
    const float inner_w = R - L;
    const float title_h = 28.0f;
    const float ring_label_w = inner_w / 3.0f;
    const float radius = std::min(44.0f, (ring_label_w - 16.0f) / 2.0f);
    const float rings_h = 2.0f * radius + 28.0f; // arc + label line
    const float feedback_line_h = 24.0f;
    const float panel_h = title_h + rings_h + 14.0f + 3.0f * feedback_line_h + 20.0f;

    const D2D1_RECT_F card = D2D1::RectF(L, y, R, y + panel_h);
    panel(card, pal.panel);
    add_hit(card, kDragArea);

    float cy = y + 14.0f;
    // Title.
    auto lt = layout(L"Post-Interview Report", f_body_bold.get(), inner_w - 24.0f, title_h);
    if (lt) draw_text(lt.get(), L + 14.0f, cy, pal.text);
    cy += title_h;

    // Three rings, evenly spaced across the column.
    static const wchar_t* kLabels[3] = {L"Relevance", L"Accuracy", L"Clarity"};
    const float ring_cy = cy + radius + 4.0f;
    for (std::size_t i = 0; i < ring_specs_.size(); ++i) {
        const float ring_cx = L + ring_label_w * (static_cast<float>(i) + 0.5f);
        const std::uint32_t c = ring_specs_[i].color;
        const D2D1_COLOR_F color = rgba((c >> 16) & 0xFF, (c >> 8) & 0xFF, c & 0xFF);
        draw_score_ring(ring_cx, ring_cy, radius, ring_theta_cur_[i], color, ring_specs_[i].score, kLabels[i]);
    }
    cy += rings_h + 14.0f;

    // Instant_Feedback: exactly three lines (already normalized), beside the
    // rings in the layout sense — stacked under them within the HUD column
    // (Req 9.4). Empty slots simply render nothing.
    for (const auto& line : report_.feedback_lines) {
        if (!line.empty()) {
            auto lf = layout(widen(line), f_body.get(), inner_w - 28.0f, feedback_line_h);
            if (lf) {
                dot(L + 16.0f, cy + feedback_line_h / 2.0f, 2.5f, pal.muted);
                draw_text(lf.get(), L + 24.0f, cy + (feedback_line_h - height_of(lf.get())) / 2.0f, pal.text_sub);
            }
        }
        cy += feedback_line_h;
    }

    return y + panel_h;
}

float OverlayWindow::Impl::draw_notice(float y) {
    const auto now = std::chrono::steady_clock::now();
    if (!notice.empty() && notice_level != NoticeLevel::Error &&
        now - notice_at > std::chrono::seconds(notice_level == NoticeLevel::Info ? 6 : 12)) {
        notice.clear();
    }
    if (notice.empty()) return y;
    const float L = kMargin, R = width - kMargin;
    const D2D1_COLOR_F c = notice_level == NoticeLevel::Error ? pal.red
                           : notice_level == NoticeLevel::Warning ? pal.amber
                                                                   : pal.accent_soft;
    auto l = layout(widen(notice), f_small.get(), R - L - 52.0f, 3 * 18.0f);
    if (l) {
        DWRITE_TRIMMING trim{DWRITE_TRIMMING_GRANULARITY_WORD, 0, 0};
        l->SetTrimming(&trim, ellipsis_small.get());
    }
    const float h = std::max(34.0f, std::min(height_of(l.get()), 3 * 18.0f) + 16.0f);
    const D2D1_RECT_F r = D2D1::RectF(L, y + kGap, R, y + kGap + h);
    fill_round(r, 12.0f, rgba(28, 28, 31, 0.95f));
    stroke_round(D2D1::RectF(r.left + 0.5f, r.top + 0.5f, r.right - 0.5f, r.bottom - 0.5f), 11.5f, with_alpha(c, 0.55f));
    icon(notice_level == NoticeLevel::Info ? "info" : "triangle-alert", r.left + 18.0f, (r.top + r.bottom) / 2, 15.0f, c);
    text_centered_v(l.get(), r.left + 34.0f, (r.top + r.bottom) / 2, pal.text);
    add_hit(r, kNotice, L"Click to dismiss");
    return r.bottom;
}

void OverlayWindow::Impl::draw_tooltip(float max_y) {
    (void)max_y;
    if (hover == kNone || pressed != kNone || resizing) return;
    if (std::chrono::steady_clock::now() - hover_since < std::chrono::milliseconds(550)) return;
    const Hit* h = nullptr;
    for (auto it = hits.rbegin(); it != hits.rend(); ++it) {
        if (it->id == hover) {
            h = &*it;
            break;
        }
    }
    if (!h || h->tip.empty()) return;
    auto l = layout(h->tip, f_small.get(), std::min(420.0f, width - 2 * kMargin - 20.0f));
    const float tw = width_of(l.get()) + 20.0f, th = height_of(l.get()) + 12.0f;
    float x = std::clamp((h->r.left + h->r.right) / 2 - tw / 2, kMargin, width - kMargin - tw);
    float y = h->r.bottom + 6.0f;
    fill_round(D2D1::RectF(x, y, x + tw, y + th), 8.0f, rgba(12, 12, 14, 0.97f));
    stroke_round(D2D1::RectF(x + 0.5f, y + 0.5f, x + tw - 0.5f, y + th - 0.5f), 7.5f, pal.border);
    draw_text(l.get(), x + 10.0f, y + 6.0f, pal.text);
    tooltip_bottom = y + th;
}

// ---------------------------------------------------------------------------
// Render: one pass into the layered bitmap; the window takes the height of
// whatever was drawn.
// ---------------------------------------------------------------------------

void OverlayWindow::Impl::render() {
    if (!hwnd || hidden) return;
    if (!ensure_device()) return;
    const float work = work_height_dip();
    const int wpx = static_cast<int>(std::ceil(width * scale));
    const int max_hpx = static_cast<int>(std::ceil((work + 260.0f) * scale));
    if (!ensure_surface(static_cast<int>(std::ceil(kMaxW * scale)) + 4, max_hpx)) return;
    RECT bind{0, 0, wpx, max_hpx};
    if (FAILED(rt->BindDC(mem_dc, &bind))) {
        discard_device();
        return;
    }
    rt->SetDpi(static_cast<float>(dpi), static_cast<float>(dpi));
    rt->BeginDraw();
    rt->SetTransform(D2D1::Matrix3x2F::Identity());
    rt->Clear(D2D1::ColorF(0, 0, 0, 0));

    layout_failed = false; // Req 14.5: set by layout() if any block fails this frame
    // Mark every cached block as untouched; layout() flags the ones actually
    // used this frame so the post-draw sweep can drop stale blocks (e.g. the
    // ever-changing streaming body) and keep the cache bounded (Req 14.4).
    for (auto& kv : layout_cache) kv.second.used = false;
    hits.clear();
    tooltip_bottom = 0.0f;
    float y = kMargin;
    if (mode_ == OverlayMode::PostInterviewReport) {
        // Jev Dashboard (Req 9.1-9.4). Nothing from the live HUD is drawn; the
        // window styles are untouched (Req 9.6).
        y = draw_dashboard(y);
        y = draw_notice(y);
    } else {
    // Keep the action bar and transcript strip separate in live mode. This is
    // easier to scan and preserves enough horizontal room for the reference
    // layout's actions and source indicators.
    y = draw_control_bar(y);
    y = draw_strip(y);
    y = draw_menu(y);
    y = draw_answer(y);
    y = draw_notice(y);
    }
    // Right-edge grip for resizing the width (highest priority, 5 px).
    add_hit(D2D1::RectF(width - kMargin - 4.0f, kMargin, width, y), kResize, L"");
    draw_tooltip(y);
    const float bottom = std::max(y, tooltip_bottom) + kMargin;

    // Evict blocks not drawn this frame once the cache grows past a small
    // budget. Stable blocks (headline, anchors, footer, button labels) are
    // touched every frame and survive; transient streaming text is dropped so
    // the cache cannot grow without bound (Req 14.4). Never evict while a
    // layout failed this frame — we may still need the last valid entry.
    if (!layout_failed && layout_cache.size() > 128) {
        for (auto it = layout_cache.begin(); it != layout_cache.end();) {
            if (!it->second.used) it = layout_cache.erase(it);
            else ++it;
        }
    }

    const HRESULT hr = rt->EndDraw();
    if (hr == static_cast<HRESULT>(D2DERR_RECREATE_TARGET)) {
        discard_device();
        invalidate();
        return;
    }
    // Req 14.5: if any text block failed to (re)create its layout this frame,
    // keep the last valid cache for that block (done inside layout()), preserve
    // the previously presented frame — do NOT push this partial bitmap to the
    // window — and log an error. The very first frame has nothing to preserve,
    // so we still present it rather than show a blank window.
    if (layout_failed && have_presented_frame) {
        set_notice(NoticeLevel::Error,
                   "Could not render a text block; keeping the previous frame.", false);
        return;
    }

    const int hpx = std::min(max_hpx, static_cast<int>(std::ceil(bottom * scale)));
    POINT src{0, 0};
    SIZE size{wpx, hpx};
    BLENDFUNCTION blend{AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
    UpdateLayeredWindow(hwnd, nullptr, nullptr, &size, mem_dc, &src, 0, &blend, ULW_ALPHA);
    have_presented_frame = true;
    // Clear any stale window region from previous builds (was clipping at 400px)
    SetWindowRgn(hwnd, nullptr, FALSE);
}

// ---------------------------------------------------------------------------
// Window procedure
// ---------------------------------------------------------------------------

int OverlayWindow::Impl::hit_at(float x, float y) const {
    for (auto it = hits.rbegin(); it != hits.rend(); ++it) {
        if (x >= it->r.left && x < it->r.right && y >= it->r.top && y < it->r.bottom) return it->id;
    }
    return kNone;
}

LRESULT CALLBACK OverlayWindow::Impl::wndproc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_NCCREATE) {
        auto* cs = reinterpret_cast<CREATESTRUCTW*>(l);
        SetWindowLongPtrW(h, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
    }
    auto* self = reinterpret_cast<Impl*>(GetWindowLongPtrW(h, GWLP_USERDATA));
    if (!self) return DefWindowProcW(h, m, w, l);
    if (!self->hwnd) self->hwnd = h;
    return self->handle(m, w, l);
}

LRESULT OverlayWindow::Impl::handle(UINT m, WPARAM w, LPARAM l) {
    auto client_dip = [&](LPARAM lp) {
        return D2D1::Point2F(static_cast<float>(GET_X_LPARAM(lp)) / scale, static_cast<float>(GET_Y_LPARAM(lp)) / scale);
    };
    switch (m) {
        case WM_APP_DRAIN:
            drain();
            return 0;
        case WM_APP_SHOT_DONE:
            shot_busy = false;
            if (w == 0) set_notice(NoticeLevel::Error, "Could not encode the screenshot (WIC).", false);
            invalidate();
            return 0;
        case WM_TIMER:
            if (w == kTimerRender) {
                KillTimer(hwnd, kTimerRender);
                render_pending = false;
                render();
            } else if (w == kTimerAnim) {
                anim_tick();
            } else if (w == kTimerShot) {
                finish_screenshot();
            } else if (w == kTimerClock) {
                if (menu_open || !notice.empty()) invalidate();
            }
            return 0;
        case WM_HOTKEY:
            on_hotkey(static_cast<int>(w));
            return 0;
        case WM_MOUSEACTIVATE:
            return MA_NOACTIVATE; // clicks never steal focus; the chat field asks for it explicitly
        case WM_NCHITTEST: {
            POINT pt{GET_X_LPARAM(l), GET_Y_LPARAM(l)};
            ScreenToClient(hwnd, &pt);
            const int id = hit_at(static_cast<float>(pt.x) / scale, static_cast<float>(pt.y) / scale);
            return (id == kDragArea || id == kBtnMove) ? HTCAPTION : HTCLIENT;
        }
        case WM_SETCURSOR:
            if (LOWORD(l) == HTCLIENT) {
                POINT pt{};
                GetCursorPos(&pt);
                ScreenToClient(hwnd, &pt);
                const int id = resizing ? kResize : hit_at(static_cast<float>(pt.x) / scale, static_cast<float>(pt.y) / scale);
                LPCWSTR cur = reinterpret_cast<LPCWSTR>(IDC_ARROW);
                if (id == kResize) cur = reinterpret_cast<LPCWSTR>(IDC_SIZEWE);
                else if (id == kChatField) cur = reinterpret_cast<LPCWSTR>(IDC_IBEAM);
                else if (id >= kSrcOutros) cur = reinterpret_cast<LPCWSTR>(IDC_HAND);
                SetCursor(LoadCursorW(nullptr, cur));
                return TRUE;
            }
            break;
        case WM_MOUSEMOVE: {
            if (!tracking_leave) {
                TRACKMOUSEEVENT tme{sizeof(tme), TME_LEAVE, hwnd, 0};
                tracking_leave = TrackMouseEvent(&tme) != FALSE;
            }
            if (resizing) {
                POINT pt{};
                GetCursorPos(&pt);
                const float nw = ui::clamp_width(resize_start_w + static_cast<float>(pt.x - resize_start_x) / scale);
                if (std::fabs(nw - width) >= 1.0f) {
                    width = nw;
                    reposition(/*use_persisted=*/true); // keep Top-Center as width changes (Req 1.4)
                    render(); // immediate: the grip should follow the pointer
                }
                return 0;
            }
            const auto p = client_dip(l);
            const int id = hit_at(p.x, p.y);
            if (id != hover) {
                hover = id;
                hover_since = std::chrono::steady_clock::now();
                invalidate();
            }
            return 0;
        }
        case WM_MOUSELEAVE:
            tracking_leave = false;
            if (hover != kNone) {
                hover = kNone;
                invalidate();
            }
            return 0;
        case WM_LBUTTONDOWN: {
            const auto p = client_dip(l);
            const int id = hit_at(p.x, p.y);
            SetCapture(hwnd);
            if (id == kResize) {
                POINT pt{};
                GetCursorPos(&pt);
                resizing = true;
                resize_start_x = pt.x;
                resize_start_w = width;
                return 0;
            }
            pressed = id;
            invalidate();
            return 0;
        }
        case WM_LBUTTONUP: {
            const auto p = client_dip(l);
            const int id = hit_at(p.x, p.y);
            const bool was_resizing = resizing;
            const int was_pressed = pressed;
            resizing = false;
            pressed = kNone;
            if (GetCapture() == hwnd) ReleaseCapture();
            if (was_resizing) {
                save_state();
                invalidate();
                return 0;
            }
            if (was_pressed != kNone && was_pressed == id && id != kDragArea) {
                on_click(id);
            } else {
                if (menu_open && (id < kMenuRecap || id > kMenuConfig) && id != kBtnMenu) menu_open = false;
                invalidate();
            }
            return 0;
        }
        case WM_CAPTURECHANGED:
            if (resizing) save_state();
            resizing = false;
            pressed = kNone;
            return 0;
        case WM_MOUSEWHEEL: {
            const float delta = static_cast<float>(GET_WHEEL_DELTA_WPARAM(w)) / WHEEL_DELTA;
            scroll -= delta * 48.0f;
            user_scrolled = true;
            invalidate();
            return 0;
        }
        case WM_KEYDOWN:
        case WM_SYSKEYDOWN:
            if (chat_focused && chat_key(w)) {
                caret_t0 = std::chrono::steady_clock::now();
                invalidate();
                return 0;
            }
            break;
        case WM_CHAR:
            if (chat_focused) {
                const auto c = static_cast<char16_t>(w);
                if (c >= 0x20 && c != 0x7F) {
                    edit.insert(std::u16string(1, c));
                    caret_t0 = std::chrono::steady_clock::now();
                    invalidate();
                }
                return 0;
            }
            break;
        case WM_ACTIVATE:
            if (LOWORD(w) == WA_INACTIVE && chat_focused) {
                // The user clicked another app: give up focus, keep the text.
                chat_focused = false;
                prev_foreground = nullptr;
                LONG_PTR ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE);
                invalidate();
            }
            break;
        case WM_EXITSIZEMOVE:
            save_state();
            return 0;
        case WM_DPICHANGED: {
            dpi = HIWORD(w);
            scale = static_cast<float>(dpi) / 96.0f;
            const auto* r = reinterpret_cast<const RECT*>(l);
            SetWindowPos(hwnd, nullptr, r->left, r->top, 0, 0, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSIZE);
            release_surface();
            invalidate();
            return 0;
        }
        case WM_DISPLAYCHANGE:
            release_surface();
            invalidate();
            return 0;
        case WM_CLOSE:
            DestroyWindow(hwnd);
            return 0;
        case WM_DESTROY: {
            save_state();
            unregister_hotkeys();
            KillTimer(hwnd, kTimerRender);
            KillTimer(hwnd, kTimerClock);
            KillTimer(hwnd, kTimerAnim);
            KillTimer(hwnd, kTimerShot);
            queue.set_wake(nullptr); // producers stop posting to this HWND
            {
                std::lock_guard<std::mutex> lk(hwnd_mu);
                hwnd_for_post = nullptr;
            }
            PostQuitMessage(0);
            return 0;
        }
        case WM_NCDESTROY: {
            const HWND h = hwnd;
            release_surface();
            discard_device();
            SetWindowLongPtrW(h, GWLP_USERDATA, 0); // no more messages reach this Impl
            hwnd = nullptr;
            return DefWindowProcW(h, m, w, l);
        }
        default:
            break;
    }
    return DefWindowProcW(hwnd, m, w, l);
}

// ===========================================================================

OverlayWindow::OverlayWindow(OverlayOptions opts, OverlayCallbacks callbacks)
    : impl_(std::make_unique<Impl>(std::move(opts), std::move(callbacks))) {}

OverlayWindow::~OverlayWindow() {
    if (impl_->hwnd) DestroyWindow(impl_->hwnd);
    impl_->release_surface();
}

bool OverlayWindow::create(std::string* error) { return impl_->create(error); }

int OverlayWindow::run() {
    MSG msg{};
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    return static_cast<int>(msg.wParam);
}

void OverlayWindow::post(const EngineEvent& ev) { impl_->queue.push(ev); }

void OverlayWindow::request_close() {
    std::lock_guard<std::mutex> lk(impl_->hwnd_mu);
    if (impl_->hwnd_for_post) PostMessageW(impl_->hwnd_for_post, WM_CLOSE, 0, 0);
}

} // namespace rtai
