// lipcue.com dashboard — core: state, helpers, router, actions, shell and boot.
// Views live in views.js, live.js, settings.js and modals.js; they register
// renderers and actions on window.Cue. Every number on screen comes from the
// main process (agents, session files, config.ini, question bank, engine
// events); nothing is invented when data is missing, it shows "—" instead.
'use strict';

const api = window.rtai;
const { icon, fullLogo, hydrateIcons } = window.CueIcons;

const Cue = (window.Cue = {
  views: {},
  actions: {},
  changes: {},
  inputs: {},
  afterRender: {}
});

// ------------------------------------------------------------------ state --
const S = (Cue.state = {
  // Interface language (i18n.js): the resolved locale and the Windows
  // display languages it was picked from.
  lang: { locale: 'en', systemLanguages: [], supported: ['en'] },
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
Cue.fullLogo = fullLogo;

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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_EN = [MONTHS.slice(), MONTHS_LONG.slice()];
Cue.MONTHS = MONTHS;
Cue.MONTHS_LONG = MONTHS_LONG;

// ------------------------------------------------------------- language --
const I18n = window.CueI18n || { t: (s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => (v && v[k] !== undefined ? v[k] : m)), has: (l) => l === 'en', apply: () => 'en' };
const t = (text, vars) => I18n.t(text, vars);
Cue.t = t;

// The locale to show: the Language setting, or the first Windows display
// language with a catalog (mirrors resolveUiLocale in main/ui_locale.js).
function resolveLocale() {
  const pref = String((S.config && S.config.ui_language) || 'auto');
  if (pref !== 'auto' && I18n.has(pref)) return pref;
  for (const tag of S.lang.systemLanguages || []) {
    const lang = String(tag).toLowerCase().split(/[-_]/)[0];
    const hit = (S.lang.supported || []).find((l) => l.toLowerCase().split('-')[0] === lang);
    if (hit && I18n.has(hit)) return hit;
  }
  return 'en';
}

// Applies the language to the whole page: month names from Intl, the
// automatic translation of rendered text, and a fresh render.
function applyLocale(rerender) {
  const locale = I18n.apply(resolveLocale(), document);
  S.lang.locale = locale;
  const names = (opts) => Array.from({ length: 12 }, (_, i) => {
    try {
      return new Intl.DateTimeFormat(locale, opts).format(new Date(2020, i, 15)).replace(/\.$/, '');
    } catch (_e) {
      return '';
    }
  });
  const short = locale === 'en' ? MONTHS_EN[0] : names({ month: 'short' });
  const long = locale === 'en' ? MONTHS_EN[1] : names({ month: 'long' });
  if (short.every(Boolean)) MONTHS.splice(0, 12, ...short);
  if (long.every(Boolean)) MONTHS_LONG.splice(0, 12, ...long);
  if (rerender && typeof renderView === 'function') renderView(false);
  return locale;
}
Cue.applyLocale = applyLocale;

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
  return t('{m} {d}', { m: MONTHS[d.getMonth()], d: d.getDate() });
}
Cue.fmtDateShort = fmtDateShort;

function fmtCompactDate(d) {
  return `${pad2(d.getDate())} ${t(MONTHS[d.getMonth()]).toLowerCase()}`;
}
Cue.fmtCompactDate = fmtCompactDate;

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
  if (n === 0) return t('Today');
  if (n === 1) return t('Tomorrow');
  if (n === -1) return t('Yesterday');
  if (n > 1) return t('In {n} days', { n });
  return t('{n} days ago', { n: -n });
}
Cue.relDays = relDays;

function plural(n, one, many) {
  return t(`{n} ${n === 1 ? one : many}`, { n });
}
Cue.plural = plural;

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

