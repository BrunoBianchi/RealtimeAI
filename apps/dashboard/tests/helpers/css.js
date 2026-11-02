// Design tokens of the dashboard (src/renderer/tailwind.input.css) and the
// WCAG 2.1 contrast math the token tests share. Dark is the default theme
// (:root); the light theme overrides part of it under html[data-theme='light'].
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INPUT = path.resolve(__dirname, '..', '..', 'src', 'renderer', 'tailwind.input.css');
const OUTPUT = path.resolve(__dirname, '..', '..', 'src', 'renderer', 'styles.css');

const css = fs.readFileSync(INPUT, 'utf8');

function block(selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return {};
  const body = css.slice(start, css.indexOf('}', start));
  const tokens = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) tokens[m[1]] = m[2].trim();
  return tokens;
}

const dark = block(':root');
const lightOverrides = block("html[data-theme='light']");
const light = { ...dark, ...lightOverrides };

// '#rrggbb' or 'rgba(r, g, b, a)' -> [r, g, b, a]; null for anything else.
function parseColor(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value || '');
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(value || '');
  if (!fn) return null;
  const [r, g, b, a = 1] = fn[1].split(',').map(Number);
  return [r, g, b, a];
}

const isColor = (value) => parseColor(value) !== null;

// A translucent color as seen on top of an opaque surface.
function over(fg, bg) {
  const a = fg[3];
  return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)).concat(1);
}

function luminance([r, g, b]) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// Contrast of token `fg` drawn on token `bg` in a theme's token map.
function contrast(theme, fg, bg) {
  const surface = parseColor(theme[bg]);
  const ink = over(parseColor(theme[fg]), surface);
  const [hi, lo] = [luminance(ink), luminance(surface)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

module.exports = { INPUT, OUTPUT, css, dark, light, lightOverrides, parseColor, isColor, contrast };
