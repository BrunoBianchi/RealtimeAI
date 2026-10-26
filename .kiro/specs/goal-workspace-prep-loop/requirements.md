# Requirements Document

## Introduction

Esta feature transforma cada meta (goal) do aplicativo "RealTimeAI" em um workspace completo de preparação para entrevistas, substituindo o modal de edição atual por uma área de trabalho por meta com três abas — Overview, Prep e Sessions. O objetivo é criar um ciclo de preparação de ponta a ponta: o usuário agenda a próxima entrevista, reúne o contexto da vaga, define os padrões de resposta, pratica com o overlay ao vivo e recebe debriefs gerados por IA que alimentam uma "Goal Memory" acumulada ao longo das sessões. A fidelidade visual segue as referências do Final Round AI (tipografia, card de getting-started creme #FDFBF7, rótulos de seção em caixa alta suave, acento vermelho e espaçamento limpo), mantendo o app pt-BR existente e o overlay nativo em funcionamento.

O corpo e os critérios desta especificação são redigidos em português (pt-BR), consistentes com as demais specs em `.kiro/specs`. Os rótulos de UI das novas telas são exibidos em inglês conforme decisão da fase de clarify (por exemplo "Next focus", "Goal brief", "Start Practice", e os estágios Active / Interviewing / I got the offer / Moved on - archive).

A integração com o overlay nativo (C++) é de leitura e escrita (requer alterações no binário C++): o overlay consome o Next Focus, os Response defaults e as knowledge sources da meta e, ao final de uma sessão ao vivo, produz um debrief/reflection gerado por IA que alimenta a Goal Memory e aparece em Sessions/History. O modelo de dados existente é reutilizado: "agents" representam goals (company, role, job_description, extra_instructions, company_research/dossier, mini_compact, documents[]), com estado trafegado pela ponte IPC `window.rtai` (getState, saveAgent, startOverlay, companyRecon, readSessionDetail, setThemePreference, onOverlayStatus). O overlay é iniciado via `window.rtai.startOverlay({agent, demo, configOverrides})` e `iniciar-overlay.bat`.

As regras EARS abaixo descrevem o comportamento observável; detalhes de implementação ficam para o documento de design.

## Glossary

- **Dashboard**: a interface Electron (JS) do RealTimeAI renderizada a partir de `dashboard/src/index.html`, onde reside o Goal_Workspace.
- **Overlay**: a janela nativa em C++/Direct2D que exibe o HUD ao vivo durante a entrevista, iniciada via `window.rtai.startOverlay`.
- **Goal**: uma meta de entrevista, persistida no modelo de dados como um "agent" (campos company, role, job_description, extra_instructions, company_research/dossier, mini_compact, documents[]).
- **Goal_Workspace**: a área de trabalho por Goal no Dashboard, composta pelas abas Overview, Prep e Sessions, que substitui o modal de edição anterior.
- **Overview_Tab**: a aba de visão geral do Goal_Workspace (Next interview, Goal context, Goal Memory, Recent sessions).
- **Prep_Tab**: a aba de preparação do Goal_Workspace (Next focus, Goal brief, Knowledge sources, Response defaults, Start Practice).
- **Sessions_Tab**: a aba de sessões do Goal_Workspace que lista os debriefs do Goal corrente.
- **History_View**: a visão global de histórico que lista os debriefs de todos os Goals, do mais recente ao mais antigo.
- **Goal_Memory**: o painel "What we know" do Goal, com seções Strength e Improve, gerado por IA a partir de padrões entre reflections concluídas.
- **Reflection**: a reflexão gerada por IA ao final de uma sessão, derivada da transcrição e das sugestões, que é comprometida (committed) à Goal_Memory.
- **Session_Report**: o debrief de uma sessão gerado por IA, exibido em Sessions_Tab e History_View.
- **Debrief_Processing**: o estado de processamento pós-sessão durante o qual o Session_Report é gerado antes de ficar disponível.
- **Next_Focus**: o bloco "Next focus" da Prep_Tab, exibido somente após uma Reflection ter sido comprometida à Goal_Memory.
- **Goal_Brief**: o bloco "Goal brief" da Prep_Tab (company summary / job description).
- **Knowledge_Sources**: os documentos anexados ao Goal (resume/materials) usados como fonte de conhecimento (campo documents[]).
- **Response_Defaults**: os padrões de resposta do Goal: Playbook, Answer language e Coding language.
- **Account_Defaults**: os valores padrão de Playbook, Answer language e Coding language definidos no nível da conta/plataforma, herdados pelo Response_Defaults.
- **Next_Interview**: a próxima entrevista agendada de um Goal, com data e horário.
- **Scheduler**: o fluxo "When's the next round?" que captura e edita a data e o horário da Next_Interview.
- **Interview_Notification**: a notificação nativa do Windows disparada antes da Next_Interview.
- **Goal_Stage**: o estágio do Goal, alterado via "Update progress", com os valores Active, Interviewing, I got the offer e Moved on - archive.
- **Getting_Started_Checklist**: o card de primeiros passos (fundo creme #FDFBF7) que marca etapas concluídas: Create a goal, Add your resume, Run a practice session e Read your debrief.
- **IPC_Bridge**: a ponte `window.rtai` que expõe getState, saveAgent, startOverlay, companyRecon, readSessionDetail, setThemePreference e onOverlayStatus.

## Requirements

### Requirement 1 — Goal Workspace com abas Overview, Prep e Sessions

**User Story:** Como usuário, quero abrir uma meta e ver um workspace com abas Overview, Prep e Sessions, para que eu possa preparar, agendar e revisar entrevistas em um único lugar em vez de apenas editar campos.

#### Acceptance Criteria

1. WHEN o usuário abre um Goal no Dashboard, THE Dashboard SHALL exibir o Goal_Workspace com exatamente três abas rotuladas "Overview", "Prep" e "Sessions", substituindo o modal de edição anterior.
2. WHEN o usuário abre um Goal, THE Dashboard SHALL exibir a Overview_Tab como aba ativa inicial.
3. WHEN o usuário aciona uma das três abas, THE Dashboard SHALL exibir o conteúdo correspondente a essa aba e indicar visualmente a aba ativa.
4. THE Dashboard SHALL preservar a capacidade de editar os campos existentes do Goal (company, role, job_description, extra_instructions) dentro do Goal_Workspace.
5. WHEN o usuário salva alterações do Goal no Goal_Workspace, THE Dashboard SHALL persistir as alterações por meio de `window.rtai.saveAgent`.

### Requirement 2 — Overview: Next interview

**User Story:** Como usuário, quero ver e gerenciar a próxima entrevista agendada na Overview, para que eu saiba quando praticar e não perca a data.

#### Acceptance Criteria

1. WHERE existe uma Next_Interview agendada, THE Overview_Tab SHALL exibir o bloco "Next interview" com a data e o horário agendados e os controles "Edit date" e "Skip for now".
2. WHERE não existe uma Next_Interview agendada, THE Overview_Tab SHALL exibir o bloco "Next interview" em estado vazio com o controle de agendamento "When's the next round?".
3. WHEN o usuário aciona "Edit date", THE Dashboard SHALL abrir o Scheduler com a data e o horário atualmente agendados pré-selecionados.
4. WHEN o usuário aciona "Skip for now", THE Dashboard SHALL remover a data e o horário agendados da Next_Interview e exibir o bloco "Next interview" em estado vazio.

### Requirement 3 — Scheduler da próxima entrevista e notificação nativa

**User Story:** Como usuário, quero agendar a próxima entrevista com data e horário e receber um aviso antes dela, para que eu me prepare a tempo.

#### Acceptance Criteria

1. WHEN o usuário aciona "When's the next round?", THE Dashboard SHALL exibir o Scheduler com um seletor de calendário (data), um seletor de horário (time) e o controle "Skip for now".
2. WHEN o usuário confirma uma data e um horário no Scheduler, THE Dashboard SHALL persistir a data e o horário como a Next_Interview do Goal por meio de `window.rtai.saveAgent`.
3. WHEN o usuário aciona "Skip for now" no Scheduler, THE Dashboard SHALL fechar o Scheduler sem registrar data nem horário para a Next_Interview.
4. WHEN uma Next_Interview possui data e horário persistidos, THE Dashboard SHALL agendar uma Interview_Notification nativa do Windows para aproximadamente 1 hora antes do horário agendado.
5. WHEN o horário de disparo de uma Interview_Notification é atingido, THE Dashboard SHALL exibir uma notificação nativa do Windows identificando o Goal e o horário da Next_Interview.
6. WHEN o usuário altera a data ou o horário de uma Next_Interview existente, THE Dashboard SHALL recalcular o horário de disparo da Interview_Notification com base no novo horário agendado.
7. WHEN a data e o horário da Next_Interview são removidos por "Skip for now", THE Dashboard SHALL cancelar a Interview_Notification pendente associada a esse Goal.
8. IF o horário de disparo calculado para a Interview_Notification já é anterior ao momento atual no instante do agendamento, THEN THE Dashboard SHALL persistir a Next_Interview sem agendar a Interview_Notification.

### Requirement 4 — Overview: Goal context

**User Story:** Como usuário, quero ver na Overview o status do contexto da meta, para saber de relance se já anexei currículo, materiais e playbook.

#### Acceptance Criteria

1. THE Overview_Tab SHALL exibir o bloco "Goal context" com o status de anexo de Resume, Materials e Playbook do Goal.
2. WHERE um Resume está anexado ao Goal, THE Overview_Tab SHALL exibir o status de Resume como anexado.
3. WHERE nenhum Resume está anexado ao Goal, THE Overview_Tab SHALL exibir o status de Resume como não anexado.
4. WHERE um ou mais Materials estão anexados ao Goal, THE Overview_Tab SHALL exibir o status de Materials como anexado.
5. WHERE um Playbook está definido nos Response_Defaults do Goal, THE Overview_Tab SHALL exibir o status de Playbook como definido.

### Requirement 5 — Overview: Goal Memory "What we know"

**User Story:** Como usuário, quero ver um resumo do que o sistema aprendeu sobre meu desempenho na meta, para focar nos meus pontos fortes e no que preciso melhorar.

#### Acceptance Criteria

1. THE Overview_Tab SHALL exibir o painel Goal_Memory rotulado "What we know" com as seções "Strength" e "Improve".
2. WHERE não existe nenhuma Reflection comprometida ao Goal, THE Overview_Tab SHALL exibir o painel Goal_Memory em estado vazio.
3. WHEN uma Reflection é comprometida à Goal_Memory, THE Dashboard SHALL atualizar o conteúdo das seções "Strength" e "Improve" com texto gerado por IA a partir dos padrões entre as Reflections concluídas do Goal.
4. THE Dashboard SHALL derivar o conteúdo da Goal_Memory exclusivamente a partir das Reflections geradas por IA das sessões concluídas do Goal.

### Requirement 6 — Overview: Recent sessions

**User Story:** Como usuário, quero ver na Overview minhas sessões recentes da meta, para acessar rapidamente os debriefs mais novos.

#### Acceptance Criteria

1. THE Overview_Tab SHALL exibir o bloco "Recent sessions" com os Session_Reports do Goal ordenados do mais recente ao mais antigo.
2. WHERE o Goal não possui nenhum Session_Report, THE Overview_Tab SHALL exibir o bloco "Recent sessions" em estado vazio.
3. WHEN o usuário aciona um item em "Recent sessions", THE Dashboard SHALL exibir o Session_Report correspondente por meio de `window.rtai.readSessionDetail`.

### Requirement 7 — Estágios do Goal via "Update progress"

**User Story:** Como usuário, quero atualizar o estágio da minha meta, para refletir onde estou no processo e arquivar metas encerradas.

#### Acceptance Criteria

1. THE Goal_Workspace SHALL expor o controle "Update progress" com exatamente os estágios "Active", "Interviewing", "I got the offer" e "Moved on - archive".
2. WHEN o usuário seleciona um Goal_Stage em "Update progress", THE Dashboard SHALL persistir o estágio selecionado no Goal por meio de `window.rtai.saveAgent`.
3. THE Dashboard SHALL exibir o Goal_Stage corrente do Goal no Goal_Workspace.
4. WHEN um Goal é definido com o estágio "Moved on - archive", THE Dashboard SHALL marcar o Goal como arquivado na listagem de Goals.
5. WHEN um Goal é criado, THE Dashboard SHALL definir o Goal_Stage inicial como "Active".

### Requirement 8 — Prep: Next focus

**User Story:** Como usuário, quero ver o próximo foco de preparação na aba Prep, para saber no que trabalhar com base no que aprendi.

#### Acceptance Criteria

1. WHERE existe ao menos uma Reflection comprometida à Goal_Memory, THE Prep_Tab SHALL exibir o bloco Next_Focus rotulado "Next focus".
2. WHERE nenhuma Reflection foi comprometida à Goal_Memory, THE Prep_Tab SHALL ocultar o bloco Next_Focus.
3. WHEN uma Reflection é comprometida à Goal_Memory, THE Dashboard SHALL atualizar o conteúdo do Next_Focus com texto gerado por IA derivado das Reflections concluídas do Goal.

### Requirement 9 — Prep: Goal brief

**User Story:** Como usuário, quero registrar o resumo da empresa e a descrição da vaga na aba Prep, para que o contexto fique disponível na preparação e no overlay.

#### Acceptance Criteria

1. THE Prep_Tab SHALL exibir o bloco Goal_Brief rotulado "Goal brief" com o company summary e a job description do Goal.
2. WHEN o usuário edita o company summary ou a job description no Goal_Brief, THE Dashboard SHALL persistir o conteúdo nos campos correspondentes do Goal por meio de `window.rtai.saveAgent`.
3. WHERE o usuário aciona a pesquisa de empresa no Goal_Brief, THE Dashboard SHALL obter o resumo da empresa por meio de `window.rtai.companyRecon` e preencher o company summary com o resultado retornado.

### Requirement 10 — Prep: Knowledge sources

**User Story:** Como usuário, quero anexar currículo e materiais como fontes de conhecimento na aba Prep, para que a IA e o overlay usem meu contexto real.

#### Acceptance Criteria

1. THE Prep_Tab SHALL exibir o bloco Knowledge_Sources com a lista de documentos anexados ao Goal (campo documents[]).
2. WHEN o usuário anexa um resume ou material ao Knowledge_Sources, THE Dashboard SHALL adicionar o documento ao campo documents[] do Goal e persistir por meio de `window.rtai.saveAgent`.
3. WHEN o usuário remove um documento do Knowledge_Sources, THE Dashboard SHALL remover o documento do campo documents[] do Goal e persistir por meio de `window.rtai.saveAgent`.
4. WHERE o Goal não possui nenhum documento anexado, THE Prep_Tab SHALL exibir o Knowledge_Sources em estado vazio.

### Requirement 11 — Prep: Response defaults com herança da conta

**User Story:** Como usuário, quero definir os padrões de resposta da meta e herdar os padrões da conta quando não os sobrescrever, para evitar configurar tudo manualmente a cada meta.

#### Acceptance Criteria

1. THE Prep_Tab SHALL exibir o bloco Response_Defaults rotulado "Response defaults" com os campos Playbook, Answer language e Coding language.
2. WHERE um campo do Response_Defaults não possui valor definido no Goal, THE Dashboard SHALL exibir o valor herdado do Account_Defaults correspondente indicando que o valor é herdado.
3. WHEN o usuário define um valor para Playbook, Answer language ou Coding language no Goal, THE Dashboard SHALL persistir esse valor no Goal por meio de `window.rtai.saveAgent` e passar a usar o valor do Goal em vez do Account_Defaults.
4. WHEN o usuário limpa um valor sobrescrito de um campo do Response_Defaults, THE Dashboard SHALL restaurar a exibição do valor herdado do Account_Defaults para esse campo.

### Requirement 12 — Prep: Start Practice

**User Story:** Como usuário, quero iniciar uma sessão de prática a partir da aba Prep, para praticar com o overlay usando o contexto da meta.

#### Acceptance Criteria

1. THE Prep_Tab SHALL exibir o controle "Start Practice".
2. WHEN o usuário aciona "Start Practice", THE Dashboard SHALL iniciar o Overlay por meio de `window.rtai.startOverlay` passando o Goal corrente e os configOverrides derivados do Next_Focus, dos Response_Defaults e das Knowledge_Sources.
3. THE Dashboard SHALL incluir nos configOverrides enviados ao Overlay o Answer language, o Coding language e o Playbook efetivos do Goal, resolvendo valores herdados do Account_Defaults quando o Goal não os sobrescreve.

### Requirement 13 — Sessions tab e History com relatórios gerados por IA

**User Story:** Como usuário, quero ver os debriefs das sessões na aba Sessions e no histórico global, para revisar meu desempenho do mais recente ao mais antigo.

#### Acceptance Criteria

1. THE Sessions_Tab SHALL exibir os Session_Reports do Goal corrente ordenados do mais recente ao mais antigo.
2. THE History_View SHALL exibir os Session_Reports de todos os Goals ordenados do mais recente ao mais antigo.
3. WHEN uma sessão atinge o estado Debrief_Processing, THE Dashboard SHALL gerar o Session_Report por IA e, ao concluir o processamento, exibi-lo na Sessions_Tab do Goal e na History_View.
4. WHILE uma sessão está em Debrief_Processing, THE Dashboard SHALL indicar o estado de processamento do Session_Report correspondente.
5. WHERE o Goal não possui nenhum Session_Report, THE Sessions_Tab SHALL exibir um estado vazio consistente com as telas de referência.
6. WHERE não existe nenhum Session_Report em nenhum Goal, THE History_View SHALL exibir um estado vazio consistente com as telas de referência.
7. WHEN o usuário aciona um Session_Report, THE Dashboard SHALL exibir o detalhe do relatório por meio de `window.rtai.readSessionDetail`.

### Requirement 14 — Getting-started checklist

**User Story:** Como novo usuário, quero uma lista de primeiros passos que se marca conforme eu avanço, para saber o que fazer para começar a usar o produto.

#### Acceptance Criteria

1. THE Dashboard SHALL exibir o Getting_Started_Checklist com exatamente as etapas "Create a goal", "Add your resume", "Run a practice session" e "Read your debrief".
2. WHEN o usuário cria um Goal, THE Dashboard SHALL marcar a etapa "Create a goal" como concluída.
3. WHEN um resume é anexado a qualquer Goal, THE Dashboard SHALL marcar a etapa "Add your resume" como concluída.
4. WHEN uma sessão de prática é executada, THE Dashboard SHALL marcar a etapa "Run a practice session" como concluída.
5. WHEN o usuário abre um Session_Report, THE Dashboard SHALL marcar a etapa "Read your debrief" como concluída.
6. THE Dashboard SHALL exibir o estado concluído de cada etapa do Getting_Started_Checklist de forma visualmente distinta das etapas pendentes.

### Requirement 15 — Integração do Overlay (leitura e escrita)

**User Story:** Como usuário, quero que o overlay ao vivo use o contexto da minha meta e gere um debrief ao final, para que a prática seja personalizada e o aprendizado volte para a meta.

#### Acceptance Criteria

1. WHEN o Overlay é iniciado para um Goal, THE Overlay SHALL consumir o Next_Focus, os Response_Defaults (Answer language, Coding language, Playbook) e as Knowledge_Sources recebidos nos configOverrides.
2. WHILE uma sessão ao vivo está em andamento, THE Overlay SHALL aplicar o Answer language e o Coding language dos Response_Defaults recebidos às respostas geradas.
3. WHEN uma sessão ao vivo termina, THE Overlay SHALL produzir uma Reflection gerada por IA a partir da transcrição e das sugestões da sessão.
4. WHEN a Reflection de uma sessão é produzida, THE Dashboard SHALL comprometer a Reflection à Goal_Memory do Goal correspondente.
5. WHEN a Reflection de uma sessão é produzida, THE Dashboard SHALL disponibilizar o Session_Report correspondente na Sessions_Tab do Goal e na History_View.
6. WHILE o Overlay reporta estado por `window.rtai.onOverlayStatus`, THE Dashboard SHALL refletir o estado da sessão no Goal_Workspace.

### Requirement 16 — Fidelidade visual e preservação do existente

**User Story:** Como usuário, quero que as novas telas sigam a estética de referência mantendo o app e o overlay atuais funcionando, para ter uma experiência polida sem regressões.

#### Acceptance Criteria

1. THE Dashboard SHALL aplicar às telas do Goal_Workspace a tipografia, os rótulos de seção em caixa alta suave, o acento vermelho e o espaçamento limpo das referências de design.
2. THE Dashboard SHALL renderizar o Getting_Started_Checklist com fundo creme #FDFBF7.
3. THE Dashboard SHALL exibir os rótulos de UI das novas telas em inglês, incluindo "Next focus", "Goal brief", "Start Practice" e os estágios "Active", "Interviewing", "I got the offer" e "Moved on - archive".
4. THE Dashboard SHALL preservar o funcionamento do aplicativo pt-BR existente e do Overlay nativo sem regressão de comportamento.
5. THE Dashboard SHALL obter e persistir o estado do Goal_Workspace por meio da IPC_Bridge existente (`getState` e `saveAgent`) sem substituir o modelo de dados de "agents".
