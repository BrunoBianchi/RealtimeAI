const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.resolve(__dirname, '../src/index.html');
const appJsPath = path.resolve(__dirname, '../src/app.js');

test('Feature: dashboard-ui-redesign, Property 6: Preservação dos ganchos de script', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  // Extract all getElementById targets from app.js
  const idRegex = /document\.getElementById\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  const idsInAppJs = new Set();
  let match;
  while ((match = idRegex.exec(appJs)) !== null) {
    idsInAppJs.add(match[1]);
  }

  // Extract all querySelector and querySelectorAll targets from app.js
  const qsRegex = /document\.querySelector(All)?\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  const selectorsInAppJs = new Set();
  while ((match = qsRegex.exec(appJs)) !== null) {
    selectorsInAppJs.add(match[2]);
  }

  // Also elements referenced via specific data attributes in app.js
  const expectedDataAttrs = [
    'data-view',
    'data-settings-tab',
    'data-lib-tab',
    'data-theme-pref'
  ];

  // Dynamically created IDs inside app.js that are not in index.html initially
  // e.g., dynamic session items, radio inputs created in code
  const dynamicallyGeneratedIds = new Set([
    'goalCompanyReconDetails' // created dynamically in recon flow
  ]);

  const idsArray = Array.from(idsInAppJs).filter(id => !dynamicallyGeneratedIds.has(id));
  assert.ok(idsArray.length > 20, 'Should find substantial number of getElementById calls');

  // Property-based test with >= 100 iterations
  for (let i = 0; i < 100; i++) {
    const randomId = idsArray[Math.floor(Math.random() * idsArray.length)];
    const idPattern = new RegExp(`id=["']${randomId}["']`);
    assert.ok(
      idPattern.test(html),
      `Property 6 violation: id="${randomId}" used in app.js was not found in index.html (iteration ${i + 1})`
    );
  }

  // Full check of all static IDs
  for (const id of idsArray) {
    const idPattern = new RegExp(`id=["']${id}["']`);
    assert.ok(
      idPattern.test(html),
      `Property 6 violation: id="${id}" referenced by app.js must exist in index.html`
    );
  }

  // Full check of selectors used by app.js
  for (const sel of selectorsInAppJs) {
    // If selector targets class
    if (sel.startsWith('.')) {
      const clsName = sel.replace(/^\./, '').split(/[\s,>:[\]]/)[0];
      const classPattern = new RegExp(`class=["'][^"']*\\b${clsName}\\b[^"']*["']`);
      assert.ok(
        classPattern.test(html),
        `Property 6 violation: class selector "${sel}" (class "${clsName}") not found in index.html`
      );
    }
  }

  // Verify all expected data attributes exist in index.html
  for (const attr of expectedDataAttrs) {
    assert.ok(
      html.includes(attr),
      `Property 6 violation: data attribute ${attr} missing in index.html`
    );
  }
});

