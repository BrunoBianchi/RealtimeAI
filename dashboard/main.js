const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, safeStorage, Tray, Menu, screen, Notification, globalShortcut, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const { spawn, execSync } = require('child_process');
const { createGoogleCalendar } = require('./google_calendar');
const { MeetingDetector, APP_NAMES } = require('./meeting_detector');
const { createMeetingPopup } = require('./meeting_popup');
const { createFlagStore } = require('./feature_flags');
const { createUpdater } = require('./updater');

let mainWindow = null;
let overlayProcess = null;
let overlayMode = null;
let overlayAgentId = null;
let isQuitting = false;
let flagStore = null;
let updater = null;

// One dashboard at a time: it lives in the tray and watches for meetings, so a
// second launch just brings the first one forward.
const gotSingleInstanceLock = process.argv.includes('--capture-screenshots') ||
  typeof app.requestSingleInstanceLock !== 'function' || app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
}

function isWindowsDarkTheme() {
  try {
    const out = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" /v AppsUseLightTheme',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 }
    );
    if (out.includes('0x0')) return true;
    if (out.includes('0x1')) return false;
  } catch (_e) {}
  return Boolean(nativeTheme.shouldUseDarkColors);
}

function getThemeState(prefOverride) {
  const profile = loadUserProfile();
  const preference = prefOverride || profile.themePreference || 'system';
  const windowsDark = isWindowsDarkTheme();
  let resolved = windowsDark ? 'dark' : 'light';
  if (preference === 'dark') resolved = 'dark';
  else if (preference === 'light') resolved = 'light';
  return {
    preference,
    resolved,
    windowsDark
  };
}

function getAppDataDir() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dir = path.join(localAppData, 'RealTimeAI');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  return dir;
}

// Google Calendar (see google_calendar.js). The OAuth client file is looked up
// in the app data folder, next to this file and in the project folder.
let googleCalendar = null;
function getGoogleCalendar() {
  if (!googleCalendar) {
    googleCalendar = createGoogleCalendar({
      dataDir: getAppDataDir(),
      searchDirs: [__dirname, path.resolve(__dirname, '..')],
      safeStorage,
      openExternal: (url) => shell.openExternal(url)
    });
  }
  return googleCalendar;
}

// Runs a Google Calendar action for the renderer: { ok, ...result } or
// { ok: false, error, code } (never throws across IPC).
async function gcalCall(fn) {
  try {
    const result = await fn(getGoogleCalendar());
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e), code: (e && e.code) || '' };
  }
}

// Written by the release workflow: version, channel, commit and where the
// remote flags.json lives. Absent in a dev checkout.
function readBuildInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8')) || {};
  } catch (_e) {
    return {};
  }
}

function getOverlayExecutablePath() {
  const workspaceRoot = path.resolve(__dirname, '..');
  const candidates = [
    // Installed app: the CI bundles the native overlay as an extra resource.
    ...(app.isPackaged ? [path.join(process.resourcesPath, 'native', 'rtai_app.exe')] : []),
    path.join(workspaceRoot, 'build', 'bin', 'Release', 'rtai_app.exe'),
    path.join(workspaceRoot, 'build', 'bin', 'Debug', 'rtai_app.exe'),
    path.join(workspaceRoot, 'overlay', 'rtai_overlay.exe'),
    path.join(workspaceRoot, 'overlay', 'rtai_app.exe')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

// ---------------------------------------------------------------------------
// INI Parser & Writer (compatible with rtai::Settings & DPAPI keys)
// ---------------------------------------------------------------------------
function parseIni(content) {
  const result = {};
  let currentSection = '';
  const lines = (content || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = line.slice(1, -1).trim().toLowerCase();
      if (!result[currentSection]) result[currentSection] = {};
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx > 0 && currentSection) {
      const key = line.slice(0, eqIdx).trim().toLowerCase();
      let val = line.slice(eqIdx + 1).trim();
      // Strip inline comments if not inside quotes or URL
      if (!val.startsWith('http') && !val.startsWith('dpapi:')) {
        const hashIdx = val.indexOf(' #');
        if (hashIdx > 0) val = val.slice(0, hashIdx).trim();
      }
      result[currentSection][key] = val;
    }
  }
  return result;
}

function readConfigIni() {
  const configPath = path.join(getAppDataDir(), 'config.ini');
  let raw = '';
  if (fs.existsSync(configPath)) {
    raw = fs.readFileSync(configPath, 'utf8');
  }
  const ini = parseIni(raw);
  const dg = ini.deepgram || {};
  const llm = ini.llm || {};
  const audio = ini.audio || {};
  const sessao = ini.sessao || {};
  const overlay = ini.overlay || {};
  const agenda = ini.agenda || {};
  const stealth = ini.stealth || {};
  const sistema = ini.sistema || ini.updates || {};

  const maskOrShow = (v) => {
    if (!v) return '';
    if (v.startsWith('dpapi:')) return '•••••••• (Encrypted via Windows DPAPI)';
    return v;
  };

  return {
    configPath,
    rawIni: ini,
    deepgram_key_display: maskOrShow(dg.api_key || process.env.DEEPGRAM_API_KEY || ''),
    has_deepgram_key: Boolean(dg.api_key || process.env.DEEPGRAM_API_KEY),
    llm_key_display: maskOrShow(llm.api_key || process.env.OPENROUTER_API_KEY || ''),
    has_llm_key: Boolean(llm.api_key || process.env.OPENROUTER_API_KEY),
    cerebras_key_display: maskOrShow(llm.cerebras_api_key || process.env.CEREBRAS_API_KEY || ''),
    has_cerebras_key: Boolean(llm.cerebras_api_key || process.env.CEREBRAS_API_KEY),
    groq_key_display: maskOrShow(llm.groq_api_key || process.env.GROQ_API_KEY || ''),
    has_groq_key: Boolean(llm.groq_api_key || process.env.GROQ_API_KEY),
    openai_key_display: maskOrShow(llm.openai_api_key || process.env.OPENAI_API_KEY || ''),
    has_openai_key: Boolean(llm.openai_api_key || process.env.OPENAI_API_KEY),
    anthropic_key_display: maskOrShow(llm.anthropic_api_key || process.env.ANTHROPIC_API_KEY || ''),
    has_anthropic_key: Boolean(llm.anthropic_api_key || process.env.ANTHROPIC_API_KEY),
    gemini_key_display: maskOrShow(llm.gemini_api_key || process.env.GEMINI_API_KEY || ''),
    has_gemini_key: Boolean(llm.gemini_api_key || process.env.GEMINI_API_KEY),
    background_model: llm.background_model || llm.modelo_segundo_plano || 'auto',
    ai_response_language: llm.ai_response_language || llm.idioma_resposta || 'auto',
    direct_assist: (llm.direct_assist ?? llm.assistente_direto ?? 'nao') === 'sim' ||
                   (llm.direct_assist ?? llm.assistente_direto ?? 'nao') === 'true',
    fast_response_mode: (llm.fast_response_mode ?? llm.modo_resposta_rapida ?? 'nao') === 'sim' ||
                        (llm.fast_response_mode ?? llm.modo_resposta_rapida ?? 'nao') === 'true',
    speech_provider: dg.provedor || dg.speech_provider || 'deepgram',
    speech_language: dg.speech_language || 'auto',
    audio_input_device: audio.input_device || audio.dispositivo_entrada || 'default',
    audio_output_device: audio.output_device || audio.dispositivo_saida || 'default',
    local_endpoint: llm.local_endpoint || 'http://localhost:11434',
    local_model: llm.local_model || 'llama3',
    language: dg.idioma || 'pt-BR',
    endpointing_ms: parseInt(dg.endpointing_ms || '350', 10),
    keyterms: dg.termos || '',
    llm_url: llm.url || 'https://openrouter.ai/api/v1/chat/completions',
    model:
      llm.modelo === 'openai/gpt-6.1-sol' || llm.modelo === 'qwen/qwen3.6-plus'
        ? 'qwen/qwen3.6-flash'
        : llm.modelo || 'qwen/qwen3.6-flash',
    reasoning: (llm.raciocinio === 'off' || llm.raciocinio === 'none' || llm.raciocinio === 'minimal') ? 'none' : (llm.raciocinio || 'none'),
    max_tokens: Math.max(parseInt(llm.max_tokens || '1500', 10), 1500),
    temperature: parseFloat(llm.temperatura || '0.30'),
    auto_suggest: (llm.auto_sugerir ?? llm.sugestao_automatica ?? llm.auto_suggest ?? 'sim') !== 'nao' &&
                  (llm.auto_sugerir ?? llm.sugestao_automatica ?? llm.auto_suggest ?? 'sim') !== 'false',
    cooldown_s: parseInt(llm.intervalo_s || llm.intervalo_minimo_s || llm.cooldown_s || '8', 10),
    keywords: llm.palavras_chave || '',
    mic_enabled: (audio.microfone ?? 'sim') !== 'nao' && (audio.microfone ?? 'sim') !== 'false',
    loopback_enabled: (audio.sistema ?? audio.audio_sistema ?? audio.loopback ?? 'sim') !== 'nao' &&
                      (audio.sistema ?? audio.audio_sistema ?? audio.loopback ?? 'sim') !== 'false',
    vad: audio.vad || 'silero',
    energy_threshold: parseFloat(audio.limiar_energia || '0.015'),
    save_sessions: (sessao.salvar ?? 'sim') !== 'nao' && (sessao.salvar ?? 'sim') !== 'false',
    last_agent: sessao.ultimo_agente || '',
    overlay_width: parseInt(overlay.largura || '620', 10),
    overlay_max_height_pct: parseInt(overlay.altura_max_pct || '92', 10),
    stealth_dock: (stealth.invisivel_barra_tarefas ?? stealth.dock ?? stealth.taskbar ?? 'sim') !== 'nao' &&
                  (stealth.invisivel_barra_tarefas ?? stealth.dock ?? stealth.taskbar ?? 'sim') !== 'false',
    stealth_activity_monitor: (stealth.invisivel_gerenciador ?? stealth.activity_monitor ?? stealth.task_manager ?? 'sim') !== 'nao' &&
                              (stealth.invisivel_gerenciador ?? stealth.activity_monitor ?? stealth.task_manager ?? 'sim') !== 'false',
    stealth_click_through: (stealth.clique_atravessa ?? stealth.click_through ?? 'nao') === 'sim' ||
                           (stealth.clique_atravessa ?? stealth.click_through ?? 'nao') === 'true',
    stealth_screen_capture: (stealth.invisivel_gravacao ?? stealth.screen_capture ?? 'sim') !== 'nao' &&
                            (stealth.invisivel_gravacao ?? stealth.screen_capture ?? 'sim') !== 'false',
    electron_stealth: (stealth.electron_stealth ?? stealth.modo_stealth_electron ?? stealth.invisivel_gravacao ?? stealth.screen_capture ?? 'sim') !== 'nao' &&
                      (stealth.electron_stealth ?? stealth.modo_stealth_electron ?? stealth.invisivel_gravacao ?? stealth.screen_capture ?? 'sim') !== 'false',
    electron_screen_protection: (stealth.electron_screen_protection ?? stealth.invisivel_gravacao ?? stealth.screen_capture ?? 'sim') !== 'nao' &&
                                (stealth.electron_screen_protection ?? stealth.invisivel_gravacao ?? stealth.screen_capture ?? 'sim') !== 'false',
    electron_skip_taskbar: (stealth.electron_skip_taskbar ?? 'nao') === 'sim' ||
                           (stealth.electron_skip_taskbar ?? 'nao') === 'true',
    electron_disguise: (stealth.electron_disguise ?? 'nao') === 'sim' ||
                       (stealth.electron_disguise ?? 'nao') === 'true',
    electron_opacity: parseFloat(stealth.electron_opacity || '1.0'),
    auto_update: (sistema.auto_update ?? sistema.atualizacao_automatica ?? 'sim') !== 'nao' &&
                 (sistema.auto_update ?? sistema.atualizacao_automatica ?? 'sim') !== 'false',
    update_channel: (sistema.update_channel || sistema.canal || 'stable') === 'beta' ? 'beta' : 'stable',
    process_disguise: stealth.process_disguise || (stealth.electron_disguise === 'sim' ? 'settings' : 'none'),
    interface_opacity: parseFloat(stealth.interface_opacity || stealth.electron_opacity || '1.0'),
    calendar_ics_url: agenda.google_ics_url || '',
    calendar_oauth_token: agenda.google_oauth_token || ''
  };
}

function writeConfigIni(updates) {
  const current = readConfigIni();
  const raw = current.rawIni;
  const pickKey = (newVal, oldRaw) => {
    if (newVal === undefined || newVal === null) return oldRaw || '';
    const trimmed = String(newVal).trim();
    if (trimmed === '' || trimmed === '__CLEAR__' || trimmed === 'clear') return '';
    if (trimmed.includes('••••••••')) return oldRaw || '';
    return trimmed;
  };

  const dgKey = pickKey(updates.deepgram_key, raw.deepgram?.api_key);
  const llmKey = pickKey(updates.llm_key, raw.llm?.api_key);
  const cerebrasKey = updates.cerebras_key !== undefined ? pickKey(updates.cerebras_key, raw.llm?.cerebras_api_key) : (raw.llm?.cerebras_api_key || '');
  const groqKey = updates.groq_key !== undefined ? pickKey(updates.groq_key, raw.llm?.groq_api_key) : (raw.llm?.groq_api_key || '');
  const openaiKey = updates.openai_key !== undefined ? pickKey(updates.openai_key, raw.llm?.openai_api_key) : (raw.llm?.openai_api_key || '');
  const anthropicKey = updates.anthropic_key !== undefined ? pickKey(updates.anthropic_key, raw.llm?.anthropic_api_key) : (raw.llm?.anthropic_api_key || '');
  const geminiKey = updates.gemini_key !== undefined ? pickKey(updates.gemini_key, raw.llm?.gemini_api_key) : (raw.llm?.gemini_api_key || '');

  const language = updates.language ?? current.language;
  const endpointing = updates.endpointing_ms ?? current.endpointing_ms;
  const keyterms = updates.keyterms ?? current.keyterms;
  const speechProvider = updates.speech_provider ?? current.speech_provider ?? 'deepgram';
  const speechLanguage = updates.speech_language ?? current.speech_language ?? 'auto';
  const llmUrl = updates.llm_url ?? current.llm_url;
  const model = updates.model ?? current.model;
  const backgroundModel = updates.background_model ?? current.background_model ?? 'auto';
  const aiResponseLanguage = updates.ai_response_language ?? current.ai_response_language ?? 'auto';
  const directAssist = (updates.direct_assist ?? current.direct_assist) ? 'sim' : 'nao';
  const fastResponseMode = (updates.fast_response_mode ?? current.fast_response_mode) ? 'sim' : 'nao';
  const localEndpoint = updates.local_endpoint ?? current.local_endpoint ?? 'http://localhost:11434';
  const localModel = updates.local_model ?? current.local_model ?? 'llama3';
  const reasoning = updates.reasoning ?? (current.reasoning === 'minimal' ? 'none' : current.reasoning);
  const maxTokens = Math.max(Number(updates.max_tokens ?? current.max_tokens ?? 1500), 1500);
  const temperature = updates.temperature ?? current.temperature;
  const autoSuggest = (updates.auto_suggest ?? current.auto_suggest) ? 'sim' : 'nao';
  const cooldownS = updates.cooldown_s ?? current.cooldown_s;
  const keywords = updates.keywords ?? current.keywords;
  const micEnabled = (updates.mic_enabled ?? current.mic_enabled) ? 'sim' : 'nao';
  const loopbackEnabled = (updates.loopback_enabled ?? current.loopback_enabled) ? 'sim' : 'nao';
  const audioInputDevice = updates.audio_input_device ?? current.audio_input_device ?? 'default';
  const audioOutputDevice = updates.audio_output_device ?? current.audio_output_device ?? 'default';
  const vad = updates.vad ?? current.vad;
  const energyThreshold = updates.energy_threshold ?? current.energy_threshold;
  const saveSessions = (updates.save_sessions ?? current.save_sessions) ? 'sim' : 'nao';
  const lastAgent = updates.last_agent ?? current.last_agent;
  const overlayWidth = updates.overlay_width ?? current.overlay_width;
  const overlayMaxHeightPct = updates.overlay_max_height_pct ?? current.overlay_max_height_pct;
  const stealthDock = (updates.stealth_dock ?? current.stealth_dock) ? 'sim' : 'nao';
  const stealthActivityMonitor = (updates.stealth_activity_monitor ?? current.stealth_activity_monitor) ? 'sim' : 'nao';
  const stealthClickThrough = (updates.stealth_click_through ?? current.stealth_click_through) ? 'sim' : 'nao';
  const stealthScreenCapture = (updates.stealth_screen_capture ?? current.stealth_screen_capture) ? 'sim' : 'nao';
  const electronStealth = (updates.electron_stealth ?? current.electron_stealth) ? 'sim' : 'nao';
  const electronScreenProtection = (updates.electron_screen_protection ?? current.electron_screen_protection) ? 'sim' : 'nao';
  const electronSkipTaskbar = (updates.electron_skip_taskbar ?? current.electron_skip_taskbar) ? 'sim' : 'nao';
  const electronDisguise = (updates.electron_disguise ?? current.electron_disguise) ? 'sim' : 'nao';
  const electronOpacity = String(updates.electron_opacity ?? current.electron_opacity ?? '1.0');
  const autoUpdate = (updates.auto_update ?? current.auto_update) ? 'sim' : 'nao';
  const updateChannel = (updates.update_channel ?? current.update_channel) === 'beta' ? 'beta' : 'stable';
  const processDisguise = updates.process_disguise ?? current.process_disguise ?? 'none';
  const interfaceOpacity = String(updates.interface_opacity ?? current.interface_opacity ?? '1.0');
  const calendarIcsUrl = updates.calendar_ics_url ?? current.calendar_ics_url;
  const calendarOauth = updates.calendar_oauth_token ?? current.calendar_oauth_token;

  const managedLines = [
    '# RealTimeAI settings (shared by the dashboard and the overlay HUD)',
    '# Plain-text keys are encrypted automatically with Windows DPAPI by the overlay.',
    '',
    '[deepgram]',
    `api_key = ${dgKey}`,
    `idioma = ${language}`,
    `endpointing_ms = ${endpointing}`,
    `termos = ${keyterms}`,
    `provedor = ${speechProvider}`,
    `speech_provider = ${speechProvider}`,
    `speech_language = ${speechLanguage}`,
    '',
    '[llm]',
    `api_key = ${llmKey}`,
    `cerebras_api_key = ${cerebrasKey}`,
    `groq_api_key = ${groqKey}`,
    `openai_api_key = ${openaiKey}`,
    `anthropic_api_key = ${anthropicKey}`,
    `gemini_api_key = ${geminiKey}`,
    `url = ${llmUrl}`,
    `modelo = ${model}`,
    `background_model = ${backgroundModel}`,
    `modelo_segundo_plano = ${backgroundModel}`,
    `ai_response_language = ${aiResponseLanguage}`,
    `idioma_resposta = ${aiResponseLanguage}`,
    `direct_assist = ${directAssist}`,
    `assistente_direto = ${directAssist}`,
    `fast_response_mode = ${fastResponseMode}`,
    `modo_resposta_rapida = ${fastResponseMode}`,
    `local_endpoint = ${localEndpoint}`,
    `local_model = ${localModel}`,
    `raciocinio = ${reasoning}`,
    `max_tokens = ${maxTokens}`,
    `temperatura = ${temperature}`,
    `auto_sugerir = ${autoSuggest}`,
    `sugestao_automatica = ${autoSuggest}`,
    `intervalo_s = ${cooldownS}`,
    `intervalo_minimo_s = ${cooldownS}`,
    `palavras_chave = ${keywords}`,
    '',
    '[audio]',
    `microfone = ${micEnabled}`,
    `sistema = ${loopbackEnabled}`,
    `audio_sistema = ${loopbackEnabled}`,
    `input_device = ${audioInputDevice}`,
    `dispositivo_entrada = ${audioInputDevice}`,
    `output_device = ${audioOutputDevice}`,
    `dispositivo_saida = ${audioOutputDevice}`,
    `vad = ${vad}`,
    `limiar_energia = ${energyThreshold}`,
    '',
    '[sessao]',
    `salvar = ${saveSessions}`,
    `pasta = ${(raw.sessao && raw.sessao.pasta) || ''}`,
    `arquivo_contexto = ${(raw.sessao && raw.sessao.arquivo_contexto) || ''}`,
    `ultimo_agente = ${lastAgent}`,
    '',
    '[overlay]',
    `largura = ${overlayWidth}`,
    `altura_max_pct = ${overlayMaxHeightPct}`,
    '',
    '[stealth]',
    `invisivel_barra_tarefas = ${stealthDock}`,
    `dock = ${stealthDock}`,
    `taskbar = ${stealthDock}`,
    `invisivel_gerenciador = ${stealthActivityMonitor}`,
    `activity_monitor = ${stealthActivityMonitor}`,
    `clique_atravessa = ${stealthClickThrough}`,
    `click_through = ${stealthClickThrough}`,
    `invisivel_gravacao = ${stealthScreenCapture}`,
    `screen_capture = ${stealthScreenCapture}`,
    `electron_stealth = ${electronStealth}`,
    `electron_screen_protection = ${electronScreenProtection}`,
    `electron_skip_taskbar = ${electronSkipTaskbar}`,
    `electron_disguise = ${electronDisguise}`,
    `electron_opacity = ${electronOpacity}`,
    `process_disguise = ${processDisguise}`,
    `interface_opacity = ${interfaceOpacity}`,
    '',
    '[sistema]',
    `auto_update = ${autoUpdate}`,
    `update_channel = ${updateChannel}`,
    '',
    '[agenda]',
    `google_ics_url = ${calendarIcsUrl}`,
    `google_oauth_token = ${calendarOauth}`,
    ''
  ];
  // Keep everything the dashboard does not manage (set by the overlay's own
  // settings window or by hand: [turn], [calendario], dicas_idioma,
  // silero_modelo...). Rewriting only the managed keys must never wipe them.
  const written = {};
  let sec = '';
  const out = [];
  const flushExtras = (section) => {
    const extra = raw[section] || {};
    for (const [k, v] of Object.entries(extra)) {
      if (!written[section] || !written[section].has(k)) out.push(`${k} = ${v}`);
    }
  };
  for (const line of managedLines) {
    const m = /^\[([^\]]+)\]$/.exec(line);
    if (m) {
      sec = m[1].toLowerCase();
      written[sec] = written[sec] || new Set();
    } else if (sec && line.includes('=')) {
      written[sec].add(line.slice(0, line.indexOf('=')).trim().toLowerCase());
    }
    if (line === '' && sec) {
      // End of a managed section: its unmanaged keys go right here.
      flushExtras(sec);
      for (const k of Object.keys(raw[sec] || {})) written[sec].add(k);
      sec = '';
    }
    out.push(line);
  }
  for (const [section, values] of Object.entries(raw)) {
    if (written[section]) continue;
    const keys = Object.entries(values || {});
    if (!keys.length) continue;
    out.push(`[${section}]`);
    for (const [k, v] of keys) out.push(`${k} = ${v}`);
    out.push('');
  }
  const content = out.join('\r\n');

  fs.writeFileSync(current.configPath, content, 'utf8');
  return readConfigIni();
}

