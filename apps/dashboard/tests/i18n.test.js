'use strict';
// Interface language: follows the Windows display language ("auto") or the
// Language setting, translates rendered text from the catalogs, and every
// screen is covered by each catalog.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { normalizeUiLanguage, resolveUiLocale, systemLanguages, matchSupported } = require('../src/main/ui_locale');
const I18n = require('../src/renderer/i18n.js');
require('../src/renderer/locales/pt-BR.js');
const { missing } = require('./helpers/i18n_coverage');
const { loadRenderer, render, tags } = require('./helpers/renderer');

test('ui_locale: "auto" follows the first Windows language with a catalog', () => {
  assert.strictEqual(resolveUiLocale('auto', ['pt-BR', 'en-US']), 'pt-BR');
  assert.strictEqual(resolveUiLocale('auto', ['de-DE', 'pt-PT', 'en-US']), 'pt-BR', 'pt-PT falls back to the Portuguese catalog');
  assert.strictEqual(resolveUiLocale('auto', ['en-GB', 'pt-BR']), 'en', 'order of preference wins');
  assert.strictEqual(resolveUiLocale('auto', ['de-DE', 'ja-JP']), 'en', 'no catalog: English');
  assert.strictEqual(resolveUiLocale('auto', []), 'en');
  assert.strictEqual(resolveUiLocale('en', ['pt-BR']), 'en', 'an explicit choice beats Windows');
  assert.strictEqual(resolveUiLocale('pt-BR', ['en-US']), 'pt-BR');
});

test('ui_locale: stored values are normalized', () => {
  assert.strictEqual(normalizeUiLanguage(''), 'auto');
  assert.strictEqual(normalizeUiLanguage('AUTO'), 'auto');
  assert.strictEqual(normalizeUiLanguage('pt_br'), 'pt-BR');
  assert.strictEqual(normalizeUiLanguage('pt'), 'pt-BR');
  assert.strictEqual(normalizeUiLanguage('klingon'), 'auto');
  assert.strictEqual(matchSupported('EN-us'), 'en');
});

test('ui_locale: Windows languages come from Electron, most preferred first', () => {
  const app = { getPreferredSystemLanguages: () => ['pt-BR', 'en-US'], getLocale: () => 'pt-BR' };
  assert.deepStrictEqual(systemLanguages(app), ['pt-BR', 'en-US']);
  assert.deepStrictEqual(systemLanguages({ getLocale: () => 'en-US' }), ['en-US'], 'older Electron');
  assert.deepStrictEqual(systemLanguages({ getPreferredSystemLanguages: () => { throw new Error('x'); } }), []);
});

test('main process: config.ini [sistema] idioma_interface round-trips as ui_language', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rtai-i18n-'));
  process.env.LOCALAPPDATA = tmp;
  process.env.RTAI_TEST_EXPORTS = '1';
  const fakeElectron = {
    app: { whenReady: () => new Promise(() => {}), on: () => {}, quit: () => {}, getPreferredSystemLanguages: () => ['pt-BR'], getLocale: () => 'pt-BR' },
    BrowserWindow: function () {},
    ipcMain: { handle: () => {}, on: () => {} },
    dialog: {},
    shell: {},
    nativeTheme: { shouldUseDarkColors: true },
    Notification: { isSupported: () => false }
  };
  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return fakeElectron;
    return realLoad.call(this, request, ...rest);
  };
  const main = require('../src/main/main.js');
  Module._load = realLoad;

  assert.strictEqual(main.readConfigIni().ui_language, 'auto', 'default is automatic');
  main.writeConfigIni({ ui_language: 'pt-BR' });
  const ini = fs.readFileSync(path.join(tmp, 'RealTimeAI', 'config.ini'), 'utf8');
  assert.match(ini, /idioma_interface\s*=\s*pt-BR/);
  assert.strictEqual(main.readConfigIni().ui_language, 'pt-BR');
  main.writeConfigIni({ ui_language: 'nonsense' });
  assert.strictEqual(main.readConfigIni().ui_language, 'auto');
});

test('runtime: exact strings, templates and nested values', () => {
  const cat = I18n.catalogs['pt-BR'];
  assert.strictEqual(I18n.lookup(cat, 'Sign out'), 'Sair');
  assert.strictEqual(I18n.lookup(cat, '3 active sessions'), '3 sessões ativas');
  assert.strictEqual(I18n.lookup(cat, 'Acme · 2 files'), 'Acme · 2 arquivos', 'names stay, the rest is translated');
  assert.strictEqual(I18n.lookup(cat, 'Interview language saved.'), 'Idioma da entrevista salvo.');
  assert.strictEqual(I18n.lookup(cat, 'Deepgram'), 'Deepgram', 'brands are kept');
  assert.strictEqual(I18n.lookup(cat, 'Something new'), null);
  // Whitespace around a text node is kept; text without letters is left alone.
  assert.strictEqual(I18n.translateText(cat, '\n   Settings  '), '\n   Configurações  ');
  assert.strictEqual(I18n.translateText(cat, '12:30'), null);
  // Code-level helper falls back to English with the values filled in.
  I18n.locale = 'pt-BR';
  assert.strictEqual(I18n.t('In {n} days', { n: 3 }), 'Em 3 dias');
  assert.strictEqual(I18n.t('Not in the catalog {x}', { x: 1 }), 'Not in the catalog 1');
  I18n.locale = 'en';
  assert.strictEqual(I18n.t('In {n} days', { n: 3 }), 'In 3 days');
});

test('renderer: Windows in Portuguese switches the interface, dates included', () => {
  const r = loadRenderer({ state: { lang: { locale: 'en', systemLanguages: ['pt-BR', 'en-US'], supported: ['en', 'pt-BR'] }, config: { ui_language: 'auto' } } });
  assert.strictEqual(r.Cue.applyLocale(false), 'pt-BR');
  assert.strictEqual(r.document.documentElement.lang, 'pt-BR');
  assert.strictEqual(r.Cue.t('Today'), 'Hoje');
  assert.match(r.Cue.fmtDateShort(new Date(2026, 10, 3)), /^3 de nov$/);

  r.S.config.ui_language = 'en';
  assert.strictEqual(r.Cue.applyLocale(false), 'en', 'the setting overrides Windows');
  assert.strictEqual(r.Cue.fmtDateShort(new Date(2026, 10, 3)), 'Nov 3');
});

test('settings: General has the Language choice, with Automatic showing the Windows language', () => {
  const r = loadRenderer({ state: { lang: { locale: 'en', systemLanguages: ['pt-BR'], supported: ['en', 'pt-BR'] }, config: { ui_language: 'auto' } } });
  const html = render(r.Cue, 'settings/general');
  const [select] = tags(html, { 'data-key': 'ui_language' });
  assert.ok(select, 'Language select');
  assert.strictEqual(select['data-change'], 'cfg');
  assert.match(html, /<option value="auto" selected>Automatic · Windows: Português \(Brasil\)<\/option>/);
  assert.match(html, /<option value="pt-BR"[^>]*>Português \(Brasil\)<\/option>/);
});

test('coverage: every screen, tab and dialog is translated in each catalog', async () => {
  const dir = path.join(__dirname, '..', 'src', 'renderer', 'locales');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const locale = file.slice(0, -3);
    const list = await missing(locale);
    assert.deepStrictEqual(list, [], `${locale}: untranslated text (run npm run i18n:check)`);
  }
});
