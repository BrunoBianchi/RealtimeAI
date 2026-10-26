# Documento de Design — Glanceable HUD Overlay

## Overview

Esta feature redesenha a UI/UX do HUD flutuante do copiloto de entrevista em tempo real sobre a base C++/Win32 + Direct2D/DirectWrite já existente. O problema central é que o layout atual está **largo e quebrado**: os defaults de `overlay_window.cpp` são `kHudW=820`, `kMinW=720`, `kMaxW=960` DIP, uma barra de ferramentas horizontal com chips de transcrição que produz ~70-80 caracteres por linha. Isso é o oposto de "glanceable": o olho precisa varrer a tela inteira em vez de bater o olho por meio segundo colado à webcam.

O redesenho move o produto para um **HUD de coluna única de 480 DIP** (travado em 460–540), ancorado em Top-Center logo abaixo da webcam, com três zonas empilhadas (Strip_Unificada ~38 DIP, Headline+3 Âncoras, Micro_Footer). A regra cognitiva é **1+3**: uma tese direta em negrito seguida de exatamente três âncoras rotuladas. O streaming cresce sem jitter (confirma apenas palavras completas, coalesce em 16 ms, expande em blocos de linha com ease-out). A pergunta que originou a resposta fica **congelada** no cabeçalho do card (Trigger Lock), e o card atual **não é substituído** enquanto o usuário fala (Pin on Speak), reaproveitando o `cooldown_ms=4000` que a `DecisionPolicy` já mantém. A janela é criada **sem roubo de foco** (`WS_EX_NOACTIVATE` + `MA_NOACTIVATE`) e **invisível em compartilhamento de tela** (`SetWindowDisplayAffinity`/`WDA_EXCLUDEFROMCAPTURE`). Hotkeys globais discretas (Alt+Espaço, Alt+Setas, Alt+1/2/3, Alt+H) complementam os cliques.

O design respeita dois fatos importantes do código atual:

1. O **prompt teleprompter do Requisito 4 já está majoritariamente implementado** em `copilot_prompt.hpp` (`copilot_system_prompt()`): tese ≤12 palavras sem introdução, 3 bullets com 2–3 palavras-chave em negrito + `:` + ≤15 palavras em primeira pessoa, rótulos comportamental/system design, teto 80–120 tokens, proibição de inventar fatos e de reescrever a fala de `[Outros]`. O trabalho restante é pontual (tornar o caso 4.5 explícito e validar limites), não uma reescrita.
2. O **parser de layout rico do Requisito 5 já existe** em `suggestion_format.hpp` (`format_suggestion()` / `detail::parse_bold()`): detecção de linha-título, bullets e negrito `**`, inclusive com `**` não fechado durante streaming. O trabalho é ajustar a semântica de headline/termo-chave aos critérios do Req 5 e preservar conteúdo byte a byte.

O escopo cobre quatro superfícies: `overlay_window.cpp`/`overlay_window.hpp` (janela, layout, interação), `suggestion_format.hpp` (parser), `decision_policy.hpp`/`copilot_engine.cpp` (gate de voz e fila de pendentes) e `copilot_prompt.hpp` (ajuste fino do prompt).

## Architecture

### Invariante central: "never block the UI thread"

Todo o redesenho preserva o modelo de threading existente. Eventos do engine/LLM chegam por `OverlayWindow::post()` de qualquer thread; `post()` apenas empilha o `EngineEvent` numa `WakeQueue` e, no máximo uma vez por dreno, faz `PostMessage(WM_APP_DRAIN)`. A UI thread drena todos os eventos de uma vez, atualiza um **modelo plano** (structs POD, sem I/O), e agenda **um único** render via `kTimerRender` (16 ms). Rajadas de `SuggestionDeltaEvent` e `TranscriptUpdateEvent` são, portanto, coalescidas em ≤60 fps de repaints. Callbacks (`OverlayCallbacks`) só chamam métodos não-bloqueantes do engine (enqueue/atômico). Screenshots são capturadas na UI thread (BitBlt) e codificadas em JPEG numa worker thread, sinalizando de volta com `WM_APP_SHOT_DONE`.

Cada nova responsabilidade do redesenho entra **dentro** desse pipeline, nunca em paralelo a ele:

- **Confirmação de palavras completas e coalescência** (Req 6): buffer no modelo plano, aplicado durante o dreno; render único no tick de 16 ms.
- **Trigger Lock** (Req 8): captura do `trigger_text` verbatim no dreno do `SuggestionStartedEvent`, congelado no modelo até a próxima sugestão.
- **Pin on Speak / fila de pendentes** (Req 9): gate de voz avaliado no engine (orchestrator thread, dona da `DecisionPolicy`) antes de publicar `SuggestionStartedEvent`; a fila de "próxima sugestão pronta" vive no modelo da UI.
- **Pulse_Bar / shimmer / fade-in** (Req 13): animações dirigidas por `kTimerAnim`, lendo níveis via `poll_levels()` (~20 Hz) e progresso de tempo com os helpers `ui::approach()`.

```mermaid
flowchart TD
    subgraph eng["Orchestrator / LLM threads"]
        DP["DecisionPolicy\n(evaluate, cooldown_ms=4000,\n+ gate de voz do usuário)"]
        CE["CopilotEngine\n(publica EngineEvent)"]
        DP -->|TriggerReason| CE
    end

    CE -->|post EngineEvent\n(qualquer thread)| WQ["WakeQueue\n(lock-free push)"]
    WQ -.->|PostMessage WM_APP_DRAIN\n(1x por dreno)| UIT

    subgraph UIT["UI thread (janela layered)"]
        DR["drain(): aplica todos os eventos"]
        FM["Modelo plano\n(UiState, AnswerCard,\nStrip, SuggestionQueue,\nLayoutCache)"]
        RT["kTimerRender (16 ms)\nagenda 1 render"]
        AT["kTimerAnim\nPulse_Bar / shimmer / fade"]
        RD["render(): Direct2D/DirectWrite\n-> UpdateLayeredWindow\n(per-pixel alpha)"]
        DR --> FM
        FM --> RT --> RD
        AT --> RD
        PL["poll_levels() ~20 Hz\nOverlayLevels (RMS 0..1)"] --> FM
    end

    RD -->|hit regions reconstruídas\npor render| INP["WndProc\n(WM_MOUSEACTIVATE->MA_NOACTIVATE,\ncliques, WM_HOTKEY)"]
    INP -->|callbacks não-bloqueantes| CE

    classDef eng fill:#1f2d3d,stroke:#0a84ff,color:#fff;
    classDef ui fill:#223,stroke:#5af,color:#fff;
    class DP,CE eng;
    class DR,FM,RT,AT,RD,PL ui;
```