// Minimal, safe Markdown: input is escaped first, then a few constructs are
// turned back into tags (bold, italics, code, lists, headings, quotes).
function markdownParts(src, { coding = false, streaming = false } = {}) {
  const blocks = [];
  const source = (coding ? String(src ?? '') : fixText(src || '')).replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  if (source.endsWith('\n')) lines.pop();
  let prose = [];
  let fence = '';
  let language = '';
  let code = [];
  const flushCode = (closed) => {
    blocks.push({ language, code: code.join('\n'), closed });
    code = [];
    fence = '';
  };

  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    if (fence) {
      if (trimmed.length >= fence.length && [...trimmed].every((char) => char === fence[0])) {
        flushCode(true);
      } else if (!(streaming && i === lines.length - 1 && !source.endsWith('\n') &&
                   trimmed && [...trimmed].every((char) => char === fence[0]))) {
        code.push(line);
      }
      continue;
    }
    const candidate = coding ? trimmed.replace(/^\d+[.)]\s+/, '') : trimmed;
    const opening = candidate.match(/^(`{3,}|~{3,})([^~`]*?)$/);
    if (!opening) {
      prose.push(line);
      continue;
    }
    if (prose.length) blocks.push({ text: prose.join('\n') });
    prose = [];
    fence = opening[1];
    language = opening[2].trim().split(/\s+/)[0];
  }
  if (fence) flushCode(false);
  if (prose.length) blocks.push({ text: prose.join('\n') });
  return blocks;
}
Cue.markdownParts = markdownParts;

