// Keeps the signed-in account's data in the cloud (docs/server-api.md
// "Sincronização"): the sessions (agents/*.json), the session history
// (sessions/<id>.md, .jsonl, .jev.json, sent as one bundle) and the personal
// question bank (question_bank.json). The disk stays the working copy, so the
// app works offline; what the plan does not keep in the cloud stays local.
//
// cloud_sync.json remembers the hash of each item at the last sync, which tells
// "deleted here" from "new there" and which side changed.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STATE_FILE = 'cloud_sync.json';
const HISTORY_PARTS = { md: '.md', jsonl: '.jsonl', jev: '.jev.json' };
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const keyOf = (kind, id) => `${kind}/${id}`;
// Ids come back from the server: they must stay plain file names.
const safeId = (id) => typeof id === 'string' && id.length > 0 && id === path.basename(id) && !id.includes('..') && !/[\\/:]/.test(id);

const norm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// Union of two question banks: nothing either device collected is lost.
function mergeBanks(local, remote) {
  const out = { ...remote, ...local, companies: (local.companies || []).map((c) => ({ ...c, questions: [...(c.questions || [])] })) };
  for (const rc of remote.companies || []) {
    const name = String(rc.name || '').toLowerCase();
    const mine = out.companies.find((c) => c.id === rc.id || String(c.name || '').toLowerCase() === name);
    if (!mine) {
      out.companies.push(rc);
      continue;
    }
    const seen = new Set(mine.questions.map((q) => norm(q.text)));
    for (const q of rc.questions || []) {
      if (seen.has(norm(q.text))) continue;
      seen.add(norm(q.text));
      mine.questions.push(q);
    }
    mine.questionsReported = mine.questions.length;
  }
  out.totalQuestions = out.companies.reduce((sum, c) => sum + (c.questions || []).length, 0);
  return out;
}

/**
 * @param {object} deps
 * @param {() => string} deps.dataDir       folder of agents/, sessions/ and the bank
 * @param {() => object} deps.client        { list, get, put, remove } (cloud_account)
 * @param {() => Promise<string>} deps.owner  e-mail of the signed-in account, '' = none
 * @param {() => boolean} [deps.busy]       true while a live session writes its files
 */
