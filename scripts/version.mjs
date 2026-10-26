#!/usr/bin/env node
// Version numbers from Conventional Commits, for stable and pre-release builds.
//
//   node scripts/version.mjs                  next stable version (2.1.0)
//   node scripts/version.mjs --pre beta       next pre-release   (2.1.0-beta.3)
//   node scripts/version.mjs --local          local test build (2.1.0-local.202610261405)
//   node scripts/version.mjs --json           every detail, as JSON
//   node scripts/version.mjs notes [--since-stable] [--version X.Y.Z]
//                                             Markdown release notes up to HEAD
//
// Rules (the same release-please applies to stable releases):
//   * the base is the newest stable tag (vX.Y.Z) reachable from HEAD;
//   * `feat!:` / `BREAKING CHANGE:` -> major, `feat:` -> minor, `fix:` and
//     `perf:` -> patch; anything else alone -> patch for a pre-release;
//   * a pre-release is <next>-<id>.<N>, N = 1 + the highest existing tag
//     v<next>-<id>.*, so it restarts at 1 after every stable release and
//     always sorts before <next> (semver), which is what electron-updater
//     needs to move beta users onto the stable release;
//   * the pre-release is also kept above every stable tag in the repository,
//     so a beta branch that did not merge main yet never publishes a version
//     lower than what stable users already have.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- semver

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(text) {
  const m = SEMVER.exec(String(text).trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : []
  };
}

export function formatVersion(v) {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  return v.pre && v.pre.length ? `${core}-${v.pre.join('.')}` : core;
}

export function isStable(text) {
  const v = parseVersion(text);
  return Boolean(v) && v.pre.length === 0;
}

// Semver precedence (build metadata ignored). Returns <0, 0 or >0.
export function compareVersions(a, b) {
  const x = typeof a === 'string' ? parseVersion(a) : a;
  const y = typeof b === 'string' ? parseVersion(b) : b;
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] - y[k];
  }
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length; // release > pre-release
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (i >= x.pre.length) return -1;
    if (i >= y.pre.length) return 1;
    const p = x.pre[i];
    const q = y.pre[i];
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export function bumpVersion(text, level) {
  const v = typeof text === 'string' ? parseVersion(text) : { ...text };
  if (level === 'major') return { major: v.major + 1, minor: 0, patch: 0, pre: [] };
  if (level === 'minor') return { major: v.major, minor: v.minor + 1, patch: 0, pre: [] };
  return { major: v.major, minor: v.minor, patch: v.patch + 1, pre: [] };
}

// ---------------------------------------------------------------- commits

const HEADER = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;

export function parseCommit(message, hash = '') {
  const text = String(message).replace(/\r\n/g, '\n').trim();
  const [header = '', ...rest] = text.split('\n');
  const m = HEADER.exec(header.trim());
  const body = rest.join('\n');
  const breakingNote = /^BREAKING[ -]CHANGE:\s*(.+)$/m.exec(body);
  if (!m) return { hash, type: '', scope: '', subject: header.trim(), breaking: Boolean(breakingNote), note: '' };
  return {
    hash,
    type: m[1].toLowerCase(),
    scope: m[2] || '',
    subject: m[4].trim(),
    breaking: Boolean(m[3]) || Boolean(breakingNote),
    note: breakingNote ? breakingNote[1].trim() : ''
  };
}

// 'major' | 'minor' | 'patch' | null (nothing that cuts a release).
export function releaseLevel(commits) {
  let level = null;
  for (const c of commits) {
    if (c.breaking) return 'major';
    if (c.type === 'feat') level = 'minor';
    else if ((c.type === 'fix' || c.type === 'perf') && !level) level = 'patch';
  }
  return level;
}

export function nextStable(current, commits) {
  const level = releaseLevel(commits);
  return { level, version: level ? formatVersion(bumpVersion(current, level)) : null };
}

// `tags` are every tag in the repository (with or without the leading v).
export function nextPrerelease({ current, commits, tags = [], preid = 'beta' }) {
  if (!/^[0-9A-Za-z-]+$/.test(preid)) throw new Error(`invalid pre-release id: ${preid}`);
  const level = releaseLevel(commits) || 'patch';
  let base = bumpVersion(current, level);
  const stable = tags.filter(isStable).map(parseVersion);
  for (const s of stable) {
    if (compareVersions(base, s) <= 0) base = bumpVersion(s, 'patch');
  }
  const baseText = formatVersion(base);
  let n = 0;
  for (const tag of tags) {
    const v = parseVersion(tag);
    if (!v || formatVersion({ ...v, pre: [] }) !== baseText) continue;
    if (v.pre.length === 2 && v.pre[0] === preid && /^\d+$/.test(v.pre[1])) n = Math.max(n, Number(v.pre[1]));
  }
  return { level, base: baseText, version: `${baseText}-${preid}.${n + 1}` };
}

