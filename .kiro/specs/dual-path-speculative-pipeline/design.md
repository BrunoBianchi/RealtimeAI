# Design Document

## Overview

Esta feature acopla um pipeline **Dual-Path** (dois caminhos) ao copiloto de entrevista existente (C++20 / Win32 / Direct2D / DirectWrite / WASAPI / Deepgram). O objetivo é reduzir a latência percebida de ponta a ponta para abaixo de 200 ms no caminho ao vivo e, ao encerrar, montar um painel pós-entrevista (Jev Dashboard) em até ~300 ms.

O design **estende** componentes já existentes em vez de recriá-los:

- `TurnAssembler` já expõe `poll_speculative()`, `SpeculativeCandidate` e lanes com `speculative_fired`/`last_speculative_text` — o Hot_Path reaproveita esse mecanismo e adiciona um gatilho acústico local independente da rede.
- `CopilotEngine::Impl` já tem `speculative_match(...)`, a estrutura `Shadow`, o padrão `generation_id_` (via `Shadow::id`/`next_id`) e os inputs `InMicRms`/`InLlmDone`/`InPtt`/`InPause`. A máquina de estados **Shadow Streaming** (Speculating → Committed → Aborted) formaliza o que hoje é `shadow`/`promote_shadow`/`cancel_shadow`.
- `WinHttpLlmClient` já parametriza host/path (OpenAI-compatible), já habilita HTTP/2 (`WINHTTP_OPTION_ENABLE_HTTP_PROTOCOL = WINHTTP_PROTOCOL_FLAG_HTTP2`) e TLS 1.2/1.3, e já usa `openrouter_protocol.hpp` (JSON padrão OpenAI) + `sse_parser.hpp`. "Transporte direto" = host/modelo padrão + failover + keep-alive, **não** nova pilha de transporte.
- `OverlayWindow` já usa `WakeQueue` + `PostMessageW` + um único timer de animação de 16 ms (`kTimerAnim`/`anim_tick()`), e já tem `ID2D1PathGeometry`/`ID2D1GeometrySink` disponíveis. O `OverlayMode` é **net-new** (o header hoje só expõe `mode_label`).
- O orquestrador do `CopilotEngine` já acorda por `std::condition_variable::wait_until` (não por `sleep_for(50ms)` fixo); o Req 5 é satisfeito consolidando essa espera e adicionando o empurrão imediato do primeiro token à UI.

Provedores (config atual): **Primário = Cerebras** (`api.cerebras.ai`, `llama-3.3-70b`); **Fallback = Groq** (`api.groq.com`, `llama-3.3-70b-versatile`). OpenRouter sai do caminho crítico.

Todo o produto e a UI são em pt-BR. Exemplos de código usam C++20, a linguagem real do projeto.

## Architecture

### Fluxo Dual-Path

```
                         CAPTURA (thread WASAPI)
   mic/loopback PCM ──► WasapiCaptureSource::deliver()
                             │ (já converte p/ int16/float)
                             ▼
                       FrameVad (NET-NEW, por lane)
             RMS 20ms int16 · Noise_Floor rolante · streak 110ms
                             │ gate: DecisionPolicy fast-filter (>5 palavras + pergunta)
                             │ enqueue lock-free + notify  (não bloqueia a captura)
   ┌─────────────────────────┼──────────────────────────────────────────────┐
   │                HOT_PATH  ▼                                               │
   │   CopilotEngine (thread orquestradora única, sem locks internos)         │
   │     InMicRms/InVadSpeculate/InTranscript/InLlmDone  ──► inbox (cv)        │
   │                                                                          │
   │   Shadow Streaming:  Speculating ──► Committed ──► (append visível)       │
   │                           └────────► Aborted (gen++ , RST_STREAM)         │
   │     shadow_buffer_ (oculto)   generation_id_ (gating)                     │
   │                             │ primeiro token / commit                    │
   │                             ▼                                            │
   │   WinHttpLlmClient (HTTP/2 direto)  Cerebras ──falha──► Groq              │
   │     keep-alive 25s · RST_STREAM mantém conexão aberta                     │
   │                             │ EngineEvent (Delta/Done/SpecHit/Miss)       │
   │                             ▼                                            │
   │   UI_Bridge: WakeQueue ──► PostMessageW ──► InvalidateRect                │
   │     primeiro token imediato · deltas seguintes coalescidos 16ms           │
   └──────────────────────────────────────────────────────────────────────────┘
                             │ cada turno fechado (ambas as lanes)
                             ▼
                    SessionTranscript (std::vector<TranscriptTurn>, RAM)
                             │ ação Finalizar (botão / hotkey)
   ┌─────────────────────────▼──────────────────────────────────────────────┐
   │                COLD_PATH                                                  │
   │   JevAnalyticsClient: 2 threads WinHttp paralelas                         │
   │     T1 Jev Engine API  (JSON POST: state + questions scores/choices)      │
   │     T2 feedback sintético (<=80 tokens, 3 linhas)                         │
   │   join tudo-ou-nada ──► ambos OK?  ──► OverlayMode::PostInterviewReport    │
   │                         qualquer falha ──► fica LiveCopilot, descarta      │
   └──────────────────────────────────────────────────────────────────────────┘
                             │ sucesso
                             ▼
             Overlay dashboard: 3 Score_Ring (AddArc, theta animado)
                              + Instant_Feedback 3 linhas  (~300ms)
```

### Tabela de orçamento de tempo (Hot_Path, primário Cerebras)

O alvo de ponta a ponta é **< 200 ms** do fim acústico da fala ao primeiro token visível, assumindo conexão HTTP/2 já aquecida pelo keep-alive.

