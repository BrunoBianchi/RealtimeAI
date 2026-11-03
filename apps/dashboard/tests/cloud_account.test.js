// RealTimeAI cloud account: device sign-in (RFC 8628), account status and
// the [servidor] section of config.ini shared with the engine.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { createCloudAccount, effectiveServerUrl } = require('../src/main/cloud_account');

function fakeServer(script) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization || '' });
    const step = script(url, init, calls.length);
    return { ok: step.status >= 200 && step.status < 300, status: step.status, json: async () => step.body };
  };
  return { calls, fetchImpl };
}

function account(server, extra = {}) {
  const events = [];
  const store = { token: extra.token || '' };
  const acc = createCloudAccount({
    getServerUrl: () => 'https://api.test.local/',
    hasToken: () => Boolean(store.token),
    readToken: () => store.token,
    saveToken: (t) => { store.token = t; },
    openBrowser: (u) => events.push({ type: 'browser', url: u }),
    emit: (e) => events.push(e),
    appVersion: '9.9.9',
    fetchImpl: server.fetchImpl,
    sleep: async () => {}
  });
  return { acc, events, store };
}

const waitFor = async (pred) => {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(pred(), 'condition not reached');
};

test('device sign-in: shows the code, honours slow_down and stores the token', async () => {
  let polls = 0;
  const server = fakeServer((url) => {
    if (url.endsWith('/v1/auth/device')) {
      return { status: 200, body: { device_code: 'dc', user_code: 'ABCD-EFGH', verification_uri: 'https://rt.test/ativar', verification_uri_complete: 'https://rt.test/ativar?c=ABCD-EFGH', interval: 1, expires_in: 600 } };
    }
    polls += 1;
    if (polls === 1) return { status: 400, body: { error: 'authorization_pending' } };
    if (polls === 2) return { status: 400, body: { error: 'slow_down' } };
    return { status: 200, body: { access_token: 'device-token', account: { email: 'a@b.c' } } };
  });
  const { acc, events, store } = account(server);
  const res = await acc.startLogin();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.userCode, 'ABCD-EFGH');
  assert.deepStrictEqual(events[0], { type: 'browser', url: 'https://rt.test/ativar?c=ABCD-EFGH' });
  await waitFor(() => events.some((e) => e.type === 'signed_in'));
  assert.strictEqual(store.token, 'device-token');
  assert.strictEqual(server.calls[0].url, 'https://api.test.local/v1/auth/device');
  assert.strictEqual(server.calls[1].body.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
});

test('device sign-in: a denial ends the flow with a pt-BR message', async () => {
  const server = fakeServer((url) => url.endsWith('/v1/auth/device')
    ? { status: 200, body: { device_code: 'dc', user_code: 'X', verification_uri: 'https://rt.test/a', interval: 1 } }
    : { status: 400, body: { error: 'access_denied' } });
  const { acc, events, store } = account(server);
  await acc.startLogin();
  await waitFor(() => events.some((e) => e.type === 'error'));
  assert.match(events.find((e) => e.type === 'error').error, /denied/);
  assert.strictEqual(store.token, '');
});

test('status: 401 means the sign-in expired; offline keeps the sign-in', async () => {
  let mode = 401;
  const server = fakeServer(() => (mode === 401 ? { status: 401, body: { error: 'invalid_token' } } : { status: 503, body: null }));
  const { acc } = account(server, { token: 'tok' });
  const expired = await acc.status(true);
  assert.strictEqual(expired.signedIn, false);
  assert.strictEqual(expired.expired, true);
  assert.strictEqual(server.calls[0].auth, 'Bearer tok');
  mode = 503;
  const offline = await acc.status(true);
  assert.strictEqual(offline.signedIn, true);
});

test('logout revokes on the server and clears the token', async () => {
  const server = fakeServer(() => ({ status: 204, body: null }));
  const { acc, store } = account(server, { token: 'tok' });
  await acc.logout();
  assert.strictEqual(server.calls[0].url, 'https://api.test.local/v1/auth/logout');
  assert.strictEqual(store.token, '');
});

test('no server configured: sign-in is not offered', async () => {
  const saved = process.env.RTAI_SERVER_URL;
  delete process.env.RTAI_SERVER_URL;
  assert.strictEqual(effectiveServerUrl(''), '');
  assert.strictEqual(effectiveServerUrl('ftp://x'), '');
  assert.strictEqual(effectiveServerUrl('https://api.x.com/'), 'https://api.x.com');
  if (saved !== undefined) process.env.RTAI_SERVER_URL = saved;
});

