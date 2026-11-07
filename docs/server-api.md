# API do servidor lipcue.com (v1)

Contrato entre o app (engine `rtai_app` + dashboard) e os servidores lipcue.com. O app
continua open-source e funciona sem servidor (modo **chaves próprias**); com uma conta, o
usuário não precisa de chave nenhuma (modo **nuvem**).

Implementação do lado do cliente:

| Parte | Arquivo |
|---|---|
| Contrato puro (parse/validação, escolha do backend) | `src/core/include/rtai/cloud_session.hpp` |
| Cliente HTTP do engine (bootstrap, renovação, fim de sessão) | `src/net/include/rtai/cloud_client.hpp`, `src/net/src/cloud_client.cpp` |
| Ligação no engine | `src/app/src/main.cpp` (seção "lipcue.com cloud bootstrap") |
| Login e conta no dashboard | `apps/dashboard/src/main/cloud_account.js`, aba **Conta e servidor** |
| Servidor local para testes | `../backend/` em Go, fora deste repositório, roda no Docker (`npm run backend`, veja `../backend/README.md`) |
| Testes | `tests/core_tests/test_cloud_session.cpp`, `test_deepgram_stream.cpp`, `apps/dashboard/tests/cloud_account.test.js` |

## Princípio: corretor de credenciais, não proxy de mídia

```
              (1x por sessão, em paralelo com o start do áudio)
 rtai_app ── POST /v1/session ──────────────► API lipcue.com
    │        ◄── stt{url,token} llm{url,token} ──┘   (tokens de curta duração)
    │
    ├── WebSocket de áudio ──────────────────► Deepgram (direto, token temporário)
    └── SSE chat/completions ────────────────► URL escolhida pelo servidor
                                                (relay na borda, perto do provedor,
                                                 ou o provedor com chave escopada)
```

O servidor **não fica no caminho do áudio**. Cada pergunta continua com o mesmo número de
saltos de rede do modo chaves próprias. O único custo novo é uma chamada HTTPS no início da
sessão, feita em paralelo com o carregamento do agente, do RAG e do áudio (o log mostra
`Cloud: session ... waited N ms at start-up`: o alvo é 0 ms de espera).

Orçamento de latência. Menos de 200 ms do fim da fala à primeira palavra só acontece quando
a especulação acerta: a resposta já estava sendo gerada antes de a fala terminar. Sem esse
acerto, o tempo é dominado pelo TTFT do provedor, e a meta do modo nuvem é p50 ≤ 500 ms e
p95 ≤ 1.000 ms (`specs/001-backend-latency/spec.md`, SC-002). Os budgets de 200 ms do servidor
valem para o trecho medido nele (linha `llm_relay` do log), não para o caminho inteiro.

| Etapa | Chaves próprias | Nuvem |
|---|---|---|
| Áudio → Deepgram | direto | direto (token temporário) |
| Pergunta → 1º token do LLM | direto | +1 salto pelo relay, em streaming sem buffer (conexões mantidas abertas nos dois trechos) |
| Reconexão do STT | imediata | imediata (token já renovado em segundo plano) |
| Início da sessão | — | 1 RTT, sobreposto ao start |

Quanto cada resposta gastou fica em dois lugares, sem conteúdo da conversa: a linha `llm_relay`
no servidor e os campos `route` (em `session_start`) e `speech_end_to_visible_ms` (em
`suggestion`) nos arquivos de sessão do app. `scripts/session-ttft.mjs` resume os arquivos.

Regras para o servidor manter isso:

1. **STT direto**: emitir token temporário do Deepgram (`POST /v1/auth/grant` com a chave
   do projeto, `ttl_seconds` ≥ `refresh_after_s` + 60). O app envia `Authorization: Bearer <token>`.
   O token só é exigido no handshake: uma conexão aberta não cai quando ele expira.
2. **LLM**: se usar relay, colocá-lo na mesma região do provedor (ex.: Cloudflare Workers /
   Fly.io em `gru`/`iad`), repassar SSE byte a byte (`Content-Type: text/event-stream`,
   sem compressão e sem buffering) e manter HTTP/2 com o cliente. Alternativa sem salto:
   chave escopada por usuário (ex.: chaves provisionadas do OpenRouter com limite de crédito).
