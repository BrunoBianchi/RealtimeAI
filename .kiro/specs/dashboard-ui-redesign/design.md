# Design Document — Dashboard UI Redesign

## Visão Geral

Este documento descreve o design de um redesign **puramente visual** do dashboard Electron do RealTimeAI, mais a harmonização do overlay nativo (C++/Direct2D). O trabalho é inteiramente orientado por *design tokens*: a estética muda ao reescrever variáveis CSS HSL, a configuração do Tailwind e um pequeno conjunto de constantes do overlay — sem tocar na estrutura do DOM, nas views, na lógica de controle do `app.js` ou no pipeline de renderização do overlay.

Princípios que guiam o design:

- **Token-first.** Toda a nova estética flui de `:root` / `.dark` em `tailwind.input.css` e de `tailwind.config.js`. Nada de acento novo hardcoded fora dos tokens (Req 2.4).
- **Regressão zero.** Ids, classes, `data-*` e ganchos consumidos por `app.js` permanecem intactos (Req 5, Req 6).
- **Acento harmonizado com o overlay.** O overlay já usa azul `rgba(96,165,250)` como acento e reserva o vermelho ao contexto live. O dashboard passa a adotar um indigo/azul elegante da mesma família, unificando as duas superfícies, e mantém o vermelho apenas em Go Live/gravação (Req 2, Req 7).
- **Acessibilidade AA.** Todos os pares texto/superfície e o anel de foco atingem os limiares WCAG 2.1 AA nos dois temas (Req 8).

### Descoberta da fase anterior (contexto de decisão de cor)

`src/overlay/src/overlay_window.cpp` define a paleta nativa com:

```cpp
D2D1_COLOR_F accent      = rgba(96, 165, 250);   // ~ hsl(217 92% 68%)  — azul
D2D1_COLOR_F accent_soft = rgba(147, 197, 253);  // ~ hsl(213 94% 78%)
D2D1_COLOR_F accent_glow = rgba(59, 130, 246, 0.18f); // blue-500
D2D1_COLOR_F red         = rgba(255, 69, 58);    // contexto live / erro
constexpr float kRadius  = 12.0f;
```

Ou seja, **o overlay já é azul**; o vermelho só aparece em `red`/`end`/`end_hover` (encerrar/gravar) e em `NoticeLevel::Error`. Portanto, adotar um acento **indigo/azul** no dashboard é a escolha que harmoniza naturalmente com o que já existe, em vez de impor uma cor nova e desalinhada. Fixamos a família de acento do dashboard em **indigo ~ `hsl(221 83% 53%)`** (blue-600 do Tailwind), que casa com o azul do overlay e mantém contraste AA sobre as superfícies claras e escuras.

## Arquitetura

### Camadas afetadas

```
┌─────────────────────────────────────────────────────────────┐
│ Fonte de design (editável)                                    │
│  ├─ dashboard/src/tailwind.input.css   ← tokens :root / .dark │
│  └─ dashboard/tailwind.config.js       ← radius, sombras, cor │
└───────────────────────────┬─────────────────────────────────┘
                            │ npm run build:css (tailwindcss --minify)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ Artefato gerado                                               │
│  └─ dashboard/src/styles.css  (NÃO editar à mão)              │
└───────────────────────────┬─────────────────────────────────┘
                            │ carregado por
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ dashboard/src/index.html  ← markup (ids/classes preservados)  │
│ dashboard/src/app.js      ← apenas strings de classe visuais  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Superfície nativa (harmonização paralela)                     │
│  └─ src/overlay/src/overlay_window.cpp                        │
│       accent/accent_soft/accent_glow + kRadius                │
│       (render/posição/janela inalterados)                     │
└─────────────────────────────────────────────────────────────┘
```

### Fluxo de aplicação de tema (preservado)

`app.js::applyTheme(resolved, preference)` faz `document.documentElement.classList.toggle('dark', isDark)` e marca os botões `.theme-pref-btn`. Nenhuma cor é computada em JS — o tema é 100% CSS/token. O redesign **não altera esse fluxo**; apenas troca os valores que os tokens resolvem. Os três modos (Windows/Claro/Escuro) e a sincronização com `prefers-color-scheme`/IPC do Electron permanecem como estão (Req 3, Req 6.3).

## Tokens de Design (tabela antes/depois)

Todos os valores em HSL (formato `H S% L%`) para uso direto em `hsl(var(--token))`.