function md(src) {
  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  const out = [];
  for (const part of markdownParts(src)) {
    if ('code' in part) {
      out.push(`<pre><code>${esc(part.code)}</code></pre>`);
      continue;
    }
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
    for (const raw of esc(part.text).split('\n')) {
      if (!raw.trim()) {
        flushPara();
        flushList();
        continue;
      }
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
  return c || r || fixText((a && a.name) || 'Untitled session');
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
  resume: 'Resume',
  job: 'Job description',
  project: 'Project',
  portfolio: 'Portfolio',
  material: 'Material',
  doc: 'Document'
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
// context, extra files, a first recorded session and its debrief.
function readiness(a) {
  if (!a) return { pct: 0, items: [] };
  const docs = Array.isArray(a.documents) ? a.documents : [];
  const cs = a.checklist_state || {};
  const items = [
    { key: 'resume', label: 'Resume attached', done: docs.some((d) => docTag(d) === 'resume'), w: 30 },
    { key: 'job', label: 'Job description', done: Boolean((a.job_description || '').trim()) || docs.some((d) => docTag(d) === 'job'), w: 20 },
    { key: 'research', label: 'Company research', done: Boolean((a.company_research || a.company_dossier || '').trim()), w: 15 },
    { key: 'extra', label: 'Extra material (projects, portfolio)', done: docs.filter((d) => docTag(d) !== 'resume').length > 0, w: 10 },
    { key: 'practice', label: 'First session recorded', done: Boolean(cs.practice_run) || (S.sessions || []).some((s) => s.agentId === a.id), w: 15 },
    { key: 'debrief', label: 'Debrief generated', done: Boolean(cs.debrief_read) || (a.goal_memory_strengths || []).length > 0, w: 10 }
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
  return d ? `Session of ${fmtDateShort(d)}` : fixText((s && s.id) || 'Session');
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
  const ent = S.auth && S.auth.entitlement;
  if (ent) {
    const now = new Date();
    const renew = ent.periodEnd ? new Date(ent.periodEnd) : new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const limit = ent.limitMinutes || null;
    return {
      usedMin: Math.round(ent.usedMinutes),
      limit,
      plan: ent.isPro ? 'pro' : 'free',
      planLabel: ent.planLabel,
      isPro: ent.isPro,
      canStart: ent.canStart,
      reason: ent.reason,
      sessions: list.length,
      questions: list.reduce((acc, s) => acc + (Number(s.questionsCount) || 0), 0),
      answers: list.reduce((acc, s) => acc + (Number(s.suggestions) || Number(s.answersCount) || 0), 0),
      pct: limit ? clamp(Math.round((ent.usedMinutes / limit) * 100), 0, 100) : null,
      left: limit ? Math.max(0, Math.round(ent.leftMinutes + (ent.creditMinutes || 0))) : null,
      renewLabel: ent.monthly ? fmtDateShort(renew) : '',
      monthLabel: ent.monthly ? MONTHS_LONG[now.getMonth()] : 'free session'
    };
  }
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

// Local mode ([servidor] modo = local): no account, no server, the user's own
// keys. Mirrors cloud::local_mode in the engine.
function localMode() {
  const m = String((S.config && S.config.server_mode) || '').trim().toLowerCase();
  return m === 'local' || m === 'offline';
}
Cue.localMode = localMode;

// Extra wait per answer in local mode (cloud::kLocalAnswerDelayMs in the
// engine; keep both in sync).
const LOCAL_ANSWER_DELAY_MS = 500;
Cue.LOCAL_ANSWER_DELAY_MS = LOCAL_ANSWER_DELAY_MS;

// Signed in to the lipcue.com servers: they provide STT and the LLM, no keys
// needed. Mirrors cloud::choose_backend in the engine.
function cloudActive() {
  const c = S.config || {};
  return c.server_mode !== 'proprio' && !localMode() && Boolean(c.has_server_token) && Boolean(c.server_url_effective);
}
Cue.cloudActive = cloudActive;

// What PRO adds over local mode. Shown as ads everywhere in local mode.
const PRO_PERKS = [
  ['cloud', 'Cloud backup of your files', 'Sessions, CVs and documents saved to your account.'],
  ['arrows-clockwise', 'Sync across devices', 'The same sessions and question bank on every computer.'],
  ['calendar', 'Google Calendar', 'Interviews show up on their own, with a reminder to go live.'],
  ['lightning', 'Faster answers', `No ${LOCAL_ANSWER_DELAY_MS} ms wait: answers start right away.`]
];
Cue.PRO_PERKS = PRO_PERKS;

// PRO ad for local mode. kind: 'banner' (one line), 'card' (perk list),
// 'compact' (sidebar). Empty outside local mode.
function proAd(kind = 'banner', title) {
  if (!localMode()) return '';
  const cta = '<button type="button" class="btn sm primary" data-action="go-pro">Get PRO</button>';
  if (kind === 'banner') {
    return `<div class="banner pro-ad">${icon('sparkle')}<span class="grow"><span class="strong">${esc(title || 'You are in local mode.')}</span> PRO adds cloud backup, sync across devices, Google Calendar and answers ${LOCAL_ANSWER_DELAY_MS} ms faster.</span>${cta}</div>`;
  }
  const perks = PRO_PERKS.map(([ic, t, s]) => `<li class="pro-perk">${icon(ic)}<span class="stack" style="gap:0"><span class="t">${esc(t)}</span><span class="s">${esc(s)}</span></span></li>`).join('');
  return `<section class="card pro-ad-card" style="gap:12px">
      <div class="row" style="gap:10px">${icon('sparkle')}<span class="strong grow">${esc(title || 'Unlock lipcue.com PRO')}</span><span class="pill">Local mode</span></div>
      <ul class="pro-perks">${perks}</ul>
      <div class="row" style="gap:8px"><span class="small faint grow">Local mode keeps working with your own keys, with a ${LOCAL_ANSWER_DELAY_MS} ms wait before each answer.</span>${cta}</div>
    </section>`;
}
Cue.proAd = proAd;

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
    toast(failMessage || 'Something went wrong.', 'error');
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
  S.dashboardExecutable = st.dashboardExecutable || '';
  S.agents = st.agents || [];
  S.sessions = st.sessions || [];
  S.profile = st.profile || {};
  S.playbooks = st.playbooks || S.playbooks || [];
  S.themeState = st.themeState || S.themeState;
  S.overlayStatus = st.overlayStatus || S.overlayStatus;
  S.stealthState = st.stealthState || S.stealthState;
  if (st.ui) S.lang = { ...S.lang, ...st.ui };
  return st;
}
Cue.refreshState = refreshState;

async function saveAgent(agent, message) {
  const res = await guard(() => api.saveAgent(agent), 'Could not save the session.');
  if (!res) return null;
  applyAgents(res.agents, res.saved && res.saved.id);
  if (message) toast(res.overlayRestarted ? `${message} The copilot restarted to apply it.` : message);
  renderShell();
  return res.saved || res.agent || null;
}
Cue.saveAgent = saveAgent;

async function saveConfig(patch, message) {
  const res = await guard(() => api.saveConfig(patch), 'Could not save the settings.');
  if (!res) return null;
  if (res.config) S.config = res.config;
  if ('ui_language' in patch) applyLocale(true);
  if (message) toast(res.overlayRestarted ? `${message} The copilot restarted.` : message);
  renderShell();
  return res;
}
Cue.saveConfig = saveConfig;

// Starts the native copilot (HUD) for a goal.
async function startCopilot(agent, codingInterview = false) {
  const target = agent || activeAgent();
  if (!target) {
    toast('Create a session before starting the copilot.');
    Cue.openModal('new-session');
    return null;
  }
  if (isLocked()) {
    navigate('home');
    return null;
  }
  const ent = S.auth && S.auth.entitlement;
  if (ent && !ent.canStart) {
    toast(ent.reason, 'error');
    navigate('settings/plan');
    return null;
  }
  const ready = engineReady();
  if (!ready.ok) {
    toast(!ready.stt ? 'Set up the transcription key (Deepgram) first.' : 'Set up an AI key first.', 'error');
    navigate('settings/ai');
    return null;
  }
  S.activeAgentId = target.id;
  toast(`Starting copilot: ${agentTitle(target)}`);
  const res = await guard(
    () => api.startOverlay({ agent: target, configOverrides: {}, codingInterview }),
    'Could not start the copilot.'
  );
  if (!res) return null;
  if (res.ok === false) {
    toast(res.error || 'The copilot did not start.', 'error');
    if (res.needsLogin && Cue.authRefresh) await Cue.authRefresh(true);
    if (res.needsKeys) navigate('settings/ai');
    else if (res.needsUpgrade) navigate('settings/plan');
    return null;
  }
  if (Cue.liveReset) Cue.liveReset(target.id);
  await refreshState();
  if (res.agent) S.activeAgentId = res.agent.id;
  navigate('live');
  return res;
}
Cue.startCopilot = startCopilot;

async function stopCopilot() {
  await guard(() => api.stopOverlay(), 'Could not stop the copilot.');
  toast('Copilot stopped. The session was saved.');
}
Cue.stopCopilot = stopCopilot;

// ----------------------------------------------------------------- router --
const CRUMBS = {
  home: 'Home',
  mock: 'Mock interview',
  pair: 'Pair programming',
  profile: 'Profile',
  sessions: 'Sessions',
  history: 'History',
  session: 'Session',
  review: 'Review',
  files: 'Files',
  questions: 'Question bank',
  live: 'Live',
  settings: 'Settings'
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
// Until the user signs in or picks local mode, only the sign-in screen exists
// (no sidebar, no tabs, no settings). The main process enforces the same rule.
function isLocked() {
  return !(S.auth && S.auth.signedIn) && !localMode();
}
Cue.isLocked = isLocked;

function applyLock() {
  const locked = isLocked();
  const app = document.getElementById('app');
  if (app) app.classList.toggle('locked', locked);
  for (const id of ['sidebar', 'searchTrigger', 'btnUpdateChip', 'btnTour', 'btnStealthChip', 'btnGoLive']) {
    const el = document.getElementById(id);
    if (el && (id !== 'btnUpdateChip' || locked)) el.hidden = locked;
  }
  return locked;
}

function renderView(resetScroll) {
  const host = document.getElementById('view');
  const locked = applyLock();
  const view = locked ? Cue.views.login : Cue.views[S.route.view] || Cue.views.home;
  let html = '';
  try {
    html = view(S.route.parts);
  } catch (err) {
    console.error(err);
    html = `<div class="page"><div class="empty boxed">${icon('warning')}<span class="t">This screen failed to load</span><span>${esc(err.message)}</span></div></div>`;
  }
  host.innerHTML = html;
  hydrateIcons(host);
  if (resetScroll) document.getElementById('content').scrollTop = 0;
  const after = locked ? Cue.afterRender.login : Cue.afterRender[S.route.view];
  if (after) after(S.route.parts);
  renderShell();
  // First visit of a page: its guided tour (tour.js).
  if (Cue.onViewRendered) Cue.onViewRendered();
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
  ['home', 'Home', 'house'],
  ['sessions', 'Sessions', 'stack'],
  ['history', 'History', 'history'],
  ['files', 'Files', 'folder'],
  ['questions', 'Question bank', 'question'],
  ['mock', 'Mock interview', 'microphone'],
  ['pair', 'Pair programming', 'code'],
  ['live', 'Live', 'broadcast'],
  ['settings', 'Settings', 'gear']
];

function navActive(id) {
  const v = S.route.view;
  if (id === 'settings') return v === 'settings';
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
  if (applyLock()) {
    const crumbEl = document.getElementById('crumb');
    if (crumbEl) crumbEl.textContent = 'Sign in';
    return;
  }
  const running = Boolean(S.overlayStatus && S.overlayStatus.running);
  const ready = engineReady();
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
      const active = navActive(id);
      const right =
        id === 'live' && (running || ready.ok)
          ? `<span class="nav-live-dot${running ? ' running' : ''}" title="${running ? 'Copilot running' : 'Ready'}"></span>`
          : id === 'pair' ? '<span class="nav-count">new</span>'
            : counts[id] === undefined || counts[id] === '' ? '' : `<span class="nav-count">${counts[id]}</span>`;
      return `<button type="button" class="nav-item ${active ? 'active' : ''}" data-action="go" data-to="${id}" title="${esc(label)}"${active ? ' aria-current="page"' : ''}>${icon(ic)}<span class="nav-label">${esc(label)}</span>${right}</button>`;
    }).join(''));
  }

  const crumb = document.getElementById('crumb');
  if (crumb) {
    let label = CRUMBS[S.route.view] || 'Home';
    if (S.route.view === 'sessions' && S.ui.sessTab === 'past') label = 'History';
    if (S.route.view === 'session') {
      const a = agentById(S.route.parts[0]);
      if (a) label = `${t('Sessions')} / ${agentTitle(a)}`;
    }
    crumb.textContent = label;
  }

  // Engine status pill
  const pill = document.getElementById('engineStatusPill');
  const pillLabel = document.getElementById('engineStatusLabel');
  if (pill && pillLabel) {
    if (running) {
      pill.className = 'pill danger';
      pillLabel.textContent = 'Live';
      pill.title = 'The copilot is running';
    } else if (ready.ok) {
      pill.className = 'pill ok';
      pillLabel.textContent = 'Ready';
      pill.title = 'Transcription and AI keys set up';
    } else {
      pill.className = 'pill warn';
      pillLabel.textContent = 'Set up';
      pill.title = !ready.stt ? 'Missing the transcription key (Deepgram)' : 'Missing an AI key';
    }
  }

  // Next interviews in the sidebar
  const next = document.getElementById('sidebarNext');
  if (next) {
    const upcoming = upcomingAgents().slice(0, 2);
    setHtml(next, upcoming.length
      ? `<span class="eyebrow">Up next</span>${upcoming
          .map(({ a, iv }) => {
            const role = agentRole(a) || agentTitle(a);
            const when = iv.days > 1 ? t('in {n}d', { n: iv.days }) : relDays(iv.days).toLowerCase();
            const schedule = `${fmtCompactDate(iv.at)}${iv.hasTime ? ` · ${iv.time}` : ''} · ${when}`;
            const label = esc(`${agentTitle(a)} · ${schedule}`);
            return `<button type="button" class="next-item" data-action="go" data-to="session/${esc(a.id)}" title="${label}" aria-label="${label}">${Cue.companyTile(agentCompany(a), agentCompany(a) || a.name)}<span class="next-copy"><span class="t" data-no-i18n>${esc(role)}</span><span class="s" data-no-i18n>${esc(schedule)}</span></span></button>`;
          })
          .join('')}`
      : '');
  }

  // Usage card
  const u = usage();
  const card = document.getElementById('sidebarUsage');
  if (card) card.classList.toggle('pro-ad', localMode());
  if (card && localMode()) {
    // Local mode: the usage card becomes the PRO ad.
    card.dataset.action = 'go-pro';
    card.removeAttribute('data-to');
    setHtml(card, `
      <div class="row between"><span class="eyebrow">Local mode</span><span class="pill">${icon('sparkle')}PRO</span></div>
      <div class="pro-mini">${PRO_PERKS.map(([ic, t]) => `<span>${icon(ic)}${esc(t)}</span>`).join('')}</div>
      <div class="pro-ad-foot"><span class="pro-ad-note">Answers +${LOCAL_ANSWER_DELAY_MS} ms</span><span class="pro-ad-cta">Get PRO →</span></div>`);
  } else if (card) {
    card.dataset.action = 'go';
    card.dataset.to = 'settings/plan';
    const ticks = usageMeter(u.pct);
    setHtml(card, `
      <div class="row between"><span class="eyebrow">This month</span><span class="plan-badge${u.planLabel === 'Free' ? ' free' : ''}">${esc(u.planLabel)}</span></div>
      <div class="usage-num"><strong>${u.usedMin}</strong> <span class="of">${u.limit ? `/ ${u.limit} min` : 'min transcribed'}</span></div>
      ${u.limit ? ticks : ''}
      <span class="usage-note" data-no-i18n>${esc(u.limit ? t('{n} min left in plan', { n: u.left }) : plural(u.sessions, 'session', 'sessions'))} · ${esc(u.limit ? (u.renewLabel ? t('renews {date}', { date: u.renewLabel }) : t('Does not renew')) : u.monthLabel)}</span>`);
  }

  // Profile
  const acct = (S.auth && S.auth.signedIn && S.auth.account) || {};
  const name = fixText((S.profile && S.profile.name) || acct.name || '');
  const signOutBtn = document.getElementById('sidebarSignOut');
  if (signOutBtn) signOutBtn.hidden = !(S.auth && S.auth.signedIn);
  const setText = (id, t) => {
    const el = document.getElementById(id);
    if (el) el.textContent = t;
  };
  setText('profileInitials', monogram(name || 'You'));
  setText('profileName', name || 'Set up profile');
  setText('profilePlan', localMode() ? 'Local mode' : `${u.planLabel} plan`);

  // Top bar: live button, stealth, update chip
  const live = document.getElementById('btnGoLive');
  if (live) {
    if (running) {
      live.hidden = false;
      live.className = 'btn live';
      // The clock span is ticked in place (tickLiveClock) so the pulse
      // animation is not restarted every second.
      setHtml(live, `<span class="dot" style="background:#fff;animation:pulse 1.4s infinite"></span>${'Live'} <span class="mono" id="btnGoLiveClock" style="font-size:11px;opacity:.85"></span>`);
      tickLiveClock();
    } else {
      live.className = 'btn raised';
      setHtml(live, '<span class="dot"></span>Go live');
      live.hidden = true;
    }
  }
  const stealth = document.getElementById('btnStealthChip');
  if (stealth) {
    const on = Boolean(S.stealthState && S.stealthState.active);
    setHtml(stealth, `${icon(on ? 'eye-slash' : 'eye')}${on ? 'Hidden from captures' : 'Visible in captures'}`);
    stealth.classList.toggle('on', on);
  }
  const upd = document.getElementById('btnUpdateChip');
  if (upd) {
    const st = S.update && S.update.status;
    const show = ['available', 'downloading', 'downloaded'].includes(st);
    upd.hidden = !show;
    if (show) {
      const v = S.update.latestVersion || '';
      setHtml(upd, `${icon('download')}${st === 'downloaded' ? 'Restart to update' : st === 'downloading' ? `Downloading ${S.update.progress ? Math.round(S.update.progress.percent || 0) + '%' : ''}` : `Update ${esc(v)}`}`);
    }
  }
}
Cue.renderShell = renderShell;

// The 40-bar usage meter of the design system: filled bars follow the real share used.
function usageMeter(pct) {
  const heights = [45, 90, 60, 100];
  const filled = pct == null ? 0 : Math.round((Math.min(100, Math.max(0, pct)) / 100) * 40);
  return `<div class="usage-meter" aria-hidden="true">${Array.from({ length: 40 }, (_, i) => `<span class="${i < filled ? 'on' : ''}" style="height:${heights[i % 4]}%"></span>`).join('')}</div>`;
}
Cue.usageMeter = usageMeter;

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
  const res = await guard(() => api.toggleStealthMode(), 'Could not toggle hidden mode.');
  if (res && res.status) {
    S.stealthState = res.status;
    toast(res.status.active ? 'Panel hidden from recordings and screen sharing.' : 'Panel visible in recordings.');
    renderShell();
    if (['home', 'settings'].includes(S.route.view)) refresh();
  }
};

