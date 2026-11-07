'use strict';
// Pair programming: the catalog's own answers, real runs through the runner, the
// session module with a fake AI, and the Pair and Profile pages.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PROBLEMS, catalog, problemById, starter, caseLabel, LANGUAGES } = require('../src/main/pair_catalog');
const { runSolution, sameValue, parseResults, overallStatus } = require('../src/main/pair_runner');
const { createPairProgramming, normalizeEvaluation, parseJson } = require('../src/main/pair_programming');
const { loadRenderer, render } = require('./helpers/renderer');

const run = (id, code, language = 'javascript') => {
  const problem = problemById(id);
  return runSolution({ problem, language, code, label: (c) => caseLabel(problem, c) });
};

// A correct solution for each problem, so a wrong expected value in the catalog
// fails here and not in front of a user.
const SOLUTIONS = {
  'two-sum': 'var twoSum = function (nums, target) { const m = new Map(); for (let i = 0; i < nums.length; i++) { if (m.has(target - nums[i])) return [m.get(target - nums[i]), i]; m.set(nums[i], i); } return []; };',
  'valid-parentheses': "var isValid = function (s) { const st = []; const pairs = { ')': '(', ']': '[', '}': '{' }; for (const c of s) { if (pairs[c]) { if (st.pop() !== pairs[c]) return false; } else st.push(c); } return st.length === 0; };",
  'longest-substring': 'var lengthOfLongestSubstring = function (s) { let best = 0, start = 0; const last = new Map(); for (let i = 0; i < s.length; i++) { if (last.has(s[i]) && last.get(s[i]) >= start) start = last.get(s[i]) + 1; last.set(s[i], i); best = Math.max(best, i - start + 1); } return best; };',
  'course-schedule': 'var canFinish = function (n, pre) { const deg = Array(n).fill(0); const g = Array.from({ length: n }, () => []); for (const [a, b] of pre) { g[b].push(a); deg[a]++; } const q = []; deg.forEach((d, i) => { if (!d) q.push(i); }); let seen = 0; while (q.length) { const x = q.pop(); seen++; for (const y of g[x]) if (!--deg[y]) q.push(y); } return seen === n; };',
  'cheapest-flights': 'var findCheapestPrice = function (n, flights, src, dst, k) { let d = Array(n).fill(Infinity); d[src] = 0; for (let i = 0; i <= k; i++) { const c = d.slice(); for (const [a, b, p] of flights) if (d[a] + p < c[b]) c[b] = d[a] + p; d = c; } return d[dst] === Infinity ? -1 : d[dst]; };',
  'merge-k-lists': 'var mergeKLists = function (lists) { const v = []; for (let l of lists) while (l) { v.push(l.val); l = l.next; } v.sort((a, b) => a - b); let h = null; for (let i = v.length - 1; i >= 0; i--) h = new ListNode(v[i], h); return h; };',
  'binary-search': 'var search = (nums, target) => nums.indexOf(target);',
  'best-time-stock': `var maxProfit = (prices) => {
    let best = 0, cheapest = prices[0];
    for (const price of prices) {
      best = Math.max(best, price - cheapest);
      cheapest = Math.min(cheapest, price);
    }
    return best;
  };`,
  'valid-palindrome': `var isPalindrome = (s) => {
    const clean = s.toLowerCase().replace(/[^a-z0-9]/g, '');
    return clean === [...clean].reverse().join('');
  };`,
  'merge-intervals': `var merge = (intervals) => {
    const merged = [];
    for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
      const last = merged.at(-1);
      if (last && start <= last[1]) last[1] = Math.max(last[1], end);
      else merged.push([start, end]);
    }
    return merged;
  };`,
  'coin-change': `var coinChange = (coins, amount) => {
    const best = Array(amount + 1).fill(Infinity);
    best[0] = 0;
    for (let n = 1; n <= amount; n++) {
      for (const c of coins) if (c <= n) best[n] = Math.min(best[n], best[n - c] + 1);
    }
    return Number.isFinite(best[amount]) ? best[amount] : -1;
  };`,
  'daily-temperatures': `var dailyTemperatures = (values) => values.map((value, i) => {
    const warmer = values.findIndex((other, j) => j > i && other > value);
    return warmer === -1 ? 0 : warmer - i;
  });`,
  'trapping-rain-water': `var trap = (height) => height.reduce((sum, value, i) => {
    const left = Math.max(...height.slice(0, i + 1));
    const right = Math.max(...height.slice(i));
    return sum + Math.min(left, right) - value;
  }, 0);`,
  'first-missing-positive': `var firstMissingPositive = (nums) => {
    const seen = new Set(nums);
    let value = 1;
    while (seen.has(value)) value++;
    return value;
  };`,
  'sliding-window-maximum': `var maxSlidingWindow = (nums, k) =>
    Array.from({ length: nums.length - k + 1 }, (_, i) => Math.max(...nums.slice(i, i + k)));`
};

