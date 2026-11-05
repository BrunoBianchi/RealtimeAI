'use strict';
// A fresh install starts empty (no starter goal, no sample data, no scripted
// demo) and explains itself with guided tours (tour.js on driver.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { loadRenderer, render, sources } = require('./helpers/renderer');
const { SAMPLE } = require('./helpers/i18n_coverage');

function loadMain() {
  process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rtai-first-'));
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
  return main;
}
const main = loadMain();
const appDir = () => path.join(process.env.LOCALAPPDATA, 'RealTimeAI');
const freshDir = () => (process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rtai-first-')));

test('fresh install: no goals, no sessions, an empty profile', () => {
  freshDir();
  assert.deepStrictEqual(main.loadAllAgents(), [], 'no starter goal');
  assert.deepStrictEqual(main.loadPastSessions(), []);
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  assert.ok(!/saveAgentToDisk\(\{\s*id: 'my-first-goal'/.test(mainSrc), 'the starter goal is no longer created');
});

test('upgrade: the empty "My first goal" of older versions goes away, a used one stays', () => {
  freshDir();
  main.loadAllAgents(); // creates the data folders, like the first launch
  const file = path.join(appDir(), 'agents', 'my-first-goal.json');
  const write = (extra) => fs.writeFileSync(file, JSON.stringify({ id: 'my-first-goal', name: 'My first goal', company: '', role: '', documents: [], ...extra }));

  write({});
  assert.strictEqual(main.removeUntouchedStarterGoal(), true);
  assert.ok(!fs.existsSync(file));

  write({ company: 'Acme' });
  assert.strictEqual(main.removeUntouchedStarterGoal(), false, 'filled in by the user');
  assert.ok(fs.existsSync(file));

  write({});
  fs.writeFileSync(path.join(appDir(), 'sessions', '2026-01-01_10-00-00_ab12.jsonl'), '{"type":"session_start","agent":"my-first-goal"}\n');
  assert.strictEqual(main.removeUntouchedStarterGoal(), false, 'a session was recorded with it');
});

test('no invented content: no fake calendar events, no debrief without a transcript', async () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  assert.ok(!/source: 'template'/.test(mainSrc) && !/Mercado Livre/.test(mainSrc), 'calendar sync returns only real events');
  assert.ok(!/--capture-screenshots/.test(mainSrc), 'no leftover screenshot mode');

  freshDir();
  main.saveAgentToDisk({ id: 'g1', company: 'Acme', role: 'Engineer', documents: [] });
  const res = await main.generateSessionDebrief({ goalId: 'g1', transcript: '' });
  assert.strictEqual(res.ok, false);
  const [g] = main.loadAllAgents();
  assert.ok(!(g.goal_memory && g.goal_memory.strengths && g.goal_memory.strengths.length), 'no generic praise saved');
});

test('no scripted demo in the app: every start is a real session', async () => {
  const r = loadRenderer({
    state: { ...SAMPLE, config: { ...SAMPLE.config } },
    api: { startOverlay: async () => ({ ok: true, agent: SAMPLE.agents[0] }) }
  });
  for (const route of ['home', 'sessions', 'session/a1', 'review/s1', 'live', 'questions']) {
    const html = String(render(r.Cue, route));
    assert.ok(!/data-demo=/.test(html), `${route}: no practice/demo launcher`);
  }
  await r.Cue.actions['start-copilot']({ dataset: { agent: 'a1', demo: '1' } });
  const [[opts]] = r.called('startOverlay');
  assert.strictEqual(opts.demo, undefined);
});

// ------------------------------------------------------------------ tours --
const pkg = require('../package.json');

test('tour library: driver.js is vendored at the version in package.json', () => {
  const vendored = path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'driver');
  const installed = path.join(__dirname, '..', 'node_modules', 'driver.js', 'dist');
  assert.strictEqual(pkg.dependencies['driver.js'], '1.10.2');
  assert.ok(fs.existsSync(path.join(vendored, 'LICENSE')));
  if (fs.existsSync(installed)) {
    assert.strictEqual(fs.readFileSync(path.join(vendored, 'driver.iife.js'), 'utf8'), fs.readFileSync(path.join(installed, 'driver.js.iife.js'), 'utf8'), 'copy of the installed build');
  }
  assert.ok(sources['vendor/driver/driver.iife.js'] && sources['tour.js'], 'loaded by index.html');
});

test('tours: every step points at something the screen really renders', () => {
  const modes = [false, true].flatMap((local) => [false, true].map((running) => ({ local, running })));
  const pageRoute = { session: 'session/a1', live: 'live', files: 'files', questions: 'questions' };
  for (const m of modes) {
    const r = loadRenderer({
      state: {
        ...SAMPLE,
        config: { ...SAMPLE.config, server_mode: m.local ? 'local' : 'auto' },
        overlayStatus: { running: m.running, agentId: 'a1' }
      }
    });
    for (const [id, def] of Object.entries(r.Cue.tours)) {
      for (const st of def.steps(m).filter(Boolean)) {
        if (typeof st.element !== 'string' || st.optional) continue;
        const anchor = /\[data-(card|tour)="([^"]+)"\]/.exec(st.element);
        if (!anchor) continue; // shell ids (#btnNewSession...) are checked by the layout tests
        const route = st.route || pageRoute[id];
        const html = String(render(r.Cue, route));
        assert.ok(html.includes(`data-${anchor[1]}="${anchor[2]}"`), `${id} (${JSON.stringify(m)}): ${route} has ${st.element}`);
      }
    }
  }
});