3. **Região**: responder com endpoints da região mais próxima (GeoIP/anycast) ou da `region`
   pedida.
4. `POST /v1/session` deve responder em < 150 ms p95 (sem chamadas externas em série:
   gerar os dois tokens em paralelo, ou manter um pool pré-emitido).

## Autenticação

O login é **obrigatório**: sem token do dispositivo o dashboard mostra só a tela de login
(nenhuma aba ou configuração) e o engine não inicia sessão ao vivo (`hello.needs = "login"`).
Três formas de entrar, todas terminam no mesmo token do dispositivo:

- **Google** e **SSO da empresa** (SAML/OIDC): device code (RFC 8628) com `provider`; a
  página do servidor redireciona ao Google ou ao IdP da empresa;
- **e-mail + senha**: `POST /v1/auth/login` (conta nova: `POST /v1/auth/signup`).

- **Token do dispositivo**: obtido por um dos logins acima. Longa
  duração, revogável. Fica em `config.ini [servidor] token`, criptografado com DPAPI pelo
  engine (`rtai_app --protect-keys` logo após o login) e numa cópia `cloud_token.bin`
  (Electron `safeStorage`) para o dashboard consultar a conta.
- Todas as chamadas autenticadas usam `Authorization: Bearer <token do dispositivo>`.
- Todas as chamadas enviam `X-RTAI-Version: <versão do app>`. Responda `426` para versões
  sem suporte.
- Erros: corpo JSON `{"error": "<codigo>"}` ou `{"error": {"code": "...", "message": "<texto pt-BR>"}}`.
  A `message` é mostrada ao usuário como está.
- **`503 busy`** com `Retry-After`: o servidor limita o trabalho pesado para proteger as
  respostas ao vivo. Vale para rotas que calculam hash de senha (login, cadastro, troca e
  exclusão de senha) e para corpos acima de 1 MB em `POST /v1/ai/chat/completions`,
  `POST /v1/files` e `PUT /v1/sync/{kind}/{id}`. Depois de até 2 s de espera, o servidor
  recusa em vez de enfileirar. O relay ao vivo (`/v1/llm/`) nunca recebe esse erro.

## Endpoints

### `POST /v1/auth/device` — início do login (RFC 8628)

Requisição: `{"client_id": "rtai-dashboard", "app_version": "2.1.0", "provider": "google"}`

- `provider`: `google` ou `sso`. Com `sso` vai também `login_hint` (e-mail corporativo ou
  domínio), que o servidor usa para achar o IdP da empresa. Sem SSO configurado para o
  domínio: `400 {"error": "sso_not_configured"}`.

Resposta `200`:

```json
{
  "device_code": "opaque",
  "user_code": "ABCD-EFGH",
  "verification_uri": "https://app.lipcue.example/ativar",
  "verification_uri_complete": "https://app.lipcue.example/ativar?code=ABCD-EFGH",
  "expires_in": 600,
  "interval": 5
}
```

O dashboard abre `verification_uri_complete` no navegador e mostra `user_code`.

### `POST /v1/auth/device/token` — polling do login

Requisição: `{"device_code": "...", "grant_type": "urn:ietf:params:oauth:grant-type:device_code", "client_id": "rtai-dashboard"}`

- `200` `{"access_token": "<token do dispositivo>", "account": {"email": "...", "name": "..."}}`
- `400` `{"error": "authorization_pending"}`: continua esperando.
- `400` `{"error": "slow_down"}`: o app soma 5 s ao intervalo.
- `400` `{"error": "access_denied" | "expired_token"}`: encerra o login.

### `POST /v1/auth/login` — e-mail + senha

Requisição: `{"email": "...", "password": "...", "client_id": "rtai-dashboard"}`

- `200` `{"access_token": "<token do dispositivo>", "account": {...}}`
- `401` `{"error": "invalid_credentials"}` · `403` `{"error": "email_not_verified"}` ·
  `429` `{"error": "rate_limited"}` · `503` `{"error": "busy"}` (não conta como tentativa errada)

