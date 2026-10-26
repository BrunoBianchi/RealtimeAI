# Requirements Document

## Introduction

Esta feature redesenha por completo a UI/UX do HUD flutuante do copiloto de entrevista em tempo real (projeto C++/Win32 + Direct2D/DirectWrite). A interface atual está quebrada e deve passar a seguir as duas imagens de referência fornecidas, sendo 100% responsiva e com tamanho coerente. O objetivo central é uma experiência "glanceable" (legível em meio segundo) ancorada abaixo da webcam, com ergonomia cognitiva estrita: uma tese direta seguida de três âncoras, sem jitter durante o streaming, sem roubo de foco da aplicação de videochamada e invisível no compartilhamento de tela. O idioma de todo o produto e da UI é o português (pt-BR).

O redesenho cobre quatro superfícies principais do código existente: `src/overlay/src/overlay_window.cpp` e `src/overlay/include/rtai/overlay_window.hpp` (janela e renderização), `src/core/include/rtai/copilot_prompt.hpp` (formatação do prompt teleprompter), `src/core/include/rtai/decision_policy.hpp` e `src/core/src/copilot_engine.cpp` (regras anti-substituição). As regras EARS abaixo descrevem o comportamento observável; detalhes de implementação ficam para o documento de design.

## Glossary

- **HUD**: janela flutuante sem foco do copiloto, exibida sobre as demais aplicações.
- **Overlay**: o componente de janela Win32 (`OverlayWindow`) responsável por renderizar o HUD. Usa-se "Overlay" como nome de sistema nas regras.
- **Decision_Policy**: componente de núcleo (`DecisionPolicy`) que decide quando uma fala fechada merece uma sugestão automática.
- **Copilot_Engine**: orquestrador de núcleo que publica `EngineEvent` para o Overlay.
- **Prompt_Builder**: código de `copilot_prompt.hpp` que monta as mensagens enviadas ao modelo de linguagem.
- **Modo_Setup**: estado anterior à chamada no qual o usuário configura currículo, chave de API, modelo, idioma e vaga.
- **Modo_Ao_Vivo**: estado durante a entrevista no qual a barra de controle encolhe para uma pílula minimalista e configurações ficam bloqueadas (Stealth HUD).
- **Strip_Unificada**: zona superior compacta (~38px) que funde a barra de controle e o indicador de transcrição ao vivo.
- **Headline**: primeira linha da resposta (tese direta), renderizada em branco 15.5sp em negrito.
- **Ancora**: cada um dos 3 bullets de resposta, com termo-chave em negrito seguido de explicação em cinza claro.
- **Micro_Footer**: rodapé do card com hints de atalho e telemetria discreta.
- **Trigger_Lock**: congelamento da pergunta que originou a resposta atual no cabeçalho do card.
- **Pin_On_Speak**: bloqueio da substituição automática do card enquanto o usuário fala.
- **Pulse_Bar**: indicador de áudio linear (3 micro-barras verticais) que reage ao RMS real, em substituição ao spinner giratório.
- **RMS**: valor eficaz do nível de áudio (0..1) de uma origem de captura.
- **Teleprompter_Formatting**: formato de saída do modelo (tese + 3 bullets rotulados).
- **Rich_Layout_Parser**: parser do Overlay que detecta a primeira linha e os prefixos de bullet para aplicar fonte/cor.
- **Zona_De_Ancoragem**: posição e largura padrão do HUD colado abaixo da webcam (Top-Center).
- **Hotkey_Global**: atalho de teclado registrado via `RegisterHotKey`, ativo mesmo sem foco.
- **Modo_Panic**: estado Stealth acionado por atalho que oculta o HUD (opacidade 0% ou ponto de 8x8px).
- **DIP**: device-independent pixel (unidade lógica do Direct2D). Medidas em "px"/"sp" nas imagens de referência são tratadas como DIP.

## Requirements

### Requirement 1: Zona de ancoragem e dimensões padrão

**User Story:** Como usuário em entrevista, quero o HUD ancorado abaixo da webcam com largura coerente, para ler a resposta de relance sem desviar o olhar da câmera.

#### Acceptance Criteria

