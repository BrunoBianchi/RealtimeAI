# Requirements Document

## Introduction

Esta feature introduz um pipeline especulativo de dois caminhos (Dual-Path) no copiloto de entrevista em tempo real (projeto C++/Win32 + Direct2D/DirectWrite), com o objetivo de reduzir a latência percebida de ponta a ponta para abaixo de 200 ms e de entregar, ao final da sessão, um painel pós-entrevista (Jev Dashboard).

O Hot_Path otimiza a resposta ao vivo: detecção acústica local de fim de fala na própria thread de captura WASAPI, uma máquina de estados de Shadow Streaming no `CopilotEngine` (Speculating → Committed → Aborted), transporte HTTP/2 direto para provedores primário e de fallback (removendo o proxy OpenRouter do caminho crítico) e um barramento de eventos sem sleep que propaga o primeiro token à UI imediatamente.

O Cold_Path acumula a transcrição completa da sessão e, ao encerrar, dispara duas chamadas paralelas (Jev Engine API e feedback sintético) para renderizar um relatório de desempenho em três anéis Direct2D (Relevância, Acurácia, Clareza), com política de falha tudo-ou-nada que retorna ao modo ao vivo quando qualquer chamada falha.

As regras EARS abaixo descrevem o comportamento observável; detalhes de implementação ficam para o documento de design. O idioma de todo o produto e da UI é o português (pt-BR).

O redesenho cobre superfícies do código existente: `src/audio_wasapi/src/wasapi_capture.cpp` (VAD acústico local), `src/core/src/copilot_engine.cpp` e `src/core/include/rtai/copilot_engine.hpp` (máquina de estados Shadow Streaming), `src/core/include/rtai/decision_policy.hpp` (filtro rápido do turno interino), `src/net/src/winhttp_llm_client.cpp` e `src/net/include/rtai/winhttp_llm_client.hpp` (transporte HTTP/2 direto e Keep-Alive), `src/core/include/rtai/copilot_events.hpp` (eventos de engine) e `src/overlay/src/overlay_window.cpp` com `src/overlay/include/rtai/overlay_window.hpp` (barramento sem sleep, bridge de UI e renderização do dashboard).

## Glossary

- **Hot_Path**: caminho quente de baixa latência que produz a resposta ao vivo, do áudio capturado até o primeiro token exibido no HUD.
- **Cold_Path**: caminho frio executado ao encerrar a sessão, que gera o relatório pós-entrevista a partir da transcrição acumulada.
- **Copilot_Engine**: orquestrador de núcleo (`CopilotEngine`, em `src/core/src/copilot_engine.cpp`) que hospeda a máquina de estados de Shadow Streaming e publica `EngineEvent` para os sinks.
- **Turn_Assembler**: componente de núcleo (`TurnAssembler`) que monta turnos a partir de eventos de transcrição e emite candidatos interinos.
- **Decision_Policy**: componente de núcleo (`DecisionPolicy`, em `src/core/include/rtai/decision_policy.hpp`) cujo filtro rápido decide se um interino qualifica para disparo especulativo.
- **Local_VAD**: detecção acústica local de atividade de voz executada na thread de captura WASAPI (`src/audio_wasapi/src/wasapi_capture.cpp`), baseada no RMS de amostras int16.
- **RMS**: valor eficaz do nível de áudio calculado por quadro de 20 ms sobre amostras int16.
- **Noise_Floor**: piso de ruído estimado localmente, usado como referência para considerar um quadro como silêncio.
- **Speculative_Turn**: disparo especulativo de uma sugestão iniciado pelo Hot_Path antes do fechamento definitivo do turno.
- **Shadow_Streaming**: máquina de estados do Copilot_Engine com os estados Speculating, Committed e Aborted.
- **Shadow_Buffer**: buffer oculto (`shadow_buffer_`) que acumula os tokens recebidos durante o estado Speculating, sem exibi-los na UI.
- **Speculating**: estado no qual a resposta é gerada de forma oculta, os tokens são retidos no Shadow_Buffer e o HUD exibe o indicador "Generating answer...".
- **Committed**: estado no qual o Shadow_Buffer é promovido para a UI, tornando o conteúdo visível com tempo até o primeiro token percebido igual a zero.
- **Aborted**: estado no qual o Shadow_Buffer é descartado, o identificador de geração (`generation_id_`) é incrementado e a chamada remota é cancelada via RST_STREAM, sem flicker na UI.
- **Generation_Id**: contador monotônico (`generation_id_`) que identifica a geração especulativa corrente e invalida tokens de gerações anteriores.
- **Llm_Transport**: cliente de transporte HTTP/2 direto (`WinHttpLlmClient`, em `src/net/src/winhttp_llm_client.cpp`) para os provedores de modelo de linguagem.
- **Primary_Provider**: provedor primário Cerebras (host `api.cerebras.ai`, modelo `llama-3.3-70b`).
- **Fallback_Provider**: provedor de fallback Groq (host `api.groq.com`, modelo `llama-3.3-70b-versatile`).
- **Keep_Alive_Ping**: ping periódico de aplicação enviado para manter a conexão TCP e a sessão TLS 1.3 aquecidas.
- **Event_Bus**: barramento de eventos interno do Copilot_Engine que notifica consumidores sem usar espera por sleep.
- **UI_Bridge**: ponte do Overlay que agenda redesenho na thread de UI via `PostMessageW` e `InvalidateRect`.
- **SSE_Token**: token recebido via Server-Sent Events do provedor de modelo de linguagem.
- **Overlay**: componente de janela Win32 (`OverlayWindow`, em `src/overlay/src/overlay_window.cpp`) que renderiza o HUD.
- **OverlayMode**: enumeração net-new de modo de renderização do Overlay, com os valores `LiveCopilot` e `PostInterviewReport`.
- **Session_Transcript**: acumulador em RAM (`SessionTranscript`, `std::vector<TranscriptTurn>`) de todos os turnos fechados da sessão.
- **Transcript_Turn**: entrada (`TranscriptTurn`) de um turno fechado, incluindo a faixa de origem (Loopback/entrevistador ou Mic/candidato) e o texto verbatim.
- **Jev_Client**: cliente do Cold_Path que realiza as chamadas WinHttp paralelas (Jev Engine API e feedback sintético).
- **Jev_Engine_Api**: API remota que recebe a transcrição completa e as questões de avaliação e retorna as pontuações do relatório.
- **Score_Ring**: anel Direct2D do dashboard que representa uma dimensão de pontuação de 0 a 10, desenhado com `ID2D1PathGeometry` e `ID2D1GeometrySink::AddArc`.
- **Instant_Feedback**: bloco textual de 3 linhas de "Instant Performance Feedback" produzido pela chamada de feedback sintético.
- **Finalizar**: ação de encerramento da sessão, acionada pelo botão Finalizar ou por hotkey, que inicia o Cold_Path.
- **DIP**: device-independent pixel (unidade lógica do Direct2D).

