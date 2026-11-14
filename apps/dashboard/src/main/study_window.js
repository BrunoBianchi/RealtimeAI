const { BrowserWindow, ipcMain, protocol } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const origin = 'lipcue-study://app';
const files = new Map([
  ['/index.html', 'text/html; charset=utf-8'],
  ['/study.js', 'text/javascript; charset=utf-8'],
  ['/study.css', 'text/css; charset=utf-8'],
  ['/pcm-worklet.js', 'text/javascript; charset=utf-8'],
]);
const operation = /^\/v1\/mock\/(?:start|mock_[\w-]+\/(?:chat|tts|stt|end))$/;

protocol?.registerSchemesAsPrivileged([{
  scheme: 'lipcue-study', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}]);

function createStudyWindow({ rendererDir, preloadDir, getParent, getAccount, getEndpoint, getHistory, getLocale, navigate }) {
  let win;
  const requests = new Set();
  const chatRequests = new Map();
  const trusted = (ev) => win && !win.isDestroyed() && ev.sender === win.webContents && ev.senderFrame?.url === `${origin}/index.html`;

  protocol.handle('lipcue-study', async (request) => {
    const url = new URL(request.url);
    const type = files.get(url.pathname);
    if (url.host !== 'app' || !type) return new Response(null, { status: 404 });
    try {
      const body = await fs.readFile(path.join(rendererDir, 'study', path.basename(url.pathname)));
      return new Response(body, { headers: { 'Content-Type': type } });
    } catch {
      return new Response(null, { status: 404 });
    }
  });

  ipcMain.handle('rtai:study-bootstrap', async (ev) => {
    if (!trusted(ev)) throw new Error('Invalid study window.');
    const account = await getAccount();
    const history = account ? await getHistory() : { mocks: [], live: [] };
    return { account, ...history, lang: getLocale() };
  });
  ipcMain.on('rtai:study-navigate', (ev, target) => {
    if (!trusted(ev) || !['train', 'live', 'plan'].includes(target)) return;
    win.close();
    navigate(target);
  });
  ipcMain.on('rtai:study-cancel', (ev, key) => { if (trusted(ev)) chatRequests.get(key)?.abort(); });
  ipcMain.handle('rtai:study-request', async (ev, method, route, body, key) => {
    if (!trusted(ev) || method !== 'POST' || typeof route !== 'string' || !operation.test(route) ||
        typeof body !== 'string' || Buffer.byteLength(body) > 64 * 1024 ||
        (route.endsWith('/chat') && (typeof key !== 'string' || !/^[\w-]{36}$/.test(key) || chatRequests.has(key)))) {
      return { status: 400, code: 'invalid_request' };
    }
    const endpoint = getEndpoint();
    if (!endpoint) return { status: 401, code: 'invalid_token', body: '{"error":"invalid_token"}' };
    const ctrl = new AbortController();
    requests.add(ctrl);
    if (key) chatRequests.set(key, ctrl);
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const res = await fetch(new URL(route, endpoint.url), {
        method, headers: { ...endpoint.headers, 'Content-Type': 'application/json' }, body, signal: ctrl.signal,
      });
      if (res.ok && route.endsWith('/chat')) {
        const decoder = new TextDecoder();
        for await (const chunk of res.body) {
          if (!ev.sender.isDestroyed()) ev.sender.send('rtai:study-chunk', key, decoder.decode(chunk, { stream: true }));
        }
        const tail = decoder.decode();
        if (tail && !ev.sender.isDestroyed()) ev.sender.send('rtai:study-chunk', key, tail);
        return { status: res.status };
      }
      if (res.ok && route.endsWith('/tts')) return { status: res.status, audio: new Uint8Array(await res.arrayBuffer()) };
      const text = await res.text();
      let code;
      try {
        const error = JSON.parse(text)?.error;
        code = typeof error === 'string' ? error : error?.code;
      } catch { /* response may have no JSON body */ }
      if (res.ok && route.endsWith('/end')) {
        getAccount(true).then((data) => {
          if (!ev.sender.isDestroyed()) ev.sender.send('rtai:study-account', data);
        }).catch(() => {});
      }
      return { status: res.status, body: text, code };
    } catch {
      return { status: 503, code: 'network', body: '{"error":"network"}' };
    } finally {
      clearTimeout(timer);
      requests.delete(ctrl);
      if (key && chatRequests.get(key) === ctrl) chatRequests.delete(key);
    }
  });

  return {
    open() {
      if (win && !win.isDestroyed()) return win.focus();
      win = new BrowserWindow({
        parent: getParent(), title: getLocale() === 'pt-BR' ? 'LipCue · Estudar' : 'LipCue · Study',
        width: 1380, height: 900, minWidth: 750, minHeight: 620, backgroundColor: '#0a0b0c',
        webPreferences: { preload: path.join(preloadDir, 'study.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      win.setMenuBarVisibility(false);
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (event) => event.preventDefault());
      win.on('closed', () => {
        for (const ctrl of requests) ctrl.abort();
        requests.clear();
        chatRequests.clear();
        win = null;
      });
      win.loadURL(`${origin}/index.html`);
    },
    close() { win?.close(); },
  };
}

module.exports = { createStudyWindow };
