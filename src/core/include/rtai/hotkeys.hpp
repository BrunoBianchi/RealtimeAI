// HUD shortcuts: the [atalhos] section of config.ini. Platform-free so it can be
// unit tested; the modifier and key values are the Win32 ones RegisterHotKey
// takes. The dashboard's Settings > Shortcuts page lists the same actions.
#pragma once

#include <cctype>
#include <cstddef>
#include <optional>
#include <string>
#include <string_view>

namespace rtai::hotkeys {

inline constexpr unsigned kModAlt = 0x1;
inline constexpr unsigned kModControl = 0x2;
inline constexpr unsigned kModShift = 0x4;
inline constexpr unsigned kModWin = 0x8;

// A value that turns the shortcut off.
inline constexpr std::string_view kDisabled = "nenhum";

struct Action {
    const char* key;  // config.ini key
    const char* fallback;
};

inline constexpr Action kActions[] = {
    {"responder", "Ctrl+Alt+Enter"},
    {"responder_alt", "Alt+Space"},
    {"responder_alt2", "Ctrl+Space"},
    {"captura", "Ctrl+Alt+S"},
    {"chat", "Ctrl+Alt+K"},
    {"resumo", "Ctrl+Alt+R"},
    {"proxima_sugestao", "Ctrl+Alt+Tab"},
    {"resposta_anterior", "Ctrl+Alt+Left"},
    {"proxima_resposta", "Ctrl+Alt+Right"},
    {"historico_anterior", "Alt+Up"},
    {"historico_proximo", "Alt+Down"},
    {"acao_rapida_1", "Alt+1"},
    {"acao_rapida_2", "Alt+2"},
    {"acao_rapida_3", "Alt+3"},
    {"pausar", "Ctrl+Alt+P"},
    {"so_transcricao", "Ctrl+Alt+M"},
    {"limpar_respostas", "Ctrl+Alt+Backspace"},
    {"limpar_transcricao", "Ctrl+Alt+Shift+Backspace"},
    {"clique_atravessa", "Ctrl+Alt+T"},
    {"esconder", "Ctrl+Alt+H"},
    {"panico", "Alt+H"},
    {"configuracoes", "Ctrl+Alt+O"},
    {"encerrar", "Ctrl+Alt+Q"},
};

inline const Action* find_action(std::string_view key) {
    for (const auto& a : kActions) {
        if (key == a.key) return &a;
    }
    return nullptr;
}

struct Combo {
    unsigned mods{0};
    unsigned vk{0};
};

namespace detail {

inline std::string lower(std::string_view s) {
    std::string out(s);
    for (char& c : out) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return out;
}

inline std::string_view trim(std::string_view s) {
    while (!s.empty() && std::isspace(static_cast<unsigned char>(s.front()))) s.remove_prefix(1);
    while (!s.empty() && std::isspace(static_cast<unsigned char>(s.back()))) s.remove_suffix(1);
    return s;
}

inline unsigned key_code(const std::string& k) {
    if (k.size() == 1) {
        const char c = k[0];
        if (c >= 'a' && c <= 'z') return static_cast<unsigned>(c - 'a' + 'A');
        if (c >= '0' && c <= '9') return static_cast<unsigned>(c);
        return 0;
    }
    if (k[0] == 'f' && k.size() <= 3) {
        int n = 0;
        for (std::size_t i = 1; i < k.size(); ++i) {
            if (k[i] < '0' || k[i] > '9') return 0;
            n = n * 10 + (k[i] - '0');
        }
        if (n >= 1 && n <= 24) return 0x70u + static_cast<unsigned>(n - 1);
        return 0;
    }
    struct Named { const char* name; unsigned vk; };
    static constexpr Named named[] = {
        {"enter", 0x0D}, {"tab", 0x09}, {"space", 0x20}, {"backspace", 0x08}, {"delete", 0x2E},
        {"insert", 0x2D}, {"home", 0x24}, {"end", 0x23}, {"pageup", 0x21}, {"pagedown", 0x22},
        {"left", 0x25}, {"up", 0x26}, {"right", 0x27}, {"down", 0x28},
    };
    for (const auto& n : named) {
        if (k == n.name) return n.vk;
    }
    return 0;
}

}  // namespace detail

// "Ctrl+Alt+Enter" -> combo. A combo needs a modifier, unless it is a function
// key: a bare letter would be taken from whatever the user is typing.
inline std::optional<Combo> parse(std::string_view text) {
    Combo combo;
    bool has_key = false;
    while (true) {
        const std::size_t plus = text.find('+');
        const std::string part = detail::lower(detail::trim(text.substr(0, plus)));
        if (part.empty()) return std::nullopt;
        if (part == "ctrl" || part == "control") combo.mods |= kModControl;
        else if (part == "alt") combo.mods |= kModAlt;
        else if (part == "shift") combo.mods |= kModShift;
        else if (part == "win") combo.mods |= kModWin;
        else {
            if (has_key) return std::nullopt;
            combo.vk = detail::key_code(part);
            if (combo.vk == 0) return std::nullopt;
            has_key = true;
        }
        if (plus == std::string_view::npos) break;
        text.remove_prefix(plus + 1);
    }
    if (!has_key) return std::nullopt;
    const bool function_key = combo.vk >= 0x70 && combo.vk <= 0x87;
    if (combo.mods == 0 && !function_key) return std::nullopt;
    return combo;
}

inline bool is_disabled(std::string_view text) { return detail::lower(detail::trim(text)) == kDisabled; }

}  // namespace rtai::hotkeys
