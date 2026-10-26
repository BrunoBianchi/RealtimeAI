# Implementation Plan: Glanceable HUD Overlay

## Overview

A implementação segue uma ordem incremental: primeiro as **funções puras** (clamp de largura/altura, ancoragem/multi-monitor, normalização de âncoras, parser de layout rico, buffer de streaming, pergunta congelada, gate de voz, fila de pendentes, mapeamento RMS→Pulse_Bar e navegação de histórico) acompanhadas de seus **testes property-based** que validam as 21 Correctness Properties do design, e só então a **integração Win32/Direct2D** (constantes de layout, ancoragem real, três zonas, streaming sem jitter, Trigger Lock, Pin on Speak, hotkeys globais, modos/panic, zero-focus-steal, anti-captura, renderização de texto e micro-footer). O prompt (Req 4) e o parser (Req 5) já estão majoritariamente implementados — as tarefas correspondentes são ajustes pontuais, não reescritas.

As quatro superfícies de código tocadas são:
- `src/overlay/src/overlay_window.cpp` + `src/overlay/include/rtai/overlay_window.hpp`
- `src/core/include/rtai/suggestion_format.hpp`
- `src/core/include/rtai/decision_policy.hpp` + `src/core/src/copilot_engine.cpp`
- `src/core/include/rtai/copilot_prompt.hpp`

A linguagem de implementação é **C++** (projeto Win32 + Direct2D/DirectWrite já existente), com property-based testing no framework de testes já presente no projeto.

## Tasks

- [x] 1. Funções puras de dimensionamento e ancoragem em `ui_models.hpp`
  - [x] 1.1 Implementar `clamp_width` e `clamp_height_fraction` com as constantes de layout
    - Adicionar `kMinW=460`, `kMaxW=540`, `kHudW=480`, `kMaxHeightFractionMin=0.1`, `kMaxHeightFractionMax=1.0`, `kMaxHeightFractionDefault=0.6` em `src/core/include/rtai/ui_models.hpp` (ou cabeçalho compartilhado testável fora do Win32)
    - `clamp_width(w)` trava em `[460,540]`; `clamp_height_fraction(f)` trava em `[0.1,1.0]`
    - _Requirements: 1.3, 1.7_

  - [x] 1.2 Escrever property test para `clamp_width`
    - **Property 1: clamp_width mantém a largura em [460,540] e é idempotente**
    - **Validates: Requirements 1.3**

  - [x] 1.3 Escrever property test para `clamp_height_fraction`
    - **Property 2: clamp_height_fraction mantém a fração em [0.1,1.0] e é idempotente**
    - **Validates: Requirements 1.7**

  - [x] 1.4 Implementar `resolve_anchor` (ancoragem Top-Center e multi-monitor)
    - Definir `struct AnchorResult { int x_dip; int y_dip; RECT work_area; }` e a função pura `resolve_anchor(persisted_center, eff_width, primary_work, monitor_of)` em cabeçalho testável fora do Win32
    - Sem posição persistida → work area do primário, `y` em `[8,10]`, `x = round((work.w - eff_w)/2)`; com posição persistida → monitor que contém o centro; sem interseção → Top-Center do primário com dimensões default
    - _Requirements: 1.1, 1.4, 1.5, 1.9_

  - [x] 1.5 Escrever property test para centralização e ancoragem no topo
    - **Property 3: resolve_anchor centraliza horizontalmente e ancora no topo**
    - **Validates: Requirements 1.1, 1.4**

  - [x] 1.6 Escrever property test para seleção de monitor e fallback
    - **Property 4: resolve_anchor seleciona o monitor correto**
    - **Validates: Requirements 1.5, 1.9**

  - [x] 1.7 Implementar cálculo puro de altura da janela (`min(conteúdo, teto)`)
    - Função pura `window_height(content_h, frac, work_h)` que retorna `min(content_h, clamp_height_fraction(frac) * work_h)`
    - _Requirements: 1.6_

  - [x] 1.8 Escrever property test para altura mínima entre conteúdo e teto
    - **Property 5: altura da janela é o mínimo entre conteúdo e teto**
    - **Validates: Requirements 1.6**

