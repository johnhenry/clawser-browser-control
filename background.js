// background.js — Clawser Extension service worker
// Handles Chrome API calls, message routing, and userScripts execution.

const MARKER = '__clawser_ext__';
const VERSION = '0.1.0';

// ── State ─────────────────────────────────────────────────────────

/** @type {boolean} Whether chrome.userScripts is available */
let userScriptsAvailable = false;

/** @type {Map<number, Array<{level: string, message: string, timestamp: number}>>} */
const consoleBuffers = new Map();
const CONSOLE_BUFFER_MAX = 200;

/** @type {Map<number, Array<{url: string, method: string, statusCode: number, type: string, timestamp: number}>>} */
const networkBuffers = new Map();
const NETWORK_BUFFER_MAX = 200;

/** @type {Array<{timestamp: number, action: string, tabId: number|null, url: string|null, success: boolean, error: string|null}>} */
const auditLog = [];
const AUDIT_LOG_MAX = 500;

function recordAudit(entry) {
  auditLog.push(entry);
  if (auditLog.length > AUDIT_LOG_MAX) auditLog.splice(0, auditLog.length - AUDIT_LOG_MAX);
}

/** Cap on concurrent in-flight actions — a flood of requests from an
 * injected/malicious script queues past this rather than piling up
 * unbounded concurrent chrome.scripting.executeScript calls. */
const MAX_CONCURRENT_ACTIONS = 20;
let inFlightCount = 0;

// ── Init ──────────────────────────────────────────────────────────

async function init() {
  // Check userScripts availability
  try {
    if (chrome.userScripts) {
      // Must call getScripts or similar to verify the toggle is on
      await chrome.userScripts.getScripts();
      userScriptsAvailable = true;
    }
  } catch {
    userScriptsAvailable = false;
  }

  // Set up network request monitoring
  if (chrome.webRequest) {
    chrome.webRequest.onCompleted.addListener(
      (details) => {
        if (details.tabId < 0) return;
        if (!networkBuffers.has(details.tabId)) {
          networkBuffers.set(details.tabId, []);
        }
        const buf = networkBuffers.get(details.tabId);
        buf.push({
          url: details.url,
          method: details.method,
          statusCode: details.statusCode,
          type: details.type,
          timestamp: details.timeStamp,
        });
        if (buf.length > NETWORK_BUFFER_MAX) buf.splice(0, buf.length - NETWORK_BUFFER_MAX);
      },
      { urls: ['<all_urls>'] },
    );
  }

  // Clean up buffers when tabs close
  chrome.tabs.onRemoved.addListener((tabId) => {
    consoleBuffers.delete(tabId);
    networkBuffers.delete(tabId);
  });

  // Inject content.js into already-open matching tabs
  // (manifest content_scripts only inject on page load, not retroactively)
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.url) continue;
      const u = tab.url;
      if (u.startsWith('http://localhost') || u.startsWith('https://localhost')
          || u.startsWith('http://127.0.0.1') || u.startsWith('https://127.0.0.1')
          || u.startsWith('file://')) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js'],
        }).catch(() => {}); // ignore tabs where injection fails (e.g. chrome:// pages)
      }
    }
  } catch (e) {
    console.warn('[clawser-ext] Could not inject into existing tabs:', e);
  }

  console.log('[clawser-ext] Background initialized, userScripts:', userScriptsAvailable);
}

init();

// ── Message router ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== MARKER) return false;

  if (msg.direction === 'notify') {
    handleNotify(msg, sender);
    return false; // fire-and-forget, no response expected
  }

  if (inFlightCount >= MAX_CONCURRENT_ACTIONS) {
    console.warn(`[clawser-ext] Rejecting "${msg.action}" — ${inFlightCount} actions already in flight (limit ${MAX_CONCURRENT_ACTIONS})`);
    sendResponse({ error: `Too many concurrent requests (limit ${MAX_CONCURRENT_ACTIONS}) — try again shortly` });
    return true;
  }

  inFlightCount++;
  const startedAt = Date.now();
  const tabId = sender?.tab?.id ?? null;
  const tabUrl = sender?.tab?.url ?? null;

  handleAction(msg.action, msg.params || {})
    .then((result) => {
      recordAudit({ timestamp: startedAt, action: msg.action, tabId, url: tabUrl, success: true, error: null });
      sendResponse({ result });
    })
    .catch((err) => {
      const message = err.message || String(err);
      recordAudit({ timestamp: startedAt, action: msg.action, tabId, url: tabUrl, success: false, error: message });
      sendResponse({ error: message });
    })
    .finally(() => { inFlightCount--; });

  return true; // async sendResponse
});

/**
 * Route an action to the appropriate handler.
 * @param {string} action
 * @param {object} params
 * @returns {Promise<any>}
 */
async function handleAction(action, params) {
  switch (action) {
    // ── Status ──
    case 'status': return actionStatus(params);
    case 'capabilities': return actionCapabilities(params);
    case 'get_available_capabilities': return getAvailableCapabilities();

    // ── Tabs ──
    case 'tabs_list': return actionTabsList(params);
    case 'tab_open': return actionTabOpen(params);
    case 'tab_close': return actionTabClose(params);
    case 'tab_activate': return actionTabActivate(params);
    case 'tab_reload': return actionTabReload(params);

    // ── Navigation ──
    case 'navigate': return actionNavigate(params);
    case 'go_back': return actionGoBack(params);
    case 'go_forward': return actionGoForward(params);

    // ── Screenshots & Window ──
    case 'screenshot': return actionScreenshot(params);
    case 'resize': return actionResize(params);

    // ── DOM Reading (userScripts) ──
    case 'read_page': return actionReadPage(params);
    case 'find': return actionFind(params);
    case 'get_text': return actionGetText(params);
    case 'get_html': return actionGetHtml(params);

    // ── Input (userScripts) ──
    case 'click': return actionClick(params);
    case 'double_click': return actionDoubleClick(params);
    case 'triple_click': return actionTripleClick(params);
    case 'right_click': return actionRightClick(params);
    case 'hover': return actionHover(params);
    case 'drag': return actionDrag(params);
    case 'scroll': return actionScroll(params);
    case 'type': return actionType(params);
    case 'key': return actionKey(params);

    // ── Form ──
    case 'form_input': return actionFormInput(params);
    case 'select_option': return actionSelectOption(params);

    // ── Execution ──
    case 'evaluate': return actionEvaluate(params);
    case 'wait': return actionWait(params);
    case 'wait_cancel': return actionWaitCancel(params);

    // ── Monitoring ──
    case 'console': return actionConsole(params);
    case 'network': return actionNetwork(params);
    case 'audit_log': return actionAuditLog(params);

    // ── Cookies ──
    case 'cookies': return actionCookies(params);

    // ── WebMCP ──
    case 'webmcp_discover': return actionWebmcpDiscover(params);

    // ── CORS-free fetch ──
    case 'cors_fetch': return actionCorsFetch(params);

    // ── Tab Watch ──
    case 'tab_watch_start': return actionTabWatchStart(params);
    case 'tab_watch_poll': return actionTabWatchPoll(params);
    case 'tab_watch_stop': return actionTabWatchStop(params);

    // ── Pod Injection ──
    case 'inject_pod': return actionInjectPod(params);

    // ── GIF Recording ──
    case 'gif_record_start': return actionGifRecordStart(params);
    case 'gif_record_stop': return actionGifRecordStop(params);

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Execute a function in a target tab via chrome.scripting.executeScript.
 * Falls back from userScripts to scripting API.
 */
async function executeInTab(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
    world: 'MAIN',
  });
  if (!results || results.length === 0) return null;
  return results[0].result;
}

