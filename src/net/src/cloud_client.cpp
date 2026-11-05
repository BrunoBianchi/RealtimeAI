#include "rtai/cloud_client.hpp"

#include <windows.h>
#include <winhttp.h>

#include <ctime>
#include <utility>

#include "rtai/url.hpp"
#include "rtai/version.hpp"
#include "rtai/winhttp_util.hpp"

namespace rtai {

struct CloudClient::Http {
    win::HInternet session;
    win::HInternet connection;
    bool secure{true};
    std::string prefix; // path part of the base URL ("" or "/api")
    bool ok{false};
};

namespace {

std::int64_t unix_now_s() { return static_cast<std::int64_t>(std::time(nullptr)); }

// pt-BR reason for the UI; the server's own message wins when it sent one.
std::string status_text(DWORD status) {
    switch (status) {
        case 401: return "session expired: sign in to your account again";
        case 402: return "plan limit reached: upgrade to PRO to continue";
        case 403: return "this account has no access to this feature";
        case 426: return "app version too old: please update";
        case 429: return "too many requests: try again in a moment";
        default:  return status >= 500 ? "server unavailable right now" : "the server refused the session";
    }
}

bool post_json(HINTERNET connection, bool secure, const std::wstring& path,
               const std::string& token, const std::string& body, DWORD& status, std::string& response,
               std::string& error) {
    HINTERNET req = WinHttpOpenRequest(connection, L"POST", path.c_str(), nullptr, WINHTTP_NO_REFERER,
                                       WINHTTP_DEFAULT_ACCEPT_TYPES, secure ? WINHTTP_FLAG_SECURE : 0);
    if (!req) {
        error = win::winhttp_error_text(GetLastError());
        return false;
    }
    win::HInternet owner(req);
    std::wstring headers = L"Content-Type: application/json\r\nAccept: application/json\r\n";
    headers += L"Authorization: Bearer " + win::widen(token) + L"\r\n";
    headers += L"X-RTAI-Version: " RTAI_VERSION_WSTRING L"\r\n";
    if (!WinHttpSendRequest(req, headers.c_str(), static_cast<DWORD>(-1L),
                            const_cast<char*>(body.data()), static_cast<DWORD>(body.size()),
                            static_cast<DWORD>(body.size()), 0) ||
        !WinHttpReceiveResponse(req, nullptr)) {
        error = win::winhttp_error_text(GetLastError());
        return false;
    }
    status = win::query_status(req);
    response = win::read_body(req, 64 * 1024);
    return true;
}

} // namespace

CloudClient::CloudClient(CloudClientOptions opts) : opts_(std::move(opts)), http_(std::make_shared<Http>()) {
    const ParsedUrl u = parse_url(opts_.base_url);
    if (!u.ok) return;
    HINTERNET s = win::open_session(L"lipcue.com/" RTAI_VERSION_WSTRING L" (WinHTTP)");
    if (!s) return;
    win::enable_modern_tls(s);
    win::enable_low_latency(s);
    WinHttpSetTimeouts(s, opts_.timeout_ms, opts_.timeout_ms, opts_.timeout_ms, opts_.timeout_ms);
    http_->session = win::HInternet(s);
    HINTERNET c = WinHttpConnect(s, win::widen(u.host).c_str(), u.port, 0);
    if (!c) return;
    http_->connection = win::HInternet(c);
    http_->secure = u.secure;
    http_->prefix = u.path == "/" ? std::string() : u.path;
    while (!http_->prefix.empty() && http_->prefix.back() == '/') http_->prefix.pop_back();
    http_->ok = true;
}

CloudClient::~CloudClient() { stop(); }

std::optional<cloud::Session> CloudClient::fetch(std::string& error, int* http_status) {
    std::lock_guard<std::mutex> lk(fetch_mu_);
    return fetch_locked_out(error, http_status);
}

std::optional<cloud::Session> CloudClient::fetch_locked_out(std::string& error, int* http_status) {
    if (http_status) *http_status = 0;
    if (!http_->ok) {
        error = "invalid server address: " + opts_.base_url;
        return std::nullopt;
    }
    DWORD status = 0;
    std::string body;
    const std::wstring path = win::widen(http_->prefix + "/v1/session");
    if (!post_json(http_->connection.get(), http_->secure, path, opts_.token,
                   cloud::build_session_request(opts_.request), status, body, error)) {
        error = "no connection to the server (" + error + ")";
        return std::nullopt;
    }
    if (http_status) *http_status = static_cast<int>(status);
    std::string parse_error;
    auto s = cloud::parse_session(body, parse_error, opts_.request.credentials);
    if (status != 200) {
        // Prefer the server's own explanation ({"error": "..."}) when present.
        error = !parse_error.empty() && parse_error != "invalid server response" ? parse_error
                                                                                      : status_text(status);
        return std::nullopt;
    }
    if (!s) {
        error = parse_error;
        return std::nullopt;
    }
    {
        std::lock_guard<std::mutex> lk(mu_);
        session_ = *s;
    }
    return s;
}

void CloudClient::start_refresh() {
    std::lock_guard<std::mutex> lk(mu_);
    if (refresher_.joinable() || stop_) return;
    refresher_ = std::thread([this] { refresh_main(); });
}

void CloudClient::refresh_main() {
    int failures = 0;
    for (;;) {
        int delay_s = 60;
        {
            std::unique_lock<std::mutex> lk(mu_);
            if (session_) delay_s = cloud::refresh_delay_s(*session_, unix_now_s());
            if (failures > 0) delay_s = failures < 4 ? 5 << failures : 60; // 10, 20, 40, 60 s
            if (cv_.wait_for(lk, std::chrono::seconds(delay_s), [this] { return stop_; })) return;
        }
        std::string error;
        std::lock_guard<std::mutex> f(fetch_mu_);
        failures = fetch_locked_out(error, nullptr) ? 0 : failures + 1;
    }
}

std::optional<cloud::Session> CloudClient::current() const {
    std::lock_guard<std::mutex> lk(mu_);
    return session_;
}

std::string CloudClient::stt_authorization(bool force_refresh) {
    if (force_refresh) {
        std::string error;
        std::lock_guard<std::mutex> f(fetch_mu_);
        fetch_locked_out(error, nullptr);
    }
    std::lock_guard<std::mutex> lk(mu_);
    if (!session_ || session_->stt.token.empty()) return {};
    return "Bearer " + session_->stt.token;
}

void CloudClient::end_session(const cloud::SessionEnd& e, std::chrono::milliseconds wait) {
    std::string id;
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (!session_ || session_->session_id.empty()) return;
        id = session_->session_id;
    }
    if (!http_->ok) return;
    // A detached worker shares the HTTP handles (kept alive by the shared_ptr
    // even if this client goes away first); shutdown waits at most `wait`.
    struct Shared {
        std::mutex mu;
        std::condition_variable cv;
        bool done{false};
    };
    auto shared = std::make_shared<Shared>();
    std::thread([shared, http = http_, path = win::widen(http_->prefix + "/v1/session/" + id + "/end"),
                 token = opts_.token, body = cloud::build_session_end(e)] {
        DWORD status = 0;
        std::string response, error;
        post_json(http->connection.get(), http->secure, path, token, body, status, response, error);
        std::lock_guard<std::mutex> lk(shared->mu);
        shared->done = true;
        shared->cv.notify_all();
    }).detach();
    std::unique_lock<std::mutex> lk(shared->mu);
    shared->cv.wait_for(lk, wait, [&] { return shared->done; });
}

void CloudClient::stop() {
    {
        std::lock_guard<std::mutex> lk(mu_);
        stop_ = true;
    }
    cv_.notify_all();
    if (refresher_.joinable()) refresher_.join();
}

} // namespace rtai
