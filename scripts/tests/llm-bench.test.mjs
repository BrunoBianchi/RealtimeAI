import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { askOnce, benchLines, parseArgs, percentile, renderReport, requestBody, runBench, summarize } from '../llm-bench.mjs';

function fakeUpstream(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        handler(res, seen.length);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, seen, close: () => server.close() }));
  });
}

const chunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

test('the lines are the Q7 table, the direct one mirroring the chosen line', () => {
  const lines = benchLines({ directAs: 'reasoning_off' });
  assert.deepEqual(lines.map((l) => l.id), ['baseline', 'sort_latency', 'reasoning_off', 'cerebras', 'direct_reasoning_off']);
  assert.equal(lines[0].provider_routing, null);
  assert.deepEqual(lines[1].provider_routing, { sort: 'latency' });
  assert.equal(lines[2].reasoning.effort, 'none');
  assert.deepEqual(lines[3].provider_routing, { order: ['Cerebras'] });
  assert.equal(lines[4].route, 'direct');
  assert.equal(lines[4].reasoning.effort, 'none');
  assert.throws(() => benchLines({ directAs: 'nope' }), /--direct-as/);
});

test('the baseline asks what the app asks, with no provider route', () => {
  const body = requestBody(benchLines()[0], 'sys', 'q?');
  assert.deepEqual(body.reasoning, { effort: 'minimal', exclude: true });
  assert.equal(body.stream, true);
  assert.equal('provider' in body, false);
  assert.deepEqual(body.messages.at(-1), { role: 'user', content: 'q?' });
  assert.deepEqual(requestBody(benchLines()[1], 's', 'q').provider, { sort: 'latency' });
});

test('TTFT counts visible text, not hidden reasoning, and cost comes from usage', async () => {
  const up = await fakeUpstream((res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(chunk({ choices: [{ delta: { reasoning: 'thinking' } }] }));
    setTimeout(() => {
      res.write(chunk({ choices: [{ delta: { content: 'Hi' } }] }));
      res.write(chunk({ choices: [{ delta: { content: ' there' } }], usage: { cost: 0.00012 } }));
      res.end('data: [DONE]\n\n');
    }, 60);
  });
  const r = await askOnce({ url: up.url, key: 'secret', body: { model: 'm' } });
  up.close();
  assert.equal(r.error, null);
  assert.equal(r.text, 'Hi there');
  assert.ok(r.ttft_ms >= 50, `ttft ${r.ttft_ms}: the reasoning chunk does not count`);
  assert.ok(r.total_ms >= r.ttft_ms);
  assert.equal(r.cost, 0.00012);
  assert.equal(up.seen[0].auth, 'Bearer secret');
});

test('failures are counted, not hidden', async () => {
  const up = await fakeUpstream((res, n) => {
    if (n === 1) { res.writeHead(502); res.end('{}'); return; }
    res.writeHead(200);
    if (n === 2) { res.end(chunk({ error: { message: 'no provider' } })); return; }
    res.end('data: [DONE]\n\n');
  });
  assert.equal((await askOnce({ url: up.url, key: 'k', body: {} })).error, 'HTTP 502');
  assert.equal((await askOnce({ url: up.url, key: 'k', body: {} })).error, 'no provider');
  assert.equal((await askOnce({ url: up.url, key: 'k', body: {} })).error, 'no text in the answer');
  up.close();
  assert.equal((await askOnce({ url: up.url, key: 'k', body: {} })).error, 'connection failed');
});

test('the row has every field of the data model', () => {
  const line = benchLines()[1];
  const row = summarize(line, [
    { ttft_ms: 100.4, total_ms: 900, cost: 0.001, error: null },
    { ttft_ms: 300, total_ms: 1100, cost: 0.002, error: null },
    { ttft_ms: null, total_ms: null, cost: null, error: 'HTTP 502' }
  ]);
  assert.deepEqual(Object.keys(row), ['route', 'model', 'provider_routing', 'reasoning', 'n', 'ttft_p50_ms', 'ttft_p95_ms', 'total_p50_ms', 'errors', 'usd_per_1k_answers', 'quality']);
  assert.equal(row.n, 3);
  assert.equal(row.errors, 1);
  assert.equal(row.ttft_p50_ms, 300);
  assert.equal(row.usd_per_1k_answers, 1.5);
  assert.equal(row.provider_routing, '{"sort":"latency"}');
  assert.equal(row.quality, null);
  assert.equal(percentile([], 50), null);
});

test('every line answers every question, repeat times, and a stale token is renewed', async () => {
  const lines = benchLines().slice(0, 2);
  const questions = [{ text: 'q1' }, { text: 'q2' }];
  const calls = [];
  let renewed = 0;
  const ask = async ({ key, body }) => {
    calls.push({ key, model: body.model, q: body.messages.at(-1).content });
    if (key === 'old' && calls.length === 1) return { error: 'HTTP 401' };
    return { ttft_ms: 10, total_ms: 20, text: `answer to ${body.messages.at(-1).content}`, cost: null, error: null };
  };
  let token = 'old';
  const target = async () => ({ url: 'u', key: token, retry: async () => { renewed++; token = 'new'; return token; } });
  const { rows, answers } = await runBench({ lines, questions, system: 's', repeat: 2, target, ask });
  assert.equal(renewed, 1);
  assert.equal(rows[0].n, 4);
  assert.equal(rows[0].errors, 0, 'the retried request counts once, and it worked');
  assert.equal(calls.length, 2 * 2 * 2 + 1);
  assert.equal(answers[1].byLine.sort_latency, 'answer to q2');

  const md = renderReport(rows, answers, { date: 'd', questions: 2, repeat: 2 });
  assert.match(md, /\| route \| model \|/);
  assert.match(md, /answer to q2/);
  assert.ok(!md.includes('new') && !md.includes('old'), 'tokens never reach the report');
});

test('arguments are validated', () => {
  assert.equal(parseArgs(['--repeat', '3', '--limit', '2']).repeat, 3);
  assert.throws(() => parseArgs(['--repeat', '0']), /at least 1/);
  assert.throws(() => parseArgs(['--nope', '1']), /Unknown/);
});

test('the question list is synthetic, fixed and long enough', () => {
  const file = parseArgs([]).questions;
  const { questions, system } = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(system);
  assert.ok(questions.length >= 30);
  assert.equal(new Set(questions.map((q) => q.text)).size, questions.length);
  for (const lang of ['pt', 'en']) assert.ok(questions.some((q) => q.lang === lang));
});