### `POST /v1/auth/signup` — criar conta

Requisição: `{"name": "...", "email": "...", "password": "...", "client_id": "rtai-dashboard", "referral_code": "..."}`
(o app exige senha com pelo menos 8 caracteres). `referral_code` é opcional: um código
desconhecido ou esgotado é ignorado e nunca impede a criação da conta.

- `201` `{"access_token": "...", "account": {...}}` (entra direto), ou
- `201` `{"verification_required": true}` (o app pede para confirmar o e-mail e entrar);
- `409` `{"error": "email_taken"}` · `400` `{"error": "weak_password" | "invalid_email"}`.

Toda conta nova começa no plano **Free**.

### `POST /v1/auth/password/reset` — recuperar senha

Requisição: `{"email": "..."}`. Responda `204` exista ou não a conta (sem enumeração).

### `POST /v1/auth/logout` — revoga o token do dispositivo

Bearer. Resposta `204`. O app apaga o token local mesmo se a chamada falhar.

### `GET /v1/me` — conta (dashboard)

Bearer. Resposta `200`:

```json
{
  "email": "pessoa@exemplo.com",
  "name": "Pessoa",
  "plan": {
    "id": "pro",
    "minutes_limit": 200,
    "minutes_used": 115,
    "sessions_used": 31,
    "max_session_minutes": 200,
    "period_end": "2026-12-01"
  }
}
```

`401` = login expirado (o app volta para a tela de login).

## Arquivos

Backup dos documentos do usuário. Bearer em todas as rotas.

| Rota | O que faz |
|---|---|
| `GET /v1/files` | `{files: [{id, name, tag, agent_id, size, sha256, created_at}], used_bytes, limit_bytes}` |
| `POST /v1/files?name=&tag=&agent_id=` | corpo = bytes do arquivo. `201` novo, `200` se o mesmo nome e conteúdo já existe |
| `GET /v1/files/{id}` | baixa o arquivo |
| `DELETE /v1/files/{id}` | `{ok: true}` |

Até 20 MB por arquivo (`413 file_too_large`). Cota: Free 25 MB, PRO 500 MB (`413 storage_full`).
Arquivo de outra conta responde `404`.

## Planos

| Plano | Limite | Sessões | Renova |
|---|---|---|---|
| `free` | 15 min | **uma única**, de até 15 min | nunca (é um teste) |
| `pro` | US$ 19/mês, 200 min (tokens) e 1 entrevista simulada por mês | quantas quiser | todo mês (`period_end`) |

Tokens avulsos: 1 token = 1 minuto, nunca expiram e são gastos depois dos minutos do plano.
Pacotes: `tokens_60` (US$ 7), `tokens_150` (US$ 16), `tokens_400` (US$ 40). O saldo vem em
`plan.credit_minutes` de `GET /v1/me`, e `minutes_left`/`max_session_s` da sessão já o incluem.

- O servidor é a autoridade: recusa `POST /v1/session` com `402` quando o plano não tem
  minutos (ou a sessão gratuita já foi usada) e informa em `account` quanto a sessão pode
  durar.
- A sessão gratuita é consumida quando o servidor concede a primeira sessão com
  credenciais (`credentials: true`), mesmo que dure menos de 15 min.
- O app confere antes (dashboard: `apps/dashboard/src/main/plans.js`) e durante (engine:
  `cloud::session_budget_s`): avisa 1 min antes e encerra e salva a sessão ao atingir o
  limite. Valores do servidor têm precedência; os do app só preenchem o que faltar.
- `id` desconhecido = Free. `premium` é aceito como sinônimo de `pro`.

### `POST /v1/billing/checkout` e `POST /v1/billing/portal` — assinatura

Bearer. `checkout` recebe `{"plan": "pro"}` ou `{"pack": "tokens_60"}` (pacote inexistente: `400 unknown_pack`); `portal` recebe `{}`. Resposta `200`
`{"url": "https://..."}` com a página hospedada (ex.: Stripe Checkout / Customer Portal),
que o app abre no navegador. Só `https://` é aceito. Depois do pagamento, `GET /v1/me`
passa a mostrar `pro`.

