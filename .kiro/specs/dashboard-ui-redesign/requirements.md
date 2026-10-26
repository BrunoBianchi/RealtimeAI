# Requirements Document

## Introduction

Este documento define os requisitos para um redesign puramente visual e estético do dashboard do aplicativo Electron "RealTimeAI" (Interview Copilot). O objetivo é elevar a aparência para um padrão elegante, profissional, minimalista e amigável ao usuário, inspirado nas referências Parakeet AI e AcedlyAI, sem alterar o layout estrutural nem qualquer funcionalidade existente.

O redesign atua sobre os tokens de design (raio de cantos, paleta de acento, tipografia, espaçamento e sombras), mantém os dois temas (claro e escuro) polidos e consistentes, harmoniza a cor de acento do overlay nativo (C++/Direct2D) com a nova paleta do dashboard, e garante acessibilidade de contraste. Nenhuma lógica de aplicação, estrutura de views ou comportamento de componentes deve ser alterada.

Os arquivos-alvo são: `dashboard/src/index.html`, `dashboard/src/styles.css` (gerado), `dashboard/src/tailwind.input.css`, `dashboard/tailwind.config.js`, `dashboard/src/app.js` (somente ajustes visuais) e `src/overlay/src/overlay_window.cpp` (somente acento/harmonização).

## Glossary

- **Dashboard**: A interface Electron do aplicativo RealTimeAI renderizada a partir de `dashboard/src/index.html`.
- **Overlay**: A janela nativa em C++/Direct2D definida em `src/overlay/src/overlay_window.cpp` que exibe o HUD ao vivo.
- **Design_Token**: Variável de design centralizada (ex.: raio, cor, sombra) definida como variável CSS HSL em `:root` e `.dark` no arquivo `tailwind.input.css`, ou constante equivalente no overlay.
- **Tema_Claro**: Conjunto de tokens aplicado quando o modo claro está ativo (bloco `:root`).
- **Tema_Escuro**: Conjunto de tokens aplicado quando o modo escuro está ativo (classe `.dark`).
- **Cor_De_Acento**: A cor dominante de destaque usada em elementos interativos e estados de foco da interface.
- **Contexto_Live**: Estados visuais relacionados a transmissão/gravação ao vivo, como o botão "Go Live" ativo e o indicador de gravação.
- **Theme_Switcher**: O controle do Dashboard que alterna entre os modos Windows (seguir o sistema), Claro e Escuro.
- **Raio_De_Canto**: O token `--radius` que controla o arredondamento de botões, inputs e cards.
- **Contraste_WCAG_AA**: Razão de contraste de cor igual ou superior a 4.5:1 para texto normal e 3:1 para texto grande e elementos gráficos de interface, conforme WCAG 2.1 nível AA.

## Requirements

### Requirement 1 — Redução do raio de canto

**User Story:** Como usuário, quero cantos mais contidos e retos na interface, para que o dashboard tenha uma aparência mais minimalista e profissional.

#### Acceptance Criteria

1. THE Dashboard SHALL definir o Design_Token `--radius` com o valor `0.375rem` tanto no Tema_Claro quanto no Tema_Escuro.
2. THE Dashboard SHALL aplicar o Raio_De_Canto derivado de `--radius` a todos os botões, inputs e cards por meio dos tokens de borda existentes (`lg`, `md`, `sm`).
3. WHERE um componente usa valor de raio fixo em vez do Design_Token (ex.: `rounded-lg`, `rounded-md` com valor literal), THE Dashboard SHALL manter esse componente consistente com o Raio_De_Canto reduzido.

### Requirement 2 — Nova cor de acento

**User Story:** Como usuário, quero uma cor de acento elegante e não dominada pelo vermelho, para que a interface transmita profissionalismo e calma.

#### Acceptance Criteria

1. THE Dashboard SHALL adotar uma Cor_De_Acento diferente do vermelho `#E11D48` como cor dominante de destaque.
2. THE Dashboard SHALL aplicar a Cor_De_Acento de forma consistente nos elementos interativos e estados de foco definidos pelos tokens de design.
3. WHERE um elemento pertence ao Contexto_Live, THE Dashboard SHALL poder manter o vermelho como cor desse contexto específico.
4. THE Dashboard SHALL definir a Cor_De_Acento por meio de Design_Tokens em variáveis CSS HSL, sem cores codificadas de forma dispersa fora dos tokens.

### Requirement 3 — Consistência entre temas claro e escuro

**User Story:** Como usuário, quero que os temas claro e escuro estejam igualmente polidos, para que a experiência seja coerente independentemente do modo escolhido.

