# Implementation Plan: Modo Somente Transcrição

## Overview

A implementação segue a decisão central do design: o `CopilotEngine` é o dono único do `Mode_State` (um `std::atomic<bool>`), e toda troca de modo — venha do Dashboard (comando `set_mode` no stdin) ou do Overlay (callback) — é aplicada no engine e **republicada** para as duas superfícies. Reaproveitamos os dois seams de propagação já existentes (pipe JSON Dashboard↔Core e barramento `EngineEvent` Core↔Overlay), o precedente de toggle de pipeline (`set_auto_answer`) e o precedente de encerramento com IA (`finalize_session`).

A ordem de construção é incremental e de fora para dentro do núcleo: primeiro o evento e o estado/gate no engine (coração da feature), depois a montagem pura de export/resumo, depois o protocolo stdin/stdout, em seguida a fiação de I/O em `main.cpp`, e por fim as duas superfícies de UI (Overlay nativo e Dashboard Electron). Cada bloco termina com integração real, sem código órfão. Testes unitários e de propriedade (as 9 Correctness Properties) são sub-tarefas próximas da implementação que validam, compilados via CMake em `tests/core_tests`.

A linguagem é a do projeto: C++ (núcleo, overlay) e JavaScript/Electron (dashboard). Nenhuma seleção de linguagem é necessária.

## Tasks

- [x] 1. Modelo do evento de modo
  - [x] 1.1 Adicionar o evento `TranscriptionModeEvent`
    - Em `src/core/include/rtai/copilot_events.hpp`, definir `struct TranscriptionModeEvent { bool enabled{false}; std::int64_t t_ms{0}; }`
    - Incluir `TranscriptionModeEvent` no variant `EngineEvent`, seguindo o padrão do `AutoAnswerStateEvent` já existente
    - _Requirements: 2.2_

- [x] 2. Estado `Mode_State` e gate do AI_Analysis_Pipeline no CopilotEngine
  - [x] 2.1 Adicionar a API pública e o estado atômico
    - Em `copilot_engine.hpp`, declarar `void set_transcription_only(bool on)` e `[[nodiscard]] bool transcription_only() const noexcept`
    - No `Impl` (orquestrador), adicionar `std::atomic<bool> transcription_only_{false}`
    - Implementar `set_transcription_only` em `copilot_engine.cpp`: thread-safe, não-bloqueante (enfileira + notifica), **idempotente** — se o valor não mudar, não reconfigura nem republica; se mudar, aplica e publica exatamente um `TranscriptionModeEvent{enabled}` via `post()`
    - _Requirements: 2.1, 2.2, 3.1_

  - [x]* 2.2 Teste de propriedade: toda troca efetiva é propagada (idempotência)
    - **Feature: transcription-only-mode, Property 3: Toda troca efetiva é propagada**
    - Novo `tests/core_tests/test_transcription_mode_properties.cpp`: para valor igual ao corrente → 0 eventos; para valor diferente → exatamente 1 `TranscriptionModeEvent` com `enabled` igual ao aplicado
    - _Requirements: 2.2_

  - [x] 2.3 Guardar triggers, especulativo e ações manuais pelo gate
    - No tratamento de turno fechado e interim estável em `copilot_engine.cpp`, envolver a avaliação de `DecisionPolicy::evaluate(...)` e o início de `Speculative_Turn`/Shadow Streaming com `if (!transcription_only_) { ... }`
    - Suprimir `request_suggestion()` / `request_action(...)` manuais enquanto o modo está ativo, publicando `NoticeEvent{Info}` em pt-BR ("Modo somente transcrição ativo: sugestões por IA desativadas.") em vez de disparar
    - Garantir que o acúmulo em `SessionTranscript` e a emissão de `TranscriptUpdateEvent`/`TurnEvent` fiquem **fora** do gate (sempre executam)
    - _Requirements: 3.1, 3.2, 3.3, 3.6_

  - [x] 2.4 Transição imediata ao ligar/desligar durante a sessão
    - Ao ligar com geração em andamento: abortar como o engine já faz (incremento de `generation_id_` + cancelamento da chamada remota) e não iniciar nova geração
    - Ao desligar: retomar a avaliação de triggers a partir daquele momento, respeitando `auto_answer()` e `cooldown_ms` existentes
    - _Requirements: 3.4, 3.5_

  - [x]* 2.5 Teste de propriedade: modo ativo suprime todo o AI_Analysis_Pipeline
    - **Feature: transcription-only-mode, Property 6: Modo ativo suprime todo o AI_Analysis_Pipeline**
    - Com um `ILlmClient` fake contador: para qualquer fluxo de transcrição + ações manuais com o modo ativo, nenhuma `SuggestionStartedEvent/DeltaEvent/DoneEvent` é emitida e contagem de chamadas ao LLM do caminho ao vivo = 0
    - _Requirements: 3.1, 3.3_

  - [x]* 2.6 Teste de propriedade: modo ativo preserva o caminho de transcrição
    - **Feature: transcription-only-mode, Property 7: Modo ativo preserva o caminho de transcrição**
    - Para `N` turnos fechados com o modo ativo, os eventos de transcrição/turno correspondentes continuam sendo emitidos e o `SessionTranscript` acumulado contém exatamente esses `N` turnos
    - _Requirements: 3.2_