### Camadas e responsabilidades por requisito

| Camada | Arquivo | Requisitos atendidos |
|---|---|---|
| Janela/Composição | `overlay_window.cpp`, `overlay_window.hpp` | 1, 2, 10, 11, 12, 13, 14 |
| Layout/Render de conteúdo | `overlay_window.cpp` (zonas, Headline+Âncoras, Micro_Footer) | 2, 3, 5, 15 |
| Parser de layout rico | `suggestion_format.hpp` | 5 |
| Streaming sem jitter | `overlay_window.cpp` (buffer de palavras, coalescência, expansão) | 6 |
| Trigger Lock | `overlay_window.cpp` (modelo da pergunta congelada) | 8 |
| Modo Setup/Ao Vivo | `overlay_window.cpp` (`OverlayOptions`, estados de edição) | 7 |
| Decisão/Anti-substituição | `decision_policy.hpp`, `copilot_engine.cpp` | 9 |
| Prompt teleprompter | `copilot_prompt.hpp` | 4 |

## Components and Interfaces

### 1. `overlay_window.cpp` / `overlay_window.hpp`

#### 1.1 Constantes de layout corrigidas (Req 1, Req 2, Req 3)

O defeito a corrigir é a largura. As constantes de tipografia e espaçamento já estão corretas; as de largura e ancoragem precisam mudar:

```cpp
// --- ANTES (quebrado, layout largo) ---
// constexpr float kHudW = 820.0f;
// constexpr float kMinW = 720.0f;
// constexpr float kMaxW = 960.0f;

// --- DEPOIS (HUD glanceable de coluna única) ---
constexpr float kHudW   = 480.0f;   // default (Req 1.2)
constexpr float kMinW   = 460.0f;   // clamp inferior (Req 1.3)
constexpr float kMaxW   = 540.0f;   // clamp superior (Req 1.3)

constexpr float kAnchorTopMin = 8.0f;   // Req 1.1
constexpr float kAnchorTopMax = 10.0f;  // Req 1.1
constexpr float kAnchorTop    = 9.0f;   // valor usado por default

// já existentes e mantidos:
constexpr float kMargin = 6.0f;          // Req 2.2 (gap entre zonas)
constexpr float kGap = 6.0f;             // Req 2.2
constexpr float kRadius = 14.0f;
constexpr float kUnifiedStripH = 38.0f;  // Req 2.3 (36..38)
constexpr float kHeadlineSize = 15.5f;   // Req 3.1
constexpr float kBulletSize = 13.5f;     // Req 3.5
constexpr float kMinAnswerH = 110.0f;    // Req 6.1 (>= 2 linhas pré-alocadas)

constexpr float kMaxHeightFractionMin = 0.1f;   // Req 1.7
constexpr float kMaxHeightFractionMax = 1.0f;   // Req 1.7
constexpr float kMaxHeightFractionDefault = 0.6f;
```

Clamp de largura e de fração de altura centralizados numa função pura, testável fora do Win32:

```cpp
// pura (Req 1.3, 1.7) — vive em overlay_window.cpp ou ui_models.hpp
inline float clamp_width(float w) {
    return std::clamp(w, kMinW, kMaxW); // < 460 -> 460; > 540 -> 540
}
inline float clamp_height_fraction(float f) {
    return std::clamp(f, kMaxHeightFractionMin, kMaxHeightFractionMax);
}
```

`OverlayOptions::width_dip` passa a default `480.0f` (hoje `860.0f`) e `max_height_fraction` permanece `0.6f`.

#### 1.2 Ancoragem Top-Center e multi-monitor (Req 1)

No `create()` e no reposicionamento, a posição horizontal é derivada da largura efetiva e da work area do monitor:

```cpp
// Req 1.1, 1.4, 1.5, 1.9 — resolve posição/monitor
struct AnchorResult { int x_dip; int y_dip; RECT work_area; };

AnchorResult resolve_anchor(std::optional<POINT> persisted_center,
                            float eff_width,
                            const RECT& primary_work,
                            std::function<std::optional<RECT>(POINT)> monitor_of);
// Regras:
//  - sem posição persistida -> work area do monitor primário (Req 1.5),
//    y = clamp(kAnchorTop, 8, 10) do topo (Req 1.1);
//  - x = round((work.width - eff_width) / 2) (Req 1.4);
//  - com posição persistida -> monitor que contém o centro persistido (Req 1.5);
//  - se o centro persistido não intersecta nenhum monitor -> Top-Center do
//    primário com dimensões default (Req 1.9).
```

Altura segue o conteúdo até o teto `clamp_height_fraction(max_height_fraction) * work.height` (Req 1.6, 1.7). Quando o conteúdo excede o teto, a janela trava no teto e o **card de resposta** vira a área rolável, preservando o topo do conteúdo (Req 1.8). O scroll é interno ao card (offset no modelo plano), não redimensiona a janela.

#### 1.3 As três zonas empilhadas (Req 2, Req 3, Req 15)

`render()` empilha, de cima para baixo, com `kGap=6` entre zonas e sem sobreposição (Req 2.1, 2.2):