#### Acceptance Criteria

1. THE Dashboard SHALL definir valores completos para todos os Design_Tokens tanto no Tema_Claro quanto no Tema_Escuro.
2. WHEN o Theme_Switcher alterna entre Claro e Escuro, THE Dashboard SHALL aplicar o conjunto de tokens correspondente a todos os componentes visíveis.
3. WHEN o Theme_Switcher está no modo Windows, THE Dashboard SHALL aplicar o Tema_Claro ou o Tema_Escuro conforme a preferência de tema do sistema operacional.
4. THE Dashboard SHALL preservar o comportamento atual do Theme_Switcher com as três opções Windows, Claro e Escuro.

### Requirement 4 — Tokens de tipografia, espaçamento e sombras

**User Story:** Como usuário, quero tipografia, espaçamento e sombras refinados, para que a interface pareça leve, legível e bem organizada.

#### Acceptance Criteria

1. THE Dashboard SHALL manter a família de fonte Segoe UI Variable como fonte primária da interface.
2. THE Dashboard SHALL aplicar escalas de tipografia e espaçamento de forma consistente entre componentes equivalentes.
3. THE Dashboard SHALL aplicar sombras sutis e consistentes nos cards e superfícies elevadas por meio dos tokens de sombra definidos em `tailwind.config.js`.
4. THE Dashboard SHALL manter a legibilidade do texto em superfícies de ambos os temas.

### Requirement 5 — Preservação de layout e estrutura

**User Story:** Como usuário, quero que o layout e a estrutura permaneçam idênticos, para que eu não precise reaprender a navegar após o redesign.

#### Acceptance Criteria

1. THE Dashboard SHALL preservar as views Goals, Library, History e Settings sem alterar sua estrutura de navegação.
2. THE Dashboard SHALL preservar as abas Resumes, Materials, Playbooks e About you dentro da view Library.
3. THE Dashboard SHALL preservar a subnavegação de Settings com os itens General, Appearance, Defaults, Privacy & Stealth, Shortcuts e Account & Billing.
4. THE Dashboard SHALL preservar a sidebar contendo Goals, UP NEXT, informação de plano e perfil.
5. THE Dashboard SHALL preservar a posição e a hierarquia dos elementos de layout existentes.

### Requirement 6 — Preservação funcional (regressão zero)

**User Story:** Como usuário, quero que todas as funcionalidades continuem operando, para que o redesign não introduza nenhuma quebra de comportamento.

#### Acceptance Criteria

1. THE Dashboard SHALL preservar o funcionamento dos botões Go Live e Testar Demo.
2. THE Dashboard SHALL preservar o funcionamento dos controles de janela.
3. THE Dashboard SHALL preservar o funcionamento do Theme_Switcher.
4. THE Dashboard SHALL preservar todos os identificadores, classes e ganchos de script em `app.js` necessários ao comportamento existente.
5. IF uma alteração visual exigir modificar `app.js`, THEN THE Dashboard SHALL limitar essa alteração a ajustes visuais sem alterar a lógica de controle.

### Requirement 7 — Harmonização do acento do overlay

**User Story:** Como usuário, quero que o overlay ao vivo combine com a nova paleta do dashboard, para que a experiência visual seja unificada entre as duas superfícies.

#### Acceptance Criteria

1. THE Overlay SHALL usar uma Cor_De_Acento harmonizada com a Cor_De_Acento do Dashboard.
2. THE Overlay SHALL reduzir a constante `kRadius` para um valor coerente com o Raio_De_Canto reduzido do Dashboard.
3. WHERE um elemento do Overlay pertence ao Contexto_Live, THE Overlay SHALL poder manter o vermelho como cor desse contexto específico.
4. THE Overlay SHALL preservar seu comportamento de renderização, posicionamento e janela sem alterações funcionais.

### Requirement 8 — Acessibilidade de contraste

**User Story:** Como usuário, quero contraste adequado entre texto e fundo, para que a interface seja legível e acessível em ambos os temas.

#### Acceptance Criteria

1. THE Dashboard SHALL atender ao Contraste_WCAG_AA para texto normal sobre as superfícies de fundo no Tema_Claro e no Tema_Escuro.
2. THE Dashboard SHALL atender ao Contraste_WCAG_AA para elementos gráficos de interface e estados de foco que dependem da Cor_De_Acento.
3. WHEN um elemento interativo recebe foco, THE Dashboard SHALL exibir um indicador de foco visível com contraste suficiente em relação ao fundo adjacente.