| Etapa | Mecanismo | Orçamento |
|---|---|---|
| Detecção de fim de fala local | `FrameVad` streak de 110 ms (6 frames de 20 ms) | já embutido nos 110 ms; disparo ~0 ms após o 6º frame |
| Enfileirar + acordar orquestrador | lock-free enqueue + `cv.notify_one` | < 1 ms |
| Decisão + início da geração especulativa | normalmente **já em voo** (shadow iniciado no interino estável, antes do silêncio) | 0 ms no caminho feliz |
| TTFT do provedor (Cerebras, conexão quente) | HTTP/2 multiplexado, TLS 1.3 já estabelecido | ~80–150 ms |
| Commit (Speculating→Committed) | gatilho: primeiro de {`speech_final`, 120 ms de silêncio local} | tokens já no `shadow_buffer_` |
| Promoção p/ UI | move de buffer + `PostMessageW`/`InvalidateRect` | <= 16 ms (1 quadro) |
| **TTFT percebido** | buffer já cheio no commit | **~0 ms** |

A chave da arquitetura é que a geração **começa durante** o interino estável (especulação), de modo que, quando o silêncio local fecha o turno, os tokens já estão no `shadow_buffer_` e o commit os torna visíveis em um quadro. O fallback Groq só entra se o primário falhar/expirar, pagando uma segunda rodada de TTFT.

### Threads e propriedade de estado

| Thread | Responsabilidade | Comunicação |
|---|---|---|
| Captura WASAPI (1 por lane) | PCM + `FrameVad` (RMS, streak, gate) | `enqueue + notify` para o engine (não bloqueia) |
| Orquestradora do engine (única) | TurnAssembler, DecisionPolicy, Shadow Streaming, SessionTranscript | `inbox` + `std::condition_variable` |
| Workers LLM (1 por chamada) | WinHTTP síncrono, SSE deltas | callbacks → `post(Input)` no inbox |
| UI (Overlay) | drenar `WakeQueue`, render, `anim_tick` 16 ms | `PostMessageW` |
| Cold_Path (2 workers) | Jev Engine API + feedback sintético | `join` tudo-ou-nada → `post` 1 evento de modo |

Invariante preservada do código atual: **todo estado do copiloto pertence a uma única thread orquestradora** — sem locks na lógica. O `FrameVad` roda na thread de captura e só comunica por fila + notificação.

_Mapa de requisitos:_ o fluxo Dual-Path cobre Req 1–9; a tabela de tempo materializa a meta implícita de latência de Req 1–5; o modelo de threads honra a invariância "nunca bloquear a UI/captura" de Req 1.6, 5.1–5.4.

## Components and Interfaces

### 1. `FrameVad` — VAD acústico local (NET-NEW, puro)
**Arquivos:** `src/core/include/rtai/frame_vad.hpp` (lógica pura, testável) usado por `src/audio_wasapi/src/wasapi_capture.cpp`.
**Requisitos:** 1.1, 1.2, 1.3, 1.5, 1.6, 3.1, 3.3.

A lógica numérica mora no core (pura, sem dependência de WASAPI) para ser testável por PBT, espelhando o padrão de `UserSpeechGate`. A thread de captura instancia um `FrameVad` por lane e alimenta frames de 20 ms.

```cpp
namespace rtai {

struct FrameVadConfig {
    int sample_rate_hz{16000};
    int frame_ms{20};                 // 320 amostras @ 16 kHz
    int silence_frames{6};            // 6 * 20 ms = 110 ms (Req 1.3)
    int commit_silence_frames{6};     // 120 ms de silêncio absoluto (Req 3.1/3.3) ~= 6 frames
    float noise_margin{1.6f};         // multiplicador sobre o Noise_Floor
    float floor_attack{0.05f};        // suavização quando o piso sobe
    float floor_release{0.002f};      // decaimento lento quando cai
};

// Resultado de alimentar um frame.
struct FrameVadResult {
    double rms{0.0};                  // 0..32767 (Req 1.1)
    bool silent{false};               // rms < noise_floor * margin (Req 1.2)
    bool speculative_edge{false};     // 110 ms de silêncio contínuo atingido AGORA (Req 1.3)
    bool commit_silence_edge{false};  // 120 ms de silêncio absoluto atingido AGORA (Req 3.1/3.3)
};

class FrameVad {
public:
    explicit FrameVad(FrameVadConfig cfg = {}) : cfg_(cfg) {}

    // RMS de um frame de amostras int16 (Req 1.1). Puro, sem alocação.
    static double frame_rms(const std::int16_t* samples, std::size_t n);

    // Alimenta um frame de 20 ms. Atualiza o Noise_Floor rolante, classifica
    // silêncio (Req 1.2) e avança os streaks de 110 ms e 120 ms.
    FrameVadResult on_frame(const std::int16_t* samples, std::size_t n);

    [[nodiscard]] double noise_floor() const noexcept { return noise_floor_; }
    void reset() noexcept;            // chamada ao início de um novo turno

private:
    FrameVadConfig cfg_;
    double noise_floor_{200.0};       // estimativa inicial conservadora
    int silent_streak_{0};            // frames silenciosos consecutivos
    bool spec_fired_{false};          // evita re-disparar o mesmo streak
};

} // namespace rtai
```

Gate do disparo especulativo, na thread de captura (Req 1.3/1.5):

