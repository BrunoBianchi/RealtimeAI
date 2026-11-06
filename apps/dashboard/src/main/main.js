// Node's on-disk compile cache (Node >= 22.1, Electron >= 33): the main
// process modules are parsed once and reused on the next launches.
try {
  require('node:module').enableCompileCache?.();
} catch (_e) {}

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, safeStorage, Tray, Menu, screen, Notification, globalShortcut, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const { spawn, execFile, execSync } = require('child_process');
const { createGoogleCalendar } = require('./google_calendar');
const { MeetingDetector, APP_NAMES } = require('./meeting_detector');
const { createMeetingPopup } = require('./meeting_popup');
const { createFlagStore } = require('./feature_flags');
const { createUpdater } = require('./updater');
const { createCloudSync } = require('./cloud_sync');
const { createCloudAccount, effectiveServerUrl } = require('./cloud_account');
const { normalizeUiLanguage, resolveUiLocale, systemLanguages, SUPPORTED: UI_LOCALES } = require('./ui_locale');
const I18n = require('../renderer/i18n.js');
require('../renderer/locales/pt-BR.js');

// Interface text shown by the main process itself; same catalogs as the renderer.
function tm(text, vars) {
  I18n.locale = resolveUiLocale(readConfigIni().ui_language, systemLanguages(app));
  return I18n.t(text, vars);
}
const localBackend = require('./local_backend');
const { settingsSectionFromArgv } = require('./launch_args');
const jevEngine = require('./jev_engine');
const { createMockInterviews, languageName } = require('./mock_interview');
const companyLogoService = require('./company_logo_service');

// apps/dashboard (or the app.asar root once packaged) and the repository root.
const APP_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');
const PRELOAD_DIR = path.join(__dirname, '..', 'preload');
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

let mainWindow = null;
let overlayProcess = null;
let overlayMode = null;
let overlayAgentId = null;
let overlayStartedAt = 0;
let overlayVersion = ''; // reported by the overlay's hello (rtai_app --server)
let isQuitting = false;
let flagStore = null;
let updater = null;

// One dashboard at a time: it lives in the tray and watches for meetings, so a
// second launch just brings the first one forward.
// Windows shows this ID as the name on notifications, so it is the app's name.
// The packaged app also keeps the profile it had before its rename, so sign-ins
// and preferences survive.
if (typeof app.setAppUserModelId === 'function') app.setAppUserModelId('lipcue.com');
if (app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'RealTimeAI'));

const gotSingleInstanceLock =
  typeof app.requestSingleInstanceLock !== 'function' || app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const section = settingsSectionFromArgv(argv);
    if (section) {
      showSettingsWindow(section);
      return;
    }
    if (!app.isPackaged && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reloadIgnoringCache();
    }
    showMainWindow();
  });
}

// The registry probe spawns `reg.exe` (tens of ms, blocking the main
// process), so its answer is cached until Windows reports a theme change.
let windowsDarkCache = null;
function isWindowsDarkTheme() {
  if (windowsDarkCache !== null) return windowsDarkCache;
  windowsDarkCache = probeWindowsDarkTheme();
  return windowsDarkCache;
}

function probeWindowsDarkTheme() {
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
  const preference = prefOverride || profile.themePreference || 'dark';
  const windowsDark = isWindowsDarkTheme();
  let resolved = 'dark';
  if (preference === 'light') resolved = 'light';
  else if (preference === 'dark') resolved = 'dark';
  else if (preference === 'system') resolved = windowsDark ? 'dark' : 'light';
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
// in the app data folder, next to this file and in the project folder; without
// one, a signed-in app uses the lipcue.com server's client (it does the token
// exchanges, so the client secret stays on the server).
let googleCalendar = null;
let googleBroker = { client: null, at: 0 };
async function refreshGoogleBroker(force = false) {
  if (!isSignedIn()) {
    googleBroker = { client: null, at: 0 };
    return null;
  }
  if (!force && googleBroker.at && Date.now() - googleBroker.at < 5 * 60 * 1000) return googleBroker.client;
  const r = await cloudAccount.api('GET', '/v1/integrations/google');
  if (r.ok && r.data && r.data.client_id) googleBroker = { client: r.data, at: Date.now() };
  else if (r.status !== 0) googleBroker = { client: null, at: Date.now() }; // keep the last one on network errors
  return googleBroker.client;
}
function getGoogleCalendar() {
  if (!googleCalendar) {
    googleCalendar = createGoogleCalendar({
      dataDir: getAppDataDir(),
      searchDirs: [APP_ROOT, REPO_ROOT],
      safeStorage,
      openExternal: (url) => shell.openExternal(url),
      broker: {
        client: () => (isSignedIn() ? googleBroker.client : null),
        token: (params) => cloudAccount.api('POST', '/v1/integrations/google/token', params, { timeoutMs: 15000 })
      }
    });
  }
  return googleCalendar;
}

// Runs a Google Calendar action for the renderer: { ok, ...result } or
// { ok: false, error, code } (never throws across IPC).
async function gcalCall(fn) {
  try {
    await refreshGoogleBroker();
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
    return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'build-info.json'), 'utf8')) || {};
  } catch (_e) {
    return {};
  }
}