// A build made on a developer machine: the next version with a minute stamp,
// so it sorts below the real release and above every earlier local build.
export function localVersion({ current, commits, tags = [], date = new Date() }) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `${nextPrerelease({ current, commits, tags, preid: 'local' }).base}-local.${stamp}`;
}

// ---------------------------------------------------------------- notes

const SECTIONS = [
  ['feat', 'Novidades'],
  ['fix', 'Correções'],
  ['perf', 'Desempenho']
];

export function releaseNotes(commits, { version = '', date = '' } = {}) {
  const lines = [];
  if (version) lines.push(`## ${version}${date ? ` (${date})` : ''}`, '');
  const breaking = commits.filter((c) => c.breaking);
  const item = (c) => `- ${c.scope ? `**${c.scope}:** ` : ''}${c.subject}${c.hash ? ` (${c.hash.slice(0, 7)})` : ''}`;
  if (breaking.length) {
    lines.push('### Mudanças incompatíveis', '');
    for (const c of breaking) lines.push(item(c.note ? { ...c, subject: c.note } : c));
    lines.push('');
  }
  let any = breaking.length > 0;
  for (const [type, title] of SECTIONS) {
    const list = commits.filter((c) => c.type === type && !c.breaking);
    if (!list.length) continue;
    any = true;
    lines.push(`### ${title}`, '');
    for (const c of list) lines.push(item(c));
    lines.push('');
  }
  if (!any) lines.push('Manutenção e melhorias internas.', '');
  return lines.join('\n');
}

// ---------------------------------------------------------------- git

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function lines(text) {
  return text.split('\n').map((s) => s.trim()).filter(Boolean);
}

function newest(tags) {
  return tags.filter((t) => parseVersion(t)).sort((a, b) => compareVersions(b, a))[0] || null;
}

function manifestVersion() {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, '.release-please-manifest.json'), 'utf8'))['.'];
  } catch {
    return '0.0.0';
  }
}

function commitsBetween(fromTag, until = 'HEAD') {
  const range = fromTag ? `${fromTag}..${until}` : until;
  const raw = git(['log', '--no-merges', '--format=%H%x1f%B%x1e', range]);
  return raw
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, msg] = r.split('\x1f');
      return parseCommit(msg || '', hash);
    });
}

export function repoState(until = 'HEAD') {
  const all = lines(git(['tag', '--list', 'v*']));
  const reachable = lines(git(['tag', '--list', 'v*', '--merged', until]));
  const atHead = new Set(lines(git(['tag', '--list', 'v*', '--points-at', until])));
  const lastStableTag = newest(reachable.filter((t) => isStable(t) && !atHead.has(t)));
  const lastTag = newest(reachable.filter((t) => !atHead.has(t)));
  return { all, lastStableTag, lastTag, current: lastStableTag ? lastStableTag.slice(1) : manifestVersion() };
}

// ---------------------------------------------------------------- CLI

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function main(argv) {
  if (argv[0] === 'notes') {
    const st = repoState('HEAD');
    const since = arg(argv, '--since') || (argv.includes('--since-stable') ? st.lastStableTag : st.lastTag);
    const version = arg(argv, '--version') || '';
    const date = new Date().toISOString().slice(0, 10);
    process.stdout.write(releaseNotes(commitsBetween(since), { version, date }));
    return;
  }
  const st = repoState('HEAD');
  const commits = commitsBetween(st.lastStableTag);
  if (argv.includes('--local')) {
    process.stdout.write(`${localVersion({ current: st.current, commits, tags: st.all })}\n`);
    return;
  }
  const preid = arg(argv, '--pre');
  const stable = nextStable(st.current, commits);
  const pre = preid ? nextPrerelease({ current: st.current, commits, tags: st.all, preid }) : null;
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({
      current: st.current,
      lastStableTag: st.lastStableTag,
      commits: commits.length,
      level: stable.level,
      next: stable.version,
      prerelease: pre ? pre.version : null
    }, null, 2)}\n`);
    return;
  }
  const out = pre ? pre.version : stable.version;
  if (!out) {
    process.stderr.write(`No feat/fix/perf/breaking commits since ${st.lastStableTag || 'the start'}: nothing to release.\n`);
    process.exit(2);
  }
  process.stdout.write(`${out}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`version: ${e.message}\n`);
    process.exit(1);
  }
}