1. **Strip_Unificada** (altura 36–38 DIP, Req 2.3): dois toggles de captura (sistema/`Loopback` e microfone/`Microphone`), cada um com ponto de gravação + indicador de nível (Req 2.4, 2.5, 2.6); reticências (`kBtnMenu`, ícone `ellipsis-vertical`) alinhado à direita recolhendo toda a configuração (Req 2.7). A densidade responsiva usa `ui::pick_density()` já existente: abaixo do limiar de colapso mostra só ícones; acima mostra rótulos + key hints (Req 2.8, 2.9).
2. **Headline + Âncoras** (Req 3): headline em linha única 15.5 DIP SemiBold branco (Req 3.1), truncada com reticências se exceder a largura (Req 3.2, sem quebra de linha); exatamente 3 âncoras (Req 3.3), preenchendo com âncoras vazias quando há menos de 3 (Req 3.4); termo-chave (1–24 chars até o primeiro `:`) em negrito na cor de destaque, resto em `rgba(255,255,255,0.78)` a 13.5 DIP (Req 3.5); cor de destaque `rgb(10,132,255)` (acento) ou branco (mono) conforme paleta (Req 3.6); tipografia dimensionada para 45–55 chars/linha em 480 DIP (Req 3.7); âncora truncada com reticências se exceder (Req 3.8).
3. **Micro_Footer** (Req 15): hints de atalho (detalhar, exemplo de código) com rótulo + combinação (Req 15.1); telemetria TTFT/total em ms inteiros ao receber `SuggestionDoneEvent` (Req 15.2), com indicador de indisponível quando `ttft_ms < 0` ou `total_ms` inválido (Req 15.3); navegação "N de M" (Req 15.4), com "1 de 1" e setas desabilitadas quando M=1 (Req 15.5); controles de feedback 👍/👎 (`kVoteUp`/`kVoteDown`, Req 15.6) publicando `FeedbackEvent` com `vote=+1/-1` (Req 15.7) e `vote=0` ao reclicar o voto já ativo (Req 15.8).

A `Palette` dark glass existente ganha os tokens de destaque `accent = rgb(10,132,255)` e `mono = branco`, selecionados por uma flag `palette_accent` em `OverlayOptions`.

#### 1.4 Streaming sem jitter (Req 6)

Estado no modelo plano, aplicado durante o dreno:

```cpp
struct StreamBuffer {
    std::string committed;   // só termina em separador de palavra (Req 6.2, 6.5)
    std::string pending;     // cauda sem separador, retida (Req 6.2)
};
// commit_words(pending_delta): move para `committed` tudo até o último
// separador de palavra (espaço/pontuação/\n); o resto fica em `pending`.
// No SuggestionCompletedEvent: committed += pending; pending.clear(); (Req 6.6)
```

`SuggestionStartedEvent` pré-aloca o card com `kMinAnswerH` (≥2 linhas, Req 6.1) e arma um timeout de 5 s (`kTimerAnim` ou um deadline no modelo): se nenhum delta chegar, mantém a altura mínima e mostra um indicador de espera sem encolher (Req 6.7). A coalescência já é garantida pelo `kTimerRender` de 16 ms: o dreno marca `dirty=true`, o timer dispara ≤1 render por 16 ms (Req 6.3). A expansão de altura usa `ui::approach()` com `tau` ajustado para um ease-out de ~150 ms, em blocos de 1 linha (Req 6.4).

#### 1.5 Trigger Lock (Req 8)

No dreno de `SuggestionStartedEvent`, o modelo captura `trigger_text` verbatim:

```cpp
struct FrozenQuestion {
    std::string full;        // texto completo capturado (Req 8.4 preserva internamente)
    std::string display;     // primeiros 280 chars + "…" se full.size()>280 (Req 8.4)
    bool present{false};     // false -> indicador de ausência + ícone de citação (Req 8.5)
    std::uint64_t suggestion_id{0};
};
```

Enquanto a resposta está exibida, `TranscriptUpdateEvent` só altera a Strip_Unificada; a `FrozenQuestion` permanece byte a byte idêntica (Req 8.2, 8.3). O cabeçalho exibe ícone de citação sempre (Req 8.1, 8.5).

#### 1.6 Pin on Speak — lado da UI (Req 9)

O overlay mantém a fila de pendentes e o estado da pílula "nova pergunta":

```cpp
struct SuggestionQueue {
    std::deque<SuggestionStartedEvent> pending; // máx 5, FIFO (Req 9.5)
    void push(SuggestionStartedEvent e) {
        pending.push_back(std::move(e));
        while (pending.size() > 5) pending.pop_front(); // descarta a mais antiga
    }
};
bool new_question_pill{false}; // Req 9.2 ("Nova pergunta detectada (Aperte [Tab] para ver)")
```

[Tab] promove a próxima sugestão e remove a pílula (Req 9.3). A janela de 4000 ms é a **mesma** `cooldown_ms=4000` da `DecisionPolicy` (não um novo timer): quando expira sem fala e há pendente, o card é substituído pela próxima da fila (Req 9.6). Atividade de voz curta (<300 ms) dentro da janela mantém o card atual (Req 9.4).

#### 1.7 Hotkeys globais (Req 12)

As hotkeys hoje são `Ctrl+Alt+<tecla>`. O redesenho adiciona/ajusta as combinações do Req 12 via `RegisterHotKey`, estendendo o enum `HotkeyId`:

```cpp
enum HotkeyId : int {
    kHkAnswer = 1, kHkShot, kHkChat, kHkPrev, kHkNext, kHkRecap, kHkPause,
    kHkClearAnswers, kHkClearStrip, kHkHide, kHkClick, kHkConfig, kHkQuit,
    // novas (Req 12):
    kHkAnswerNow,   // Alt+Espaço e Ctrl+Espaço (Req 12.1/12.2)
    kHkHistPrev,    // Alt+Seta Cima (Req 12.3/12.4)
    kHkHistNext,    // Alt+Seta Baixo (Req 12.3/12.4)
    kHkQuick1,      // Alt+1: versão curta em tópicos (Req 12.5)
    kHkQuick2,      // Alt+2: exemplo do currículo (Req 12.6)
    kHkQuick3,      // Alt+3: código + complexidade (Req 12.7)
    kHkPanic,       // Alt+H: toggle Modo_Panic (Req 12.8/12.9)
    kHkLast
};
// keys[] ganha: {kHkAnswerNow, MOD_ALT, VK_SPACE, "Alt+Espaço"} e também
// {kHkAnswerNow2, MOD_CONTROL, VK_SPACE, "Ctrl+Espaço"}; Alt+Up/Down; Alt+1..3; Alt+H.
```