function getOverlayExecutablePath() {
  const workspaceRoot = REPO_ROOT;
  const candidates = [
    // Installed app: the CI bundles the native overlay as an extra resource.
    ...(app.isPackaged ? [path.join(process.resourcesPath, 'native', 'rtai_app.exe')] : []),
    path.join(workspaceRoot, 'build', 'bin', 'Release', 'rtai_app.exe'),
    path.join(workspaceRoot, 'build', 'bin', 'Debug', 'rtai_app.exe')
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
  const servidor = ini.servidor || {};

  // A key is never sent to the renderer in full: a plaintext one (an env var,
  // or one the engine has not encrypted yet) would show up as the field's
  // placeholder, i.e. on a screen share.
  const maskKey = (v) => {
    if (!v) return '';
    if (v.startsWith('dpapi:')) return '•••••••• (Encrypted via Windows DPAPI)';
    return v.length > 12 ? `••••••••${v.slice(-4)}` : '••••••••';
  };

  return {
    configPath,
    rawIni: ini,
    deepgram_key_display: maskKey(dg.api_key || process.env.DEEPGRAM_API_KEY || ''),
    has_deepgram_key: Boolean(dg.api_key || process.env.DEEPGRAM_API_KEY),
    llm_key_display: maskKey(llm.api_key || process.env.OPENROUTER_API_KEY || ''),
    has_llm_key: Boolean(llm.api_key || process.env.OPENROUTER_API_KEY),
    cerebras_key_display: maskKey(llm.cerebras_api_key || process.env.CEREBRAS_API_KEY || ''),
    has_cerebras_key: Boolean(llm.cerebras_api_key || process.env.CEREBRAS_API_KEY),
    groq_key_display: maskKey(llm.groq_api_key || process.env.GROQ_API_KEY || ''),
    has_groq_key: Boolean(llm.groq_api_key || process.env.GROQ_API_KEY),
    openai_key_display: maskKey(llm.openai_api_key || process.env.OPENAI_API_KEY || ''),
    has_openai_key: Boolean(llm.openai_api_key || process.env.OPENAI_API_KEY),
    anthropic_key_display: maskKey(llm.anthropic_api_key || process.env.ANTHROPIC_API_KEY || ''),
    has_anthropic_key: Boolean(llm.anthropic_api_key || process.env.ANTHROPIC_API_KEY),
    gemini_key_display: maskKey(llm.gemini_api_key || process.env.GEMINI_API_KEY || ''),
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
    noise_cancellation: (audio.cancelamento_ruido ?? audio.noise_cancellation ?? 'sim') !== 'nao' &&
                        (audio.cancelamento_ruido ?? audio.noise_cancellation ?? 'sim') !== 'false',
    vad: audio.vad || 'silero',
    energy_threshold: parseFloat(audio.limiar_energia || '0.015'),
    save_sessions: (sessao.salvar ?? 'sim') !== 'nao' && (sessao.salvar ?? 'sim') !== 'false',
    last_agent: sessao.ultimo_agente || '',
    hotkeys: { ...(ini.atalhos || {}) },
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
    // Interface language: auto = follow Windows (see ui_locale.js), or a locale.
    ui_language: normalizeUiLanguage(sistema.idioma_interface || sistema.ui_language || 'auto'),
    process_disguise: stealth.process_disguise || (stealth.electron_disguise === 'sim' ? 'settings' : 'none'),
    interface_opacity: parseFloat(stealth.interface_opacity || stealth.electron_opacity || '1.0'),
    share_anonymized_questions: (stealth.share_anonymized_questions ?? stealth.contribuir_perguntas ?? 'sim') !== 'nao' &&
                                (stealth.share_anonymized_questions ?? stealth.contribuir_perguntas ?? 'sim') !== 'false',
    calendar_ics_url: agenda.google_ics_url || '',
    calendar_oauth_token: agenda.google_oauth_token || '',
    // lipcue.com cloud ([servidor]): auto = our servers when signed in,
    // nuvem = always, proprio = only the user's own keys (open-source mode).
    // Stored as written; the engine validates it (unknown values act as auto).
    server_mode: servidor.modo || 'auto',
    server_url: servidor.url || '',
    server_region: servidor.regiao || 'auto',
    server_url_effective: effectiveServerUrl(servidor.url || ''),
    has_server_token: Boolean(servidor.token || process.env.RTAI_SERVER_TOKEN),
    server_token_display: maskKey(servidor.token || '')
  };
}

// Signed in to a lipcue.com account (mirrors cloud::signed_in). The whole app
// is gated on it: the renderer shows only the sign-in screen and nothing
// starts the copilot without it.
function isSignedIn(cfg) {
  const c = cfg || readConfigIni();
  return Boolean(c.has_server_token) && Boolean(c.server_url_effective);
}

// Local mode ([servidor] modo = local, mirrors cloud::local_mode): no
// account and no server, only the user's own keys. The app is usable, with
// the PRO features (cloud backup, sync, Google Calendar) shown as ads.
function isLocalMode(cfg) {
  const c = cfg || readConfigIni();
  return ['local', 'offline'].includes(String(c.server_mode || '').trim().toLowerCase());
}

// The app is unlocked when signed in or in local mode.
function canUseApp(cfg) {
  const c = cfg || readConfigIni();
  return isSignedIn(c) || isLocalMode(c);
}

// Signed in and using the server credentials (mirrors cloud::choose_backend).
function cloudBackendActive(cfg) {
  const c = cfg || readConfigIni();
  return c.server_mode !== 'proprio' && !isLocalMode(c) && isSignedIn(c);
}

const LOGIN_REQUIRED = { ok: false, needsLogin: true, error: 'Sign in to your lipcue.com account, or continue locally with your own API keys.' };

function hasOwnAiKey(c) {
  return Boolean(c.has_llm_key || c.has_cerebras_key || c.has_groq_key || c.has_openai_key || c.has_anthropic_key || c.has_gemini_key);
}

// Before a live start: signed in, keys present when using own keys, and the
// plan still has minutes (the engine asks the server again: this is only so
// the user gets the reason right away instead of a failed start).
async function checkCanStartLive() {
  const cfg = readConfigIni();
  if (isLocalMode(cfg)) {
    if (!cfg.has_deepgram_key) return { ok: false, needsKeys: true, error: 'Local mode: add your Deepgram key in AI and models.' };
    if (!hasOwnAiKey(cfg)) return { ok: false, needsKeys: true, error: 'Local mode: add an AI key (OpenRouter, Cerebras…) in AI and models.' };
    return { ok: true };
  }
  if (!isSignedIn(cfg)) return LOGIN_REQUIRED;
  if (!cloudBackendActive(cfg) && !cfg.has_deepgram_key) {
    return { ok: false, error: '"My keys" mode: set the Deepgram key or switch back to the lipcue.com servers.' };
  }
  // Fresh: the session that just ended may have used the last minutes.
  const st = await cloudAccount.status(true);
  if (st && st.expired) return LOGIN_REQUIRED;
  if (st && st.entitlement && !st.entitlement.canStart) {
    return { ok: false, needsUpgrade: true, error: st.entitlement.reason };
  }
  return { ok: true };
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
  const audioInputDevice = updates.audio_input_device ?? updates.input_device ?? current.audio_input_device ?? 'default';
  const audioOutputDevice = updates.audio_output_device ?? updates.output_device ?? current.audio_output_device ?? 'default';
  const noiseCancellation = (updates.noise_cancellation ?? updates.cancelamento_ruido ?? current.noise_cancellation) ? 'sim' : 'nao';
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
  const uiLanguage = normalizeUiLanguage(updates.ui_language ?? current.ui_language ?? 'auto');
  const processDisguise = updates.process_disguise ?? current.process_disguise ?? 'none';
  const interfaceOpacity = String(updates.interface_opacity ?? current.interface_opacity ?? '1.0');
  const shareAnonymizedQuestions = (updates.share_anonymized_questions ?? current.share_anonymized_questions) ? 'sim' : 'nao';
  const calendarIcsUrl = updates.calendar_ics_url ?? current.calendar_ics_url;
  const calendarOauth = updates.calendar_oauth_token ?? current.calendar_oauth_token;
  const serverMode = String(updates.server_mode ?? current.server_mode ?? 'auto').trim() || 'auto';
  const serverUrl = String(updates.server_url ?? current.server_url ?? '').trim();
  const serverRegion = String(updates.server_region ?? current.server_region ?? 'auto').trim() || 'auto';
  const serverToken = updates.server_token !== undefined ? pickKey(updates.server_token, raw.servidor?.token) : (raw.servidor?.token || '');

  const managedLines = [
    '# lipcue.com settings (shared by the dashboard and the overlay HUD)',
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
    `cancelamento_ruido = ${noiseCancellation}`,
    `noise_cancellation = ${noiseCancellation}`,
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
    '[atalhos]',
    ...Object.entries(updates.hotkeys && typeof updates.hotkeys === 'object' ? updates.hotkeys : current.hotkeys || {})
      .filter(([k, v]) => /^[a-z0-9_]+$/.test(k) && /^[\w+]+$/.test(String(v)))
      .map(([k, v]) => `${k} = ${v}`),
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
    `share_anonymized_questions = ${shareAnonymizedQuestions}`,
    '',
    '[sistema]',
    `auto_update = ${autoUpdate}`,
    `update_channel = ${updateChannel}`,
    `idioma_interface = ${uiLanguage}`,
    '',
    '[agenda]',
    `google_ics_url = ${calendarIcsUrl}`,
    `google_oauth_token = ${calendarOauth}`,
    '',
    '[servidor]',
    `modo = ${serverMode}`,
    `url = ${serverUrl}`,
    `regiao = ${serverRegion}`,
    `token = ${serverToken}`,
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

// The engine encrypts plaintext secrets in config.ini with DPAPI; run it
// right after a sign-in so the device token is never left readable on disk.
function protectConfigSecrets() {
  const exe = getOverlayExecutablePath();
  if (!exe || !fs.existsSync(exe)) return; // the next overlay start does it
  try {
    execFile(exe, ['--protect-keys'], { windowsHide: true, timeout: 15000 }, () => {});
  } catch (_e) { /* best effort */ }
}

// The dashboard keeps its own copy of the device token (Electron safeStorage)
// for account calls (/v1/me, logout): once the engine seals config.ini with
// DPAPI, Node can no longer read it back from there.
function cloudTokenPath() {
  return path.join(getAppDataDir(), 'cloud_token.bin');
}

function readCloudToken() {
  try {
    const p = cloudTokenPath();
    if (fs.existsSync(p) && safeStorage && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(fs.readFileSync(p));
    }
  } catch (_e) { /* fall through */ }
  const t = (readConfigIni().rawIni.servidor || {}).token || process.env.RTAI_SERVER_TOKEN || '';
  return t.startsWith('dpapi:') ? '' : t;
}

function saveCloudToken(token) {
  // Signing in leaves local mode: the account's plan takes over.
  const leaveLocal = token && isLocalMode() ? { server_mode: 'auto' } : {};
  writeConfigIni({ server_token: token || '__CLEAR__', ...leaveLocal });
  try {
    if (!token) fs.rmSync(cloudTokenPath(), { force: true });
    else if (safeStorage && safeStorage.isEncryptionAvailable()) fs.writeFileSync(cloudTokenPath(), safeStorage.encryptString(token));
  } catch (_e) { /* the engine copy is the one that matters */ }
  if (token) protectConfigSecrets();
}

const cloudAccount = createCloudAccount({
  getServerUrl: () => readConfigIni().server_url,
  hasToken: () => readConfigIni().has_server_token,
  readToken: readCloudToken,
  saveToken: saveCloudToken,
  openBrowser: (url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  },
  emit: (e) => {
    // A sign-in rewrote config.ini: hand the renderer the fresh config.
    const payload = e.type === 'signed_in' ? { ...e, config: readConfigIni() } : e;
    if (e.type === 'signed_in') scheduleCloudSync();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('rtai:cloud-event', payload);
  },
  appVersion: typeof app.getVersion === 'function' ? app.getVersion() : ''
});

// Sessions, history and the question bank follow the account (cloud_sync.js).
const cloudSync = createCloudSync({
  dataDir: () => getAppDataDir(),
  client: () => cloudAccount.syncClient,
  owner: async () => {
    if (!isSignedIn()) return '';
    const r = await cloudAccount.api('GET', '/v1/me');
    return r.ok && r.data ? String(r.data.email || '') : '';
  },
  busy: () => isOverlayRunning() // a live session is still writing its files
});
async function runCloudSync() {
  const res = await cloudSync.syncNow();
  if (res && (res.downloaded || res.removed) && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('rtai:cloud-synced', res);
  }
  return res;
}
// Everything of the user's in the data folder. What stays holds nothing personal:
// the downloaded speech model, the install id and the feature flags.
const KEEP_ON_ERASE = new Set(['models', 'install-id', 'flags-active.json', 'flags-cache.json', 'flags-overrides.json']);
function eraseLocalUserData() {
  const dir = getAppDataDir();
  for (const name of fs.readdirSync(dir)) {
    if (KEEP_ON_ERASE.has(name)) continue;
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch (err) {
      console.warn('[erase]', name, err && err.message); // e.g. a log still open
    }
  }
  getAppDataDir(); // recreates the empty folders
}
let cloudSyncTimer = null;
function scheduleCloudSync() {
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => {
    if (isSignedIn()) runCloudSync().catch((err) => console.warn('[cloud-sync]', err));
  }, 3000);
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

// Where the dashboard's own AI calls go (compaction, JEV, dossier, OCR):
// the lipcue.com server when signed in, so no key is needed, or OpenRouter
// with the user's key in "My keys" mode. null when neither is available.
const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
function aiTarget(title = 'lipcue.com Studio') {
  const cfg = readConfigIni();
  const ownKey = getOpenRouterApiKey();
  const direct = ownKey
    ? { url: OPENROUTER_CHAT_URL, headers: { Authorization: `Bearer ${ownKey}`, 'HTTP-Referer': 'https://lipcue.com', 'X-Title': title } }
    : null;
  if (isLocalMode(cfg)) return direct; // never the server in local mode
  if (cfg.server_mode === 'proprio' && direct) return direct;
  return (isSignedIn(cfg) && cloudAccount.aiEndpoint()) || direct;
}

// POST to an aiTarget(); resolves { status, body } ('' body on failure).
function aiPost(target, payload, timeoutMs) {
  return new Promise((resolve) => {
    const lib = target.url.startsWith('http:') ? http : https;
    const req = lib.request(
      target.url,
      {
        method: 'POST',
        headers: { ...target.headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload, 'utf8') },
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '', error: 'timeout' });
    });
    req.end(payload);
  });
}

function callOpenRouterSol61(messagesOrSystem, userOrMaxTokens = 1800, maybeMaxTokens = 1800) {
  const target = aiTarget('lipcue.com Studio');
  if (!target) return Promise.resolve('');

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

  return aiPost(target, payload, 18000).then((r) => {
    try {
      return String(JSON.parse(r.body)?.choices?.[0]?.message?.content || '').trim();
    } catch (_e) {
      return '';
    }
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

function guessDocumentTag(fileName, defaultTag) {
  const lower = String(fileName || '').toLowerCase();
  if (lower.includes('cv') || lower.includes('curriculo') || lower.includes('resume')) return 'resume';
  if (lower.includes('vaga') || lower.includes('job') || lower.includes('jd')) return 'job';
  if (lower.includes('proj') || lower.includes('arquitetura') || lower.includes('readme')) return 'project';
  return defaultTag || 'doc';
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

// Self-heal for agent files written by older builds: some free-text fields
// carry one round of cp1252 double-encoding (UTF-8 decoded as Windows-1252
// and re-encoded, so "A\u00e7\u00e3o" reads as "A\u00c3\u00a7\u00c3\u00a3o"). Detection is
// conservative: a string is repaired only when every non-ASCII code point maps
// back to a single cp1252 byte AND the re-encoded bytes decode as valid UTF-8,
// which legitimate Portuguese/Greek/Cyrillic text virtually never does.
const CP1252_REVERSE = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f
};

function looksDoubleEncoded(s) {
  if (typeof s !== 'string' || !s) return false;
  let nonAscii = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp <= 0x7f) continue;
    nonAscii += 1;
    if (!((cp >= 0xa0 && cp <= 0xff) || Object.prototype.hasOwnProperty.call(CP1252_REVERSE, cp))) {
      return false; // contains a code point cp1252 cannot produce
    }
  }
  return nonAscii > 0;
}

function repairDoubleEncoded(s) {
  if (typeof s !== 'string' || !s || !looksDoubleEncoded(s)) return s;
  const bytes = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp <= 0xff) bytes.push(cp);
    else bytes.push(CP1252_REVERSE[cp]);
  }
  const decoded = Buffer.from(bytes).toString('utf8');
  if (decoded.includes('\uFFFD')) return s; // not valid UTF-8 after repair
  // Mojibake always shrinks (each original byte became 2+ UTF-8 bytes).
  // Same-size output means the input was already clean accented text.
  if (Buffer.byteLength(decoded, 'utf8') >= Buffer.byteLength(s, 'utf8')) return s;
  return decoded;
}

