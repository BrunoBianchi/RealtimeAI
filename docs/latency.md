# Latência

Meta do produto: o texto da resposta aparece no HUD em menos de 200 ms depois que a pergunta
termina. Este documento mostra para onde vai cada milissegundo, o que o app faz para reduzir cada
etapa e como medir.

## Orçamento ponta a ponta

```
fala termina ─► VAD local ─► Deepgram final ─► turno fecha ─► RAG + prompt ─► 1º token ─► HUD
               (32 ms/janela)  (endpointing     (grace /       (< 1 ms)       (provedor)   (mesmo frame
                               100 ms)          especulação)                               ou <= 16 ms)
```

| Etapa | Quem controla | Como fica baixa |
|---|---|---|
| Captura + resample + VAD | app | WASAPI com MMCSS "Pro Audio", resampler sem alocação, VAD em janelas de 512 amostras (32 ms) e pre-roll de 256 ms |
| Envio ao Deepgram | app | fila de saída single-writer, envio sem bloquear a thread de captura, `Finalize` ao fechar o turno |
| Transcrição final | Deepgram | `no_delay=true`, endpointing 100 ms com `multi`, keyterms |
| Fechamento do turno | app | engine acordada no **deadline exato** de cada turno (ver abaixo) |
| Geração | provedor | especulação durante a pausa da pergunta: a resposta já está sendo gerada quando a pergunta fecha |
| Conexão HTTP | app | HTTP/2 com conexão quente (warm-up na abertura, PING HTTP/2 e ping leve a cada 25 s), TCP Fast Open, TLS False Start, IPv6 fast fallback |
| RAG + prompt | app | BM25 em ~0,1 ms; embeddings com orçamento de 12 ms e cache por pergunta; prefixo de prompt estável para o cache do provedor |
| Pintura no HUD | app | o primeiro delta de uma geração pinta na hora; os seguintes são agrupados em no máximo 1 frame a cada 16 ms |

O que depende só do app roda em poucos milissegundos. O que sobra é rede e provedor, por isso o
`visible_ms` (tempo entre a pergunta fechar e o primeiro texto no HUD) é a métrica que importa.

## Otimizações desta versão

### Engine acordada por deadline

Antes, o orquestrador (`CopilotEngine::run`) só verificava os prazos (fechamento de turno por
*grace*/*stale*, especulação com interim estável, commit de fallback, pergunta segurada, fila do
Pin on Speak) a cada *tick* de 20 ms. Um turno fechava até um tick inteiro depois do prazo.

Agora `TurnAssembler::next_deadline_ms()` e `CopilotEngine::Impl::next_deadline_ms()` calculam o
próximo prazo e a thread dorme exatamente até ele. Prazos que já foram verificados e continuam no
passado (por exemplo, uma sugestão na fila enquanto o usuário fala) são ignorados até o próximo tick,
então o loop nunca entra em espera ativa. O teste `EngineDeadline.TurnClosesAtGraceNotAtNextTick`
fecha um turno com grace de 60 ms em ~62 ms mesmo com tick de 2 s.

O inbox do orquestrador também deixou de alocar a cada evento: dois `std::vector` trocados por
`swap` mantêm a capacidade.

### Processo em modo tempo real no Windows

`src/app/include/rtai/low_latency_win.hpp`, aplicado no início do `main`:

- `timeBeginPeriod(1)`: o timer padrão do Windows anda em passos de 15,6 ms. Sem isso, uma espera
  de 20 ms dura ~31 ms e o orçamento de 12 ms dos embeddings vira ~16 ms. Desde o Windows 10 2004 a
  resolução vale só para o processo que pediu.
- Opt-out de EcoQoS (`ProcessPowerThrottling`): o Windows 11 joga processos sem janela em primeiro
  plano para os núcleos de eficiência e pode ignorar o pedido de resolução de timer. O overlay é
  exatamente esse processo (o usuário está olhando o app da reunião).

### Rede

`win::enable_low_latency()` (`src/net/include/rtai/winhttp_util.hpp`) liga, em toda sessão WinHTTP
(LLM e WebSocket do Deepgram):

- **IPv6 fast fallback** (Happy Eyeballs): uma rota IPv6 quebrada não segura o connect;
- **TCP Fast Open** e **TLS False Start**: um round trip a menos em conexão fria (primeira pergunta,
  reconexão depois de troca de rede);
- **PING HTTP/2** no cliente do LLM: a conexão do pool fica aberta entre as perguntas sem requisição.

O keep-alive do cliente LLM agora também aquece o provedor direto (Cerebras) **na abertura** e o
provedor de fallback, para que nem a primeira pergunta nem um failover paguem DNS + TCP + TLS
(100 a 300 ms). Com OpenRouter, o `warm_up` passou a valer para qualquer configuração que mande as
respostas para o openrouter.ai. Um fallback sem chave não é mais tentado (era um round trip perdido
antes de mostrar o erro).

### Build

- LTO (MSVC `/GL` + `/LTCG`, GCC/Clang `-flto`) em Release, `/Ob3`, `/Gy /Gw` e `/OPT:REF,ICF`: o
  caminho quente atravessa bibliotecas (core, net, app) e passa a ser inlinado entre elas.
- `/arch:AVX2` virou opção (`RTAI_ENABLE_AVX2`, desligada): ligada no build global, o executável
  travava com instrução ilegal em CPUs sem AVX2, e o código não tem kernels AVX2 explícitos.

### Dashboard

- O tema do Windows era lido com `reg query` síncrono a cada consulta; agora é lido uma vez e só
  de novo quando o Windows avisa que o tema mudou.
- `isOverlayRunning()` rodava `tasklist` síncrono (e o filtro duplo nunca encontrava nada). Agora
  o processo próprio é a fonte principal e a checagem externa roda em segundo plano, com cache.
- Parar o overlay usa um único `taskkill` para os dois nomes de executável (antes eram dois
  processos em sequência no caminho de iniciar uma sessão).
- Cache de compilação do Node (`module.enableCompileCache`) para abrir o dashboard mais rápido.

## Como medir

- Console e `.md` da sessão: `1st token`, `total` e `visible_ms` de cada resposta.
- `--server`: os mesmos campos no evento `answer_done`.
- Dashboard: a lista de sessões mostra a latência média do primeiro token.
- Para ficar abaixo de 200 ms de forma consistente, use um provedor rápido (Cerebras/Groq em
  `cerebras_api_key`/`groq_api_key`) e acompanhe o `visible_ms`.
