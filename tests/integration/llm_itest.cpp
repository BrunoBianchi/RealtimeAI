// Integration test: WinHttpLlmClient (real WinHTTP + SSE) against a local
// OpenAI/OpenRouter-compatible server.
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <mutex>
#include <string>
#include <thread>

#include "rtai/winhttp_llm_client.hpp"

using namespace rtai;
using namespace std::chrono_literals;

struct Waiter {
    std::mutex mu; std::condition_variable cv; bool done = false; LlmResult res; std::string text;
    std::chrono::steady_clock::time_point done_at;
    LlmCallbacks cb() {
        LlmCallbacks c;
        c.on_delta = [this](std::string_view d) { std::lock_guard<std::mutex> lk(mu); text.append(d); };
        c.on_done = [this](const LlmResult& r) {
            std::lock_guard<std::mutex> lk(mu); res = r; done = true; done_at = std::chrono::steady_clock::now(); cv.notify_all(); };
        return c;
    }
    bool wait(std::chrono::milliseconds t) { std::unique_lock<std::mutex> lk(mu); return cv.wait_for(lk, t, [&] { return done; }); }
};

LlmRequest req(const std::string& user) {
    LlmRequest r; r.model = "google/gemini-3.1-flash-lite"; r.reasoning_effort = "minimal";
    r.messages = {{"system", "sys"}, {"user", user}}; return r;
}

int main(int argc, char** argv) {
    const int port = argc > 1 ? std::atoi(argv[1]) : 8780;
    int failures = 0;
    auto check = [&](bool ok, const char* what) { std::printf("%s %s\n", ok ? "PASS" : "FAIL", what); if (!ok) ++failures; };
    WinHttpLlmOptions o; o.api_key = "test-key"; o.host = "127.0.0.1"; o.port = static_cast<std::uint16_t>(port); o.secure = false;
    WinHttpLlmClient client{o};

    { Waiter w; client.start(req("Qual o prazo?"), w.cb());
      check(w.wait(5s), "stream completes");
      std::printf("     status=%s ttft=%lldms total=%lldms text=[%s]\n", to_string(w.res.status), (long long)w.res.ttft_ms, (long long)w.res.total_ms, w.text.c_str());
      check(w.res.status == LlmStatus::Completed, "status Completed");
      check(w.text == "- Prazo de **4 semanas**.\nInsight: orçamento aprovado.\nAções: demo", "text reassembled from split SSE chunks (UTF-8 intact)");
      check(w.res.ttft_ms >= 200 && w.res.ttft_ms < 1500, "ttft measured after the processing comment");
      check(w.res.finish_reason == "stop", "finish_reason stop"); }

    { WinHttpLlmOptions bad = o; bad.api_key = "wrong"; WinHttpLlmClient c2{bad}; Waiter w; c2.start(req("x"), w.cb());
      check(w.wait(5s) && w.res.status == LlmStatus::Failed && w.res.http_status == 401, "401 reported as Failed");
      std::printf("     error=[%s]\n", w.res.error.c_str()); }

    { Waiter w; client.start(req("ERRO_MEIO"), w.cb());
      check(w.wait(5s) && w.res.status == LlmStatus::Failed, "mid-stream error -> Failed");
      std::printf("     error=[%s] partial=[%s]\n", w.res.error.c_str(), w.text.c_str()); }

    { Waiter w; auto call = client.start(req("LENTO"), w.cb());
      std::this_thread::sleep_for(700ms);
      const auto t_cancel = std::chrono::steady_clock::now();
      call->cancel();
      check(w.wait(3s) && w.res.status == LlmStatus::Cancelled, "cancel -> Cancelled");
      const auto lag = std::chrono::duration_cast<std::chrono::milliseconds>(w.done_at - t_cancel).count();
      std::printf("     on_done %lld ms after cancel(), partial=[%zu bytes]\n", (long long)lag, w.text.size());
      check(lag < 500, "cancellation observed within one chunk interval"); }

    { std::mutex mu; std::condition_variable cv; bool got = false, ok = false; std::string msg;
      client.warm_up([&](bool k, std::string m) { std::lock_guard<std::mutex> lk(mu); ok = k; msg = m; got = true; cv.notify_all(); });
      std::unique_lock<std::mutex> lk(mu); cv.wait_for(lk, 5s, [&] { return got; });
      check(got && ok, "warm_up validates the key"); std::printf("     warm_up=[%s]\n", msg.c_str()); }

    client.shutdown(2000ms);
    std::printf("RESULT failures=%d\n", failures);
    return failures;
}