function healAgentStrings(ag) {
  if (!ag || typeof ag !== 'object') return false;
  let changed = false;
  const fields = ['name', 'company', 'role', 'job_description', 'calendar_event',
    'company_research', 'company_dossier', 'custom_instructions', 'extra_instructions',
    'mini_compact', 'next_focus', 'playbook_name', 'answer_language', 'coding_language'];
  for (const f of fields) {
    if (typeof ag[f] === 'string') {
      const fixed = repairDoubleEncoded(ag[f]);
      if (fixed !== ag[f]) { ag[f] = fixed; changed = true; }
    }
  }
  if (Array.isArray(ag.documents)) {
    for (const d of ag.documents) {
      if (d && typeof d === 'object') {
        for (const k of ['name', 'title', 'content']) {
          if (typeof d[k] === 'string') {
            const fixed = repairDoubleEncoded(d[k]);
            if (fixed !== d[k]) { d[k] = fixed; changed = true; }
          }
        }
      }
    }
  }
  if (ag.goal_memory && typeof ag.goal_memory === 'object') {
    for (const key of ['strengths', 'improve']) {
      if (Array.isArray(ag.goal_memory[key])) {
        ag.goal_memory[key] = ag.goal_memory[key].map((s) => {
          const fixed = repairDoubleEncoded(s);
          if (fixed !== s) changed = true;
          return fixed;
        });
      }
    }
  }
  return changed;
}
// Older versions created an empty "My first goal" on first launch. Removed
// unless the user filled it in or recorded a session with it.
const STARTER_GOAL_ID = 'my-first-goal';
function removeUntouchedStarterGoal() {
  const filePath = path.join(getAppDataDir(), 'agents', `${STARTER_GOAL_ID}.json`);
  if (!fs.existsSync(filePath)) return false;
  let g;
  try {
    g = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
  } catch (_e) {
    return false;
  }
  const filled = ['company', 'role', 'job_description', 'company_research', 'interview_date', 'mini_compact']
    .some((k) => String(g[k] || '').trim()) || (g.documents || []).length > 0;
  if (filled) return false;
  const sessionsDir = path.join(getAppDataDir(), 'sessions');
  const used = fs.existsSync(sessionsDir) && fs.readdirSync(sessionsDir).some((f) => {
    try {
      return /.(jsonl|md)$/.test(f) && fs.readFileSync(path.join(sessionsDir, f), 'utf8').includes(STARTER_GOAL_ID);
    } catch (_e) {
      return false;
    }
  });
  if (used) return false;
  fs.unlinkSync(filePath);
  return true;
}

