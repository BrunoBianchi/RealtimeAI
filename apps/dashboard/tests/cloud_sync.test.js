const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCloudSync, mergeBanks } = require('../src/main/cloud_sync');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function cloud({ limit = 0 } = {}) {
  const items = new Map();
  const c = {
    items,
    list: async () => ({ ok: true, limits: {}, used_bytes: 0, limit_bytes: 1,
      items: [...items.entries()].map(([k, v]) => ({ kind: k.split('/')[0], id: k.split('/')[1], sha256: sha(v.bytes), updated_at: v.at })) }),
    get: async (kind, id) => ({ ok: true, bytes: items.get(kind + '/' + id).bytes }),
    put: async (kind, id, bytes, at) => {
      const n = [...items.keys()].filter((k) => k.startsWith(kind + '/')).length;
      if (limit && kind === 'session' && !items.has(kind + '/' + id) && n >= limit) return { ok: false, code: 'cloud_limit' };
      items.set(kind + '/' + id, { bytes: Buffer.from(bytes), at });
      return { ok: true };
    },
    remove: async (kind, id) => { items.delete(kind + '/' + id); return { ok: true }; }
  };
  return c;
}
function device(c, owner = 'a@b.c') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-sync-'));
  fs.mkdirSync(path.join(dir, 'agents'));
  fs.mkdirSync(path.join(dir, 'sessions'));
  const d = { dir, owner, busy: false };
  d.sync = createCloudSync({ dataDir: () => dir, client: () => c, owner: async () => d.owner, busy: () => d.busy });
  return d;
}
const agent = (d, id) => path.join(d.dir, 'agents', id + '.json');

test('a session and its history travel to a second device, and edits follow', async () => {
  const c = cloud();
  const a = device(c);
  const b = device(c);
  fs.writeFileSync(agent(a, 'g1'), '{"id":"g1"}');
  fs.writeFileSync(path.join(a.dir, 'sessions', 's1.md'), '# s1');
  fs.writeFileSync(path.join(a.dir, 'sessions', 's1.jsonl'), '{}');
  assert.strictEqual((await a.sync.syncNow()).uploaded, 2);
  assert.strictEqual((await b.sync.syncNow()).downloaded, 2);
  assert.strictEqual(fs.readFileSync(path.join(b.dir, 'sessions', 's1.jsonl'), 'utf8'), '{}');
  fs.writeFileSync(agent(b, 'g1'), '{"id":"g1","x":1}');
  await b.sync.syncNow();
  await a.sync.syncNow();
  assert.strictEqual(fs.readFileSync(agent(a, 'g1'), 'utf8'), '{"id":"g1","x":1}');
});

test('a deletion on one device reaches the cloud and the other device', async () => {
  const c = cloud();
  const a = device(c);
  const b = device(c);
  fs.writeFileSync(agent(a, 'g1'), '{}');
  await a.sync.syncNow();
  await b.sync.syncNow();
  fs.rmSync(agent(a, 'g1'));
  await a.sync.syncNow();
  assert.strictEqual(c.items.size, 0);
  await b.sync.syncNow();
  assert.ok(!fs.existsSync(agent(b, 'g1')));
});

test('the plan limit keeps the rest local and is reported', async () => {
  const c = cloud({ limit: 1 });
  const a = device(c);
  fs.writeFileSync(agent(a, 'old'), '{}');
  fs.utimesSync(agent(a, 'old'), new Date(1000), new Date(1000));
  fs.writeFileSync(agent(a, 'new'), '{"n":1}');
  const r = await a.sync.syncNow();
  assert.strictEqual(r.limited.session, 1);
  assert.ok(c.items.has('session/new'), 'the newest goes first');
  assert.ok(fs.existsSync(agent(a, 'old')));
});

test('a failed listing changes nothing; a live session waits', async () => {
  const c = cloud();
  const a = device(c);
  fs.writeFileSync(agent(a, 'g1'), '{}');
  await a.sync.syncNow();
  c.list = async () => ({ ok: false, error: 'offline' });
  assert.strictEqual((await a.sync.syncNow()).ok, false);
  assert.ok(fs.existsSync(agent(a, 'g1')));
  a.busy = true;
  assert.strictEqual((await a.sync.syncNow()).skipped, true);
});

test("another account on this computer does not receive the first account's data", async () => {
  const c = cloud();
  const a = device(c);
  fs.writeFileSync(agent(a, 'g1'), '{}');
  await a.sync.syncNow();
  const other = cloud();
  a.sync = createCloudSync({ dataDir: () => a.dir, client: () => other, owner: async () => 'x@y.z' });
  await a.sync.syncNow();
  assert.strictEqual(other.items.size, 0);
});

test('a hostile id from the server never leaves the data folder', async () => {
  const c = cloud();
  c.items.set('session/..', { bytes: Buffer.from('{}'), at: 1 });
  const a = device(c);
  const r = await a.sync.syncNow();
  assert.strictEqual(r.downloaded, 0);
});

test('question banks merge: nothing either device collected is lost', async () => {
  const q = (text) => ({ text });
  const m = mergeBanks(
    { companies: [{ id: 'nu', name: 'Nubank', questions: [q('A?')] }] },
    { companies: [{ id: 'nu', name: 'Nubank', questions: [q('a?'), q('B?')] }, { id: 'x', name: 'X', questions: [q('C?')] }] });
  assert.deepStrictEqual(m.companies[0].questions.map((x) => x.text), ['A?', 'B?']);
  assert.strictEqual(m.totalQuestions, 3);
});