```cpp
// wasapi_capture.cpp (pseudocódigo do caminho de 20 ms, por lane)
FrameVadResult r = vad_.on_frame(frame16, frame_len);
if (r.speculative_edge) {
    // Gate pelo filtro rápido do DecisionPolicy (Req 1.3/1.4/1.5).
    // O texto interino corrente é lido do engine via snapshot atômico/fila.
    engine_->on_vad_speculate(source_, r.rms, ticks);   // enqueue + notify
}
if (r.commit_silence_edge) {
    engine_->on_vad_commit_silence(source_, ticks);     // Req 3.1/3.3
}
```

> Nota de thread-safety (Req 1.6, invariante do projeto): `FrameVad::on_frame` é chamado **apenas** na thread de captura; o engine recebe apenas sinais via `enqueue + notify`, sem travar a captura. O disparo é independente de qualquer evento Deepgram.

### 2. `DecisionPolicy` — filtro rápido do interino
**Arquivos:** `src/core/include/rtai/decision_policy.hpp`.
**Requisitos:** 1.4.

O filtro rápido reaproveita `looks_like_question()` (já existente) e adiciona a condição ">5 palavras". É um método puro novo sobre o `DecisionPolicy`:

```cpp
// Filtro rápido do Hot_Path: aprova o interino para disparo especulativo
// somente quando tem MAIS de 5 palavras E estrutura de pergunta (Req 1.4).
// Mais estrito que would_trigger(): sem keyword/long-turn, sem cooldown.
[[nodiscard]] bool fast_filter(std::string_view interim) const {
    return text::word_count(interim) > 5 && looks_like_question(interim);
}
```

### 3. `CopilotEngine` — máquina de estados Shadow Streaming
**Arquivos:** `src/core/src/copilot_engine.cpp`, `src/core/include/rtai/copilot_engine.hpp`.
**Requisitos:** 2.1–2.6, 3.1–3.4, 5.2.

Formaliza o que hoje é `std::optional<Shadow> shadow` + `promote_shadow`/`cancel_shadow`. O `Shadow` ganha um estado explícito e o `generation_id_` passa a ser o gating de tokens.

```cpp
enum class ShadowState : std::uint8_t { Idle, Speculating, Committed, Aborted };

struct Shadow {                       // (estende o struct existente)
    ShadowState state{ShadowState::Idle};
    std::uint64_t id{0};              // == generation_id_ corrente desta geração
    std::string speculative_text;     // texto do interino que originou a especulação
    std::string shadow_buffer_;       // tokens retidos durante Speculating (Req 2.1)
    std::shared_ptr<Ctx> ctx;
    std::shared_ptr<ILlmCall> call;
    AudioSource source{AudioSource::Loopback};
    TriggerReason reason{TriggerReason::None};
    std::string keyword;
    std::int64_t started_ms{0};
    std::int64_t commit_deadline_ms{-1}; // timeout de fallback do commit
};
std::uint64_t generation_id_{0};      // monotônico (Req 2.3/2.5)
```

Novos inputs no `using Input = std::variant<...>`:

```cpp
struct InVadSpeculate { AudioSource source; float rms; std::int64_t t; };
struct InVadCommitSilence { AudioSource source; std::int64_t t; };
struct InSpeechFinal { AudioSource source; std::int64_t t; }; // Deepgram speech_final
```

Transições (cada uma roda na thread orquestradora, sem locks):

```cpp
// Req 2.1: Idle -> Speculating. Inicia a geração, retém tokens ocultos,
// instrui o overlay a mostrar "Generating answer...".
void enter_speculating(const SpeculativeCandidate& c) {
    const std::uint64_t gen = ++generation_id_;
    Shadow sh; sh.state = ShadowState::Speculating; sh.id = gen;
    sh.speculative_text = c.text; sh.source = c.source;
    sh.commit_deadline_ms = now_ms() + kCommitTimeoutMs;  // fallback (Req 3.1)
    // ... start LLM (ver §4) com callback que faz gating por gen ...
    publish(SpeculativeCandidateEvent{c.source, c.text, c.t_ms}); // "Generating answer..."
    shadow = std::move(sh);
}

// Req 2.5: token recebido com gen != generation_id_ é descartado sem efeito.
void on_shadow_delta(std::uint64_t gen, std::string_view d) {
    if (!shadow || gen != generation_id_) return;              // descarta
    if (shadow->state == ShadowState::Speculating)
        shadow->shadow_buffer_.append(d);                      // Req 2.1/2.4 (oculto)
    else if (shadow->state == ShadowState::Committed)
        publish(SuggestionDeltaEvent{shadow->id, std::string(d)}); // Req 2.6 (anexa visível)
}

// Req 2.2/2.6: Speculating -> Committed. Promove o buffer para a UI em <=16 ms.
void commit_shadow(CommitCause cause) {
    if (!shadow || shadow->state != ShadowState::Speculating) return;
    shadow->state = ShadowState::Committed;
    const std::uint64_t pid = shadow->id;
    publish(SpeculativeHitEvent{shadow->id, pid, now_ms()});
    if (!shadow->shadow_buffer_.empty())
        publish(SuggestionDeltaEvent{pid, shadow->shadow_buffer_}); // 1º conteúdo visível
    // UI_Bridge faz PostMessageW/InvalidateRect imediatos (Req 5.2).
}

// Req 2.3/3.4: -> Aborted. Descarta buffer, gen++, RST_STREAM, sem flicker.
void abort_shadow() {
    if (!shadow) return;
    ++generation_id_;                                   // invalida tokens em voo (Req 2.3/2.5)
    shadow->shadow_buffer_.clear();                     // descarta (Req 2.3)
    shadow->ctx->cancelled.store(true);
    if (shadow->call) shadow->call->cancel();           // RST_STREAM (Req 2.3/4.6)
    shadow.reset();                                     // card visível intocado (sem flicker)
}
```