function loadAllAgents() {
  const agentsDir = path.join(getAppDataDir(), 'agents');
  const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.json'));
  const agents = [];
  for (const file of files) {
    try {
      const fullPath = path.join(agentsDir, file);
      const stat = fs.statSync(fullPath);
      const data = JSON.parse(fs.readFileSync(fullPath, 'utf8').replace(/^\uFEFF/, ''));
      // Self-heal cp1252 double-encoding written by older builds; persist the
      // repaired file so the fix survives restarts.
      if (healAgentStrings(data)) {
        try {
          fs.writeFileSync(fullPath, JSON.stringify(data, null, 2), 'utf8');
        } catch (_e) {}
      }
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
        '=== COMPANY DOSSIER (TAKO · https://tako.ai/) · SYNTHESIS SOL 6.1 (MEDIUM) ===',
        '• WHAT TAKO DOES & PRODUCT:',
        '  - Tako is an AI platform for HR and Payroll ("The AI that runs the complete HR lifecycle from hiring to offboarding"), led by CEO Fernando Gadotti.',
        '  - Operates two integrated products: Tako Payroll & People Ops and Tako Recruiter (AI agents for hiring).',
        '  - Operational metrics: NPS +94, Zero churn, and SOC 2 Type 1 certification.',
        '• CULTURE & VALUES:',
        '  - Pragmatic engineering focused on real-world AI agent operations, reliability, end-to-end automation, and zero busywork.'
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
            title: tm('Interview in 1 hour: {name}', { name: goal.name }),
            body: `Your interview with ${goal.company || goal.name} starts at ${ni.time}. Open lipcue.com to review the Prep tab.`
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

// ---------------------------------------------------------------------------
// JEV session evaluation: every interviewer question + the candidate's spoken
// answer scored on one fixed rubric by an LLM judge, against the goal's
// company research, job description and résumé. Cached next to the session
// as <id>.jev.json so the review screen is stable and costs one run.
// ---------------------------------------------------------------------------
const JEV_VERSION = 3;
const JEV_CRITERIA = ['adequacao', 'cultura', 'estrutura', 'evidencias', 'objetividade'];
const JEV_QUESTION_RE = /\?\s*$|^(como|por ?que|qual|quais|o que|quando|onde|quanto|me (conta|fala|diz)|conte|descreva|explique|fale|voc[eê] (pode|poderia|conseguiria|j[aá])|what|why|how|tell me|describe|can you|could you|walk me)\b/i;

function readSessionEvents(sessionId) {
  const safe = path.basename(String(sessionId || '')).replace(/\.(md|jsonl)$/i, '');
  const file = path.join(getAppDataDir(), 'sessions', `${safe}.jsonl`);
  if (!fs.existsSync(file)) return { id: safe, events: [] };
  const events = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line[0] !== '{') continue;
    try {
      events.push(JSON.parse(line));
    } catch (_e) {}
  }
  return { id: safe, events };
}

// Consecutive turns of the same speaker form one block (the engine emits a
// turn per endpoint, i.e. a few words at a time).
function sessionBlocks(events) {
  const blocks = [];
  for (const e of events) {
    if (e.type !== 'turn' || !String(e.text || '').trim()) continue;
    const src = e.src === 'voce' ? 'voce' : 'outros';
    const t0 = Number(e.t0 || e.t) || 0;
    const t1 = Number(e.t) || t0;
    const last = blocks[blocks.length - 1];
    if (last && last.src === src) {
      last.text += ` ${String(e.text).trim()}`;
      last.t1 = t1;
      last.parts += 1;
    } else {
      blocks.push({ src, text: String(e.text).trim(), t0, t1, parts: 1 });
    }
  }
  return blocks;
}

// Practice prompts wrap the interviewer's question: "Responda por áudio: ..."
// pasted in the chat, or `Como eu responderia: "..."` from the question bank.
const PRACTICE_PREFIX_RE = /^\s*(?:responda(?:\s+por\s+[áa]udio)?|como eu responderia|pergunta|question)\s*:\s*/i;
const QUESTION_LEAD_RE = /^(imagine|conte|descreva|explique|fale|me (conta|conte|fala|fale|diga|diz|d[eê])|d[eê] um exemplo)\b/i;
// Suggestions that answered something the candidate may say out loud
// (screenshots, recaps and follow-up lists are not questions).
const ANSWER_REASONS = new Set(['question', 'manual', 'chat', 'keyword', 'long_turn']);

function questionFromTrigger(text) {
  return String(text || '').replace(PRACTICE_PREFIX_RE, '').replace(/^["“'\s]+|["”'\s]+$/g, '').trim();
}

function looksLikeQuestion(text) {
  const t = String(text || '').trim();
  return /\?/.test(t) || QUESTION_LEAD_RE.test(t) || t.split(/(?<=[.?!])\s+/).some((s) => JEV_QUESTION_RE.test(s.trim()));
}

// Where the questions are in a session log, in time order: the interviewer's
// question blocks, plus the questions the copilot received some other way
// (pasted or typed in the chat, sent from the question bank, or asked into
// the microphone when the call ran without system audio). A suggestion that
// answered an interviewer block only lends it the engine's reading.
function sessionQuestionAnchors(events) {
  const anchors = [];
  for (const b of sessionBlocks(events)) {
    if (b.src === 'outros' && looksLikeQuestion(b.text)) anchors.push({ t: b.t0, end: b.t1, text: b.text, understood: '', sugg: null, from: 'interviewer' });
  }
  for (const s of events) {
    if (s.type !== 'suggestion' || s.status !== 'completed' || !ANSWER_REASONS.has(String(s.reason || ''))) continue;
    const t = Number(s.t) || 0;
    const block = anchors.find((a) => a.from === 'interviewer' && !a.sugg && t >= a.t && t <= a.end + 15000);
    if (block) {
      block.sugg = s;
      block.understood = s.understood || '';
      continue;
    }
    const text = questionFromTrigger(s.understood || s.trigger);
    if (text.length < 12 || !looksLikeQuestion(text)) continue;
    anchors.push({ t, end: t, text, understood: '', sugg: s, from: 'copilot' });
  }
  return anchors.sort((a, b) => a.t - b.t);
}

// Each question with what the candidate said after it, until the next one.
function jevPairs(events) {
  const anchors = sessionQuestionAnchors(events);
  const turns = events.filter((e) => e.type === 'turn' && e.src === 'voce' && String(e.text || '').trim());
  const pairs = [];
  anchors.forEach((q, i) => {
    const until = i + 1 < anchors.length ? anchors[i + 1].t : Infinity;
    // A turn's t is when it closed: what closed after the question was asked.
    const said = turns.filter((e) => Number(e.t) > q.end && Number(e.t) <= until);
    const answer = said.map((e) => String(e.text).trim()).join(' ').trim();
    const words = (answer.match(/[\p{L}\p{N}']+/gu) || []).length;
    if (words < 8) return;
    const first = said[0];
    const last = said[said.length - 1];
    pairs.push({
      t: q.t,
      question: q.text.slice(-900),
      understood: q.understood,
      answer: answer.slice(0, 2400),
      answerSeconds: Math.max(0, Math.round((Number(last.t) - Number(first.t0 || first.t)) / 1000)),
      copilot: q.sugg ? String(q.sugg.text || '').slice(0, 1200) : '',
      ttftMs: q.sugg ? Number(q.sugg.ttft_ms) || null : null
    });
  });
  return pairs.slice(0, 24);
}

function callOpenRouterJson(messages, maxTokens, timeoutMs) {
  const target = aiTarget('lipcue.com JEV');
  if (!target) return Promise.resolve({ ok: false, error: 'Sign in to your lipcue.com account (or set the OpenRouter key) to use the JEV evaluation.' });
  const payload = JSON.stringify({
    model: SOL_ANALYSIS_MODEL,
    messages,
    max_tokens: maxTokens,
    temperature: 0,
    stream: false,
    response_format: { type: 'json_object' },
    // The judge needs no chain of thought; reasoning tokens would eat max_tokens.
    reasoning: { enabled: false }
  });
  return aiPost(target, payload, timeoutMs || 60000).then((r) => {
    if (r.error) return { ok: false, error: r.error === 'timeout' ? 'The evaluator took too long to answer.' : r.error };
    try {
      const parsed = JSON.parse(r.body);
      if (parsed.error) return { ok: false, error: parsed.error.message || 'Provider error.' };
      const choice = parsed?.choices?.[0] || {};
      const content = String(choice.message?.content || '');
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) {
        console.warn('[jev] no JSON', choice.finish_reason, content.slice(0, 300));
        return { ok: false, error: `Evaluator answer without JSON (${choice.finish_reason || 'empty'}).` };
      }
      return { ok: true, json: JSON.parse(match[0]) };
    } catch (e) {
      return { ok: false, error: `Invalid evaluator answer: ${e.message}` };
    }
  });
}

// "NUBANK - Estágio — https://…" (the goal named in the session log) -> "NUBANK".
function companyFromGoalLabel(label) {
  return String(label || '').split(/\s+[-–—·|]\s+/)[0].replace(/https?:\/\/\S+/g, '').trim();
}

function jevContext(agent, goalLabel) {
  if (!agent) {
    const company = companyFromGoalLabel(goalLabel);
    return company
      ? `Empresa: ${company} | Vaga registrada na sessão: ${goalLabel}\nNão há pesquisa salva desta empresa: avalie a cultura pelo que se sabe publicamente sobre os valores e a forma de trabalhar da ${company}.`
      : 'Empresa e vaga desconhecidas: avalie a cultura pelo que é comum em empresas de tecnologia.';
  }
  const docs = Array.isArray(agent.documents) ? agent.documents : [];
  const resume = docs.find((d) => /resume|cv|curric/i.test(`${d.tag || ''} ${d.title || ''}`));
  return [
    `Empresa: ${agent.company || '(não informada)'} | Vaga: ${agent.role || '(não informada)'}`,
    agent.company_research ? `Cultura e contexto da empresa:\n${String(agent.company_research).slice(0, 2600)}` : '',
    agent.job_description ? `Descrição da vaga:\n${String(agent.job_description).slice(0, 1500)}` : '',
    resume ? `Currículo do candidato (trecho):\n${String(resume.content || '').slice(0, 2200)}` : ''
  ].filter(Boolean).join('\n\n');
}

const JEV_SYSTEM = `Você é o JEV, avaliador de entrevistas. Avalie a RESPOSTA FALADA do candidato (não a do copiloto) a cada pergunta, sempre com a mesma rubrica, notas inteiras de 0 a 10:
- adequacao: responde exatamente o que foi perguntado.
- cultura: alinhamento com a cultura e os valores da empresa descritos no contexto.
- estrutura: organização (STAR quando comportamental; raciocínio claro quando técnica).
- evidencias: exemplos concretos, números e fatos coerentes com o currículo; penalize fatos inventados.
- objetividade: vai direto ao ponto, sem rodeios nem repetição.
A transcrição vem de reconhecimento de voz e pode ter erros de palavra; não penalize isso.
Responda SOMENTE JSON e escreva todos os textos do JSON em inglês.`;

async function evaluateSessionWithJev({ sessionId, agentId, force }) {
  const { id, events } = readSessionEvents(sessionId);
  if (!events.length) return { ok: false, error: 'This session has no event log to evaluate.' };
  const cachePath = path.join(getAppDataDir(), 'sessions', `${id}.jev.json`);
  if (!force && fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (cached.version === JEV_VERSION) return { ok: true, cached: true, evaluation: cached };
    } catch (_e) {}
  }
  const pairs = jevPairs(events);
  if (!pairs.length) {
    return { ok: false, error: 'No question with a spoken answer was found: JEV evaluates what you said on the microphone after each question (from the interviewer, the chat or the question bank).' };
  }

  const agent = agentId ? loadAllAgents().find((a) => a.id === agentId) : null;
  const start = events.find((e) => e.type === 'notice' && /^Active goal:/i.test(e.text || ''));
  const goalLabel = start ? String(start.text).replace(/^Active goal:\s*/i, '').split(' · ')[0] : '';
  const companyName = agent ? agent.company : companyFromGoalLabel(goalLabel);
  const result = await jevEvaluatePairs(pairs, { context: jevContext(agent, goalLabel), companyName });
  if (!result.ok) return result;
  const evaluation = { version: JEV_VERSION, sessionId: id, agentId: agent ? agent.id : '', ...result.evaluation };
  fs.writeFileSync(cachePath, JSON.stringify(evaluation, null, 2), 'utf8');
  return { ok: true, cached: false, evaluation };
}

// The rubric over question/answer pairs: saved sessions and mock interviews.
async function jevEvaluatePairs(pairs, { context, companyName, lang }) {
  const language = (text) => (lang ? text.split('em inglês').join(`em ${languageName(lang)}`) : text);
  const items = [];
  const BATCH = 5;
  const batches = [];
  for (let i = 0; i < pairs.length; i += BATCH) batches.push(pairs.slice(i, i + BATCH));
  const results = await Promise.all(
    batches.map((batch, bi) =>
      callOpenRouterJson(
        [
          { role: 'system', content: language(JEV_SYSTEM) },
          {
            role: 'user',
            content: `${context}\n\nAvalie os pares abaixo e devolva {"items":[{"i":<índice>,"pergunta":"<pergunta reescrita em uma frase clara>","tipo":"comportamental|tecnica|cultura|motivacao|outra","notas":{"adequacao":0,"cultura":0,"estrutura":0,"evidencias":0,"objetividade":0},"veredito":"<uma frase>","dica":"<uma ação concreta para melhorar>"}]}\n\n${batch
              .map((p, k) => `#${bi * BATCH + k}\nPERGUNTA: ${p.understood || p.question}\nRESPOSTA DO CANDIDATO: ${p.answer}`)
              .join('\n\n')}`
          }
        ],
        2200,
        70000
      )
    )
  );
  const failed = results.find((r) => !r.ok);
  if (failed && results.every((r) => !r.ok)) return { ok: false, error: failed.error };
  for (const r of results) {
    if (!r.ok) continue;
    for (const it of (r.json && r.json.items) || []) {
      const idx = Number(it.i);
      const pair = pairs[idx];
      if (!pair) continue;
      const notas = {};
      for (const c of JEV_CRITERIA) {
        const v = Number(it.notas && it.notas[c]);
        notas[c] = Number.isFinite(v) ? Math.max(0, Math.min(10, Math.round(v))) : null;
      }
      const vals = Object.values(notas).filter((v) => v != null);
      items.push({
        ...pair,
        index: idx,
        pergunta: String(it.pergunta || pair.understood || pair.question).slice(0, 400),
        tipo: String(it.tipo || 'outra'),
        notas,
        score: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) : null,
        veredito: String(it.veredito || '').slice(0, 400),
        dica: String(it.dica || '').slice(0, 400)
      });
    }
  }
  items.sort((a, b) => a.index - b.index);
  if (!items.length) return { ok: false, error: (failed && failed.error) || 'The evaluator returned no scores.' };

  const criteria = {};
  for (const c of JEV_CRITERIA) {
    const vals = items.map((i) => i.notas[c]).filter((v) => v != null);
    criteria[c] = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) : null;
  }
  const crit = Object.values(criteria).filter((v) => v != null);
  const score = crit.length ? Math.round(crit.reduce((a, b) => a + b, 0) / crit.length) : null;

  const synth = await callOpenRouterJson(
    [
      { role: 'system', content: language('Você é o JEV e escreve o feedback final para o candidato sobre o desempenho dele na entrevista, com base nas avaliações por pergunta. Fale do candidato (em segunda pessoa), não das notas nem da avaliação. Responda SOMENTE JSON e escreva todos os textos do JSON em inglês.') },
      {
        role: 'user',
        content: `Empresa: ${companyName || '(desconhecida)'}. Médias (0-100): ${JSON.stringify(criteria)}.\nAvaliações por pergunta:\n${items
          .map((i) => `- [${i.score}] ${i.pergunta} | ${i.veredito} | dica: ${i.dica}`)
          .join('\n')}\n\nDevolva {"resumo":"<2 frases para o candidato sobre o desempenho geral, citando a cultura da empresa>","fortes":["até 3 pontos fortes concretos"],"melhorar":["até 3 melhorias concretas e acionáveis"]}`
      }
    ],
    700,
    45000
  );

  const evaluation = {
    evaluatedAt: new Date().toISOString(),
    model: SOL_ANALYSIS_MODEL,
    company: companyName || '',
    score,
    criteria,
    items,
    partial: Boolean(failed),
    resumo: synth.ok ? String(synth.json.resumo || '') : '',
    fortes: synth.ok && Array.isArray(synth.json.fortes) ? synth.json.fortes.map(String).slice(0, 3) : [],
    melhorar: synth.ok && Array.isArray(synth.json.melhorar) ? synth.json.melhorar.map(String).slice(0, 3) : []
  };
  return { ok: true, evaluation };
}

// Interviewer text of every saved session, as the question extractor reads it.
// JEV reads each candidate question the way a shared interview bank needs it:
// what kind of question it is and a clear, generic wording. A question that
// only makes sense for this candidate, or is not an interview question at all
// (a request to the copilot, a quiz on screen, a piece of an answer), is left
// out. Returns null without an OpenRouter key or when the call fails, and the
// rule-based reading is used instead.
const JEV_BANK_SYSTEM = `Você é o JEV e organiza um banco de perguntas reais de entrevista, que outros candidatos usam para treinar. Classifique cada item pelo tipo:
- pessoal: sobre a experiência e o comportamento do candidato, pede uma história ("me conte uma vez em que você teve que assumir uma nova responsabilidade", conflito, erro, liderança, pressão, aprendizado, trabalho em equipe).
- cultura: valores e forma de trabalhar da empresa, fit cultural.
- motivacao: por que esta empresa ou vaga, objetivos de carreira.
- abertura: apresentação ("fale sobre você", trajetória).
- tecnica: conhecimento técnico, código, arquitetura, system design, dados.
- dominio: negócio, produto, mercado.
- salario: salário, benefícios, disponibilidade, modelo de trabalho.
- especifica: só faz sentido para este candidato e não dá para generalizar.
- nao_pergunta: não é pergunta de entrevista (pedido ao copiloto, conta ou exercício de tela, cumprimento, teste de áudio, trecho de resposta).
Se a pergunta cita um projeto, empresa ou resposta do candidato mas tem uma versão genérica útil ("Você comentou que aprendeu React com protótipos; como faz isso?" -> "Como você aprende uma tecnologia nova rapidamente?"), reescreva genérica e classifique pelo tipo dela.
"pergunta": a pergunta clara, completa e genérica, sem nomes do candidato, no idioma original. Responda SOMENTE JSON.`;

async function classifyQuestionsWithJev(questions, { company } = {}) {
  if (!Array.isArray(questions) || !questions.length || !aiTarget()) return null;
  const res = await callOpenRouterJson(
    [
      { role: 'system', content: JEV_BANK_SYSTEM },
      {
        role: 'user',
        content: `Empresa da entrevista: ${company || '(desconhecida)'}\n\n${questions
          .map((q, i) => `#${i} ${q}`)
          .join('\n')}\n\nDevolva {"items":[{"i":<índice>,"tipo":"pessoal|cultura|motivacao|abertura|tecnica|dominio|salario|especifica|nao_pergunta","pergunta":"<pergunta>"}]}`
      }
    ],
    Math.min(3000, 400 + questions.length * 90),
    60000
  );
  return res.ok && res.json && Array.isArray(res.json.items) ? res.json.items : null;
}

// The questions of a session log as lines the question extractor reads: the
// interviewer's question blocks and, when JEV can vet them, the questions the
// copilot got from the chat or the question bank. Copilot answers never go in.
// "X, X" from repeated speech or scripted demos -> "X"; a trailing "." would
// become ".?" once the extractor adds the question mark.
function sessionQuestionLines(events, { withChat }) {
  const dedupe = (t) => String(t).replace(/(.{12,}?)[\s,;:-]+\1/g, '$1').trim().replace(/[.\s]+$/, '');
  const lines = [];
  for (const a of sessionQuestionAnchors(events)) {
    if (a.from === 'interviewer') {
      lines.push(a.understood ? `Pergunta: "${dedupe(a.understood).replace(/"/g, "'")}"` : `Entrevistador: ${dedupe(a.text)}`);
    } else if (withChat) {
      lines.push(`Pergunta: "${dedupe(a.text).replace(/"/g, "'")}"`);
    }
  }
  return lines;
}

const bankClassifier = (questions, ctx) => classifyQuestionsWithJev(questions, ctx);

// "Share anonymized questions": after a session, the generalist questions JEV
// kept go to the lipcue.com community bank, and the questions other candidates
// reported for that company come back into the local bank. Never blocks.
async function shareSessionQuestions(extraction) {
  try {
    const cfg = readConfigIni();
    if (cfg.share_anonymized_questions === false || !isSignedIn(cfg)) return;
    if (!extraction || !extraction.company || !Array.isArray(extraction.questions) || !extraction.questions.length) return;
    const questions = extraction.questions.map((q) => ({ text: q.text, category: q.category, subCategory: q.subCategory || '' }));
    const r = await cloudAccount.api('POST', '/v1/questions', { company: extraction.company, questions });
    if (!r.ok || !r.data || !Array.isArray(r.data.questions)) return;
    const merged = jevEngine.mergeCommunityQuestions(getAppDataDir(), extraction.company, r.data.questions);
    if (merged.added && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('rtai:question-bank-updated', { ok: true, company: extraction.company, added: merged.added, community: true });
    }
  } catch (err) {
    console.warn('Community questions:', err && err.message ? err.message : err);
  }
}

async function rebuildQuestionBankFromSessions() {
  const sessions = loadPastSessions();
  const agents = loadAllAgents();
  const withChat = Boolean(aiTarget());
  const entries = [];
  for (const s of sessions) {
    // Only sessions that ran with a goal: the goal names the company.
    const label = String(s.goalLabel || '');
    if (!label) continue;
    const { events } = readSessionEvents(s.id);
    if (!events.length) continue;
    const lines = sessionQuestionLines(events, { withChat });
    if (!lines.length) continue;
    const lower = label.toLowerCase();
    const agent = agents.find((a) => a.company && lower.includes(String(a.company).toLowerCase()));
    entries.push({ text: lines.join('\n'), company: agent ? agent.company : companyFromGoalLabel(label) });
  }
  return jevEngine.rebuildQuestionBank(getAppDataDir(), entries, { classify: bankClassifier });
}

// A bank built by an older version (questions taken from the copilot's
// answers, rule-based categories) is rebuilt once from the session logs.
async function migrateQuestionBank() {
  try {
    const bank = jevEngine.loadQuestionBank(getAppDataDir());
    if (bank.version === jevEngine.QUESTION_BANK_VERSION) return;
    const res = await rebuildQuestionBankFromSessions();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('rtai:question-bank-updated', { rebuilt: true, added: (res && res.added) || 0 });
    }
  } catch (err) {
    console.warn('[question-bank] rebuild failed:', err);
  }
}

async function generateSessionDebrief({ sessionId, goalId, agentId, transcript: providedTranscript }) {
  const targetId = goalId || agentId;
  const agents = loadAllAgents();
  const goal = agents.find((a) => a.id === targetId) || agents[0];
  if (!goal) return { ok: false, error: 'Goal not found' };

  let transcript = (providedTranscript && typeof providedTranscript === 'string') ? providedTranscript.trim() : '';

  if (!transcript && sessionId) {
    const sessionsDir = path.join(getAppDataDir(), 'sessions');
    const safeSessionId = path.basename(String(sessionId));
    const candidates = [
      path.join(sessionsDir, safeSessionId),
      path.join(sessionsDir, `${safeSessionId}.md`),
      path.join(sessionsDir, `${safeSessionId}.jsonl`)
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, 'utf8');
          if (content && content.trim().length > 0) {
            transcript = content;
            break;
          }
        } catch (_e) {}
      }
    }
  }

  // Nothing recorded, nothing to judge: no generic praise or advice.
  if (!transcript) return { ok: false, error: 'This session has no transcript to analyze.' };

  const role = goal.role || 'the role';

  // Extract substantive questions asked in this session via JEV
  let extractedQuestions = [];
  if (transcript) {
    try {
      extractedQuestions = jevEngine.extractQuestionsFromTranscript(transcript);
    } catch (_e) {}
  }

  // Real analysis of candidate responses and interview content from actual transcript
  const lower = transcript.toLowerCase();
  const dynamicStrengths = [];
  const dynamicImprovements = [];

  // 1. Metric-driven quantitative communication
  if (/\b\d+\s*%/i.test(lower) || /\b\d+\s*(?:ms|milliseconds|seconds|minutes|hours|users|req\/s|rps|million|thousand|tb|gb)\b/i.test(lower)) {
    dynamicStrengths.push(`Solid quantitative stance: supported engineering decisions with concrete metrics and data points.`);
  } else {
    dynamicImprovements.push(`Bring up concrete metrics (latency, throughput, scale numbers) proactively to substantiate answers.`);
  }

  // 2. STAR / Personal ownership delivery
  if (/(?:in my previous|in my last|when i|i designed|i built|i led|i resolved|my responsibility|minha responsabilidade|eu liderei|desenvolvi|implementei)\b/i.test(lower)) {
    dynamicStrengths.push(`Clear first-person walkthrough of past projects with strong personal ownership and STAR structure.`);
  } else {
    dynamicImprovements.push(`Lead with strong first-person ownership ("I decided", "I engineered") rather than collective team summaries.`);
  }

  // 3. Leading with verdict / trade-offs
  if (/(?:the trade-off|tradeoff|verdict|in summary|ultimately|trade-offs|conclusão|o resultado foi)\b/i.test(lower)) {
    dynamicStrengths.push(`Direct executive communication: highlighted trade-offs and stated the verdict before expanding context.`);
  } else {
    dynamicImprovements.push(`State the architectural verdict sooner (lead with the answer) before diving into deep technical details.`);
  }

  // 4. Technical depth on specific domains
  if (extractedQuestions.length > 0) {
    const categories = [...new Set(extractedQuestions.map((q) => q.subCategory || q.category))].join(', ');
    dynamicStrengths.push(`Addressed ${extractedQuestions.length} substantive ${extractedQuestions.length === 1 ? 'question' : 'questions'} across ${categories} for ${role}.`);
  }

  const newImprove = dynamicImprovements[0] || `Bring up metrics and trade-offs on your own to strengthen the answer.`;

  if (!goal.goal_memory) goal.goal_memory = { strengths: [], improve: [] };
  if (!Array.isArray(goal.goal_memory.strengths)) goal.goal_memory.strengths = [];
  if (!Array.isArray(goal.goal_memory.improve)) goal.goal_memory.improve = [];

  for (const s of dynamicStrengths) {
    if (!goal.goal_memory.strengths.includes(s)) {
      goal.goal_memory.strengths.unshift(s);
    }
  }
  for (const imp of dynamicImprovements) {
    if (!goal.goal_memory.improve.includes(imp)) {
      goal.goal_memory.improve.unshift(imp);
    }
  }

  goal.goal_memory.strengths = goal.goal_memory.strengths.slice(0, 5);
  goal.goal_memory.improve = goal.goal_memory.improve.slice(0, 5);

  goal.next_focus = `Focus on: ${goal.goal_memory.improve[0] || newImprove}`;

  if (!goal.checklist_state) goal.checklist_state = {};
  goal.checklist_state.practice_run = true;
  goal.checklist_state.debrief_read = true;

  const saved = saveAgentToDisk(goal);

  // Real JEV Question Extraction & Question Bank Ingestion
  const cfg = readConfigIni();
  let jevExtraction = null;
  if (cfg.share_anonymized_questions !== false && transcript) {
    try {
      jevExtraction = await jevEngine.ingestSessionQuestions(getAppDataDir(), transcript, goal.company || '', { classify: bankClassifier });
      shareSessionQuestions(jevExtraction);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('rtai:question-bank-updated', jevExtraction);
      }
    } catch (err) {
      console.warn('JEV Question Analysis error:', err);
    }
  }

  return {
    ok: true,
    debrief: {
      session_id: sessionId || `session-${Date.now()}`,
      created_at: Date.now(),
      summary: extractedQuestions.length > 0
        ? `Debrief completed for ${goal.name}: ${extractedQuestions.length} substantive questions analyzed.`
        : `Debrief completed for ${goal.name}: strengths and priority focus areas identified.`,
      strengths: goal.goal_memory.strengths,
      improve: goal.goal_memory.improve,
      next_focus: goal.next_focus,
      questions: extractedQuestions.map((q) => q.text),
      jevExtraction
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
    name: (agent.name || `${agent.company || 'Session'} — ${agent.role || 'Interview'}`).trim(),
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
    // Interview format shown on the dashboard (behavioral, technical, panel...).
    interview_format: String(agent.interview_format || '').trim(),
    archived: Boolean(agent.archived),
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
      const ocr = await pdfText.ocrPdfWithOpenRouter(buf, path.basename(filePath), aiTarget(), https, undefined, undefined, http);
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
          ? (aiTarget()
              ? 'Could not read this PDF, not even with OCR. Use "Paste text".'
              : 'This PDF looks scanned (no text layer). Sign in (or set the OpenRouter key) to read it with OCR, or use "Paste text".')
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
    if (headings.length > 0) lines.push(`• Key website highlights: ${[...new Set(headings)].join(' · ')}`);
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

// Company research runs on the lipcue.com server when signed in (scraping +
// dossier, no keys on this machine); the local version stays for offline use.
async function runCompanyRecon(input) {
  const { company, role, job_description } = input || {};
  if (String(company || '').trim() && isSignedIn()) {
    const r = await cloudAccount.api('POST', '/v1/research/company', { company, role, job_description }, { timeoutMs: 45000 });
    if (r.ok && r.data && r.data.dossier) return r.data.dossier;
  }
  return runCompanyReconLocal({ company, role, job_description });
}

async function runCompanyReconLocal({ company, role, job_description }) {
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
// Knowledge Base Keywords Extractor (for RAG Adherence)
// ---------------------------------------------------------------------------
function getKnowledgeBaseKeywords() {
  const agentsDir = path.join(getAppDataDir(), 'agents');
  const keywords = new Set();
  if (!fs.existsSync(agentsDir)) return keywords;
  try {
    const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      const data = JSON.parse(fs.readFileSync(path.join(agentsDir, f), 'utf8'));
      if (Array.isArray(data.documents)) {
        for (const doc of data.documents) {
          const raw = ((doc.title || '') + ' ' + (doc.content || '') + ' ' + (doc.summary || '')).toLowerCase();
          const clean = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          const tokens = clean.match(/[a-z]{3,}/g) || [];
          tokens.forEach((t) => keywords.add(t));
        }
      }
      if (data.company_research) {
        const clean = String(data.company_research).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const tokens = clean.match(/[a-z]{3,}/g) || [];
        tokens.forEach((t) => keywords.add(t));
      }
    }
  } catch (_e) {}
  return keywords;
}

// ---------------------------------------------------------------------------
// Past Sessions Reader
// ---------------------------------------------------------------------------
// Facts from the session's event log (<id>.jsonl, written by the engine next
// to the Markdown): which goal ran, the mode, turn and answer counts. Every
// field is null/0 when the log is missing (older sessions have only the .md).
function readSessionEventMeta(jsonlPath) {
  const meta = {
    hasEvents: false, startedAt: '', mode: '', llmModel: '', language: '', goalLabel: '',
    turnsYou: 0, turnsOthers: 0, suggestions: 0, avgTtftMs: null, jevAvg: null, endedReason: ''
  };
  let raw = '';
  try {
    raw = fs.readFileSync(jsonlPath, 'utf8');
  } catch (_e) {
    return meta;
  }
  meta.hasEvents = true;
  const ttfts = [];
  const jev = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line[0] !== '{') continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch (_e) {
      continue;
    }
    if (ev.type === 'session_start') {
      meta.startedAt = ev.started_at || '';
      meta.mode = ev.mode || '';
      meta.llmModel = ev.llm_model || '';
      meta.language = ev.language || '';
    } else if (ev.type === 'notice' && !meta.goalLabel && /^Active goal:/i.test(ev.text || '')) {
      meta.goalLabel = String(ev.text).replace(/^Active goal:\s*/i, '').split(' · ').slice(0, 2).join(' · ').replace(/\s*\(.*?\)\s*$/, '').trim();
    } else if (ev.type === 'turn') {
      if (ev.src === 'voce') meta.turnsYou += 1;
      else meta.turnsOthers += 1;
    } else if (ev.type === 'suggestion' && ev.status === 'completed') {
      meta.suggestions += 1;
      if (Number(ev.ttft_ms) > 0) ttfts.push(Number(ev.ttft_ms));
    } else if (ev.type === 'jev' && Number.isFinite(Number(ev.relevance))) {
      jev.push(Number(ev.relevance));
    } else if (ev.type === 'session_end') {
      meta.endedReason = ev.reason || '';
    }
  }
  if (ttfts.length) meta.avgTtftMs = Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length);
  if (jev.length) meta.jevAvg = Math.round((jev.reduce((a, b) => a + b, 0) / jev.length) * 10) / 10;
  return meta;
}

