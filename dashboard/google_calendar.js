'use strict';
// Google Calendar for the RealTimeAI dashboard.
//
// * OAuth 2.0 authorization code flow with PKCE and a loopback redirect: the
//   system browser shows Google's consent page and a one-shot HTTP server on
//   127.0.0.1 receives the answer. "Desktop app" clients accept any loopback
//   port; "Web application" clients only the redirect URIs registered in
//   Google Cloud (WEB_REDIRECT_URI below, unless the JSON lists another one).
// * Tokens live in %LOCALAPPDATA%\RealTimeAI\google_calendar_token.dat,
//   encrypted with Electron safeStorage (DPAPI on Windows) when available.
// * Calendar API v3: calendars, upcoming events, create, update and delete.
//   The "Next interview" of a goal becomes an event that moves and goes away
//   with it.
//
// Everything that touches the outside world (fetch, safeStorage, the browser,
// the clock) is injected, so tests run without Electron or the network.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/calendar/v3';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly'
];
const LOOPBACK_HOST = '127.0.0.1';
const WEB_PORT = 53682;
const WEB_PATH = '/oauth2callback';
const WEB_REDIRECT_URI = `http://${LOOPBACK_HOST}:${WEB_PORT}${WEB_PATH}`;
const CLIENT_FILE = 'google_oauth_client.json';
const TOKEN_FILE = 'google_calendar_token.dat';
const SETTINGS_FILE = 'google_calendar_settings.json';
const LINKS_FILE = 'google_calendar_links.json';
const CONNECT_TIMEOUT_MS = 5 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15000;
const DEFAULT_SETTINGS = { calendarId: 'primary', autoSync: true, reminderMin: 60, durationMin: 60 };

class GcalError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// PKCE (RFC 7636): the code is useless without the verifier this run keeps.
function pkcePair() {
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// The JSON downloaded from Google Cloud > Credentials: {"installed": {...}}
// for a Desktop app, {"web": {...}} for a Web application.
function parseClientJson(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch (_e) {
      return null;
    }
  }
  if (!data || typeof data !== 'object') return null;
  const type = data.installed ? 'installed' : data.web ? 'web' : '';
  const c = type ? data[type] : data;
  if (!c || typeof c !== 'object' || !c.client_id) return null;
  return {
    type: type || 'installed',
    clientId: String(c.client_id),
    clientSecret: c.client_secret ? String(c.client_secret) : '',
    redirectUris: Array.isArray(c.redirect_uris) ? c.redirect_uris.map(String) : [],
    projectId: c.project_id ? String(c.project_id) : ''
  };
}

function safeUrl(s) {
  try {
    return new URL(s);
  } catch (_e) {
    return null;
  }
}

// Where Google sends the browser back after consent. A Web client needs one
// of its registered URIs exactly (a loopback one, so this app can listen on
// it); a Desktop client takes any 127.0.0.1 port (chosen when listening).
function chooseRedirect(client) {
  if (client.type === 'web') {
    for (const uri of client.redirectUris) {
      const u = safeUrl(uri);
      if (u && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port) {
        return { uri, host: LOOPBACK_HOST, port: Number(u.port), path: u.pathname || '/', registered: true };
      }
    }
    return { uri: WEB_REDIRECT_URI, host: LOOPBACK_HOST, port: WEB_PORT, path: WEB_PATH, registered: false };
  }
  return { uri: '', host: LOOPBACK_HOST, port: 0, path: '', registered: true };
}

function buildAuthUrl({ clientId, redirectUri, state, challenge, scopes = SCOPES, loginHint = '' }) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline', // a refresh token: no sign-in every hour
    prompt: 'consent', // Google only returns the refresh token on consent
    include_granted_scopes: 'true',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });
  if (loginHint) p.set('login_hint', loginHint);
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

// ---------------------------------------------------------------- events

const pad = (n) => String(n).padStart(2, '0');
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const isTime = (s) => /^\d{1,2}:\d{2}$/.test(String(s || ''));

