const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const Module = require('node:module');

function loadBridge() {
  const handlers = new Map();
  const listeners = new Map();
  const stub = { ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => listeners.set(name, fn) } };
  const load = Module._load;
  Module._load = function (id, ...args) { return id === 'electron' ? stub : load.call(this, id, ...args); };
  try {
    delete require.cache[require.resolve('../src/main/study_bridge')];
    return { ...require('../src/main/study_bridge'), handlers, listeners };
  } finally { Module._load = load; }
}

test('Study runs inside the main window and only that page can reach the server', async (t) => {
  const { createStudyBridge, handlers } = loadBridge();
  const sent = [];
  const webContents = { send: (...args) => sent.push(args), isDestroyed: () => false };
  const win = { webContents, isDestroyed: () => false };
  createStudyBridge({
    getWindow: () => win,
    getAccount: () => ({ email: 'test@example.com' }), getEndpoint: () => ({ url: 'https://study.test', headers: {} }),
    getHistory: () => ({ mocks: [], live: [] }), getLocale: () => 'pt-BR',
  });
  const page = 'file:///C:/app/src/renderer/index.html#/study';
  const event = { sender: webContents, senderFrame: { url: page } };
  const request = handlers.get('rtai:study-request');

  assert.equal((await handlers.get('rtai:study-bootstrap')(event)).lang, 'pt-BR');
  await assert.rejects(handlers.get('rtai:study-bootstrap')({ sender: {}, senderFrame: { url: page } }));
  assert.equal((await request({ ...event, sender: {} }, 'POST', '/v1/mock/start', '{}')).status, 400);
  assert.equal((await request({ sender: webContents, senderFrame: { url: 'https://evil.test/index.html' } }, 'POST', '/v1/mock/start', '{}')).status, 400);
  assert.equal((await request(event, 'POST', '/v1/me', '{}')).status, 400);

  t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url.href, 'https://study.test/v1/mock/mock_valid/chat');
    assert.equal(options.body, '{}');
    return new Response('data: example\n\n');
  });
  const key = '12345678-1234-1234-1234-123456789abc';
  assert.equal((await request(event, 'POST', '/v1/mock/mock_valid/chat', '{}', key)).status, 200);
  assert.deepEqual(sent, [['rtai:study-chunk', key, 'data: example\n\n']]);
});

test('Study no longer opens a window of its own', () => {
  const root = path.join(__dirname, '..', 'src');
  const main = fs.readFileSync(path.join(root, 'main', 'main.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  assert.doesNotMatch(main, /study_window|lipcue-study|rtai:study-open/);
  assert.match(html, /id="studyHost"/);
  assert.match(app, /LipCue|LipcueStudy/);
  assert.match(app, /setHidden\(true\)/);
  assert.equal(fs.existsSync(path.join(root, 'preload', 'study.js')), false);
});
