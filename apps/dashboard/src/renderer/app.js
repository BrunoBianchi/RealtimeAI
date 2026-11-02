// Cue dashboard — core: state, helpers, router, actions, shell and boot.
// Views live in views.js, live.js, settings.js and modals.js; they register
// renderers and actions on window.Cue. Every number on screen comes from the
// main process (agents, session files, config.ini, question bank, engine
// events); nothing is invented when data is missing, it shows "—" instead.
'use strict';

const api = window.rtai;
const { icon, hydrateIcons } = window.CueIcons;

const Cue = (window.Cue = {
  views: {},
  actions: {},
  changes: {},
  inputs: {},
  afterRender: {}
});

// ------------------------------------------------------------------ state --
const S = (Cue.state = {
  config: {},
  agents: [],
  sessions: [],
  profile: {},
  playbooks: [],
  themeState: { preference: 'dark', resolved: 'dark' },
  overlayStatus: { running: false, mode: 'idle', agentId: '', startedAt: 0 },
  stealthState: { active: false },
  questionBank: null,
  flags: null,
  meeting: null,
  update: null,
  appVersion: { version: '', channel: 'stable', packaged: false },
  gcal: { status: null, calendars: [], events: null, eventsError: '' },
  activeAgentId: '',
  route: { view: 'home', parts: [] },
  ui: {
    sessTab: 'upcoming',
    showArchived: false,
    qCompany: 'all',
    qQuery: '',
    qCat: 'all',
    qOpen: '',
    filesQuery: '',
    filesTarget: '',
    reviews: {},
    liveTab: 'answer'
  },
  live: null
});

// ---------------------------------------------------------------- helpers --
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}
Cue.esc = esc;
Cue.icon = icon;

// Older engine builds wrote some UTF-8 text through cp1252 ("NubankÂ·").
function fixText(s) {
  const str = String(s == null ? '' : s);
  if (!/[ÃÂ][\u0080-ÿ]/.test(str)) return str;
  try {
    const bytes = Uint8Array.from(str, (ch) => ch.charCodeAt(0) & 0xff);
    const out = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return out;
  } catch (_e) {
    return str.replace(/Â·/g, '·');
  }
}
Cue.fixText = fixText;