- [x] 2. Normalização de âncoras (exatamente 3 posições)
  - [x] 2.1 Implementar `normalize_anchors` para sempre produzir 3 posições
    - Função pura que recebe 0..N âncoras e retorna exatamente 3, preservando as presentes na ordem original e preenchendo o restante com âncoras vazias
    - _Requirements: 3.3, 3.4_

  - [x] 2.2 Escrever property test para exatamente 3 âncoras
    - **Property 6: a resposta sempre exibe exatamente 3 âncoras**
    - **Validates: Requirements 3.3, 3.4**

- [x] 3. Ajustes no Rich_Layout_Parser em `suggestion_format.hpp` (Req 5)
  - [x] 3.1 Adicionar flag `streaming` e semântica de `**` órfão a `format_suggestion`
    - Alterar a assinatura para `format_suggestion(std::string_view body, bool streaming = false)` em `src/core/include/rtai/suggestion_format.hpp`
    - `streaming=true` mantém o comportamento atual (`**` órfão em negrito até o fim da linha); `streaming=false` trata `**` de abertura sem fechamento como texto literal
    - Garantir que entrada vazia/só espaços retorna `{}` (lista vazia)
    - _Requirements: 5.5, 5.6, 5.2_

  - [x] 3.2 Tratar a primeira linha não vazia como Headline
    - Classificar a primeira `FormattedLine` produzida como Headline (semântica de headline/termo-chave conforme Req 5.1); preservar bullets com/sem `:` e o conteúdo byte a byte
    - _Requirements: 5.1, 5.3, 5.4, 5.7_

  - [x] 3.3 Escrever property test para a Headline como primeira linha não vazia
    - **Property 7: a primeira linha não vazia é a Headline**
    - **Validates: Requirements 5.1**

  - [x] 3.4 Escrever property test para entrada vazia/só espaços
    - **Property 8: texto vazio ou só de espaços produz lista vazia e preserva o original**
    - **Validates: Requirements 5.2**

  - [x] 3.5 Escrever property test para bullet com `:` (termo-chave de destaque)
    - **Property 9: bullet com ':' separa termo-chave de destaque e resto secundário**
    - **Validates: Requirements 3.5, 5.3**

  - [x] 3.6 Escrever property test para bullet sem `:`
    - **Property 10: bullet sem ':' fica inteiramente em cor secundária**
    - **Validates: Requirements 5.4**

  - [x] 3.7 Escrever property test para pares `**...**` fechados
    - **Property 11: pares `**...**` viram negrito com delimitadores removidos**
    - **Validates: Requirements 5.5**

  - [x] 3.8 Escrever property test para `**` órfão com a flag streaming
    - **Property 12: `**` órfão é literal em modo não-streaming**
    - **Validates: Requirements 5.6**

  - [x] 3.9 Escrever property test para preservação de conteúdo como subsequência estável
    - **Property 13: o parser preserva o conteúdo textual como subsequência estável**
    - **Validates: Requirements 5.7**

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Buffer de streaming sem jitter (`StreamBuffer`)
  - [x] 5.1 Implementar `StreamBuffer::commit_words` e esvaziamento na conclusão
    - `commit_words(delta)` move para `committed` tudo até o último separador de palavra (espaço/pontuação/`\n`), retendo a cauda em `pending`; na conclusão `committed += pending; pending.clear()`
    - _Requirements: 6.2, 6.5, 6.6_

  - [x] 5.2 Escrever property test para ausência de palavra parcial
    - **Property 14: commit_words nunca confirma palavra parcial**
    - **Validates: Requirements 6.2, 6.5**

  - [x] 5.3 Escrever property test para preservação byte a byte ao concluir
    - **Property 15: o streaming preserva a entrada byte a byte ao concluir**
    - **Validates: Requirements 6.6**