function createCloudSync(deps) {
  const dir = () => deps.dataDir();
  const statePath = () => path.join(dir(), STATE_FILE);

  function readState() {
    try {
      const s = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
      return { owner: s.owner || '', items: s.items || {}, ignored: s.ignored || [] };
    } catch (_e) {
      return { owner: '', items: {}, ignored: [] };
    }
  }
  const writeState = (s) => fs.writeFileSync(statePath(), JSON.stringify(s), 'utf8');

  function historyBundle(id) {
    const folder = path.join(dir(), 'sessions');
    const bundle = {};
    let mtime = 0;
    for (const [part, ext] of Object.entries(HISTORY_PARTS)) {
      const fp = path.join(folder, id + ext);
      if (!fs.existsSync(fp)) continue;
      bundle[part] = fs.readFileSync(fp, 'utf8');
      mtime = Math.max(mtime, fs.statSync(fp).mtimeMs);
    }
    return { bytes: Buffer.from(JSON.stringify(bundle), 'utf8'), mtime };
  }

  // Everything on this computer, newest first (so the plan keeps the newest).
  function localItems() {
    const items = [];
    const push = (kind, id, bytes, mtime) => items.push({ kind, id, bytes, mtime: Math.round(mtime), sha: sha(bytes) });
    const bank = path.join(dir(), 'question_bank.json');
    if (fs.existsSync(bank)) push('bank', 'main', fs.readFileSync(bank), fs.statSync(bank).mtimeMs);
    const agents = path.join(dir(), 'agents');
    for (const f of fs.existsSync(agents) ? fs.readdirSync(agents) : []) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(agents, f);
      push('session', path.basename(f, '.json'), fs.readFileSync(fp), fs.statSync(fp).mtimeMs);
    }
    const sessions = path.join(dir(), 'sessions');
    for (const f of fs.existsSync(sessions) ? fs.readdirSync(sessions) : []) {
      if (!f.endsWith('.md')) continue;
      const id = path.basename(f, '.md');
      const { bytes, mtime } = historyBundle(id);
      push('history', id, bytes, mtime);
    }
    return items.sort((a, b) => b.mtime - a.mtime);
  }

  function writeLocal(kind, id, bytes, updatedAt) {
    const stamp = (fp) => {
      if (updatedAt > 0) fs.utimesSync(fp, new Date(updatedAt), new Date(updatedAt));
    };
    if (kind === 'bank') {
      JSON.parse(bytes.toString('utf8')); // a damaged copy must not replace the bank
      const fp = path.join(dir(), 'question_bank.json');
      fs.writeFileSync(fp, bytes);
      stamp(fp);
    } else if (kind === 'session') {
      JSON.parse(bytes.toString('utf8'));
      const fp = path.join(dir(), 'agents', `${id}.json`);
      fs.writeFileSync(fp, bytes);
      stamp(fp);
    } else {
      const bundle = JSON.parse(bytes.toString('utf8'));
      for (const [part, ext] of Object.entries(HISTORY_PARTS)) {
        if (typeof bundle[part] !== 'string') continue;
        const fp = path.join(dir(), 'sessions', id + ext);
        fs.writeFileSync(fp, bundle[part], 'utf8');
        stamp(fp);
      }
    }
  }

  function removeLocal(kind, id) {
    const files = kind === 'bank' ? ['question_bank.json']
      : kind === 'session' ? [path.join('agents', `${id}.json`)]
        : Object.values(HISTORY_PARTS).map((ext) => path.join('sessions', id + ext));
    for (const f of files) fs.rmSync(path.join(dir(), f), { force: true });
  }

  async function run() {
    if (deps.busy && deps.busy()) return { ok: true, skipped: true };
    const owner = await deps.owner();
    if (!owner) return { ok: false, error: 'not_signed_in' };
    const client = deps.client();
    const listed = await client.list();
    if (!listed.ok) return { ok: false, error: listed.error }; // never read a failure as "the cloud is empty"

    let state = readState();
    const local = localItems();
    if (state.owner !== owner) {
      // Another account used this computer: its data is not this account's to upload.
      state = { owner, items: {}, ignored: state.owner ? local.map((i) => keyOf(i.kind, i.id)) : [] };
    }
    const remote = new Map(listed.items.map((r) => [keyOf(r.kind, r.id), r]));
    const out = { ok: true, uploaded: 0, downloaded: 0, removed: 0, limited: { session: 0, history: 0 }, full: false, failed: 0 };
    const blocked = new Set(); // kinds refused by the plan: no point in asking again this run

    const upload = async (item) => {
      if (out.full || blocked.has(item.kind)) {
        if (item.kind in out.limited) out.limited[item.kind] += 1;
        return;
      }
      const r = await client.put(item.kind, item.id, item.bytes, item.mtime);
      if (r.ok) {
        state.items[keyOf(item.kind, item.id)] = { sha: item.sha };
        out.uploaded += 1;
      } else if (r.code === 'cloud_limit') {
        blocked.add(item.kind);
        if (item.kind in out.limited) out.limited[item.kind] += 1;
      } else if (r.code === 'storage_full') {
        out.full = true;
      } else {
        out.failed += 1;
      }
    };
    const download = async (kind, id, r) => {
      if (!safeId(id)) return;
      const got = await client.get(kind, id);
      if (!got.ok) {
        out.failed += 1;
        return;
      }
      try {
        writeLocal(kind, id, got.bytes, r.updated_at);
      } catch (_e) {
        out.failed += 1; // damaged copy: the local one stays
        return;
      }
      state.items[keyOf(kind, id)] = { sha: r.sha256 };
      out.downloaded += 1;
    };

    for (const item of local) {
      const key = keyOf(item.kind, item.id);
      const r = remote.get(key);
      const known = state.items[key];
      remote.delete(key);
      if (!r) {
        if (known) {
          removeLocal(item.kind, item.id); // deleted on another device
          delete state.items[key];
          out.removed += 1;
        } else if (!state.ignored.includes(key)) {
          await upload(item);
        }
        continue;
      }
      if (r.sha256 === item.sha) {
        state.items[key] = { sha: item.sha };
        continue;
      }
      const localChanged = !known || known.sha !== item.sha;
      const remoteChanged = !known || known.sha !== r.sha256;
      if (state.ignored.includes(key)) {
        await download(item.kind, item.id, r);
      } else if (item.kind === 'bank' && localChanged && remoteChanged) {
        // Both sides collected questions: keep all of them.
        const got = await client.get('bank', 'main');
        if (!got.ok) {
          out.failed += 1;
          continue;
        }
        try {
          const merged = mergeBanks(JSON.parse(item.bytes.toString('utf8')), JSON.parse(got.bytes.toString('utf8')));
          const bytes = Buffer.from(JSON.stringify(merged, null, 2), 'utf8');
          writeLocal('bank', 'main', bytes, 0);
          await upload({ ...item, bytes, sha: sha(bytes), mtime: Date.now() });
          out.downloaded += 1;
        } catch (_e) {
          out.failed += 1;
        }
      } else if (localChanged && (!remoteChanged || item.mtime >= r.updated_at)) {
        await upload(item);
      } else {
        await download(item.kind, item.id, r);
      }
    }

    // In the cloud only: new from another device, or deleted here since the last sync.
    for (const [key, r] of remote) {
      if (state.items[key]) {
        const del = await client.remove(r.kind, r.id);
        if (del.ok) {
          delete state.items[key];
          out.removed += 1;
        } else {
          out.failed += 1;
        }
      } else {
        await download(r.kind, r.id, r);
      }
    }
    writeState(state);
    const after = await client.list();
    if (after.ok) {
      const count = (k) => after.items.filter((i) => i.kind === k).length;
      out.counts = { session: count('session'), history: count('history'), bank: count('bank') };
      out.limits = after.limits;
      out.used_bytes = after.used_bytes;
      out.limit_bytes = after.limit_bytes;
    }
    return out;
  }

  // One at a time; a request during a run is served by one more run after it.
  let current = null;
  let again = false;
  function syncNow() {
    if (current) {
      again = true;
      return current;
    }
    current = run()
      .catch((err) => ({ ok: false, error: err && err.message ? err.message : String(err) }))
      .finally(() => {
        current = null;
        if (again) {
          again = false;
          syncNow();
        }
      });
    return current;
  }
  return { syncNow };
}

module.exports = { createCloudSync, mergeBanks };
