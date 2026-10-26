# Contribuindo

## Ambiente

Requisitos no Windows:

- Visual Studio 2022 ou 2026 com **Desktop development with C++** (traz CMake e Ninja)
- Node.js 22 LTS e Git

```bat
scripts\windows\setup-dev.bat   :: dependências Node + hooks do git
scripts\windows\build.bat       :: overlay nativo (Release) + core_tests
scripts\windows\start-dashboard.bat
```

Sem Windows dá para trabalhar no núcleo (`rtai_core`), que não depende de `<windows.h>`:

```bash
cmake --preset linux && cmake --build --preset linux && ctest --preset linux
cmake --preset linux-tsan && cmake --build --preset linux-tsan && ctest --preset linux-tsan
```

## Branches

- `main`: sempre publicável. Todo merge passa pelo CI.
- `beta`: cada push publica uma pré-release `X.Y.(Z+1)-beta.N` para o canal Beta.
- Trabalho novo em branches curtas a partir da `main`: `feat/rag-cache`, `fix/loopback-device`,
  `perf/engine-deadlines`. Abra um PR para a `main`.

## Commits: Conventional Commits

Toda mensagem segue [Conventional Commits](https://www.conventionalcommits.org/pt-br/v1.0.0/). O
hook `commit-msg` (commitlint) recusa o que estiver fora do padrão, e o release-please usa as
mensagens para decidir a versão e escrever o `CHANGELOG.md`.

```
<tipo>(<escopo>): <descrição curta no imperativo>

<corpo opcional: o porquê da mudança, em parágrafos separados por linha em branco>

<rodapés opcionais: BREAKING CHANGE:, Closes: #123, Co-authored-by: ...>
```

| Tipo | Quando usar | Versão |
|---|---|---|
| `feat` | funcionalidade nova | minor |
| `fix` | correção de bug | patch |
| `perf` | mudança que melhora desempenho/latência | nenhuma (entra no changelog) |
| `refactor` | muda o código sem mudar comportamento | nenhuma |
| `test` | testes novos ou corrigidos | nenhuma |
| `docs` | só documentação | nenhuma |
| `build` | CMake, dependências, scripts de build | nenhuma |
| `ci` | workflows do GitHub Actions | nenhuma |
| `style` | formatação, sem mudar significado | nenhuma |
| `chore` | manutenção que não se encaixa acima | nenhuma |
| `revert` | desfaz um commit anterior | depende |

Mudança incompatível: `!` depois do tipo/escopo (`feat(llm)!: ...`) ou o rodapé
`BREAKING CHANGE: <o que quebra>`. Gera versão major.

Escopos aceitos (`commitlint.config.mjs`):

| Área | Escopos |
|---|---|
| Motor nativo (`src/`) | `core`, `engine`, `audio`, `stt`, `llm`, `rag`, `net`, `overlay`, `app` |
| Dashboard (`apps/dashboard/`) | `dashboard`, `ui`, `updater`, `flags`, `calendar` |
| Repositório | `build`, `cmake`, `ci`, `deps`, `deps-dev`, `docs`, `release`, `repo`, `scripts`, `tests` |

Exemplos:

```
feat(rag): add hybrid BM25 + dense retrieval with local e5 embeddings
fix(audio): reopen the loopback lane when the default device changes
perf(engine): wake the orchestrator at the exact turn deadline
build(deps): bump electron to 35.2.0
```

Um commit = uma mudança lógica. Se a descrição precisa de "e", provavelmente são dois commits.

## Hooks do git (husky)

| Hook | O que roda |
|---|---|
| `pre-commit` | scan de segredos no que está staged e validação do `flags.json` |
| `commit-msg` | commitlint |
| `pre-push` | scan de segredos completo, testes do dashboard e `core_tests.exe` (se houver build local) |

## Pull requests

- CI verde: commitlint, scan de segredos, flags, testes do dashboard, `core_tests` no Linux e build
  completo + testes no Windows.
- Teste novo para todo bug corrigido e toda regra nova do motor.
- Mudou latência? Diga no PR quanto (`visible_ms`, `1st token` ou um teste de tempo).
- Documentação junto: `docs/` para arquitetura, configuração, latência e releases.

## Estilo de código

- C++20, 4 espaços, 120 colunas (`.clang-format`). Formate só as linhas que tocou:
  `git clang-format`.
- `rtai_core` nunca inclui `<windows.h>`: código de plataforma fica nos adapters
  (`src/net`, `src/audio_wasapi`, `src/overlay`, `src/app`).
- Nada bloqueante nas threads quentes (captura, orquestrador, UI): enfileire e notifique.
- JavaScript do dashboard: CommonJS no processo principal, `contextIsolation` sempre ligado e
  toda ponte com o renderer passa pelo `preload`.
- Comentários em inglês, explicando o porquê.