Gatilho de commit (Req 3.1–3.3), avaliado na chegada de `InSpeechFinal`, `InVadCommitSilence` e no tick (timeout de fallback):

```cpp
// "primeiro de {speech_final, 120 ms de silêncio local}" — o que vier antes.
void maybe_commit(CommitCause cause, std::int64_t now) {
    if (shadow && shadow->state == ShadowState::Speculating) commit_shadow(cause);
}
// tick(): if (shadow Speculating && now >= commit_deadline_ms) commit_shadow(Timeout);
```

Divergência (Req 3.4): quando o turno fecha, compara via `speculative_match` já existente (prefixo + containment folded, a tolerância do design). Casa → commit; diverge → `abort_shadow()` + nova geração para o turno fechado (o caminho `on_turn` atual já faz exatamente isso em `promote_shadow`/`cancel_shadow`; passa a chamar as transições nomeadas).

### 4. `WinHttpLlmClient` — HTTP/2 direto + failover + keep-alive
**Arquivos:** `src/net/src/winhttp_llm_client.cpp`, `src/net/include/rtai/winhttp_llm_client.hpp`.
**Requisitos:** 4.1–4.6.

HTTP/2 e TLS 1.2/1.3 **já estão habilitados** na sessão. As adições são de política, não de transporte:

```cpp
struct LlmEndpoint {
    std::string host;      // "api.cerebras.ai" | "api.groq.com"
    std::string path{"/v1/chat/completions"};
    std::string model;     // "llama-3.3-70b" | "llama-3.3-70b-versatile"
    std::string api_key;
};

struct WinHttpLlmOptions {              // (estende o existente)
    LlmEndpoint primary;                // Cerebras (Req 4.1)
    LlmEndpoint fallback;               // Groq   (Req 4.2)
    int resolve_timeout_ms{3000};
    int connect_timeout_ms{4000};
    int send_timeout_ms{5000};
    int first_byte_timeout_ms{1200};    // falha "rápida" do primário -> failover (Req 4.2)
    int receive_timeout_ms{15000};      // gap máximo entre chunks do stream
    int keep_alive_ms{25000};           // Req 4.5
};
```

Seleção de endpoint (lógica pura, testável — Req 4.2):

```cpp
// attempt 0 -> primário; após falha retryável (timeout/5xx/conexão) -> fallback.
// 4xx (auth/validação) não troca silenciosamente de provedor.
const LlmEndpoint& choose_endpoint(int attempt, const WinHttpLlmOptions& o) {
    return attempt == 0 ? o.primary : o.fallback;
}
bool is_retryable(LlmFailure f) {       // timeout, conexão, 5xx, RST inesperado
    return f == LlmFailure::Timeout || f == LlmFailure::Connect || f == LlmFailure::Server5xx;
}
```

Keep-alive (Req 4.5): um worker por sessão envia um ping leve de aplicação (HEAD/`GET` barato OU um frame PING HTTP/2) quando `should_ping(now, last_ping)` é verdadeiro:

```cpp
bool should_ping(std::int64_t now_ms, std::int64_t last_ping_ms, int interval_ms) {
    return (now_ms - last_ping_ms) >= interval_ms;   // 25 s (Req 4.5)
}
```

Cancelamento (Req 4.6): `ILlmCall::cancel()` continua cooperativo (o worker fecha os próprios handles entre reads). Sobre HTTP/2 isso emite **RST_STREAM** e mantém a conexão TCP/TLS aberta para reuso — nenhum novo handshake na próxima geração. OpenRouter é removido dos dois endpoints do caminho crítico (Req 4.3); permanece apenas disponível fora do caminho de geração ao vivo.

### 5. Event_Bus sem sleep + UI_Bridge
**Arquivos:** `src/core/src/copilot_engine.cpp` (bus), `src/overlay/src/overlay_window.cpp` (bridge).
**Requisitos:** 5.1–5.4.

O orquestrador **já** usa `cv.wait_until(lk, next_tick, pred)` — não há `sleep_for(50ms)` fixo no caminho de eventos; o tick de 50 ms é só o relógio periódico do `TurnAssembler`. Esta feature consolida isso como o Event_Bus (Req 5.1/5.4): um `post(Input)` faz `notify_one`, acordando o consumidor sem latência de polling.

UI_Bridge (Req 5.2/5.3) no `OverlayWindow`:

- `post()` já empurra no `WakeQueue` e faz **um** `PostMessageW(WM_APP_DRAIN)` por drenagem.
- No primeiro `SuggestionDeltaEvent` válido de uma geração **ou** no evento de commit, o overlay força um render imediato (`render()` + `InvalidateRect`) em vez de esperar o próximo quadro.
- Deltas subsequentes da mesma geração marcam `render_pending` e são coalescidos pelo `kTimerAnim` de 16 ms (já existente), <= 1 render por 16 ms.

```cpp
// pseudocódigo do drain no overlay
if (is_first_visible_delta(ev) || is_commit(ev)) { drain_model(ev); render(); } // imediato (Req 5.2)
else { drain_model(ev); render_pending = true; }                                // coalesce 16ms (Req 5.3)
```

### 6. `SessionTranscript` — acumulador da sessão (NET-NEW)
**Arquivos:** `src/core/include/rtai/session_transcript.hpp`; alimentado em `copilot_engine.cpp` no `on_turn`.
**Requisitos:** 6.1–6.4.