- [x] 6. Pergunta congelada (`FrozenQuestion`)
  - [x] 6.1 Implementar `FrozenQuestion` com captura verbatim e truncamento em 280
    - `full` guarda o texto completo; `display` = texto se `size<=280`, senão primeiros 280 + reticências; `present=false` quando não há pergunta
    - A aplicação de `TranscriptUpdateEvent` não altera `full` (função/estado puro testável)
    - _Requirements: 8.2, 8.3, 8.4, 8.5_

  - [x] 6.2 Escrever property test para congelamento sob TranscriptUpdate
    - **Property 16: a pergunta congelada permanece idêntica sob TranscriptUpdate**
    - **Validates: Requirements 8.2, 8.3**

  - [x] 6.3 Escrever property test para truncamento do display em 280
    - **Property 17: o display da pergunta trunca em 280 preservando o texto completo**
    - **Validates: Requirements 8.4**

- [x] 7. Gate de voz (`UserSpeechGate`) em `decision_policy.hpp`
  - [x] 7.1 Implementar `UserSpeechGate::on_mic_rms` e `should_pin`
    - Adicionar `struct UserSpeechGate` em `src/core/include/rtai/decision_policy.hpp`: `active` verdadeiro sse voz contínua acima do limiar por `>=300 ms`; `should_pin() == active || ptt_down`
    - _Requirements: 9.1, 9.4_

  - [x] 7.2 Escrever property test para should_pin (voz contínua ≥300 ms ou PTT)
    - **Property 18: should_pin é verdadeiro sse voz contínua ≥ 300 ms ou PTT**
    - **Validates: Requirements 9.1, 9.4**

- [x] 8. Fila de pendentes (`SuggestionQueue`)
  - [x] 8.1 Implementar `SuggestionQueue::push` com cap 5 FIFO
    - `push` adiciona ao fim e descarta a mais antiga quando `size>5` (em `ui_models.hpp` / cabeçalho da UI testável)
    - _Requirements: 9.5_

  - [x] 8.2 Escrever property test para cap 5 FIFO
    - **Property 19: a fila de pendentes nunca excede 5 e descarta a mais antiga (FIFO)**
    - **Validates: Requirements 9.5**

- [x] 9. Mapeamento RMS→altura da Pulse_Bar
  - [x] 9.1 Implementar `pulse_bar_height` (RMS → [2,24] DIP)
    - Função pura monótona não-decrescente: RMS `<=0.0` ou indisponível → 2 DIP; RMS `>=1.0` → 24 DIP; interpolação linear no meio
    - _Requirements: 13.1, 13.5_

  - [x] 9.2 Escrever property test para o mapeamento RMS→altura
    - **Property 20: a altura da Pulse_Bar mapeia o RMS em [2,24] de forma monótona**
    - **Validates: Requirements 13.1, 13.5**

- [x] 10. Navegação de histórico "N de M" (`History`)
  - [x] 10.1 Implementar `History` com cap 50 e navegação com cursor limitado
    - `items` armazena no máx 50 (descartando as mais antigas); "N de M" com `N = cursor+1`, `1 <= N <= M <= 999`; cursor sempre dentro dos limites
    - _Requirements: 12.3, 15.4_

  - [x] 10.2 Escrever property test para navegação "N de M" com cap 50
    - **Property 21: a navegação "N de M" respeita os limites do histórico**
    - **Validates: Requirements 12.3, 15.4**

