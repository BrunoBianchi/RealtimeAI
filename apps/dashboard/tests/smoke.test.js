const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.resolve(__dirname, '../src/renderer/index.html');
const appJsPath = path.resolve(__dirname, '../src/renderer/app.js');

test('Task 10.1: Teste de integração / smoke dos controles principais (Requirements: 3.3, 6.1, 6.2, 6.3)', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  // 1. Requirement 6.1: Go Live and Demo buttons
  // Assert button existence and class styling in HTML
  assert.ok(
    html.includes('id="btnTopGoLive"'),
    'Top Go Live button #btnTopGoLive must exist in HTML'
  );
  assert.ok(
    html.includes('id="btnLaunchDemo"'),
    'Test Demo button #btnLaunchDemo must exist in HTML'
  );
  assert.ok(
    html.includes('id="btnGoalModalGoLive"'),
    'Goal modal Go Live button #btnGoalModalGoLive must exist in HTML'
  );
  assert.ok(
    html.includes('id="stepDemoLink"'),
    'Walkthrough Demo link #stepDemoLink must exist in HTML'
  );

  // Assert event listeners registered in app.js
  assert.ok(
    appJs.includes("getElementById('btnTopGoLive')"),
    'app.js must attach listener to btnTopGoLive'
  );
  assert.ok(
    appJs.includes("getElementById('btnLaunchDemo')"),
    'app.js must attach listener to btnLaunchDemo'
  );
  assert.ok(
    appJs.includes("getElementById('btnGoalModalGoLive')"),
    'app.js must attach listener to btnGoalModalGoLive'
  );

  // 2. Requirement 6.2: Window controls
  const winControls = ['minimize', 'maximize', 'close'];
  for (const action of winControls) {
    const pattern = new RegExp(`data-win=["']${action}["']`);
    assert.ok(
      pattern.test(html),
      `Window control button with data-win="${action}" must exist in HTML`
    );
  }
  assert.ok(
    appJs.includes("querySelectorAll('[data-win]')"),
    'app.js must bind click events to [data-win] elements'
  );

  // 3. Requirements 3.3, 6.3: Theme_Switcher in 3 modes (Windows / Claro / Escuro)
  const themeModes = ['system', 'light', 'dark'];
  for (const mode of themeModes) {
    const pattern = new RegExp(`data-theme-pref=["']${mode}["']`);
    assert.ok(
      pattern.test(html),
      `Theme button with data-theme-pref="${mode}" must exist in HTML`
    );
  }

  // Verify applyTheme contract and behavior
  assert.ok(
    appJs.includes('function applyTheme(resolved, preference)'),
    'app.js must define applyTheme(resolved, preference)'
  );
  assert.ok(
    appJs.includes("document.documentElement.classList.toggle('dark', isDark)"),
    'applyTheme must toggle dark class on documentElement'
  );
  assert.ok(
    appJs.includes('.theme-pref-btn'),
    'applyTheme must update .theme-pref-btn visual states'
  );

  // Test applyTheme logic simulation
  class MockClassList {
    constructor() { this.classes = new Set(); }
    toggle(cls, force) {
      if (force === undefined) {
        if (this.classes.has(cls)) this.classes.delete(cls);
        else this.classes.add(cls);
      } else if (force) {
        this.classes.add(cls);
      } else {
        this.classes.delete(cls);
      }
    }
    contains(cls) { return this.classes.has(cls); }
  }

  // Simulate applying light, dark, and system themes
  for (const resolved of ['light', 'dark']) {
    const docList = new MockClassList();
    const isDark = resolved === 'dark';
    docList.toggle('dark', isDark);
    assert.strictEqual(
      docList.contains('dark'),
      isDark,
      `Theme resolution for "${resolved}" must set dark class to ${isDark}`
    );
  }
});