function readJevScore(file) {
  try {
    const ev = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isFinite(ev.score) ? ev.score : null;
  } catch (_e) {
    return null;
  }
}

function loadPastSessions() {
  const sessionsDir = path.join(getAppDataDir(), 'sessions');
  if (!fs.existsSync(sessionsDir)) return [];
  const files = fs.readdirSync(sessionsDir);
  const mdFiles = files.filter((f) => f.endsWith('.md'));
  const sessions = [];
  const docKeywords = getKnowledgeBaseKeywords();

  for (const mdFile of mdFiles) {
    try {
      const fullPath = path.join(sessionsDir, mdFile);
      const stat = fs.statSync(fullPath);
      const content = fs.readFileSync(fullPath, 'utf8');
      const preview = content.slice(0, 600);

      // Support English ('Question: "..."'), Portuguese ('Pergunta: "..."'), chat inputs ('Chat: "..."'), and JEV extracted questions
      const qMatches = (content.match(/(?:Question|Pergunta|Chat):\s*"[^"]+"/gi) || []).length;
      let totalSessionQuestions = qMatches;
      try {
        const extracted = jevEngine.extractQuestionsFromTranscript(content);
        if (extracted && extracted.length > totalSessionQuestions) {
          totalSessionQuestions = extracted.length;
        }
      } catch (_e) {}
      // Support English ('Suggestion') and Portuguese ('Sugestão')
      const aMatches = (content.match(/>\s*\*\*(?:Suggestion|Sugestão)/gi) || []).length;

      // Parse first token latency across both languages and comma/dot decimal formats
      const lats = [...content.matchAll(/(?:1st token in|1º token em)\s*([0-9.,]+)\s*s/gi)]
        .map((m) => parseFloat(m[1].replace(',', '.')) * 1000)
        .filter((n) => !isNaN(n) && n > 0 && n < 60000);
      const avgLat = lats.length > 0 ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null;

      // Parse audio duration in seconds
      let durSec = 0;
      const durMatch = content.match(/(?:Duração|Duration):\s*([0-9]+):([0-9]+)/i);
      if (durMatch) {
        durSec = parseInt(durMatch[1], 10) * 60 + parseInt(durMatch[2], 10);
      } else {
        const durMatchSec = content.match(/(?:Duração|Duration):\s*([0-9]+)\s*s/i);
        if (durMatchSec) durSec = parseInt(durMatchSec[1], 10);
      }

      const words = (content.match(/\b\w+\b/g) || []).length;

      // Grounding adherence against indexed knowledge base
      let groundedInSession = 0;
      if (aMatches > 0 && docKeywords.size > 0) {
        const cleanContent = content.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const tokens = cleanContent.match(/[a-z]{3,}/g) || [];
        let hits = 0;
        for (const t of tokens) {
          if (docKeywords.has(t)) hits++;
        }
        if (hits >= 10) {
          groundedInSession = aMatches;
        } else {
          groundedInSession = Math.round(aMatches * (hits / 10));
        }
      } else if (aMatches > 0) {
        groundedInSession = aMatches;
      }

      sessions.push({
        id: path.basename(mdFile, '.md'),
        fileName: mdFile,
        fullPath,
        updatedAt: stat.mtimeMs,
        sizeKb: Math.max(1, Math.round(stat.size / 1024)),
        preview: preview.replace(/\r?\n/g, ' ').slice(0, 220),
        questionsCount: totalSessionQuestions,
        answersCount: aMatches,
        groundedAnswersCount: groundedInSession,
        avgLatencyMs: avgLat,
        durationSeconds: durSec,
        wordsCount: words,
        ...readSessionEventMeta(path.join(sessionsDir, `${path.basename(mdFile, '.md')}.jsonl`)),
        jevScore: readJevScore(path.join(sessionsDir, `${path.basename(mdFile, '.md')}.jev.json`))
      });
    } catch (_e) {}
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}

// ---------------------------------------------------------------------------
// User Profile Persistence
// ---------------------------------------------------------------------------
const SAMPLE_PROFILE_EMAIL = 'bruno@realtimeai.dev';
function loadUserProfile(cachedSessions) {
  const p = path.join(getAppDataDir(), 'dashboard_profile.json');
  let data = null;
  if (fs.existsSync(p)) {
    try {
      data = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    } catch (_e) {}
  }
  if (!data) {
    data = {
      name: '',
      email: '',
      headline: '',
      seniority: '',
      linkedin: '',
      themePreference: 'dark',
      loggedIn: true
    };
  }
  if (data.email === SAMPLE_PROFILE_EMAIL) {
    for (const k of ['name', 'email', 'headline', 'seniority', 'linkedin']) data[k] = '';
    try {
      fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
    } catch (_e) {}
  }
  if (!data.themePreference) data.themePreference = 'dark';
  if (!data.plan) data.plan = 'free';

  // Compute real transcription statistics from actual session files
  const sessions = cachedSessions || loadPastSessions();
  let totalDurSec = 0;
  let totalWords = 0;
  for (const s of sessions) {
    totalDurSec += (s.durationSeconds || 0);
    totalWords += (s.wordsCount || 0);
  }
  // Always recomputed from the session files; no quota is invented.
  data.transcriptionUsage = {
    usedMinutes: Math.round(totalDurSec / 60),
    limitMinutes: null,
    sessionsCount: sessions.length,
    wordsCount: totalWords
  };
  return data;
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
const OVERLAY_IMAGES = ['rtai_overlay.exe', 'rtai_app.exe'];
// An overlay started outside the dashboard (a script, a second install) is
// found with `tasklist`. That probe runs in the background and is cached, so
// callers never block the main process on a child process.
const EXTERNAL_PROBE_TTL_MS = 3000;
let externalOverlay = { running: false, checkedAt: 0, pending: false };

function refreshExternalOverlayProbe() {
  if (externalOverlay.pending || process.platform !== 'win32') return;
  externalOverlay.pending = true;
  execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
    const out = err ? '' : String(stdout || '').toLowerCase();
    externalOverlay = {
      running: OVERLAY_IMAGES.some((img) => out.includes(`"${img}"`)),
      checkedAt: Date.now(),
      pending: false
    };
  });
}

function isOverlayRunning() {
  if (overlayProcess && !overlayProcess.killed) return true;
  if (Date.now() - externalOverlay.checkedAt > EXTERNAL_PROBE_TTL_MS) refreshExternalOverlayProbe();
  return externalOverlay.running;
}

function broadcastOverlayStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const running = Boolean(overlayProcess && !overlayProcess.killed);
    mainWindow.webContents.send('rtai:overlay-status', {
      running,
      mode: overlayMode || 'idle',
      agentId: overlayAgentId || '',
      startedAt: running ? overlayStartedAt : 0
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
  // One taskkill for both image names (a stray overlay holds the hotkeys and
  // the audio devices, so it must be gone before the next one starts).
  try {
    execSync(`taskkill /F /T ${OVERLAY_IMAGES.map((img) => `/IM ${img}`).join(' ')}`, {
      stdio: 'ignore',
      windowsHide: true
    });
  } catch (_e) {}
  externalOverlay = { running: false, checkedAt: Date.now(), pending: false };
  broadcastOverlayStatus();
}

// Engine events (server_protocol.hpp) forwarded to the dashboard's live view.
const LIVE_EVENT_TYPES = new Set([
  'hello', 'status', 'live', 'turn', 'answer_start', 'answer_delta', 'answer_done',
  'notice', 'pause', 'level', 'bye'
]);

// Commands the live view may send to the engine's stdin. Anything else is
// refused: config and quit go through their own handlers.
const OVERLAY_COMMANDS = new Set(['answer', 'chat', 'recap', 'followup', 'pause', 'rate', 'clear_chat']);

function sendOverlayCommand(command) {
  const cmd = command && String(command.cmd || '');
  if (!OVERLAY_COMMANDS.has(cmd)) return { ok: false, error: `Unknown command: ${cmd}` };
  if (!overlayProcess || overlayProcess.killed || !overlayProcess.stdin || !overlayProcess.stdin.writable) {
    return { ok: false, error: 'The copilot is not running.' };
  }
  const payload = { cmd };
  if (cmd === 'chat') payload.text = String(command.text || '').slice(0, 4000);
  if (cmd === 'pause') {
    payload.src = ['voce', 'outros', 'all'].includes(command.src) ? command.src : 'all';
    payload.paused = Boolean(command.paused);
  }
  if (cmd === 'rate') {
    payload.id = Math.max(0, parseInt(command.id, 10) || 0);
    payload.vote = Number(command.vote) < 0 ? -1 : 1;
  }
  try {
    overlayProcess.stdin.write(JSON.stringify(payload) + '\n');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function launchOverlay({ agent, configOverrides = {} }) {
  if (!canUseApp()) return LOGIN_REQUIRED; // also covers relaunches
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

  // 4. Spawn the native C++20 overlay (packaged resource or local CMake build).
  const exePath = getOverlayExecutablePath();
  const args = ['--no-launcher', '--server'];
  if (savedAgent && savedAgent.id) {
    args.push('--agent', savedAgent.id);
  }
  overlayMode = 'live';
  overlayAgentId = savedAgent ? savedAgent.id : '';

  overlayStartedAt = Date.now();
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
    // A multi-byte character can straddle two chunks; the decoder keeps it whole.
    overlayProcess.stdout.setEncoding('utf8');
    overlayProcess.stdout.on('data', (chunk) => {
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('{')) continue;
        try {
          const msg = JSON.parse(trimmed);
          // The dashboard's live view mirrors the engine: transcript, answers,
          // audio levels and notices, exactly as the HUD receives them.
          if (LIVE_EVENT_TYPES.has(msg.type) && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('rtai:live-event', msg);
          }
          if (msg.type === 'mode' && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('rtai:mode', Boolean(msg.on));
          } else if (msg.type === 'hello' && mainWindow && !mainWindow.isDestroyed()) {
            if (msg.app_version) {
              overlayVersion = String(msg.app_version);
              // An installed app always ships both halves from the same build.
              if (app.isPackaged && overlayVersion.split('+')[0] !== app.getVersion()) {
                console.warn(`[overlay] version ${overlayVersion} differs from the dashboard ${app.getVersion()}`);
              }
            }
            if (msg.mode !== undefined) {
              mainWindow.webContents.send('rtai:mode', Boolean(msg.mode));
            }
          } else if (msg.type === 'open_settings') {
            // The HUD's Config button: one settings screen, the dashboard's.
            showSettingsWindow(msg.section || 'general');
          } else if (msg.type === 'summary') {
            // The engine names the field "export" (server_protocol.hpp).
            const exportPath = msg.export_path || msg.export || '';
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('rtai:summary', {
                ok: Boolean(msg.ok),
                text: msg.text || '',
                export_path: exportPath
              });
            }
            const cfg = readConfigIni();
            if (cfg.share_anonymized_questions !== false && exportPath) {
              try {
                if (fs.existsSync(exportPath)) {
                  // The session log next to the export: its questions are
                  // structured, while the .md also carries the copilot's answers.
                  const { events } = readSessionEvents(path.basename(exportPath));
                  const fromEvents = events.length ? sessionQuestionLines(events, { withChat: Boolean(aiTarget()) }).join('\n') : '';
                  const t = events.length ? fromEvents : fs.readFileSync(exportPath, 'utf8');
                  if (t) {
                    const currentGoal = overlayAgentId ? loadAllAgents().find((a) => a.id === overlayAgentId) : null;
                    const compFallback = (currentGoal && currentGoal.company) || '';
                    jevEngine.ingestSessionQuestions(getAppDataDir(), t, compFallback, { classify: bankClassifier }).then((extraction) => {
                      if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('rtai:question-bank-updated', extraction);
                      }
                      shareSessionQuestions(extraction);
                    }).catch((err) => console.warn('Auto JEV question extraction error:', err));
                  }
                }
              } catch (err) {
                console.warn('Auto JEV question read error:', err);
              }
            }
          }
        } catch (_e) {
          // non-JSON line, ignore
        }
      }
    });
  }

  overlayProcess.on('exit', () => {
    overlayProcess = null;
    scheduleCloudSync();
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
    if (Notification && Notification.isSupported()) {
      new Notification({ title, body, icon: path.join(APP_ROOT, 'assets', 'icon.png') }).show();
    }
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
        let title = 'lipcue.com — Interview Copilot';
        if (activeDisguise === 'settings') title = 'Settings';
        else if (activeDisguise === 'cmd') title = 'Command Prompt';
        else if (activeDisguise === 'taskmgr') title = 'Task Manager';
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

    // 1. Toggle Stealth Mode
    globalShortcut.register('CommandOrControl+Alt+S', () => {
      const cfg = readConfigIni();
      const nextActive = !Boolean(cfg.electron_stealth);
      writeConfigIni({ electron_stealth: nextActive });
      applyElectronStealthMode({ electron_stealth: nextActive });
      notify(
        nextActive ? '🛡️ Stealth Mode Enabled' : 'Stealth Mode Disabled',
        nextActive
          ? 'Dashboard cloaked in screen shares (Zoom, Meet, Teams, OBS).'
          : 'Dashboard visible normally.'
      );
    });

    // 2. Boss Key / Panic Button (Quick hide/show)
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
    return { ok: false, error: 'Overlay not found. Build it first: npm run build:native (scripts\\windows\\build.bat).' };
  }
  const allowed = await checkCanStartLive();
  if (!allowed.ok) {
    showSettingsWindow(allowed.needsLogin ? 'account' : allowed.needsKeys ? 'ai' : 'plan');
    return allowed;
  }
  const agent = loadAllAgents().find((a) => a.id === agentId) || null;
  const res = launchOverlay({ agent });
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
        notify(`lipcue.com won't ask for ${m.name} again`, 'Turn it back on in Settings > General > Meeting detection.');
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
  if (!canUseApp()) return; // the app does nothing until the user signs in (or goes local)
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
    { label: tm('Open lipcue.com'), click: () => showMainWindow() },
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
  if (active.length) items.push({ label: tm('In a call: {names}', { names: active.map((m) => m.name).join(', ') }), enabled: false });
  items.push(running
    ? { label: 'Stop copilot', click: () => stopOverlayGracefully() }
    : {
        label: tm('Start copilot'),
        click: async () => {
          const r = await startCopilotForMeeting(pickDefaultAgentId(loadAllAgents()));
          if (!r.ok) notify('Could not start the copilot', r.error || '');
        }
      });
  items.push(
    { type: 'separator' },
    { label: tm('Detect meetings'), type: 'checkbox', checked: s.enabled, click: (item) => saveMeetingSettings({ enabled: item.checked }) },
    { label: tm('Show a test popup'), click: () => showTestMeetingPopup() },
    { type: 'separator' },
    { label: tm('Quit lipcue.com'), click: () => { isQuitting = true; app.quit(); } }
  );
  try {
    tray.setContextMenu(Menu.buildFromTemplate(items));
    const stealthPrefix = stealthActive ? '🛡️ [Stealth] ' : '';
    tray.setToolTip(running ? `${stealthPrefix}lipcue.com · copilot on`
      : active.length ? `${stealthPrefix}lipcue.com · ${active[0].name} detected` : `${stealthPrefix}lipcue.com`);
  } catch (_e) {}
}

