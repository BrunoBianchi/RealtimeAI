const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadRenderer, render, el, tags } = require('./helpers/renderer');

const preloadJsPath = path.resolve(__dirname, '../src/preload/preload.js');
const mainJsPath = path.resolve(__dirname, '../src/main/main.js');

test('Task 9.1: Preload API exports setMode, onModeChanged, and onSessionSummary', () => {
  const preload = fs.readFileSync(preloadJsPath, 'utf8');
  assert.ok(
    preload.includes("setMode:"),
    'preload.js must expose setMode'
  );
  assert.ok(
    preload.includes("onModeChanged:"),
    'preload.js must expose onModeChanged'
  );
  assert.ok(
    preload.includes("onSessionSummary:"),
    'preload.js must expose onSessionSummary'
  );
  assert.ok(
    preload.includes("'rtai:set-mode'"),
    'setMode must invoke rtai:set-mode channel'
  );
  assert.ok(
    preload.includes("'rtai:mode'"),
    'onModeChanged must listen on rtai:mode channel'
  );
  assert.ok(
    preload.includes("'rtai:summary'"),
    'onSessionSummary must listen on rtai:summary channel'
  );
});

test('Task 9.2: Main process IPC registration and stdout JSON forwarding', () => {
  const mainJs = fs.readFileSync(mainJsPath, 'utf8');
  assert.ok(
    mainJs.includes("'rtai:set-mode'"),
    "main.js must register ipcMain.handle('rtai:set-mode')"
  );
  assert.ok(
    mainJs.includes('set_mode'),
    "main.js must send cmd 'set_mode' to core process stdin"
  );
  assert.ok(
    mainJs.includes("'rtai:mode'"),
    "main.js must forward mode events as 'rtai:mode'"
  );
  assert.ok(
    mainJs.includes("'rtai:summary'"),
    "main.js must forward summary events as 'rtai:summary'"
  );
  assert.ok(
    mainJs.includes("'--server'"),
    "main.js must pass '--server' in args when spawning core"
  );
});

test('Task 9.3: UI presence for Transcription Only toggle and Session Summary modal', () => {
  // The toggle lives in the live view, disabled until the copilot runs.
  const view = (running, on) => {
    const { Cue } = loadRenderer({ state: { overlayStatus: { running, mode: 'live', agentId: '' } } });
    Cue.state.live.transcriptionOnly = on;
    return tags(render(Cue, 'live'), { 'data-change': 'live-mode' })[0];
  };
  const stopped = view(false, false);
  assert.ok(stopped && 'disabled' in stopped, 'disabled while the copilot is stopped');
  const running = view(true, true);
  assert.ok(!('disabled' in running) && 'checked' in running, 'on while the engine reports transcription-only');

  // Summary dialog: rendered Markdown, the exported file and a way to the history.
  const r = loadRenderer({ state: { agents: [{ id: 'a1', company: 'Nubank' }], activeAgentId: 'a1' } });
  r.Cue.openModal('summary', { ok: true, text: '## Resumo\n- Falou de **Kafka**', export_path: 'C:/RealTimeAI/sessions/s1.md' });
  const html = r.modals.last;
  assert.ok(html.includes('Resumo da sessão') && html.includes('<strong>Kafka</strong>'));
  assert.ok(html.includes('data-action="open-path" data-path="C:/RealTimeAI/sessions/s1.md"'), 'opens the exported file');
  assert.ok(html.includes('id="smDebrief"'), 'can save a debrief to the session');
  assert.ok(/data-to="sessions\/past"/.test(html), 'goes to the history');
});

test('Feature: transcription-only-mode, Property 1: Toggle solicita o valor oposto ao espelho sem mutação local', async () => {
  for (const mirror of [false, true]) {
    const r = loadRenderer({ api: { setMode: async () => ({ ok: true }) } });
    r.S.live.transcriptionOnly = mirror;
    // The checkbox flips first (browser), the handler asks the engine for it.
    await r.Cue.changes['live-mode'](el({}, { checked: !mirror }));
    assert.deepStrictEqual(r.called('setMode'), [[!mirror]]);
    assert.strictEqual(r.S.live.transcriptionOnly, mirror, 'the mirror waits for the engine to confirm');
  }
  // The engine refuses (not running): the checkbox goes back.
  const r = loadRenderer({ api: { setMode: async () => ({ ok: false, error: 'O copiloto não está rodando.' }) } });
  const box = el({}, { checked: true });
  await r.Cue.changes['live-mode'](box);
  assert.strictEqual(box.checked, false);
  assert.deepStrictEqual(r.toasts(), [{ text: 'O copiloto não está rodando.', error: true }]);
});

test('Feature: transcription-only-mode, Property 2: O espelho segue a última republicação recebida', async () => {
  const r = loadRenderer();
  await r.boot();
  const [onMode] = r.calls.find(([n]) => n === 'onModeChanged')[1];
  const seq = [true, false, false, true, 1, 0, 'x'];
  for (const v of seq) {
    onMode(v);
    assert.strictEqual(r.S.live.transcriptionOnly, Boolean(v));
  }
});

test('Feature: transcription-only-mode, Requirements 5.4, 5.5: Comportamento de onSessionSummary', async () => {
  const r = loadRenderer();
  await r.boot();
  const [onSummary] = r.calls.find(([n]) => n === 'onSessionSummary')[1];

  onSummary(null);
  onSummary({ ok: false, text: '', export_path: 'C:/fake/path.txt' });
  assert.deepStrictEqual(r.toasts(), [{ text: 'O resumo não pôde ser gerado; a transcrição foi salva.', error: true }]);
  assert.strictEqual(r.dialogs.length, 0, 'no dialog for a failed summary');

  onSummary({ ok: true, text: '## Resumo da Sessão', export_path: 'C:/fake/path.txt' });
  assert.strictEqual(r.dialogs.length, 1);
  assert.ok(r.modals.last.includes('Resumo da Sessão'));
});
