// WCAG 2.1 contrast of the design tokens in both themes (tailwind.input.css).
const test = require('node:test');
const assert = require('node:assert');
const { dark, light, contrast } = require('./helpers/css');

const THEMES = [['dark', dark], ['light', light]];
const SURFACES = ['--bg', '--surface-raised', '--surface-card', '--surface-overlay'];

function check(fgs, surfaces, min, what) {
  for (const [name, theme] of THEMES) {
    for (const fg of fgs) {
      for (const bg of surfaces) {
        const ratio = contrast(theme, fg, bg);
        assert.ok(ratio >= min, `${what} (${name}): ${fg} on ${bg} is ${ratio.toFixed(2)}:1, expected >= ${min}:1`);
      }
    }
  }
}

test('Feature: dashboard-ui-redesign, Property 1: Contraste de texto atende AA nos dois temas', () => {
  // Body text, secondary text and status text (errors, warnings): AA 4.5:1.
  check(['--text', '--text-body', '--text-secondary', '--danger', '--warning'], SURFACES, 4.5, 'text');
  // Primary button label on the button.
  check(['--btn-primary-text'], ['--btn-primary-bg'], 4.5, 'primary button');
  // Tertiary meta text (timestamps, hints) stays readable as large/incidental text.
  check(['--text-tertiary'], SURFACES, 3, 'tertiary text');
});

test('Feature: dashboard-ui-redesign, Property 2: Contraste do indicador de foco atende AA', () => {
  // Focus outline and accent-filled controls (switches, dots): 3:1 (WCAG 1.4.11).
  check(['--border-focus', '--accent'], SURFACES, 3, 'non-text');
});
