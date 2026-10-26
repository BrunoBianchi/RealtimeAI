# Testes de integração locais

Exercitam os adapters WinHTTP reais (WebSocket do Deepgram e streaming do OpenRouter)
contra servidores falsos rodando na sua máquina. Não precisam de chave nem de internet.

Pré-requisito: Python 3 com `pip install websockets`.

## KeepAlive, reconexão e Finalize (Deepgram)

O servidor falso se comporta como o Deepgram: fecha com `1011 NET-0001` depois de 10 s
sem áudio nem KeepAlive. O segundo argumento derruba a primeira conexão (TCP abort)
depois de N segundos, para testar a reconexão.

```powershell
python tests\integration\fake_deepgram.py 8765 18 stats.json
build\bin\Release\stream_itest.exe keepalive 8765 25
```

Esperado: 25 s de silêncio sem nenhum NET-0001, KeepAlive a cada 3 s, reconexão logo
após a queda simulada, transcrição do áudio depois do silêncio e `CloseStream` no fim.

Para ver o comportamento antigo (sem KeepAlive), rode o cliente com `nokeepalive`
contra um servidor sem queda (`python ... 8766 0`): o servidor fecha a conexão a cada
10 s de silêncio e o stream precisa reconectar.

## Streaming do LLM (OpenRouter)

```powershell
python tests\integration\fake_openrouter.py 8780
build\bin\Release\llm_itest.exe 8780
```

Cobre: tokens chegando um a um, eventos SSE quebrados entre pacotes, erro 401, erro no
meio do stream, cancelamento e validação da chave no warm-up. Sai com código 0 se tudo
passar.
