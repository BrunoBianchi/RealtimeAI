# Arquitetura

O RealTimeAI tem duas partes:

- **Motor nativo** (`src/`, C++20, Win32): captura o microfone ("Você") e o áudio do sistema
  ("Outros"), transcreve com o Deepgram Nova-3 em streaming, decide quando responder e mostra a
  resposta do LLM num HUD Direct2D. Tudo que é lógica fica em `rtai_core`, sem `<windows.h>`, e roda
  nos testes em qualquer sistema.
- **Dashboard** (`apps/dashboard/`, Electron): metas e documentos do RAG, configurações, detecção de
  reuniões, histórico de sessões, instalador e auto-update.

```
 Mic  (thread WASAPI) --> resample 16k --> VAD --> fila ─┐  DeepgramStream "Você"
 Loop (thread WASAPI) --> resample 16k --> VAD --> fila ─┤  (1 thread escritora + 1 leitora por lane)
                                                        │      │  KeepAlive/timer, Finalize,
                                                        │      │  reconexão, watchdog
                                                        │      v
                                       transcrições + fim de turno local
                                                        │
                                                        v
                    CopilotEngine (1 thread dona do estado: turnos, política, contexto)
                          │                 │                       │
             LLM worker threads      SessionStore (thread     AsyncLog (thread
             (OpenRouter, SSE,        de escrita, JSONL)       do console)
              "a mais nova vence")
                          │
                          v
             Overlay (thread de UI): fila com coalescência -> 1 render a cada <=16 ms
```

- **Motor x clientes.** O motor (captura, STT, LLM, persistência) publica eventos tipados
  (`copilot_events.hpp`) para sinks não bloqueantes. O overlay é um cliente desses eventos,
  assim como o gravador de sessão e o console. Como todo evento já serializa para JSON
  (formato do log de sessão), expor o mesmo fluxo para um processo externo (named pipe,
  WebSocket local) é uma troca de sink, não uma reescrita.
- **A thread de UI nunca bloqueia.** Produtores só fazem `push` numa `WakeQueue`; no máximo
  um `PostMessage` por rajada. A UI drena tudo, atualiza o modelo e agenda um único frame.
- `src/core/`: lógica pura e testável (sem `<windows.h>`): `DeepgramStream`, protocolo,
  fila de saída, backoff, VAD, turnos, política de disparo, prompt, SSE/OpenRouter,
  `CopilotEngine`, `SessionStore`, formatação das sugestões.
- `src/net/`: adapters WinHTTP (WebSocket do Deepgram, streaming HTTPS do OpenRouter).
- `src/deepgram/`: `DeepgramTransport` = `DeepgramStream` + WebSocket WinHTTP.
- `src/audio_wasapi/`: captura mic + loopback.
- `src/overlay/`: HUD Win32 + Direct2D/DirectWrite (janela layered com alpha por pixel).
- `src/vad_onnx/`: Silero via ONNX Runtime (opcional, `-DRTAI_ENABLE_ONNX=ON`).
- `src/embed_onnx/`: embeddings multilingual-e5 do RAG híbrido (opcional, `-DRTAI_ENABLE_EMBEDDINGS=ON`).
- `src/app/`: fiação, configuração, ajuste de processo para tempo real e desligamento ordenado.
- `apps/dashboard/`: dashboard Electron (bandeja, metas/agentes, configurações, instalador e
  auto-update). Inicia o overlay com `--server` e conversa com ele por JSON em stdin/stdout.

## O HUD

Três painéis arredondados empilhados (a mesma organização de apps como o Natively, que
serviu de referência de UX; nenhum código dele foi usado):

1. **Barra de ações**: áudio do sistema ("Outros") e microfone ("Você") com ponto de
   gravação e anel de nível, clique para pausar só aquela fonte; **Responder**, **Tela**
   (captura o monitor e manda para um modelo com visão), **Chat** (pergunta digitada sobre
   a conversa); mover, recolher, menu (resumo, follow-up, pausar, clique atravessa,
   config) e **Encerrar**.
2. **Faixa de transcrição**: medidor de nível e a fala recente em blocos (cinza = Outros,
   azul = Você), os mais antigos saem pela esquerda.
