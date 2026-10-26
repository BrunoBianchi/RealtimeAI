// Google Calendar integration (dashboard/google_calendar.js): OAuth with PKCE
// over a loopback redirect, encrypted token storage, refresh, Calendar API
// calls and the goal "Next interview" -> event sync. No network: fetch,
// safeStorage and the browser are fakes.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const gc = require('../src/main/google_calendar.js');

const WEB_CLIENT = { web: { client_id: 'abc.apps.googleusercontent.com', project_id: 'proj-1', client_secret: 'shh',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token' } };
const DESKTOP_CLIENT = { installed: { client_id: 'desk.apps.googleusercontent.com', client_secret: 'd', redirect_uris: ['http://localhost'] } };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rtai-gcal-'));
}

// DPAPI stand-in: reversible, and visibly not plain text.
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`ENC1${Buffer.from(s, 'utf8').toString('base64')}`, 'latin1'),
  decryptString: (b) => Buffer.from(b.toString('latin1').slice(4), 'base64').toString('utf8')
};

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, text: async () => (body === undefined ? '' : JSON.stringify(body)) };
}

// Records calls; `routes` answers by "METHOD url-prefix".
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url: String(url), method, headers: init.headers || {}, body: init.body });
    for (const [key, handler] of routes) {
      const [m, prefix] = key.split(' ');
      if (m === method && String(url).startsWith(prefix)) return handler(String(url), init, calls);
    }
    return jsonResponse(404, { error: { message: 'no route' } });
  };
  fn.calls = calls;
  return fn;
}

function service(dataDir, fetchImpl, extra = {}) {
  return gc.createGoogleCalendar({ dataDir, fetchImpl, safeStorage: fakeSafeStorage, timeZone: 'America/Sao_Paulo', ...extra });
}

function connectedDir(tok = {}) {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, gc.CLIENT_FILE), JSON.stringify(WEB_CLIENT));
  const token = { refresh_token: 'r1', access_token: 'a1', expiry: Date.now() + 3600e3, email: 'me@example.com', ...tok };
  fs.writeFileSync(path.join(dir, gc.TOKEN_FILE), fakeSafeStorage.encryptString(JSON.stringify(token)));
  return dir;
}

test('client JSON: Web and Desktop clients, garbage rejected', () => {
  const web = gc.parseClientJson(JSON.stringify(WEB_CLIENT));
  assert.strictEqual(web.type, 'web');
  assert.strictEqual(web.clientId, 'abc.apps.googleusercontent.com');
  assert.strictEqual(web.projectId, 'proj-1');
  assert.strictEqual(gc.parseClientJson(DESKTOP_CLIENT).type, 'installed');
  assert.strictEqual(gc.parseClientJson('{"foo":1}'), null);
  assert.strictEqual(gc.parseClientJson('not json'), null);
});

test('redirect: Web client without a loopback URI uses the documented one; Desktop picks a free port', () => {
  const web = gc.chooseRedirect(gc.parseClientJson(WEB_CLIENT));
  assert.strictEqual(web.uri, 'http://127.0.0.1:53682/oauth2callback');
  assert.strictEqual(web.uri, gc.WEB_REDIRECT_URI);
  assert.strictEqual(web.registered, false);
  const reg = gc.chooseRedirect(gc.parseClientJson({ web: { client_id: 'x', redirect_uris: ['https://site.example/cb', 'http://localhost:8765/cb'] } }));
  assert.strictEqual(reg.uri, 'http://localhost:8765/cb');
  assert.strictEqual(reg.port, 8765);
  const desk = gc.chooseRedirect(gc.parseClientJson(DESKTOP_CLIENT));
  assert.strictEqual(desk.port, 0);
});

