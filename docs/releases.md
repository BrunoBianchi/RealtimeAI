# Versões, releases e feature flags

## Primeira vez nesta máquina

```bat
scripts\windows\setup-dev.bat
```

Instala as dependências da raiz (husky + commitlint) e do dashboard, e liga os hooks do git.

## Commits

Os commits seguem o padrão [Conventional Commits](https://www.conventionalcommits.org/pt-br/), e é ele que decide a próxima versão:

| Commit | Exemplo | Versão |
|---|---|---|
| `fix:` | `fix(audio): reabre o loopback no device de comunicação` | 2.1.0 → 2.1.1 |
| `feat:` | `feat(ui): card de próxima entrevista` | 2.1.0 → 2.2.0 |
| `feat!:` ou `BREAKING CHANGE:` | `feat!: novo formato do config.ini` | 2.1.0 → 3.0.0 |
| `perf:` | `perf(engine): acorda no deadline do turno` | 2.1.0 → 2.1.1 |
| `chore:` `docs:` `test:` `ci:` `refactor:` `build:` | | não gera versão estável sozinho |

Hooks (husky):

- **pre-commit**: bloqueia chaves de API e arquivos privados (`config.ini`, `google_oauth_client.json`, `.env`) e valida o `flags.json`.
- **commit-msg**: recusa mensagens fora do padrão.
- **pre-push**: scan de segredos no repositório inteiro, testes do dashboard e `core_tests.exe` se houver build local.

## Como uma versão chega nos usuários

### Estável

1. Push na `main` → o workflow **Release** abre (ou atualiza) um PR `chore(release): vX.Y.Z` com a versão nova, o `CHANGELOG.md` e os números atualizados em `package.json`, `apps/dashboard/package.json` e `CMakeLists.txt`.
2. Merge desse PR → tag `vX.Y.Z` → o workflow compila o overlay C++ e o instalador Electron no Windows, roda os testes, confere que o `rtai_app.exe` diz a versão certa e publica `RealTimeAI-Setup-X.Y.Z.exe` + `latest.yml` com as notas da versão.
3. Os apps instalados checam a cada 4 h (e ao abrir), baixam em segundo plano e instalam ao reiniciar. Settings → General → Updates mostra o estado e tem "Check now".

### Pré-release (beta)

Todo push na branch `beta` (ou o botão **Run workflow** do workflow **Beta**, em qualquer branch) gera uma pré-release. O número sai dos commits desde a última versão estável, com as mesmas regras do release-please:

| Commits desde a última estável (2.0.0) | Betas publicados | Estável depois |
|---|---|---|
| só `fix:` / `perf:` | `2.0.1-beta.1`, `2.0.1-beta.2`, ... | `2.0.1` |
| algum `feat:` | `2.1.0-beta.1`, `2.1.0-beta.2`, ... | `2.1.0` |
| algum `feat!:` / `BREAKING CHANGE:` | `3.0.0-beta.1`, ... | `3.0.0` |
| só `chore:` / `docs:` / ... | `2.0.1-beta.1` | (nenhuma) |

- O `N` de `-beta.N` vem das tags que já existem (`v2.1.0-beta.*`), então nunca repete e recomeça em 1 depois de cada versão estável.
- Cada beta vira uma tag `vX.Y.Z-beta.N` no commit e uma pré-release no GitHub com notas geradas dos commits (Novidades, Correções, Desempenho).
- O beta sempre fica acima de qualquer versão estável já publicada, mesmo que a branch `beta` ainda não tenha recebido a `main`. Ainda assim, faça merge da `main` na `beta` depois de cada versão estável.
- Pela ordem do semver, `2.1.0-beta.5` < `2.1.0`: quando a estável sai, quem está no beta recebe ela normalmente, e o próximo beta já é `2.1.1-beta.1` ou `2.2.0-beta.1`.
- Só recebe beta quem escolheu o canal **Beta** em Settings → General → Beta and experiments. Quem está no beta também recebe as versões estáveis.
- Os arquivos de versão (`package.json`, `CMakeLists.txt`) não mudam num beta: só a tag. A versão completa é injetada na hora do build.

Para ver o que vai sair antes de publicar:

```bash
npm run version:next     # {"next": "2.1.0", "prerelease": "2.1.0-beta.3", ...}
npm run version:notes    # notas desde a última tag
```

Publicar um beta:

```bash
git push origin main:beta        # ou: git checkout beta && git merge main && git push
```

### A versão dentro do app

- **Overlay (`rtai_app.exe`)**: a versão vem do CMake (`RTAI_VERSION_STRING`, passada pelo CI). Aparece em `rtai_app.exe --version`, na primeira linha do log, no `hello` do modo `--server` (`app_version`), no User-Agent das conexões e em Propriedades → Detalhes do arquivo (`FileVersion` 2.1.0.3 para `2.1.0-beta.3`, marcado como pré-release).
- **Build local**: sem `RTAI_VERSION_STRING`, o exe usa a versão do `CMakeLists.txt` com o commit como metadado (`2.0.0+dev.07e1001`), para nunca se passar por uma versão publicada.
- **Dashboard**: `app.getVersion()` (do `apps/dashboard/package.json`, que o CI ajusta para a versão do build) e a versão do overlay recebida no `hello`.

## Feature flags e testes A/B

As flags ficam em `apps/dashboard/flags.json`:

```json
"direct_assist": {
  "description": "Direct Assist toggle in Settings > AI",
  "rollout": { "stable": 0, "beta": 100 }
},
"ab_start_cta": {
  "description": "A/B test: label of the main start button",
  "rollout": { "stable": 100, "beta": 100 },
  "variants": { "start_session": 50, "go_live": 50 }
}
```

- `rollout`: % das instalações que recebem a flag, por canal. Cada instalação tem um ID fixo, então quem caiu num grupo continua nele.
- `variants`: divide quem recebeu a flag entre variantes (A/B/n), por peso.
- `channels`, `default`, `min_version`: restringem por canal, valor padrão e versão mínima.
- Na interface: `data-flag="chave"` esconde o elemento quando a flag está desligada; `data-ab="chave" data-ab-<variante>="texto"` troca o texto por variante. No JS: `isFlagEnabled('chave')` e `flagVariant('chave')`.
- O overlay C++ pode ler o resultado em `%LOCALAPPDATA%\RealTimeAI\flags-active.json`.

Mudar o `flags.json` na `main` já vale para os apps instalados (com `RELEASES_REPO`, o workflow **Feature flags** copia o arquivo para lá). Os apps buscam a cada 30 min, então dá pra liberar uma feature para 10%, 50%, 100% sem lançar versão nova. Em Settings, cada flag pode ser forçada (On/Off/variante) na própria máquina para testar.

## Configuração do GitHub (uma vez)

O repositório `BrunoBianchi/RealtimeAI` é **público**, então os instaladores, o `latest.yml`/`beta.yml` do auto-update e o `flags.json` podem ficar nele mesmo:

1. Em Settings → Actions → General → Workflow permissions, marque **Read and write permissions** e **Allow GitHub Actions to create and approve pull requests** (sem isso o release-please não consegue abrir o PR de versão). Alternativa: um secret `RELEASE_PLEASE_TOKEN` com um token fine-grained (Contents e Pull requests: Read and write, só neste repositório); com ele o PR de versão também roda o CI.
2. Opcional, em Settings → Secrets and variables → Actions:
   - secret `GOOGLE_OAUTH_CLIENT_JSON` = conteúdo do `apps/dashboard/google_oauth_client.json` (integração com o Google Agenda no instalador).
   - Para publicar os instaladores em outro repositório (por exemplo se este voltar a ser privado): variável `RELEASES_REPO` = `usuario/realtimeai-releases` e secret `RELEASES_TOKEN` = token fine-grained com **Contents: Read and write** só nesse repositório. Com isso o workflow **Feature flags** também copia o `flags.json` para lá.
3. Recomendado: em Settings → Branches, proteja a `main` exigindo os checks do CI (`Commits, secrets and flags`, `Dashboard tests`) antes do merge.

Sem `RELEASES_REPO`, o instalador é anexado à release deste repositório e os apps buscam as flags em `apps/dashboard/flags.json` da `main`.

Build local do instalador (sem publicar): rode `scripts\windows\build.bat`, copie `build\bin\Release\rtai_app.exe` (e `onnxruntime.dll`) para `apps\dashboard\native\` e rode `npm --prefix apps/dashboard run dist`.
