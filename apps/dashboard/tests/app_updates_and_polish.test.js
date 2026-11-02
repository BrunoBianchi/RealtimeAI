const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadRenderer, render, indexHtml, el, tags } = require('./helpers/renderer');

const preloadJsPath = path.resolve(__dirname, '../src/preload/preload.js');
const mainJsPath = path.resolve(__dirname, '../src/main/main.js');

test('App Updates & Polish: Settings > Updates shows the version and the right action for each status', () => {
  const { Cue, S } = loadRenderer({ state: { appVersion: { version: '2.4.0', packaged: true }, config: { auto_update: true } } });

  const at = (update) => {
    S.update = update;
    return render(Cue, 'settings/updates');
  };
  const actions = (html) => tags(html, { 'data-action': true }).map((t) => t['data-action']);

  let html = at({ status: 'idle' });
  assert.ok(html.includes('2.4.0'), 'installed version is shown');
  assert.ok(actions(html).includes('update-check'), 'idle: Verificar');
  assert.ok(!actions(html).includes('update-download') && !actions(html).includes('update-install'));
  // Auto-update and channel controls live on the same card.
  assert.ok(tags(html, { 'data-change': 'cfg', 'data-key': 'auto_update' }).length === 1, 'auto-update switch');
  assert.deepStrictEqual(tags(html, { 'data-action': 'update-channel' }).map((t) => t['data-channel']), ['stable', 'beta']);

  html = at({ status: 'available', latestVersion: '2.5.0', releaseNotes: '**Mais rápido**' });
  assert.ok(html.includes('A versão 2.5.0 está disponível.'));
  assert.ok(actions(html).includes('update-download') && !actions(html).includes('update-check'));
  assert.ok(html.includes('<strong>Mais rápido</strong>'), 'release notes rendered as Markdown');

  html = at({ status: 'downloading', latestVersion: '2.5.0', progress: { percent: 42 } });
  assert.ok(/id="updateProgressBar" style="width:42%"/.test(html), 'progress bar the progress event updates in place');

  html = at({ status: 'downloaded', latestVersion: '2.5.0' });
  assert.ok(actions(html).includes('update-install'), 'downloaded: restart to install');
});

test('App Updates & Polish: top bar hosts search, update chip, stealth chip and Go Live', () => {
  const header = indexHtml.match(/<header\b[^>]*>([\s\S]*?)<\/header>/)[1];
  assert.ok(header.includes('data-action="open-palette"'), 'search opens the Ctrl+K palette');
  assert.ok(header.includes('Ctrl K'), 'search shows its shortcut');
  assert.ok(/id="btnUpdateChip"[^>]*data-to="settings\/updates"[^>]*hidden/.test(header), 'update chip starts hidden and opens Updates');
  assert.ok(/id="btnStealthChip"[^>]*data-action="toggle-stealth"/.test(header));
  assert.ok(/id="btnGoLive"[^>]*data-to="live"/.test(header));

  // The chip appears only while an update is on its way.
  const { Cue, S, page } = loadRenderer();
  S.update = { status: 'up-to-date' };
  Cue.renderShell();
  assert.strictEqual(page('btnUpdateChip').hidden, true);
  S.update = { status: 'available', latestVersion: '2.5.0' };
  Cue.renderShell();
  assert.strictEqual(page('btnUpdateChip').hidden, false);
  assert.ok(page('btnUpdateChip').innerHTML.includes('Atualização 2.5.0'));
  S.update = { status: 'downloaded', latestVersion: '2.5.0' };
  Cue.renderShell();
  assert.ok(page('btnUpdateChip').innerHTML.includes('Reiniciar para atualizar'));
});

