// Loads src/main/main.js outside Electron (fake `electron` module) with its
// test exports and a private %LOCALAPPDATA%, so config.ini, agents and the
// other files it writes land in a temp folder. Call restore() when done.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const MAIN = path.resolve(__dirname, '..', '..', 'src', 'main', 'main.js');

const fakeElectron = {
  app: { whenReady: () => new Promise(() => {}), on: () => {}, quit: () => {} },
  BrowserWindow: function () {},
  ipcMain: { handle: () => {}, on: () => {} },
  dialog: {},
  shell: {},
  nativeTheme: { shouldUseDarkColors: true },
  Notification: { isSupported: () => false }
};

function loadMain() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtai-main-'));
  const prev = { LOCALAPPDATA: process.env.LOCALAPPDATA, RTAI_TEST_EXPORTS: process.env.RTAI_TEST_EXPORTS };
  process.env.LOCALAPPDATA = dataDir;
  process.env.RTAI_TEST_EXPORTS = '1';
  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return fakeElectron;
    return realLoad.call(this, request, ...rest);
  };
  delete require.cache[MAIN];
  let main;
  try {
    main = require(MAIN);
  } finally {
    Module._load = realLoad;
  }
  const restore = () => {
    delete require.cache[MAIN];
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return { main, dataDir, restore };
}

module.exports = { MAIN, loadMain };