Cue.actions['start-copilot'] = (el) => startCopilot(agentById(el.dataset.agent) || activeAgent(), el.dataset.mode === 'coding-interview');
Cue.actions['stop-copilot'] = () => stopCopilot();

// Local mode -> account: back to the sign-in screen, on "Create account".
// Local sessions and keys stay; the account's plan applies once signed in.
Cue.actions['go-pro'] = async () => {
  const ok = await Cue.confirm('Get lipcue.com PRO', 'Create an account or sign in to get PRO. Your local sessions, files and keys stay on this computer.', 'Continue');
  if (!ok) return;
  if (Cue.authMode) Cue.authMode('signup');
  await saveConfig({ server_mode: 'auto' });
  navigate('home', true);
};
Cue.actions['open-path'] = (el) => api.openExternalPath(el.dataset.path || undefined);
Cue.actions['open-url'] = async (el) => {
  const res = await api.openUrl(el.dataset.url);
  if (!res || !res.ok) toast('Could not open the link.', 'error');
};

// The only actions that work before signing in (sign-in screen + window).
const AUTH_ACTIONS = new Set(['auth-password', 'auth-signup', 'auth-mode', 'auth-reset', 'auth-cancel', 'auth-reopen', 'auth-local', 'open-url']);

function bindDelegation() {
  document.addEventListener('click', (e) => {
    const win = e.target.closest('[data-win]');
    if (win) {
      api.windowControl(win.dataset.win);
      return;
    }
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    if (isLocked() && !AUTH_ACTIONS.has(el.dataset.action)) return;
    const fn = Cue.actions[el.dataset.action];
    if (!fn) return;
    if (el.tagName === 'A') e.preventDefault();
    if (el.dataset.stop) e.stopPropagation();
    fn(el, e);
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-change]');
    if (!el) return;
    if (isLocked() && el.dataset.change !== 'auth-server') return;
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
      if (isLocked()) return;
      Cue.openModal('palette');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      if (!isLocked() && Cue.actions['new-session']) Cue.actions['new-session'](document.getElementById('btnNewSession'), e);
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
  const bank = await guard(() => api.getQuestionBank(), 'Could not load the question bank.');
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
      toast('The summary could not be generated; the transcript was saved.', 'error');
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
    const previous = S.meeting?.active?.[0]?.name;
    S.meeting = st;
    if (S.route.view === 'settings' || (S.route.view === 'home' && previous !== st?.active?.[0]?.name)) refresh();
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
      toast(`${plural(payload.questionsExtracted, 'new question', 'new questions')} added to the bank${payload.company ? ` (${fixText(payload.company)})` : ''}.`);
      await loadQuestionBank(true);
      renderShell();
      if (S.route.view === 'questions' || S.route.view === 'home') refresh();
    }
  });
  // Another device changed something: show it.
  if (api.onCloudSynced) {
    api.onCloudSynced(async () => {
      await refreshState();
      await loadQuestionBank(true);
      renderShell();
      refresh();
    });
  }
  // Clock on the live button (ticked in place; full shell only if it is missing).
  setInterval(() => {
    if (S.overlayStatus && S.overlayStatus.running && !tickLiveClock()) renderShell();
  }, 1000);
}

// ------------------------------------------------------------------- boot --
async function boot() {
  hydrateIcons(document);
  bindDelegation();
  if (Cue.authInit) await Cue.authInit();
  try {
    await refreshState();
  } catch (err) {
    console.error(err);
    toast('Could not read the local data.', 'error');
  }
  applyTheme();
  applyLocale(false);
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