### Tema Claro (`:root`)

| Token | Antes | Depois | Observação |
|---|---|---|---|
| `--radius` | `0.75rem` | **`0.375rem`** | cantos mais contidos (Req 1.1) |
| `--primary` | `240 6% 10%` (quase preto) | **`221 83% 53%`** (indigo) | acento dominante (Req 2.1) |
| `--primary-foreground` | `0 0% 99%` | **`0 0% 100%`** | texto branco sobre indigo; contraste ~4.6:1 |
| `--ring` | `240 6% 15%` | **`221 83% 53%`** | anel de foco = acento (Req 2.2, 8.2) |
| `--accent` | `240 5% 93%` (cinza hover) | `240 5% 93%` *(mantido)* | superfície de hover neutra; o "accent" do shadcn é superfície, não a cor de marca |
| `--accent-foreground` | `240 6% 10%` | `240 6% 10%` *(mantido)* | — |
| `--background` | `240 20% 99%` | `240 20% 99%` *(mantido)* | — |
| `--foreground` | `240 10% 9%` | `240 10% 9%` *(mantido)* | contraste ~17:1 |
| `--card` / `--card-foreground` | `0 0% 100%` / `240 10% 9%` | *(mantidos)* | — |
| `--secondary` / `-foreground` | `240 5% 96%` / `240 6% 14%` | *(mantidos)* | — |
| `--muted` / `-foreground` | `240 5% 95%` / `240 4% 46%` | `240 5% 95%` / **`240 4% 44%`** | leve escurecimento do muted-fg p/ garantir 4.5:1 |
| `--border` / `--input` | `240 6% 91%` / `240 6% 89%` | *(mantidos)* | — |
| `--destructive` | `347 77% 50%` | *(mantido)* | erro/destrutivo segue vermelho |
| `--live` | `347 77% 50%` | *(mantido)* | **vermelho reservado ao Contexto_Live** (Req 2.3) |
| `--sidebar-*` | — | *(mantidos)* | neutros da sidebar inalterados |

> Nota sobre `--accent`: no esquema shadcn que este projeto usa, `--accent` é a **superfície de hover** (cinza), não a cor de marca. A cor de marca/destaque é veiculada por `--primary` e `--ring`. Por isso o acento visual de marca muda via `--primary`/`--ring`, enquanto `--accent` permanece neutro — isso preserva o comportamento de hover de `.sh-btn-secondary`, `.sh-nav-item`, etc.

### Tema Escuro (`.dark`)

| Token | Antes | Depois | Observação |
|---|---|---|---|
| `--radius` | `0.75rem` | **`0.375rem`** | (compartilhado; definido também aqui — Req 1.1) |
| `--primary` | `0 0% 98%` (quase branco) | **`213 94% 68%`** (indigo claro) | casa com `accent_soft` do overlay; contraste sobre fundo escuro |
| `--primary-foreground` | `240 8% 8%` | **`222 47% 11%`** | texto escuro sobre indigo claro; contraste ~5:1 |
| `--ring` | `240 5% 84%` | **`213 94% 68%`** | anel de foco = acento (Req 2.2, 8.2) |
| `--background` | `240 8% 6.5%` | *(mantido)* | — |
| `--foreground` | `0 0% 96%` | *(mantido)* | contraste ~16:1 |
| `--card` / `-foreground` | `240 7% 9.5%` / `0 0% 96%` | *(mantidos)* | — |
| `--accent` / `-foreground` | `240 5% 17%` / `0 0% 98%` | *(mantidos)* | superfície de hover escura |
| `--muted` / `-foreground` | `240 5% 14%` / `240 5% 63%` | `240 5% 14%` / **`240 5% 66%`** | muted-fg mais claro p/ 4.5:1 |
| `--destructive` / `--live` | `347 77% 50%` | *(mantidos)* | vermelho live preservado (Req 2.3) |

### Raio derivado (impacto em lg/md/sm)

`tailwind.config.js` mantém o mapeamento relativo; só o valor-base de `--radius` muda:

| Utilitário | Fórmula | Antes (`--radius`=12px) | Depois (`--radius`=6px) |
|---|---|---|---|
| `rounded-lg` | `var(--radius)` | 12px | **6px** |
| `rounded-md` | `calc(var(--radius) - 2px)` | 10px | **4px** |
| `rounded-sm` | `calc(var(--radius) - 4px)` | 8px | **2px** |

### Raios literais em `index.html` (Req 1.3)

