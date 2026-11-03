'use strict';
// Development wiring for the local Cue server (backend/ next to the repo
// folder, a Go service run with Docker). Running from source with no server
// configured, the dashboard and the engine it spawns use
// http://localhost:8787, and the dashboard starts the container itself if
// nothing answers there. Packaged builds never do this. RTAI_LOCAL_BACKEND=0
// turns it off.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const DEFAULT_URL = 'http://localhost:8787';
const COMPOSE_FILE = path.join('..', 'backend', 'docker-compose.yml');

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
  return fs.existsSync(path.join(repoRoot, COMPOSE_FILE)) ? DEFAULT_URL : '';
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

function compose(args, { repoRoot, port, url, spawnImpl, log, detached = false }) {
  const child = spawnImpl('docker', ['compose', '-f', path.join(repoRoot, COMPOSE_FILE), ...args], {
    cwd: repoRoot,
    env: { ...process.env, PORT: port, PUBLIC_URL: url },
    stdio: detached ? 'ignore' : ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached
  });
  if (!detached) {
    const relay = (stream, fn) => stream && stream.on('data', (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => fn(`[backend] ${l}`)));
    relay(child.stdout, (l) => log.log(l));
    relay(child.stderr, (l) => log.log(l)); // compose reports progress on stderr
  }
  return child;
}

// Builds and starts the backend container (docker compose up -d --build)
// unless a server already answers at `url`. Resolves { started, ready, stop }:
// stop() stops the container this call started (no-op otherwise).
async function ensureLocalBackend({ url, repoRoot, spawnImpl = spawn, log = console, waitMs = 240000 }) {
  const none = { started: false, ready: false, stop() {} };
  if (!isLoopbackUrl(url)) return none;
  if (!fs.existsSync(path.join(repoRoot, COMPOSE_FILE))) return none;
  if (await probe(url)) return { ...none, ready: true };

  const port = new URL(url).port || '80';
  const opts = { repoRoot, port, url, spawnImpl, log };
  const up = compose(['up', '-d', '--build'], opts);
  const code = await new Promise((resolve) => {
    up.on('error', () => resolve(-1));
    up.on('exit', (c) => resolve(c));
  });
  if (code !== 0) {
    log.warn(`[backend] could not start the local server with Docker (${code === -1 ? 'docker not found' : `exit ${code}`}). Start Docker Desktop, or set [servidor] url / RTAI_SERVER_URL.`);
    return none;
  }
  const stop = () => {
    try {
      compose(['stop'], { ...opts, detached: true }).unref();
    } catch (_e) { /* best effort on quit */ }
  };
  const deadline = Date.now() + Math.min(waitMs, 20000);
  while (Date.now() < deadline) {
    if (await probe(url, 300)) return { started: true, ready: true, stop };
    await new Promise((r) => setTimeout(r, 200));
  }
  return { started: true, ready: false, stop };
}

module.exports = { devServerUrl, ensureLocalBackend, isLoopbackUrl, DEFAULT_URL };
