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
announcePresence().then(() => console.log('[clawser-ext] Initial presence announced'));
const _presenceInterval = setInterval(async () => {
  _cachedCaps = await queryCapabilities();
  if (_cachedCaps === null) {
    // Extension was disabled/uninstalled — stop heartbeating
    clearInterval(_presenceInterval);
    console.log('[clawser-ext] Runtime gone, stopped presence');
    return;
  }
  announcePresence();
}, 5000);

// ── Page → Background relay ──────────────────────────────────────
window.addEventListener('message', async (ev) => {
  if (ev.source !== window) return;
  const msg = ev.data;
  if (!msg || msg.type !== MARKER || msg.direction !== 'request') return;

  try {
    const response = await chrome.runtime.sendMessage({
      type: MARKER,
      id: msg.id,
      action: msg.action,
      params: msg.params,
    });

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

} // end double-injection guard
