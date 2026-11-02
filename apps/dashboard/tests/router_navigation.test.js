const test = require('node:test');
const assert = require('node:assert');
const { loadRenderer, tags } = require('./helpers/renderer');

const SESSION_ID = '2026-10-01_10-00-00_ab12';
const STATE = {
  config: { model: 'qwen/qwen3.6-flash', has_deepgram_key: true, has_llm_key: true },
  agents: [{ id: 'a1', company: 'Nubank', role: 'Backend', documents: [{ title: 'cv.pdf', tag: 'resume', content: 'Go' }] }],
  sessions: [{ id: SESSION_ID, goalLabel: 'Nubank · Backend', startedAt: '2026-10-01T13:00:00Z', durationSeconds: 1500, questionsCount: 4 }],
  profile: { name: 'Ana Souza', plan: 'free', transcriptionUsage: { limitMinutes: 300 } },
  questionBank: { companies: [{ company: 'Nubank', questions: [{ id: 'q1', text: 'Fale de um projeto difícil', category: 'behavioral' }] }] },
  gcal: { status: { configured: true, connected: false } },
  meeting: { supported: true, enabled: true, active: [], mutedApps: [] }
};

async function booted() {
  const r = loadRenderer({ state: STATE, api: { getState: async () => STATE } });
  await r.boot();
  return r;
}

test('Client-side Router: hash routes map to views', async () => {
  const r = await booted();
  assert.strictEqual(r.location.hash, '#/home', 'starts on #/home');
  const cases = [
    ['home', 'home', []],
    ['sessions', 'sessions', []],
    ['history', 'sessions', ['past']],
    ['sessions/past', 'sessions', ['past']],
    ['session/a1', 'session', ['a1']],
    [`review/${SESSION_ID}`, 'review', [SESSION_ID]],
    ['files', 'files', []],
    ['questions', 'questions', []],
    ['live', 'live', []],
    ['settings/calendar', 'settings', ['calendar']],
    ['nao-existe', 'home', []]
  ];
  for (const [path, view, parts] of cases) {
    r.Cue.navigate(path);
    assert.strictEqual(r.location.hash, `#/${path}`);
    assert.strictEqual(r.S.route.view, view, `#/${path} -> ${view}`);
    assert.deepStrictEqual([...r.S.route.parts], parts, `#/${path} parts`);
  }
  // History is the "past" tab of Sessões, and the sidebar highlights it.
  r.Cue.navigate('history');
  assert.strictEqual(r.S.ui.sessTab, 'past');
  assert.ok(/class="nav-item active"[^>]*data-to="history"/.test(r.page('sideNav').innerHTML));
  assert.strictEqual(r.page('crumb').textContent, 'Histórico');
});

test('Prep Session & Goal Workspace Navigation: links go where they say', async () => {
  const r = await booted();
  r.Cue.navigate('session/a1');
  const html = r.page('view').innerHTML;
  assert.ok(tags(html, { 'data-action': 'go', 'data-to': 'sessions' }).length >= 1, 'back to Sessões');
  assert.ok(tags(html, { 'data-action': 'go', 'data-to': `review/${SESSION_ID}` }).length === 1, 'recorded session opens its review');
  assert.strictEqual(r.page('crumb').textContent, 'Sessões / Nubank · Backend');

  // Every internal link on every screen points at a route the router knows.
  const known = new Set(['home', 'sessions', 'history', 'session', 'review', 'files', 'questions', 'live', 'settings']);
  for (const path of ['home', 'sessions', 'history', 'session/a1', `review/${SESSION_ID}`, 'files', 'questions', 'live', 'settings/general']) {
    r.Cue.navigate(path);
    const links = tags(r.page('view').innerHTML + r.page('sideNav').innerHTML, { 'data-action': 'go' });
    for (const l of links) assert.ok(known.has(String(l['data-to']).split('/')[0]), `#/${path}: link to unknown route ${l['data-to']}`);
  }
});

test('Prep Session & Workspace UI: every screen renders with real data and without it', async () => {
  const paths = ['home', 'sessions', 'history', 'session/a1', `review/${SESSION_ID}`, 'files', 'questions', 'live',
    ...['general', 'ai', 'audio', 'privacy', 'overlay', 'calendar', 'shortcuts', 'plan', 'updates'].map((t) => `settings/${t}`)];
  const full = await booted();
  const empty = loadRenderer();
  await empty.boot();
  for (const r of [full, empty]) {
    for (const path of paths) {
      r.Cue.navigate(path);
      const html = r.page('view').innerHTML;
      assert.ok(html.length > 200, `#/${path} rendered`);
      assert.ok(!html.includes('Esta tela falhou ao carregar'), `#/${path} threw while rendering`);
      assert.ok(!/undefined|NaN|\[object Object\]/.test(html.replace(/<svg[\s\S]*?<\/svg>/g, '')), `#/${path} shows a raw undefined/NaN`);
    }
  }
});
