// Cue cloud account (dashboard side). Signing in is mandatory: the
// dashboard shows only the sign-in screen until there is a device token.
// Three ways in, all ending in the same device token:
//   * Google and SSO (SAML/OIDC of the user's company): the OAuth 2.0 device
//     authorization grant (RFC 8628) with a `provider` hint. The dashboard
//     opens the browser on the server's page (which redirects to Google or to
//     the company IdP) and polls until the user approves;
//   * e-mail + password: POST /v1/auth/login (and /v1/auth/signup). The resulting device token goes to config.ini [servidor] token,
// where the engine (rtai_app) encrypts it with DPAPI and exchanges it for
// short-lived STT/LLM credentials at each session (POST /v1/session).
//
// Nothing here runs during a live session: the hot path (audio -> STT -> LLM)
// never waits on this module. Contract: docs/server-api.md.
'use strict';

const { entitlement } = require('./plans');

// Official builds set this (keep it in sync with CMake -DRTAI_SERVER_URL).
// For now the Droplet by address, over plain HTTP: move to https://<domain> as soon as there is one.
const BUILTIN_SERVER_URL = 'http://167.172.147.53';

const STATUS_TTL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const UPLOAD_TIMEOUT_MS = 120000;

function normalizeBaseUrl(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+/i.test(u) ? u : '';
}

// Hosted billing pages must be https; plain http only for a local server (backend/).
function billingUrlAllowed(url) {
  return /^https:\/\//i.test(url) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(url);
}

function effectiveServerUrl(configured) {
  return normalizeBaseUrl(configured) || normalizeBaseUrl(process.env.RTAI_SERVER_URL) || normalizeBaseUrl(BUILTIN_SERVER_URL);
}

// pt-BR text for the device-flow errors of RFC 8628 §3.5 and HTTP failures.
function describeError(code, status) {
  switch (code) {
    case 'access_denied': return 'Access denied in the browser.';
    case 'expired_token': return 'The code expired. Try signing in again.';
    case 'invalid_token': return 'Session expired: sign in to your account again.';
    case 'network': return 'No connection to the Cue server.';
    case 'no_server': return 'No server configured.';
    case 'invalid_credentials': return 'Wrong e-mail or password.';
    case 'email_taken': return 'An account with this e-mail already exists. Sign in or reset the password.';
    case 'weak_password': return 'Weak password: use at least 8 characters.';
    case 'invalid_email': return 'Invalid e-mail.';
    case 'email_not_verified': return 'Confirm your e-mail with the link we sent, then sign in again.';
    case 'sso_not_configured': return 'SSO is not set up for this domain. Contact your company administrator.';
    case 'rate_limited': return 'Too many attempts. Wait a moment and try again.';
    case 'signin_unavailable': return 'Google and SSO sign-in are not available yet. Sign in with e-mail and password.';
    case 'file_too_large': return 'Files can have up to 20 MB.';
    case 'storage_full': return 'Your cloud storage is full.';
    case 'billing_unavailable': return 'Upgrades are not available yet. Try again later.';
    default:
      if (status === 401) return 'Session expired: sign in to your account again.';
      if (status === 426) return 'App version too old: please update.';
      if (status >= 500) return 'Server unavailable right now.';
      return 'Could not reach the server.';
  }
}

