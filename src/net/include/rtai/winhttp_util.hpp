// Small WinHTTP helpers shared by the WebSocket and the LLM client adapters.
// Windows-only; never included by core.
#pragma once

#include <windows.h>
#include <winhttp.h>

#include <string>
#include <string_view>
#include <utility>

namespace rtai::win {

inline std::wstring widen(std::string_view s) {
    if (s.empty()) return {};
    const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring w(static_cast<std::size_t>(n > 0 ? n : 0), L'\0');
    if (n > 0) MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
    return w;
}

inline std::string narrow(std::wstring_view w) {
    if (w.empty()) return {};
    const int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0,
                                      nullptr, nullptr);
    std::string s(static_cast<std::size_t>(n > 0 ? n : 0), '\0');
    if (n > 0) {
        WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr,
                            nullptr);
    }
    return s;
}

// Readable text for WinHTTP (12xxx) and system error codes.
inline std::string winhttp_error_text(DWORD code) {
    switch (code) {
        case ERROR_WINHTTP_TIMEOUT:                 return "tempo esgotado (12002)";
        case ERROR_WINHTTP_NAME_NOT_RESOLVED:       return "DNS could not resolve the host (12007)";
        case ERROR_WINHTTP_OPERATION_CANCELLED:     return "operation cancelled (12017)";
        case ERROR_WINHTTP_CANNOT_CONNECT:          return "could not connect (12029)";
        case ERROR_WINHTTP_CONNECTION_ERROR:        return "connection reset (12030)";
        case ERROR_WINHTTP_INVALID_SERVER_RESPONSE: return "invalid server response (12152)";
        case ERROR_WINHTTP_SECURE_FAILURE:          return "TLS failure (12175)";
        default: break;
    }
    wchar_t* buf = nullptr;
    DWORD flags = FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_IGNORE_INSERTS |
                  FORMAT_MESSAGE_FROM_SYSTEM;
    HMODULE mod = nullptr;
    if (code >= WINHTTP_ERROR_BASE && code <= WINHTTP_ERROR_BASE + 200) {
        mod = GetModuleHandleW(L"winhttp.dll");
        if (mod) flags |= FORMAT_MESSAGE_FROM_HMODULE;
    }
    const DWORD n = FormatMessageW(flags, mod, code, 0, reinterpret_cast<LPWSTR>(&buf), 0, nullptr);
    std::string msg = (n && buf) ? narrow(std::wstring_view(buf, n)) : std::string("error");
    if (buf) LocalFree(buf);
    while (!msg.empty() && (msg.back() == '\n' || msg.back() == '\r' || msg.back() == ' ' ||
                            msg.back() == '.')) {
        msg.pop_back();
    }
    return msg + " (" + std::to_string(code) + ")";
}

// Move-only owner of an HINTERNET.
class HInternet {
public:
    HInternet() = default;
    explicit HInternet(HINTERNET h) noexcept : h_(h) {}
    ~HInternet() { reset(); }
    HInternet(HInternet&& o) noexcept : h_(std::exchange(o.h_, nullptr)) {}
    HInternet& operator=(HInternet&& o) noexcept {
        if (this != &o) {
            reset();
            h_ = std::exchange(o.h_, nullptr);
        }
        return *this;
    }
    HInternet(const HInternet&) = delete;
    HInternet& operator=(const HInternet&) = delete;

    void reset(HINTERNET h = nullptr) noexcept {
        if (h_) WinHttpCloseHandle(h_);
        h_ = h;
    }
    [[nodiscard]] HINTERNET get() const noexcept { return h_; }
    explicit operator bool() const noexcept { return h_ != nullptr; }

private:
    HINTERNET h_{nullptr};
};

inline DWORD query_status(HINTERNET req) {
    DWORD status = 0;
    DWORD len = sizeof(status);
    if (!WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                             WINHTTP_HEADER_NAME_BY_INDEX, &status, &len, WINHTTP_NO_HEADER_INDEX)) {
        return 0;
    }
    return status;
}

inline std::string query_header(HINTERNET req, const wchar_t* name) {
    DWORD size = 0;
    WinHttpQueryHeaders(req, WINHTTP_QUERY_CUSTOM, name, WINHTTP_NO_OUTPUT_BUFFER, &size,
                        WINHTTP_NO_HEADER_INDEX);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || size == 0) return {};
    std::wstring buf(size / sizeof(wchar_t) + 1, L'\0');
    if (!WinHttpQueryHeaders(req, WINHTTP_QUERY_CUSTOM, name, buf.data(), &size,
                             WINHTTP_NO_HEADER_INDEX)) {
        return {};
    }
    buf.resize(size / sizeof(wchar_t));
    return narrow(buf);
}

// Reads up to max_bytes of a (non-streaming) response body.
inline std::string read_body(HINTERNET req, std::size_t max_bytes) {
    std::string body;
    char buf[4096];
    for (;;) {
        DWORD avail = 0;
        if (!WinHttpQueryDataAvailable(req, &avail) || avail == 0) break;
        DWORD want = avail < sizeof(buf) ? avail : static_cast<DWORD>(sizeof(buf));
        DWORD read = 0;
        if (!WinHttpReadData(req, buf, want, &read) || read == 0) break;
        body.append(buf, read);
        if (body.size() >= max_bytes) break;
    }
    return body;
}

// Enables TLS 1.2 + 1.3 where available (1.3 is rejected on older Windows).
inline void enable_modern_tls(HINTERNET session) {
    DWORD protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2;
#ifdef WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3
    protocols |= WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3;
#endif
    if (!WinHttpSetOption(session, WINHTTP_OPTION_SECURE_PROTOCOLS, &protocols, sizeof(protocols))) {
        protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2;
        WinHttpSetOption(session, WINHTTP_OPTION_SECURE_PROTOCOLS, &protocols, sizeof(protocols));
    }
}

// WinHttpOpen with automatic proxy discovery (Windows 8.1+), falling back to
// the default proxy configuration.
inline HINTERNET open_session(const wchar_t* user_agent) {
    HINTERNET s = WinHttpOpen(user_agent, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                              WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!s) {
        s = WinHttpOpen(user_agent, WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME,
                        WINHTTP_NO_PROXY_BYPASS, 0);
    }
    return s;
}

} // namespace rtai::win
