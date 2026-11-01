const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadRenderer, render, el, tags } = require('./helpers/renderer');

const mainJsPath = path.resolve(__dirname, '../src/main/main.js');

test('Model Tier Selection: three cards (Rápido, Equilibrado, Ultra), the current one pressed', () => {
  const cardsFor = (model) => {
    const { Cue } = loadRenderer({ state: { config: { model } } });
    const html = render(Cue, 'settings/ai');
    return { html, cards: tags(html, { 'data-action': 'set-model' }) };
  };

  const { html, cards } = cardsFor('meta-llama/llama-3.3-70b-instruct');
  assert.deepStrictEqual(cards.map((c) => c['data-tier']), ['fast', 'medium', 'ultra']);
  assert.deepStrictEqual(cards.map((c) => c['aria-pressed']), ['false', 'true', 'false']);
  for (const name of ['Qwen 3.6 Flash', 'Llama 3.3 70B', 'GPT-OSS 120B']) assert.ok(html.includes(name));
  assert.ok(!/\d+\s*ms\b/.test(html), 'cards must not promise fixed latencies; the HUD shows measured time');
  assert.ok(html.includes('Atual: Llama 3.3 70B'), 'header names the active model');

  // Both Ultra ids (OpenRouter and Cerebras) light the Ultra card.
  assert.strictEqual(cardsFor('gpt-oss-120b').cards[2]['aria-pressed'], 'true');
  assert.strictEqual(cardsFor('openai/gpt-oss-120b').cards[2]['aria-pressed'], 'true');

  // A custom model lights no card and stays editable in the free-text field.
  const custom = cardsFor('mistralai/mistral-large');
  assert.ok(custom.cards.every((c) => c['aria-pressed'] === 'false'));
  assert.ok(custom.html.includes('Personalizado.'));
  assert.strictEqual(tags(custom.html, { 'data-key': 'model' })[0].value, 'mistralai/mistral-large');
});

test('Model Tier Selection: picking a tier saves the model id the configured provider can serve', async () => {
  const pick = async (tier, config) => {
    const r = loadRenderer({ state: { config }, api: { saveConfig: async (patch) => ({ ok: true, config: { ...config, ...patch } }) } });
    await r.Cue.actions['set-model'](el({ tier }));
    return r.called('saveConfig')[0][0].model;
  };
  assert.strictEqual(await pick('fast', {}), 'qwen/qwen3.6-flash');
  assert.strictEqual(await pick('medium', {}), 'meta-llama/llama-3.3-70b-instruct');
  assert.strictEqual(await pick('ultra', {}), 'openai/gpt-oss-120b', 'no Cerebras key: OpenRouter id');
  assert.strictEqual(await pick('ultra', { has_cerebras_key: true }), 'gpt-oss-120b', 'Cerebras key: direct id');
});

test('Model Tier Selection: main.js re-launches running overlay on model change', () => {
  const mainJs = fs.readFileSync(mainJsPath, 'utf8');

  assert.ok(mainJs.includes('overlayRestarted'), 'main.js must track and return overlayRestarted');
  assert.ok(mainJs.includes('configUpdates.model && isOverlayRunning()'), 'main.js must check if overlay is running when model updates');
  assert.ok(mainJs.includes('launchOverlay'), 'main.js must call launchOverlay to reload the overlay with the new model');
});
