# Implementation Plan: Goal Workspace & Prep Loop

## Overview

Este plano de implementação organiza a criação completa do **Goal Workspace** com as abas **Overview**, **Prep** e **Sessions**, incorporando todas as referências de design do Final Round AI (card de primeiros passos creme `#FDFBF7`, agendador de entrevista, Goal Memory "What we know", Next focus, fontes de conhecimento, modal de Playbook, relatórios de debrief por IA e sincronização bidirecional com o Overlay em C++).

## Tasks

- [x] 1. Modelo de Dados e Prompt Engine no C++ Core
  - [x] 1.1 Estender `MiniAgentProfile` em `src/core/include/rtai/mini_agent.hpp`
    - Adicionar campos: `stage` ("Active", "Interviewing", "I got the offer", "Moved on - archive"), `next_interview_date`, `next_interview_time`, `next_focus`, `playbook_name`, `playbook_answer_length`, `playbook_behavioral_structure`, `playbook_lead_with_answer`, `playbook_name_tradeoffs`, `answer_language`, `coding_language`, `goal_memory_strengths`, `goal_memory_improve`
    - Atualizar `to_json()` e `from_json()` garantindo compatibilidade reversa com arquivos JSON de agentes existentes
    - _Requirements: 1.4, 7.1, 7.5, 8.1, 9.1, 11.1, 15.1_

  - [x] 1.2 Incorporar regras de Playbook e Next Focus na montagem do prompt do CopilotEngine
    - Em `src/core/src/copilot_engine.cpp`: injetar no prompt do sistema as instruções de concisão/extensão do Playbook, estrutura STAR/CAR/PAR, declaração imediata do veredito (lead with answer), exposição de trade-offs não solicitados e a lembrança do Next Focus
    - Respeitar o `answer_language` e `coding_language` definidos no Goal
    - _Requirements: 11.3, 12.3, 15.1, 15.2_

  - [x]* 1.3 Testes unitários no Core para serialização e montagem de prompt
    - Criar teste em `tests/core_tests/test_goal_workspace_properties.cpp` validando serialização completa de `MiniAgentProfile` e presença das diretivas do playbook no prompt
    - _Requirements: 1.4, 11.1, 15.1_

- [x] 2. Backend Electron e Handlers IPC (`main.js` e `preload.js`)
  - [x] 2.1 Suporte a Playbooks, Estágios e Goal Memory em `dashboard/main.js`
    - Atualizar `saveAgentToDisk` e `loadAllAgents` para persistir e carregar com integridade os novos campos do Goal Workspace
    - Adicionar suporte para salvar e carregar playbooks personalizados da conta em `getAppDataDir()/playbooks.json`
    - _Requirements: 1.5, 7.2, 11.3_

  - [x] 2.2 Agendamento de notificações nativas do Windows para entrevistas
    - Em `dashboard/main.js`: implementar agendador de lembretes para `Next_Interview` (disparando notificação nativa do Windows via Electron `Notification` aproximadamente 1 hora antes)
    - Tratar reagendamento e cancelamento com "Skip for now"
    - _Requirements: 3.4, 3.5, 3.6, 3.7, 3.8_

  - [x] 2.3 Geração de Debrief e Reflection por IA pós-sessão
    - Implementar handler IPC `rtai:generate-debrief`: após encerramento da sessão, dispara chamada de IA para produzir o Session Report e extrair reflexões (pontos fortes e melhorias)
    - Persistir a Reflection na `goal_memory` do Goal e recalcular o `next_focus`
    - _Requirements: 5.3, 5.4, 8.3, 13.3, 15.3, 15.4, 15.5_

  - [x] 2.4 Expor novas APIs no `dashboard/preload.js`
    - Expor `savePlaybook`, `getPlaybooks`, `generateDebrief`, `dismissChecklistStep`, `scheduleInterview`
    - _Requirements: 1.5, 3.2, 11.3, 13.3_

