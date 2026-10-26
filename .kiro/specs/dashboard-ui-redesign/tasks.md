# Implementation Plan: Dashboard UI Redesign

## Overview

A implementação é orientada por *design tokens* e puramente visual. A estética flui de `dashboard/src/tailwind.input.css` (`:root` / `.dark`) e de `dashboard/tailwind.config.js`, é recompilada em `dashboard/src/styles.css` via `npm run build:css`, e normalizada nos raios literais de `index.html`/`app.js`. Em paralelo, o overlay nativo (`src/overlay/src/overlay_window.cpp`) harmoniza acento e `kRadius`. Cada passo é incremental: primeiro os tokens-fonte, depois a propagação pelo build, depois os raios literais, depois o overlay, encerrando com testes de propriedade/exemplo e a verificação de regressão. Nenhuma lógica, id, `data-*` ou gancho de script é alterado.

> Linguagens já conhecidas pelo design: CSS (tokens Tailwind), JavaScript (strings de classe em `app.js`) e C++/Direct2D (overlay). Nenhum passo de seleção de linguagem é necessário.

## Tasks

- [x] 1. Atualizar os design tokens em `dashboard/src/tailwind.input.css`
  - [x] 1.1 Reescrever tokens do Tema_Claro (`:root`)
    - Definir `--radius: 0.375rem`
    - Definir `--primary: 221 83% 53%` (indigo) e `--primary-foreground: 0 0% 100%`
    - Definir `--ring: 221 83% 53%`
    - Ajustar `--muted-foreground` para `240 4% 44%`
    - Manter `--live` e `--destructive` em `347 77% 50%` (vermelho) e demais tokens neutros inalterados
    - _Requirements: 1.1, 2.1, 2.2, 2.3, 2.4, 3.1, 8.1, 8.2_

  - [x] 1.2 Reescrever tokens do Tema_Escuro (`.dark`)
    - Definir `--radius: 0.375rem`
    - Definir `--primary: 213 94% 68%` (indigo claro) e `--primary-foreground: 222 47% 11%`
    - Definir `--ring: 213 94% 68%`
    - Ajustar `--muted-foreground` para `240 5% 66%`
    - Manter `--live` e `--destructive` em `347 77% 50%` (vermelho) e demais tokens inalterados
    - _Requirements: 1.1, 2.1, 2.2, 2.3, 2.4, 3.1, 8.1, 8.2_

  - [x] 1.3 Escrever teste de propriedade para paridade de tokens entre temas
    - **Feature: dashboard-ui-redesign, Property 4: Paridade de tokens entre os temas**
    - Verificar que o conjunto de nomes de token definidos em `:root` é idêntico ao definido em `.dark` e que nenhuma definição correspondente é vazia
    - **Validates: Requirements 3.1**

  - [x] 1.4 Escrever teste de exemplo para valores determinísticos dos tokens
    - Assertar `--radius = 0.375rem` em ambos os temas; `--primary = 221 83% 53%` (claro) e `213 94% 68%` (escuro); `--live`/`--destructive` permanecem vermelhos
    - _Requirements: 1.1, 2.1, 2.3_

- [x] 2. Verificar/ajustar `dashboard/tailwind.config.js`
  - [x] 2.1 Confirmar mapeamento de `borderRadius`, `boxShadow` e `fontFamily`
    - Confirmar que `borderRadius` (`lg`/`md`/`sm`) deriva de `var(--radius)` sem valor fixo
    - Confirmar que os tokens de sombra (`shadcn`/`shadcn-md`) e `fontFamily.sans = Segoe UI Variable` permanecem; ajustar somente se algum valor estiver hardcoded fora do token
    - _Requirements: 1.2, 4.1, 4.3_

  - [x] 2.2 Escrever teste de exemplo para derivação de raio e tipografia
    - Assertar `rounded-lg = var(--radius)`, `rounded-md = calc(var(--radius) - 2px)`, `rounded-sm = calc(var(--radius) - 4px)` e `fontFamily.sans` iniciando por Segoe UI Variable
    - Assertar que as escalas de tipografia/espaçamento permanecem relativas aos tokens (sem valores ad-hoc introduzidos), mantendo consistência entre componentes equivalentes
    - _Requirements: 1.2, 4.1, 4.2_