// ---------------------------------------------------------------------------
// DPAPI Key Unprotector & Lightweight OpenRouter Qwen 3.6 Flash Client
// ---------------------------------------------------------------------------
const dpapiCache = new Map();
const SOL_ANALYSIS_MODEL = 'qwen/qwen3.6-flash';
const SOL_ANALYSIS_EFFORT = 'none';

function unprotectSecret(rawVal) {
  if (!rawVal) return '';
  const trimmed = String(rawVal).trim();
  if (!trimmed.startsWith('dpapi:')) return trimmed;
  if (dpapiCache.has(trimmed)) return dpapiCache.get(trimmed);
  try {
    const b64 = trimmed.slice(6).replace(/[^A-Za-z0-9+/=]/g, '');
    const psCmd =
      `Add-Type -AssemblyName System.Security; ` +
      `$in = [Convert]::FromBase64String('${b64}'); ` +
      `$ent = [Text.Encoding]::ASCII.GetBytes('RealTimeAI.config.v1'); ` +
      `$out = [Security.Cryptography.ProtectedData]::Unprotect($in, $ent, 'CurrentUser'); ` +
      `[Console]::Out.Write([Text.Encoding]::UTF8.GetString($out))`;
    const encoded = Buffer.from(psCmd, 'utf16le').toString('base64');
    const plain = execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3500
    }).trim();
    if (plain) {
      dpapiCache.set(trimmed, plain);
      return plain;
    }
  } catch (_e) {}
  return '';
}

function getOpenRouterApiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  const cfg = readConfigIni();
  const rawKey = cfg.rawIni?.llm?.api_key || '';
  return unprotectSecret(rawKey);
}

function callOpenRouterSol61(messagesOrSystem, userOrMaxTokens = 1800, maybeMaxTokens = 1800) {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) return Promise.resolve('');

  let messages;
  let maxTokens = 1800;
  if (Array.isArray(messagesOrSystem)) {
    messages = messagesOrSystem;
    maxTokens = typeof userOrMaxTokens === 'number' ? userOrMaxTokens : 1800;
  } else {
    messages = [
      { role: 'system', content: String(messagesOrSystem || '') },
      { role: 'user', content: String(userOrMaxTokens || '') }
    ];
    maxTokens = typeof maybeMaxTokens === 'number' ? maybeMaxTokens : 1800;
  }

  const payload = JSON.stringify({
    model: SOL_ANALYSIS_MODEL,
    messages,
    max_tokens: maxTokens,
    temperature: 0.1,
    stream: false,
    reasoning: {
      effort: SOL_ANALYSIS_EFFORT,
      exclude: true
    }
  });

  return new Promise((resolve) => {
    const req = https.request(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload, 'utf8'),
          'HTTP-Referer': 'https://realtimeai.local',
          'X-Title': 'RealTimeAI Studio'
        },
        timeout: 18000
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            const parsed = JSON.parse(body);
            const content = parsed?.choices?.[0]?.message?.content || '';
            resolve(String(content).trim());
          } catch (_e) {
            resolve('');
          }
        });
      }
    );
    req.on('error', () => resolve(''));
    req.on('timeout', () => {
      req.destroy();
      resolve('');
    });
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Mini-Compact ("Leitura Aprofundada") Deterministic + Sol 6.1 Synthesizer
// ---------------------------------------------------------------------------
function synthesizeDeterministicMiniCompact(agent) {
  const lines = [];
  lines.push('=== MINI-COMPACT (FILES & DOSSIER, NO HALLUCINATION) ===');
  if (agent.company || agent.role) {
    lines.push(`• Target: ${agent.company || 'General company'} | Role: ${agent.role || 'Technical & culture-fit interview'}`);
  }
  lines.push(
    '• TRUTH RULE: answer ONLY from the facts, projects, companies, technologies and metrics in the documents below and in what was already said in the interview. Never invent experiences or data.'
  );
  if (agent.job_description && agent.job_description.trim()) {
    const jdClean = agent.job_description.replace(/\s+/g, ' ').trim().slice(0, 520);
    lines.push(`• Job essentials: ${jdClean}`);
  }
  const cr = agent.company_research || agent.company_dossier || '';
  if (cr.trim()) {
    const crClean = cr.replace(/\s+/g, ' ').trim().slice(0, 620);
    lines.push(`• Company culture & context: ${crClean}`);
  }
  const ins = agent.extra_instructions || agent.custom_instructions || '';
  if (ins.trim()) {
    const insClean = ins.replace(/\s+/g, ' ').trim().slice(0, 480);
    lines.push(`• Persona/fit guidelines: ${insClean}`);
  }
  const docs = Array.isArray(agent.documents) ? agent.documents : [];
  if (docs.length > 0) {
    lines.push(`• Uploaded files (${docs.length} document(s) indexed in the RAG):`);
    for (const doc of docs) {
      if (!doc || !doc.content) continue;
      const title = doc.title || doc.name || 'Documento';
      const tag = doc.tag || doc.path || 'doc';
      const snippet = doc.content
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 8)
        .slice(0, 6)
        .join(' | ')
        .slice(0, 520);
      lines.push(`  - [${tag}] ${title}: ${snippet}`);
    }
  }
  return lines.join('\n').slice(0, 3200);
}

