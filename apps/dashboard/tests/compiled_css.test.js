const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { OUTPUT } = require('./helpers/css');
const { indexHtml, sources } = require('./helpers/renderer');

const dashboard = path.resolve(__dirname, '..');
const cli = path.join(dashboard, 'node_modules', 'tailwindcss', 'lib', 'cli.js');

// Classes that only exist as JavaScript hooks, never styled.
const JS_HOOKS = new Set(['live-partials']);

test('Task 6.2: styles.css is the current build of tailwind.input.css', { skip: !fs.existsSync(cli) && 'tailwindcss not installed' }, () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rtai-css-')), 'styles.css');
  // Same flags as scripts/run-tailwind-css.mjs (npm run build:css).
  const res = spawnSync(process.execPath, [cli, '-i', './src/renderer/tailwind.input.css', '-o', out, '--minify', '--no-autoprefixer'], {
    cwd: dashboard,
    env: { ...process.env, BROWSERSLIST_IGNORE_OLD_DATA: '1' },
    encoding: 'utf8'
  });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(
    fs.readFileSync(out, 'utf8') === fs.readFileSync(OUTPUT, 'utf8'),
    'styles.css is stale: edit tailwind.input.css and run `npm run build:css`'
  );
});

test('Task 6.2: every class the renderer puts in markup is defined in styles.css', () => {
  const css = fs.readFileSync(OUTPUT, 'utf8');
  const defined = new Set([...css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  const used = new Set();
  for (const src of [indexHtml, ...Object.values(sources)]) {
    for (const m of src.matchAll(/class="([^"]*)"/g)) {
      // Static names, plus both branches of `${cond ? 'a' : 'b'}` inside the attribute.
      const literal = m[1].replace(/\$\{[^}]*\}/g, ' ');
      for (const c of literal.split(/\s+/)) if (/^[a-z][\w-]*$/.test(c)) used.add(c);
      for (const t of m[1].matchAll(/\?\s*'([a-z][\w -]*)'\s*:\s*'([a-z][\w -]*)?'/g)) {
        for (const c of `${t[1]} ${t[2] || ''}`.split(/\s+/)) if (c) used.add(c);
      }
    }
  }
  assert.ok(used.size > 150, `found ${used.size} classes`);
  const missing = [...used].filter((c) => !defined.has(c) && !JS_HOOKS.has(c));
  assert.deepStrictEqual(missing, [], `classes used in markup but not defined in styles.css: ${missing.join(', ')}`);
});