1. WHEN o Overlay é criado sem posição persistida, THE Overlay SHALL posicionar a janela em Top-Center com a borda superior entre 8 e 10 DIP, inclusive, do topo da área de trabalho do monitor primário.
2. WHEN o Overlay é criado sem largura persistida, THE Overlay SHALL definir a largura da janela em 480 DIP.
3. THE Overlay SHALL restringir a largura da janela ao intervalo de 460 a 540 DIP, inclusive, travando qualquer valor fora do intervalo ao limite mais próximo (valores abaixo de 460 DIP tornam-se 460 DIP; valores acima de 540 DIP tornam-se 540 DIP).
4. THE Overlay SHALL centralizar a janela horizontalmente usando a largura efetiva, definindo a posição horizontal como (largura_da_area_de_trabalho menos largura_efetiva) dividido por 2, arredondado ao DIP inteiro mais próximo.
5. WHERE há múltiplos monitores, THE Overlay SHALL usar a área de trabalho do monitor que contém o ponto central da posição persistida, ou a área de trabalho do monitor primário quando não há posição persistida.
6. WHEN o conteúdo é renderizado, THE Overlay SHALL ajustar a altura da janela à altura total do conteúdo renderizado, limitada à altura máxima definida no critério 7.
7. THE Overlay SHALL limitar a altura da janela a uma fração configurável da altura da área de trabalho do monitor, com valor padrão de 0.6 e intervalo válido de 0.1 a 1.0, inclusive; valores fora do intervalo são travados ao limite mais próximo.
8. IF a altura do conteúdo renderizado excede a altura máxima permitida definida no critério 7, THEN THE Overlay SHALL manter a altura da janela no limite máximo e tornar o excedente do card de resposta rolável, preservando a visibilidade do início do conteúdo.
9. IF a posição persistida não intersecta a área de trabalho de nenhum monitor disponível, THEN THE Overlay SHALL reposicionar a janela em Top-Center do monitor primário usando as dimensões padrão dos critérios 1 e 2.

### Requirement 2: Layout em três zonas empilhadas

**User Story:** Como usuário, quero um layout enxuto em três zonas, para que cada pixel vertical sirva à leitura rápida.

#### Acceptance Criteria

1. THE Overlay SHALL renderizar três zonas empilhadas verticalmente na ordem, de cima para baixo, Strip_Unificada, Headline mais Âncoras, e Micro_Footer.
2. THE Overlay SHALL separar cada par de zonas adjacentes com um espaçamento vertical de exatamente 6 DIP, sem sobreposição entre zonas.
3. WHILE em Modo_Ao_Vivo, THE Overlay SHALL renderizar a Strip_Unificada com altura entre 36 e 38 DIP, inclusive.
4. THE Overlay SHALL exibir na Strip_Unificada exatamente dois toggles de captura, um para o áudio do sistema e um para o microfone, cada um acompanhado de um ponto de gravação e um indicador de nível.
5. WHILE um toggle de captura está ativo, THE Overlay SHALL exibir o ponto de gravação correspondente no estado ativo e o indicador de nível refletindo o nível de áudio corrente entre 0 e 100 por cento.
6. WHILE um toggle de captura está inativo, THE Overlay SHALL exibir o ponto de gravação correspondente no estado inativo e o indicador de nível em 0 por cento.
7. THE Overlay SHALL recolher todos os controles de configuração da Strip_Unificada em um único ícone de reticências alinhado à borda direita da Strip_Unificada.
8. WHERE a largura efetiva da Strip_Unificada é menor que o limiar de colapso definido no design, THE Overlay SHALL ocultar os rótulos de texto e as dicas de atalho de todos os botões, mantendo visíveis apenas os ícones.
9. WHERE a largura efetiva da Strip_Unificada é maior ou igual ao limiar de colapso definido no design, THE Overlay SHALL exibir os rótulos de texto e as dicas de atalho dos botões junto aos respectivos ícones.

### Requirement 3: Regra 1+3 de divulgação progressiva

**User Story:** Como usuário sob pressão, quero uma tese curta seguida de três âncoras, para captar a resposta em meio segundo e detalhar com os olhos.

#### Acceptance Criteria

