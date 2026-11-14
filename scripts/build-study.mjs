import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const windows = fileURLToPath(new URL('../', import.meta.url));
const web = resolve(windows, '../Browser/Home');
const output = resolve(windows, 'apps/dashboard/src/renderer/study');
const require = createRequire(resolve(windows, 'apps/dashboard/package.json'));
const { build } = require('esbuild');
await build({
  absWorkingDir: web,
  entryPoints: { study: 'src/components/study/desktop.jsx' },
  outdir: output,
  jsx: 'automatic',
  bundle: true,
  format: 'esm',
  minify: true,
  legalComments: 'inline',
  define: { 'process.env.NODE_ENV': '"production"' },
});
await copyFile(resolve(web, 'public/pcm-worklet.js'), resolve(output, 'pcm-worklet.js'));
