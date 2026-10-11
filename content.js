// content.js — Clawser Extension content script
// Injected into Clawser pages (localhost / 127.0.0.1 / file:/// / https://clawser.erisera.com,
// plus one optional user-configured https origin).
// Relays messages between the Clawser web app (postMessage) and the
// extension background service worker (chrome.runtime).

// Guard against double-injection (manifest inject + programmatic inject)
if (window.__clawser_ext_injected) { /* already running */ } else {
window.__clawser_ext_injected = true;

const MARKER = '__clawser_ext__';
const VERSION = '0.1.0';

console.log('[clawser-ext] content.js loaded on', location.href);

// ── Announce presence to the page ─────────────────────────────────

/** Check whether the extension runtime is still alive. */
function isRuntimeAlive() {
  // chrome.runtime.id becomes undefined when the extension is disabled/uninstalled
  return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
}

// Defense in depth: the manifest's content_scripts/web_accessible_resources
// match patterns already restrict where content.js and pod-inject.js get
// injected to localhost / 127.0.0.1 / file:// (Clawser's own app — see the
// file header comment above), but this relay is the actual boundary between
// an untrusted page and the extension's privileged background context. Check
// the origin here too, so that if the manifest match pattern is ever
// loosened again in the future (e.g. back to <all_urls>) without this check
// being revisited, arbitrary web pages still can't relay messages through to
// background.js.
//
// Allowed: localhost / 127.0.0.1 / file:// , the production Clawser origin,
// and one optional user-configured https origin (options page). The custom
// origin lives in chrome.storage.local and is re-validated here on every
// load: a corrupt or hostile stored value is treated as unset.
const DEFAULT_CLAWSER_ORIGIN = 'https://clawser.erisera.com';

// KEEP IN SYNC with normalizeClawserOrigin() in background.js (a test runs the
// same table through both).
function normalizeClawserOrigin(input) {
  const fail = (error) => ({ ok: false, error });
  if (typeof input !== 'string') return fail('not a string');
  const raw = input.trim();
  if (!raw || raw.length > 200) return fail('empty or too long');
  if (/[\s*<>"'\\^`{|}?#]/.test(raw)) return fail('illegal character');
  let u;
  try { u = new URL(raw); } catch { return fail('invalid URL'); }
  if (u.protocol !== 'https:') return fail('not https');
  if (u.username || u.password) return fail('credentials');
  if (u.pathname !== '/') return fail('path');
  const host = u.hostname;
  if (!host || host.endsWith('.') || !host.includes('.')) return fail('hostname');
  if (/^[\d.]+$/.test(host) || host.startsWith('[')) return fail('IP address');
  if (host === 'localhost' || host.endsWith('.localhost')) return fail('localhost');
  if (u.origin === DEFAULT_CLAWSER_ORIGIN) return fail('default origin');
  return { ok: true, origin: u.origin };
}

let customOrigin = null;
const originsReady = (async () => {
  try {
    const stored = await chrome.storage.local.get('clawserOrigin');
    const r = normalizeClawserOrigin(stored && stored.clawserOrigin);
    customOrigin = r.ok ? r.origin : null;
  } catch {
    customOrigin = null; // no storage access: only the built-in origins apply
  }
})();

function isAllowedOrigin() {
  try {
    const { protocol, hostname } = location;
    if (protocol === 'file:') return true;
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
    if (protocol !== 'https:') return false;
    const origin = location.origin;
    return origin === DEFAULT_CLAWSER_ORIGIN || (customOrigin !== null && origin === customOrigin);
  } catch {
    return false;
  }
}

/** Query the background for which Chrome APIs are actually available. */
async function queryCapabilities() {
  if (!isRuntimeAlive()) return null; // signal: extension gone
  try {
    const resp = await chrome.runtime.sendMessage({
      type: MARKER,
      action: 'get_available_capabilities',
      params: {},
    });
    return resp?.result || [];
  } catch {
    // sendMessage failed — runtime likely invalidated
    return null;
  }
}

/** Cached capabilities — refreshed each announce cycle. */
let _cachedCaps = null;

/** @returns {boolean} false if the extension is gone and we should stop */
async function announcePresence() {
  if (!_cachedCaps) {
    _cachedCaps = await queryCapabilities();
  }
  if (_cachedCaps === null) return false; // runtime dead — stop announcing
  window.postMessage({
    type: MARKER,
    direction: 'presence',
    action: 'present',
    version: VERSION,
    capabilities: _cachedCaps,
  }, '*');
  return true;
}

// Announce on load and periodically (handles SPA navigation).
// Refresh capabilities each cycle in case permissions changed.
// Stops itself when the extension runtime is invalidated.
//
// content.js only runs on Clawser origins, so the heartbeat runs even while the
// tab is hidden. That matters: a background tab opened by the scheduler is hidden
// from birth, and Clawser boots slowly, so the one initial announcement below
// fires before the page's ExtensionClient exists. Hidden tabs are throttled, which
// only makes the heartbeat slower; the page can also ask for presence (below).
let _presenceInterval = null;

function startPresenceHeartbeat() {
  if (_presenceInterval !== null) return;
  _presenceInterval = setInterval(async () => {
    _cachedCaps = await queryCapabilities();
    if (_cachedCaps === null) {
      // Extension was disabled/uninstalled — stop heartbeating
      stopPresenceHeartbeat();
      console.log('[clawser-ext] Runtime gone, stopped presence');
      return;
    }
    announcePresence();
  }, 5000);
}

function stopPresenceHeartbeat() {
  if (_presenceInterval === null) return;
  clearInterval(_presenceInterval);
  _presenceInterval = null;
}

announcePresence().then(() => console.log('[clawser-ext] Initial presence announced'));
startPresenceHeartbeat();

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) announcePresence();
});

