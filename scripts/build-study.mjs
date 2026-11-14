// Builds Study (specs/006) from the site's sources into the dashboard renderer.
// The page runs inside the main window, in a shadow root (embedded.jsx), so the
// bundle is a classic script and the site's global selectors are rewritten for
// a shadow root: :root -> :host, html/body -> the page container.
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const windows = fileURLToPath(new URL('../', import.meta.url));
const web = resolve(windows, '../Browser/Home');
const output = resolve(windows, 'apps/dashboard/src/renderer/study');
const require = createRequire(resolve(windows, 'apps/dashboard/package.json'));
const { build } = require('esbuild');

export function shadowCss(css) {
  return css
    .replace(/:root(?=[\s,{])/g, ':host')
    .replace(/(^|[{},])\s*(?:html|body)(?:\s*,\s*(?:html|body|#study))*\s*(?=[{,])/g, '$1.lw-shadow-root');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await build({
    absWorkingDir: web,
    entryPoints: { study: 'src/components/study/embedded.jsx' },
    outdir: output,
    jsx: 'automatic',
    bundle: true,
    format: 'iife',
    minify: true,
    legalComments: 'inline',
    define: {
      'process.env.NODE_ENV': '"production"',
      __PCM_WORKLET__: JSON.stringify(await readFile(resolve(web, 'public/pcm-worklet.js'), 'utf8')),
    },
  });
  const cssFile = resolve(output, 'study.css');
  await writeFile(cssFile, shadowCss(await readFile(cssFile, 'utf8')));
  for (const old of ['index.html', 'pcm-worklet.js']) await rm(resolve(output, old), { force: true });
}
