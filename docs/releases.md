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
| `chore:` `docs:` `test:` `ci:` `refactor:` | | não gera versão sozinho |

Hooks (husky):

- **pre-commit**: bloqueia chaves de API e arquivos privados (`config.ini`, `google_oauth_client.json`, `.env`) e valida o `flags.json`.
- **commit-msg**: recusa mensagens fora do padrão.
- **pre-push**: scan de segredos no repositório inteiro, testes do dashboard e `core_tests.exe` se houver build local.

## Como uma versão chega nos usuários

1. Push na `main` → o workflow **Release** abre (ou atualiza) um PR `chore(release): vX.Y.Z` com a versão nova e o `CHANGELOG.md`.
2. Merge desse PR → tag `vX.Y.Z` → o workflow compila o overlay C++ e o instalador Electron no Windows, roda os testes e publica `RealTimeAI-Setup-X.Y.Z.exe` + `latest.yml` no repositório público de releases.
3. Os apps instalados checam a cada 4 h (e ao abrir), baixam em segundo plano e instalam ao reiniciar. Settings → General → Updates mostra o estado e tem "Check now".

Beta: todo push na branch `beta` publica uma pré-release `X.Y.(Z+1)-beta.N`. Só recebe quem escolheu o canal **Beta** em Settings → General → Beta and experiments. Quem está no beta também recebe as versões estáveis.

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

Mudar o `flags.json` na `main` publica o arquivo no repositório de releases (workflow **Feature flags**). Os apps buscam a cada 30 min, então dá pra liberar uma feature para 10%, 50%, 100% sem lançar versão nova. Em Settings, cada flag pode ser forçada (On/Off/variante) na própria máquina para testar.

## Configuração do GitHub (uma vez)

1. Repositório **privado** com este código.
2. Repositório **público** só para os instaladores, por exemplo `realtimeai-releases`, com um README (precisa ter ao menos um commit).
3. No repositório privado, em Settings → Secrets and variables → Actions:
   - variável `RELEASES_REPO` = `seu-usuario/realtimeai-releases`
   - secret `RELEASES_TOKEN` = token fine-grained com **Contents: Read and write** só no repositório de releases
   - secret `GOOGLE_OAUTH_CLIENT_JSON` (opcional) = conteúdo do `apps/dashboard/google_oauth_client.json`
4. Em Settings → Actions → General, marque "Allow GitHub Actions to create and approve pull requests" (o release-please abre o PR de versão).

Build local do instalador (sem publicar): rode `scripts\windows\build.bat`, copie `build\bin\Release\rtai_app.exe` (e `onnxruntime.dll`) para `apps\dashboard\native\` e rode `npm --prefix apps/dashboard run dist`.
