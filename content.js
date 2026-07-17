// content.js — Clawser Extension content script
// Injected into Clawser pages (localhost / 127.0.0.1 / file:///).
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
// content.js matches <all_urls>, so this heartbeat would otherwise run on
// every page the user visits, forever, keeping the MV3 service worker warm
// globally even on tabs that will never host Clawser. Pause it while the
// tab is hidden (backgrounded/minimized) — the common case for most open
// tabs most of the time — and resume on visibility, rather than running
// unconditionally.
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
if (!document.hidden) startPresenceHeartbeat();

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPresenceHeartbeat();
  } else {
    announcePresence();
    startPresenceHeartbeat();
  }
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

// ── Background → Page relay (extension-initiated pushes) ──────────
// The scheduler in background.js can ask this tab to run a due routine
// via a 'push' message — relay it down to the page unmodified.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== MARKER || msg.direction !== 'push') return false;
  window.postMessage(msg, '*');
  return false; // no response expected back through this channel
});

} // end double-injection guard
