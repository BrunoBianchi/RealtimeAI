// Copies copilot_system_prompt() from the engine header into the site's JS
// port (COPILOT_SYSTEM in Browser/Home/src/lib/live/prompt.js), so the two
// are never edited by hand in two places. Run it after changing the prompt,
// then regenerate the fixtures:
//   node tests/fixtures/live_parity/sync_system_prompt.mjs
//   node tests/fixtures/live_parity/generate.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const hpp = path.resolve(here, '../../../src/core/include/rtai/copilot_prompt.hpp');
const js = path.resolve(here, '../../../../Browser/Home/src/lib/live/prompt.js');

const src = readFileSync(hpp, 'utf8');
const start = src.indexOf('inline std::string copilot_system_prompt() {');
if (start < 0) throw new Error('copilot_system_prompt() not found in copilot_prompt.hpp');
const body = src.slice(start, src.indexOf('\n}', start));

// The function body is one string literal split over many lines.
let prompt = '';
const literal = /"((?:[^"\\]|\\.)*)"/g;
let m;
while ((m = literal.exec(body))) prompt += m[1].replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c));

const port = readFileSync(js, 'utf8');
const line = /^export const COPILOT_SYSTEM = .*$/m;
if (!line.test(port)) throw new Error('COPILOT_SYSTEM line not found in prompt.js');
const next = port.replace(line, () => `export const COPILOT_SYSTEM = ${JSON.stringify(prompt)};`);
if (next === port) {
  console.log('system prompt already in sync');
} else {
  writeFileSync(js, next);
  console.log(`system prompt copied (${Buffer.byteLength(prompt)} bytes)`);
}
