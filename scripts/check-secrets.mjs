#!/usr/bin/env node
// Blocks commits that would leak API keys or private config.
//
//   node scripts/check-secrets.mjs --staged   (pre-commit: staged content only)
//   node scripts/check-secrets.mjs --all      (CI: every tracked file)
//
// A line can opt out with the marker "secret-scan:allow" (use for test
// fixtures with obviously fake keys).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const mode = process.argv.includes('--all') ? 'all' : 'staged';

const FORBIDDEN_PATHS = [
  { re: /(^|\/)config\.ini$/i, why: 'config.ini holds your API keys' },
  { re: /(^|\/)google_oauth_client\.json$/i, why: 'OAuth client secret (inject it in CI from a secret)' },
  { re: /(^|\/)client_secret[^/]*\.json$/i, why: 'OAuth client secret' },
  { re: /(^|\/)\.env(\.|$)/i, why: '.env files hold secrets' },
  { re: /\.(pem|pfx|p12)$/i, why: 'private key / certificate' }
];

const PATTERNS = [
  { name: 'OpenRouter key', re: /sk-or-v1-[a-f0-9]{32,}/ },
  { name: 'Anthropic key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI key', re: /sk-(proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'Groq key', re: /gsk_[A-Za-z0-9]{40,}/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'Google OAuth secret', re: /GOCSPX-[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub token', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/ },
  { name: 'Deepgram key in config', re: /api_key\s*=\s*[0-9a-f]{40}\b/i },
  { name: 'Private key block', re: /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/ }
];

const SKIP_EXT = /\.(png|jpe?g|gif|ico|pdf|onnx|exe|dll|pdb|zip|7z|woff2?|ttf|lock)$/i;

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function listFiles() {
  if (mode === 'all') return git(['ls-files', '-z']).split('\0').filter(Boolean);
  return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);
}

function readContent(file) {
  try {
    if (mode === 'staged') return git(['show', `:${file}`]);
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

const problems = [];
for (const file of listFiles()) {
  const posix = file.replace(/\\/g, '/');
  for (const p of FORBIDDEN_PATHS) {
    if (p.re.test(posix)) problems.push(`${posix}: ${p.why}`);
  }
  if (SKIP_EXT.test(posix)) continue;
  const content = readContent(file);
  if (!content || content.length > 5 * 1024 * 1024 || content.includes('\0')) continue;
  const lines = content.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.includes('secret-scan:allow')) return;
    for (const p of PATTERNS) {
      if (p.re.test(line)) problems.push(`${posix}:${i + 1}: looks like a ${p.name}`);
    }
  });
}

if (problems.length) {
  console.error('\n  Secret scan blocked this commit:\n');
  for (const p of problems) console.error(`   - ${p}`);
  console.error('\n  Remove the secret (or unstage the file). For a fake test value, add "secret-scan:allow" on that line.\n');
  process.exit(1);
}
console.log(`secret scan: ok (${mode})`);
