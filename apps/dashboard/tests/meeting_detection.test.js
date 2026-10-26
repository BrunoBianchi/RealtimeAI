// Meeting detection: which scans count as a call, the start/end debounce,
// the default goal for the popup and the wiring of popup, tray and settings.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const { MeetingDetector, classifySnapshot, parseMicEntry, stripBrowserSuffix, scannerScript } =
  require('../src/main/meeting_detector.js');

const ids = (snap) => classifySnapshot(snap).map((m) => m.id).sort();

test('desktop apps holding the microphone are calls', () => {
  assert.deepStrictEqual(ids({ mic: ['C:#Users#bruno#AppData#Roaming#Zoom#bin#Zoom.exe'], win: [] }), ['zoom']);
  assert.deepStrictEqual(ids({ mic: ['MSTeams_8wekyb3d8bbwe'], win: [] }), ['teams']);
  assert.deepStrictEqual(ids({ mic: ['C:#Users#bruno#AppData#Local#Discord#app-1.0.9#Discord.exe'], win: [] }), ['discord']);
  assert.deepStrictEqual(ids({ mic: ['Microsoft.SkypeApp_kzf8qxf38zg5c'], win: [] }), ['skype']);
  assert.deepStrictEqual(ids({ mic: ['5319275A.WhatsAppDesktop_cv1g1gvanyjgm'], win: [] }), ['whatsapp']);
  assert.deepStrictEqual(ids({ mic: ['C:#Program Files#Slack#slack.exe'], win: [] }), ['slack']);
});

test('a Zoom meeting window counts even before the mic opens; the Zoom home does not', () => {
  assert.deepStrictEqual(ids({ mic: [], win: [{ p: 'Zoom', t: 'Zoom Meeting' }] }), ['zoom']);
  assert.deepStrictEqual(ids({ mic: [], win: [{ p: 'Zoom', t: 'Zoom Workplace' }] }), []);
});

test('web meetings need the browser on the mic, except a Meet room code', () => {
  const meetTab = { p: 'chrome', t: 'Meet - abc-defg-hij - Google Chrome' };
  const chromeMic = 'C:#Program Files#Google#Chrome#Application#chrome.exe';
  const m = classifySnapshot({ mic: [chromeMic], win: [meetTab] });
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].id, 'meet');
  assert.strictEqual(m[0].title, 'Meet - abc-defg-hij');
  assert.deepStrictEqual(ids({ mic: [], win: [meetTab] }), ['meet']);

  // Teams on the web: only with the browser holding the mic.
  const teamsTab = { p: 'msedge', t: 'Meeting with Ana | Microsoft Teams - Work - Microsoft​ Edge' };
  assert.deepStrictEqual(ids({ mic: [], win: [teamsTab] }), []);
  assert.deepStrictEqual(ids({ mic: ['C:#Program Files (x86)#Microsoft#Edge#Application#msedge.exe'], win: [teamsTab] }), ['teams']);
});

test('no false positives: a browser on the mic elsewhere, RealTimeAI itself, idle apps', () => {
  const chromeMic = 'C:#Program Files#Google#Chrome#Application#chrome.exe';
  assert.deepStrictEqual(ids({ mic: [chromeMic], win: [{ p: 'chrome', t: 'Voice recorder - Google Chrome' }] }), []);
  assert.deepStrictEqual(ids({ mic: ['C:#Users#bruno#Desktop#RealTimeAI#overlay#rtai_overlay.exe'], win: [] }), []);
  assert.deepStrictEqual(ids({ mic: [], win: [{ p: 'Discord', t: 'Discord' }, { p: 'ms-teams', t: 'Chat | Microsoft Teams' }] }), []);
  assert.deepStrictEqual(ids({}), []);
  assert.deepStrictEqual(ids(null), []);
});

test('helpers: consent-store keys and browser title suffixes', () => {
  assert.deepStrictEqual(parseMicEntry('C:#Program Files#Zoom#Zoom.exe'), { exe: 'zoom.exe' });
  assert.deepStrictEqual(parseMicEntry('MSTeams_8wekyb3d8bbwe'), { pkg: 'MSTeams_8wekyb3d8bbwe' });
  assert.strictEqual(stripBrowserSuffix('Daily sync - Google Meet - Mozilla Firefox'), 'Daily sync - Google Meet');
  assert.strictEqual(stripBrowserSuffix('Meet - abc-defg-hij - Microsoft​ Edge'), 'Meet - abc-defg-hij');
});

test('debounce: 2 scans to start, 3 missing scans to end, blips ignored', () => {
  const d = new MeetingDetector({ spawn: () => null });
  const events = [];
  d.on('meeting-started', (m) => events.push(['start', m.id]));
  d.on('meeting-ended', (m) => events.push(['end', m.id]));
  const zoom = { mic: ['C:#Zoom#Zoom.exe'], win: [{ p: 'Zoom', t: 'Zoom Meeting' }] };
  const none = { mic: [], win: [] };

  d.feed(zoom); d.feed(none); d.feed(none); // one-scan blip
  assert.deepStrictEqual(events, []);

  d.feed(zoom); d.feed(zoom);
  assert.deepStrictEqual(events, [['start', 'zoom']]);
  assert.strictEqual(d.active.length, 1);

  d.feed(none); d.feed(zoom); d.feed(none); d.feed(none); // mic dropped for a moment
  assert.deepStrictEqual(events, [['start', 'zoom']]);
  d.feed(none);
  assert.deepStrictEqual(events, [['start', 'zoom'], ['end', 'zoom']]);
  assert.strictEqual(d.active.length, 0);
});