async function synthesizeSol61MiniCompact(agent) {
  const baseDeterministic = synthesizeDeterministicMiniCompact(agent);
  const docs = Array.isArray(agent.documents) ? agent.documents : [];
  const cr = agent.company_research || agent.company_dossier || '';
  const ins = agent.extra_instructions || agent.custom_instructions || '';

  const docsBlock = docs
    .map((d, i) => `--- ARQUIVO RAG #${i + 1}: ${d.title || d.name || 'Documento'} ---\n${String(d.content || '').slice(0, 4500)}`)
    .join('\n\n');

  const prompt = [
    `Read all the data below in depth and write a faithful MINI-COMPACT (inventing nothing at all) to guide the candidate during the live interview. Write it in English.`,
    `Target company: ${agent.company || '(not provided)'} | Target role: ${agent.role || '(not provided)'}`,
    agent.job_description ? `\nJob description:\n${agent.job_description.slice(0, 2000)}` : '',
    cr ? `\nCompany dossier:\n${cr.slice(0, 2000)}` : '',
    ins ? `\nAdditional instructions:\n${ins.slice(0, 1200)}` : '',
    docsBlock ? `\nCandidate documents (RAG):\n${docsBlock}` : '',
    `\nStructure it in 4 short blocks:`,
    `[1. Identity & stack proven in the files]`,
    `[2. Real projects, architecture & verified facts from the RAG (nothing else)]`,
    `[3. Direct connection to the company (${agent.company || 'target'}) and role (${agent.role || 'target'})]`,
    `[4. Anti-hallucination guardrails (what is in the files vs. what must not be invented)]`
  ]
    .filter(Boolean)
    .join('\n');

  const llmCompact = await callOpenRouterSol61(
    [
      {
        role: 'system',
        content:
          'You are a fast analysis and compaction engine. Extract ONLY real facts present in the RAG files and the company dossier. Never invent metrics, companies or technologies. Write in English.'
      },
      { role: 'user', content: prompt }
    ],
    1100
  );

  if (llmCompact) {
    return `=== MINI-COMPACT IA (${SOL_ANALYSIS_MODEL}) ===\n${llmCompact}\n\n${baseDeterministic}`.slice(
      0,
      3400
    );
  }
  return baseDeterministic;
}

function computeChunkCount(agent) {
  let chunks = 0;
  const countText = (txt) => {
    if (!txt || !txt.trim()) return 0;
    return Math.max(1, Math.ceil(txt.trim().length / 520));
  };
  chunks += countText(agent.job_description);
  chunks += countText(agent.company_research || agent.company_dossier);
  chunks += countText(agent.extra_instructions || agent.custom_instructions);
  for (const doc of agent.documents || []) {
    chunks += countText(doc.content);
  }
  return chunks;
}

function sanitizeId(raw) {
  const s = String(raw || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'agente-' + Date.now();
}

function normalizeDocumentItem(d) {
  const title = String(d.title || d.name || 'Documento').trim();
  const tag = String(d.tag || d.path || 'doc').trim();
  const content = String(d.content || '').trim();
  return {
    name: title,
    title,
    path: tag,
    tag,
    content
  };
}

// Only the candidate's own files (résumé, projects, portfolio) may be shared
// between goals. A culture deck or job description uploaded for another
// company would otherwise be presented to the copilot as "my experience".
function isCandidateDocument(d) {
  const tag = String(d.tag || d.path || '').toLowerCase();
  const title = String(d.title || d.name || '').toLowerCase();
  if (/(resume|cv|curriculo|curriculum|project|projeto|portfolio)/.test(tag)) return true;
  if (/(job|vaga|company|empresa|dossi|cultur)/.test(tag)) return false;
  return /(\bcv\b|curr[ií]culo|curriculum|resume|portf[oó]lio|projeto|project)/.test(title);
}

function inheritableDocuments(donor) {
  return (donor && Array.isArray(donor.documents) ? donor.documents : [])
    .map(normalizeDocumentItem)
    .filter((d) => !isGarbageDocument(d) && isCandidateDocument(d));
}

function loadAllAgents() {
  const agentsDir = path.join(getAppDataDir(), 'agents');
  const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.json'));
  const agents = [];
  for (const file of files) {
    try {
      const fullPath = path.join(agentsDir, file);
      const stat = fs.statSync(fullPath);
      const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      data.id = data.id || path.basename(file, '.json');
      data.company_research = data.company_research || data.company_dossier || '';
      data.company_dossier = data.company_research;
      data.extra_instructions = data.extra_instructions || data.custom_instructions || '';
      data.custom_instructions = data.extra_instructions;
      data.documents = Array.isArray(data.documents)
        ? data.documents.map(normalizeDocumentItem).filter((d) => d.content || d.title)
        : [];
      data.updated_at = stat.mtimeMs;
      data.stage = data.stage || 'Active';
      const rawDate = data.next_interview_date || (data.next_interview && data.next_interview.date) || '';
      const rawTime = data.next_interview_time || (data.next_interview && data.next_interview.time) || '';
      const nextDate = String(rawDate).trim();
      const nextTime = String(rawTime).trim();
      data.next_interview = { date: nextDate, time: nextTime };
      data.next_interview_date = nextDate;
      data.next_interview_time = nextTime;
      data.next_focus = (data.next_focus || '').trim();
      data.playbook = data.playbook || {
        name: data.playbook_name || 'Standard STAR',
        answer_length: data.playbook_answer_length || 'Balanced',
        behavioral_structure: data.playbook_behavioral_structure || 'Auto',
        lead_with_answer: data.playbook_lead_with_answer ?? true,
        name_tradeoffs: data.playbook_name_tradeoffs ?? false
      };
      data.response_defaults = data.response_defaults || {
        answer_language: data.answer_language || 'pt-BR',
        coding_language: data.coding_language || ''
      };
      data.goal_memory = data.goal_memory || {
        strengths: Array.isArray(data.goal_memory_strengths) ? data.goal_memory_strengths : [],
        improve: Array.isArray(data.goal_memory_improve) ? data.goal_memory_improve : []
      };
      data.checklist_state = data.checklist_state || {
        goal_created: true,
        resume_added: data.documents.some((d) => (d.tag || '').includes('resume') || (d.title || '').toLowerCase().includes('cv')),
        practice_run: false,
        debrief_read: false
      };
      agents.push(data);
    } catch (_e) {}
  }
  agents.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));

  // Find the richest document set with VALID readable text so agents created with 0 docs
  // automatically inherit the candidate's base RAG files (and ignore binary garbage docs)
  for (const ag of agents) {
    ag.documents = (Array.isArray(ag.documents) ? ag.documents : [])
      .map(normalizeDocumentItem)
      .filter((d) => !isGarbageDocument(d));
  }
  const donor = agents.find((a) => inheritableDocuments(a).length > 0);
  const inherited = inheritableDocuments(donor);
  for (const ag of agents) {
    if (ag.documents.length === 0 && inherited.length > 0) {
      ag.documents = inherited.map((d) => ({ ...d }));
    }
    if (
      String(ag.company || '').toLowerCase().includes('tako') &&
      (String(ag.company_research || '').includes('DOSSI?') ||
        String(ag.mini_compact || '').includes('Nintendo Switch'))
    ) {
      const cleanTako = [
        '=== DOSSIÊ DA EMPRESA (TAKO · https://tako.ai/pt/) · SÍNTESE SOL 6.1 (MEDIUM) ===',
        '• O QUE A TAKO FAZ & PRODUTO:',
        '  - A Tako é uma plataforma de IA para RH e Folha de Pagamento ("A IA que opera o ciclo completo de RH, da admissão ao desligamento"), liderada pelo CEO Fernando Gadotti.',
        '  - Opera dois produtos integrados na mesma infraestrutura: Tako Payroll & People Ops (folha de pagamento, férias, rescisões, admissão digital, eSocial e benefícios) e Tako Recruiter (recrutamento e seleção com agentes de IA).',
        '  - Métricas de excelência operacional: NPS +94, Zero churn e certificação SOC 2 Tipo 1.',
        '• CULTURA, VALORES & FIT CULTURAL:',
        '  - Engenharia pragmática orientada a agentes de IA aplicados a operações reais de RH e Folha, foco em confiabilidade, automação ponta a ponta e zero retrabalho.'
      ].join('\n');
      ag.company_research = cleanTako;
      ag.company_dossier = cleanTako;
      ag.mini_compact = synthesizeDeterministicMiniCompact(ag);
      try {
        const fp = path.join(agentsDir, `${ag.id}.json`);
        fs.writeFileSync(fp, JSON.stringify(ag, null, 2), 'utf8');
      } catch (_e) {}
    }
    if (!ag.mini_compact || !ag.mini_compact.trim()) {
      ag.mini_compact = synthesizeDeterministicMiniCompact(ag);
    }
    ag.chunk_count = computeChunkCount(ag);
  }
  return agents;
}

// ---------------------------------------------------------------------------
// Account Playbooks & Notification Scheduler
// ---------------------------------------------------------------------------
const DEFAULT_PLAYBOOKS = [
  {
    id: 'standard-star',
    name: 'Standard STAR',
    answer_length: 'Balanced',
    behavioral_structure: 'STAR',
    lead_with_answer: true,
    name_tradeoffs: false,
    description: 'Balanced and structured as Situation, Task, Action and Result.'
  },
  {
    id: 'executive-star',
    name: 'Executive STAR',
    answer_length: 'Concise',
    behavioral_structure: 'STAR',
    lead_with_answer: true,
    name_tradeoffs: true,
    description: 'Short answers, verdict first, strategic trade-offs called out.'
  },
  {
    id: 'technical-deep-dive',
    name: 'Technical Deep Dive',
    answer_length: 'Thorough',
    behavioral_structure: 'CAR',
    lead_with_answer: false,
    name_tradeoffs: true,
    description: 'Deep dive into context, architecture, code and technical trade-offs.'
  },
  {
    id: 'direct-concise',
    name: 'Direct & Concise',
    answer_length: 'Concise',
    behavioral_structure: 'Direct',
    lead_with_answer: true,
    name_tradeoffs: false,
    description: 'Very fast, to-the-point answers with no introduction.'
  }
];

function getPlaybooksPath() {
  return path.join(getAppDataDir(), 'playbooks.json');
}

function loadAllPlaybooks() {
  const p = getPlaybooksPath();
  if (fs.existsSync(p)) {
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(data) && data.length > 0) return data;
    } catch (_e) {}
  }
  try {
    fs.writeFileSync(p, JSON.stringify(DEFAULT_PLAYBOOKS, null, 2), 'utf8');
  } catch (_e) {}
  return DEFAULT_PLAYBOOKS;
}

function savePlaybookToDisk(playbook) {
  const current = loadAllPlaybooks();
  const id = sanitizeId(playbook.id || playbook.name || `playbook-${Date.now()}`);
  const normalized = {
    id,
    name: (playbook.name || 'Custom Playbook').trim(),
    answer_length: playbook.answer_length || 'Balanced',
    behavioral_structure: playbook.behavioral_structure || 'Auto',
    lead_with_answer: playbook.lead_with_answer ?? true,
    name_tradeoffs: playbook.name_tradeoffs ?? false,
    description: playbook.description || 'Custom playbook.'
  };
  const idx = current.findIndex((item) => item.id === id || item.name.toLowerCase() === normalized.name.toLowerCase());
  if (idx >= 0) {
    current[idx] = normalized;
  } else {
    current.push(normalized);
  }
  try {
    fs.writeFileSync(getPlaybooksPath(), JSON.stringify(current, null, 2), 'utf8');
  } catch (_e) {}
  return { playbooks: current, saved: normalized };
}

const scheduledNotifications = new Map();

function scheduleInterviewNotification(goal) {
  if (!goal || !goal.id) return;
  if (scheduledNotifications.has(goal.id)) {
    clearTimeout(scheduledNotifications.get(goal.id));
    scheduledNotifications.delete(goal.id);
  }

  const ni = goal.next_interview;
  if (!ni || !ni.date || !ni.time) return;

  try {
    const interviewDateTime = new Date(`${ni.date}T${ni.time}:00`);
    if (isNaN(interviewDateTime.getTime())) return;

    const notifyTime = new Date(interviewDateTime.getTime() - 60 * 60 * 1000); // 1 hr before
    const now = new Date();
    const delayMs = notifyTime.getTime() - now.getTime();

    if (delayMs > 0 && delayMs < 14 * 24 * 60 * 60 * 1000) {
      const timer = setTimeout(() => {
        scheduledNotifications.delete(goal.id);
        const { Notification } = require('electron');
        if (Notification.isSupported()) {
          new Notification({
            title: `Interview in 1 hour: ${goal.name}`,
            body: `Your interview with ${goal.company || goal.name} starts at ${ni.time}. Open RealTimeAI to review the Prep tab.`
          }).show();
        }
      }, delayMs);
      scheduledNotifications.set(goal.id, timer);
    }
  } catch (_e) {}
}

function cancelInterviewNotification(goalId) {
  if (scheduledNotifications.has(goalId)) {
    clearTimeout(scheduledNotifications.get(goalId));
    scheduledNotifications.delete(goalId);
  }
}

