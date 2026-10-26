const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.resolve(__dirname, '../src/renderer/index.html');
const appJsPath = path.resolve(__dirname, '../src/renderer/app.js');
const preloadJsPath = path.resolve(__dirname, '../src/preload/preload.js');
const mainJsPath = path.resolve(__dirname, '../src/main/main.js');

test('Task 5.1 / Property 1: Estrutura HTML do Goal Workspace e 3 Abas (Requirements: 1.1, 1.2, 1.3)', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');

  // Verify workspace pane
  assert.ok(html.includes('id="view-goal-workspace"'), 'Goal Workspace pane must exist');
  assert.ok(html.includes('id="btnWorkspaceBackToGoals"'), 'Back to Goals breadcrumb must exist');
  assert.ok(html.includes('id="workspaceBreadcrumbGoalName"'), 'Goal title breadcrumb must exist');
  assert.ok(html.includes('id="btnWorkspaceGoLive"'), 'Go Live button in workspace must exist');

  // Verify the 3 tabs
  assert.ok(html.includes('id="tabGoalOverview"'), 'Overview tab button must exist');
  assert.ok(html.includes('id="tabGoalPrep"'), 'Prep tab button must exist');
  assert.ok(html.includes('id="tabGoalSessions"'), 'Sessions tab button must exist');

  // Verify the 3 tab panes
  assert.ok(html.includes('id="paneGoalOverview"'), 'Overview pane must exist');
  assert.ok(html.includes('id="paneGoalPrep"'), 'Prep pane must exist');
  assert.ok(html.includes('id="paneGoalSessions"'), 'Sessions pane must exist');

  // Verify stage update dropdown and scheduler trigger
  assert.ok(html.includes('id="btnUpdateProgress"'), 'Update progress dropdown must exist');
  assert.ok(html.includes('id="menuUpdateProgress"'), 'Update progress menu must exist');
  assert.ok(html.includes('id="btnOpenScheduler"'), 'Add interview date trigger must exist');
});

test('Task 5.1 / Property 2: Modais New Playbook e Interview Scheduler (Requirements: 2.1, 11.1, 16.1)', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');

  // New Playbook Modal (Image 5 fidelity)
  assert.ok(html.includes('id="modalNewPlaybook"'), 'New Playbook modal must exist');
  assert.ok(html.includes('id="inputPlaybookName"'), 'Playbook name input must exist');
  assert.ok(html.includes('id="btnPlaybookLenConcise"'), 'Concise length button must exist');
  assert.ok(html.includes('id="btnPlaybookLenBalanced"'), 'Balanced length button must exist');
  assert.ok(html.includes('id="btnPlaybookLenThorough"'), 'Thorough length button must exist');
  assert.ok(html.includes('id="selectPlaybookStructure"'), 'Behavioral structure select must exist');
  assert.ok(html.includes('id="togglePlaybookLeadAnswer"'), 'Lead with answer toggle must exist');
  assert.ok(html.includes('id="togglePlaybookTradeoffs"'), 'Name trade-offs toggle must exist');
  assert.ok(html.includes('id="btnSaveNewPlaybook"'), 'Save playbook button must exist');

  // Interview Scheduler Modal
  assert.ok(html.includes('id="modalInterviewScheduler"'), 'Interview Scheduler modal must exist');
  assert.ok(html.includes('id="inputInterviewDate"'), 'Date input must exist');
  assert.ok(html.includes('id="inputInterviewTime"'), 'Time input must exist');
  assert.ok(html.includes('id="btnSchedulerSkip"'), 'Skip for now button must exist');
  assert.ok(html.includes('id="btnSchedulerConfirm"'), 'Confirm schedule button must exist');
});