### `GET /v1/referral` — convites

Bearer. Devolve o código da conta (criado no primeiro uso) e o andamento:
`{"code": "...", "url": "https://.../r/...", "invited": 2, "completed": 1, "limit": 5, "bonus_minutes": 30, "minutes_earned": 30}`.

- A conta nova entra com `referral_code` no `signup`. Quando ela encerra a primeira sessão
  de pelo menos 60 s, o servidor soma 30 `credit_minutes` às duas contas, uma única vez.
- O dono do código recebe por no máximo 5 amigos; com 5 concluídos, o código deixa de valer
  para contas novas. Os minutos valem como tokens comprados e não expiram.
- `GET /r/{code}` é a página pública do link: explica como usar o código no app (`404` se o
  código não existe). Excluir a conta invalida o código.

### Entrevista simulada (`/v1/mock`)

Até 30 min por simulado. O Básico custa 24 tokens de simulado e o Avançado, 48. O Pro inclui 72 tokens de simulado por mês, em saldo separado dos minutos ao vivo. Os dois modos usam primeiro a franquia mensal e depois os tokens comprados, que não expiram. Créditos antigos são convertidos pelo custo do modo original. O saldo em `GET /v1/me` fica em `plan.mock_tokens`, com `included_limit`, `included_left`, `purchased`, `basic_cost` e `advanced_cost`.

- `POST /v1/mock/start` `{agent_id, mode: "basic" | "advanced"}` → `{id, source, mode, max_s, tokens_spent?, vision_enabled, stt?}`. Básico conversa com Orby por texto. Avançado inclui voz e pede consentimento para analisar imagens ocasionais da câmera. Uma entrevista em andamento é retomada sem nova cobrança. Saldo insuficiente retorna `402 mock_not_included`.
- `POST /v1/mock/{id}/chat`: corpo chat/completions; o servidor impõe o modelo de conversa e `max_tokens`. Aceito até 3 min depois do limite (feedback final).
- `POST /v1/mock/{id}/tts` `{text}` (até 500 caracteres; 15 mil por entrevista Avançada) → áudio mp3 (`TTS_MODEL`, padrão `elevenlabs/eleven-turbo-v2.5`; `TTS_VOICE`, padrão `sarah`; o modelo detecta o idioma do texto). Indisponível no Básico.
- `POST /v1/mock/{id}/stt` → nova credencial de transcrição. Indisponível no Básico.
- `POST /v1/mock/{id}/vision` `{image, previous_image?, language}` analisa até dois JPEGs pequenos, com limite de 30 chamadas por entrevista e intervalo mínimo de 55 s. Usa `MOCK_VISION_MODEL` (padrão `openai/gpt-5.4-mini` via OpenRouter) para observações de enquadramento, direção do olhar, postura, vestimenta, organização do fundo e movimentos visíveis. As imagens são retransmitidas para o modelo e não são armazenadas pelo servidor.
- `POST /v1/mock/{id}/end` → `{refunded}`. Encerrar em menos de 1 min estorna a cobrança para os saldos de origem, desde que a franquia mensal ainda esteja no mesmo ciclo.
- Depois do limite: `410 mock_over`.

### `POST /v1/session` — credenciais da sessão (engine)

Bearer. Feita no início de cada sessão ao vivo e depois em segundo plano a cada
`refresh_after_s` (ou 30 s antes de `expires_at`). Também é refeita na hora se o Deepgram
recusar o token com `401`.

Requisição:

```json
{
  "api": 1,
  "client": "engine",
  "app_version": "2.1.0",
  "platform": "windows",
  "language": "multi",
  "model": "qwen/qwen3.6-flash",
  "region": "sa-east-1",
  "agent_id": "nubank-senior",
  "capabilities": {"stt": ["deepgram-ws"], "llm": ["openai-chat-sse"]},
  "credentials": true
}
```

`credentials: false` quando o usuário usa as próprias chaves (`[servidor] modo = proprio`):
o servidor só concede a sessão e o tempo (a cota vale nos dois modos) e pode omitir
`stt`/`llm`.

