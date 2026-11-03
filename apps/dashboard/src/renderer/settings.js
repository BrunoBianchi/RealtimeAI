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
    ['general', 'General', 'gear'],
    ['account', 'Account and server', 'globe'],
    ['ai', 'AI and models', 'cpu'],
    ['audio', 'Audio and transcription', 'microphone'],
    ['privacy', 'Privacy', 'shield-check'],
    ['overlay', 'Floating panel', 'monitor'],
    ['calendar', 'Calendar', 'calendar'],
    ['shortcuts', 'Shortcuts', 'keyboard'],
    ['plan', 'Plan and usage', 'credit-card'],
    ['updates', 'Updates', 'download']
  ];

  const MODELS = [
    { tier: 'fast', id: 'qwen/qwen3.6-flash', title: 'Fast', model: 'Qwen 3.6 Flash', desc: 'Lowest latency; ideal for continuous conversation.' },
    { tier: 'medium', id: 'meta-llama/llama-3.3-70b-instruct', title: 'Balanced', model: 'Llama 3.3 70B', desc: 'More elaborate answers, still fast.' },
    { tier: 'ultra', id: 'openai/gpt-oss-120b', alt: 'gpt-oss-120b', title: 'Ultra', model: 'GPT-OSS 120B', desc: 'Stronger technical reasoning (system design, code).' }
  ];

  const KEYS = [
    ['deepgram_key', 'Deepgram', 'has_deepgram_key', 'deepgram_key_display', 'Speech transcription (required)', 'https://console.deepgram.com/'],
    ['llm_key', 'OpenRouter', 'has_llm_key', 'llm_key_display', 'Access to Qwen, Llama, GPT-OSS and others', 'https://openrouter.ai/keys'],
    ['cerebras_key', 'Cerebras', 'has_cerebras_key', 'cerebras_key_display', 'Ultra-fast inference for models without "/"', 'https://cloud.cerebras.ai/'],
    ['groq_key', 'Groq', 'has_groq_key', 'groq_key_display', 'Alternative fast inference', 'https://console.groq.com/keys'],
    ['openai_key', 'OpenAI', 'has_openai_key', 'openai_key_display', 'GPT models', 'https://platform.openai.com/api-keys'],
    ['anthropic_key', 'Anthropic', 'has_anthropic_key', 'anthropic_key_display', 'Claude models', 'https://console.anthropic.com/'],
    ['gemini_key', 'Google Gemini', 'has_gemini_key', 'gemini_key_display', 'Gemini models', 'https://aistudio.google.com/app/apikey']
  ];

  const LANGS = [['pt-BR', 'Portuguese (Brazil)'], ['en-US', 'English (US)'], ['es', 'Spanish'], ['multi', 'Detect automatically']];

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
    let meetingStatus = 'Loading…';
    if (m) {
      const active = Array.isArray(m.active) ? m.active : [];
      if (!m.supported) meetingStatus = 'Available on Windows only.';
      else if (!m.enabled) meetingStatus = 'Off: no alert when a meeting starts.';
      else if (active.length) meetingStatus = `In a call now: ${active.map((x) => x.name).join(', ')}.`;
      else meetingStatus = 'Watching Meet, Teams, Zoom, Discord, Slack and others.';
    }
    const muted = m && Array.isArray(m.mutedApps) ? m.mutedApps.map((id) => (m.appNames && m.appNames[id]) || id) : [];
    return `
      ${card('Profile', 'Used in the greeting and by the copilot to speak in the first person',
        `<div class="row" style="gap:14px"><span class="avatar" style="width:40px;height:40px;font-size:13px">${esc(C.monogram(p.name || 'You'))}</span><div class="stack grow" style="gap:0"><span class="strong">${esc(fixText(p.name || 'No name'))}</span><span class="small faint">${esc(fixText([p.headline, p.seniority].filter(Boolean).join(' · ') || 'No role set'))}</span><span class="small faint">${esc(p.email || '')}</span></div><button type="button" class="btn" data-action="open-profile">${icon('pencil')}Edit profile</button></div>`)}
      ${card('Appearance', '',
        `<div class="option-cards">${[['dark', 'Dark', 'moon'], ['light', 'Light', 'sun'], ['system', 'System', 'monitor']]
          .map(([v, l, ic]) => `<button type="button" class="option-card ${pref === v ? 'active' : ''}" aria-pressed="${pref === v}" data-action="set-theme" data-theme="${v}"><span class="t">${icon(ic)}${l}</span><span class="s">${v === 'system' ? 'Follows Windows' : `${l} theme`}</span></button>`)
          .join('')}</div>`)}
      ${card('Meeting detection', esc(meetingStatus),
        `${row('Alert when a meeting starts', 'A popup offers to start the copilot with the right session.', m ? C.sw('data-change="meeting" data-field="enabled"', m.enabled, !m.supported) : '')}
         ${row('Keep in the tray when closed', 'Cue keeps watching for meetings with the window closed.', m ? C.sw('data-change="meeting" data-field="keepInTray"', m.keepInTray, !m.enabled) : '')}
         ${muted.length ? row('Muted apps', esc(muted.join(', ')), '<button type="button" class="btn sm" data-action="meeting-unmute">Unmute all</button>') : ''}
         ${row('Test the alert', 'Shows the popup as if a meeting had started.', '<button type="button" class="btn sm" data-action="meeting-test">Show popup</button>')}`)}
      ${card('Local data', 'Everything stays on this machine: sessions, files and settings',
        `${row('Record sessions', 'Saves the transcript and answers as Markdown and JSONL when stopping.', cfgSwitch('save_sessions', 'Record sessions', cfg.save_sessions !== false))}
         ${row('Data folder', `<span class="mono" style="font-size:11px">${esc((cfg.configPath || '').replace(/[\\/][^\\/]+$/, '') || '%LOCALAPPDATA%\\RealTimeAI')}</span>`, '<button type="button" class="btn sm" data-action="open-path">Open folder</button>')}`)}`;
  }

  // ----------------------------------------------------- cloud account --
  // The RealTimeAI account is mandatory (auth.js locks the app while signed
  // out). This tab shows who is signed in and where STT + IA run.
  function account() {
    const cfg = S.config;
    const st = S.auth || {};
    const mode = cfg.server_mode || 'auto';
    const available = Boolean(cfg.server_url_effective);
    const acc = st.account;
    const ent = st.entitlement;
    const who = (acc && (acc.name || acc.email)) || 'Signed in';
    const planText = ent
      ? `${ent.planLabel} plan · ${Math.round(ent.usedMinutes)} of ${ent.limitMinutes} min used${ent.monthly ? ' this month' : ''}`
      : st.detail || '';
    const body = `<div class="row" style="gap:14px"><span class="avatar" style="width:40px;height:40px;font-size:13px">${esc(C.monogram(who))}</span>
        <div class="stack grow" style="gap:0"><span class="strong">${esc(who)}</span>
        ${acc && acc.email && acc.name ? `<span class="small faint">${esc(acc.email)}</span>` : ''}
        <span class="small faint">${esc(planText)}</span></div>
        <button type="button" class="btn sm" data-action="go" data-to="settings/plan">View plan</button>
        <button type="button" class="btn" data-action="cloud-logout">${icon('sign-out')}Sign out</button></div>`;
    const active = C.cloudActive();
    return `
      ${card('RealTimeAI account', active ? 'Next session uses the RealTimeAI servers' : 'Next session uses your API keys', body)}
      ${card('Where the AI runs', 'Audio goes straight to the transcription provider; the server only issues temporary credentials. Plan minutes count in both modes.',
        `<div class="option-cards">${[
          ['auto', 'RealTimeAI servers', 'Transcription and answers through your account, no API keys.'],
          ['proprio', 'My keys', 'Uses the keys in AI and models (open-source mode).']
        ].map(([v, l, d]) => {
          const on = v === 'proprio' ? mode === 'proprio' : mode !== 'proprio';
          return `<button type="button" class="option-card ${on ? 'active' : ''}" aria-pressed="${on}" data-action="cloud-mode" data-mode="${v}"><span class="t">${on ? '<span class="dot"></span>' : ''}${l}</span><span class="s">${d}</span></button>`;
        }).join('')}</div>`)}
      ${card('Advanced', 'Your own or a test server',
        `${row('Server address', available && !cfg.server_url ? `Default: <span class="mono">${esc(cfg.server_url_effective)}</span>` : 'Any server that implements the RealTimeAI v1 API.', cfgText('server_url', 'Server address', cfg.server_url || '', cfg.server_url_effective || 'https://server.example.com', 280))}
         ${row('Region', 'Automatic picks the closest one (lowest latency).', cfgSelect('server_region', 'Region', [['auto', 'Automatic'], ['sa-east-1', 'South America (São Paulo)'], ['us-east-1', 'US (East)'], ['eu-west-1', 'Europe (Ireland)']], cfg.server_region || 'auto'))}`)}`;
  }

  C.actions['cloud-logout'] = async () => {
    const ok = await C.confirm('Sign out of RealTimeAI?', 'Cue stays locked until you sign in again. A live session in progress is stopped.', 'Sign out');
    if (!ok) return;
    const res = await C.guard(() => api.cloudLogout(), 'Could not sign out.');
    if (res && res.config) S.config = res.config;
    S.auth = { signedIn: false };
    await C.authRefresh(true);
  };

  C.actions['cloud-mode'] = async (el) => {
    await C.saveConfig({ server_mode: el.dataset.mode }, 'Server preference saved.');
    C.refresh();
  };

  C.actions['cloud-billing'] = async (el) => {
    const kind = el.dataset.kind === 'portal' ? 'portal' : 'checkout';
    const res = await C.guard(() => api.cloudBilling(kind), 'Could not open the payment page.');
    if (res && res.ok) C.toast(kind === 'portal' ? 'Your subscription opened in the browser.' : 'Finish subscribing in the browser. The plan updates on its own.');
    else if (res) C.toast(res.error || 'Could not open the payment page.', 'error');
  };

  C.actions['plan-refresh'] = async () => {
    await C.authRefresh(true);
    C.toast('Plan refreshed.');
  };

  function ai() {
    const cfg = S.config;
    const cur = cfg.model || 'qwen/qwen3.6-flash';
    const known = MODELS.some((m) => m.id === cur || m.alt === cur);
    return `
      ${card('Answer model', `Current: ${esc(C.modelLabel(cur))} via ${esc(C.providerFor(cur))}`,
        `<div class="option-cards">${MODELS.map((m) => {
          const active = cur === m.id || cur === m.alt;
          return `<button type="button" class="option-card ${active ? 'active' : ''}" aria-pressed="${active}" data-action="set-model" data-tier="${m.tier}"><span class="t">${active ? '<span class="dot"></span>' : ''}${m.title}<span class="num" style="margin-left:auto">${m.model}</span></span><span class="s">${m.desc}</span></button>`;
        }).join('')}</div>
        <div class="set-row" style="margin-top:14px;border-top:1px solid var(--border-subtle);padding-top:14px"><div class="txt"><span class="t">Model ID</span><span class="s">Any OpenRouter model (provider/model) or Cerebras model (without "/").${known ? '' : ' Custom.'}</span></div><div class="ctl">${cfgText('model', 'Model', cur, 'qwen/qwen3.6-flash', 280)}</div></div>`)}
      ${card('Behavior', '',
        `${row('Suggest answers automatically', 'Answers as soon as it detects a question. When off, only with Ctrl+Alt+Enter.', cfgSwitch('auto_suggest', 'Automatic suggestion', cfg.auto_suggest !== false))}
         ${row('Minimum interval between answers', 'Seconds between two automatic suggestions.', cfgNumber('cooldown_s', 'Interval', cfg.cooldown_s ?? 8, 2, 60))}
         ${row('Answer language', 'The language the copilot writes in.', cfgSelect('ai_response_language', 'Answer language', [['auto', 'Same as the conversation'], ['pt-BR', 'Portuguese'], ['en-US', 'English'], ['es', 'Spanish']], cfg.ai_response_language || 'auto'))}
         ${row('Fast answer mode', 'Shorter, more direct answers with less waiting.', cfgSwitch('fast_response_mode', 'Fast answer', cfg.fast_response_mode))}
         ${row('Direct assistant (beta)', 'Also answers direct requests, not just interview questions.', cfgSwitch('direct_assist', 'Direct assistant', cfg.direct_assist))}
         ${row('Background model', 'Used for summaries and tasks outside the conversation.', cfgSelect('background_model', 'Background model', [['auto', 'Automatic'], ...MODELS.map((m) => [m.id, m.model])], cfg.background_model || 'auto'))}
         ${row('Reasoning', 'More reasoning improves hard answers but adds latency.', cfgSelect('reasoning', 'Reasoning', [['none', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], cfg.reasoning || 'none'))}
         ${row('Max tokens', 'Maximum length of each answer.', cfgNumber('max_tokens', 'Max tokens', cfg.max_tokens ?? 1500, 1500, 8000, 100))}
         ${row('Temperature', '0 = more predictable, 1 = more creative.', cfgNumber('temperature', 'Temperature', cfg.temperature ?? 0.3, 0, 1.5, 0.05, 'float'))}
         ${row('Trigger keywords', 'Terms that trigger an answer (comma-separated).', cfgText('keywords', 'Keywords', cfg.keywords || '', 'e.g. architecture, kafka'))}`)}
      ${card('API keys', 'Stored in config.ini and encrypted by Windows (DPAPI) on first run',
        KEYS.map(([key, name, has, display, sub, url]) => {
          const ok = Boolean(cfg[has]);
          return `<div class="set-row"><div class="txt"><span class="t row" style="gap:8px">${esc(name)}<span class="key-status" style="color:${ok ? 'var(--accent)' : 'var(--text-tertiary)'}">${ok ? '● connected' : '○ not set'}</span></span><span class="s">${esc(sub)} · <a data-action="open-url" data-url="${esc(url)}">get a key</a></span></div>
            <div class="ctl"><input class="input sm" style="width:240px" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(ok ? cfg[display] || '••••••••' : 'Paste the key')}" data-key-input="${key}" data-label="${esc(name)}"/>${ok ? `<button type="button" class="icon-btn danger" title="Remove key" data-action="clear-key" data-key="${key}" data-label="${esc(name)}">${icon('trash')}</button>` : ''}</div></div>`;
        }).join(''))}
      ${card('Advanced', 'Custom endpoints and local models',
        `${row('Chat API URL', 'OpenAI-compatible (chat/completions).', cfgText('llm_url', 'API URL', cfg.llm_url || '', 'https://openrouter.ai/api/v1/chat/completions', 300))}
         ${row('Local endpoint', 'Ollama, LM Studio or another local server.', cfgText('local_endpoint', 'Local endpoint', cfg.local_endpoint || '', 'http://localhost:11434'))}
         ${row('Local model', '', cfgText('local_model', 'Local model', cfg.local_model || '', 'llama3', 180))}`)}`;
  }

  function audio() {
    const cfg = S.config;
    const devs = S.ui.audioDevices || { inputs: [], outputs: [] };
    const inOpts = [['default', 'System default'], ...devs.inputs.map((d) => [d.deviceId, d.label])];
    const outOpts = [['default', 'System default (loopback)'], ...devs.outputs.map((d) => [d.deviceId, d.label])];
    const vu = Array.from({ length: 24 }, () => '<span></span>').join('');
    return `
      ${card('Capture', 'You = microphone · Interviewer = system audio',
        `${row('Microphone (you)', 'Transcribes your voice so the copilot can follow your answers.', cfgSwitch('mic_enabled', 'Microphone', cfg.mic_enabled !== false))}
         ${row('System audio (interviewer)', 'Captures what plays on the speakers or headphones (loopback).', cfgSwitch('loopback_enabled', 'System audio', cfg.loopback_enabled !== false))}
         ${row('Input device', '', `<select class="select sm" style="width:280px" data-change="audio-device" data-kind="input">${C.opts(inOpts, cfg.audio_input_device || 'default')}</select>`)}
         <div class="set-row"><div class="txt"><span class="t">Microphone level</span><span class="s">Speak normally: the bars should pass the middle.</span></div><div class="ctl" style="gap:10px"><div class="vu" id="micVu" style="max-width:200px">${vu}</div><span class="num" id="micDb" style="width:48px;text-align:right">-- dB</span></div></div>
         ${row('Output device', 'Where the interviewer audio comes from.', `<select class="select sm" style="width:280px" data-change="audio-device" data-kind="output">${C.opts(outOpts, cfg.audio_output_device || 'default')}</select>`)}
         ${row('Test output', 'Plays a short beep on the default device.', '<button type="button" class="btn sm" data-action="test-sound">' + icon('speaker') + 'Play sound</button>')}
         ${row('Noise cancellation', '', cfgSwitch('noise_cancellation', 'Noise cancellation', cfg.noise_cancellation !== false))}`)}
      ${card('Transcription', 'Provider: Deepgram Nova-3, streaming',
        `${row('Interview language', 'The language the interviewer speaks.', `<select class="select sm" data-change="language">${C.opts(LANGS, cfg.language || 'pt-BR')}</select>`)}
         ${row('End of speech (endpointing)', 'Silence, in ms, that ends a turn. Lower = faster, higher = fewer cut-offs.', cfgNumber('endpointing_ms', 'Endpointing', cfg.endpointing_ms ?? 350, 10, 3000, 10))}
         ${row('Technical terms', 'Words the recognizer should prioritize (names, acronyms, technologies).', cfgText('keyterms', 'Terms', cfg.keyterms || '', 'e.g. Kubernetes, Pix, gRPC', 300))}
         ${row('Voice detection', 'Silero is more accurate; energy is lighter.', cfgSelect('vad', 'Voice detection', [['silero', 'Silero (recommended)'], ['energy', 'Energy']], cfg.vad || 'silero'))}
         ${row('Energy threshold', 'Sensitivity of the energy detector.', cfgNumber('energy_threshold', 'Threshold', cfg.energy_threshold ?? 0.015, 0.001, 0.2, 0.001, 'float'))}`)}`;
  }

  function privacy() {
    const cfg = S.config;
    const st = S.stealthState || {};
    const disguise = cfg.process_disguise || 'none';
    const opacity = Math.round((cfg.interface_opacity ?? cfg.electron_opacity ?? 1) * 100);
    return `
      ${card('This window', 'How the Cue window appears to other people',
        `${row('Hide from recordings and screen sharing', 'Windows excludes this window from captures (Meet, Zoom, Teams, OBS). Shortcut: Ctrl+Alt+S.', C.sw('data-change="stealth" data-field="active"', st.active))}
         ${row('Screen protection', 'Keeps capture exclusion on whenever the panel is hidden.', C.sw('data-change="stealth" data-field="screenProtection"', st.screenProtection ?? cfg.electron_screen_protection))}
         ${row('Hide from the taskbar and Alt+Tab', 'Open it from the tray or with Ctrl+Shift+H.', C.sw('data-change="stealth" data-field="skipTaskbar"', st.skipTaskbar ?? cfg.electron_skip_taskbar))}
         ${row('Discreet title', 'Changes the window title to "Settings".', C.sw('data-change="stealth" data-field="disguise"', st.disguise ?? cfg.electron_disguise))}
         <div class="set-row"><div class="txt"><span class="t">Window opacity</span><span class="s">Makes the panel translucent over other windows.</span></div><div class="ctl" style="gap:10px"><input type="range" min="40" max="100" step="5" value="${opacity}" data-input="opacity" data-change="opacity-save" style="width:180px;accent-color:var(--accent)"/><span class="num" id="opacityLabel" style="width:40px;text-align:right">${opacity}%</span></div></div>
         <div class="set-row stacked"><div class="txt"><span class="t">Process name</span><span class="s">How Cue appears in Task Manager.</span></div>
           <div class="option-cards">${[['none', 'RealTimeAI', 'Normal'], ['settings', 'Settings', 'Windows Settings'], ['cmd', 'Command Prompt', 'cmd.exe'], ['taskmgr', 'Task Manager', 'Task Manager']]
             .map(([v, t, s]) => `<button type="button" class="option-card ${disguise === v ? 'active' : ''}" aria-pressed="${disguise === v}" data-action="set-disguise" data-mode="${v}" data-label="${esc(t)}"><span class="t">${esc(t)}</span><span class="s">${esc(s)}</span></button>`)
             .join('')}</div></div>`)}
      ${card('Floating panel (HUD)', 'What the interviewer does not see during the call',
        `${row('Invisible in screen sharing and recording', 'You see the HUD on your screen; the capture does not.', cfgSwitch('stealth_screen_capture', 'Invisible in captures', cfg.stealth_screen_capture !== false))}
         ${row('Off the taskbar and Alt+Tab', '', cfgSwitch('stealth_dock', 'Off the taskbar', cfg.stealth_dock !== false))}
         ${row('Discreet in Task Manager', '', cfgSwitch('stealth_activity_monitor', 'Discreet in Task Manager', cfg.stealth_activity_monitor !== false))}
         ${row('Clicks pass through the HUD', 'Click the app underneath. Toggle live with Ctrl+Alt+T.', cfgSwitch('stealth_click_through', 'Clicks pass through', cfg.stealth_click_through))}`)}
      ${card('Sharing', '',
        `${row('Contribute anonymized questions', 'At the end of a session, only the interviewer questions (no names, none of your answers) feed the Question bank.', C.sw('data-change="share-questions"', cfg.share_anonymized_questions !== false))}`)}`;
  }

  function overlay() {
    const cfg = S.config;
    return `${card('HUD size', 'Applied the next time the copilot starts (or now, if it is running)',
      `${row('Width', 'In pixels.', cfgNumber('overlay_width', 'HUD width', cfg.overlay_width ?? 620, 360, 1400, 10))}
       ${row('Max height', 'Percentage of the screen height.', cfgNumber('overlay_max_height_pct', 'Max height', cfg.overlay_max_height_pct ?? 92, 30, 100, 1))}`)}
      ${card('Copilot', S.overlayStatus.running ? 'Running now' : 'Stopped',
        `${row('Status', S.overlayStatus.running ? `${S.overlayStatus.mode === 'demo' ? 'Practice' : 'Live'} since ${C.fmtTime(new Date(S.overlayStatus.startedAt || Date.now()))}` : 'The HUD opens when you start a session.', S.overlayStatus.running ? '<button type="button" class="btn sm danger" data-action="stop-copilot">Stop</button>' : '<button type="button" class="btn sm" data-action="go" data-to="live">Go to Live</button>')}`)}`;
  }

  function calendar() {
    const g = S.gcal;
    const st = g.status;
    const configured = Boolean(st && st.configured);
    const connected = Boolean(st && st.connected);
    let title = 'Not set up';
    let detail = 'Load the OAuth client file (client_secret_….json) downloaded from Google Cloud.';
    let dot = 'off';
    if (configured && !connected) {
      title = 'Ready to connect';
      detail = st.lastError || (st.brokered ? 'Ready to connect through your RealTimeAI account.' : `OAuth client: ${st.clientType === 'web' ? 'web application' : 'desktop app'}${st.projectId ? ` (${st.projectId})` : ''}`);
      dot = 'warn';
    } else if (connected) {
      title = 'Connected';
      detail = st.lastError || (st.email ? `Account: ${st.email}` : 'Account connected');
      dot = st.lastError ? 'warn' : '';
    }
    const events = g.events;
    const today = new Date();
    const iso = `${today.getFullYear()}-${C.pad2(today.getMonth() + 1)}-${C.pad2(today.getDate())}`;
    return `
      ${card('Google Calendar', 'Scheduled interviews become events with a reminder',
        `<div class="row" style="gap:12px;padding-bottom:14px"><span class="dot ${dot}"></span><div class="stack grow" style="gap:0"><span class="strong">${esc(title)}</span><span class="small faint">${esc(detail)}</span></div>
          ${connected || (st && st.brokered) ? '' : `<button type="button" class="btn" data-action="gcal-import">${icon('upload')}${configured ? 'Replace file' : 'Load file'}</button>`}
          ${configured && !connected ? `<button type="button" class="btn primary" data-action="gcal-connect" ${g.busy ? 'disabled' : ''}>${g.busy ? '<span class="spinner"></span>Waiting for Google…' : 'Connect'}</button>` : ''}
          ${connected ? '<button type="button" class="btn" data-action="gcal-disconnect">Disconnect</button>' : ''}</div>
          ${configured && !connected && st.redirectUri ? `<div class="inset"><span class="eyebrow">Redirect URI</span><div class="row"><code class="mono grow truncate" style="font-size:12px">${esc(st.redirectUri)}</code><button type="button" class="btn sm" data-action="copy-text" data-text="${esc(st.redirectUri)}">${icon('copy')}Copy</button></div><span class="xs faint">Register this address in the Google Cloud OAuth client.</span></div>` : ''}
          ${connected
            ? `${row('Send scheduled interviews', 'Creates and updates the event when you schedule a session.', C.sw('data-change="gcal-setting" data-field="autoSync"', st.autoSync !== false))}
               ${row('Calendar', '', `<select class="select sm" style="width:240px" data-change="gcal-setting" data-field="calendarId">${C.opts([['primary', 'Primary calendar'], ...(g.calendars || []).filter((c) => !c.primary).map((c) => [c.id, c.summary])], st.calendarId || 'primary')}</select>`)}
               ${row('Reminder', 'Google notification before each event.', `<select class="select sm" data-change="gcal-setting" data-field="reminderMin">${C.opts([['0', 'Calendar default'], ['10', '10 min before'], ['30', '30 min before'], ['60', '1 hour before'], ['1440', '1 day before']], String(st.reminderMin ?? 60))}</select>`)}`
            : ''}`)}
      ${connected
        ? card('New event', '',
            `<div class="stack">
              <label class="field">Title<input class="input" id="gcalTitle" placeholder="Technical interview · Company"/></label>
              <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr"><label class="field">Date<input class="input" type="date" id="gcalDate" value="${iso}"/></label><label class="field">Time<input class="input" type="time" id="gcalTime"/></label><label class="field">Duration<select class="select" id="gcalDuration">${C.opts([['30', '30 min'], ['45', '45 min'], ['60', '1 hour'], ['90', '1h30'], ['120', '2 hours']], '60')}</select></label></div>
              <label class="field">Notes<textarea class="textarea" id="gcalNotes" rows="2" placeholder="Call link, interviewers…"></textarea></label>
              <div class="row" style="justify-content:flex-end"><span class="xs faint grow">No time = all-day event.</span><button type="button" class="btn primary" data-action="gcal-create">${icon('plus')}Add to Google Calendar</button></div>
            </div>`)
        : ''}
      ${connected
        ? `<section class="card flush"><div class="row between" style="padding:14px 20px;border-bottom:1px solid var(--border-subtle)"><span class="strong">Next 14 days</span><button type="button" class="btn sm" data-action="gcal-refresh">${icon('refresh')}Refresh</button></div>
            ${events == null
              ? '<div class="empty">Loading…</div>'
              : g.eventsError
                ? `<div class="empty">${esc(g.eventsError)}</div>`
                : events.length
                  ? events.map((ev) => `<div class="table-row" style="grid-template-columns:minmax(0,1fr) auto"><div class="stack" style="gap:0;min-width:0"><span class="truncate strong">${esc(ev.summary || '(untitled)')}${ev.goalId ? ' <span class="tag">Interview</span>' : ''}</span><span class="small faint truncate">${esc(gcalWhen(ev))}${ev.location ? ` · ${esc(ev.location)}` : ''}</span></div><div class="row" style="gap:4px">${ev.meet ? `<button type="button" class="btn sm" data-action="gcal-open" data-url="${esc(ev.meet)}">${icon('video')}Meet</button>` : ''}${ev.link ? `<button type="button" class="btn sm ghost" data-action="gcal-open" data-url="${esc(ev.link)}">Open</button>` : ''}<button type="button" class="icon-btn danger" title="Delete" data-action="gcal-delete" data-id="${esc(ev.id)}" data-title="${esc(ev.summary || '')}">${icon('trash')}</button></div></div>`).join('')
                  : '<div class="empty">Nothing in the next 14 days.</div>'}
          </section>`
        : ''}`;
  }

  function gcalWhen(ev) {
    if (!ev || !ev.start) return '';
    if (ev.allDay) {
      const d = new Date(`${ev.start}T00:00:00`);
      return `${d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })} · all day`;
    }
    const d = new Date(ev.start);
    if (Number.isNaN(d.getTime())) return ev.start;
    return d.toLocaleString('en-US', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  const SHORTCUTS = [
    ['During the interview (HUD)', [
      [['Ctrl', 'Alt', 'Enter'], 'Answer now'],
      [['Alt', 'Space'], 'Answer now (alternative)'],
      [['Ctrl', 'Space'], 'Answer now (alternative)'],
      [['Ctrl', 'Alt', 'S'], 'Analyze the screen (screenshot)'],
      [['Ctrl', 'Alt', 'K'], 'Open the chat'],
      [['Ctrl', 'Alt', 'R'], 'Conversation recap'],
      [['Ctrl', 'Alt', 'Tab'], 'Show the next queued suggestion'],
      [['Ctrl', 'Alt', '←'], 'Previous answer'],
      [['Ctrl', 'Alt', '→'], 'Next answer'],
      [['Alt', '↑'], 'History: previous'],
      [['Alt', '↓'], 'History: next'],
      [['Alt', '1 / 2 / 3'], 'Quick actions'],
      [['Ctrl', 'Alt', 'P'], 'Pause capture'],
      [['Ctrl', 'Alt', 'M'], 'Transcription-only mode'],
      [['Ctrl', 'Alt', 'Backspace'], 'Clear answers'],
      [['Ctrl', 'Alt', 'Shift', 'Backspace'], 'Clear the transcript strip'],
      [['Ctrl', 'Alt', 'T'], 'Clicks pass through the HUD'],
      [['Ctrl', 'Alt', 'H'], 'Hide / show the HUD'],
      [['Alt', 'H'], 'Panic: hide everything'],
      [['Ctrl', 'Alt', 'O'], 'Open settings'],
      [['Ctrl', 'Alt', 'Q'], 'Stop and save the session']
    ]],
    ['In this window', [
      [['Ctrl', 'K'], 'Search and commands'],
      [['Ctrl', 'Alt', 'S'], 'Hide the panel from captures (global)'],
      [['Ctrl', 'Shift', 'H'], 'Show / hide the panel (global)'],
      [['Esc'], 'Close dialogs']
    ]]
  ];

  function shortcuts() {
    return SHORTCUTS.map(([title, list]) =>
      card(esc(title), '', list.map(([keys, label]) => `<div class="shortcut-row"><span>${esc(label)}</span><span class="keys">${keys.map((k) => `<span class="kbd">${esc(k)}</span>`).join('')}</span></div>`).join(''))
    ).join('');
  }

  // Account plan from the server (S.auth.entitlement): Free = one session of up
  // to 15 min, once; PRO = 200 min per month.
  function planCard(u) {
    const ent = S.auth && S.auth.entitlement;
    if (!ent) return card('Current plan', '', '<div class="muted">Could not read the plan right now.</div>', `<button type="button" class="btn sm" data-action="plan-refresh">${icon('refresh')}Refresh</button>`);
    const tone = u.pct > 90 ? 'danger' : u.pct > 70 ? 'warn' : '';
    const sub = ent.isPro
      ? `${ent.limitMinutes} minutes per month · renews on ${esc(u.renewLabel)}`
      : ent.sessionsUsed >= 1 ? 'Free session already used' : 'One free session of up to 15 minutes';
    const action = ent.isPro
      ? `<button type="button" class="btn" data-action="cloud-billing" data-kind="portal">${icon('external')}Manage subscription</button>`
      : `<button type="button" class="btn primary" data-action="cloud-billing" data-kind="checkout">Upgrade to PRO</button>`;
    return card('Current plan', 'From your RealTimeAI account',
      `<div class="row" style="gap:16px"><span class="metric">${esc(ent.planLabel)}</span><span class="muted grow">${sub}</span>${action}</div>
       <div class="meter-row" style="margin-top:14px"><div class="lbl"><span>${u.usedMin} of ${u.limit} min ${ent.isPro ? `in ${esc(u.monthLabel)}` : 'used'}</span><span class="num">${u.left} min left</span></div>${C.pctBar(u.pct, tone)}</div>
       ${ent.canStart ? '' : `<div class="small" role="alert" style="color:var(--danger);margin-top:12px">${esc(ent.reason)}</div>`}`,
      `<button type="button" class="btn sm ghost" data-action="plan-refresh">${icon('refresh')}Refresh</button>`);
  }

  function plan() {
    const u = C.usage();
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
      ${planCard(u)}
      ${card('Plans', 'The server checks the limit on every session; when it runs out, the session ends.',
        `<div class="option-cards">
          <div class="option-card ${u.isPro ? '' : 'active'}"><span class="t">${u.isPro ? '' : '<span class="dot"></span>'}Free</span><span class="s">A single session of up to 15 minutes to try it out. Does not renew.</span></div>
          <div class="option-card ${u.isPro ? 'active' : ''}"><span class="t">${u.isPro ? '<span class="dot"></span>' : ''}PRO</span><span class="s">Up to 200 minutes per month, across as many sessions as you like. Renews monthly.</span></div>
        </div>`)}
      ${card('Usage by month', 'Calculated from recorded sessions',
        months.length
          ? months.map(([key, v]) => `<div class="meter-row" style="padding:8px 0"><div class="lbl"><span>${esc(C.MONTHS_LONG[v.d.getMonth()])} ${v.d.getFullYear()}</span><span class="num">${Math.round(v.sec / 60)} min · ${plural(v.n, 'session', 'sessions')}</span></div>${C.pctBar((v.sec / max) * 100, 'thick')}</div>`).join('')
          : '<div class="empty">No recorded sessions yet.</div>')}`;
  }

  function updates() {
    const v = S.appVersion || {};
    const st = S.update || {};
    const cfg = S.config;
    const channel = cfg.update_channel === 'beta' ? 'beta' : 'stable';
    const latest = st.latestVersion || v.version || '';
    const msgs = {
      idle: 'Not checked yet.',
      checking: 'Checking for updates…',
      'up-to-date': `You are on the latest version${channel === 'beta' ? ' (beta channel)' : ''}.`,
      available: `Version ${latest} is available.`,
      downloading: `Downloading ${latest}…`,
      downloaded: `Version ${latest} is ready. Restart to finish.`,
      error: `Could not check: ${st.error || 'unknown error'}`,
      disabled: st.error || 'Updates only work in the installed app.'
    };
    const status = st.status || 'idle';
    const pct = st.progress ? C.clamp(Number(st.progress.percent) || 0, 0, 100) : 0;
    const flags = S.flags || { flags: {} };
    const flagList = Object.values(flags.flags || {});
    const srcLabel = { override: 'set here', rollout: 'rollout', default: 'default', channel: 'beta only', min_version: 'needs a newer version' };
    return `
      ${card('Version', '',
        `<div class="row" style="gap:16px;padding-bottom:14px"><span class="metric">${esc(v.version || '—')}</span><div class="stack grow" style="gap:0"><span class="muted">${esc(msgs[status] || msgs.idle)}</span>${v.packaged === false ? '<span class="xs faint">Development build</span>' : ''}</div>
          ${status === 'available' ? `<button type="button" class="btn primary" data-action="update-download">${icon('download')}Download</button>` : ''}
          ${status === 'downloaded' ? `<button type="button" class="btn primary" data-action="update-install">${icon('refresh')}Restart and update</button>` : ''}
          ${!['available', 'downloaded', 'downloading'].includes(status) ? `<button type="button" class="btn" data-action="update-check" ${status === 'checking' ? 'disabled' : ''}>${status === 'checking' ? '<span class="spinner"></span>' : icon('refresh')}Check</button>` : ''}</div>
          ${status === 'downloading' ? `<div class="meter-row" style="padding-bottom:14px"><div class="bar thick"><span id="updateProgressBar" style="width:${pct}%"></span></div><span class="num">${pct}%</span></div>` : ''}
          ${st.releaseNotes && ['available', 'downloading', 'downloaded'].includes(status) ? `<div class="inset" style="margin-bottom:14px"><span class="eyebrow">What's new</span><div class="md sm">${C.md(st.releaseNotes)}</div></div>` : ''}
          ${row('Channel', 'Beta gets new features first, with more risk.', `<div class="segmented">${[['stable', 'Stable'], ['beta', 'Beta']].map(([val, label]) => `<button type="button" class="${channel === val ? 'active' : ''}" data-action="update-channel" data-channel="${val}">${label}</button>`).join('')}</div>`)}
          ${row('Update automatically', 'Downloads in the background and installs on restart.', cfgSwitch('auto_update', 'Automatic updates', cfg.auto_update !== false))}`)}
      ${card('Experimental features', esc(`Install ID ${String(flags.installId || '').slice(0, 8)} · last sync ${flags.lastFetch ? new Date(flags.lastFetch).toLocaleString('en-US') : 'never'}${flags.lastError ? ` · ${flags.lastError}` : ''}`),
        flagList.length
          ? flagList.map((f) => {
              const val = f.source === 'override' ? (f.enabled ? f.variant || 'on' : 'off') : 'default';
              const optsList = [['default', 'Default'], ['on', 'On'], ['off', 'Off'], ...(f.variants || []).map((x) => [x, `Variant ${x}`])];
              return `<div class="flag-row"><div class="stack grow" style="gap:0;min-width:0"><span class="row" style="gap:8px"><span class="dot ${f.enabled ? '' : 'off'}"></span><code class="mono" style="font-size:12px">${esc(f.key)}</code>${f.variant ? `<span class="tag">${esc(f.variant)}</span>` : ''}</span><span class="xs faint truncate">${esc(f.description || '')}${srcLabel[f.source] ? ` · ${srcLabel[f.source]}` : ''}</span></div><select class="select sm" style="width:150px" data-change="flag" data-key="${esc(f.key)}">${C.opts(optsList, val)}</select></div>`;
            }).join('')
          : '<div class="empty" style="padding:20px">No experimental features defined.</div>',
        `<div class="row"><button type="button" class="btn sm" data-action="flags-refresh">${icon('refresh')}Sync</button><button type="button" class="btn sm ghost" data-action="flags-reset">Restore defaults</button></div>`)}`;
  }

  const SECTIONS = { general, account, ai, audio, privacy, overlay, calendar, shortcuts, plan, updates };

  C.views.settings = function settings(parts) {
    const tab = SECTIONS[parts[0]] ? parts[0] : 'general';
    const label = (TABS.find((t) => t[0] === tab) || TABS[0])[1];
    return `<div class="page">
      ${C.head('Settings', 'Copilot, audio capture, privacy and account settings.')}
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
        await C.saveConfig({ [input.dataset.keyInput]: v }, `${input.dataset.label} key saved.`);
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
      const outputs = list.filter((d) => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d, i) => ({ deviceId: d.deviceId, label: clean(d.label, `Output ${i + 1}`) }));
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
      if (lbl) lbl.textContent = 'no access';
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
    const label = el.dataset.label || 'Setting';
    let val;
    if (el.dataset.type === 'bool') val = el.checked;
    else if (el.dataset.type === 'int' || el.dataset.type === 'float') {
      let n = el.dataset.type === 'int' ? parseInt(el.value, 10) : parseFloat(el.value);
      if (!Number.isFinite(n)) {
        C.toast(`${label}: enter a number.`, 'error');
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
    await C.saveConfig({ model: id }, `Answer model: ${m.model}.`);
    C.refresh();
  };

  C.changes.language = async (el) => {
    await C.saveConfig({ language: el.value, speech_language: el.value }, `Interview language: ${el.selectedOptions[0].textContent}.`);
  };

  C.changes['audio-device'] = async (el) => {
    const v = el.value;
    const label = el.selectedOptions[0] ? el.selectedOptions[0].textContent : v;
    if (el.dataset.kind === 'input') {
      await C.saveConfig({ audio_input_device: v, input_device: v }, `Microfone: ${label}.`);
      stopMicMeter();
      startMicMeter();
    } else {
      await C.saveConfig({ audio_output_device: v, output_device: v }, `Output: ${label}.`);
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
    C.toast('Test sound played.');
  };

  C.actions['clear-key'] = async (el) => {
    const ok = await C.confirm(`Remove the ${el.dataset.label} key?`, 'The copilot stops using this provider until you paste a new key.', 'Remove');
    if (!ok) return;
    await C.saveConfig({ [el.dataset.key]: '' }, `${el.dataset.label} key removed.`);
    C.refresh();
  };

  C.actions['set-theme'] = async (el) => {
    const res = await C.guard(() => api.setThemePreference(el.dataset.theme), 'Could not change the theme.');
    if (res) C.applyTheme(res);
    else C.applyTheme({ preference: el.dataset.theme, resolved: el.dataset.theme === 'light' ? 'light' : 'dark' });
    C.refresh();
  };

  C.changes.stealth = async (el) => {
    const res = await C.guard(() => api.setStealthMode({ [el.dataset.field]: el.checked }), 'Could not change it.');
    if (res && res.status) S.stealthState = res.status;
    await C.refreshState();
    C.renderShell();
    C.toast('Panel privacy updated.');
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
    await C.saveConfig({ process_disguise: mode }, `Process name: ${el.dataset.label}.`);
    C.refresh();
  };

  C.changes.meeting = async (el) => {
    const res = await C.guard(() => api.setMeetingDetection({ [el.dataset.field]: el.checked }), 'Could not change detection.');
    if (res) S.meeting = res;
    C.refresh();
  };
  C.actions['meeting-unmute'] = async () => {
    const res = await C.guard(() => api.setMeetingDetection({ mutedApps: [] }));
    if (res) S.meeting = res;
    C.toast('The alert shows again for all apps.');
    C.refresh();
  };
  C.actions['meeting-test'] = () => C.guard(() => api.testMeetingPopup(), 'Could not show the popup.');

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
        S.gcal.eventsError = (evs && evs.error) || 'Could not load the events.';
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
    const res = await C.guard(() => api.gcalImportClient(), 'Could not load the file.');
    if (res && res.status) S.gcal.status = res.status;
    if (res && res.ok) C.toast('OAuth client loaded. Now click Connect.');
    else if (res && !res.canceled) C.toast(res.error || 'Invalid file.', 'error');
    C.refresh();
  };
  C.actions['gcal-connect'] = async () => {
    S.gcal.busy = true;
    C.refresh();
    C.toast('Finish the Google sign-in in the browser.');
    const res = await C.guard(() => api.gcalConnect(), 'Google Calendar was not connected.');
    S.gcal.busy = false;
    if (res && res.status) S.gcal.status = res.status;
    if (res && res.ok) C.toast(res.status && res.status.email ? `Google Calendar connected: ${res.status.email}` : 'Google Calendar connected.');
    else if (res) C.toast(res.error || 'Google Calendar was not connected.', 'error');
    reloadCalendar();
  };
  C.actions['gcal-disconnect'] = async () => {
    const res = await C.guard(() => api.gcalDisconnect());
    if (res && res.status) S.gcal.status = res.status;
    S.gcal.events = null;
    C.toast('Google Calendar disconnected.');
    C.refresh();
  };
  C.changes['gcal-setting'] = async (el) => {
    const f = el.dataset.field;
    const v = f === 'autoSync' ? el.checked : f === 'reminderMin' ? Number(el.value) : el.value;
    const res = await C.guard(() => api.gcalSaveSettings({ [f]: v }), 'Could not save.');
    if (res && res.status) S.gcal.status = res.status;
    C.toast(f === 'autoSync' ? (v ? 'Scheduled interviews go to Google Calendar.' : 'Interviews stay only in Cue.') : 'Preference saved.');
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
    if (!title) return C.toast('Give the event a title.', 'error');
    if (!date) return C.toast('Pick a date.', 'error');
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
      C.toast(`Added to Google Calendar: ${title}`);
      reloadCalendar();
    } else C.toast((res && res.error) || 'Could not create the event.', 'error');
  };
  C.actions['gcal-open'] = async (el) => {
    const res = await C.guard(() => api.gcalOpen(el.dataset.url));
    if (res && !res.ok) C.toast(res.error || 'Could not open the event.', 'error');
  };
  C.actions['gcal-delete'] = async (el) => {
    const ok = await C.confirm(`Delete "${el.dataset.title || 'event'}" from Google Calendar?`, 'The event is removed from your calendar.', 'Delete');
    if (!ok) return;
    const cal = (S.gcal.status && S.gcal.status.calendarId) || 'primary';
    const res = await C.guard(() => api.gcalDeleteEvent(cal, el.dataset.id));
    C.toast(res && res.ok ? 'Event deleted.' : (res && res.error) || 'Could not delete.', res && res.ok ? '' : 'error');
    reloadCalendar();
  };
  C.actions['copy-text'] = async (el) => {
    try {
      await navigator.clipboard.writeText(el.dataset.text || '');
      C.toast('Copied.');
    } catch (_e) {
      C.toast(el.dataset.text || '');
    }
  };

  // Updates and flags
  C.actions['update-check'] = async () => {
    S.update = { ...(S.update || {}), status: 'checking' };
    C.refresh();
    const res = await C.guard(() => api.checkUpdate(), 'Error checking for updates.');
    if (res) S.update = res;
    C.refresh();
  };
  C.actions['update-download'] = async () => {
    S.update = { ...(S.update || {}), status: 'downloading', progress: { percent: 0 } };
    C.refresh();
    const res = await C.guard(() => api.downloadUpdate());
    if (res && res.ok === false) C.toast(`Download failed: ${res.error || 'unknown error'}`, 'error');
  };
  C.actions['update-install'] = async () => {
    const res = await C.guard(() => api.installUpdate());
    if (res && res.ok === false) C.toast(res.error || 'No update ready.', 'error');
    else C.toast('Restarting to update…');
  };
  C.actions['update-channel'] = async (el) => {
    const res = await C.guard(() => api.setUpdateChannel(el.dataset.channel), 'Could not change the channel.');
    if (res && res.ok) {
      S.config.update_channel = res.channel;
      if (res.flags) S.flags = res.flags;
      C.toast(`Update channel: ${res.channel === 'beta' ? 'Beta' : 'Stable'}.`);
      C.refresh();
    }
  };
  C.changes.flag = async (el) => {
    const res = await C.guard(() => api.setFlagOverride(el.dataset.key, el.value));
    if (res && res.ok === false) C.toast(res.error || 'Invalid value.', 'error');
    else if (res && res.flags) S.flags = res.flags;
    C.refresh();
  };
  C.actions['flags-refresh'] = async () => {
    const res = await C.guard(() => api.refreshFlags());
    if (res) S.flags = res;
    C.toast('Features synced.');
    C.refresh();
  };
  C.actions['flags-reset'] = async () => {
    const res = await C.guard(() => api.resetFlagOverrides());
    if (res && res.flags) S.flags = res.flags;
    C.toast('Defaults restored.');
    C.refresh();
  };
})();