1. WHEN uma resposta é renderizada, THE Overlay SHALL exibir a Headline em uma única linha com fonte 15.5 DIP SemiBold na cor branca em opacidade total.
2. IF o texto da Headline excede a largura efetiva disponível em uma única linha, THEN THE Overlay SHALL truncar a Headline no limite da largura efetiva e indicar o truncamento com reticências, sem quebrar para uma segunda linha.
3. WHEN uma resposta é renderizada, THE Overlay SHALL exibir exatamente 3 Âncoras abaixo da Headline.
4. IF a resposta disponível contém menos de 3 Âncoras, THEN THE Overlay SHALL exibir as Âncoras disponíveis e preencher as posições restantes com Âncoras vazias, mantendo exatamente 3 posições de Âncora.
5. THE Overlay SHALL renderizar o termo-chave inicial de cada Âncora, definido como a primeira sequência de caracteres de 1 a 24 caracteres delimitada pelo primeiro separador de dois-pontos, em negrito na cor de destaque, e o restante da Âncora na cor rgba(255,255,255,0.78) com fonte 13.5 DIP.
6. THE Overlay SHALL definir a cor de destaque como rgb(10,132,255) quando a paleta configurada for a paleta de acento, ou como branco em opacidade total quando a paleta configurada for a paleta monocromática.
7. WHERE a largura efetiva é 480 DIP, THE Overlay SHALL dimensionar a tipografia de modo a renderizar entre 45 e 55 caracteres por linha de texto de resposta, inclusive nos limites de 45 e 55 caracteres.
8. IF a Âncora excede a largura efetiva disponível após o termo-chave, THEN THE Overlay SHALL truncar a Âncora no limite da largura efetiva e indicar o truncamento com reticências.

### Requirement 4: Formatação teleprompter do prompt

**User Story:** Como usuário, quero que o modelo sempre responda no formato tese mais três bullets rotulados, para que o parser da UI aplique o destaque correto.

#### Acceptance Criteria

1. THE Prompt_Builder SHALL incluir no prompt de sistema a instrução de iniciar a resposta com exatamente uma linha de tese em negrito, com 1 a 12 palavras, sem texto introdutório antes dela e sem conteúdo adicional após ela na mesma linha.
2. THE Prompt_Builder SHALL incluir no prompt de sistema a instrução de listar exatamente 3 bullets, cada um iniciando com 2 a 3 palavras-chave em negrito seguidas do caractere ":" e, após os dois pontos, 1 a 15 palavras redigidas em primeira pessoa.
3. WHERE a pergunta é comportamental, THE Prompt_Builder SHALL instruir o modelo a usar, em ordem, exatamente os rótulos "Contexto:", "Ação Chave:" e "Resultado (Métrica):", um por bullet.
4. WHERE a pergunta é de system design ou arquitetura, THE Prompt_Builder SHALL instruir o modelo a usar, em ordem, exatamente os rótulos "Componente Central:", "Escalabilidade/Gargalo:" e "Trade-off:", um por bullet.
5. WHERE a pergunta não é comportamental nem de system design ou arquitetura, THE Prompt_Builder SHALL instruir o modelo a iniciar cada um dos 3 bullets com 2 a 3 palavras-chave em negrito escolhidas pelo próprio modelo, seguidas do caractere ":".
6. THE Prompt_Builder SHALL incluir no prompt de sistema a instrução de limitar a resposta a um total entre 80 e 120 tokens, incluindo a linha de tese e os 3 bullets.
7. THE Prompt_Builder SHALL incluir no prompt de sistema a instrução de responder usando apenas fatos presentes na transcrição e no contexto do usuário, sem inventar números, nomes, clientes ou experiências não presentes nessas fontes.

### Requirement 5: Parser de layout rico na resposta

**User Story:** Como usuário, quero que a UI interprete a estrutura da resposta do modelo, para ver a tese e os termos-chave destacados automaticamente.

#### Acceptance Criteria

1. WHEN o Rich_Layout_Parser recebe o texto de uma resposta não vazia, THE Overlay SHALL identificar a primeira linha não vazia como Headline e renderizá-la com fonte 15.5 DIP na cor de destaque.
2. IF o texto da resposta recebido estiver vazio ou contiver apenas espaços em branco, THEN THE Overlay SHALL não renderizar nenhuma Headline nem bullet e exibir a área de conteúdo vazia, preservando o texto original sem modificá-lo.
3. WHEN o Rich_Layout_Parser encontra um bullet contendo o primeiro caractere ":", THE Overlay SHALL colorir o texto anterior ao primeiro ":" na cor de destaque e o texto posterior ao primeiro ":" na cor de texto secundário.
4. WHEN o Rich_Layout_Parser encontra um bullet que não contém o caractere ":", THE Overlay SHALL renderizar o texto completo do bullet na cor de texto secundário.
5. WHEN o Rich_Layout_Parser encontra um trecho delimitado por exatamente dois asteriscos de abertura e dois asteriscos de fechamento ("**"), THE Overlay SHALL renderizar o texto interno em negrito e remover os asteriscos delimitadores do texto exibido.
6. IF um trecho contiver um par de asteriscos duplos de abertura sem o par de fechamento correspondente na mesma linha, THEN THE Overlay SHALL renderizar os asteriscos como texto literal sem aplicar negrito.
7. WHEN o Rich_Layout_Parser processa uma resposta com qualquer número de bullets detectados entre 0 e 20, THE Overlay SHALL renderizar exatamente os bullets detectados sem inserir, remover ou reordenar conteúdo textual.