3. **Cartão de resposta**: histórico (←/→), pergunta literal com o motivo do disparo,
   resposta em streaming com bullets e negrito, copiar, avaliar (👍/👎 vão para a sessão),
   métricas (1º token, total, modelo) e o campo de chat.

Detalhes: largura ajustável pela borda direita (420 a 1100 px) com layout responsivo
(botões perdem os atalhos e depois os rótulos), altura acompanha o conteúdo, tooltips,
ícones Lucide desenhados como geometria Direct2D (arcos SVG convertidos em Bézier),
posição/largura/estado recolhido salvos. O HUD não rouba o foco: só o campo de chat pede
foco, e ao enviar devolve para o app que estava ativo.

## Sessões salvas

Cada execução gera `AAAA-MM-DD_HH-MM-SS_xxxx.jsonl` (append-only, uma linha por evento:
falas, sugestões, mudanças de conexão, avisos e pausas) e, ao encerrar, um `.md` legível
com a linha do tempo e um resumo. A escrita acontece numa thread própria com flush a cada
lote; se o app cair, a próxima execução fecha a sessão incompleta e gera o `.md`
(uma linha cortada no meio é ignorada, não invalida o arquivo).

## Histórico de decisões

### Robustez do streaming (slice inicial)

| Problema | Causa raiz | Correção |
|---|---|---|
| Deepgram derruba a conexão no silêncio | O KeepAlive só era checado antes de um `WinHttpWebSocketReceive` bloqueante. No silêncio o servidor não manda nada, o receive nunca retorna e o KeepAlive nunca sai. O Deepgram fecha com `1011 NET-0001` após ~10 s, e a lane morria de vez | Thread escritora com timer próprio: KeepAlive sai a cada 3 s de inatividade, independente de áudio ou de mensagens do servidor. Cobre também o loopback, que não entrega pacotes enquanto nada toca |
| Envio concorrente de áudio e controle | Áudio saía da thread de captura e KeepAlive da thread de recepção, no mesmo socket. O WinHTTP rejeita dois `WinHttpWebSocketSend` simultâneos (`ERROR_INVALID_OPERATION`), e a thread de captura (MMCSS "Pro Audio") ficava presa na rede | **Single writer**: só uma thread escreve no socket. A captura apenas enfileira (lock de poucos microssegundos, nunca durante I/O). Áudio e Finalize compartilham a mesma fila FIFO, então a ordem é garantida |
| Final da fala demorava ou não vinha | Com o VAD cortando o silêncio, o Deepgram não "ouve" o fim da fala | `Finalize` ao fechar o turno, ordenado depois do áudio daquele turno |
| Queda de rede encerrava a lane | Não havia reconexão | Reconexão com backoff exponencial + jitter, replay do áudio retido (até 20 s, descarta o mais antigo), watchdog para conexão "muda" e erro fatal (401/402/403) sem loop infinito |
| VAD Silero v5 praticamente nunca abria | O adapter enviava 512 amostras; o v5 exige 64 amostras de contexto + 512 | Contexto implementado como no exemplo C++ oficial. Medido com fala sintetizada: probabilidade média na fala foi de 0,001 para 0,877 (gate aberto em 98% das janelas de fala) |
| Pergunta "reescrita" pelo LLM | O modelo parafraseava a pergunta ("Have you worked for Microsoft?" virava "Why do you want to work for Microsoft?") | A pergunta mostrada no HUD vem literal da transcrição; o prompt cita a fala e proíbe reformular ou inventar fatos |

Também entram neste slice: captura WASAPI com COM na própria thread, recuperação
quando o dispositivo é removido e troca automática quando o dispositivo padrão muda;
pre-roll de 256 ms (não corta a primeira sílaba); pausa de privacidade; log de console
assíncrono (clicar no console não congela mais nenhuma thread).

### Respostas STAR, RAG e latência (out/2026)