`region` só vai quando o usuário escolhe uma (padrão: o servidor decide). `model` é a
preferência do usuário; o servidor pode trocar conforme o plano.

Resposta `200`:

```json
{
  "session_id": "sess_01J...",
  "expires_at": 1793600000,
  "refresh_after_s": 240,
  "stt": {
    "url": "wss://api.deepgram.com/v1/listen",
    "token": "<token temporário do Deepgram>",
    "model": "nova-3",
    "extra_query": "tag=sess_01J..."
  },
  "llm": {
    "url": "https://llm-gru.lipcue.example/v1/chat/completions",
    "token": "<token de sessão>",
    "model": "qwen/qwen3.6-flash",
    "background_model": "qwen/qwen3.6-flash",
    "fallback": {"url": "https://llm-iad.lipcue.example/v1/chat/completions", "token": "...", "model": "..."}
  },
  "account": {"plan": "pro", "minutes_left": 85, "max_session_s": 5100},
  "notice": "Mensagem opcional mostrada no HUD"
}
```

Validação no app (`cloud::parse_session`):

- `stt.url` precisa ser `wss://` (ou `ws://` em desenvolvimento) e ter `token`. O app monta
  os parâmetros de consulta do Deepgram (`model`, `encoding`, `language`, `endpointing`,
  `keyterm`...) e acrescenta `extra_query` (ex.: `tag` para medir uso por sessão no Deepgram).
  O caminho da URL é respeitado (`/v1/listen` ou o de um relay compatível).
- `llm` é opcional (plano só de transcrição). Quando presente: `https://` (ou `http://` em
  desenvolvimento) compatível com OpenAI `chat/completions` com `stream: true`. O app envia
  `Authorization: Bearer <llm.token>`.
- `llm.fallback` é opcional, só `https://`; o app troca para ele se o primário não mandar
  o primeiro byte rápido. Um fallback em `http://` é descartado sem falhar a sessão. O
  servidor só o envia com `PUBLIC_URL` em HTTPS e `LLM_FALLBACK_MODEL` definido: é o mesmo
  relay, com o mesmo token e outro modelo.
- **Relay em HTTPS**: `llm.url` segue `PUBLIC_URL`. Em HTTPS, o nginx fala HTTP/2 com o cliente
  e mantém a conexão por 300 s. A porta 80 continua respondendo, sem redirecionar, para as
  instalações antigas, porque um redirecionamento quebraria os POSTs delas.
- `HEAD /v1/llm/models` responde `200` sem token e sem tocar no banco. O app usa essa rota
  para manter a conexão com o relay aquecida (`keep_alive_relay`).
- O servidor pode acrescentar `provider` ao corpo no relay ao vivo (`LLM_PROVIDER_ROUTING`). Um
  `provider` enviado pelo cliente continua prevalecendo.
- `background_model`: resumos e compactação de memória (fora do caminho ao vivo).

- `account.max_session_s`: quanto esta sessão pode durar (Free: 900 na única sessão). O
  app encerra a sessão ao atingir `min(max_session_s, minutes_left × 60)`.
  `minutes_left: 0` é tratado como recusa.

Erros: `401` (login expirado → `hello.needs = "login"`, o app volta para o login), `402`
(plano sem minutos / sessão gratuita já usada → `needs = "upgrade"`, o dashboard abre o
plano), `403` (conta bloqueada → `upgrade`), `426`, `429`, `5xx` (`needs = "server"`).
Não há mais queda para as chaves próprias: sem a concessão do servidor a sessão não inicia.

### Recursos do dashboard (fora do caminho ao vivo)

Todos com Bearer do token do dispositivo. Com login, o app não precisa de chave nenhuma
para eles; no modo **chaves próprias** com chave do OpenRouter, a IA vai direto ao provedor.

- `POST /v1/ai/chat/completions`: mesmo formato do OpenAI `chat/completions` (com ou sem
  `stream`). Avaliação JEV, compactação de memória, debriefs e OCR de PDF escaneado.
