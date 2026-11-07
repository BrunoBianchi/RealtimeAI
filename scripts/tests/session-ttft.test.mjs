import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../session-ttft.mjs', import.meta.url));
const SECRET = 'TRANSCRIPT-SENTINEL-41d9';

function run(sessions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-ttft-'));
  try {
    for (const [name, recs] of Object.entries(sessions)) {
      fs.writeFileSync(path.join(dir, name), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
    return execFileSync(process.execPath, [script, dir], { encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const suggestion = (ttft, speechEnd) => ({
  type: 'suggestion', t: 5000, model: 'm/x', reason: 'question', ttft_ms: ttft, total_ms: 900,
  trigger: SECRET, text: SECRET, ...(speechEnd === undefined ? {} : { speech_end_to_visible_ms: speechEnd })
});

test('splits by route and reports the speech end timing', () => {
  const out = run({
    '2026-11-01_a.jsonl': [{ type: 'session_start', route: 'relay' }, suggestion(420, 610)],
    '2026-11-02_b.jsonl': [{ type: 'session_start', route: 'direct_cerebras' }, suggestion(300, -40)]
  });
  assert.match(out, /relay \| m\/x/);
  assert.match(out, /direct_cerebras \| m\/x/);
  assert.match(out, /610/);
  assert.match(out, /-40/, 'a real negative value is kept');
});

test('older sessions without the new fields still count', () => {
  const out = run({ '2026-10-01_a.jsonl': [{ type: 'session_start' }, suggestion(777)] });
  assert.match(out, /no-route \| m\/x/);
  assert.match(out, /777/);
});

test('the no-data marker is not treated as a measurement', () => {
  const out = run({ '2026-11-01_a.jsonl': [{ type: 'session_start', route: 'relay' }, suggestion(500, -1)] });
  const section = out.split('speech end to first visible text')[1].split('first token relative')[0];
  assert.doesNotMatch(section, /relay/);
});

test('never prints what was said', () => {
  const out = run({ '2026-11-01_a.jsonl': [
    { type: 'session_start', route: 'relay' },
    { type: 'turn', t: 100, src: 'outros', text: SECRET },
    { type: 'notice', text: SECRET },
    suggestion(420, 610)
  ] });
  assert.ok(!out.includes(SECRET));
});