- [x] 3. Checkpoint — Garanta que todos os testes passam, pergunte ao usuário se surgirem dúvidas.

- [x] 4. Montagem pura de export e prompt de resumo (`transcript_export.hpp`)
  - [x] 4.1 Implementar `build_transcript_export`
    - Novo header `src/core/include/rtai/transcript_export.hpp` com `enum class TranscriptExportFormat { Txt, Md }`
    - `std::string build_transcript_export(const SessionTranscript& t, TranscriptExportFormat fmt)`: `.txt` = `SessionTranscript::render()` direto; `.md` = cabeçalho leve + a mesma renderização. Função pura, sem I/O, verbatim e em ordem cronológica de fechamento
    - _Requirements: 4.3, 4.4_

  - [x]* 4.2 Teste de propriedade: export verbatim e em ordem cronológica
    - **Feature: transcription-only-mode, Property 8: Export verbatim e em ordem cronológica**
    - Em `test_transcription_mode_properties.cpp`: para qualquer `SessionTranscript`, a sequência de textos extraída do export (`.txt` e `.md`) é idêntica byte a byte à sequência de textos dos turnos, na mesma ordem
    - _Requirements: 4.4_

  - [x] 4.3 Implementar `build_summary_request`
    - `std::vector<ChatMessage> build_summary_request(const SessionTranscript& t)`: exatamente uma mensagem de sistema (pt-BR, orientada a resumo fiel da chamada) + uma de usuário (`SessionTranscript::render()`). Pura, sem I/O
    - _Requirements: 5.1, 5.3_

  - [x]* 4.4 Testes unitários de montagem
    - `build_transcript_export` com 0, 1 e N turnos para `.txt` e `.md`; `build_summary_request` montando exatamente 1 mensagem de sistema + 1 de usuário
    - _Requirements: 4.4, 5.1_

- [x] 5. Protocolo Dashboard↔Core (`server_protocol.hpp`)
  - [x] 5.1 Comando `set_mode` no parser
    - Adicionar `Kind::SetMode` em `Command::Kind` e um campo booleano dedicado (ex.: `mode_on`)
    - Em `parse_command`, adicionar o ramo `cmd == "set_mode"` preenchendo `Command{Kind::SetMode, mode_on=on}`
    - _Requirements: 1.3, 1.4_

  - [x] 5.2 Serialização do evento `mode` e campo `mode` no `hello`
    - Em `encode_event`, adicionar o ramo que serializa `TranscriptionModeEvent` como `{"type":"mode","on":<bool>}`
    - Adicionar o campo `"mode": <bool>` ao `hello` para entregar o valor corrente a uma `Surface` que conecta
    - _Requirements: 2.2, 2.5_

  - [x]* 5.3 Testes unitários do protocolo
    - Em `tests/core_tests/test_server_protocol.cpp`: parse de `{"cmd":"set_mode","on":true/false}`; serialização de `TranscriptionModeEvent` como `{"type":"mode","on":...}`; presença do campo `mode` no `hello`
    - _Requirements: 1.3, 1.4, 2.2, 2.5_

  - [x]* 5.4 Teste de propriedade: o hello de conexão carrega o estado corrente
    - **Feature: transcription-only-mode, Property 5: O hello de conexão carrega o estado corrente**
    - Para qualquer `s` corrente do `Mode_State`, o `hello` gerado contém `mode == s`
    - _Requirements: 2.5_

