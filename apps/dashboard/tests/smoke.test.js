const test = require('node:test');
const assert = require('node:assert');
const { loadRenderer, indexHtml, el } = require('./helpers/renderer');

test('Task 10.1: Go Live and window controls are wired (Requirements: 6.1, 6.2)', async () => {
  // Go Live in the top bar opens the live view; a session always starts live
  // (the scripted demo is a developer tool, never started from the app).
  assert.ok(/id="btnGoLive"[^>]*data-action="go"[^>]*data-to="live"/.test(indexHtml));
  const agent = { id: 'a1', company: 'Nubank', role: 'Backend' };
  const r = loadRenderer({
    state: { agents: [agent], config: { has_deepgram_key: true, has_llm_key: true } },
    api: { startOverlay: async () => ({ ok: true, agent }) }
  });
  await r.boot();
  await r.Cue.actions['start-copilot'](el({ agent: 'a1', demo: '1' }));
  const [[start]] = r.called('startOverlay');
  assert.strictEqual(start.demo, undefined, 'never the scripted demo, even if asked');
  assert.strictEqual(start.codingInterview, false);
  assert.strictEqual(r.S.route.view, 'live', 'starting jumps to the live view');

  // Frameless window: the three controls in the top bar go to the main process.
  for (const action of ['minimize', 'maximize', 'close']) {
    assert.ok(new RegExp(`data-win=["']${action}["']`).test(indexHtml), `data-win="${action}"`);
    r.dispatch('click', { target: { closest: (sel) => (sel === '[data-win]' ? { dataset: { win: action } } : null) } });
  }
  assert.deepStrictEqual(r.called('windowControl'), [['minimize'], ['maximize'], ['close']]);
});

test('Coding interview opens the live overlay in coding mode and renders fenced code', async () => {
  const agent = { id: 'a1', company: 'Nubank', role: 'Backend' };
  const r = loadRenderer({
    state: { agents: [agent], config: { has_deepgram_key: true, has_llm_key: true } },
    api: { startOverlay: async () => ({ ok: true, agent }) }
  });
  await r.boot();
  assert.match(r.Cue.views.live(), /data-mode="coding-interview"/);
  await r.Cue.actions['start-copilot'](el({ agent: 'a1', mode: 'coding-interview' }));
  const [[start]] = r.called('startOverlay');
  assert.strictEqual(start.codingInterview, true);
  assert.strictEqual(start.agent.id, agent.id);

  const partial = '```python\ndef square(n):\n\n    return n ** 2 < 10';
  const code = '<pre><code>def square(n):\n\n    return n ** 2 &lt; 10</code></pre>';
  assert.strictEqual(r.Cue.md(partial), code);
  assert.strictEqual(r.Cue.md(partial + '\n```\n## Complexity'), `${code}<h4>Complexity</h4>`);
});

test('Live coding answers keep the highlighted code and walkthrough in separate panes', async () => {
  const r = loadRenderer();
  r.S.overlayStatus = { running: true, codingInterview: true };
  r.Cue.liveOnEvent({ type: 'answer_start', id: 7, reason: 'question' });
  r.Cue.liveOnEvent({ type: 'answer_delta', id: 7, text: '## Approach\nDivide by two.\n2. ```python\ndef half(n: int):\n    return n // 2 # half\n``' });
  const partial = r.Cue.views.live();
  assert.match(partial, /syntax-keyword">def</);
  assert.match(partial, /syntax-function">half</);
  assert.match(partial, /syntax-type">int</);
  assert.match(partial, /syntax-number">2</);
  assert.match(partial, /syntax-comment"># half</);
  assert.match(partial, /coding-line-number" aria-hidden="true">2<\/span>    /);
  assert.doesNotMatch(partial, /data-action="copy-coding-block"|>``<\/span>/);
  r.Cue.liveOnEvent({ type: 'answer_done', id: 7, understood: 'Implement integer halving', text: '2. ```python\nprint("<script>")\n```\n## Walkthrough\n1. Print the value.' });
  r.S.overlayStatus = { running: false, codingInterview: false };
  const completed = r.Cue.views.live();
  assert.match(completed, /coding-code-column[\s\S]*syntax-string">&quot;&lt;script&gt;&quot;[\s\S]*coding-explanation[\s\S]*<ol><li>Print the value/);
  assert.doesNotMatch(completed, /print\(<script>/);
  assert.match(completed, /class="answer-q">Implement integer halving/);
  assert.match(completed, /data-action="copy-coding-block" data-text="print\(&quot;&lt;script&gt;&quot;\)"/);
  const [block] = r.Cue.markdownParts('2. ````js\nconst s = "```";\n````', { coding: true });
  assert.deepStrictEqual({ ...block }, { language: 'js', code: 'const s = "```";', closed: true });
  let copied;
  r.window.navigator.clipboard = { writeText: async (text) => { copied = text; } };
  await r.Cue.actions['copy-coding-block'](el({ text: 'def half(n):\n    return n // 2' }));
  assert.strictEqual(copied, 'def half(n):\n    return n // 2');
});

test('Coding answers keep partial output visible and explain why it was cut off', () => {
  const r = loadRenderer();
  r.S.overlayStatus = { running: true, codingInterview: true };
  r.Cue.liveOnEvent({ type: 'answer_start', id: 8, reason: 'screenshot', trigger: 'Screenshot' });
  r.Cue.liveOnEvent({ type: 'answer_done', id: 8, status: 'failed', error: 'The model reached its output limit.',
    text: '1. ```python\nclass DynamicArray:' });
  const html = r.Cue.views.live();
  assert.match(html, /Incomplete/);
  assert.match(html, /The model reached its output limit/);
  assert.match(html, /syntax-keyword">class</);
  assert.doesNotMatch(html, /data-action="copy-coding-block"/);
});

test('Task 10.1: theme switcher in 3 modes (Requirements: 3.3, 6.3)', async () => {
  const set = async (pref, { prefersLight = false } = {}) => {
    const r = loadRenderer({ prefersLight, api: { setThemePreference: async (p) => ({ preference: p, resolved: p === 'light' ? 'light' : 'dark' }) } });
    await r.Cue.actions['set-theme'](el({ theme: pref }));
    return { theme: r.document.documentElement.dataset.theme, calls: r.called('setThemePreference') };
  };
  assert.deepStrictEqual(await set('dark'), { theme: 'dark', calls: [['dark']] });
  assert.deepStrictEqual(await set('light'), { theme: 'light', calls: [['light']] });
  // "Sistema" follows Windows.
  assert.strictEqual((await set('system', { prefersLight: true })).theme, 'light');
  assert.strictEqual((await set('system', { prefersLight: false })).theme, 'dark');
});
