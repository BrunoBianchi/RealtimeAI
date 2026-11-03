// Lists the dashboard interface text a translation catalog does not cover.
//
//   node scripts/i18n-check.mjs [locale...]     (default: every catalog)
//
// Renders every screen, settings tab and dialog with sample data (see
// apps/dashboard/tests/helpers/i18n_coverage.js) and prints the English
// strings that would stay untranslated. Exits 1 when any are missing.
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dashboard = path.join(root, 'apps', 'dashboard');
const { missing } = require(path.join(dashboard, 'tests', 'helpers', 'i18n_coverage.js'));

const locales = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(path.join(dashboard, 'src', 'renderer', 'locales')).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3));

let total = 0;
for (const locale of locales) {
  const list = await missing(locale);
  total += list.length;
  if (!list.length) {
    console.log(`${locale}: complete`);
    continue;
  }
  console.log(`${locale}: ${list.length} untranslated`);
  for (const s of list) console.log(`  ${JSON.stringify(s)}`);
}
process.exit(total ? 1 : 0);