test('a title change on an active call is reported, not a new call', () => {
  const d = new MeetingDetector({ spawn: () => null });
  const started = [];
  const updated = [];
  d.on('meeting-started', (m) => started.push(m.title));
  d.on('meeting-updated', (m) => updated.push(m.title));
  const snap = (t) => ({ mic: [], win: [{ p: 'chrome', t: `${t} - Google Chrome` }] });
  d.feed(snap('Meet - abc-defg-hij'));
  d.feed(snap('Meet - abc-defg-hij'));
  d.feed(snap('Weekly review - abc-defg-hij - Google Meet'));
  assert.deepStrictEqual(started, ['Meet - abc-defg-hij']);
  assert.deepStrictEqual(updated, ['Weekly review - abc-defg-hij - Google Meet']);
});

test('the scanner runs from one PowerShell process and reads the scans it prints', () => {
  const calls = [];
  const fake = () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => {};
    calls.push(p);
    return p;
  };
  const d = new MeetingDetector({ spawn: (cmd, args) => { assert.ok(/powershell\.exe$/i.test(cmd)); assert.ok(args.includes('-EncodedCommand')); return fake(); } });
  const started = [];
  d.on('meeting-started', (m) => started.push(m.id));
  d.start();
  assert.strictEqual(calls.length, 1);
  const line = JSON.stringify({ mic: ['MSTeams_8wekyb3d8bbwe'], win: [] }) + '\r\n';
  calls[0].stdout.emit('data', Buffer.from(line.slice(0, 10)));
  calls[0].stdout.emit('data', Buffer.from(line.slice(10) + line));
  assert.deepStrictEqual(started, ['teams']);
  d.stop();

  const script = scannerScript(3000, 4242);
  assert.ok(script.includes('CapabilityAccessManager'));
  assert.ok(script.includes('LastUsedTimeStop'));
  assert.ok(script.includes('Get-Process -Id 4242'), 'exits with the dashboard');
});

// ---- main.js: default goal and wiring -------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rtai-meet-'));
process.env.LOCALAPPDATA = tmp;
process.env.RTAI_TEST_EXPORTS = '1';
const fakeElectron = {
  app: { whenReady: () => new Promise(() => {}), on: () => {}, quit: () => {} },
  BrowserWindow: function () {},
  ipcMain: { handle: () => {}, on: () => {} },
  dialog: {},
  shell: {},
  nativeTheme: { shouldUseDarkColors: true },
  Notification: { isSupported: () => false }
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return fakeElectron;
  return realLoad.call(this, request, ...rest);
};
const main = require('../src/main/main.js');
Module._load = realLoad;

test('the popup preselects the goal whose interview is now', () => {
  const pad = (n) => String(n).padStart(2, '0');
  const at = (minutesFromNow) => {
    const d = new Date(Date.now() + minutesFromNow * 60000);
    return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
  };
  const agents = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B', next_interview: at(600) }, // later today: not now
    { id: 'c', name: 'C', next_interview: at(10) } // in 10 minutes
  ];
  assert.strictEqual(main.pickDefaultAgentId(agents), 'c');
  assert.strictEqual(main.pickDefaultAgentId([{ id: 'a' }, { id: 'b', next_interview: at(600) }]), 'a');
  assert.strictEqual(main.pickDefaultAgentId([]), '');
});

test('meeting detection is on by default and stays in the tray', () => {
  assert.deepStrictEqual(main.getMeetingSettings(), { enabled: true, keepInTray: true, mutedApps: [] });
});

test('wiring: IPC, preload bridges, settings controls and popup actions', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const mainJs = read('src/main/main.js');
  for (const ch of ['rtai:meeting-detection-get', 'rtai:meeting-detection-set', 'rtai:meeting-popup-test']) {
    assert.ok(mainJs.includes(`'${ch}'`), `main.js handles ${ch}`);
  }
  assert.ok(mainJs.includes("JSON.stringify({ cmd: 'quit' })"), 'stopping from the popup lets the overlay save the session');
  const preload = read('src/preload/preload.js');
  for (const fn of ['getMeetingDetection', 'setMeetingDetection', 'testMeetingPopup', 'onMeetingDetection']) {
    assert.ok(preload.includes(fn), `preload exposes ${fn}`);
  }
  const html = read('src/renderer/index.html');
  for (const id of ['cfgMeetingDetect', 'cfgMeetingTray', 'meetingDetectStatus', 'btnMeetingTest', 'btnMeetingUnmute']) {
    assert.ok(html.includes(`id="${id}"`), `settings has #${id}`);
  }
  const popup = read('src/renderer/meeting_popup.html');
  for (const id of ['btnStart', 'btnLater', 'btnMute', 'selGoal', 'btnStop', 'btnKeep']) {
    assert.ok(popup.includes(`id="${id}"`), `popup has #${id}`);
  }
  assert.ok(popup.includes("Content-Security-Policy"), 'popup has a CSP');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets', 'tray.png')), 'tray icon exists');
});