`Alt+Espaço` com buffer do montador de turnos vazio é ignorado e publica `NoticeEvent{Info}` (Req 12.2). Navegação de histórico limita a 50 respostas (`kMaxHistory` sobe para 50) e publica `NoticeEvent{Info}` no fim do histórico (Req 12.4). Falha de `RegisterHotKey` publica `NoticeEvent{Warning}` nomeando o atalho em conflito e preserva os demais (Req 12.10).

#### 1.8 Modo Setup / Modo Ao Vivo e Modo_Panic (Req 7, Req 12.8/12.9)

```cpp
enum class UiMode { Setup, AoVivo };
struct ModeState {
    UiMode mode{UiMode::AoVivo};
    bool panic{false};
    float pre_panic_opacity{1.0f};
    SIZE  pre_panic_size{};   // restaurado no toggle (Req 12.9)
};
```

Em `AoVivo`, os controles de edição de currículo, chave de API, modelo, idioma e vaga ficam desabilitados e tentativas de edição são rejeitadas preservando o valor, com indicação "editável só no Modo_Setup" (Req 7.1, 7.2, 7.5). A barra encolhe para a pílula de 36–38 DIP (Req 7.3). Em `Setup`, os mesmos controles ficam habilitados (Req 7.4). `Alt+H` ativa/desativa o `Modo_Panic` (opacidade 0% ou ponto 8×8 DIP) em ≤50 ms, restaurando opacidade/tamanho anteriores (Req 12.8, 12.9).

#### 1.9 Zero-Focus-Steal e anti-captura (Req 10, Req 11, Req 14)

```cpp
// Estilos na criação (Req 10.1, 11.2, 11.3):
DWORD ex_style = WS_EX_LAYERED | WS_EX_TOPMOST
               | WS_EX_NOACTIVATE   // Req 10.1
               | WS_EX_TOOLWINDOW;  // Req 11.2 (fora da taskbar/Alt+Tab, Req 11.3)

// WndProc:
case WM_MOUSEACTIVATE: return MA_NOACTIVATE; // Req 10.2 (<=16 ms, caminho direto)

// Após criar a janela (Req 11.1, 11.4, 11.5):
if (!SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)) {
    post_notice(NoticeLevel::Warning, "Exclusão de captura indisponível"); // Req 11.4
    capture_excluded = false;
} else {
    capture_excluded = true; // estado observável (Req 11.5)
}
```

Foco do chat (Req 10.4–10.7): ao ativar o campo de chat, guarda `prev_focus = GetForegroundWindow()` e adquire foco de teclado; ao concluir/cancelar, restaura `prev_focus` em ≤100 ms. Se a restauração falha, libera o foco sem retê-lo e publica `NoticeEvent{Warning}` (Req 10.6); se não havia janela registrada, libera sem transferir (Req 10.7). Cliques em botões executam a ação sem transferir foro (a janela nunca ativa), mantendo a mesma foreground window antes/depois (Req 10.3).

Renderização de texto (Req 14): todo `DrawTextLayout`/`DrawText` usa `D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT` e o render target aplica `D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE` (Req 14.1). A composição é per-pixel alpha via `UpdateLayeredWindow` (Req 14.2). Cada glifo recebe contorno/sombra ≥1 px e opacidade ≥60% para garantir contraste ≥4.5:1 (Req 14.3). `IDWriteTextLayout` é cacheado por bloco e reutilizado enquanto o texto não muda (Req 14.4); se a criação/atualização do layout falha, mantém o último cache válido, preserva o quadro anterior e registra um evento de erro (Req 14.5).

#### 1.10 Micro-animações (Req 13)

A `Pulse_Bar` (3 micro-barras de 12 DIP de largura) substitui o spinner: altura mapeada do RMS (0.0→2 DIP, ≥1.0→24 DIP), atualizada a 60 fps via `kTimerAnim` (Req 13.1); RMS indisponível mantém as 3 barras em 2 DIP (Req 13.5). Shimmer horizontal na borda superior do card oscila opacidade 0.04↔0.12 em ciclo de 1200 ms durante geração (Req 13.2). Novas linhas entram com fade-in de 0→1 em 200 ms (Req 13.3). Nenhum spinner giratório é renderizado em qualquer estado (Req 13.4) — o `draw_spinner` existente é removido dos caminhos de estado.

### 2. `suggestion_format.hpp` — Rich_Layout_Parser (Req 5)

O parser já existe (`format_suggestion`, `detail::parse_bold`). Ajustes para alinhar ao Req 5:

- A **primeira linha não vazia** vira a Headline, renderizada na cor de destaque a 15.5 DIP (Req 5.1). Hoje o parser classifica a primeira linha como `Paragraph`; o overlay passa a tratar a primeira `FormattedLine` do resultado como Headline.
- Texto vazio/só espaços retorna **lista vazia** de linhas; o overlay não renderiza headline nem bullets e preserva o texto original sem modificar (Req 5.2). `format_suggestion` já ignora linhas vazias; adicionamos a garantia de que a entrada em branco produz `{}`.
- Bullet **com** `:` → termo antes do primeiro `:` na cor de destaque, resto na cor secundária (Req 5.3) — exatamente o `bold_prefix_until_colon` já implementado em `parse_bold`.
- Bullet **sem** `:` → tudo na cor secundária (Req 5.4).
- `**...**` → interno em negrito, delimitadores removidos (Req 5.5); `**` de abertura sem fechamento na mesma linha → asteriscos literais sem negrito (Req 5.6). **Atenção:** o comportamento atual de `parse_bold` renderiza `**` não fechado como negrito até o fim da linha (útil no streaming). Para o texto final (Req 5.6) o overlay deve chamar o parser em modo "não-streaming" que trata `**` órfão como literal. Proposta: um flag `bool streaming` em `format_suggestion`:

```cpp
// Req 5.5, 5.6 — fechamento órfão
std::vector<FormattedLine> format_suggestion(std::string_view body, bool streaming = false);
// streaming=true  -> ** órfão fica em negrito até o fim (jitter mínimo ao vivo)
// streaming=false -> ** órfão vira texto literal "**" (comportamento do Req 5.6)
```