### Requirement 6: Streaming sem jitter de texto

**User Story:** Como usuário lendo durante o streaming, quero que o card cresça de forma suave, para que o texto não trema nem mude de posição a cada token.

#### Acceptance Criteria

1. WHEN o Overlay recebe um SuggestionStartedEvent, THE Overlay SHALL pré-alocar o card de resposta com altura mínima de 2 linhas de texto antes de exibir o primeiro delta.
2. WHILE deltas de uma sugestão chegam, THE Overlay SHALL confirmar visualmente apenas o texto que termina em um separador de palavra (espaço, pontuação ou quebra de linha), retendo em buffer qualquer sequência de caracteres sem separador final.
3. WHILE deltas de uma sugestão chegam, THE Overlay SHALL coalescer todas as atualizações pendentes em no máximo 1 redesenho por intervalo de 16 milissegundos.
4. WHEN o conteúdo confirmado excede a altura atual do card, THE Overlay SHALL expandir a altura em blocos de 1 linha de texto aplicando transição ease-out com duração de 150 milissegundos.
5. WHILE deltas de uma sugestão chegam, THE Overlay SHALL renderizar apenas palavras completas, não exibindo qualquer palavra parcial ou sílaba quebrada na borda até que seu separador de palavra seja recebido.
6. WHEN o Overlay recebe um SuggestionCompletedEvent, THE Overlay SHALL confirmar e renderizar qualquer texto retido em buffer que ainda não terminava em separador de palavra.
7. IF nenhum delta é recebido dentro de 5 segundos após o SuggestionStartedEvent, THEN THE Overlay SHALL manter a altura mínima pré-alocada e exibir um indicador visual de espera, preservando o card sem reduzir sua altura.

### Requirement 7: Separação entre Modo Setup e Modo Ao Vivo

**User Story:** Como usuário, quero configurar tudo antes da chamada, para que durante a entrevista o HUD seja mínimo e eu não altere ajustes por engano.

#### Acceptance Criteria

1. WHILE em Modo_Ao_Vivo, THE Overlay SHALL impedir a alteração dos valores de currículo, chave de API, modelo, idioma e vaga, mantendo os controles de edição desses campos em estado desabilitado (não editáveis e não acionáveis).
2. WHERE o usuário solicita configuração WHILE em Modo_Ao_Vivo, THE Overlay SHALL direcionar o acesso às configurações ao menu fechado ou ao fluxo de Modo_Setup, sem aplicar nenhuma alteração aos valores de currículo, chave de API, modelo, idioma ou vaga enquanto permanecer em Modo_Ao_Vivo.
3. WHEN o Overlay entra em Modo_Ao_Vivo, THE Overlay SHALL encolher a barra de controle para a pílula minimalista com altura entre 36 e 38 DIP, inclusive nos extremos.
4. WHILE em Modo_Setup, THE Overlay SHALL permitir a edição dos valores de currículo, chave de API, modelo, idioma e vaga, mantendo os controles de edição desses campos em estado habilitado.
5. IF o usuário tenta alterar currículo, chave de API, modelo, idioma ou vaga WHILE em Modo_Ao_Vivo, THEN THE Overlay SHALL rejeitar a alteração, preservar o valor vigente de cada campo sem modificação e exibir uma indicação visível de que a edição está disponível apenas em Modo_Setup.

### Requirement 8: Trava visual da pergunta (Trigger Lock)

**User Story:** Como usuário, quero que a pergunta que gerou a resposta fique congelada no card, para não confundir com falas novas que continuam chegando.

#### Acceptance Criteria

