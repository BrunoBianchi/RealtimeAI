// Rating dialog at the end of sessions (specs/004-session-feedback-popup):
// main-process rules (src/main/feedback.js), the HTTP calls it makes, the
// engine's bye event and the renderer markup.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFeedback } = require('../src/main/feedback');
const { createCloudAccount, describeError } = require('../src/main/cloud_account');

function setup({ local = false, reply } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtai-feedback-'));
  const calls = [];
  const env = { local, reply: reply || (() => ({ ok: true, status: 200, error: '', data: {} })) };
  const make = () =>
    createFeedback({
      api: async (method, p, body) => {
        calls.push({ method, path: p, body });
        return env.reply(method, p, body);
      },
      describeError,
      dataDir: () => dir,
      isLocalMode: () => env.local,
      appVersion: '2.1.0'
    });
  return { fb: make(), make, calls, env, dir, stored: () => JSON.parse(fs.readFileSync(path.join(dir, 'feedback.json'), 'utf8')) };
}

const offline = () => ({ ok: false, status: 0, error: 'network', data: null });

test('nothing known about the preference: the dialog stays shut', () => {
  const { fb } = setup();
  assert.strictEqual(fb.shouldAskMock({ id: 'mock_1', userTurns: 2 }), false);
});

test('mock interview: asks once, only with an answer and only signed in', async () => {
  const { fb, env } = setup();
  await fb.syncFromMe({ preferences: { feedback_prompt: true } });
  assert.strictEqual(fb.shouldAskMock({ id: 'mock_1', userTurns: 0 }), false, 'no answer');
  assert.strictEqual(fb.shouldAskMock({ id: 'mock_1', userTurns: 1 }), true);
  assert.strictEqual(fb.shouldAskMock({ id: 'mock_1', userTurns: 1 }), false, 'once per session');
  env.local = true;
  assert.strictEqual(fb.shouldAskMock({ id: 'mock_2', userTurns: 1 }), false, 'local mode has no account');
});

test('the asked list keeps the last 50 sessions, across restarts', async () => {
  const { fb, make, stored } = setup();
  await fb.syncFromMe({ preferences: { feedback_prompt: true } });
  for (let i = 0; i < 60; i++) fb.shouldAskMock({ id: `m${i}`, userTurns: 1 });
  assert.strictEqual(stored().asked.length, 50);
  assert.strictEqual(stored().asked[0], 'm10');
  assert.strictEqual(make().shouldAskMock({ id: 'm59', userTurns: 1 }), false);
});

test('submit: PUT /v1/feedback/{kind}/{id} with the app surface', async () => {
  const { fb, calls } = setup();
  assert.deepStrictEqual(await fb.submit({ kind: 'mock', id: 'mock_1', rating: 4, comment: '  Fast and easy  ' }), { ok: true });
  assert.deepStrictEqual(calls[0], {
    method: 'PUT',
    path: '/v1/feedback/mock/mock_1',
    body: { rating: 4, surface: 'app', client_version: '2.1.0', comment: 'Fast and easy' }
  });
  await fb.submit({ kind: 'live', id: 'sess_1', rating: 5, comment: '   ' });
  assert.strictEqual('comment' in calls[1].body, false, 'a blank comment is not sent');
  await fb.submit({ kind: 'live', id: 'sess_1', rating: 5, comment: 'ç'.repeat(1200) });
  assert.strictEqual([...calls[2].body.comment].length, 1000);
  assert.strictEqual((await fb.submit({ kind: 'mock', id: 'x', rating: 0 })).ok, false);
  assert.strictEqual(calls.length, 3, 'an invalid rating is not sent');
});

test('submit errors say what to do', async () => {
  const { fb, env } = setup();
  env.reply = offline;
  assert.match((await fb.submit({ kind: 'mock', id: 'm', rating: 3 })).error, /connection/);
  env.reply = () => ({ ok: false, status: 429, error: 'rate_limited' });
  assert.strictEqual((await fb.submit({ kind: 'mock', id: 'm', rating: 3 })).error, describeError('rate_limited'));
  env.reply = () => ({ ok: false, status: 404, error: 'not_found' });
  const gone = await fb.submit({ kind: 'mock', id: 'm', rating: 3 });
  assert.strictEqual(gone.gone, true);
  assert.match(gone.error, /can no longer be rated/);
});

// US2
test("don't show again: saved on the account", async () => {
  const { fb, calls, stored } = setup();
  await fb.syncFromMe({ preferences: { feedback_prompt: true } });
  assert.deepStrictEqual(await fb.setPrompt(false), { ok: true });
  assert.deepStrictEqual(calls[0], { method: 'PUT', path: '/v1/me/preferences', body: { feedback_prompt: false } });
  assert.deepStrictEqual({ prompt: stored().prompt, pending_off: stored().pending_off }, { prompt: false, pending_off: false });
  assert.strictEqual(fb.shouldAskMock({ id: 'm1', userTurns: 1 }), false);
});

test("don't show again offline: shut now, sent with the next /v1/me", async () => {
  const { fb, env, calls, stored } = setup();
  await fb.syncFromMe({ preferences: { feedback_prompt: true } });
  env.reply = offline;
  assert.deepStrictEqual(await fb.setPrompt(false), { ok: false });
  assert.strictEqual(stored().pending_off, true);
  assert.strictEqual(fb.shouldAskMock({ id: 'm1', userTurns: 1 }), false);

  env.reply = () => ({ ok: true, status: 200, data: { preferences: { feedback_prompt: false } } });
  await fb.syncFromMe({ preferences: { feedback_prompt: true } });
  assert.deepStrictEqual(calls.at(-1).body, { feedback_prompt: false });
  assert.strictEqual(stored().pending_off, false);
  assert.strictEqual(fb.knownPrompt(), false);
});

