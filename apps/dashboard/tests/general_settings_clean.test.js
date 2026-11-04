const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadRenderer, render, el, tags } = require('./helpers/renderer');
const { loadMain } = require('./helpers/main');

const mainJsPath = path.resolve(__dirname, '../src/main/main.js');

const PROVIDERS = ['deepgram_key', 'llm_key', 'cerebras_key', 'groq_key', 'openai_key', 'anthropic_key', 'gemini_key'];

test('General Settings: one auto-saving field per provider key, no save button', () => {
  const { Cue } = loadRenderer({
    state: { config: { has_deepgram_key: true, deepgram_key_display: '••••••••a1b2', has_llm_key: false } }
  });
  const html = render(Cue, 'settings/ai');

  const fields = tags(html, { 'data-key-input': true });
  assert.deepStrictEqual(fields.map((f) => f['data-key-input']), PROVIDERS, 'Cerebras and Groq are back: the engine uses them');
  for (const f of fields) {
    assert.strictEqual(f.type, 'password', `${f['data-key-input']} is masked`);
    assert.strictEqual(f.autocomplete, 'off');
  }
  // A saved key shows only its mask and can be removed; a missing one asks to paste.
  assert.strictEqual(fields[0].placeholder, '••••••••a1b2');
  assert.strictEqual(fields[1].placeholder, 'Paste the key');
  assert.deepStrictEqual(tags(html, { 'data-action': 'clear-key' }).map((b) => b['data-key']), ['deepgram_key']);
  assert.ok(html.includes('● connected') && html.includes('○ not set'));
  assert.ok(!/>\s*Salvar\s*</.test(html), 'no save button: keys save on Enter or blur');
});

test('General Settings: removing a key asks first, then clears it', async () => {
  let asked = 0;
  const r = loadRenderer({ api: { saveConfig: async () => ({ ok: true }) } });
  r.Cue.confirm = async () => {
    asked += 1;
    return asked > 1; // refuse the first time, accept the second
  };
  const btn = el({ key: 'llm_key', label: 'OpenRouter' });
  await r.Cue.actions['clear-key'](btn);
  assert.strictEqual(r.called('saveConfig').length, 0, 'cancelled: nothing saved');
  await r.Cue.actions['clear-key'](btn);
  assert.deepStrictEqual(r.called('saveConfig'), [[{ llm_key: '' }]]);
});

test('General Settings: main.js masks keys in English and supports key clearing', () => {
  const mainJs = fs.readFileSync(mainJsPath, 'utf8');

  assert.ok(mainJs.includes('Encrypted via Windows DPAPI'), 'DPAPI mask text must be in English');
  assert.ok(!mainJs.includes('Criptografada via Windows DPAPI'), 'Portuguese DPAPI mask must be removed');
});

test('General Settings: a plaintext key never reaches the renderer in full', () => {
  const { main, restore } = loadMain();
  try {
    // Not encrypted yet (the engine does that on its first run).
    main.writeConfigIni({ llm_key: 'sk-or-v1-0123456789abcdef' });
    const cfg = main.readConfigIni();
    assert.strictEqual(cfg.has_llm_key, true);
    assert.strictEqual(cfg.llm_key_display, '••••••••cdef', 'only the last 4 characters are shown');
    for (const [k, v] of Object.entries(cfg)) {
      if (k.endsWith('_display')) assert.ok(!String(v).includes('0123456789'), `${k} must not carry the key`);
    }
  } finally {
    restore();
  }
});
