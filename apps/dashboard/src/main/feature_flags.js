// Feature flags with A/B variants, staged rollout and release channels.
//
// Pure evaluation (no Electron, no I/O) lives at the top so it can be unit
// tested; createFlagStore() at the bottom adds the file cache, remote fetch
// and local overrides used by main.js.
//
// flags.json schema (version 1):
// {
//   "schema": 1,
//   "flags": {
//     "<key>": {
//       "description": "What the flag controls",
//       "default": false,               // used when no rollout applies
//       "channels": ["beta"],           // optional: only these channels may get it
//       "rollout": { "stable": 0, "beta": 100 },  // % of installs per channel (or a number for all)
//       "variants": { "a": 50, "b": 50 },          // optional A/B(/n) split, weights
//       "min_version": "2.1.0"          // optional: app must be at least this version
//     }
//   }
// }
//
// Each install gets a stable random id; bucket = hash(installId + key) % 100,
// so one install always lands in the same group for a given flag, and the
// groups of different flags are independent.

'use strict';

const CHANNELS = ['stable', 'beta'];
const OVERRIDE_VALUES = ['on', 'off'];

// FNV-1a 32-bit. Deterministic across platforms and Node versions.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function bucketFor(installId, key) {
  return fnv1a(`${installId}:${key}`) % 100;
}

// Compares "1.2.3" / "1.2.3-beta.4". Returns -1, 0 or 1.
function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v || '0.0.0').replace(/^v/, '').split('-', 2);
    const nums = core.split('.').map((n) => parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre: pre || '' };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1; // release > prerelease
  if (!pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre, 'en', { numeric: true }) < 0 ? -1 : 1;
}

function normalizeChannel(channel) {
  return CHANNELS.includes(channel) ? channel : 'stable';
}

function rolloutPercent(rollout, channel) {
  if (typeof rollout === 'number') return rollout;
  if (rollout && typeof rollout === 'object' && typeof rollout[channel] === 'number') return rollout[channel];
  return null;
}