/**
 * Resolve a target tab ID — use provided tabId or fall back to active tab.
 */
async function resolveTabId(params) {
  if (params.tabId) return params.tabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found');
  return tab.id;
}

/** Max plausible viewport coordinate — guards against garbage x/y silently
 * resolving to whatever elementFromPoint(NaN, NaN) or similarly nonsensical
 * input happens to return. */
const MAX_COORD = 20000;

/** @returns {boolean} true if v is a finite, non-negative, in-bounds coordinate */
function isValidCoord(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_COORD;
}

/**
 * Validate an optional x/y coordinate pair. Both or neither must be given;
 * if given, both must be valid coordinates.
 * @throws {Error} if x/y are partially given or out of bounds
 */
function assertValidCoordPair(x, y, label = 'x/y') {
  const xGiven = x !== undefined;
  const yGiven = y !== undefined;
  if (!xGiven && !yGiven) return;
  if (xGiven !== yGiven || !isValidCoord(x) || !isValidCoord(y)) {
    throw new Error(`${label} must be given together as finite numbers in [0, ${MAX_COORD}]`);
  }
}

/**
 * Validate that at least one way of identifying a target element was
 * given, so "nothing specified" isn't silently indistinguishable from a
 * genuine "element not found" at runtime.
 * @throws {Error} if selector, text, and x/y are all absent
 */
function assertHasTarget({ selector, text, x, y }) {
  if (!selector && !text && x === undefined && y === undefined) {
    throw new Error('selector, text, or x/y is required');
  }
}

// ── Action handlers ───────────────────────────────────────────────

// -- Status --

/**
 * Return coarse capability names based on which Chrome APIs are available.
 * Used by content.js to announce real capabilities to the page.
 */
function getAvailableCapabilities() {
  const caps = [];
  if (typeof chrome !== 'undefined' && chrome.tabs) caps.push('tabs');
  if (typeof chrome !== 'undefined' && chrome.scripting) caps.push('scripting');
  if (typeof chrome !== 'undefined' && chrome.cookies) caps.push('cookies');
  if (typeof chrome !== 'undefined' && chrome.webRequest) caps.push('network');
  caps.push('cors_fetch');
  return caps;
}

async function actionStatus() {
  return {
    connected: true,
    version: VERSION,
    userScriptsAvailable,
    availableCapabilities: getAvailableCapabilities(),
    capabilities: actionCapabilities().capabilities,
  };
}

function actionCapabilities() {
  const caps = [
    { name: 'tabs', available: true },
    { name: 'navigate', available: true },
    { name: 'screenshot', available: true },
    { name: 'resize', available: true },
    { name: 'cookies', available: !!chrome.cookies },
    { name: 'network', available: !!chrome.webRequest },
    { name: 'dom', available: true, note: userScriptsAvailable ? 'userScripts (MAIN world)' : 'scripting (ISOLATED world, reduced)' },
    { name: 'input', available: true, note: userScriptsAvailable ? 'userScripts events' : 'scripting (limited)' },
    { name: 'evaluate', available: true },
    { name: 'console', available: true },
    { name: 'webmcp', available: true },
    { name: 'cors_fetch', available: true },
  ];
  return { capabilities: caps, userScriptsAvailable };
}

// -- Tabs --

async function actionTabsList() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({
    id: t.id,
    url: t.url,
    title: t.title,
    active: t.active,
    windowId: t.windowId,
    index: t.index,
    pinned: t.pinned,
    status: t.status,
  }));
}

async function actionTabOpen({ url }) {
  const tab = await chrome.tabs.create({ url: url || 'about:blank', active: true });
  return { id: tab.id, url: tab.url || tab.pendingUrl, title: tab.title };
}

async function actionTabClose({ tabId }) {
  const tid = await resolveTabId({ tabId });
  await chrome.tabs.remove(tid);
  return { closed: tid };
}

async function actionTabActivate({ tabId }) {
  const tid = await resolveTabId({ tabId });
  const tab = await chrome.tabs.update(tid, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return { activated: tid };
}

async function actionTabReload({ tabId }) {
  const tid = await resolveTabId({ tabId });
  await chrome.tabs.reload(tid);
  return { reloaded: tid };
}

// -- Navigation --

async function actionNavigate({ tabId, url }) {
  if (!url) throw new Error('url is required');
  const tid = await resolveTabId({ tabId });
  const tab = await chrome.tabs.update(tid, { url });
  return { tabId: tid, url: tab.url || tab.pendingUrl };
}

async function actionGoBack({ tabId }) {
  const tid = await resolveTabId({ tabId });
  await chrome.tabs.goBack(tid);
  return { tabId: tid, direction: 'back' };
}

async function actionGoForward({ tabId }) {
  const tid = await resolveTabId({ tabId });
  await chrome.tabs.goForward(tid);
  return { tabId: tid, direction: 'forward' };
}

// -- Screenshots & Window --

async function actionScreenshot({ tabId, format, quality }) {
  const tid = await resolveTabId({ tabId });
  // Ensure the tab's window is focused
  const tab = await chrome.tabs.get(tid);
  await chrome.tabs.update(tid, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });

  // Small delay for rendering
  await new Promise((r) => setTimeout(r, 100));

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: format || 'png',
    quality: quality || 80,
  });
  return { dataUrl, format: format || 'png' };
}

async function actionResize({ tabId, width, height }) {
  const tid = await resolveTabId({ tabId });
  const tab = await chrome.tabs.get(tid);
  const win = await chrome.windows.update(tab.windowId, {
    width: width || undefined,
    height: height || undefined,
  });
  return { windowId: win.id, width: win.width, height: win.height };
}

// -- DOM Reading --

