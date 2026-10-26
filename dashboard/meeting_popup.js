'use strict';
// The "meeting detected" popup: a small always-on-top card in the bottom-right
// corner of the screen the cursor is on. It is shown without taking focus, so
// typing in the meeting is never interrupted.
//
// Two kinds share the window:
//   started -> pick a goal, "Start copilot" / "Not now" / "Don't ask for <app>"
//   ended   -> the copilot started for this meeting is still on: "Stop copilot"

const path = require('path');

const WIDTH = 372;
const MARGIN = 16;
const MIN_H = 150;
const MAX_H = 420;

function createMeetingPopup(deps) {
  const {
    BrowserWindow,
    screen,
    ipcMain,
    preloadPath = path.join(__dirname, 'meeting_popup_preload.js'),
    htmlPath = path.join(__dirname, 'src', 'meeting_popup.html'),
    contentProtection = () => false,
    onStart = async () => ({ ok: false }),
    onStop = async () => ({ ok: true }),
    onDismiss = () => {},
    onOpenDashboard = () => {}
  } = deps;

  let win = null;
  let payload = null;

  function anchor(height) {
    let area = { x: 0, y: 0, width: 1280, height: 720 };
    try {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      area = display.workArea;
    } catch (_e) {}
    return {
      x: Math.round(area.x + area.width - WIDTH - MARGIN),
      y: Math.round(area.y + area.height - height - MARGIN),
      width: WIDTH,
      height
    };
  }

  function send() {
    if (win && !win.isDestroyed() && payload) win.webContents.send('popup:data', payload);
  }

  function show(next) {
    payload = next;
    if (win && !win.isDestroyed()) {
      send();
      if (!win.isVisible()) win.showInactive();
      return;
    }
    const dark = payload.theme === 'dark';
    win = new BrowserWindow({
      ...anchor(230),
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      title: 'RealTimeAI',
      backgroundColor: dark ? '#15151A' : '#FFFFFF',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    win.setAlwaysOnTop(true, 'pop-up-menu');
    try {
      // Follows Settings > Stealth "screen-recording invisibility", so the card
      // does not show up in a screen share when that setting is on.
      if (contentProtection()) win.setContentProtection(true);
    } catch (_e) {}
    win.setMenu(null);
    win.on('closed', () => {
      win = null;
      payload = null;
    });
    win.loadFile(htmlPath);
  }

  function close() {
    if (win && !win.isDestroyed()) win.close();
    win = null;
    payload = null;
  }

  function fromPopup(event) {
    return win && !win.isDestroyed() && event.sender === win.webContents;
  }

  // Shown once the card has measured itself, so it never jumps in size.
  function reveal() {
    if (win && !win.isDestroyed() && !win.isVisible()) win.showInactive();
  }

  ipcMain.on('popup:ready', (event) => {
    if (!fromPopup(event)) return;
    send();
    setTimeout(reveal, 400); // fallback if no size arrives
  });

  ipcMain.on('popup:resize', (event, height) => {
    if (!fromPopup(event)) return;
    const h = Math.max(MIN_H, Math.min(MAX_H, Math.round(Number(height) || 0)));
    win.setBounds(anchor(h));
    reveal();
  });

  ipcMain.handle('popup:start', async (event, { agentId } = {}) => {
    if (!fromPopup(event)) return { ok: false, error: 'Not allowed.' };
    const meeting = payload && payload.meeting;
    let res;
    try {
      res = await onStart(String(agentId || ''), meeting);
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    if (res && res.ok) close();
    return res || { ok: false };
  });

  ipcMain.handle('popup:stop', async (event) => {
    if (!fromPopup(event)) return { ok: false };
    const meeting = payload && payload.meeting;
    let res = { ok: true };
    try {
      res = await onStop(meeting);
    } catch (_e) {}
    close();
    return res;
  });

  ipcMain.on('popup:dismiss', (event, opts = {}) => {
    if (!fromPopup(event)) return;
    const current = payload;
    close();
    onDismiss(String((opts && opts.reason) || 'close'), current);
  });

  ipcMain.on('popup:open-dashboard', (event) => {
    if (!fromPopup(event)) return;
    onOpenDashboard();
  });

  return {
    show,
    close,
    isOpen: () => Boolean(win && !win.isDestroyed()),
    current: () => payload
  };
}

module.exports = { createMeetingPopup };
