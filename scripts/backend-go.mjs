#!/usr/bin/env node
// Runs a Go command for backend/ (e.g. `node scripts/backend-go.mjs test ./...`)
// with the local Go toolchain when there is one, otherwise in the golang Docker
// image with cached modules and build output.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GO_IMAGE = 'golang:1.26-alpine';
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'backend');
const args = process.argv.slice(2);
// backend/ is git-ignored (kept local): nothing to do in a clone without it.
if (!fs.existsSync(path.join(backend, 'go.mod'))) {
  console.log('backend/: not in this checkout, skipped');
  process.exit(0);
}
if (!args.length) {
  console.error('usage: node scripts/backend-go.mjs <go args...>   (e.g. test ./...)');
  process.exit(2);
}

const hasGo = spawnSync('go', ['version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;
const run = hasGo
  ? spawnSync('go', args, { cwd: backend, stdio: 'inherit', shell: process.platform === 'win32' })
  : spawnSync('docker', [
      'run', '--rm',
      '-v', `${backend}:/src`, '-w', '/src',
      '-v', 'rtai-gomod:/go/pkg/mod', '-v', 'rtai-gocache:/root/.cache/go-build',
      '-e', 'CGO_ENABLED=0',
      GO_IMAGE, 'go', ...args
    ], { stdio: 'inherit' });

if (run.error) {
  console.error(hasGo ? run.error.message : 'Neither Go nor Docker is available: install one to build the backend.');
  process.exit(1);
}
process.exit(run.status ?? 1);