- [x] 11. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Ajuste fino do prompt teleprompter em `copilot_prompt.hpp` (Req 4)
  - [x] 12.1 Tornar o caso 4.5 explícito em `copilot_system_prompt()`
    - Adicionar regra explícita de caso geral (nem comportamental nem system design): cada um dos 3 bullets inicia com 2–3 palavras-chave em negrito escolhidas pelo modelo + `:`; renumerar o teto de tokens; manter `trigger_text` verbatim em `build_copilot_messages()`
    - Edição de string, não reescrita do componente
    - _Requirements: 4.5, 4.1, 4.2, 4.6, 4.7_

  - [x] 12.2 Escrever unit tests para as instruções do prompt de sistema
    - Verificar presença das instruções: tese 1–12 palavras, 3 bullets rotulados, rótulos comportamental e system design, caso geral 4.5 explícito, teto 80–120 tokens, proibição de inventar fatos
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

- [x] 13. Gate de voz e fila no engine (`copilot_engine.cpp`)
  - [x] 13.1 Integrar `UserSpeechGate` ao fluxo de decisão do engine
    - Alimentar `on_mic_rms()` com frames de `AudioSource::Microphone`; antes de publicar `SuggestionStartedEvent`, se `should_pin()` ou dentro de `cooldown_ms=4000`, marcar o evento para enfileirar em vez de substituir o card; liberar a próxima pendente quando a janela de 4000 ms expira sem fala; preservar o upgrade pergunta-após-keyword de `evaluate()`
    - _Requirements: 9.1, 9.5, 9.6_

  - [x] 13.2 Escrever unit tests para o fluxo de enfileiramento/substituição
    - Testar: fala fixa o card; expiração da janela promove a pendente; voz curta (<300 ms) mantém o card atual
    - _Requirements: 9.4, 9.6_

- [x] 14. Constantes de layout e janela em `overlay_window.cpp`/`overlay_window.hpp` (Req 1, 2)
  - [x] 14.1 Corrigir constantes de largura/ancoragem e `OverlayOptions`
    - Substituir `kHudW/kMinW/kMaxW` por 480/460/540; adicionar `kAnchorTop*`; `OverlayOptions::width_dip` default 480 e `max_height_fraction` 0.6; integrar `clamp_width`/`clamp_height_fraction` em `src/overlay/src/overlay_window.cpp` e declarações em `src/overlay/include/rtai/overlay_window.hpp`
    - _Requirements: 1.2, 1.3, 1.7_

  - [x] 14.2 Aplicar `resolve_anchor` em `create()` e no reposicionamento
    - Posicionar Top-Center via `resolve_anchor`, derivando monitor/work area; ajustar altura ao conteúdo até o teto e tornar o card rolável (offset no modelo) quando exceder, preservando o topo
    - _Requirements: 1.1, 1.4, 1.5, 1.6, 1.8, 1.9_

- [x] 15. Zona Strip_Unificada e densidade responsiva (Req 2)
  - [x] 15.1 Renderizar a Strip_Unificada (38 DIP) com toggles, níveis e reticências
    - Dois toggles (sistema/`Loopback`, microfone/`Microphone`) com ponto de gravação + indicador de nível; menu de reticências (`kBtnMenu`) alinhado à direita recolhendo a configuração; usar `ui::pick_density()` para alternar ícones-só vs rótulos+key hints no limiar de colapso
    - _Requirements: 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_

- [x] 16. Zona Headline + 3 Âncoras e Micro_Footer (Req 3, 15)
  - [x] 16.1 Renderizar Headline (15.5 DIP SemiBold) e 3 âncoras via `normalize_anchors`
    - Headline em linha única branca truncada com reticências sem quebra; exatamente 3 âncoras via `normalize_anchors`; termo-chave em negrito na cor de destaque e resto em `rgba(255,255,255,0.78)` a 13.5 DIP; cor de destaque `accent=rgb(10,132,255)` ou `mono=branco` via `palette_accent`; tipografia para 45–55 chars/linha em 480 DIP; âncora truncada com reticências
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [x] 16.2 Renderizar o Micro_Footer (hints, telemetria, "N de M", feedback)
    - Hints de atalho (detalhar, exemplo de código) com rótulo + combinação; telemetria TTFT/total em ms inteiros ao `SuggestionDoneEvent` com indicador de indisponível para valores inválidos; navegação "N de M" com "1 de 1" e setas desabilitadas quando M=1; controles 👍/👎 publicando `FeedbackEvent` com `vote=+1/-1` e `vote=0` ao reclicar o voto ativo
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8_

  - [x] 16.3 Empilhar as três zonas com gap de 6 DIP sem sobreposição
    - `render()` empilha Strip_Unificada, Headline+Âncoras e Micro_Footer na ordem, com `kGap=6` entre zonas e sem sobreposição
    - _Requirements: 2.1, 2.2_

