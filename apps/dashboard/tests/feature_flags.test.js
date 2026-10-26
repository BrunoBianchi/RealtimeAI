const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  bucketFor,
  compareVersions,
  validateFlagsDocument,
  evaluateFlag,
  evaluateFlags,
  createFlagStore
} = require('../src/main/feature_flags');

const bundledPath = path.resolve(__dirname, '../flags.json');

test('flags: bundled flags.json is valid', () => {
  const doc = JSON.parse(fs.readFileSync(bundledPath, 'utf8'));
  assert.deepStrictEqual(validateFlagsDocument(doc), []);
});

test('flags: validation catches bad documents', () => {
  assert.ok(validateFlagsDocument({ schema: 2, flags: {} }).length > 0);
  assert.ok(validateFlagsDocument({ schema: 1, flags: { BadKey: { description: 'x' } } }).length > 0);
  assert.ok(validateFlagsDocument({ schema: 1, flags: { a: { description: 'x', rollout: 150 } } }).length > 0);
  assert.ok(validateFlagsDocument({ schema: 1, flags: { a: { description: 'x', rollout: { nightly: 10 } } } }).length > 0);
  assert.ok(validateFlagsDocument({ schema: 1, flags: { a: { description: 'x', variants: { only: 1 } } } }).length > 0);
  assert.ok(validateFlagsDocument({ schema: 1, flags: { a: { description: 'x', variants: { off: 1, b: 1 } } } }).length > 0);
  assert.ok(validateFlagsDocument({ schema: 1, flags: { a: { description: '' } } }).length > 0);
});

test('flags: bucket is deterministic and spread across 0-99', () => {
  assert.strictEqual(bucketFor('install-1', 'x'), bucketFor('install-1', 'x'));
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(bucketFor(`id-${i}`, 'flag'));
  assert.ok(seen.size > 95, `buckets too clustered: ${seen.size}`);
});

test('flags: rollout percentage is respected across installs', () => {
  const def = { description: 'x', rollout: { stable: 20, beta: 100 } };
  let on = 0;
  const N = 5000;
  for (let i = 0; i < N; i++) {
    if (evaluateFlag('f', def, { channel: 'stable', installId: `i${i}` }).enabled) on++;
  }
  assert.ok(Math.abs(on / N - 0.2) < 0.03, `expected ~20%, got ${(100 * on / N).toFixed(1)}%`);
  for (let i = 0; i < 200; i++) {
    assert.ok(evaluateFlag('f', def, { channel: 'beta', installId: `i${i}` }).enabled);
  }
});

test('flags: 0% and channel restrictions keep stable users out', () => {
  const def = { description: 'x', rollout: { stable: 0, beta: 100 } };
  for (let i = 0; i < 200; i++) {
    assert.strictEqual(evaluateFlag('f', def, { channel: 'stable', installId: `i${i}` }).enabled, false);
  }
  const betaOnly = { description: 'x', channels: ['beta'], default: true };
  const r = evaluateFlag('f', betaOnly, { channel: 'stable', installId: 'a' });
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(r.source, 'channel');
  assert.strictEqual(evaluateFlag('f', betaOnly, { channel: 'beta', installId: 'a' }).enabled, true);
});

test('flags: A/B variants split by weight and stay sticky per install', () => {
  const def = { description: 'x', rollout: 100, variants: { a: 50, b: 50 } };
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 4000; i++) {
    const r = evaluateFlag('ab', def, { channel: 'stable', installId: `u${i}` });
    counts[r.variant]++;
  }
  assert.ok(Math.abs(counts.a / 4000 - 0.5) < 0.04, JSON.stringify(counts));
  const once = evaluateFlag('ab', def, { channel: 'stable', installId: 'same' }).variant;
  for (let i = 0; i < 10; i++) {
    assert.strictEqual(evaluateFlag('ab', def, { channel: 'stable', installId: 'same' }).variant, once);
  }
  const skewed = { description: 'x', rollout: 100, variants: { a: 90, b: 10 } };
  let a = 0;
  for (let i = 0; i < 4000; i++) if (evaluateFlag('s', skewed, { installId: `k${i}` }).variant === 'a') a++;
  assert.ok(Math.abs(a / 4000 - 0.9) < 0.03, `expected ~90% a, got ${a / 40}%`);
});

