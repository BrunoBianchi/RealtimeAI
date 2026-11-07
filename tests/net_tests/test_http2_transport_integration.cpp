// Integration tests for the Dual-Path Hot_Path direct HTTP/2 transport
// (src/net/src/winhttp_llm_client.cpp, src/net/include/rtai/winhttp_llm_client.hpp).
// Task 10.2 — "Testes de integração do transporte HTTP/2 direto".
//
// WHAT THIS FILE COVERS (the automatable subset)
// ------------------------------------------------------------------
// Two of the task's four requirements are pure/static and run EVERYWHERE, with
// no network, no credentials and no Win32 message pump:
//
//   * Req 4.1 / 4.3 — critical-endpoint static guard. The default
//     WinHttpLlmOptions resolve the two critical generation endpoints to the
//     direct providers Cerebras (api.cerebras.ai) and Groq (api.groq.com), and
//     NEITHER critical host ever contains "openrouter": OpenRouter is kept off
//     the critical path. This is asserted against both the as-constructed
//     defaults and the endpoints that choose_endpoint() hands the worker, so a
//     regression that points a critical endpoint back at the proxy fails the
//     build's test run deterministically.
//
// The remaining two requirements need a live network to observe:
//
//   * Req 4.4 — HTTP/2 is the negotiated wire protocol, read from WinHTTP itself
//     (WINHTTP_OPTION_HTTP_PROTOCOL_USED, reported in LlmResult::http2), and
//   * Req 4.6 — re-issuing, also after cancelling a stream, reuses the warm
//     connection. A new handshake needs a new TCP connection, so the tests
//     compare this process's established connections to port 443 before and
//     after.
//
// They only run when asked to, so net_tests stays green offline:
//   RTAI_NET_LIVE     — "1"/"true" enables them. No credentials are needed: the
//                       server's 401 also comes over the negotiated connection.
//   RTAI_LLM_API_KEY  — OpenRouter key (spends a few tokens). Without one, the
//                       test that cancels in the middle of a stream skips,
//                       because a 401 has no stream to cancel.
//   RTAI_NET_MODEL    — model for that test (default qwen/qwen3.6-flash).
//
// The RST_STREAM frame itself can only be seen on the wire: see
// tests/net_tests/MANUAL_CHECKLIST.md.

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <iphlpapi.h>

#include <gtest/gtest.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "rtai/winhttp_llm_client.hpp"

using namespace rtai;

namespace {

// Lower-cased copy, so a host containing "OpenRouter" in any casing is still
// caught by the substring guard below.
std::string to_lower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return s;
}

// True iff `host` mentions the OpenRouter proxy in any casing. The critical
// generation path (Req 4.3) must never resolve to it.
bool mentions_openrouter(const std::string& host) {
    return to_lower(host).find("openrouter") != std::string::npos;
}

// Read an environment variable as an owned string ("" when unset). _dupenv_s is
// the MSVC-safe getenv; it is what the rest of the Win32 code uses.
std::string env_or_empty(const char* name) {
    std::string value;
#if defined(_MSC_VER)
    char* buf = nullptr;
    size_t len = 0;
    if (_dupenv_s(&buf, &len, name) == 0 && buf != nullptr) {
        value.assign(buf);
        std::free(buf);
    }
#else
    if (const char* raw = std::getenv(name)) value.assign(raw);
#endif
    return value;
}

bool env_truthy(const char* name) {
    const std::string v = to_lower(env_or_empty(name));
    return v == "1" || v == "true" || v == "yes" || v == "on";
}

bool live_net_enabled() { return env_truthy("RTAI_NET_LIVE"); }

// The local ports of this process's established connections to port 443. A new
// handshake would show up as a new port.
template <typename Table, typename Row>
void collect_https_ports(ULONG family, std::set<unsigned>& ports) {
    DWORD size = 0;
    GetExtendedTcpTable(nullptr, &size, FALSE, family, TCP_TABLE_OWNER_PID_CONNECTIONS, 0);
    std::vector<char> buf(size + 4096);
    size = static_cast<DWORD>(buf.size());
    if (GetExtendedTcpTable(buf.data(), &size, FALSE, family, TCP_TABLE_OWNER_PID_CONNECTIONS, 0) != NO_ERROR) return;
    const auto* table = reinterpret_cast<const Table*>(buf.data());
    const Row* rows = table->table;
    for (DWORD i = 0; i < table->dwNumEntries; ++i) {
        const Row& r = rows[i];
        const bool established = static_cast<DWORD>(r.dwState) == MIB_TCP_STATE_ESTAB;
        if (r.dwOwningPid == GetCurrentProcessId() && established && ntohs(static_cast<u_short>(r.dwRemotePort)) == 443) {
            ports.insert(ntohs(static_cast<u_short>(r.dwLocalPort)));
        }
    }
}