- `POST /v1/research/company` `{"company", "role", "job_description"}` →
  `200 {"ok": true, "source": "ai" | "web", "dossier": "..."}`. O servidor busca o site
  oficial (só hosts públicos), resultados da web e Wikipedia, e escreve o dossiê.
- `GET /v1/integrations/google` → `{"client_id", "type": "installed"}` (ou `404
  not_configured`). `POST /v1/integrations/google/token` recebe `grant_type`
  (`authorization_code` com `code`, `redirect_uri` de loopback e `code_verifier`, ou
  `refresh_token`) e devolve a resposta do Google: o segredo do cliente OAuth fica no servidor.
- `POST /v1/questions` `{"company", "questions": [{"text", "category", "subCategory"}]}`
  (com "Compartilhar perguntas anonimizadas" ligado) e `GET /v1/questions?company=` →
  `{"company", "questions": [{"text", "category", "subCategory", "reports", "last"}]}`.
  O servidor remove e-mails, links e números e conta um voto por conta.

`GET /v1/me` informa o que o servidor oferece em `features`
(`ai`, `research`, `community_questions`, `google_calendar`).

### `POST /v1/session/{session_id}/end` — fim da sessão

Bearer. Enviada ao encerrar (sem bloquear: espera no máximo 1,2 s).

```json
{"duration_s": 1800, "stt_audio_s": 1500, "answers": 12, "avg_ttft_ms": 180}
```

Resposta `204`. Use para conciliar uso; a fonte de verdade de cobrança deve ser o
servidor (uso do Deepgram por `tag`, tokens do LLM no relay).

## Configuração (`config.ini`)

```ini
[servidor]
; auto / nuvem = transcrição e IA pelos servidores lipcue.com
; proprio = suas chaves de API (o login e a cota do plano continuam valendo)
; local = suas chaves, sem conta e sem nenhuma chamada a este servidor
;         (modo open-source; cada resposta espera +500 ms, recursos PRO desligados)
modo = auto
; vazio = servidor padrão do build oficial
url =
; auto, sa-east-1, us-east-1, eu-west-1
regiao = auto
; gravado pelo login do dashboard; criptografado (dpapi:...) pelo app
token =
```

Variáveis equivalentes: `RTAI_SERVER_MODE`, `RTAI_SERVER_URL`, `RTAI_SERVER_REGION`,
`RTAI_SERVER_TOKEN`.

O servidor padrão é definido no build: `cmake --preset windows-release -DRTAI_SERVER_URL=https://api...`
(engine) e `BUILTIN_SERVER_URL` em `apps/dashboard/src/main/cloud_account.js` (dashboard).
Um build open-source sem esses valores pede o endereço do servidor na própria tela de login.

## Sincronização

Cópia na nuvem dos dados do usuário. O app define o formato; o servidor guarda bytes e aplica o plano. `kind`: `session`, `history` ou `bank` (`id` = `main`).

- `GET /v1/sync` → `{ items: [{kind, id, size, sha256, updated_at}], used_bytes, limit_bytes, limits: {session, history} }` (limite `0` = sem limite).
- `GET /v1/sync/{kind}/{id}` → os bytes (`404` se não existir ou for de outra conta).
- `PUT /v1/sync/{kind}/{id}?updated_at=<ms>` (corpo cru, até 20 MB) → o item. Erros: `402 cloud_limit`, `413 storage_full`, `413 item_too_large`.
- `DELETE /v1/sync/{kind}/{id}` → `{ ok: true }`.

Free: 3 sessões e 5 itens de histórico. PRO: sem limite de quantidade. A cota de bytes é compartilhada com `/v1/files`.

Os endpoints `/v1/auth/device*` (login por dispositivo) foram removidos: o login é por e-mail e senha. `/v1/billing/*` responde `503 billing_unavailable` até haver um provedor de pagamento.

## Excluir conta

`DELETE /v1/me` com `{ "password": "..." }` → `{ ok: true }`. Apaga a conta, tokens, sessões, arquivos e dados sincronizados. Senha errada: `401 invalid_credentials`. As perguntas anônimas do banco da comunidade ficam, sem o vínculo com a conta.
