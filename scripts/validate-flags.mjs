#!/usr/bin/env node
// Validates apps/dashboard/flags.json against the schema in apps/dashboard/src/main/feature_flags.js.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { validateFlagsDocument } = require(path.join(root, 'apps', 'dashboard', 'src', 'main', 'feature_flags.js'));

const file = process.argv[2] || path.join(root, 'apps', 'dashboard', 'flags.json');
let doc;
try {
  doc = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`flags: cannot parse ${file}: ${e.message}`);
  process.exit(1);
}
const errors = validateFlagsDocument(doc);
if (errors.length) {
  console.error(`flags: ${file} is invalid:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`flags: ok (${Object.keys(doc.flags).length} flags)`);