function pickVariant(variants, bucket) {
  const entries = Object.entries(variants).filter(([, w]) => typeof w === 'number' && w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (!entries.length || total <= 0) return null;
  // Scale the 0..99 bucket onto the total weight.
  const point = (bucket / 100) * total;
  let acc = 0;
  for (const [name, w] of entries) {
    acc += w;
    if (point < acc) return name;
  }
  return entries[entries.length - 1][0];
}

// Validates a flags document. Returns a list of problems (empty = valid).
function validateFlagsDocument(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return ['document must be an object'];
  if (doc.schema !== 1) errors.push('schema must be 1');
  if (!doc.flags || typeof doc.flags !== 'object' || Array.isArray(doc.flags)) {
    errors.push('flags must be an object');
    return errors;
  }
  for (const [key, def] of Object.entries(doc.flags)) {
    const at = `flags.${key}`;
    if (!/^[a-z][a-z0-9_]*$/.test(key)) errors.push(`${at}: key must be snake_case`);
    if (!def || typeof def !== 'object') { errors.push(`${at}: must be an object`); continue; }
    if (typeof def.description !== 'string' || !def.description.trim()) errors.push(`${at}.description is required`);
    if (def.default !== undefined && typeof def.default !== 'boolean') errors.push(`${at}.default must be boolean`);
    if (def.channels !== undefined) {
      if (!Array.isArray(def.channels) || def.channels.some((c) => !CHANNELS.includes(c))) {
        errors.push(`${at}.channels must list only ${CHANNELS.join('/')}`);
      }
    }
    if (def.rollout !== undefined) {
      const vals = typeof def.rollout === 'number' ? [def.rollout] : Object.entries(def.rollout || {});
      const bad = typeof def.rollout === 'number'
        ? !(def.rollout >= 0 && def.rollout <= 100)
        : !def.rollout || typeof def.rollout !== 'object' ||
          vals.some(([ch, p]) => !CHANNELS.includes(ch) || typeof p !== 'number' || p < 0 || p > 100);
      if (bad) errors.push(`${at}.rollout must be 0-100 or { stable, beta } with 0-100`);
    }
    if (def.variants !== undefined) {
      const ok = def.variants && typeof def.variants === 'object' &&
        Object.keys(def.variants).length >= 2 &&
        Object.entries(def.variants).every(([n, w]) => /^[a-z0-9_]+$/.test(n) && n !== 'off' && typeof w === 'number' && w >= 0);
      if (!ok) errors.push(`${at}.variants needs 2+ names (not "off") with numeric weights`);
    }
    if (def.min_version !== undefined && !/^\d+\.\d+\.\d+/.test(String(def.min_version))) {
      errors.push(`${at}.min_version must be semver`);
    }
  }
  return errors;
}

// Evaluates one flag. ctx: { channel, installId, appVersion, override }
// override: undefined | 'on' | 'off' | '<variant name>'
function evaluateFlag(key, def, ctx) {
  const channel = normalizeChannel(ctx.channel);
  const variants = def.variants && typeof def.variants === 'object' ? def.variants : null;
  const base = { key, description: def.description || '', variants: variants ? Object.keys(variants) : null };

  const ov = ctx.override;
  if (ov !== undefined && ov !== null && ov !== '') {
    if (ov === 'off') return { ...base, enabled: false, variant: null, source: 'override' };
    if (variants && Object.prototype.hasOwnProperty.call(variants, ov)) {
      return { ...base, enabled: true, variant: ov, source: 'override' };
    }
    if (ov === 'on') {
      const v = variants ? Object.keys(variants)[0] : null;
      return { ...base, enabled: true, variant: v, source: 'override' };
    }
  }

  if (Array.isArray(def.channels) && !def.channels.includes(channel)) {
    return { ...base, enabled: false, variant: null, source: 'channel' };
  }
  if (def.min_version && ctx.appVersion && compareVersions(ctx.appVersion, def.min_version) < 0) {
    return { ...base, enabled: false, variant: null, source: 'min_version' };
  }

  const bucket = bucketFor(ctx.installId || 'anonymous', key);
  const pct = rolloutPercent(def.rollout, channel);
  let enabled;
  let source;
  if (pct !== null) {
    enabled = bucket < pct;
    source = 'rollout';
  } else {
    enabled = Boolean(def.default);
    source = 'default';
  }
  if (!enabled) return { ...base, enabled: false, variant: null, source };

  // Variant assignment uses an independent bucket so a 50% rollout does not
  // put everybody who got the flag into the first variant.
  const variant = variants ? pickVariant(variants, bucketFor(ctx.installId || 'anonymous', `${key}#variant`)) : null;
  return { ...base, enabled: true, variant, source };
}

function evaluateFlags(doc, ctx) {
  const out = {};
  const flags = (doc && doc.flags) || {};
  const overrides = (ctx && ctx.overrides) || {};
  for (const [key, def] of Object.entries(flags)) {
    out[key] = evaluateFlag(key, def || {}, { ...ctx, override: overrides[key] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Store: bundled defaults + cached/remote definitions + local overrides.
// ---------------------------------------------------------------------------
function createFlagStore(opts) {
  const fs = opts.fs || require('fs');
  const path = opts.path || require('path');
  const crypto = opts.crypto || require('crypto');
  const fetchImpl = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  const dataDir = opts.dataDir;
  const bundledPath = opts.bundledPath;
  const getChannel = opts.getChannel || (() => 'stable');
  const appVersion = opts.appVersion || '0.0.0';
  const remoteUrl = opts.remoteUrl || '';
  const onChange = opts.onChange || (() => {});

  const cachePath = path.join(dataDir, 'flags-cache.json');
  const overridesPath = path.join(dataDir, 'flags-overrides.json');
  const idPath = path.join(dataDir, 'install-id');
  const activePath = path.join(dataDir, 'flags-active.json');

  const readJson = (p) => {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_e) { return null; }
  };
  const writeJson = (p, v) => {
    try { fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8'); } catch (_e) {}
  };

  let installId = '';
  try { installId = fs.readFileSync(idPath, 'utf8').trim(); } catch (_e) {}
  if (!/^[0-9a-f-]{16,}$/.test(installId)) {
    installId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    try { fs.writeFileSync(idPath, installId, 'utf8'); } catch (_e) {}
  }

  const pickValid = (doc) => (doc && validateFlagsDocument(doc).length === 0 ? doc : null);
  const cached = pickValid(readJson(cachePath));
  const bundled = pickValid(readJson(bundledPath));
  // Remote/cached definitions win over the ones shipped in the installer, but a
  // flag that only the bundled file knows (new build, stale cache) still exists.
  const merge = (over) => ({ schema: 1, flags: { ...((bundled && bundled.flags) || {}), ...((over && over.flags) || {}) } });
  let doc = merge(cached);
  let source = cached ? 'cache' : bundled ? 'bundled' : 'empty';
  let lastFetch = null;
  let lastError = '';
  let overrides = readJson(overridesPath) || {};

  function snapshot() {
    const channel = normalizeChannel(getChannel());
    const flags = evaluateFlags(doc, { channel, installId, appVersion, overrides });
    return {
      channel,
      installId,
      appVersion,
      source,
      remoteUrl,
      lastFetch,
      lastError,
      flags
    };
  }

  function persistActive() {
    // The native overlay (C++) can read this file to gate its own features.
    const snap = snapshot();
    const active = {};
    for (const [k, f] of Object.entries(snap.flags)) active[k] = f.enabled ? (f.variant || true) : false;
    writeJson(activePath, { channel: snap.channel, flags: active });
    return snap;
  }

  function changed() {
    const snap = persistActive();
    onChange(snap);
    return snap;
  }

  async function refresh() {
    if (!remoteUrl || !fetchImpl) return snapshot();
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 6000) : null;
    try {
      const res = await fetchImpl(`${remoteUrl}${remoteUrl.includes('?') ? '&' : '?'}t=${Date.now()}`, {
        signal: ctrl ? ctrl.signal : undefined,
        headers: { 'Cache-Control': 'no-cache' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const remote = await res.json();
      const problems = validateFlagsDocument(remote);
      if (problems.length) throw new Error(`invalid flags.json: ${problems[0]}`);
      doc = merge(remote);
      source = 'remote';
      lastError = '';
      lastFetch = new Date().toISOString();
      writeJson(cachePath, remote);
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return changed();
  }

  function setOverride(key, value) {
    if (value === undefined || value === null || value === '' || value === 'default') {
      delete overrides[key];
    } else {
      const def = doc.flags[key];
      const okVariant = def && def.variants && Object.prototype.hasOwnProperty.call(def.variants, value);
      if (!OVERRIDE_VALUES.includes(value) && !okVariant) throw new Error(`invalid override for ${key}: ${value}`);
      overrides[key] = value;
    }
    writeJson(overridesPath, overrides);
    return changed();
  }

  function clearOverrides() {
    overrides = {};
    writeJson(overridesPath, overrides);
    return changed();
  }

  function isEnabled(key) {
    const f = snapshot().flags[key];
    return Boolean(f && f.enabled);
  }

  persistActive();
  return { snapshot, refresh, setOverride, clearOverrides, isEnabled, notifyChannelChanged: changed };
}

module.exports = {
  CHANNELS,
  fnv1a,
  bucketFor,
  compareVersions,
  validateFlagsDocument,
  evaluateFlag,
  evaluateFlags,
  pickVariant,
  createFlagStore
};
