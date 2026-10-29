const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.resolve(__dirname, '../src/renderer/index.html');
const appJsPath = path.resolve(__dirname, '../src/renderer/app.js');
const mainJsPath = path.resolve(__dirname, '../src/main/main.js');
const popupHtmlPath = path.resolve(__dirname, '../src/renderer/meeting_popup.html');
const tailwindCssPath = path.resolve(__dirname, '../src/renderer/tailwind.input.css');
const stylesCssPath = path.resolve(__dirname, '../src/renderer/styles.css');

test('Standardized Default Theme: HTML and Core defaults to Dark theme', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const mainJs = fs.readFileSync(mainJsPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');
  const popupHtml = fs.readFileSync(popupHtmlPath, 'utf8');

  // Root HTML must have class="dark" by default
  assert.ok(html.includes('<html lang="en" class="dark">'), 'index.html must have class="dark" by default');

  // Meeting popup must default to dark
  assert.ok(popupHtml.includes('data-theme="dark"'), 'meeting_popup.html must have data-theme="dark"');

  // main.js getThemeState must fall back to "dark"
  assert.ok(mainJs.includes("profile.themePreference || 'dark'"), 'main.js must default theme to dark');

  // app.js initial themeState must default to dark
  assert.ok(appJs.includes("themeState: { preference: 'dark', resolved: 'dark'"), 'app.js initial state must default to dark');
});

test('Standardized Design Tokens: Visual harmony across buttons, badges and surfaces', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const css = fs.readFileSync(tailwindCssPath, 'utf8');
  const stylesCss = fs.readFileSync(stylesCssPath, 'utf8');

  // No hardcoded beige surfaces or bright orange CTAs in index.html
  assert.ok(!html.includes('#FFFBF5'), 'Must not contain hardcoded #FFFBF5');
  assert.ok(!html.includes('#1A140B'), 'Must not contain hardcoded #1A140B');
  assert.ok(!html.includes('#FF4F00'), 'Must not contain hardcoded #FF4F00');
  assert.ok(!html.includes('#E04500'), 'Must not contain hardcoded #E04500');

  // Badges are harmonized
  assert.ok(html.includes('id="profilePlanBadge" class="rounded-full bg-emerald-500/15 border border-emerald-500/30'), 'profilePlanBadge must match sidebarPlanBadge emerald theme');
  assert.ok(html.includes('id="profileAvatar" class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/20 border border-primary/30 text-[10px] font-bold text-primary'), 'User avatar must use standard primary token');

  // Question Bank unlock CTA uses standard tokens
  assert.ok(!html.includes('id="btnQbUnlockTop3"\n                      type="button"\n                      class="inline-flex items-center gap-1.5 rounded-lg bg-foreground text-background'), 'btnQbUnlockTop3 must not use jarring bg-foreground text-background');

  // Settings theme cards active style exists in CSS
  assert.ok(css.includes('.theme-pref-btn.active-theme:not(.theme-icon)'), 'tailwind.input.css must define active state for theme cards');
  assert.ok(stylesCss.includes('theme-pref-btn.active-theme'), 'styles.css must compile theme-pref-btn.active-theme');
});
