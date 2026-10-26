const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.resolve(__dirname, '../src/index.html');
const appJsPath = path.resolve(__dirname, '../src/app.js');
const mainJsPath = path.resolve(__dirname, '../main.js');

test('Model Tier Selection: HTML contains 3 accessible cards (Fast, Balanced, Ultra)', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');

  // Verify the 3 cards exist
  assert.ok(html.includes('id="cardModelFast"'), 'Card Fast must exist');
  assert.ok(html.includes('id="cardModelMedium"'), 'Card Medium must exist');
  assert.ok(html.includes('id="cardModelUltra"'), 'Card Ultra must exist');

  // Verify tier data attributes
  assert.ok(html.includes('data-tier="fast"'), 'data-tier="fast" must exist');
  assert.ok(html.includes('data-tier="medium"'), 'data-tier="medium" must exist');
  assert.ok(html.includes('data-tier="ultra"'), 'data-tier="ultra" must exist');

  // Verify model values
  assert.ok(html.includes('data-model="qwen/qwen3.6-flash"'), 'Fast model must be qwen/qwen3.6-flash');
  assert.ok(html.includes('data-model="meta-llama/llama-3.3-70b-instruct"'), 'Medium model must be meta-llama/llama-3.3-70b-instruct');
  assert.ok(html.includes('data-model="gpt-oss-120b"'), 'Ultra model must be gpt-oss-120b');

  // Each card explains itself: speed/depth meters plus best-for and trade-off lines
  assert.strictEqual((html.match(/class="tier-meter"/g) || []).length, 6, 'Each card must have Speed and Depth meters');
  assert.ok((html.match(/>Best for</g) || []).length >= 3, 'Each card must have a "Best for" line');
  assert.ok((html.match(/>Trade-off</g) || []).length >= 3, 'Each card must have a "Trade-off" line');
  assert.ok(html.includes('role="radiogroup"'), 'Cards must be exposed as a radio group');
  assert.ok(!/\d+\s*ms latency/.test(html), 'Cards must not promise fixed latencies; the HUD shows measured time');

  // Verify active badge & backing select element
  assert.ok(html.includes('id="activeModelBadge"'), 'activeModelBadge element must exist');
  assert.ok(html.includes('id="selectDefaultModel"'), 'selectDefaultModel must be preserved');
});

test('Model Tier Selection: app.js contains tier mapping, UI update, and auto-save logic', () => {
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  assert.ok(appJs.includes('getTierForModel'), 'getTierForModel function must exist in app.js');
  assert.ok(appJs.includes('updateModelCardsUI'), 'updateModelCardsUI function must exist in app.js');
  assert.ok(appJs.includes('selectModelTier'), 'selectModelTier function must exist in app.js');
  assert.ok(appJs.includes('saveConfig'), 'saveConfig call must be triggered on tier change');
  assert.ok(appJs.includes("'openai/gpt-oss-120b'"), 'Ultra must use the OpenRouter id when no Cerebras key is set');
});

test('Model Tier Selection: main.js re-launches running overlay on model change', () => {
  const mainJs = fs.readFileSync(mainJsPath, 'utf8');

  assert.ok(mainJs.includes('overlayRestarted'), 'main.js must track and return overlayRestarted');
  assert.ok(mainJs.includes('configUpdates.model && isOverlayRunning()'), 'main.js must check if overlay is running when model updates');
  assert.ok(mainJs.includes('launchOverlay'), 'main.js must call launchOverlay to reload the overlay with the new model');
});