std::set<unsigned> https_connections() {
    std::set<unsigned> ports;
    collect_https_ports<MIB_TCPTABLE_OWNER_PID, MIB_TCPROW_OWNER_PID>(AF_INET, ports);
    collect_https_ports<MIB_TCP6TABLE_OWNER_PID, MIB_TCP6ROW_OWNER_PID>(AF_INET6, ports);
    return ports;
}

// One client on the same path as a live answer, without the keep-alive thread,
// so every connection in the process comes from the requests under test.
WinHttpLlmOptions live_options(const std::string& key) {
    WinHttpLlmOptions o;
    o.api_key = key;
    o.primary.host.clear();
    o.fallback.host.clear();
    o.keep_alive = false;
    return o;
}

LlmRequest live_request() {
    LlmRequest r;
    r.model = env_or_empty("RTAI_NET_MODEL");
    if (r.model.empty()) r.model = "qwen/qwen3.6-flash";
    r.messages.push_back({"user", "Say hello in one short sentence."});
    return r;
}

struct LiveCall {
    LlmResult result;
    bool finished{false};
    bool saw_text{false};
};

// Runs one call to the end. With cancel_on_first_text, cancels when the first
// text arrives, so the cancel lands in the middle of a real stream.
LiveCall run_call(WinHttpLlmClient& client, bool cancel_on_first_text = false) {
    struct State {
        std::mutex mu;
        std::condition_variable cv;
        LiveCall call;
    };
    auto state = std::make_shared<State>();
    LlmCallbacks cb;
    cb.on_delta = [state](std::string_view) {
        std::lock_guard<std::mutex> lk(state->mu);
        state->call.saw_text = true;
        state->cv.notify_all();
    };
    cb.on_done = [state](const LlmResult& r) {
        std::lock_guard<std::mutex> lk(state->mu);
        state->call.result = r;
        state->call.finished = true;
        state->cv.notify_all();
    };
    auto call = client.start(live_request(), std::move(cb));

    std::unique_lock<std::mutex> lk(state->mu);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
    if (cancel_on_first_text) {
        state->cv.wait_until(lk, deadline, [&] { return state->call.saw_text || state->call.finished; });
        call->cancel();
    }
    state->cv.wait_until(lk, deadline, [&] { return state->call.finished; });
    return state->call;
}

} // namespace

// ===========================================================================
// Req 4.1 / 4.3 — critical-endpoint static guard (pure, runs everywhere).
// ===========================================================================

// The default options resolve the two critical generation endpoints to the
// direct providers: primary = Cerebras (api.cerebras.ai, llama-3.3-70b),
// fallback = Groq (api.groq.com, llama-3.3-70b-versatile). These are the exact
// hosts/models Req 4.1 names, asserted on the as-constructed defaults so a
// regression in the header's defaults is caught here.
//
// **Validates: Requirements 4.1**
TEST(Http2TransportStaticGuard, DefaultCriticalEndpointsAreCerebrasAndGroq) {
    const WinHttpLlmOptions o; // defaults from winhttp_llm_client.hpp

    EXPECT_EQ(o.primary.host, "api.cerebras.ai");
    EXPECT_EQ(o.primary.model, "qwen-3.8-27b");

    EXPECT_EQ(o.fallback.host, "api.groq.com");
    EXPECT_EQ(o.fallback.model, "llama-3.3-70b-versatile");
}

