# Requirements Document

## Introduction

Esta feature introduz o "Modo Somente Transcrição" no copiloto de entrevista em tempo real (projeto RealTimeAI: núcleo C++/Win32 com CMake, overlay nativo HUD/Direct2D e dashboard Electron em `dashboard/`). O objetivo é oferecer um modo no qual apenas o caminho de transcrição alimenta a interface, desativando por completo o pipeline de análise e geração de respostas por IA, de forma a reduzir processamento local e custo de chamadas de API durante a sessão.

O modo é controlado por um alternador presente em duas superfícies: um botão/toggle no dashboard Electron (`dashboard/`, JavaScript) e um controle equivalente no overlay nativo em C++. O estado do modo é global e sincronizado entre o núcleo/aplicação, o overlay e o dashboard, por meio de um canal de estado compartilhado, de modo que alternar o modo em uma superfície reflita imediatamente na outra.

Quando o modo é ativado, somente o caminho de transcrição permanece ativo; o pipeline de análise/resposta por IA não é executado durante a sessão. A IA é utilizada apenas de forma pontual no encerramento: ao desativar o modo ou ao encerrar a sessão, a transcrição acumulada é exportada para um arquivo (`.txt` ou `.md`) e um resumo automático da chamada é gerado por IA.

As regras EARS abaixo descrevem o comportamento observável; detalhes de implementação ficam para o documento de design. O idioma de todo o produto e da UI é o português (pt-BR).

## Glossary

- **Transcription_Only_Mode**: modo de operação no qual apenas o caminho de transcrição alimenta a interface e o pipeline de análise/resposta por IA permanece desativado durante a sessão.
- **Mode_Toggle**: controle de interface que ativa ou desativa o Transcription_Only_Mode, presente tanto no Dashboard quanto no Overlay.
- **Dashboard**: interface Electron do aplicativo RealTimeAI renderizada a partir de `dashboard/src/index.html`, com lógica em `dashboard/src/app.js`.
- **Overlay**: janela nativa em C++/Direct2D (`src/overlay/src/overlay_window.cpp`) que exibe o HUD ao vivo.
- **Core_App**: núcleo C++ da aplicação que orquestra a captura de áudio, o pipeline e a publicação de estado.
- **Mode_State_Channel**: canal de estado compartilhado entre Core_App, Overlay e Dashboard que propaga o estado corrente do Transcription_Only_Mode.
- **Mode_State**: valor booleano global do Transcription_Only_Mode, com os estados Ativado e Desativado.
- **Transcription_Path**: caminho de processamento que converte o áudio capturado em texto de transcrição e o entrega à interface.
- **AI_Analysis_Pipeline**: pipeline de análise e geração de respostas por IA (caminho de resposta ao vivo) que consome a transcrição para produzir sugestões.
- **Session_Transcript**: acumulador da transcrição completa da sessão, composto pelos turnos de transcrição fechados em ordem cronológica.
- **Transcript_Export**: arquivo exportado contendo a transcrição acumulada da sessão, no formato `.txt` ou `.md`.
- **Session_Summary**: resumo automático da chamada gerado por uma única chamada de IA no encerramento, a partir do Session_Transcript.
- **Session_End**: encerramento da sessão, acionado pela ação de finalizar a sessão.
- **Surface**: qualquer superfície de controle do modo, isto é, o Dashboard ou o Overlay.

## Requirements

### Requirement 1 — Alternador do modo nas duas superfícies

**User Story:** Como usuário, quero ativar o modo somente transcrição tanto pelo dashboard quanto pelo overlay, para controlar o modo pela superfície que estiver usando no momento.

#### Acceptance Criteria

1. THE Dashboard SHALL apresentar um Mode_Toggle que ativa e desativa o Transcription_Only_Mode.
2. THE Overlay SHALL apresentar um Mode_Toggle que ativa e desativa o Transcription_Only_Mode.
3. WHEN o usuário aciona o Mode_Toggle no Dashboard, THE Dashboard SHALL solicitar a alteração do Mode_State para o valor oposto ao valor corrente.
4. WHEN o usuário aciona o Mode_Toggle no Overlay, THE Overlay SHALL solicitar a alteração do Mode_State para o valor oposto ao valor corrente.
5. THE Dashboard SHALL refletir visualmente no Mode_Toggle se o Transcription_Only_Mode está Ativado ou Desativado.
6. THE Overlay SHALL refletir visualmente no Mode_Toggle se o Transcription_Only_Mode está Ativado ou Desativado.

### Requirement 2 — Estado global sincronizado entre superfícies

