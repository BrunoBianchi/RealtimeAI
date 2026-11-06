// Interface text coverage for the translation catalogs (renderer/i18n.js).
//
// Renders every route, settings tab and dialog through the renderer harness
// with sample data, then collects the text the user would see, split at tags
// the same way the runtime walks text nodes, plus the placeholder / title /
// aria-label attributes. User content (textarea, pre, code, .md,
// [data-no-i18n]) is skipped like the runtime does. Toast and confirm
// messages are taken from the source, since they only appear on events.
//
// Used by tests/i18n.test.js and scripts/i18n-check.mjs.
'use strict';

const { loadRenderer, render, sources, indexHtml, pageIds } = require('./renderer');

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const SKIP_TAGS = new Set(['script', 'style', 'textarea', 'pre', 'code', 'svg']);
const ATTRS = ['placeholder', 'title', 'aria-label'];
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: '\u00a0' };

function decode(s) {
  return s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_m, e) => ENTITIES[e]);
}

function skipsByAttrs(attrs) {
  return /\bdata-no-i18n\b/.test(attrs) || /\bcontenteditable="true"/.test(attrs) || /\bclass="(?:[^"]*\s)?md(?:\s[^"]*)?"/.test(attrs);
}

// Visible strings of a markup string, as the runtime would see them.
function extract(html, out = new Set()) {
  const stack = []; // { tag, skip }
  const skipping = () => stack.some((e) => e.skip);
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[0].startsWith('<!--')) continue;
    if (m[3] !== undefined) {
      if (!skipping()) add(out, decode(m[3]));
      continue;
    }
    const tag = m[1].toLowerCase();
    const attrs = m[2] || '';
    if (m[0].startsWith('</')) {
      const i = stack.map((e) => e.tag).lastIndexOf(tag);
      if (i >= 0) stack.length = i;
      continue;
    }
    const skip = SKIP_TAGS.has(tag) || skipsByAttrs(attrs);
    if (!skip && !skipping()) {
      for (const a of ATTRS) {
        const v = new RegExp(`\\b${a}="([^"]*)"`).exec(attrs);
        if (v) add(out, decode(v[1]));
      }
    }
    if (!VOID.has(tag) && !/\/\s*$/.test(attrs)) stack.push({ tag, skip });
  }
  return out;
}

// Month names come from Intl in the active language, not from the catalogs.
const MONTHS = /^(January|February|March|April|May|June|July|August|September|October|November|December)$/;

function add(out, s) {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t && /[A-Za-z]/.test(t) && !MONTHS.test(t)) out.add(t);
}

// Sample data: one of everything, so every card renders.
const now = Date.UTC(2026, 10, 3, 12);
const DAY = 864e5;
const SAMPLE = {
  config: {
    server_mode: 'auto', has_deepgram_key: true, has_llm_key: true, deepgram_key_display: 'e4a1••••', llm_key_display: 'sk-o••••',
    model: 'qwen/qwen3.6-flash', language: 'pt-BR', ai_response_language: 'pt-BR', auto_suggest: true, cooldown_s: 8,
    fast_response_mode: true, direct_assist: true, save_sessions: true, mic_enabled: true, loopback_enabled: true,
    update_channel: 'stable', ui_language: 'auto'
  },
  agents: [
    {
      id: 'a1', company: 'Acme', role: 'Backend Engineer', interview_date: new Date(now + 3 * DAY).toISOString().slice(0, 10),
      documents: [{ name: 'cv.pdf', title: 'Resume', tag: 'resume', content: 'x'.repeat(2000) }], createdAt: now - 5 * DAY, playbook_name: 'Standard STAR'
    },
    { id: 'a2', company: 'Globex', role: 'Data Analyst', documents: [], createdAt: now - 9 * DAY }
  ],
  sessions: [
    { id: 's1', agentId: 'a1', title: 'Acme mock', startedAt: new Date(now - 2 * DAY).toISOString(), durationSeconds: 1260, questionsCount: 9, suggestions: 8, latency: { avgMs: 420 } },
    { id: 's2', agentId: 'a2', title: 'Globex screening', startedAt: new Date(now - 6 * DAY).toISOString(), durationSeconds: 840, questionsCount: 6, suggestions: 5, latency: { avgMs: 510 } }
  ],
  profile: { name: 'Sample User' },
  questionBank: { companies: [{ id: 'acme', name: 'Acme', questions: [{ id: 'q1', text: 'Tell me about a project you led.', category: 'Behavioral', subCategory: 'Leadership / STAR', count: 2 }] }] },
  lang: { locale: 'en', systemLanguages: ['pt-BR', 'en-US'], supported: ['en', 'pt-BR'] }
};
// Values that come from the sample data, not from the interface.
const SAMPLE_VALUES = new Set(['Tell me about a project you led.', 'Acme', 'Globex', 'Backend Engineer', 'Data Analyst', 'Acme mock', 'Globex screening', 'Sample User', 'cv.pdf', 'e4a1••••', 'sk-o••••', 'S', 'SU']);