- Qualquer número de bullets entre 0 e 20 é renderizado **sem inserir, remover ou reordenar** conteúdo textual (Req 5.7): a concatenação de todos os `TextSegment::text` de todas as linhas (descontando apenas os `**` consumidos e o prefixo de bullet `- `/`* `/`•`) é uma subsequência estável da entrada.

### 3. `decision_policy.hpp` / `copilot_engine.cpp` — gate de voz e fila (Req 9)

A `DecisionPolicy` permanece dona da orchestrator thread, não thread-safe. Reutilizamos `cooldown_ms=4000` como a janela de 4 s do Req 9. Adicionamos o conceito de "usuário está falando" como **gate extra** consultado pelo engine antes de publicar `SuggestionStartedEvent`:

```cpp
// decision_policy.hpp — novo estado consultável (orchestrator thread)
struct UserSpeechGate {
    // Atividade contínua de voz no mic local (AudioSource::Microphone) por
    // >= 300 ms acima do limiar, OU tecla de fala pressionada (Req 9.1).
    bool active{false};
    std::int64_t voiced_since_ms{-1};
    bool ptt_down{false};

    void on_mic_rms(float rms, float threshold, std::int64_t now_ms) {
        if (rms >= threshold) {
            if (voiced_since_ms < 0) voiced_since_ms = now_ms;
            active = (now_ms - voiced_since_ms) >= 300; // Req 9.1
        } else {
            voiced_since_ms = -1;
            active = ptt_down;
        }
    }
    [[nodiscard]] bool should_pin() const noexcept { return active || ptt_down; }
};
```

Fluxo no `copilot_engine.cpp` quando um turno fecha e `DecisionPolicy::evaluate()` retorna um gatilho:

1. Se `UserSpeechGate::should_pin()` ou se estamos dentro de `cooldown_ms` do último card → **não substitui**. Em vez de publicar e trocar o card, publica o `SuggestionStartedEvent` marcado para **enfileirar** (o overlay o coloca na `SuggestionQueue`, máx 5, FIFO) e mostra a pílula "nova pergunta" (Req 9.2, 9.5).
2. Quando a janela de 4000 ms expira sem fala, o engine libera a próxima pendente para substituição (Req 9.6). O upgrade pergunta-após-keyword já existente em `evaluate()` é preservado.

O `UserSpeechGate` é alimentado pelo mesmo caminho de RMS do mic que o overlay já usa em `poll_levels()`; no engine, os frames de `AudioSource::Microphone` alimentam `on_mic_rms()`.

### 4. `copilot_prompt.hpp` — ajuste fino do teleprompter (Req 4)

`copilot_system_prompt()` já cobre Req 4.1, 4.2, 4.3, 4.4, 4.6, 4.7 e as regras de não reescrever `[Outros]`/não inventar fatos. `build_copilot_messages()` já envia `trigger_text` verbatim. O único gap é **o caso 4.5 explícito** (quando a pergunta não é comportamental nem system design, os 3 bullets começam com 2–3 palavras-chave em negrito escolhidas pelo modelo + `:`). Hoje a regra 2 cobre isso implicitamente; o ajuste é tornar o fallback explícito logo após as regras 3 e 4:

```
"6. CASO GERAL (nem comportamental nem system design/arquitetura): "
"comece cada um dos 3 bullets com 2 a 3 palavras-chave em **negrito** "
"escolhidas por você, seguidas de \":\"."
```

e renumerar o teto de tokens. Nenhuma mudança em `build_copilot_messages()` é necessária além de manter o `trigger_text` literal. Isto é uma edição de string, não uma reescrita do componente.

## Data Models

Todos os structs abaixo vivem no **modelo plano** da UI thread (POD, sem I/O), atualizados durante o dreno e lidos pelo render. Os puros (clamp, parser, gate) são testáveis fora do Win32.

```cpp
// --- Modo e panic (Req 7, Req 12.8/12.9) ---
enum class UiMode { Setup, AoVivo };
struct ModeState { UiMode mode; bool panic; float pre_panic_opacity; SIZE pre_panic_size; };

// --- Pergunta congelada (Req 8) ---
struct FrozenQuestion { std::string full; std::string display; bool present; std::uint64_t suggestion_id; };

// --- Card de resposta (Req 3, Req 5, Req 6, Req 15) ---
struct AnswerCard {
    std::uint64_t id{0};
    std::vector<FormattedLine> lines;  // [0] = Headline; demais = bullets (do parser)
    StreamBuffer stream;               // committed/pending (Req 6)
    float height{kMinAnswerH};         // alvo animado (Req 6.4)
    float scroll_offset{0.0f};         // Req 1.8 (card rolável sob o teto)
    bool waiting{false};               // Req 6.7 (timeout de 5 s sem delta)
    // telemetria do footer (Req 15.2/15.3)
    std::int64_t ttft_ms{-1};
    std::int64_t total_ms{-1};
    int vote{0};                       // -1/0/+1 (Req 15.7/15.8)
};

// --- Fila de pendentes (Req 9) ---
struct SuggestionQueue { std::deque<SuggestionStartedEvent> pending; /* push(): máx 5 FIFO */ };

// --- Histórico (Req 12.3, Req 15.4/15.5) ---
struct History { std::deque<AnswerCard> items; /* máx 50 */ std::size_t cursor{0}; };
// "N de M": N = cursor+1 (1..M), M = items.size() (1..999)

// --- Strip_Unificada: toggles e níveis (Req 2.4-2.6, Req 13) ---
struct CaptureToggle { bool enabled; float level01; bool recording_dot; };
struct StripState {
    CaptureToggle system;   // AudioSource::Loopback
    CaptureToggle mic;      // AudioSource::Microphone
    float pulse_bar_h[3];   // alturas animadas 2..24 DIP (Req 13.1/13.5)
};

// --- Cache de layouts por bloco (Req 14.4/14.5) ---
struct LayoutCacheEntry {
    std::wstring text; float width; ComPtr<IDWriteTextLayout> layout; bool valid;
};
// chave = (bloco lógico: headline / âncora i / footer / pergunta congelada)

// --- Gate de voz (Req 9.1) — vive no núcleo, orchestrator thread ---
struct UserSpeechGate { bool active; std::int64_t voiced_since_ms; bool ptt_down; /* should_pin() */ };

// --- Estado global da UI ---
struct UiState {
    float width{kHudW};                // sempre via clamp_width (Req 1.3)
    float max_height_fraction{0.6f};   // via clamp_height_fraction (Req 1.7)
    ModeState modes;
    FrozenQuestion question;
    AnswerCard card;
    SuggestionQueue queue;
    History history;
    StripState strip;
    bool capture_excluded{false};      // Req 11.5 (observável)
    bool new_question_pill{false};     // Req 9.2
    HWND prev_focus{nullptr};          // Req 10.4/10.5
    bool palette_accent{true};         // Req 3.6
};
```

