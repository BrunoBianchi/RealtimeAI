// Pure core: scripted two-sided sales call for --demo (no audio, no network).
// It plays transcript events word by word (interims, then a Finalize-final)
// for both lanes, and reports who is "speaking" so the UI meters move. The
// replies for the scripted LLM live here too, so the whole demo is one place.
#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "rtai/interfaces.hpp"
#include "rtai/llm.hpp"

namespace rtai {

struct DemoLine {
    AudioSource source;
    std::string text;
    int pause_before_ms; // silence before this line starts
};

inline std::vector<DemoLine> default_demo_script() {
    using S = AudioSource;
    return {
        {S::Loopback, "Oi, tudo bem? Vi a proposta que vocês mandaram ontem.", 1200},
        {S::Microphone, "Tudo ótimo. Que bom, ficou alguma dúvida sobre o escopo?", 900},
        {S::Loopback, "O escopo está claro. Mas o preço de vocês está bem acima da alternativa que estamos avaliando.", 900},
        {S::Loopback, "Por que eu pagaria trinta por cento a mais?", 500},
        {S::Microphone, "Boa pergunta. Deixa eu te mostrar onde está a diferença.", 9000},
        {S::Loopback, "E qual é o prazo de implantação se a gente fechar este mês?", 2500},
    };
}

// Reply of the scripted LLM in demo mode, picked from the request content.
inline std::string demo_reply_for(const LlmRequest& req) {
    if (req.messages.empty()) return {};
    const ChatMessage& last = req.messages.back();
    const std::string& u = last.content;
    auto has = [&](std::string_view s) { return u.find(s) != std::string::npos; };
    if (!last.images.empty()) {
        return "- A tela mostra a **tabela de preços** com o plano Pro em destaque.\n"
               "- Compare com o custo de manter a alternativa: horas de suporte e retrabalho.\n"
               "Sugestão: abra a aba de ROI e mostre o payback em 5 meses.";
    }
    if (has("Pedido: resumo")) {
        return "- Cliente leu a proposta e entendeu o escopo.\n"
               "- Objeção principal: preço **30% acima** da alternativa.\n"
               "- Pergunta aberta sobre prazo de implantação para fechar este mês.\n"
               "Pendências: enviar comparativo de custo total; confirmar data de início.";
    }
    if (has("Pedido: perguntas de follow-up")) {
        return "- O que pesa mais na decisão hoje: preço inicial ou custo total em 12 meses?\n"
               "- Quem mais participa da aprovação além de você?\n"
               "- Se resolvermos o prazo, o que impediria fechar ainda este mês?";
    }
    if (has("Minha pergunta: ")) {
        const auto p = u.rfind("Minha pergunta: ");
        const std::string q = u.substr(p + 16);
        return "Sobre \"" + q + "\":\n"
               "- No roteiro do demo, o cliente citou preço **30% acima** da alternativa.\n"
               "- Ele também quer saber o prazo para fechar este mês.\n"
               "(Resposta de demonstração: com a chave do OpenRouter a resposta vem do modelo.)";
    }
    if (has("prazo")) {
        return "**Situação:** Implantação padrão em 4 a 6 semanas, com piloto já na 2ª semana.\n"
               "**Tarefa:** Fechar este mês sem atrasar o início.\n"
               "**Ação:** Proponho o kickoff para a próxima segunda e confirmo agora quem participa.\n"
               "**Resultado:** O cliente sai da conversa com data e responsáveis definidos.";
    }
    if (has("pagaria") || has("preço") || has("preco")) {
        return "**Situação:** Faz sentido comparar: o valor inicial é 30% maior que a alternativa.\n"
               "**Tarefa:** Mostrar o custo total, não só o preço de entrada.\n"
               "**Ação:** Comparo as horas de suporte e a licença extra de integração que a alternativa exige, "
               "e pergunto o que pesa mais: preço agora ou resultado em 12 meses.\n"
               "**Resultado:** Ofereço o comparativo de ROI por escrito ainda hoje.";
    }
    return {};
}

class DemoConversation {
public:
    using Emit = std::function<void(const TranscriptEvent&)>;
    using Speaking = std::function<void(AudioSource, bool speaking)>;

    struct Options {
        std::vector<DemoLine> script = default_demo_script();
        std::chrono::milliseconds word_interval{170};
        std::chrono::milliseconds start_delay{600};
    };

    DemoConversation() : DemoConversation(Options{}) {}
    explicit DemoConversation(Options o) : opts_(std::move(o)) {}
    ~DemoConversation() { stop(); }

    DemoConversation(const DemoConversation&) = delete;
    DemoConversation& operator=(const DemoConversation&) = delete;

    void start(Emit emit, Speaking speaking) {
        emit_ = std::move(emit);
        speaking_ = std::move(speaking);
        thread_ = std::thread([this] { run(); });
    }

    void stop() {
        {
            std::lock_guard<std::mutex> lk(mu_);
            stop_ = true;
        }
        cv_.notify_all();
        if (thread_.joinable()) thread_.join();
    }

    [[nodiscard]] bool finished() const noexcept { return finished_.load(); }

private:
    bool sleep_for(std::chrono::milliseconds d) {
        std::unique_lock<std::mutex> lk(mu_);
        return !cv_.wait_for(lk, d, [&] { return stop_; });
    }

    void run() {
        if (!sleep_for(opts_.start_delay)) return;
        for (const auto& line : opts_.script) {
            if (!sleep_for(std::chrono::milliseconds(line.pause_before_ms))) return;
            if (speaking_) speaking_(line.source, true);
            std::string partial;
            std::size_t pos = 0;
            while (pos < line.text.size()) {
                std::size_t sp = line.text.find(' ', pos);
                if (sp == std::string::npos) sp = line.text.size();
                partial = line.text.substr(0, sp);
                pos = sp + 1;
                if (pos < line.text.size()) {
                    TranscriptEvent ev{line.source, partial, false, 0};
                    if (emit_) emit_(ev);
                }
                if (!sleep_for(opts_.word_interval)) return;
            }
            if (speaking_) speaking_(line.source, false);
            TranscriptEvent fin{line.source, line.text, true, 0};
            fin.from_finalize = true;
            if (emit_) emit_(fin);
        }
        finished_ = true;
    }

    Options opts_;
    Emit emit_;
    Speaking speaking_;
    std::mutex mu_;
    std::condition_variable cv_;
    bool stop_{false};
    std::atomic<bool> finished_{false};
    std::thread thread_;
};

} // namespace rtai