// Wall-clock arithmetic ("2026-10-28", "23:30", 60 -> "2026-10-29T00:30:00"):
// the event carries its time zone, so no offsets are computed here.
function addMinutesLocal(date, time, minutes) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, 0) + minutes * 60000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00`;
}

function nextDay(date) {
  return addMinutesLocal(date, '00:00', 24 * 60).slice(0, 10);
}

function defaultTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (_e) {
    return 'UTC';
  }
}

// Calendar API event body. No time = all-day event.
function eventBody({ summary, description = '', location = '', date, time = '', durationMin = 60, timeZone,
                     reminderMin = 60, goalId = '' }) {
  if (!isDate(date)) throw new GcalError('input', 'Pick a valid date.');
  const body = { summary: String(summary || '').trim() || 'Interview' };
  if (description) body.description = String(description);
  if (location) body.location = String(location);
  if (time && isTime(time)) {
    const t = time.length === 4 ? `0${time}` : time;
    const minutes = Math.max(5, Math.min(24 * 60, Number(durationMin) || 60));
    body.start = { dateTime: `${date}T${t}:00`, timeZone };
    body.end = { dateTime: addMinutesLocal(date, t, minutes), timeZone };
  } else {
    body.start = { date };
    body.end = { date: nextDay(date) };
  }
  const rem = Number(reminderMin) || 0;
  body.reminders = rem > 0 ? { useDefault: false, overrides: [{ method: 'popup', minutes: rem }] } : { useDefault: true };
  if (goalId) body.extendedProperties = { private: { rtaiGoalId: String(goalId) } };
  return body;
}

// The "Next interview" of a goal as an event.
function interviewEventBody(goal, settings, timeZone) {
  const ni = goal.next_interview || {};
  const date = goal.next_interview_date || ni.date || '';
  const time = goal.next_interview_time || ni.time || '';
  const who = [goal.role, goal.company].map((s) => String(s || '').trim()).filter(Boolean).join(' @ ');
  const lines = [];
  if (goal.name) lines.push(`Goal: ${goal.name}`);
  lines.push('Prep and live copilot in RealTimeAI.');
  return eventBody({
    summary: `Interview: ${who || goal.name || 'RealTimeAI'}`,
    description: lines.join('\n'),
    date,
    time,
    durationMin: settings.durationMin,
    timeZone,
    reminderMin: settings.reminderMin,
    goalId: goal.id
  });
}

function simplifyEvent(e) {
  const start = (e.start && (e.start.dateTime || e.start.date)) || '';
  const end = (e.end && (e.end.dateTime || e.end.date)) || '';
  return {
    id: e.id,
    summary: e.summary || '(no title)',
    start,
    end,
    allDay: Boolean(e.start && e.start.date && !e.start.dateTime),
    location: e.location || '',
    link: e.htmlLink || '',
    meet: e.hangoutLink || '',
    goalId: (e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.rtaiGoalId) || ''
  };
}

// ---------------------------------------------------------------- storage

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_e) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// Refresh/access tokens, encrypted with safeStorage (DPAPI) when it works.
function tokenStore(dataDir, safeStorage) {
  const file = path.join(dataDir, TOKEN_FILE);
  const canEncrypt = () => {
    try {
      return Boolean(safeStorage && safeStorage.isEncryptionAvailable());
    } catch (_e) {
      return false;
    }
  };
  return {
    encrypted: canEncrypt,
    load() {
      try {
        if (!fs.existsSync(file)) return null;
        const raw = fs.readFileSync(file);
        const head = raw.subarray(0, 6).toString('latin1');
        let json;
        if (head === 'plain:') json = raw.subarray(6).toString('utf8');
        else if (canEncrypt()) json = safeStorage.decryptString(raw);
        else return null;
        const tok = JSON.parse(json);
        return tok && typeof tok === 'object' ? tok : null;
      } catch (_e) {
        return null;
      }
    },
    save(tok) {
      fs.mkdirSync(dataDir, { recursive: true });
      const json = JSON.stringify(tok);
      if (canEncrypt()) fs.writeFileSync(file, safeStorage.encryptString(json));
      else fs.writeFileSync(file, `plain:${json}`, { mode: 0o600 });
    },
    clear() {
      try {
        fs.unlinkSync(file);
      } catch (_e) {}
    }
  };
}

// ---------------------------------------------------------------- loopback

function callbackPage(ok, message) {
  const title = ok ? 'Google Calendar connected' : 'Google Calendar was not connected';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
main{max-width:420px;padding:28px;border-radius:14px;background:#1c1c1c;border:1px solid #333}h1{font-size:18px;margin:0 0 8px}p{color:#aaa;font-size:14px;line-height:1.5}</style>
</head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

function denialText(error) {
  if (error === 'access_denied') return 'Access was declined on the Google page.';
  if (error === 'state_mismatch') return 'The answer from Google did not match this request. Try connecting again.';
  return `Google returned "${error}".`;
}

// One-shot HTTP server on the loopback address that waits for Google's
// redirect (?code=...&state=...).
function startCallbackServer(redirect, expectedState) {
  return new Promise((resolve, reject) => {
    let outcome = null;
    let waiter = null;
    const deliver = () => {
      if (!outcome || !waiter) return;
      const w = waiter;
      waiter = null;
      if (outcome.code) w.resolve(outcome.code);
      else w.reject(new GcalError('denied', denialText(outcome.error)));
    };
    const server = http.createServer((req, res) => {
      const u = new URL(req.url || '/', `http://${LOOPBACK_HOST}`);
      const code = u.searchParams.get('code');
      const error = u.searchParams.get('error');
      if ((redirect.path && u.pathname !== redirect.path) || (!code && !error)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      let result;
      if (u.searchParams.get('state') !== expectedState) result = { error: 'state_mismatch' };
      else if (error) result = { error };
      else result = { code };
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(result.code
        ? callbackPage(true, 'You can close this tab and go back to RealTimeAI.')
        : callbackPage(false, `${denialText(result.error)} You can close this tab.`));
      if (!outcome) {
        outcome = result;
        deliver();
      }
    });
    server.on('error', (e) => {
      if (e && e.code === 'EADDRINUSE') {
        reject(new GcalError('port', `Port ${redirect.port} is in use by another program, so Google cannot return to RealTimeAI. Close it and try again.`));
      } else {
        reject(e);
      }
    });
    server.listen(redirect.port, redirect.host, () => {
      const port = server.address().port;
      resolve({
        uri: redirect.uri || `http://${redirect.host}:${port}${redirect.path}`,
        port,
        waitForCode(timeoutMs) {
          return new Promise((res2, rej2) => {
            const timer = setTimeout(() => {
              waiter = null;
              rej2(new GcalError('timeout', 'Google sign-in was not finished in time. Try connecting again.'));
            }, timeoutMs);
            waiter = {
              resolve: (v) => { clearTimeout(timer); res2(v); },
              reject: (e) => { clearTimeout(timer); rej2(e); }
            };
            deliver();
          });
        },
        close() {
          try {
            server.close();
          } catch (_e) {}
        }
      });
    });
  });
}

