import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareVersions,
  localVersion,
  nextPrerelease,
  nextStable,
  parseCommit,
  releaseLevel,
  releaseNotes
} from '../version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const c = (msg) => parseCommit(msg, 'abcdef1234');

test('semver precedence, including pre-releases', () => {
  const sorted = ['2.1.0', '2.0.0', '2.1.0-beta.10', '2.1.0-beta.2', '2.0.1-beta.1', '3.0.0-beta.1'].sort(compareVersions);
  assert.deepEqual(sorted, ['2.0.0', '2.0.1-beta.1', '2.1.0-beta.2', '2.1.0-beta.10', '2.1.0', '3.0.0-beta.1']);
});

test('Conventional Commits decide the release level', () => {
  assert.equal(releaseLevel([c('docs: x'), c('chore(repo): y')]), null);
  assert.equal(releaseLevel([c('perf(engine): faster')]), 'patch');
  assert.equal(releaseLevel([c('fix(llm): a'), c('feat(rag): b')]), 'minor');
  assert.equal(releaseLevel([c('feat(llm)!: new config')]), 'major');
  assert.equal(releaseLevel([c('refactor: x\n\nBREAKING CHANGE: config.ini keys renamed')]), 'major');
});

test('next stable version', () => {
  assert.deepEqual(nextStable('2.0.0', [c('fix: a')]), { level: 'patch', version: '2.0.1' });
  assert.deepEqual(nextStable('2.0.3', [c('feat: a')]), { level: 'minor', version: '2.1.0' });
  assert.deepEqual(nextStable('2.4.1', [c('feat!: a')]), { level: 'major', version: '3.0.0' });
  assert.deepEqual(nextStable('2.0.0', [c('docs: a')]), { level: null, version: null });
});

test('pre-release counter follows existing tags and restarts per version', () => {
  const commits = [c('feat(rag): hybrid')];
  assert.equal(nextPrerelease({ current: '2.0.0', commits, tags: ['v2.0.0'] }).version, '2.1.0-beta.1');
  assert.equal(
    nextPrerelease({ current: '2.0.0', commits, tags: ['v2.0.0', 'v2.1.0-beta.1', 'v2.1.0-beta.2'] }).version,
    '2.1.0-beta.3'
  );
  // After 2.1.0 ships, the next beta starts over on 2.1.1 / 2.2.0.
  assert.equal(
    nextPrerelease({ current: '2.1.0', commits: [c('fix: a')], tags: ['v2.1.0', 'v2.1.0-beta.3'] }).version,
    '2.1.1-beta.1'
  );
});

test('a breaking change moves the beta to the next major', () => {
  const r = nextPrerelease({
    current: '2.0.0',
    commits: [c('feat: a'), c('feat(llm)!: b')],
    tags: ['v2.0.0', 'v2.1.0-beta.4']
  });
  assert.equal(r.version, '3.0.0-beta.1');
  assert.ok(compareVersions(r.version, '2.1.0-beta.4') > 0);
});

test('only internal commits still produce a newer beta', () => {
  assert.equal(nextPrerelease({ current: '2.0.0', commits: [c('chore: a')], tags: ['v2.0.0'] }).version, '2.0.1-beta.1');
});

test('beta never falls below a stable release it has not merged yet', () => {
  const r = nextPrerelease({ current: '2.0.0', commits: [c('fix: a')], tags: ['v2.0.0', 'v2.0.1', 'v2.1.0'] });
  assert.equal(r.version, '2.1.1-beta.1');
});

test('custom pre-release id and validation', () => {
  assert.equal(nextPrerelease({ current: '1.0.0', commits: [c('fix: a')], preid: 'rc' }).version, '1.0.1-rc.1');
  assert.throws(() => nextPrerelease({ current: '1.0.0', commits: [], preid: 'b@d' }));
});

test('release notes group commits like the changelog', () => {
  const notes = releaseNotes(
    [c('feat(rag): hybrid search'), c('fix(llm): fallback key'), c('perf(engine): deadlines'), c('docs: readme'),
      c('feat(llm)!: drop old url\n\nBREAKING CHANGE: [llm] url is now required')],
    { version: '3.0.0-beta.1', date: '2026-10-26' }
  );
  assert.match(notes, /^## 3\.0\.0-beta\.1 \(2026-10-26\)/);
  assert.match(notes, /### Mudanças incompatíveis\n\n- \*\*llm:\*\* \[llm\] url is now required/);
  assert.match(notes, /### Novidades\n\n- \*\*rag:\*\* hybrid search \(abcdef1\)/);
  assert.match(notes, /### Correções/);
  assert.match(notes, /### Desempenho/);
  assert.doesNotMatch(notes, /readme/);
  assert.match(releaseNotes([c('chore: x')]), /Manutenção e melhorias internas/);
});

test('local builds sort between the last release and the next one', () => {
  const v = localVersion({ current: '2.0.0', commits: [c('feat: a')], tags: ['v2.0.0'], date: new Date(2026, 9, 26, 14, 5) });
  assert.equal(v, '2.1.0-local.202610261405');
  assert.ok(compareVersions(v, '2.0.0') > 0);
  assert.ok(compareVersions(v, '2.1.0') < 0);
  const later = localVersion({ current: '2.0.0', commits: [c('feat: a')], tags: ['v2.0.0'], date: new Date(2026, 9, 26, 15, 0) });
  assert.ok(compareVersions(later, v) > 0);
});

test('release.yml uses semantic-release and builds real-time update installer assets', () => {
  const releaseYml = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
  const buildWinYml = fs.readFileSync(path.join(ROOT, '.github/workflows/build-windows.yml'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  assert.ok(releaseYml.includes('permissions: write-all'));
  assert.ok(releaseYml.includes('uses: pnpm/action-setup@v4'));
  assert.ok(releaseYml.includes('pnpm exec semantic-release'));
  assert.ok(releaseYml.includes('uses: ./.github/workflows/build-windows.yml'));
  assert.ok(releaseYml.includes('publish: true'));

  assert.ok(buildWinYml.includes("'.exe', '.yml', '.blockmap'"));
  assert.ok(buildWinYml.includes('gh release upload "v$version" @assets'));

  assert.ok(pkg.devDependencies && pkg.devDependencies['semantic-release']);
  assert.ok(pkg.release && Array.isArray(pkg.release.plugins));
  assert.ok(pkg.release.plugins.includes('@semantic-release/github'));
});