- [x] 3. Checkpoint — Validar tokens-fonte
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Normalizar raios literais em `dashboard/src/index.html`
  - [x] 4.1 Substituir `rounded-2xl`/`rounded-xl` por `rounded-lg` nos cards e superfícies
    - Normalizar `gettingStartedCard`, `sidebarPlanCard`, `.sh-card`, cards de walkthrough, labels de fontes de áudio e cartões do theme switcher
    - Preservar `rounded-full` (pills, avatar, dots, `.sh-btn-dashed`, `.sh-btn-pill-primary`) e as ilustrações de ícone conforme a regra do design
    - Manter vermelho do logo (`bg-[#E11D48]`) e da ilustração "Red Flag"; apenas o raio da caixa acompanha o token
    - Não alterar ids, classes de gancho, `data-*` ou estrutura de nós
    - _Requirements: 1.3, 2.3, 5.5, 6.4_

  - [x] 4.2 Escrever teste de propriedade para preservação dos ganchos de script
    - **Feature: dashboard-ui-redesign, Property 6: Preservação dos ganchos de script**
    - Para todo id/seletor/`data-*` referenciado por `app.js`, verificar que o elemento permanece resolvível no DOM de `index.html`
    - **Validates: Requirements 6.4**

  - [x] 4.3 Escrever teste de propriedade para preservação da estrutura de layout
    - **Feature: dashboard-ui-redesign, Property 5: Preservação da estrutura de layout**
    - Verificar presença e hierarquia das views (Goals, Library, History, Settings), abas da Library, subnav de Settings e sidebar após o redesign
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5**

- [x] 5. Ajustar strings de classe visuais em `dashboard/src/app.js`
  - [x] 5.1 Normalizar raios em template literals puramente visuais
    - Trocar `rounded-2xl`/`rounded-xl` embutidos por `rounded-lg` apenas em strings de classe
    - Preservar `dot` vermelho de live (`bg-[#E11D48]`) e badges emerald de estado
    - Proibido alterar ids, `data-*`, seletores de `getElementById`/`querySelector` ou qualquer lógica de controle
    - _Requirements: 1.3, 2.3, 6.4, 6.5_

  - [x] 5.2 Escrever teste de propriedade para proveniência do acento via tokens
    - **Feature: dashboard-ui-redesign, Property 3: Acento provém exclusivamente de Design_Tokens**
    - Verificar que a Cor_De_Acento em elementos interativos/foco resolve de `hsl(var(--primary))`/`hsl(var(--ring))` e que não há literal de acento indigo fora dos tokens em `index.html`/`app.js`
    - **Validates: Requirements 2.2, 2.4**

- [x] 6. Recompilar o CSS e verificar propagação dos tokens
  - [x] 6.1 Executar o build e inspecionar `styles.css`
    - Rodar `npm run build:css` no diretório `dashboard/` (manualmente, conforme o design)
    - Verificar que `dashboard/src/styles.css` reflete `--radius:.375rem`, `--primary:221 83% 53%` (claro) e `213 94% 68%` (escuro), e que `--live`/`--destructive` seguem vermelhos
    - _Requirements: 1.1, 2.1, 2.3, 3.2_

  - [x] 6.2 Escrever teste de exemplo/snapshot sobre o `styles.css` gerado
    - Assertar presença dos valores de token esperados no artefato minificado e ausência de regressão de classes purgadas
    - _Requirements: 1.1, 2.1, 3.1_