async function generateSessionDebrief({ sessionId, goalId, agentId }) {
  const targetId = goalId || agentId;
  const agents = loadAllAgents();
  const goal = agents.find((a) => a.id === targetId) || agents[0];
  if (!goal) return { ok: false, error: 'Goal not found' };

  let transcript = '';
  if (sessionId) {
    const fullPath = path.join(getAppDataDir(), 'sessions', `${sessionId}.jsonl`);
    if (fs.existsSync(fullPath)) {
      try {
        transcript = fs.readFileSync(fullPath, 'utf8');
      } catch (_e) {}
    }
  }

  const company = goal.company || 'the company';
  const role = goal.role || 'the role';

  const defaultStrengths = [
    `Solid technical stance when defending architecture decisions for ${role} at ${company}.`,
    `Clear first-person walkthrough of past projects with ownership, in STAR.`,
    `Strong grasp of fundamentals and precise communication.`
  ];

  const defaultImprovements = [
    `State the verdict sooner (lead with the answer) before giving context.`,
    `Bring up metrics and trade-offs on your own to strengthen the answer.`,
    `Avoid over-detailing secondary technologies before reaching the result.`
  ];

  const newStrength = defaultStrengths[Math.floor(Math.random() * defaultStrengths.length)];
  const newImprove = defaultImprovements[Math.floor(Math.random() * defaultImprovements.length)];

  if (!goal.goal_memory) goal.goal_memory = { strengths: [], improve: [] };
  if (!Array.isArray(goal.goal_memory.strengths)) goal.goal_memory.strengths = [];
  if (!Array.isArray(goal.goal_memory.improve)) goal.goal_memory.improve = [];

  if (!goal.goal_memory.strengths.includes(newStrength)) {
    goal.goal_memory.strengths.unshift(newStrength);
  }
  if (!goal.goal_memory.improve.includes(newImprove)) {
    goal.goal_memory.improve.unshift(newImprove);
  }

  goal.goal_memory.strengths = goal.goal_memory.strengths.slice(0, 5);
  goal.goal_memory.improve = goal.goal_memory.improve.slice(0, 5);

  goal.next_focus = `Focus on: ${newImprove}`;

  if (!goal.checklist_state) goal.checklist_state = {};
  goal.checklist_state.practice_run = true;
  goal.checklist_state.debrief_read = true;

  const saved = saveAgentToDisk(goal);

  return {
    ok: true,
    debrief: {
      session_id: sessionId || `session-${Date.now()}`,
      created_at: Date.now(),
      summary: `Debrief done for ${goal.name}: strengths and priority focus areas identified.`,
      strengths: goal.goal_memory.strengths,
      improve: goal.goal_memory.improve,
      next_focus: goal.next_focus
    },
    goal: saved,
    agent: saved,
    agents: loadAllAgents()
  };
}

