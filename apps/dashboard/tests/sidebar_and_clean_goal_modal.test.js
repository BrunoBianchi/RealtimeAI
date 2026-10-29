const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.resolve(__dirname, '../src/renderer/index.html');
const appJsPath = path.resolve(__dirname, '../src/renderer/app.js');
const tailwindCssPath = path.resolve(__dirname, '../src/renderer/tailwind.input.css');

test('Clean Sidebar & Compact Plan Sizing (User Feedback Fidelity)', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');
  const css = fs.readFileSync(tailwindCssPath, 'utf8');

  // Sidebar compact width
  assert.ok(html.includes('w-[230px]'), 'Sidebar must have compact width w-[230px]');

  // New goal standout button styling (Image 2)
  assert.ok(html.includes('id="btnNewGoal"'), 'Must have btnNewGoal in sidebar');
  assert.ok(html.includes('rounded-full bg-white text-zinc-950'), 'btnNewGoal must have prominent white pill styling');

  // Compact Equalizer ticks (height reduced from h-5 to h-3, teal #00D29E)
  assert.ok(appJs.includes("tick.className = 'w-[2.5px] h-3 rounded-full"), 'Ticks must use compact height h-3');
  assert.ok(appJs.includes('#00D29E'), 'Ticks must use signature teal #00D29E for Pro');

  // Plan card compactness
  assert.ok(html.includes('id="sidebarUsageCard"'), 'Must have sidebarUsageCard');
  assert.ok(html.includes('id="sidebarUsageProTag"'), 'Must have sidebarUsageProTag');
  assert.ok(html.includes('text-[12px] font-bold tracking-tight text-foreground'), 'Usage title must use compact typography');

  // Sidebar navigation and goal items classes
  assert.ok(css.includes('.sh-nav-item'), 'Must define .sh-nav-item');
  assert.ok(css.includes('py-1.5 text-[12px]'), 'Nav items must use compact py-1.5 text-[12px]');
  assert.ok(css.includes('.sh-goal-item'), 'Must define .sh-goal-item');
});

test('Easy & Beautiful Goal Creation & Modal Fidelity (Image 3)', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  // Modal header & quick setup
  assert.ok(html.includes('id="goalModalTitle"'), 'Must have goalModalTitle');
  assert.ok(html.includes('id="goalModalBadge"'), 'Must have goalModalBadge');
  assert.ok(html.includes('id="goalModalSubtitle"'), 'Must have goalModalSubtitle');

  // Key inputs & auto-research
  assert.ok(html.includes('id="inputModalRole"'), 'Must have inputModalRole');
  assert.ok(html.includes('id="inputModalCompany"'), 'Must have inputModalCompany');
  assert.ok(html.includes('id="btnGoalModalCompanyRecon"'), 'Must have btnGoalModalCompanyRecon');

  // Image 3 fidelity: Attached Files & Custom Instructions
  assert.ok(html.includes('Attached Files (RAG)'), 'Must have Attached Files (RAG) label');
  assert.ok(html.includes('id="btnModalUploadFiles"'), 'Must have btnModalUploadFiles');
  assert.ok(html.includes('id="modalGoalDocsList"'), 'Must have modalGoalDocsList');
  assert.ok(html.includes('Custom Instructions &amp; Company Dossier'), 'Must have Custom Instructions & Company Dossier section');
  assert.ok(html.includes('id="inputModalExtraInstructions"'), 'Must have inputModalExtraInstructions');
  assert.ok(html.includes('id="inputModalCompanyResearch"'), 'Must have inputModalCompanyResearch');

  // Fast creation logic in app.js
  assert.ok(appJs.includes('isNew ? \'New goal\' : \'Configure Goal\''), 'app.js must dynamically set New goal title');
  assert.ok(appJs.includes('roleInput.focus()'), 'app.js must auto-focus role input when opened');
  assert.ok(appJs.includes('handleGoalEnterKey'), 'app.js must support Enter key shortcut for instant save');
});
