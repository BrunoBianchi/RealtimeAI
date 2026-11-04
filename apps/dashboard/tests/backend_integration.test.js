// App <-> RealTimeAI server integration: the dashboard's server-side features
// (AI relay, research, community questions, Google Calendar broker) and the
// local backend wiring used when running from source. No network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createCloudAccount } = require('../src/main/cloud_account');
const localBackend = require('../src/main/local_backend');
const gc = require('../src/main/google_calendar');
const jevEngine = require('../src/main/jev_engine');
const pdfText = require('../src/main/pdf_text');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
// backend/ lives next to this repo, outside it: a clone without it skips the launcher tests.
const NO_BACKEND = !fs.existsSync(path.join(__dirname, '..', '..', '..', '..', 'backend', 'docker-compose.yml')) && '../backend/ is not next to this repo';

function account({ token = 'dev-tok', url = 'http://localhost:8787', reply = () => ({ status: 200, body: {} }) } = {}) {
  const calls = [];
  const acc = createCloudAccount({
    getServerUrl: () => url,
    hasToken: () => Boolean(token),
    readToken: () => token,
    saveToken: () => {},
    openBrowser: () => {},
    appVersion: '2.1.0',
    fetchImpl: async (u, init) => {
      calls.push({ url: u, method: init.method, auth: init.headers.Authorization || '', body: init.body ? JSON.parse(init.body) : null });
      const r = reply(u, init);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    }
  });
  return { acc, calls };
}

test('cloud account: authenticated api() calls and the AI endpoint for the dashboard', async () => {
  const { acc, calls } = account({ reply: () => ({ status: 200, body: { dossier: 'D' } }) });
  const r = await acc.api('POST', '/v1/research/company', { company: 'Acme' });
  assert.deepStrictEqual([r.ok, r.data.dossier], [true, 'D']);
  assert.deepStrictEqual(calls[0], { url: 'http://localhost:8787/v1/research/company', method: 'POST', auth: 'Bearer dev-tok', body: { company: 'Acme' } });
  assert.deepStrictEqual(acc.aiEndpoint(), {
    url: 'http://localhost:8787/v1/ai/chat/completions',
    headers: { Authorization: 'Bearer dev-tok', 'X-RTAI-Version': '2.1.0' }
  });

  const out = account({ token: '' });
  assert.strictEqual(out.acc.aiEndpoint(), null, 'signed out: no server AI');
  assert.strictEqual((await out.acc.api('GET', '/v1/questions')).status, 401);
  assert.strictEqual(out.calls.length, 0, 'nothing is sent without a token');
});