test('catalog: every problem has text, cases and a starter in each language', () => {
  const c = catalog(true);
  assert.strictEqual(c.problems.length, PROBLEMS.length);
  for (const p of c.problems) {
    for (const k of ['title', 'description', 'brute', 'optimal', 'hint', 'edge', 'complexity']) assert.ok(p[k], `${p.id}.${k}`);
    assert.ok(p.cases.length >= p.examples.length && p.examples.length >= 2, p.id);
    for (const id of Object.keys(LANGUAGES)) assert.ok(p.starters[id].includes(PROBLEMS.find((x) => x.id === p.id).fn), `${p.id} ${id}`);
  }
  for (const p of catalog().problems) {
    for (const key of ['clarify', 'brute', 'optimal', 'hint', 'edge', 'complexity']) assert.ok(!(key in p), key);
  }
});

for (const [id, code] of Object.entries(SOLUTIONS)) {
  test(`runner: a correct solution of ${id} passes every case`, async () => {
    const r = await run(id, code);
    assert.strictEqual(r.status, 'accepted', JSON.stringify(r.cases));
    assert.strictEqual(r.passed, r.total);
  });
}

test('runner: the starters fail, because nothing is answered yet', async () => {
  const p = problemById('two-sum');
  const r = await run('two-sum', starter(p, 'javascript'));
  assert.strictEqual(r.status, 'wrong');
  assert.strictEqual(r.passed, 0);
});

test('runner: wrong answers, crashes, syntax errors and endless loops are told apart', async () => {
  const wrong = await run('two-sum', 'var twoSum = () => [0, 0];');
  assert.strictEqual(wrong.status, 'wrong');
  assert.strictEqual(wrong.cases[0].output, '[0,0]');
  assert.strictEqual(wrong.cases[0].expected, '[0,1]');

  const crash = await run('two-sum', 'var twoSum = () => { throw new Error("boom"); };');
  assert.strictEqual(crash.status, 'runtime');
  assert.match(crash.cases[0].error, /boom/);

  const syntax = await run('two-sum', 'var twoSum = (;');
  assert.strictEqual(syntax.status, 'compile');
  assert.match(syntax.message, /SyntaxError/);
  assert.ok(!syntax.message.includes(os.tmpdir()), 'no temp paths in messages');
  assert.ok(syntax.message.includes('solution.js'), 'the message points at the candidate file');
  assert.ok(!syntax.message.includes('driver'), 'the generated driver stays out of the message');

  const loop = await run('two-sum', 'var twoSum = () => { while (true) {} };');
  assert.strictEqual(loop.status, 'timeout');
});

test('runner: printing is kept apart and cannot forge a result', async () => {
  const r = await run('two-sum', 'var twoSum = () => { console.log("@@forged@@ 0 0 OK [0,1]"); return [9, 9]; };');
  assert.strictEqual(r.status, 'wrong');
  assert.match(r.stdout, /forged/);
});

