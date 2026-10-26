// Windows side of config.ini: location, first-run template, DPAPI protection
// of API keys and "open in Notepad".
//
// DPAPI (CryptProtectData) ties the encrypted key to the current Windows user:
// another user, or the same file copied to another PC, can't decrypt it.
#pragma once

#include <windows.h>
#include <wincrypt.h>
#include <shellapi.h>

#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
#include <vector>

#include "rtai/ini.hpp"
#include "rtai/settings.hpp"

namespace rtai::wincfg {

namespace fs = std::filesystem;

inline DATA_BLOB entropy_blob() {
    static const char kEntropy[] = "RealTimeAI.config.v1";
    DATA_BLOB b;
    b.pbData = reinterpret_cast<BYTE*>(const_cast<char*>(kEntropy));
    b.cbData = static_cast<DWORD>(sizeof(kEntropy) - 1);
    return b;
}

// "dpapi:<base64>" or nullopt on failure.
inline std::optional<std::string> protect(const std::string& plain) {
    DATA_BLOB in{static_cast<DWORD>(plain.size()), reinterpret_cast<BYTE*>(const_cast<char*>(plain.data()))};
    DATA_BLOB ent = entropy_blob();
    DATA_BLOB out{};
    if (!CryptProtectData(&in, L"RealTimeAI API key", &ent, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &out)) {
        return std::nullopt;
    }
    std::string blob(reinterpret_cast<const char*>(out.pbData), out.cbData);
    LocalFree(out.pbData);
    return std::string(kSecretPrefix) + base64_encode(blob);
}

inline std::optional<std::string> unprotect(const std::string& value) {
    if (!is_protected_secret(value)) return std::nullopt;
    auto blob = base64_decode(value.substr(6));
    if (!blob) return std::nullopt;
    DATA_BLOB in{static_cast<DWORD>(blob->size()), reinterpret_cast<BYTE*>(blob->data())};
    DATA_BLOB ent = entropy_blob();
    DATA_BLOB out{};
    if (!CryptUnprotectData(&in, nullptr, &ent, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &out)) {
        return std::nullopt;
    }
    std::string plain(reinterpret_cast<const char*>(out.pbData), out.cbData);
    SecureZeroMemory(out.pbData, out.cbData);
    LocalFree(out.pbData);
    return plain;
}

inline std::string read_file(const fs::path& p) {
    std::ifstream f(p, std::ios::binary);
    return std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

// Writes via a temp file + replace so a crash never leaves half a config.
inline bool write_file_atomic(const fs::path& p, const std::string& content) {
    fs::path tmp = p;
    tmp += L".tmp";
    {
        std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
        if (!f) return false;
        f << content;
        if (!f) return false;
    }
    return MoveFileExW(tmp.c_str(), p.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
}

inline std::string to_crlf(const std::string& lf) {
    std::string out;
    out.reserve(lf.size() + lf.size() / 20);
    for (char c : lf) {
        if (c == '\n') out += "\r\n";
        else out += c;
    }
    return out;
}

// Creates config.ini from the template if missing. Keys already present in
// the environment (setx DEEPGRAM_API_KEY ...) are imported, encrypted.
inline bool ensure_config(const fs::path& path, const EnvLookup& env, std::string* error) {
    std::error_code ec;
    if (fs::exists(path, ec)) return true;
    fs::create_directories(path.parent_path(), ec);
    std::string text = default_config_text();
    auto import = [&](const char* section, const char* key, const char* env_name) {
        const std::string v = env ? env(env_name) : std::string();
        if (v.empty()) return;
        auto prot = protect(v);
        if (!prot) return;
        if (auto t = ini::rewrite_value(text, section, key,
                                        [&](const std::string&) { return std::optional<std::string>(*prot); })) {
            text = *t;
        }
    };
    import("deepgram", "api_key", "DEEPGRAM_API_KEY");
    import("llm", "api_key", "OPENROUTER_API_KEY");
    import("llm", "cerebras_api_key", "CEREBRAS_API_KEY");
    // UTF-8 BOM + CRLF so Notepad shows the accents and line breaks right.
    if (!write_file_atomic(path, "\xEF\xBB\xBF" + to_crlf(text))) {
        if (error) *error = "could not create config.ini";
        return false;
    }
    return true;
}

// Encrypts any plaintext api_key in place. Returns how many were protected.
inline int protect_plaintext_keys(const fs::path& path) {
    std::string text = read_file(path);
    int count = 0;
    for (const auto& setting : {std::pair{"deepgram", "api_key"},
                                std::pair{"llm", "api_key"},
                                std::pair{"llm", "cerebras_api_key"}}) {
        auto t = ini::rewrite_value(text, setting.first, setting.second,
                                    [&](const std::string& old) -> std::optional<std::string> {
                                        const std::string v = text::trim(old);
                                        if (v.empty() || is_protected_secret(v)) return std::nullopt;
                                        return protect(v);
                                    });
        if (t) {
            text = *t;
            ++count;
        }
    }
    if (count > 0 && !write_file_atomic(path, text)) return 0;
    return count;
}

// Writes values coming from the UI (settings panel). API keys are encrypted
// before they touch the disk; an empty key value clears it. Unknown keys and
// values that can't be one INI line are refused as a whole (nothing written).
struct UiValue {
    std::string section, key, value;
};

inline bool apply_values(const fs::path& path, const std::vector<UiValue>& values, std::string* error) {
    std::string text = read_file(path);
    for (const auto& v : values) {
        if (!is_known_setting(v.section, v.key)) {
            if (error) *error = "unknown key: [" + v.section + "] " + v.key;
            return false;
        }
        std::string raw = text::trim(v.value);
        if (is_secret_setting(v.section, v.key) && !raw.empty() && !is_protected_secret(raw)) {
            auto sealed = protect(raw);
            if (!sealed) {
                if (error) *error = "could not encrypt the key (DPAPI)";
                return false;
            }
            raw = std::move(*sealed);
        }
        auto enc = ini::encode_value(raw);
        if (!enc) {
            if (error) *error = "invalid value for [" + v.section + "] " + v.key;
            return false;
        }
        text = ini::upsert_value(text, ini::lower(v.section), ini::lower(v.key), *enc);
    }
    if (!write_file_atomic(path, text)) {
        if (error) *error = "could not write " + path.string();
        return false;
    }
    return true;
}

inline void open_in_notepad(const fs::path& path) {
    ShellExecuteW(nullptr, L"open", L"notepad.exe", path.c_str(), nullptr, SW_SHOWNORMAL);
}

} // namespace rtai::wincfg