| Tema | Antes | Agora |
|---|---|---|
| Formato | Tese + parágrafos/bullets livres | **STAR natural**: a resposta começa com a linha `PERGUNTA:` (a pergunta como o modelo entendeu, vira o título do card) e depois um texto corrido de 80 a 150 palavras em primeira pessoa, sem rótulos: tese direta, história real (contexto, o que eu fiz, resultado) e fechamento ligado à pergunta. Sem caso real no contexto, a resposta se declara hipotética |
| Invenção de dados | Só instrução no prompt; o prompt tinha fatos fixos de um perfil (TechFinance, Midea, Tako) | Prompt genérico, os nomes dos projetos vêm dos documentos do agente. Pós-checagem local: número da resposta que não aparece no contexto nem na conversa gera o aviso "Confira antes de falar" |
| RAG | BM25 sem stemming, histórico colado na consulta, completava o orçamento com **todos** os outros chunks | Stemming leve PT/EN (projeto/project, implementei/implemented), sinônimos PT-EN, pergunta com peso 1 e falas anteriores de [Outros] com peso 0,3, corte relativo (30% do melhor), parágrafo seguinte da mesma história, e pergunta comportamental sem match recebe uma história real dos arquivos. 0,11 ms por consulta em 318 chunks (antes 0,38 ms) |
| Prompt | Até ~29 mil caracteres, tudo na mensagem do usuário | Regras + perfil da sessão no **system** (prefixo idêntico entre perguntas, aproveita cache de prompt do provedor); só trechos recuperados + histórico curto (3,5 mil) + 4 respostas anteriores no user |
| Especulação | Dois caminhos; o legado mexia no estado da especulação a partir da thread do LLM (corrida documentada nos testes); resposta que terminava escondida nunca fechava o card e travava novas especulações; commit aos 120 ms de silêncio mostrava resposta para meia pergunta; fala do candidato no microfone cancelava a resposta visível | Um caminho só, todo no orquestrador. Commit antecipado só quando a pergunta terminou ("?"); se a pergunta cresceu com uma nova parte ("...e qual foi o desafio?"), a especulação reinicia ou a resposta é refeita com a pergunta inteira |
| Pergunta quebrada em duas falas | Respondia só a primeira metade (a segunda caía no cooldown) | A segunda metade, em até 2,5 s e sem ninguém falar no meio, refaz a resposta com a pergunta completa |
| Conexão LLM | Sem keep-alive no modo OpenRouter (a primeira pergunta depois de um silêncio pagava TLS) | Ping leve a cada 25 s e `provider.sort = latency` no OpenRouter |
| Transcrição | `smart_format` podia segurar o final até ~3 s esperando um número; endpointing 300 | `no_delay=true`, endpointing 100 com `multi`, `language_hint=pt,en`, keyterms melhores (nomes próprios, siglas, termos técnicos por frequência). Se o Deepgram recusar um parâmetro opcional (HTTP 400), reconecta sem ele |
| Fixar card enquanto você fala | Código existia mas nunca era alimentado | Ligado ao VAD Silero do microfone |
| Medição | 1º token do modelo | Também `visible_ms`: tempo entre a pergunta fechar e o primeiro texto no HUD (console, `.jsonl`, `.md`, `--server`) |

Sobre "menos de 200 ms": o tempo até o primeiro token depende do provedor. O que o app controla
agora roda em menos de 1 ms (RAG + montagem do prompt) e a geração começa durante a pausa da pergunta;
quando ela já gerou texto até a pergunta fechar, o texto aparece no mesmo frame (`visible_ms = 0`).
Para ficar abaixo de 200 ms de forma consistente, use um provedor rápido (Cerebras/Groq em
`cerebras_api_key`/`groq_api_key`) e acompanhe `visible_ms` nas sessões.

### Interpretação da transcrição (out/2026)

- **Pergunta reconstruída**: o prompt recebe as falas recentes do entrevistador separadas e instruções para juntar
  pedaços picados pelo STT, aplicar correções ("não é a questão da cultura") e ignorar conversa paralela
  ("espera aí, amor"). O modelo escreve `PERGUNTA: ...` na primeira linha; o HUD mostra isso como título do card e
  tira a linha do corpo. O texto bruto continua salvo como `trigger` na sessão; o entendido vai em `understood`.
- **Atalho Answer (Ctrl+Alt+Enter)**: antes pegava só o último turno de [Outros]. Agora junta os turnos dele ditos
  com menos de 6 s de intervalo (até 4), pulando "uhum" curtos do microfone, mais o que ainda está sendo falado.