// A stand-in for window.driver.js.driver that records what it is asked to show.
function fakeDriver(win) {
  const shown = [];
  let destroyed = 0;
  win.driver = { js: { driver: () => ({ highlight: (cfg) => shown.push(cfg), destroy: () => (destroyed += 1) }) } };
  return { shown, destroyed: () => destroyed };
}

test('tours: start, close and the seen list saved in the profile', async () => {
  const saved = [];
  const r = loadRenderer({ state: { ...SAMPLE, profile: {} }, api: { saveProfile: async (p) => (saved.push(p), { profile: p }) } });
  const d = fakeDriver(r.window);

  assert.strictEqual(r.Cue.startTour('welcome'), true);
  assert.strictEqual(r.Cue.tourActive(), 'welcome');
  await new Promise((resolve) => setImmediate(resolve));
  const [first] = d.shown;
  assert.strictEqual(first.popover.title, 'Welcome to lipcue.com');
  assert.strictEqual(first.popover.progressText, `1 / ${r.Cue.tours.welcome.steps({ local: false, running: false }).length}`);
  assert.deepStrictEqual([...first.popover.disableButtons], ['previous']);

  first.popover.onCloseClick();
  assert.strictEqual(r.Cue.tourActive(), null);
  assert.strictEqual(d.destroyed(), 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(saved.pop())), { tours_seen: { welcome: true } });

  // Restart from Settings: the seen list is cleared and welcome runs again.
  await r.Cue.actions['tour-reset']();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(saved.pop())), { tours_seen: {} });
  assert.strictEqual(r.Cue.tourActive(), 'welcome');
});

test('tours: locked (signed out) never starts one; Settings and the top bar offer them', () => {
  const r = loadRenderer({ state: { ...SAMPLE, auth: { signedIn: false, available: true } } });
  fakeDriver(r.window);
  assert.strictEqual(r.Cue.startTour('welcome'), false);
  const general = String(render(loadRenderer({ state: SAMPLE }).Cue, 'settings/general'));
  assert.ok(/data-action="start-setup-tour"/.test(general) && /data-action="tour-reset"/.test(general));
  assert.ok(/id="btnTour"[^>]*data-action="start-tour"/.test(require('./helpers/renderer').indexHtml));
});