/**
 * @param {object} deps
 * @param {() => string} deps.getServerUrl   configured [servidor] url ('' = default)
 * @param {() => boolean} deps.hasToken      whether a device token is stored
 * @param {() => string} deps.readToken      plaintext token ('' when encrypted-only/absent)
 * @param {(token: string) => void} deps.saveToken  persists ('' clears) the token
 * @param {(url: string) => void} deps.openBrowser
 * @param {(event: object) => void} [deps.emit]     progress events for the renderer
 * @param {string} deps.appVersion
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 */
function createCloudAccount(deps) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const emit = deps.emit || (() => {});
  let login = null; // { cancelled: boolean }
  let cache = null; // { at, value }

  async function request(method, path, { body, token, timeoutMs } = {}) {
    const base = effectiveServerUrl(deps.getServerUrl());
    if (!base) return { ok: false, status: 0, error: 'no_server', data: null };
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || REQUEST_TIMEOUT_MS) : null;
    try {
      const res = await fetchImpl(base + path, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'X-RTAI-Version': deps.appVersion || ''
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl ? ctrl.signal : undefined
      });
      let data = null;
      try { data = await res.json(); } catch (_e) { data = null; }
      const code = data && typeof data.error === 'string' ? data.error : (data && data.error && data.error.code) || '';
      return { ok: res.ok, status: res.status, error: code, data };
    } catch (_e) {
      return { ok: false, status: 0, error: 'network', data: null };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Authenticated call for the server-side features (research, community
  // questions, Google Calendar broker). { ok, status, error, data }; a 401
  // drops the cached account so the app shows the sign-in screen again.
  async function api(method, path, body, { timeoutMs } = {}) {
    const token = deps.readToken();
    if (!token) return { ok: false, status: 401, error: 'invalid_token', data: null };
    const r = await request(method, path, { body, token, timeoutMs });
    if (r.status === 401) cache = null;
    return r;
  }

  // Where the dashboard's own AI calls go when signed in: the server relay,
  // authorized with the device token. null without a server or a token.
  function aiEndpoint() {
    const base = effectiveServerUrl(deps.getServerUrl());
    const token = base ? deps.readToken() : '';
    if (!token) return null;
    return { url: `${base}/v1/ai/chat/completions`, headers: { Authorization: `Bearer ${token}`, 'X-RTAI-Version': deps.appVersion || '' } };
  }

  function serverInfo() {
    const url = effectiveServerUrl(deps.getServerUrl());
    return { available: Boolean(url), serverUrl: url, builtin: !normalizeBaseUrl(deps.getServerUrl()) && Boolean(url) };
  }

  async function status(force) {
    const info = serverInfo();
    if (!info.available) return { ...info, signedIn: false };
    if (!deps.hasToken()) return { ...info, signedIn: false };
    if (!force && cache && Date.now() - cache.at < STATUS_TTL_MS) return cache.value;
    const token = deps.readToken();
    // Encrypted by the engine (dpapi:...): the dashboard cannot read it back.
    // It is still a valid sign-in; the engine uses it at the next session.
    if (!token) {
      const value = { ...info, signedIn: true, account: null, detail: 'Signed in.' };
      cache = { at: Date.now(), value };
      return value;
    }
    const r = await request('GET', '/v1/me', { token });
    let value;
    if (r.ok && r.data) {
      value = { ...info, signedIn: true, account: r.data, entitlement: entitlement(r.data) };
    } else if (r.status === 401) {
      value = { ...info, signedIn: false, expired: true, detail: describeError('invalid_token', 401) };
    } else {
      // Offline or server hiccup: keep the sign-in, just without fresh data.
      value = { ...info, signedIn: true, account: null, detail: describeError(r.error, r.status) };
    }
    cache = { at: Date.now(), value };
    return value;
  }

  // provider: 'google' | 'sso' (login_hint = work e-mail or company domain).
  async function startLogin(options) {
    if (!serverInfo().available) return { ok: false, error: describeError('no_server') };
    const provider = options && ['google', 'sso'].includes(options.provider) ? options.provider : 'google';
    const hint = String((options && options.hint) || '').trim();
    if (provider === 'sso' && !hint) return { ok: false, error: 'Enter your work e-mail or company domain.' };
    if (login) login.cancelled = true;
    const mine = { cancelled: false };
    login = mine;
    const start = await request('POST', '/v1/auth/device', {
      body: { client_id: 'rtai-dashboard', app_version: deps.appVersion || '', provider, ...(hint ? { login_hint: hint } : {}) }
    });
    if (!start.ok || !start.data || !start.data.device_code) {
      login = null;
      return { ok: false, error: describeError(start.error, start.status) };
    }
    const d = start.data;
    const verifyUrl = d.verification_uri_complete || d.verification_uri;
    if (verifyUrl) deps.openBrowser(verifyUrl);
    emit({ type: 'pending', userCode: d.user_code || '', verificationUri: d.verification_uri || verifyUrl || '' });

    // Poll in the background; the IPC call returns the code right away.
    (async () => {
      let interval = Math.max(1, Number(d.interval) || 5) * 1000;
      const deadline = Date.now() + Math.max(60, Number(d.expires_in) || 600) * 1000;
      while (!mine.cancelled && Date.now() < deadline) {
        await sleep(interval);
        if (mine.cancelled) return;
        const r = await request('POST', '/v1/auth/device/token', {
          body: { device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: 'rtai-dashboard' }
        });
        if (mine.cancelled) return;
        if (r.ok && r.data && r.data.access_token) {
          deps.saveToken(String(r.data.access_token));
          cache = null;
          login = null;
          emit({ type: 'signed_in', account: r.data.account || null });
          return;
        }
        if (r.error === 'authorization_pending' || r.error === 'network') continue;
        if (r.error === 'slow_down') { interval += 5000; continue; }
        login = null;
        emit({ type: 'error', error: describeError(r.error, r.status) });
        return;
      }
      if (!mine.cancelled) {
        login = null;
        emit({ type: 'error', error: describeError('expired_token') });
      }
    })();
    return { ok: true, userCode: d.user_code || '', verificationUri: d.verification_uri || verifyUrl || '', expiresIn: Number(d.expires_in) || 600 };
  }

  // Token responses from password sign-in / sign-up.
  function finishSignIn(r) {
    if (r.ok && r.data && r.data.access_token) {
      deps.saveToken(String(r.data.access_token));
      cache = null;
      emit({ type: 'signed_in', account: r.data.account || null });
      return { ok: true, account: r.data.account || null };
    }
    if (r.ok && r.data && r.data.verification_required) {
      return { ok: false, pendingVerification: true, error: describeError('email_not_verified') };
    }
    const msg = r.data && r.data.error && r.data.error.message;
    return { ok: false, error: msg || describeError(r.error, r.status) };
  }

  const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());

  async function loginWithPassword(email, password) {
    if (!serverInfo().available) return { ok: false, error: describeError('no_server') };
    if (!validEmail(email)) return { ok: false, error: describeError('invalid_email') };
    if (!password) return { ok: false, error: 'Enter your password.' };
    const r = await request('POST', '/v1/auth/login', {
      body: { email: String(email).trim(), password: String(password), client_id: 'rtai-dashboard' }
    });
    return finishSignIn(r);
  }

  async function signup(name, email, password) {
    if (!serverInfo().available) return { ok: false, error: describeError('no_server') };
    if (!validEmail(email)) return { ok: false, error: describeError('invalid_email') };
    if (String(password || '').length < 8) return { ok: false, error: describeError('weak_password') };
    const r = await request('POST', '/v1/auth/signup', {
      body: { name: String(name || '').trim(), email: String(email).trim(), password: String(password), client_id: 'rtai-dashboard' }
    });
    return finishSignIn(r);
  }

  async function resetPassword(email) {
    if (!validEmail(email)) return { ok: false, error: describeError('invalid_email') };
    const r = await request('POST', '/v1/auth/password/reset', { body: { email: String(email).trim() } });
    // Same answer whether or not the account exists (no account enumeration).
    return r.status === 0 ? { ok: false, error: describeError('network') } : { ok: true };
  }

  // PRO checkout / subscription management: the server returns a hosted page.
  async function billing(kind, pack) {
    const token = deps.readToken();
    if (!token) return { ok: false, error: describeError('invalid_token') };
    const r = await request('POST', kind === 'portal' ? '/v1/billing/portal' : '/v1/billing/checkout', {
      token,
      body: kind === 'portal' ? {} : pack ? { pack: String(pack) } : { plan: 'pro' }
    });
    if (r.ok && r.data && billingUrlAllowed(String(r.data.url || ''))) {
      deps.openBrowser(r.data.url);
      cache = null; // the plan may change once the user pays
      return { ok: true };
    }
    return { ok: false, error: describeError(r.error, r.status) };
  }

  // Cloud backup of a document (POST /v1/files, raw bytes).
  async function uploadFile(bytes, { name, tag, agentId } = {}) {
    const base = effectiveServerUrl(deps.getServerUrl());
    const token = deps.readToken();
    if (!base || !token) return { ok: false, error: describeError('invalid_token') };
    const q = new URLSearchParams({ name: String(name || '') });
    if (tag) q.set('tag', String(tag));
    if (agentId) q.set('agent_id', String(agentId));
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT_MS) : null;
    try {
      const res = await fetchImpl(`${base}/v1/files?${q}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${token}`, 'X-RTAI-Version': deps.appVersion || '' },
        body: bytes,
        signal: ctrl ? ctrl.signal : undefined
      });
      const data = await res.json().catch(() => null);
      if (res.ok) return { ok: true, file: data };
      return { ok: false, status: res.status, error: describeError(data && data.error, res.status) };
    } catch (_e) {
      return { ok: false, status: 0, error: describeError('network') };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function listFiles() {
    const r = await api('GET', '/v1/files');
    return r.ok ? { ok: true, ...r.data } : { ok: false, error: describeError(r.error, r.status) };
  }

  async function deleteFile(id) {
    const r = await api('DELETE', `/v1/files/${encodeURIComponent(String(id))}`);
    return r.ok ? { ok: true } : { ok: false, error: describeError(r.error, r.status) };
  }

  function cancelLogin() {
    if (login) login.cancelled = true;
    login = null;
    return { ok: true };
  }

  async function logout() {
    const token = deps.readToken();
    if (token) await request('POST', '/v1/auth/logout', { token }); // best effort revoke
    deps.saveToken('');
    cache = null;
    return { ok: true };
  }

  return { status, startLogin, cancelLogin, loginWithPassword, signup, resetPassword, billing, logout, serverInfo, api, aiEndpoint, uploadFile, listFiles, deleteFile };
}

module.exports = { createCloudAccount, effectiveServerUrl, normalizeBaseUrl, describeError, BUILTIN_SERVER_URL };
