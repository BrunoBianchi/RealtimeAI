const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.resolve(__dirname, '../src/renderer/index.html');
const appJsPath = path.resolve(__dirname, '../src/renderer/app.js');
const mainJsPath = path.resolve(__dirname, '../src/main/main.js');
const preloadJsPath = path.resolve(__dirname, '../src/preload/preload.js');

test('Electron Stealth Mode: HTML contains header controls and settings panel', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');

  // Top header stealth button & indicators
  assert.ok(html.includes('id="btnTopStealthMode"'), 'btnTopStealthMode button must exist in header');
  assert.ok(html.includes('id="labelTopStealth"'), 'labelTopStealth label must exist in header');
  assert.ok(html.includes('id="indicatorTopStealth"'), 'indicatorTopStealth indicator dot must exist in header');
  assert.ok(html.includes('id="iconStealthShield"'), 'iconStealthShield SVG icon must exist in header');

  // Privacy & Stealth tab: Electron stealth controls
  assert.ok(html.includes('id="badgeElectronStealth"'), 'badgeElectronStealth status badge must exist');
  assert.ok(html.includes('id="btnQuickToggleStealth"'), 'btnQuickToggleStealth quick toggle button must exist');
  assert.ok(html.includes('id="cfgElectronScreenProtection"'), 'cfgElectronScreenProtection checkbox must exist');
  assert.ok(html.includes('id="cfgElectronSkipTaskbar"'), 'cfgElectronSkipTaskbar checkbox must exist');
  assert.ok(html.includes('id="cfgElectronDisguise"'), 'cfgElectronDisguise checkbox must exist');

  // Checkboxes must be wrapped in clickable labels
  for (const id of ['cfgElectronScreenProtection', 'cfgElectronSkipTaskbar', 'cfgElectronDisguise']) {
    const re = new RegExp(`<label[^>]*>(?:(?!</label>)[\\s\\S])*id="${id}"`);
    assert.ok(re.test(html), `${id} must be wrapped in a clickable <label>`);
  }

  // Global hotkeys indicators
  assert.ok(html.includes('Ctrl + Alt + S'), 'Must indicate Ctrl + Alt + S shortcut');
  assert.ok(html.includes('Ctrl + Shift + H'), 'Must indicate Ctrl + Shift + H shortcut');
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

test('Electron Stealth Mode: app.js contains UI updater and event listeners', () => {
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  assert.ok(appJs.includes('updateStealthUI'), 'app.js must define updateStealthUI');
  assert.ok(appJs.includes('btnTopStealthMode'), 'app.js must attach click listener to btnTopStealthMode');
  assert.ok(appJs.includes('btnQuickToggleStealth'), 'app.js must attach click listener to btnQuickToggleStealth');
  assert.ok(appJs.includes('cfgElectronScreenProtection'), 'app.js must handle cfgElectronScreenProtection');
  assert.ok(appJs.includes('cfgElectronSkipTaskbar'), 'app.js must handle cfgElectronSkipTaskbar');
  assert.ok(appJs.includes('cfgElectronDisguise'), 'app.js must handle cfgElectronDisguise');
  assert.ok(appJs.includes('onStealthModeUpdated'), 'app.js must listen for onStealthModeUpdated');
});
