'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { settingsSectionFromArgv } = require('../src/main/launch_args');

test('--open-settings picks the Settings section from the command line', () => {
  assert.strictEqual(settingsSectionFromArgv(['app.exe', '--open-settings=general']), 'general');
  assert.strictEqual(settingsSectionFromArgv(['electron.exe', 'C:\\app', '--open-settings=plan']), 'plan');
  assert.strictEqual(settingsSectionFromArgv(['app.exe', '--open-settings']), 'general');
});

test('without --open-settings the dashboard opens normally', () => {
  assert.strictEqual(settingsSectionFromArgv(['app.exe']), '');
  assert.strictEqual(settingsSectionFromArgv(['app.exe', '--open-settings-other']), '');
  assert.strictEqual(settingsSectionFromArgv(undefined), '');
});