## Requirements

### Requirement 1: VAD acústico local na thread de captura

**User Story:** Como usuário em entrevista, quero que o fim da minha pergunta seja detectado localmente pelo áudio, para que a resposta comece sem depender da latência de rede da detecção de fala remota.

#### Acceptance Criteria

1. WHILE a captura WASAPI está ativa, THE Local_VAD SHALL calcular o valor RMS das amostras int16 a cada quadro de 20 ms de áudio.
2. WHILE quadros de 20 ms são processados, THE Local_VAD SHALL classificar um quadro como silêncio quando seu valor RMS permanecer abaixo do Noise_Floor estimado.
3. WHEN o valor RMS permanece abaixo do Noise_Floor por 110 ms consecutivos e o interino corrente do Turn_Assembler é aprovado pelo filtro rápido do Decision_Policy, THE Local_VAD SHALL sinalizar um Speculative_Turn ao Copilot_Engine.
4. THE Decision_Policy SHALL aprovar o interino no filtro rápido somente quando o interino contiver mais de 5 palavras e apresentar estrutura de pergunta.
5. IF o valor RMS permanece abaixo do Noise_Floor por 110 ms consecutivos e o interino corrente não é aprovado pelo filtro rápido do Decision_Policy, THEN THE Local_VAD SHALL não sinalizar Speculative_Turn.
6. THE Hot_Path SHALL disparar o Speculative_Turn pelo Local_VAD de forma independente da detecção de fala da rede Deepgram, sem exigir que a detecção remota tenha ocorrido.

### Requirement 2: Máquina de estados Shadow Streaming

**User Story:** Como usuário, quero que a resposta seja gerada em segundo plano enquanto termino de falar, para que ela apareça instantaneamente quando confirmada, sem tremor nem espera.

#### Acceptance Criteria

