# API do servidor RealTimeAI (v1)

Contrato entre o app (engine `rtai_app` + dashboard) e os servidores RealTimeAI. O app
continua open-source e funciona sem servidor (modo **chaves próprias**); com uma conta, o
usuário não precisa de chave nenhuma (modo **nuvem**).

Implementação do lado do cliente:

| Parte | Arquivo |
|---|---|
| Contrato puro (parse/validação, escolha do backend) | `src/core/include/rtai/cloud_session.hpp` |
| Cliente HTTP do engine (bootstrap, renovação, fim de sessão) | `src/net/include/rtai/cloud_client.hpp`, `src/net/src/cloud_client.cpp` |
| Ligação no engine | `src/app/src/main.cpp` (seção "RealTimeAI cloud bootstrap") |
| Login e conta no dashboard | `apps/dashboard/src/main/cloud_account.js`, aba **Conta e servidor** |
| Testes | `tests/core_tests/test_cloud_session.cpp`, `test_deepgram_stream.cpp`, `apps/dashboard/tests/cloud_account.test.js` |

## Princípio: corretor de credenciais, não proxy de mídia

```
              (1x por sessão, em paralelo com o start do áudio)
 rtai_app ── POST /v1/session ──────────────► API RealTimeAI
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

Orçamento de latência (meta < 200 ms do fim da fala à primeira palavra):

| Etapa | Chaves próprias | Nuvem |
|---|---|---|
| Áudio → Deepgram | direto | direto (token temporário) |
| Pergunta → 1º token do LLM | direto | direto ou +1 salto na borda (relay deve fazer streaming sem buffer, < 10 ms) |
| Reconexão do STT | imediata | imediata (token já renovado em segundo plano) |
| Início da sessão | — | 1 RTT, sobreposto ao start |

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

- **Token do dispositivo**: obtido pelo login do dashboard (device code, abaixo). Longa
  duração, revogável. Fica em `config.ini [servidor] token`, criptografado com DPAPI pelo
  engine (`rtai_app --protect-keys` logo após o login) e numa cópia `cloud_token.bin`
  (Electron `safeStorage`) para o dashboard consultar a conta.
- Todas as chamadas autenticadas usam `Authorization: Bearer <token do dispositivo>`.
- Todas as chamadas enviam `X-RTAI-Version: <versão do app>`. Responda `426` para versões
  sem suporte.
- Erros: corpo JSON `{"error": "<codigo>"}` ou `{"error": {"code": "...", "message": "<texto pt-BR>"}}`.
  A `message` é mostrada ao usuário como está.

## Endpoints

### `POST /v1/auth/device` — início do login (RFC 8628)

Requisição: `{"client_id": "rtai-dashboard", "app_version": "2.1.0"}`

Resposta `200`:

```json
{
  "device_code": "opaque",
  "user_code": "ABCD-EFGH",
  "verification_uri": "https://app.realtimeai.example/ativar",
  "verification_uri_complete": "https://app.realtimeai.example/ativar?code=ABCD-EFGH",
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

### `POST /v1/auth/logout` — revoga o token do dispositivo

Bearer. Resposta `204`. O app apaga o token local mesmo se a chamada falhar.

### `GET /v1/me` — conta (dashboard)

Bearer. Resposta `200`:

```json
{
  "email": "pessoa@exemplo.com",
  "name": "Pessoa",
  "plan": {"id": "pro", "label": "Pro", "minutes_limit": 1200, "minutes_used": 315, "period_end": "2026-12-01"}
}
```

`401` = login expirado (o dashboard pede para entrar de novo).

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
  "capabilities": {"stt": ["deepgram-ws"], "llm": ["openai-chat-sse"]}
}
```

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
    "url": "https://llm-gru.realtimeai.example/v1/chat/completions",
    "token": "<token de sessão>",
    "model": "qwen/qwen3.6-flash",
    "background_model": "qwen/qwen3.6-flash",
    "fallback": {"url": "https://llm-iad.realtimeai.example/v1/chat/completions", "token": "...", "model": "..."}
  },
  "account": {"plan": "pro", "minutes_left": 885},
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
  o primeiro byte rápido.
- `background_model`: resumos e compactação de memória (fora do caminho ao vivo).

Erros: `401` (login expirado → o dashboard pede login), `402` (sem minutos), `403`, `426`,
`429`, `5xx`. Com `[servidor] modo = auto` e chaves próprias configuradas, uma falha cai
para as chaves próprias com um aviso; sem chaves, a sessão não inicia e o HUD/dashboard
mostram o motivo.

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
; auto = servidores RealTimeAI quando conectado, senão as suas chaves
; nuvem = sempre pela conta (sem servidor, a sessão não inicia)
; proprio = só as suas chaves (modo open-source)
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
Um build open-source sem esses valores só oferece login se `[servidor] url` for preenchido.
