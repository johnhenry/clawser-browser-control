// test/_load-content.mjs — shared helper for loading content.js into a
// fresh, isolated VM context per test, with a minimal fake `window` and
// stubbed `chrome` API.
//
// content.js is a plain (non-module) content script, not an ES module —
// it can't be `import`ed directly, and it assumes a real DOM (`window`,
// `location`) that a vm context doesn't provide. Rather than refactor it
// (which would change what actually ships to the browser), this gives it
// a tiny fake `window` implementing just enough of the EventTarget +
// postMessage contract for the relay logic to run against the real,
// unmodified source.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_SRC = readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

const MARKER = '__clawser_ext__';

/**
 * @param {object} [chromeOverrides] - overrides for chrome.runtime
 *   (e.g. { sendMessage: async () => ({ result: 42 }) })
 * @param {object} [opts]
 * @param {Function} [opts.setTimeoutImpl] - replaces the sandbox's setTimeout
 *   entirely (content.js's only setTimeout use is the request-relay timeout
 *   race, so tests can substitute an immediate-fire version to exercise the
 *   timeout path without a real 35s wait — no interaction with the presence
 *   heartbeat, which uses setInterval, not setTimeout)
 * @param {boolean} [opts.hidden] - initial document.hidden value (default false)
 * @param {object} [opts.location] - overrides the sandbox's `location`
 *   (default `{ href: 'http://localhost/workspace' }` — inside content.js's
 *   own allowed origin scope, so existing relay tests don't need to know
 *   about the origin allowlist to keep working)
 * @returns {{postFromPage, popPosted, chrome, sandbox, stop, setHidden, liveIntervals}}
 */
export function loadContent(chromeOverrides = {}, opts = {}) {
  const pageListeners = []; // window.addEventListener('message', fn)
  const runtimeListeners = []; // chrome.runtime.onMessage.addListener(fn)
  const posted = []; // everything content.js has sent via window.postMessage

  const fakeWindow = {
    __clawser_ext_injected: false,
    addEventListener(type, fn) {
      if (type === 'message') pageListeners.push(fn);
    },
    postMessage(data) {
      posted.push(data);
    },
  };

  const visibilityListeners = []; // document.addEventListener('visibilitychange', fn)
  const fakeDocument = {
    hidden: opts.hidden ?? false,
    addEventListener(type, fn) {
      if (type === 'visibilitychange') visibilityListeners.push(fn);
    },
    removeEventListener(type, fn) {
      if (type !== 'visibilitychange') return;
      const idx = visibilityListeners.indexOf(fn);
      if (idx !== -1) visibilityListeners.splice(idx, 1);
    },
  };

  /** Simulate the tab being hidden or shown (document.visibilityState changing). */
  function setHidden(hidden) {
    fakeDocument.hidden = hidden;
    for (const fn of visibilityListeners) fn();
  }

  const defaultRuntime = {
    id: 'fake-extension-id',
    sendMessage: async () => ({}),
    onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
  };
  const chromeStub = { runtime: { ...defaultRuntime, ...(chromeOverrides.runtime || chromeOverrides) } };
  if (opts.storage) {
    chromeStub.storage = { local: { get: async (k) => { const o = {}; for (const key of [].concat(k)) if (key in opts.storage) o[key] = opts.storage[key]; return o; } } };
  }

  // content.js starts a 5s presence-heartbeat setInterval at load time that
  // it never exposes a handle to. Track every interval it creates here so
  // tests can clear them — otherwise each test leaves a live timer behind
  // and `node --test` never exits (the same "leaked interval" hang pattern
  // as elsewhere in this project's test suites).
  const liveIntervals = new Set();
  const trackedSetInterval = (fn, ms) => {
    const id = setInterval(fn, ms);
    liveIntervals.add(id);
    return id;
  };
  const trackedClearInterval = (id) => {
    liveIntervals.delete(id);
    clearInterval(id);
  };

  const sandbox = {
    window: fakeWindow,
    document: fakeDocument,
    chrome: chromeStub,
    console,
    location: opts.location || { href: 'http://localhost/workspace', protocol: 'http:', hostname: 'localhost' },
    setTimeout: opts.setTimeoutImpl || setTimeout,
    clearTimeout,
    setInterval: trackedSetInterval,
    clearInterval: trackedClearInterval,
    Promise,
    URL,
  };
  vm.createContext(sandbox);
  vm.runInContext(CONTENT_SRC, sandbox, { filename: 'content.js' });

  /** Simulate the page (window.postMessage from the app side) sending content.js a message. */
  function postFromPage(data) {
    for (const fn of pageListeners) fn({ source: fakeWindow, data });
  }

  /** Simulate the page sending a message from some OTHER window (should be ignored). */
  function postFromOtherWindow(data) {
    for (const fn of pageListeners) fn({ source: {}, data });
  }

  /** Simulate the background service worker pushing a message down via chrome.runtime.onMessage. */
  function pushFromBackground(msg) {
    for (const fn of runtimeListeners) fn(msg);
  }

  /**
   * Simulate a request/response message from the background (e.g. a btask
   * request). Resolves with whatever the content script passes to sendResponse,
   * or undefined if its listener declined to handle it.
   */
  function requestFromBackground(msg, sender = { id: 'fake-extension-id' }) {
    return new Promise((resolve) => {
      let handled = false;
      for (const fn of runtimeListeners) {
        const r = fn(msg, sender, (v) => resolve(v));
        if (r === true) handled = true;
      }
      if (!handled) resolve(undefined);
    });
  }

  /** Pop and return everything posted to the page so far, clearing the log. */
  function popPosted() {
    const out = posted.slice();
    posted.length = 0;
    return out;
  }

  /** Clear the presence-heartbeat interval(s) content.js started at load. Call in every test's cleanup. */
  function stop() {
    for (const id of liveIntervals) clearInterval(id);
    liveIntervals.clear();
  }

  return { postFromPage, postFromOtherWindow, pushFromBackground, requestFromBackground, popPosted, stop, setHidden, liveIntervals, chrome: chromeStub, sandbox, MARKER };
}