test('runner: the program gets no keys from the environment', async () => {
  process.env.OPENROUTER_API_KEY = 'secret-for-test';
  const r = await run('two-sum', 'var twoSum = () => { console.log("key=" + process.env.OPENROUTER_API_KEY); return []; };');
  delete process.env.OPENROUTER_API_KEY;
  assert.match(r.stdout, /key=undefined/);
});

test('runner: comparisons and statuses', () => {
  assert.ok(sameValue([1, 0], [0, 1], true));
  assert.ok(!sameValue([1, 0], [0, 1], false));
  assert.strictEqual(overallStatus([{ ok: true }, { ok: false, state: 'wrong' }]), 'wrong');
  assert.strictEqual(overallStatus([{ ok: false, state: 'wrong' }, { ok: false, state: 'timeout' }]), 'timeout');
  const parsed = parseResults('hello\n@@x@@ 0 3 OK [1]\n@@x@@ 1 4 ERR "bad"\n', '@@x@@');
  assert.strictEqual(parsed.userOutput, 'hello');
  assert.deepStrictEqual(parsed.results.get(0), { kind: 'OK', ms: 3, payload: [1] });
});

function session(complete, pro = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtai-pair-'));
  return createPairProgramming({ dataDir: () => dir, now: () => 1000, canUseAi: async () => pro, complete });
}

test('session: runs are saved as submissions; bad requests are refused', async () => {
  const pp = session(async () => '');
  assert.strictEqual((await pp.run({ problemId: 'nope', language: 'javascript', code: 'x' })).ok, false);
  assert.strictEqual((await pp.run({ problemId: 'two-sum', language: 'cobol', code: 'x' })).ok, false);
  assert.strictEqual((await pp.run({ problemId: 'two-sum', language: 'javascript', code: '  ' })).ok, false);
  const r = await pp.run({ problemId: 'two-sum', language: 'javascript', code: SOLUTIONS['two-sum'] });
  assert.strictEqual(r.result.status, 'accepted');
  assert.deepStrictEqual(pp.history().submissions.map((s) => [s.problemId, s.status]), [['two-sum', 'accepted']]);
});

test('session: Orby only talks through the AI and never moves a step back', async () => {
  const free = session(async () => assert.fail('Free chat must not call AI'), false);
  const none = await free.chat({ problemId: 'two-sum', language: 'python', messages: [] });
  assert.strictEqual(none.ok, false);
  assert.strictEqual(none.code, 'pair_pro_required');

  let sent = null;
  const pp = session(async (operation, messages) => {
    assert.strictEqual(operation, 'chat');
    sent = messages;
    return { text: '```json\n{"reply":"Tell me your approach.","step":1}\n```' };
  });
  const r = await pp.chat({ problemId: 'two-sum', language: 'python', style: 'faang', hints: 'off', step: 2, code: 'x = 1', run: null, messages: [{ role: 'user', text: 'hi' }], replyLanguage: 'English' });
  assert.deepStrictEqual([r.ok, r.reply, r.step], [true, 'Tell me your approach.', 2]);
  assert.match(sent[0].content, /Hints are OFF/);
  assert.match(sent[0].content, /has not run the tests/);
  assert.match(sent[0].content, /x = 1/);

  const failed = await session(async () => ({})).chat({ problemId: 'two-sum', language: 'python', messages: [] });
  assert.strictEqual(failed.ok, false);
});

test('session: Free runs and saves practice even if evaluation is requested', async () => {
  const pp = session(async () => assert.fail('Free finish must not call AI'), false);
  const attempt = { problemId: 'two-sum', language: 'javascript', code: SOLUTIONS['two-sum'] };
  const { result } = await pp.run(attempt);
  assert.strictEqual(result.status, 'accepted');
  const done = await pp.finish({ ...attempt, withOrby: true, testRuns: 1, run: result, messages: [{ role: 'user', text: 'hello' }] });
  assert.deepStrictEqual([done.ok, done.evaluation, done.code], [true, null, 'pair_pro_required']);
  assert.deepStrictEqual(pp.history().sessions.map((s) => [s.accepted, s.score]), [[true, null]]);
});