test('auth URL asks for offline calendar access with PKCE S256 and the state', () => {
  const { verifier, challenge } = gc.pkcePair();
  const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
  assert.strictEqual(challenge, expected);
  const u = new URL(gc.buildAuthUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:53682/oauth2callback', state: 'st', challenge }));
  assert.strictEqual(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.strictEqual(u.searchParams.get('client_id'), 'cid');
  assert.strictEqual(u.searchParams.get('response_type'), 'code');
  assert.strictEqual(u.searchParams.get('access_type'), 'offline');
  assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
  assert.strictEqual(u.searchParams.get('code_challenge'), challenge);
  assert.strictEqual(u.searchParams.get('state'), 'st');
  assert.ok(u.searchParams.get('scope').includes('https://www.googleapis.com/auth/calendar.events'));
});

test('event bodies: timed, all-day, past midnight, reminders and goal tag', () => {
  const timed = gc.eventBody({ summary: 'Tech interview', date: '2026-10-28', time: '15:00', durationMin: 60, timeZone: 'America/Sao_Paulo', reminderMin: 30 });
  assert.deepStrictEqual(timed.start, { dateTime: '2026-10-28T15:00:00', timeZone: 'America/Sao_Paulo' });
  assert.deepStrictEqual(timed.end, { dateTime: '2026-10-28T16:00:00', timeZone: 'America/Sao_Paulo' });
  assert.deepStrictEqual(timed.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] });
  const late = gc.eventBody({ summary: 'x', date: '2026-12-31', time: '23:30', durationMin: 90, timeZone: 'UTC' });
  assert.strictEqual(late.end.dateTime, '2027-01-01T01:00:00');
  const allDay = gc.eventBody({ summary: 'x', date: '2026-02-28', timeZone: 'UTC', reminderMin: 0 });
  assert.deepStrictEqual(allDay.start, { date: '2026-02-28' });
  assert.deepStrictEqual(allDay.end, { date: '2026-03-01' });
  assert.deepStrictEqual(allDay.reminders, { useDefault: true });
  assert.throws(() => gc.eventBody({ summary: 'x', date: '28/10/2026' }), /valid date/);
  const iv = gc.interviewEventBody({ id: 'g1', name: 'Nubank SWE', company: 'Nubank', role: 'Senior SWE',
    next_interview: { date: '2026-11-03', time: '9:30' } }, { durationMin: 45, reminderMin: 60 }, 'America/Sao_Paulo');
  assert.strictEqual(iv.summary, 'Interview: Senior SWE @ Nubank');
  assert.strictEqual(iv.start.dateTime, '2026-11-03T09:30:00');
  assert.strictEqual(iv.end.dateTime, '2026-11-03T10:15:00');
  assert.deepStrictEqual(iv.extendedProperties, { private: { rtaiGoalId: 'g1' } });
  assert.ok(!/—/.test(JSON.stringify(iv)), 'no em dashes in what the user reads');
});

test('status: not set up, then set up from a client_secret file next to the app', () => {
  const dir = tmpDir();
  const appDir = tmpDir();
  const s1 = service(dir, fakeFetch([]), { searchDirs: [appDir] });
  assert.strictEqual(s1.status().configured, false);
  fs.writeFileSync(path.join(appDir, 'client_secret_2_869-xyz.apps.googleusercontent.com.json'), JSON.stringify(WEB_CLIENT));
  const st = s1.status();
  assert.strictEqual(st.configured, true);
  assert.strictEqual(st.clientType, 'web');
  assert.strictEqual(st.redirectUri, 'http://127.0.0.1:53682/oauth2callback');
  assert.strictEqual(st.connected, false);
  assert.ok(!JSON.stringify(st).includes('shh'), 'the client secret never leaves the main process');
});

test('import: copies a valid client file into the app data folder, refuses anything else', () => {
  const dir = tmpDir();
  const src = path.join(tmpDir(), 'client.json');
  fs.writeFileSync(src, JSON.stringify(WEB_CLIENT));
  const s = service(dir, fakeFetch([]));
  assert.strictEqual(s.importClient(src).configured, true);
  assert.ok(fs.existsSync(path.join(dir, gc.CLIENT_FILE)));
  const bad = path.join(tmpDir(), 'bad.json');
  fs.writeFileSync(bad, '{"hello":"world"}');
  assert.throws(() => s.importClient(bad), /not a Google OAuth client/);
});