```cpp
namespace rtai {

enum class TranscriptTrack : std::uint8_t { Interviewer, Candidate };

struct TranscriptTurn {
    TranscriptTrack track{TranscriptTrack::Interviewer};
    std::string text;              // verbatim, idêntico ao turno fechado (Req 6.4)
    std::int64_t start_ms{0};
    std::int64_t end_ms{0};
    std::uint64_t seq{0};
};

// Acumulador em RAM, propriedade da thread orquestradora (não thread-safe).
class SessionTranscript {
public:
    // Anexa um turno fechado preservando a ordem cronológica (Req 6.1/6.2/6.3).
    void append(const Turn& t) {
        turns_.push_back(TranscriptTurn{
            t.source == AudioSource::Loopback ? TranscriptTrack::Interviewer
                                              : TranscriptTrack::Candidate,  // Req 6.1/6.2
            t.text, t.start_ms, t.end_ms, t.seq});                           // Req 6.4 verbatim
    }
    [[nodiscard]] const std::vector<TranscriptTurn>& turns() const noexcept { return turns_; }
    [[nodiscard]] std::string render() const; // texto completo p/ o campo "state" do Jev
private:
    std::vector<TranscriptTurn> turns_;
};

} // namespace rtai
```

Mapeamento de faixa: `AudioSource::Loopback` = entrevistador; `AudioSource::Microphone` = candidato. O `append` é chamado em `on_turn(const Turn&)`, logo após `publish(TurnEvent{turn})`, para **todo** turno fechado (ambas as lanes), antes da avaliação de trigger.

### 7. `JevAnalyticsClient` — Cold Path (NET-NEW)
**Arquivos:** `src/net/include/rtai/jev_analytics_client.hpp`, `src/net/src/jev_analytics_client.cpp`.
**Requisitos:** 7.1–7.5, 8.1–8.4.

Reusa a infra WinHTTP (sessão HTTP/2, `enable_modern_tls`) e `json_min.hpp`/`openrouter_protocol.hpp`. **Duas** threads paralelas; `join` tudo-ou-nada.

```cpp
namespace rtai {

struct JevScores { double relevance{0}, accuracy{0}, clarity{0}; }; // 0..10

struct JevReport {
    JevScores scores;
    std::array<std::string, 3> feedback_lines; // Instant_Feedback (3 linhas)
};

struct JevClientOptions {
    LlmEndpoint engine_api;       // Jev Engine API (JSON direto, sem SSE)
    LlmEndpoint feedback;         // feedback sintético (<=80 tokens)
    int engine_timeout_ms{8000};  // "tempo limite definido no design" (Req 8.1)
    int feedback_timeout_ms{6000};// (Req 8.2)
    int feedback_max_tokens{80};  // Req 7.4
};

class JevAnalyticsClient {
public:
    explicit JevAnalyticsClient(JevClientOptions opts);
    ~JevAnalyticsClient();

    // Req 7.1: dispara DUAS chamadas WinHttp paralelas em threads distintas.
    // on_done(ok, report): ok == true SOMENTE se ambas concluíram com sucesso
    // (Req 8.3); em qualquer falha, descarta parciais (Req 8.4) e ok == false.
    void finalize(const SessionTranscript& transcript,
                  std::function<void(bool ok, JevReport report)> on_done);

    // Builders/parsers puros (testáveis sem rede):
    static std::string build_engine_request(const SessionTranscript& t);     // Req 7.2
    static std::optional<JevScores> parse_engine_response(std::string_view);  // Req 7.3
    static std::string build_feedback_request(const SessionTranscript& t, int max_tokens); // 7.4
    static std::array<std::string,3> normalize_feedback(const std::vector<std::string>&);   // 9.4
private:
    JevClientOptions opts_;
};

} // namespace rtai
```

`join` tudo-ou-nada (Req 8.1–8.4):

```cpp
// final_mode puro: PostInterviewReport SOMENTE se ambos ok; senão LiveCopilot.
OverlayMode final_mode(bool engine_ok, bool feedback_ok) {
    return (engine_ok && feedback_ok) ? OverlayMode::PostInterviewReport
                                      : OverlayMode::LiveCopilot;
}
```

Enquanto as duas chamadas estão em voo, o overlay permanece em `LiveCopilot` (Req 7.5). Se qualquer uma falhar/expirar, o resultado parcial da outra é **descartado** e nunca renderizado (Req 8.4); só na dupla-sucesso o engine publica o evento de transição de modo (Req 8.3).

### 8. `OverlayWindow` — OverlayMode + dashboard Direct2D
**Arquivos:** `src/overlay/src/overlay_window.cpp`, `src/overlay/include/rtai/overlay_window.hpp`.
**Requisitos:** 7.5, 8.1–8.3, 9.1–9.6.

`OverlayMode` é **net-new** (hoje só existe `mode_label`):

```cpp
enum class OverlayMode : std::uint8_t { LiveCopilot, PostInterviewReport };
```

Evento net-new para dirigir a transição (publicado só na dupla-sucesso do Cold_Path):

```cpp
struct OverlayModeEvent { OverlayMode mode; JevReport report; std::int64_t t_ms{0}; };
// adicionado ao std::variant EngineEvent
```

Modelo de render do dashboard (pure → testável):

```cpp
enum class RingDim : std::uint8_t { Relevance, Accuracy, Clarity };

struct RingSpec {
    RingDim dim;
    float score;            // 0..10 (clamp)
    std::uint32_t color;    // Relevance=laranja, Accuracy=verde, Clarity=lilás (Req 9.1)
    float target_theta_deg; // (score/10)*360 (Req 9.3)
};

// Req 9.1: sempre exatamente 3 anéis, ordem/cor fixas por dimensão.
std::array<RingSpec,3> build_rings(const JevScores& s);

// Req 9.3: ângulo-alvo puro, clampado.
inline float ring_theta_deg(float score) {
    const float c = std::clamp(score, 0.0f, 10.0f);
    return (c / 10.0f) * 360.0f;     // 0 -> 0°, 10 -> 360°
}
```

