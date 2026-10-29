const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.resolve(__dirname, '../src/renderer/index.html');
const appJsPath = path.resolve(__dirname, '../src/renderer/app.js');

test('Feature: Plan & Billing Screen (Image 1 Fidelity)', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  // Breadcrumb and header
  assert.ok(html.includes('id="btnBillingHelp"'), 'Must have btnBillingHelp in Plan & Billing');
  assert.ok(html.includes('id="billingPlanAvatar"'), 'Must have billingPlanAvatar in Plan & Billing');
  assert.ok(html.includes('id="billingCurrentPlanName"'), 'Must have billingCurrentPlanName in Plan & Billing');

  // Left column: 4 plans
  assert.ok(html.includes('id="billingPlansRadioGroup"'), 'Must have billingPlansRadioGroup');
  assert.ok(html.includes('data-plan-id="monthly"'), 'Must have Monthly plan card');
  assert.ok(html.includes('data-plan-id="quarterly"'), 'Must have Quarterly plan card');
  assert.ok(html.includes('data-plan-id="max"'), 'Must have Premium MAX plan card');
  assert.ok(html.includes('data-plan-id="yearly"'), 'Must have Yearly plan card');
  assert.ok(html.includes('id="linkHowPricingWorks"'), 'Must have linkHowPricingWorks');

  // Right column: selected plan card
  assert.ok(html.includes('id="selectedPlanTitle"'), 'Must have selectedPlanTitle');
  assert.ok(html.includes('id="selectedPlanPrice"'), 'Must have selectedPlanPrice');
  assert.ok(html.includes('id="selectedPlanCadenceSub"'), 'Must have selectedPlanCadenceSub');
  assert.ok(html.includes('id="selectedPlanDiscountPill"'), 'Must have selectedPlanDiscountPill');
  assert.ok(html.includes('id="selectedPlanBaseline"'), 'Must have selectedPlanBaseline');
  assert.ok(html.includes('id="selectedPlanAdvantage"'), 'Must have selectedPlanAdvantage');
  assert.ok(html.includes('id="btnBillingContinueCheckout"'), 'Must have btnBillingContinueCheckout');

  // app.js interactivity
  assert.ok(appJs.includes('billingPlansRadioGroup'), 'app.js must handle billingPlansRadioGroup');
  assert.ok(appJs.includes('btnBillingContinueCheckout'), 'app.js must handle btnBillingContinueCheckout');
});

test('Feature: Library & Playbooks Tab (Image 2 Fidelity)', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  // Top header with Go Live · goal and help
  assert.ok(html.includes('id="btnLibraryGoLive"'), 'Library must have Go Live button');
  assert.ok(html.includes('id="libraryGoLiveText"'), 'Library Go Live button must display active goal name');
  assert.ok(html.includes('id="btnLibraryHelp"'), 'Library must have help button');

  // Subtitle links
  assert.ok(html.includes('id="linkHowLibraryWorks"'), 'Library must have linkHowLibraryWorks');
  assert.ok(html.includes('id="linkOpenAiDrive"'), 'Library must have linkOpenAiDrive');

  // Tab action button
  assert.ok(html.includes('id="btnLibraryNewPlaybook"'), 'Library tab bar must have btnLibraryNewPlaybook');

  // Empty state for playbooks
  assert.ok(html.includes('id="libraryPlaybooksEmptyState"'), 'Library must have libraryPlaybooksEmptyState');
  assert.ok(html.includes('Shape how the copilot answers.'), 'Empty state must have heading');
  assert.ok(html.includes('id="linkPlaybooksWhatPlaybookDoes"'), 'Empty state must have linkPlaybooksWhatPlaybookDoes');
  assert.ok(html.includes('id="btnEmptyNewPlaybook"'), 'Empty state must have btnEmptyNewPlaybook');

  // app.js wiring
  assert.ok(appJs.includes('libraryPlaybooksEmptyState'), 'app.js must toggle libraryPlaybooksEmptyState');
  assert.ok(appJs.includes('btnLibraryNewPlaybook'), 'app.js must wire btnLibraryNewPlaybook');
  assert.ok(appJs.includes('btnEmptyNewPlaybook'), 'app.js must wire btnEmptyNewPlaybook');
});

test('Feature: New Playbook Modal (Images 3 & 4 Fidelity)', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  // Header & Name
  assert.ok(html.includes('id="modalNewPlaybook"'), 'Must have modalNewPlaybook');
  assert.ok(html.includes('id="btnCloseNewPlaybook"'), 'Must have btnCloseNewPlaybook');
  assert.ok(html.includes('id="linkHowPlaybooksWork"'), 'Must have linkHowPlaybooksWork');
  assert.ok(html.includes('id="inputPlaybookName"'), 'Must have inputPlaybookName');
  assert.ok(html.includes('id="btnPlaybookWriteYourOwn"'), 'Must have btnPlaybookWriteYourOwn');

  // How You Sound: Segmented length & behavioral structure & toggles
  assert.ok(html.includes('id="btnPlaybookLenConcise"'), 'Must have btnPlaybookLenConcise');
  assert.ok(html.includes('id="btnPlaybookLenBalanced"'), 'Must have btnPlaybookLenBalanced');
  assert.ok(html.includes('id="btnPlaybookLenThorough"'), 'Must have btnPlaybookLenThorough');
  assert.ok(html.includes('id="selectPlaybookStructure"'), 'Must have selectPlaybookStructure');
  assert.ok(html.includes('id="togglePlaybookLeadAnswer"'), 'Must have togglePlaybookLeadAnswer');
  assert.ok(html.includes('id="togglePlaybookTradeoffs"'), 'Must have togglePlaybookTradeoffs');

  // When It Speaks: Surface mode & code comments
  assert.ok(html.includes('id="linkHowCopilotSpeaks"'), 'Must have linkHowCopilotSpeaks');
  assert.ok(html.includes('id="btnSurfaceModeAlways"'), 'Must have btnSurfaceModeAlways');
  assert.ok(html.includes('id="btnSurfaceModeRealQuestion"'), 'Must have btnSurfaceModeRealQuestion');
  assert.ok(html.includes('id="btnSurfaceModeOnRequest"'), 'Must have btnSurfaceModeOnRequest');
  assert.ok(html.includes('id="togglePlaybookCodeComments"'), 'Must have togglePlaybookCodeComments');

  // Preview Box & Footer
  assert.ok(html.includes('id="playbookAnswerPreview"'), 'Must have playbookAnswerPreview');
  assert.ok(html.includes('id="btnCancelNewPlaybook"'), 'Must have btnCancelNewPlaybook');
  assert.ok(html.includes('id="btnSaveNewPlaybook"'), 'Must have btnSaveNewPlaybook');

  // Switches use orange styling
  assert.ok(html.includes('sh-switch-orange'), 'Toggles must use sh-switch-orange');

  // app.js dynamic preview & surface mode
  assert.ok(appJs.includes('playbookPreviewTexts'), 'app.js must support dynamic playbookPreviewTexts');
  assert.ok(appJs.includes('btnSurfaceModeRealQuestion'), 'app.js must handle surface mode buttons');
});