test('config.ini [servidor] round-trips and decides the backend', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rtai-cloud-'));
  process.env.LOCALAPPDATA = tmp;
  process.env.RTAI_TEST_EXPORTS = '1';
  const fakeElectron = {
    app: { whenReady: () => new Promise(() => {}), on: () => {}, quit: () => {} },
    BrowserWindow: function () {},
    ipcMain: { handle: () => {}, on: () => {} },
    dialog: {},
    shell: {},
    nativeTheme: { shouldUseDarkColors: true },
    Notification: { isSupported: () => false }
  };
  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return fakeElectron;
    return realLoad.call(this, request, ...rest);
  };
  const main = require('../src/main/main.js');
  Module._load = realLoad;

  const cfgPath = path.join(tmp, 'RealTimeAI', 'config.ini');
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, ['[servidor]', 'modo = auto', 'url = https://api.test.local', 'token = dpapi:SEALED', ''].join('\r\n'));

  let cfg = main.readConfigIni();
  assert.strictEqual(cfg.has_server_token, true);
  assert.strictEqual(cfg.server_url_effective, 'https://api.test.local');
  assert.strictEqual(main.cloudBackendActive(cfg), true);
  assert.ok(!JSON.stringify({ ...cfg, rawIni: null }).includes('SEALED'), 'token never reaches the renderer');

  // Saving an unrelated setting, or the masked placeholder, keeps the sealed token.
  cfg = main.writeConfigIni({ language: 'multi', server_token: cfg.server_token_display || '••••••••' });
  assert.match(fs.readFileSync(cfgPath, 'utf8'), /token = dpapi:SEALED/);

  cfg = main.writeConfigIni({ server_mode: 'proprio' });
  assert.strictEqual(main.cloudBackendActive(cfg), false);

  cfg = main.writeConfigIni({ server_mode: 'auto', server_token: '__CLEAR__' });
  assert.strictEqual(cfg.has_server_token, false);
  assert.strictEqual(main.cloudBackendActive(cfg), false);
});

test('Conta e servidor: signed out only the login screen exists; signed in no keys are needed', async () => {
  const { loadRenderer, render, tags, settle } = require('./helpers/renderer');
  const base = { server_mode: 'auto', server_url: '', server_url_effective: 'https://api.test.local', server_region: 'auto' };

  // Signed out: the login view replaces every route and the shell is hidden.
  let r = loadRenderer({ state: { auth: { signedIn: false, available: true }, config: { ...base, has_server_token: false } } });
  await r.boot();
  await settle();
  assert.strictEqual(r.Cue.isLocked(), true);
  const view = r.page('view').innerHTML;
  for (const a of ['auth-google', 'auth-password']) assert.strictEqual(tags(view, { 'data-action': a }).length, 1, a);
  assert.ok(tags(view, { 'data-action': 'auth-mode', 'data-mode': 'sso' }).length === 1, 'SSO');
  assert.ok(tags(view, { 'data-action': 'auth-mode', 'data-mode': 'signup' }).length === 1, 'criar conta');
  assert.strictEqual(r.page('sidebar').hidden, true, 'no sidebar while signed out');
  // Any other action is ignored while locked.
  r.location.hash = '#/settings/ai';
  await settle();
  assert.ok(r.page('view').innerHTML.includes('data-action="auth-google"'), 'settings stay locked');

  // Signed in: settings render, the account card offers Sair, own keys not needed.
  r = loadRenderer({ state: { config: { ...base, has_server_token: true } } });
  const html = render(r.Cue, 'settings/account');
  assert.strictEqual(tags(html, { 'data-action': 'cloud-logout' }).length, 1, 'Sair');
  assert.strictEqual(tags(html, { 'data-action': 'cloud-mode' }).length, 2, 'servidores / minhas chaves');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.Cue.engineReady())), { stt: true, llm: true, ok: true, cloud: true });

  r = loadRenderer({ state: { config: { ...base, has_server_token: true, server_mode: 'proprio' } } });
  assert.strictEqual(r.Cue.engineReady().cloud, false, 'proprio never uses the cloud');

  // No server configured: the login screen asks for its address.
  r = loadRenderer({ state: { auth: { signedIn: false }, config: { ...base, server_url_effective: '', has_server_token: false } } });
  assert.strictEqual(tags(render(r.Cue, 'login'), { 'data-change': 'auth-server' }).length, 1);
});

test('Google and SSO go through the browser with a provider hint; SSO needs the company', async () => {
  const server = fakeServer(() => ({ status: 200, body: { device_code: 'dc', user_code: 'C', verification_uri: 'https://rt.test/a', interval: 1, expires_in: 1 } }));
  const { acc } = account(server);
  assert.strictEqual((await acc.startLogin({ provider: 'sso', hint: '' })).ok, false, 'SSO without e-mail/domain');
  assert.strictEqual(server.calls.length, 0);
  await acc.startLogin({ provider: 'sso', hint: 'ana@empresa.com' });
  assert.deepStrictEqual([server.calls[0].body.provider, server.calls[0].body.login_hint], ['sso', 'ana@empresa.com']);
  acc.cancelLogin();
  await acc.startLogin({ provider: 'google' });
  const google = server.calls.filter((c) => c.url.endsWith('/v1/auth/device')).pop();
  assert.strictEqual(google.body.provider, 'google');
  assert.ok(!('login_hint' in google.body));
  acc.cancelLogin();
});

