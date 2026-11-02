// Wrapper for the dashboard CSS build.
//
// Why a wrapper: tailwindcss v3 bundles its own copies of browserslist and
// caniuse-lite inside peers/index.js (they are not npm dependencies, so
// `npx update-browserslist-db` cannot update them). The bundled copy is older
// than the registry, so every build printed:
//   "Browserslist: caniuse-lite is outdated. Please run: npx update-browserslist-db@latest"
// The official escape hatch is BROWSERSLIST_IGNORE_OLD_DATA=1, which only
// silences the stale-data warning. The target is Electron (a fixed, modern
// Chromium), so autoprefixer adds nothing: --no-autoprefixer skips that stage
// entirely (verified: 23 instead of 30 -webkit- prefixes, CSS still valid).
//
// Usage: node scripts/run-tailwind-css.mjs [extra tailwindcss args]
// Runs from apps/dashboard via the package.json "build:css" script.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboard = path.resolve(here, '..', 'apps', 'dashboard');
const extraArgs = process.argv.slice(2);

const result = spawnSync(
  process.execPath,
  [
    path.join(dashboard, 'node_modules', 'tailwindcss', 'lib', 'cli.js'),
    '-i', './src/renderer/tailwind.input.css',
    '-o', './src/renderer/styles.css',
    '--minify',
    '--no-autoprefixer',
    ...extraArgs
  ],
  {
    cwd: dashboard,
    stdio: 'inherit',
    env: { ...process.env, BROWSERSLIST_IGNORE_OLD_DATA: '1' }
  }
);

process.exit(result.status ?? (result.error ? 1 : 0));