- [x] 7. Checkpoint — Validar build do dashboard
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Harmonizar o overlay nativo em `src/overlay/src/overlay_window.cpp`
  - [x] 8.1 Ajustar acento e raio do `struct Palette`/constante
    - Definir `kRadius = 6.0f`
    - Definir `accent = rgba(59, 130, 246)` e `accent_soft = rgba(96, 165, 250)`
    - Manter `accent_glow` (blue-500), `red`/`end`/`end_hover` (Contexto_Live) e todos os raios locais não relacionados ao card
    - Não alterar render, hit-testing, posicionamento nem ciclo de vida da janela
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 8.2 Escrever teste de propriedade para não-regressão de geometria do overlay
    - **Feature: dashboard-ui-redesign, Property 7: Não-regressão de geometria do Overlay**
    - Para toda entrada de layout do HUD, verificar que dimensões, hit-testing e posição são equivalentes antes/depois da mudança de `kRadius` e das cores de acento
    - **Validates: Requirements 7.4**

- [x] 9. Testes de contraste WCAG AA e foco
  - [x] 9.1 Escrever teste de propriedade para contraste de texto AA nos dois temas
    - **Feature: dashboard-ui-redesign, Property 1: Contraste de texto atende AA nos dois temas**
    - Para todo par (texto token, superfície token) — incluindo `foreground`/`background`, `foreground`/`card`, `muted-foreground`/`background` — calcular contraste e assertar ≥ 4.5:1 no Tema_Claro e no Tema_Escuro
    - **Validates: Requirements 4.4, 8.1**

  - [x] 9.2 Escrever teste de propriedade para contraste do indicador de foco AA
    - **Feature: dashboard-ui-redesign, Property 2: Contraste do indicador de foco atende AA**
    - Para o anel de foco derivado de `--ring`, assertar contraste ≥ 3:1 contra a superfície adjacente em ambos os temas
    - **Validates: Requirements 8.2, 8.3**

- [x] 10. Verificação funcional e visual (regressão zero)
  - [x] 10.1 Escrever teste de integração/smoke dos controles principais
    - Cobrir Go Live, Testar Demo, controles de janela e Theme_Switcher nos três modos (Windows/Claro/Escuro) com asserts automatizados sobre os ganchos preservados
    - _Requirements: 3.3, 6.1, 6.2, 6.3_

  - [x] 10.2 Checklist de verificação visual manual
    - Conferir cantos reduzidos (pills/dots ainda totalmente arredondados), acento indigo em botões/foco/itens ativos, vermelho só em live, tipografia/espaçamento/sombras consistentes entre componentes equivalentes, polimento Claro↔Escuro↔Windows, overlay com acento azul e vermelho intacto, e ausência de regressão de layout em todas as views/abas/subnav
    - _Requirements: 1.3, 2.1, 2.3, 3.2, 4.2, 4.3, 5.1, 5.2, 5.3, 5.4, 7.1, 8.1_

- [x] 11. Checkpoint final — Garantir que todos os testes passam
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tarefas marcadas com `*` são opcionais e podem ser puladas para um MVP mais rápido — incluem testes (propriedade, exemplo, integração) e a verificação manual/visual (10.2).
- Cada tarefa referencia requisitos específicos para rastreabilidade.
- Os checkpoints garantem validação incremental: tokens-fonte (3), build do dashboard (7) e consolidação final (11).
- Os testes de propriedade cobrem as 7 Correctness Properties do design, cada um com a tag **Feature: dashboard-ui-redesign, Property {n}** e ≥ 100 iterações onde aplicável.
- `styles.css` é artefato gerado: nunca é editado à mão; só muda via `npm run build:css`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "1.4", "2.1"] },
    { "id": 2, "tasks": ["2.2", "4.1", "8.1"] },
    { "id": 3, "tasks": ["4.2", "4.3", "5.1", "8.2"] },
    { "id": 4, "tasks": ["5.2", "6.1"] },
    { "id": 5, "tasks": ["6.2", "9.1", "9.2"] },
    { "id": 6, "tasks": ["10.1", "10.2"] }
  ]
}
```
