const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { dark, light, lightOverrides, isColor, parseColor } = require('./helpers/css');

const tailwindConfigPath = path.resolve(__dirname, '../tailwind.config.js');

test('Feature: dashboard-ui-redesign, Property 4: Paridade de tokens entre os temas', () => {
  const darkKeys = Object.keys(dark);
  assert.ok(darkKeys.length > 30, ':root should define the design tokens');

  // The light theme only overrides tokens that exist (no orphan names)...
  for (const key of Object.keys(lightOverrides)) {
    assert.ok(key in dark, `Property 4 violation: ${key} is set for the light theme but not in :root`);
  }
  // ...and sets every color explicitly: a color inherited from the dark theme
  // is how the light theme ended up with 2:1 warnings.
  const colors = darkKeys.filter((k) => isColor(dark[k]));
  assert.ok(colors.length > 25);
  for (const key of colors) {
    assert.ok(key in lightOverrides, `Property 4 violation: color ${key} has no light-theme value`);
  }
  for (const [key, value] of Object.entries(light)) {
    assert.ok(value.length > 0, `Property 4 violation: ${key} is empty`);
  }
});

test('Task 1.4: Valores determinísticos dos tokens de design (Requirements: 1.1, 2.1, 2.3)', () => {
  // Radius scale: sm < base < md < lg, in px.
  const px = (k) => {
    assert.match(dark[k], /^\d+px$/, `${k} must be in px`);
    return parseInt(dark[k], 10);
  };
  const radii = ['--radius-sm', '--radius', '--radius-md', '--radius-lg'].map(px);
  assert.deepStrictEqual([...radii].sort((a, b) => a - b), radii, 'radius scale must grow');

  // Typography: Geist with Segoe UI fallbacks; JetBrains Mono for numbers.
  assert.match(dark['--font-sans'], /^Geist,.*'Segoe UI Variable Text'.*system-ui/);
  assert.match(dark['--font-mono'], /^'JetBrains Mono',.*monospace$/);

  // One emerald accent, rose for danger, amber for warning, in both themes.
  const hue = (value) => {
    const [r, g, b] = parseColor(value).map((v) => v / 255);
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (!d) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  for (const [name, theme] of [['dark', dark], ['light', light]]) {
    assert.ok(hue(theme['--accent']) > 140 && hue(theme['--accent']) < 170, `${name} accent must be emerald`);
    assert.ok(hue(theme['--danger']) > 330 || hue(theme['--danger']) < 10, `${name} danger must be rose/red`);
    assert.ok(hue(theme['--warning']) > 20 && hue(theme['--warning']) < 45, `${name} warning must be amber`);
  }
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