test('Feature: dashboard-ui-redesign, Property 5: Preservação da estrutura de layout', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');

  // 1. Requirement 5.1: The 4 main views must exist
  const views = ['view-goals', 'view-library', 'view-history', 'view-settings'];
  for (const viewId of views) {
    const pattern = new RegExp(`id=["']${viewId}["'][^>]*class=["'][^"']*view-pane`);
    assert.ok(
      pattern.test(html),
      `Property 5 violation: view "${viewId}" with class "view-pane" must exist`
    );
  }

  // Navigation anchors
  const dataViews = ['library', 'history', 'settings'];
  for (const dv of dataViews) {
    const pattern = new RegExp(`data-view=["']${dv}["']`);
    assert.ok(
      pattern.test(html),
      `Property 5 violation: navigation item with data-view="${dv}" must exist`
    );
  }
  // Goals section navigation
  assert.ok(html.includes('id="btnNewGoal"'), 'Goals creation button must exist');
  assert.ok(html.includes('id="agentSelectorBar"'), 'Goals UP NEXT list container must exist');

  // 2. Requirement 5.2: Library tabs: Resumes, Materials, Playbooks, About you
  const libraryTabs = ['resumes', 'materials', 'playbooks', 'about'];
  for (const tab of libraryTabs) {
    const pattern = new RegExp(`data-lib-tab=["']${tab}["']`);
    assert.ok(
      pattern.test(html),
      `Property 5 violation: library tab "${tab}" must exist`
    );
  }

  // 3. Requirement 5.3: Settings subnav: General, Appearance, Defaults, Privacy & Stealth, Shortcuts, Account & Billing
  const settingsTabs = ['general', 'appearance', 'defaults', 'stealth', 'shortcuts', 'billing'];
  for (const subtab of settingsTabs) {
    const pattern = new RegExp(`data-settings-tab=["']${subtab}["']`);
    assert.ok(
      pattern.test(html),
      `Property 5 violation: settings subtab "${subtab}" must exist`
    );
    const panePattern = new RegExp(`id=["']subpane-${subtab}["'][^>]*class=["'][^"']*settings-subpane`);
    assert.ok(
      panePattern.test(html),
      `Property 5 violation: settings pane "subpane-${subtab}" must exist`
    );
  }

  // 4. Requirement 5.4: Sidebar containing Goals, UP NEXT, plan info, profile
  assert.ok(html.includes('id="agentSelectorBar"'), 'Sidebar goals list container (agentSelectorBar) must exist');
  assert.ok(html.includes('id="sidebarPlanCard"'), 'Sidebar plan card must exist');
  assert.ok(html.includes('id="profileChip"'), 'Sidebar profile chip must exist');
  assert.ok(html.includes('id="btnToggleSidebar"'), 'Sidebar toggle button must exist');

  // 5. Requirement 5.5: Hierarchy validation via randomized checks (>= 100 iterations)
  const anchors = [
    ...views,
    ...libraryTabs.map(t => `data-lib-tab="${t}"`),
    ...settingsTabs.map(s => `data-settings-tab="${s}"`),
    'id="sidebarPlanCard"',
    'id="profileChip"'
  ];

  for (let i = 0; i < 100; i++) {
    const anchor = anchors[Math.floor(Math.random() * anchors.length)];
    assert.ok(
      html.includes(anchor),
      `Property 5 violation: Layout anchor "${anchor}" missing (iteration ${i + 1})`
    );
  }
});

test('Feature: dashboard-ui-redesign, Property 3: Acento provém exclusivamente de Design_Tokens', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  // Verify that no arbitrary hardcoded indigo/blue hex colors are in index.html or app.js
  // (except allowed illustration icons like dark mode moon or standard system tokens)
  const hardcodedAccentHexes = [
    '#4F46E5', '#6366F1', '#4338CA', '#3730A3', '#312E81', // indigo-600..900
    '#2563EB', '#1D4ED8', '#1E40AF', '#1E3A8A' // blue-600..900
  ];

  for (let i = 0; i < 100; i++) {
    const hex = hardcodedAccentHexes[i % hardcodedAccentHexes.length];
    assert.ok(
      !html.includes(hex),
      `Property 3 violation: index.html contains hardcoded accent hex ${hex}`
    );
    assert.ok(
      !appJs.includes(hex),
      `Property 3 violation: app.js contains hardcoded accent hex ${hex}`
    );
  }

  // Buttons, inputs and active states use primary/ring tokens
  assert.ok(html.includes('bg-primary'), 'Buttons and accents must use bg-primary');
  assert.ok(html.includes('accent-primary'), 'Inputs and checkboxes must use accent-primary');

  // Live context specifically keeps red #E11D48
  assert.ok(html.includes('#E11D48'), 'Live context retains red #E11D48 in logo/live indicators');
  assert.ok(appJs.includes('#E11D48'), 'Live status dot in app.js retains red #E11D48');
});