Classes de raio fixo que não derivam do token precisam ser normalizadas para a nova escala contida. Normalização proposta:

| Classe literal | Uso | Ação |
|---|---|---|
| `rounded-2xl` (1rem/16px) | `gettingStartedCard`, ilustrações 16×16 (`bg-live/10`, `bg-amber-500/10`) | → `rounded-lg` (6px) para cards; ilustrações → `rounded-xl` para manter proporção do ícone |
| `rounded-xl` (0.75rem/12px) | `sidebarPlanCard`, `.sh-card`, cards de walkthrough, labels de fontes de áudio, cartões do theme switcher | → `rounded-lg` (6px) |
| `rounded-lg` (token agora 6px) | botões, inputs, chips, logo | sem mudança de classe (herda o novo valor) |
| `rounded-md` (token) | botões de janela, kbd badges, `.sh-btn-live` | sem mudança de classe |
| `rounded-full` | pills de status, avatar, dots, `.sh-btn-dashed`, `.sh-btn-pill-primary` | **preservado** — pills/dots continuam totalmente arredondados por intenção |

> Regra geral: `rounded-2xl`/`rounded-xl` → `rounded-lg`; `rounded-full` e dots permanecem. Isso mantém a hierarquia visual (Req 1.3) sem mexer em layout.

## Componentes Afetados

Nenhum componente é reestruturado. As mudanças são de token/classe de estilo:

| Componente / seletor | Fonte | Mudança |
|---|---|---|
| `.sh-btn-primary`, `.sh-btn-pill-primary` | `tailwind.input.css` | passam a renderizar **indigo** via `bg-primary` (token mudou); sem alteração de classe |
| `.sh-btn-live` | `tailwind.input.css` | **mantém vermelho** (`bg-[#E11D48]`/`hover:bg-[#BE123C]`) — Contexto_Live (Req 2.3) |
| `.sh-input`, `.sh-textarea`, `.sh-select-pill` | `tailwind.input.css` | anel de foco `ring-ring` passa a indigo; raio reduzido via token |
| `.sh-card` | `tailwind.input.css` | `rounded-xl` → `rounded-lg`; sombra `shadow-sm` mantida |
| `.sh-nav-item`, `.sh-goal-item`, `.settings-subnav-btn`, `.library-tab`, `.kbd-badge` | `tailwind.input.css` | raio reduzido via token; hover neutro preservado |
| Logo (`bg-[#E11D48]`) e ilustração "Red Flag" (`text-[#E11D48]`, `bg-live/10`) | `index.html` | **mantêm vermelho** (identidade/contexto); só o raio da caixa do logo acompanha o token |
| `gettingStartedCard`, `sidebarPlanCard`, cards do theme switcher | `index.html` | `rounded-2xl`/`rounded-xl` → `rounded-lg` |
| Badges emerald (`overlayStatusPill`, "Ready for live", "Stealth Active") | `index.html`/`app.js` | **mantidos** — são sinais de estado (verde), fora do sistema de acento |
| `dot` do status (`bg-[#E11D48]` em `app.js`) | `app.js` | **mantido** — indicador de live vermelho |

### Restrições sobre `app.js` (Req 6.4, 6.5)

`app.js` só referencia tokens via classes utilitárias e manipula ids/`data-*`. Mudanças permitidas: trocar **strings de classe puramente visuais** (ex.: um `rounded-xl` embutido em template literal por `rounded-lg`). Proibido: alterar ids, `data-*`, seletores de `getElementById`/`querySelector`, ou qualquer lógica. Os ganchos atuais que devem permanecer resolvíveis incluem (não exaustivo): `overlayStatusPill`, `overlayStatusDot`, `overlayStatusText`, `btnNewGoal`, `sidebarPlanCard`, `profileChip`, `profileAvatar`, `btnToggleSidebar`, `.theme-pref-btn[data-theme-pref]`, `.sh-nav-item[data-view]`, `.view-pane`, `.settings-subnav-btn[data-settings-tab]`, `.settings-subpane`, `.library-tab[data-lib-tab]`, modais (`modalGoalSetup`, `modalPasteDoc`, `modalDocPreview`).

## Estratégia de Build / Compilação

O `styles.css` é **gerado** e nunca editado à mão.

