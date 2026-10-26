// Pure core: ILlmClient fake that streams a scripted answer token by token.
// Used by the --demo mode (no network) and by the copilot engine tests.
#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "rtai/llm.hpp"

namespace rtai {

class ScriptedLlmClient final : public ILlmClient {
public:
    struct Options {
        std::string reply{
            "- Nosso prazo típico de implantação é de **4 a 6 semanas**, com piloto na 2ª semana.\n"
            "- O valor depende do volume de usuários; posso mandar uma proposta hoje.\n"
            "Insight: a pergunta junta prazo e custo, sinal de que já existe orçamento em análise.\n"
            "Ações: confirmar número de usuários; agendar demo técnica"};
        std::chrono::milliseconds first_token_delay{350};
        std::chrono::milliseconds token_delay{25};
        bool fail{false};
        std::string fail_message{"falha simulada"};
        // Optional: pick the reply per request (demo answers chat/recap/...).
        std::function<std::string(const LlmRequest&)> reply_for;
    };

    ScriptedLlmClient() : ScriptedLlmClient(Options{}) {}
    explicit ScriptedLlmClient(Options opts) : opts_(std::move(opts)), shared_(std::make_shared<Shared>()) {}
    ~ScriptedLlmClient() override { shutdown(std::chrono::milliseconds(2000)); }

    std::shared_ptr<ILlmCall> start(LlmRequest request, LlmCallbacks cb) override {
        auto call = std::make_shared<Call>();
        {
            std::lock_guard<std::mutex> lk(shared_->mu);
            if (shared_->shutting_down) {
                LlmResult r;
                r.status = LlmStatus::Cancelled;
                if (cb.on_done) cb.on_done(r);
                call->done = true;
                return call;
            }
            ++shared_->active;
            ++started_;
            last_request_ = request;
            std::erase_if(shared_->calls, [](const std::weak_ptr<Call>& w) { return w.expired(); });
            shared_->calls.push_back(call);
        }
        auto shared = shared_;
        auto opts = opts_;
        if (opts.reply_for) {
            std::string r = opts.reply_for(request);
            if (!r.empty()) opts.reply = std::move(r);
        }
        std::thread([call, shared, opts, cb = std::move(cb)] {
            const auto t0 = std::chrono::steady_clock::now();
            LlmResult res;
            auto elapsed = [&] {
                return std::chrono::duration_cast<std::chrono::milliseconds>(
                           std::chrono::steady_clock::now() - t0).count();
            };
            if (!call->sleep(opts.first_token_delay)) {
                res.status = LlmStatus::Cancelled;
            } else if (opts.fail) {
                res.status = LlmStatus::Failed;
                res.error = opts.fail_message;
            } else {
                // Stream word by word (keeping the separators).
                std::size_t i = 0;
                const std::string& s = opts.reply;
                while (i < s.size()) {
                    std::size_t j = s.find_first_of(" \n", i);
                    j = (j == std::string::npos) ? s.size() : j + 1;
                    if (call->cancelled.load()) { res.status = LlmStatus::Cancelled; break; }
                    if (res.ttft_ms < 0) res.ttft_ms = elapsed();
                    if (cb.on_delta) cb.on_delta(std::string_view(s).substr(i, j - i));
                    i = j;
                    if (i < s.size() && !call->sleep(opts.token_delay)) {
                        res.status = LlmStatus::Cancelled;
                        break;
                    }
                }
                if (res.status == LlmStatus::Completed) res.finish_reason = "stop";
            }
            res.total_ms = elapsed();
            if (cb.on_done) cb.on_done(res);
            call->done = true;
            {
                std::lock_guard<std::mutex> lk(shared->mu);
                --shared->active;
            }
            shared->cv.notify_all();
        }).detach();
        return call;
    }

    void shutdown(std::chrono::milliseconds wait) override {
        std::vector<std::shared_ptr<Call>> live;
        {
            std::lock_guard<std::mutex> lk(shared_->mu);
            shared_->shutting_down = true;
            for (auto& w : shared_->calls) {
                if (auto c = w.lock()) live.push_back(std::move(c));
            }
            shared_->calls.clear();
        }
        for (auto& c : live) c->cancel();
        std::unique_lock<std::mutex> lk(shared_->mu);
        shared_->cv.wait_for(lk, wait, [&] { return shared_->active == 0; });
    }

    [[nodiscard]] std::string name() const override { return "demo (roteiro local)"; }

    int started() const {
        std::lock_guard<std::mutex> lk(shared_->mu);
        return started_;
    }
    LlmRequest last_request() const {
        std::lock_guard<std::mutex> lk(shared_->mu);
        return last_request_;
    }

private:
    struct Call final : ILlmCall {
        std::atomic<bool> cancelled{false};
        std::atomic<bool> done{false};
        std::mutex mu;
        std::condition_variable cv;

        void cancel() override {
            {
                std::lock_guard<std::mutex> lk(mu);
                cancelled.store(true);
            }
            cv.notify_all();
        }
        [[nodiscard]] bool finished() const override { return done.load(); }

        // Interruptible sleep; false if cancelled.
        bool sleep(std::chrono::milliseconds d) {
            std::unique_lock<std::mutex> lk(mu);
            return !cv.wait_for(lk, d, [&] { return cancelled.load(); });
        }
    };

    struct Shared {
        mutable std::mutex mu;
        std::condition_variable cv;
        int active{0};
        bool shutting_down{false};
        std::vector<std::weak_ptr<Call>> calls;
    };

    Options opts_;
    std::shared_ptr<Shared> shared_;
    int started_{0};          // guarded by shared_->mu
    LlmRequest last_request_; // guarded by shared_->mu
};

} // namespace rtai