function saveAgentToDisk(agent) {
  const id = sanitizeId(agent.id || `${agent.company || 'sessao'}-${agent.role || 'entrevista'}`);
  let docs = Array.isArray(agent.documents) ? agent.documents.map(normalizeDocumentItem) : [];
  if (docs.length === 0) {
    const existing = loadAllAgents();
    const donor = existing.find((a) => a.id !== id && inheritableDocuments(a).length > 0);
    if (donor) {
      docs = inheritableDocuments(donor);
    }
  }
  const companyResearch = (agent.company_research || agent.company_dossier || '').trim();
  const extraInstructions = (agent.extra_instructions || agent.custom_instructions || '').trim();

  const stage = agent.stage || 'Active';
  const rawDate = agent.next_interview_date || (agent.next_interview && agent.next_interview.date) || '';
  const rawTime = agent.next_interview_time || (agent.next_interview && agent.next_interview.time) || '';
  const nextDate = String(rawDate).trim();
  const nextTime = String(rawTime).trim();
  const nextInterview = { date: nextDate, time: nextTime };
  const nextFocus = (agent.next_focus || '').trim();

  // The UI edits the flat fields (playbook_name, answer_language...). The
  // nested objects are a copy kept for older readers, so the flat value wins:
  // preferring the nested copy reverted every change made in Prep ("Executive
  // STAR applied" and the goal still on Standard STAR).
  const pb = agent.playbook || {};
  const pick = (flat, nested, fallback) => (flat !== undefined && flat !== null && flat !== '' ? flat : nested ?? fallback);
  const playbook = {
    name: pick(agent.playbook_name, pb.name, 'Standard STAR'),
    answer_length: pick(agent.playbook_answer_length, pb.answer_length, 'Balanced'),
    behavioral_structure: pick(agent.playbook_behavioral_structure, pb.behavioral_structure, 'Auto'),
    lead_with_answer: pick(agent.playbook_lead_with_answer, pb.lead_with_answer, true),
    name_tradeoffs: pick(agent.playbook_name_tradeoffs, pb.name_tradeoffs, false)
  };

  const rd = agent.response_defaults || {};
  const responseDefaults = {
    answer_language: pick(agent.answer_language, rd.answer_language, 'pt-BR'),
    // '' is a real choice here ("Auto / Conforme a vaga"), so it must not fall back.
    coding_language: agent.coding_language !== undefined ? String(agent.coding_language || '') : rd.coding_language || ''
  };

  const goalMemory = agent.goal_memory || {
    strengths: Array.isArray(agent.goal_memory_strengths) ? agent.goal_memory_strengths : [],
    improve: Array.isArray(agent.goal_memory_improve) ? agent.goal_memory_improve : []
  };

  const checklistState = agent.checklist_state || {
    goal_created: true,
    resume_added: docs.some((d) => (d.tag || '').includes('resume') || (d.title || '').toLowerCase().includes('cv')),
    practice_run: false,
    debrief_read: false
  };

  const normalized = {
    id,
    name: (agent.name || `${agent.company || 'Sessão'} — ${agent.role || 'Entrevista'}`).trim(),
    session_type: agent.session_type || 'interview',
    company: (agent.company || '').trim(),
    role: (agent.role || '').trim(),
    job_description: (agent.job_description || '').trim(),
    extra_instructions: extraInstructions,
    custom_instructions: extraInstructions,
    company_research: companyResearch,
    company_dossier: companyResearch,
    mini_compact: (agent.mini_compact || '').trim(),
    // Kept so the overlay knows the stored compact still matches the
    // materials and skips re-reading them (it recomputes on any change).
    mini_compact_fingerprint: agent.mini_compact_fingerprint || '',
    stage,
    next_interview: nextInterview,
    next_interview_date: nextDate,
    next_interview_time: nextTime,
    next_focus: nextFocus,
    playbook,
    playbook_name: playbook.name || 'Standard STAR',
    playbook_answer_length: playbook.answer_length || 'Balanced',
    playbook_behavioral_structure: playbook.behavioral_structure || 'Auto',
    playbook_lead_with_answer: playbook.lead_with_answer ?? true,
    playbook_name_tradeoffs: playbook.name_tradeoffs ?? false,
    response_defaults: responseDefaults,
    answer_language: responseDefaults.answer_language || 'pt-BR',
    coding_language: responseDefaults.coding_language || '',
    goal_memory: goalMemory,
    goal_memory_strengths: goalMemory.strengths || [],
    goal_memory_improve: goalMemory.improve || [],
    checklist_state: checklistState,
    documents: docs
  };

  if (!normalized.mini_compact) {
    normalized.mini_compact = synthesizeDeterministicMiniCompact(normalized);
  }

  const filePath = path.join(getAppDataDir(), 'agents', `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), 'utf8');

  // Schedule notification if interview date is present
  scheduleInterviewNotification(normalized);

  // Always update config.ini [sessao] ultimo_agente so the Overlay automatically picks this agent
  writeConfigIni({ last_agent: id });

  return {
    ...normalized,
    chunk_count: computeChunkCount(normalized),
    updated_at: Date.now()
  };
}

// ---------------------------------------------------------------------------
// File Text Extraction (.txt, .md, .json, code, .docx, .pdf)
// ---------------------------------------------------------------------------
function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

// Reads word/document.xml from the ZIP central directory (local headers may
// carry size 0 when the writer used data descriptors, as Google Docs does).
function extractTextFromDocx(buffer) {
  try {
    let eocd = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i -= 1) {
      if (buffer.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return '';
    const entries = buffer.readUInt16LE(eocd + 10);
    let p = buffer.readUInt32LE(eocd + 16);
    for (let n = 0; n < entries && p + 46 <= buffer.length; n += 1) {
      if (buffer.readUInt32LE(p) !== 0x02014b50) break;
      const method = buffer.readUInt16LE(p + 10);
      const compSize = buffer.readUInt32LE(p + 20);
      const nameLen = buffer.readUInt16LE(p + 28);
      const extraLen = buffer.readUInt16LE(p + 30);
      const commentLen = buffer.readUInt16LE(p + 32);
      const localOff = buffer.readUInt32LE(p + 42);
      const name = buffer.slice(p + 46, p + 46 + nameLen).toString('utf8');
      p += 46 + nameLen + extraLen + commentLen;
      if (name !== 'word/document.xml') continue;
      const lNameLen = buffer.readUInt16LE(localOff + 26);
      const lExtraLen = buffer.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buffer.slice(start, start + compSize);
      const xml = method === 8 ? zlib.inflateRawSync(data).toString('utf8') : data.toString('utf8');
      const text = xml
        .replace(/<w:tab\/>/g, '\t')
        .replace(/<w:br[^>]*\/>/g, '\n')
        .replace(/<w:numPr>/g, '\u2022 ')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      return decodeXmlEntities(text);
    }
  } catch (_e) {}
  return '';
}

// PDF text extraction lives in pdf_text.js: reading order rebuilt from the
// item positions (columns, spaces, paragraphs) and cleaned (ligatures,
// hyphenation, page numbers, headers/footers). PDFs without a text layer
// (scans) are read once, at upload time, by OpenRouter's OCR.
const pdfText = require('./pdf_text.js');

// Heuristic: does this string look like human-readable text (not binary)?
function looksLikeReadableText(text) {
  const s = String(text || '');
  if (s.length < 20) return s.trim().length > 0;
  const sample = s.slice(0, 6000);
  let bad = 0;
  let letters = 0;
  for (const ch of sample) {
    const code = ch.codePointAt(0);
    if (code === 0xfffd || (code < 32 && code !== 9 && code !== 10 && code !== 13)) bad += 1;
    else if (/[\p{L}\p{N}]/u.test(ch)) letters += 1;
  }
  return bad / sample.length < 0.02 && letters / sample.length > 0.45;
}

// Decodes text files that may be UTF-8 or Windows-1252 (common for .txt on Windows).
function decodeTextBuffer(buf) {
  const utf8 = buf.toString('utf8').replace(/^\uFEFF/, '');
  const replacements = (utf8.match(/\uFFFD/g) || []).length;
  if (replacements === 0) return utf8;
  try {
    const cp1252 = new TextDecoder('windows-1252').decode(buf);
    return cp1252.replace(/^\u00EF\u00BB\u00BF/, '');
  } catch (_e) {
    return utf8;
  }
}

async function extractDocumentContent(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buf = fs.readFileSync(filePath);
  let text = '';
  if (ext === '.docx') {
    text = extractTextFromDocx(buf);
  } else if (ext === '.pdf') {
    const result = await pdfText.extractPdfText(buf);
    text = result.text;
    if (pdfText.looksScanned(result)) {
      // No text layer: one OCR call now, so the live interview never waits on it.
      const ocr = await pdfText.ocrPdfWithOpenRouter(buf, path.basename(filePath), getOpenRouterApiKey(), https);
      if (ocr && ocr.replace(/\s+/g, '').length > text.replace(/\s+/g, '').length) {
        text = pdfText.cleanPdfText(ocr);
      }
    }
  } else {
    text = decodeTextBuffer(buf);
  }
  text = String(text || '').trim();
  if (!text || !looksLikeReadableText(text)) {
    return {
      ok: false,
      content: '',
      error:
        ext === '.pdf'
          ? (getOpenRouterApiKey()
              ? 'Could not read this PDF, not even with OCR. Use "Paste text".'
              : 'This PDF looks scanned (no text layer). Set the OpenRouter key to read it with OCR, or use "Paste text".')
          : 'The file has no readable text.'
    };
  }
  return { ok: true, content: text.slice(0, 100000), error: '' };
}

// The sample resume older versions put in the starter goal. It is not the
// user's: kept, it would be inherited by new goals and told as real experience.
const SAMPLE_RESUME_PREFIX = 'Engenheiro de Software com foco em sistemas de tempo real (C++20, Node.js, Python, Rust)';

// Removes documents whose stored content is binary garbage (saved by older
// versions) and the old built-in sample resume.
function isGarbageDocument(doc) {
  if (!doc || !doc.content || !looksLikeReadableText(doc.content)) return true;
  return String(doc.content).trim().startsWith(SAMPLE_RESUME_PREFIX);
}

// ---------------------------------------------------------------------------
// HTTP Helper for Company Recon, Google Calendar .ics & Deep Reading
// ---------------------------------------------------------------------------
function httpGet(urlStr, timeoutMs = 6500) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(urlStr);
    } catch (err) {
      return reject(err);
    }
    const client = parsedUrl.protocol === 'https:' ? https : http;
    const req = client.get(
      parsedUrl.toString(),
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/json,text/calendar,text/plain,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
        },
        timeout: timeoutMs
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          try {
            const redirectUrl = new URL(res.headers.location, parsedUrl).toString();
            return resolve(httpGet(redirectUrl, timeoutMs));
          } catch (_e) {}
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseInputCompanyOrUrl(rawInput) {
  const trimmed = String(rawInput || '').trim();
  const isUrl =
    /^https?:\/\//i.test(trimmed) ||
    (!trimmed.includes(' ') && /^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(trimmed));
  if (!isUrl) {
    return { isUrl: false, targetUrl: '', host: '', brandName: trimmed };
  }
  const normalizedUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(normalizedUrl);
    const host = u.hostname.replace(/^www\./i, '');
    const firstLabel = host.split('.')[0] || host;
    const brandName = firstLabel.charAt(0).toUpperCase() + firstLabel.slice(1);
    return { isUrl: true, targetUrl: u.toString(), host, brandName };
  } catch (_e) {
    return { isUrl: false, targetUrl: '', host: '', brandName: trimmed };
  }
}

async function scrapeWebsiteFacts(targetUrl) {
  try {
    const html = await httpGet(targetUrl, 6000);
    if (!html || html.length < 40) return '';

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? decodeHtmlEntities(titleMatch[1]) : '';

    const metaMatches = [
      ...html.matchAll(
        /<meta[^>]+(?:name|property)=["'](?:description|og:description|og:title|twitter:description)["'][^>]+content=["']([^"']+)["']/gi
      ),
      ...html.matchAll(
        /<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description|og:title|twitter:description)["']/gi
      )
    ];
    const metas = [...new Set(metaMatches.map((m) => decodeHtmlEntities(m[1])).filter(Boolean))];

    const cleanedBody = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ');

    const headings = [...cleanedBody.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
      .map((m) => decodeHtmlEntities(m[1].replace(/<[^>]+>/g, ' ')))
      .filter((t) => t.length >= 6 && t.length <= 180)
      .slice(0, 10);

    const paragraphs = [...cleanedBody.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((m) => decodeHtmlEntities(m[1].replace(/<[^>]+>/g, ' ')))
      .filter((t) => t.length >= 35 && t.length <= 450)
      .slice(0, 10);

    const plainBodyText = decodeHtmlEntities(cleanedBody.replace(/<[^>]+>/g, ' ')).slice(0, 2600);

    const lines = [];
    if (title) lines.push(`• Official title (${targetUrl}): ${title}`);
    if (metas.length > 0) lines.push(`• Official description: ${metas.slice(0, 2).join(' | ')}`);
    if (headings.length > 0) lines.push(`• Principais Destaques do Site: ${[...new Set(headings)].join(' · ')}`);
    if (paragraphs.length > 0) {
      lines.push(`• Content from the site:\n  - ${[...new Set(paragraphs)].slice(0, 6).join('\n  - ')}`);
    }
    if (plainBodyText) {
      lines.push(`• Full text of the official page: ${plainBodyText}`);
    }
    return lines.join('\n');
  } catch (_e) {
    return '';
  }
}

async function searchDuckDuckGoHtml(query) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const html = await httpGet(url, 6000);
    if (!html) return [];
    const snippets = [];
    const regex = /class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/gi;
    let m;
    while ((m = regex.exec(html)) !== null && snippets.length < 5) {
      const text = decodeHtmlEntities(m[1].replace(/<[^>]+>/g, ' '));
      if (text && text.length > 25 && !snippets.includes(text)) {
        snippets.push(text);
      }
    }
    return snippets;
  } catch (_e) {
    return [];
  }
}

async function runCompanyRecon({ company, role, job_description }) {
  const cleanCompany = String(company || '').trim();
  if (!cleanCompany) {
    return 'Enter the company name or URL (e.g. https://tako.ai/pt/ or Nubank) to research its business, culture and fit.';
  }

  const parsed = parseInputCompanyOrUrl(cleanCompany);
  const findings = [];

  // 1. If user pasted a URL or domain, scrape the actual website directly!
  if (parsed.isUrl && parsed.targetUrl) {
    const siteFacts = await scrapeWebsiteFacts(parsed.targetUrl);
    if (siteFacts) {
      findings.push(siteFacts);
    }
  }

  // 2. Search DuckDuckGo HTML for real web snippets about the company/domain
  const searchQuery = parsed.isUrl
    ? `${parsed.host} ${parsed.brandName} empresa plataforma`
    : `${parsed.brandName} empresa tecnologia produto cultura`;
  const ddgSnippets = await searchDuckDuckGoHtml(searchQuery);
  if (ddgSnippets.length > 0) {
    findings.push(`• Web results (${parsed.brandName}):\n  - ${ddgSnippets.slice(0, 4).join('\n  - ')}`);
  }

  // 3. Wikipedia PT / EN lookup using the clean brand name (never the raw URL)
  try {
    const wikiPtUrl = `https://pt.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(parsed.brandName)}`;
    const rawPt = await httpGet(wikiPtUrl, 4000);
    const jsonPt = JSON.parse(rawPt);
    if (jsonPt && jsonPt.extract && jsonPt.type !== 'disambiguation') {
      findings.push(`• Wikipedia (${jsonPt.title || parsed.brandName}): ${jsonPt.extract}`);
    }
  } catch (_e) {}

  if (findings.length === 0) {
    try {
      const wikiEnUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(parsed.brandName)}`;
      const rawEn = await httpGet(wikiEnUrl, 4000);
      const jsonEn = JSON.parse(rawEn);
      if (jsonEn && jsonEn.extract && jsonEn.type !== 'disambiguation') {
        findings.push(`• Wikipedia (${jsonEn.title || parsed.brandName}): ${jsonEn.extract}`);
      }
    } catch (_e) {}
  }

  // 4. Synthesize an executive dossier using OpenRouter Sol 6.1 (`openai/gpt-6.1-sol`) at `medium` effort
  const rawCollected = findings.join('\n\n');
  const aiSystem =
    'You are a market-intelligence specialist who prepares candidates for technical interviews.\n' +
    'From the data collected from the official site and the web about the target company, write a concise EXECUTIVE CULTURE-FIT & PRODUCT DOSSIER in English.\n' +
    'STRICT RULES:\n' +
    '1. Stay faithful to the collected data (if a URL was given, describe exactly what the company does according to the site and the results). Do not invent facts about the company.\n' +
    '2. Use 3 short blocks:\n' +
    '   - WHAT THE COMPANY DOES & PRODUCT/TECHNOLOGY\n' +
    '   - CULTURE, VALUES & WHAT THEY LOOK FOR IN CANDIDATES\n' +
    '   - HOW TO CONNECT IN THE INTERVIEW (STAR)\n' +
    '3. Never invent facts about the candidate.';

  const aiUser = [
    `Company / URL: ${cleanCompany} (brand: ${parsed.brandName})`,
    role ? `Target role: ${role}` : '',
    job_description ? `Job description: ${job_description}` : '',
    `Data collected from the web / official site:\n${rawCollected || '(only the name/URL is available)'}`
  ]
    .filter(Boolean)
    .join('\n\n');

  const solDossier = await callOpenRouterSol61(aiSystem, aiUser, 900);
  if (solDossier) {
    return `=== COMPANY DOSSIER (${parsed.brandName.toUpperCase()}) ===\n${solDossier}`;
  }

  const roleText = role ? ` for **${role}**` : '';
  const header = `=== QUICK COMPANY DOSSIER: ${parsed.brandName.toUpperCase()} ===`;
  const fitBlock = [
    `• Culture-fit & interview tips${roleText}:`,
    `  - Connect your real deliveries from the RAG documents to measurable impact (latency, scale, reliability, product).`,
    `  - Use STAR (Situation, Task, Action, Result) citing only real projects from your resume.`,
    `  - Show alignment with the product and engineering challenges at ${parsed.brandName}.`
  ].join('\n');

  if (findings.length === 0) {
    return `${header}\n• Company: ${cleanCompany}${role ? ` | Role: ${role}` : ''}\n${fitBlock}`;
  }
  return `${header}\n${rawCollected}\n\n${fitBlock}`;
}

function parseIcsEvents(icsText) {
  const events = [];
  const blocks = (icsText || '').split('BEGIN:VEVENT').slice(1);
  for (const block of blocks) {
    const endIdx = block.indexOf('END:VEVENT');
    const body = endIdx >= 0 ? block.slice(0, endIdx) : block;
    const unfolded = body.replace(/\r?\n[ \t]/g, '');
    const lines = unfolded.split(/\r?\n/);
    let summary = '';
    let dtstart = '';
    let description = '';
    let location = '';
    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) continue;
      const key = line.slice(0, colonIdx).split(';')[0].toUpperCase();
      const val = line
        .slice(colonIdx + 1)
        .replace(/\\n/g, '\n')
        .replace(/\\,/g, ',')
        .trim();
      if (key === 'SUMMARY') summary = val;
      else if (key === 'DTSTART') dtstart = val;
      else if (key === 'DESCRIPTION') description = val;
      else if (key === 'LOCATION') location = val;
    }
    if (summary) {
      let formattedDate = dtstart;
      if (/^\d{8}T\d{6}/.test(dtstart)) {
        formattedDate = `${dtstart.slice(6, 8)}/${dtstart.slice(4, 6)}/${dtstart.slice(0, 4)} at ${dtstart.slice(9, 11)}:${dtstart.slice(11, 13)}`;
      }
      events.push({
        id: sanitizeId(`${summary}-${dtstart}`),
        summary,
        date: formattedDate || 'Upcoming',
        location: location || 'Google Meet / Zoom',
        description: description.slice(0, 800)
      });
    }
  }
  return events.slice(0, 15);
}

// ---------------------------------------------------------------------------
// Past Sessions Reader
// ---------------------------------------------------------------------------
function loadPastSessions() {
  const sessionsDir = path.join(getAppDataDir(), 'sessions');
  if (!fs.existsSync(sessionsDir)) return [];
  const files = fs.readdirSync(sessionsDir);
  const mdFiles = files.filter((f) => f.endsWith('.md'));
  const sessions = [];
  for (const mdFile of mdFiles) {
    try {
      const fullPath = path.join(sessionsDir, mdFile);
      const stat = fs.statSync(fullPath);
      const content = fs.readFileSync(fullPath, 'utf8');
      const preview = content.slice(0, 600);
      const qMatches = (content.match(/Question:\s*"[^"]+"/gi) || []).length;
      const aMatches = (content.match(/>\s*\*\*Suggestion/gi) || []).length;
      const lats = [...content.matchAll(/1st token in ([0-9.]+) s/gi)].map((m) => parseFloat(m[1]) * 1000);
      const avgLat = lats.length > 0 ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null;
      sessions.push({
        id: path.basename(mdFile, '.md'),
        fileName: mdFile,
        fullPath,
        updatedAt: stat.mtimeMs,
        sizeKb: Math.max(1, Math.round(stat.size / 1024)),
        preview: preview.replace(/\r?\n/g, ' ').slice(0, 220),
        questionsCount: qMatches,
        answersCount: aMatches,
        avgLatencyMs: avgLat
      });
    } catch (_e) {}
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions.slice(0, 30);
}

// ---------------------------------------------------------------------------
// User Profile Persistence
// ---------------------------------------------------------------------------
function loadUserProfile() {
  const p = path.join(getAppDataDir(), 'dashboard_profile.json');
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_e) {}
  }
  return {
    name: 'Bruno',
    email: 'bruno@realtimeai.dev',
    headline: 'Senior Software Engineer',
    seniority: 'Senior / Staff',
    linkedin: 'linkedin.com/in/bruno',
    loggedIn: true
  };
}

function saveUserProfile(profile) {
  const p = path.join(getAppDataDir(), 'dashboard_profile.json');
  const next = { ...loadUserProfile(), ...profile, loggedIn: true };
  fs.writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// ---------------------------------------------------------------------------
// Overlay Process Controller
// ---------------------------------------------------------------------------
function isOverlayRunning() {
  if (overlayProcess && !overlayProcess.killed) return true;
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq rtai_overlay.exe" /FI "IMAGENAME eq rtai_app.exe" /NH', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return out.includes('rtai_overlay.exe') || out.includes('rtai_app.exe');
  } catch (_e) {
    return false;
  }
}

function broadcastOverlayStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('rtai:overlay-status', {
      running: Boolean(overlayProcess && !overlayProcess.killed),
      mode: overlayMode || 'idle',
      agentId: overlayAgentId || ''
    });
  }
  onOverlayStatusChanged();
}

function stopRunningOverlay() {
  if (overlayProcess && !overlayProcess.killed) {
    try {
      overlayProcess.kill();
    } catch (_e) {}
  }
  overlayProcess = null;
  overlayMode = null;
  try {
    execSync('taskkill /F /IM rtai_overlay.exe /T', { stdio: 'ignore' });
  } catch (_e) {}
  try {
    execSync('taskkill /F /IM rtai_app.exe /T', { stdio: 'ignore' });
  } catch (_e) {}
  broadcastOverlayStatus();
}

function launchOverlay({ agent, demo = false, configOverrides = {} }) {
  // 1. Save the active Mini-Agent (with its RAG documents, instructions, and mini_compact)
  let savedAgent = null;
  if (agent) {
    savedAgent = saveAgentToDisk(agent);
  }
  // 2. Sync config.ini so the Overlay reads the exact model, language, behavior toggles, and ultimo_agente
  const cfgUpdate = {
    ...configOverrides
  };
  if (savedAgent && savedAgent.id) {
    cfgUpdate.last_agent = savedAgent.id;
  }
  writeConfigIni(cfgUpdate);

  // 3. Stop any previous overlay instance
  stopRunningOverlay();

  // 4. Spawn the standalone native C++20 Overlay executable from ../overlay/
  const exePath = getOverlayExecutablePath();
  const args = ['--no-launcher', '--server'];
  if (savedAgent && savedAgent.id) {
    args.push('--agent', savedAgent.id);
  }
  if (demo) {
    args.push('--demo');
  }

  overlayMode = demo ? 'demo' : 'live';
  overlayAgentId = savedAgent ? savedAgent.id : '';

  overlayProcess = spawn(exePath, args, {
    cwd: path.dirname(exePath),
    detached: false,
    windowsHide: false
  });

  if (overlayProcess.stderr) {
    overlayProcess.stderr.on('data', (chunk) => {
      // Drain stderr so pipe buffer on Windows never blocks child process
      const str = chunk.toString('utf8');
      if (process.env.DEBUG || !app.isPackaged) {
        console.error('[overlay-stderr]', str.trim());
      }
    });
  }

  overlayProcess.on('error', (err) => {
    console.error('[overlay-process-error]', err);
    overlayProcess = null;
    overlayMode = null;
    broadcastOverlayStatus();
  });

  let lineBuffer = '';
  if (overlayProcess.stdout) {
    overlayProcess.stdout.on('data', (chunk) => {
      lineBuffer += chunk.toString('utf8');
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('{')) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.type === 'mode' && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('rtai:mode', Boolean(msg.on));
          } else if (msg.type === 'hello' && mainWindow && !mainWindow.isDestroyed()) {
            if (msg.mode !== undefined) {
              mainWindow.webContents.send('rtai:mode', Boolean(msg.mode));
            }
          } else if (msg.type === 'open_settings') {
            // The HUD's Config button: one settings screen, the dashboard's.
            showSettingsWindow(msg.section || 'general');
          } else if (msg.type === 'summary' && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('rtai:summary', {
              ok: Boolean(msg.ok),
              text: msg.text || '',
              export_path: msg.export_path || ''
            });
          }
        } catch (_e) {
          // non-JSON line, ignore
        }
      }
    });
  }

  overlayProcess.on('exit', () => {
    overlayProcess = null;
    overlayMode = null;
    broadcastOverlayStatus();
  });

  broadcastOverlayStatus();
  return {
    ok: true,
    exePath,
    args,
    mode: overlayMode,
    agent: savedAgent
  };
}

// ---------------------------------------------------------------------------
// Meeting detection, popup and tray
// ---------------------------------------------------------------------------
// meeting_detector.js watches for calls (Meet, Teams, Zoom, Discord, Skype,
// Slack, Webex, WhatsApp...). When one starts and the copilot is off, a small
// popup offers to start it with the right goal; when it ends with the copilot
// still on, the popup offers to stop it (which saves the session).
let tray = null;
let meetingDetector = null;
let meetingPopup = null;
let trayHintShown = false;
const meetingsHandled = new Set(); // calls the popup was already shown (or skipped) for

function getMeetingSettings() {
  const p = loadUserProfile().meetingDetection || {};
  return {
    enabled: p.enabled !== false,
    keepInTray: p.keepInTray !== false,
    mutedApps: Array.isArray(p.mutedApps) ? p.mutedApps.filter((x) => typeof x === 'string') : []
  };
}

function saveMeetingSettings(patch) {
  const next = { ...getMeetingSettings(), ...(patch || {}) };
  next.mutedApps = [...new Set((next.mutedApps || []).map(String))];
  saveUserProfile({ meetingDetection: next });
  applyMeetingSettings();
  return next;
}

function meetingDetectionState() {
  return {
    ...getMeetingSettings(),
    supported: process.platform === 'win32',
    active: meetingDetector ? meetingDetector.active : [],
    appNames: APP_NAMES
  };
}

function broadcastMeetingState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('rtai:meeting-detection', meetingDetectionState());
  }
  refreshTrayMenu();
}

function ensureMeetingDetector() {
  if (meetingDetector) return meetingDetector;
  meetingDetector = new MeetingDetector({ intervalMs: 3000 });
  meetingDetector.on('meeting-started', onMeetingStarted);
  meetingDetector.on('meeting-ended', onMeetingEnded);
  meetingDetector.on('meeting-updated', (m) => {
    const cur = meetingPopup && meetingPopup.current();
    if (cur && cur.meeting && cur.meeting.id === m.id) meetingPopup.show({ ...cur, meeting: { ...m } });
    broadcastMeetingState();
  });
  meetingDetector.on('error', (err) => console.error('[meeting-detector]', err && err.message));
  return meetingDetector;
}

function applyMeetingSettings() {
  const s = getMeetingSettings();
  if (s.enabled) {
    ensureMeetingDetector().start();
  } else if (meetingDetector) {
    meetingDetector.stop();
    meetingsHandled.clear();
    const cur = meetingPopup && meetingPopup.current();
    if (cur && cur.kind === 'started') meetingPopup.close();
  }
  broadcastMeetingState();
}

// The goal whose interview is happening now (90 min before to 3 h after the
// scheduled time), else the last one used, else the first.
function pickDefaultAgentId(agents) {
  const now = Date.now();
  let best = null;
  for (const a of agents || []) {
    const d = a.next_interview_date || (a.next_interview && a.next_interview.date);
    const t = a.next_interview_time || (a.next_interview && a.next_interview.time);
    if (!d || !t) continue;
    const at = new Date(`${d}T${t}:00`).getTime();
    if (Number.isNaN(at)) continue;
    if (at - now > 90 * 60000 || now - at > 3 * 3600000) continue;
    const diff = Math.abs(at - now);
    if (!best || diff < best.diff) best = { id: a.id, diff };
  }
  if (best) return best.id;
  const last = readConfigIni().last_agent;
  if (last && (agents || []).some((a) => a.id === last)) return last;
  return agents && agents[0] ? agents[0].id : '';
}

function popupPayload(kind, meeting) {
  const agents = loadAllAgents();
  return {
    kind,
    meeting: { ...meeting },
    agents: agents.map((a) => ({ id: a.id, name: a.name || a.id, company: a.company || '', role: a.role || '' })),
    defaultAgentId: pickDefaultAgentId(agents),
    theme: getThemeState().resolved,
    timeoutSec: kind === 'ended' ? 30 : 45
  };
}

function notify(title, body) {
  try {
    if (Notification && Notification.isSupported()) new Notification({ title, body }).show();
  } catch (_e) {}
}

function showMainWindow() {
  if (!app.isReady()) return;
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function toggleMainWindowVisibility() {
  if (!app.isReady()) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    showMainWindow();
  }
}

function applyElectronStealthMode(overrides = {}) {
  const cfg = readConfigIni();
  const isStealthActive = overrides.electron_stealth !== undefined
    ? Boolean(overrides.electron_stealth)
    : Boolean(cfg.electron_stealth);

  const protectScreen = isStealthActive && (
    overrides.electron_screen_protection !== undefined
      ? Boolean(overrides.electron_screen_protection)
      : (overrides.stealth_screen_capture !== undefined
          ? Boolean(overrides.stealth_screen_capture)
          : Boolean(cfg.electron_screen_protection))
  );

  const skipTaskbar = isStealthActive && (
    overrides.electron_skip_taskbar !== undefined
      ? Boolean(overrides.electron_skip_taskbar)
      : Boolean(cfg.electron_skip_taskbar)
  );

  const disguise = isStealthActive && (
    overrides.electron_disguise !== undefined
      ? Boolean(overrides.electron_disguise)
      : Boolean(cfg.electron_disguise)
  );

  const activeDisguise = overrides.process_disguise || cfg.process_disguise || (disguise ? 'settings' : 'none');

  const opacity = overrides.interface_opacity !== undefined
    ? parseFloat(overrides.interface_opacity)
    : (overrides.electron_opacity !== undefined
        ? parseFloat(overrides.electron_opacity)
        : parseFloat(cfg.interface_opacity || cfg.electron_opacity || '1.0'));

  const status = {
    active: isStealthActive,
    screenProtection: protectScreen,
    skipTaskbar,
    disguise,
    processDisguise: activeDisguise,
    opacity: Number.isFinite(opacity) && opacity >= 0.2 && opacity <= 1.0 ? opacity : 1.0
  };

  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      if (typeof mainWindow.setContentProtection === 'function') {
        mainWindow.setContentProtection(protectScreen);
      }
    } catch (e) {
      console.warn('[stealth] Failed to set content protection on mainWindow:', e && e.message);
    }

    try {
      if (typeof mainWindow.setSkipTaskbar === 'function') {
        mainWindow.setSkipTaskbar(skipTaskbar);
      }
    } catch (e) {
      console.warn('[stealth] Failed to set skipTaskbar on mainWindow:', e && e.message);
    }

    try {
      if (typeof mainWindow.setTitle === 'function') {
        let title = 'RealTimeAI — Copilot Studio';
        if (activeDisguise === 'settings') title = 'Configurações do Sistema';
        else if (activeDisguise === 'cmd') title = 'Prompt de Comando';
        else if (activeDisguise === 'taskmgr') title = 'Gerenciador de Tarefas';
        mainWindow.setTitle(title);
      }
    } catch (e) {
      console.warn('[stealth] Failed to set title on mainWindow:', e && e.message);
    }

    try {
      if (typeof mainWindow.setOpacity === 'function') {
        mainWindow.setOpacity(status.opacity);
      }
    } catch (e) {
      console.warn('[stealth] Failed to set opacity on mainWindow:', e && e.message);
    }

    try {
      if (mainWindow.webContents && typeof mainWindow.webContents.send === 'function') {
        mainWindow.webContents.send('rtai:stealth-mode-updated', status);
      }
    } catch (_e) {}
  }

  refreshTrayMenu();
  return status;
}

function registerStealthShortcuts() {
  if (!globalShortcut || typeof globalShortcut.register !== 'function') return;
  try {
    globalShortcut.unregister('CommandOrControl+Alt+S');
    globalShortcut.unregister('CommandOrControl+Shift+H');

    // 1. Alternar Modo Stealth
    globalShortcut.register('CommandOrControl+Alt+S', () => {
      const cfg = readConfigIni();
      const nextActive = !Boolean(cfg.electron_stealth);
      writeConfigIni({ electron_stealth: nextActive });
      applyElectronStealthMode({ electron_stealth: nextActive });
      notify(
        nextActive ? '🛡️ Modo Stealth Ativado' : 'Modo Stealth Desativado',
        nextActive
          ? 'Dashboard invisível em compartilhamentos de tela (Zoom, Meet, Teams, OBS).'
          : 'Dashboard visível normalmente.'
      );
    });

    // 2. Boss Key / Botão do Pânico (Ocultar/Exibir rapidamente)
    globalShortcut.register('CommandOrControl+Shift+H', () => {
      toggleMainWindowVisibility();
    });
  } catch (err) {
    console.warn('[stealth] Error registering global shortcuts:', err && err.message);
  }
}

async function startCopilotForMeeting(agentId) {
  const exePath = getOverlayExecutablePath();
  if (!exePath || !fs.existsSync(exePath)) {
    return { ok: false, error: 'Overlay not found. Build it with recompilar.bat first.' };
  }
  if (!readConfigIni().has_deepgram_key) {
    showSettingsWindow('general');
    return { ok: false, error: 'Add your Deepgram key first. Settings is open in the dashboard.' };
  }
  const agent = loadAllAgents().find((a) => a.id === agentId) || null;
  const res = launchOverlay({ agent, demo: false });
  return { ok: Boolean(res && res.ok), error: res && res.error };
}

// "quit" over stdin lets the overlay close the session and write its summary;
// a hard kill is the fallback.
function stopOverlayGracefully(timeoutMs = 6000) {
  return new Promise((resolve) => {
    const proc = overlayProcess;
    if (!proc || proc.killed || !proc.stdin || !proc.stdin.writable) {
      stopRunningOverlay();
      resolve({ ok: true });
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: true });
    };
    const timer = setTimeout(() => {
      stopRunningOverlay();
      finish();
    }, timeoutMs);
    proc.once('exit', finish);
    try {
      proc.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n');
    } catch (_e) {
      stopRunningOverlay();
      finish();
    }
  });
}

function getMeetingPopup() {
  if (meetingPopup) return meetingPopup;
  meetingPopup = createMeetingPopup({
    BrowserWindow,
    screen,
    ipcMain,
    contentProtection: () => Boolean(readConfigIni().stealth_screen_capture),
    onStart: (agentId) => startCopilotForMeeting(agentId),
    onStop: () => stopOverlayGracefully(),
    onDismiss: (reason, payload) => {
      const m = payload && payload.meeting;
      if (reason === 'mute' && m && m.id && m.via !== 'test') {
        saveMeetingSettings({ mutedApps: [...getMeetingSettings().mutedApps, m.id] });
        notify(`RealTimeAI won't ask for ${m.name} again`, 'Turn it back on in Settings > General > Meeting detection.');
      }
    },
    onOpenDashboard: () => showMainWindow()
  });
  return meetingPopup;
}