async function actionReadPage({ tabId, maxDepth }) {
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (depth) => {
    /* eslint-disable no-undef */
    const ROLES = new Set([
      'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
      'listbox', 'menuitem', 'tab', 'switch', 'slider', 'spinbutton',
      'searchbox', 'option', 'menuitemcheckbox', 'menuitemradio',
      'treeitem', 'heading', 'img', 'navigation', 'main', 'banner',
      'contentinfo', 'complementary', 'form', 'region', 'alert', 'dialog',
    ]);
    const TAG_ROLES = {
      A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox',
      TEXTAREA: 'textbox', IMG: 'img', H1: 'heading', H2: 'heading',
      H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
      NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo',
      ASIDE: 'complementary', FORM: 'form', DIALOG: 'dialog',
    };
    const INPUT_ROLES = {
      checkbox: 'checkbox', radio: 'radio', range: 'slider',
      number: 'spinbutton', search: 'searchbox', submit: 'button',
      reset: 'button', button: 'button',
    };

    let refCounter = 0;
    const refMap = {};

    function getRole(el) {
      const explicit = el.getAttribute('role');
      if (explicit && ROLES.has(explicit)) return explicit;
      const tag = el.tagName;
      if (tag === 'INPUT') return INPUT_ROLES[el.type] || 'textbox';
      return TAG_ROLES[tag] || null;
    }

    function getName(el) {
      return el.getAttribute('aria-label')
        || el.getAttribute('alt')
        || el.getAttribute('title')
        || el.getAttribute('placeholder')
        || (el.labels?.[0]?.textContent?.trim())
        || el.textContent?.trim()?.slice(0, 80)
        || '';
    }

    function walk(node, currentDepth) {
      if (currentDepth > (depth || 12)) return null;
      if (node.nodeType !== 1) return null;

      const role = getRole(node);
      const isInteractive = node.matches?.(
        'a, button, input, select, textarea, [tabindex], [onclick], [role=button], [role=link], [contenteditable]'
      );

      const children = [];
      for (const child of node.children || []) {
        const c = walk(child, currentDepth + 1);
        if (c) children.push(c);
      }

      if (!role && !isInteractive && children.length === 0) return null;
      if (!role && children.length === 1) return children[0]; // collapse

      const ref = `ref_${++refCounter}`;
      const entry = { ref, role: role || node.tagName.toLowerCase() };
      refMap[ref] = node;

      const name = getName(node);
      if (name) entry.name = name;

      if (node.value !== undefined && node.value !== '') entry.value = String(node.value).slice(0, 200);
      if (node.disabled) entry.disabled = true;
      if (node.checked) entry.checked = true;
      if (node.tagName === 'A' && node.href) entry.href = node.href;

      if (children.length > 0) entry.children = children;
      return entry;
    }

    const tree = walk(document.body, 0);
    return { tree, refCount: refCounter };
    /* eslint-enable no-undef */
  }, [maxDepth || 12]);
}

async function actionFind({ tabId, query, selector }) {
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (q, sel) => {
    const results = [];
    let refCounter = 0;

    // By CSS selector
    if (sel) {
      try {
        const nodes = document.querySelectorAll(sel);
        for (const el of nodes) {
          if (results.length >= 20) break;
          results.push({
            ref: `ref_${++refCounter}`,
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || el.tagName.toLowerCase(),
            name: el.getAttribute('aria-label') || el.textContent?.trim()?.slice(0, 80) || '',
            id: el.id || undefined,
          });
        }
        return { results, total: nodes.length };
      } catch (e) {
        return { error: e.message, results: [] };
      }
    }

    // By text content (natural language)
    if (q) {
      const lower = q.toLowerCase();
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        if (results.length >= 20) break;
        const text = (el.textContent || '').trim();
        const label = el.getAttribute('aria-label') || '';
        const placeholder = el.getAttribute('placeholder') || '';
        const alt = el.getAttribute('alt') || '';
        const combined = `${text} ${label} ${placeholder} ${alt}`.toLowerCase();

        if (combined.includes(lower) && el.children.length < 5) {
          results.push({
            ref: `ref_${++refCounter}`,
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || el.tagName.toLowerCase(),
            name: text.slice(0, 80),
            id: el.id || undefined,
          });
        }
      }
      return { results, total: results.length };
    }

    return { results: [], total: 0 };
  }, [query, selector]);
}

async function actionGetText({ tabId }) {
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, () => {
    const article = document.querySelector('article') || document.querySelector('main');
    const source = article || document.body;
    return {
      title: document.title,
      url: location.href,
      text: source?.innerText?.trim()?.slice(0, 50000) || '',
    };
  });
}

/**
 * Return the outer HTML of an element. Precedence when multiple params
 * are given: `selector` wins, then `ref`, then the whole `<html>` element.
 */
async function actionGetHtml({ tabId, selector, ref }) {
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (sel) => {
    const el = sel ? document.querySelector(sel) : document.documentElement;
    if (!el) return { error: `Element not found: ${sel}` };
    return { html: el.outerHTML.slice(0, 50000) };
  }, [selector || ref || 'html']);
}

// -- Input Simulation --
//
// All coordinate-accepting actions below share the same text-based
// fallback semantics (search common interactive-element selectors, then
// fall back to any element for a plain-text match) and the same realistic
// event sequence (mousedown -> mouseup -> the semantic event), so callers
// get consistent behavior regardless of which action they use. The
// find-by-text snippet is duplicated per action rather than shared via a
// stringified-function/eval trick, so these actions don't newly depend on
// unsafe-eval-tolerant page CSPs (unlike actionEvaluate/actionWait, which
// already accept that trade-off deliberately for their own reasons).

async function actionClick({ tabId, selector, text, x, y }) {
  assertHasTarget({ selector, text, x, y });
  assertValidCoordPair(x, y);
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (sel, txt, cx, cy) => {
    let el;
    if (cx !== undefined && cy !== undefined) el = document.elementFromPoint(cx, cy);
    else if (sel) el = document.querySelector(sel);
    else if (txt) {
      const semantic = document.querySelectorAll('a, button, [role=button], [role=link], input[type=submit]');
      for (const e of semantic) { if (e.textContent?.trim()?.includes(txt)) { el = e; break; } }
      if (!el) for (const e of document.querySelectorAll('*')) {
        if (e.children.length < 3 && e.textContent?.trim()?.includes(txt)) { el = e; break; }
      }
    }
    if (!el) return { error: 'Element not found' };
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return { clicked: el.tagName, text: el.textContent?.trim()?.slice(0, 50) };
  }, [selector, text, x, y]);
}

async function actionDoubleClick({ tabId, selector, text, x, y }) {
  assertHasTarget({ selector, text, x, y });
  assertValidCoordPair(x, y);
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (sel, txt, cx, cy) => {
    let el;
    if (cx !== undefined && cy !== undefined) el = document.elementFromPoint(cx, cy);
    else if (sel) el = document.querySelector(sel);
    else if (txt) {
      const semantic = document.querySelectorAll('a, button, [role=button], [role=link], input[type=submit]');
      for (const e of semantic) { if (e.textContent?.trim()?.includes(txt)) { el = e; break; } }
      if (!el) for (const e of document.querySelectorAll('*')) {
        if (e.children.length < 3 && e.textContent?.trim()?.includes(txt)) { el = e; break; }
      }
    }
    if (!el) return { error: 'Element not found' };
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 2 }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, detail: 2 }));
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    return { doubleClicked: el.tagName };
  }, [selector, text, x, y]);
}

