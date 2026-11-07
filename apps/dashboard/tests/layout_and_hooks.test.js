// The renderer's wiring holds together: every element it looks up exists,
// every data-action/change/input has a handler, every window.rtai call is
// exposed by the preload, and the page keeps its layout anchors.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadRenderer, indexHtml, sources } = require('./helpers/renderer');

const preload = fs.readFileSync(path.resolve(__dirname, '../src/preload/preload.js'), 'utf8');
const markup = [indexHtml, ...Object.values(sources)].join('\n');
const definedIds = new Set([...markup.matchAll(/\bid=["']([A-Za-z][\w-]*)["']/g)].map((m) => m[1]));

test('Feature: dashboard-ui-redesign, Property 6: Preservação dos ganchos de script', () => {
  // Elements looked up by id exist in index.html or in a template the renderer writes.
  let lookups = 0;
  // Third-party code under vendor/ manages its own elements.
  for (const [file, src] of Object.entries(sources).filter(([f]) => !f.startsWith('vendor/'))) {
    for (const m of src.matchAll(/(?:getElementById\(\s*|querySelector(?:All)?\(\s*['"`]#)['"`]?([A-Za-z][\w-]*)['"`]/g)) {
      lookups += 1;
      assert.ok(definedIds.has(m[1]), `${file} looks up #${m[1]}, which no markup defines`);
    }
  }
  assert.ok(lookups > 40, `found ${lookups} lookups`);

  // Every delegated attribute has a handler (dynamic values are skipped).
  const { Cue } = loadRenderer();
  const registry = { action: Cue.actions, change: Cue.changes, input: Cue.inputs };
  let wired = 0;
  for (const m of markup.matchAll(/data-(action|change|input)="([^"$]+)"/g)) {
    wired += 1;
    assert.strictEqual(typeof registry[m[1]][m[2]], 'function', `data-${m[1]}="${m[2]}" has no handler`);
  }
  assert.ok(wired > 100, `found ${wired} delegated attributes`);

  // Every window.rtai method the renderer calls is exposed by the preload.
  const exposed = new Set([...preload.matchAll(/^\s{2}(\w+)\s*:/gm)].map((m) => m[1]));
  for (const [file, src] of Object.entries(sources)) {
    for (const m of src.matchAll(/\b(?:api|window\.rtai)\.(\w+)/g)) {
      assert.ok(exposed.has(m[1]), `${file} calls window.rtai.${m[1]}, which the preload does not expose`);
    }
  }
});

test('Feature: dashboard-ui-redesign, Property 5: Preservação da estrutura de layout', () => {
  // Shell: sidebar + main (top bar, content) + modal and toast layers.
  for (const id of ['app', 'sidebar', 'sideNav', 'crumb', 'content', 'view', 'modalRoot', 'toasts']) {
    assert.ok(indexHtml.includes(`id="${id}"`), `#${id}`);
  }
  assert.ok(/<header class="topbar">/.test(indexHtml), 'top bar (the window drag region)');
  assert.ok(/id="toasts"[^>]*aria-live="polite"/.test(indexHtml), 'toasts are announced');
  // Scripts load core first, then the views that register on window.Cue.
  assert.deepStrictEqual(
    [...indexHtml.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]),
    ['i18n.js', 'locales/pt-BR.js', 'icons.js', 'app.js', 'views.js', 'live.js', 'settings.js', 'orb.js', 'mock.js', 'referral.js', 'pair.js', 'profile.js', 'modals.js', 'auth.js', 'vendor/driver/driver.iife.js', 'tour.js']
  );
  // Every view the sidebar links to is registered.
  const { Cue } = loadRenderer();
  for (const view of ['home', 'sessions', 'session', 'review', 'files', 'questions', 'live', 'settings', 'login']) {
    assert.strictEqual(typeof Cue.views[view], 'function', `view ${view}`);
  }
});

test('Feature: dashboard-ui-redesign, Property 3: Acento provém exclusivamente de Design_Tokens', () => {
  // Colors in the renderer only through CSS variables; the one literal allowed
  // is the white dot on the red Go Live button.
  const literal = [...markup.matchAll(/(?:color|background)\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/g)].map((m) => m[1]);
  assert.deepStrictEqual(literal.filter((c) => c !== '#fff'), [], `hardcoded colors: ${literal.join(', ')}`);
  assert.ok((markup.match(/var\(--accent\)/g) || []).length >= 3, 'accent comes from --accent');
});