1. WHEN uma resposta é disparada, THE Overlay SHALL capturar o texto verbatim da pergunta que originou a resposta e exibi-lo no cabeçalho do card em até 200 ms após o disparo, precedido por um ícone de citação.
2. WHILE uma resposta está exibida, THE Overlay SHALL manter o texto da pergunta congelada byte a byte idêntico ao capturado no momento do disparo, independentemente da quantidade de TranscriptUpdateEvent recebidos.
3. WHEN um ou mais TranscriptUpdateEvent chegam enquanto uma resposta está exibida, THE Overlay SHALL atualizar exclusivamente o indicador de áudio da Strip_Unificada com a fala nova e SHALL NOT alterar, substituir ou anexar conteúdo ao texto da pergunta congelada no cabeçalho do card.
4. IF o texto verbatim da pergunta exceder 280 caracteres, THEN THE Overlay SHALL exibir os primeiros 280 caracteres seguidos de reticências no cabeçalho do card, preservando internamente o texto completo capturado.
5. IF nenhum texto de pergunta estiver disponível no momento do disparo da resposta, THEN THE Overlay SHALL exibir no cabeçalho do card um indicador textual de ausência de pergunta e SHALL manter o ícone de citação.

### Requirement 9: Anti-substituição acidental (Pin on Speak)

**User Story:** Como usuário, quero que o card atual não seja substituído quando eu começo a falar, para não perder a resposta que estou lendo em voz alta.

#### Acceptance Criteria

1. WHILE o usuário está falando pelo microfone local com atividade de voz contínua por 300 ms ou mais acima do limiar de detecção, ou enquanto uma tecla de fala está pressionada, THE Decision_Policy SHALL impedir a substituição automática do card atual por uma nova sugestão.
2. IF uma nova pergunta é detectada enquanto o usuário fala, THEN THE Overlay SHALL exibir no rodapé a pílula "Nova pergunta detectada (Aperte [Tab] para ver)".
3. WHEN o usuário aciona [Tab] com uma pílula de nova pergunta exibida, THE Overlay SHALL exibir a próxima sugestão e remover a pílula de nova pergunta do rodapé.
4. IF uma resposta foi exibida há menos de 4000 ms e é detectada atividade de voz com duração inferior a 300 ms acima do limiar de detecção, THEN THE Overlay SHALL manter o card atual exibido sem limpá-lo automaticamente.
5. IF o card não pode ser substituído por estar dentro da janela de 4000 ms, THEN THE Overlay SHALL enfileirar a nova sugestão como "Próxima sugestão pronta" até um máximo de 5 sugestões, descartando a sugestão mais antiga da fila quando o limite for excedido.
6. WHEN a janela de 4000 ms expira sem que o usuário esteja falando e existe uma sugestão enfileirada, THE Overlay SHALL substituir o card atual pela próxima sugestão enfileirada.

### Requirement 10: Interação sem roubo de foco (Zero-Focus-Steal)

**User Story:** Como usuário em uma videochamada, quero clicar nos botões do HUD sem perder o foco da chamada, para que minha câmera e áudio continuem ativos.

#### Acceptance Criteria

1. THE Overlay SHALL criar a janela com o estilo estendido WS_EX_NOACTIVATE.
2. WHEN a janela recebe WM_MOUSEACTIVATE, THE Overlay SHALL retornar MA_NOACTIVATE em até 16 ms.
3. WHEN o usuário clica em um botão do HUD, THE Overlay SHALL executar a ação do botão sem transferir o foco da aplicação em primeiro plano para o HUD, mantendo a mesma janela em primeiro plano antes e depois do clique.
4. WHEN o usuário ativa o campo de chat, THE Overlay SHALL registrar o identificador da janela que detinha o foco imediatamente antes da ativação e adquirir o foco de teclado.
5. WHEN o usuário conclui ou cancela a entrada no campo de chat, THE Overlay SHALL restaurar o foco de teclado à janela registrada em até 100 ms.
6. IF a restauração do foco à aplicação anterior falha, THEN THE Overlay SHALL liberar o foco de teclado sem o reter e publicar um NoticeEvent de nível Warning indicando a falha na restauração do foco.
7. IF nenhuma janela anterior de foco foi registrada quando a entrada é concluída ou cancelada, THEN THE Overlay SHALL liberar o foco de teclado sem transferi-lo a qualquer janela.