test('main process: AI, research, calendar and question sharing go to the server when signed in', () => {
  // One routing point for every dashboard AI call; own keys only in "My keys" mode.
  assert.match(MAIN, /function aiTarget\(/);
  assert.match(MAIN, /cfg\.server_mode === 'proprio' && direct\) return direct/);
  assert.match(MAIN, /isSignedIn\(cfg\) && cloudAccount\.aiEndpoint\(\)/);
  assert.ok(!/https\.request\(\s*'https:\/\/openrouter\.ai/.test(MAIN), 'no direct OpenRouter requests left in main.js');
  assert.match(MAIN, /ocrPdfWithOpenRouter\(buf, path\.basename\(filePath\), aiTarget\(\)/);
  assert.match(MAIN, /cloudAccount\.api\('POST', '\/v1\/research\/company'/);
  assert.match(MAIN, /cloudAccount\.api\('POST', '\/v1\/integrations\/google\/token'/);
  assert.match(MAIN, /cloudAccount\.api\('POST', '\/v1\/questions'/);
  assert.match(MAIN, /shareSessionQuestions\(jevExtraction\)/);
  assert.match(MAIN, /startLocalBackendForDev\(\);/);
});

test('local backend: dev default URL only from source, never over an explicit server', { skip: NO_BACKEND }, () => {
  const repoRoot = path.join(__dirname, '..', '..', '..');
  assert.strictEqual(localBackend.devServerUrl({ packaged: false, env: { RTAI_LOCAL_BACKEND: '1' }, repoRoot }), 'http://localhost:8787');
  assert.strictEqual(localBackend.devServerUrl({ packaged: true, env: { RTAI_LOCAL_BACKEND: '1' }, repoRoot }), '');
  assert.strictEqual(localBackend.devServerUrl({ packaged: false, env: { RTAI_SERVER_URL: 'https://api.x' }, repoRoot }), '');
  assert.strictEqual(localBackend.devServerUrl({ packaged: false, env: { RTAI_LOCAL_BACKEND: '1' }, repoRoot, configuredUrl: 'https://mine' }), '');
  assert.strictEqual(localBackend.devServerUrl({ packaged: false, env: { RTAI_LOCAL_BACKEND: '0' }, repoRoot }), '');
  assert.strictEqual(localBackend.devServerUrl({ packaged: false, env: { RTAI_LOCAL_BACKEND: '1' }, repoRoot: os.tmpdir() }), '', 'no backend folder');
  assert.ok(localBackend.isLoopbackUrl('http://127.0.0.1:8787'));
  assert.ok(!localBackend.isLoopbackUrl('https://localhost:8787'));
  assert.ok(!localBackend.isLoopbackUrl('http://localhost.evil.com'));
});

test('local backend: reuses a running server, otherwise starts the Go server with docker compose', { skip: NO_BACKEND }, async (t) => {
  const repoRoot = path.join(__dirname, '..', '..', '..');
  const quiet = { log() {}, warn() {} };
  const up = http.createServer((req, res) => res.end(req.url === '/health' ? '{"ok":true}' : ''));
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  t.after(() => up.close());
  const url = `http://127.0.0.1:${up.address().port}`;
  let spawned = 0;
  const running = await localBackend.ensureLocalBackend({ url, repoRoot, spawnImpl: () => { spawned += 1; } });
  assert.deepStrictEqual([running.started, running.ready, spawned], [false, true, 0]);
  running.stop(); // a server this app did not start is left alone
  assert.strictEqual(spawned, 0);

  // Nothing listening: `docker compose up -d --build` with the URL's port, then
  // `docker compose stop` on quit.
  const free = http.createServer();
  await new Promise((r) => free.listen(0, '127.0.0.1', r));
  const port = free.address().port;
  await new Promise((r) => free.close(r));
  const seen = [];
  let late = null;
  const fakeSpawn = (exe, args, opts) => {
    seen.push({ exe, args, env: opts.env, detached: Boolean(opts.detached) });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.unref = () => {};
    if (args.includes('up')) {
      late = http.createServer((req, res) => res.end('{}'));
      late.listen(port, '127.0.0.1', () => child.emit('exit', 0));
    }
    return child;
  };
  t.after(() => late && late.close());
  const started = await localBackend.ensureLocalBackend({ url: `http://127.0.0.1:${port}`, repoRoot, spawnImpl: fakeSpawn, log: quiet });
  assert.deepStrictEqual([started.started, started.ready], [true, true]);
  assert.strictEqual(seen[0].exe, 'docker');
  assert.deepStrictEqual(seen[0].args.slice(0, 2), ['compose', '-f']);
  assert.ok(seen[0].args[2].endsWith(path.join('backend', 'docker-compose.yml')));
  assert.deepStrictEqual(seen[0].args.slice(3), ['up', '-d', '--build']);
  assert.deepStrictEqual([seen[0].env.PORT, seen[0].env.PUBLIC_URL], [String(port), `http://127.0.0.1:${port}`]);
  started.stop();
  assert.deepStrictEqual([seen[1].args.at(-1), seen[1].detached], ['stop', true]);

  // Docker missing or failing: no crash, nothing ready.
  const failing = () => {
    const child = new EventEmitter();
    setImmediate(() => child.emit('error', new Error('spawn docker ENOENT')));
    return child;
  };
  const noDocker = await localBackend.ensureLocalBackend({ url: `http://127.0.0.1:${port + 1}`, repoRoot, spawnImpl: failing, log: quiet });
  assert.deepStrictEqual([noDocker.started, noDocker.ready], [false, false]);

  const remote = await localBackend.ensureLocalBackend({ url: 'https://api.example.com', repoRoot, spawnImpl: () => assert.fail('never for a remote server') });
  assert.strictEqual(remote.ready, false);
});

test('Google Calendar through the server: no client file, the server exchanges the code and refreshes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtai-gcal-broker-'));
  const exchanged = [];
  const broker = {
    client: () => ({ client_id: 'srv.apps.googleusercontent.com', type: 'installed' }),
    token: async (params) => {
      exchanged.push(params);
      return { ok: true, status: 200, data: { access_token: `at${exchanged.length}`, refresh_token: 'rt', expires_in: 3600 } };
    }
  };
  const apiCalls = [];
  const fetchImpl = async (url, init = {}) => {
    apiCalls.push({ url: String(url), auth: (init.headers || {}).Authorization });
    return { status: 200, ok: true, text: async () => JSON.stringify(String(url).includes('calendarList/primary') ? { id: 'me@gmail.com' } : { items: [] }) };
  };
  let authUrl = '';
  const g = gc.createGoogleCalendar({
    dataDir: dir,
    fetchImpl,
    broker,
    timeZone: 'America/Sao_Paulo',
    safeStorage: null,
    openExternal: async (u) => {
      authUrl = u;
      const q = new URL(u).searchParams;
      // The browser comes back to the loopback redirect with the code.
      http.get(`${q.get('redirect_uri')}?code=c-1&state=${q.get('state')}`, (res) => res.resume());
    }
  });
  const before = g.status();
  assert.deepStrictEqual([before.configured, before.brokered, before.clientSource], [true, true, 'Cue server']);
  const st = await g.connect();
  assert.strictEqual(new URL(authUrl).searchParams.get('client_id'), 'srv.apps.googleusercontent.com');
  assert.deepStrictEqual(Object.keys(exchanged[0]).sort(), ['code', 'code_verifier', 'grant_type', 'redirect_uri']);
  assert.strictEqual(exchanged[0].grant_type, 'authorization_code');
  assert.ok(!('client_secret' in exchanged[0]), 'the app never sends a client secret');
  assert.deepStrictEqual([st.connected, st.email], [true, 'me@gmail.com']);

  const tokFile = path.join(dir, gc.TOKEN_FILE);
  const tok = JSON.parse(fs.readFileSync(tokFile, 'utf8').replace(/^plain:/, ''));
  tok.expiry = 0; // force a refresh on the next call
  fs.writeFileSync(tokFile, `plain:${JSON.stringify(tok)}`);
  await g.listEvents({ days: 1 });
  assert.deepStrictEqual(exchanged.at(-1), { grant_type: 'refresh_token', refresh_token: 'rt' });
});

test('community questions merge into a company already in the local bank', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtai-bank-'));
  jevEngine.saveQuestionBank(dir, {
    version: 1, totalInterviews: 1, totalCompanies: 1, totalQuestions: 1,
    companies: [{ id: 'nubank', name: 'Nubank', domain: 'nubank.com.br', logo: 'x', interviewsReported: 1, questions: [
      { id: 'nubank-1', text: 'Tell me about a time you disagreed with your manager?', category: 'Behavioral', interviewsCount: 1 }
    ] }]
  });
  const r = jevEngine.mergeCommunityQuestions(dir, 'NUBANK', [
    { text: 'Tell me about a time you disagreed with your manager?', category: 'Behavioral', reports: 4 },
    { text: 'How do you prioritize when everything is urgent?', category: 'Behavioral', subCategory: '', reports: 2 },
    { text: '**markup** is never imported?', reports: 9 }
  ]);
  assert.strictEqual(r.added, 1);
  const bank = jevEngine.loadQuestionBank(dir);
  const qs = bank.companies[0].questions;
  assert.strictEqual(qs.find((q) => q.id === 'nubank-1').interviewsCount, 4, 'reports from others raise the count');
  const added = qs.find((q) => /prioritize/.test(q.text));
  assert.deepStrictEqual([added.classifiedBy, added.interviewsCount], ['community', 2]);
  assert.deepStrictEqual(jevEngine.mergeCommunityQuestions(dir, 'Unknown Co', [{ text: 'Why us?' }]), { added: 0 });
});

test('PDF OCR goes to the server relay when given a target', async () => {
  const sent = [];
  const fake = (label) => ({
    request: (url, opts, cb) => {
      sent.push({ label, url, auth: opts.headers.Authorization });
      const res = new EventEmitter();
      return {
        on: () => {},
        write: () => {},
        end: () => { cb(res); res.emit('data', Buffer.from(JSON.stringify({ choices: [{ message: { content: 'OCR text' } }] }))); res.emit('end'); },
        destroy: () => {}
      };
    }
  });
  const target = { url: 'http://localhost:8787/v1/ai/chat/completions', headers: { Authorization: 'Bearer dev-tok' } };
  const out = await pdfText.ocrPdfWithOpenRouter(Buffer.from('%PDF'), 'cv.pdf', target, fake('https'), undefined, undefined, fake('http'));
  assert.strictEqual(out, 'OCR text');
  assert.deepStrictEqual(sent[0], { label: 'http', url: target.url, auth: 'Bearer dev-tok' });
});