// ── Page → Background relay ──────────────────────────────────────

// Upper bound on how long we'll wait for the background service worker to
// respond. Without this, a hung/crashed background leaves the page's
// caller awaiting forever — chrome.runtime.sendMessage's own promise only
// rejects if the message port actually closes, not if the receiving end
// simply never calls sendResponse.
const RELAY_TIMEOUT_MS = 35000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Extension did not respond within ${ms}ms`)), ms)),
  ]);
}

window.addEventListener('message', async (ev) => {
  if (ev.source !== window) return;
  const msg = ev.data;
  if (!msg || msg.type !== MARKER) return;

  // The custom origin loads asynchronously; hold the message until it has,
  // so a legitimate custom-origin page is not dropped and nothing else gets in.
  await originsReady;

  // Reject relaying anything into the extension's privileged background
  // context from a page outside the intended localhost/127.0.0.1/file://
  // scope — see isAllowedOrigin() above.
  if (!isAllowedOrigin()) return;

  // The page asks "is the extension there?" (its ExtensionClient is created long after
  // this script loaded, so it may have missed the announcements). Answer every query at
  // once; event-driven, so it works in a hidden, throttled tab. Our own 'present'
  // announcements come back through this listener and are ignored.
  if (msg.direction === 'presence') {
    if (msg.action === 'query') {
      _cachedCaps = await queryCapabilities();
      if (_cachedCaps !== null) announcePresence();
    }
    return;
  }

  // Answer to a btask request we pushed to the page (see below).
  if (msg.direction === 'btask_response') {
    settleBtask(msg);
    return;
  }

  // Fire-and-forget notifications from the page (e.g. "this workspace is
  // ready" or "here's the result of a routine you asked me to run") — no
  // response expected, so no id correlation needed.
  if (msg.direction === 'notify') {
    try {
      chrome.runtime.sendMessage(msg);
    } catch {
      // Runtime likely invalidated — nothing to relay to.
    }
    return;
  }

  if (msg.direction !== 'request') return;
  if (msg.id === undefined || msg.id === null) {
    console.warn('[clawser-ext] Ignoring request with no id — the page won\'t be able to correlate a response:', msg.action);
    return;
  }

  try {
    const response = await withTimeout(
      chrome.runtime.sendMessage({
        type: MARKER,
        id: msg.id,
        action: msg.action,
        params: msg.params,
      }),
      RELAY_TIMEOUT_MS,
    );

    window.postMessage({
      type: MARKER,
      direction: 'response',
      id: msg.id,
      result: response?.result ?? null,
      error: response?.error ?? null,
    }, '*');
  } catch (err) {
    window.postMessage({
      type: MARKER,
      direction: 'response',
      id: msg.id,
      result: null,
      error: err.message || 'Extension communication error',
    }, '*');
  }
});

// ── Background → Page: browser-task requests with a reply ───────────
// The side panel / context menus ask the Clawser page for its task list or
// hand it a draft. Only the three clawser.btask.* request types are relayed,
// only to an allowed-origin page, and only from this extension.
const BTASK_TYPES = ['clawser.btask.draft', 'clawser.btask.list', 'clawser.btask.inbox', 'clawser.btask.ping'];
const BTASK_DEFAULT_TIMEOUT_MS = 5000;
const BTASK_MAX_TIMEOUT_MS = 8000;
const btaskPending = new Map(); // id -> { respond, timer }
let btaskSeq = 0;

function settleBtask(msg) {
  const id = typeof msg.id === 'string' ? msg.id : null;
  const entry = id ? btaskPending.get(id) : null;
  if (!entry) return; // unknown, already answered or timed out
  btaskPending.delete(id);
  clearTimeout(entry.timer);
  if (msg.error) entry.respond({ error: String(msg.error).slice(0, 300) });
  else entry.respond({ result: msg.result === undefined ? null : msg.result });
}

async function handleBtaskRequest(msg, sendResponse) {
  await originsReady;
  if (!isAllowedOrigin()) { sendResponse({ transportError: 'origin_not_allowed' }); return; }
  const request = msg.request;
  if (!request || typeof request !== 'object' || !BTASK_TYPES.includes(request.type)) {
    sendResponse({ error: 'Unsupported browser-task request' });
    return;
  }
  const requested = Number(msg.timeoutMs);
  const timeoutMs = Number.isFinite(requested) && requested > 0 ? Math.min(requested, BTASK_MAX_TIMEOUT_MS) : BTASK_DEFAULT_TIMEOUT_MS;
  const id = 'bt' + (++btaskSeq) + '-' + Math.random().toString(36).slice(2, 10);
  const timer = setTimeout(() => {
    if (btaskPending.delete(id)) sendResponse({ transportError: 'no_response' });
  }, timeoutMs);
  btaskPending.set(id, { respond: sendResponse, timer });
  window.postMessage({ type: MARKER, direction: 'push', action: 'btask', id, request }, '*');
}

// ── Background → Page relay (extension-initiated pushes) ──────────
// The scheduler in background.js can ask this tab to run a due routine
// via a 'push' message — relay it down to the page unmodified.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === MARKER && msg.direction === 'btask_request') {
    if (sender && sender.id !== chrome.runtime.id) return false; // only our own background
    handleBtaskRequest(msg, sendResponse);
    return true; // async response
  }
  if (!msg || msg.type !== MARKER || msg.direction !== 'push') return false;
  window.postMessage(msg, '*');
  return false; // no response expected back through this channel
});

} // end double-injection guard