**User Story:** Como usuário, quero que o estado do modo seja o mesmo em todas as superfícies, para que alternar em uma superfície se reflita imediatamente na outra.

#### Acceptance Criteria

1. THE Core_App SHALL manter um único Mode_State global compartilhado entre Core_App, Overlay e Dashboard.
2. WHEN o Mode_State é alterado por qualquer Surface, THE Mode_State_Channel SHALL propagar o novo valor do Mode_State ao Core_App, ao Overlay e ao Dashboard.
3. WHEN o Dashboard recebe uma alteração do Mode_State pelo Mode_State_Channel, THE Dashboard SHALL atualizar o estado exibido no Mode_Toggle para o valor recebido.
4. WHEN o Overlay recebe uma alteração do Mode_State pelo Mode_State_Channel, THE Overlay SHALL atualizar o estado exibido no Mode_Toggle para o valor recebido.
5. WHEN uma Surface se conecta ao Mode_State_Channel, THE Core_App SHALL fornecer a essa Surface o valor corrente do Mode_State.
6. THE Mode_State SHALL permanecer consistente entre Core_App, Overlay e Dashboard após a conclusão da propagação de uma alteração.

### Requirement 3 — Desativação do pipeline de IA no modo ativo

**User Story:** Como usuário, quero que apenas a transcrição alimente a interface quando o modo está ativo, para economizar processamento local e custo de chamadas de API durante a sessão.

#### Acceptance Criteria

1. WHILE o Transcription_Only_Mode está Ativado, THE Core_App SHALL manter o AI_Analysis_Pipeline desativado, sem iniciar geração de respostas por IA.
2. WHILE o Transcription_Only_Mode está Ativado, THE Transcription_Path SHALL permanecer ativo e entregar o texto de transcrição à interface.
3. WHILE o Transcription_Only_Mode está Ativado, THE Core_App SHALL suprimir toda chamada de API do AI_Analysis_Pipeline.
4. WHEN o Transcription_Only_Mode transita de Desativado para Ativado durante uma sessão, THE Core_App SHALL interromper o AI_Analysis_Pipeline a partir desse momento.
5. WHEN o Transcription_Only_Mode transita de Ativado para Desativado durante uma sessão, THE Core_App SHALL restabelecer o AI_Analysis_Pipeline a partir desse momento.
6. WHILE o Transcription_Only_Mode está Desativado, THE Core_App SHALL manter o AI_Analysis_Pipeline em operação normal.

### Requirement 4 — Exportação da transcrição no encerramento do modo

**User Story:** Como usuário, quero receber a transcrição em arquivo ao desativar o modo ou encerrar a sessão, para guardar o registro completo da chamada.

#### Acceptance Criteria

1. WHEN o Transcription_Only_Mode é desativado após ter estado Ativado durante a sessão, THE Core_App SHALL gerar o Transcript_Export a partir do Session_Transcript acumulado.
2. WHEN ocorre o Session_End enquanto o Transcription_Only_Mode está Ativado, THE Core_App SHALL gerar o Transcript_Export a partir do Session_Transcript acumulado.
3. THE Transcript_Export SHALL ser gravado em um arquivo no formato `.txt` ou `.md`.
4. THE Transcript_Export SHALL conter o texto verbatim de cada turno do Session_Transcript na ordem cronológica de fechamento.
5. IF a gravação do Transcript_Export falha, THEN THE Core_App SHALL registrar a falha e preservar o Session_Transcript acumulado em memória.

### Requirement 5 — Resumo automático por IA no encerramento

**User Story:** Como usuário, quero um resumo automático da chamada ao encerrar o modo, para revisar os pontos principais sem reler toda a transcrição.

#### Acceptance Criteria

1. WHEN o Transcription_Only_Mode é desativado após ter estado Ativado durante a sessão, THE Core_App SHALL solicitar a geração do Session_Summary a partir do Session_Transcript por meio de uma única chamada de IA.
2. WHEN ocorre o Session_End enquanto o Transcription_Only_Mode está Ativado, THE Core_App SHALL solicitar a geração do Session_Summary a partir do Session_Transcript por meio de uma única chamada de IA.
3. THE Core_App SHALL invocar a IA para o Session_Summary somente no encerramento do modo ou da sessão, e não durante a captura ao vivo.
4. WHEN o Session_Summary é gerado com sucesso, THE Dashboard SHALL apresentar o Session_Summary ao usuário.
5. IF a chamada de IA do Session_Summary falha, THEN THE Core_App SHALL preservar o Transcript_Export já gerado e informar ao usuário que o resumo não foi produzido.
