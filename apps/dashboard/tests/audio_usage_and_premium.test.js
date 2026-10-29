const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.resolve(__dirname, '../src/renderer/index.html');
const appJsPath = path.resolve(__dirname, '../src/renderer/app.js');
const mainJsPath = path.resolve(__dirname, '../src/main/main.js');

test('Audio Usage & Premium: HTML contains sidebar widget and upgrade modal', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');

  // Sidebar usage widget elements
  assert.ok(html.includes('id="sidebarUsageCard"'), 'Must have sidebarUsageCard');
  assert.ok(html.includes('id="sidebarPlanBadge"'), 'Must have sidebarPlanBadge');
  assert.ok(html.includes('id="sidebarUsageTime"'), 'Must have sidebarUsageTime');
  assert.ok(html.includes('id="sidebarUsagePercent"'), 'Must have sidebarUsagePercent');
  assert.ok(html.includes('id="sidebarUsageProgressBar"'), 'Must have sidebarUsageProgressBar');
  assert.ok(html.includes('id="sidebarUsageSessions"'), 'Must have sidebarUsageSessions');
  assert.ok(html.includes('id="btnSidebarUpgrade"'), 'Must have btnSidebarUpgrade');
  assert.ok(html.includes('id="profilePlanBadge"'), 'Must have profilePlanBadge');

  // Settings -> Account plan elements
  assert.ok(html.includes('id="accountPlanBadge"'), 'Must have accountPlanBadge');
  assert.ok(html.includes('id="accountUsageTimeLabel"'), 'Must have accountUsageTimeLabel');
  assert.ok(html.includes('id="accountUsageProgressBar"'), 'Must have accountUsageProgressBar');
  assert.ok(html.includes('id="btnAccountUpgrade"'), 'Must have btnAccountUpgrade');

  // Modal elements
  assert.ok(html.includes('id="modalUpgradePremium"'), 'Must have modalUpgradePremium');
  assert.ok(html.includes('id="btnCloseUpgradeModal"'), 'Must have btnCloseUpgradeModal');
  assert.ok(html.includes('id="toggleBillingInterval"'), 'Must have toggleBillingInterval');
  assert.ok(html.includes('id="btnActionUpgradePremium"'), 'Must have btnActionUpgradePremium');
  assert.ok(html.includes('id="btnSelectPlanFree"'), 'Must have btnSelectPlanFree');
});

test('Audio Usage & Premium: main.js provides default profile with plan and usage', () => {
  const mainJs = fs.readFileSync(mainJsPath, 'utf8');

  assert.ok(mainJs.includes('plan'), 'main.js should reference plan in profile');
  assert.ok(mainJs.includes('transcriptionUsage'), 'main.js should reference transcriptionUsage');
  assert.ok(mainJs.includes('usedMinutes'), 'main.js should initialize usedMinutes');
  assert.ok(mainJs.includes('limitMinutes'), 'main.js should initialize limitMinutes');
});

test('Audio Usage & Premium: app.js contains renderPlanAndUsage and initPlanAndBillingEvents', () => {
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  assert.ok(appJs.includes('function renderPlanAndUsage'), 'app.js should define renderPlanAndUsage');
  assert.ok(appJs.includes('function initPlanAndBillingEvents'), 'app.js should define initPlanAndBillingEvents');
  assert.ok(appJs.includes('renderPlanAndUsage()'), 'app.js should call renderPlanAndUsage');
  assert.ok(appJs.includes('initPlanAndBillingEvents()'), 'app.js should call initPlanAndBillingEvents');
  assert.ok(appJs.includes("plan: 'premium'"), 'app.js should support upgrading to premium');
  assert.ok(appJs.includes("plan: 'free'"), 'app.js should support switching to free mock');
});