- [x] 17. Streaming sem jitter na UI (Req 6)
  - [x] 17.1 Integrar `StreamBuffer` ao dreno e à expansão animada do card
    - Pré-alocar o card com `kMinAnswerH` (≥2 linhas) no `SuggestionStartedEvent`; aplicar `commit_words` no dreno; coalescer render em ≤1 por 16 ms (`kTimerRender`); expandir altura em blocos de 1 linha com ease-out ~150 ms; armar timeout de 5 s mostrando indicador de espera sem encolher; esvaziar `pending` no `SuggestionCompletedEvent`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

- [x] 18. Trigger Lock e Pin on Speak na UI (Req 8, 9)
  - [x] 18.1 Capturar e exibir a `FrozenQuestion` no cabeçalho do card
    - No dreno de `SuggestionStartedEvent`, capturar `trigger_text` verbatim em `FrozenQuestion.full`, exibir `display` (≤280 + reticências) com ícone de citação em ≤200 ms; indicador de ausência com `present=false`; `TranscriptUpdateEvent` só altera a Strip
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x] 18.2 Integrar `SuggestionQueue` e a pílula "Nova pergunta" com [Tab]
    - Enfileirar sugestões marcadas pelo engine (máx 5 FIFO), exibir a pílula "Nova pergunta detectada (Aperte [Tab] para ver)"; [Tab] promove a próxima e remove a pílula; substituir o card quando a janela de 4000 ms expira sem fala
    - _Requirements: 9.2, 9.3, 9.6_

- [x] 19. Hotkeys globais e modos Setup/Ao Vivo/Panic (Req 7, 12)
  - [x] 19.1 Registrar as hotkeys globais e tratar seus acionamentos
    - Estender `HotkeyId` e `keys[]` com Alt+Espaço/Ctrl+Espaço (resposta imediata), Alt+Up/Down (histórico, cap 50), Alt+1/2/3 (ações rápidas), Alt+H (panic); buffer vazio em resposta imediata publica `NoticeEvent{Info}`; fim do histórico publica `NoticeEvent{Info}`; falha de `RegisterHotKey` publica `NoticeEvent{Warning}` nomeando o conflito e preserva os demais
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.10_

  - [x] 19.2 Implementar Modo_Setup/Modo_Ao_Vivo e Modo_Panic
    - Em Ao Vivo desabilitar edição de currículo/chave/modelo/idioma/vaga rejeitando alterações com indicação "editável só no Modo_Setup" e encolher a barra para a pílula de 36–38 DIP; em Setup habilitar a edição; Alt+H alterna Modo_Panic (opacidade 0% ou ponto 8×8 DIP) em ≤50 ms restaurando opacidade/tamanho anteriores
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 12.8, 12.9_

