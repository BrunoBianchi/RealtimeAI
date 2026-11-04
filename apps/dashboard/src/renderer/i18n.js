// Cue dashboard — interface translation.
//
// English is the source text. A catalog (locales/<locale>.js) maps English
// strings to the locale, either exactly ("Sign out") or as a template with
// placeholders ("{n} active sessions"). Two ways in:
//   * automatic: a MutationObserver translates every text node and the
//     placeholder / title / aria-label attributes the views render, so new
//     markup is covered without touching its code;
//   * Cue.t(text, vars) for text built from pieces in code (dates, plurals,
//     "in 3 days"), where no single DOM text equals a catalog entry.
// User content is never translated: transcripts, answers (.md), inputs and
// anything under [data-no-i18n] are skipped. Missing strings stay in English;
// `npm run i18n:check` lists them.
//
// The locale comes from the main process (ui_locale.js): config.ini
// [sistema] idioma_interface, or the Windows display language when "auto".
// Also loaded by Node (tests, scripts/i18n-check.mjs): the pure part is
// exported there.
'use strict';

(function (root) {
  const catalogs = {}; // locale -> { strings: Map, templates: [{ re, keys, out }] }
  const SKIP = 'script,style,textarea,pre,code,.md,[data-no-i18n],[contenteditable="true"]';
  const ATTRS = ['placeholder', 'title', 'aria-label'];

  // Placeholders with these names only match numbers ("{n} files", "{m} {d}"),
  // so a template made mostly of placeholders cannot swallow plain text.
  const NUMERIC = new Set(['n', 'd', 'total', 'used', 'limit']);

  function compileTemplate(src, out) {
    const keys = [];
    const pattern = src
      .split(/(\{[a-zA-Z0-9_]+\})/)
      .map((part) => {
        const m = /^\{([a-zA-Z0-9_]+)\}$/.exec(part);
        if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        keys.push(m[1]);
        return NUMERIC.has(m[1]) ? '(\\d[\\d.,]*)' : '(.+?)';
      })
      .join('');
    // Literal text first in the list: the longest wins when two match.
    const literal = src.replace(/\{[a-zA-Z0-9_]+\}/g, '').length;
    return { re: new RegExp(`^${pattern}$`), keys, out, literal };
  }

  function register(locale, catalog) {
    // `keep`: text that reads the same in the locale (brands, key names).
    const strings = new Map([...(catalog.keep || []).map((s) => [s, s]), ...Object.entries(catalog.strings || {})]);
    const templates = Object.entries(catalog.templates || {})
      .map(([src, out]) => compileTemplate(src, out))
      .sort((a, b) => b.literal - a.literal);
    // Code asks by the template's source text: Cue.t('In {n} days', { n }).
    const sources = new Map(Object.entries(catalog.templates || {}));
    catalogs[locale] = { strings, templates, sources, name: catalog.name || locale };
  }

  function fill(text, vars) {
    return String(text).replace(/\{([a-zA-Z0-9_]+)\}/g, (m, k) => (vars && vars[k] !== undefined ? String(vars[k]) : m));
  }

  // Translates one string (already trimmed). Returns null when the catalog
  // has nothing for it.
  function lookup(cat, text, depth = 0) {
    if (!cat || !text) return null;
    const hit = cat.strings.get(text);
    if (hit !== undefined) return hit;
    if (depth > 3) return null;
    for (const t of cat.templates) {
      const m = t.re.exec(text);
      if (!m) continue;
      const vars = {};
      t.keys.forEach((k, i) => {
        const v = m[i + 1];
        // A captured part may itself be translatable ("{plan} plan",
        // "{a} · {b}"); names, numbers and dates stay as they are.
        const inner = /[A-Za-z]/.test(v) ? lookup(cat, v, depth + 1) : null;
        vars[k] = inner !== null ? inner : v;
      });
      return fill(t.out, vars);
    }
    return null;
  }

  // Keeps the whitespace around the text (it often sits between tags).
  function translateText(cat, value) {
    const s = String(value);
    const trimmed = s.trim();
    if (!trimmed || !/[A-Za-z]/.test(trimmed)) return null;
    const out = lookup(cat, trimmed);
    if (out === null || out === trimmed) return null;
    const lead = s.slice(0, s.indexOf(trimmed));
    const tail = s.slice(s.indexOf(trimmed) + trimmed.length);
    return lead + out + tail;
  }

  const I18n = {
    locale: 'en',
    register,
    catalogs,
    compileTemplate,
    lookup,
    translateText,
    fill,
    // Code-level translation: Cue.t('In {n} days', { n: 3 }).
    t(text, vars) {
      const cat = catalogs[I18n.locale];
      const hit = cat ? cat.strings.get(text) ?? cat.sources.get(text) ?? lookup(cat, text) : null;
      return fill(hit !== null && hit !== undefined ? hit : text, vars);
    },
    has(locale) {
      return locale === 'en' || Boolean(catalogs[locale]);
    },
    names() {
      return Object.fromEntries(Object.entries(catalogs).map(([k, v]) => [k, v.name]));
    }
  };

  // ------------------------------------------------------------- DOM part --
  function skipped(el) {
    return Boolean(el && el.closest && el.closest(SKIP));
  }

  function translateNode(node, cat) {
    if (node.nodeType === 3) {
      if (skipped(node.parentElement)) return;
      const out = translateText(cat, node.nodeValue);
      if (out !== null) node.nodeValue = out;
      return;
    }
    if (node.nodeType === 1 && node.matches('textarea') && !node.closest('[data-no-i18n]')) translateAttrs(node, cat);
    if (node.nodeType !== 1 || skipped(node)) return;
    translateAttrs(node, cat);
    const doc = node.ownerDocument;
    const walker = doc.createTreeWalker(node, 1 | 4, {
      acceptNode: (n) => {
        if (n.nodeType !== 1 || !n.matches(SKIP)) return 1;
        if (n.matches('textarea') && !n.matches('[data-no-i18n]')) translateAttrs(n, cat); // its placeholder is interface text
        return 2; // REJECT subtree
      }
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 3) {
        const out = translateText(cat, n.nodeValue);
        if (out !== null) n.nodeValue = out;
      } else {
        translateAttrs(n, cat);
      }
    }
  }

  function translateAttrs(el, cat) {
    for (const a of ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (!v) continue;
      const out = translateText(cat, v);
      if (out !== null) el.setAttribute(a, out);
    }
  }

  let observer = null;
  function translateDocument(doc) {
    const cat = catalogs[I18n.locale];
    if (!cat) return;
    translateNode(doc.body, cat);
    const title = translateText(cat, doc.title);
    if (title !== null) doc.title = title;
  }

  // Starts translating the page (and everything rendered later). English
  // stops the observer; the next render then shows the source text again.
  I18n.apply = function apply(locale, doc) {
    I18n.locale = I18n.has(locale) ? locale : 'en';
    if (!doc) return I18n.locale;
    if (doc.documentElement) doc.documentElement.lang = I18n.locale;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (I18n.locale === 'en' || typeof MutationObserver === 'undefined') return I18n.locale;
    translateDocument(doc);
    observer = new MutationObserver((records) => {
      const cat = catalogs[I18n.locale];
      if (!cat) return;
      for (const r of records) {
        if (r.type === 'childList') r.addedNodes.forEach((n) => translateNode(n, cat));
        else if (r.type === 'characterData') translateNode(r.target, cat);
        else if (r.type === 'attributes') translateAttrs(r.target, cat);
      }
    });
    observer.observe(doc.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    return I18n.locale;
  };

  root.CueI18n = I18n;
  if (typeof module !== 'undefined' && module.exports) module.exports = I18n;
})(typeof window !== 'undefined' ? window : globalThis);
