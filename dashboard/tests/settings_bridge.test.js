// One settings screen: the overlay HUD's Config button opens the dashboard's
// Settings page, and saving there never wipes keys the dashboard does not
// manage ([turn], [calendario], dicas_idioma, the session folder...).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rtai-cfg-'));
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
const main = require('../main.js');
Module._load = realLoad;

const cfgPath = path.join(tmp, 'RealTimeAI', 'config.ini');

test('saving from the dashboard keeps keys it does not manage', () => {
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, [
    '[deepgram]', 'api_key = dpapi:AAAA', 'idioma = multi', 'dicas_idioma = pt,en', '',
    '[llm]', 'api_key = dpapi:BBBB', 'modelo = qwen/qwen3.6-flash', '',
    '[audio]', 'silero_modelo = C:\\models\\silero.onnx', '',
    '[sessao]', 'salvar = sim', 'pasta = D:\\Sessoes', 'arquivo_contexto = C:\\notas.md', '',
    '[turn]', 'boundary_grace_ms = 500', '',
    '[calendario]', 'url_ics = https://example.com/a.ics', ''
  ].join('\r\n'));

  main.writeConfigIni({ language: 'pt-BR' });
  const ini = main.readConfigIni().rawIni;
  assert.strictEqual(ini.deepgram.idioma, 'pt-BR');
  assert.strictEqual(ini.deepgram.api_key, 'dpapi:AAAA', 'encrypted key kept');
  assert.strictEqual(ini.deepgram.dicas_idioma, 'pt,en');
  assert.strictEqual(ini.audio.silero_modelo, 'C:\\models\\silero.onnx');
  assert.strictEqual(ini.sessao.pasta, 'D:\\Sessoes', 'session folder no longer wiped');
  assert.strictEqual(ini.sessao.arquivo_contexto, 'C:\\notas.md');
  assert.strictEqual(ini.turn.boundary_grace_ms, '500');
  assert.strictEqual(ini.calendario.url_ics, 'https://example.com/a.ics');

  // Saving twice is stable (no duplicated keys).
  main.writeConfigIni({});
  const text = fs.readFileSync(cfgPath, 'utf8');
  assert.strictEqual(text.match(/^dicas_idioma =/gm).length, 1);
  assert.strictEqual(text.match(/^\[turn\]/gm).length, 1);
});

test('the HUD Config button reaches the dashboard Settings page', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  assert.match(mainSrc, /msg\.type === 'open_settings'/);
  assert.match(mainSrc, /webContents\.send\('rtai:open-settings'/);
  assert.match(preload, /onOpenSettings/);
  assert.match(app, /onOpenSettings\(\(section\) => \{\s*switchView\('settings'\)/);
  const cpp = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'app', 'src', 'main.cpp'), 'utf8');
  assert.match(cpp, /encode_simple\("open_settings"/);
});
