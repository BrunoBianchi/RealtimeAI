// Google Calendar wiring: every channel the renderer invokes is handled in
// the main process, every window.rtai call exists in the preload, and the
// calendar settings and the interview scheduler talk to the right APIs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadRenderer, render, sources, tags } = require('./helpers/renderer');

const root = path.resolve(__dirname, '..');
const mainJs = fs.readFileSync(path.join(root, 'src', 'main', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src', 'preload', 'preload.js'), 'utf8');

test('every invoked IPC channel has a handler in main.js', () => {
  const channels = [...preload.matchAll(/ipcRenderer\.invoke\('(rtai:[^']+)'/g)].map((m) => m[1]);
  assert.ok(channels.includes('rtai:gcal-connect'));
  for (const ch of channels) {
    assert.ok(mainJs.includes(`ipcMain.handle('${ch}'`), `main.js must handle ${ch}`);
  }
});

test('every window.rtai.gcal* used by the page is exposed by the preload', () => {
  const used = new Set();
  for (const src of Object.values(sources)) for (const m of src.matchAll(/\b(?:api|window\.rtai)\.(gcal\w+)/g)) used.add(m[1]);
  assert.ok(used.size >= 8, `found ${[...used].join(', ')}`);
  for (const name of used) assert.ok(preload.includes(`${name}:`), `preload must expose ${name}`);
});

test('the calendar settings follow the connection state and the form has every field it reads', () => {
  const at = (status, extra = {}) => {
    const { Cue } = loadRenderer({ state: { gcal: { status, calendars: [{ id: 'primary', summary: 'Ana', primary: true }, { id: 'work', summary: 'Trabalho' }], events: [], ...extra } } });
    return render(Cue, 'settings/calendar');
  };
  const actions = (html) => tags(html, { 'data-action': true }).map((t) => t['data-action']);

  const none = at({ configured: false, connected: false });
  assert.ok(none.includes('Não configurado') && actions(none).includes('gcal-import') && !actions(none).includes('gcal-connect'));

  const ready = at({ configured: true, connected: false, redirectUri: 'http://127.0.0.1:53682/' });
  assert.ok(actions(ready).includes('gcal-connect'));
  assert.ok(ready.includes('http://127.0.0.1:53682/') && actions(ready).includes('copy-text'), 'redirect URI to register, with copy');

  const on = at({ configured: true, connected: true, email: 'ana@example.com', calendarId: 'work', reminderMin: 30 });
  assert.ok(on.includes('Conta: ana@example.com') && actions(on).includes('gcal-disconnect'));
  assert.deepStrictEqual(tags(on, { 'data-change': 'gcal-setting' }).map((t) => t['data-field']), ['autoSync', 'calendarId', 'reminderMin']);
  assert.ok(on.includes('<option value="work" selected>Trabalho</option>'), 'saved calendar selected');
  assert.ok(on.includes('<option value="30" selected>'), 'saved reminder selected');
  // The ids gcal-create reads exist in the form it renders.
  const read = [...sources['settings.js'].matchAll(/getElementById\('(gcal\w+)'\)/g)].map((m) => m[1]);
  assert.ok(read.length >= 5);
  for (const id of read) assert.ok(on.includes(`id="${id}"`), `form must have #${id}`);
  assert.ok(actions(on).includes('gcal-create') && actions(on).includes('gcal-refresh'));
  assert.ok(on.includes('Nada nos próximos 14 dias.'), 'empty list says so');
});

test('scheduling and clearing an interview keep its Google Calendar event in step', async () => {
  assert.ok(mainJs.includes('getGoogleCalendar().syncInterview(saved, wanted)'));
  assert.ok(mainJs.includes('getGoogleCalendar().removeInterview(goal.id)'));
  assert.ok(preload.includes('calendar = goalIdOrObj.calendar'));

  // The scheduler offers the Google toggle only while connected and sends its value.
  const r = loadRenderer({
    state: { agents: [{ id: 'a1', company: 'Nubank', role: 'Backend' }], gcal: { status: { connected: true, autoSync: true, email: 'ana@example.com' } } },
    api: { scheduleInterview: async () => ({ ok: true, agents: [], calendar: { ok: true } }) }
  });
  r.Cue.openModal('scheduler', 'a1');
  assert.ok(r.modals.last.includes('Adicionar ao Google Calendar') && r.modals.last.includes('id="scGcal" checked'));
  const dlg = r.dialogs[0];
  dlg.querySelector('#scAgent').value = 'a1';
  dlg.querySelector('#scDate').value = '2099-03-10';
  dlg.querySelector('#scTime').value = '14:30';
  dlg.querySelector('#scGcal').checked = false;
  await dlg.querySelector('#scSave').fire('click');
  assert.deepStrictEqual(r.called('scheduleInterview'), [[{ goalId: 'a1', date: '2099-03-10', time: '14:30', calendar: false }]]);
  assert.ok(r.toasts().some((t) => t.text.startsWith('Entrevista em 10 mar às 14:30.')));

  const offline = loadRenderer({ state: { agents: [{ id: 'a1', company: 'Nubank' }], gcal: { status: { connected: false } } } });
  offline.Cue.openModal('scheduler', 'a1');
  assert.ok(!offline.modals.last.includes('scGcal'), 'no Google toggle while disconnected');
});

test('only Google Calendar and Meet links are opened from the calendar list', () => {
  const block = mainJs.slice(mainJs.indexOf("ipcMain.handle('rtai:gcal-open'"));
  assert.ok(block.includes("host === 'calendar.google.com'"));
  assert.ok(block.includes("u.protocol === 'https:'"));
});
