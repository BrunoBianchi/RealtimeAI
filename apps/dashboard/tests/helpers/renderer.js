// Test harness for the dashboard renderer. Loads the real renderer scripts
// (icons.js, app.js and the view files, in index.html order) into a Node vm
// context with a minimal window/document stub. Views are pure functions of
// Cue.state that return markup, so tests render them and assert on the HTML
// the user actually gets instead of grepping the source for old IDs.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RENDERER = path.resolve(__dirname, '..', '..', 'src', 'renderer');

function read(name) {
  return fs.readFileSync(path.join(RENDERER, name), 'utf8');
}

const indexHtml = read('index.html');
// Script order exactly as the page loads them.
const SCRIPTS = [...indexHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
const sources = Object.fromEntries(SCRIPTS.map((f) => [f, read(f)]));
const pageIds = new Set([...indexHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

// A detached element. innerHTML is kept as a plain string and lookups return
// further stubs (one per selector), so code that wires listeners or paints a
// part of a dialog after mounting works and its markup can be read back.
// fire(type) runs the listeners added to it, like a real event would.
function stubElement() {
  const kids = new Map();
  const listeners = {};
  const el = {
    __kids: kids,
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    className: '',
    dataset: {},
    style: {},
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [],
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener() {},
    async fire(type, ev = {}) {
      for (const fn of listeners[type] || []) {
        await fn({ target: el, key: '', preventDefault() {}, stopPropagation() {}, ...ev });
      }
    },
    appendChild() {},
    remove() {},
    querySelector(sel) {
      if (!kids.has(sel)) kids.set(sel, stubElement());
      return kids.get(sel);
    },
    querySelectorAll: () => [],
    focus() {},
    blur() {},
    scrollIntoView() {},
    setAttribute() {},
    getAttribute: () => null,
    closest: () => null
  };
  return el;
}

// Visible text of a markup string (tags removed, entities decoded).
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
function textOf(html) {
  return String(html).replace(/<[^>]+>/g, '').replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]);
}

// Markup of an element plus whatever was painted into its parts later.
function deepHtml(el) {
  return [el.innerHTML, ...[...el.__kids.values()].map(deepHtml)].join('\n');
}

// Every window.rtai call the renderer makes, recorded as [name, args].
// Unstubbed methods resolve to null, like a main process that has nothing.
function makeApi(overrides, calls) {
  return new Proxy(overrides, {
    get(target, key) {
      if (typeof key !== 'string') return undefined;
      const impl = key in target ? target[key] : () => Promise.resolve(null);
      return (...args) => {
        calls.push([key, args]);
        return impl(...args);
      };
    },
    has: () => true
  });
}

// Loads a fresh renderer.
//   api          overrides for window.rtai methods
//   state        merged into Cue.state after the scripts load
//   prefersLight answer of matchMedia('(prefers-color-scheme: light)')
// Returns:
//   Cue, S       window.Cue and Cue.state
//   calls        every window.rtai call as [name, args]; called(name) gives
//                the argument lists of one method as plain JSON values
//   modals       modals[i] / modals.last: markup of the dialogs mounted so far
//   dialogs      the mounted dialog elements (to fire events on their parts)
//   toasts()     the toasts shown so far as { text, error }
//   page(id)     the element with that id in index.html (null if none)
//   boot()       runs the DOMContentLoaded handlers (subscriptions, routing)
//   dispatch()   sends a document event to the delegated listeners
function loadRenderer({ api = {}, state = {}, prefersLight = false } = {}) {
  const calls = [];
  const layers = [];
  const modals = new Proxy(layers, {
    get: (t, k) => (/^\d+$/.test(String(k)) ? deepHtml(t[k]) : k === 'last' ? (t.length ? deepHtml(t[t.length - 1]) : '') : t[k])
  });
  const elements = new Map();
  const page = (id) => {
    if (!pageIds.has(id)) return null;
    if (!elements.has(id)) elements.set(id, stubElement());
    return elements.get(id);
  };
  page('modalRoot').appendChild = (layer) => layers.push(layer);
  const toasts = [];
  page('toasts').appendChild = (t) => toasts.push(t);

  const winListeners = {};
  const docListeners = {};
  const on = (bag) => (type, fn) => (bag[type] = bag[type] || []).push(fn);
  const document = {
    documentElement: { dataset: {}, style: {} },
    body: stubElement(),
    getElementById: page,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: on(docListeners),
    createElement: () => stubElement()
  };
  // Like a browser: assigning a new hash fires hashchange, replaceState does not.
  let hash = '';
  const location = {
    get hash() {
      return hash;
    },
    set hash(value) {
      const next = String(value).startsWith('#') ? String(value) : `#${value}`;
      if (next === hash) return;
      hash = next;
      (winListeners.hashchange || []).forEach((fn) => fn());
    }
  };
  const ctx = {
    console,
    TextDecoder,
    URL,
    document,
    location,
    history: {
      replaceState(_s, _t, url) {
        hash = url;
      },
      back() {}
    },
    navigator: {},
    matchMedia: () => ({ matches: Boolean(prefersLight), addEventListener() {} }),
    addEventListener: on(winListeners),
    removeEventListener() {},
    // Timers never fire: the renderer's clocks must not keep the test alive.
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    // getState defaults to the state the test set up, as if the main process
    // held the same data, so a refreshState() keeps it.
    rtai: makeApi({ getState: async () => ({ ...ctx.Cue.state }), ...api }, calls)
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of SCRIPTS) vm.runInContext(sources[f], ctx, { filename: f });
  const Cue = ctx.Cue;
  deepMerge(Cue.state, state);
  return {
    Cue,
    S: Cue.state,
    calls,
    // Plain copies: values built inside the vm have another realm's prototypes,
    // which assert.deepStrictEqual would reject.
    called: (name) => calls.filter(([n]) => n === name).map(([, args]) => JSON.parse(JSON.stringify(args))),
    modals,
    dialogs: layers,
    toasts: () => toasts.map((t) => ({ text: textOf(t.innerHTML), error: /\berror\b/.test(t.className) })),
    page,
    document,
    location,
    boot: () => Promise.all((winListeners.DOMContentLoaded || []).map((fn) => fn())),
    dispatch: (type, event) => (docListeners[type] || []).forEach((fn) => fn(event))
  };
}

function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') deepMerge(target[k], v);
    else target[k] = v;
  }
  return target;
}