test('Task 5.1 / Property 3: Seções da Aba Overview e Goal Memory (Requirements: 4.1, 5.1, 6.1)', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');

  assert.ok(html.includes('id="overviewInterviewEmpty"'), 'Empty interview state must exist');
  assert.ok(html.includes('id="overviewInterviewScheduled"'), 'Scheduled interview state must exist');
  assert.ok(html.includes('id="overviewStatusResume"'), 'Goal context Resume status must exist');
  assert.ok(html.includes('id="overviewStatusMaterials"'), 'Goal context Materials status must exist');
  assert.ok(html.includes('id="overviewStatusPlaybook"'), 'Goal context Playbook status must exist');
  assert.ok(html.includes('id="overviewGoalMemoryEmpty"'), 'Goal Memory empty state must exist');
  assert.ok(html.includes('id="overviewGoalMemoryFilled"'), 'Goal Memory filled state must exist');
  assert.ok(html.includes('id="overviewGoalMemoryStrengthsList"'), 'Goal Memory strengths list must exist');
  assert.ok(html.includes('id="overviewGoalMemoryImproveList"'), 'Goal Memory improve list must exist');
  assert.ok(html.includes('id="overviewRecentSessionsContainer"'), 'Recent sessions container must exist');
});

test('Task 5.1 / Property 4: Seções da Aba Prep e Response Defaults (Requirements: 8.1, 9.1, 10.1, 11.2)', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');

  assert.ok(html.includes('id="btnPrepStartPractice"'), 'Start Practice button must exist');
  assert.ok(html.includes('id="prepNextFocusCard"'), 'Next focus card must exist');
  assert.ok(html.includes('id="prepNextFocusEmpty"'), 'Next focus empty state must exist');
  assert.ok(html.includes('id="prepNextFocusFilled"'), 'Next focus filled state must exist');
  assert.ok(html.includes('id="btnPrepEditBrief"'), 'Edit goal brief button must exist');
  assert.ok(html.includes('id="btnPrepPinResume"'), 'Pin resume button must exist');
  assert.ok(html.includes('id="btnPrepAddMaterial"'), 'Add material button must exist');
  assert.ok(html.includes('id="btnPrepNewPlaybook"'), 'New playbook trigger must exist');
  assert.ok(html.includes('id="selectPrepPlaybook"'), 'Select playbook must exist');
  assert.ok(html.includes('id="selectPrepAnswerLang"'), 'Select answer language must exist');
  assert.ok(html.includes('id="selectPrepCodingLang"'), 'Select coding language must exist');
});

test('Task 5.1 / Property 5: Seções da Aba Sessions e Debrief State (Requirements: 13.1, 13.4, 13.5)', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');

  assert.ok(html.includes('id="sessionsProcessingCard"'), 'Debrief processing card must exist');
  assert.ok(html.includes('id="workspaceSessionsEmpty"'), 'Empty sessions card must exist');
  assert.ok(html.includes('id="btnSessionsOpenPrep"'), 'Open Prep button in sessions empty state must exist');
  assert.ok(html.includes('id="workspaceSessionsList"'), 'Sessions list container must exist');
});

test('Task 5.1 / Property 6: Preload API exports para Goal Workspace (Requirements: 3.1, 11.1, 15.1)', () => {
  const preloadJs = fs.readFileSync(preloadJsPath, 'utf8');

  assert.ok(preloadJs.includes('getPlaybooks:'), 'preload must export getPlaybooks');
  assert.ok(preloadJs.includes('savePlaybook:'), 'preload must export savePlaybook');
  assert.ok(preloadJs.includes('scheduleInterview:'), 'preload must export scheduleInterview');
  assert.ok(preloadJs.includes('clearInterview:'), 'preload must export clearInterview');
  assert.ok(preloadJs.includes('generateDebrief:'), 'preload must export generateDebrief');
  assert.ok(preloadJs.includes('saveChecklist:'), 'preload must export saveChecklist');
});

test('Task 5.1 / Property 7: Main Process IPC Handlers registrados (Requirements: 3.2, 11.1, 15.2)', () => {
  const mainJs = fs.readFileSync(mainJsPath, 'utf8');

  assert.ok(mainJs.includes("'rtai:get-playbooks'"), 'IPC rtai:get-playbooks must be registered');
  assert.ok(mainJs.includes("'rtai:save-playbook'"), 'IPC rtai:save-playbook must be registered');
  assert.ok(mainJs.includes("'rtai:schedule-interview'"), 'IPC rtai:schedule-interview must be registered');
  assert.ok(mainJs.includes("'rtai:clear-interview'"), 'IPC rtai:clear-interview must be registered');
  assert.ok(mainJs.includes("'rtai:generate-debrief'"), 'IPC rtai:generate-debrief must be registered');
  assert.ok(mainJs.includes("'rtai:save-checklist'"), 'IPC rtai:save-checklist must be registered');
  assert.ok(mainJs.includes('DEFAULT_PLAYBOOKS'), 'DEFAULT_PLAYBOOKS constant must exist');
});

