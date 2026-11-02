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
  assert.match(events.find((e) => e.type === 'error').error, /negado/);
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

test('Conta e servidor: login offered when signed out; own keys not required when signed in', () => {
  const { loadRenderer, render, tags } = require('./helpers/renderer');
  const base = { server_mode: 'auto', server_url: '', server_url_effective: 'https://api.test.local', server_region: 'auto' };

  let r = loadRenderer({ state: { config: { ...base, has_server_token: false } } });
  let html = render(r.Cue, 'settings/account');
  assert.strictEqual(tags(html, { 'data-action': 'cloud-login' }).length, 1, 'Entrar button');
  assert.strictEqual(tags(html, { 'data-action': 'cloud-mode' }).length, 3, 'auto / nuvem / proprio');
  assert.strictEqual(r.Cue.engineReady().ok, false, 'no keys and no account');

  r = loadRenderer({ state: { config: { ...base, has_server_token: true } } });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.Cue.engineReady())), { stt: true, llm: true, ok: true, cloud: true });

  r = loadRenderer({ state: { config: { ...base, has_server_token: true, server_mode: 'proprio' } } });
  assert.strictEqual(r.Cue.engineReady().cloud, false, 'proprio never uses the cloud');

  r = loadRenderer({ state: { config: { ...base, server_url_effective: '', has_server_token: false } } });
  html = render(r.Cue, 'settings/account');
  assert.strictEqual(tags(html, { 'data-action': 'cloud-login' }).length, 0, 'no server: no sign-in');
});
