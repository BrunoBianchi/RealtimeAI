const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadRenderer, render, sources, indexHtml, el, tags } = require('./helpers/renderer');

const mainJsPath = path.resolve(__dirname, '../src/main/main.js');

const HUD_KEYS = ['stealth_screen_capture', 'stealth_dock', 'stealth_activity_monitor', 'stealth_click_through'];

test('Privacy & Stealth: the HUD card has the 4 functional toggles', () => {
  // Capture/dock/task manager default to on; click-through defaults to off.
  const { Cue } = loadRenderer({ state: { config: { stealth_click_through: false }, dashboardExecutable: 'lipcue.exe' } });
  const html = render(Cue, 'settings/privacy');
  const toggles = tags(html, { 'data-change': 'cfg', 'data-type': 'bool' }).filter((t) => HUD_KEYS.includes(t['data-key']));
  assert.deepStrictEqual(toggles.map((t) => t['data-key']), HUD_KEYS);
  assert.deepStrictEqual(toggles.map((t) => 'checked' in t), [true, true, true, false]);
  for (const key of HUD_KEYS) {
    assert.ok(new RegExp(`<label class="switch"><input type="checkbox" data-change="cfg" data-key="${key}"`).test(html), `${key} is a clickable switch`);
  }
  assert.ok(html.includes('Ctrl+Alt+T'), 'click-through names its live shortcut');

  // Brand integrity: no third-party names anywhere in the page.
  for (const src of [indexHtml, ...Object.values(sources)]) assert.ok(!src.includes('InterviewCoder'));
  assert.ok(html.includes('lipcue.exe'), 'the process row shows the executable');
});

test('Privacy & Stealth: a toggle saves its key as a boolean and says so', async () => {
  const r = loadRenderer({ api: { saveConfig: async (patch) => ({ ok: true, config: patch }) } });
  await r.Cue.changes.cfg(el({ key: 'stealth_click_through', type: 'bool', label: 'Cliques atravessam' }, { checked: true }));
  assert.deepStrictEqual(r.called('saveConfig'), [[{ stealth_click_through: true }]]);
  assert.deepStrictEqual(r.toasts(), [{ text: 'Cliques atravessam: on.', error: false }]);
});

test('Privacy & Stealth: main.js reads, writes, and syncs stealth settings', () => {
  const mainJs = fs.readFileSync(mainJsPath, 'utf8');

  assert.ok(mainJs.includes('stealth_dock'), 'main.js must handle stealth_dock');
  assert.ok(mainJs.includes('stealth_activity_monitor'), 'main.js must handle stealth_activity_monitor');
  assert.ok(mainJs.includes('stealth_click_through'), 'main.js must handle stealth_click_through');
  assert.ok(mainJs.includes('stealth_screen_capture'), 'main.js must handle stealth_screen_capture');
  assert.ok(mainJs.includes('[stealth]'), 'main.js writeConfigIni must output [stealth] section');
});
