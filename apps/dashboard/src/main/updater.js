// Real auto-update on top of electron-updater + GitHub Releases.
//
// Channels:
//   stable -> only full releases (latest.yml)
//   beta   -> prereleases too (beta.yml). Stable builds also publish beta.yml
//             (generateUpdatesFilesForAllChannels), so beta testers get every
//             stable release as well.
//
// electron-updater is required lazily: tests load main.js with a stubbed
// 'electron', and a dev run (not packaged) has no app-update.yml.

'use strict';

function stripHtml(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function notesToText(notes) {
  if (Array.isArray(notes)) return notes.map((n) => `${n.version}\n${stripHtml(n.note)}`).join('\n\n');
  return stripHtml(notes);
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  const mb = n / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

function createUpdater(opts) {
  const app = opts.app;
  const send = opts.send || (() => {});
  const log = opts.log || (() => {});
  const getChannel = opts.getChannel || (() => 'stable');
  const getAutoUpdate = opts.getAutoUpdate || (() => true);
  const beforeInstall = opts.beforeInstall || (() => {});
  const markQuitting = opts.markQuitting || (() => {});

  const currentVersion = app.getVersion();
  let updater = null;
  let disabledReason = '';
  let state = { status: 'idle', currentVersion, latestVersion: currentVersion, hasUpdate: false };
  let timer = null;

  function publish(patch) {
    state = { ...state, ...patch, channel: getChannel() };
    send('rtai:update-status', state);
    return state;
  }

  function load() {
    if (updater || disabledReason) return updater;
    if (!app.isPackaged) {
      disabledReason = 'Updates only run in the installed app (this is a dev build).';
      return null;
    }
    try {
      updater = require('electron-updater').autoUpdater;
    } catch (e) {
      disabledReason = `electron-updater unavailable: ${e.message}`;
      return null;
    }
    updater.logger = { info: log, warn: log, error: log, debug: () => {} };
    updater.autoInstallOnAppQuit = true;
    updater.allowDowngrade = false;
    applyChannel();

    updater.on('checking-for-update', () => publish({ status: 'checking', error: '' }));
    updater.on('update-not-available', (info) => publish({
      status: 'up-to-date', hasUpdate: false, latestVersion: (info && info.version) || currentVersion
    }));
    updater.on('update-available', (info) => publish({
      status: 'available',
      hasUpdate: true,
      latestVersion: info.version,
      releaseName: info.releaseName || `RealTimeAI ${info.version}`,
      releaseNotes: notesToText(info.releaseNotes),
      releaseDate: info.releaseDate || '',
      prerelease: /-/.test(info.version)
    }));
    updater.on('download-progress', (p) => {
      const info = {
        percent: Math.round(p.percent || 0),
        transferred: formatBytes(p.transferred),
        total: formatBytes(p.total),
        speed: p.bytesPerSecond ? `${formatBytes(p.bytesPerSecond)}/s` : ''
      };
      publish({ status: 'downloading', progress: info });
      send('rtai:update-progress', info);
    });
    updater.on('update-downloaded', (info) => {
      publish({ status: 'downloaded', latestVersion: info.version });
      send('rtai:update-downloaded', { version: info.version, releaseName: info.releaseName || '' });
    });
    updater.on('error', (err) => publish({ status: 'error', error: err ? err.message || String(err) : 'unknown error' }));
    return updater;
  }

  function applyChannel() {
    if (!updater) return;
    const beta = getChannel() === 'beta';
    updater.allowPrerelease = beta;
    updater.channel = beta ? 'beta' : 'latest';
    updater.autoDownload = Boolean(getAutoUpdate());
  }

  async function check() {
    const u = load();
    if (!u) return publish({ status: 'disabled', hasUpdate: false, error: disabledReason });
    applyChannel();
    try {
      await u.checkForUpdates();
    } catch (e) {
      publish({ status: 'error', error: e.message || String(e) });
    }
    return state;
  }

  async function download() {
    const u = load();
    if (!u) return { ok: false, error: disabledReason };
    if (state.status === 'downloaded') return { ok: true };
    try {
      await u.downloadUpdate();
      return { ok: true };
    } catch (e) {
      publish({ status: 'error', error: e.message || String(e) });
      return { ok: false, error: e.message || String(e) };
    }
  }

  async function install() {
    const u = load();
    if (!u || state.status !== 'downloaded') return { ok: false, error: 'No downloaded update to install.' };
    try { await beforeInstall(); } catch (_e) {}
    markQuitting();
    // isSilent: the NSIS one-click installer runs without UI; forceRunAfter: reopen.
    setImmediate(() => u.quitAndInstall(true, true));
    return { ok: true, version: state.latestVersion };
  }

  function setChannel() {
    applyChannel();
    publish({});
    return check();
  }

  function start(intervalMs = 15 * 60 * 1000) {
    if (!load()) {
      publish({ status: 'disabled', error: disabledReason });
      return;
    }
    setTimeout(() => { if (getAutoUpdate()) check(); }, 5000);
    timer = setInterval(() => { if (getAutoUpdate()) check(); }, intervalMs);
    if (timer.unref) timer.unref();
  }

  return {
    check,
    download,
    install,
    setChannel,
    start,
    status: () => ({ ...state, channel: getChannel(), disabledReason })
  };
}

module.exports = { createUpdater, stripHtml, notesToText, formatBytes };