async function actionTripleClick({ tabId, selector, text, x, y }) {
  assertHasTarget({ selector, text, x, y });
  assertValidCoordPair(x, y);
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (sel, txt, cx, cy) => {
    let el;
    if (cx !== undefined && cy !== undefined) el = document.elementFromPoint(cx, cy);
    else if (sel) el = document.querySelector(sel);
    else if (txt) {
      const semantic = document.querySelectorAll('a, button, [role=button], [role=link], input[type=submit]');
      for (const e of semantic) { if (e.textContent?.trim()?.includes(txt)) { el = e; break; } }
      if (!el) for (const e of document.querySelectorAll('*')) {
        if (e.children.length < 3 && e.textContent?.trim()?.includes(txt)) { el = e; break; }
      }
    }
    if (!el) return { error: 'Element not found' };
    // Real triple-clicks fire three click events with an incrementing
    // `detail` (the UI Events click-count), each preceded by its own
    // mousedown/mouseup — not one click with detail=3.
    for (let i = 1; i <= 3; i++) {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: i }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, detail: i }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: i }));
    }
    return { tripleClicked: el.tagName };
  }, [selector, text, x, y]);
}

async function actionRightClick({ tabId, selector, text, x, y }) {
  assertHasTarget({ selector, text, x, y });
  assertValidCoordPair(x, y);
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (sel, txt, cx, cy) => {
    let el;
    if (cx !== undefined && cy !== undefined) el = document.elementFromPoint(cx, cy);
    else if (sel) el = document.querySelector(sel);
    else if (txt) {
      const semantic = document.querySelectorAll('a, button, [role=button], [role=link], input[type=submit]');
      for (const e of semantic) { if (e.textContent?.trim()?.includes(txt)) { el = e; break; } }
      if (!el) for (const e of document.querySelectorAll('*')) {
        if (e.children.length < 3 && e.textContent?.trim()?.includes(txt)) { el = e; break; }
      }
    }
    if (!el) return { error: 'Element not found' };
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 2 }));
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    return { rightClicked: el.tagName };
  }, [selector, text, x, y]);
}

async function actionHover({ tabId, selector, text, x, y }) {
  assertHasTarget({ selector, text, x, y });
  assertValidCoordPair(x, y);
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (sel, txt, cx, cy) => {
    let el;
    if (cx !== undefined && cy !== undefined) el = document.elementFromPoint(cx, cy);
    else if (sel) el = document.querySelector(sel);
    else if (txt) {
      const semantic = document.querySelectorAll('a, button, [role=button], [role=link], input[type=submit]');
      for (const e of semantic) { if (e.textContent?.trim()?.includes(txt)) { el = e; break; } }
      if (!el) for (const e of document.querySelectorAll('*')) {
        if (e.children.length < 3 && e.textContent?.trim()?.includes(txt)) { el = e; break; }
      }
    }
    if (!el) return { error: 'Element not found' };
    // Fire mouseout/mouseleave on whatever we last hovered, so a
    // sequence of hover calls behaves like real pointer movement rather
    // than leaving every previous target stuck in a ":hover"-like state.
    if (window.__clawserLastHovered && window.__clawserLastHovered !== el) {
      window.__clawserLastHovered.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      window.__clawserLastHovered.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    }
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    window.__clawserLastHovered = el;
    return { hovered: el.tagName };
  }, [selector, text, x, y]);
}

async function actionDrag({ tabId, startSelector, startX, startY, endX, endY }) {
  assertValidCoordPair(startX, startY, 'startX/startY');
  assertValidCoordPair(endX, endY, 'endX/endY');
  if (endX === undefined || endY === undefined) throw new Error('endX/endY are required');
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (sel, sx, sy, ex, ey) => {
    let el;
    if (sel) el = document.querySelector(sel);
    else if (sx !== undefined && sy !== undefined) el = document.elementFromPoint(sx, sy);
    if (!el) return { error: 'Element not found' };
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: sx || 0, clientY: sy || 0 }));
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ex, clientY: ey }));
    const dest = document.elementFromPoint(ex, ey);
    dest?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: ex, clientY: ey }));
    return { dragged: true, destination: dest?.tagName || null };
  }, [startSelector, startX, startY, endX, endY]);
}

async function actionScroll({ tabId, selector, direction, amount }) {
  const dir = (direction || 'down').toLowerCase();
  if (!['up', 'down', 'left', 'right'].includes(dir)) {
    throw new Error(`Invalid direction "${direction}" (expected up/down/left/right, case-insensitive)`);
  }
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (sel, normalizedDir, amt) => {
    const pixels = (amt || 3) * 100;
    const target = sel ? document.querySelector(sel) : window;
    if (!target) return { error: 'Scroll target not found' };
    const opts = { behavior: 'smooth' };
    switch (normalizedDir) {
      case 'up': opts.top = -pixels; break;
      case 'down': opts.top = pixels; break;
      case 'left': opts.left = -pixels; break;
      case 'right': opts.left = pixels; break;
    }
    (target === window ? window : target).scrollBy(opts);
    return { scrolled: normalizedDir, pixels };
  }, [selector, dir, amount]);
}

async function actionType({ tabId, selector, text, submit, append }) {
  if (typeof text !== 'string') throw new Error('text is required');
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (sel, txt, doSubmit, doAppend) => {
    const el = sel ? document.querySelector(sel) : document.activeElement;
    if (!el) return { error: 'Element not found' };
    if (el.disabled) return { error: 'Element is disabled' };
    el.focus();
    if (el.value !== undefined) {
      el.value = doAppend ? el.value + txt : txt;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = doAppend ? el.textContent + txt : txt;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      return { error: 'Element does not accept text input' };
    }
    if (doSubmit) {
      const form = el.closest('form');
      if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    return { typed: txt.length + ' chars', appended: !!doAppend, submitted: !!doSubmit };
  }, [selector, text, submit, !!append]);
}

async function actionKey({ tabId, key }) {
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (k) => {
    const parts = k.split('+');
    const keyName = parts.pop();
    const opts = {
      key: keyName, bubbles: true, cancelable: true,
      ctrlKey: parts.includes('ctrl') || parts.includes('Control'),
      shiftKey: parts.includes('shift') || parts.includes('Shift'),
      altKey: parts.includes('alt') || parts.includes('Alt'),
      metaKey: parts.includes('meta') || parts.includes('Meta') || parts.includes('cmd'),
    };
    const target = document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', opts));
    target.dispatchEvent(new KeyboardEvent('keypress', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));
    return { key: k };
  }, [key]);
}

// -- Form --

async function actionFormInput({ tabId, selector, value }) {
  if (!selector) throw new Error('selector is required');
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return { error: `Element not found: ${sel}` };
    const FORM_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
    if (!FORM_TAGS.has(el.tagName)) return { error: `Element is not a form control: ${el.tagName}` };
    if (el.disabled) return { error: 'Element is disabled' };
    if (el.type === 'checkbox' || el.type === 'radio') {
      el.checked = !!val;
    } else {
      el.value = val;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { set: sel, value: String(val).slice(0, 100) };
  }, [selector, value]);
}

async function actionSelectOption({ tabId, selector, value, text }) {
  if (!selector) throw new Error('selector is required');
  if (value === undefined && text === undefined) throw new Error('value or text is required');
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (sel, val, txt) => {
    const el = document.querySelector(sel);
    if (!el || el.tagName !== 'SELECT') return { error: 'Select element not found' };
    // value takes precedence over text if both are given, rather than
    // whichever matches first across the option list.
    const matches = (opt) => (val !== undefined ? opt.value === val : opt.textContent?.trim() === txt);
    for (const opt of el.options) {
      if (matches(opt)) {
        opt.selected = true;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { selected: opt.value, text: opt.textContent?.trim() };
      }
    }
    return { error: 'Option not found' };
  }, [selector, value, text]);
}