// Neither critical endpoint host mentions the OpenRouter proxy: OpenRouter is
// excluded from the critical generation path (Req 4.3). Checked for both the
// defaults and the endpoints the worker actually selects via choose_endpoint()
// (attempt 0 = primary, attempt >= 1 = fallback), since those are the hosts a
// generation request is dialed against.
//
// **Validates: Requirements 4.3**
TEST(Http2TransportStaticGuard, CriticalEndpointsNeverResolveToOpenRouter) {
    const WinHttpLlmOptions o;

    EXPECT_FALSE(mentions_openrouter(o.primary.host))
        << "primary host must not be the OpenRouter proxy: " << o.primary.host;
    EXPECT_FALSE(mentions_openrouter(o.fallback.host))
        << "fallback host must not be the OpenRouter proxy: " << o.fallback.host;

    // The worker dials choose_endpoint(attempt): attempt 0 -> primary, any
    // later attempt -> fallback. Confirm every selected critical host stays off
    // the proxy, across the boundary and well beyond it.
    for (int attempt : {0, 1, 2, 7, 99, 1000}) {
        const LlmEndpoint& ep = choose_endpoint(attempt, o);
        EXPECT_FALSE(mentions_openrouter(ep.host))
            << "choose_endpoint(" << attempt << ") resolved to OpenRouter: " << ep.host;
    }

    // And positively: attempt 0 is Cerebras, attempt >= 1 is Groq — the two
    // direct providers, never the proxy.
    EXPECT_EQ(choose_endpoint(0, o).host, "api.cerebras.ai");
    EXPECT_EQ(choose_endpoint(1, o).host, "api.groq.com");
}

// ===========================================================================
// Req 4.4 / 4.6 — live network behaviour, opt-in with RTAI_NET_LIVE=1.
// ===========================================================================

// Req 4.4: the response really comes over HTTP/2, as reported by WinHTTP.
//
// **Validates: Requirements 4.4**
TEST(Http2TransportLive, GenerationNegotiatesHttp2) {
    if (!live_net_enabled()) GTEST_SKIP() << "set RTAI_NET_LIVE=1 to run";
    const std::string key = env_or_empty("RTAI_LLM_API_KEY");

    WinHttpLlmClient client(live_options(key.empty() ? "no-key-this-test-expects-401" : key));
    const LiveCall call = run_call(client);

    ASSERT_TRUE(call.finished) << "no answer in 30 s";
    ASSERT_NE(call.result.http_status, 0) << "no HTTP response: " << call.result.error;
    EXPECT_TRUE(call.result.http2) << "HTTP status " << call.result.http_status << " did not come over HTTP/2";
    EXPECT_EQ(call.result.http_status, key.empty() ? 401 : 200);
}

// Req 4.6, without credentials: a second request uses the same connection.
//
// **Validates: Requirements 4.6**
TEST(Http2TransportLive, SecondRequestReusesConnection) {
    if (!live_net_enabled()) GTEST_SKIP() << "set RTAI_NET_LIVE=1 to run";

    WinHttpLlmClient client(live_options("no-key-this-test-expects-401"));
    const LiveCall first = run_call(client);
    ASSERT_TRUE(first.finished);
    ASSERT_EQ(first.result.http_status, 401) << first.result.error;
    const std::set<unsigned> before = https_connections();
    ASSERT_FALSE(before.empty()) << "the first request left no open connection to reuse";

    const LiveCall second = run_call(client);
    ASSERT_TRUE(second.finished);
    EXPECT_EQ(second.result.http_status, 401) << second.result.error;
    EXPECT_EQ(https_connections(), before) << "the second request opened a new connection";
}

// Req 4.6: cancelling in the middle of a stream closes only that stream, so the
// next request finds the connection open. The RST_STREAM frame itself is only
// visible on the wire (MANUAL_CHECKLIST.md M2).
//
// **Validates: Requirements 4.6**
TEST(Http2TransportLive, CancelAndReissueReusesConnection) {
    if (!live_net_enabled()) GTEST_SKIP() << "set RTAI_NET_LIVE=1 to run";
    const std::string key = env_or_empty("RTAI_LLM_API_KEY");
    if (key.empty()) {
        GTEST_SKIP() << "needs RTAI_LLM_API_KEY: without a key the server answers 401 "
                        "and there is no stream to cancel";
    }

    WinHttpLlmClient client(live_options(key));
    const LiveCall cancelled = run_call(client, /*cancel_on_first_text=*/true);
    ASSERT_TRUE(cancelled.finished);
    ASSERT_TRUE(cancelled.saw_text) << "no text to cancel on: " << cancelled.result.error;
    EXPECT_EQ(cancelled.result.status, LlmStatus::Cancelled);
    EXPECT_TRUE(cancelled.result.http2);
    const std::set<unsigned> before = https_connections();
    ASSERT_FALSE(before.empty()) << "cancelling closed the connection";

    const LiveCall next = run_call(client, /*cancel_on_first_text=*/true);
    ASSERT_TRUE(next.finished);
    EXPECT_TRUE(next.saw_text) << next.result.error;
    EXPECT_EQ(https_connections(), before) << "the request after a cancel opened a new connection";
}