1. WHEN o Copilot_Engine recebe um Speculative_Turn, THE Copilot_Engine SHALL entrar no estado Speculating, iniciar a geração da resposta, reter cada token recebido no Shadow_Buffer sem exibi-lo na UI e instruir o Overlay a exibir o indicador textual "Generating answer...".
2. WHEN o Copilot_Engine transita de Speculating para Committed, THE Copilot_Engine SHALL promover o conteúdo do Shadow_Buffer para a UI em até 16 ms, apresentando o texto já acumulado como primeiro conteúdo visível.
3. WHEN o Copilot_Engine entra no estado Aborted, THE Copilot_Engine SHALL descartar o conteúdo do Shadow_Buffer, incrementar o Generation_Id, cancelar a chamada remota corrente via RST_STREAM e preservar o conteúdo atualmente exibido no HUD sem flicker.
4. WHILE o Copilot_Engine está no estado Speculating, THE Overlay SHALL exibir o indicador "Generating answer..." e SHALL NOT exibir qualquer token do Shadow_Buffer.
5. IF um token é recebido com um Generation_Id diferente do Generation_Id corrente do Copilot_Engine, THEN THE Copilot_Engine SHALL descartar esse token sem alterar o Shadow_Buffer nem a UI.
6. WHEN o estado transita para Committed, THE Copilot_Engine SHALL continuar anexando os tokens subsequentes da mesma geração diretamente à resposta visível no HUD.

### Requirement 3: Gatilho de confirmação Speculating para Committed

**User Story:** Como usuário, quero que a resposta seja confirmada no primeiro sinal confiável de que terminei de falar, para que o copiloto não espere a rede quando o silêncio local já é suficiente.

#### Acceptance Criteria

1. WHILE o Copilot_Engine está no estado Speculating, THE Copilot_Engine SHALL transitar para Committed quando ocorrer primeiro, entre o evento `speech_final` da Deepgram e a marca de 120 ms de silêncio acústico local absoluto medido pelo Local_VAD.
2. WHEN o evento `speech_final` da Deepgram é recebido durante o estado Speculating antes de completados 120 ms de silêncio acústico local, THE Copilot_Engine SHALL transitar para Committed.
3. WHEN o silêncio acústico local absoluto atinge 120 ms durante o estado Speculating antes do recebimento do evento `speech_final`, THE Copilot_Engine SHALL transitar para Committed.
4. IF o texto do turno fechado diverge do texto que originou o Speculative_Turn além da tolerância definida no design, THEN THE Copilot_Engine SHALL entrar no estado Aborted e iniciar uma nova geração para o turno fechado.

### Requirement 4: Transporte HTTP/2 direto com provedor primário e fallback

**User Story:** Como usuário, quero que as respostas usem uma conexão direta e aquecida com o provedor de modelo, para eliminar a latência do proxy e do handshake no caminho crítico.

#### Acceptance Criteria

1. THE Llm_Transport SHALL enviar as requisições de geração diretamente ao Primary_Provider no host `api.cerebras.ai` usando o modelo `llama-3.3-70b`.
2. IF a requisição ao Primary_Provider falha ou expira dentro do tempo limite definido no design, THEN THE Llm_Transport SHALL repetir a requisição no Fallback_Provider no host `api.groq.com` usando o modelo `llama-3.3-70b-versatile`.
3. THE Llm_Transport SHALL excluir o proxy OpenRouter do caminho crítico de geração de respostas ao vivo.
4. THE Llm_Transport SHALL emitir requisições de geração sobre HTTP/2 na sessão WinHTTP já habilitada para HTTP/2.
5. WHILE uma sessão de entrevista está ativa, THE Llm_Transport SHALL enviar um Keep_Alive_Ping a cada 25 s para manter a conexão TCP e a sessão TLS 1.3 aquecidas.
6. WHEN o Copilot_Engine entra no estado Aborted, THE Llm_Transport SHALL encerrar o fluxo da geração corrente via RST_STREAM mantendo a conexão HTTP/2 aberta para reutilização.

### Requirement 5: Barramento de eventos sem sleep e bridge de UI

**User Story:** Como usuário, quero que o primeiro token apareça assim que chega, para que a resposta pareça instantânea em vez de esperar um ciclo de polling.

#### Acceptance Criteria

1. THE Event_Bus SHALL sinalizar a chegada de novos eventos usando `std::condition_variable`, sem empregar espera por `sleep_for` fixo de 50 ms.
2. WHEN o primeiro SSE_Token válido de uma geração é recebido ou o estado transita para Committed, THE UI_Bridge SHALL postar `PostMessageW` para a thread de UI e invocar `InvalidateRect` imediatamente.
3. WHILE deltas de uma mesma geração continuam chegando após o primeiro redesenho, THE UI_Bridge SHALL coalescer as atualizações em no máximo 1 redesenho por intervalo de 16 ms (60 quadros por segundo).
4. WHEN o consumidor do Event_Bus está em espera e um evento é publicado, THE Event_Bus SHALL despertar o consumidor por notificação da `std::condition_variable` sem latência adicional de polling.

### Requirement 6: Acumulação da transcrição da sessão