// ---------------------------------------------------------------- service

function apiErrorMessage(r, client) {
  const err = (r.body && r.body.error) || {};
  const reasons = (err.errors || []).map((e) => e.reason);
  const message = err.message || (r.body && r.body.raw) || '';
  if (r.status === 403 && (reasons.includes('accessNotConfigured') || /has not been used|is disabled/i.test(message))) {
    const project = client && client.projectId ? `?project=${client.projectId}` : '';
    return `Google Calendar API is not enabled for this Google Cloud project. Enable it at https://console.cloud.google.com/apis/library/calendar-json.googleapis.com${project} and try again.`;
  }
  if (r.status === 403 && reasons.includes('insufficientPermissions')) {
    return 'RealTimeAI does not have calendar access. Disconnect, connect again and allow the calendar permissions.';
  }
  if (r.status === 404) return 'Calendar or event not found.';
  if (r.status === 429 || reasons.includes('rateLimitExceeded')) return 'Google Calendar is busy right now. Try again in a minute.';
  return `Google Calendar error ${r.status}${message ? `: ${message}` : ''}`;
}

function createGoogleCalendar(opts = {}) {
  const dataDir = opts.dataDir;
  if (!dataDir) throw new Error('createGoogleCalendar: dataDir is required');
  const searchDirs = opts.searchDirs || [];
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const openExternal = opts.openExternal || null;
  const now = opts.now || (() => Date.now());
  const timeZone = opts.timeZone || defaultTimeZone();
  const connectTimeoutMs = opts.connectTimeoutMs || CONNECT_TIMEOUT_MS;
  const store = tokenStore(dataDir, opts.safeStorage || null);
  let lastError = '';
  let connecting = null;

  function loadClient() {
    const candidates = [path.join(dataDir, CLIENT_FILE)];
    for (const dir of searchDirs) {
      candidates.push(path.join(dir, CLIENT_FILE));
      try {
        for (const f of fs.readdirSync(dir).sort()) {
          if (/^client_secret.*\.json$/i.test(f)) candidates.push(path.join(dir, f));
        }
      } catch (_e) {}
    }
    for (const file of candidates) {
      try {
        if (!fs.existsSync(file)) continue;
        const c = parseClientJson(fs.readFileSync(file, 'utf8'));
        if (c) return { ...c, source: file };
      } catch (_e) {}
    }
    return null;
  }

  function settings() {
    const s = { ...DEFAULT_SETTINGS, ...readJson(path.join(dataDir, SETTINGS_FILE), {}) };
    s.autoSync = s.autoSync !== false;
    s.reminderMin = Math.max(0, Number(s.reminderMin) || 0);
    s.durationMin = Math.max(5, Number(s.durationMin) || 60);
    s.calendarId = String(s.calendarId || 'primary');
    return s;
  }

  function saveSettings(patch = {}) {
    const s = settings();
    if (patch.calendarId !== undefined) s.calendarId = String(patch.calendarId || 'primary');
    if (patch.autoSync !== undefined) s.autoSync = Boolean(patch.autoSync);
    if (patch.reminderMin !== undefined) s.reminderMin = Math.max(0, Number(patch.reminderMin) || 0);
    if (patch.durationMin !== undefined) s.durationMin = Math.max(5, Number(patch.durationMin) || 60);
    writeJson(path.join(dataDir, SETTINGS_FILE), s);
    return status();
  }

  const linksFile = () => path.join(dataDir, LINKS_FILE);
  const links = () => readJson(linksFile(), {});
  const saveLinks = (l) => writeJson(linksFile(), l);

  function status() {
    const client = loadClient();
    const tok = store.load();
    const s = settings();
    const redirect = client ? chooseRedirect(client) : null;
    return {
      configured: Boolean(client),
      clientType: client ? client.type : '',
      clientSource: client ? client.source : '',
      projectId: client ? client.projectId : '',
      redirectUri: client && client.type === 'web' ? redirect.uri : '',
      connected: Boolean(tok && tok.refresh_token),
      email: (tok && tok.email) || '',
      calendarId: s.calendarId,
      autoSync: s.autoSync,
      reminderMin: s.reminderMin,
      durationMin: s.durationMin,
      timeZone,
      encrypted: store.encrypted(),
      lastError
    };
  }

  function importClient(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!parseClientJson(raw)) {
      throw new GcalError('input', 'This is not a Google OAuth client file. Download it in Google Cloud Console > Credentials > your OAuth client > Download JSON.');
    }
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, CLIENT_FILE), raw, { mode: 0o600 });
    lastError = '';
    return status();
  }

  async function httpJson(url, init = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch (_e) {
        body = { raw: text };
      }
      return { status: res.status, ok: res.ok, body };
    } catch (e) {
      if (e && e.name === 'AbortError') throw new GcalError('network', 'Google did not answer in time. Check your internet connection.');
      throw new GcalError('network', `Could not reach Google: ${e && e.message ? e.message : e}`);
    } finally {
      clearTimeout(timer);
    }
  }

  function tokenRequest(client, params) {
    const form = new URLSearchParams({ client_id: client.clientId, ...params });
    if (client.clientSecret) form.set('client_secret', client.clientSecret);
    return httpJson(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
  }

  async function accessToken(forceRefresh = false) {
    const client = loadClient();
    if (!client) throw new GcalError('not_configured', 'Google Calendar is not set up: load the OAuth client file first.');
    const tok = store.load();
    if (!tok || !tok.refresh_token) throw new GcalError('not_connected', 'Google Calendar is not connected.');
    if (!forceRefresh && tok.access_token && Number(tok.expiry) - 60000 > now()) return { token: tok.access_token, client };
    const r = await tokenRequest(client, { grant_type: 'refresh_token', refresh_token: tok.refresh_token });
    if (!r.ok || !r.body || !r.body.access_token) {
      const err = (r.body && r.body.error) || '';
      if (err === 'invalid_grant' || err === 'invalid_client' || err === 'unauthorized_client') {
        store.clear();
        lastError = 'Google access expired or was removed. Connect again.';
        throw new GcalError('reconnect', lastError);
      }
      throw new GcalError('token', `Google sign-in refresh failed (${r.status}${err ? `: ${err}` : ''}).`);
    }
    tok.access_token = r.body.access_token;
    tok.expiry = now() + (Number(r.body.expires_in) || 3600) * 1000;
    if (r.body.refresh_token) tok.refresh_token = r.body.refresh_token;
    store.save(tok);
    return { token: tok.access_token, client };
  }

  async function api(method, pathname, { query, body } = {}) {
    const url = new URL(API + pathname);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    let attempt = 0;
    for (;;) {
      const { token, client } = await accessToken(attempt > 0);
      const headers = { Authorization: `Bearer ${token}` };
      if (body) headers['Content-Type'] = 'application/json';
      const r = await httpJson(url.toString(), { method, headers, body: body ? JSON.stringify(body) : undefined });
      if (r.status === 401 && attempt === 0) {
        attempt += 1; // the access token was rejected: refresh once
        continue;
      }
      if (!r.ok) {
        const e = new GcalError('api', apiErrorMessage(r, client));
        e.status = r.status;
        throw e;
      }
      return r.body || {};
    }
  }

  async function connect() {
    if (connecting) return connecting;
    const client = loadClient();
    if (!client) throw new GcalError('not_configured', 'Google Calendar is not set up: load the OAuth client file first.');
    if (!openExternal) throw new GcalError('browser', 'No browser available to sign in.');
    connecting = (async () => {
      const redirect = chooseRedirect(client);
      const { verifier, challenge } = pkcePair();
      const state = base64url(crypto.randomBytes(24));
      const server = await startCallbackServer(redirect, state);
      try {
        const old = store.load();
        await openExternal(buildAuthUrl({
          clientId: client.clientId,
          redirectUri: server.uri,
          state,
          challenge,
          loginHint: (old && old.email) || ''
        }));
        const code = await server.waitForCode(connectTimeoutMs);
        const r = await tokenRequest(client, {
          grant_type: 'authorization_code',
          code,
          redirect_uri: server.uri,
          code_verifier: verifier
        });
        if (!r.ok || !r.body || !r.body.access_token) {
          const err = (r.body && (r.body.error_description || r.body.error)) || r.status;
          throw new GcalError('token', `Google did not accept the sign-in (${err}).`);
        }
        const refresh = r.body.refresh_token || (old && old.refresh_token) || '';
        if (!refresh) {
          throw new GcalError('token', 'Google did not return offline access. Remove RealTimeAI at https://myaccount.google.com/permissions and connect again.');
        }
        const tok = {
          refresh_token: refresh,
          access_token: r.body.access_token,
          expiry: now() + (Number(r.body.expires_in) || 3600) * 1000,
          scope: r.body.scope || SCOPES.join(' '),
          connected_at: new Date(now()).toISOString()
        };
        store.save(tok);
        lastError = '';
        try {
          const primary = await api('GET', '/users/me/calendarList/primary');
          if (primary && primary.id) {
            tok.email = primary.id;
            store.save(tok);
          }
        } catch (e) {
          lastError = e.message; // e.g. the Calendar API is not enabled yet
        }
        return status();
      } finally {
        server.close();
      }
    })();
    try {
      return await connecting;
    } catch (e) {
      lastError = e.message;
      throw e;
    } finally {
      connecting = null;
    }
  }

  async function disconnect() {
    const tok = store.load();
    store.clear();
    lastError = '';
    if (tok && (tok.refresh_token || tok.access_token)) {
      try {
        await httpJson(REVOKE_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: tok.refresh_token || tok.access_token }).toString()
        });
      } catch (_e) {
        // Revoking is a courtesy: the local tokens are gone either way.
      }
    }
    return status();
  }

  async function listCalendars() {
    const body = await api('GET', '/users/me/calendarList', { query: { minAccessRole: 'writer', maxResults: 100 } });
    return (body.items || []).map((c) => ({
      id: c.id,
      summary: c.summaryOverride || c.summary || c.id,
      primary: Boolean(c.primary),
      color: c.backgroundColor || ''
    }));
  }

  async function listEvents({ days = 14, max = 20, calendarId } = {}) {
    const cal = calendarId || settings().calendarId || 'primary';
    const from = new Date(now());
    const to = new Date(now() + Math.max(1, Number(days) || 14) * 86400000);
    const body = await api('GET', `/calendars/${encodeURIComponent(cal)}/events`, {
      query: {
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: Math.min(100, Math.max(1, Number(max) || 20))
      }
    });
    return (body.items || []).filter((e) => e.status !== 'cancelled').map(simplifyEvent);
  }

  async function createEvent(ev = {}) {
    const s = settings();
    const cal = ev.calendarId || s.calendarId;
    const body = eventBody({
      summary: ev.summary,
      description: ev.description,
      location: ev.location,
      date: ev.date,
      time: ev.time,
      durationMin: ev.durationMin || s.durationMin,
      timeZone,
      reminderMin: ev.reminderMin !== undefined ? ev.reminderMin : s.reminderMin,
      goalId: ev.goalId
    });
    const created = await api('POST', `/calendars/${encodeURIComponent(cal)}/events`, { body });
    return { ...simplifyEvent(created), calendarId: cal };
  }

  async function updateEvent(calendarId, eventId, ev = {}) {
    const s = settings();
    const body = eventBody({
      summary: ev.summary,
      description: ev.description,
      location: ev.location,
      date: ev.date,
      time: ev.time,
      durationMin: ev.durationMin || s.durationMin,
      timeZone,
      reminderMin: ev.reminderMin !== undefined ? ev.reminderMin : s.reminderMin,
      goalId: ev.goalId
    });
    const cal = calendarId || s.calendarId;
    const updated = await api('PATCH', `/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(eventId)}`, { body });
    return { ...simplifyEvent(updated), calendarId: cal };
  }

  async function deleteEvent(calendarId, eventId) {
    const cal = calendarId || settings().calendarId;
    try {
      await api('DELETE', `/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(eventId)}`);
    } catch (e) {
      if (e.status !== 404 && e.status !== 410) throw e; // already gone is fine
    }
    return { ok: true };
  }

  // The goal's "Next interview" -> its event (created, moved or removed).
  // Never throws: scheduling must work even when Google does not.
  async function syncInterview(goal, wanted) {
    try {
      const st = status();
      const s = settings();
      if (!st.connected) return { ok: false, skipped: true, reason: 'not_connected' };
      if (wanted === false || (wanted === undefined && !s.autoSync)) return { ok: false, skipped: true, reason: 'off' };
      const ni = goal.next_interview || {};
      const date = goal.next_interview_date || ni.date || '';
      if (!date) return removeInterview(goal.id);
      const body = interviewEventBody(goal, s, timeZone);
      const all = links();
      const link = all[goal.id];
      let saved = null;
      if (link && link.eventId) {
        try {
          saved = await api('PATCH', `/calendars/${encodeURIComponent(link.calendarId)}/events/${encodeURIComponent(link.eventId)}`, { body });
          saved = { ...saved, calendarId: link.calendarId };
        } catch (e) {
          if (e.status !== 404 && e.status !== 410) throw e; // deleted in Google: create it again
        }
      }
      if (!saved) {
        const cal = s.calendarId;
        saved = { ...(await api('POST', `/calendars/${encodeURIComponent(cal)}/events`, { body })), calendarId: cal };
      }
      all[goal.id] = { calendarId: saved.calendarId, eventId: saved.id };
      saveLinks(all);
      return { ok: true, eventId: saved.id, link: saved.htmlLink || '', created: !link };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code || '' };
    }
  }

  async function removeInterview(goalId) {
    try {
      const all = links();
      const link = all[goalId];
      if (!link) return { ok: true, removed: false };
      if (status().connected) await deleteEvent(link.calendarId, link.eventId);
      delete all[goalId];
      saveLinks(all);
      return { ok: true, removed: true };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code || '' };
    }
  }

  return {
    status,
    settings,
    saveSettings,
    importClient,
    connect,
    disconnect,
    listCalendars,
    listEvents,
    createEvent,
    updateEvent,
    deleteEvent,
    syncInterview,
    removeInterview
  };
}

module.exports = {
  createGoogleCalendar,
  parseClientJson,
  chooseRedirect,
  buildAuthUrl,
  pkcePair,
  eventBody,
  interviewEventBody,
  addMinutesLocal,
  startCallbackServer,
  GcalError,
  SCOPES,
  WEB_REDIRECT_URI,
  CLIENT_FILE,
  TOKEN_FILE
};
