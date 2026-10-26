// Professional Desktop Application UI (inspired by Final Round AI / Notion / Linear):
//   - Resizable, Maximizable (WS_OVERLAPPEDWINDOW) + Fullscreen (F11) support
//   - Left Navigation Sidebar (Goals, + New Goal, Up Next / Saved Agents, Library RAG,
//     Google Calendar, Settings, and Mini-Compact Status Card)
//   - Top Breadcrumb & Action Bar with Coral-Red Primary CTA ("Iniciar Copilot")
//   - Centered Responsive Workspace with "Four steps to your interview" Hero Card
//     and tabbed workspaces (Goals & Empresa, Library RAG & Mini-Compact, Agenda, Settings)
#pragma once

#include <windows.h>
#include <commdlg.h>
#include <dwmapi.h>
#include <shellapi.h>
#include <uxtheme.h>

#pragma comment(lib, "uxtheme.lib")
#pragma comment(lib, "msimg32.lib")

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "rtai/config_win.hpp"
#include "rtai/ini.hpp"
#include "rtai/mini_agent.hpp"
#include "rtai/settings.hpp"
#include "rtai/text_util.hpp"
#include "rtai/web_search.hpp"

namespace rtai::gui {

namespace fs = std::filesystem;

// ===========================================================================
// 0. UTF-8 / WIN32 HELPERS & FINAL ROUND AI DESIGN PALETTE
// ===========================================================================

inline std::wstring widen_utf8(std::string_view s) {
    if (s.empty()) return {};
    const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring out(static_cast<std::size_t>(std::max(0, n)), L'\0');
    if (n > 0) MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), n);
    return out;
}

inline std::string narrow_utf8(std::wstring_view w) {
    if (w.empty()) return {};
    const int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
    std::string out(static_cast<std::size_t>(std::max(0, n)), '\0');
    if (n > 0) WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), out.data(), n, nullptr, nullptr);
    return out;
}

inline std::wstring to_edit_wstr(std::string_view utf8) {
    std::string crlf;
    crlf.reserve(utf8.size() + 64);
    for (std::size_t i = 0; i < utf8.size(); ++i) {
        if (utf8[i] == '\r') continue;
        if (utf8[i] == '\n') crlf += "\r\n";
        else crlf.push_back(utf8[i]);
    }
    return widen_utf8(crlf);
}

inline std::string read_hwnd_text(HWND control) {
    if (!control) return {};
    const int n = GetWindowTextLengthW(control);
    if (n <= 0) return {};
    std::wstring w(static_cast<std::size_t>(n + 1), L'\0');
    GetWindowTextW(control, w.data(), n + 1);
    w.resize(static_cast<std::size_t>(n));
    std::string s = narrow_utf8(w);
    std::string clean;
    clean.reserve(s.size());
    for (char c : s) {
        if (c != '\r') clean.push_back(c);
    }
    return clean;
}

inline void set_hwnd_text(HWND control, std::string_view utf8) {
    if (!control) return;
    const std::wstring w = to_edit_wstr(utf8);
    SetWindowTextW(control, w.c_str());
}

inline void enable_dark_titlebar_chrome(HWND hwnd) {
    BOOL dark = TRUE;
    DwmSetWindowAttribute(hwnd, 20, &dark, sizeof(dark)); // Dark titlebar like Final Round AI
    COLORREF caption_col = RGB(24, 24, 27);               // #18181B
    DwmSetWindowAttribute(hwnd, 35, &caption_col, sizeof(caption_col));
}

// Final Round AI / Notion Clean SaaS Palette (matching Image 2)
namespace palette {
    constexpr COLORREF kSidebarBg        = RGB(247, 247, 245); // #F7F7F5 warm sidebar
    constexpr COLORREF kSidebarBorder    = RGB(232, 231, 227); // #E8E7E3
    constexpr COLORREF kSidebarCard      = RGB(239, 238, 234); // #EFEEEA promo box
    constexpr COLORREF kSidebarHover     = RGB(236, 235, 231); // #ECEBE7
    constexpr COLORREF kSidebarActive    = RGB(229, 228, 223); // #E5E4DF

    constexpr COLORREF kCanvasBg         = RGB(255, 255, 255); // #FFFFFF crisp main workspace
    constexpr COLORREF kTopBarBg         = RGB(255, 255, 255); // #FFFFFF
    constexpr COLORREF kHeroCardBg       = RGB(250, 247, 242); // #FAF7F2 warm cream onboarding card
    constexpr COLORREF kHeroCardBorder   = RGB(237, 231, 220); // #EDE7DC
    constexpr COLORREF kCardBg           = RGB(252, 252, 251); // #FCFCFB
    constexpr COLORREF kCardBorder       = RGB(233, 232, 228); // #E9E8E4

    constexpr COLORREF kInputBg          = RGB(255, 255, 255); // #FFFFFF
    constexpr COLORREF kInputBorder      = RGB(218, 217, 212); // #DAD9D4
    constexpr COLORREF kInputFocus       = RGB(239, 68, 68);   // #EF4444 Coral accent focus

    constexpr COLORREF kTextInk          = RGB(25, 25, 24);    // #191918 primary headings
    constexpr COLORREF kTextBody         = RGB(55, 53, 47);    // #37352F body text
    constexpr COLORREF kTextMuted        = RGB(120, 119, 116); // #787774 eyebrows / subtitles
    constexpr COLORREF kTextSubtle       = RGB(155, 154, 151); // #9B9A97

    constexpr COLORREF kCoralPrimary     = RGB(240, 68, 56);   // #F04438 Final Round AI Coral CTA
    constexpr COLORREF kCoralHover       = RGB(217, 45, 32);   // #D92D20
    constexpr COLORREF kCoralLightBg     = RGB(254, 243, 242); // #FEF3F2
    constexpr COLORREF kCoralLightBorder = RGB(254, 205, 202); // #FECDCA

    constexpr COLORREF kEmerald          = RGB(18, 165, 108);  // #12A56C
    constexpr COLORREF kEmeraldBg        = RGB(236, 253, 245); // #ECFDF5
    constexpr COLORREF kEmeraldBorder    = RGB(167, 243, 208); // #A7F3D0
}

struct GuiFonts {
    HFONT hero_title{nullptr};   // 28px Bold ("Goals")
    HFONT card_title{nullptr};   // 18px Bold ("Four steps to your first debrief")
    HFONT section{nullptr};      // 11px Uppercase Eyebrow ("INTERVIEW HORIZON")
    HFONT label{nullptr};        // 13px Semibold
    HFONT body{nullptr};         // 13px Regular
    HFONT bold{nullptr};         // 13px Semibold
    HFONT small_font{nullptr};   // 12px Regular
    HFONT badge{nullptr};        // 11px Bold
    HBRUSH canvas_brush{nullptr};
    HBRUSH input_brush{nullptr};
    HBRUSH sidebar_brush{nullptr};

