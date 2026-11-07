// TTFT and "speech end to first visible text" from the session logs on this
// machine, split by how each session reached the LLM (the `route` field of
// session_start). Prints numbers, model names and routes only, never transcript
// text. Sessions older than the `route` field show as "no-route", or as
// "local(+500)" when their notices say they ran in local mode.
//
//   node scripts/session-ttft.mjs [sessions-folder]
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || path.join(process.env.LOCALAPPDATA || '', 'RealTimeAI', 'sessions');
if (!fs.existsSync(dir)) {
  console.error(`No sessions folder at ${dir}`);
  process.exit(1);
}
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const row = (label, a) => ({ label, n: a.length, min: a.length ? Math.min(...a) : null, p25: pct(a, 25), p50: pct(a, 50), p95: pct(a, 95), max: a.length ? Math.max(...a) : null });

const ttft = {};
const speechEnd = {};
const closeLag = {};
const days = {};
for (const f of files) {
  const recs = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const start = recs.find((r) => r.type === 'session_start');
  const notices = recs.filter((r) => r.type === 'notice').map((r) => String(r.text ?? r.message ?? r.msg ?? ''));
  const route = start?.route || (notices.some((n) => /500 ms/.test(n)) ? 'local(+500)' : 'no-route');
  let lastOutros = null;
  for (const r of recs) {
    if (r.type === 'turn' && r.src === 'outros') lastOutros = r.t;
    if (r.type !== 'suggestion' || r.model === 'demo/roteiro-local') continue;
    if (!(r.ttft_ms >= 0) || r.reason === 'screenshot') continue;
    const key = `${route} | ${r.model}`;
    (ttft[key] ||= []).push(r.ttft_ms);
    // -1 means no data; other negatives are real (text before the speech end).
    if (typeof r.speech_end_to_visible_ms === 'number' && r.speech_end_to_visible_ms !== -1) {
      (speechEnd[key] ||= []).push(r.speech_end_to_visible_ms);
    }
    if (r.reason === 'question' && lastOutros !== null && r.total_ms >= 0) {
      (closeLag[key] ||= []).push(r.t - r.total_ms + r.ttft_ms - lastOutros); // first token minus turn close
    }
    (days[key] ||= new Set()).add(f.slice(0, 10));
  }
}
console.log('TTFT, ms');
console.table(Object.entries(ttft).sort().map(([k, v]) => row(k, v)));
console.log('speech end to first visible text, ms (negative = text came first)');
console.table(Object.entries(speechEnd).sort().map(([k, v]) => row(k, v)));
console.log('first token relative to the interviewer turn close, ms (negative = before close)');
console.table(Object.entries(closeLag).sort().map(([k, v]) => row(k, v)));
console.log(Object.entries(days).sort().map(([k, v]) => `${k}: ${[...v].sort()[0]} .. ${[...v].sort().at(-1)} (${v.size} days)`).join('\n'));
