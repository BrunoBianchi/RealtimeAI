// LLM route benchmark (specs/001-backend-latency/quickstart.md, Q7). Asks every
// route the same synthetic questions from this PC and writes TTFT, total time,
// errors, cost and the answers side by side, so a person can judge quality.
//
// IT SPENDS CREDITS AND PLAN MINUTES. Start with `--repeat 1 --limit 3`.
//
//   LIPCUE_SERVER_URL=https://...   the server whose relay is measured
//   LIPCUE_DEVICE_TOKEN=rtai_...    opens one session for the relay's LLM token
//   OPENROUTER_API_KEY=sk-...       only for the direct route (skipped without it)
//
//   node scripts/llm-bench.mjs --repeat 3 [--limit N] [--direct-as sort_latency]
//        [--cerebras-model openai/gpt-oss-120b] [--out results.md]
//
// Credentials come only from the environment and are never printed or written.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_QUESTIONS = path.join(here, 'fixtures', 'llm-bench-questions.json');
const DEFAULT_OUT = path.join(here, '..', '..', 'specs', '001-backend-latency', 'benchmark-results.md');
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'qwen/qwen3.6-flash';
const CEREBRAS_MODEL = 'openai/gpt-oss-120b';
const REQUEST_TIMEOUT_MS = 60000;

// What the app sends today (openrouter_protocol.hpp, Settings::reasoning).
const APP_REASONING = { effort: 'minimal', exclude: true };

// The rows of the Q7 table. `route` decides the URL and the credential.
export function benchLines({ cerebrasModel = CEREBRAS_MODEL, directAs = 'sort_latency' } = {}) {
  const relay = [
    { id: 'baseline', route: 'relay', model: MODEL, provider_routing: null, reasoning: APP_REASONING },
    { id: 'sort_latency', route: 'relay', model: MODEL, provider_routing: { sort: 'latency' }, reasoning: APP_REASONING },
    { id: 'reasoning_off', route: 'relay', model: MODEL, provider_routing: null, reasoning: { effort: 'none', exclude: true } },
    { id: 'cerebras', route: 'relay', model: cerebrasModel, provider_routing: { order: ['Cerebras'] }, reasoning: APP_REASONING }
  ];
  const best = relay.find((l) => l.id === directAs);
  if (!best) throw new Error(`--direct-as must be one of: ${relay.map((l) => l.id).join(', ')}`);
  return [...relay, { ...best, id: `direct_${best.id}`, route: 'direct' }];
}

export function requestBody(line, system, question) {
  const body = {
    model: line.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: question }],
    stream: true,
    max_tokens: 300,
    temperature: 0.3,
    usage: { include: true },
    reasoning: line.reasoning
  };
  if (line.provider_routing) body.provider = line.provider_routing;
  return body;
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// One streamed completion. TTFT is the first visible text: hidden reasoning
// chunks do not count, because the user sees nothing until the answer starts.
export async function askOnce({ url, key, body, fetchImpl = fetch, now = () => performance.now() }) {
  const start = now();
  const result = { ttft_ms: null, total_ms: null, text: '', cost: null, error: null };
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!res.ok) {
      await res.body?.cancel();
      result.error = `HTTP ${res.status}`;
      return result;
    }
    const decoder = new TextDecoder();
    let pending = '';
    for await (const bytes of res.body) {
      pending += decoder.decode(bytes, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; }
        if (chunk.error) result.error = String(chunk.error.message || 'stream error');
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          if (result.ttft_ms === null) result.ttft_ms = now() - start;
          result.text += delta;
        }
        if (typeof chunk.usage?.cost === 'number') result.cost = chunk.usage.cost;
      }
    }
    result.total_ms = now() - start;
    if (result.ttft_ms === null && !result.error) result.error = 'no text in the answer';
  } catch (err) {
    result.error = err?.name === 'TimeoutError' ? 'timeout' : 'connection failed';
  }
  return result;
}

// The row format of data-model.md. `quality` is left for the person reading.
export function summarize(line, results) {
  const ok = results.filter((r) => !r.error);
  const ttft = ok.map((r) => r.ttft_ms);
  const costs = ok.map((r) => r.cost).filter((c) => typeof c === 'number');
  const round = (v) => (v === null ? null : Math.round(v));
  return {
    route: line.route,
    model: line.model,
    provider_routing: line.provider_routing ? JSON.stringify(line.provider_routing) : 'default',
    reasoning: line.reasoning.effort,
    n: results.length,
    ttft_p50_ms: round(percentile(ttft, 50)),
    ttft_p95_ms: round(percentile(ttft, 95)),
    total_p50_ms: round(percentile(ok.map((r) => r.total_ms), 50)),
    errors: results.length - ok.length,
    usd_per_1k_answers: costs.length ? Number(((costs.reduce((a, b) => a + b, 0) / costs.length) * 1000).toFixed(3)) : null,
    quality: null
  };
}