function createTray() {
  if (tray || typeof Tray !== 'function') return;
  try {
    tray = new Tray(path.join(APP_ROOT, 'assets', 'tray.png'));
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

// The whole dashboard (text, spacing, icons, tour popovers) is drawn 10%
// larger than its CSS pixels.
const UI_ZOOM = 1.1;

function createWindow() {
  const initialTheme = getThemeState();
  if (initialTheme && initialTheme.preference) {
    nativeTheme.themeSource = initialTheme.preference;
  }
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    // At UI_ZOOM these leave about the same CSS space as 1024x680 did at 100%.
    minWidth: 1100,
    minHeight: 720,
    frame: false,
    backgroundColor: initialTheme.resolved === 'dark' ? '#070908' : '#FFFFFF',
    title: 'lipcue.com — Interview Copilot',
    icon: path.join(APP_ROOT, 'assets', process.platform === 'win32' && fs.existsSync(path.join(APP_ROOT, 'assets', 'icon.ico')) ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(PRELOAD_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: UI_ZOOM
    }
  });

  // Electron resets the zoom of file:// pages on loads and on some hash
  // (router) navigations, so put it back after each of them.
  const keepZoom = () => {
    const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
    if (wc && wc.getZoomFactor() !== UI_ZOOM) wc.setZoomFactor(UI_ZOOM);
  };
  for (const ev of ['did-finish-load', 'did-navigate', 'did-navigate-in-page']) mainWindow.webContents.on(ev, keepZoom);
  const loadPromise = mainWindow.loadFile(path.join(RENDERER_DIR, 'index.html'));
  applyElectronStealthMode();

  // With meeting detection on, closing the window keeps the app in the tray.
  mainWindow.on('close', (e) => {
    const s = getMeetingSettings();
    if (isQuitting || !tray || !s.enabled || !s.keepInTray) return;
    e.preventDefault();
    mainWindow.hide();
    if (!trayHintShown) {
      trayHintShown = true;
      const pt = resolveUiLocale(readConfigIni().ui_language, systemLanguages(app)).startsWith('pt');
      notify(
        pt ? 'O lipcue.com continua ativo' : 'lipcue.com is still running',
        pt ? 'Ele fica na bandeja e avisa quando uma reunião começar.' : 'It stays in the tray and lets you know when a meeting starts.'
      );
    }
  });

  // Start maximized if screen is compact, or allow responsive resize/fullscreen
  if (process.argv.includes('--fullscreen')) {
    mainWindow.setFullScreen(true);
  } else if (process.argv.includes('--maximize')) {
    mainWindow.maximize();
  }

  const settingsSection = settingsSectionFromArgv(process.argv);
  if (settingsSection) showSettingsWindow(settingsSection);
}

// Running from source: use (and start, with Docker) the local lipcue.com
// server in ../backend/ unless a server is configured. The engine inherits the env var.
let localBackendHandle = null;
function startLocalBackendForDev() {
  const configured = readConfigIni().server_url;
  const devUrl = localBackend.devServerUrl({ packaged: app.isPackaged, repoRoot: REPO_ROOT, configuredUrl: configured });
  if (devUrl) process.env.RTAI_SERVER_URL = devUrl;
  const url = effectiveServerUrl(configured);
  if (app.isPackaged || process.env.RTAI_LOCAL_BACKEND === '0' || !localBackend.isLoopbackUrl(url)) return;
  localBackend.ensureLocalBackend({ url, repoRoot: REPO_ROOT }).then((r) => {
    localBackendHandle = r;
    if (r.started) console.log(`[backend] local server ${r.ready ? 'ready' : 'starting'} at ${url}`);
    // The renderer may have asked before the server was up: refresh the account.
    if (r.ready && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('rtai:cloud-event', { type: 'server_ready' });
  }).catch((e) => console.warn('[backend]', e.message));
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  startLocalBackendForDev();
  scheduleCloudSync();
  setInterval(scheduleCloudSync, 5 * 60 * 1000).unref(); // also picks up what other devices sent
  if (session && session.defaultSession) {
    // Only the bundled UI (file://) may use the microphone meter, clipboard and
    // notifications; anything remote that ends up in a window gets nothing.
    const isBundledUi = (url) => typeof url === 'string' && url.startsWith('file://');
    session.defaultSession.setPermissionCheckHandler((webContents, _permission, requestingOrigin) =>
      isBundledUi(requestingOrigin) || isBundledUi(webContents && webContents.getURL()));
    session.defaultSession.setPermissionRequestHandler((webContents, _permission, callback, details) => {
      callback(isBundledUi((details && details.requestingUrl) || (webContents && webContents.getURL())));
    });
  }
  // A fresh install starts empty: no starter goal. Older versions created an
  // empty "My first goal"; it goes away while still untouched.
  removeUntouchedStarterGoal();

  ipcMain.handle('rtai:get-state', async () => {
    const config = readConfigIni();
    const agents = loadAllAgents();
    const sessions = loadPastSessions();
    const profile = loadUserProfile(sessions);
    const themeState = getThemeState(profile.themePreference);
    return {
      appDataDir: getAppDataDir(),
      overlayExePath: getOverlayExecutablePath(),
      // Interface language: the setting resolved against the Windows languages.
      ui: { locale: resolveUiLocale(config.ui_language, systemLanguages(app)), systemLanguages: systemLanguages(app), supported: UI_LOCALES },
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
        agentId: overlayAgentId || config.last_agent || (agents[0]?.id ?? ''),
        startedAt: overlayProcess && !overlayProcess.killed ? overlayStartedAt : 0
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
    windowsDarkCache = null; // the OS theme may have changed
    const nextTheme = getThemeState();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(nextTheme.resolved === 'dark' ? '#0D0D10' : '#FFFFFF');
      mainWindow.webContents.send('rtai:system-theme-updated', nextTheme);
    }
  });

  ipcMain.handle('rtai:save-agent', async (_ev, agent) => {
    const before = loadAllAgents().find((a) => a.id === sanitizeId(agent && agent.id));
    const saved = saveAgentToDisk(agent);
    scheduleCloudSync();
    // The overlay reads the goal at launch: when the running one uses this goal
    // and its answer settings changed, relaunch it so the change takes effect.
    let overlayRestarted = false;
    const answerKeys = ['playbook_name', 'playbook_answer_length', 'playbook_behavioral_structure',
      'playbook_lead_with_answer', 'playbook_name_tradeoffs', 'answer_language', 'coding_language'];
    const changed = before && answerKeys.some((k) => String(before[k] ?? '') !== String(saved[k] ?? ''));
    if (changed && isOverlayRunning() && overlayAgentId === saved.id) {
      launchOverlay({ agent: saved });
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
    scheduleCloudSync();
    const agents = loadAllAgents();
    if (agents.length > 0) {
      writeConfigIni({ last_agent: agents[0].id });
    }
    return { agents };
  });

  ipcMain.handle('rtai:pick-files', async (_ev, defaultTag = 'resume') => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: tm('Select files for the goal RAG (resume, job description, projects)'),
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
      documents.push({
        title: base,
        tag: guessDocumentTag(base, defaultTag),
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
    // Only real events: an empty or unreachable feed shows nothing.
    return { ok: true, source: 'none', events: [] };
  });

  // ---- Google Calendar ----------------------------------------------------
  ipcMain.handle('rtai:gcal-status', async () => {
    await refreshGoogleBroker();
    return getGoogleCalendar().status();
  });
  ipcMain.handle('rtai:gcal-import-client', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: tm('Google OAuth client file (client_secret_....json)'),
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
  // ---- lipcue.com cloud account (device sign-in; docs/server-api.md) ----
  ipcMain.handle('rtai:cloud-status', async (_ev, force) => {
    const st = await cloudAccount.status(Boolean(force));
    const account = st && st.account;
    if (account) {
      const p = loadUserProfile();
      if (p.name !== account.name || p.email !== account.email) saveUserProfile({ name: account.name || '', email: account.email || '' });
    }
    return st;
  });
  ipcMain.handle('rtai:cloud-password-login', async (_ev, p) => cloudAccount.loginWithPassword(p && p.email, p && p.password));
  ipcMain.handle('rtai:cloud-signup', async (_ev, p) => cloudAccount.signup(p && p.name, p && p.email, p && p.password));
  ipcMain.handle('rtai:cloud-reset-password', async (_ev, email) => cloudAccount.resetPassword(email));
  // The server copy goes first: a refused password or no network erases nothing.
  ipcMain.handle('rtai:cloud-delete-account', async (_ev, password) => {
    if (isOverlayRunning()) stopRunningOverlay();
    const res = await cloudAccount.deleteAccount(password);
    if (!res.ok) return res;
    clearTimeout(cloudSyncTimer);
    eraseLocalUserData();
    return { ok: true, config: readConfigIni() };
  });
  ipcMain.handle('rtai:cloud-sync', async () => (isSignedIn() ? runCloudSync() : { ok: false, error: 'not_signed_in' }));
  ipcMain.handle('rtai:cloud-files', async () => cloudAccount.listFiles());
  ipcMain.handle('rtai:cloud-file-delete', async (_ev, id) => cloudAccount.deleteFile(id));
  // Sends the documents of every session as the text the app extracted from
  // them (the originals' paths are not kept); the server skips what it has.
  ipcMain.handle('rtai:cloud-files-backup', async () => {
    let sent = 0;
    const failed = [];
    const seen = new Set();
    for (const agent of loadAllAgents()) {
      for (const doc of agent.documents || []) {
        if (!doc.content) continue;
        const name = /\.(txt|md)$/i.test(doc.title) ? doc.title : `${doc.title}.txt`;
        const key = `${name}\n${doc.content}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const r = await cloudAccount.uploadFile(Buffer.from(doc.content, 'utf8'), { name, tag: doc.tag, agentId: agent.id });
        if (r.ok) sent += 1;
        else failed.push({ title: doc.title, error: r.error });
      }
    }
    return { ok: true, sent, failed };
  });
  const mockInterviews = createMockInterviews({
    dataDir: () => getAppDataDir(),
    agents: () => loadAllAgents(),
    now: () => Date.now(),
    fetch: (...args) => fetch(...args),
    evaluate: async (pairs, agent, lang) => {
      const r = await jevEvaluatePairs(pairs, { context: jevContext(agent, ''), companyName: agent.company || '', lang });
      return r.ok ? r.evaluation : null;
    },
    complete: (messages, maxTokens) => callOpenRouterSol61(messages, maxTokens),
    bank: () => jevEngine.loadQuestionBank(getAppDataDir()),
    api: (method, route, body) => cloudAccount.api(method, route, body, { timeoutMs: 15000 }),
    url: (route) => cloudAccount.aiEndpoint().url.replace('/v1/ai/chat/completions', route),
    headers: () => cloudAccount.aiEndpoint().headers,
    emit: (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('rtai:mock-event', event);
    }
  });
  ipcMain.handle('rtai:mock-start', async (_ev, agentId, lang, mode, avatar) => {
    if (isLocalMode(readConfigIni())) return { ok: false, error: 'Mock interviews need a lipcue.com account.' };
    return mockInterviews.start({ agentId, lang, mode, avatar });
  });
  ipcMain.handle('rtai:mock-analyze', async (_ev, image, previousImage) => mockInterviews.analyzeFrame(image, previousImage));
  ipcMain.handle('rtai:mock-turn', async (_ev, text) => mockInterviews.turn(text));
  ipcMain.handle('rtai:mock-cancel-turn', async () => mockInterviews.cancelTurn());
  ipcMain.handle('rtai:mock-speak', async (_ev, text) => mockInterviews.speak(text));
  ipcMain.handle('rtai:mock-avatar-config', async () => mockInterviews.avatarConfig());
  ipcMain.handle('rtai:mock-avatar-session', async () => mockInterviews.avatarSession());
  ipcMain.handle('rtai:mock-end', async () => mockInterviews.end());
  ipcMain.handle('rtai:mock-prep', async (_ev, agentId) => mockInterviews.prep(agentId));
  ipcMain.handle('rtai:mock-coach', async (_ev, id, question) => mockInterviews.coach(id, question));
  ipcMain.handle('rtai:mock-list', async () => mockInterviews.list());
  ipcMain.handle('rtai:mock-stt-token', async () => mockInterviews.sttToken());
  ipcMain.handle('rtai:cloud-billing', async (_ev, kind, pack) => cloudAccount.billing(kind === 'portal' ? 'portal' : 'checkout', pack));
  ipcMain.handle('rtai:cloud-logout', async () => {
    if (isOverlayRunning()) stopRunningOverlay();
    const res = await cloudAccount.logout();
    return { ...res, config: readConfigIni() };
  });

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
    // The interface language is dashboard-only: it never restarts the copilot.
    const dashboardOnly = configUpdates && Object.keys(configUpdates).every((k) => k === 'ui_language');
    const changed = before !== JSON.stringify(updated.rawIni);
    const shouldRelaunch = configUpdates && !dashboardOnly && (
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
        configOverrides: { ...configUpdates }
      });
      overlayRestarted = true;
    }
    return { config: updated, overlayRestarted };
  });

  ipcMain.handle('rtai:save-profile', async (_ev, profile) => {
    const next = { ...(profile || {}) };
    // Name and e-mail belong to the account while signed in.
    if (isSignedIn()) {
      delete next.name;
      delete next.email;
    }
    return { profile: saveUserProfile(next) };
  });

  // Always a real session: there is no scripted demo.
  ipcMain.handle('rtai:start-overlay', async (_ev, options) => {
    const { agent, configOverrides } = options || {};
    const allowed = await checkCanStartLive();
    if (!allowed.ok) return allowed;
    return launchOverlay({ agent, configOverrides });
  });

  ipcMain.handle('rtai:stop-overlay', async () => {
    stopRunningOverlay();
    return { ok: true };
  });

  ipcMain.handle('rtai:overlay-command', async (_ev, command) => sendOverlayCommand(command));

  // Files dropped on the dashboard: same extraction as the file picker.
  ipcMain.handle('rtai:import-files', async (_ev, payload) => {
    const paths = Array.isArray(payload && payload.paths) ? payload.paths.filter((p) => typeof p === 'string' && p) : [];
    const defaultTag = (payload && payload.tag) || 'material';
    const documents = [];
    const failed = [];
    for (const fp of paths.slice(0, 25)) {
      const base = path.basename(fp);
      try {
        if (!fs.statSync(fp).isFile()) throw new Error('Not a file');
      } catch (e) {
        failed.push({ title: base, error: e.message });
        continue;
      }
      const extracted = await extractDocumentContent(fp);
      if (!extracted.ok) {
        failed.push({ title: base, error: extracted.error });
        continue;
      }
      documents.push({ title: base, tag: guessDocumentTag(base, defaultTag), path: fp, source_path: fp, content: extracted.content });
    }
    return { documents, failed };
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

  ipcMain.handle('rtai:evaluate-session', async (_ev, payload) => evaluateSessionWithJev(payload || {}));
  ipcMain.handle('rtai:rebuild-question-bank', async () => rebuildQuestionBankFromSessions());

  ipcMain.handle('rtai:generate-debrief', async (_ev, payload) => {
    return generateSessionDebrief(payload || {});
  });

  ipcMain.handle('rtai:get-question-bank', async () => {
    return jevEngine.loadQuestionBank(getAppDataDir());
  });

  ipcMain.handle('rtai:get-company-questions', async (_ev, companyId) => {
    const bank = jevEngine.loadQuestionBank(getAppDataDir());
    const comp = bank.companies.find(
      (c) => c.id === companyId || c.name.toLowerCase() === String(companyId).toLowerCase()
    );
    return comp || null;
  });

  ipcMain.handle('rtai:unlock-company-questions', async (_ev, { companyId, previewOnly }) => {
    return jevEngine.unlockCompany(getAppDataDir(), companyId, previewOnly);
  });

  ipcMain.handle('rtai:set-question-sharing', async (_ev, enabled) => {
    writeConfigIni({ share_anonymized_questions: Boolean(enabled) });
    return { ok: true, share_anonymized_questions: Boolean(enabled) };
  });

  ipcMain.handle('rtai:trigger-jev-analysis', async (_ev, { transcript, companyName }) => {
    return jevEngine.ingestSessionQuestions(getAppDataDir(), transcript, companyName, { classify: bankClassifier });
  });

  ipcMain.handle('rtai:detect-company', async (_ev, { transcript, fallbackName }) => {
    return jevEngine.detectCompanyFromTranscript(transcript, fallbackName);
  });

  ipcMain.handle('rtai:fetch-company-logo', async (_ev, { companyName, domain }) => {
    return companyLogoService.resolveAndCacheCompanyLogo(getAppDataDir(), companyName, domain);
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
    bundledPath: path.join(APP_ROOT, 'flags.json'),
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
    packaged: app.isPackaged,
    overlayVersion
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
    let title = 'lipcue.com — Interview Copilot';
    if (valid === 'settings') title = 'Settings';
    else if (valid === 'cmd') title = 'Command Prompt';
    else if (valid === 'taskmgr') title = 'Task Manager';
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
  // Off the startup path: the window is up before the bank is rebuilt.
  setTimeout(() => migrateQuestionBank(), 4000).unref();
});

app.on('will-quit', () => {
  if (localBackendHandle) {
    localBackendHandle.stop(); // stops the container only if this app started it
    localBackendHandle = null;
  }
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
    removeUntouchedStarterGoal,
    generateSessionDebrief,
    loadPastSessions,
    extractDocumentContent,
    extractTextFromDocx,
    isCandidateDocument,
    inheritableDocuments,
    readConfigIni,
    writeConfigIni,
    cloudBackendActive,
    isLocalMode,
    canUseApp,
    isSignedIn,
    checkCanStartLive,
    launchOverlay,
    jevPairs,
    sessionQuestionAnchors,
    sessionQuestionLines,
    rebuildQuestionBankFromSessions,
    pickDefaultAgentId,
    getMeetingSettings,
    applyElectronStealthMode,
    aiTarget,
    runCompanyRecon,
    callOpenRouterJson,
    shareSessionQuestions,
    getGoogleCalendar,
    refreshGoogleBroker
  };
}