test('Task 5.1 / Property 8: Lógica de Abas, Checklist e Horizon Filters em app.js (Requirements: 1.3, 7.4, 14.1)', () => {
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  assert.ok(appJs.includes('switchGoalWorkspaceTab'), 'app.js must define switchGoalWorkspaceTab');
  assert.ok(appJs.includes('renderGoalWorkspace'), 'app.js must define renderGoalWorkspace');
  assert.ok(appJs.includes('renderWorkspaceOverview'), 'app.js must define renderWorkspaceOverview');
  assert.ok(appJs.includes('renderWorkspacePrep'), 'app.js must define renderWorkspacePrep');
  assert.ok(appJs.includes('renderWorkspaceSessions'), 'app.js must define renderWorkspaceSessions');
  assert.ok(appJs.includes('renderChecklist'), 'app.js must define renderChecklist');
  assert.ok(appJs.includes('goalsFilter'), 'app.js must support goalsFilter');
});

test('Task 5.1 / Property 9: Persistência e Limpeza de Data da Entrevista (Requirements: 2.1, 3.2, 7.2)', () => {
  const mainJs = fs.readFileSync(mainJsPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');
  const preloadJs = fs.readFileSync(preloadJsPath, 'utf8');

  // main.js must read next_interview_date cleanly and sync next_interview object
  assert.ok(mainJs.includes('const rawDate = agent.next_interview_date'), 'saveAgentToDisk must extract rawDate');
  assert.ok(mainJs.includes('data.next_interview_date = nextDate'), 'loadAllAgents must set next_interview_date');
  assert.ok(mainJs.includes('goal.next_interview_date = cleanDate'), 'schedule-interview IPC must set next_interview_date');

  // preload.js must support both object and positional args
  assert.ok(preloadJs.includes('goalIdOrObj'), 'preload.js scheduleInterview must handle flexible arguments');

  // app.js must format display date
  assert.ok(appJs.includes('formatDisplayDate'), 'app.js must define formatDisplayDate');
  assert.ok(appJs.includes('formatDisplayDate(dateVal)'), 'app.js must format date on schedule confirm');
});

test('Task 5.1 / Property 10: Remoção visual dos botões extras do topo e links funcionais (User Request)', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  // Header should not contain btnToggleTranscriptionMode or btnLaunchDemo in the visible app-no-drag header
  const headerMatch = html.match(/<header\b[^>]*>([\s\S]*?)<\/header>/);
  assert.ok(headerMatch, 'Header element must exist');
  const headerContent = headerMatch[1];
  assert.ok(!headerContent.includes('id="btnToggleTranscriptionMode"'), 'Top header must NOT contain btnToggleTranscriptionMode');
  assert.ok(!headerContent.includes('id="btnLaunchDemo"'), 'Top header must NOT contain btnLaunchDemo');
  assert.ok(headerContent.includes('id="btnTopGoLive"'), 'Top header must retain btnTopGoLive');

  // Wire-up of links in Sessions and Prep
  assert.ok(appJs.includes("getElementById('linkSessionsRunFirst')"), 'app.js must attach click listener to linkSessionsRunFirst');
  assert.ok(appJs.includes("getElementById('linkHowLiveStarts')"), 'app.js must attach click listener to linkHowLiveStarts');
  assert.ok(appJs.includes("getElementById('linkHowPracticeWorks')"), 'app.js must attach click listener to linkHowPracticeWorks');
  assert.ok(appJs.includes("getElementById('linkSourcesExplained')"), 'app.js must attach click listener to linkSourcesExplained');
});