- [x] 3. Estrutura HTML e Estilos (`index.html` e `styles.css`)
  - [x] 3.1 Card Getting Started "Four steps to your first debrief"
    - Adicionar o card com fundo creme `#FDFBF7` (e tema escuro harmônico), título "Four steps to your first debrief", 4 passos interativos com checkmarks automáticos e thumbnail do walkthrough
    - _Requirements: 14.1, 14.6, 16.2_

  - [x] 3.2 Tabela e filtros de Goals Horizon
    - Atualizar a visualização principal de Goals para incluir os filtros `Current · N` e `Archived · M`, busca em tempo real e colunas `GOAL`, `READINESS`, `SESSIONS`, `INTERVIEW`, `ACTIONS` fiéis às imagens de referência
    - _Requirements: 7.4, 16.1_

  - [x] 3.3 Workspace do Goal com as 3 abas fundamentais
    - Criar o container do Goal Workspace com breadcrumb navegável (`Goals > empresa · cargo`), controles de estágio (`Update progress`), botão `+ Add interview date`, botão `Edit` e as abas `Overview`, `Prep` e `Sessions`
    - _Requirements: 1.1, 1.2, 1.3, 7.1, 7.3, 16.1_

  - [x] 3.4 Modal de agendamento de entrevista ("When's the next round?")
    - Criar modal/popover para seleção de data e hora com botão "Confirm" e botão "Skip for now"
    - _Requirements: 2.1, 2.2, 3.1_

  - [x] 3.5 Modal "New playbook"
    - Criar modal completo conforme a Imagem 5: Nome do playbook, controles para Answer length (Concise, Balanced, Thorough), Behavioral structure (Auto, STAR, CAR, PAR, Direct), toggles para Lead with the answer e Name trade-offs unprompted
    - _Requirements: 11.1, 16.1_

  - [x] 3.6 Seções da aba Overview
    - Bloco "Next interview" (com data ou botão de agendar), bloco "Goal context" (status de Resume, Materials, Playbook), bloco "Goal Memory" ("What we know" com seções Strength e Improve) e bloco "Recent sessions"
    - _Requirements: 2.1, 4.1, 5.1, 6.1_

  - [x] 3.7 Seções da aba Prep
    - Header com notice "FUTURE SESSIONS" e botão "Start Practice", bloco "Next focus" (exibição condicional), bloco "Goal brief" (com edição e auto-recon), bloco "Knowledge sources" (currículo e materiais) e bloco "Response defaults" (Playbook, Answer language, Coding language)
    - _Requirements: 8.1, 9.1, 10.1, 11.1, 12.1_

  - [x] 3.8 Seções da aba Sessions
    - Lista de Session Reports com badges, duração, estado Debrief Processing, detalhe do relatório e estado vazio educativo com botão "Open Prep"
    - _Requirements: 13.1, 13.4, 13.5_

- [x] 4. Lógica de Interface e Integração (`dashboard/src/app.js`)
  - [x] 4.1 Navegação entre Horizon e Goal Workspace
    - Permitir clicar em qualquer meta para abrir o Goal Workspace correspondente com Overview como padrão, e clicar no breadcrumb para retornar à lista de metas
    - _Requirements: 1.1, 1.2, 1.3_

  - [x] 4.2 Lógica do controle "Update progress"
    - Implementar dropdown com estágios Active, Interviewing, I got the offer, Moved on - archive; persistir via `saveAgent` e atualizar filtros
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 4.3 Lógica do Agendador de Entrevista
    - Abertura de "When's the next round?", edição com "Edit date", remoção com "Skip for now", persistência e recálculo de notificação
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.7_

  - [x] 4.4 Renderização da aba Overview e Goal Memory
    - Renderizar status de anexos no Goal Context, exibir aprendizados em Strength/Improve quando houver reflections e listar sessões recentes
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 6.1, 6.2, 6.3_

  - [x] 4.5 Renderização da aba Prep, Knowledge Sources e Response Defaults
    - Exibir Next Focus condicionalmente, gerenciar Goal Brief com recon automático, upload/remoção de fontes de conhecimento e resolução de herança de Response Defaults
    - _Requirements: 8.1, 8.2, 9.1, 9.2, 9.3, 10.1, 10.2, 10.3, 11.2, 11.4_

  - [x] 4.6 Criação e seleção de Playbooks
    - Interação com modal New Playbook, salvar playbook na conta, aplicá-lo ao Goal e refletir os padrões
    - _Requirements: 11.1, 11.3_

  - [x] 4.7 Ação Start Practice e integração pós-sessão
    - "Start Practice" inicia overlay com overrides corretos; ao término de sessão, aciona debrief por IA, adiciona reflexão e atualiza Goal Memory
    - _Requirements: 12.1, 12.2, 12.3, 13.3, 15.1, 15.4_

  - [x] 4.8 Checklist Getting Started interativo
    - Atualização dinâmica dos checkmarks dos 4 passos conforme metas são criadas, currículos são anexados, sessões são rodadas e debriefs são lidos
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6_

- [x] 5. Testes, Validação e Ajustes Finais
  - [x]* 5.1 Testes automatizados do Dashboard (`dashboard/tests/goal_workspace.test.js`)
    - Validar presença dos elementos, alternância de abas, persistência de estágios, herança de response defaults, condição de exibição da Goal Memory e checklist
    - _Requirements: 1.1, 3.1, 5.1, 7.1, 8.1, 11.2, 14.1_

  - [x]* 5.2 Execução de testes de regressão e C++
    - Rodar `core_tests.exe` e `npm test` para garantir 100% de sucesso sem regressão nos módulos anteriores
    - _Requirements: 16.4, 16.5_

  - [x] 5.3 Validação visual e conclusão do objetivo
    - Verificar fidelidade estética às imagens do usuário, responsividade e operação em modo claro e escuro
    - _Requirements: 16.1, 16.2, 16.3_