// -- Execution --

async function actionEvaluate({ tabId, script }) {
  if (!script) throw new Error('script is required');
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (code) => {
    try {
      const result = (0, eval)(code); // indirect eval — global scope
      if (result === undefined) return { result: 'undefined' };
      if (typeof result === 'function') return { result: '[Function]' };
      try { return { result: JSON.parse(JSON.stringify(result)) }; } catch {
        return { result: String(result) };
      }
    } catch (e) {
      return { error: e.message };
    }
  }, [script]);
}

async function actionWait({ tabId, selector, timeout, condition }) {
  if (!selector && !condition) throw new Error('selector or condition is required');
  const tid = await resolveTabId({ tabId });
  const ms = timeout || 10000;

  return executeInTab(tid, (sel, cond, timeoutMs) => {
    // Reset any stale cancellation flag from a previous wait on this page.
    window.__clawserWaitCancelled = false;

    return new Promise((resolve) => {
      const start = Date.now();
      let delay = 100;

      function check() {
        if (window.__clawserWaitCancelled) {
          window.__clawserWaitCancelled = false;
          return resolve({ found: false, cancelled: true, elapsed: Date.now() - start });
        }
        if (sel) {
          const el = document.querySelector(sel);
          if (el) return resolve({ found: true, elapsed: Date.now() - start });
        }
        if (cond) {
          try {
            if ((0, eval)(cond)) return resolve({ found: true, elapsed: Date.now() - start });
          } catch (e) {
            // A condition that throws will never succeed — surface the
            // error immediately instead of silently retrying every
            // interval until the overall timeout expires.
            return resolve({ found: false, error: `condition threw: ${e.message}`, elapsed: Date.now() - start });
          }
        }
        if (Date.now() - start > timeoutMs) {
          return resolve({ found: false, timeout: true, elapsed: Date.now() - start });
        }
        delay = Math.min(delay * 1.2, 500); // light backoff, capped at 500ms
        setTimeout(check, delay);
      }
      check();
    });
  }, [selector, condition, ms]);
}

/** Cancel an in-progress `wait` action on the given tab, if any. */
async function actionWaitCancel({ tabId } = {}) {
  const tid = await resolveTabId({ tabId });
  await executeInTab(tid, () => { window.__clawserWaitCancelled = true; });
  return { tabId: tid, cancelled: true };
}

// -- Monitoring --

async function actionConsole({ tabId, clear }) {
  const tid = await resolveTabId({ tabId });

  // Inject console interceptor if not already done
  await executeInTab(tid, () => {
    if (window.__clawser_console_hooked) return;
    window.__clawser_console_hooked = true;
    window.__clawser_console_buffer = [];

    for (const level of ['log', 'warn', 'error', 'info', 'debug']) {
      const orig = console[level].bind(console);
      console[level] = (...args) => {
        orig(...args);
        const buf = window.__clawser_console_buffer;
        buf.push({
          level,
          message: args.map((a) => {
            try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
            catch { return String(a); }
          }).join(' '),
          timestamp: Date.now(),
        });
        if (buf.length > 200) buf.splice(0, buf.length - 200);
      };
    }
  });

  // Read buffer
  const entries = await executeInTab(tid, (doClear) => {
    const buf = window.__clawser_console_buffer || [];
    const copy = [...buf];
    if (doClear) buf.length = 0;
    return copy;
  }, [!!clear]);

  return { entries: entries || [] };
}

async function actionNetwork({ tabId, urlPattern, clear }) {
  const tid = await resolveTabId({ tabId });
  let buf = networkBuffers.get(tid) || [];

  let entries = buf;
  if (urlPattern) {
    entries = buf.filter((e) => e.url.includes(urlPattern));
  }

  if (clear) {
    networkBuffers.set(tid, []);
  }

  return { entries };
}

/**
 * Read (and optionally clear) the audit log of actions this extension has
 * executed, including which tab/page requested each one.
 */
async function actionAuditLog({ clear } = {}) {
  const entries = [...auditLog];
  if (clear) auditLog.length = 0;
  return { entries };
}

// -- Cookies --

async function actionCookies({ url }) {
  if (!url) throw new Error('url is required');
  if (!chrome.cookies) throw new Error('cookies permission not available');
  const cookies = await chrome.cookies.getAll({ url });
  return {
    cookies: cookies.map((c) => ({
      name: c.name,
      value: c.value.slice(0, 200),
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      expirationDate: c.expirationDate,
    })),
  };
}

// -- CORS-free Fetch --

const SSRF_BLOCK_RE = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.|fc|fd|fe80|::ffff:|0x|0177)/i;
const SSRF_DECIMAL_RE = /^\d+$/;

