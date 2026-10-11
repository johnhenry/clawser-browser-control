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
 * @param {Map} [opts.idbStore] - an existing extension IndexedDB store, to simulate a service-worker restart
 * @param {object} [opts.storage] - initial chrome.storage.local contents (pass a previous instance's localStore for a restart)
 * @param {Function} [opts.setTimeoutImpl] - replaces the sandbox's setTimeout (e.g. to shrink retry delays)
 * @returns {{send: Function, notify: Function, fireAlarm: Function, chrome: object, sandbox: object}}
 */
/** An independent in-memory IndexedDB (one store, get/put) with real-transaction completion semantics. */
export function makeFakeIndexedDB(store = new Map()) {
  const indexedDB = {
    open() {
      const req = {};
      queueMicrotask(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          close() {},
          transaction: () => {
            // Completes once every request issued so far (including ones issued from
            // inside a success callback) has finished, like a real IDB transaction.
            let pending = 0; let completeFn = null; let completed = false;
            const maybeComplete = () => {
              if (pending === 0 && completeFn && !completed) { completed = true; queueMicrotask(() => completeFn()); }
            };
            return {
              objectStore: () => ({
                get: (key) => {
                  const r = {};
                  pending++;
                  queueMicrotask(() => { const v = store.get(key); r.result = v === undefined ? undefined : structuredClone(v); r.onsuccess?.(); pending--; maybeComplete(); });
                  return r;
                },
                put: (data, key) => { store.set(key, structuredClone(data)); },
              }),
              get oncomplete() { return completeFn; },
              set oncomplete(fn) { completeFn = fn; queueMicrotask(maybeComplete); },
            };
          },
        };
        req.onsuccess?.();
      });
      return req;
    },
  };
  return { indexedDB, store };
}

export function loadBackground(chromeOverrides = {}, opts = {}) {
  const hooks = { listener: null, alarmListener: null, installedListener: null, startupListener: null, menuListener: null };
  const menusCreated = []; // chrome.contextMenus.create() props, in order
  const registered = []; // chrome.scripting.registerContentScripts() entries currently registered
  const localStore = { ...(opts.storage || {}) }; // chrome.storage.local backing object
  const sessionStore = {}; // chrome.storage.session backing object
  const badge = { text: '', title: '' }; // chrome.action state
  const panelBehavior = []; // chrome.sidePanel.setPanelBehavior() args

  const defaultChrome = {
    runtime: {
      id: 'ext-id',
      getURL: (p = '') => `chrome-extension://ext-id/${p}`,
      onMessage: { addListener: (fn) => { hooks.listener = fn; } },
      onInstalled: { addListener: (fn) => { hooks.installedListener = fn; } },
      onStartup: { addListener: (fn) => { hooks.startupListener = fn; } },
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
      registerContentScripts: async (list) => { registered.push(...list); },
      unregisterContentScripts: async ({ ids } = {}) => {
        const before = registered.length;
        for (let i = registered.length - 1; i >= 0; i--) if (!ids || ids.includes(registered[i].id)) registered.splice(i, 1);
        if (ids && before === registered.length) throw new Error('Nonexistent script ID');
      },
      executeScript: async ({ func, args }) => [{ result: func ? func(...(args || [])) : null }],
    },
    webRequest: { onCompleted: { addListener: () => {} } },
    cookies: { getAll: async () => [] },
    contextMenus: {
      create: (props) => { menusCreated.push(props); return props.id; },
      removeAll: async () => { menusCreated.length = 0; },
      onClicked: { addListener: (fn) => { hooks.menuListener = fn; } },
    },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          for (const k of [].concat(keys ?? Object.keys(localStore))) if (k in localStore) out[k] = localStore[k];
          return out;
        },
        set: async (obj) => { Object.assign(localStore, obj); },
        remove: async (keys) => { for (const k of [].concat(keys)) delete localStore[k]; },
      },
      session: {
        get: async (k) => { const o = {}; for (const key of [].concat(k)) if (key in sessionStore) o[key] = sessionStore[key]; return o; },
        set: async (obj) => { Object.assign(sessionStore, obj); },
        remove: async (k) => { for (const key of [].concat(k)) delete sessionStore[key]; },
      },
    },
    action: {
      setBadgeText: async ({ text }) => { badge.text = text; },
      setTitle: async ({ title }) => { badge.title = title; },
    },
    sidePanel: { setPanelBehavior: async (b) => { panelBehavior.push(b); } },
    userScripts: undefined,
    offscreen: undefined,
  };

  const chromeStub = shallowMergeOneLevel(defaultChrome, chromeOverrides);

  // In-memory IndexedDB stub. The EXTENSION and the CLAWSER PAGE have separate IndexedDB
  // stores (different origins), so there are two independent fakes here:
  //   idbStore  - the extension's own store (what background.js reads and writes)
  //   pageIdb   - the clawser page's store (background.js can never see it)
  // A routine only gets from the page to the extension through a `routines_sync` notify
  // (see pageSync below). Seeding `idbStore` directly is a shortcut for tests of the
  // scheduler's own internals; anything about routines *reaching* the scheduler must go
  // through pageSync, or the very bug that hid in clawser#377 can hide again.
  const { indexedDB: fakeIndexedDB, store: idbStore } = makeFakeIndexedDB(opts.idbStore);
  const { store: pageIdb } = makeFakeIndexedDB();

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
    setTimeout: opts.setTimeoutImpl || setTimeout,
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

  /**
   * What clawser's extension routine bridge does: send the page's full routine list for a workspace
   * through the notify channel, from a tab on a clawser origin. This is the ONLY legitimate way
   * for routines to reach the extension.
   */
  function pageSync(routines, { wsId = 'ws1', url = 'https://clawser.erisera.com/#workspace/ws1', tabId = 5, tabUrl = url } = {}) {
    hooks.listener({ type: MARKER, direction: 'notify', action: 'routines_sync', wsId, url, routines }, { tab: { id: tabId, url: tabUrl } }, () => {});
    return new Promise((r) => setTimeout(r, 15));
  }

  /** Fire the scheduler alarm as chrome.alarms would. */
  function fireAlarm() {
    return hooks.alarmListener({ name: 'clawser-scheduler' });
  }

  /** Simulate a message from an extension page (side panel / options). */
  function sendUi(msg, sender = { id: 'ext-id', url: 'chrome-extension://ext-id/sidepanel.html' }) {
    return new Promise((resolve) => {
      const r = hooks.listener({ type: '__clawser_ext_ui__', ...msg }, sender, resolve);
      if (r !== true) resolve(undefined); // listener declined (no async response)
    });
  }

  /** Fire runtime.onInstalled. */
  function install() { return hooks.installedListener?.({ reason: 'install' }); }

  /** Simulate a context-menu click. */
  function clickMenu(info, tab) { return hooks.menuListener?.(info, tab); }

  return { sandbox, send, sendUi, install, clickMenu, notify, fireAlarm, chrome: chromeStub, idbStore, pageIdb, pageSync, menusCreated, registered, localStore, sessionStore, badge, panelBehavior, hooks };
}
