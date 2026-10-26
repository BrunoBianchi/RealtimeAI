const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.resolve(__dirname, '../src/index.html');
const appJsPath = path.resolve(__dirname, '../src/app.js');
const preloadJsPath = path.resolve(__dirname, '../preload.js');
const mainJsPath = path.resolve(__dirname, '../main.js');

test('App Updates & Polish: HTML contains version badges, update controls, and modal', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');

  // Top header search & version badge
  assert.ok(html.includes('id="topSearchInput"'), 'topSearchInput must exist in index.html');
  assert.ok(html.includes('id="btnTopVersionBadge"'), 'btnTopVersionBadge must exist in index.html');
  assert.ok(html.includes('id="topVersionBadgeDot"'), 'topVersionBadgeDot must exist in index.html');
  assert.ok(html.includes('id="btnTopOpenSettings"'), 'btnTopOpenSettings must exist in index.html');

  // Sidebar app version
  assert.ok(html.includes('id="sidebarAppVersion"'), 'sidebarAppVersion must exist in index.html');

  // Settings update controls & auto-update toggle
  assert.ok(html.includes('id="cfgAutoUpdate"'), 'cfgAutoUpdate toggle must exist in index.html');
  assert.ok(html.includes('id="btnCheckUpdates"'), 'btnCheckUpdates must exist in index.html');
  assert.ok(html.includes('id="updateStatusText"'), 'updateStatusText must exist in index.html');
  assert.ok(html.includes('id="updateBanner"'), 'updateBanner must exist in index.html');
  assert.ok(html.includes('id="updateProgressBar"'), 'updateProgressBar must exist in index.html');
  assert.ok(html.includes('id="updateProgressPercent"'), 'updateProgressPercent must exist in index.html');
  assert.ok(html.includes('id="btnDownloadUpdate"'), 'btnDownloadUpdate must exist in index.html');
  assert.ok(html.includes('id="btnRestartUpdate"'), 'btnRestartUpdate must exist in index.html');

  // Update Modal
  assert.ok(html.includes('id="modalAppUpdate"'), 'modalAppUpdate must exist in index.html');
  assert.ok(html.includes('id="modalUpdateVersionTag"'), 'modalUpdateVersionTag must exist in index.html');
  assert.ok(html.includes('id="modalUpdateNotes"'), 'modalUpdateNotes must exist in index.html');
  assert.ok(html.includes('id="modalUpdateProgressContainer"'), 'modalUpdateProgressContainer must exist in index.html');
  assert.ok(html.includes('id="modalUpdateProgressBar"'), 'modalUpdateProgressBar must exist in index.html');
  assert.ok(html.includes('id="modalUpdateProgressPercent"'), 'modalUpdateProgressPercent must exist in index.html');
  assert.ok(html.includes('id="btnModalDownloadUpdate"'), 'btnModalDownloadUpdate must exist in index.html');
  assert.ok(html.includes('id="btnCloseUpdateModal"'), 'btnCloseUpdateModal must exist in index.html');
});