1. Editar os tokens em `dashboard/src/tailwind.input.css` (`:root` e `.dark`).
2. Ajustar `dashboard/tailwind.config.js` se necessário (o mapeamento `borderRadius` e `boxShadow` já é relativo a `--radius`/tokens, então normalmente **não precisa mudar**; `fontFamily.sans` permanece Segoe UI Variable — Req 4.1). As escalas de tipografia e espaçamento são mantidas como estão — relativas aos utilitários/tokens existentes, sem introduzir valores ad-hoc — preservando a consistência entre componentes equivalentes (Req 4.2).
3. Normalizar raios literais em `dashboard/src/index.html` e nos template literals visuais de `app.js`.
4. Recompilar o CSS:

```powershell
# executar manualmente no diretório do dashboard
npm run build:css
# equivale a: tailwindcss -i ./src/tailwind.input.css -o ./src/styles.css --minify
```

5. Verificar que `styles.css` reflete os novos tokens (ex.: `--radius:.375rem`, `--primary:221 83% 53%`).

> `tailwindcss` faz *tree-shaking* com base em `content: ['./src/**/*.{html,js}']`. Qualquer classe nova de raio usada precisa existir no HTML/JS para sobreviver ao purge. Como só trocamos classes existentes por outras já usadas no projeto, não há risco de purga de classes novas.

## Harmonização do Overlay

Alterações mínimas e locais em `src/overlay/src/overlay_window.cpp`, dentro do `struct Palette` e da constante de raio. **Sem** mudanças em render, hit-testing, posicionamento ou ciclo de vida da janela (Req 7.4).

| Constante | Antes | Depois | Motivo |
|---|---|---|---|
| `kRadius` | `12.0f` | **`6.0f`** | coerente com `--radius` 6px do dashboard (Req 7.2) |
| `accent` | `rgba(96, 165, 250)` | **`rgba(59, 130, 246)`** | blue-500, harmoniza com o indigo `--primary` claro `221 83% 53%` (Req 7.1) |
| `accent_soft` | `rgba(147, 197, 253)` | **`rgba(96, 165, 250)`** | casa com `--primary` escuro `213 94% 68%` |
| `accent_glow` | `rgba(59, 130, 246, 0.18f)` | *(mantido)* | já é blue-500 |
| `red`, `end`, `end_hover` | vermelhos | *(mantidos)* | Contexto_Live preservado (Req 7.3) |

Pontos de uso de `kRadius` que acompanham automaticamente a mudança (sombra em camadas, hairline, highlight de topo) continuam coerentes porque todos derivam de `kRadius ± offset`. Valores de raio locais não relacionados ao card (ex.: pílulas de botão `kBtnH/2`, campo de chat `10.0f`, barras de áudio `3.0f`) permanecem — são formas próprias, não o raio do contêiner.

## Acessibilidade

Alvos WCAG 2.1 AA: **4.5:1** para texto normal, **3:1** para texto grande e elementos gráficos/foco.

Verificação dos pares principais com os novos tokens:

| Par | Tema | Razão aprox. | Status |
|---|---|---|---|
| `--foreground` sobre `--background` | Claro | ~17:1 | ✔ |
| `--foreground` sobre `--card` | Claro | ~17:1 | ✔ |
| `--muted-foreground` (44%) sobre `--background` | Claro | ~4.6:1 | ✔ (ajustado) |
| `--primary-foreground` (branco) sobre `--primary` (indigo 53%) | Claro | ~4.6:1 | ✔ |
| anel `--ring` (indigo 53%) sobre `--card`/`--background` | Claro | ~3.3:1 | ✔ (gráfico/foco) |
| `--foreground` sobre `--background` | Escuro | ~16:1 | ✔ |
| `--muted-foreground` (66%) sobre `--background` | Escuro | ~4.7:1 | ✔ (ajustado) |
| `--primary-foreground` (escuro) sobre `--primary` (indigo 68%) | Escuro | ~5:1 | ✔ |
| anel `--ring` (indigo 68%) sobre `--background`/`--card` | Escuro | ~4.5:1 | ✔ |

Foco visível (Req 8.3): preservado via `focus-visible:ring-2 focus-visible:ring-ring` nos tokens de botão/input. Como `--ring` passa a ser o acento indigo com contraste ≥3:1 contra as superfícies adjacentes nos dois temas, o indicador de foco permanece claramente visível.

## Correctness Properties

*Uma propriedade é uma característica ou comportamento que deve valer em todas as execuções válidas do sistema — uma afirmação formal do que o sistema deve fazer. As propriedades fazem a ponte entre a especificação legível por humanos e garantias de correção verificáveis por máquina.*