function norm(s) {
  return fixText(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
Cue.norm = norm;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
Cue.clamp = clamp;

function monogram(name) {
  const clean = fixText(name || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  if (!clean) return '—';
  const words = clean.split(/\s+/);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
Cue.monogram = monogram;

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MONTHS_LONG = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
Cue.MONTHS = MONTHS;
Cue.MONTHS_LONG = MONTHS_LONG;

function pad2(n) {
  return String(n).padStart(2, '0');
}
Cue.pad2 = pad2;

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function dayDiff(from, to) {
  return Math.round((startOfDay(to) - startOfDay(from)) / 86400000);
}
Cue.dayDiff = dayDiff;

function fmtDateShort(d) {
  if (!d || Number.isNaN(d.getTime())) return '—';
  return `${pad2(d.getDate())} ${MONTHS[d.getMonth()]}`;
}
Cue.fmtDateShort = fmtDateShort;

function fmtTime(d) {
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
Cue.fmtTime = fmtTime;

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (!s) return '—';
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h${pad2(m % 60)}`;
}
Cue.fmtDuration = fmtDuration;

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${pad2(m)}:${pad2(s % 60)}`;
}
Cue.fmtClock = fmtClock;

function fmtMs(v) {
  return Number.isFinite(v) && v > 0 ? `${Math.round(v)} ms` : '—';
}
Cue.fmtMs = fmtMs;

function fmtKb(chars) {
  const kb = (Number(chars) || 0) / 1024;
  if (!kb) return '—';
  return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
}
Cue.fmtKb = fmtKb;

function relDays(n) {
  if (n === 0) return 'Hoje';
  if (n === 1) return 'Amanhã';
  if (n === -1) return 'Ontem';
  if (n > 1) return `Em ${n} dias`;
  return `Há ${-n} dias`;
}
Cue.relDays = relDays;

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}
Cue.plural = plural;

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

// Minimal, safe Markdown: input is escaped first, then a few constructs are
// turned back into tags (bold, italics, code, lists, headings, quotes).
function md(src) {
  const text = esc(fixText(src || '')).replace(/\r\n/g, '\n');
  const blocks = text.split(/\n{2,}/);
  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  const out = [];
  for (const block of blocks) {
    if (/^```/.test(block)) {
      out.push(`<pre><code>${block.replace(/^```[^\n]*\n?/, '').replace(/```\s*$/, '')}</code></pre>`);
      continue;
    }
    const lines = block.split('\n');
    let list = null;
    let para = [];
    const flushPara = () => {
      if (para.length) out.push(`<p>${inline(para.join('<br>'))}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
      list = null;
    };
    for (const raw of lines) {
      const line = raw.replace(/^&gt;\s?/, '');
      const ul = line.match(/^\s*[-*•]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      const h = line.match(/^#{1,4}\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        const tag = ul ? 'ul' : 'ol';
        if (!list || list.tag !== tag) {
          flushList();
          list = { tag, items: [] };
        }
        list.items.push((ul || ol)[1]);
      } else if (h) {
        flushPara();
        flushList();
        out.push(`<h4>${inline(h[1])}</h4>`);
      } else if (line.trim()) {
        flushList();
        para.push(line);
      }
    }
    flushPara();
    flushList();
  }
  return out.join('');
}
Cue.md = md;

function pctBar(pct, cls) {
  const p = clamp(Math.round(Number(pct) || 0), 0, 100);
  return `<div class="bar ${cls || ''}"><span style="width:${p}%"></span></div>`;
}
Cue.pctBar = pctBar;

function sw(attrs, checked, disabled) {
  return `<label class="switch"><input type="checkbox" ${attrs} ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}/><span class="track"></span></label>`;
}
Cue.sw = sw;

function opts(list, current) {
  return list
    .map(([v, label]) => `<option value="${esc(v)}" ${String(v) === String(current) ? 'selected' : ''}>${esc(label)}</option>`)
    .join('');
}
Cue.opts = opts;

// ---------------------------------------------------------- domain logic --
function agentCompany(a) {
  return fixText((a && a.company) || '').trim();
}
function agentRole(a) {
  return fixText((a && a.role) || '').trim();
}
function agentTitle(a) {
  const c = agentCompany(a);
  const r = agentRole(a);
  if (c && r) return `${c} · ${r}`;
  return c || r || fixText((a && a.name) || 'Sessão sem nome');
}
Cue.agentCompany = agentCompany;
Cue.agentRole = agentRole;
Cue.agentTitle = agentTitle;

function agentById(id) {
  return S.agents.find((a) => a.id === id) || null;
}
Cue.agentById = agentById;

function activeAgent() {
  return agentById(S.activeAgentId) || agentById(S.config.last_agent) || S.agents.find((a) => !a.archived) || S.agents[0] || null;
}
Cue.activeAgent = activeAgent;

function agentInterview(a) {
  const date = (a && (a.next_interview_date || (a.next_interview && a.next_interview.date))) || '';
  const time = (a && (a.next_interview_time || (a.next_interview && a.next_interview.time))) || '';
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = /^\d{1,2}:\d{2}$/.test(time) ? time.split(':').map(Number) : [0, 0];
  const at = new Date(y, m - 1, d, hh, mm);
  return { date, time, at, hasTime: Boolean(time), days: dayDiff(new Date(), at) };
}
Cue.agentInterview = agentInterview;

function docTag(doc) {
  const raw = String((doc && (doc.tag || doc.path)) || '').toLowerCase();
  if (raw.includes('resume') || raw.includes('cv') || raw.includes('curric')) return 'resume';
  if (raw.includes('job') || raw.includes('vaga') || raw === 'jd') return 'job';
  if (raw.includes('project') || raw.includes('proj')) return 'project';
  if (raw.includes('portfolio')) return 'portfolio';
  if (raw.includes('material')) return 'material';
  return 'doc';
}
Cue.docTag = docTag;

const TAG_LABEL = {
  resume: 'Currículo',
  job: 'Descrição da vaga',
  project: 'Projeto',
  portfolio: 'Portfólio',
  material: 'Material',
  doc: 'Documento'
};
Cue.TAG_LABEL = TAG_LABEL;

function docIcon(doc) {
  const name = String((doc && (doc.title || doc.name)) || '').toLowerCase();
  if (name.endsWith('.pdf')) return 'file-pdf';
  if (/\.(js|ts|py|cpp|hpp|json|html|csv)$/.test(name)) return 'file-code';
  if (docTag(doc) === 'job') return 'briefcase';
  if (docTag(doc) === 'portfolio') return 'bookmark';
  return 'file-text';
}
Cue.docIcon = docIcon;

// How much of the material the copilot reads is in place for this goal.
// Weights match what the engine uses: résumé first, then the job, company
// context, extra files, the answer playbook and a debrief from practice.
function readiness(a) {
  if (!a) return { pct: 0, items: [] };
  const docs = Array.isArray(a.documents) ? a.documents : [];
  const cs = a.checklist_state || {};
  const items = [
    { key: 'resume', label: 'Currículo anexado', done: docs.some((d) => docTag(d) === 'resume'), w: 30 },
    { key: 'job', label: 'Descrição da vaga', done: Boolean((a.job_description || '').trim()) || docs.some((d) => docTag(d) === 'job'), w: 20 },
    { key: 'research', label: 'Pesquisa da empresa', done: Boolean((a.company_research || a.company_dossier || '').trim()), w: 15 },
    { key: 'extra', label: 'Material extra (projetos, portfólio)', done: docs.filter((d) => docTag(d) !== 'resume').length > 0, w: 10 },
    { key: 'practice', label: 'Simulação feita', done: Boolean(cs.practice_run), w: 15 },
    { key: 'debrief', label: 'Debrief gerado', done: Boolean(cs.debrief_read) || (a.goal_memory_strengths || []).length > 0, w: 10 }
  ];
  const pct = items.reduce((acc, i) => acc + (i.done ? i.w : 0), 0);
  return { pct: clamp(pct, 0, 100), items };
}
Cue.readiness = readiness;

function sessionDate(s) {
  const iso = s && s.startedAt;
  const d = iso ? new Date(iso) : new Date(Number(s && s.updatedAt) || 0);
  if (!Number.isNaN(d.getTime()) && d.getTime() > 0) return d;
  const m = String((s && s.id) || '').match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return null;
}
Cue.sessionDate = sessionDate;

function sessionTitle(s) {
  const label = fixText((s && s.goalLabel) || '');
  if (label) return label;
  const d = sessionDate(s);
  return d ? `Sessão de ${fmtDateShort(d)}` : fixText((s && s.id) || 'Sessão');
}
Cue.sessionTitle = sessionTitle;

function sessionLatency(s) {
  const v = Number(s && (s.avgTtftMs || s.avgLatencyMs));
  return Number.isFinite(v) && v > 0 ? v : null;
}
Cue.sessionLatency = sessionLatency;

// A session log names its goal ("Nubank · Estágio..."): match it back.
function agentForSession(s) {
  const label = norm((s && s.goalLabel) || '');
  if (!label) return null;
  let best = null;
  let bestScore = 0;
  for (const a of S.agents) {
    const c = norm(agentCompany(a));
    const r = norm(agentRole(a));
    let score = 0;
    if (c && label.includes(c)) score += 2;
    if (r && label.includes(r)) score += 2;
    if (norm(a.name) && label.includes(norm(a.name))) score += 1;
    if (score > bestScore) {
      best = a;
      bestScore = score;
    }
  }
  return bestScore >= 2 ? best : null;
}
Cue.agentForSession = agentForSession;

function sessionsForAgent(a) {
  return S.sessions.filter((s) => agentForSession(s) === a);
}
Cue.sessionsForAgent = sessionsForAgent;

function monthSessions(ref) {
  const now = ref || new Date();
  return S.sessions.filter((s) => {
    const d = sessionDate(s);
    return d && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });
}

// Minutes transcribed this calendar month, from the session files.
function usage() {
  const list = monthSessions();
  const sec = list.reduce((acc, s) => acc + (Number(s.durationSeconds) || 0), 0);
  const tu = (S.profile && S.profile.transcriptionUsage) || {};
  const plan = String((S.profile && S.profile.plan) || 'free').toLowerCase();
  const limit = Number.isFinite(Number(tu.limitMinutes)) && Number(tu.limitMinutes) > 0 && plan !== 'premium' ? Number(tu.limitMinutes) : null;
  const usedMin = Math.round(sec / 60);
  const now = new Date();
  const renew = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return {
    usedMin,
    limit,
    plan,
    planLabel: plan === 'premium' ? 'Pro' : 'Free',
    sessions: list.length,
    questions: list.reduce((acc, s) => acc + (Number(s.questionsCount) || 0), 0),
    answers: list.reduce((acc, s) => acc + (Number(s.suggestions) || Number(s.answersCount) || 0), 0),
    pct: limit ? clamp(Math.round((usedMin / limit) * 100), 0, 100) : null,
    left: limit ? Math.max(0, limit - usedMin) : null,
    renewLabel: fmtDateShort(renew),
    monthLabel: MONTHS_LONG[now.getMonth()]
  };
}
Cue.usage = usage;

const MODEL_LABELS = {
  'qwen/qwen3.6-flash': 'Qwen 3.6 Flash',
  'meta-llama/llama-3.3-70b-instruct': 'Llama 3.3 70B',
  'openai/gpt-oss-120b': 'GPT-OSS 120B',
  'gpt-oss-120b': 'GPT-OSS 120B',
  'llama-3.3-70b': 'Llama 3.3 70B'
};
Cue.MODEL_LABELS = MODEL_LABELS;

function modelLabel(id) {
  const m = String(id || '');
  if (!m) return '—';
  return MODEL_LABELS[m] || m.split('/').pop();
}
Cue.modelLabel = modelLabel;

function providerFor(model) {
  const cfg = S.config || {};
  const m = String(model || '');
  if (m.includes('/') && (cfg.has_llm_key || !cfg.has_cerebras_key)) return 'OpenRouter';
  if (!m.includes('/') && cfg.has_cerebras_key) return 'Cerebras';
  return 'OpenRouter';
}
Cue.providerFor = providerFor;

function recentLatency(n) {
  const vals = S.sessions.map(sessionLatency).filter((v) => v != null).slice(0, n || 10);
  if (!vals.length) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}
Cue.recentLatency = recentLatency;

// Signed in to the RealTimeAI servers: they provide STT and the LLM, no keys
// needed. Mirrors cloud::choose_backend in the engine.
function cloudActive() {
  const c = S.config || {};
  return c.server_mode !== 'proprio' && Boolean(c.has_server_token) && Boolean(c.server_url_effective);
}
Cue.cloudActive = cloudActive;

function engineReady() {
  const c = S.config || {};
  const cloud = cloudActive();
  const stt = cloud || Boolean(c.has_deepgram_key);
  const llm = cloud || Boolean(c.has_llm_key || c.has_cerebras_key || c.has_groq_key || c.has_openai_key || c.has_anthropic_key || c.has_gemini_key);
  return { stt, llm, ok: stt && llm, cloud };
}
Cue.engineReady = engineReady;

// -------------------------------------------------------------- feedback --
function toast(message, kind) {
  const box = document.getElementById('toasts');
  if (!box || !message) return;
  const el = document.createElement('div');
  el.className = `toast ${kind || ''}`;
  el.innerHTML = `<span class="dot ${kind === 'error' ? 'danger' : ''}"></span><span>${esc(message)}</span>`;
  box.appendChild(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, kind === 'error' ? 5200 : 3200);
}
Cue.toast = toast;

async function guard(fn, failMessage) {
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    toast(failMessage || 'Algo deu errado.', 'error');
    return null;
  }
}
Cue.guard = guard;

// ------------------------------------------------------------ data sync --
function applyAgents(list, preferId) {
  if (Array.isArray(list)) S.agents = list;
  if (preferId) S.activeAgentId = preferId;
}
Cue.applyAgents = applyAgents;

async function refreshState() {
  const st = await api.getState();
  S.config = st.config || {};
  S.agents = st.agents || [];
  S.sessions = st.sessions || [];
  S.profile = st.profile || {};
  S.playbooks = st.playbooks || S.playbooks || [];
  S.themeState = st.themeState || S.themeState;
  S.overlayStatus = st.overlayStatus || S.overlayStatus;
  S.stealthState = st.stealthState || S.stealthState;
  return st;
}
Cue.refreshState = refreshState;

async function saveAgent(agent, message) {
  const res = await guard(() => api.saveAgent(agent), 'Não foi possível salvar a sessão.');
  if (!res) return null;
  applyAgents(res.agents, res.saved && res.saved.id);
  if (message) toast(res.overlayRestarted ? `${message} O copiloto foi reiniciado para aplicar.` : message);
  renderShell();
  return res.saved || res.agent || null;
}
Cue.saveAgent = saveAgent;

async function saveConfig(patch, message) {
  const res = await guard(() => api.saveConfig(patch), 'Não foi possível salvar a configuração.');
  if (!res) return null;
  if (res.config) S.config = res.config;
  if (message) toast(res.overlayRestarted ? `${message} O copiloto foi reiniciado.` : message);
  renderShell();
  return res;
}
Cue.saveConfig = saveConfig;

// Starts the native copilot (HUD) for a goal. demo = practice run.
async function startCopilot(agent, demo) {
  const target = agent || activeAgent();
  if (!target) {
    toast('Crie uma sessão antes de iniciar o copiloto.');
    Cue.openModal('new-session');
    return null;
  }
  const ready = engineReady();
  if (!demo && !ready.ok) {
    toast(!ready.stt ? 'Configure a chave de transcrição (Deepgram) primeiro.' : 'Configure uma chave de IA primeiro.', 'error');
    navigate('settings/ai');
    return null;
  }
  S.activeAgentId = target.id;
  toast(demo ? `Iniciando simulação: ${agentTitle(target)}` : `Iniciando copiloto: ${agentTitle(target)}`);
  const res = await guard(
    () => api.startOverlay({ agent: target, demo: Boolean(demo), configOverrides: {} }),
    'Não foi possível iniciar o copiloto.'
  );
  if (!res) return null;
  if (res.ok === false) {
    toast(res.error || 'O copiloto não iniciou.', 'error');
    return null;
  }
  if (Cue.liveReset) Cue.liveReset(target.id, demo);
  await refreshState();
  if (res.agent) S.activeAgentId = res.agent.id;
  navigate('live');
  return res;
}
Cue.startCopilot = startCopilot;

async function stopCopilot() {
  await guard(() => api.stopOverlay(), 'Não foi possível parar o copiloto.');
  toast('Copiloto encerrado. A sessão foi salva.');
}
Cue.stopCopilot = stopCopilot;

// ----------------------------------------------------------------- router --
const CRUMBS = {
  home: 'Início',
  sessions: 'Sessões',
  history: 'Histórico',
  session: 'Sessão',
  review: 'Análise',
  files: 'Arquivos',
  questions: 'Banco de perguntas',
  live: 'Ao vivo',
  settings: 'Configurações'
};

function parseHash() {
  const raw = decodeURIComponent((location.hash || '').replace(/^#\/?/, ''));
  const parts = raw.split('/').filter(Boolean);
  let view = parts.shift() || 'home';
  if (view === 'history') {
    view = 'sessions';
    parts.unshift('past');
  }
  if (!CRUMBS[view]) view = 'home';
  return { view, parts };
}

function navigate(path, replace) {
  const target = `#/${String(path || 'home').replace(/^#?\/?/, '')}`;
  if (location.hash === target) {
    handleRoute();
    return;
  }
  if (replace) history.replaceState(null, '', target);
  else location.hash = target;
  if (replace) handleRoute();
}
Cue.navigate = navigate;

function handleRoute() {
  const prev = S.route.view;
  S.route = parseHash();
  if (S.route.view === 'sessions') S.ui.sessTab = S.route.parts[0] === 'past' ? 'past' : 'upcoming';
  if (prev === 'live' && S.route.view !== 'live' && Cue.liveLeave) Cue.liveLeave();
  if (prev === 'settings' && S.route.view !== 'settings' && Cue.settingsLeave) Cue.settingsLeave();
  renderView(true);
}

// ----------------------------------------------------------------- render --
function renderView(resetScroll) {
  const host = document.getElementById('view');
  const view = Cue.views[S.route.view] || Cue.views.home;
  let html = '';
  try {
    html = view(S.route.parts);
  } catch (err) {
    console.error(err);
    html = `<div class="page"><div class="empty boxed">${icon('warning')}<span class="t">Esta tela falhou ao carregar</span><span>${esc(err.message)}</span></div></div>`;
  }
  host.innerHTML = html;
  hydrateIcons(host);
  if (resetScroll) document.getElementById('content').scrollTop = 0;
  const after = Cue.afterRender[S.route.view];
  if (after) after(S.route.parts);
  renderShell();
}
Cue.renderView = renderView;

// Re-render the current view keeping the scroll position.
function refresh() {
  const content = document.getElementById('content');
  const top = content.scrollTop;
  renderView(false);
  content.scrollTop = top;
}
Cue.refresh = refresh;

const NAV = [
  ['home', 'Início', 'house'],
  ['sessions', 'Sessões', 'stack'],
  ['history', 'Histórico', 'history'],
  ['files', 'Arquivos', 'folder'],
  ['questions', 'Banco de perguntas', 'question'],
  ['live', 'Ao vivo', 'broadcast'],
  ['settings', 'Configurações', 'gear']
];

function navActive(id) {
  const v = S.route.view;
  if (id === 'history') return v === 'review' || (v === 'sessions' && S.ui.sessTab === 'past');
  if (id === 'sessions') return v === 'session' || (v === 'sessions' && S.ui.sessTab !== 'past');
  return v === id;
}

function allDocs() {
  const seen = new Map();
  for (const a of S.agents) {
    for (const d of a.documents || []) {
      const key = `${norm(d.title || d.name)}|${docTag(d)}`;
      if (!seen.has(key)) seen.set(key, d);
    }
  }
  return [...seen.values()];
}
Cue.allDocs = allDocs;

function renderShell() {
  const running = Boolean(S.overlayStatus && S.overlayStatus.running);
  const activeAgents = S.agents.filter((a) => !a.archived);
  const qCount = S.questionBank
    ? (S.questionBank.companies || []).reduce((acc, c) => acc + ((c.questions && c.questions.length) || 0), 0)
    : '';
  const counts = {
    sessions: activeAgents.length,
    history: S.sessions.length,
    files: allDocs().length,
    questions: qCount
  };
  const nav = document.getElementById('sideNav');
  if (nav) {
    setHtml(nav, NAV.map(([id, label, ic]) => {
      const right =
        id === 'live' && running
          ? '<span class="nav-live-dot" title="Copiloto ativo"></span>'
          : `<span class="nav-count">${counts[id] === undefined || counts[id] === '' ? '' : counts[id]}</span>`;
      return `<button type="button" class="nav-item ${navActive(id) ? 'active' : ''}" data-action="go" data-to="${id}" title="${esc(label)}">${icon(ic)}<span class="nav-label">${esc(label)}</span>${right}</button>`;
    }).join(''));
  }

  const crumb = document.getElementById('crumb');
  if (crumb) {
    let label = CRUMBS[S.route.view] || 'Início';
    if (S.route.view === 'sessions' && S.ui.sessTab === 'past') label = 'Histórico';
    if (S.route.view === 'session') {
      const a = agentById(S.route.parts[0]);
      if (a) label = `Sessões / ${agentTitle(a)}`;
    }
    crumb.textContent = label;
  }

  // Engine status pill
  const ready = engineReady();
  const pill = document.getElementById('engineStatusPill');
  const pillLabel = document.getElementById('engineStatusLabel');
  if (pill && pillLabel) {
    if (running) {
      pill.className = 'pill danger';
      pillLabel.textContent = S.overlayStatus.mode === 'demo' ? 'Simulando' : 'Ao vivo';
      pill.title = 'O copiloto está rodando';
    } else if (ready.ok) {
      pill.className = 'pill ok';
      pillLabel.textContent = 'Pronto';
      pill.title = 'Chaves de transcrição e IA configuradas';
    } else {
      pill.className = 'pill warn';
      pillLabel.textContent = 'Configurar';
      pill.title = !ready.stt ? 'Falta a chave de transcrição (Deepgram)' : 'Falta uma chave de IA';
    }
  }

  // Next interviews in the sidebar
  const next = document.getElementById('sidebarNext');
  if (next) {
    const upcoming = upcomingAgents().slice(0, 2);
    setHtml(next, upcoming.length
      ? `<span class="eyebrow" style="padding:0 10px">A seguir</span>${upcoming
          .map(({ a, iv }) => `<button type="button" class="next-item" data-action="go" data-to="session/${esc(a.id)}"><span class="t">${esc(agentTitle(a))}</span><span class="s">${esc(fmtDateShort(iv.at))}${iv.hasTime ? ` · ${esc(iv.time)}` : ''} · ${esc(relDays(iv.days).toLowerCase())}</span></button>`)
          .join('')}`
      : '');
  }

  // Usage card
  const u = usage();
  const card = document.getElementById('sidebarUsage');
  if (card) {
    const ticks = Array.from({ length: 12 }, (_, i) => {
      if (u.pct == null) return '<span></span>';
      const filled = (u.pct / 100) * 12;
      return `<span class="${i < Math.floor(filled) ? 'on' : i < filled ? 'half' : ''}"></span>`;
    }).join('');
    setHtml(card, `
      <div class="row between"><span class="eyebrow">Uso do mês</span><span class="pill">${esc(u.planLabel)}</span></div>
      <div class="row" style="align-items:baseline;gap:6px"><span style="font-size:22px;font-weight:600;letter-spacing:-.03em;line-height:1">${u.usedMin}</span><span class="num">${u.limit ? `/ ${u.limit} min` : 'min transcritos'}</span></div>
      ${u.limit ? `<div class="usage-ticks">${ticks}</div>` : ''}
      <div class="row between faint" style="font-size:11.5px"><span>${u.limit ? `${u.left} min restantes` : plural(u.sessions, 'sessão', 'sessões')}</span><span class="nowrap">${u.limit ? `Renova ${esc(u.renewLabel)}` : esc(u.monthLabel)}</span></div>`);
  }

  // Profile
  const name = fixText((S.profile && S.profile.name) || '');
  const setText = (id, t) => {
    const el = document.getElementById(id);
    if (el) el.textContent = t;
  };
  setText('profileInitials', monogram(name || 'Você'));
  setText('profileName', name || 'Configurar perfil');
  setText('profilePlan', `Plano ${u.planLabel}`);

  // Top bar: live button, stealth, update chip
  const live = document.getElementById('btnGoLive');
  if (live) {
    if (running) {
      live.className = 'btn live';
      // The clock span is ticked in place (tickLiveClock) so the pulse
      // animation is not restarted every second.
      setHtml(live, `<span class="dot" style="background:#fff;animation:pulse 1.4s infinite"></span>${S.overlayStatus.mode === 'demo' ? 'Simulando' : 'Ao vivo'} <span class="mono" id="btnGoLiveClock" style="font-size:11px;opacity:.85"></span>`);
      tickLiveClock();
    } else {
      live.className = 'btn raised';
      setHtml(live, '<span class="dot"></span>Entrar ao vivo');
    }
  }
  const stealth = document.getElementById('btnStealthChip');
  if (stealth) {
    const on = Boolean(S.stealthState && S.stealthState.active);
    setHtml(stealth, `${icon(on ? 'eye-slash' : 'eye')}${on ? 'Oculto' : 'Visível'}`);
    stealth.style.color = on ? 'var(--accent)' : '';
  }
  const upd = document.getElementById('btnUpdateChip');
  if (upd) {
    const st = S.update && S.update.status;
    const show = ['available', 'downloading', 'downloaded'].includes(st);
    upd.hidden = !show;
    if (show) {
      const v = S.update.latestVersion || '';
      setHtml(upd, `${icon('download')}${st === 'downloaded' ? 'Reiniciar para atualizar' : st === 'downloading' ? `Baixando ${S.update.progress ? Math.round(S.update.progress.percent || 0) + '%' : ''}` : `Atualização ${esc(v)}`}`);
    }
  }
}
Cue.renderShell = renderShell;

// Writes markup only when it changed: the shell is refreshed often, and an
// identical rewrite still costs a reflow and restarts CSS animations.
function setHtml(el, html) {
  if (el.__html === html) return;
  el.__html = html;
  el.innerHTML = html;
}

function tickLiveClock() {
  const el = document.getElementById('btnGoLiveClock');
  if (!el) return false;
  const st = S.overlayStatus;
  el.textContent = st && st.startedAt ? fmtClock(Date.now() - st.startedAt) : '';
  return true;
}

function upcomingAgents() {
  return S.agents
    .filter((a) => !a.archived)
    .map((a) => ({ a, iv: agentInterview(a) }))
    .filter(({ iv }) => iv && (iv.days > 0 || (iv.days === 0 && (!iv.hasTime || iv.at.getTime() > Date.now() - 2 * 3600000))))
    .sort((x, y) => x.iv.at - y.iv.at);
}
Cue.upcomingAgents = upcomingAgents;

// ---------------------------------------------------------------- actions --
Cue.actions.go = (el) => navigate(el.dataset.to);
Cue.actions.back = () => history.back();

Cue.actions['toggle-stealth'] = async () => {
  const res = await guard(() => api.toggleStealthMode(), 'Não foi possível alternar o modo oculto.');
  if (res && res.status) {
    S.stealthState = res.status;
    toast(res.status.active ? 'Painel oculto de gravações e compartilhamento de tela.' : 'Painel visível em gravações.');
    renderShell();
    if (['home', 'settings'].includes(S.route.view)) refresh();
  }
};

Cue.actions['start-copilot'] = (el) => startCopilot(agentById(el.dataset.agent) || activeAgent(), el.dataset.demo === '1');
Cue.actions['stop-copilot'] = () => stopCopilot();
Cue.actions['open-path'] = (el) => api.openExternalPath(el.dataset.path || undefined);
Cue.actions['open-url'] = async (el) => {
  const res = await api.openUrl(el.dataset.url);
  if (!res || !res.ok) toast('Não foi possível abrir o link.', 'error');
};

function bindDelegation() {
  document.addEventListener('click', (e) => {
    const win = e.target.closest('[data-win]');
    if (win) {
      api.windowControl(win.dataset.win);
      return;
    }
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const fn = Cue.actions[el.dataset.action];
    if (!fn) return;
    if (el.tagName === 'A') e.preventDefault();
    if (el.dataset.stop) e.stopPropagation();
    fn(el, e);
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-change]');
    if (!el) return;
    const fn = Cue.changes[el.dataset.change];
    if (fn) fn(el, e);
  });
  document.addEventListener('input', (e) => {
    const el = e.target.closest('[data-input]');
    if (!el) return;
    const fn = Cue.inputs[el.dataset.input];
    if (fn) fn(el, e);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      Cue.openModal('palette');
      return;
    }
    if (e.key === 'Escape' && Cue.closeTopModal) Cue.closeTopModal();
  });
  // Dropping files anywhere outside a dropzone must not navigate the window.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    if (!e.target.closest('.dropzone')) e.preventDefault();
  });
}

// ------------------------------------------------------------------ theme --
function applyTheme(info) {
  if (info) S.themeState = { ...S.themeState, ...info };
  const pref = S.themeState.preference || 'dark';
  let resolved = S.themeState.resolved || 'dark';
  if (pref === 'system') resolved = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = resolved === 'light' ? 'light' : 'dark';
}
Cue.applyTheme = applyTheme;

// ------------------------------------------------------------- live data --
async function loadQuestionBank(force) {
  if (S.questionBank && !force) return S.questionBank;
  const bank = await guard(() => api.getQuestionBank(), 'Não foi possível carregar o banco de perguntas.');
  S.questionBank = bank || { companies: [] };
  return S.questionBank;
}
Cue.loadQuestionBank = loadQuestionBank;

async function loadGcal() {
  if (!api.gcalStatus) return;
  try {
    S.gcal.status = await api.gcalStatus();
  } catch (_e) {
    S.gcal.status = null;
  }
}
Cue.loadGcal = loadGcal;

function subscribe() {
  api.onOverlayStatus((st) => {
    const wasRunning = S.overlayStatus && S.overlayStatus.running;
    S.overlayStatus = { ...S.overlayStatus, ...st };
    if (st.agentId) S.activeAgentId = st.agentId;
    if (wasRunning && !st.running) {
      // The engine wrote the session files on exit: list them.
      setTimeout(async () => {
        await refreshState();
        renderShell();
        if (['home', 'sessions', 'session'].includes(S.route.view)) refresh();
      }, 1200);
    }
    if (Cue.liveOnStatus) Cue.liveOnStatus(st);
    renderShell();
    if (S.route.view === 'home') refresh();
  });
  if (api.onLiveEvent) api.onLiveEvent((msg) => Cue.liveOnEvent && Cue.liveOnEvent(msg));
  api.onModeChanged((on) => Cue.liveOnMode && Cue.liveOnMode(Boolean(on)));
  api.onSessionSummary((summary) => {
    if (!summary) return;
    if (!summary.ok) {
      toast('O resumo não pôde ser gerado; a transcrição foi salva.', 'error');
      return;
    }
    Cue.openModal('summary', summary);
  });
  api.onOpenSettings((section) => {
    const map = { general: 'general', appearance: 'general', defaults: 'ai', speech: 'audio', audio: 'audio', ai: 'ai', calendar: 'calendar', stealth: 'privacy', privacy: 'privacy', shortcuts: 'shortcuts', billing: 'plan', overlay: 'overlay', updates: 'updates' };
    navigate(`settings/${map[section] || 'general'}`);
  });
  api.onStealthModeUpdated((st) => {
    if (!st) return;
    S.stealthState = st;
    renderShell();
  });
  api.onSystemThemeUpdated((info) => applyTheme(info));
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applyTheme());
  api.onUpdateStatus((st) => {
    S.update = st;
    renderShell();
    if (S.route.view === 'settings' && S.route.parts[0] === 'updates') refresh();
  });
  api.onUpdateProgress((info) => {
    S.update = { ...(S.update || {}), status: 'downloading', progress: info };
    renderShell();
    const bar = document.getElementById('updateProgressBar');
    if (bar) bar.style.width = `${clamp(Number(info.percent) || 0, 0, 100)}%`;
  });
  api.onFlagsChanged((snap) => {
    S.flags = snap;
    if (S.route.view === 'settings') refresh();
  });
  api.onMeetingDetection((st) => {
    S.meeting = st;
    if (S.route.view === 'settings') refresh();
  });
  api.onQuestionBankUpdated(async (payload) => {
    // The one-time rebuild after an update reclassifies the bank: reload it quietly.
    if (payload && payload.rebuilt) {
      await loadQuestionBank(true);
      renderShell();
      if (S.route.view === 'questions' || S.route.view === 'home') refresh();
      return;
    }
    if (payload && payload.questionsExtracted > 0) {
      toast(`${plural(payload.questionsExtracted, 'pergunta nova', 'perguntas novas')} no banco${payload.company ? ` (${fixText(payload.company)})` : ''}.`);
      await loadQuestionBank(true);
      renderShell();
      if (S.route.view === 'questions' || S.route.view === 'home') refresh();
    }
  });
  // Clock on the live button (ticked in place; full shell only if it is missing).
  setInterval(() => {
    if (S.overlayStatus && S.overlayStatus.running && !tickLiveClock()) renderShell();
  }, 1000);
}

