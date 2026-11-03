// Interface language. config.ini [sistema] idioma_interface = auto | <locale>.
// "auto" follows the Windows display languages (Settings > Time & language >
// Language & region), read through Electron at start-up; the first one the app
// has a catalog for wins, else English. Catalogs live in
// src/renderer/locales/<locale>.js (English is the source text, no catalog).
'use strict';

// Every locale with a catalog, plus English. Keep in sync with
// src/renderer/locales/ and the Language setting (settings.js).
const SUPPORTED = ['en', 'pt-BR'];

// "pt", "pt_br", "PT-BR" -> "pt-BR"; unknown values -> null.
function matchSupported(tag) {
  const t = String(tag || '').trim().replace('_', '-').toLowerCase();
  if (!t) return null;
  const exact = SUPPORTED.find((s) => s.toLowerCase() === t);
  if (exact) return exact;
  const lang = t.split('-')[0];
  return SUPPORTED.find((s) => s.toLowerCase().split('-')[0] === lang) || null;
}

// The stored preference: "auto" or a supported locale.
function normalizeUiLanguage(value) {
  const v = String(value || '').trim();
  if (!v || v.toLowerCase() === 'auto') return 'auto';
  return matchSupported(v) || 'auto';
}

// The locale to show: the preference, or the first Windows language with a
// catalog. `systemLanguages` is app.getPreferredSystemLanguages() (most
// preferred first), with app.getLocale() as a fallback.
function resolveUiLocale(preference, systemLanguages) {
  const pref = normalizeUiLanguage(preference);
  if (pref !== 'auto') return pref;
  for (const tag of systemLanguages || []) {
    const m = matchSupported(tag);
    if (m) return m;
  }
  return 'en';
}

// Windows display languages, most preferred first (["pt-BR", "en-US"]).
function systemLanguages(app) {
  const out = [];
  try {
    if (app && typeof app.getPreferredSystemLanguages === 'function') out.push(...app.getPreferredSystemLanguages());
  } catch (_e) { /* older Electron */ }
  try {
    if (app && typeof app.getLocale === 'function') out.push(app.getLocale());
  } catch (_e) { /* not ready */ }
  return [...new Set(out.filter(Boolean))];
}

module.exports = { SUPPORTED, matchSupported, normalizeUiLanguage, resolveUiLocale, systemLanguages };
