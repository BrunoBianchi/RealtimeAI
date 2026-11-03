'use strict';
// Local mode ([servidor] modo = local): no account and no server, the user's
// own keys, the PRO features shown as ads and the answer delay disclosed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function loadMain() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rtai-local-'));
  process.env.LOCALAPPDATA = tmp;
  process.env.RTAI_TEST_EXPORTS = '1';
  // Keys come only from the test's config.ini, never from the machine.
  for (const k of ['DEEPGRAM_API_KEY', 'OPENROUTER_API_KEY', 'CEREBRAS_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'RTAI_SERVER_TOKEN']) delete process.env[k];
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
  fs.writeFileSync(cfgPath, ['[servidor]', 'modo = local', 'url = https://api.test.local', ''].join('\r\n'));
  return main;
}

test('main process: local mode unlocks the app without an account, but needs the user\'s keys', async () => {
  const main = loadMain();
  let cfg = main.readConfigIni();
  assert.strictEqual(main.isSignedIn(cfg), false);
  assert.strictEqual(main.isLocalMode(cfg), true);
  assert.strictEqual(main.canUseApp(cfg), true);
  assert.strictEqual(main.cloudBackendActive(cfg), false, 'never the server credentials');

  let res = await main.checkCanStartLive();
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.needsKeys, true);
  assert.match(res.error, /Deepgram/);

  main.writeConfigIni({ deepgram_key: 'dg-test-key' });
  res = await main.checkCanStartLive();
  assert.strictEqual(res.needsKeys, true);
  assert.match(res.error, /AI key/);

  cfg = main.writeConfigIni({ llm_key: 'sk-or-test' });
  res = await main.checkCanStartLive();
  assert.deepStrictEqual(res, { ok: true }, 'no server call, no plan check');

  // Back to auto without a token: locked again.
  cfg = main.writeConfigIni({ server_mode: 'auto' });
  assert.strictEqual(main.canUseApp(cfg), false);
  assert.strictEqual((await main.checkCanStartLive()).needsLogin, true);
});

test('renderer: "Continue locally" on the sign-in screen, then PRO ads everywhere', async () => {
  const { loadRenderer, render, tags, settle } = require('./helpers/renderer');
  const base = { server_url: '', server_url_effective: 'https://api.test.local', server_region: 'auto', has_server_token: false };

  // Signed out: the login screen offers local mode and says what it costs.
  let r = loadRenderer({ state: { auth: { signedIn: false, available: true }, config: { ...base, server_mode: 'auto' } } });
  await r.boot();
  await settle();
  assert.strictEqual(r.Cue.isLocked(), true);
  const login = r.page('view').innerHTML;
  assert.strictEqual(tags(login, { 'data-action': 'auth-local' }).length, 1, 'Continue locally');
  assert.ok(login.includes(`${r.Cue.LOCAL_ANSWER_DELAY_MS} ms later than with PRO`), 'the delay is disclosed');

  // Local mode: unlocked, no plan, own keys required, ads on every relevant screen.
  r = loadRenderer({ state: { auth: { signedIn: false }, config: { ...base, server_mode: 'local' } } });
  assert.strictEqual(r.Cue.isLocked(), false);
  assert.strictEqual(r.Cue.localMode(), true);
  assert.strictEqual(r.Cue.cloudActive(), false);
  assert.strictEqual(r.Cue.engineReady().ok, false, 'keys are needed');

  for (const route of ['home', 'settings/account', 'settings/ai', 'settings/calendar', 'settings/plan']) {
    const html = render(r.Cue, route);
    assert.ok(tags(html, { 'data-action': 'go-pro' }).length >= 1, `PRO ad on ${route}`);
  }
  const ads = render(r.Cue, 'home');
  for (const perk of ['Cloud backup', 'Sync across devices', 'Google Calendar', 'Faster answers']) {
    assert.ok(ads.includes(perk), perk);
  }
  const calendar = render(r.Cue, 'settings/calendar');
  assert.strictEqual(tags(calendar, { 'data-action': 'gcal-connect' }).length, 0, 'Google Calendar is PRO');
  assert.ok(render(r.Cue, 'settings/ai').includes(`${r.Cue.LOCAL_ANSWER_DELAY_MS} ms before each answer`));

  // Signed in: no ads.
  r = loadRenderer({ state: { config: { ...base, server_mode: 'auto', has_server_token: true } } });
  assert.strictEqual(r.Cue.localMode(), false);
  for (const route of ['home', 'settings/account', 'settings/ai', 'settings/plan']) {
    assert.strictEqual(tags(render(r.Cue, route), { 'data-action': 'go-pro' }).length, 0, `no ad on ${route} when signed in`);
  }
});