test('App Updates & Polish: Privacy offers window opacity and the four process names', async () => {
  const { Cue, called } = loadRenderer({ state: { config: { process_disguise: 'cmd', interface_opacity: 0.8 } } });
  const html = render(Cue, 'settings/privacy');

  const slider = tags(html, { type: 'range', 'data-input': 'opacity' });
  assert.strictEqual(slider.length, 1, 'opacity slider');
  assert.strictEqual(slider[0].value, '80');
  assert.ok(html.includes('id="opacityLabel"') && html.includes('>80%<'));

  const cards = tags(html, { 'data-action': 'set-disguise' });
  assert.deepStrictEqual(cards.map((c) => c['data-mode']), ['none', 'settings', 'cmd', 'taskmgr']);
  assert.deepStrictEqual(cards.filter((c) => c['aria-pressed'] === 'true').map((c) => c['data-mode']), ['cmd'], 'current name is the pressed card');

  await Cue.actions['set-disguise'](el({ mode: 'taskmgr', label: 'Gerenciador de Tarefas' }));
  assert.deepStrictEqual(called('setProcessDisguise'), [['taskmgr']]);
  assert.deepStrictEqual(called('saveConfig'), [[{ process_disguise: 'taskmgr' }]]);
});

test('App Updates & Polish: preload.js exposes update, disguise, and opacity APIs', () => {
  const preload = fs.readFileSync(preloadJsPath, 'utf8');

  assert.ok(preload.includes('getAppVersion:'), 'preload must expose getAppVersion');
  assert.ok(preload.includes('checkUpdate:'), 'preload must expose checkUpdate');
  assert.ok(preload.includes('downloadUpdate:'), 'preload must expose downloadUpdate');
  assert.ok(preload.includes('installUpdate:'), 'preload must expose installUpdate');
  assert.ok(preload.includes('setProcessDisguise:'), 'preload must expose setProcessDisguise');
  assert.ok(preload.includes('setInterfaceOpacity:'), 'preload must expose setInterfaceOpacity');
  assert.ok(preload.includes('onUpdateProgress:'), 'preload must expose onUpdateProgress');
  assert.ok(preload.includes('onUpdateDownloaded:'), 'preload must expose onUpdateDownloaded');
});

test('App Updates & Polish: main.js implements IPC channels and config persistence for updates & disguise', () => {
  const main = fs.readFileSync(mainJsPath, 'utf8');

  // IPC handlers
  assert.ok(main.includes("'rtai:get-app-version'"), 'main.js must handle rtai:get-app-version');
  assert.ok(main.includes("'rtai:check-update'"), 'main.js must handle rtai:check-update');
  assert.ok(main.includes("'rtai:download-update'"), 'main.js must handle rtai:download-update');
  assert.ok(main.includes("'rtai:install-update'"), 'main.js must handle rtai:install-update');
  assert.ok(main.includes("'rtai:set-process-disguise'"), 'main.js must handle rtai:set-process-disguise');
  assert.ok(main.includes("'rtai:set-interface-opacity'"), 'main.js must handle rtai:set-interface-opacity');

  // Config INI schema handling
  assert.ok(main.includes('auto_update'), 'main.js must handle auto_update in config');
  assert.ok(main.includes('process_disguise'), 'main.js must handle process_disguise in config');
  assert.ok(main.includes('interface_opacity'), 'main.js must handle interface_opacity in config');
});

test('App Updates & Polish: update actions call the updater and reflect its answer', async () => {
  const { Cue, S, called } = loadRenderer({
    api: { checkUpdate: async () => ({ status: 'available', latestVersion: '2.5.0' }) }
  });
  Cue.state.route = { view: 'settings', parts: ['updates'] };
  await Cue.actions['update-check']();
  assert.strictEqual(called('checkUpdate').length, 1);
  assert.strictEqual(S.update.status, 'available', 'the updater answer replaces the "checking" state');

  await Cue.actions['update-download']();
  assert.strictEqual(called('downloadUpdate').length, 1);
  assert.strictEqual(S.update.status, 'downloading');

  await Cue.actions['update-install']();
  assert.strictEqual(called('installUpdate').length, 1);
});