- [x] 6. Fiação de I/O em `main.cpp` (roteamento, export e resumo)
  - [x] 6.1 Rotear o comando `set_mode`
    - No loop de comandos do servidor, rotear `K::SetMode` para `engine->set_transcription_only(c->mode_on)`; comando malformado apenas loga "comando inválido" e é ignorado (sem alterar o estado)
    - _Requirements: 1.3, 1.4_

  - [x] 6.2 Encerramento: Transcript_Export determinístico
    - Disparar o export ao **desativar** o modo após ele ter estado ativo e no **Session_End** com o modo ativo; usar um flag `summary_pending_` para executar export+resumo **uma única vez** por ativação
    - Gravar `build_transcript_export(...)` em `%LOCALAPPDATA%\RealTimeAI\sessions\` (padrão do `SessionStore`); em falha de gravação, logar + `NoticeEvent{Error}` em pt-BR e preservar o `SessionTranscript` em memória
    - _Requirements: 4.1, 4.2, 4.5_

  - [x] 6.3 Encerramento: Session_Summary (uma chamada de IA)
    - Após o export, montar `build_summary_request(...)` e disparar **uma única** chamada assíncrona via `openrouter_sol_client` (modelo `qwen/qwen3.6-flash`), somente no encerramento
    - Em sucesso: emitir `{"type":"summary","ok":true,"text":...,"export":<path>}` no stdout; em falha/texto vazio: preservar o export e emitir `{"type":"summary","ok":false,...}` + `NoticeEvent{Warning}` ("Resumo não pôde ser gerado; a transcrição foi exportada."), sem segunda chamada
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x]* 6.4 Teste de propriedade: uma única chamada de IA de resumo, apenas no encerramento
    - **Feature: transcription-only-mode, Property 9: Uma única chamada de IA de resumo, apenas no encerramento**
    - Com cliente de resumo fake contador: durante a captura ao vivo a contagem de chamadas de resumo = 0; por ativação do modo, no máximo 1 chamada e somente no encerramento
    - _Requirements: 5.1, 5.2, 5.3_

- [x] 7. Checkpoint — Garanta que todos os testes passam, pergunte ao usuário se surgirem dúvidas.

- [x] 8. Mode_Toggle nativo no Overlay
  - [x] 8.1 Opção e callback do toggle
    - Em `overlay_window.hpp`, adicionar `bool transcription_only_on{false}` a `OverlayOptions` e `std::function<void(bool on)> on_transcription_only_toggle` a `OverlayCallbacks`
    - _Requirements: 1.2_

  - [x] 8.2 Botão na control bar e reflexo de estado
    - Em `overlay_window.cpp`, desenhar o `Mode_Toggle` "Somente transcrição" na control bar (padrão dos toggles de áudio/auto-resposta), com forma curta ao colapsar rótulos
    - Estado visual: ativado → toggle aceso + área de resposta em estado neutro ("Modo somente transcrição — sugestões por IA desativadas"); desativado → comportamento normal de LiveCopilot
    - _Requirements: 1.6_

  - [x] 8.3 Interação solicita o oposto e espelho segue a republicação
    - O clique chama `callbacks.on_transcription_only_toggle(!model.transcription_only)` sem alterar o espelho localmente; opcionalmente ligar hotkey Ctrl+Alt+M
    - O espelho `model.transcription_only` só muda ao drenar um `TranscriptionModeEvent` recebido por `post()`
    - _Requirements: 1.4, 2.4_

  - [x]* 8.4 Teste de propriedade: toggle solicita o oposto / espelho segue a republicação (Overlay)
    - **Feature: transcription-only-mode, Property 1: Toggle solicita o valor oposto ao espelho** e **Property 2: O espelho segue a última republicação recebida**
    - Em `tests/overlay_tests` (ou no core de UI): acionar o toggle com espelho `m` emite solicitação `!m` sem mudar o espelho; após uma sequência de `TranscriptionModeEvent`, o espelho é igual ao último valor
    - _Requirements: 1.4, 1.6, 2.4_

- [x] 9. Mode_Toggle e exibição do resumo no Dashboard (Electron)
  - [x] 9.1 Expor IPC no preload
    - Em `dashboard/preload.js`, expor `setMode: (on) => ipcRenderer.invoke('rtai:set-mode', on)` e os assinantes `onModeChanged(cb)` / `onSessionSummary(cb)` sobre `ipcRenderer.on('rtai:mode', ...)` / `ipcRenderer.on('rtai:summary', ...)`, no padrão de `onOverlayStatus`
    - _Requirements: 2.3_

  - [x] 9.2 Fiação da pipe JSON no main process
    - Em `dashboard/main.js`, encaminhar linhas `{"type":"mode"}` → `webContents.send('rtai:mode', on)` e `{"type":"summary"}` → `rtai:summary`; adicionar `ipcMain.handle('rtai:set-mode', ...)` que escreve `{"cmd":"set_mode","on":...}\n` no stdin do processo do núcleo
    - _Requirements: 1.3, 2.2, 5.4_

  - [x] 9.3 Botão, reflexo de estado e card de resumo na UI
    - Em `index.html` + `app.js`, adicionar o toggle "Somente transcrição" na barra de status/sessão; o clique chama `window.rtai.setMode(!state.transcriptionOnly)` (solicita o oposto)
    - `state.transcriptionOnly` só muda em `onModeChanged`, atualizando o reflexo visual; `onSessionSummary` exibe o `Session_Summary` (ou um aviso quando `ok:false`)
    - _Requirements: 1.1, 1.5, 2.3, 5.4, 5.5_

  - [x]* 9.4 Teste do Dashboard: toggle e convergência do espelho
    - Em `dashboard/tests`: o clique solicita `!state.transcriptionOnly` sem mutar o estado localmente; `onModeChanged` atualiza o espelho para o último valor recebido; `onSessionSummary` com `ok:false` mostra aviso
    - _Requirements: 1.3, 1.5, 2.3, 5.5_

- [x] 10. Integração ponta a ponta do canal de estado
  - [x] 10.1 Wire-up e convergência entre superfícies
    - Em `main.cpp`, inicializar `oo.transcription_only_on` a partir do estado corrente do engine e fiar `ocb.on_transcription_only_toggle = [engine](bool on){ engine->set_transcription_only(on); };`
    - Garantir que a republicação alcança Dashboard (stdout `mode`) e Overlay (`TranscriptionModeEvent`), inclusive a superfície que originou a troca
    - _Requirements: 2.1, 2.2, 2.6_

  - [x]* 10.2 Teste de propriedade: convergência do estado após propagação
    - **Feature: transcription-only-mode, Property 4: Convergência do estado após propagação**
    - Para qualquer solicitação de troca de qualquer superfície, após aplicar e republicar, `Mode_State` do Core, espelho do Dashboard e espelho do Overlay são todos iguais ao valor aplicado
    - _Requirements: 2.1, 2.6_

  - [x] 10.3 Registrar os novos testes no CMake
    - Adicionar `test_transcription_mode_properties.cpp` (e quaisquer novos arquivos) ao `tests/core_tests/CMakeLists.txt`, seguindo o padrão dos demais testes de propriedade
    - _Requirements: 2.2, 3.1, 4.4, 5.1_

- [x] 11. Checkpoint final — Garanta que todos os testes passam, pergunte ao usuário se surgirem dúvidas.

## Notes

- Tarefas marcadas com `*` são opcionais (testes) e podem ser puladas para um MVP mais rápido; as de implementação principal nunca são opcionais.
- Cada tarefa referencia requisitos específicos para rastreabilidade.
- Os checkpoints garantem validação incremental.
- Os testes de propriedade validam as 9 Correctness Properties do design (mínimo de 100 iterações por propriedade), cada um com a tag **Feature: transcription-only-mode, Property {n}**.
- A montagem de export/resumo é pura e testável; o I/O (gravar arquivo, chamar LLM) fica na borda em `main.cpp`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "4.1", "5.1"] },
    { "id": 1, "tasks": ["2.1", "4.2", "4.3", "5.2"] },
    { "id": 2, "tasks": ["2.2", "2.3", "4.4", "5.3", "5.4"] },
    { "id": 3, "tasks": ["2.4", "6.1", "6.2"] },
    { "id": 4, "tasks": ["2.5", "2.6", "6.3", "8.1", "9.1"] },
    { "id": 5, "tasks": ["6.4", "8.2", "9.2"] },
    { "id": 6, "tasks": ["8.3", "9.3", "10.1"] },
    { "id": 7, "tasks": ["8.4", "9.4", "10.2", "10.3"] }
  ]
}
```