Renderização (Req 9.2/9.3): cada `Score_Ring` é desenhado com `ID2D1PathGeometry` + `ID2D1GeometrySink::AddArc` (já disponíveis). O `anim_tick()` (timer de 16 ms já existente) interpola o ângulo corrente de 0 até `target_theta_deg`, exatamente como já faz com `pulse_bar_height`/crescimento do card. O `Instant_Feedback` de 3 linhas (`normalize_feedback`) é desenhado ao lado dos anéis (Req 9.4). Ao entrar em `PostInterviewReport` (dupla-sucesso), o dashboard completo aparece em ~300 ms (Req 9.5). Em `PostInterviewReport`, a janela mantém os estilos já aplicados pelo HUD: sem roubo de foco e com exclusão de captura de tela (Req 9.6) — nenhuma mudança de `WS_EX_*`/`SetWindowDisplayAffinity` na troca de modo.

## Data Models

### TranscriptTurn / TranscriptTrack (Req 6)
Ver §6. `track` ∈ {Interviewer (Loopback), Candidate (Microphone)}; `text` verbatim; ordem = ordem de fechamento.

### Enums de estado
- `ShadowState` ∈ {Idle, Speculating, Committed, Aborted} (Req 2).
- `OverlayMode` ∈ {LiveCopilot, PostInterviewReport} (Req 7/8/9).
- `RingDim` ∈ {Relevance, Accuracy, Clarity} (Req 9.1).
- `generation_id_` : contador monotônico `std::uint64_t` (Req 2.3/2.5).

### Jev Engine API — request (Req 7.2)
POST JSON, lido como JSON direto (sem SSE, Req 7.3):

```json
{
  "state": "<transcrição completa do SessionTranscript, verbatim>",
  "questions": [
    { "key": "relevance_score", "type": "score", "min": 0, "max": 10 },
    { "key": "accuracy_score",  "type": "score", "min": 0, "max": 10 },
    { "key": "clarity_score",   "type": "score", "min": 0, "max": 10 },
    { "key": "domain",          "type": "choice" },
    { "key": "interview_type",  "type": "choice" }
  ]
}
```

### Jev Engine API — response (Req 7.3)
```json
{
  "relevance_score": 8,
  "accuracy_score": 7,
  "clarity_score": 9,
  "domain": "backend",
  "interview_type": "system-design"
}
```
Parse → `JevScores{relevance, accuracy, clarity}`, cada score clampado a [0,10].

### Feedback sintético — request/response (Req 7.4, 9.4)
Request: chat-completions padrão OpenAI com `max_tokens <= 80`. Response: texto que `normalize_feedback` reduz a **exatamente 3 linhas** (preserva presentes em ordem, preenche faltantes com "", trunca excedentes) — mesmo contrato de `normalize_anchors` já testado no projeto.

### FrameVad (Req 1)
`FrameVadConfig` (ver §1): `silence_frames=6` (110 ms), `commit_silence_frames=6` (~120 ms), `noise_margin`, attack/release do piso. `FrameVadResult{rms, silent, speculative_edge, commit_silence_edge}`.

## Correctness Properties

*Uma propriedade é um comportamento que deve valer em todas as execuções válidas do sistema — a ponte entre a especificação humana e garantias verificáveis por máquina. O projeto já usa PBT por amostragem com `std::mt19937` semeado + casos de fronteira nomeados (ver `tests/core_tests/test_hud_properties.cpp`); estas propriedades seguem o mesmo estilo.*

### Property 1: RMS do frame fica no domínio e escala monotonicamente
*Para qualquer* frame de amostras int16, `FrameVad::frame_rms` retorna um valor em [0, 32767]; um frame todo-zero retorna 0; e multiplicar uniformemente todas as amostras por um fator `k` em [0,1] nunca aumenta o RMS (monotonicidade sob escala de amplitude).
**Validates: Requirements 1.1**

### Property 2: Classificação de silêncio é o limiar exato
*Para quaisquer* `rms`, `noise_floor` e `margin`, o frame é classificado como silêncio se e somente se `rms < noise_floor * margin`.
**Validates: Requirements 1.2**

### Property 3: Filtro rápido aprova sse >5 palavras e estrutura de pergunta
*Para qualquer* texto interino, `DecisionPolicy::fast_filter` retorna verdadeiro se e somente se `word_count(texto) > 5` E `looks_like_question(texto)` for verdadeiro (fronteiras explícitas em 5 e 6 palavras).
**Validates: Requirements 1.4**

### Property 4: Disparo especulativo exige streak de 110 ms contínuo gated pelo filtro rápido
*Para qualquer* série temporal de frames `(silent, fast_ok)`, o `FrameVad` só emite `speculative_edge` quando houver pelo menos 6 frames silenciosos consecutivos (110 ms) E `fast_ok` verdadeiro no instante; um único frame não-silencioso reinicia o streak, e enquanto `fast_ok` for falso o disparo nunca ocorre.
**Validates: Requirements 1.3, 1.5**

### Property 5: Durante Speculating nada é exibido e o buffer é a concatenação dos deltas
*Para qualquer* sequência de deltas recebidos no estado Speculating com a geração corrente, `shadow_buffer_` é exatamente a concatenação byte-a-byte desses deltas e a resposta visível permanece vazia o tempo todo.
**Validates: Requirements 2.1, 2.4**