function isBlockedHost(hostname) {
  return SSRF_BLOCK_RE.test(hostname) ||
    SSRF_DECIMAL_RE.test(hostname) ||
    hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

const CORS_FETCH_MAX_BODY = 2 * 1024 * 1024; // 2 MB

async function actionCorsFetch({ url, method = 'GET', headers = {}, body }) {
  if (!url) throw new Error('url is required');

  let parsed;
  try { parsed = new URL(url); } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  // SSRF check on request URL
  const hostname = parsed.hostname.toLowerCase();
  if (isBlockedHost(hostname) || parsed.protocol === 'file:') {
    throw new Error(`Blocked: fetching private/reserved address "${hostname}" is not allowed`);
  }

  const opts = { method, headers: headers || {}, redirect: 'follow' };
  if (body && method !== 'GET') opts.body = body;

  const resp = await fetch(url, opts);

  // Post-redirect SSRF check
  if (resp.redirected) {
    const finalHost = new URL(resp.url).hostname.toLowerCase();
    if (isBlockedHost(finalHost)) {
      throw new Error(`Redirect to private/reserved address blocked: ${finalHost}`);
    }
  }

  const text = await resp.text();
  const cappedBody = text.length > CORS_FETCH_MAX_BODY
    ? text.slice(0, CORS_FETCH_MAX_BODY) + '\n... (truncated at 2MB)'
    : text;

  const respHeaders = {};
  resp.headers.forEach((v, k) => { respHeaders[k] = v; });

  return { status: resp.status, headers: respHeaders, body: cappedBody };
}

// -- WebMCP --

async function actionWebmcpDiscover({ tabId }) {
  const tid = await resolveTabId({ tabId });

  const pageResult = await executeInTab(tid, () => {
    const markers = [];

    // <meta name="webmcp" content="...">
    const metas = document.querySelectorAll('meta[name="webmcp"], meta[name="mcp"]');
    for (const m of metas) {
      markers.push({ type: 'meta', name: m.name, content: m.content });
    }

    // <link rel="mcp" href="...">
    const links = document.querySelectorAll('link[rel="mcp"]');
    for (const l of links) {
      markers.push({ type: 'link', rel: l.rel, href: l.href });
    }

    // navigator.modelContext
    if (typeof navigator !== 'undefined' && navigator.modelContext) {
      markers.push({ type: 'navigator.modelContext', value: JSON.stringify(navigator.modelContext) });
    }

    return { url: location.href, markers };
  });

  // Also check .well-known/mcp
  try {
    const tab = await chrome.tabs.get(tid);
    if (tab.url) {
      const origin = new URL(tab.url).origin;
      const resp = await fetch(`${origin}/.well-known/mcp`, { signal: AbortSignal.timeout(3000) });
      if (resp.ok) {
        const text = await resp.text();
        pageResult.wellKnown = { url: `${origin}/.well-known/mcp`, content: text.slice(0, 5000) };
      }
    }
  } catch {
    // .well-known not available — fine
  }

  return pageResult;
}

// ── Tab Watch ─────────────────────────────────────────────────────

/** @type {Set<number>} Tab IDs currently being watched */
const watchedTabs = new Set();

/**
 * Start watching a tab for new DOM nodes under a selector.
 * Injects a MutationObserver that buffers new text content.
 */
async function actionTabWatchStart({ tabId, selector, siteProfile }) {
  const tid = await resolveTabId({ tabId });

  // Resolve selector from site profile if provided
  const sel = selector || SITE_PROFILES[siteProfile]?.containerSelector;
  if (!sel) throw new Error('selector or valid siteProfile is required');

  const profile = siteProfile ? (SITE_PROFILES[siteProfile] || null) : null;
  const msgSelector = profile?.messageSelector || null;
  const senderSelector = profile?.senderSelector || null;

  await executeInTab(tid, (containerSel, msgSel, senderSel) => {
    // Clean up any existing watcher
    if (window.__clawserWatchObserver) {
      window.__clawserWatchObserver.disconnect();
    }
    window.__clawserWatchBuffer = [];
    window.__clawserWatchSeen = window.__clawserWatchSeen || new Set();

    const container = document.querySelector(containerSel);
    if (!container) {
      window.__clawserWatchBuffer.push({
        text: `[watch-error] Container not found: ${containerSel}`,
        sender: 'system',
        timestamp: Date.now(),
      });
      return { started: false, error: `Container not found: ${containerSel}` };
    }

    // Snapshot existing children so we only report NEW messages
    if (msgSel) {
      container.querySelectorAll(msgSel).forEach(el => {
        window.__clawserWatchSeen.add(el);
      });
    } else {
      for (const child of container.children) {
        window.__clawserWatchSeen.add(child);
      }
    }

    function extractMessage(node) {
      if (window.__clawserWatchSeen.has(node)) return null;
      window.__clawserWatchSeen.add(node);

      const text = node.textContent?.trim() || '';
      let sender = 'unknown';

      if (senderSel) {
        const senderEl = node.querySelector(senderSel);
        if (senderEl) sender = senderEl.textContent?.trim() || 'unknown';
      }

      if (!text) return null;
      return { text: text.slice(0, 2000), sender, timestamp: Date.now() };
    }

    window.__clawserWatchObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue; // Element nodes only

          if (msgSel) {
            // Site profile mode: check if the added node IS a message,
            // then check descendants. querySelectorAll only matches
            // descendants, so we check the node itself separately.
            if (node.matches?.(msgSel)) {
              const msg = extractMessage(node);
              if (msg) window.__clawserWatchBuffer.push(msg);
            }
            for (const target of node.querySelectorAll(msgSel)) {
              const msg = extractMessage(target);
              if (msg) window.__clawserWatchBuffer.push(msg);
            }
          } else {
            // Custom selector mode: the added node itself is the message
            const msg = extractMessage(node);
            if (msg) window.__clawserWatchBuffer.push(msg);
          }
        }
      }
      // Cap buffer
      if (window.__clawserWatchBuffer.length > 100) {
        window.__clawserWatchBuffer.splice(0, window.__clawserWatchBuffer.length - 100);
      }
    });

    window.__clawserWatchObserver.observe(container, { childList: true, subtree: !!msgSel });
    return { started: true };
  }, [sel, msgSelector, senderSelector]);

  watchedTabs.add(tid);
  return { tabId: tid, watching: true, selector: sel, siteProfile: siteProfile || null };
}

/**
 * Poll buffered messages from a watched tab.
 */
async function actionTabWatchPoll({ tabId }) {
  const tid = await resolveTabId({ tabId });

  const messages = await executeInTab(tid, () => {
    const buf = window.__clawserWatchBuffer || [];
    const copy = [...buf];
    buf.length = 0;
    return copy;
  });

  return { tabId: tid, messages: messages || [] };
}

/**
 * Stop watching a tab — disconnect observer and clean up.
 */
async function actionTabWatchStop({ tabId }) {
  const tid = await resolveTabId({ tabId });

  await executeInTab(tid, () => {
    if (window.__clawserWatchObserver) {
      window.__clawserWatchObserver.disconnect();
      window.__clawserWatchObserver = null;
    }
    window.__clawserWatchBuffer = [];
    window.__clawserWatchSeen = null;
  });

  watchedTabs.delete(tid);
  return { tabId: tid, watching: false };
}

/**
 * Site profile presets — DOM selectors for popular web apps.
 * NOTE: Duplicated in web/clawser-channel-tabwatch.js (which uses inputSelector/sendMethod
 * for outbound responses). Extension service workers can't import ES modules, so the
 * duplication is intentional. Keep both copies in sync when updating selectors.
 */
const SITE_PROFILES = {
  slack: {
    containerSelector: '[data-qa="slack_kit_list"]',
    messageSelector: '[data-qa="virtual-list-item"]',
    senderSelector: '[data-qa="message_sender_name"]',
    inputSelector: '[data-qa="message_input"] [contenteditable]',
    sendMethod: 'enter',
  },
  gmail: {
    containerSelector: 'table.F.cf.zt',
    messageSelector: 'tr.zA',
    senderSelector: '.yW .yP, .yW .zF',
    inputSelector: '.Am.Al.editable',
    sendMethod: 'ctrl+enter',
  },
  discord: {
    containerSelector: 'ol[data-list-id="chat-messages"]',
    messageSelector: 'li[id^="chat-messages-"]',
    senderSelector: 'h3 span[class*="username"]',
    inputSelector: 'div[role="textbox"]',
    sendMethod: 'enter',
  },
};

// Clean up watch state when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
  watchedTabs.delete(tabId);
});

// ── Background Scheduler (Tier 1: chrome.alarms) ──────────────────
//
// This tier detects which routines are due and delegates *actual*
// execution into a live Clawser tab — it cannot execute a routine's
// action itself (no ES module imports in an MV3 service worker, and no
// access to the page's orchestrator/gateway/agent objects even if it
// could). See web/clawser-extension-routine-bridge.js in the main repo
// for the page-side half of this handoff.
//
// Tab tracking: the page announces itself via a 'workspace_ready'
// notify message (relayed by content.js) once its own agent has booted;
// we remember that tab's id/url. When a routine is due:
//   1. If the remembered tab is still open at the same URL, ask it to
//      run the routine (push message) and wait for a 'routine_executed'
//      notify back.
//   2. Otherwise, if we at least know the workspace's URL, open a new
//      background tab there, wait for its own 'workspace_ready', then
//      do the same handoff — and close the tab we opened once done.
//   3. If we've never seen a live workspace at all, log that execution
//      was skipped rather than pretending it succeeded.

