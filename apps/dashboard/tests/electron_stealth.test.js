const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadRenderer, render, indexHtml, el, tags } = require('./helpers/renderer');

const mainJsPath = path.resolve(__dirname, '../src/main/main.js');
const preloadJsPath = path.resolve(__dirname, '../src/preload/preload.js');

test('Electron Stealth Mode: top bar chip and the Privacy controls for this window', () => {
  assert.ok(/id="btnStealthChip"[^>]*data-action="toggle-stealth"[^>]*title="[^"]*Ctrl\+Alt\+S/.test(indexHtml), 'chip toggles stealth and names its shortcut');

  const { Cue } = loadRenderer({ state: { stealthState: { active: true, screenProtection: true, skipTaskbar: false, disguise: true } } });
  const html = render(Cue, 'settings/privacy');
  const switches = tags(html, { 'data-change': 'stealth' });
  assert.deepStrictEqual(switches.map((s) => s['data-field']), ['active', 'screenProtection', 'skipTaskbar', 'disguise']);
  assert.deepStrictEqual(switches.map((s) => 'checked' in s), [true, true, false, true], 'switches mirror the live stealth state');
  // Every switch is an <input> inside a <label class="switch">: the whole control is clickable.
  assert.strictEqual((html.match(/<label class="switch"><input type="checkbox" data-change="stealth"/g) || []).length, 4);
  assert.ok(html.includes('Ctrl+Alt+S') && html.includes('Ctrl+Shift+H'), 'global shortcuts are named');
});

test('Electron Stealth Mode: preload.js exposes all required APIs', () => {
  const preloadJs = fs.readFileSync(preloadJsPath, 'utf8');

  assert.ok(preloadJs.includes('getStealthState'), 'preload must expose getStealthState');
  assert.ok(preloadJs.includes('toggleStealthMode'), 'preload must expose toggleStealthMode');
  assert.ok(preloadJs.includes('setStealthMode'), 'preload must expose setStealthMode');
  assert.ok(preloadJs.includes('onStealthModeUpdated'), 'preload must expose onStealthModeUpdated');
});

test('Electron Stealth Mode: main.js implements stealth logic and IPC handlers', () => {
  const mainJs = fs.readFileSync(mainJsPath, 'utf8');

  // IPC handlers
  assert.ok(mainJs.includes("'rtai:get-stealth-state'"), 'main.js must register rtai:get-stealth-state handler');
  assert.ok(mainJs.includes("'rtai:toggle-stealth-mode'"), 'main.js must register rtai:toggle-stealth-mode handler');
  assert.ok(mainJs.includes("'rtai:set-stealth-mode'"), 'main.js must register rtai:set-stealth-mode handler');

  // Config persistence
  assert.ok(mainJs.includes('electron_stealth'), 'main.js must handle electron_stealth');
  assert.ok(mainJs.includes('electron_screen_protection'), 'main.js must handle electron_screen_protection');
  assert.ok(mainJs.includes('electron_skip_taskbar'), 'main.js must handle electron_skip_taskbar');
  assert.ok(mainJs.includes('electron_disguise'), 'main.js must handle electron_disguise');

  // Window protection & global shortcuts
  assert.ok(mainJs.includes('setContentProtection'), 'main.js must apply setContentProtection to window');
  assert.ok(mainJs.includes('setSkipTaskbar'), 'main.js must apply setSkipTaskbar to window');
  assert.ok(mainJs.includes('applyElectronStealthMode'), 'main.js must have applyElectronStealthMode function');
  assert.ok(mainJs.includes('registerStealthShortcuts'), 'main.js must have registerStealthShortcuts function');
});

test('Electron Stealth Mode: chip, switches and the global shortcut stay in sync', async () => {
  const r = loadRenderer({
    api: {
      toggleStealthMode: async () => ({ status: { active: true } }),
      setStealthMode: async (patch) => ({ status: { active: false, ...patch } })
    }
  });
  await r.boot();
  assert.ok(r.page('btnStealthChip').innerHTML.includes('Visible'));

  // Clicking the chip.
  await r.Cue.actions['toggle-stealth']();
  assert.strictEqual(r.called('toggleStealthMode').length, 1);
  assert.ok(r.page('btnStealthChip').innerHTML.includes('Hidden'));

  // A settings switch sends only its own field.
  await r.Cue.changes.stealth(el({ field: 'skipTaskbar' }, { checked: true }));
  assert.deepStrictEqual(r.called('setStealthMode'), [[{ skipTaskbar: true }]]);

  // Ctrl+Alt+S in the main process republishes the state; the chip follows it.
  const [listener] = r.calls.find(([n]) => n === 'onStealthModeUpdated')[1];
  listener({ active: true });
  assert.ok(r.page('btnStealthChip').innerHTML.includes('Hidden'));
  listener({ active: false });
  assert.ok(r.page('btnStealthChip').innerHTML.includes('Visible'));
});