## Correctness Properties

*Uma propriedade é uma característica ou comportamento que deve valer para todas as execuções válidas do sistema — essencialmente uma afirmação formal sobre o que o sistema deve fazer. Propriedades são a ponte entre a especificação legível por humanos e as garantias de correção verificáveis por máquina.*

As propriedades abaixo cobrem exclusivamente as **funções puras** do redesenho, testáveis fora do Win32: `clamp_width`, `clamp_height_fraction`, `resolve_anchor`, a normalização de âncoras, o parser `format_suggestion`/`parse_bold` (`suggestion_format.hpp`), `StreamBuffer::commit_words`, `FrozenQuestion`, `UserSpeechGate`, `SuggestionQueue::push`, o mapeamento RMS→altura da Pulse_Bar e a navegação de histórico. Comportamentos ligados a Win32/Direct2D/temporizadores (foco, captura, hotkeys, animações, contraste, coalescência de render) ficam na Testing Strategy como testes de integração/manuais.

### Property 1: clamp_width mantém a largura em [460,540] e é idempotente

*Para toda* largura `w` (dentro, abaixo ou acima do intervalo), `clamp_width(w)` retorna um valor em `[460, 540]`; valores abaixo de 460 tornam-se 460 e valores acima de 540 tornam-se 540; e `clamp_width(clamp_width(w)) == clamp_width(w)`.

**Validates: Requirements 1.3**

### Property 2: clamp_height_fraction mantém a fração em [0.1,1.0] e é idempotente

*Para toda* fração `f`, `clamp_height_fraction(f)` retorna um valor em `[0.1, 1.0]`; valores abaixo de 0.1 tornam-se 0.1 e acima de 1.0 tornam-se 1.0; e aplicar a função duas vezes produz o mesmo resultado.

**Validates: Requirements 1.7**

### Property 3: resolve_anchor centraliza horizontalmente e ancora no topo

*Para toda* área de trabalho de largura `work.w` e largura efetiva `eff_w`, sem posição persistida, `resolve_anchor` define `x = round((work.w - eff_w) / 2)` e `y` em `[8, 10]` DIP a partir do topo.

**Validates: Requirements 1.1, 1.4**

### Property 4: resolve_anchor seleciona o monitor correto

*Para todo* ponto central persistido e qualquer conjunto de monitores, `resolve_anchor` usa a área de trabalho do monitor que contém o centro persistido; se nenhum monitor contém o centro, usa o monitor primário em Top-Center com as dimensões padrão.

**Validates: Requirements 1.5, 1.9**

### Property 5: altura da janela é o mínimo entre conteúdo e teto

*Para toda* altura de conteúdo e teto `clamp_height_fraction(frac) * work.h`, a altura resultante da janela é `min(conteúdo, teto)` e nunca excede o teto.

**Validates: Requirements 1.6**

### Property 6: a resposta sempre exibe exatamente 3 âncoras

*Para toda* lista de 0 a N âncoras disponíveis, a normalização produz exatamente 3 posições, preservando as âncoras presentes na ordem original e preenchendo as restantes com âncoras vazias.

**Validates: Requirements 3.3, 3.4**

### Property 7: a primeira linha não vazia é a Headline

*Para todo* texto de resposta não vazio, a primeira `FormattedLine` produzida pelo parser corresponde à primeira linha não vazia da entrada e é classificada como Headline.

**Validates: Requirements 5.1**

### Property 8: texto vazio ou só de espaços produz lista vazia e preserva o original

*Para toda* string composta apenas de espaços em branco (incluindo string vazia), `format_suggestion` retorna uma lista vazia de linhas e a entrada original permanece inalterada (sem headline nem bullets).

**Validates: Requirements 5.2**

### Property 9: bullet com ':' separa termo-chave de destaque e resto secundário

*Para todo* bullet que contenha ao menos um `:`, o parser coloca em destaque o termo-chave (os caracteres 1–24 antes do primeiro `:`) e o restante na cor secundária, usando sempre o **primeiro** `:` como separador.

**Validates: Requirements 3.5, 5.3**

### Property 10: bullet sem ':' fica inteiramente em cor secundária

*Para todo* bullet que não contenha `:`, o parser renderiza todo o texto na cor secundária, sem nenhum segmento de destaque.

**Validates: Requirements 5.4**

### Property 11: pares `**...**` viram negrito com delimitadores removidos

*Para todo* texto com um ou mais pares de `**` corretamente fechados, o conteúdo interno é marcado como negrito e os `**` delimitadores não aparecem no texto exibido.

**Validates: Requirements 5.5**

### Property 12: `**` órfão é literal em modo não-streaming

*Para toda* linha contendo um `**` de abertura sem fechamento na mesma linha, com `streaming=false` o parser renderiza os asteriscos como texto literal sem aplicar negrito; com `streaming=true` o trecho fica em negrito até o fim da linha.

**Validates: Requirements 5.6**

### Property 13: o parser preserva o conteúdo textual como subsequência estável

*Para todo* corpo de resposta com qualquer número de bullets entre 0 e 20, a concatenação, em ordem, de todos os `TextSegment::text` de todas as linhas — descontando apenas os `**` consumidos e o prefixo de bullet (`- `, `* `, `•`) — é uma subsequência estável da entrada: nenhum caractere de conteúdo é inserido, removido ou reordenado.

