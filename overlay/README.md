# RealTimeAI — Overlay HUD (Nativo C++20 / Direct2D / WASAPI)

Esta pasta contém exclusivamente o **Overlay HUD transparente de baixa latência** do RealTimeAI, separado do aplicativo de Dashboard (`../dashboard`).

## Sincronização Automática com o Dashboard
Tudo o que você configurar no **Dashboard Electron (`../dashboard`)** — incluindo:
- **Mini-Agente ativo** (`--agent <id>` ou `[sessao] ultimo_agente` no `%LOCALAPPDATA%\RealTimeAI\config.ini`)
- **Arquivos enviados para o RAG** (Currículo, Vaga, Projetos, Código)
- **Leitura Aprofundada (Mini-Compact sempre no prompt)**
- **Dossiê da Empresa & Instruções STAR / Fit Cultural**
- **Chaves de API, Modelo LLM, Idioma e Dimensões do HUD**

é carregado automaticamente pelo `rtai_overlay.exe` / `rtai_app.exe` ao iniciar a sessão!

## Como executar
- **Pelo Dashboard (Recomendado)**: Clique em **"Iniciar Sessão (Abrir Overlay)"** ou **"Testar em Modo Demo"** dentro do app em `../dashboard`.
- **Diretamente**:
  - `iniciar-overlay-aovivo.bat` (modo ao vivo com captura WASAPI + Deepgram + LLM)
  - `iniciar-overlay-demo.bat` (modo demonstração com conversa simulada)
  - `rtai_overlay.exe --agent <id_do_agente>` (inicia com um Mini-Agente específico)