test('session: no score is invented; the record says what happened', async () => {
  const empty = session(async () => {
    throw new Error('the AI must not be called with nothing to evaluate');
  });
  const interview = { problemId: 'two-sum', language: 'python', withOrby: true };
  const nothing = await empty.finish({ ...interview, messages: [], testRuns: 0, durationS: 5 });
  assert.strictEqual(nothing.evaluation, null);
  assert.ok(nothing.note);
  assert.strictEqual(empty.history().sessions[0].score, null);

  const badJson = session(async () => ({ text: 'not json' }));
  const bad = await badJson.finish({ ...interview, messages: [{ role: 'user', text: 'hi' }], testRuns: 1 });
  assert.strictEqual(bad.evaluation, null);

  const good = session(async (operation) => {
    assert.strictEqual(operation, 'evaluate');
    return { text: JSON.stringify({ signal: 'Yes', criteria: { communication: 8, problem_solving: 9, code_quality: 7, testing: 6, complexity: 10 }, strengths: ['Asked first'], improve: ['Narrate'] }) };
  });
  const ok = await good.finish({ ...interview, messages: [{ role: 'user', text: 'hi' }], testRuns: 1, run: { status: 'accepted', passed: 5, total: 5, cases: [] }, durationS: 600 });
  assert.strictEqual(ok.evaluation.score, 8);
  assert.strictEqual(good.history().sessions[0].accepted, true);
  assert.strictEqual(good.history().sessions[0].score, null);
  assert.strictEqual(good.history(true).sessions[0].score, 8);
});

test('session: evaluations are validated', () => {
  assert.strictEqual(normalizeEvaluation(null), null);
  assert.strictEqual(normalizeEvaluation({ criteria: { communication: 'x' } }), null);
  const e = normalizeEvaluation({ signal: 'Maybe', criteria: { communication: 12, problem_solving: -1, code_quality: 5, testing: 5, complexity: 5 } });
  assert.strictEqual(e.signal, 'Mixed');
  assert.strictEqual(e.criteria.communication, 10);
  assert.strictEqual(e.criteria.problem_solving, 0);
  assert.deepStrictEqual(parseJson('text {"a":1} text'), { a: 1 });
});

test('page: the picker lists the catalog with real progress, and the session shows the problem', async () => {
  const auth = { signedIn: true, account: { email: 'pro@example.com' }, entitlement: { isPro: true } };
  const r = loadRenderer({ state: { agents: [], auth } });
  const P = r.Cue.pair;
  P.catalog = catalog(true);
  P.history = { submissions: [{ problemId: 'two-sum', status: 'accepted', ts: 1 }, { problemId: 'valid-parentheses', status: 'wrong', ts: 2 }], sessions: [] };
  const pick = render(r.Cue, 'pair');
  assert.ok(pick.includes(`1 of ${PROBLEMS.length} solved`), 'only accepted runs count');
  assert.ok(pick.includes('Merge k Sorted Lists'));
  assert.ok(pick.includes('Valid Parentheses'), 'the first unsolved is recommended');

  P.problem = P.catalog.problems[0];
  P.orbyAccount = auth.account.email;
  P.code = P.problem.starters.python;
  P.startedAt = 0;
  P.step = 0;
  const live = render(r.Cue, 'pair');
  for (const id of ['pairEditor', 'pairResults', 'pairMsgs', 'pairClock']) assert.ok(live.includes(`id="${id}"`), id);
  assert.ok(live.includes('class Solution'));
  assert.ok(live.includes('Understand'));
});