**Validates: Requirements 5.7**

### Property 14: commit_words nunca confirma palavra parcial

*Para toda* sequência de deltas aplicada a `StreamBuffer::commit_words`, o buffer `committed` termina sempre em um separador de palavra (espaço, pontuação ou quebra de linha) ou está vazio, e `pending` contém apenas a cauda sem separador — nenhuma palavra parcial aparece em `committed`.

**Validates: Requirements 6.2, 6.5**

### Property 15: o streaming preserva a entrada byte a byte ao concluir

*Para toda* sequência de deltas, após aplicar `commit_words` em cada delta e esvaziar `pending` em `committed` no `SuggestionCompletedEvent`, o `committed` final é exatamente igual, byte a byte, à concatenação de todos os deltas recebidos (`committed + pending` preserva a entrada em qualquer instante).

**Validates: Requirements 6.6**

### Property 16: a pergunta congelada permanece idêntica sob TranscriptUpdate

*Para toda* sequência de `TranscriptUpdateEvent` recebida enquanto uma resposta está exibida, `FrozenQuestion.full` permanece byte a byte idêntico ao texto capturado no disparo, sem alteração, substituição ou anexação.

**Validates: Requirements 8.2, 8.3**

### Property 17: o display da pergunta trunca em 280 preservando o texto completo

*Para todo* texto de pergunta, se o comprimento for ≤ 280 o `display` é igual ao texto; se for > 280 o `display` é os primeiros 280 caracteres seguidos de reticências; em ambos os casos `full` preserva o texto completo capturado.

**Validates: Requirements 8.4**

### Property 18: should_pin é verdadeiro sse voz contínua ≥ 300 ms ou PTT

*Para toda* série temporal de `(rms, threshold, now_ms, ptt_down)` aplicada a `UserSpeechGate::on_mic_rms`, `active` torna-se verdadeiro se e somente se houver voz contínua acima do limiar por ≥ 300 ms, e `should_pin()` é verdadeiro se e somente se `active || ptt_down`. Atividade contínua inferior a 300 ms não fixa o card por voz.

**Validates: Requirements 9.1, 9.4**

### Property 19: a fila de pendentes nunca excede 5 e descarta a mais antiga (FIFO)

*Para toda* sequência de N inserções em `SuggestionQueue::push`, o tamanho da fila é sempre ≤ 5 e, quando N > 5, o conteúdo é exatamente as últimas 5 sugestões na ordem de inserção, tendo descartado as mais antigas.

**Validates: Requirements 9.5**

### Property 20: a altura da Pulse_Bar mapeia o RMS em [2,24] de forma monótona

*Para todo* valor RMS, a altura de cada micro-barra fica em `[2, 24]` DIP e é monótona não-decrescente em relação ao RMS; RMS ≤ 0.0 ou indisponível mapeia para 2 DIP e RMS ≥ 1.0 mapeia para 24 DIP.

**Validates: Requirements 13.1, 13.5**

### Property 21: a navegação "N de M" respeita os limites do histórico

*Para toda* sequência de inserções (inclusive mais de 50) e navegação, o histórico armazena no máximo 50 respostas, a posição exibida satisfaz `1 ≤ N ≤ M ≤ 999` e o cursor permanece sempre dentro dos limites válidos.

**Validates: Requirements 12.3, 15.4**

## Error Handling

O tratamento de erros segue o princípio de **degradação graciosa**: nenhum caminho de falha derruba a UI thread ou deixa o HUD inoperante. Falhas de serviços do sistema viram `NoticeEvent` (nível `Warning` ou `Info`) e o HUD continua operacional com o melhor estado disponível.

| Falha / caminho de borda | Tratamento | Requisito |
|---|---|---|
| `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` falha ou indisponível na versão do Windows | Publica `NoticeEvent{Warning}` ("exclusão de captura indisponível"), define `capture_excluded=false` e mantém a janela totalmente operacional com interação inalterada | 11.4 |
| `RegisterHotKey` falha para um atalho (conflito) | Publica `NoticeEvent{Warning}` nomeando o atalho em conflito e preserva todos os demais atalhos registrados com sucesso | 12.10 |
| Restauração de foco do chat à janela anterior falha | Libera o foco de teclado sem retê-lo e publica `NoticeEvent{Warning}` indicando a falha de restauração | 10.6 |
| Nenhuma janela de foco anterior registrada ao concluir/cancelar o chat | Libera o foco sem transferi-lo a qualquer janela (sem erro) | 10.7 |
| Criação/atualização de `IDWriteTextLayout` de um bloco falha | Mantém o último `LayoutCacheEntry` válido daquele bloco, preserva o quadro anterior exibido e registra um evento de erro de renderização do bloco | 14.5 |
| Timeout de 5 s após `SuggestionStartedEvent` sem nenhum delta | Mantém a altura mínima pré-alocada (`kMinAnswerH`), exibe indicador visual de espera e não reduz a altura do card | 6.7 |
| `SuggestionDoneEvent` sem telemetria válida (`ttft_ms < 0` ou `total_ms` inválido) | Exibe o indicador de "indisponível" no campo correspondente do Micro_Footer e preserva os demais campos de telemetria já exibidos | 15.3 |
| Posição persistida fora da área de trabalho de qualquer monitor | `resolve_anchor` reposiciona em Top-Center do monitor primário com as dimensões padrão (480 DIP, borda superior 8–10 DIP) | 1.9 |
| `Alt+Espaço`/`Ctrl+Espaço` com buffer do montador de turnos vazio | Ignora o acionamento e publica `NoticeEvent{Info}` indicando ausência de conteúdo | 12.2 |
| Navegação de histórico no fim do histórico (sem resposta anterior) | Mantém a resposta atual exibida e publica `NoticeEvent{Info}` indicando o fim do histórico | 12.4 |

Princípios transversais:

- **Entrada vazia no parser** (Req 5.2): `format_suggestion` retorna lista vazia para texto em branco; o render não desenha headline nem bullets e o texto original é preservado — tratado como caminho normal, não exceção.
- **Valores fora de faixa** de largura e fração de altura são sempre travados (`clamp_width`, `clamp_height_fraction`) em vez de rejeitados, garantindo que o HUD nunca assume dimensões inválidas.
- **Fila cheia** (Req 9.5): o estouro do limite de 5 não é erro; descarta-se silenciosamente a sugestão mais antiga (FIFO).