const SCHEDULER_ALARM_NAME = 'clawser-scheduler';
const ROUTINE_EXEC_TIMEOUT_MS = 30000;
const TAB_OPEN_WAIT_MS = 20000;

/** @type {{tabId: number, url: string, wsId: string|null, lastSeen: number}|null} */
let lastKnownWorkspaceTab = null;

/** @type {Map<string, {resolve: Function, timer: ReturnType<typeof setTimeout>}>} routineId -> pending execution */
const pendingRoutineExecutions = new Map();

/** @type {Map<number, Function>} tabId -> resolve fn, for tabs we're waiting on to report ready */
const pendingReadyWaiters = new Map();

// Set up the alarm on extension install/update
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SCHEDULER_ALARM_NAME, { periodInMinutes: 1 });
});

// Also ensure alarm exists on startup
chrome.runtime.onStartup?.addListener(() => {
  chrome.alarms.create(SCHEDULER_ALARM_NAME, { periodInMinutes: 1 });
});

/**
 * Handle a fire-and-forget 'notify' message from a page (relayed by
 * content.js) — workspace-ready announcements and routine-execution
 * results, as opposed to the request/response RPC actions above.
 */
function handleNotify(msg, sender) {
  const tabId = sender?.tab?.id;
  const tabUrl = sender?.tab?.url;

  if (msg.action === 'workspace_ready') {
    if (tabId !== undefined && tabUrl) {
      lastKnownWorkspaceTab = { tabId, url: tabUrl, wsId: msg.wsId || null, lastSeen: Date.now() };
      const waiter = pendingReadyWaiters.get(tabId);
      if (waiter) { pendingReadyWaiters.delete(tabId); waiter(); }
    }
  } else if (msg.action === 'routine_executed') {
    const pending = pendingRoutineExecutions.get(msg.routineId);
    if (pending) {
      pendingRoutineExecutions.delete(msg.routineId);
      clearTimeout(pending.timer);
      pending.resolve({ success: !!msg.success, error: msg.error || null });
    }
  }
}

/** Ask a specific tab to run a routine now, and wait for its result. */
function requestRoutineExecution(tabId, routineId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRoutineExecutions.delete(routineId);
      resolve({ success: false, error: 'Timed out waiting for tab to execute routine' });
    }, ROUTINE_EXEC_TIMEOUT_MS);
    pendingRoutineExecutions.set(routineId, { resolve, timer });
    chrome.tabs.sendMessage(tabId, { type: MARKER, direction: 'push', action: 'execute_routine', routineId })
      .catch((e) => {
        clearTimeout(timer);
        pendingRoutineExecutions.delete(routineId);
        resolve({ success: false, error: `Could not reach tab: ${e.message}` });
      });
  });
}

/**
 * Execute a due routine by delegating to a live Clawser tab — the
 * currently-known one if still open at the same URL, or a freshly
 * opened one at the last-known workspace URL otherwise. Never throws;
 * returns a description of what happened, including honest failure
 * when no workspace has ever been seen.
 * @returns {Promise<{success: boolean, error: string|null}>}
 */
async function delegateRoutineExecution(routineId) {
  if (lastKnownWorkspaceTab) {
    try {
      const tab = await chrome.tabs.get(lastKnownWorkspaceTab.tabId);
      if (tab && tab.url === lastKnownWorkspaceTab.url) {
        return await requestRoutineExecution(lastKnownWorkspaceTab.tabId, routineId);
      }
    } catch {
      // Tab no longer exists — fall through to (re)opening one below.
    }
  }

  if (!lastKnownWorkspaceTab?.url) {
    return { success: false, error: 'No known Clawser tab to execute this routine on (no live workspace has ever connected)' };
  }

  let openedTab;
  try {
    openedTab = await chrome.tabs.create({ url: lastKnownWorkspaceTab.url, active: false });
  } catch (e) {
    return { success: false, error: `Could not open a tab to run this routine: ${e.message}` };
  }

  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => { pendingReadyWaiters.delete(openedTab.id); resolve(false); }, TAB_OPEN_WAIT_MS);
    pendingReadyWaiters.set(openedTab.id, () => { clearTimeout(timer); resolve(true); });
  });

  const result = ready
    ? await requestRoutineExecution(openedTab.id, routineId)
    : { success: false, error: 'Opened a tab but it did not report ready in time' };

  try { await chrome.tabs.remove(openedTab.id); } catch { /* best-effort cleanup */ }
  return result;
}

// Cron field-range validation, ported from web/clawser-background-runner.js's
// validateCronExpression() (can't import it — no ES modules in an MV3
// service worker). Without this, a malformed expression silently never
// matches, indistinguishable from "not due yet".
const CRON_FIELD_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

function validateCronFieldRange(pattern, min, max) {
  if (pattern === '*') return true;
  if (pattern.startsWith('*/')) {
    const step = parseInt(pattern.slice(2), 10);
    return step > 0;
  }
  for (const v of pattern.split(',')) {
    if (v.includes('-')) {
      const [a, b] = v.split('-').map(Number);
      if (Number.isNaN(a) || Number.isNaN(b) || a > b || a < min || b > max) return false;
    } else {
      const n = parseInt(v, 10);
      if (Number.isNaN(n) || n < min || n > max) return false;
    }
  }
  return true;
}