const COLUMNS = ['route', 'model', 'provider_routing', 'reasoning', 'n', 'ttft_p50_ms', 'ttft_p95_ms', 'total_p50_ms', 'errors', 'usd_per_1k_answers', 'quality'];

export function renderReport(rows, answers, meta) {
  const cell = (v) => (v === null || v === undefined ? '—' : String(v).replaceAll('|', '\\|').replace(/\s+/g, ' ').trim());
  const out = [`## Run of ${meta.date}`, '', `${meta.questions} questions, ${meta.repeat} repetition(s) per route, from one PC. Fill in \`quality\` after reading the answers.`, ''];
  out.push(`| ${COLUMNS.join(' | ')} |`, `|${COLUMNS.map(() => '---').join('|')}|`);
  for (const r of rows) out.push(`| ${COLUMNS.map((c) => cell(r[c])).join(' | ')} |`);
  out.push('', '### Answers, side by side', '');
  for (const a of answers) {
    out.push(`**${a.question}**`, '');
    for (const [id, text] of Object.entries(a.byLine)) out.push(`- \`${id}\`: ${cell(text)}`);
    out.push('');
  }
  return out.join('\n');
}

// Runs the lines in turn for each question, so a provider's slow minute hits all
// routes alike instead of only the one that happened to be running.
export async function runBench({ lines, questions, system, repeat, target, ask = askOnce, log = () => {} }) {
  const results = new Map(lines.map((l) => [l.id, []]));
  const answers = questions.map((q) => ({ question: q.text, byLine: {} }));
  for (let rep = 0; rep < repeat; rep++) {
    for (const [i, q] of questions.entries()) {
      for (const line of lines) {
        const { url, key, retry } = await target(line);
        const body = requestBody(line, system, q.text);
        let r = await ask({ url, key, body });
        if (r.error === 'HTTP 401' && retry) { // the session token aged out
          const fresh = await retry();
          r = await ask({ url, key: fresh, body });
        }
        results.get(line.id).push(r);
        if (r.text && !answers[i].byLine[line.id]) answers[i].byLine[line.id] = r.text;
      }
      log(`rep ${rep + 1}/${repeat}: question ${i + 1}/${questions.length}`);
    }
  }
  return { rows: lines.map((l) => summarize(l, results.get(l.id))), answers };
}

export function parseArgs(argv) {
  const args = { repeat: 1, limit: 0, directAs: 'sort_latency', cerebrasModel: CEREBRAS_MODEL, out: DEFAULT_OUT, questions: DEFAULT_QUESTIONS };
  const names = { '--repeat': 'repeat', '--limit': 'limit', '--direct-as': 'directAs', '--cerebras-model': 'cerebrasModel', '--out': 'out', '--questions': 'questions' };
  for (let i = 0; i < argv.length; i += 2) {
    const name = names[argv[i]];
    if (!name || argv[i + 1] === undefined) throw new Error(`Unknown or incomplete option: ${argv[i]}`);
    args[name] = ['repeat', 'limit'].includes(name) ? Number(argv[i + 1]) : argv[i + 1];
  }
  if (!(args.repeat >= 1)) throw new Error('--repeat must be at least 1');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const server = (process.env.LIPCUE_SERVER_URL || '').replace(/\/+$/, '');
  const device = process.env.LIPCUE_DEVICE_TOKEN || '';
  const direct = process.env.OPENROUTER_API_KEY || '';
  if (!server || !device) throw new Error('Set LIPCUE_SERVER_URL and LIPCUE_DEVICE_TOKEN.');

  const { system, questions: all } = JSON.parse(fs.readFileSync(args.questions, 'utf8'));
  const questions = args.limit > 0 ? all.slice(0, args.limit) : all;
  let lines = benchLines(args);
  if (!direct) {
    console.error('No OPENROUTER_API_KEY: skipping the direct route.');
    lines = lines.filter((l) => l.route !== 'direct');
  }

  const openSession = async () => {
    const res = await fetch(`${server}/v1/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${device}` },
      body: '{}'
    });
    if (!res.ok) throw new Error(`The server refused the session: HTTP ${res.status}`);
    return res.json();
  };
  let session = await openSession();
  const started = Date.now();
  const target = async (line) => (line.route === 'direct'
    ? { url: OPENROUTER_URL, key: direct }
    : {
        url: session.llm.url,
        key: session.llm.token,
        retry: async () => {
          session = await openSession();
          return session.llm.token;
        }
      });

  let report;
  try {
    report = await runBench({ lines, questions, system, repeat: args.repeat, target, log: (m) => console.error(m) });
  } finally {
    // Close the session so it stops counting against the plan.
    await fetch(`${server}/v1/session/${session.session_id}/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${device}` },
      body: JSON.stringify({ duration_s: (Date.now() - started) / 1000 })
    }).catch(() => {});
  }
  const text = renderReport(report.rows, report.answers, { date: new Date().toISOString().slice(0, 16), questions: questions.length, repeat: args.repeat });
  fs.appendFileSync(args.out, `${text}\n`);
  console.table(report.rows);
  console.error(`Written to ${args.out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