    void init() {
        hero_title = CreateFontW(-28, 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                                 OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                 DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI");
        card_title = CreateFontW(-18, 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                                 OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                 DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI");
        section = CreateFontW(-11, 0, 0, 0, FW_semibold, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                              OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                              DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI");
        label = CreateFontW(-13, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                            OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                            DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI");
        body = CreateFontW(-13, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                           OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                           DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI");
        bold = CreateFontW(-13, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                           OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                           DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI");
        small_font = CreateFontW(-12, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                                 OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                                 DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI");
        badge = CreateFontW(-11, 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                            OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                            DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI");
        canvas_brush = CreateSolidBrush(palette::kCanvasBg);
        input_brush = CreateSolidBrush(palette::kInputBg);
        sidebar_brush = CreateSolidBrush(palette::kSidebarBg);
    }

    void cleanup() {
        for (HFONT* f : {&hero_title, &card_title, &section, &label, &body, &bold, &small_font, &badge}) {
            if (*f) { DeleteObject(*f); *f = nullptr; }
        }
        if (canvas_brush) { DeleteObject(canvas_brush); canvas_brush = nullptr; }
        if (input_brush) { DeleteObject(input_brush); input_brush = nullptr; }
        if (sidebar_brush) { DeleteObject(sidebar_brush); sidebar_brush = nullptr; }
    }

private:
    static constexpr int FW_semibold = 600;
};

inline void fill_round_rect(HDC hdc, RECT rc, int radius, COLORREF fill, COLORREF border, int border_w = 1) {
    HBRUSH br = CreateSolidBrush(fill);
    HPEN pen = CreatePen(PS_SOLID, border_w, border);
    HGDIOBJ old_br = SelectObject(hdc, br);
    HGDIOBJ old_pen = SelectObject(hdc, pen);
    RoundRect(hdc, rc.left, rc.top, rc.right, rc.bottom, radius, radius);
    SelectObject(hdc, old_br);
    SelectObject(hdc, old_pen);
    DeleteObject(br);
    DeleteObject(pen);
}

inline void fill_solid_rect(HDC hdc, RECT rc, COLORREF fill) {
    HBRUSH br = CreateSolidBrush(fill);
    FillRect(hdc, &rc, br);
    DeleteObject(br);
}

inline void draw_line(HDC hdc, int x1, int y1, int x2, int y2, COLORREF col) {
    HPEN pen = CreatePen(PS_SOLID, 1, col);
    HGDIOBJ old = SelectObject(hdc, pen);
    MoveToEx(hdc, x1, y1, nullptr);
    LineTo(hdc, x2, y2);
    SelectObject(hdc, old);
    DeleteObject(pen);
}

inline void draw_text_clean(HDC hdc, const std::wstring& txt, RECT rc, HFONT font, COLORREF color,
                            UINT flags = DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS) {
    HGDIOBJ old_f = SelectObject(hdc, font);
    SetBkMode(hdc, TRANSPARENT);
    SetTextColor(hdc, color);
    DrawTextW(hdc, txt.c_str(), static_cast<int>(txt.size()), &rc, flags);
    SelectObject(hdc, old_f);
}

struct InputFrame {
    HWND ctrl{nullptr};
    RECT box{};
    int tab_mask{-1}; // -1 = always visible, or bitmask of tabs (1 << tab)
};

inline void draw_input_frames(HDC hdc, const std::vector<InputFrame>& frames, int active_tab) {
    HWND focused = GetFocus();
    for (const auto& f : frames) {
        if (f.tab_mask != -1 && (f.tab_mask & (1 << active_tab)) == 0) continue;
        if (f.ctrl && !IsWindowVisible(f.ctrl)) continue;
        const bool is_focus = (f.ctrl && f.ctrl == focused);
        fill_round_rect(hdc, f.box, 8, palette::kInputBg,
                        is_focus ? palette::kInputFocus : palette::kInputBorder, 1);
    }
}

// ===========================================================================
// OWNER-DRAWN MODERN BUTTONS, SIDEBAR ITEMS, DROPDOWNS & TOGGLE SWITCHES
// ===========================================================================

enum class BtnKind {
    PrimaryCoral, // Final Round AI Coral CTA (#F04438)
    AccentSoft,   // Soft Coral/Warm button (#FEF3F2 + #F04438 text)
    Secondary,    // Clean white/outlined button (#FFFFFF + #DAD9D4 border)
    GhostLink,    // Minimal text/link button ("New goal ->", "Ver Mini-Compact ->")
    SidebarNav,   // Left sidebar navigation tab item
    SidebarNew,   // "+ New goal" button in sidebar
    Danger,       // Subtle red outline button
    Dropdown,     // Clean selector box with right chevron ▾
    Toggle        // Modern pill switch + label
};

struct CustomBtnMeta {
    BtnKind kind{BtnKind::Secondary};
    bool hovered{false};
    bool checked{false};
    bool on_sidebar{false};
    bool on_hero{false};
    WNDPROC orig_proc{nullptr};
};

inline std::unordered_map<HWND, CustomBtnMeta>& btn_registry() {
    static std::unordered_map<HWND, CustomBtnMeta> reg;
    return reg;
}

inline LRESULT CALLBACK modern_btn_subclass_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    auto& reg = btn_registry();
    auto it = reg.find(hwnd);
    WNDPROC orig = (it != reg.end()) ? it->second.orig_proc : DefWindowProcW;

    switch (msg) {
        case WM_SETCURSOR:
            SetCursor(LoadCursorW(nullptr, reinterpret_cast<LPCWSTR>(IDC_HAND)));
            return TRUE;
        case WM_MOUSEMOVE:
            if (it != reg.end() && !it->second.hovered) {
                it->second.hovered = true;
                TRACKMOUSEEVENT tme{sizeof(tme), TME_LEAVE, hwnd, 0};
                TrackMouseEvent(&tme);
                InvalidateRect(hwnd, nullptr, FALSE);
            }
            break;
        case WM_MOUSELEAVE:
            if (it != reg.end() && it->second.hovered) {
                it->second.hovered = false;
                InvalidateRect(hwnd, nullptr, FALSE);
            }
            break;
        case WM_NCDESTROY:
            reg.erase(hwnd);
            break;
    }
    return CallWindowProcW(orig, hwnd, msg, wp, lp);
}

inline HWND make_modern_btn(HWND parent, int id, const wchar_t* text, int x, int y, int w, int h,
                            HFONT font, BtnKind kind = BtnKind::Secondary, bool checked = false,
                            bool on_sidebar = false, bool on_hero = false) {
    HWND ctrl = CreateWindowExW(0, L"BUTTON", text,
                                WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW,
                                x, y, w, h, parent,
                                reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)),
                                GetModuleHandleW(nullptr), nullptr);
    if (ctrl) {
        if (font) SendMessageW(ctrl, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
        CustomBtnMeta meta;
        meta.kind = kind;
        meta.checked = checked;
        meta.on_sidebar = on_sidebar || (kind == BtnKind::SidebarNav || kind == BtnKind::SidebarNew);
        meta.on_hero = on_hero;
        meta.orig_proc = reinterpret_cast<WNDPROC>(
            SetWindowLongPtrW(ctrl, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(modern_btn_subclass_proc)));
        btn_registry()[ctrl] = meta;
    }
    return ctrl;
}

inline bool get_toggle_checked(HWND ctrl) {
    auto& reg = btn_registry();
    auto it = reg.find(ctrl);
    return it != reg.end() ? it->second.checked : false;
}

inline void set_toggle_checked(HWND ctrl, bool val) {
    auto& reg = btn_registry();
    auto it = reg.find(ctrl);
    if (it != reg.end()) {
        it->second.checked = val;
        InvalidateRect(ctrl, nullptr, FALSE);
    }
}

inline void flip_toggle_checked(HWND ctrl) {
    set_toggle_checked(ctrl, !get_toggle_checked(ctrl));
}

inline void draw_modern_button(const DRAWITEMSTRUCT* dis, const GuiFonts& fonts) {
    if (!dis) return;
    HDC hdc = dis->hDC;
    RECT rc = dis->rcItem;
    const int w = rc.right - rc.left;
    const int h = rc.bottom - rc.top;
    if (w <= 0 || h <= 0) return;

    HDC mem_dc = CreateCompatibleDC(hdc);
    HBITMAP mem_bmp = CreateCompatibleBitmap(hdc, w, h);
    HGDIOBJ old_bmp = SelectObject(mem_dc, mem_bmp);

    auto& reg = btn_registry();
    auto it = reg.find(dis->hwndItem);
    const BtnKind kind = (it != reg.end()) ? it->second.kind : BtnKind::Secondary;
    const bool hovered = (it != reg.end() && it->second.hovered);
    const bool pressed = (dis->itemState & ODS_SELECTED) != 0;
    const bool checked = (it != reg.end() && it->second.checked);
    const bool on_sidebar = (it != reg.end() && it->second.on_sidebar);
    const bool on_hero = (it != reg.end() && it->second.on_hero);

    RECT local{0, 0, w, h};
    const COLORREF parent_bg = on_sidebar ? palette::kSidebarBg
                             : (on_hero ? palette::kHeroCardBg : palette::kCanvasBg);
    fill_solid_rect(mem_dc, local, parent_bg);

    wchar_t wbuf[512]{};
    GetWindowTextW(dis->hwndItem, wbuf, 511);
    std::wstring text(wbuf);

    if (kind == BtnKind::Toggle) {
        const int sw_w = 36;
        const int sw_h = 20;
        const int sw_y = (h - sw_h) / 2;
        RECT sw_rc{2, sw_y, 2 + sw_w, sw_y + sw_h};
        const COLORREF track_fill = checked
            ? (hovered ? palette::kCoralHover : palette::kCoralPrimary)
            : (hovered ? RGB(195, 194, 189) : RGB(212, 211, 206));
        fill_round_rect(mem_dc, sw_rc, sw_h, track_fill, track_fill, 1);

        const int knob_d = 14;
        const int knob_x = checked ? (2 + sw_w - knob_d - 3) : (2 + 3);
        const int knob_y = sw_y + (sw_h - knob_d) / 2;
        HBRUSH k_br = CreateSolidBrush(RGB(255, 255, 255));
        HPEN k_pen = CreatePen(PS_SOLID, 1, RGB(255, 255, 255));
        HGDIOBJ ob = SelectObject(mem_dc, k_br);
        HGDIOBJ op = SelectObject(mem_dc, k_pen);
        Ellipse(mem_dc, knob_x, knob_y, knob_x + knob_d, knob_y + knob_d);
        SelectObject(mem_dc, ob);
        SelectObject(mem_dc, op);
        DeleteObject(k_br);
        DeleteObject(k_pen);

        RECT txt_rc{sw_w + 10, 0, w, h};
        draw_text_clean(mem_dc, text, txt_rc, fonts.body, palette::kTextInk);
    } else if (kind == BtnKind::SidebarNav) {
        if (checked || hovered) {
            const COLORREF fill = checked ? palette::kSidebarActive : palette::kSidebarHover;
            fill_round_rect(mem_dc, local, 6, fill, fill, 1);
        }
        if (checked) {
            RECT bar{2, 6, 5, h - 6};
            fill_solid_rect(mem_dc, bar, palette::kCoralPrimary);
        }
        RECT txt_rc{12, 0, w - 8, h};
        draw_text_clean(mem_dc, text, txt_rc, checked ? fonts.bold : fonts.body,
                        checked ? palette::kTextInk : palette::kTextBody);
    } else if (kind == BtnKind::SidebarNew) {
        const COLORREF fill = hovered ? RGB(255, 255, 255) : RGB(252, 252, 250);
        const COLORREF border = hovered ? RGB(195, 194, 188) : palette::kSidebarBorder;
        fill_round_rect(mem_dc, local, 8, fill, border, 1);
        RECT txt_rc{12, 0, w - 8, h};
        draw_text_clean(mem_dc, text, txt_rc, fonts.bold, palette::kTextInk);
    } else if (kind == BtnKind::GhostLink) {
        if (hovered) {
            fill_round_rect(mem_dc, local, 6, RGB(242, 238, 230), RGB(230, 224, 212), 1);
        }
        draw_text_clean(mem_dc, text, local, fonts.bold,
                        hovered ? palette::kCoralPrimary : palette::kTextBody,
                        DT_RIGHT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    } else if (kind == BtnKind::Dropdown) {
        const COLORREF fill = palette::kInputBg;
        const COLORREF border = hovered ? palette::kTextMuted : palette::kInputBorder;
        fill_round_rect(mem_dc, local, 8, fill, border, 1);

        RECT txt_rc{12, 0, w - 30, h};
        draw_text_clean(mem_dc, text, txt_rc, fonts.body, palette::kTextInk);

        RECT chev_rc{w - 26, 0, w - 8, h};
        draw_text_clean(mem_dc, L"▾", chev_rc, fonts.bold, palette::kTextMuted,
                        DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    } else {
        COLORREF fill = RGB(255, 255, 255);
        COLORREF border = palette::kInputBorder;
        COLORREF txt_col = palette::kTextInk;
        HFONT use_font = fonts.bold;

        switch (kind) {
            case BtnKind::PrimaryCoral:
                fill = pressed ? RGB(196, 38, 26) : (hovered ? palette::kCoralHover : palette::kCoralPrimary);
                border = fill;
                txt_col = RGB(255, 255, 255);
                break;
            case BtnKind::AccentSoft:
                fill = hovered ? RGB(254, 228, 226) : palette::kCoralLightBg;
                border = palette::kCoralLightBorder;
                txt_col = palette::kCoralHover;
                break;
            case BtnKind::Secondary:
                fill = pressed ? RGB(242, 241, 238) : (hovered ? RGB(248, 248, 246) : RGB(255, 255, 255));
                border = hovered ? RGB(190, 189, 184) : palette::kInputBorder;
                txt_col = palette::kTextInk;
                use_font = fonts.body;
                break;
            case BtnKind::Danger:
                fill = hovered ? RGB(254, 242, 242) : RGB(255, 255, 255);
                border = hovered ? RGB(248, 113, 113) : palette::kInputBorder;
                txt_col = RGB(220, 38, 38);
                use_font = fonts.body;
                break;
            default:
                break;
        }
        fill_round_rect(mem_dc, local, 8, fill, border, 1);
        draw_text_clean(mem_dc, text, local, use_font, txt_col,
                        DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    }

    BitBlt(hdc, rc.left, rc.top, w, h, mem_dc, 0, 0, SRCCOPY);
    SelectObject(mem_dc, old_bmp);
    DeleteObject(mem_bmp);
    DeleteDC(mem_dc);
}

inline void draw_modern_listbox_item(const DRAWITEMSTRUCT* dis, const GuiFonts& fonts) {
    if (!dis || dis->itemID == static_cast<UINT>(-1)) return;
    HDC hdc = dis->hDC;
    RECT rc = dis->rcItem;
    const bool selected = (dis->itemState & ODS_SELECTED) != 0;

    fill_solid_rect(hdc, rc, selected ? palette::kCoralLightBg : palette::kInputBg);
    if (selected) {
        RECT bar{rc.left, rc.top + 2, rc.left + 3, rc.bottom - 2};
        fill_solid_rect(hdc, bar, palette::kCoralPrimary);
    }

    const int len = static_cast<int>(SendMessageW(dis->hwndItem, LB_GETTEXTLEN, dis->itemID, 0));
    if (len > 0) {
        std::wstring text(static_cast<std::size_t>(len + 1), L'\0');
        SendMessageW(dis->hwndItem, LB_GETTEXT, dis->itemID, reinterpret_cast<LPARAM>(text.data()));
        text.resize(static_cast<std::size_t>(len));

        RECT txt_rc{rc.left + 10, rc.top, rc.right - 8, rc.bottom};
        draw_text_clean(hdc, text, txt_rc, selected ? fonts.bold : fonts.body,
                        selected ? palette::kTextInk : palette::kTextBody);
    }
}

inline HWND make_framed_edit(HWND parent, int id, int x, int y, int w, int h, HFONT font,
                             std::vector<InputFrame>& frames, int tab_mask = -1,
                             bool secret = false, bool multiline = false) {
    InputFrame frame;
    frame.box = RECT{x, y, x + w, y + h};
    frame.tab_mask = tab_mask;
    DWORD style = WS_CHILD | WS_VISIBLE | WS_TABSTOP;
    if (secret) style |= ES_PASSWORD | ES_AUTOHSCROLL;
    else if (multiline) style |= ES_MULTILINE | ES_AUTOVSCROLL | ES_WANTRETURN | WS_VSCROLL;
    else style |= ES_AUTOHSCROLL;

    const int pad_x = 10;
    const int pad_y = multiline ? 8 : std::max(5, (h - 19) / 2);
    HWND ctrl = CreateWindowExW(0, L"EDIT", L"", style,
                                x + pad_x, y + pad_y, w - pad_x * 2, h - pad_y * 2,
                                parent, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)),
                                GetModuleHandleW(nullptr), nullptr);
    if (ctrl) {
        if (font) SendMessageW(ctrl, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
        frame.ctrl = ctrl;
    }
    frames.push_back(frame);
    return ctrl;
}

inline HWND make_framed_listbox(HWND parent, int id, int x, int y, int w, int h, HFONT font,
                                std::vector<InputFrame>& frames, int tab_mask = -1) {
    InputFrame frame;
    frame.box = RECT{x, y, x + w, y + h};
    frame.tab_mask = tab_mask;
    DWORD style = WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_VSCROLL | LBS_NOTIFY |
                  LBS_OWNERDRAWFIXED | LBS_HASSTRINGS | LBS_NOINTEGRALHEIGHT;
    HWND ctrl = CreateWindowExW(0, L"LISTBOX", L"", style,
                                x + 3, y + 3, w - 6, h - 6,
                                parent, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)),
                                GetModuleHandleW(nullptr), nullptr);
    if (ctrl) {
        if (font) SendMessageW(ctrl, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
        SendMessageW(ctrl, LB_SETITEMHEIGHT, 0, 24);
        frame.ctrl = ctrl;
    }
    frames.push_back(frame);
    return ctrl;
}

inline void move_framed_control(std::vector<InputFrame>& frames, HWND ctrl, int x, int y, int w, int h, bool multiline = false, bool is_listbox = false) {
    if (!ctrl) return;
    for (auto& f : frames) {
        if (f.ctrl == ctrl) {
            f.box = RECT{x, y, x + w, y + h};
            break;
        }
    }
    if (is_listbox) {
        MoveWindow(ctrl, x + 3, y + 3, std::max(10, w - 6), std::max(10, h - 6), FALSE);
    } else {
        const int pad_x = 10;
        const int pad_y = multiline ? 8 : std::max(5, (h - 19) / 2);
        MoveWindow(ctrl, x + pad_x, y + pad_y, std::max(10, w - pad_x * 2), std::max(10, h - pad_y * 2), FALSE);
    }
}

inline int show_dropdown_menu(HWND parent, HWND btn, const std::vector<std::wstring>& options) {
    if (options.empty()) return -1;
    HMENU menu = CreatePopupMenu();
    for (std::size_t i = 0; i < options.size(); ++i) {
        AppendMenuW(menu, MF_STRING, i + 1, options[i].c_str());
    }
    RECT rc{};
    GetWindowRect(btn, &rc);
    const int cmd = TrackPopupMenu(menu, TPM_LEFTALIGN | TPM_TOPALIGN | TPM_RETURNCMD | TPM_NONOTIFY,
                                   rc.left, rc.bottom + 2, 0, parent, nullptr);
    DestroyMenu(menu);
    return (cmd > 0) ? (cmd - 1) : -1;
}

inline std::string join_comma(const std::vector<std::string>& items) {
    std::string out;
    for (std::size_t i = 0; i < items.size(); ++i) {
        if (i > 0) out += ", ";
        out += items[i];
    }
    return out;
}

// ===========================================================================
// 1. DOCUMENT EXTRACTION FOR RAG (.txt, .md, .json, .csv, code, .pdf, .docx)
// ===========================================================================

inline std::string strip_xml_tags(std::string_view xml) {
    std::string out;
    out.reserve(xml.size() / 2);
    bool in_tag = false;
    for (std::size_t i = 0; i < xml.size(); ++i) {
        const char c = xml[i];
        if (c == '<') {
            if (i + 4 < xml.size() && (xml.substr(i, 4) == "</w:" || xml.substr(i, 3) == "</p")) {
                if (!out.empty() && out.back() != '\n') out.push_back('\n');
            }
            in_tag = true;
        } else if (c == '>') {
            in_tag = false;
        } else if (!in_tag) {
            out.push_back(c);
        }
    }
    return text::trim(out);
}

inline std::string extract_pdf_readable_text(const std::string& raw_bytes) {
    std::string out;
    out.reserve(4096);
    bool in_paren = false;
    bool escaped = false;
    for (std::size_t i = 0; i < raw_bytes.size(); ++i) {
        const unsigned char c = static_cast<unsigned char>(raw_bytes[i]);
        if (escaped) {
            if (c == 'n') out.push_back('\n');
            else if (c == 'r' || c == 't') out.push_back(' ');
            else if (c >= 32 && c < 127) out.push_back(static_cast<char>(c));
            escaped = false;
            continue;
        }
        if (c == '\\') { escaped = true; continue; }
        if (c == '(') { in_paren = true; continue; }
        if (c == ')') {
            if (in_paren) { out.push_back(' '); in_paren = false; }
            continue;
        }
        if (in_paren && ((c >= 32 && c < 127) || c >= 0x80)) {
            out.push_back(static_cast<char>(c));
        }
    }
    return text::trim(out);
}

inline std::string load_document_text_for_rag(const fs::path& file_path) {
    std::ifstream f(file_path, std::ios::binary);
    if (!f) return {};
    std::string raw((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    if (raw.empty()) return {};

    if (raw.size() >= 3 &&
        static_cast<unsigned char>(raw[0]) == 0xEF &&
        static_cast<unsigned char>(raw[1]) == 0xBB &&
        static_cast<unsigned char>(raw[2]) == 0xBF) {
        raw.erase(0, 3);
    }

    std::string ext = text::fold(narrow_utf8(file_path.extension().wstring()));
    if (ext == ".pdf") {
        std::string extracted = extract_pdf_readable_text(raw);
        if (extracted.size() >= 40) return text::truncate_utf8(extracted, 24000);
    }
    if (ext == ".xml" || ext == ".html" || ext == ".htm") {
        return text::truncate_utf8(strip_xml_tags(raw), 24000);
    }

    std::string cleaned;
    cleaned.reserve(std::min<std::size_t>(raw.size(), 28000));
    for (unsigned char c : raw) {
        if (c == '\0' || c == '\r') continue;
        if (c == '\n' || c == '\t' || c >= 32) {
            cleaned.push_back(static_cast<char>(c));
        }
        if (cleaned.size() >= 26000) break;
    }
    return text::trim(cleaned);
}

// ===========================================================================
// 2. UNIFIED DESKTOP WORKSPACE APP (Final Round AI Style — Image 2)
// ===========================================================================

struct SessionLaunchResult {
    bool proceed{false};
    bool run_demo{false};
    MiniAgentProfile agent;
};

enum StudioTab : int {
    kTabGoals = 0,     // Main "Goals" view (Hero onboarding card + Goal/Company setup)
    kTabLibrary = 1,   // "Library" view (RAG Documents, Deep-Reading Mini-Compact & Persona)
    kTabCalendar = 2,  // "Calendar" view (Google Calendar sync & upcoming interviews)
    kTabSettings = 3   // "Settings" view (API Keys, Models, Audio/VAD & HUD Overlay)
};

enum StudioId : int {
    // Sidebar controls
    kStNewGoalSidebar = 6101,
    kStAgentSelector,
    kStNavGoals,
    kStNavLibrary,
    kStNavCalendar,
    kStNavSettings,

    // Top bar controls
    kStFullscreenBtn,
    kStStartDemoBtn,
    kStStartLiveBtn,

    // Hero card quick-action links (Tab 0)
    kStStep1Link,
    kStStep2Link,
    kStStep3Link,
    kStStep4Link,
    kStSaveAgentBtn,
    kStDeleteAgentBtn,

    // Goal & Company controls (Tab 0)
    kStSessionName,
    kStCompany,
    kStRole,
    kStCompanySearch,
    kStCompanyDossier,

    // Library RAG & Mini-Compact controls (Tab 1)
    kStDocList,
    kStAddFiles,
    kStPasteClipboard,
    kStPreviewCompact,
    kStRemoveDoc,
    kStInstructions,

    // Google Calendar controls (Tab 2)
    kStCalInput,
    kStCalSync,
    kStCalBrowser,
    kStCalList,

    // Settings controls (Tab 3)
    kCfgDeepgramKey = 6201,
    kCfgCerebrasKey,
    kCfgGroqKey,
    kCfgOpenRouterKey,
    kCfgLlmUrl,
    kCfgModel,
    kCfgModelPresetBtn,
    kCfgReasoningBtn,
    kCfgTemperature,
    kCfgMaxTokens,
    kCfgCooldown,
    kCfgLanguage,
    kCfgEndpointing,
    kCfgKeyterms,
    kCfgKeywords,
    kCfgAutoSuggest,
    kCfgMicEnabled,
    kCfgLoopbackEnabled,
    kCfgVadModeBtn,
    kCfgOverlayWidth,
    kCfgOverlayHeightPct,
    kCfgSaveSessions,
    kCfgOpenNotepad,
    kCfgSaveBtn
};

struct StudioState {
    fs::path app_dir;
    fs::path agents_dir;
    fs::path config_path;
    EnvLookup env_fn;
    Settings* st{nullptr};
    Settings owned_st;
    bool settings_only_mode{false};
    bool initial_demo{false};
    bool settings_saved{false};

    GuiFonts fonts;
    HWND hwnd{nullptr};
    int active_tab{kTabGoals};
    bool is_fullscreen{false};
    WINDOWPLACEMENT wp_prev{sizeof(WINDOWPLACEMENT)};

    std::vector<InputFrame> frames;
    std::vector<MiniAgentProfile> saved_agents;
    std::vector<web::CalendarEvent> calendar_events;
    MiniAgentProfile current_agent;
    int selected_agent_idx{0};
    std::string status_text;

    // Sidebar HWNDs
    HWND btn_new_goal_sb{nullptr};
    HWND btn_agent_sel{nullptr};
    HWND btn_nav_goals{nullptr};
    HWND btn_nav_library{nullptr};
    HWND btn_nav_calendar{nullptr};
    HWND btn_nav_settings{nullptr};

    // Top bar HWNDs
    HWND btn_fullscreen{nullptr};
    HWND btn_demo{nullptr};
    HWND btn_launch{nullptr};

    // Tab 0 (Goals) HWNDs
    HWND btn_save_agent{nullptr};
    HWND btn_delete_agent{nullptr};
    HWND btn_step1{nullptr};
    HWND btn_step2{nullptr};
    HWND btn_step3{nullptr};
    HWND btn_step4{nullptr};
    HWND session_name{nullptr};
    HWND company{nullptr};
    HWND role{nullptr};
    HWND btn_company_search{nullptr};
    HWND company_dossier{nullptr};

    // Tab 1 (Library RAG & Mini-Compact) HWNDs
    HWND doc_list{nullptr};
    HWND btn_add_files{nullptr};
    HWND btn_paste_clip{nullptr};
    HWND btn_preview_compact{nullptr};
    HWND btn_remove_doc{nullptr};
    HWND instructions{nullptr};

    // Tab 2 (Google Calendar) HWNDs
    HWND cal_input{nullptr};
    HWND btn_cal_sync{nullptr};
    HWND btn_cal_browser{nullptr};
    HWND cal_list{nullptr};

    // Tab 3 (Settings) HWNDs
    HWND deepgram_key{nullptr};
    HWND cerebras_key{nullptr};
    HWND groq_key{nullptr};
    HWND openrouter_key{nullptr};
    HWND llm_url{nullptr};
    HWND model{nullptr};
    HWND model_preset_btn{nullptr};
    HWND reasoning_btn{nullptr};
    HWND temperature{nullptr};
    HWND max_tokens{nullptr};
    HWND cooldown{nullptr};
    HWND language{nullptr};
    HWND endpointing{nullptr};
    HWND keyterms{nullptr};
    HWND keywords{nullptr};
    HWND auto_suggest{nullptr};
    HWND mic_enabled{nullptr};
    HWND loopback_enabled{nullptr};
    HWND vad_mode_btn{nullptr};
    HWND overlay_width{nullptr};
    HWND overlay_height_pct{nullptr};
    HWND save_sessions{nullptr};
    HWND btn_open_notepad{nullptr};
    HWND btn_save_settings{nullptr};

    std::string selected_reasoning;
    std::string selected_vad;

    SessionLaunchResult result;
};

inline void ensure_default_agent_templates(const fs::path& agents_dir) {
    std::error_code ec;
    fs::create_directories(agents_dir, ec);
    bool any = false;
    for (const auto& entry : fs::directory_iterator(agents_dir, ec)) {
        if (entry.path().extension() == L".json") {
            any = true;
            break;
        }
    }
    if (any) return;

    MiniAgentProfile swe;
    swe.id = "swe-senior-fintech";
    swe.name = "Senior SWE / Tech Lead (high scale & culture fit)";
    swe.company = "Fintech / Big Tech";
    swe.role = "Senior Software Engineer";
    swe.company_dossier =
        "• End-to-end ownership culture, obsessive customer focus and data-driven decisions.\n"
        "• Distributed microservices, low latency, high availability, observability and resilience.\n"
        "• Values clear communication, cross-functional collaboration and incremental delivery with clear metrics.";
    swe.custom_instructions =
        "- Use STAR for behavioral questions.\n"
        "- Highlight experience with critical low-latency systems, concurrency, caching, messaging and scalability.\n"
        "- Show strong culture fit: ownership, empathy for the end user, technical pragmatism and mentoring.";
    MiniAgentRag rag(swe);
    swe.mini_compact = rag.synthesize_deep_mini_compact();
    wincfg::write_file_atomic(agents_dir / L"swe-senior-fintech.json", swe.to_json());
}

inline std::vector<MiniAgentProfile> load_all_saved_agents(const fs::path& agents_dir) {
    ensure_default_agent_templates(agents_dir);
    std::vector<MiniAgentProfile> out;
    std::error_code ec;
    for (const auto& entry : fs::directory_iterator(agents_dir, ec)) {
        if (entry.path().extension() != L".json") continue;
        const std::string raw = wincfg::read_file(entry.path());
        if (auto p = MiniAgentProfile::from_json(raw)) {
            out.push_back(std::move(*p));
        }
    }
    std::sort(out.begin(), out.end(), [](const MiniAgentProfile& a, const MiniAgentProfile& b) {
        return a.name < b.name;
    });
    return out;
}

inline void refresh_saved_agents(StudioState* s, const std::string& select_id = {}) {
    s->saved_agents = load_all_saved_agents(s->agents_dir);
    s->selected_agent_idx = 0;
    for (std::size_t i = 0; i < s->saved_agents.size(); ++i) {
        if (!select_id.empty() && s->saved_agents[i].id == select_id) {
            s->selected_agent_idx = static_cast<int>(i);
            break;
        }
    }
}

inline void toggle_fullscreen(HWND hwnd, StudioState* s) {
    const DWORD style = static_cast<DWORD>(GetWindowLongPtrW(hwnd, GWL_STYLE));
    if (!s->is_fullscreen) {
        MONITORINFO mi{sizeof(mi)};
        if (GetWindowPlacement(hwnd, &s->wp_prev) &&
            GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY), &mi)) {
            SetWindowLongPtrW(hwnd, GWL_STYLE, style & ~WS_OVERLAPPEDWINDOW);
            SetWindowPos(hwnd, HWND_TOP,
                         mi.rcMonitor.left, mi.rcMonitor.top,
                         mi.rcMonitor.right - mi.rcMonitor.left,
                         mi.rcMonitor.bottom - mi.rcMonitor.top,
                         SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
            s->is_fullscreen = true;
            if (s->btn_fullscreen) SetWindowTextW(s->btn_fullscreen, L"🗗 Exit full screen (F11)");
        }
    } else {
        SetWindowLongPtrW(hwnd, GWL_STYLE, style | WS_OVERLAPPEDWINDOW);
        SetWindowPlacement(hwnd, &s->wp_prev);
        SetWindowPos(hwnd, nullptr, 0, 0, 0, 0,
                     SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
        s->is_fullscreen = false;
        if (s->btn_fullscreen) SetWindowTextW(s->btn_fullscreen, L"⛶ Full screen (F11)");
    }
}

// Dynamically positions all controls based on current window width/height and active tab
inline void relayout_studio(StudioState* s, int W, int H) {
    if (!s || !s->hwnd || W <= 0 || H <= 0) return;

    constexpr int kSidebarW = 248;
    constexpr int kTopBarH = 52;

    // 1. Sidebar controls
    if (s->btn_new_goal_sb) MoveWindow(s->btn_new_goal_sb, 16, kTopBarH + 46, kSidebarW - 32, 34, FALSE);
    if (s->btn_agent_sel)   MoveWindow(s->btn_agent_sel,   16, kTopBarH + 118, kSidebarW - 32, 34, FALSE);

    const int nav_base_y = std::max(kTopBarH + 260, H - 208);
    if (s->btn_nav_goals)    MoveWindow(s->btn_nav_goals,    12, nav_base_y,       kSidebarW - 24, 32, FALSE);
    if (s->btn_nav_library)  MoveWindow(s->btn_nav_library,  12, nav_base_y + 36,  kSidebarW - 24, 32, FALSE);
    if (s->btn_nav_calendar) MoveWindow(s->btn_nav_calendar, 12, nav_base_y + 72,  kSidebarW - 24, 32, FALSE);
    if (s->btn_nav_settings) MoveWindow(s->btn_nav_settings, 12, nav_base_y + 108, kSidebarW - 24, 32, FALSE);

    // 2. Top bar right buttons
    int right_x = W - 24;
    if (s->btn_launch) {
        MoveWindow(s->btn_launch, right_x - 178, 9, 178, 34, FALSE);
        right_x -= 188;
    }
    if (s->btn_demo) {
        MoveWindow(s->btn_demo, right_x - 146, 9, 146, 34, FALSE);
        right_x -= 156;
    }
    if (s->btn_fullscreen) {
        MoveWindow(s->btn_fullscreen, right_x - 148, 9, 148, 34, FALSE);
    }

    // 3. Centered Workspace Geometry (like Final Round AI Image 2)
    const int avail_w = std::max(640, W - kSidebarW);
    const int content_w = std::min(920, avail_w - 80);
    const int cx = kSidebarW + (avail_w - content_w) / 2;
    const int top_y = kTopBarH + 28;

    // Show/hide controls by active tab
    auto show_for = [&](HWND ctrl, int tab) {
        if (ctrl) ShowWindow(ctrl, (s->active_tab == tab) ? SW_SHOW : SW_HIDE);
    };

    // ---- TAB 0: GOALS & ENTREVISTA (Hero Card + Goal Setup) ----
    const int hero_y = top_y + 72;
    if (s->btn_save_agent)   MoveWindow(s->btn_save_agent,   cx + content_w - 220, top_y + 18, 126, 32, FALSE);
    if (s->btn_delete_agent) MoveWindow(s->btn_delete_agent, cx + content_w - 86,  top_y + 18, 86,  32, FALSE);

    if (s->btn_step1) MoveWindow(s->btn_step1, cx + content_w - 175, hero_y + 52,  150, 26, FALSE);
    if (s->btn_step2) MoveWindow(s->btn_step2, cx + content_w - 175, hero_y + 84,  150, 26, FALSE);
    if (s->btn_step3) MoveWindow(s->btn_step3, cx + content_w - 175, hero_y + 116, 150, 26, FALSE);
    if (s->btn_step4) MoveWindow(s->btn_step4, cx + content_w - 175, hero_y + 148, 150, 26, FALSE);

    const int form_y = hero_y + 212;
    const int col_gap = 20;
    const int col3_w = (content_w - col_gap * 2) / 3;
    move_framed_control(s->frames, s->session_name, cx, form_y + 22, col3_w, 34);
    move_framed_control(s->frames, s->company, cx + col3_w + col_gap, form_y + 22, col3_w, 34);
    move_framed_control(s->frames, s->role, cx + (col3_w + col_gap) * 2, form_y + 22, content_w - (col3_w + col_gap) * 2, 34);

    if (s->btn_company_search) {
        MoveWindow(s->btn_company_search, cx, form_y + 68, content_w, 34, FALSE);
    }
    const int dossier_h = std::max(110, H - (form_y + 136) - 28);
    move_framed_control(s->frames, s->company_dossier, cx, form_y + 132, content_w, dossier_h, true);

    for (HWND c : {s->btn_save_agent, s->btn_delete_agent, s->btn_step1, s->btn_step2,
                   s->btn_step3, s->btn_step4, s->session_name, s->company, s->role,
                   s->btn_company_search, s->company_dossier}) {
        show_for(c, kTabGoals);
    }

    // ---- TAB 1: LIBRARY (RAG DOCUMENTS, MINI-COMPACT & PERSONA) ----
    const int lib_y = top_y + 84;
    if (s->btn_add_files)       MoveWindow(s->btn_add_files,       cx,       lib_y, 170, 34, FALSE);
    if (s->btn_paste_clip)      MoveWindow(s->btn_paste_clip,      cx + 180, lib_y, 150, 34, FALSE);
    if (s->btn_preview_compact) MoveWindow(s->btn_preview_compact, cx + 340, lib_y, 210, 34, FALSE);
    if (s->btn_remove_doc)      MoveWindow(s->btn_remove_doc,      cx + content_w - 110, lib_y, 110, 34, FALSE);

    move_framed_control(s->frames, s->doc_list, cx, lib_y + 46, content_w, 130, false, true);
    const int instr_h = std::max(140, H - (lib_y + 216) - 32);
    move_framed_control(s->frames, s->instructions, cx, lib_y + 212, content_w, instr_h, true);

    for (HWND c : {s->doc_list, s->btn_add_files, s->btn_paste_clip,
                   s->btn_preview_compact, s->btn_remove_doc, s->instructions}) {
        show_for(c, kTabLibrary);
    }

    // ---- TAB 2: GOOGLE CALENDAR & AGENDA ----
    const int cal_y = top_y + 84;
    move_framed_control(s->frames, s->cal_input, cx, cal_y + 22, content_w - 360, 34);
    if (s->btn_cal_sync)    MoveWindow(s->btn_cal_sync,    cx + content_w - 348, cal_y + 22, 168, 34, FALSE);
    if (s->btn_cal_browser) MoveWindow(s->btn_cal_browser, cx + content_w - 170, cal_y + 22, 170, 34, FALSE);

    const int cal_list_h = std::max(180, H - (cal_y + 96) - 36);
    move_framed_control(s->frames, s->cal_list, cx, cal_y + 92, content_w, cal_list_h, false, true);

    for (HWND c : {s->cal_input, s->btn_cal_sync, s->btn_cal_browser, s->cal_list}) {
        show_for(c, kTabCalendar);
    }

    // ---- TAB 3: SETTINGS (CONFIGURAÇÕES DO SISTEMA) ----
    const int set_y = top_y + 76;
    const int scol_w = (content_w - 28) / 2;
    const int L1 = cx;
    const int L2 = cx + scol_w + 28;

    move_framed_control(s->frames, s->deepgram_key,   L1, set_y + 20,  scol_w, 32);
    move_framed_control(s->frames, s->cerebras_key,   L1, set_y + 78,  scol_w, 32);
    move_framed_control(s->frames, s->groq_key,       L1, set_y + 136, scol_w, 32);
    move_framed_control(s->frames, s->openrouter_key, L1, set_y + 194, scol_w, 32);
    move_framed_control(s->frames, s->llm_url,        L1, set_y + 252, scol_w, 32);
    move_framed_control(s->frames, s->language,       L1, set_y + 310, (scol_w - 12) / 2, 32);
    move_framed_control(s->frames, s->endpointing,    L1 + (scol_w - 12) / 2 + 12, set_y + 310, scol_w - ((scol_w - 12) / 2 + 12), 32);
    move_framed_control(s->frames, s->keyterms,       L1, set_y + 368, scol_w, 32);

    move_framed_control(s->frames, s->model,          L2, set_y + 20,  scol_w - 114, 32);
    if (s->model_preset_btn) MoveWindow(s->model_preset_btn, L2 + scol_w - 106, set_y + 20, 106, 32, FALSE);

    const int third_w = (scol_w - 20) / 3;
    if (s->reasoning_btn) MoveWindow(s->reasoning_btn, L2, set_y + 78, third_w, 32, FALSE);
    move_framed_control(s->frames, s->temperature,    L2 + third_w + 10, set_y + 78, third_w, 32);
    move_framed_control(s->frames, s->max_tokens,     L2 + (third_w + 10) * 2, set_y + 78, scol_w - (third_w + 10) * 2, 32);

    move_framed_control(s->frames, s->keywords,       L2, set_y + 136, scol_w, 32);
    move_framed_control(s->frames, s->cooldown,       L2, set_y + 194, (scol_w - 12) / 2, 32);
    if (s->vad_mode_btn) MoveWindow(s->vad_mode_btn,  L2 + (scol_w - 12) / 2 + 12, set_y + 194, scol_w - ((scol_w - 12) / 2 + 12), 32, FALSE);

    move_framed_control(s->frames, s->overlay_width,      L2, set_y + 252, (scol_w - 12) / 2, 32);
    move_framed_control(s->frames, s->overlay_height_pct, L2 + (scol_w - 12) / 2 + 12, set_y + 252, scol_w - ((scol_w - 12) / 2 + 12), 32);

    if (s->auto_suggest)     MoveWindow(s->auto_suggest,     L2, set_y + 306, scol_w, 26, FALSE);
    if (s->mic_enabled)      MoveWindow(s->mic_enabled,      L2, set_y + 336, (scol_w - 10) / 2, 26, FALSE);
    if (s->loopback_enabled) MoveWindow(s->loopback_enabled, L2 + (scol_w - 10) / 2 + 10, set_y + 336, scol_w - ((scol_w - 10) / 2 + 10), 26, FALSE);
    if (s->save_sessions)    MoveWindow(s->save_sessions,    L2, set_y + 366, scol_w, 26, FALSE);

    if (s->btn_open_notepad)  MoveWindow(s->btn_open_notepad,  L1, set_y + 422, 230, 36, FALSE);
    if (s->btn_save_settings) MoveWindow(s->btn_save_settings, L2 + scol_w - 220, set_y + 422, 220, 36, FALSE);

    for (HWND c : {s->deepgram_key, s->cerebras_key, s->groq_key, s->openrouter_key,
                   s->llm_url, s->model, s->model_preset_btn, s->reasoning_btn,
                   s->temperature, s->max_tokens, s->cooldown, s->language,
                   s->endpointing, s->keyterms, s->keywords, s->auto_suggest,
                   s->mic_enabled, s->loopback_enabled, s->vad_mode_btn,
                   s->overlay_width, s->overlay_height_pct, s->save_sessions,
                   s->btn_open_notepad, s->btn_save_settings}) {
        show_for(c, kTabSettings);
    }
}

inline void switch_studio_tab(StudioState* s, int new_tab) {
    s->active_tab = new_tab;
    set_toggle_checked(s->btn_nav_goals,    new_tab == kTabGoals);
    set_toggle_checked(s->btn_nav_library,  new_tab == kTabLibrary);
    set_toggle_checked(s->btn_nav_calendar, new_tab == kTabCalendar);
    set_toggle_checked(s->btn_nav_settings, new_tab == kTabSettings);

    RECT rc{};
    GetClientRect(s->hwnd, &rc);
    relayout_studio(s, rc.right - rc.left, rc.bottom - rc.top);
    InvalidateRect(s->hwnd, nullptr, FALSE);
}

inline void sync_ui_from_agent(StudioState* s) {
    const auto& a = s->current_agent;
    set_hwnd_text(s->session_name, a.name);
    set_hwnd_text(s->company, a.company);
    set_hwnd_text(s->role, a.role);
    set_hwnd_text(s->company_dossier, a.company_dossier);
    set_hwnd_text(s->instructions, a.custom_instructions);

    if (s->btn_agent_sel) {
        std::string label = a.name.empty() ? std::string("New goal") : a.name;
        SetWindowTextW(s->btn_agent_sel, widen_utf8(label).c_str());
        InvalidateRect(s->btn_agent_sel, nullptr, FALSE);
    }

    SendMessageW(s->doc_list, LB_RESETCONTENT, 0, 0);
    if (a.documents.empty()) {
        SendMessageW(s->doc_list, LB_ADDSTRING, 0,
                     reinterpret_cast<LPARAM>(L"📎 No files attached: click 'Upload files' or 'Paste text / resume'."));
    } else {
        for (const auto& d : a.documents) {
            std::string item = "📄 " + d.name + "  —  " + std::to_string(d.content.size()) + " characters indexed in the RAG";
            SendMessageW(s->doc_list, LB_ADDSTRING, 0, reinterpret_cast<LPARAM>(widen_utf8(item).c_str()));
        }
    }

    MiniAgentRag rag(a);
    s->current_agent.mini_compact = rag.synthesize_deep_mini_compact();
    s->status_text = std::to_string(s->saved_agents.size()) + " goal(s) salvos  ·  " +
                     std::to_string(a.documents.size()) + " file(s) in the RAG (" +
                     std::to_string(rag.chunk_count()) + " chunks)  ·  Mini-Compact on (" +
                     std::to_string(s->current_agent.mini_compact.size()) + " chars)";
    if (s->hwnd) InvalidateRect(s->hwnd, nullptr, FALSE);
}

inline void sync_agent_from_ui(StudioState* s) {
    s->current_agent.name = text::trim(read_hwnd_text(s->session_name));
    s->current_agent.company = text::trim(read_hwnd_text(s->company));
    s->current_agent.role = text::trim(read_hwnd_text(s->role));
    s->current_agent.company_dossier = text::trim(read_hwnd_text(s->company_dossier));
    s->current_agent.custom_instructions = text::trim(read_hwnd_text(s->instructions));
    if (s->current_agent.name.empty() && !s->current_agent.company.empty()) {
        s->current_agent.name = "Interview - " + s->current_agent.company +
                                (s->current_agent.role.empty() ? "" : " (" + s->current_agent.role + ")");
    }
    s->current_agent.id = MiniAgentProfile::slugify(
        s->current_agent.name.empty() ? s->current_agent.company : s->current_agent.name);
    MiniAgentRag rag(s->current_agent);
    s->current_agent.mini_compact = rag.synthesize_deep_mini_compact();
}

inline void paint_studio_window(HWND hwnd, StudioState* s) {
    PAINTSTRUCT ps{};
    HDC hdc = BeginPaint(hwnd, &ps);
    RECT client{};
    GetClientRect(hwnd, &client);
    const int W = client.right - client.left;
    const int H = client.bottom - client.top;

    HDC mem = CreateCompatibleDC(hdc);
    HBITMAP bmp = CreateCompatibleBitmap(hdc, W, H);
    HGDIOBJ old_bmp = SelectObject(mem, bmp);

    constexpr int kSidebarW = 248;
    constexpr int kTopBarH = 52;

    // 1. Main White Workspace Canvas + Warm Sidebar (exact Image 2 layout)
    fill_solid_rect(mem, RECT{0, 0, W, H}, palette::kCanvasBg);
    fill_solid_rect(mem, RECT{0, 0, kSidebarW, H}, palette::kSidebarBg);
    draw_line(mem, kSidebarW, 0, kSidebarW, H, palette::kSidebarBorder);

    // 2. Top Breadcrumb & Action Bar
    fill_solid_rect(mem, RECT{kSidebarW + 1, 0, W, kTopBarH}, palette::kTopBarBg);
    draw_line(mem, 0, kTopBarH, W, kTopBarH, palette::kSidebarBorder);

    // Brand Coral Icon in Top Bar (like Image 2's red square icon)
    fill_round_rect(mem, RECT{kSidebarW + 20, 15, kSidebarW + 42, 37}, 6,
                    palette::kCoralPrimary, palette::kCoralPrimary, 1);
    draw_text_clean(mem, L"R", RECT{kSidebarW + 20, 15, kSidebarW + 42, 37},
                    s->fonts.bold, RGB(255, 255, 255), DT_CENTER | DT_VCENTER | DT_SINGLELINE);

    const wchar_t* tab_names[] = {L"Goals", L"Library (RAG & Mini-Compact)", L"Google Calendar", L"Settings"};
    std::wstring crumb = std::wstring(tab_names[s->active_tab]) + L"   /   " +
                         widen_utf8(s->current_agent.name.empty() ? "Current session" : s->current_agent.name);
    draw_text_clean(mem, crumb, RECT{kSidebarW + 52, 0, W - 490, kTopBarH},
                    s->fonts.body, palette::kTextMuted);

    // 3. Left Sidebar Content
    draw_text_clean(mem, L"RealTime AI", RECT{18, 0, 160, kTopBarH}, s->fonts.bold, palette::kTextInk);
    fill_round_rect(mem, RECT{172, 16, 232, 36}, 6, palette::kCoralLightBg, palette::kCoralLightBorder, 1);
    draw_text_clean(mem, L"STUDIO", RECT{172, 16, 232, 36}, s->fonts.badge, palette::kCoralPrimary,
                    DT_CENTER | DT_VCENTER | DT_SINGLELINE);

    draw_text_clean(mem, L"Goals", RECT{18, kTopBarH + 14, 150, kTopBarH + 38}, s->fonts.bold, palette::kTextInk);
    draw_text_clean(mem, L"UP NEXT · SAVED PROFILES", RECT{18, kTopBarH + 94, kSidebarW - 16, kTopBarH + 112},
                    s->fonts.section, palette::kTextMuted);

    // Sidebar Summary under the selector
    std::wstring sb_info = s->current_agent.company.empty()
        ? L"No company set yet.\nSet it up on the side to start."
        : (L"🏢 " + widen_utf8(s->current_agent.company) + L"\n🎯 " +
           widen_utf8(s->current_agent.role.empty() ? "Cargo geral" : s->current_agent.role));
    draw_text_clean(mem, sb_info, RECT{18, kTopBarH + 160, kSidebarW - 18, kTopBarH + 204},
                    s->fonts.small_font, palette::kTextMuted, DT_LEFT | DT_WORDBREAK | DT_NOPREFIX);

    // Sidebar Promo / Mini-Compact Status Box (like "FREE PLAN / Unlock Interview Copilot" in Image 2)
    const int nav_base_y = std::max(kTopBarH + 260, H - 208);
    const int promo_y = nav_base_y - 82;
    fill_round_rect(mem, RECT{14, promo_y, kSidebarW - 14, promo_y + 70}, 10,
                    palette::kSidebarCard, palette::kSidebarBorder, 1);
    draw_text_clean(mem, L"MINI-COMPACT + RAG ON",
                    RECT{26, promo_y + 10, kSidebarW - 24, promo_y + 26},
                    s->fonts.section, palette::kCoralPrimary);
    std::wstring compact_stat = L"Ready (" +
                                std::to_wstring(s->current_agent.mini_compact.size()) + L" chars in the prompt)";
    draw_text_clean(mem, compact_stat,
                    RECT{26, promo_y + 28, kSidebarW - 24, promo_y + 46},
                    s->fonts.bold, palette::kTextInk);
    draw_text_clean(mem, L"Persona & conversation memory",
                    RECT{26, promo_y + 46, kSidebarW - 24, promo_y + 64},
                    s->fonts.small_font, palette::kTextMuted);

    // Bottom User Profile Footer in Sidebar
    draw_line(mem, 14, H - 48, kSidebarW - 14, H - 48, palette::kSidebarBorder);
    fill_round_rect(mem, RECT{18, H - 38, 42, H - 14}, 12, RGB(59, 130, 246), RGB(59, 130, 246), 1);
    draw_text_clean(mem, L"AI", RECT{18, H - 38, 42, H - 14}, s->fonts.badge, RGB(255, 255, 255),
                    DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    draw_text_clean(mem, L"Copilot Studio", RECT{50, H - 38, 175, H - 14}, s->fonts.bold, palette::kTextInk);
    fill_round_rect(mem, RECT{182, H - 35, 232, H - 17}, 6, palette::kEmeraldBg, palette::kEmeraldBorder, 1);
    draw_text_clean(mem, L"READY", RECT{182, H - 35, 232, H - 17}, s->fonts.badge, palette::kEmerald,
                    DT_CENTER | DT_VCENTER | DT_SINGLELINE);

    // 4. Centered Main Workspace Content
    const int avail_w = std::max(640, W - kSidebarW);
    const int content_w = std::min(920, avail_w - 80);
    const int cx = kSidebarW + (avail_w - content_w) / 2;
    const int top_y = kTopBarH + 28;

    if (s->active_tab == kTabGoals) {
        // Eyebrow + Hero Title ("INTERVIEW HORIZON" / "Goals")
        draw_text_clean(mem, L"INTERVIEW HORIZON", RECT{cx, top_y, cx + 300, top_y + 16},
                        s->fonts.section, palette::kTextMuted);
        draw_text_clean(mem, L"Goals", RECT{cx, top_y + 16, cx + 400, top_y + 52},
                        s->fonts.hero_title, palette::kTextInk);
        draw_text_clean(mem, widen_utf8(s->status_text), RECT{cx, top_y + 52, cx + content_w, top_y + 70},
                        s->fonts.small_font, palette::kTextMuted);

        // Warm Cream Onboarding Card ("Four steps to your first debrief" in Image 2)
        const int hero_y = top_y + 78;
        fill_round_rect(mem, RECT{cx, hero_y, cx + content_w, hero_y + 190}, 12,
                        palette::kHeroCardBg, palette::kHeroCardBorder, 1);

        draw_text_clean(mem, L"GETTING STARTED · SMART PREP",
                        RECT{cx + 24, hero_y + 14, cx + content_w - 24, hero_y + 30},
                        s->fonts.section, palette::kTextMuted);
        draw_text_clean(mem, L"Four steps to your best-fit interview",
                        RECT{cx + 24, hero_y + 30, cx + content_w - 24, hero_y + 56},
                        s->fonts.card_title, palette::kTextInk);

        auto draw_step = [&](int idx, int sy, bool done, const wchar_t* title, const wchar_t* desc) {
            RECT badge_rc{cx + 24, sy + 2, cx + 44, sy + 22};
            fill_round_rect(mem, badge_rc, 10,
                            done ? palette::kEmeraldBg : RGB(238, 233, 224),
                            done ? palette::kEmeraldBorder : RGB(220, 214, 202), 1);
            draw_text_clean(mem, done ? L"✓" : std::to_wstring(idx).c_str(), badge_rc,
                            s->fonts.badge, done ? palette::kEmerald : palette::kTextBody,
                            DT_CENTER | DT_VCENTER | DT_SINGLELINE);

            draw_text_clean(mem, title, RECT{cx + 54, sy, cx + 310, sy + 24},
                            s->fonts.bold, palette::kTextInk);
            draw_text_clean(mem, desc, RECT{cx + 315, sy, cx + content_w - 185, sy + 24},
                            s->fonts.small_font, palette::kTextMuted);
        };

        draw_step(1, hero_y + 60,  !s->current_agent.company.empty(),
                  L"Define the goal (company & role)", L"One role, one company. Quick research on culture and values.");
        draw_step(2, hero_y + 92,  !s->current_agent.documents.empty(),
                  L"Attach resume & files (RAG)", L"Automatic in-depth reading and Mini-Compact generation.");
        draw_step(3, hero_y + 124, !s->current_agent.custom_instructions.empty(),
                  L"Tune persona & Google Calendar", L"Sync the invite and set STAR guidelines without inventing facts.");
        draw_step(4, hero_y + 156, !s->current_agent.mini_compact.empty(),
                  L"Start the live session (HUD)", L"Real-time answers that reuse the whole conversation and persona.");

        // Active Goal Editor Form below the Hero Card
        const int form_y = hero_y + 212;
        const int col_gap = 20;
        const int col3_w = (content_w - col_gap * 2) / 3;

        draw_text_clean(mem, L"Goal / session name", RECT{cx, form_y, cx + col3_w, form_y + 18},
                        s->fonts.label, palette::kTextInk);
        draw_text_clean(mem, L"Target company", RECT{cx + col3_w + col_gap, form_y, cx + col3_w * 2 + col_gap, form_y + 18},
                        s->fonts.label, palette::kTextInk);
        draw_text_clean(mem, L"Role / Position", RECT{cx + (col3_w + col_gap) * 2, form_y, cx + content_w, form_y + 18},
                        s->fonts.label, palette::kTextInk);

        draw_text_clean(mem, L"Company dossier, culture & fit pillars (used in the Mini-Compact and RAG)",
                        RECT{cx, form_y + 110, cx + content_w, form_y + 128},
                        s->fonts.label, palette::kTextInk);

    } else if (s->active_tab == kTabLibrary) {
        draw_text_clean(mem, L"KNOWLEDGE BASE & MINI-COMPACT", RECT{cx, top_y, cx + 400, top_y + 16},
                        s->fonts.section, palette::kTextMuted);
        draw_text_clean(mem, L"Library (RAG & Mini-Compact)", RECT{cx, top_y + 16, cx + 600, top_y + 52},
                        s->fonts.hero_title, palette::kTextInk);
        draw_text_clean(mem, L"Upload your resume, the job description and your projects. The app reads them in depth and builds the Mini-Compact that goes with every prompt.",
                        RECT{cx, top_y + 54, cx + content_w, top_y + 74},
                        s->fonts.small_font, palette::kTextMuted);

        const int lib_y = top_y + 84;
        draw_text_clean(mem, L"Persona instructions, tone of voice & behavior guidelines (STAR / culture fit)",
                        RECT{cx, lib_y + 188, cx + content_w, lib_y + 208},
                        s->fonts.label, palette::kTextInk);

    } else if (s->active_tab == kTabCalendar) {
        draw_text_clean(mem, L"SCHEDULE & INTERVIEWS", RECT{cx, top_y, cx + 400, top_y + 16},
                        s->fonts.section, palette::kTextMuted);
        draw_text_clean(mem, L"Google Calendar & schedule", RECT{cx, top_y + 16, cx + 600, top_y + 52},
                        s->fonts.hero_title, palette::kTextInk);
        draw_text_clean(mem, L"Connect your private Google Calendar .ics link or OAuth2 token to import interviews and fill in the goal automatically.",
                        RECT{cx, top_y + 54, cx + content_w, top_y + 74},
                        s->fonts.small_font, palette::kTextMuted);

        const int cal_y = top_y + 84;
        draw_text_clean(mem, L"Private Google Calendar .ics URL or OAuth2 token",
                        RECT{cx, cal_y, cx + content_w, cal_y + 18},
                        s->fonts.label, palette::kTextInk);
        draw_text_clean(mem, L"Upcoming events found (click one to fill in the session)",
                        RECT{cx, cal_y + 68, cx + content_w, cal_y + 88},
                        s->fonts.label, palette::kTextInk);

    } else if (s->active_tab == kTabSettings) {
        draw_text_clean(mem, L"SYSTEM PREFERENCES & PROVIDERS", RECT{cx, top_y, cx + 400, top_y + 16},
                        s->fonts.section, palette::kTextMuted);
        draw_text_clean(mem, L"Settings", RECT{cx, top_y + 16, cx + 600, top_y + 52},
                        s->fonts.hero_title, palette::kTextInk);
        draw_text_clean(mem, L"Keys are protected with Windows DPAPI encryption. Leaving a key blank keeps the saved one.",
                        RECT{cx, top_y + 54, cx + content_w, top_y + 74},
                        s->fonts.small_font, palette::kTextMuted);

        const int set_y = top_y + 76;
        const int scol_w = (content_w - 28) / 2;
        const int L1 = cx;
        const int L2 = cx + scol_w + 28;
        const int half_w = (scol_w - 12) / 2;
        const int third_w = (scol_w - 20) / 3;

        auto draw_key_lbl = [&](int y, const wchar_t* name, bool has_key, bool opt) {
            draw_text_clean(mem, name, RECT{L1, y, L1 + scol_w - 90, y + 18}, s->fonts.label, palette::kTextInk);
            draw_text_clean(mem, has_key ? L"● Set" : (opt ? L"○ Optional" : L"○ Pending"),
                            RECT{L1 + scol_w - 110, y, L1 + scol_w, y + 18},
                            s->fonts.small_font, has_key ? palette::kEmerald : palette::kTextMuted,
                            DT_RIGHT | DT_VCENTER | DT_SINGLELINE);
        };

        draw_key_lbl(set_y,       L"Deepgram API Key (STT Nova-3)",       s->st && !s->st->deepgram_key.empty(), false);
        draw_key_lbl(set_y + 58,  L"Cerebras API Key (Hot Path HTTP/2)",  s->st && !s->st->cerebras_key.empty(), true);
        draw_key_lbl(set_y + 116, L"Groq API Key (Fallback HTTP/2)",      s->st && !s->st->groq_key.empty(), true);
        draw_key_lbl(set_y + 174, L"OpenRouter / OpenAI API Key",         s->st && !s->st->llm_key.empty(), true);

        draw_text_clean(mem, L"Endpoint URL (OpenRouter / Custom)", RECT{L1, set_y + 232, L1 + scol_w, set_y + 250}, s->fonts.label, palette::kTextInk);
        draw_text_clean(mem, L"STT language (multi, pt-BR, en)",      RECT{L1, set_y + 290, L1 + half_w, set_y + 308}, s->fonts.label, palette::kTextInk);
        draw_text_clean(mem, L"Endpointing (ms)",                   RECT{L1 + half_w + 12, set_y + 290, L1 + scol_w, set_y + 308}, s->fonts.label, palette::kTextInk);
        draw_text_clean(mem, L"Deepgram boost terms",        RECT{L1, set_y + 348, L1 + scol_w, set_y + 366}, s->fonts.label, palette::kTextInk);

        draw_text_clean(mem, L"Main LLM model",               RECT{L2, set_y, L2 + scol_w, set_y + 18}, s->fonts.label, palette::kTextInk);
        draw_text_clean(mem, L"Reasoning",                         RECT{L2, set_y + 58, L2 + third_w, set_y + 76}, s->fonts.label, palette::kTextInk);
        draw_text_clean(mem, L"Temperature",                        RECT{L2 + third_w + 10, set_y + 58, L2 + third_w * 2 + 10, set_y + 76}, s->fonts.label, palette::kTextInk);
        draw_text_clean(mem, L"Max Tokens",                         RECT{L2 + (third_w + 10) * 2, set_y + 58, L2 + scol_w, set_y + 76}, s->fonts.label, palette::kTextInk);
        draw_text_clean(mem, L"Extra trigger keywords",   RECT{L2, set_y + 116, L2 + scol_w, set_y + 134}, s->fonts.label, palette::kTextInk);
        draw_text_clean(mem, L"Cooldown (seconds)",                RECT{L2, set_y + 174, L2 + half_w, set_y + 192}, s->fonts.label, palette::kTextInk);
        draw_text_clean(mem, L"Voice detector (VAD)",              RECT{L2 + half_w + 12, set_y + 174, L2 + scol_w, set_y + 192}, s->fonts.label, palette::kTextInk);
        draw_text_clean(mem, L"HUD width (420–1100)",          RECT{L2, set_y + 232, L2 + half_w, set_y + 250}, s->fonts.label, palette::kTextInk);
        draw_text_clean(mem, L"HUD max height (20–95%)",        RECT{L2 + half_w + 12, set_y + 232, L2 + scol_w, set_y + 250}, s->fonts.label, palette::kTextInk);
    }

    // 5. Draw Input Frames for the active tab
    draw_input_frames(mem, s->frames, s->active_tab);

    BitBlt(hdc, 0, 0, W, H, mem, 0, 0, SRCCOPY);
    SelectObject(mem, old_bmp);
    DeleteObject(bmp);
    DeleteDC(mem);
    EndPaint(hwnd, &ps);
}

inline bool save_settings_from_studio(StudioState* s) {
    if (!s || !s->st) return false;
    std::vector<wincfg::UiValue> vals;
    const std::string dg = text::trim(read_hwnd_text(s->deepgram_key));
    const std::string cb = text::trim(read_hwnd_text(s->cerebras_key));
    const std::string gq = text::trim(read_hwnd_text(s->groq_key));
    const std::string or_key = text::trim(read_hwnd_text(s->openrouter_key));
    if (!dg.empty()) vals.push_back({"deepgram", "api_key", dg});
    if (!cb.empty()) vals.push_back({"llm", "cerebras_api_key", cb});
    if (!gq.empty()) vals.push_back({"llm", "groq_api_key", gq});
    if (!or_key.empty()) vals.push_back({"llm", "api_key", or_key});

    vals.push_back({"llm", "url", text::trim(read_hwnd_text(s->llm_url))});
    vals.push_back({"llm", "modelo", text::trim(read_hwnd_text(s->model))});
    vals.push_back({"llm", "raciocinio", s->selected_reasoning});
    vals.push_back({"llm", "temperatura", text::trim(read_hwnd_text(s->temperature))});
    vals.push_back({"llm", "max_tokens", text::trim(read_hwnd_text(s->max_tokens))});
    vals.push_back({"llm", "intervalo_minimo_s", text::trim(read_hwnd_text(s->cooldown))});
    vals.push_back({"llm", "palavras_chave", text::trim(read_hwnd_text(s->keywords))});
    vals.push_back({"llm", "sugestao_automatica", get_toggle_checked(s->auto_suggest) ? "sim" : "nao"});

    vals.push_back({"deepgram", "idioma", text::trim(read_hwnd_text(s->language))});
    vals.push_back({"deepgram", "endpointing_ms", text::trim(read_hwnd_text(s->endpointing))});
    vals.push_back({"deepgram", "termos", text::trim(read_hwnd_text(s->keyterms))});

    vals.push_back({"audio", "microfone", get_toggle_checked(s->mic_enabled) ? "sim" : "nao"});
    vals.push_back({"audio", "audio_sistema", get_toggle_checked(s->loopback_enabled) ? "sim" : "nao"});
    vals.push_back({"audio", "vad", s->selected_vad});

    vals.push_back({"overlay", "largura", text::trim(read_hwnd_text(s->overlay_width))});
    vals.push_back({"overlay", "altura_max_pct", text::trim(read_hwnd_text(s->overlay_height_pct))});
    vals.push_back({"sessao", "salvar", get_toggle_checked(s->save_sessions) ? "sim" : "nao"});

    const std::string cal_u = text::trim(read_hwnd_text(s->cal_input));
    if (!cal_u.empty()) vals.push_back({"calendario", "url_ics", cal_u});

    std::string err;
    if (!wincfg::apply_values(s->config_path, vals, &err)) {
        MessageBoxW(s->hwnd, widen_utf8(err).c_str(), L"RealTimeAI — Save error", MB_OK | MB_ICONERROR);
        return false;
    }
    const ini::File file = ini::File::parse(wincfg::read_file(s->config_path));
    *s->st = load_settings(file, s->env_fn, [](const std::string& v) { return wincfg::unprotect(v); });
    s->settings_saved = true;
    return true;
}

inline LRESULT CALLBACK studio_wnd_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    auto* s = reinterpret_cast<StudioState*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    if (msg == WM_NCCREATE) {
        auto* cs = reinterpret_cast<CREATESTRUCTW*>(lp);
        s = static_cast<StudioState*>(cs->lpCreateParams);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(s));
        s->hwnd = hwnd;
    }
    if (!s) return DefWindowProcW(hwnd, msg, wp, lp);

    switch (msg) {
        case WM_CREATE: {
            enable_dark_titlebar_chrome(hwnd);
            s->fonts.init();

            // ---- Sidebar Controls ----
            s->btn_new_goal_sb = make_modern_btn(hwnd, kStNewGoalSidebar, L"＋  New goal",
                                                 0, 0, 100, 34, s->fonts.bold, BtnKind::SidebarNew, false, true);
            s->btn_agent_sel = make_modern_btn(hwnd, kStAgentSelector, L"Select goal...",
                                               0, 0, 100, 34, s->fonts.body, BtnKind::Dropdown, false, true);

            s->btn_nav_goals    = make_modern_btn(hwnd, kStNavGoals,    L"🎯   Goals & interview",
                                                  0, 0, 100, 32, s->fonts.body, BtnKind::SidebarNav, s->active_tab == kTabGoals, true);
            s->btn_nav_library  = make_modern_btn(hwnd, kStNavLibrary,  L"📚   Library (RAG & Compact)",
                                                  0, 0, 100, 32, s->fonts.body, BtnKind::SidebarNav, s->active_tab == kTabLibrary, true);
            s->btn_nav_calendar = make_modern_btn(hwnd, kStNavCalendar, L"📅   Google Calendar",
                                                  0, 0, 100, 32, s->fonts.body, BtnKind::SidebarNav, s->active_tab == kTabCalendar, true);
            s->btn_nav_settings = make_modern_btn(hwnd, kStNavSettings, L"⚙️   Settings",
                                                  0, 0, 100, 32, s->fonts.body, BtnKind::SidebarNav, s->active_tab == kTabSettings, true);

            // ---- Top Bar Controls ----
            s->btn_fullscreen = make_modern_btn(hwnd, kStFullscreenBtn, L"⛶ Full screen (F11)",
                                                0, 0, 148, 34, s->fonts.body, BtnKind::Secondary);
            s->btn_demo       = make_modern_btn(hwnd, kStStartDemoBtn,  L"🧪 Try demo",
                                                0, 0, 146, 34, s->fonts.body, BtnKind::Secondary);
            s->btn_launch     = make_modern_btn(hwnd, kStStartLiveBtn,  L"🚀 Start copilot",
                                                0, 0, 178, 34, s->fonts.bold, BtnKind::PrimaryCoral);

            // ---- Tab 0: Goals Controls ----
            s->btn_save_agent   = make_modern_btn(hwnd, kStSaveAgentBtn,   L"💾 Save goal",
                                                  0, 0, 126, 32, s->fonts.bold, BtnKind::Secondary);
            s->btn_delete_agent = make_modern_btn(hwnd, kStDeleteAgentBtn, L"✕ Delete",
                                                  0, 0, 86, 32, s->fonts.body, BtnKind::Danger);

            s->btn_step1 = make_modern_btn(hwnd, kStStep1Link, L"Research company →",
                                           0, 0, 150, 26, s->fonts.bold, BtnKind::GhostLink, false, false, true);
            s->btn_step2 = make_modern_btn(hwnd, kStStep2Link, L"Attach resume →",
                                           0, 0, 150, 26, s->fonts.bold, BtnKind::GhostLink, false, false, true);
            s->btn_step3 = make_modern_btn(hwnd, kStStep3Link, L"Open calendar →",
                                           0, 0, 150, 26, s->fonts.bold, BtnKind::GhostLink, false, false, true);
            s->btn_step4 = make_modern_btn(hwnd, kStStep4Link, L"View Mini-Compact →",
                                           0, 0, 150, 26, s->fonts.bold, BtnKind::GhostLink, false, false, true);

            s->session_name = make_framed_edit(hwnd, kStSessionName, 0, 0, 100, 34, s->fonts.body, s->frames, 1 << kTabGoals);
            s->company      = make_framed_edit(hwnd, kStCompany,     0, 0, 100, 34, s->fonts.body, s->frames, 1 << kTabGoals);
            s->role         = make_framed_edit(hwnd, kStRole,        0, 0, 100, 34, s->fonts.body, s->frames, 1 << kTabGoals);

            s->btn_company_search = make_modern_btn(hwnd, kStCompanySearch,
                                                    L"⚡ Research the company (quick tool: culture, products, values & fit)",
                                                    0, 0, 100, 34, s->fonts.bold, BtnKind::AccentSoft);
            s->company_dossier = make_framed_edit(hwnd, kStCompanyDossier, 0, 0, 100, 140, s->fonts.body, s->frames, 1 << kTabGoals, false, true);

            // ---- Tab 1: Library RAG & Mini-Compact Controls ----
            s->btn_add_files       = make_modern_btn(hwnd, kStAddFiles,       L"📎 Upload files (RAG)", 0, 0, 170, 34, s->fonts.bold, BtnKind::PrimaryCoral);
            s->btn_paste_clip      = make_modern_btn(hwnd, kStPasteClipboard, L"📋 Paste text / resume",      0, 0, 150, 34, s->fonts.body, BtnKind::Secondary);
            s->btn_preview_compact = make_modern_btn(hwnd, kStPreviewCompact, L"🧠 View AI Mini-Compact",   0, 0, 210, 34, s->fonts.bold, BtnKind::AccentSoft);
            s->btn_remove_doc      = make_modern_btn(hwnd, kStRemoveDoc,      L"✕ Remove",               0, 0, 110, 34, s->fonts.body, BtnKind::Danger);

            s->doc_list     = make_framed_listbox(hwnd, kStDocList, 0, 0, 100, 130, s->fonts.body, s->frames, 1 << kTabLibrary);
            s->instructions = make_framed_edit(hwnd, kStInstructions, 0, 0, 100, 160, s->fonts.body, s->frames, 1 << kTabLibrary, false, true);

            // ---- Tab 2: Google Calendar Controls ----
            s->cal_input       = make_framed_edit(hwnd, kStCalInput, 0, 0, 100, 34, s->fonts.body, s->frames, 1 << kTabCalendar);
            set_hwnd_text(s->cal_input, s->st ? s->st->calendar_ics_url : "");
            s->btn_cal_sync    = make_modern_btn(hwnd, kStCalSync,    L"📅 Sync calendar",    0, 0, 168, 34, s->fonts.bold, BtnKind::PrimaryCoral);
            s->btn_cal_browser = make_modern_btn(hwnd, kStCalBrowser, L"🌐 Open Google Calendar", 0, 0, 170, 34, s->fonts.body, BtnKind::Secondary);
            s->cal_list        = make_framed_listbox(hwnd, kStCalList, 0, 0, 100, 200, s->fonts.body, s->frames, 1 << kTabCalendar);
            SendMessageW(s->cal_list, LB_ADDSTRING, 0,
                         reinterpret_cast<LPARAM>(L"💡 Paste your Google Calendar .ics link (Settings -> Secret address in iCal format) and click 'Sync calendar'."));

            // ---- Tab 3: Settings Controls ----
            s->deepgram_key   = make_framed_edit(hwnd, kCfgDeepgramKey,   0, 0, 100, 32, s->fonts.body, s->frames, 1 << kTabSettings, true);
            s->cerebras_key   = make_framed_edit(hwnd, kCfgCerebrasKey,   0, 0, 100, 32, s->fonts.body, s->frames, 1 << kTabSettings, true);
            s->groq_key       = make_framed_edit(hwnd, kCfgGroqKey,       0, 0, 100, 32, s->fonts.body, s->frames, 1 << kTabSettings, true);
            s->openrouter_key = make_framed_edit(hwnd, kCfgOpenRouterKey, 0, 0, 100, 32, s->fonts.body, s->frames, 1 << kTabSettings, true);
            s->llm_url        = make_framed_edit(hwnd, kCfgLlmUrl,        0, 0, 100, 32, s->fonts.body, s->frames, 1 << kTabSettings);
            s->language       = make_framed_edit(hwnd, kCfgLanguage,      0, 0, 100, 32, s->fonts.body, s->frames, 1 << kTabSettings);
            s->endpointing    = make_framed_edit(hwnd, kCfgEndpointing,   0, 0, 100, 32, s->fonts.body, s->frames, 1 << kTabSettings);
            s->keyterms       = make_framed_edit(hwnd, kCfgKeyterms,      0, 0, 100, 32, s->fonts.body, s->frames, 1 << kTabSettings);

            s->model          = make_framed_edit(hwnd, kCfgModel,         0, 0, 100, 32, s->fonts.body, s->frames, 1 << kTabSettings);
            s->model_preset_btn = make_modern_btn(hwnd, kCfgModelPresetBtn, L"Presets ▾", 0, 0, 106, 32, s->fonts.bold, BtnKind::AccentSoft);

            s->selected_reasoning = (s->st && !s->st->reasoning.empty()) ? s->st->reasoning : "minimal";
            s->reasoning_btn = make_modern_btn(hwnd, kCfgReasoningBtn, widen_utf8(s->selected_reasoning).c_str(),
                                               0, 0, 100, 32, s->fonts.body, BtnKind::Dropdown);
            s->temperature   = make_framed_edit(hwnd, kCfgTemperature,    0, 0, 100, 32, s->fonts.body, s->frames, 1 << kTabSettings);
            s->max_tokens    = make_framed_edit(hwnd, kCfgMaxTokens,      0, 0, 100, 32, s->fonts.body, s->frames, 1 << kTabSettings);
            s->keywords      = make_framed_edit(hwnd, kCfgKeywords,       0, 0, 100, 32, s->fonts.body, s->frames, 1 << kTabSettings);
            s->cooldown      = make_framed_edit(hwnd, kCfgCooldown,       0, 0, 100, 32, s->fonts.body, s->frames, 1 << kTabSettings);

            s->selected_vad = (s->st && s->st->vad == "energia") ? "energia" : "silero";
            s->vad_mode_btn = make_modern_btn(hwnd, kCfgVadModeBtn, widen_utf8(s->selected_vad).c_str(),
                                              0, 0, 100, 32, s->fonts.body, BtnKind::Dropdown);

            s->overlay_width      = make_framed_edit(hwnd, kCfgOverlayWidth,     0, 0, 100, 32, s->fonts.body, s->frames, 1 << kTabSettings);
            s->overlay_height_pct = make_framed_edit(hwnd, kCfgOverlayHeightPct, 0, 0, 100, 32, s->fonts.body, s->frames, 1 << kTabSettings);

            s->auto_suggest     = make_modern_btn(hwnd, kCfgAutoSuggest,     L"Suggest automatically when a question is detected", 0, 0, 100, 26, s->fonts.body, BtnKind::Toggle, s->st ? s->st->auto_suggest : true);
            s->mic_enabled      = make_modern_btn(hwnd, kCfgMicEnabled,      L"Microphone (You)",                          0, 0, 100, 26, s->fonts.body, BtnKind::Toggle, s->st ? s->st->mic_enabled : true);
            s->loopback_enabled = make_modern_btn(hwnd, kCfgLoopbackEnabled, L"System audio (Others)",                 0, 0, 100, 26, s->fonts.body, BtnKind::Toggle, s->st ? s->st->loopback_enabled : true);
            s->save_sessions    = make_modern_btn(hwnd, kCfgSaveSessions,    L"Save session history and transcripts",0, 0, 100, 26, s->fonts.body, BtnKind::Toggle, s->st ? s->st->save_sessions : true);

            s->btn_open_notepad  = make_modern_btn(hwnd, kCfgOpenNotepad, L"📄 Open config.ini in the editor", 0, 0, 230, 36, s->fonts.body, BtnKind::Secondary);
            s->btn_save_settings = make_modern_btn(hwnd, kCfgSaveBtn,     L"💾 Save settings",       0, 0, 220, 36, s->fonts.bold, BtnKind::PrimaryCoral);

            if (s->st) {
                set_hwnd_text(s->llm_url, s->st->llm_url);
                set_hwnd_text(s->language, s->st->language);
                set_hwnd_text(s->endpointing, std::to_string(s->st->endpointing_ms));
                set_hwnd_text(s->keyterms, join_comma(s->st->keyterms));
                set_hwnd_text(s->model, s->st->model);
                char tbuf[32];
                std::snprintf(tbuf, sizeof(tbuf), "%.2f", s->st->temperature);
                set_hwnd_text(s->temperature, tbuf);
                set_hwnd_text(s->max_tokens, std::to_string(s->st->max_tokens));
                set_hwnd_text(s->keywords, join_comma(s->st->keywords));
                set_hwnd_text(s->cooldown, std::to_string(s->st->cooldown_s));
                set_hwnd_text(s->overlay_width, std::to_string(s->st->overlay_width));
                set_hwnd_text(s->overlay_height_pct, std::to_string(s->st->overlay_max_height_pct));
            }

            // Load initial agent
            refresh_saved_agents(s, s->st ? s->st->last_agent : "");
            if (!s->saved_agents.empty()) {
                s->current_agent = s->saved_agents[static_cast<std::size_t>(s->selected_agent_idx)];
            }
            if (s->st && !s->st->context_file.empty()) {
                fs::path cp(widen_utf8(s->st->context_file));
                if (cp.is_relative()) cp = s->app_dir / cp;
                std::string ctxt = load_document_text_for_rag(cp);
                if (!ctxt.empty()) {
                    bool exists = false;
                    for (const auto& d : s->current_agent.documents) {
                        if (d.name == narrow_utf8(cp.filename().wstring())) exists = true;
                    }
                    if (!exists) {
                        s->current_agent.documents.push_back(
                            RagDocument{narrow_utf8(cp.filename().wstring()), narrow_utf8(cp.wstring()), std::move(ctxt)});
                    }
                }
            }
            sync_ui_from_agent(s);

            RECT rc{};
            GetClientRect(hwnd, &rc);
            relayout_studio(s, rc.right - rc.left, rc.bottom - rc.top);
            return 0;
        }

        case WM_GETMINMAXINFO: {
            auto* mmi = reinterpret_cast<MINMAXINFO*>(lp);
            mmi->ptMinTrackSize.x = 980;
            mmi->ptMinTrackSize.y = 660;
            return 0;
        }

        case WM_SIZE: {
            const int W = LOWORD(lp);
            const int H = HIWORD(lp);
            relayout_studio(s, W, H);
            InvalidateRect(hwnd, nullptr, FALSE);
            return 0;
        }

        case WM_KEYDOWN: {
            if (wp == VK_F11) {
                toggle_fullscreen(hwnd, s);
                return 0;
            }
            break;
        }

        case WM_ERASEBKGND:
            return 1;

        case WM_PAINT:
            paint_studio_window(hwnd, s);
            return 0;

        case WM_DRAWITEM: {
            auto* dis = reinterpret_cast<const DRAWITEMSTRUCT*>(lp);
            if (!dis) break;
            if (dis->CtlType == ODT_BUTTON) {
                draw_modern_button(dis, s->fonts);
                return TRUE;
            }
            if (dis->CtlType == ODT_LISTBOX) {
                draw_modern_listbox_item(dis, s->fonts);
                return TRUE;
            }
            break;
        }

        case WM_CTLCOLOREDIT:
        case WM_CTLCOLORLISTBOX: {
            HDC hdc = reinterpret_cast<HDC>(wp);
            SetTextColor(hdc, palette::kTextInk);
            SetBkColor(hdc, palette::kInputBg);
            return reinterpret_cast<LRESULT>(s->fonts.input_brush);
        }

        case WM_COMMAND: {
            const int id = LOWORD(wp);
            const int code = HIWORD(wp);

            if (code == EN_SETFOCUS || code == EN_KILLFOCUS) {
                InvalidateRect(hwnd, nullptr, FALSE);
                return 0;
            }

            // Sidebar Tab Navigation
            if (id == kStNavGoals)    { switch_studio_tab(s, kTabGoals);    return 0; }
            if (id == kStNavLibrary || id == kStStep2Link)  { switch_studio_tab(s, kTabLibrary);  return 0; }
            if (id == kStNavCalendar || id == kStStep3Link) { switch_studio_tab(s, kTabCalendar); return 0; }
            if (id == kStNavSettings) { switch_studio_tab(s, kTabSettings); return 0; }

            if (id == kStFullscreenBtn) {
                toggle_fullscreen(hwnd, s);
                return 0;
            }

            if (id == kStNewGoalSidebar) {
                sync_agent_from_ui(s);
                s->current_agent = MiniAgentProfile{};
                s->current_agent.name = "New interview goal";
                s->current_agent.custom_instructions =
                    "- Structure behavioral answers with STAR.\n"
                    "- Connect my experiences from the attached files (RAG) to the company culture and challenges.";
                sync_ui_from_agent(s);
                switch_studio_tab(s, kTabGoals);
                SetFocus(s->company);
                return 0;
            }

            if (id == kStAgentSelector) {
                std::vector<std::wstring> labels;
                for (const auto& a : s->saved_agents) {
                    std::string lbl = a.name.empty() ? a.id : a.name;
                    if (!a.company.empty()) lbl += "  [" + a.company + "]";
                    labels.push_back(widen_utf8(lbl));
                }
                int idx = show_dropdown_menu(hwnd, s->btn_agent_sel, labels);
                if (idx >= 0 && idx < static_cast<int>(s->saved_agents.size())) {
                    s->selected_agent_idx = idx;
                    s->current_agent = s->saved_agents[static_cast<std::size_t>(idx)];
                    sync_ui_from_agent(s);
                }
                return 0;
            }

            if (id == kStSaveAgentBtn) {
                sync_agent_from_ui(s);
                if (s->current_agent.name.empty()) {
                    s->current_agent.name = "Goal Personalizado";
                    s->current_agent.id = MiniAgentProfile::slugify(s->current_agent.name);
                }
                std::error_code ec;
                fs::create_directories(s->agents_dir, ec);
                const fs::path p = s->agents_dir / widen_utf8(s->current_agent.id + ".json");
                wincfg::write_file_atomic(p, s->current_agent.to_json());
                wincfg::apply_values(s->config_path, {{"sessao", "ultimo_agente", s->current_agent.id}}, nullptr);
                refresh_saved_agents(s, s->current_agent.id);
                sync_ui_from_agent(s);
                return 0;
            }

            if (id == kStDeleteAgentBtn) {
                if (s->selected_agent_idx >= 0 && s->selected_agent_idx < static_cast<int>(s->saved_agents.size())) {
                    const std::string del_id = s->saved_agents[static_cast<std::size_t>(s->selected_agent_idx)].id;
                    std::error_code ec;
                    fs::remove(s->agents_dir / widen_utf8(del_id + ".json"), ec);
                    refresh_saved_agents(s);
                    if (!s->saved_agents.empty()) s->current_agent = s->saved_agents[0];
                    else s->current_agent = MiniAgentProfile{};
                    sync_ui_from_agent(s);
                }
                return 0;
            }

            if (id == kStCompanySearch || id == kStStep1Link) {
                sync_agent_from_ui(s);
                if (s->current_agent.company.empty()) {
                    SetFocus(s->company);
                    MessageBoxW(hwnd, L"Type the target company name first to run the quick research.",
                                L"Research the company", MB_OK | MB_ICONINFORMATION);
                    return 0;
                }
                s->status_text = "⚡ Buscando cultura, produtos e valores sobre '" + s->current_agent.company + "'...";
                InvalidateRect(hwnd, nullptr, FALSE);
                UpdateWindow(hwnd);
                const std::string dossier = web::search_company(s->current_agent.company, s->current_agent.role);
                s->current_agent.company_dossier = dossier;
                sync_ui_from_agent(s);
                return 0;
            }

            if (id == kStAddFiles) {
                sync_agent_from_ui(s);
                std::vector<wchar_t> buf(32768, L'\0');
                OPENFILENAMEW ofn{};
                ofn.lStructSize = sizeof(ofn);
                ofn.hwndOwner = hwnd;
                ofn.lpstrFilter =
                    L"Documents & code (*.txt;*.md;*.pdf;*.docx;*.json;*.csv;*.cpp;*.py;*.ts)\0"
                    L"*.txt;*.md;*.pdf;*.docx;*.json;*.csv;*.cpp;*.hpp;*.py;*.js;*.ts;*.java;*.go\0"
                    L"All files (*.*)\0*.*\0";
                ofn.lpstrFile = buf.data();
                ofn.nMaxFile = static_cast<DWORD>(buf.size());
                ofn.Flags = OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_ALLOWMULTISELECT | OFN_NOCHANGEDIR;
                if (GetOpenFileNameW(&ofn)) {
                    const wchar_t* p = buf.data();
                    fs::path first = p;
                    p += first.native().size() + 1;
                    std::vector<fs::path> chosen;
                    if (*p == L'\0') {
                        chosen.push_back(first);
                    } else {
                        while (*p != L'\0') {
                            std::wstring fname = p;
                            chosen.push_back(first / fname);
                            p += fname.size() + 1;
                        }
                    }
                    for (const auto& fp : chosen) {
                        std::string content = load_document_text_for_rag(fp);
                        if (!content.empty()) {
                            s->current_agent.documents.push_back(
                                RagDocument{narrow_utf8(fp.filename().wstring()),
                                            narrow_utf8(fp.wstring()),
                                            std::move(content)});
                        }
                    }
                    sync_ui_from_agent(s);
                }
                return 0;
            }

            if (id == kStPasteClipboard) {
                sync_agent_from_ui(s);
                if (OpenClipboard(hwnd)) {
                    HANDLE hData = GetClipboardData(CF_UNICODETEXT);
                    if (hData) {
                        const wchar_t* wptr = static_cast<const wchar_t*>(GlobalLock(hData));
                        if (wptr) {
                            std::string clip = text::trim(narrow_utf8(wptr));
                            GlobalUnlock(hData);
                            if (!clip.empty()) {
                                const std::string doc_name = "Clipboard_" +
                                    std::to_string(s->current_agent.documents.size() + 1) + ".txt";
                                s->current_agent.documents.push_back(
                                    RagDocument{doc_name, "clipboard", text::truncate_utf8(clip, 24000)});
                                sync_ui_from_agent(s);
                            }
                        }
                    }
                    CloseClipboard();
                }
                return 0;
            }

            if (id == kStPreviewCompact || id == kStStep4Link) {
                sync_agent_from_ui(s);
                sync_ui_from_agent(s);
                const std::wstring msg_w = widen_utf8(
                    "This Mini-Compact was built from an in-depth reading of every uploaded file, "
                    "the instructions and the company dossier.\n"
                    "It is ALWAYS sent with every question to keep the same persona and real facts, "
                    "and the engine decides when to fetch extra RAG chunks:\n\n" +
                    s->current_agent.mini_compact);
                MessageBoxW(hwnd, msg_w.c_str(),
                            L"RealTimeAI — In-depth reading & Mini-Compact (always in the prompt)",
                            MB_OK | MB_ICONINFORMATION);
                return 0;
            }

            if (id == kStRemoveDoc) {
                sync_agent_from_ui(s);
                int idx = static_cast<int>(SendMessageW(s->doc_list, LB_GETCURSEL, 0, 0));
                if (idx >= 0 && idx < static_cast<int>(s->current_agent.documents.size())) {
                    s->current_agent.documents.erase(s->current_agent.documents.begin() + idx);
                    sync_ui_from_agent(s);
                }
                return 0;
            }

            if (id == kStCalBrowser) {
                ShellExecuteW(nullptr, L"open", L"https://calendar.google.com/calendar/u/0/r/settings",
                              nullptr, nullptr, SW_SHOWNORMAL);
                return 0;
            }

            if (id == kStCalSync) {
                const std::string url_or_tok = text::trim(read_hwnd_text(s->cal_input));
                if (!url_or_tok.empty()) {
                    wincfg::apply_values(s->config_path, {{"calendario", "url_ics", url_or_tok}}, nullptr);
                    if (s->st) s->st->calendar_ics_url = url_or_tok;
                }
                std::string err;
                s->calendar_events = web::fetch_google_calendar_events(url_or_tok, &err);
                SendMessageW(s->cal_list, LB_RESETCONTENT, 0, 0);
                if (s->calendar_events.empty()) {
                    SendMessageW(s->cal_list, LB_ADDSTRING, 0,
                                 reinterpret_cast<LPARAM>(widen_utf8("⚠️ " + err).c_str()));
                } else {
                    for (const auto& ev : s->calendar_events) {
                        std::string line = "📅 " + (ev.start_time.empty() ? std::string("Evento") : ev.start_time) +
                                           "  —  " + ev.title;
                        if (!ev.company_hint.empty()) line += "  [Empresa: " + ev.company_hint + "]";
                        SendMessageW(s->cal_list, LB_ADDSTRING, 0, reinterpret_cast<LPARAM>(widen_utf8(line).c_str()));
                    }
                }
                return 0;
            }

            if (id == kStCalList && code == LBN_SELCHANGE) {
                int idx = static_cast<int>(SendMessageW(s->cal_list, LB_GETCURSEL, 0, 0));
                if (idx >= 0 && idx < static_cast<int>(s->calendar_events.size())) {
                    sync_agent_from_ui(s);
                    const auto& ev = s->calendar_events[static_cast<std::size_t>(idx)];
                    s->current_agent.calendar_event = ev.title + (ev.start_time.empty() ? "" : " (" + ev.start_time + ")");
                    s->current_agent.name = ev.title;
                    if (!ev.company_hint.empty()) s->current_agent.company = ev.company_hint;
                    if (!ev.role_hint.empty()) s->current_agent.role = ev.role_hint;
                    if (!ev.description.empty()) {
                        s->current_agent.custom_instructions =
                            "Google Calendar invite context:\n" + ev.description + "\n\n" +
                            s->current_agent.custom_instructions;
                    }
                    sync_ui_from_agent(s);
                    switch_studio_tab(s, kTabGoals);
                }
                return 0;
            }

            // Settings controls
            if (id == kCfgAutoSuggest || id == kCfgMicEnabled ||
                id == kCfgLoopbackEnabled || id == kCfgSaveSessions) {
                flip_toggle_checked(reinterpret_cast<HWND>(lp));
                return 0;
            }

            if (id == kCfgModelPresetBtn) {
                const std::vector<std::wstring> models = {
                    L"qwen-3.8-27b", L"llama-3.3-70b", L"gpt-oss-120b",
                    L"llama-3.3-70b-versatile", L"openai/gpt-4o-mini", L"anthropic/claude-3.5-sonnet"
                };
                int idx = show_dropdown_menu(hwnd, s->model_preset_btn, models);
                if (idx >= 0 && idx < static_cast<int>(models.size())) {
                    SetWindowTextW(s->model, models[static_cast<std::size_t>(idx)].c_str());
                }
                return 0;
            }

            if (id == kCfgReasoningBtn) {
                const std::vector<std::wstring> opts = {L"minimal", L"low", L"medium", L"high", L"off"};
                int idx = show_dropdown_menu(hwnd, s->reasoning_btn, opts);
                if (idx >= 0 && idx < static_cast<int>(opts.size())) {
                    s->selected_reasoning = narrow_utf8(opts[static_cast<std::size_t>(idx)]);
                    SetWindowTextW(s->reasoning_btn, opts[static_cast<std::size_t>(idx)].c_str());
                    InvalidateRect(s->reasoning_btn, nullptr, FALSE);
                }
                return 0;
            }

            if (id == kCfgVadModeBtn) {
                const std::vector<std::wstring> opts = {L"silero", L"energia"};
                int idx = show_dropdown_menu(hwnd, s->vad_mode_btn, opts);
                if (idx >= 0 && idx < static_cast<int>(opts.size())) {
                    s->selected_vad = narrow_utf8(opts[static_cast<std::size_t>(idx)]);
                    SetWindowTextW(s->vad_mode_btn, opts[static_cast<std::size_t>(idx)].c_str());
                    InvalidateRect(s->vad_mode_btn, nullptr, FALSE);
                }
                return 0;
            }

            if (id == kCfgOpenNotepad) {
                wincfg::open_in_notepad(s->config_path);
                return 0;
            }

            if (id == kCfgSaveBtn) {
                if (save_settings_from_studio(s)) {
                    if (s->settings_only_mode) {
                        DestroyWindow(hwnd);
                    } else {
                        MessageBoxW(hwnd, L"Settings saved and applied.",
                                    L"RealTimeAI — Settings", MB_OK | MB_ICONINFORMATION);
                        InvalidateRect(hwnd, nullptr, FALSE);
                    }
                }
                return 0;
            }

            // Launch Session (Demo or Live HUD)
            if (id == kStStartDemoBtn || id == kStStartLiveBtn) {
                sync_agent_from_ui(s);
                save_settings_from_studio(s);
                const bool want_demo = (id == kStStartDemoBtn) || (s->initial_demo && (!s->st || s->st->deepgram_key.empty()));
                if (!want_demo && s->st && s->st->deepgram_key.empty()) {
                    const int resp = MessageBoxW(
                        hwnd,
                        L"The Deepgram key is not set yet, so live transcription is off.\n\n"
                        L"Open Settings now to paste your key?\n"
                        L"(Click 'No' to start in Demo mode with your goal.)",
                        L"RealTimeAI — Set up Deepgram",
                        MB_YESNOCANCEL | MB_ICONQUESTION);
                    if (resp == IDYES) {
                        switch_studio_tab(s, kTabSettings);
                        SetFocus(s->deepgram_key);
                        return 0;
                    }
                    if (resp == IDCANCEL) return 0;
                    s->result.run_demo = true;
                } else {
                    s->result.run_demo = want_demo;
                }
                std::error_code ec;
                fs::create_directories(s->agents_dir, ec);
                wincfg::write_file_atomic(s->agents_dir / widen_utf8(s->current_agent.id + ".json"),
                                          s->current_agent.to_json());
                wincfg::apply_values(s->config_path, {{"sessao", "ultimo_agente", s->current_agent.id}}, nullptr);

                s->result.proceed = true;
                s->result.agent = s->current_agent;
                DestroyWindow(hwnd);
                return 0;
            }
            break;
        }

        case WM_CLOSE:
            s->result.proceed = false;
            DestroyWindow(hwnd);
            return 0;

        case WM_DESTROY:
            s->fonts.cleanup();
            return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

inline SessionLaunchResult open_session_studio_gui(const fs::path& app_dir,
                                                   const fs::path& config_path,
                                                   Settings& st,
                                                   const EnvLookup& env_fn = {},
                                                   bool initial_demo = false,
                                                   int start_tab = kTabGoals,
                                                   bool settings_only = false) {
    static const wchar_t kClass[] = L"RealTimeAI.DesktopStudio.v3";
    static bool registered = false;
    if (!registered) {
        WNDCLASSW wc{};
        wc.lpfnWndProc = studio_wnd_proc;
        wc.hInstance = GetModuleHandleW(nullptr);
        wc.hCursor = LoadCursorW(nullptr, reinterpret_cast<LPCWSTR>(IDC_ARROW));
        wc.hbrBackground = nullptr;
        wc.lpszClassName = kClass;
        if (!RegisterClassW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
            return SessionLaunchResult{true, initial_demo, {}};
        }
        registered = true;
    }

    StudioState state;
    state.app_dir = app_dir;
    state.agents_dir = app_dir / L"agents";
    state.config_path = config_path;
    state.env_fn = env_fn;
    state.st = &st;
    state.initial_demo = initial_demo;
    state.active_tab = start_tab;
    state.settings_only_mode = settings_only;

    // Resizable & Maximizable desktop app (WS_OVERLAPPEDWINDOW)
    const DWORD style = WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN;
    const DWORD ex_style = WS_EX_APPWINDOW;
    RECT win_rc{0, 0, 1220, 760};
    AdjustWindowRectEx(&win_rc, style, FALSE, ex_style);
    const int win_w = std::min<int>(static_cast<int>(win_rc.right - win_rc.left), GetSystemMetrics(SM_CXSCREEN) - 40);
    const int win_h = std::min<int>(static_cast<int>(win_rc.bottom - win_rc.top), GetSystemMetrics(SM_CYSCREEN) - 60);

    const int sx = (GetSystemMetrics(SM_CXSCREEN) - win_w) / 2;
    const int sy = (GetSystemMetrics(SM_CYSCREEN) - win_h) / 2;

    HWND hwnd = CreateWindowExW(ex_style, kClass,
                                L"RealTime AI",
                                style | WS_VISIBLE,
                                std::max(0, sx), std::max(0, sy), win_w, win_h,
                                nullptr, nullptr, GetModuleHandleW(nullptr), &state);
    if (!hwnd) {
        return SessionLaunchResult{true, false, {}};
    }

    ShowWindow(hwnd, SW_SHOW);
    UpdateWindow(hwnd);
    SetForegroundWindow(hwnd);

    MSG msg{};
    while (IsWindow(hwnd) && GetMessageW(&msg, nullptr, 0, 0) > 0) {
        if (msg.message == WM_KEYDOWN && msg.wParam == VK_F11) {
            toggle_fullscreen(hwnd, &state);
            continue;
        }
        if (!IsDialogMessageW(hwnd, &msg)) {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    return state.result;
}

inline bool open_settings_gui(const fs::path& config_path, const EnvLookup& env_fn = {}) {
    const ini::File file = ini::File::parse(wincfg::read_file(config_path));
    Settings st = load_settings(file, env_fn, [](const std::string& v) { return wincfg::unprotect(v); });
    const fs::path app_dir = config_path.parent_path();
    open_session_studio_gui(app_dir, config_path, st, env_fn, false, kTabSettings, true);
    return true;
}

} // namespace rtai::gui
