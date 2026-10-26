# RealTimeAI

[![CI](https://github.com/BrunoBianchi/RealtimeAI/actions/workflows/ci.yml/badge.svg)](https://github.com/BrunoBianchi/RealtimeAI/actions/workflows/ci.yml)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-fe5196.svg)](https://www.conventionalcommits.org)

Copiloto de reuniões e entrevistas em tempo real para Windows. Captura o seu microfone ("Você") e o
áudio do sistema ("Outros"), transcreve em streaming com o Deepgram Nova-3, percebe quando alguém faz
uma pergunta e mostra num HUD flutuante uma resposta gerada por LLM a partir dos seus próprios
documentos (RAG híbrido). Cada sessão fica salva em disco.

- **Motor nativo em C++20**: WASAPI, WinHTTP (HTTP/2 + WebSocket), Direct2D/DirectWrite. Sem runtime
  de JavaScript no caminho quente.
- **Baixa latência por projeto**: geração especulativa durante a pausa da pergunta, conexões
  quentes, engine acordada por deadline e processo em modo tempo real. Detalhes em
  [docs/latency.md](docs/latency.md).
- **RAG híbrido**: BM25 com stemming PT/EN + embeddings multilingual-e5 locais (ONNX Runtime),
  fundidos por Reciprocal Rank Fusion. Números da resposta que não estão nos documentos geram aviso.
- **Dashboard Electron**: metas e documentos, configurações, detecção de reuniões, histórico de
  sessões, instalador NSIS, auto-update por canal (stable/beta) e feature flags remotas.

## Estrutura do repositório

```
.
├── apps/
│   └── dashboard/          Dashboard Electron
│       ├── src/main/       processo principal (IPC, overlay, updater, flags, calendário)
│       ├── src/preload/    pontes seguras para o renderer
│       ├── src/renderer/   UI (HTML, Tailwind, JS)
│       └── tests/          testes (node --test)
├── src/                    Motor nativo (uma biblioteca CMake por pasta)
│   ├── core/               lógica pura e testável: engine, turnos, RAG, protocolo, sessão
│   ├── net/                WinHTTP: LLM (SSE/HTTP2), WebSocket, analytics, busca
│   ├── deepgram/           transporte do Deepgram
│   ├── audio_wasapi/       captura de microfone e loopback
│   ├── overlay/            HUD Win32 + Direct2D
│   ├── vad_onnx/           Silero VAD (opcional)
│   ├── embed_onnx/         embeddings do RAG híbrido (opcional)
│   └── app/                executável rtai_app: fiação e ciclo de vida
├── tests/                  testes C++ (unidade, rede, overlay, integração)
├── cmake/                  módulos CMake (flags, GoogleTest, ONNX Runtime)
├── scripts/                checagens (segredos, flags) e scripts Windows (build, run)
├── docs/                   arquitetura, configuração, latência, releases
├── examples/               exemplo de arquivo de contexto
└── .github/                CI, releases, templates
```

## Começando

Requisitos: Windows 10/11, Visual Studio 2022/2026 com **Desktop development with C++**,
Node.js 22 LTS e Git.

```bat
scripts\windows\setup-dev.bat        :: dependências Node e hooks do git
scripts\windows\build.bat            :: overlay nativo + testes do core
scripts\windows\start-dashboard.bat  :: dashboard (inicia o overlay pelas sessões)
```

Sem chaves de API, `scripts\windows\run-demo.bat` abre o HUD com uma conversa roteirizada.
Para usar ao vivo, configure as chaves do Deepgram e do LLM no dashboard (Settings) ou no
`%LOCALAPPDATA%\RealTimeAI\config.ini` (ver [docs/configuration.md](docs/configuration.md)).
O modelo de embeddings do RAG híbrido é baixado uma vez com
`scripts\windows\download-embeddings-model.bat`.

### Comandos

| Comando | O que faz |
|---|---|
| `npm run build:native` | configura e compila com o preset `windows-release` |
| `npm run test:native` | `ctest` do build nativo |
| `npm test` | testes do dashboard |
| `npm run dev` | abre o dashboard a partir do código |
| `npm run check:secrets` | procura chaves de API no repositório |
| `npm run flags:validate` | valida `apps/dashboard/flags.json` |

Presets CMake: `windows-release` (padrão, com RAG híbrido), `windows-lean` (sem ONNX Runtime),
`linux` e `linux-tsan` (núcleo + testes, também em ThreadSanitizer).

## Testes

- `core_tests`: mais de 400 testes GoogleTest do núcleo, sem rede nem hardware (protocolo do
  Deepgram, fila de saída, reconexão, turnos, política de disparo, especulação, RAG, prompt, UI
  models, deadlines da engine). Rodam no Linux e no Windows.
- `net_tests`, `overlay_tests`, `tests/integration`: adapters WinHTTP e Win32 contra servidores
  falsos locais; `deepgram_tests` só com `DEEPGRAM_API_KEY`.
- Dashboard: `npm test` (node --test).

O CI roda tudo isso a cada push e PR.

## Versionamento

Commits seguem [Conventional Commits](https://www.conventionalcommits.org/pt-br/v1.0.0/)
(`feat:`, `fix:`, `perf:`...), validados pelo commitlint. O release-please abre o PR de versão com o
`CHANGELOG.md`, e o merge dele publica o instalador. Fluxo completo em
[CONTRIBUTING.md](CONTRIBUTING.md) e [docs/releases.md](docs/releases.md).

## Documentação

- [Arquitetura](docs/architecture.md)
- [Configuração e uso](docs/configuration.md)
- [Latência](docs/latency.md)
- [Releases, auto-update e feature flags](docs/releases.md)
- [Contribuindo](CONTRIBUTING.md)
- [Avisos de terceiros](THIRD_PARTY_NOTICES.md)
