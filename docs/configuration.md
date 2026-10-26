# Configuração e uso

## Linha de comando

- `scripts\windows\run-demo.bat`: sem microfone, sem rede e sem chaves. Abre o HUD com uma conversa de
  vendas roteirizada dos dois lados (objeção de preço, pergunta de prazo), sugestões em
  streaming, e as ações de chat/tela/resumo respondidas por um LLM local de demonstração.
- `scripts\windows\run-live.bat`: captura real. Sem a chave do Deepgram o app abre o `config.ini` no
  Bloco de Notas e encerra; com a chave do OpenRouter as sugestões ficam ativas.
- `rtai_app.exe --config`: abre (e cria, se não existir) o `config.ini` e sai.
- `rtai_app.exe --config-file C:\caminho\outro.ini`: usa outro arquivo de configuração
  (também via variável `RTAI_CONFIG`).
- `rtai_app.exe --console`: sem overlay, tudo impresso no console (vale para `--demo`).
- `rtai_app.exe --no-save`: não grava a sessão.
- `rtai_app.exe --server`: motor sem HUD, para clientes externos (outra UI, automação,
  testes): eventos em JSON por linha no stdout e comandos no stdin
  (`src/core/include/rtai/server_protocol.hpp`). Opcional; o HUD nativo é a interface
  principal.

Aberto direto (duplo clique ou `start`), o app esconde a própria janela de console; o log
vai para `%LOCALAPPDATA%\RealTimeAI\logs\rtai.log`.

Use fone de ouvido: sem ele, o microfone também capta a voz dos outros saindo do alto-falante.

## config.ini

Tudo fica em `%LOCALAPPDATA%\RealTimeAI\config.ini`, criado na primeira execução com todas
as opções comentadas. Abra com `rtai_app.exe --config` ou Ctrl+Alt+O com o app rodando
(mudanças valem ao reabrir o app).

Chaves de API: cole em texto puro em `[deepgram] api_key` e `[llm] api_key`. Na próxima
execução o app troca o valor por `dpapi:...` (criptografado com DPAPI para o seu usuário
do Windows; outra conta ou outro PC não consegue ler). Para trocar a chave, basta colar a
nova por cima. Se já existirem as variáveis `DEEPGRAM_API_KEY`/`OPENROUTER_API_KEY` quando o
arquivo é criado, elas são importadas já criptografadas.

Precedência: `config.ini` > variável de ambiente > padrão. Valor vazio no arquivo = usa a
variável/padrão.

| Seção / chave | Padrão | Variável equivalente | Uso |
|---|---|---|---|
| `[deepgram] api_key` | (obrigatória ao vivo) | `DEEPGRAM_API_KEY` | Chave do Deepgram |
| `[deepgram] idioma` | `multi` | `RTAI_DG_LANGUAGE` | `multi` (pt + en no mesmo fluxo), `pt-BR`, `en`... |
| `[deepgram] termos` | | `RTAI_DG_KEYTERMS` | Termos para reforçar no STT, separados por vírgula |
| `[deepgram] endpointing_ms` | `100` | | Silêncio que fecha uma frase (com `multi`, o antigo 300 vira 100) |
| `[deepgram] dicas_idioma` | `pt, en` | `RTAI_DG_LANGUAGE_HINTS` | Só com `multi`: idiomas mais prováveis (`nenhuma` desliga) |
| `[turn] boundary_grace_ms` / `stale_ms` / `speculative_pause_ms` | padrão do motor | | Ajuste fino do fechamento de turno |
| `[llm] api_key` | (vazia: sem sugestões) | `OPENROUTER_API_KEY` | Chave do OpenRouter (ou do endpoint em `url`) |
| `[llm] url` | OpenRouter | `RTAI_LLM_URL` | Outro endpoint compatível com OpenAI (OpenAI, Ollama, LM Studio) |
| `[llm] modelo` | `google/gemini-3.1-flash-lite` | `RTAI_LLM_MODEL` | Qualquer modelo do OpenRouter |
| `[llm] raciocinio` | `minimal` | `RTAI_LLM_REASONING` | Esforço de raciocínio; `off` omite o parâmetro |
| `[llm] max_tokens` / `temperatura` | `450` / `0.3` | | Tamanho e variação da sugestão |
| `[llm] sugestao_automatica` | `sim` | `RTAI_AUTO_SUGGEST` | `nao` = só sugere com Ctrl+Alt+Enter |
| `[llm] palavras_chave` | lista de vendas | `RTAI_KEYWORDS` | Palavras que disparam sugestão, separadas por vírgula |
| `[llm] intervalo_minimo_s` | `4` | | Tempo mínimo entre sugestões automáticas |
| `[llm] arquivo_contexto` | | `RTAI_CONTEXT_FILE` | Notas enviadas como contexto (veja `examples/contexto-exemplo.md`) |
| `[audio] microfone` / `audio_sistema` | `sim` / `sim` | | Liga/desliga cada fonte |
| `[audio] vad` | `silero` | | `silero` ou `energia` (sem o modelo, cai para energia) |
| `[audio] silero_modelo` | `silero_vad.onnx` ao lado do exe | `RTAI_SILERO_MODEL` | Modelo Silero (build com ONNX) |
| `[audio] limiar_energia` | `0.01` | | Sensibilidade do VAD por energia |
| `[overlay] largura` / `altura_max_pct` | `560` / `60` | | Tamanho do overlay |
| `[sessao] salvar` / `pasta` | `sim` / `%LOCALAPPDATA%\RealTimeAI\sessions` | `RTAI_SESSION_DIR` | Gravação das sessões |

Só por variável: `RTAI_DEMO_WAV` (WAV para o modo demo) e `RTAI_CONFIG` (caminho do config).

## Atalhos globais

| Atalho | Ação |
|---|---|
| Ctrl+Alt+Enter | Responder agora (usa a fala de "Outros" em andamento, mesmo antes do final) |
| Ctrl+Alt+S | Capturar a tela e pedir uma análise (o texto do chat, se houver, vai junto) |
| Ctrl+Alt+K | Abrir o chat (Enter envia, Esc fecha) |
| Ctrl+Alt+Seta esquerda / direita | Navegar no histórico de respostas |
| Ctrl+Alt+R | Resumo da conversa |
| Ctrl+Alt+P | Pausar / retomar a captura (nada sai para a rede pausado) |
| Ctrl+Alt+Backspace | Limpar as respostas e o fio do chat |
| Ctrl+Alt+Shift+Backspace | Limpar a faixa de transcrição |
| Ctrl+Alt+H | Esconder / mostrar o HUD |
| Ctrl+Alt+T | Clique atravessa o HUD (liga/desliga) |
| Ctrl+Alt+O | Abrir o `config.ini` |
| Ctrl+Alt+Q | Encerrar salvando a sessão |

Os atalhos usam Ctrl+Alt para não colidir com Ctrl+Enter de apps de chat. Se algum já
estiver ocupado por outro app, o HUD avisa qual.
