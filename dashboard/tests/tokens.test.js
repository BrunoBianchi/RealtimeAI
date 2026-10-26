const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Helper to extract CSS custom properties from a block
function parseCssBlock(cssContent, selector) {
  // Matches selector { ... }
  // e.g. :root { ... } or .dark { ... }
  const regex = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]+)\\}`, 'm');
  const match = cssContent.match(regex);
  if (!match) return {};

  const lines = match[1].split('\n');
  const tokens = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('/*')) continue;
    const parts = trimmed.split(':');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      let val = parts.slice(1).join(':').trim();
      if (val.endsWith(';')) val = val.slice(0, -1).trim();
      tokens[key] = val;
    }
  }
  return tokens;
}

const inputCssPath = path.resolve(__dirname, '../src/tailwind.input.css');
const tailwindConfigPath = path.resolve(__dirname, '../tailwind.config.js');

test('Feature: dashboard-ui-redesign, Property 4: Paridade de tokens entre os temas', () => {
  const css = fs.readFileSync(inputCssPath, 'utf8');
  const rootTokens = parseCssBlock(css, ':root');
  const darkTokens = parseCssBlock(css, '.dark');

  // Filter only custom properties starting with --
  const rootKeys = Object.keys(rootTokens).filter(k => k.startsWith('--')).sort();
  const darkKeys = Object.keys(darkTokens).filter(k => k.startsWith('--')).sort();

  assert.ok(rootKeys.length > 0, ':root should define design tokens');
  assert.ok(darkKeys.length > 0, '.dark should define design tokens');

  // Verify parity across 100 random samples / permutations
  for (let i = 0; i < 100; i++) {
    const sampleIndex = Math.floor(Math.random() * rootKeys.length);
    const key = rootKeys[sampleIndex];
    assert.ok(
      key in darkTokens,
      `Property 4 violation: Token ${key} exists in :root but is missing in .dark (iteration ${i + 1})`
    );
    assert.ok(
      rootTokens[key] && rootTokens[key].trim().length > 0,
      `Property 4 violation: Token ${key} in :root is empty (iteration ${i + 1})`
    );
    assert.ok(
      darkTokens[key] && darkTokens[key].trim().length > 0,
      `Property 4 violation: Token ${key} in .dark is empty (iteration ${i + 1})`
    );
  }

  // Exact set parity check
  assert.deepStrictEqual(
    rootKeys,
    darkKeys,
    'Property 4 violation: The set of tokens in :root and .dark must be identical'
  );
});

test('Task 1.4: Valores determinísticos dos tokens de design (Requirements: 1.1, 2.1, 2.3)', () => {
  const css = fs.readFileSync(inputCssPath, 'utf8');
  const rootTokens = parseCssBlock(css, ':root');
  const darkTokens = parseCssBlock(css, '.dark');

  // Req 1.1: --radius = 0.375rem in both
  assert.strictEqual(rootTokens['--radius'], '0.375rem', ':root --radius must be 0.375rem');
  assert.strictEqual(darkTokens['--radius'], '0.375rem', '.dark --radius must be 0.375rem');

  // Req 2.1: --primary in light is indigo 221 83% 53%, in dark is light indigo 213 94% 68%
  assert.strictEqual(rootTokens['--primary'], '221 83% 53%', ':root --primary must be 221 83% 53%');
  assert.strictEqual(rootTokens['--primary-foreground'], '0 0% 100%', ':root --primary-foreground must be 0 0% 100%');
  assert.strictEqual(darkTokens['--primary'], '213 94% 68%', '.dark --primary must be 213 94% 68%');
  assert.strictEqual(darkTokens['--primary-foreground'], '222 47% 11%', '.dark --primary-foreground must be 222 47% 11%');

  // Req 2.2: --ring is aligned with --primary
  assert.strictEqual(rootTokens['--ring'], '221 83% 53%', ':root --ring must be 221 83% 53%');
  assert.strictEqual(darkTokens['--ring'], '213 94% 68%', '.dark --ring must be 213 94% 68%');

  // Muted foreground adjustments for contrast AA
  assert.strictEqual(rootTokens['--muted-foreground'], '240 4% 44%', ':root --muted-foreground must be 240 4% 44%');
  assert.strictEqual(darkTokens['--muted-foreground'], '240 5% 66%', '.dark --muted-foreground must be 240 5% 66%');

  // Req 2.3: --live and --destructive remain red
  assert.strictEqual(rootTokens['--live'], '347 77% 50%', ':root --live must be red');
  assert.strictEqual(darkTokens['--live'], '347 77% 50%', '.dark --live must be red');
  assert.strictEqual(rootTokens['--destructive'], '347 77% 50%', ':root --destructive must be red');
  assert.strictEqual(darkTokens['--destructive'], '347 77% 50%', '.dark --destructive must be red');
});

test('Task 2.2: Derivação de raio e tipografia em tailwind.config.js (Requirements: 1.2, 4.1, 4.2)', () => {
  const config = require(tailwindConfigPath);
  assert.ok(config.theme?.extend, 'tailwind.config.js must have theme.extend');

  const borderRadius = config.theme.extend.borderRadius;
  assert.strictEqual(borderRadius.lg, 'var(--radius)', 'borderRadius.lg must derive from var(--radius)');
  assert.strictEqual(borderRadius.md, 'calc(var(--radius) - 2px)', 'borderRadius.md must derive from calc(var(--radius) - 2px)');
  assert.strictEqual(borderRadius.sm, 'calc(var(--radius) - 4px)', 'borderRadius.sm must derive from calc(var(--radius) - 4px)');

  const sansFont = config.theme.extend.fontFamily?.sans;
  assert.ok(Array.isArray(sansFont), 'fontFamily.sans must be an array');
  assert.ok(
    sansFont[0].includes('Segoe UI Variable'),
    `fontFamily.sans[0] must start with Segoe UI Variable, got: ${sansFont[0]}`
  );

  const boxShadow = config.theme.extend.boxShadow;
  assert.ok(boxShadow.shadcn, 'boxShadow.shadcn must be defined');
  assert.ok(boxShadow['shadcn-md'], 'boxShadow.shadcn-md must be defined');
});

