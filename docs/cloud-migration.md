# Migração para os servidores RealTimeAI

Objetivo: o app continua open-source e funcional com chaves próprias, mas o caminho padrão
passa a ser a conta RealTimeAI (sem chaves de API), sem perder latência (meta < 200 ms).

## O que já está no app (lado cliente)

| Peça | Estado |
|---|---|
| `[servidor]` no `config.ini` (`modo`, `url`, `regiao`, `token`) lido pelo engine e pelo dashboard | pronto |
| Token do dispositivo criptografado com DPAPI (`rtai_app --protect-keys`) | pronto |
| Bootstrap `POST /v1/session` em paralelo com o start, renovação em segundo plano | pronto |
| STT direto no Deepgram com token temporário (renovação forçada em `401`) | pronto |
| LLM pela URL do servidor (relay na borda ou provedor), com fallback | pronto |
| Relatório de uso `POST /v1/session/{id}/end` no encerramento (≤ 1,2 s) | pronto |
| Login obrigatório: tela de login bloqueia abas e configurações até entrar | pronto |
| Google e SSO (device code, RFC 8628, com `provider`), e-mail + senha, criar conta, recuperar senha | pronto |
| Planos: Free (uma sessão de até 15 min, uma vez) e PRO (200 min/mês); checkout e portal | pronto |
| Engine encerra a sessão no limite do plano (aviso 1 min antes) | pronto |
| `hello` com `backend` (`nuvem`/`proprio`) e `plan`; `needs: "login" \| "upgrade" \| "server"` | pronto |
| Servidor padrão no build (`-DRTAI_SERVER_URL`, `BUILTIN_SERVER_URL`) | **vazio: preencher** |

Sem servidor configurado, a tela de login pede o endereço: não há mais uso sem conta.

## O que falta (lado servidor)

Implementar `docs/server-api.md`. Sugestão de arquitetura, pensando em latência:

1. **API de controle** (contas, Google/SSO/senha, planos e cobrança, `/v1/auth/*`,
   `/v1/me`, `/v1/billing/*`, `/v1/session`): qualquer
   stack, perto do banco. Não está no caminho ao vivo; `/v1/session` < 150 ms p95.
2. **STT**: sem relay. `/v1/session` emite um token temporário do Deepgram
   (`POST https://api.deepgram.com/v1/auth/grant`) e um `tag` por sessão para medir uso.
3. **LLM**: relay de borda em streaming (Workers/Fly) na região do provedor, validando o
   token de sessão (JWT assinado, verificação local sem I/O) e repassando SSE sem buffer;
   ou chaves escopadas por usuário direto no provedor. Medir TTFT nos dois e escolher.
4. **Medição/cobrança**: uso do Deepgram por `tag`, tokens contados no relay;
   `/session/{id}/end` só como conciliação. O servidor desconta os minutos do plano e
   marca a sessão gratuita como usada ao concedê-la (veja "Planos" em `server-api.md`).

## Passo a passo do lançamento

1. Subir a API em staging e apontar um build de teste:
   `[servidor] url = https://staging...` (ou `RTAI_SERVER_URL`), entrar pela aba Conta.
2. Validar latência com `--console`: o log mostra `Cloud: session ... waited N ms`
   (alvo 0) e os tempos de TTFT por resposta; comparar com o modo `proprio`.
3. Definir o domínio de produção em dois lugares: `cmake ... -DRTAI_SERVER_URL=https://...`
   (CI: `.github/workflows/build-windows.yml`) e `BUILTIN_SERVER_URL` em
   `apps/dashboard/src/main/cloud_account.js`.
4. Lançar no canal **beta**. Atenção: o login passa a ser obrigatório, então usuários
   atuais precisam criar conta (começam no Free; quem usa as próprias chaves pode manter
   `modo = proprio`, mas a cota do plano vale igual).

## Riscos e decisões

- **Servidor fora do ar**: sessões novas não iniciam (`needs = "server"`) e o motivo
  aparece no HUD/dashboard; o dashboard continua aberto para quem já entrou. Sessões em andamento não dependem do
  servidor (os tokens só são verificados no handshake do STT; o LLM depende do relay, se usado).
- **Privacidade**: o áudio não passa pelos servidores RealTimeAI (vai direto ao Deepgram).
  Com relay de LLM, o texto da pergunta passa pelo relay: documentar na política.
- **Open-source**: nenhum segredo do servidor fica no app; qualquer um pode apontar
  `[servidor] url` para uma implementação própria da API v1.
