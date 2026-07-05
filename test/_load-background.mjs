// test/_load-background.mjs — shared helper for loading background.js
// into a fresh, isolated VM context per test, with a stubbed chrome API.
//
// background.js is a plain (non-module) MV3 service worker script, not
// an ES module — it can't be `import`ed directly. Rather than refactor
// it into a module (which would mean changing the manifest's background
// config and could subtly change execution semantics), each test gets
// its own vm.createContext() sandbox with a stubbed `chrome` global and
// runs the real, unmodified source in it via vm.runInContext(). This
// exercises the actual production file, not a copy or a reimplementation.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKGROUND_SRC = readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

const MARKER = '__clawser_ext__';

function shallowMergeOneLevel(base, override) {
  const out = { ...base };
  for (const key of Object.keys(override || {})) {
    const b = base[key];
    const o = override[key];
    out[key] = (b && typeof b === 'object' && o && typeof o === 'object' && !Array.isArray(o))
      ? { ...b, ...o }
      : o;
  }
  return out;
}

/**
 * @param {object} [chromeOverrides] - per-namespace overrides, one level
 *   deep (e.g. { tabs: { get: async () => ... } } replaces just tabs.get)
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] - stub for the global fetch() used by
 *   actionCorsFetch/actionWebmcpDiscover — defaults to one that rejects,
 *   since most tests shouldn't make real network calls.
 * @returns {{send: Function, notify: Function, fireAlarm: Function, chrome: object, sandbox: object}}
 */
export function loadBackground(chromeOverrides = {}, opts = {}) {
  const hooks = { listener: null, alarmListener: null };

  const defaultChrome = {
    runtime: {
      onMessage: { addListener: (fn) => { hooks.listener = fn; } },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      sendMessage: async () => ({}),
      getContexts: async () => [],
    },
    alarms: {
      create: () => {},
      onAlarm: { addListener: (fn) => { hooks.alarmListener = fn; } },
    },
    tabs: {
      query: async () => [{ id: 1, url: 'https://example.com', active: true }],
      onRemoved: { addListener: () => {} },
      get: async (id) => ({ id, windowId: 1, url: 'https://example.com' }),
      update: async () => ({ id: 1, windowId: 1 }),
      create: async (opts) => ({ id: 999, url: opts.url, title: '' }),
      remove: async () => {},
      reload: async () => {},
      captureVisibleTab: async () => 'data:image/jpeg;base64,AAA',
      goBack: async () => {},
      goForward: async () => {},
      sendMessage: async () => {},
    },
    windows: { update: async () => ({ id: 1, width: 100, height: 100 }) },
    scripting: {
      executeScript: async ({ func, args }) => [{ result: func ? func(...(args || [])) : null }],
    },
    webRequest: { onCompleted: { addListener: () => {} } },
    cookies: { getAll: async () => [] },
    userScripts: undefined,
    offscreen: undefined,
  };

  const chromeStub = shallowMergeOneLevel(defaultChrome, chromeOverrides);

  // In-memory IndexedDB stub — real browsers have indexedDB, but a vm
  // context (a fresh Node realm, not a browser) doesn't. background.js's
  // scheduler is the only thing that touches it; `idbStore` is exposed
  // so tests can seed/read routine state directly.
  const idbStore = new Map();
  const fakeIndexedDB = {
    open() {
      const req = {};
      queueMicrotask(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          close() {},
          transaction: () => ({
            objectStore: () => ({
              get: (key) => {
                const r = {};
                queueMicrotask(() => { r.result = idbStore.get(key); r.onsuccess?.(); });
                return r;
              },
              put: (data, key) => { idbStore.set(key, data); },
            }),
            get oncomplete() { return this._oncomplete; },
            set oncomplete(fn) { this._oncomplete = fn; queueMicrotask(() => fn()); },
          }),
        };
        req.onsuccess?.();
      });
      return req;
    },
  };

  // A fresh vm context only gets true ECMAScript globals (Object, Array,
  // Promise, Date, Math, JSON, ...) — NEITHER the WHATWG globals Node adds
  // to its *main* realm (URL, fetch, TextEncoder, AbortSignal) NOR Node's
  // own timer functions (setTimeout/setInterval/...) are automatically
  // present; both must be passed through explicitly, or background.js's
  // (extensive) use of setTimeout/setInterval throws ReferenceErrors that
  // are easy to misdiagnose as logic bugs instead of a missing global.
  const fetchImpl = opts.fetchImpl || (async () => { throw new Error('fetch() was not stubbed for this test'); });
  const sandbox = {
    chrome: chromeStub,
    console,
    indexedDB: fakeIndexedDB,
    URL,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    AbortSignal,
  };
  vm.createContext(sandbox);
  vm.runInContext(BACKGROUND_SRC, sandbox, { filename: 'background.js' });

  /** Simulate a request/response RPC call, as content.js would relay it. */
  function send(action, params = {}, sender = { tab: { id: 1, url: 'https://example.com' } }) {
    return new Promise((resolve) => {
      hooks.listener({ type: MARKER, action, params }, sender, resolve);
    });
  }

  /** Simulate a fire-and-forget 'notify' message from a page. */
  function notify(action, extra = {}, sender = { tab: { id: 1, url: 'https://example.com' } }) {
    hooks.listener({ type: MARKER, direction: 'notify', action, ...extra }, sender, () => {});
  }

  /** Fire the scheduler alarm as chrome.alarms would. */
  function fireAlarm() {
    return hooks.alarmListener({ name: 'clawser-scheduler' });
  }

  return { sandbox, send, notify, fireAlarm, chrome: chromeStub, idbStore };
}
