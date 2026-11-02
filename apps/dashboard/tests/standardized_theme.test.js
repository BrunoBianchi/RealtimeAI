const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadRenderer, render, indexHtml, sources, tags } = require('./helpers/renderer');
const { css } = require('./helpers/css');

const mainJsPath = path.resolve(__dirname, '../src/main/main.js');
const popupHtmlPath = path.resolve(__dirname, '../src/renderer/meeting_popup.html');

test('Standardized Default Theme: HTML and Core defaults to Dark theme', () => {
  const mainJs = fs.readFileSync(mainJsPath, 'utf8');
  const popupHtml = fs.readFileSync(popupHtmlPath, 'utf8');

  // Root HTML starts dark (no flash of the light theme before boot).
  assert.ok(/<html lang="pt-BR" data-theme="dark">/.test(indexHtml), 'index.html must start with data-theme="dark"');
  // Meeting popup must default to dark
  assert.ok(popupHtml.includes('data-theme="dark"'), 'meeting_popup.html must have data-theme="dark"');
  // main.js getThemeState must fall back to "dark"
  assert.ok(mainJs.includes("profile.themePreference || 'dark'"), 'main.js must default theme to dark');
  // The renderer's initial state is dark too.
  const { S } = loadRenderer();
  assert.strictEqual(S.themeState.preference, 'dark');
  assert.strictEqual(S.themeState.resolved, 'dark');
});

test('Standardized Design Tokens: colors come from tokens and the theme cards show the choice', () => {
  // No hardcoded colors in the markup: everything goes through the CSS tokens.
  const markup = [indexHtml, ...Object.values(sources)].join('\n');
  const hexes = [...markup.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0]);
  assert.deepStrictEqual(hexes, [], `hardcoded colors in the renderer: ${hexes.join(', ')}`);
  for (const old of ['#FFFBF5', '#1A140B', '#FF4F00', '#E04500']) assert.ok(!css.includes(old), `old palette color ${old}`);

  // Settings > General: three theme cards, the saved preference pressed.
  for (const pref of ['dark', 'light', 'system']) {
    const { Cue } = loadRenderer({ state: { themeState: { preference: pref, resolved: pref === 'light' ? 'light' : 'dark' } } });
    const cards = tags(render(Cue, 'settings/general'), { 'data-action': 'set-theme' });
    assert.deepStrictEqual(cards.map((c) => c['data-theme']), ['dark', 'light', 'system']);
    assert.deepStrictEqual(cards.filter((c) => c['aria-pressed'] === 'true').map((c) => c['data-theme']), [pref]);
  }
  assert.ok(/\.option-card\.active\b/.test(css), 'the active theme card has a style');
});