### Requirement 11: Invisibilidade no compartilhamento de tela

**User Story:** Como usuário, quero que o HUD não apareça quando eu compartilho a tela, para manter o copiloto discreto.

#### Acceptance Criteria

1. WHEN o Overlay é criado, THE Overlay SHALL aplicar SetWindowDisplayAffinity com WDA_EXCLUDEFROMCAPTURE à janela em até 500 ms após a criação.
2. THE Overlay SHALL criar a janela com o estilo estendido WS_EX_TOOLWINDOW.
3. THE Overlay SHALL manter a janela fora da barra de tarefas e da lista de Alt+Tab.
4. IF SetWindowDisplayAffinity falha ou não é suportado pela versão do Windows em execução, THEN THE Overlay SHALL publicar um NoticeEvent de nível Warning informando que a exclusão de captura não está disponível e SHALL manter a janela operacional com a interação do HUD inalterada.
5. WHEN a aplicação da afinidade de exclusão de captura é concluída com sucesso, THE Overlay SHALL registrar o estado de exclusão de captura como ativo de modo observável pela aplicação.

### Requirement 12: Hotkeys globais discretas

**User Story:** Como usuário, quero controlar o HUD por atalhos globais sem clicar, para agir rápido sem tirar o foco da entrevista.

#### Acceptance Criteria

1. WHEN o usuário aciona a Hotkey_Global de resposta imediata (Alt+Espaço ou Ctrl+Espaço), THE Overlay SHALL solicitar ao Copilot_Engine uma resposta a partir do buffer atual do montador de turnos em até 100 ms após o acionamento.
2. IF o buffer atual do montador de turnos está vazio quando a Hotkey_Global de resposta imediata é acionada, THEN THE Overlay SHALL ignorar o acionamento e publicar um NoticeEvent de nível Info indicando que não há conteúdo disponível.
3. WHEN o usuário aciona a Hotkey_Global de navegação de histórico (Alt+Seta Cima ou Alt+Seta Baixo), THE Overlay SHALL alternar a exibição entre a resposta atual e a resposta imediatamente anterior no histórico, limitado a um máximo de 50 respostas armazenadas.
4. IF não existe resposta anterior no histórico quando a Hotkey_Global de navegação de histórico é acionada, THEN THE Overlay SHALL manter a resposta atual exibida e publicar um NoticeEvent de nível Info indicando o fim do histórico.
5. WHEN o usuário aciona a Hotkey_Global de ação rápida 1 (Alt+1), THE Overlay SHALL solicitar ao Copilot_Engine uma versão mais curta em tópicos da resposta atual.
6. WHEN o usuário aciona a Hotkey_Global de ação rápida 2 (Alt+2), THE Overlay SHALL solicitar ao Copilot_Engine um exemplo baseado no currículo do usuário.
7. WHEN o usuário aciona a Hotkey_Global de ação rápida 3 (Alt+3), THE Overlay SHALL solicitar ao Copilot_Engine a geração de código com análise de complexidade.
8. WHEN o usuário aciona a Hotkey_Global de Panic (Alt+H) e o Modo_Panic está inativo, THE Overlay SHALL ativar o Modo_Panic ocultando o HUD com opacidade 0% ou colapsando para um ponto de 8 por 8 DIP em até 50 ms após o acionamento.
9. WHEN o usuário aciona a Hotkey_Global de Panic (Alt+H) e o Modo_Panic está ativo, THE Overlay SHALL desativar o Modo_Panic restaurando a opacidade e o tamanho do HUD anteriores à ativação em até 50 ms após o acionamento.
10. IF o registro de uma Hotkey_Global falha, THEN THE Overlay SHALL publicar um NoticeEvent de nível Warning indicando o atalho em conflito e preservar os demais atalhos registrados com sucesso.

### Requirement 13: Micro-animações de estado

**User Story:** Como usuário, quero sinais de estado sutis em vez de um spinner, para perceber "ouvindo" e "gerando" sem distração.

#### Acceptance Criteria