// Renders a route ("settings/privacy", "session/<id>"...) the way the router
// does: Cue.state.route is set first because some views read it.
function render(Cue, route) {
  const parts = String(route || 'home').split('/').filter(Boolean);
  const view = parts.shift() || 'home';
  Cue.state.route = { view, parts };
  const fn = Cue.views[view];
  if (!fn) throw new Error(`no view "${view}"`);
  return fn(parts);
}

// A fake element for handlers that read el.dataset / el.checked / el.value.
function el(dataset = {}, props = {}) {
  return { dataset, checked: false, value: '', selectedOptions: [{ textContent: props.value || '' }], ...props };
}

// The attributes of every tag in `html` that matches `selector`-like filters:
// tags(html, { 'data-action': 'set-model' }) -> [{ 'data-action': ..., ... }].
function tags(html, filter = {}) {
  const out = [];
  for (const m of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const attrs = { tag: m[1].toLowerCase() };
    for (const a of m[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] === undefined ? true : a[2];
    if (Object.entries(filter).every(([k, v]) => (v === true ? k in attrs : attrs[k] === v))) out.push(attrs);
  }
  return out;
}

// Lets fire-and-forget async handlers (a click that starts a save) finish.
async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

module.exports = { RENDERER, indexHtml, pageIds, SCRIPTS, sources, read, loadRenderer, render, el, tags, settle, textOf };