test('flags: overrides win over rollout, channel and variants', () => {
  const def = { description: 'x', rollout: { stable: 0, beta: 0 }, variants: { a: 1, b: 1 } };
  assert.strictEqual(evaluateFlag('f', def, { installId: 'z', override: 'on' }).enabled, true);
  assert.strictEqual(evaluateFlag('f', def, { installId: 'z', override: 'b' }).variant, 'b');
  const on = { description: 'x', default: true };
  const off = evaluateFlag('f', on, { installId: 'z', override: 'off' });
  assert.strictEqual(off.enabled, false);
  assert.strictEqual(off.source, 'override');
});

test('flags: min_version gates older builds', () => {
  const def = { description: 'x', default: true, min_version: '2.1.0' };
  assert.strictEqual(evaluateFlag('f', def, { installId: 'a', appVersion: '2.0.9' }).enabled, false);
  assert.strictEqual(evaluateFlag('f', def, { installId: 'a', appVersion: '2.1.0' }).enabled, true);
  assert.strictEqual(compareVersions('2.1.0-beta.3', '2.1.0'), -1);
  assert.strictEqual(compareVersions('2.1.0-beta.10', '2.1.0-beta.9'), 1);
  assert.strictEqual(compareVersions('v3.0.0', '2.9.9'), 1);
});

test('flags: evaluateFlags returns every defined flag', () => {
  const doc = JSON.parse(fs.readFileSync(bundledPath, 'utf8'));
  const out = evaluateFlags(doc, { channel: 'beta', installId: 'x', overrides: {} });
  assert.deepStrictEqual(Object.keys(out).sort(), Object.keys(doc.flags).sort());
  assert.strictEqual(out.direct_assist.enabled, true, 'beta testers get direct_assist');
  const stable = evaluateFlags(doc, { channel: 'stable', installId: 'x', overrides: {} });
  assert.strictEqual(stable.direct_assist.enabled, false, 'stable users do not');
});

test('flags store: install id, overrides, remote refresh and cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtai-flags-'));
  let channel = 'stable';
  let changes = 0;
  const remote = {
    schema: 1,
    flags: { direct_assist: { description: 'remote', rollout: { stable: 100, beta: 100 } } }
  };
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => remote });
  const store = createFlagStore({
    dataDir: dir,
    bundledPath,
    getChannel: () => channel,
    appVersion: '2.0.0',
    remoteUrl: 'https://example.invalid/flags.json',
    fetch: fakeFetch,
    onChange: () => changes++
  });
  const first = store.snapshot();
  assert.match(first.installId, /^[0-9a-f-]{16,}$/);
  assert.strictEqual(first.source, 'bundled');
  assert.strictEqual(store.isEnabled('direct_assist'), false);

  store.setOverride('direct_assist', 'on');
  assert.strictEqual(store.isEnabled('direct_assist'), true);
  store.setOverride('direct_assist', 'default');
  assert.strictEqual(store.isEnabled('direct_assist'), false);
  assert.throws(() => store.setOverride('ab_start_cta', 'nope'));
  store.setOverride('ab_start_cta', 'go_live');
  assert.strictEqual(store.snapshot().flags.ab_start_cta.variant, 'go_live');

  const after = await store.refresh();
  assert.strictEqual(after.source, 'remote');
  assert.strictEqual(after.flags.direct_assist.enabled, true, 'remote rollout applies');
  assert.ok(after.flags.getting_started_card, 'bundled-only flags survive a remote doc');
  assert.ok(changes >= 3);

  const active = JSON.parse(fs.readFileSync(path.join(dir, 'flags-active.json'), 'utf8'));
  assert.strictEqual(active.flags.direct_assist, true);
  assert.strictEqual(active.flags.ab_start_cta, 'go_live');

  // Same data dir: install id and cache persist; a failing fetch keeps the cache.
  const again = createFlagStore({
    dataDir: dir,
    bundledPath,
    getChannel: () => channel,
    remoteUrl: 'https://example.invalid/flags.json',
    fetch: async () => { throw new Error('offline'); }
  });
  assert.strictEqual(again.snapshot().installId, first.installId);
  assert.strictEqual(again.snapshot().source, 'cache');
  const failed = await again.refresh();
  assert.strictEqual(failed.lastError, 'offline');
  assert.strictEqual(failed.flags.direct_assist.enabled, true);

  channel = 'beta';
  assert.strictEqual(again.snapshot().channel, 'beta');
});

test('flags store: rejects an invalid remote document', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtai-flags-'));
  const store = createFlagStore({
    dataDir: dir,
    bundledPath,
    remoteUrl: 'https://example.invalid/flags.json',
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ schema: 9 }) })
  });
  const snap = await store.refresh();
  assert.match(snap.lastError, /invalid flags.json/);
  assert.notStrictEqual(snap.source, 'remote');
});