### Property 6: Tokens de geração obsoleta não têm efeito
*Para qualquer* intercalação de deltas com a geração corrente e com gerações obsoletas (`gen != generation_id_`), apenas os deltas da geração corrente alteram `shadow_buffer_`/UI; o estado após um delta obsoleto é idêntico ao estado imediatamente anterior a ele.
**Validates: Requirements 2.5**

### Property 7: Após o commit, a resposta visível é o buffer promovido seguido dos deltas subsequentes
*Para qualquer* buffer acumulado em Speculating e qualquer sequência de deltas da mesma geração após o commit, a resposta visível é igual, byte-a-byte, a `buffer_promovido + concatenação(deltas_pós_commit)`, na ordem.
**Validates: Requirements 2.2, 2.6**

### Property 8: Abortar incrementa estritamente a geração e descarta o buffer sem afetar o card visível
*Para qualquer* estado do engine, `abort_shadow()` produz `generation_id_` estritamente maior que o anterior, esvazia `shadow_buffer_` e deixa o texto atualmente visível no HUD inalterado.
**Validates: Requirements 2.3**

### Property 9: Commit ocorre no primeiro de {speech_final, 120 ms de silêncio local}
*Para qualquer* linha do tempo em que `speech_final` chega em `t1` e o silêncio local absoluto atinge 120 ms em `t2` (qualquer um podendo ser ausente/infinito), estando em Speculating o engine transita para Committed no instante `min(t1, t2)` e a causa registrada corresponde ao evento mais cedo.
**Validates: Requirements 3.1, 3.2, 3.3**

### Property 10: Casamento especulativo decide commit vs abort e é reflexivo/prefixo-fechado
*Para qualquer* par `(especulativo, fechado)`, ao fechar o turno o engine faz commit se e somente se `speculative_match(especulativo, fechado)` for verdadeiro; caso contrário aborta e inicia nova geração. Além disso, para qualquer `s`, `speculative_match(s, s)` é verdadeiro e `speculative_match(s, s+sufixo)` é verdadeiro (prefixo real estende o especulativo).
**Validates: Requirements 3.4**

### Property 11: Seleção de endpoint faz failover do primário para o fallback
*Para qualquer* resultado de tentativa, a seleção escolhe o Primary_Provider na tentativa 0 e o Fallback_Provider na tentativa 1 após uma falha retryável; falhas não-retryáveis (4xx) não trocam de provedor silenciosamente.
**Validates: Requirements 4.2**

### Property 12: Keep-alive dispara exatamente a cada 25 s
*Para qualquer* par `(now_ms, last_ping_ms)`, `should_ping` é verdadeiro se e somente se `now_ms - last_ping_ms >= 25000`; após disparar, o relógio do ping reinicia a partir do instante do envio.
**Validates: Requirements 4.5**

### Property 13: Coalescência limita a 1 redesenho por janela de 16 ms
*Para qualquer* sequência de instantes de chegada de deltas da mesma geração após o primeiro redesenho, o número de redesenhos agendados em qualquer janela de 16 ms é no máximo 1, e ao menos um redesenho é agendado após o último delta.
**Validates: Requirements 5.3**

### Property 14: Append do transcript preserva faixa, ordem e texto verbatim
*Para qualquer* sequência de turnos fechados, `SessionTranscript::append` produz um vetor de comprimento igual ao número de turnos, na mesma ordem de fechamento, com cada entrada marcada como Interviewer sse a origem é Loopback (senão Candidate) e com `text` byte-a-byte idêntico ao texto do turno fechado.
**Validates: Requirements 6.1, 6.2, 6.3, 6.4**

### Property 15: Request da Jev Engine API contém state e o esquema de questions
*Para qualquer* `SessionTranscript`, o JSON de `build_engine_request` parseia válido, seu campo `state` é igual ao texto renderizado do transcript, e `questions` contém exatamente os três campos de `type:"score"` (relevance/accuracy/clarity, 0..10) e os dois de `type:"choice"` (domain, interview_type).
**Validates: Requirements 7.2**

### Property 16: Response da Jev Engine API faz round-trip de pontuações clampadas
*Para quaisquer* três pontuações, serializar a resposta JSON e então `parse_engine_response` recupera as mesmas pontuações, cada uma clampada a [0,10].
**Validates: Requirements 7.3**

### Property 17: Join tudo-ou-nada decide o modo e nunca renderiza parcial
*Para qualquer* par `(engine_ok, feedback_ok)`, `final_mode` retorna `PostInterviewReport` se e somente se ambos forem verdadeiros; em qualquer outro caso retorna `LiveCopilot` e nenhum payload de dashboard é exposto (parciais descartados).
**Validates: Requirements 8.1, 8.2, 8.3, 8.4**

### Property 18: Modelo de anéis tem sempre 3 anéis com cores fixas por dimensão
*Para quaisquer* pontuações, `build_rings` retorna exatamente 3 `RingSpec` na ordem Relevância, Acurácia, Clareza, com cores laranja, verde e lilás respectivamente.
**Validates: Requirements 9.1**

### Property 19: Ângulo theta do anel mapeia o score em [0°,360°] monotonicamente
*Para qualquer* score, `ring_theta_deg` retorna um valor em [0,360]; `ring_theta_deg(0)=0`, `ring_theta_deg(10)=360`; o mapeamento é monótono não-decrescente e o score é clampado a [0,10].
**Validates: Requirements 9.3**

