---
name: RealTimeAI Executive
colors:
  surface: '#121315'
  surface-dim: '#121315'
  surface-bright: '#38393b'
  surface-container-lowest: '#0d0e10'
  surface-container-low: '#1b1c1e'
  surface-container: '#1f2022'
  surface-container-high: '#292a2c'
  surface-container-highest: '#343537'
  on-surface: '#e3e2e5'
  on-surface-variant: '#bbcabf'
  inverse-surface: '#e3e2e5'
  inverse-on-surface: '#303033'
  outline: '#86948a'
  outline-variant: '#3c4a42'
  surface-tint: '#4edea3'
  primary: '#4edea3'
  on-primary: '#003824'
  primary-container: '#10b981'
  on-primary-container: '#00422b'
  inverse-primary: '#006c49'
  secondary: '#c6c5cf'
  on-secondary: '#2f3038'
  secondary-container: '#4a4b53'
  on-secondary-container: '#bcbbc5'
  tertiary: '#adc6ff'
  on-tertiary: '#002e6a'
  tertiary-container: '#71a1ff'
  on-tertiary-container: '#00367a'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#6ffbbe'
  primary-fixed-dim: '#4edea3'
  on-primary-fixed: '#002113'
  on-primary-fixed-variant: '#005236'
  secondary-fixed: '#e3e1ec'
  secondary-fixed-dim: '#c6c5cf'
  on-secondary-fixed: '#1a1b22'
  on-secondary-fixed-variant: '#46464e'
  tertiary-fixed: '#d8e2ff'
  tertiary-fixed-dim: '#adc6ff'
  on-tertiary-fixed: '#001a42'
  on-tertiary-fixed-variant: '#004395'
  background: '#121315'
  on-background: '#e3e2e5'
  surface-variant: '#343537'
  surface-base: '#090a0c'
  surface-raised: '#111215'
  surface-card: '#16171b'
  surface-overlay: '#1c1e24'
  border-subtle: rgba(255, 255, 255, 0.06)
  border-muted: rgba(255, 255, 255, 0.11)
  border-hover: rgba(255, 255, 255, 0.20)
  text-primary: '#f4f4f5'
  text-secondary: '#a1a1aa'
  text-tertiary: '#71717a'
  accent-emerald-subtle: rgba(16, 185, 129, 0.10)
  accent-emerald-border: rgba(16, 185, 129, 0.24)
  status-error: '#f43f5e'
  status-warning: '#f59e0b'
typography:
  headline-xl:
    fontFamily: Geist
    fontSize: 2.25rem
    fontWeight: '600'
    lineHeight: 2.75rem
    letterSpacing: -0.03em
  headline-xl-mobile:
    fontFamily: Geist
    fontSize: 1.75rem
    fontWeight: '600'
    lineHeight: 2.25rem
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Geist
    fontSize: 1.5rem
    fontWeight: '600'
    lineHeight: 2rem
    letterSpacing: -0.025em
  headline-md:
    fontFamily: Geist
    fontSize: 1.125rem
    fontWeight: '500'
    lineHeight: 1.625rem
    letterSpacing: -0.015em
  headline-sm:
    fontFamily: Geist
    fontSize: 0.9375rem
    fontWeight: '500'
    lineHeight: 1.375rem
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Geist
    fontSize: 1rem
    fontWeight: '400'
    lineHeight: 1.625rem
  body-md:
    fontFamily: Geist
    fontSize: 0.875rem
    fontWeight: '400'
    lineHeight: 1.375rem
  body-sm:
    fontFamily: Geist
    fontSize: 0.8125rem
    fontWeight: '400'
    lineHeight: 1.25rem
  metric-display:
    fontFamily: Geist
    fontSize: 1.75rem
    fontWeight: '600'
    lineHeight: 2.125rem
    letterSpacing: -0.03em
  label-code:
    fontFamily: JetBrains Mono
    fontSize: 0.75rem
    fontWeight: '500'
    lineHeight: 1rem
    letterSpacing: 0.02em
  label-badge:
    fontFamily: Geist
    fontSize: 0.75rem
    fontWeight: '500'
    lineHeight: 1rem
    letterSpacing: 0.01em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 1rem
  gutter-desktop: 1.5rem
  margin: 1rem
  margin-desktop: 2.5rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1.25rem
  space-xl: 2rem