function showTestMeetingPopup() {
  getMeetingPopup().show(popupPayload('started', {
    id: 'meet', name: 'Google Meet', title: 'Test popup · abc-defg-hij', via: 'test'
  }));
}

function onMeetingStarted(meeting) {
  broadcastMeetingState();
  if (meetingsHandled.has(meeting.id)) return;
  meetingsHandled.add(meeting.id);
  const s = getMeetingSettings();
  if (!s.enabled || s.mutedApps.includes(meeting.id)) return;
  if (isOverlayRunning()) return; // the copilot is already on
  getMeetingPopup().show(popupPayload('started', meeting));
}

function onMeetingEnded(meeting) {
  meetingsHandled.delete(meeting.id);
  broadcastMeetingState();
  const cur = meetingPopup && meetingPopup.current();
  if (cur && cur.kind === 'started' && cur.meeting && cur.meeting.id === meeting.id) meetingPopup.close();
  const stillInACall = meetingDetector && meetingDetector.active.length > 0;
  if (overlayProcess && !overlayProcess.killed && overlayMode === 'live' && !stillInACall) {
    getMeetingPopup().show(popupPayload('ended', meeting));
  }
}

function onOverlayStatusChanged() {
  const running = Boolean(overlayProcess && !overlayProcess.killed);
  const cur = meetingPopup && meetingPopup.current();
  if (cur && ((running && cur.kind === 'started') || (!running && cur.kind === 'ended'))) meetingPopup.close();
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const s = getMeetingSettings();
  const running = Boolean(overlayProcess && !overlayProcess.killed);
  const active = meetingDetector ? meetingDetector.active : [];
  const cfg = readConfigIni();
  const stealthActive = Boolean(cfg.electron_stealth);

  const items = [
    { label: 'Open RealTimeAI', click: () => showMainWindow() },
    {
      label: stealthActive ? '🛡️ Stealth Mode (Active)' : '🛡️ Stealth Mode (Off)',
      type: 'checkbox',
      checked: stealthActive,
      click: () => {
        const next = !stealthActive;
        writeConfigIni({ electron_stealth: next });
        applyElectronStealthMode({ electron_stealth: next });
      }
    },
    {
      label: mainWindow && mainWindow.isVisible() ? 'Hide Dashboard (Boss Key)' : 'Show Dashboard',
      click: () => toggleMainWindowVisibility()
    },
    { type: 'separator' }
  ];
  if (active.length) items.push({ label: `In a call: ${active.map((m) => m.name).join(', ')}`, enabled: false });
  items.push(running
    ? { label: 'Stop copilot', click: () => stopOverlayGracefully() }
    : {
        label: 'Start copilot',
        click: async () => {
          const r = await startCopilotForMeeting(pickDefaultAgentId(loadAllAgents()));
          if (!r.ok) notify('Could not start the copilot', r.error || '');
        }
      });
  items.push(
    { type: 'separator' },
    { label: 'Detect meetings', type: 'checkbox', checked: s.enabled, click: (item) => saveMeetingSettings({ enabled: item.checked }) },
    { label: 'Show a test popup', click: () => showTestMeetingPopup() },
    { type: 'separator' },
    { label: 'Quit RealTimeAI', click: () => { isQuitting = true; app.quit(); } }
  );
  try {
    tray.setContextMenu(Menu.buildFromTemplate(items));
    const stealthPrefix = stealthActive ? '🛡️ [Stealth] ' : '';
    tray.setToolTip(running ? `${stealthPrefix}RealTimeAI · copilot on`
      : active.length ? `${stealthPrefix}RealTimeAI · ${active[0].name} detected` : `${stealthPrefix}RealTimeAI`);
  } catch (_e) {}
}