test('/v1/me sets the local copy; an older server changes nothing', async () => {
  const { fb, calls } = setup();
  await fb.syncFromMe({ preferences: { feedback_prompt: false } });
  assert.strictEqual(fb.knownPrompt(), false);
  await fb.syncFromMe({ preferences: { feedback_prompt: true } });
  assert.strictEqual(fb.knownPrompt(), true);
  await fb.syncFromMe({ email: 'x' });
  assert.strictEqual(fb.knownPrompt(), true);
  assert.strictEqual(calls.length, 0);
});

test('cloud account hands every /v1/me body to the feedback preference', async () => {
  const seen = [];
  const acc = createCloudAccount({
    getServerUrl: () => 'https://api.test.local',
    hasToken: () => true,
    readToken: () => 'tok',
    saveToken: () => {},
    openBrowser: () => {},
    appVersion: '2.1.0',
    onAccount: (me) => seen.push(me),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ email: 'a@b.c', plan: { id: 'free' }, preferences: { feedback_prompt: false } }) })
  });
  await acc.status(true);
  assert.deepStrictEqual(seen[0].preferences, { feedback_prompt: false });
});

// US3: the engine's bye event (contracts/engine-bye.md).
test('live session: asks after 60 s with a cloud session, once', async () => {
  const { fb, env } = setup();
  await fb.syncFromMe({ preferences: { feedback_prompt: true } });
  assert.strictEqual(fb.onBye({ type: 'bye', cloud_session: 'sess_1', duration_s: 59 }), null, 'under 60 s');
  assert.strictEqual(fb.onBye({ type: 'bye', session: 'a.jsonl', summary: 'a.md' }), null, 'older engine');
  assert.deepStrictEqual(fb.onBye({ type: 'bye', cloud_session: 'sess_1', duration_s: 60 }), { kind: 'live', id: 'sess_1' });
  assert.strictEqual(fb.onBye({ type: 'bye', cloud_session: 'sess_1', duration_s: 600 }), null, 'once per session');
  env.local = true;
  assert.strictEqual(fb.onBye({ type: 'bye', cloud_session: 'sess_2', duration_s: 600 }), null, 'local mode');
  env.local = false;
  await fb.syncFromMe({ preferences: { feedback_prompt: false } });
  assert.strictEqual(fb.onBye({ type: 'bye', cloud_session: 'sess_3', duration_s: 600 }), null, "don't show again");
});

// US4
test('settings toggle: only what the server saved', async () => {
  const { fb, env } = setup();
  await fb.syncFromMe({ preferences: { feedback_prompt: true } });
  env.reply = offline;
  const failed = await fb.savePrompt(false);
  assert.strictEqual(failed.ok, false);
  assert.match(failed.error, /Could not save/);
  assert.strictEqual(fb.getPrompt().value, true, 'a failed save changes nothing');
  env.reply = () => ({ ok: true, status: 200, data: { preferences: { feedback_prompt: false } } });
  assert.deepStrictEqual(await fb.savePrompt(false), { ok: true, value: false });
  assert.strictEqual(fb.getPrompt().value, false);
  env.local = true;
  assert.deepStrictEqual(fb.getPrompt(), { value: null, local: true });
});

// Renderer and wiring.
const src = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

test('the dialog: stars as a radio group, a 1,000-character comment, theme colors only', () => {
  const ui = src('renderer/modals.js');
  const start = ui.indexOf('function feedbackDialog');
  assert.ok(start > 0, 'feedback dialog in modals.js');
  const dialog = ui.slice(start, ui.indexOf('MODALS.feedback', start));
  assert.match(dialog, /role="radiogroup"/);
  assert.match(dialog, /role="radio"/);
  assert.match(dialog, /aria-checked/);
  assert.match(dialog, /maxlength="1000"/);
  assert.match(dialog, /mount\(/);
  assert.match(dialog, /Don't show again/);
  assert.doesNotMatch(dialog, /#[0-9a-fA-F]{3,8}\b/, 'colors come from the theme tokens');
});

test('wiring: IPC, preload, the bye event and the mock end', () => {
  const main = src('main/main.js');
  for (const ch of ['rtai:feedback-submit', 'rtai:feedback-should-ask-mock', 'rtai:feedback-set-prompt', 'rtai:feedback-save-prompt', 'rtai:feedback-get-prompt']) {
    assert.ok(main.includes(`'${ch}'`), ch);
  }
  assert.match(main, /msg\.type === 'bye'/);
  assert.match(main, /feedback\.onBye\(msg\)/);
  assert.match(main, /rtai:feedback-prompt/);
  assert.doesNotMatch(main.slice(main.indexOf("msg.type === 'bye'"), main.indexOf("msg.type === 'bye'") + 600), /\.focus\(\)/, 'never steals focus');
  const preload = src('preload/preload.js');
  for (const fn of ['feedbackSubmit', 'feedbackShouldAskMock', 'feedbackSetPrompt', 'feedbackSavePrompt', 'feedbackGetPrompt', 'onFeedbackPrompt', 'onFeedbackClose']) {
    assert.ok(preload.includes(fn), fn);
  }
  assert.match(src('renderer/mock.js'), /feedbackShouldAskMock/);
});

test('settings: the toggle and its tour step', () => {
  assert.match(src('renderer/settings.js'), /Ask for a rating after sessions/);
  assert.match(src('renderer/tour.js'), /feedbackPrompt|Ask for a rating/);
});
