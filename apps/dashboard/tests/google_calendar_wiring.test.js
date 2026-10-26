// Google Calendar wiring: every channel the renderer invokes is handled in
// the main process, every window.rtai.gcal* call exists in the preload, and
// every element the calendar UI looks up exists in the page.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const mainJs = fs.readFileSync(path.join(root, 'src', 'main', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src', 'preload', 'preload.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');

test('every invoked IPC channel has a handler in main.js', () => {
  const channels = [...preload.matchAll(/ipcRenderer\.invoke\('(rtai:[^']+)'/g)].map((m) => m[1]);
  assert.ok(channels.includes('rtai:gcal-connect'));
  for (const ch of channels) {
    assert.ok(mainJs.includes(`ipcMain.handle('${ch}'`), `main.js must handle ${ch}`);
  }
});

test('every window.rtai.gcal* used by the page is exposed by the preload', () => {
  const used = new Set([...appJs.matchAll(/window\.rtai\.(gcal\w+)/g)].map((m) => m[1]));
  assert.ok(used.size >= 8);
  for (const name of used) assert.ok(preload.includes(`${name}:`), `preload must expose ${name}`);
});

test('every element the calendar UI reads exists in index.html', () => {
  const ids = new Set([...appJs.matchAll(/gcalEl\('([^']+)'\)/g)].map((m) => m[1]));
  for (const id of ['cfgGcalAutoSync', 'selectGcalCalendar', 'selectGcalReminder', 'inputGcalTitle', 'inputGcalDate',
    'inputGcalTime', 'selectGcalDuration', 'inputGcalNotes', 'btnGcalCreate', 'btnGcalRefresh']) ids.add(id);
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `index.html must have #${id}`);
  assert.ok(/data-settings-tab=["']calendar["']/.test(html));
  assert.ok(/id=["']subpane-calendar["'][^>]*class=["'][^"']*settings-subpane/.test(html));
});

test('scheduling and clearing an interview keep its Google Calendar event in step', () => {
  assert.ok(mainJs.includes('getGoogleCalendar().syncInterview(saved, wanted)'));
  assert.ok(mainJs.includes('getGoogleCalendar().removeInterview(goal.id)'));
  assert.ok(preload.includes('calendar = goalIdOrObj.calendar'));
  assert.ok(appJs.includes('calendar: gcalSchedulerChoice()'));
});

test('only Google Calendar and Meet links are opened from the calendar list', () => {
  const block = mainJs.slice(mainJs.indexOf("ipcMain.handle('rtai:gcal-open'"));
  assert.ok(block.includes("host === 'calendar.google.com'"));
  assert.ok(block.includes("u.protocol === 'https:'"));
});