1. WHILE o Overlay está no estado de escuta do entrevistador, THE Overlay SHALL renderizar a Pulse_Bar com 3 micro-barras verticais de 12 DIP de largura cada, atualizando a altura de cada barra a cada 16 ms (60 quadros por segundo), mapeando o valor RMS da origem de captura (faixa de 0.0 a 1.0) para uma altura entre 2 DIP (RMS igual a 0.0) e 24 DIP (RMS igual ou superior a 1.0).
2. WHILE o Overlay está no estado de geração de resposta, THE Overlay SHALL renderizar um shimmer horizontal na borda superior do card, oscilando a opacidade entre 0.04 e 0.12 em um ciclo completo de 1200 ms de forma contínua.
3. WHEN uma nova linha de resposta é adicionada ao card, THE Overlay SHALL animar o surgimento da linha com um fade-in que varia a opacidade de 0.0 a 1.0 ao longo de 200 ms.
4. THE Overlay SHALL exibir a Pulse_Bar como único indicador de estado de atividade, não renderizando nenhum elemento de spinner giratório em qualquer estado.
5. IF o valor RMS da origem de captura não estiver disponível durante o estado de escuta, THEN THE Overlay SHALL renderizar as 3 micro-barras na altura mínima de 2 DIP e manter esse estado até que um valor RMS válido seja recebido.

### Requirement 14: Renderização de texto sobre fundo transparente

**User Story:** Como usuário, quero texto nítido sobre o fundo transparente do HUD, para ler com conforto em qualquer plano de fundo.

#### Acceptance Criteria

1. WHEN o Overlay desenha um bloco de texto, THE Overlay SHALL habilitar a opção D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT e aplicar o modo de antialiasing de texto D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE.
2. THE Overlay SHALL compor a janela com transparência por pixel usando UpdateLayeredWindow, de modo que cada pixel renderizado preserve seu valor de canal alfa individual (0 a 255) sem aplicar uma cor de chroma key única para toda a janela.
3. WHEN o Overlay renderiza texto sobre o fundo transparente, THE Overlay SHALL aplicar uma cor de contorno ou sombra ao redor de cada glifo com largura mínima de 1 pixel e opacidade mínima de 60%, garantindo relação de contraste de no mínimo 4.5:1 entre o texto e qualquer pixel de plano de fundo adjacente.
4. WHILE o conteúdo textual de um bloco permanece idêntico entre quadros consecutivos, THE Overlay SHALL reutilizar o IDWriteTextLayout armazenado em cache desse bloco, sem recriá-lo.
5. IF a criação ou atualização do IDWriteTextLayout de um bloco falha, THEN THE Overlay SHALL preservar o último layout válido em cache desse bloco, manter o quadro anterior exibido e registrar um evento de erro indicando a falha de renderização do bloco.

### Requirement 15: Micro-footer com hints e telemetria

**User Story:** Como usuário, quero ver atalhos úteis e a latência de forma discreta, para agir rápido e confiar no tempo de resposta.

#### Acceptance Criteria

1. THE Overlay SHALL exibir no Micro_Footer as dicas de atalho de detalhamento e de exemplo de código, cada dica contendo o rótulo da ação e a respectiva combinação de teclas.
2. WHEN um SuggestionDoneEvent é recebido, THE Overlay SHALL exibir no Micro_Footer a telemetria de tempo até o primeiro token e de tempo total, cada valor expresso em milissegundos inteiros (0 a 600000 ms), em fonte de tamanho menor ou igual ao do texto principal do card.
3. IF o SuggestionDoneEvent não contém valor válido para tempo até o primeiro token ou para tempo total, THEN THE Overlay SHALL exibir o indicador de valor indisponível no campo correspondente do Micro_Footer e preservar os demais campos de telemetria já exibidos.
4. THE Overlay SHALL exibir no card a navegação de histórico com a posição atual no formato "N de M", onde N é a posição atual (1 a M) e M é a contagem total de sugestões no histórico (1 a 999).
5. IF o histórico contém exatamente uma sugestão (M igual a 1), THEN THE Overlay SHALL exibir "1 de 1" e desabilitar os controles de navegação para sugestão anterior e posterior.
6. THE Overlay SHALL exibir no card os controles de feedback de polegar para cima e polegar para baixo, cada controle identificável de forma distinta.
7. WHEN o usuário aciona um controle de feedback, THE Overlay SHALL publicar um FeedbackEvent contendo o voto correspondente (positivo para polegar para cima, negativo para polegar para baixo) e o identificador da sugestão atualmente exibida.
8. WHEN o usuário aciona um controle de feedback já selecionado para a sugestão atual, THE Overlay SHALL publicar um FeedbackEvent indicando a remoção do voto e atualizar o estado visual do controle para não selecionado.