test('connect: browser consent -> loopback code -> tokens stored encrypted', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, gc.CLIENT_FILE), JSON.stringify(DESKTOP_CLIENT)); // any free port
  let tokenForm = null;
  const fetchImpl = fakeFetch([
    ['POST https://oauth2.googleapis.com/token', (_u, init) => {
      tokenForm = new URLSearchParams(init.body);
      return jsonResponse(200, { access_token: 'acc', refresh_token: 'ref', expires_in: 3600, scope: gc.SCOPES.join(' ') });
    }],
    ['GET https://www.googleapis.com/calendar/v3/users/me/calendarList/primary', () => jsonResponse(200, { id: 'bruno@example.com', primary: true })]
  ]);
  // The "browser": follow the consent URL straight to the redirect with a code.
  const openExternal = async (url) => {
    const u = new URL(url);
    const back = new URL(u.searchParams.get('redirect_uri'));
    back.searchParams.set('code', 'the-code');
    back.searchParams.set('state', u.searchParams.get('state'));
    await new Promise((resolve, reject) => http.get(back, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject));
  };
  const s = service(dir, fetchImpl, { openExternal });
  const st = await s.connect();
  assert.strictEqual(st.connected, true);
  assert.strictEqual(st.email, 'bruno@example.com');
  assert.strictEqual(tokenForm.get('grant_type'), 'authorization_code');
  assert.strictEqual(tokenForm.get('code'), 'the-code');
  assert.ok(tokenForm.get('code_verifier'), 'PKCE verifier sent');
  assert.match(tokenForm.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+$/);
  const raw = fs.readFileSync(path.join(dir, gc.TOKEN_FILE), 'latin1');
  assert.ok(raw.startsWith('ENC1'), 'tokens are encrypted at rest');
  assert.ok(!raw.includes('ref'), 'no plain refresh token on disk');
});

test('connect: a declined consent or a forged state does not connect', async () => {
  for (const mode of ['denied', 'forged']) {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, gc.CLIENT_FILE), JSON.stringify(DESKTOP_CLIENT));
    const openExternal = async (url) => {
      const u = new URL(url);
      const back = new URL(u.searchParams.get('redirect_uri'));
      if (mode === 'denied') back.searchParams.set('error', 'access_denied');
      else back.searchParams.set('code', 'x');
      back.searchParams.set('state', mode === 'forged' ? 'not-the-state' : u.searchParams.get('state'));
      await new Promise((resolve, reject) => http.get(back, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject));
    };
    const s = service(dir, fakeFetch([]), { openExternal });
    await assert.rejects(s.connect(), mode === 'denied' ? /declined/ : /did not match/);
    assert.strictEqual(s.status().connected, false);
  }
});

test('expired access token is refreshed once and saved; a revoked grant asks to reconnect', async () => {
  const dir = connectedDir({ access_token: 'old', expiry: Date.now() - 1000 });
  const fetchImpl = fakeFetch([
    ['POST https://oauth2.googleapis.com/token', () => jsonResponse(200, { access_token: 'fresh', expires_in: 3600 })],
    ['GET https://www.googleapis.com/calendar/v3/users/me/calendarList', () => jsonResponse(200, { items: [{ id: 'primary@x', summary: 'Me', primary: true }] })]
  ]);
  const s = service(dir, fetchImpl);
  const cals = await s.listCalendars();
  assert.deepStrictEqual(cals[0], { id: 'primary@x', summary: 'Me', primary: true, color: '' });
  const apiCall = fetchImpl.calls.find((c) => c.url.includes('/calendarList'));
  assert.strictEqual(apiCall.headers.Authorization, 'Bearer fresh');

  const dir2 = connectedDir({ access_token: 'old', expiry: 0 });
  const s2 = service(dir2, fakeFetch([
    ['POST https://oauth2.googleapis.com/token', () => jsonResponse(400, { error: 'invalid_grant' })]
  ]));
  await assert.rejects(s2.listCalendars(), /Connect again/);
  assert.strictEqual(s2.status().connected, false);
  assert.match(s2.status().lastError, /Connect again/);
});