// ------------------------------------------------------------------- boot --
async function boot() {
  hydrateIcons(document);
  bindDelegation();
  try {
    await refreshState();
  } catch (err) {
    console.error(err);
    toast('Não foi possível ler os dados locais.', 'error');
  }
  applyTheme();
  S.activeAgentId = (S.overlayStatus && S.overlayStatus.agentId) || S.config.last_agent || '';
  subscribe();

  // Secondary data in parallel; each view re-renders when its part arrives.
  const loads = [
    loadQuestionBank().then(() => renderShell()),
    loadGcal(),
    guard(() => api.getAppVersion()).then((v) => v && (S.appVersion = { ...S.appVersion, ...v })),
    guard(() => api.getUpdateStatus()).then((st) => st && (S.update = st)),
    guard(() => api.getFlags()).then((f) => f && (S.flags = f)),
    guard(() => api.getMeetingDetection()).then((m) => m && (S.meeting = m))
  ];
  if (!S.playbooks.length && api.getPlaybooks) {
    loads.push(guard(() => api.getPlaybooks()).then((r) => r && r.playbooks && (S.playbooks = r.playbooks)));
  }

  window.addEventListener('hashchange', handleRoute);
  if (!location.hash) history.replaceState(null, '', '#/home');
  handleRoute();
  await Promise.allSettled(loads);
  renderShell();
  if (['home', 'questions', 'settings'].includes(S.route.view)) refresh();
}

window.addEventListener('DOMContentLoaded', boot);
