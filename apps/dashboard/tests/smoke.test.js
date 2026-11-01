const test = require('node:test');
const assert = require('node:assert');
const { loadRenderer, indexHtml, el } = require('./helpers/renderer');

test('Task 10.1: Go Live, demo and window controls are wired (Requirements: 6.1, 6.2)', async () => {
  // Go Live in the top bar opens the live view; a session starts live or as a demo.
  assert.ok(/id="btnGoLive"[^>]*data-action="go"[^>]*data-to="live"/.test(indexHtml));
  const agent = { id: 'a1', company: 'Nubank', role: 'Backend' };
  const r = loadRenderer({
    state: { agents: [agent], config: { has_deepgram_key: true, has_llm_key: true } },
    api: { startOverlay: async () => ({ ok: true, agent }) }
  });
  await r.boot();
  await r.Cue.actions['start-copilot'](el({ agent: 'a1', demo: '1' }));
  const [[start]] = r.called('startOverlay');
  assert.strictEqual(start.demo, true, 'Simular starts the scripted demo');
  assert.strictEqual(r.S.route.view, 'live', 'starting jumps to the live view');

  // Frameless window: the three controls in the top bar go to the main process.
  for (const action of ['minimize', 'maximize', 'close']) {
    assert.ok(new RegExp(`data-win=["']${action}["']`).test(indexHtml), `data-win="${action}"`);
    r.dispatch('click', { target: { closest: (sel) => (sel === '[data-win]' ? { dataset: { win: action } } : null) } });
  }
  assert.deepStrictEqual(r.called('windowControl'), [['minimize'], ['maximize'], ['close']]);
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