const ROUTES = ['home', 'sessions', 'sessions/past', 'session/a1', 'session/a2', 'review/s1', 'files', 'questions', 'mock', 'live'];

function settingsTabs() {
  const m = /const TABS = \[([\s\S]*?)\];/.exec(sources['settings.js']);
  return [...m[1].matchAll(/\['([\w-]+)'/g)].map((x) => x[1]);
}

// Messages passed to toast()/confirm() as plain literals.
function sourceMessages(out) {
  for (const src of Object.values(sources)) {
    for (const m of src.matchAll(/\b(?:toast|confirmDialog|confirm|guard\([^,]+,)\s*\(?\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g)) add(out, m[1].replace(/\\'/g, "'"));
  }
  return out;
}

// Every visible interface string, in render order (deduplicated).
async function collect() {
  const out = new Set();
  extract(indexHtml.replace(/^[\s\S]*?<body[^>]*>/, ''), out);
  const variants = [
    { auth: { signedIn: true, available: true, account: { name: 'Sample User', email: 'user@example.com' }, entitlement: { planLabel: 'PRO', isPro: true, monthly: true, usedMinutes: 42, limitMinutes: 200, leftMinutes: 158, canStart: true } } },
    { config: { ...SAMPLE.config, server_mode: 'local' } },
    { auth: { signedIn: true, available: true, entitlement: { planLabel: 'Free', isPro: false, usedMinutes: 0, limitMinutes: 15, leftMinutes: 15, canStart: true } } },
    // Missing keys: the setup banners on Home.
    { auth: { signedIn: false, available: false }, config: { ...SAMPLE.config, server_mode: 'local', has_deepgram_key: false, has_llm_key: false } },
    { auth: { signedIn: false, available: false }, config: { ...SAMPLE.config, server_mode: 'local', has_deepgram_key: true, has_llm_key: false } },
    // Each meeting detection status in Settings > General.
    { meeting: { supported: false } },
    { meeting: { supported: true, enabled: false } },
    { meeting: { supported: true, enabled: true, active: [] } }
  ];
  for (const extra of variants) {
    const r = loadRenderer({ state: { ...SAMPLE, ...extra, config: extra.config || SAMPLE.config } });
    const routes = [...ROUTES, ...settingsTabs().map((t) => `settings/${t}`)];
    // Hidden and idle, then visible with the copilot running.
    for (const stealth of [true, false]) {
      r.S.stealthState = { active: stealth };
      r.S.overlayStatus = { running: !stealth, agentId: 'a1' };
      for (const route of routes) {
        try {
          extract(String(render(r.Cue, route) || ''), out);
        } catch (_e) {
          /* a view that needs live data the sample lacks */
        }
      }
      // The shell (sidebar, top bar) paints into the page's own elements.
      try {
        r.Cue.renderShell();
      } catch (_e) { /* needs more state */ }
      for (const id of pageIds) {
        const el = r.page(id);
        if (el) extract(el.innerHTML, out);
      }
    }
  }
  // Signed out: the login view, with and without a server configured.
  for (const available of [true, false]) {
    const out_ = loadRenderer({ state: { ...SAMPLE, config: { ...SAMPLE.config, server_url_effective: '' }, auth: { signedIn: false, available } } });
    try {
      extract(String(out_.Cue.views.login([]) || ''), out);
    } catch (_e) { /* ignore */ }
  }
  // Dialogs.
  const r = loadRenderer({ state: SAMPLE });
  const dialogs = [
    ['new-session'], ['edit-session', SAMPLE.agents[0]], ['scheduler', 'a1'], ['profile'],
    ['summary', { export_path: '', text: '' }], ['doc-preview', SAMPLE.agents[0].documents[0]], ['paste-doc', 'a1'], ['playbook', 'a1'], ['palette']
  ];
  for (const [name, data] of dialogs) {
    try {
      r.Cue.openModal(name, data);
    } catch (_e) { /* needs more state */ }
  }
  for (let i = 0; i < r.modals.length; i++) extract(r.modals[i], out);
  // Guided tour popovers (tour.js), every mode.
  for (const s of r.Cue.tourStrings()) add(out, s);
  sourceMessages(out);
  for (const v of SAMPLE_VALUES) out.delete(v);
  return [...out];
}

// Parts that are data, not interface text: initials, short dates, sample values.
const DATE = /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}$|^(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/;
function isData(part) {
  return !/[A-Za-z]/.test(part) || /^[A-Z]{1,2}$/.test(part) || DATE.test(part) || SAMPLE_VALUES.has(part);
}

// A string is covered when the catalog translates it, or else every
// " · "-separated part of it (the generic "{a} · {b}" template).
function covered(I18n, cat, s) {
  if (isData(s) || cat.strings.has(s)) return true;
  const parts = s.split(' · ').map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) return parts.every((p) => covered(I18n, cat, p));
  return I18n.lookup(cat, s) !== null;
}

// Every string and template literal of a source file (holes become {x}): a
// screen that needs live data the samples lack is still checked this way.
function literals(src) {
  const res = [];
  let i = 0;
  const str = (q) => {
    let s = '';
    i++;
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') { s += src[i + 1] === 'n' ? ' ' : src[i + 1]; i += 2; } else s += src[i++];
    }
    i++;
    return s;
  };
  const tmpl = () => {
    let s = '';
    i++;
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { s += src[i + 1]; i += 2; } else if (src[i] === '$' && src[i + 1] === '{') { i += 2; code(true); s += '{x}'; } else s += src[i++];
    }
    i++;
    res.push(s);
  };
  const code = (inHole) => {
    let depth = 0;
    let prev = '';
    while (i < src.length) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 2; continue; }
      if (c === '/' && /[(,=:[!&|?{};\n]|^$/.test(prev)) {
        i++;
        let cls = false;
        while (i < src.length && (src[i] !== '/' || cls) && src[i] !== '\n') {
          if (src[i] === '\\') i++; else if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false;
          i++;
        }
        i++;
        prev = 'r';
        continue;
      }
      if (c === "'" || c === '"') { res.push(str(c)); prev = 's'; continue; }
      if (c === '`') { tmpl(); prev = 's'; continue; }
      if (c === '{') depth++;
      if (c === '}') { if (inHole && depth === 0) { i++; return; } depth--; }
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  };
  code(false);
  return res;
}

// Literals that read as interface text and the catalog does not translate.
function sourceMissing(I18n, cat) {
  const out = new Set();
  const known = (p) => I18n.lookup(cat, p) !== null || I18n.lookup(cat, p.replace(/\{x\}/g, '3')) !== null || I18n.lookup(cat, '3 ' + p) !== null;
  for (const [file, src] of Object.entries(sources)) {
    if (!file.endsWith('.js') || file === 'i18n.js' || file === 'icons.js' || file === 'liveavatar.bundle.js' || file.startsWith('locales') || file.includes('vendor')) continue;
    for (const lit of literals(src)) {
      const pieces = [...lit.matchAll(/\b(?:title|placeholder|aria-label|data-label)="([^"]+)"/g)].map((m) => m[1]);
      lit.replace(/<[^>]*>/g, '\u0001').split('\u0001').forEach((p) => pieces.push(p));
      for (const raw of pieces) {
        const p = raw.replace(/\s+/g, ' ').trim().replace(/^\{x\}/, '');
        const bare = p.replace(/\{x\}/g, ' ').trim();
        if (!/[A-Za-z]{2}/.test(bare)) continue;
        // Prose only: at least two lowercase words, not code or a key combo.
        if (!/^[A-Z(+]/.test(bare) || !/[a-z]+ [a-z]+/.test(bare)) continue;
        if (/[{}<>=;]|=>|\bfunction\b|https?:|\dpx\b|\.(js|css|png|json|ini)\b|rtai:|var\(|\[data-|document\./.test(bare)) continue;
        if (known(p)) continue;
        const frags = p.split('{x}').map((x) => x.trim()).filter((x) => /[A-Za-z]{2}/.test(x));
        if (frags.length && frags.every((x) => I18n.lookup(cat, x) !== null)) continue;
        out.add(p);
      }
    }
  }
  return [...out];
}

// Strings the catalog of `locale` has no translation for.
async function missing(locale) {
  const I18n = require('../../src/renderer/i18n.js');
  require(`../../src/renderer/locales/${locale}.js`);
  const cat = I18n.catalogs[locale];
  if (!cat) throw new Error(`no catalog for ${locale}`);
  const all = await collect();
  return [...new Set([...all.filter((s) => !covered(I18n, cat, s)), ...sourceMissing(I18n, cat)])];
}

module.exports = { extract, collect, missing, SAMPLE };