## Testing Strategy

A estratégia combina **testes unitários/property-based** para toda a lógica pura e **testes de integração/manuais** para os comportamentos acoplados ao Win32/Direct2D que não podem ser automatizados de forma confiável.

### Abordagem de testes de propriedade (PBT)

As 21 propriedades da seção Correctness Properties são implementadas com o framework de testes já presente no projeto, usando geração aleatória de entradas. Cada teste de propriedade:

- Roda no mínimo **100 iterações** por propriedade (devido à randomização).
- É anotado com um comentário referenciando a propriedade de design no formato **Feature: glanceable-hud-overlay, Property {número}: {texto}**.
- Implementa **exatamente uma** propriedade por teste.

Alvos puros, todos exercitáveis fora do Win32:

- `clamp_width`, `clamp_height_fraction` — faixa/idempotência (Props 1, 2).
- `resolve_anchor` — centralização horizontal, faixa de `y`, seleção de monitor e fallback primário (Props 3, 4, 5).
- Normalização de âncoras para exatamente 3 posições (Prop 6).
- `format_suggestion` / `detail::parse_bold` em `suggestion_format.hpp` — headline, bullet com/sem `:`, negrito `**`, `**` órfão com a flag `streaming`, subsequência estável do conteúdo e entrada vazia (Props 7–13). O parser é testado com **dois conjuntos de entradas**: fluxos de *streaming* (`streaming=true`, `**` órfão em negrito) e texto *final* (`streaming=false`, `**` órfão literal). Por ser um parser, a verificação de subsequência estável (Prop 13) e a preservação byte a byte funcionam como garantia de "round-trip" do conteúdo.
- `StreamBuffer::commit_words` — ausência de palavra parcial e preservação byte a byte ao concluir (Props 14, 15).
- `FrozenQuestion` — congelamento sob `TranscriptUpdateEvent` e truncamento em 280 (Props 16, 17).
- `UserSpeechGate::on_mic_rms` / `should_pin` — gate de voz ≥ 300 ms / PTT, incluindo o caso de borda de voz curta (Prop 18).
- `SuggestionQueue::push` — limite 5 FIFO (Prop 19).
- Mapeamento RMS→altura da Pulse_Bar (Prop 20).
- Navegação de histórico "N de M" com cap 50 (Prop 21).

### Testes unitários (exemplos e casos de borda)

Complementam as propriedades com exemplos concretos e caminhos de erro que não se expressam como "para todo":

- Largura padrão 480 DIP na ausência de persistência (Req 1.2).
- Mapeamento de cor de destaque: `accent → rgb(10,132,255)`, `mono → branco` (Req 3.6).
- Presença das instruções no prompt de sistema `copilot_system_prompt()`: tese 1–12 palavras, 3 bullets, rótulos comportamental e system design, caso geral 4.5 explícito, teto 80–120 tokens e proibição de inventar fatos (Req 4.1–4.7).
- Pré-alocação do card com `kMinAnswerH` no `SuggestionStartedEvent` e captura verbatim em `FrozenQuestion.full` (Req 6.1, 8.1); indicador de ausência com `present=false` (Req 8.5).
- Pílula "Nova pergunta" ao enfileirar e promoção via `Tab` (Req 9.2, 9.3).
- Telemetria formatada em ms inteiros e o indicador de indisponível para valores inválidos (Req 15.2, 15.3).
- `M == 1 → "1 de 1"` com navegação desabilitada (Req 15.5).
- Feedback: `up → +1`, reclicar `up → 0`, `down → -1` (Req 15.7, 15.8).
- Caminhos de `NoticeEvent` de nível Info/Warning descritos em Error Handling.

### Testes de integração e manuais (Win32 / Direct2D)

Comportamentos que dependem de janela real, composição ou temporizadores são verificados por integração ou inspeção manual, com 1–3 exemplos representativos (não cabem em PBT):

- **Zero-Focus-Steal** (Req 10): `WS_EX_NOACTIVATE` + retorno `MA_NOACTIVATE` em `WM_MOUSEACTIVATE`; clicar em botões não altera a `GetForegroundWindow()` antes/depois; registro e restauração de foco do chat em ≤ 100 ms.
- **Invisibilidade em captura** (Req 11): `WDA_EXCLUDEFROMCAPTURE` deixa o HUD invisível em compartilhamento de tela; `WS_EX_TOOLWINDOW` o mantém fora da taskbar e do Alt+Tab.
- **Hotkeys globais** (Req 12): `RegisterHotKey` para Alt+Espaço/Ctrl+Espaço, Alt+Setas, Alt+1/2/3, Alt+H respondem sem foco; Modo_Panic alterna opacidade/tamanho em ≤ 50 ms.
- **Composição per-pixel alpha** (Req 14): `UpdateLayeredWindow` preserva o canal alfa por pixel; contorno/sombra ≥ 1 px garante **contraste ≥ 4.5:1** — validado por inspeção visual sobre fundos variados; o cache de `IDWriteTextLayout` é reutilizado quando o texto não muda.
- **Layout e tipografia** (Req 2, 3): ordem das três zonas, gap de 6 DIP, strip em 36–38 DIP, 45–55 chars/linha em 480 DIP e truncamento com reticências — verificados com layout real do DirectWrite.
- **Animações e coalescência** (Req 6, 13): verificação de que o render **coalesce em ≤ 60 fps** (≤ 1 redesenho por 16 ms) sob rajada de deltas, que a expansão usa ease-out de ~150 ms e que a altura não encolhe no timeout de 5 s.
- **Ausência de spinner** (Req 13.4): inspeção de que **nenhum elemento de spinner giratório** é renderizado em qualquer estado — a Pulse_Bar é o único indicador de atividade.

O conjunto PBT + unitário cobre a correção algorítmica das funções puras; o conjunto de integração/manual cobre a conformidade das superfícies Win32 com os requisitos observáveis.
