// RealTimeAI cloud account (dashboard side). Signs the user in with the
// OAuth 2.0 device authorization grant (RFC 8628): the dashboard shows a short
// code, opens the browser on the server's page and polls until the user
// approves. The resulting device token goes to config.ini [servidor] token,
// where the engine (rtai_app) encrypts it with DPAPI and exchanges it for
// short-lived STT/LLM credentials at each session (POST /v1/session).
//
// Nothing here runs during a live session: the hot path (audio -> STT -> LLM)
// never waits on this module. Contract: docs/server-api.md.
'use strict';

// Official builds set this (keep it in sync with CMake -DRTAI_SERVER_URL).
// Empty = open-source build: sign-in is offered only when [servidor] url is set.
const BUILTIN_SERVER_URL = '';

const STATUS_TTL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

function normalizeBaseUrl(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+/i.test(u) ? u : '';
}

function effectiveServerUrl(configured) {
  return normalizeBaseUrl(configured) || normalizeBaseUrl(process.env.RTAI_SERVER_URL) || normalizeBaseUrl(BUILTIN_SERVER_URL);
}

// pt-BR text for the device-flow errors of RFC 8628 §3.5 and HTTP failures.
function describeError(code, status) {
  switch (code) {
    case 'access_denied': return 'Acesso negado no navegador.';
    case 'expired_token': return 'O código expirou. Tente entrar de novo.';
    case 'invalid_token': return 'Sessão expirada: entre de novo na sua conta.';
    case 'network': return 'Sem conexão com o servidor RealTimeAI.';
    case 'no_server': return 'Nenhum servidor configurado.';
    default:
      if (status === 401) return 'Sessão expirada: entre de novo na sua conta.';
      if (status === 426) return 'Versão do app muito antiga: atualize.';
      if (status >= 500) return 'Servidor indisponível no momento.';
      return 'Não foi possível falar com o servidor.';
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

  async function request(method, path, { body, token } = {}) {
    const base = effectiveServerUrl(deps.getServerUrl());
    if (!base) return { ok: false, status: 0, error: 'no_server', data: null };
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS) : null;
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
      const value = { ...info, signedIn: true, account: null, detail: 'Conta conectada.' };
      cache = { at: Date.now(), value };
      return value;
    }
    const r = await request('GET', '/v1/me', { token });
    let value;
    if (r.ok && r.data) {
      value = { ...info, signedIn: true, account: r.data };
    } else if (r.status === 401) {
      value = { ...info, signedIn: false, expired: true, detail: describeError('invalid_token', 401) };
    } else {
      // Offline or server hiccup: keep the sign-in, just without fresh data.
      value = { ...info, signedIn: true, account: null, detail: describeError(r.error, r.status) };
    }
    cache = { at: Date.now(), value };
    return value;
  }

  async function startLogin() {
    if (!serverInfo().available) return { ok: false, error: describeError('no_server') };
    if (login) login.cancelled = true;
    const mine = { cancelled: false };
    login = mine;
    const start = await request('POST', '/v1/auth/device', { body: { client_id: 'rtai-dashboard', app_version: deps.appVersion || '' } });
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

  return { status, startLogin, cancelLogin, logout, serverInfo };
}

module.exports = { createCloudAccount, effectiveServerUrl, normalizeBaseUrl, describeError, BUILTIN_SERVER_URL };