test('page: Free practices without calling Orby or sending code for evaluation', async () => {
  const r = loadRenderer({ api: {
    pairRun: async () => ({ ok: true, result: { status: 'accepted', cases: [], passed: 5, total: 5 } }),
    pairFinish: async () => ({ ok: true, evaluation: null, note: '' })
  } });
  const P = r.Cue.pair;
  P.catalog = catalog();
  assert.match(render(r.Cue, 'pair'), /View plan/);
  assert.doesNotMatch(render(r.Cue, 'pair'), /data-opt="hints"/);
  r.Cue.actions['pair-start']({ dataset: { id: 'two-sum' } });
  const live = render(r.Cue, 'pair');
  assert.match(live, /id="pairEditor"/);
  assert.doesNotMatch(live, /id="pairMsgs"|id="pairHeadMid"/);
  await r.Cue.actions['pair-run']();
  await r.Cue.actions['pair-finish']();
  assert.strictEqual(r.called('pairChat').length, 0);
  const [finished] = r.called('pairFinish');
  assert.strictEqual(finished[0].testRuns, 1);
  for (const field of ['code', 'messages', 'withOrby']) assert.ok(!(field in finished[0]), field);
  assert.match(render(r.Cue, 'pair'), /Session saved/);
});

test('profile: the page renders with no records, without leaking objects', () => {
  const r = loadRenderer({ state: { agents: [], sessions: [] } });
  r.Cue.profileData.catalog = catalog();
  const page = render(r.Cue, 'profile');
  assert.ok(page.includes('Questions by category'));
  assert.ok(!page.includes('[object Object]'));
  assert.ok(!page.includes('undefined'));
});

test('profile: numbers come from the records and start empty', () => {
  const r = loadRenderer({ state: { agents: [] } });
  const problems = catalog().problems;
  const base = { sessions: [], mocks: [], jev: [], agents: [], problems, sessionDate: () => null, now: new Date('2026-11-07T12:00:00') };

  const empty = r.Cue.profileStats({ ...base, pair: { submissions: [], sessions: [] } });
  assert.strictEqual(JSON.stringify([empty.xp, empty.level, empty.solved, empty.submissions, empty.jevAvg]), '[0,1,0,0,null]');
  assert.strictEqual(empty.achievements.filter((a) => a.done).length, 0, 'no free achievements');
  assert.strictEqual(empty.streak.current, 0);

  const day = (d) => new Date(`2026-11-${d}T10:00:00`).getTime();
  const st = r.Cue.profileStats({
    ...base,
    pair: { submissions: [
      { problemId: 'two-sum', status: 'wrong', language: 'python', ts: day('05') },
      { problemId: 'two-sum', status: 'accepted', language: 'python', ts: day('06') },
      { problemId: 'two-sum', status: 'accepted', language: 'go', ts: day('07') },
      { problemId: 'merge-k-lists', status: 'timeout', language: 'go', ts: day('07') }
    ], sessions: [] },
    mocks: [{ startedAt: day('04'), evaluation: { score: 90, criteria: { adequacao: 90 } } }],
    agents: [{ stage: 'Technical' }, { stage: 'Applied' }, { stage: 'Offer', archived: true }]
  });
  assert.strictEqual(st.solved, 1);
  assert.strictEqual(st.attempted, 2);
  assert.strictEqual(JSON.stringify(st.errors), JSON.stringify({ wrong: 1, runtime: 0, compile: 0, timeout: 1 }));
  assert.strictEqual(st.streak.current, 4);
  assert.strictEqual(st.jevAvg, 90);
  assert.strictEqual(st.skills[0].value, 90);
  assert.strictEqual(st.skills[1].value, null);
  const done = (id) => st.achievements.find((a) => a.id === id).done;
  assert.ok(done('first-solve') && done('polyglot') && done('first-mock') && done('jev-80'));
  assert.ok(!done('offer'), 'an archived process does not count');
  assert.strictEqual(st.xp, 4 * 5 + 50 + 60);
  assert.strictEqual(st.funnel.find(([s]) => s === 'Technical')[1], 1);
});