test('App Updates & Polish: HTML contains Image 2 Modern Hero elements and Privacy/Stealth features', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');

  // Signature Hero Header Action Row (Image 2 style)
  assert.ok(html.includes('id="btnRefreshHero"'), 'btnRefreshHero must exist in index.html');
  assert.ok(html.includes('id="heroStealthPill"'), 'heroStealthPill must exist in index.html');
  assert.ok(html.includes('id="labelHeroStealth"'), 'labelHeroStealth must exist in index.html');
  assert.ok(html.includes('id="toggleHeroStealth"'), 'toggleHeroStealth must exist in index.html');
  assert.ok(html.includes('id="btnHeroWhatsNew"'), 'btnHeroWhatsNew must exist in index.html');
  assert.ok(html.includes('id="btnHeroStartApp"'), 'btnHeroStartApp must exist in index.html');

  // Twin Hero Cards
  assert.ok(html.includes('id="btnHeroModelAction"'), 'btnHeroModelAction must exist in index.html');
  assert.ok(html.includes('id="btnHeroConnectCalendar"'), 'btnHeroConnectCalendar must exist in index.html');
  assert.ok(html.includes('id="heroCalendarEventWidget"'), 'heroCalendarEventWidget must exist in index.html');
  assert.ok(html.includes('id="heroEventTitle"'), 'heroEventTitle must exist in index.html');
  assert.ok(html.includes('id="heroEventSub"'), 'heroEventSub must exist in index.html');

  // Privacy & Stealth Settings (Image 3 & 4)
  assert.ok(html.includes('id="inputInterfaceOpacity"'), 'inputInterfaceOpacity slider must exist in index.html');
  assert.ok(html.includes('id="labelInterfaceOpacity"'), 'labelInterfaceOpacity must exist in index.html');
  assert.ok(html.includes('id="btnDisguiseNone"'), 'btnDisguiseNone must exist in index.html');
  assert.ok(html.includes('id="btnDisguiseSettings"'), 'btnDisguiseSettings must exist in index.html');
  assert.ok(html.includes('id="btnDisguiseCmd"'), 'btnDisguiseCmd must exist in index.html');
  assert.ok(html.includes('id="btnDisguiseTaskManager"'), 'btnDisguiseTaskManager must exist in index.html');
});

test('App Updates & Polish: preload.js exposes update, disguise, and opacity APIs', () => {
  const preload = fs.readFileSync(preloadJsPath, 'utf8');

  assert.ok(preload.includes('getAppVersion:'), 'preload must expose getAppVersion');
  assert.ok(preload.includes('checkUpdate:'), 'preload must expose checkUpdate');
  assert.ok(preload.includes('downloadUpdate:'), 'preload must expose downloadUpdate');
  assert.ok(preload.includes('installUpdate:'), 'preload must expose installUpdate');
  assert.ok(preload.includes('setProcessDisguise:'), 'preload must expose setProcessDisguise');
  assert.ok(preload.includes('setInterfaceOpacity:'), 'preload must expose setInterfaceOpacity');
  assert.ok(preload.includes('onUpdateProgress:'), 'preload must expose onUpdateProgress');
  assert.ok(preload.includes('onUpdateDownloaded:'), 'preload must expose onUpdateDownloaded');
});

test('App Updates & Polish: main.js implements IPC channels and config persistence for updates & disguise', () => {
  const main = fs.readFileSync(mainJsPath, 'utf8');

  // IPC handlers
  assert.ok(main.includes("'rtai:get-app-version'"), 'main.js must handle rtai:get-app-version');
  assert.ok(main.includes("'rtai:check-update'"), 'main.js must handle rtai:check-update');
  assert.ok(main.includes("'rtai:download-update'"), 'main.js must handle rtai:download-update');
  assert.ok(main.includes("'rtai:install-update'"), 'main.js must handle rtai:install-update');
  assert.ok(main.includes("'rtai:set-process-disguise'"), 'main.js must handle rtai:set-process-disguise');
  assert.ok(main.includes("'rtai:set-interface-opacity'"), 'main.js must handle rtai:set-interface-opacity');

  // Config INI schema handling
  assert.ok(main.includes('auto_update'), 'main.js must handle auto_update in config');
  assert.ok(main.includes('process_disguise'), 'main.js must handle process_disguise in config');
  assert.ok(main.includes('interface_opacity'), 'main.js must handle interface_opacity in config');
});

test('App Updates & Polish: app.js implements update checking, download flow, and search shortcuts', () => {
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  assert.ok(appJs.includes('function checkAppUpdates'), 'checkAppUpdates function must exist in app.js');
  assert.ok(appJs.includes('function startUpdateDownloadFlow'), 'startUpdateDownloadFlow function must exist in app.js');
  assert.ok(appJs.includes('function finishUpdateInstallation'), 'finishUpdateInstallation function must exist in app.js');
  assert.ok(appJs.includes('function selectProcessDisguise'), 'selectProcessDisguise function must exist in app.js');
  assert.ok(appJs.includes('function setupUpdatesAndModernHero'), 'setupUpdatesAndModernHero function must exist in app.js');
});
