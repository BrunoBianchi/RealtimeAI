// lipcue.com dashboard: the optional rating asked at the end of a live session
// or a mock interview (specs/004-session-feedback-popup).
//
// Decides when to ask (research R7), sends the rating (PUT /v1/feedback) and
// keeps the account preference "Don't show again" (GET /v1/me preferences,
// PUT /v1/me/preferences). A local copy in feedback.json decides while
// offline; with nothing known the dialog stays shut.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const COMMENT_MAX = 1000;
const ASKED_MAX = 50;
const LIVE_MIN_S = 60;

/**
 * @param {object} deps
 * @param {(method: string, path: string, body?: object) => Promise<{ok:boolean,status:number,error:string,data:any}>} deps.api
 *        authenticated call (cloudAccount.api)
 * @param {(code: string, status: number) => string} deps.describeError
 * @param {() => string} deps.dataDir   %LOCALAPPDATA%\RealTimeAI
 * @param {() => boolean} deps.isLocalMode  no account: never ask
 * @param {string} [deps.appVersion]
 * @param {typeof fs} [deps.fs]
 */
function createFeedback(deps) {
  const fsi = deps.fs || fs;
  const file = () => path.join(deps.dataDir(), 'feedback.json');
  let state = null;

  function load() {
    if (state) return state;
    state = { prompt: null, pending_off: false, asked: [] };
    try {
      const raw = JSON.parse(fsi.readFileSync(file(), 'utf8'));
      if (typeof raw.prompt === 'boolean') state.prompt = raw.prompt;
      state.pending_off = raw.pending_off === true;
      if (Array.isArray(raw.asked)) state.asked = raw.asked.filter((x) => typeof x === 'string').slice(-ASKED_MAX);
    } catch (_e) {
      /* first run or unreadable: defaults */
    }
    return state;
  }

  function save() {
    try {
      fsi.mkdirSync(deps.dataDir(), { recursive: true });
      const tmp = `${file()}.tmp`;
      fsi.writeFileSync(tmp, JSON.stringify(state));
      fsi.renameSync(tmp, file());
    } catch (_e) {
      /* the server copy still holds */
    }
  }

  // The preference as last known; a pending "off" wins.
  function knownPrompt() {
    const s = load();
    return s.pending_off ? false : s.prompt;
  }

  function canAsk(id) {
    if (!id || deps.isLocalMode()) return false;
    if (knownPrompt() !== true) return false;
    return !load().asked.includes(id);
  }

  function markAsked(id) {
    const s = load();
    s.asked = s.asked.filter((x) => x !== id);
    s.asked.push(id);
    s.asked = s.asked.slice(-ASKED_MAX);
    save();
  }

  // A mock interview with at least one answer. Marks it asked when true.
  function shouldAskMock({ id, userTurns } = {}) {
    const sid = String(id || '');
    if (!(Number(userTurns) > 0) || !canAsk(sid)) return false;
    markAsked(sid);
    return true;
  }

  // A live session of 60 s or more that the server granted.
  function shouldAskLive({ id, durationS } = {}) {
    const sid = String(id || '');
    if (!(Number(durationS) >= LIVE_MIN_S) || !canAsk(sid)) return false;
    markAsked(sid);
    return true;
  }

  // The engine's bye event (contracts/engine-bye.md): what to ask, or null.
  function onBye(msg) {
    if (!msg || msg.type !== 'bye') return null;
    const id = typeof msg.cloud_session === 'string' ? msg.cloud_session : '';
    return shouldAskLive({ id, durationS: msg.duration_s }) ? { kind: 'live', id } : null;
  }

  function body({ rating, comment }) {
    const out = { rating: Number(rating), surface: 'app', client_version: String(deps.appVersion || '').slice(0, 40) };
    if (!out.client_version) delete out.client_version;
    const c = String(comment || '').trim();
    if (c) out.comment = [...c].slice(0, COMMENT_MAX).join('');
    return out;
  }

  function errorFor(r) {
    if (r.status === 404 || r.error === 'not_found') return { gone: true, error: 'This session can no longer be rated.' };
    if (r.status === 0 || r.error === 'network') return { error: 'Could not send. Check your connection and try again.' };
    return { error: deps.describeError(r.error, r.status) };
  }

  async function submit({ kind, id, rating, comment } = {}) {
    if (kind !== 'live' && kind !== 'mock') return { ok: false, error: deps.describeError('', 400) };
    const n = Number(rating);
    if (!Number.isInteger(n) || n < 1 || n > 5) return { ok: false, error: 'Choose from 1 to 5 stars.' };
    const r = await deps.api('PUT', `/v1/feedback/${kind}/${encodeURIComponent(String(id || ''))}`, body({ rating: n, comment }));
    return r.ok ? { ok: true } : { ok: false, ...errorFor(r) };
  }

  // "Don't show again": shut now, then tell the server; a failure stays
  // pending and is sent with the next /v1/me (syncFromMe).
  async function setPrompt(value) {
    const s = load();
    s.prompt = Boolean(value);
    if (!value) s.pending_off = true;
    save();
    const r = await deps.api('PUT', '/v1/me/preferences', { feedback_prompt: Boolean(value) });
    if (r.ok) {
      s.pending_off = false;
      save();
    }
    return { ok: r.ok };
  }

  // The settings toggle: only what the server saved.
  async function savePrompt(value) {
    const r = await deps.api('PUT', '/v1/me/preferences', { feedback_prompt: Boolean(value) });
    if (!r.ok) return { ok: false, error: 'Could not save. Try again.' };
    const saved = r.data && r.data.preferences && typeof r.data.preferences.feedback_prompt === 'boolean' ? r.data.preferences.feedback_prompt : Boolean(value);
    const s = load();
    s.prompt = saved;
    s.pending_off = false;
    save();
    return { ok: true, value: saved };
  }

  // { value: true | false | null, local } for Settings.
  function getPrompt() {
    return { value: deps.isLocalMode() ? null : knownPrompt(), local: deps.isLocalMode() };
  }

  // Every GET /v1/me answer.
  async function syncFromMe(me) {
    const server = me && me.preferences && me.preferences.feedback_prompt;
    if (typeof server !== 'boolean') return;
    const s = load();
    if (s.pending_off && server) {
      await setPrompt(false);
      return;
    }
    if (s.prompt !== server || s.pending_off) {
      s.prompt = server;
      s.pending_off = false;
      save();
    }
  }

  return { shouldAskMock, shouldAskLive, onBye, submit, setPrompt, savePrompt, getPrompt, syncFromMe, knownPrompt };
}

module.exports = { createFeedback, COMMENT_MAX, LIVE_MIN_S };