test('API errors say what to do (Calendar API disabled in the project)', async () => {
  const dir = connectedDir();
  const s = service(dir, fakeFetch([
    ['GET https://www.googleapis.com/calendar/v3/calendars/', () => jsonResponse(403, { error: { code: 403, message: 'Google Calendar API has not been used in project 869 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } })]
  ]));
  await assert.rejects(s.listEvents(), /calendar-json\.googleapis\.com\?project=proj-1/);
});

test('events: list the next days, create, update and delete (already gone is fine)', async () => {
  const dir = connectedDir();
  const fetchImpl = fakeFetch([
    ['GET https://www.googleapis.com/calendar/v3/calendars/primary/events', () => jsonResponse(200, { items: [
      { id: 'e1', summary: 'Interview', start: { dateTime: '2026-10-28T15:00:00-03:00' }, end: { dateTime: '2026-10-28T16:00:00-03:00' }, htmlLink: 'https://www.google.com/calendar/event?eid=1' },
      { id: 'e2', status: 'cancelled' },
      { id: 'e3', summary: 'Holiday', start: { date: '2026-11-02' }, end: { date: '2026-11-03' } }
    ] })],
    ['POST https://www.googleapis.com/calendar/v3/calendars/primary/events', (_u, init) => jsonResponse(200, { id: 'new1', ...JSON.parse(init.body), htmlLink: 'https://www.google.com/calendar/event?eid=new1' })],
    ['PATCH https://www.googleapis.com/calendar/v3/calendars/primary/events/new1', (_u, init) => jsonResponse(200, { id: 'new1', ...JSON.parse(init.body) })],
    ['DELETE https://www.googleapis.com/calendar/v3/calendars/primary/events/new1', () => jsonResponse(204)],
    ['DELETE https://www.googleapis.com/calendar/v3/calendars/primary/events/gone', () => jsonResponse(410, { error: { message: 'Resource has been deleted' } })]
  ]);
  const s = service(dir, fetchImpl);
  const events = await s.listEvents({ days: 7 });
  assert.deepStrictEqual(events.map((e) => e.id), ['e1', 'e3']);
  assert.strictEqual(events[1].allDay, true);
  const listCall = new URL(fetchImpl.calls[0].url);
  assert.strictEqual(listCall.searchParams.get('singleEvents'), 'true');
  assert.strictEqual(listCall.searchParams.get('orderBy'), 'startTime');

  const created = await s.createEvent({ summary: 'Mock interview', date: '2026-10-30', time: '10:00', durationMin: 30 });
  assert.strictEqual(created.id, 'new1');
  const sent = JSON.parse(fetchImpl.calls.find((c) => c.method === 'POST').body);
  assert.strictEqual(sent.end.dateTime, '2026-10-30T10:30:00');
  assert.strictEqual(sent.start.timeZone, 'America/Sao_Paulo');

  const updated = await s.updateEvent('primary', 'new1', { summary: 'Moved', date: '2026-10-31', time: '11:00' });
  assert.strictEqual(updated.summary, 'Moved');
  assert.deepStrictEqual(await s.deleteEvent('primary', 'new1'), { ok: true });
  assert.deepStrictEqual(await s.deleteEvent('primary', 'gone'), { ok: true });
});

test('interview sync: creates, moves (same event), recreates if deleted in Google, removes', async () => {
  const dir = connectedDir();
  let seq = 0;
  const live = new Map();
  const fetchImpl = fakeFetch([
    ['POST https://www.googleapis.com/calendar/v3/calendars/primary/events', (_u, init) => {
      const id = `ev${++seq}`;
      live.set(id, JSON.parse(init.body));
      return jsonResponse(200, { id, htmlLink: `https://www.google.com/calendar/event?eid=${id}` });
    }],
    ['PATCH https://www.googleapis.com/calendar/v3/calendars/primary/events/', (u, init) => {
      const id = decodeURIComponent(u.split('/events/')[1]);
      if (!live.has(id)) return jsonResponse(404, { error: { message: 'Not Found' } });
      live.set(id, JSON.parse(init.body));
      return jsonResponse(200, { id });
    }],
    ['DELETE https://www.googleapis.com/calendar/v3/calendars/primary/events/', (u) => {
      live.delete(decodeURIComponent(u.split('/events/')[1]));
      return jsonResponse(204);
    }]
  ]);
  const s = service(dir, fetchImpl);
  const goal = { id: 'g1', name: 'Nubank', company: 'Nubank', role: 'SWE', next_interview: { date: '2026-11-03', time: '14:00' } };
  const r1 = await s.syncInterview(goal);
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.created, true);
  goal.next_interview = { date: '2026-11-04', time: '16:00' };
  const r2 = await s.syncInterview(goal);
  assert.strictEqual(r2.eventId, r1.eventId, 'moving the interview moves the same event');
  assert.strictEqual(live.get(r1.eventId).start.dateTime, '2026-11-04T16:00:00');
  live.clear(); // the user deleted it in Google Calendar
  const r3 = await s.syncInterview(goal);
  assert.strictEqual(r3.ok, true);
  assert.notStrictEqual(r3.eventId, r1.eventId);
  const r4 = await s.removeInterview('g1');
  assert.deepStrictEqual(r4, { ok: true, removed: true });
  assert.strictEqual(live.size, 0);
  assert.deepStrictEqual(await s.removeInterview('g1'), { ok: true, removed: false });
});

test('interview sync respects the switch and never throws', async () => {
  const dir = connectedDir();
  const s = service(dir, fakeFetch([
    ['POST https://www.googleapis.com/calendar/v3/calendars/primary/events', () => jsonResponse(500, { error: { message: 'Backend Error' } })]
  ]));
  const goal = { id: 'g2', name: 'x', next_interview: { date: '2026-11-03', time: '14:00' } };
  assert.deepStrictEqual(await s.syncInterview(goal, false), { ok: false, skipped: true, reason: 'off' });
  s.saveSettings({ autoSync: false });
  assert.strictEqual((await s.syncInterview(goal)).reason, 'off');
  const forced = await s.syncInterview(goal, true);
  assert.strictEqual(forced.ok, false);
  assert.match(forced.error, /500/);
  const offline = service(tmpDir(), fakeFetch([]));
  assert.strictEqual((await offline.syncInterview(goal)).reason, 'not_connected');
});

test('disconnect forgets the tokens and asks Google to revoke them', async () => {
  const dir = connectedDir();
  const fetchImpl = fakeFetch([['POST https://oauth2.googleapis.com/revoke', () => jsonResponse(200, {})]]);
  const s = service(dir, fetchImpl);
  const st = await s.disconnect();
  assert.strictEqual(st.connected, false);
  assert.ok(!fs.existsSync(path.join(dir, gc.TOKEN_FILE)));
  assert.strictEqual(new URLSearchParams(fetchImpl.calls[0].body).get('token'), 'r1');
});

test('without OS encryption the token file is marked plain and still readable', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, gc.CLIENT_FILE), JSON.stringify(WEB_CLIENT));
  const noEnc = { isEncryptionAvailable: () => false };
  const s = gc.createGoogleCalendar({ dataDir: dir, fetchImpl: fakeFetch([]), safeStorage: noEnc });
  fs.writeFileSync(path.join(dir, gc.TOKEN_FILE), `plain:${JSON.stringify({ refresh_token: 'r', email: 'a@b' })}`);
  assert.strictEqual(s.status().connected, true);
  assert.strictEqual(s.status().encrypted, false);
});
