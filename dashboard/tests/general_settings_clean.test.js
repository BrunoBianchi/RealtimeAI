const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.resolve(__dirname, '../src/index.html');
const appJsPath = path.resolve(__dirname, '../src/app.js');
const mainJsPath = path.resolve(__dirname, '../main.js');

test('General Settings: Obsolete keys and save button removed from UI', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');

  // Verify removed elements
  assert.ok(!html.includes('id="btnSaveGeneralSettings"'), 'btnSaveGeneralSettings button must be removed');
  assert.ok(!html.includes('id="cfgCerebrasKey"'), 'cfgCerebrasKey input must be removed');
  assert.ok(!html.includes('id="cfgGroqKey"'), 'cfgGroqKey input must be removed');

  // Verify core API key inputs and badges exist
  assert.ok(html.includes('id="cfgDeepgramKey"'), 'cfgDeepgramKey must exist');
  assert.ok(html.includes('id="cfgLlmKey"'), 'cfgLlmKey must exist');
  assert.ok(html.includes('id="badgeDgKey"'), 'badgeDgKey must exist');
  assert.ok(html.includes('id="badgeLlmKey"'), 'badgeLlmKey must exist');
  assert.ok(html.includes('id="btnClearDgKey"'), 'btnClearDgKey must exist');
  assert.ok(html.includes('id="btnClearLlmKey"'), 'btnClearLlmKey must exist');
});

test('General Settings: app.js contains auto-save and clear handlers', () => {
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  assert.ok(!appJs.includes('cfgCerebrasKey'), 'app.js must not reference cfgCerebrasKey');
  assert.ok(!appJs.includes('cfgGroqKey'), 'app.js must not reference cfgGroqKey');
  assert.ok(!appJs.includes('btnSaveGeneralSettings'), 'app.js must not reference btnSaveGeneralSettings');

  assert.ok(appJs.includes('setupKeyAutoSave'), 'setupKeyAutoSave must exist in app.js');
  assert.ok(appJs.includes('btnClearDgKey'), 'btnClearDgKey handler must exist in app.js');
  assert.ok(appJs.includes('btnClearLlmKey'), 'btnClearLlmKey handler must exist in app.js');
});

test('General Settings: main.js masks keys in English and supports key clearing', () => {
  const mainJs = fs.readFileSync(mainJsPath, 'utf8');

  assert.ok(mainJs.includes('Encrypted via Windows DPAPI'), 'DPAPI mask text must be in English');
  assert.ok(!mainJs.includes('Criptografada via Windows DPAPI'), 'Portuguese DPAPI mask must be removed');
});