### Property 1: Contraste de texto atende AA nos dois temas

Para todo par (cor de texto token, cor de superfície token) usado pela interface — incluindo `foreground` sobre `background`, `foreground` sobre `card` e `muted-foreground` sobre `background` — a razão de contraste calculada é maior ou igual a 4.5:1, tanto no Tema_Claro quanto no Tema_Escuro.

**Validates: Requirements 4.4, 8.1**

### Property 2: Contraste do indicador de foco atende AA

Para todo elemento interativo em estado de foco, existe um indicador de foco visível derivado do token de acento (`--ring`) cuja razão de contraste contra a superfície adjacente é maior ou igual a 3:1, em ambos os temas.

**Validates: Requirements 8.2, 8.3**

### Property 3: Acento provém exclusivamente de Design_Tokens

Para todo uso da Cor_De_Acento em elementos interativos e estados de foco, a cor é resolvida a partir de uma variável CSS de token (`hsl(var(--primary))` ou `hsl(var(--ring))`) e nunca a partir de um literal de acento codificado fora do sistema de tokens.

**Validates: Requirements 2.2, 2.4**

### Property 4: Paridade de tokens entre os temas

Para todo Design_Token definido no Tema_Claro (`:root`), existe uma definição correspondente e não-vazia no Tema_Escuro (`.dark`), e vice-versa; os dois conjuntos de nomes de token são idênticos.

**Validates: Requirements 3.1**

### Property 5: Preservação da estrutura de layout

Para toda âncora estrutural de navegação existente antes do redesign — as views (Goals, Library, History, Settings), as abas da Library (Resumes, Materials, Playbooks, About you), a subnavegação de Settings (General, Appearance, Defaults, Privacy & Stealth, Shortcuts, Account & Billing) e a sidebar — a mesma âncora existe e mantém sua posição hierárquica após o redesign.

**Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5**

### Property 6: Preservação dos ganchos de script

Para todo seletor, id ou atributo `data-*` referenciado por `app.js` (via `getElementById`, `querySelector`/`querySelectorAll` e `dataset`), o elemento correspondente existe e permanece resolvível no DOM do `index.html` redesenhado.

**Validates: Requirements 6.4**

### Property 7: Não-regressão de geometria do Overlay

Para toda entrada de layout do HUD, a geometria e o posicionamento produzidos pelo Overlay após a alteração de `kRadius` e das cores de acento são equivalentes aos produzidos antes da alteração; nenhuma mudança de cor ou raio altera dimensões, hit-testing ou posição da janela.

**Validates: Requirements 7.4**

## Estratégia de Teste / Verificação Visual

### Abordagem dupla

- **Testes de propriedade** (≥100 iterações) cobrem invariantes universais: contraste (P1, P2), proveniência de token do acento (P3), paridade de tokens (P4), preservação estrutural (P5), resolução de ganchos (P6) e não-regressão de geometria do overlay (P7).
- **Testes de exemplo / snapshot** cobrem valores de configuração determinísticos: `--radius = 0.375rem` em ambos os temas, mapeamento `lg/md/sm`, `fontFamily.sans` = Segoe UI Variable, tokens de sombra `shadcn`/`shadcn-md`, `kRadius = 6.0f` e cores de acento do overlay.
- **Testes de integração / smoke** cobrem comportamento dependente de Electron/SO: Go Live, Testar Demo, controles de janela e Theme_Switcher nos três modos (Req 3.3, 6.1–6.3).

Configuração dos testes de propriedade: cada teste referencia a propriedade de design correspondente com a tag **Feature: dashboard-ui-redesign, Property {n}: {texto}** e executa no mínimo 100 iterações.

### Verificação visual (checklist manual)

1. Recompilar CSS (`npm run build:css`) e abrir o dashboard.
2. Conferir cantos reduzidos em botões, inputs e cards; pills/dots ainda totalmente arredondados.
3. Confirmar acento indigo em botões primários, foco de inputs e itens ativos; vermelho só em Go Live/indicador de gravação.
4. Alternar Claro ↔ Escuro ↔ Windows e verificar polimento e legibilidade em ambos.
5. Abrir o overlay ao vivo e confirmar acento azul harmonizado, cantos menores e vermelho intacto no encerrar/gravação.
6. Navegar por todas as views, abas e subnav para confirmar que layout e comportamento não regrediram.