---

# RealTimeAI Executive — Design System & Guidelines (DESIGN.md)

Guia visual e arquitetura de design extraídos da interface clean, minimalista e profissional do **RealTimeAI** (Tela de Configurações e Aplicação Desktop).

---

## 1. Princípios de Design & Direção de Arte

1. **Elegância Sóbria & Minimalismo Executivo**:
   - Superfícies escuras com baixo contraste de fundo, eliminando supérfluos visuais e reflexos agressivos.
   - Acabamento fosco, tons neutros grafite/zinc/slate escuro e bordas ultrafinas com opacidade controlada (`border-white/10` ou `#27282b`).

2. **Cores Funcionais & Não Distrativas**:
   - Eliminação de neons estridentes. O verde esmeralda sóbrio (`#10b981`) atua exclusivamente para feedback semântico de status ativo, confirmações e progresso.
   - Paleta monocromática com variações sutis de luminância para diferenciar hierarquias de camadas e cartões.

3. **Tipografia Técnica & Alta Legibilidade**:
   - Fontes modernas grotescas/neo-grotescas (Geist, Inter ou similar sans-serif de métricas neutras).
   - Numerais tabulares e elementos de telemetria/atalhos com monospace neutro (`font-mono`).

---

## 2. Paleta de Cores (Color Tokens)

### 2.1 Fundos e Superfícies (Dark Surfaces)
| Token | HEX / Tailwind | Uso Principal |
| :--- | :--- | :--- |
| `surface-base` / `background` | `#0c0d0e` / `#0d0e10` | Fundo principal da aplicação (canvas) |
| `surface-dim` | `#111215` / `#121315` | Barra lateral (sidebar) e top bar |
| `surface-card` / `surface-container-low` | `#181a1f` / `#18191c` | Cards principais de configurações e painéis |
| `surface-container` | `#1d1f24` / `#1c1d21` | Blocos de conteúdo selecionados e botões secundários |
| `surface-container-high` | `#23262d` / `#23252a` | Elementos de foco, hover e inputs de formulário |
| `surface-container-highest` | `#2b2d34` | Badges e pílulas de destaque sutil |

### 2.2 Bordas e Divisores
| Token | HEX / CSS | Uso |
| :--- | :--- | :--- |
| `border-subtle` | `rgba(255, 255, 255, 0.07)` | Linhas de divisão interna, bordas de cards inativos |
| `border-muted` / `border-default` | `rgba(255, 255, 255, 0.12)` | Bordas padrão de containers, tabelas e botões |
| `border-hover` | `rgba(255, 255, 255, 0.22)` | Estados de hover e seleção em cards clicáveis |
| `border-focus` | `#10b981` ou `rgba(16, 185, 129, 0.5)` | Foco de inputs, seleções ativas |

### 2.3 Tipografia e Conteúdo (On-Surface)
| Token | HEX / Valor | Uso |
| :--- | :--- | :--- |
| `text-primary` | `#f4f4f5` (`zinc-100`) | Títulos principais, dados críticos, labels ativas |
| `text-secondary` | `#a1a1aa` (`zinc-400`) | Subtítulos, descrições secundárias, labels de campos |
| `text-tertiary` / `text-muted` | `#71717a` (`zinc-500`) | Metadados discretos, timestamps, atalhos secundários |
| `text-disabled` | `#4b5563` (`gray-600`) | Elementos inativos ou placeholders |

### 2.4 Acentos e Semântica (Accent & Feedback)
| Token | HEX | Uso |
| :--- | :--- | :--- |
| `primary` (Emerald) | `#10b981` / `#34d399` | Status de IA ativa, badges de "Recomendado", indicadores |
| `primary-hover` | `#059669` (`emerald-600`) | Interações ativas de botões primários |
| `primary-subtle` | `rgba(52, 211, 153, 0.08)` | Fundo sutil de badges e chips selecionados |
| `warning` | `#f59e0b` (`amber-500`) | Avisos de cota ou revisões pendentes |
| `danger` / `destructive` | `#ef4444` (`red-500`) | Alertas críticos, ações de remoção / panic button |

