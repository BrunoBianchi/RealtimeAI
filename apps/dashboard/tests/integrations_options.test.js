const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadRenderer, render, sources, el, tags } = require('./helpers/renderer');
const { loadMain } = require('./helpers/main');

const preloadJsPath = path.resolve(__dirname, '../src/preload/preload.js');
const mainJsPath = path.resolve(__dirname, '../src/main/main.js');

const cfgKeys = (html) => tags(html, { 'data-change': 'cfg' }).map((t) => t['data-key']);

test('Integrations & Options: Settings > AI has models, behavior, keys and local endpoints', () => {
  const { Cue } = loadRenderer({ state: { config: { ai_response_language: 'en-US', background_model: 'auto' } } });
  const html = render(Cue, 'settings/ai');
  for (const key of ['model', 'auto_suggest', 'cooldown_s', 'ai_response_language', 'fast_response_mode', 'direct_assist',
    'background_model', 'reasoning', 'max_tokens', 'temperature', 'keywords', 'llm_url', 'local_endpoint', 'local_model']) {
    assert.ok(cfgKeys(html).includes(key), `AI settings must have a control for ${key}`);
  }
  // Selects open on the saved value.
  assert.ok(/data-key="ai_response_language"[^>]*>[\s\S]*?<option value="en-US" selected>/.test(html));
  // Background model offers the three tiers plus automatic.
  const bg = html.slice(html.indexOf('data-key="background_model"'));
  for (const id of ['auto', 'qwen/qwen3.6-flash', 'meta-llama/llama-3.3-70b-instruct', 'openai/gpt-oss-120b']) {
    assert.ok(bg.includes(`<option value="${id}"`), `background model option ${id}`);
  }
  // Cloud providers beyond OpenRouter.
  const keyFields = tags(html, { 'data-key-input': true }).map((t) => t['data-key-input']);
  for (const key of ['openai_key', 'anthropic_key', 'gemini_key']) assert.ok(keyFields.includes(key), key);
});

test('Integrations & Options: Settings > Audio lists real devices, the mic meter and the test sound', () => {
  const { Cue } = loadRenderer({
    state: {
      config: { language: 'en-US', audio_input_device: 'mic-2', endpointing_ms: 300 },
      ui: { audioDevices: { inputs: [{ deviceId: 'mic-1', label: 'Headset' }, { deviceId: 'mic-2', label: 'USB Mic' }], outputs: [{ deviceId: 'out-1', label: 'Speakers' }] } }
    }
  });
  const html = render(Cue, 'settings/audio');
  for (const key of ['mic_enabled', 'loopback_enabled', 'noise_cancellation', 'endpointing_ms', 'keyterms', 'vad', 'energy_threshold']) {
    assert.ok(cfgKeys(html).includes(key), `audio settings must have ${key}`);
  }
  const input = html.slice(html.indexOf('data-kind="input"'), html.indexOf('data-kind="output"'));
  assert.ok(input.includes('<option value="default"') && input.includes('Headset'));
  assert.ok(input.includes('<option value="mic-2" selected>USB Mic</option>'), 'saved microphone is selected');
  assert.ok(html.slice(html.indexOf('data-kind="output"')).includes('Speakers'));
  assert.ok(html.includes('id="micVu"') && html.includes('id="micDb"'), 'mic level meter');
  assert.ok(tags(html, { 'data-action': 'test-sound' }).length === 1);
  assert.ok(/data-change="language">[\s\S]*?<option value="en-US" selected>/.test(html), 'interview language select');
});

test('Integrations & Options: meeting detection and Google Calendar have their own settings', () => {
  const { Cue } = loadRenderer({
    state: { meeting: { supported: true, enabled: true, keepInTray: false, active: [], mutedApps: [] }, gcal: { status: { configured: true, connected: false } } }
  });
  const general = render(Cue, 'settings/general');
  assert.deepStrictEqual(tags(general, { 'data-change': 'meeting' }).map((t) => t['data-field']), ['enabled', 'keepInTray']);
  assert.ok(general.includes('Observando Meet, Teams, Zoom, Discord, Slack e outros.'));
  const calendar = render(Cue, 'settings/calendar');
  assert.ok(tags(calendar, { 'data-action': 'gcal-connect' }).length === 1, 'configured client: Conectar');
});

test('Integrations & Options: preload.js exposes testSound API', () => {
  const preload = fs.readFileSync(preloadJsPath, 'utf8');
  assert.ok(preload.includes('testSound:'), 'preload must expose testSound');
});

test('Integrations & Options: main.js reads, writes, and supports all new integration keys', () => {
  const main = fs.readFileSync(mainJsPath, 'utf8');

  // Handlers
  assert.ok(main.includes("'rtai:test-sound'"), 'main.js must handle rtai:test-sound');

  // Config INI schema
  assert.ok(main.includes('background_model'), 'main.js must handle background_model');
  assert.ok(main.includes('ai_response_language'), 'main.js must handle ai_response_language');
  assert.ok(main.includes('direct_assist'), 'main.js must handle direct_assist');
  assert.ok(main.includes('fast_response_mode'), 'main.js must handle fast_response_mode');
  assert.ok(main.includes('speech_provider'), 'main.js must handle speech_provider');
  assert.ok(main.includes('speech_language'), 'main.js must handle speech_language');
  assert.ok(main.includes('audio_input_device'), 'main.js must handle audio_input_device');
  assert.ok(main.includes('audio_output_device'), 'main.js must handle audio_output_device');
});

test('Integrations & Options: device changes save both key spellings and the test sound reaches the main process', async () => {
  const r = loadRenderer({ api: { saveConfig: async () => ({ ok: true }) } });
  await r.Cue.changes['audio-device'](el({ kind: 'output' }, { value: 'out-1', selectedOptions: [{ textContent: 'Speakers' }] }));
  assert.deepStrictEqual(r.called('saveConfig'), [[{ audio_output_device: 'out-1', output_device: 'out-1' }]]);
  await r.Cue.actions['test-sound']();
  assert.strictEqual(r.called('testSound').length, 1);
});

test('Integrations & Options: every setting the dashboard writes reads back the same from config.ini', () => {
  // Keys of every cfg* control and every saveConfig({ ... }) literal in the renderer.
  const src = Object.values(sources).join('\n');
  const keys = new Set([...src.matchAll(/cfg(?:Switch|Select|Number|Text)\('([a-z_]+)'/g)].map((m) => m[1]));
  for (const m of src.matchAll(/saveConfig\(\{\s*([^}]+)\}/g)) for (const k of m[1].matchAll(/([a-z_]+)\s*:/g)) keys.add(k[1]);
  // Legacy spellings sent next to the canonical key (main.js accepts both).
  const ALIASES = { input_device: 'audio_input_device', output_device: 'audio_output_device' };
  assert.ok(keys.size > 30, `found ${keys.size} keys`);

  const { main, restore } = loadMain();
  try {
    for (const key of keys) {
      const canonical = ALIASES[key] || key;
      const before = main.readConfigIni()[canonical];
      const value = typeof before === 'boolean' ? !before : typeof before === 'number' ? before + 1 : `x-${key}`;
      main.writeConfigIni({ [key]: value });
      assert.strictEqual(String(main.readConfigIni()[canonical]), String(value), `${key} does not survive config.ini`);
    }
  } finally {
    restore();
  }
});
