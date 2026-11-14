const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');

test('the Study window streams tutor output and rejects requests from other windows', async (t) => {
  const handlers = new Map();
  let window;
  class Window {
    constructor(options) {
      this.options = options;
      this.webContents = { setWindowOpenHandler() {}, on() {}, send: (...args) => this.chunks.push(args), isDestroyed: () => false };
      this.chunks = [];
      window = this;
    }
    isDestroyed() { return false; }
    setMenuBarVisibility() {}
    on() {}
    loadURL(url) { this.url = url; }
  }
  const stub = {
    BrowserWindow: Window,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  };
  const load = Module._load;
  Module._load = function (id, ...args) { return id === 'electron' ? stub : load.call(this, id, ...args); };
  let createStudyWindow;
  try { ({ createStudyWindow } = require('../src/main/study_window')); }
  finally { Module._load = load; }
  const study = createStudyWindow({
    rendererDir: '.', preloadDir: '.', getParent: () => null,
    getAccount: () => ({ email: 'test@example.com' }), getEndpoint: () => ({ url: 'https://study.test', headers: {} }),
    getHistory: () => ({ mocks: [], live: [] }), getLocale: () => 'en',
  });
  study.open();
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.url, 'lipcue-study://app/index.html');
  const event = { sender: window.webContents, senderFrame: { url: window.url } };
  const request = handlers.get('rtai:study-request');
  assert.equal((await request({ ...event, sender: {} }, 'POST', '/v1/mock/start', '{}')).status, 400);
  assert.equal((await request(event, 'POST', '/v1/me', '{}')).status, 400);
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url.href, 'https://study.test/v1/mock/mock_valid/chat');
    assert.equal(options.body, '{}');
    return new Response('data: example\n\n');
  });
  const key = '12345678-1234-1234-1234-123456789abc';
  assert.equal((await request(event, 'POST', '/v1/mock/mock_valid/chat', '{}', key)).status, 200);
  assert.deepEqual(window.chunks, [['rtai:study-chunk', key, 'data: example\n\n']]);
});