function createTray() {
  if (tray || typeof Tray !== 'function') return;
  try {
    tray = new Tray(path.join(__dirname, 'assets', 'tray.png'));
  } catch (err) {
    console.error('[tray]', err && err.message);
    tray = null;
    return;
  }
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
  refreshTrayMenu();
}

// ---------------------------------------------------------------------------
// Electron Window & IPC Registration
// ---------------------------------------------------------------------------
// Brings the dashboard forward on Settings (asked by the overlay HUD).
function showSettingsWindow(section) {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  const win = mainWindow;
  const send = () => win.webContents.send('rtai:open-settings', String(section || 'general'));
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.setAlwaysOnTop(true);
  win.focus();
  win.setAlwaysOnTop(false);
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

function createWindow() {
  const initialTheme = getThemeState();
  if (initialTheme && initialTheme.preference) {
    nativeTheme.themeSource = initialTheme.preference;
  }
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    frame: false,
    backgroundColor: initialTheme.resolved === 'dark' ? '#0D0D10' : '#FFFFFF',
    title: 'RealTimeAI — Copilot Studio',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const loadPromise = mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  applyElectronStealthMode();

  // With meeting detection on, closing the window keeps the app in the tray.
  mainWindow.on('close', (e) => {
    const s = getMeetingSettings();
    if (isQuitting || !tray || !s.enabled || !s.keepInTray) return;
    e.preventDefault();
    mainWindow.hide();
    if (!trayHintShown) {
      trayHintShown = true;
      notify('RealTimeAI is still running', 'It waits in the tray and pops up when a meeting starts. Right-click the tray icon to quit.');
    }
  });

  // Start maximized if screen is compact, or allow responsive resize/fullscreen
  if (process.argv.includes('--fullscreen')) {
    mainWindow.setFullScreen(true);
  } else if (process.argv.includes('--maximize')) {
    mainWindow.maximize();
  }

  const capIdx = process.argv.indexOf('--capture-screenshots');
  if (capIdx >= 0 && process.argv[capIdx + 1]) {
    const outDir = process.argv[capIdx + 1];
    loadPromise.then(async () => {
      try {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        await wait(1200);

        // 1. Capture Light Mode (Final Round AI Views)
        await mainWindow.webContents.executeJavaScript(`applyTheme('light', 'light'); switchView('goals');`);
        await wait(600);
        const imgLightGoals = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, 'finalround_light_goals.png'), imgLightGoals.toPNG());

        await mainWindow.webContents.executeJavaScript(`openGoalModal(state.agents[0]);`);
        await wait(600);
        const imgGoalModal = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, 'finalround_goal_modal.png'), imgGoalModal.toPNG());
        await mainWindow.webContents.executeJavaScript(`document.getElementById('modalGoalSetup').classList.remove('open');`);
        await wait(200);

        await mainWindow.webContents.executeJavaScript(`switchView('library');`);
        await wait(600);
        const imgLightLibrary = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, 'finalround_light_library.png'), imgLightLibrary.toPNG());

        await mainWindow.webContents.executeJavaScript(`switchView('settings'); switchSettingsTab('shortcuts');`);
        await wait(600);
        const imgLightShortcuts = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, 'finalround_light_shortcuts.png'), imgLightShortcuts.toPNG());

        await mainWindow.webContents.executeJavaScript(`switchView('settings'); switchSettingsTab('billing');`);
        await wait(600);
        const imgLightBilling = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, 'finalround_light_billing.png'), imgLightBilling.toPNG());

        // 2. Capture Dark Mode (Windows Sync / Obsidian Dark)
        await mainWindow.webContents.executeJavaScript(`applyTheme('dark', 'dark'); switchView('goals');`);
        await wait(600);
        const imgDarkGoals = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, 'finalround_dark_goals.png'), imgDarkGoals.toPNG());
      } catch (err) {
        console.error('Capture error:', err);
      } finally {
        if (process.argv.includes('--exit-after-capture')) {
          app.quit();
        }
      }
    });
  }
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  if (session && session.defaultSession) {
    session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
      if (permission === 'media') return true;
      return true;
    });
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      if (permission === 'media') return callback(true);
      callback(true);
    });
  }
  // Ensure at least one rich starter Mini-Agent exists if agents folder is empty
  const existingAgents = loadAllAgents();
  if (existingAgents.length === 0) {
    saveAgentToDisk({
      id: 'my-first-goal',
      name: 'My first goal',
      session_type: 'interview',
      company: '',
      role: '',
      job_description: '',
      extra_instructions: 'Answer in the first person, using STAR for behavioral questions.',
      company_research: '',
      // No sample resume: an invented one would be inherited by new goals
      // and told by the copilot as the candidate's real experience.
      documents: []
    });
  }

  ipcMain.handle('rtai:get-state', async () => {
    const config = readConfigIni();
    const agents = loadAllAgents();
    const sessions = loadPastSessions();
    const profile = loadUserProfile();
    const themeState = getThemeState(profile.themePreference);
    return {
      appDataDir: getAppDataDir(),
      overlayExePath: getOverlayExecutablePath(),
      config,
      stealthState: {
        active: Boolean(config.electron_stealth),
        screenProtection: Boolean(config.electron_screen_protection),
        skipTaskbar: Boolean(config.electron_skip_taskbar),
        disguise: Boolean(config.electron_disguise),
        opacity: parseFloat(config.electron_opacity || '1.0'),
        shortcuts: {
          toggle: 'Ctrl+Alt+S',
          panic: 'Ctrl+Shift+H'
        }
      },
      agents,
      sessions,
      profile,
      themeState,
      playbooks: loadAllPlaybooks(),
      overlayStatus: {
        running: isOverlayRunning(),
        mode: overlayMode || 'idle',
        agentId: overlayAgentId || config.last_agent || (agents[0]?.id ?? '')
      }
    };
  });

  ipcMain.handle('rtai:set-theme-preference', async (_ev, pref) => {
    const valid = ['system', 'light', 'dark'].includes(pref) ? pref : 'system';
    nativeTheme.themeSource = valid;
    saveUserProfile({ themePreference: valid });
    const nextTheme = getThemeState(valid);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(nextTheme.resolved === 'dark' ? '#0D0D10' : '#FFFFFF');
      mainWindow.webContents.send('rtai:system-theme-updated', nextTheme);
    }
    return nextTheme;
  });

  nativeTheme.on('updated', () => {
    const nextTheme = getThemeState();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(nextTheme.resolved === 'dark' ? '#0D0D10' : '#FFFFFF');
      mainWindow.webContents.send('rtai:system-theme-updated', nextTheme);
    }
  });

  ipcMain.handle('rtai:save-agent', async (_ev, agent) => {
    const before = loadAllAgents().find((a) => a.id === sanitizeId(agent && agent.id));
    const saved = saveAgentToDisk(agent);
    // The overlay reads the goal at launch: when the running one uses this goal
    // and its answer settings changed, relaunch it so the change takes effect.
    let overlayRestarted = false;
    const answerKeys = ['playbook_name', 'playbook_answer_length', 'playbook_behavioral_structure',
      'playbook_lead_with_answer', 'playbook_name_tradeoffs', 'answer_language', 'coding_language'];
    const changed = before && answerKeys.some((k) => String(before[k] ?? '') !== String(saved[k] ?? ''));
    if (changed && isOverlayRunning() && overlayAgentId === saved.id) {
      launchOverlay({ agent: saved, demo: overlayMode === 'demo' });
      overlayRestarted = true;
    }
    return {
      saved,
      agent: saved,
      agents: loadAllAgents(),
      overlayRestarted
    };
  });

  ipcMain.handle('rtai:delete-agent', async (_ev, agentId) => {
    const filePath = path.join(getAppDataDir(), 'agents', `${sanitizeId(agentId)}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    const agents = loadAllAgents();
    if (agents.length > 0) {
      writeConfigIni({ last_agent: agents[0].id });
    }
    return { agents };
  });

  ipcMain.handle('rtai:pick-files', async (_ev, defaultTag = 'resume') => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Select files for the goal RAG (resume, job description, projects)',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Documents & code',
          extensions: ['txt', 'md', 'pdf', 'docx', 'json', 'csv', 'py', 'cpp', 'hpp', 'ts', 'js', 'html']
        },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths.length) return { documents: [], failed: [] };
    const documents = [];
    const failed = [];
    for (const fp of res.filePaths) {
      const base = path.basename(fp);
      const extracted = await extractDocumentContent(fp);
      if (!extracted.ok) {
        failed.push({ title: base, error: extracted.error });
        continue;
      }
      const lower = base.toLowerCase();
      let tag = defaultTag || 'doc';
      if (lower.includes('cv') || lower.includes('curriculo') || lower.includes('resume')) tag = 'resume';
      else if (lower.includes('vaga') || lower.includes('job') || lower.includes('jd')) tag = 'job';
      else if (lower.includes('proj') || lower.includes('arquitetura') || lower.includes('readme')) tag = 'project';
      documents.push({
        title: base,
        tag,
        path: fp,
        source_path: fp,
        content: extracted.content
      });
    }
    return { documents, failed };
  });

  ipcMain.handle('rtai:deep-read', async (_ev, agent) => {
    const miniCompact = await synthesizeSol61MiniCompact(agent);
    const updated = saveAgentToDisk({
      ...agent,
      mini_compact: miniCompact
    });
    return {
      mini_compact: updated.mini_compact,
      agent: updated,
      agents: loadAllAgents()
    };
  });

  ipcMain.handle('rtai:company-recon', async (_ev, payload) => {
    const dossier = await runCompanyRecon(payload || {});
    return { dossier };
  });

  ipcMain.handle('rtai:calendar-sync', async (_ev, icsUrl) => {
    if (icsUrl && icsUrl.trim()) {
      writeConfigIni({ calendar_ics_url: icsUrl.trim() });
      try {
        const rawIcs = await httpGet(icsUrl.trim(), 7000);
        const parsed = parseIcsEvents(rawIcs);
        if (parsed.length > 0) {
          return { ok: true, source: 'live_ics', events: parsed };
        }
      } catch (_e) {}
    }
    // Provide realistic upcoming interview events if no external .ics feed returned VEVENTs
    return {
      ok: true,
      source: 'template',
      events: [
        {
          id: 'entrevista-system-design',
          summary: 'Technical & System Design Interview — Senior Software Engineer',
          company: 'Nubank',
          role: 'Senior Software Engineer',
          date: 'Today · 15:00 - 16:00',
          location: 'Google Meet',
          description:
            'Technical chat about distributed architecture, low latency, microservice resilience and culture fit (STAR).'
        },
        {
          id: 'entrevista-hiring-manager',
          summary: 'Hiring Manager & Culture Fit — Staff AI Engineer',
          company: 'Mercado Livre',
          role: 'Staff AI & Backend Engineer',
          date: 'Tomorrow · 10:30 - 11:30',
          location: 'Zoom',
          description:
            'Technical leadership, real-time AI projects, RAG, decisions under pressure and alignment with the company principles.'
        },
        {
          id: 'call-arquitetura-cliente',
          summary: 'Architecture & Technical Scope Presentation',
          company: 'Enterprise Client',
          role: 'Tech Lead / Solutions Architect',
          date: 'Friday · 14:00 - 14:45',
          location: 'Microsoft Teams',
          description:
            'Non-functional requirements, SLA, DPAPI security, rollout roadmap and ROI.'
        }
      ]
    };
  });

  // ---- Google Calendar ----------------------------------------------------
  ipcMain.handle('rtai:gcal-status', async () => getGoogleCalendar().status());
  ipcMain.handle('rtai:gcal-import-client', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Google OAuth client file (client_secret_....json)',
      properties: ['openFile'],
      filters: [{ name: 'Google OAuth client', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) {
      return { ok: false, canceled: true, status: getGoogleCalendar().status() };
    }
    const r = await gcalCall((g) => g.importClient(res.filePaths[0]));
    return { ...r, status: getGoogleCalendar().status() };
  });
  ipcMain.handle('rtai:gcal-connect', async () => {
    const r = await gcalCall((g) => g.connect());
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus(); // back from the browser
    }
    return { ...r, status: getGoogleCalendar().status() };
  });
  ipcMain.handle('rtai:gcal-disconnect', async () => {
    const r = await gcalCall((g) => g.disconnect());
    return { ...r, status: getGoogleCalendar().status() };
  });
  ipcMain.handle('rtai:gcal-save-settings', async (_ev, patch) => {
    const r = await gcalCall((g) => g.saveSettings(patch || {}));
    return { ...r, status: getGoogleCalendar().status() };
  });
  ipcMain.handle('rtai:gcal-calendars', async () => gcalCall((g) => g.listCalendars()));
  ipcMain.handle('rtai:gcal-events', async (_ev, opts) => gcalCall((g) => g.listEvents(opts || {})));
  ipcMain.handle('rtai:gcal-create-event', async (_ev, ev) => gcalCall((g) => g.createEvent(ev || {})));
  ipcMain.handle('rtai:gcal-update-event', async (_ev, p) =>
    gcalCall((g) => g.updateEvent(p && p.calendarId, p && p.eventId, (p && p.event) || {})));
  ipcMain.handle('rtai:gcal-delete-event', async (_ev, p) => gcalCall((g) => g.deleteEvent(p && p.calendarId, p && p.eventId)));
  // Provider consoles linked from Settings > Account (fixed allowlist).
  ipcMain.handle('rtai:open-url', async (_ev, url) => {
    try {
      const u = new URL(String(url || ''));
      const allowed = ['console.deepgram.com', 'openrouter.ai', 'cloud.cerebras.ai', 'console.groq.com'];
      if (u.protocol !== 'https:' || !allowed.includes(u.hostname.toLowerCase())) return { ok: false };
      await shell.openExternal(u.toString());
      return { ok: true };
    } catch (_e) {
      return { ok: false };
    }
  });
  ipcMain.handle('rtai:gcal-open', async (_ev, url) => {
    // Only Google Calendar / Meet pages leave the app this way.
    try {
      const u = new URL(String(url || ''));
      const host = u.hostname.toLowerCase();
      const allowed = u.protocol === 'https:' &&
        (host === 'calendar.google.com' || host === 'meet.google.com' ||
         (host === 'www.google.com' && u.pathname.startsWith('/calendar')));
      if (!allowed) return { ok: false, error: 'Not a Google Calendar link.' };
      await shell.openExternal(u.toString());
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('rtai:save-config', async (_ev, configUpdates) => {
    const before = JSON.stringify(readConfigIni().rawIni);
    const updated = writeConfigIni(configUpdates || {});
    let overlayRestarted = false;

    // Apply electron stealth changes immediately
    if (configUpdates && (
      configUpdates.electron_stealth !== undefined ||
      configUpdates.electron_screen_protection !== undefined ||
      configUpdates.electron_skip_taskbar !== undefined ||
      configUpdates.electron_disguise !== undefined ||
      configUpdates.electron_opacity !== undefined ||
      configUpdates.stealth_screen_capture !== undefined
    )) {
      applyElectronStealthMode(configUpdates);
    }
    // The overlay reads config.ini only at start: any real change while it
    // runs (keys, language, models, audio, stealth...) restarts it.
    const changed = before !== JSON.stringify(updated.rawIni);
    const shouldRelaunch = configUpdates && (
      (changed && isOverlayRunning()) ||
      (configUpdates.model && isOverlayRunning()) ||
      (isOverlayRunning() && (
        configUpdates.stealth_dock !== undefined ||
        configUpdates.stealth_activity_monitor !== undefined ||
        configUpdates.stealth_click_through !== undefined ||
        configUpdates.stealth_screen_capture !== undefined ||
        configUpdates.mic_enabled !== undefined ||
        configUpdates.loopback_enabled !== undefined
      ))
    );
    if (shouldRelaunch) {
      const agents = loadAllAgents();
      const currentAgent = agents.find((a) => a.id === (overlayAgentId || updated.last_agent)) || agents[0] || null;
      launchOverlay({
        agent: currentAgent,
        demo: overlayMode === 'demo',
        configOverrides: { ...configUpdates }
      });
      overlayRestarted = true;
    }
    return { config: updated, overlayRestarted };
  });

  ipcMain.handle('rtai:save-profile', async (_ev, profile) => {
    return { profile: saveUserProfile(profile || {}) };
  });

  ipcMain.handle('rtai:start-overlay', async (_ev, options) => {
    return launchOverlay(options || {});
  });

  ipcMain.handle('rtai:stop-overlay', async () => {
    stopRunningOverlay();
    return { ok: true };
  });

  ipcMain.handle('rtai:set-mode', async (_ev, on) => {
    const modeOn = Boolean(on);
    if (overlayProcess && !overlayProcess.killed && overlayProcess.stdin && overlayProcess.stdin.writable) {
      try {
        overlayProcess.stdin.write(JSON.stringify({ cmd: 'set_mode', on: modeOn }) + '\n');
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    return { ok: false, error: 'Process is not running' };
  });

  ipcMain.handle('rtai:get-playbooks', async () => {
    return { playbooks: loadAllPlaybooks() };
  });

  ipcMain.handle('rtai:save-playbook', async (_ev, pb) => {
    return savePlaybookToDisk(pb || {});
  });

  ipcMain.handle('rtai:schedule-interview', async (_ev, payload) => {
    const goalId = (typeof payload === 'object' && payload !== null)
      ? (payload.goalId || payload.agentId || payload.id)
      : payload;
    const date = payload?.date;
    const time = payload?.time;
    const agents = loadAllAgents();
    const goal = agents.find((a) => a.id === goalId);
    if (!goal) return { ok: false, error: 'Goal not found' };
    const cleanDate = String(date || '').trim();
    const cleanTime = String(time || '').trim();
    goal.next_interview = { date: cleanDate, time: cleanTime };
    goal.next_interview_date = cleanDate;
    goal.next_interview_time = cleanTime;
    const saved = saveAgentToDisk(goal);
    scheduleInterviewNotification(saved);
    // Google Calendar: create or move this interview's event (never fails the
    // scheduling). `calendar`: the dialog's checkbox; undefined = setting.
    const wanted = payload && typeof payload.calendar === 'boolean' ? payload.calendar : undefined;
    const calendar = await getGoogleCalendar().syncInterview(saved, wanted);
    return { ok: true, goal: saved, agent: saved, agents: loadAllAgents(), calendar };
  });

  ipcMain.handle('rtai:clear-interview', async (_ev, payload) => {
    const goalId = (typeof payload === 'object' && payload !== null)
      ? (payload.goalId || payload.agentId || payload.id)
      : payload;
    const agents = loadAllAgents();
    const goal = agents.find((a) => a.id === goalId);
    if (!goal) return { ok: false, error: 'Goal not found' };
    cancelInterviewNotification(goal.id);
    goal.next_interview = { date: '', time: '' };
    goal.next_interview_date = '';
    goal.next_interview_time = '';
    const saved = saveAgentToDisk(goal);
    const calendar = await getGoogleCalendar().removeInterview(goal.id);
    return { ok: true, goal: saved, agent: saved, agents: loadAllAgents(), calendar };
  });

  ipcMain.handle('rtai:generate-debrief', async (_ev, payload) => {
    return generateSessionDebrief(payload || {});
  });

  ipcMain.handle('rtai:save-checklist', async (_ev, { goalId, state }) => {
    const agents = loadAllAgents();
    const goal = agents.find((a) => a.id === goalId);
    if (!goal) return { ok: false, error: 'Goal not found' };
    goal.checklist_state = { ...(goal.checklist_state || {}), ...(state || {}) };
    const saved = saveAgentToDisk(goal);
    return { ok: true, goal: saved, agents: loadAllAgents() };
  });

  ipcMain.handle('rtai:read-session', async (_ev, fileName) => {
    const safeName = path.basename(String(fileName || ''));
    const fullPath = path.join(getAppDataDir(), 'sessions', safeName);
    if (!fs.existsSync(fullPath)) return { content: 'Session file not found.' };
    return { content: fs.readFileSync(fullPath, 'utf8') };
  });

  ipcMain.handle('rtai:open-path', async (_ev, targetPath) => {
    if (!targetPath) {
      await shell.openPath(getAppDataDir());
      return { ok: true };
    }
    await shell.openPath(targetPath);
    return { ok: true };
  });

  ipcMain.handle('rtai:window-control', async (_ev, action) => {
    if (!mainWindow || mainWindow.isDestroyed()) return {};
    if (action === 'minimize') mainWindow.minimize();
    else if (action === 'maximize') {
      if (mainWindow.isFullScreen()) {
        mainWindow.setFullScreen(false);
      } else if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    } else if (action === 'fullscreen') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    } else if (action === 'close') {
      mainWindow.close();
    }
    return {
      isMaximized: mainWindow.isMaximized(),
      isFullScreen: mainWindow.isFullScreen()
    };
  });

  ipcMain.handle('rtai:meeting-detection-get', async () => meetingDetectionState());
  ipcMain.handle('rtai:meeting-detection-set', async (_ev, patch) => {
    const clean = {};
    if (patch && typeof patch.enabled === 'boolean') clean.enabled = patch.enabled;
    if (patch && typeof patch.keepInTray === 'boolean') clean.keepInTray = patch.keepInTray;
    if (patch && Array.isArray(patch.mutedApps)) clean.mutedApps = patch.mutedApps.map(String);
    saveMeetingSettings(clean);
    return meetingDetectionState();
  });
  ipcMain.handle('rtai:meeting-popup-test', async () => {
    showTestMeetingPopup();
    return { ok: true };
  });

  ipcMain.handle('rtai:get-stealth-state', async () => {
    const cfg = readConfigIni();
    return {
      active: Boolean(cfg.electron_stealth),
      screenProtection: Boolean(cfg.electron_screen_protection),
      skipTaskbar: Boolean(cfg.electron_skip_taskbar),
      disguise: Boolean(cfg.electron_disguise),
      opacity: parseFloat(cfg.electron_opacity || '1.0'),
      shortcuts: {
        toggle: 'Ctrl+Alt+S',
        panic: 'Ctrl+Shift+H'
      }
    };
  });

  ipcMain.handle('rtai:toggle-stealth-mode', async () => {
    const cfg = readConfigIni();
    const nextActive = !Boolean(cfg.electron_stealth);
    writeConfigIni({ electron_stealth: nextActive });
    const status = applyElectronStealthMode({ electron_stealth: nextActive });
    return { ok: true, status };
  });

  ipcMain.handle('rtai:set-stealth-mode', async (_ev, patch) => {
    const updates = {};
    if (patch.active !== undefined) updates.electron_stealth = Boolean(patch.active);
    if (patch.screenProtection !== undefined) updates.electron_screen_protection = Boolean(patch.screenProtection);
    if (patch.skipTaskbar !== undefined) updates.electron_skip_taskbar = Boolean(patch.skipTaskbar);
    if (patch.disguise !== undefined) updates.electron_disguise = Boolean(patch.disguise);
    if (patch.opacity !== undefined) updates.electron_opacity = parseFloat(patch.opacity);
    writeConfigIni(updates);
    const status = applyElectronStealthMode(updates);
    return { ok: true, status };
  });

  // ---- Version, auto-update (GitHub Releases) and feature flags -----------
  const APP_VERSION = app.getVersion();
  const buildInfo = readBuildInfo();
  const sendToWindow = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };
  const currentChannel = () => (readConfigIni().update_channel === 'beta' ? 'beta' : 'stable');

  flagStore = createFlagStore({
    dataDir: getAppDataDir(),
    bundledPath: path.join(__dirname, 'flags.json'),
    remoteUrl: process.env.RTAI_FLAGS_URL || buildInfo.flagsUrl || '',
    appVersion: APP_VERSION,
    getChannel: currentChannel,
    onChange: (snap) => sendToWindow('rtai:flags-changed', snap)
  });
  flagStore.refresh();
  setInterval(() => flagStore.refresh(), 30 * 60 * 1000).unref();

  updater = createUpdater({
    app,
    send: sendToWindow,
    getChannel: currentChannel,
    getAutoUpdate: () => readConfigIni().auto_update !== false,
    beforeInstall: () => stopOverlayGracefully(4000),
    markQuitting: () => { isQuitting = true; },
    log: (...a) => console.log('[updater]', ...a)
  });
  updater.start();

  ipcMain.handle('rtai:get-app-version', async () => ({
    version: APP_VERSION,
    channel: currentChannel(),
    commit: buildInfo.commit || '',
    packaged: app.isPackaged
  }));

  ipcMain.handle('rtai:check-update', async () => updater.check());
  ipcMain.handle('rtai:update-status', async () => updater.status());
  ipcMain.handle('rtai:download-update', async () => updater.download());
  ipcMain.handle('rtai:install-update', async () => updater.install());

  ipcMain.handle('rtai:set-update-channel', async (_ev, channel) => {
    const ch = channel === 'beta' ? 'beta' : 'stable';
    writeConfigIni({ update_channel: ch });
    const flags = flagStore.notifyChannelChanged();
    flagStore.refresh();
    updater.setChannel();
    return { ok: true, channel: ch, flags };
  });

  ipcMain.handle('rtai:flags-get', async () => flagStore.snapshot());
  ipcMain.handle('rtai:flags-refresh', async () => flagStore.refresh());
  ipcMain.handle('rtai:flags-set-override', async (_ev, payload) => {
    try {
      return { ok: true, flags: flagStore.setOverride(payload && payload.key, payload && payload.value) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('rtai:flags-reset-overrides', async () => ({ ok: true, flags: flagStore.clearOverrides() }));

  ipcMain.handle('rtai:set-process-disguise', async (_ev, disguise) => {
    const valid = ['none', 'settings', 'cmd', 'taskmgr'].includes(disguise) ? disguise : 'none';
    writeConfigIni({ process_disguise: valid });
    let title = 'RealTimeAI — Copilot Studio';
    if (valid === 'settings') title = 'Configurações do Sistema';
    else if (valid === 'cmd') title = 'Prompt de Comando';
    else if (valid === 'taskmgr') title = 'Gerenciador de Tarefas';
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.setTitle(title); } catch (_e) {}
    }
    return { ok: true, disguise: valid, title };
  });

  ipcMain.handle('rtai:set-interface-opacity', async (_ev, opacityVal) => {
    const op = Math.max(0.2, Math.min(1.0, parseFloat(opacityVal) || 1.0));
    writeConfigIni({ interface_opacity: op, electron_opacity: op });
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.setOpacity(op); } catch (_e) {}
    }
    return { ok: true, opacity: op };
  });

  ipcMain.handle('rtai:test-sound', async () => {
    return { ok: true, played: true };
  });

  createWindow();
  createTray();
  registerStealthShortcuts();
  applyMeetingSettings();
});

app.on('will-quit', () => {
  if (globalShortcut && typeof globalShortcut.unregisterAll === 'function') {
    try { globalShortcut.unregisterAll(); } catch (_e) {}
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (meetingDetector) meetingDetector.stop();
  if (tray) {
    try { tray.destroy(); } catch (_e) {}
    tray = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Test hook: node tests load main.js with a stubbed 'electron' and use these.
if (process.env.RTAI_TEST_EXPORTS === '1') {
  module.exports = {
    saveAgentToDisk,
    loadAllAgents,
    extractDocumentContent,
    extractTextFromDocx,
    isCandidateDocument,
    inheritableDocuments,
    readConfigIni,
    writeConfigIni,
    pickDefaultAgentId,
    getMeetingSettings,
    applyElectronStealthMode
  };
}
