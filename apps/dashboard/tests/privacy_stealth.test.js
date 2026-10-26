const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.resolve(__dirname, '../src/renderer/index.html');
const appJsPath = path.resolve(__dirname, '../src/renderer/app.js');
const mainJsPath = path.resolve(__dirname, '../src/main/main.js');

test('Privacy & Stealth: HTML contains all 4 functional toggles and badge', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');

  // Verify badge
  assert.ok(html.includes('id="badgeStealthStatus"'), 'badgeStealthStatus element must exist');

  // Verify all 4 toggles exist with correct IDs
  assert.ok(html.includes('id="cfgStealthDock"'), 'cfgStealthDock checkbox must exist');
  assert.ok(html.includes('id="cfgStealthActivityMonitor"'), 'cfgStealthActivityMonitor checkbox must exist');
  assert.ok(html.includes('id="cfgStealthClickThrough"'), 'cfgStealthClickThrough checkbox must exist');
  assert.ok(html.includes('id="cfgStealthScreenCapture"'), 'cfgStealthScreenCapture checkbox must exist');

  // Verify labels are clickable (<label ...>)
  for (const id of ['cfgStealthDock', 'cfgStealthActivityMonitor', 'cfgStealthClickThrough', 'cfgStealthScreenCapture']) {
    const re = new RegExp(`<label[^>]*>(?:(?!</label>)[\\s\\S])*id="${id}"`);
    assert.ok(re.test(html), `${id} must be wrapped in a clickable <label>`);
  }

  // Verify brand integrity: no third-party names
  assert.ok(!html.includes('InterviewCoder'), 'Must not contain third party brand InterviewCoder');
  assert.ok(html.includes('RealTimeAI'), 'Must refer to RealTimeAI in description');
});

test('Privacy & Stealth: app.js contains handlers and dynamic badge updater', () => {
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  assert.ok(appJs.includes('updateStealthBadge'), 'updateStealthBadge function must exist in app.js');
  assert.ok(appJs.includes('cfgStealthDock'), 'app.js must attach listener to cfgStealthDock');
  assert.ok(appJs.includes('cfgStealthActivityMonitor'), 'app.js must attach listener to cfgStealthActivityMonitor');
  assert.ok(appJs.includes('cfgStealthClickThrough'), 'app.js must attach listener to cfgStealthClickThrough');
  assert.ok(appJs.includes('cfgStealthScreenCapture'), 'app.js must attach listener to cfgStealthScreenCapture');
  assert.ok(appJs.includes('handleSettingToggle'), 'app.js must have auto-save toggle handler');
});

test('Privacy & Stealth: main.js reads, writes, and syncs stealth settings', () => {
  const mainJs = fs.readFileSync(mainJsPath, 'utf8');

  assert.ok(mainJs.includes('stealth_dock'), 'main.js must handle stealth_dock');
  assert.ok(mainJs.includes('stealth_activity_monitor'), 'main.js must handle stealth_activity_monitor');
  assert.ok(mainJs.includes('stealth_click_through'), 'main.js must handle stealth_click_through');
  assert.ok(mainJs.includes('stealth_screen_capture'), 'main.js must handle stealth_screen_capture');
  assert.ok(mainJs.includes('[stealth]'), 'main.js writeConfigIni must output [stealth] section');
});