### Property 20: Instant_Feedback normaliza para exatamente 3 linhas preservando ordem
*Para qualquer* lista de 0..N linhas, `normalize_feedback` retorna exatamente 3 linhas: as presentes na ordem original, slots restantes preenchidos com "" e excedentes truncados às 3 primeiras.
**Validates: Requirements 9.4**

## Error Handling

- **VAD / captura (Req 1.6):** `FrameVad::on_frame` nunca lança nem aloca e roda só na thread de captura; falha de dispositivo é tratada pelo caminho de recuperação WASAPI já existente. Sinais ao engine são por `enqueue + notify`; se o inbox estiver saturado, o sinal é descartado silenciosamente (o próximo frame tenta de novo) — a captura nunca bloqueia.
- **Geração obsoleta (Req 2.5):** todo delta/done carrega a geração; `gen != generation_id_` é descartado. Garante ausência de "vazamento" de tokens de uma geração abortada para a UI.
- **Abort sem flicker (Req 2.3):** abortar só limpa estado oculto e emite RST_STREAM; nunca toca o card visível, então a UI não pisca.
- **Failover (Req 4.2):** timeout de primeiro byte curto (`first_byte_timeout_ms`) no primário dispara o fallback; 4xx (auth/validação) **não** faz failover silencioso — publica `NoticeEvent{Error}`. Se ambos falharem, o Hot_Path emite `SuggestionDoneEvent{Failed}` e o card mostra erro, sem derrubar a sessão.
- **RST_STREAM / reuso (Req 4.6):** cancelamento cooperativo fecha o stream mantendo a conexão HTTP/2; se a conexão cair, a próxima chamada reabre normalmente (degradação graciosa, paga handshake).
- **Cold_Path tudo-ou-nada (Req 8):** cada worker tem timeout próprio (`engine_timeout_ms`, `feedback_timeout_ms`). Qualquer falha/timeout → `on_done(false, {})`, overlay permanece em `LiveCopilot`, nada do dashboard é renderizado e o resultado parcial é descartado. Uma falha do Cold_Path nunca afeta o Hot_Path nem encerra a sessão.
- **JSON malformado do Jev (Req 7.3):** `parse_engine_response`/parse do feedback retornam `std::nullopt`/falha → tratado como falha da chamada (entra no tudo-ou-nada).
- **UI_Bridge (Req 5):** `post()` para HWND morto é inofensivo (documentado no código atual); se a fila de wake estiver cheia, o `PostMessageW` único por drenagem garante que um render pendente ainda ocorre.

## Testing Strategy

O projeto usa **GoogleTest** com PBT por amostragem semeada (`std::mt19937`) mais casos de fronteira nomeados, como em `tests/core_tests/test_hud_properties.cpp`. A mesma abordagem dual se aplica:

**Testes de propriedade (≥100 iterações, `std::mt19937` com seed fixa):**
- `FrameVad`: Properties 1, 2, 4 (RMS, silêncio, streak gated) — `tests/core_tests/test_frame_vad_properties.cpp`.
- `DecisionPolicy::fast_filter`: Property 3.
- Shadow Streaming: Properties 5, 6, 7, 8, 9, 10 (buffering, gating, append pós-commit, abort, race de commit, divergência) — `tests/core_tests/test_shadow_streaming_properties.cpp`. Usa um `ILlmClient` fake que injeta deltas com geração controlada.
- Transporte: Properties 11, 12 (seleção de endpoint, cadência de keep-alive) sobre as funções puras `choose_endpoint`/`should_ping`.
- UI_Bridge: Property 13 (coalescência) sobre a lógica pura de agendamento de redesenho.
- `SessionTranscript`: Property 14 — `tests/core_tests/test_session_transcript_properties.cpp`.
- Jev builders/parsers: Properties 15, 16, 17, 20 (schema do request, round-trip de scores, join tudo-ou-nada, normalização de feedback) — `tests/net_tests/test_jev_properties.cpp` + reuso do estilo de `normalize_anchors`.
- Dashboard: Properties 18, 19 (modelo de anéis, theta) — `tests/core_tests/test_dashboard_properties.cpp`.

Cada teste de propriedade carrega a tag **Feature: dual-path-speculative-pipeline, Property {N}: {texto}** e um oráculo de referência independente quando a lógica envolve uma série temporal (streak do VAD, race de commit, coalescência), espelhando o `GateOracle` já usado.

**Testes de exemplo / unidade (fronteiras e casos nomeados):**
- Req 1.6: VAD dispara sem nenhum evento Deepgram (alimenta só frames).
- Req 3.2/3.3: fronteiras explícitas do commit (speech_final antes de 120 ms; 120 ms sem speech_final).
- Req 5.1/5.2/5.4: um `post` acorda o consumidor sem atraso fixo; o primeiro delta/commit força um render imediato; latência de wake medida.
- Req 7.1/7.5: `finalize` cria dois workers distintos; modo permanece `LiveCopilot` até os dois concluírem.
- Req 7.4: request de feedback com `max_tokens == 80`.
- Req 9.6: estilos da janela (sem foco, exclusão de captura) inalterados na troca de modo.

**Testes de integração (rede real/mockada, 1–3 exemplos):**
- Req 4.1/4.3: endpoints críticos resolvem para Cerebras/Groq e nunca para `openrouter.ai` (smoke de config).
- Req 4.4: protocolo negociado é HTTP/2.
- Req 4.6: cancelar um stream e emitir nova requisição reusa a conexão (sem novo handshake).
- Req 9.5: benchmark `Finalizar → dashboard renderizado` dentro de ~300 ms com rede mockada.

**Limpeza:** artefatos temporários de teste (sessões, arquivos JSONL) são removidos ao final de cada caso, consistente com a suíte existente.