test('e-mail + password: sign in, wrong password, sign-up and verification', async () => {
  const server = fakeServer((url, init) => {
    const b = JSON.parse(init.body);
    if (url.endsWith('/v1/auth/login')) {
      return b.password === 'certa123'
        ? { status: 200, body: { access_token: 'pw-token', account: { email: b.email } } }
        : { status: 401, body: { error: 'invalid_credentials' } };
    }
    if (url.endsWith('/v1/auth/signup')) {
      return b.email === 'nova@x.com' ? { status: 201, body: { verification_required: true } } : { status: 409, body: { error: 'email_taken' } };
    }
    return { status: 204, body: null };
  });
  const { acc, events, store } = account(server);

  assert.match((await acc.loginWithPassword('não-é-email', 'x')).error, /Invalid e-mail/);
  assert.match((await acc.loginWithPassword('ana@x.com', 'errada')).error, /Wrong e-mail or password/);
  assert.strictEqual(store.token, '');
  const ok = await acc.loginWithPassword('ana@x.com', 'certa123');
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(store.token, 'pw-token');
  assert.ok(events.some((e) => e.type === 'signed_in'));

  assert.match((await acc.signup('Ana', 'ana@x.com', '123')).error, /8 characters/);
  assert.match((await acc.signup('Ana', 'ana@x.com', 'segura123')).error, /already exists/);
  const pending = await acc.signup('Nova', 'nova@x.com', 'segura123');
  assert.strictEqual(pending.pendingVerification, true);

  assert.strictEqual((await acc.resetPassword('ana@x.com')).ok, true);
  assert.strictEqual(server.calls.pop().url, 'https://api.test.local/v1/auth/password/reset');
});

test('billing opens the hosted checkout or portal (https only)', async () => {
  const server = fakeServer((url) => ({ status: 200, body: { url: url.endsWith('/checkout') ? 'https://pay.test/c' : 'javascript:alert(1)' } }));
  const { acc, events } = account(server, { token: 'tok' });
  assert.strictEqual((await acc.billing('checkout')).ok, true);
  assert.deepStrictEqual(server.calls[0].body, { plan: 'pro' });
  assert.strictEqual(server.calls[0].auth, 'Bearer tok');
  assert.deepStrictEqual(events.pop(), { type: 'browser', url: 'https://pay.test/c' });
  assert.strictEqual((await acc.billing('portal')).ok, false, 'never opens a non-https url');
});

test('billing accepts plain http only from a local server', async () => {
  for (const [url, ok] of [['http://localhost:8787/billing/checkout?s=1', true], ['http://127.0.0.1:8787/b', true], ['http://pay.test/c', false], ['http://localhost.evil.com/x', false]]) {
    const server = fakeServer(() => ({ status: 200, body: { url } }));
    const { acc } = account(server, { token: 'tok' });
    assert.strictEqual((await acc.billing('checkout')).ok, ok, url);
  }
});

test('plans: Free is one session of up to 15 minutes, once; PRO is 200 minutes a month', () => {
  const { entitlement } = require('../src/main/plans');
  const fresh = entitlement({ plan: { id: 'free' } });
  assert.deepStrictEqual([fresh.canStart, fresh.limitMinutes, fresh.maxSessionMinutes, fresh.maxSessions], [true, 15, 15, 1]);
  const used = entitlement({ plan: { id: 'free', minutes_used: 3, sessions_used: 1 } });
  assert.strictEqual(used.canStart, false, 'the free session is single, even if it was short');
  assert.match(used.reason, /Upgrade to PRO/);
  assert.strictEqual(entitlement(null).planId, 'free', 'unknown plan is Free');

  const pro = entitlement({ plan: { id: 'pro', minutes_used: 150, sessions_used: 40 } });
  assert.deepStrictEqual([pro.canStart, pro.limitMinutes, pro.leftMinutes, pro.maxSessionMinutes], [true, 200, 50, 50]);
  const out = entitlement({ plan: { id: 'pro', minutes_used: 200, period_end: '2026-12-01' } });
  assert.strictEqual(out.canStart, false);
  assert.match(out.reason, /200 PRO minutes/);
});

test('main process: nothing starts the copilot while signed out (demo included)', async () => {
  const main = require('../src/main/main.js'); // loaded by the [servidor] test above
  main.writeConfigIni({ server_mode: 'auto', server_token: '__CLEAR__' });
  assert.strictEqual(main.isSignedIn(), false);
  for (const res of [await main.checkCanStartLive(), main.launchOverlay({ demo: true })]) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.needsLogin, true);
  }
});
