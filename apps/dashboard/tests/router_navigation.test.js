const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.resolve(__dirname, '../src/renderer/index.html');
const appJsPath = path.resolve(__dirname, '../src/renderer/app.js');

test('Client-side Router: app.js defines router and routes', () => {
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  assert.ok(appJs.includes('const router = {'), 'app.js must declare router');
  assert.ok(appJs.includes('window.router = router;'), 'router must be exposed on window');
  assert.ok(appJs.includes('navigate(path'), 'router must have navigate function');
  assert.ok(appJs.includes('handleRoute()'), 'router must have handleRoute function');
  assert.ok(appJs.includes('getCurrentRoute()'), 'router must have getCurrentRoute function');

  // Route patterns supported
  assert.ok(appJs.includes("root === 'goals'"), 'router must support /goals route');
  assert.ok(appJs.includes("root === 'goal'"), 'router must support /goal/:id/:tab route');
  assert.ok(appJs.includes("root === 'library'"), 'router must support /library route');
  assert.ok(appJs.includes("root === 'history'"), 'router must support /history route');
  assert.ok(appJs.includes("root === 'settings'"), 'router must support /settings route');

  // History & hash listener
  assert.ok(appJs.includes("window.addEventListener('hashchange'"), 'app.js must listen to hashchange');
  assert.ok(appJs.includes("window.addEventListener('popstate'"), 'app.js must listen to popstate');
});

test('Prep Session & Goal Workspace Navigation: Buttons and Tab Routes', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  // Button Continue prep on Image 2 warm card
  assert.ok(html.includes('id="btnOverviewContinuePrep"'), 'index.html must have btnOverviewContinuePrep');
  assert.ok(appJs.includes("getElementById('btnOverviewContinuePrep')"), 'app.js must wire btnOverviewContinuePrep');
  assert.ok(appJs.includes("'/prep'"), 'Continue prep button must route to /prep');

  // Back button and tabs
  assert.ok(html.includes('id="btnWorkspaceBackToGoals"'), 'index.html must have btnWorkspaceBackToGoals');
  assert.ok(appJs.includes("router.navigate('/goals')"), 'Back to Goals must navigate to /goals');
  assert.ok(appJs.includes("'/overview'"), 'Overview tab/card must route to /overview');
  assert.ok(appJs.includes("'/sessions'"), 'Sessions tab must route to /sessions');
});

test('Prep Session & Workspace UI Fidelity (Images 1, 2, 3, 4)', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');

  // Image 1: Breadcrumb and Help
  assert.ok(html.includes('id="btnWorkspaceHelp"'), 'Image 1 help button must exist');
  assert.ok(html.includes('id="workspaceBreadcrumbGoalName"'), 'Image 1 breadcrumb goal name must exist');

  // Image 2: Overview Warm Peach Card & Sections
  assert.ok(html.includes('NEXT FOCUS · EARLIER COMPLETED REFLECTIONS'), 'Image 2 warm card eyebrow must exist');
  assert.ok(html.includes('Next Focus appears only after reflection is committed to Goal Memory.'), 'Image 2 warm card text must exist');
  assert.ok(html.includes('id="linkHowPrepLoopWorks"'), 'Image 2 how prep loop works link must exist');
  assert.ok(html.includes('GOAL MEMORY'), 'Image 2 Goal Memory badge must exist');
  assert.ok(html.includes('id="overviewSessionsCountBadge"'), 'Image 2 sessions count badge must exist');
  assert.ok(html.includes('Goal context'), 'Image 2 Goal context card must exist');

  // Image 3: Future Sessions Banner & Goal Brief
  assert.ok(html.includes('FUTURE SESSIONS'), 'Image 3 future sessions eyebrow must exist');
  assert.ok(html.includes('id="btnPrepStartPractice"'), 'Image 3 Start Practice button must exist');
  assert.ok(html.includes('id="linkHowPracticeWorks"'), 'Image 3 how practice works link must exist');
  assert.ok(html.includes('id="prepNextFocusCard"'), 'Image 3 Next focus card must exist');
  assert.ok(html.includes('id="btnPrepEditBrief"'), 'Image 3 Edit Goal brief button must exist');

  // Image 4: Knowledge Sources & Response Defaults
  assert.ok(html.includes('id="btnPrepPinResume"'), 'Image 4 Pin a Goal resume button must exist');
  assert.ok(html.includes('id="btnPrepAddMaterial"'), 'Image 4 Attach from Library button must exist');
  assert.ok(html.includes('id="linkWhatPlaybookDoes"'), 'Image 4 what a playbook does link must exist');
  assert.ok(html.includes('id="selectPrepPlaybook"'), 'Image 4 selectPrepPlaybook must exist');
  assert.ok(html.includes('id="selectPrepAnswerLang"'), 'Image 4 selectPrepAnswerLang must exist');
  assert.ok(html.includes('id="selectPrepCodingLang"'), 'Image 4 selectPrepCodingLang must exist');
  assert.ok(html.includes('Preflight can override these for one Session without rewriting this Goal.'), 'Image 4 disclaimer subtext must exist');
});