**User Story:** Como usuário, quero que toda a conversa da entrevista seja registrada, para que o relatório final avalie a sessão completa.

#### Acceptance Criteria

1. WHEN um turno é fechado na faixa Loopback do entrevistador, THE Session_Transcript SHALL anexar um Transcript_Turn correspondente ao `std::vector<TranscriptTurn>` em RAM, identificando a faixa como entrevistador.
2. WHEN um turno é fechado na faixa Mic do candidato, THE Session_Transcript SHALL anexar um Transcript_Turn correspondente ao `std::vector<TranscriptTurn>` em RAM, identificando a faixa como candidato.
3. THE Session_Transcript SHALL preservar a ordem cronológica de fechamento dos turnos na sequência em que são anexados.
4. THE Session_Transcript SHALL manter o texto verbatim de cada Transcript_Turn idêntico ao texto do turno fechado recebido.

### Requirement 7: Disparo paralelo do Cold Path ao finalizar

**User Story:** Como usuário, quero que ao encerrar a entrevista o relatório seja montado rapidamente, para revisar meu desempenho logo em seguida.

#### Acceptance Criteria

1. WHEN a ação Finalizar é acionada pelo botão Finalizar ou pela hotkey correspondente, THE Jev_Client SHALL iniciar duas chamadas WinHttp paralelas em threads distintas.
2. WHEN a primeira chamada paralela é iniciada, THE Jev_Client SHALL enviar à Jev_Engine_Api uma requisição POST em JSON contendo `state` com a transcrição completa do Session_Transcript e `questions` com os campos `relevance_score`, `accuracy_score` e `clarity_score` como `type:"score"` de 0 a 10 e os campos `domain` e `interview_type` como `type:"choice"`.
3. THE Jev_Client SHALL ler a resposta da Jev_Engine_Api como JSON direto, sem usar Server-Sent Events.
4. WHEN a segunda chamada paralela é iniciada, THE Jev_Client SHALL enviar uma requisição de feedback sintético limitada a no máximo 80 tokens para produzir o Instant_Feedback de 3 linhas.
5. WHILE as duas chamadas paralelas estão em andamento, THE Overlay SHALL permanecer em `OverlayMode::LiveCopilot`.

### Requirement 8: Política de falha tudo-ou-nada do Cold Path

**User Story:** Como usuário, quero não ver um painel incompleto, para confiar que o relatório exibido é sempre válido.

#### Acceptance Criteria

1. IF a chamada à Jev_Engine_Api falha ou expira dentro do tempo limite definido no design, THEN THE Overlay SHALL permanecer em `OverlayMode::LiveCopilot` e SHALL NOT exibir qualquer parte do dashboard.
2. IF a chamada de feedback sintético falha ou expira dentro do tempo limite definido no design, THEN THE Overlay SHALL permanecer em `OverlayMode::LiveCopilot` e SHALL NOT exibir qualquer parte do dashboard.
3. WHEN ambas as chamadas paralelas concluem com sucesso, THE Overlay SHALL transitar de `OverlayMode::LiveCopilot` para `OverlayMode::PostInterviewReport`.
4. IF qualquer das chamadas paralelas falha, THEN THE Jev_Client SHALL descartar o resultado parcial já recebido da outra chamada sem renderizá-lo.

### Requirement 9: Renderização do dashboard pós-entrevista

**User Story:** Como usuário, quero ver meu desempenho em anéis claros logo após encerrar, para avaliar a entrevista de relance.

#### Acceptance Criteria

1. WHEN o Overlay entra em `OverlayMode::PostInterviewReport`, THE Overlay SHALL renderizar exatamente três Score_Ring, um de Relevância na cor laranja, um de Acurácia na cor verde e um de Clareza na cor lilás.
2. THE Overlay SHALL desenhar cada Score_Ring usando `ID2D1PathGeometry` e `ID2D1GeometrySink::AddArc`.
3. WHEN um Score_Ring é renderizado, THE Overlay SHALL animar o ângulo theta do anel até o valor (score dividido por 10,0) multiplicado por 360 graus, usando o mecanismo de animação existente `anim_tick()`.
4. THE Overlay SHALL exibir o Instant_Feedback de 3 linhas no dashboard junto aos três Score_Ring.
5. WHEN a ação Finalizar é concluída com sucesso, THE Overlay SHALL apresentar o dashboard completo em aproximadamente 300 ms, inclusive no limite de 300 ms, após o acionamento de Finalizar.
6. WHILE o Overlay está em `OverlayMode::PostInterviewReport`, THE Overlay SHALL manter a janela sem roubo de foco e com exclusão de captura de tela já aplicadas pelo HUD.
