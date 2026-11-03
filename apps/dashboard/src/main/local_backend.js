'use strict';
// Development wiring for the local RealTimeAI server (backend/ at the repo
// root). Running from source with no server configured, the dashboard and the
// engine it spawns use http://localhost:8787, and the dashboard starts that
// server itself if nothing answers there. Packaged builds never do this.
// RTAI_LOCAL_BACKEND=0 turns it off.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const DEFAULT_URL = 'http://localhost:8787';

function isLoopbackUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch (_e) {
    return false;
  }
}

// The server URL to use when running from source: an explicit RTAI_SERVER_URL
// or config wins; otherwise the local backend if the repo has one.
function devServerUrl({ packaged, env = process.env, repoRoot, configuredUrl = '' }) {
  if (packaged || env.RTAI_LOCAL_BACKEND === '0') return '';
  if (env.RTAI_SERVER_URL || configuredUrl) return '';
  return fs.existsSync(path.join(repoRoot, 'backend', 'index.js')) ? DEFAULT_URL : '';
}

function probe(url, timeoutMs = 600) {
  return new Promise((resolve) => {
    const req = http.get(new URL('/health', url), { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Starts backend/index.js with this Electron binary acting as Node, unless a
// server already answers at `url`. Resolves { child, started, ready }.
async function ensureLocalBackend({ url, repoRoot, execPath = process.execPath, spawnImpl = spawn, log = console, waitMs = 4000 }) {
  if (!isLoopbackUrl(url)) return { child: null, started: false, ready: false };
  const entry = path.join(repoRoot, 'backend', 'index.js');
  if (!fs.existsSync(entry)) return { child: null, started: false, ready: false };
  if (await probe(url)) return { child: null, started: false, ready: true };

  const port = new URL(url).port || '80';
  const child = spawnImpl(execPath, [entry], {
    cwd: path.dirname(entry),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: port, PUBLIC_URL: url },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  const relay = (stream, fn) => stream && stream.on('data', (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => fn(`[backend] ${l}`)));
  relay(child.stdout, (l) => log.log(l));
  relay(child.stderr, (l) => log.warn(l));
  child.on('exit', (code) => log.log(`[backend] exited (${code})`));

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return { child: null, started: false, ready: false };
    if (await probe(url, 300)) return { child, started: true, ready: true };
    await new Promise((r) => setTimeout(r, 150));
  }
  return { child, started: true, ready: false };
}

module.exports = { devServerUrl, ensureLocalBackend, isLoopbackUrl, DEFAULT_URL };