---

## 3. Tipografia (Typography Scale)

- **Fonte Principal**: `Geist`, `Inter`, `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, `sans-serif`
- **Fonte Monospaçada / Código**: `JetBrains Mono`, `Geist Mono`, `ui-monospace`, `monospace`

| Nível | Tamanho | Peso | Line Height | Tracking | Aplicação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Display / Page Title** | `24px` (`text-2xl` ou `1.5rem`) | SemiBold (`600`) | `1.25` | `-0.02em` | Título da página ("Configurações do Copiloto & Sistema") |
| **Section Title** | `16px` (`text-base` ou `1rem`) | SemiBold (`600`) | `1.4` | `-0.01em` | Cabeçalho dos cards ("Modelo de Inteligência Artificial") |
| **Card Header / Subtitle** | `14px` (`text-sm`) | Medium (`500`) | `1.4` | `0` | Nome de modelos, labels de opções |
| **Body Regular** | `13px` / `14px` | Regular (`400`) | `1.5` | `0` | Descrições de configurações e textos explicativos |
| **Caption / Subtext** | `12px` (`text-xs`) | Regular / Medium | `1.4` | `+0.01em` | Metadados, latências, micro-labels ("< 920 ms", "Tokens ilimitados") |
| **Kbd / Shortcuts** | `11px` / `12px` | Medium (`500`) / Mono | `1.2` | `+0.02em` | Teclas de atalho (`Ctrl`, `Espaço`, `Esc`) |

---

## 4. Sistema de Espaçamento e Grid (Spacing & Layout)

Utiliza base modular de **4px / 8px**:

### 4.1 Tabela de Espaçamentos
- `space-1` (4px): Espaço entre ícone e badge interno, gaps mínimos.
- `space-2` (8px): Gaps entre itens de listas compactas, padding de tags/chips (`px-2.5 py-1`).
- `space-3` (12px): Espaçamento entre inputs e labels, padding interno de atalhos e botões secundários (`px-3 py-1.5`).
- `space-4` (16px): Padding interno de cards secundários, gaps entre cards de modelos na mesma linha.
- `space-5` (20px): Padding interno padrão de containers e cards estruturais.
- `space-6` (24px): Padding externo de seções, gaps entre blocos de conteúdo da página.
- `space-8` (32px): Margem superior entre grupos principais.

### 4.2 Layout Shell Desktop
- **Sidebar Fixa**: `w-64` (256px), ancorada à esquerda, borda direita sutil `border-r border-border-subtle`.
- **Top Navigation Bar**: Altura fixa `h-14` (56px) com `border-b border-border-subtle` e `backdrop-blur-md`.
- **Área Central (Content)**: `p-6` a `p-8`, com largura máxima de conteúdo `max-w-6xl` / `max-w-7xl mx-auto`.
- **Grid de Cards**: Grid responsivo `grid grid-cols-1 lg:grid-cols-12 gap-6`.
  - Coluna Principal (Modelos, Invisibilidade, Atalhos): `lg:col-span-8`
  - Coluna Lateral (Dispositivos de Entrada, Plano Pro, Privacidade): `lg:col-span-4`

---

## 5. Raios de Borda (Corner Radius) & Sombras

- **Cards e Painéis**: `rounded-lg` (8px) a `rounded-xl` (12px).
- **Sub-cards (Opções de Modelo, Atalhos)**: `rounded-md` (6px) a `rounded-lg` (8px).
- **Botões e Inputs**: `rounded-md` (6px) a `rounded-lg` (8px).
- **Pílulas / Badges / Toggles**: `rounded-full` (9999px).
- **Kbd Badges**: `rounded` (4px).

### Elevação e Sombras
- O estilo adota visual **Flat / Soft Matte**:
  - Evitar sombras projetadas pesadas (`box-shadow` difuso preto).
  - Usar bordas internas sutis (`border border-border-subtle`).
  - Sombra sutil de hover: `box-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.4)`.

