const { ipcMain } = require('electron');

// Study (specs/006) runs inside the main window (renderer/study, drawn in a
// shadow root by the site's embedded bundle). Its requests reach the server
// only through these handlers, and only from the main window's own page.
const operation = /^\/v1\/mock\/(?:start|mock_[\w-]+\/(?:chat|tts|stt|end))$/;

function isDashboardPage(url) {
  return typeof url === 'string' && url.startsWith('file://') && /\/renderer\/index\.html(?:[?#].*)?$/.test(url);
}

function createStudyBridge({ getWindow, getAccount, getEndpoint, getHistory, getLocale }) {
  const requests = new Set();
  const chatRequests = new Map();
  const trusted = (ev) => {
    const win = getWindow();
    return Boolean(win && !win.isDestroyed() && ev.sender === win.webContents && isDashboardPage(ev.senderFrame?.url));
  };

  ipcMain.handle('rtai:study-bootstrap', async (ev) => {
    if (!trusted(ev)) throw new Error('Invalid study page.');
    const account = await getAccount();
    const history = account ? await getHistory() : { mocks: [], live: [] };
    return { account, ...history, lang: getLocale() };
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
    // Sign-out: whatever is in flight stops.
    abortAll() {
      for (const ctrl of requests) ctrl.abort();
      requests.clear();
      chatRequests.clear();
    },
  };
}

module.exports = { createStudyBridge, isDashboardPage };