- [x] 20. Zero-Focus-Steal e anti-captura (Req 10, 11)
  - [x] 20.1 Aplicar estilos sem foco, `MA_NOACTIVATE` e gestão de foco do chat
    - Criar a janela com `WS_EX_NOACTIVATE`; retornar `MA_NOACTIVATE` em `WM_MOUSEACTIVATE`; cliques executam ação sem transferir foro; chat guarda `prev_focus` e restaura em ≤100 ms; falha de restauração libera o foco e publica `NoticeEvent{Warning}`; sem janela registrada libera sem transferir
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7_

  - [x] 20.2 Aplicar anti-captura e exclusão da taskbar/Alt+Tab
    - Criar com `WS_EX_TOOLWINDOW` (fora da taskbar/Alt+Tab); aplicar `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` em ≤500 ms, definindo `capture_excluded` observável; na falha publicar `NoticeEvent{Warning}` e manter a janela operacional
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

- [x] 21. Micro-animações e renderização de texto (Req 13, 14)
  - [x] 21.1 Implementar Pulse_Bar, shimmer e fade-in via `kTimerAnim`
    - Pulse_Bar (3 barras de 12 DIP) com altura via `pulse_bar_height` a 60 fps, mínima 2 DIP quando RMS indisponível; shimmer horizontal na borda superior do card oscilando 0.04↔0.12 em ciclo de 1200 ms durante geração; fade-in de novas linhas 0→1 em 200 ms; remover todo spinner giratório dos caminhos de estado
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_

  - [x] 21.2 Implementar renderização de texto com contraste e cache de layout
    - Usar `D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT` + `D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE`; composição per-pixel alpha via `UpdateLayeredWindow`; contorno/sombra ≥1 px e opacidade ≥60% para contraste ≥4.5:1; cachear `IDWriteTextLayout` por bloco e reutilizar enquanto o texto não muda; na falha manter o último cache válido, preservar o quadro anterior e registrar erro
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5_

- [x] 22. Testes de integração Win32/Direct2D
  - Verificar zero-focus-steal (foreground inalterado no clique, restauração ≤100 ms), anti-captura/Alt+Tab, hotkeys sem foco e panic ≤50 ms, coalescência ≤60 fps e ease-out ~150 ms, ausência de spinner, composição per-pixel alpha e reutilização do cache de layout
  - _Requirements: 6.3, 6.4, 10.1, 10.2, 10.3, 10.5, 11.1, 11.2, 11.3, 12.8, 12.9, 13.4, 14.2, 14.4_

- [x] 23. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marcadas com `*` são opcionais e podem ser puladas para um MVP mais rápido.
- Cada tarefa referencia requisitos específicos para rastreabilidade; tarefas de teste PBT referenciam explicitamente a Property correspondente do design.
- Os checkpoints garantem validação incremental.
- Property tests validam as 21 propriedades de correção das funções puras; unit tests e testes de integração/manuais cobrem o prompt, o fluxo do engine e as superfícies Win32/Direct2D.
- O prompt (Req 4) e o parser (Req 5) já estão majoritariamente implementados — as tarefas 12.1 e 3.1/3.2 são ajustes pontuais (caso 4.5 explícito, flag streaming e semântica de headline), não reescritas.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.4", "1.7", "2.1", "3.1", "5.1", "6.1", "7.1", "8.1", "9.1", "10.1", "12.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.5", "1.6", "1.8", "2.2", "3.2", "5.2", "5.3", "6.2", "6.3", "7.2", "8.2", "9.2", "10.2", "12.2"] },
    { "id": 2, "tasks": ["3.3", "3.4", "3.5", "3.6", "3.7", "3.8", "3.9", "13.1"] },
    { "id": 3, "tasks": ["13.2", "14.1"] },
    { "id": 4, "tasks": ["14.2", "15.1"] },
    { "id": 5, "tasks": ["16.1", "16.2"] },
    { "id": 6, "tasks": ["16.3", "17.1"] },
    { "id": 7, "tasks": ["18.1", "18.2"] },
    { "id": 8, "tasks": ["19.1", "19.2"] },
    { "id": 9, "tasks": ["20.1", "20.2"] },
    { "id": 10, "tasks": ["21.1", "21.2"] },
    { "id": 11, "tasks": ["22"] }
  ]
}
```