function validateCronExpressionInline(expr) {
  if (typeof expr !== 'string' || !expr.trim()) return false;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p, i) => validateCronFieldRange(p, CRON_FIELD_RANGES[i][0], CRON_FIELD_RANGES[i][1]));
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SCHEDULER_ALARM_NAME) return;

  try {
    const DB_NAME = 'clawser_checkpoints';
    const STORE = 'checkpoints';
    const ROUTINE_KEY = 'background_routine_state';
    const LOG_KEY = 'background_execution_log';

    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const read = (key) => new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });

    const write = (key, data) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(data, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });

    const routines = await read(ROUTINE_KEY);
    if (!Array.isArray(routines) || routines.length === 0) {
      db.close();
      return;
    }

    const now = Date.now();
    const nowDate = new Date(now);
    const results = [];

    function cronFieldMatches(pattern, value) {
      if (pattern === '*') return true;
      if (pattern.startsWith('*/')) {
        const step = parseInt(pattern.slice(2));
        return step > 0 && value % step === 0;
      }
      for (const v of pattern.split(',')) {
        if (v.includes('-')) {
          const [a, b] = v.split('-').map(Number);
          if (value >= a && value <= b) return true;
        } else if (parseInt(v) === value) return true;
      }
      return false;
    }
    function cronMatches(expr, date) {
      const parts = expr.trim().split(/\s+/);
      const fields = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];
      for (let i = 0; i < 5; i++) {
        if (!cronFieldMatches(parts[i], fields[i])) return false;
      }
      return true;
    }

    // Determine due routines first (sync), then execute them one at a
    // time (async, potentially slow if a tab needs to be opened) so we
    // don't race concurrent IDB writes against ourselves.
    const due = [];
    for (const r of routines) {
      if (!r.enabled) continue;

      if (r.trigger?.type === 'cron' && r.trigger?.cron) {
        if (!validateCronExpressionInline(r.trigger.cron)) {
          console.warn(`[clawser-ext] Routine "${r.name || r.id}" has an invalid cron expression and will never fire: "${r.trigger.cron}"`);
          continue;
        }
        const lastMinute = r.state?.lastCronMinute || 0;
        const thisMinute = Math.floor(now / 60000);
        if (thisMinute > lastMinute && cronMatches(r.trigger.cron, nowDate)) due.push(r);
        continue;
      }
      if (r.meta?.scheduleType === 'interval') {
        const lastFired = r.meta.lastFired || 0;
        if (now >= lastFired + (r.meta.intervalMs || 60000)) due.push(r);
        continue;
      }
      if (r.meta?.scheduleType === 'once' && !r.meta.fired && now >= (r.meta.fireAt || 0)) {
        due.push(r);
      }
    }

    for (const r of due) {
      const { success, error } = await delegateRoutineExecution(r.id);
      r.state = r.state || {};
      r.state.lastRun = Date.now();
      r.state.lastResult = success ? 'executed' : `skipped: ${error}`;
      r.state.runCount = (r.state.runCount || 0) + 1;
      if (r.trigger?.type === 'cron') r.state.lastCronMinute = Math.floor(now / 60000);
      if (r.meta?.scheduleType === 'interval') r.meta.lastFired = now;
      if (r.meta?.scheduleType === 'once') r.meta.fired = true;
      results.push({ routineId: r.id, success, error });
      if (!success) console.warn(`[clawser-ext] Routine "${r.name || r.id}" not executed: ${error}`);
    }

    if (results.length > 0) {
      await write(ROUTINE_KEY, routines);
      const log = (await read(LOG_KEY)) || [];
      log.push({ timestamp: now, results });
      while (log.length > 100) log.shift();
      await write(LOG_KEY, log);
    }

    db.close();
  } catch (err) {
    console.warn('[clawser] Background scheduler error:', err);
    try { db?.close(); } catch { /* best-effort */ }
  }
});

// ── GIF Recording ─────────────────────────────────────────────────
//
// Chrome hard-caps chrome.tabs.captureVisibleTab at ~2 calls/second
// (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND, unconditional, no
// permission raises it), so frames are captured on a ~2Hz interval —
// choppy for fast motion, fine for "click here, type this" interaction
// recordings. Frames are held in memory as data URLs until encoding, so
// recordings default to a short cap to bound memory use in a service
// worker that can be killed for excess memory/CPU.

/** @type {{tabId: number, windowId: number, frames: string[], maxFrames: number, delayCs: number, format: string, quality: number, timerId: ReturnType<typeof setInterval>}|null} */
let gifRecordingState = null;

async function actionGifRecordStart({ tabId, fps = 2, maxDurationSec = 15, format = 'jpeg', quality = 60 } = {}) {
  if (gifRecordingState) throw new Error('A GIF recording is already in progress');
  if (!(maxDurationSec > 0 && maxDurationSec <= 60)) throw new Error('maxDurationSec must be between 1 and 60');

  const tid = await resolveTabId({ tabId });
  const tab = await chrome.tabs.get(tid);
  await chrome.tabs.update(tid, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });

  const effectiveFps = Math.min(fps, 2); // Chrome's hard cap
  const intervalMs = Math.round(1000 / effectiveFps);
  const maxFrames = Math.max(1, Math.floor((maxDurationSec * 1000) / intervalMs));

  gifRecordingState = {
    tabId: tid,
    windowId: tab.windowId,
    frames: [],
    maxFrames,
    delayCs: Math.round(intervalMs / 10), // GIF frame delay is in 1/100s units
    format,
    quality,
    timerId: null,
  };

  gifRecordingState.timerId = setInterval(async () => {
    if (!gifRecordingState) return;
    if (gifRecordingState.frames.length >= gifRecordingState.maxFrames) {
      actionGifRecordStop().catch((e) => console.warn('[clawser-ext] GIF auto-stop failed:', e.message));
      return;
    }
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(gifRecordingState.windowId, {
        format: gifRecordingState.format,
        quality: gifRecordingState.quality,
      });
      gifRecordingState.frames.push(dataUrl);
    } catch {
      // A transient rate-limit/quota error just drops one frame — a
      // slightly choppier GIF beats aborting the whole recording.
    }
  }, intervalMs);

  return { recording: true, tabId: tid, fps: effectiveFps, maxDurationSec, maxFrames };
}

async function actionGifRecordStop() {
  if (!gifRecordingState) throw new Error('No GIF recording in progress');
  clearInterval(gifRecordingState.timerId);
  const { frames, delayCs } = gifRecordingState;
  gifRecordingState = null;

  if (frames.length === 0) return { dataUrl: null, format: 'gif', frameCount: 0 };

  const dataUrl = await encodeFramesToGif(frames, delayCs);
  return { dataUrl, format: 'gif', frameCount: frames.length };
}

/**
 * Encode captured frames into an animated GIF using the vendored gifenc
 * library. Chrome's MV3 service worker has no DOM/canvas to decode
 * frames or draw to, so encoding happens in a short-lived offscreen
 * document (chrome.offscreen — Chromium-only); Firefox's MV3 background
 * page keeps real DOM access, so it's done inline there instead. The
 * branch is feature-detected via chrome.offscreen's presence, not
 * browser-sniffed.
 */
async function encodeFramesToGif(frames, delayCs) {
  if (chrome.offscreen) {
    await ensureOffscreenDocument();
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: MARKER, target: 'offscreen', action: 'encode_gif', frames, delayCs });
    } finally {
      await chrome.offscreen.closeDocument().catch(() => {});
    }
    if (response?.error) throw new Error(response.error);
    return response.dataUrl;
  }

  const { GIFEncoder, quantize, applyPalette } = await import('./gifenc.js');
  const gif = GIFEncoder();
  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext('2d');
  for (const dataUrl of frames) {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    ctx.drawImage(bitmap, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, width, height, { palette, delay: delayCs });
  }
  gif.finish();
  const bytes = gif.bytes();
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return 'data:image/gif;base64,' + btoa(binary);
}

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing && existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DOM_SCRAPING'],
    justification: 'Decode captured screenshot frames and encode an animated GIF via canvas — unavailable in the service worker.',
  });
}

// ── Pod Injection ───────────────────────────────────────────────

/**
 * Inject a lightweight Pod into a target tab's MAIN world.
 * The pod-inject.js IIFE bootstraps an InjectedPod with BroadcastChannel
 * discovery and a visual overlay indicator.
 */
async function actionInjectPod({ tabId }) {
  if (!tabId) throw new Error('inject_pod requires tabId');
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['pod-inject.js'],
    world: 'MAIN',
  });
  return { ok: true, tabId };
}
