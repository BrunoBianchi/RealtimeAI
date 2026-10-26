const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.resolve(__dirname, '../src/renderer/index.html');
const appJsPath = path.resolve(__dirname, '../src/renderer/app.js');
const preloadJsPath = path.resolve(__dirname, '../src/preload/preload.js');
const mainJsPath = path.resolve(__dirname, '../src/main/main.js');

test('Integrations & Options: HTML contains AI Providers options (Image 1)', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');

  // AI Providers pane & top 5 controls
  assert.ok(html.includes('id="selectActiveModelChoice"'), 'selectActiveModelChoice must exist');
  assert.ok(html.includes('id="selectBackgroundModelChoice"'), 'selectBackgroundModelChoice must exist');
  assert.ok(html.includes('id="selectAiResponseLanguageChoice"'), 'selectAiResponseLanguageChoice must exist');
  assert.ok(html.includes('id="toggleDirectAssist"'), 'toggleDirectAssist must exist');
  assert.ok(html.includes('id="toggleFastResponseMode"'), 'toggleFastResponseMode must exist');

  // Pill tabs and content
  assert.ok(html.includes('id="pillTabCloudProviders"'), 'pillTabCloudProviders must exist');
  assert.ok(html.includes('id="pillTabLocalGateways"'), 'pillTabLocalGateways must exist');
  assert.ok(html.includes('id="pillTabAiPrivacy"'), 'pillTabAiPrivacy must exist');
  assert.ok(html.includes('id="pillContentCloudProviders"'), 'pillContentCloudProviders must exist');
  assert.ok(html.includes('id="pillContentLocalGateways"'), 'pillContentLocalGateways must exist');
  assert.ok(html.includes('id="pillContentAiPrivacy"'), 'pillContentAiPrivacy must exist');

  // Cloud API keys
  assert.ok(html.includes('id="cfgOpenAiKey"'), 'cfgOpenAiKey must exist');
  assert.ok(html.includes('id="cfgAnthropicKey"'), 'cfgAnthropicKey must exist');
  assert.ok(html.includes('id="cfgGeminiKey"'), 'cfgGeminiKey must exist');

  // Local & Privacy
  assert.ok(html.includes('id="cfgLocalEndpoint"'), 'cfgLocalEndpoint must exist');
  assert.ok(html.includes('id="cfgLocalModel"'), 'cfgLocalModel must exist');
  assert.ok(html.includes('id="cfgZeroRetention"'), 'cfgZeroRetention must exist');
  assert.ok(html.includes('id="cfgLocalFallback"'), 'cfgLocalFallback must exist');
  assert.ok(html.includes('id="cfgPiiMasking"'), 'cfgPiiMasking must exist');
});

test('Integrations & Options: HTML contains Speech Provider and Audio Configuration (Image 2)', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');

  // Speech & Audio Pane
  assert.ok(html.includes('id="subpane-speech"'), 'subpane-speech must exist');
  assert.ok(html.includes('id="selectSpeechProvider"'), 'selectSpeechProvider must exist');
  assert.ok(html.includes('id="selectSpeechLanguage"'), 'selectSpeechLanguage must exist');

  // Audio Configuration
  assert.ok(html.includes('id="btnTestSound"'), 'btnTestSound must exist');
  assert.ok(html.includes('id="meterInputLevel"'), 'meterInputLevel must exist');
  assert.ok(html.includes('id="inputLevelValue"'), 'inputLevelValue must exist');
  assert.ok(html.includes('id="meterSystemAudioLevel"'), 'meterSystemAudioLevel must exist');
  assert.ok(html.includes('id="systemAudioLevelValue"'), 'systemAudioLevelValue must exist');
  assert.ok(html.includes('id="selectInputDevice"'), 'selectInputDevice must exist');
  assert.ok(html.includes('id="selectOutputDevice"'), 'selectOutputDevice must exist');
});

test('Integrations & Options: HTML contains Google Calendar connection & meeting detection (Images 3 & 4)', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');

  assert.ok(html.includes('id="btnConnectGoogleCalendarHero"'), 'btnConnectGoogleCalendarHero must exist');
  assert.ok(html.includes('id="cfgCalendarDetectMeetings"'), 'cfgCalendarDetectMeetings must exist');
  assert.ok(html.includes('Connect Google Calendar to see your next meetings'), 'Hero connection description must exist');
  assert.ok(html.includes('Offers to start RealTimeAI when a Zoom, Teams, Meet or Webex call begins'), 'Detect meetings description must exist');
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

test('Integrations & Options: app.js handles AI providers switching, audio device enumeration, and test sound', () => {
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  assert.ok(appJs.includes('setupAiProvidersAndAudio'), 'setupAiProvidersAndAudio function must exist in app.js');
  assert.ok(appJs.includes('selectActiveModelChoice'), 'selectActiveModelChoice must be wired in app.js');
  assert.ok(appJs.includes('btnTestSound'), 'btnTestSound must be wired in app.js');
  assert.ok(appJs.includes('btnConnectGoogleCalendarHero'), 'btnConnectGoogleCalendarHero must be wired in app.js');
  assert.ok(appJs.includes('cfgCalendarDetectMeetings'), 'cfgCalendarDetectMeetings must be wired in app.js');
});
