// Cue dashboard — settings. Every control reads and writes config.ini (via
// saveConfig) or a dedicated main-process API (stealth, calendar, updates,
// flags, meeting detection). The overlay restarts itself when needed.
'use strict';

(function () {
  const C = window.Cue;
  const S = C.state;
  const api = window.rtai;
  const { esc, icon, fixText, plural } = C;

  const TABS = [
    ['general', 'Geral', 'gear'],
    ['ai', 'IA e modelos', 'cpu'],
    ['audio', 'Áudio e transcrição', 'microphone'],
    ['privacy', 'Privacidade', 'shield-check'],
    ['overlay', 'Painel flutuante', 'monitor'],
    ['calendar', 'Calendário', 'calendar'],
    ['shortcuts', 'Atalhos', 'keyboard'],
    ['plan', 'Plano e uso', 'credit-card'],
    ['updates', 'Atualizações', 'download']
  ];

  const MODELS = [
    { tier: 'fast', id: 'qwen/qwen3.6-flash', title: 'Rápido', model: 'Qwen 3.6 Flash', desc: 'Menor latência; ideal para conversa contínua.' },
    { tier: 'medium', id: 'meta-llama/llama-3.3-70b-instruct', title: 'Equilibrado', model: 'Llama 3.3 70B', desc: 'Respostas mais elaboradas, ainda rápidas.' },
    { tier: 'ultra', id: 'openai/gpt-oss-120b', alt: 'gpt-oss-120b', title: 'Ultra', model: 'GPT-OSS 120B', desc: 'Raciocínio técnico mais forte (system design, código).' }
  ];

  const KEYS = [
    ['deepgram_key', 'Deepgram', 'has_deepgram_key', 'deepgram_key_display', 'Transcrição de voz (obrigatória)', 'https://console.deepgram.com/'],
    ['llm_key', 'OpenRouter', 'has_llm_key', 'llm_key_display', 'Acesso a Qwen, Llama, GPT-OSS e outros', 'https://openrouter.ai/keys'],
    ['cerebras_key', 'Cerebras', 'has_cerebras_key', 'cerebras_key_display', 'Inferência ultrarrápida para modelos sem "/"', 'https://cloud.cerebras.ai/'],
    ['groq_key', 'Groq', 'has_groq_key', 'groq_key_display', 'Inferência rápida alternativa', 'https://console.groq.com/keys'],
    ['openai_key', 'OpenAI', 'has_openai_key', 'openai_key_display', 'Modelos GPT', 'https://platform.openai.com/api-keys'],
    ['anthropic_key', 'Anthropic', 'has_anthropic_key', 'anthropic_key_display', 'Modelos Claude', 'https://console.anthropic.com/'],
    ['gemini_key', 'Google Gemini', 'has_gemini_key', 'gemini_key_display', 'Modelos Gemini', 'https://aistudio.google.com/app/apikey']
  ];

  const LANGS = [['pt-BR', 'Português (Brasil)'], ['en-US', 'Inglês (EUA)'], ['es', 'Espanhol'], ['multi', 'Detectar automaticamente']];

  function row(title, sub, control, opts) {
    return `<div class="set-row ${opts && opts.stacked ? 'stacked' : ''}"><div class="txt"><span class="t">${title}</span>${sub ? `<span class="s">${sub}</span>` : ''}</div><div class="ctl">${control}</div></div>`;
  }

  function cfgSwitch(key, label, value) {
    return C.sw(`data-change="cfg" data-key="${key}" data-type="bool" data-label="${esc(label)}" aria-label="${esc(label)}"`, value);
  }

  function cfgSelect(key, label, list, value) {
    return `<select class="select sm" data-change="cfg" data-key="${key}" data-type="text" data-label="${esc(label)}">${C.opts(list, value)}</select>`;
  }

  function cfgNumber(key, label, value, min, max, step, type) {
    return `<input class="input sm" style="width:110px;text-align:right" type="number" value="${esc(value)}" min="${min}" max="${max}" step="${step || 1}" data-change="cfg" data-key="${key}" data-type="${type || 'int'}" data-min="${min}" data-max="${max}" data-label="${esc(label)}"/>`;
  }

  function cfgText(key, label, value, placeholder, width) {
    return `<input class="input sm" style="width:${width || 260}px" type="text" value="${esc(value)}" placeholder="${esc(placeholder || '')}" data-change="cfg" data-key="${key}" data-type="text" data-label="${esc(label)}"/>`;
  }

  function card(title, sub, body, right) {
    return `<section class="card"><div class="card-head"><div class="stack" style="gap:0"><span class="t">${title}</span>${sub ? `<span class="s">${sub}</span>` : ''}</div>${right || ''}</div><div>${body}</div></section>`;
  }

  // ----------------------------------------------------------- sections --
  function general() {
    const p = S.profile || {};
    const pref = (S.themeState && S.themeState.preference) || 'dark';
    const m = S.meeting;
    const cfg = S.config;
    let meetingStatus = 'Carregando…';
    if (m) {
      const active = Array.isArray(m.active) ? m.active : [];
      if (!m.supported) meetingStatus = 'Disponível só no Windows.';
      else if (!m.enabled) meetingStatus = 'Desligada: nenhum aviso quando uma reunião começa.';
      else if (active.length) meetingStatus = `Em chamada agora: ${active.map((x) => x.name).join(', ')}.`;
      else meetingStatus = 'Observando Meet, Teams, Zoom, Discord, Slack e outros.';
    }
    const muted = m && Array.isArray(m.mutedApps) ? m.mutedApps.map((id) => (m.appNames && m.appNames[id]) || id) : [];
    return `
      ${card('Perfil', 'Usado na saudação e pelo copiloto para falar em primeira pessoa',
        `<div class="row" style="gap:14px"><span class="avatar" style="width:40px;height:40px;font-size:13px">${esc(C.monogram(p.name || 'Você'))}</span><div class="stack grow" style="gap:0"><span class="strong">${esc(fixText(p.name || 'Sem nome'))}</span><span class="small faint">${esc(fixText([p.headline, p.seniority].filter(Boolean).join(' · ') || 'Cargo não informado'))}</span><span class="small faint">${esc(p.email || '')}</span></div><button type="button" class="btn" data-action="open-profile">${icon('pencil')}Editar perfil</button></div>`)}
      ${card('Aparência', '',
        `<div class="option-cards">${[['dark', 'Escuro', 'moon'], ['light', 'Claro', 'sun'], ['system', 'Sistema', 'monitor']]
          .map(([v, l, ic]) => `<button type="button" class="option-card ${pref === v ? 'active' : ''}" aria-pressed="${pref === v}" data-action="set-theme" data-theme="${v}"><span class="t">${icon(ic)}${l}</span><span class="s">${v === 'system' ? 'Segue o Windows' : `Tema ${l.toLowerCase()}`}</span></button>`)
          .join('')}</div>`)}
      ${card('Detecção de reuniões', esc(meetingStatus),
        `${row('Avisar quando uma reunião começar', 'Um popup oferece iniciar o copiloto com a sessão certa.', m ? C.sw('data-change="meeting" data-field="enabled"', m.enabled, !m.supported) : '')}
         ${row('Manter na bandeja ao fechar', 'O Cue continua observando reuniões com a janela fechada.', m ? C.sw('data-change="meeting" data-field="keepInTray"', m.keepInTray, !m.enabled) : '')}
         ${muted.length ? row('Apps silenciados', esc(muted.join(', ')), '<button type="button" class="btn sm" data-action="meeting-unmute">Reativar todos</button>') : ''}
         ${row('Testar o aviso', 'Mostra o popup como se uma reunião tivesse começado.', '<button type="button" class="btn sm" data-action="meeting-test">Mostrar popup</button>')}`)}
      ${card('Dados locais', 'Tudo fica nesta máquina: sessões, arquivos e configurações',
        `${row('Gravar sessões', 'Salva transcrição e respostas em Markdown e JSONL ao encerrar.', cfgSwitch('save_sessions', 'Gravar sessões', cfg.save_sessions !== false))}
         ${row('Pasta de dados', `<span class="mono" style="font-size:11px">${esc((cfg.configPath || '').replace(/[\\/][^\\/]+$/, '') || '%LOCALAPPDATA%\\RealTimeAI')}</span>`, '<button type="button" class="btn sm" data-action="open-path">Abrir pasta</button>')}`)}`;
  }

  function ai() {
    const cfg = S.config;
    const cur = cfg.model || 'qwen/qwen3.6-flash';
    const known = MODELS.some((m) => m.id === cur || m.alt === cur);
    return `
      ${card('Modelo de resposta', `Atual: ${esc(C.modelLabel(cur))} via ${esc(C.providerFor(cur))}`,
        `<div class="option-cards">${MODELS.map((m) => {
          const active = cur === m.id || cur === m.alt;
          return `<button type="button" class="option-card ${active ? 'active' : ''}" aria-pressed="${active}" data-action="set-model" data-tier="${m.tier}"><span class="t">${active ? '<span class="dot"></span>' : ''}${m.title}<span class="num" style="margin-left:auto">${m.model}</span></span><span class="s">${m.desc}</span></button>`;
        }).join('')}</div>
        <div class="set-row" style="margin-top:14px;border-top:1px solid var(--border-subtle);padding-top:14px"><div class="txt"><span class="t">ID do modelo</span><span class="s">Qualquer modelo do OpenRouter (provedor/modelo) ou do Cerebras (sem "/").${known ? '' : ' Personalizado.'}</span></div><div class="ctl">${cfgText('model', 'Modelo', cur, 'qwen/qwen3.6-flash', 280)}</div></div>`)}
      ${card('Comportamento', '',
        `${row('Sugerir respostas automaticamente', 'Responde assim que detecta uma pergunta. Desligado, só com Ctrl+Alt+Enter.', cfgSwitch('auto_suggest', 'Sugestão automática', cfg.auto_suggest !== false))}
         ${row('Intervalo mínimo entre respostas', 'Segundos entre duas sugestões automáticas.', cfgNumber('cooldown_s', 'Intervalo', cfg.cooldown_s ?? 8, 2, 60))}
         ${row('Idioma das respostas', 'O idioma em que o copiloto escreve.', cfgSelect('ai_response_language', 'Idioma das respostas', [['auto', 'Igual ao da conversa'], ['pt-BR', 'Português'], ['en-US', 'Inglês'], ['es', 'Espanhol']], cfg.ai_response_language || 'auto'))}
         ${row('Modo de resposta rápida', 'Respostas mais curtas e diretas, com menos espera.', cfgSwitch('fast_response_mode', 'Resposta rápida', cfg.fast_response_mode))}
         ${row('Assistente direto (beta)', 'Responde também a pedidos diretos, não só perguntas de entrevista.', cfgSwitch('direct_assist', 'Assistente direto', cfg.direct_assist))}
         ${row('Modelo de segundo plano', 'Usado para resumos e tarefas que não estão na conversa.', cfgSelect('background_model', 'Modelo de segundo plano', [['auto', 'Automático'], ...MODELS.map((m) => [m.id, m.model])], cfg.background_model || 'auto'))}
         ${row('Raciocínio', 'Mais raciocínio melhora respostas difíceis, mas aumenta a latência.', cfgSelect('reasoning', 'Raciocínio', [['none', 'Desligado'], ['low', 'Baixo'], ['medium', 'Médio'], ['high', 'Alto']], cfg.reasoning || 'none'))}
         ${row('Máximo de tokens', 'Tamanho máximo de cada resposta.', cfgNumber('max_tokens', 'Máximo de tokens', cfg.max_tokens ?? 1500, 1500, 8000, 100))}
         ${row('Temperatura', '0 = mais previsível, 1 = mais criativo.', cfgNumber('temperature', 'Temperatura', cfg.temperature ?? 0.3, 0, 1.5, 0.05, 'float'))}
         ${row('Palavras-chave de gatilho', 'Termos que disparam uma resposta (separados por vírgula).', cfgText('keywords', 'Palavras-chave', cfg.keywords || '', 'ex.: arquitetura, kafka'))}`)}
      ${card('Chaves de API', 'Guardadas no config.ini e criptografadas pelo Windows (DPAPI) na primeira execução',
        KEYS.map(([key, name, has, display, sub, url]) => {
          const ok = Boolean(cfg[has]);
          return `<div class="set-row"><div class="txt"><span class="t row" style="gap:8px">${esc(name)}<span class="key-status" style="color:${ok ? 'var(--accent)' : 'var(--text-tertiary)'}">${ok ? '● conectada' : '○ não definida'}</span></span><span class="s">${esc(sub)} · <a data-action="open-url" data-url="${esc(url)}">obter chave</a></span></div>
            <div class="ctl"><input class="input sm" style="width:240px" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(ok ? cfg[display] || '••••••••' : 'Cole a chave')}" data-key-input="${key}" data-label="${esc(name)}"/>${ok ? `<button type="button" class="icon-btn danger" title="Remover chave" data-action="clear-key" data-key="${key}" data-label="${esc(name)}">${icon('trash')}</button>` : ''}</div></div>`;
        }).join(''))}
      ${card('Avançado', 'Endpoints personalizados e modelos locais',
        `${row('URL da API de chat', 'Compatível com OpenAI (chat/completions).', cfgText('llm_url', 'URL da API', cfg.llm_url || '', 'https://openrouter.ai/api/v1/chat/completions', 300))}
         ${row('Endpoint local', 'Ollama, LM Studio ou outro servidor local.', cfgText('local_endpoint', 'Endpoint local', cfg.local_endpoint || '', 'http://localhost:11434'))}
         ${row('Modelo local', '', cfgText('local_model', 'Modelo local', cfg.local_model || '', 'llama3', 180))}`)}`;
  }

  function audio() {
    const cfg = S.config;
    const devs = S.ui.audioDevices || { inputs: [], outputs: [] };
    const inOpts = [['default', 'Padrão do sistema'], ...devs.inputs.map((d) => [d.deviceId, d.label])];
    const outOpts = [['default', 'Padrão do sistema (loopback)'], ...devs.outputs.map((d) => [d.deviceId, d.label])];
    const vu = Array.from({ length: 24 }, () => '<span></span>').join('');
    return `
      ${card('Captura', 'Você = microfone · Entrevistador = áudio do sistema',
        `${row('Microfone (você)', 'Transcreve sua voz para o copiloto acompanhar suas respostas.', cfgSwitch('mic_enabled', 'Microfone', cfg.mic_enabled !== false))}
         ${row('Áudio do sistema (entrevistador)', 'Captura o que sai nos alto-falantes ou fones (loopback).', cfgSwitch('loopback_enabled', 'Áudio do sistema', cfg.loopback_enabled !== false))}
         ${row('Dispositivo de entrada', '', `<select class="select sm" style="width:280px" data-change="audio-device" data-kind="input">${C.opts(inOpts, cfg.audio_input_device || 'default')}</select>`)}
         <div class="set-row"><div class="txt"><span class="t">Nível do microfone</span><span class="s">Fale normalmente: as barras devem passar da metade.</span></div><div class="ctl" style="gap:10px"><div class="vu" id="micVu" style="max-width:200px">${vu}</div><span class="num" id="micDb" style="width:48px;text-align:right">-- dB</span></div></div>
         ${row('Dispositivo de saída', 'De onde vem o áudio do entrevistador.', `<select class="select sm" style="width:280px" data-change="audio-device" data-kind="output">${C.opts(outOpts, cfg.audio_output_device || 'default')}</select>`)}
         ${row('Testar saída', 'Toca um bipe curto no dispositivo padrão.', '<button type="button" class="btn sm" data-action="test-sound">' + icon('speaker') + 'Tocar som</button>')}
         ${row('Cancelamento de ruído', '', cfgSwitch('noise_cancellation', 'Cancelamento de ruído', cfg.noise_cancellation !== false))}`)}
      ${card('Transcrição', 'Provedor: Deepgram Nova-3, em streaming',
        `${row('Idioma da entrevista', 'O idioma em que o entrevistador fala.', `<select class="select sm" data-change="language">${C.opts(LANGS, cfg.language || 'pt-BR')}</select>`)}
         ${row('Fim de fala (endpointing)', 'Silêncio, em ms, que encerra uma fala. Menor = mais rápido, maior = menos cortes.', cfgNumber('endpointing_ms', 'Endpointing', cfg.endpointing_ms ?? 350, 10, 3000, 10))}
         ${row('Termos técnicos', 'Palavras que o reconhecimento deve priorizar (nomes, siglas, tecnologias).', cfgText('keyterms', 'Termos', cfg.keyterms || '', 'ex.: Kubernetes, Pix, gRPC', 300))}
         ${row('Detecção de voz', 'Silero é mais preciso; energia é mais leve.', cfgSelect('vad', 'Detecção de voz', [['silero', 'Silero (recomendado)'], ['energy', 'Energia']], cfg.vad || 'silero'))}
         ${row('Limiar de energia', 'Sensibilidade do detector por energia.', cfgNumber('energy_threshold', 'Limiar', cfg.energy_threshold ?? 0.015, 0.001, 0.2, 0.001, 'float'))}`)}`;
  }

  function privacy() {
    const cfg = S.config;
    const st = S.stealthState || {};
    const disguise = cfg.process_disguise || 'none';
    const opacity = Math.round((cfg.interface_opacity ?? cfg.electron_opacity ?? 1) * 100);
    return `
      ${card('Este painel', 'Como a janela do Cue aparece para outras pessoas',
        `${row('Ocultar de gravações e compartilhamento', 'O Windows exclui esta janela de capturas (Meet, Zoom, Teams, OBS). Atalho: Ctrl+Alt+S.', C.sw('data-change="stealth" data-field="active"', st.active))}
         ${row('Proteção de tela', 'Mantém a exclusão de captura ativa sempre que o painel estiver oculto.', C.sw('data-change="stealth" data-field="screenProtection"', st.screenProtection ?? cfg.electron_screen_protection))}
         ${row('Esconder da barra de tarefas e Alt+Tab', 'Acesse pela bandeja ou por Ctrl+Shift+H.', C.sw('data-change="stealth" data-field="skipTaskbar"', st.skipTaskbar ?? cfg.electron_skip_taskbar))}
         ${row('Título discreto', 'Troca o título da janela por "Settings".', C.sw('data-change="stealth" data-field="disguise"', st.disguise ?? cfg.electron_disguise))}
         <div class="set-row"><div class="txt"><span class="t">Opacidade da janela</span><span class="s">Deixa o painel translúcido sobre outras janelas.</span></div><div class="ctl" style="gap:10px"><input type="range" min="40" max="100" step="5" value="${opacity}" data-input="opacity" data-change="opacity-save" style="width:180px;accent-color:var(--accent)"/><span class="num" id="opacityLabel" style="width:40px;text-align:right">${opacity}%</span></div></div>
         <div class="set-row stacked"><div class="txt"><span class="t">Nome do processo</span><span class="s">Como o Cue aparece no Gerenciador de Tarefas.</span></div>
           <div class="option-cards">${[['none', 'RealTimeAI', 'Normal'], ['settings', 'Configurações', 'Windows Settings'], ['cmd', 'Prompt de Comando', 'cmd.exe'], ['taskmgr', 'Gerenciador de Tarefas', 'Task Manager']]
             .map(([v, t, s]) => `<button type="button" class="option-card ${disguise === v ? 'active' : ''}" aria-pressed="${disguise === v}" data-action="set-disguise" data-mode="${v}" data-label="${esc(t)}"><span class="t">${esc(t)}</span><span class="s">${esc(s)}</span></button>`)
             .join('')}</div></div>`)}
      ${card('Painel flutuante (HUD)', 'O que o entrevistador não vê durante a chamada',
        `${row('Invisível em compartilhamento e gravação', 'Você vê o HUD na sua tela; a captura não.', cfgSwitch('stealth_screen_capture', 'Invisível em capturas', cfg.stealth_screen_capture !== false))}
         ${row('Fora da barra de tarefas e Alt+Tab', '', cfgSwitch('stealth_dock', 'Fora da barra de tarefas', cfg.stealth_dock !== false))}
         ${row('Discreto no Gerenciador de Tarefas', '', cfgSwitch('stealth_activity_monitor', 'Discreto no gerenciador', cfg.stealth_activity_monitor !== false))}
         ${row('Cliques atravessam o HUD', 'Clique no app por baixo. Alterne ao vivo com Ctrl+Alt+T.', cfgSwitch('stealth_click_through', 'Cliques atravessam', cfg.stealth_click_through))}`)}
      ${card('Compartilhamento', '',
        `${row('Contribuir com perguntas anonimizadas', 'Ao fim da sessão, só as perguntas do entrevistador (sem nomes nem suas respostas) alimentam o Banco de perguntas.', C.sw('data-change="share-questions"', cfg.share_anonymized_questions !== false))}`)}`;
  }

  function overlay() {
    const cfg = S.config;
    return `${card('Tamanho do HUD', 'Aplicado na próxima vez que o copiloto iniciar (ou agora, se estiver rodando)',
      `${row('Largura', 'Em pixels.', cfgNumber('overlay_width', 'Largura do HUD', cfg.overlay_width ?? 620, 360, 1400, 10))}
       ${row('Altura máxima', 'Porcentagem da altura da tela.', cfgNumber('overlay_max_height_pct', 'Altura máxima', cfg.overlay_max_height_pct ?? 92, 30, 100, 1))}`)}
      ${card('Copiloto', S.overlayStatus.running ? 'Rodando agora' : 'Parado',
        `${row('Estado', S.overlayStatus.running ? `${S.overlayStatus.mode === 'demo' ? 'Simulação' : 'Ao vivo'} desde ${C.fmtTime(new Date(S.overlayStatus.startedAt || Date.now()))}` : 'O HUD abre quando você inicia uma sessão.', S.overlayStatus.running ? '<button type="button" class="btn sm danger" data-action="stop-copilot">Encerrar</button>' : '<button type="button" class="btn sm" data-action="go" data-to="live">Ir para Ao vivo</button>')}`)}`;
  }

  function calendar() {
    const g = S.gcal;
    const st = g.status;
    const configured = Boolean(st && st.configured);
    const connected = Boolean(st && st.connected);
    let title = 'Não configurado';
    let detail = 'Carregue o arquivo de cliente OAuth (client_secret_….json) baixado do Google Cloud.';
    let dot = 'off';
    if (configured && !connected) {
      title = 'Pronto para conectar';
      detail = st.lastError || `Cliente OAuth: ${st.clientType === 'web' ? 'aplicativo web' : 'app para computador'}${st.projectId ? ` (${st.projectId})` : ''}`;
      dot = 'warn';
    } else if (connected) {
      title = 'Conectado';
      detail = st.lastError || (st.email ? `Conta: ${st.email}` : 'Conta conectada');
      dot = st.lastError ? 'warn' : '';
    }
    const events = g.events;
    const today = new Date();
    const iso = `${today.getFullYear()}-${C.pad2(today.getMonth() + 1)}-${C.pad2(today.getDate())}`;
    return `
      ${card('Google Calendar', 'Entrevistas agendadas viram eventos com lembrete',
        `<div class="row" style="gap:12px;padding-bottom:14px"><span class="dot ${dot}"></span><div class="stack grow" style="gap:0"><span class="strong">${esc(title)}</span><span class="small faint">${esc(detail)}</span></div>
          ${connected ? '' : `<button type="button" class="btn" data-action="gcal-import">${icon('upload')}${configured ? 'Trocar arquivo' : 'Carregar arquivo'}</button>`}
          ${configured && !connected ? `<button type="button" class="btn primary" data-action="gcal-connect" ${g.busy ? 'disabled' : ''}>${g.busy ? '<span class="spinner"></span>Aguardando o Google…' : 'Conectar'}</button>` : ''}
          ${connected ? '<button type="button" class="btn" data-action="gcal-disconnect">Desconectar</button>' : ''}</div>
          ${configured && !connected && st.redirectUri ? `<div class="inset"><span class="eyebrow">URI de redirecionamento</span><div class="row"><code class="mono grow truncate" style="font-size:12px">${esc(st.redirectUri)}</code><button type="button" class="btn sm" data-action="copy-text" data-text="${esc(st.redirectUri)}">${icon('copy')}Copiar</button></div><span class="xs faint">Cadastre este endereço no cliente OAuth do Google Cloud.</span></div>` : ''}
          ${connected
            ? `${row('Enviar entrevistas agendadas', 'Cria e atualiza o evento quando você agenda uma sessão.', C.sw('data-change="gcal-setting" data-field="autoSync"', st.autoSync !== false))}
               ${row('Calendário', '', `<select class="select sm" style="width:240px" data-change="gcal-setting" data-field="calendarId">${C.opts([['primary', 'Calendário principal'], ...(g.calendars || []).filter((c) => !c.primary).map((c) => [c.id, c.summary])], st.calendarId || 'primary')}</select>`)}
               ${row('Lembrete', 'Notificação do Google antes de cada evento.', `<select class="select sm" data-change="gcal-setting" data-field="reminderMin">${C.opts([['0', 'Padrão do calendário'], ['10', '10 min antes'], ['30', '30 min antes'], ['60', '1 hora antes'], ['1440', '1 dia antes']], String(st.reminderMin ?? 60))}</select>`)}`
            : ''}`)}
      ${connected
        ? card('Novo evento', '',
            `<div class="stack">
              <label class="field">Título<input class="input" id="gcalTitle" placeholder="Entrevista técnica · Empresa"/></label>
              <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr"><label class="field">Data<input class="input" type="date" id="gcalDate" value="${iso}"/></label><label class="field">Hora<input class="input" type="time" id="gcalTime"/></label><label class="field">Duração<select class="select" id="gcalDuration">${C.opts([['30', '30 min'], ['45', '45 min'], ['60', '1 hora'], ['90', '1h30'], ['120', '2 horas']], '60')}</select></label></div>
              <label class="field">Notas<textarea class="textarea" id="gcalNotes" rows="2" placeholder="Link da chamada, entrevistadores…"></textarea></label>
              <div class="row" style="justify-content:flex-end"><span class="xs faint grow">Sem horário = evento de dia inteiro.</span><button type="button" class="btn primary" data-action="gcal-create">${icon('plus')}Adicionar ao Google Calendar</button></div>
            </div>`)
        : ''}
      ${connected
        ? `<section class="card flush"><div class="row between" style="padding:14px 20px;border-bottom:1px solid var(--border-subtle)"><span class="strong">Próximos 14 dias</span><button type="button" class="btn sm" data-action="gcal-refresh">${icon('refresh')}Atualizar</button></div>
            ${events == null
              ? '<div class="empty">Carregando…</div>'
              : g.eventsError
                ? `<div class="empty">${esc(g.eventsError)}</div>`
                : events.length
                  ? events.map((ev) => `<div class="table-row" style="grid-template-columns:minmax(0,1fr) auto"><div class="stack" style="gap:0;min-width:0"><span class="truncate strong">${esc(ev.summary || '(sem título)')}${ev.goalId ? ' <span class="tag">Entrevista</span>' : ''}</span><span class="small faint truncate">${esc(gcalWhen(ev))}${ev.location ? ` · ${esc(ev.location)}` : ''}</span></div><div class="row" style="gap:4px">${ev.meet ? `<button type="button" class="btn sm" data-action="gcal-open" data-url="${esc(ev.meet)}">${icon('video')}Meet</button>` : ''}${ev.link ? `<button type="button" class="btn sm ghost" data-action="gcal-open" data-url="${esc(ev.link)}">Abrir</button>` : ''}<button type="button" class="icon-btn danger" title="Excluir" data-action="gcal-delete" data-id="${esc(ev.id)}" data-title="${esc(ev.summary || '')}">${icon('trash')}</button></div></div>`).join('')
                  : '<div class="empty">Nada nos próximos 14 dias.</div>'}
          </section>`
        : ''}`;
  }

  function gcalWhen(ev) {
    if (!ev || !ev.start) return '';
    if (ev.allDay) {
      const d = new Date(`${ev.start}T00:00:00`);
      return `${d.toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' })} · dia inteiro`;
    }
    const d = new Date(ev.start);
    if (Number.isNaN(d.getTime())) return ev.start;
    return d.toLocaleString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  const SHORTCUTS = [
    ['Durante a entrevista (HUD)', [
      [['Ctrl', 'Alt', 'Enter'], 'Responder agora'],
      [['Alt', 'Espaço'], 'Responder agora (alternativo)'],
      [['Ctrl', 'Espaço'], 'Responder agora (alternativo)'],
      [['Ctrl', 'Alt', 'S'], 'Analisar a tela (screenshot)'],
      [['Ctrl', 'Alt', 'K'], 'Abrir o chat'],
      [['Ctrl', 'Alt', 'R'], 'Resumo da conversa'],
      [['Ctrl', 'Alt', 'Tab'], 'Mostrar a próxima sugestão da fila'],
      [['Ctrl', 'Alt', '←'], 'Resposta anterior'],
      [['Ctrl', 'Alt', '→'], 'Próxima resposta'],
      [['Alt', '↑'], 'Histórico: anterior'],
      [['Alt', '↓'], 'Histórico: próximo'],
      [['Alt', '1 / 2 / 3'], 'Ações rápidas'],
      [['Ctrl', 'Alt', 'P'], 'Pausar a captura'],
      [['Ctrl', 'Alt', 'M'], 'Modo só transcrição'],
      [['Ctrl', 'Alt', 'Backspace'], 'Limpar respostas'],
      [['Ctrl', 'Alt', 'Shift', 'Backspace'], 'Limpar a faixa de transcrição'],
      [['Ctrl', 'Alt', 'T'], 'Cliques atravessam o HUD'],
      [['Ctrl', 'Alt', 'H'], 'Ocultar / mostrar o HUD'],
      [['Alt', 'H'], 'Pânico: esconder tudo'],
      [['Ctrl', 'Alt', 'O'], 'Abrir configurações'],
      [['Ctrl', 'Alt', 'Q'], 'Encerrar e salvar a sessão']
    ]],
    ['Neste painel', [
      [['Ctrl', 'K'], 'Buscar e comandos'],
      [['Ctrl', 'Alt', 'S'], 'Ocultar o painel de capturas (global)'],
      [['Ctrl', 'Shift', 'H'], 'Mostrar / esconder o painel (global)'],
      [['Esc'], 'Fechar janelas de diálogo']
    ]]
  ];

  function shortcuts() {
    return SHORTCUTS.map(([title, list]) =>
      card(esc(title), '', list.map(([keys, label]) => `<div class="shortcut-row"><span>${esc(label)}</span><span class="keys">${keys.map((k) => `<span class="kbd">${esc(k)}</span>`).join('')}</span></div>`).join(''))
    ).join('');
  }

  function plan() {
    const u = C.usage();
    const p = S.profile || {};
    const byMonth = {};
    for (const s of S.sessions) {
      const d = C.sessionDate(s);
      if (!d) continue;
      const key = `${d.getFullYear()}-${C.pad2(d.getMonth() + 1)}`;
      byMonth[key] = byMonth[key] || { sec: 0, n: 0, d };
      byMonth[key].sec += Number(s.durationSeconds) || 0;
      byMonth[key].n += 1;
    }
    const months = Object.entries(byMonth).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 6);
    const max = Math.max(1, ...months.map(([, v]) => v.sec));
    return `
      ${card('Plano atual', 'Definido no perfil local deste computador',
        `<div class="row" style="gap:16px"><span class="metric">${esc(u.planLabel)}</span><span class="muted grow">${u.limit ? `${u.limit} minutos de transcrição por mês.` : 'Sem limite mensal de transcrição.'}</span></div>
         ${u.limit ? `<div class="meter-row" style="margin-top:14px"><div class="lbl"><span>${u.usedMin} de ${u.limit} min em ${esc(u.monthLabel)}</span><span class="num">${u.left} min restantes</span></div>${C.pctBar(u.pct, u.pct > 90 ? 'danger' : u.pct > 70 ? 'warn' : '')}</div>` : ''}
         ${p.email ? `<div class="xs faint" style="margin-top:12px">Conta: ${esc(p.email)}</div>` : ''}`)}
      ${card('Uso por mês', 'Calculado a partir das sessões gravadas',
        months.length
          ? months.map(([key, v]) => `<div class="meter-row" style="padding:8px 0"><div class="lbl"><span>${esc(C.MONTHS_LONG[v.d.getMonth()])} ${v.d.getFullYear()}</span><span class="num">${Math.round(v.sec / 60)} min · ${plural(v.n, 'sessão', 'sessões')}</span></div>${C.pctBar((v.sec / max) * 100, 'thick')}</div>`).join('')
          : '<div class="empty">Nenhuma sessão gravada ainda.</div>')}`;
  }

  function updates() {
    const v = S.appVersion || {};
    const st = S.update || {};
    const cfg = S.config;
    const channel = cfg.update_channel === 'beta' ? 'beta' : 'stable';
    const latest = st.latestVersion || v.version || '';
    const msgs = {
      idle: 'Ainda não verificado.',
      checking: 'Verificando atualizações…',
      'up-to-date': `Você está na versão mais recente${channel === 'beta' ? ' (canal beta)' : ''}.`,
      available: `A versão ${latest} está disponível.`,
      downloading: `Baixando ${latest}…`,
      downloaded: `A versão ${latest} está pronta. Reinicie para concluir.`,
      error: `Não foi possível verificar: ${st.error || 'erro desconhecido'}`,
      disabled: st.error || 'Atualizações só funcionam no app instalado.'
    };
    const status = st.status || 'idle';
    const pct = st.progress ? C.clamp(Number(st.progress.percent) || 0, 0, 100) : 0;
    const flags = S.flags || { flags: {} };
    const flagList = Object.values(flags.flags || {});
    const srcLabel = { override: 'definido aqui', rollout: 'rollout', default: 'padrão', channel: 'só beta', min_version: 'requer versão nova' };
    return `
      ${card('Versão', '',
        `<div class="row" style="gap:16px;padding-bottom:14px"><span class="metric">${esc(v.version || '—')}</span><div class="stack grow" style="gap:0"><span class="muted">${esc(msgs[status] || msgs.idle)}</span>${v.packaged === false ? '<span class="xs faint">Build de desenvolvimento</span>' : ''}</div>
          ${status === 'available' ? `<button type="button" class="btn primary" data-action="update-download">${icon('download')}Baixar</button>` : ''}
          ${status === 'downloaded' ? `<button type="button" class="btn primary" data-action="update-install">${icon('refresh')}Reiniciar e atualizar</button>` : ''}
          ${!['available', 'downloaded', 'downloading'].includes(status) ? `<button type="button" class="btn" data-action="update-check" ${status === 'checking' ? 'disabled' : ''}>${status === 'checking' ? '<span class="spinner"></span>' : icon('refresh')}Verificar</button>` : ''}</div>
          ${status === 'downloading' ? `<div class="meter-row" style="padding-bottom:14px"><div class="bar thick"><span id="updateProgressBar" style="width:${pct}%"></span></div><span class="num">${pct}%</span></div>` : ''}
          ${st.releaseNotes && ['available', 'downloading', 'downloaded'].includes(status) ? `<div class="inset" style="margin-bottom:14px"><span class="eyebrow">Novidades</span><div class="md sm">${C.md(st.releaseNotes)}</div></div>` : ''}
          ${row('Canal', 'Beta recebe novidades antes, com mais risco.', `<div class="segmented">${[['stable', 'Estável'], ['beta', 'Beta']].map(([val, label]) => `<button type="button" class="${channel === val ? 'active' : ''}" data-action="update-channel" data-channel="${val}">${label}</button>`).join('')}</div>`)}
          ${row('Atualizar automaticamente', 'Baixa em segundo plano e instala ao reiniciar.', cfgSwitch('auto_update', 'Atualização automática', cfg.auto_update !== false))}`)}
      ${card('Recursos experimentais', esc(`ID da instalação ${String(flags.installId || '').slice(0, 8)} · última sincronização ${flags.lastFetch ? new Date(flags.lastFetch).toLocaleString('pt-BR') : 'nunca'}${flags.lastError ? ` · ${flags.lastError}` : ''}`),
        flagList.length
          ? flagList.map((f) => {
              const val = f.source === 'override' ? (f.enabled ? f.variant || 'on' : 'off') : 'default';
              const optsList = [['default', 'Padrão'], ['on', 'Ligado'], ['off', 'Desligado'], ...(f.variants || []).map((x) => [x, `Variante ${x}`])];
              return `<div class="flag-row"><div class="stack grow" style="gap:0;min-width:0"><span class="row" style="gap:8px"><span class="dot ${f.enabled ? '' : 'off'}"></span><code class="mono" style="font-size:12px">${esc(f.key)}</code>${f.variant ? `<span class="tag">${esc(f.variant)}</span>` : ''}</span><span class="xs faint truncate">${esc(f.description || '')}${srcLabel[f.source] ? ` · ${srcLabel[f.source]}` : ''}</span></div><select class="select sm" style="width:150px" data-change="flag" data-key="${esc(f.key)}">${C.opts(optsList, val)}</select></div>`;
            }).join('')
          : '<div class="empty" style="padding:20px">Nenhum recurso experimental definido.</div>',
        `<div class="row"><button type="button" class="btn sm" data-action="flags-refresh">${icon('refresh')}Sincronizar</button><button type="button" class="btn sm ghost" data-action="flags-reset">Restaurar padrões</button></div>`)}`;
  }

  const SECTIONS = { general, ai, audio, privacy, overlay, calendar, shortcuts, plan, updates };

  C.views.settings = function settings(parts) {
    const tab = SECTIONS[parts[0]] ? parts[0] : 'general';
    const label = (TABS.find((t) => t[0] === tab) || TABS[0])[1];
    return `<div class="page">
      ${C.head('Configurações', 'Ajustes do copiloto, da captura de áudio, da privacidade e da conta.')}
      <div class="settings-layout">
        <nav class="settings-nav">${TABS.map(([id, l, ic]) => `<button type="button" class="nav-item ${tab === id ? 'active' : ''}" data-action="go" data-to="settings/${id}">${icon(ic)}<span class="nav-label">${esc(l)}</span></button>`).join('')}</nav>
        <div class="settings-section" aria-label="${esc(label)}">${SECTIONS[tab]()}</div>
      </div>
    </div>`;
  };

  // Calendar data is fetched once per visit to the tab (or on Refresh).
  let gcalLoaded = false;
  C.afterRender.settings = (parts) => {
    const tab = parts[0] || 'general';
    if (tab === 'audio') {
      enumerateDevices();
      startMicMeter();
    } else {
      stopMicMeter();
    }
    if (tab === 'calendar' && !gcalLoaded) {
      gcalLoaded = true;
      gcalOpen();
    } else if (tab !== 'calendar') {
      gcalLoaded = false;
    }
    document.querySelectorAll('[data-key-input]').forEach((input) => {
      const save = async () => {
        const v = input.value.trim();
        if (!v) return;
        input.value = '';
        await C.saveConfig({ [input.dataset.keyInput]: v }, `Chave ${input.dataset.label} salva.`);
        C.refresh();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          save();
        }
      });
      input.addEventListener('blur', save);
    });
  };

  C.settingsLeave = () => stopMicMeter();

  // ----------------------------------------------------------- devices --
  let devicesLoaded = false;
  async function enumerateDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      let list = await navigator.mediaDevices.enumerateDevices();
      if (!list.some((d) => d.label)) {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true });
          s.getTracks().forEach((t) => t.stop());
          list = await navigator.mediaDevices.enumerateDevices();
        } catch (_e) {}
      }
      const clean = (l, fb) => (l ? l.replace(/\s*\([0-9a-fA-F]{4}:[0-9a-fA-F]{4}\)/g, '').trim() : fb);
      const inputs = list.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d, i) => ({ deviceId: d.deviceId, label: clean(d.label, `Microfone ${i + 1}`) }));
      const outputs = list.filter((d) => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d, i) => ({ deviceId: d.deviceId, label: clean(d.label, `Saída ${i + 1}`) }));
      const prev = JSON.stringify(S.ui.audioDevices || {});
      S.ui.audioDevices = { inputs, outputs };
      if (!devicesLoaded || prev !== JSON.stringify(S.ui.audioDevices)) {
        devicesLoaded = true;
        if (S.route.view === 'settings' && S.route.parts[0] === 'audio') {
          stopMicMeter();
          C.refresh();
        }
      }
    } catch (err) {
      console.warn('enumerateDevices failed', err);
    }
  }
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      devicesLoaded = false;
      if (S.route.view === 'settings' && S.route.parts[0] === 'audio') enumerateDevices();
    });
  }

  let meter = null;
  async function startMicMeter() {
    if (meter) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    const id = S.config.audio_input_device;
    meter = { stopped: false };
    const local = meter;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: id && id !== 'default' ? { deviceId: { exact: id } } : true, video: false });
      if (local.stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      Object.assign(local, { stream, ctx });
      const tick = () => {
        if (local.stopped) return;
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const n = (buf[i] - 128) / 128;
          sum += n * n;
        }
        const rms = Math.sqrt(sum / buf.length);
        const db = rms > 0.0005 ? C.clamp(Math.round(20 * Math.log10(rms)), -60, 0) : -60;
        const pct = C.clamp((db + 55) / 55, 0, 1);
        const vu = document.getElementById('micVu');
        const lbl = document.getElementById('micDb');
        if (vu) {
          const n = vu.children.length;
          const on = Math.round(pct * n);
          for (let i = 0; i < n; i++) vu.children[i].className = i < on ? (i > n * 0.85 ? 'hot' : 'on') : '';
        }
        if (lbl) lbl.textContent = db > -55 ? `${db} dB` : '-- dB';
        local.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch (err) {
      const lbl = document.getElementById('micDb');
      if (lbl) lbl.textContent = 'sem acesso';
      meter = null;
    }
  }

  function stopMicMeter() {
    if (!meter) return;
    meter.stopped = true;
    if (meter.raf) cancelAnimationFrame(meter.raf);
    if (meter.stream) meter.stream.getTracks().forEach((t) => t.stop());
    if (meter.ctx && meter.ctx.state !== 'closed') meter.ctx.close().catch(() => {});
    meter = null;
  }

  // ----------------------------------------------------------- handlers --
  C.changes.cfg = async (el) => {
    const key = el.dataset.key;
    const label = el.dataset.label || 'Configuração';
    let val;
    if (el.dataset.type === 'bool') val = el.checked;
    else if (el.dataset.type === 'int' || el.dataset.type === 'float') {
      let n = el.dataset.type === 'int' ? parseInt(el.value, 10) : parseFloat(el.value);
      if (!Number.isFinite(n)) {
        C.toast(`${label}: digite um número.`, 'error');
        C.refresh();
        return;
      }
      if (el.dataset.min !== undefined) n = Math.max(Number(el.dataset.min), n);
      if (el.dataset.max !== undefined) n = Math.min(Number(el.dataset.max), n);
      el.value = String(n);
      val = n;
    } else {
      val = el.value.trim().replace(/[\r\n]+/g, ' ');
    }
    const msg = el.dataset.type === 'bool' ? `${label}: ${val ? 'ligado' : 'desligado'}.` : `${label} salvo.`;
    await C.saveConfig({ [key]: val }, msg);
    if (['model', 'save_sessions', 'auto_update'].includes(key)) C.refresh();
  };

  C.actions['set-model'] = async (el) => {
    const m = MODELS.find((x) => x.tier === el.dataset.tier);
    if (!m) return;
    const id = m.tier === 'ultra' && S.config.has_cerebras_key ? m.alt : m.id;
    await C.saveConfig({ model: id }, `Modelo de resposta: ${m.model}.`);
    C.refresh();
  };

  C.changes.language = async (el) => {
    await C.saveConfig({ language: el.value, speech_language: el.value }, `Idioma da entrevista: ${el.selectedOptions[0].textContent}.`);
  };

  C.changes['audio-device'] = async (el) => {
    const v = el.value;
    const label = el.selectedOptions[0] ? el.selectedOptions[0].textContent : v;
    if (el.dataset.kind === 'input') {
      await C.saveConfig({ audio_input_device: v, input_device: v }, `Microfone: ${label}.`);
      stopMicMeter();
      startMicMeter();
    } else {
      await C.saveConfig({ audio_output_device: v, output_device: v }, `Saída: ${label}.`);
    }
  };

  C.actions['test-sound'] = async () => {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.25);
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.65);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.65);
      setTimeout(() => ctx.close(), 900);
    } catch (_e) {}
    if (api.testSound) await C.guard(() => api.testSound());
    C.toast('Som de teste reproduzido.');
  };

  C.actions['clear-key'] = async (el) => {
    const ok = await C.confirm(`Remover a chave ${el.dataset.label}?`, 'O copiloto deixa de usar este provedor até você colar uma nova chave.', 'Remover');
    if (!ok) return;
    await C.saveConfig({ [el.dataset.key]: '' }, `Chave ${el.dataset.label} removida.`);
    C.refresh();
  };

  C.actions['set-theme'] = async (el) => {
    const res = await C.guard(() => api.setThemePreference(el.dataset.theme), 'Não foi possível trocar o tema.');
    if (res) C.applyTheme(res);
    else C.applyTheme({ preference: el.dataset.theme, resolved: el.dataset.theme === 'light' ? 'light' : 'dark' });
    C.refresh();
  };

  C.changes.stealth = async (el) => {
    const res = await C.guard(() => api.setStealthMode({ [el.dataset.field]: el.checked }), 'Não foi possível alterar.');
    if (res && res.status) S.stealthState = res.status;
    await C.refreshState();
    C.renderShell();
    C.toast('Privacidade do painel atualizada.');
  };

  C.inputs.opacity = (el) => {
    const v = Number(el.value);
    const lbl = document.getElementById('opacityLabel');
    if (lbl) lbl.textContent = `${v}%`;
    if (api.setInterfaceOpacity) api.setInterfaceOpacity(v / 100);
  };
  C.changes['opacity-save'] = async (el) => {
    await C.saveConfig({ interface_opacity: Number(el.value) / 100 }, `Opacidade: ${el.value}%.`);
  };

  C.actions['set-disguise'] = async (el) => {
    const mode = el.dataset.mode;
    if (api.setProcessDisguise) await C.guard(() => api.setProcessDisguise(mode));
    await C.saveConfig({ process_disguise: mode }, `Nome do processo: ${el.dataset.label}.`);
    C.refresh();
  };

  C.changes.meeting = async (el) => {
    const res = await C.guard(() => api.setMeetingDetection({ [el.dataset.field]: el.checked }), 'Não foi possível alterar a detecção.');
    if (res) S.meeting = res;
    C.refresh();
  };
  C.actions['meeting-unmute'] = async () => {
    const res = await C.guard(() => api.setMeetingDetection({ mutedApps: [] }));
    if (res) S.meeting = res;
    C.toast('O aviso volta a aparecer para todos os apps.');
    C.refresh();
  };
  C.actions['meeting-test'] = () => C.guard(() => api.testMeetingPopup(), 'Não foi possível mostrar o popup.');

  // Calendar
  async function gcalOpen() {
    await C.loadGcal();
    const st = S.gcal.status;
    if (st && st.connected) {
      const [cals, evs] = await Promise.all([C.guard(() => api.gcalCalendars()), C.guard(() => api.gcalEvents({ days: 14, max: 20 }))]);
      if (cals && cals.ok) S.gcal.calendars = cals.result || [];
      if (evs && evs.ok) {
        S.gcal.events = evs.result || [];
        S.gcal.eventsError = '';
      } else {
        S.gcal.events = [];
        S.gcal.eventsError = (evs && evs.error) || 'Não foi possível carregar os eventos.';
      }
    }
    if (S.route.view === 'settings' && S.route.parts[0] === 'calendar') C.refresh();
  }

  function reloadCalendar() {
    S.gcal.events = null;
    gcalLoaded = false;
    C.refresh();
  }

  C.actions['gcal-import'] = async () => {
    const res = await C.guard(() => api.gcalImportClient(), 'Não foi possível carregar o arquivo.');
    if (res && res.status) S.gcal.status = res.status;
    if (res && res.ok) C.toast('Cliente OAuth carregado. Agora clique em Conectar.');
    else if (res && !res.canceled) C.toast(res.error || 'Arquivo inválido.', 'error');
    C.refresh();
  };
  C.actions['gcal-connect'] = async () => {
    S.gcal.busy = true;
    C.refresh();
    C.toast('Conclua o login do Google no navegador.');
    const res = await C.guard(() => api.gcalConnect(), 'O Google Calendar não foi conectado.');
    S.gcal.busy = false;
    if (res && res.status) S.gcal.status = res.status;
    if (res && res.ok) C.toast(res.status && res.status.email ? `Google Calendar conectado: ${res.status.email}` : 'Google Calendar conectado.');
    else if (res) C.toast(res.error || 'O Google Calendar não foi conectado.', 'error');
    reloadCalendar();
  };
  C.actions['gcal-disconnect'] = async () => {
    const res = await C.guard(() => api.gcalDisconnect());
    if (res && res.status) S.gcal.status = res.status;
    S.gcal.events = null;
    C.toast('Google Calendar desconectado.');
    C.refresh();
  };
  C.changes['gcal-setting'] = async (el) => {
    const f = el.dataset.field;
    const v = f === 'autoSync' ? el.checked : f === 'reminderMin' ? Number(el.value) : el.value;
    const res = await C.guard(() => api.gcalSaveSettings({ [f]: v }), 'Não foi possível salvar.');
    if (res && res.status) S.gcal.status = res.status;
    C.toast(f === 'autoSync' ? (v ? 'Entrevistas agendadas vão para o Google Calendar.' : 'Entrevistas ficam só no Cue.') : 'Preferência salva.');
    if (f === 'calendarId') {
      reloadCalendar();
    }
  };
  C.actions['gcal-refresh'] = () => {
    reloadCalendar();
  };
  C.actions['gcal-create'] = async () => {
    const title = document.getElementById('gcalTitle').value.trim();
    const date = document.getElementById('gcalDate').value;
    if (!title) return C.toast('Dê um título ao evento.', 'error');
    if (!date) return C.toast('Escolha uma data.', 'error');
    const res = await C.guard(() =>
      api.gcalCreateEvent({
        summary: title,
        date,
        time: document.getElementById('gcalTime').value,
        durationMin: Number(document.getElementById('gcalDuration').value || 60),
        description: document.getElementById('gcalNotes').value.trim()
      })
    );
    if (res && res.ok) {
      C.toast(`Adicionado ao Google Calendar: ${title}`);
      reloadCalendar();
    } else C.toast((res && res.error) || 'Não foi possível criar o evento.', 'error');
  };
  C.actions['gcal-open'] = async (el) => {
    const res = await C.guard(() => api.gcalOpen(el.dataset.url));
    if (res && !res.ok) C.toast(res.error || 'Não foi possível abrir o evento.', 'error');
  };
  C.actions['gcal-delete'] = async (el) => {
    const ok = await C.confirm(`Excluir "${el.dataset.title || 'evento'}" do Google Calendar?`, 'O evento some do seu calendário.', 'Excluir');
    if (!ok) return;
    const cal = (S.gcal.status && S.gcal.status.calendarId) || 'primary';
    const res = await C.guard(() => api.gcalDeleteEvent(cal, el.dataset.id));
    C.toast(res && res.ok ? 'Evento excluído.' : (res && res.error) || 'Não foi possível excluir.', res && res.ok ? '' : 'error');
    reloadCalendar();
  };
  C.actions['copy-text'] = async (el) => {
    try {
      await navigator.clipboard.writeText(el.dataset.text || '');
      C.toast('Copiado.');
    } catch (_e) {
      C.toast(el.dataset.text || '');
    }
  };

  // Updates and flags
  C.actions['update-check'] = async () => {
    S.update = { ...(S.update || {}), status: 'checking' };
    C.refresh();
    const res = await C.guard(() => api.checkUpdate(), 'Erro ao verificar atualizações.');
    if (res) S.update = res;
    C.refresh();
  };
  C.actions['update-download'] = async () => {
    S.update = { ...(S.update || {}), status: 'downloading', progress: { percent: 0 } };
    C.refresh();
    const res = await C.guard(() => api.downloadUpdate());
    if (res && res.ok === false) C.toast(`Falha no download: ${res.error || 'erro desconhecido'}`, 'error');
  };
  C.actions['update-install'] = async () => {
    const res = await C.guard(() => api.installUpdate());
    if (res && res.ok === false) C.toast(res.error || 'Nenhuma atualização pronta.', 'error');
    else C.toast('Reiniciando para atualizar…');
  };
  C.actions['update-channel'] = async (el) => {
    const res = await C.guard(() => api.setUpdateChannel(el.dataset.channel), 'Não foi possível trocar o canal.');
    if (res && res.ok) {
      S.config.update_channel = res.channel;
      if (res.flags) S.flags = res.flags;
      C.toast(`Canal de atualização: ${res.channel === 'beta' ? 'Beta' : 'Estável'}.`);
      C.refresh();
    }
  };
  C.changes.flag = async (el) => {
    const res = await C.guard(() => api.setFlagOverride(el.dataset.key, el.value));
    if (res && res.ok === false) C.toast(res.error || 'Valor inválido.', 'error');
    else if (res && res.flags) S.flags = res.flags;
    C.refresh();
  };
  C.actions['flags-refresh'] = async () => {
    const res = await C.guard(() => api.refreshFlags());
    if (res) S.flags = res;
    C.toast('Recursos sincronizados.');
    C.refresh();
  };
  C.actions['flags-reset'] = async () => {
    const res = await C.guard(() => api.resetFlagOverrides());
    if (res && res.flags) S.flags = res.flags;
    C.toast('Padrões restaurados.');
    C.refresh();
  };
})();
