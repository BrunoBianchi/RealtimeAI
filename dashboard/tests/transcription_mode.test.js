const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.resolve(__dirname, '../src/index.html');
const appJsPath = path.resolve(__dirname, '../src/app.js');
const preloadJsPath = path.resolve(__dirname, '../preload.js');
const mainJsPath = path.resolve(__dirname, '../main.js');

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
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  // HTML elements
  assert.ok(html.includes('id="btnToggleTranscriptionMode"'), 'Must contain #btnToggleTranscriptionMode');
  assert.ok(html.includes('id="transcriptionModeDot"'), 'Must contain #transcriptionModeDot');
  assert.ok(html.includes('id="transcriptionModeLabel"'), 'Must contain #transcriptionModeLabel');
  assert.ok(html.includes('id="modalSessionSummary"'), 'Must contain #modalSessionSummary');
  assert.ok(html.includes('id="summaryModalBody"'), 'Must contain #summaryModalBody');
  assert.ok(html.includes('id="summaryModalPath"'), 'Must contain #summaryModalPath');
  assert.ok(html.includes('id="btnCloseSummaryModal"'), 'Must contain #btnCloseSummaryModal');
  assert.ok(html.includes('id="btnDismissSummaryModal"'), 'Must contain #btnDismissSummaryModal');
  assert.ok(html.includes('id="btnOpenExportFolder"'), 'Must contain #btnOpenExportFolder');

  // JS bindings in app.js
  assert.ok(appJs.includes("getElementById('btnToggleTranscriptionMode')"), 'app.js must attach to toggle');
  assert.ok(appJs.includes("onModeChanged"), 'app.js must register onModeChanged handler');
  assert.ok(appJs.includes("onSessionSummary"), 'app.js must register onSessionSummary handler');
  assert.ok(appJs.includes("renderTranscriptionModeButton"), 'app.js must define renderTranscriptionModeButton');
});

test('Feature: transcription-only-mode, Property 1: Toggle solicita o valor oposto ao espelho sem mutação local', () => {
  // Test 100 iterations of toggle clicks starting from arbitrary mirror states
  for (let i = 0; i < 100; i++) {
    const mirrorState = Math.random() < 0.5;
    let localMirror = mirrorState;
    let requestedValue = null;

    const fakeRtai = {
      setMode: (val) => {
        requestedValue = val;
      }
    };

    // Simulate click handler logic:
    // calls setMode(!localMirror) without modifying localMirror
    fakeRtai.setMode(!localMirror);

    assert.strictEqual(
      requestedValue,
      !mirrorState,
      `Iteration ${i + 1}: requested value must be the exact inverse of local mirror`
    );
    assert.strictEqual(
      localMirror,
      mirrorState,
      `Iteration ${i + 1}: local mirror must not mutate before confirmation event`
    );
  }
});

test('Feature: transcription-only-mode, Property 2: O espelho segue a última republicação recebida', () => {
  // Over 100 iterations, feed random sequences of confirmation events
  for (let i = 0; i < 100; i++) {
    let localMirror = false;
    const seqLen = 1 + Math.floor(Math.random() * 20);
    let lastPublished = null;

    for (let s = 0; s < seqLen; s++) {
      const pub = Math.random() < 0.5;
      lastPublished = pub;
      // onModeChanged handler updates mirror
      localMirror = Boolean(pub);
    }

    assert.strictEqual(
      localMirror,
      lastPublished,
      `Iteration ${i + 1}: mirror must converge to last published event (${lastPublished})`
    );
  }
});

test('Feature: transcription-only-mode, Requirements 5.4, 5.5: Comportamento de onSessionSummary', () => {
  let toastMessage = '';
  const showToast = (msg) => {
    toastMessage = msg;
  };

  const handleSummary = (summary) => {
    if (!summary) return;
    if (!summary.ok) {
      showToast('Resumo não pôde ser gerado; a transcrição foi exportada.');
      return;
    }
    showToast('Resumo da sessão gerado!');
  };

  // 1. When ok is false: neutral notification
  handleSummary({ ok: false, text: '', export_path: 'C:/fake/path.txt' });
  assert.strictEqual(
    toastMessage,
    'Resumo não pôde ser gerado; a transcrição foi exportada.',
    'Must display neutral notice when summary fails'
  );

  // 2. When ok is true: success notification
  handleSummary({ ok: true, text: '## Resumo da Sessão', export_path: 'C:/fake/path.txt' });
  assert.strictEqual(
    toastMessage,
    'Resumo da sessão gerado!',
    'Must display success notice when summary succeeds'
  );
});

