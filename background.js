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
  await injectIntoOpenClawserTabs();

  console.log('[clawser-ext] Background initialized, userScripts:', userScriptsAvailable);
}

init();

// ── Message router ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Messages from our own extension pages (side panel, options). These use a
  // different `type` than the page relay, so a web page can never forge one:
  // content.js only ever builds MARKER-typed messages.
  if (msg && msg.type === UI_MARKER) {
    handleUiMessage(msg, sender).then(
      (result) => sendResponse({ result }),
      (err) => sendResponse({ error: err?.message || String(err) }),
    );
    return true;
  }
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
    case 'webmcp_list_tools': return actionWebmcpListTools(params);
    case 'webmcp_call_tool': return actionWebmcpCallTool(params);

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
    // chrome.scripting.executeScript rejects `undefined` in args ("Value is unserializable"),
    // and callers pass optional fields straight through (a click by selector has no text/x/y).
    // Send null; in-page functions test optional args with `!= null`, never `!== undefined`.
    args: args.map((a) => (a === undefined ? null : a)),
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
  // WebMCP tools exposed by other open tabs (document.modelContext), read and called on demand.
  if (typeof chrome !== 'undefined' && chrome.scripting && chrome.tabs) caps.push('webmcp_tabs');
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
    { name: 'webmcp_tabs', available: !!(chrome.scripting && chrome.tabs), note: 'list and call document.modelContext tools of other open tabs, on demand' },
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

async function actionTabOpen({ url, active }) {
  // Only an explicit `active: false` opens in the background (scheduled
  // browser-task checks); anything else keeps the default of a foreground tab.
  const tab = await chrome.tabs.create({ url: url || 'about:blank', active: active !== false });
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

async function actionGetText({ tabId, maxChars }) {
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (max) => {
    const article = document.querySelector('article') || document.querySelector('main');
    const source = article || document.body;
    const full = source?.innerText?.trim() || '';
    return {
      title: document.title,
      url: location.href,
      text: full.slice(0, max),
      truncated: full.length > max,
      length: full.length,
    };
  }, [clampMaxChars(maxChars)]);
}

/**
 * Return the outer HTML of an element. Precedence when multiple params
 * are given: `selector` wins, then `ref`, then the whole `<html>` element.
 * Optional: `strip: true` serializes a clone without script/style/noscript/
 * template/svg/iframe/link/meta elements and comments; `maxChars` caps the
 * returned length (default 50000, at most 2,000,000). The result carries
 * `truncated` and `length` (the full length before slicing).
 */
async function actionGetHtml({ tabId, selector, ref, strip, maxChars }) {
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (sel, doStrip, max) => {
    const el = sel ? document.querySelector(sel) : document.documentElement;
    if (!el) return { error: `Element not found: ${sel}` };
    let html;
    if (doStrip) {
      const clone = el.cloneNode(true);
      for (const n of Array.from(clone.querySelectorAll('script, style, noscript, template, svg, iframe, link, meta'))) n.remove();
      const walker = document.createTreeWalker(clone, 128 /* NodeFilter.SHOW_COMMENT */);
      const comments = [];
      for (let c = walker.nextNode(); c; c = walker.nextNode()) comments.push(c);
      for (const c of comments) c.remove();
      html = clone.outerHTML;
    } else {
      html = el.outerHTML;
    }
    return { html: html.slice(0, max), truncated: html.length > max, length: html.length };
  }, [selector || ref || 'html', strip === true, clampMaxChars(maxChars)]);
}

const DEFAULT_MAX_CHARS = 50000;
const MAX_MAX_CHARS = 2000000;

/** Valid positive number (or numeric string) -> floor, capped at 2,000,000; anything else -> 50000. */
function clampMaxChars(v) {
  const n = typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_CHARS;
  return Math.min(Math.floor(n), MAX_MAX_CHARS);
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
    if (cx != null && cy != null) el = document.elementFromPoint(cx, cy);
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
    if (cx != null && cy != null) el = document.elementFromPoint(cx, cy);
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
    if (cx != null && cy != null) el = document.elementFromPoint(cx, cy);
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
    if (cx != null && cy != null) el = document.elementFromPoint(cx, cy);
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
    if (cx != null && cy != null) el = document.elementFromPoint(cx, cy);
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
    else if (sx != null && sy != null) el = document.elementFromPoint(sx, sy);
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
    const matches = (opt) => (val != null ? opt.value === val : opt.textContent?.trim() === txt);
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

// -- WebMCP tools in other tabs --
//
// A page that implements WebMCP registers tools on `document.modelContext`.
// Nothing here runs on every page: a function is injected into the MAIN world of
// a tab only when Clawser asks to list or call that tab's tools, so the page's
// own `document.modelContext` (and not an isolated-world copy) is what is read.
// Everything the page returns is untrusted data and is clamped here.
//
// Reading shapes handled (Chrome's native API and the @mcp-b/global polyfill):
//   document.modelContext.getTools()                    -> RegisteredTool[]   (inputSchema: object | JSON string)
//   document.modelContext.executeTool(tool, jsonString) -> Promise<string|null>
//   navigator.modelContextTesting.listTools() / .executeTool(name, jsonString)   (older Chrome previews)

const WEBMCP_LIMITS = {
  maxTabs: 50,
  maxTools: 100,
  maxText: 2000,
  maxSchemaChars: 20000,
  maxArgsChars: 100000,
  maxResultChars: 100000,
  callTimeoutMs: 30000,
};

function isWebPage(url) {
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

/** Runs IN THE PAGE (serialized by executeScript): must not reference anything outside itself. */
async function pageListWebmcpTools(limits) {
  const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) : s);
  const toSchema = (s) => {
    let v = s;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
    if (!v || typeof v !== 'object') return { type: 'object', properties: {} };
    if (JSON.stringify(v).length > limits.maxSchemaChars) return { type: 'object', properties: {}, 'x-truncated': true };
    return v;
  };
  const mc = typeof document !== 'undefined' ? document.modelContext : undefined;
  const testing = typeof navigator !== 'undefined' ? navigator.modelContextTesting : undefined;
  let api = null;
  let raw = [];
  if (mc && typeof mc.getTools === 'function') {
    api = 'document.modelContext';
    raw = await mc.getTools();
  } else if (testing && typeof testing.listTools === 'function') {
    api = 'navigator.modelContextTesting';
    raw = testing.listTools();
  }
  if (!api) return { api: null, tools: [] };
  const tools = [];
  for (const t of Array.from(raw || []).slice(0, limits.maxTools)) {
    if (!t || typeof t.name !== 'string' || !t.name) continue;
    const tool = {
      name: clip(t.name, 128),
      title: clip(typeof t.title === 'string' ? t.title : '', 200),
      description: clip(typeof t.description === 'string' ? t.description : '', limits.maxText),
      inputSchema: toSchema(t.inputSchema),
    };
    // Only the cautious hint is forwarded: a page's claim that a tool is read-only is not evidence.
    if (t.annotations && t.annotations.destructiveHint === true) tool.annotations = { destructiveHint: true };
    tools.push(tool);
  }
  return { api, tools };
}

/** Runs IN THE PAGE. Returns { ok, text, truncated } or { ok: false, error }. */
async function pageCallWebmcpTool(name, argsJson, timeoutMs, maxChars) {
  const mc = typeof document !== 'undefined' ? document.modelContext : undefined;
  const testing = typeof navigator !== 'undefined' ? navigator.modelContextTesting : undefined;
  const run = async () => {
    if (mc && typeof mc.getTools === 'function') {
      const tool = (await mc.getTools()).find((t) => t && t.name === name);
      if (!tool) throw new Error('No WebMCP tool named "' + name + '" on this page');
      if (typeof mc.executeTool === 'function') return mc.executeTool(tool, argsJson);
      if (typeof tool.execute === 'function') return tool.execute(JSON.parse(argsJson));
      throw new Error('This page does not let its WebMCP tools be executed from outside');
    }
    if (testing && typeof testing.executeTool === 'function') return testing.executeTool(name, argsJson);
    throw new Error('This page exposes no WebMCP API');
  };
  let timer;
  try {
    const raw = await Promise.race([
      run(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('WebMCP tool timed out after ' + timeoutMs + ' ms')), timeoutMs); }),
    ]);
    let text = typeof raw === 'string' ? raw : JSON.stringify(raw === undefined ? null : raw);
    if (typeof text !== 'string') text = String(raw);
    const truncated = text.length > maxChars;
    return { ok: true, text: truncated ? text.slice(0, maxChars) : text, truncated };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * List the WebMCP tools of one tab (`tabId`) or of every open http(s) tab.
 * @returns {Promise<{ pages: Array<{ tabId: number, url: string, origin: string, title: string, api: string, tools: object[] }>, skipped: number }>}
 */
async function actionWebmcpListTools({ tabId } = {}) {
  let tabs;
  if (tabId !== undefined && tabId !== null) {
    const tab = await chrome.tabs.get(tabId);
    if (!isWebPage(tab.url)) throw new Error('WebMCP tools can only be read from http(s) pages');
    tabs = [tab];
  } else {
    tabs = (await chrome.tabs.query({})).filter((t) => t.id !== undefined && isWebPage(t.url)).slice(0, WEBMCP_LIMITS.maxTabs);
  }
  let skipped = 0;
  const pages = [];
  await Promise.all(tabs.map(async (tab) => {
    try {
      const found = await executeInTab(tab.id, pageListWebmcpTools, [WEBMCP_LIMITS]);
      if (found && found.api && found.tools.length) {
        pages.push({ tabId: tab.id, url: tab.url, origin: new URL(tab.url).origin, title: tab.title || '', api: found.api, tools: found.tools });
      }
    } catch {
      skipped++; // restricted page (chrome web store, devtools), discarded tab, or mid-navigation
    }
  }));
  pages.sort((a, b) => a.tabId - b.tabId);
  return { pages, skipped };
}

/**
 * Call one WebMCP tool in one tab. `expectedOrigin` is required: the caller listed
 * the tool on that origin, and a tab that has since navigated elsewhere must not
 * receive the call.
 */
async function actionWebmcpCallTool({ tabId, name, arguments: args, expectedOrigin, timeoutMs } = {}) {
  if (tabId === undefined || tabId === null) throw new Error('tabId is required');
  if (typeof name !== 'string' || !name) throw new Error('name is required');
  if (typeof expectedOrigin !== 'string' || !expectedOrigin) throw new Error('expectedOrigin is required');
  const argsJson = JSON.stringify(args === undefined ? {} : args);
  if (argsJson.length > WEBMCP_LIMITS.maxArgsChars) throw new Error('arguments are too large');
  const budget = Math.min(Math.max(Number(timeoutMs) || WEBMCP_LIMITS.callTimeoutMs, 1000), WEBMCP_LIMITS.callTimeoutMs);

  const startedAt = Date.now();
  const tab = await chrome.tabs.get(tabId);
  let origin = null;
  let outcome = { success: false, error: null };
  try {
    if (!isWebPage(tab.url)) throw new Error('WebMCP tools can only be called on http(s) pages');
    origin = new URL(tab.url).origin;
    if (origin !== expectedOrigin) throw new Error(`Tab ${tabId} is now on ${origin}, not ${expectedOrigin}; list its tools again`);
    const res = await executeInTab(tabId, pageCallWebmcpTool, [name, argsJson, budget, WEBMCP_LIMITS.maxResultChars]);
    if (!res) throw new Error('The page did not answer');
    if (!res.ok) throw new Error(res.error);
    outcome = { success: true, error: null };
    return { tabId, origin, name, text: res.text, truncated: res.truncated };
  } catch (e) {
    outcome = { success: false, error: e.message || String(e) };
    throw e;
  } finally {
    // The router's own entry says who asked; this one says which tool ran, on which origin.
    // Arguments and results are never logged.
    recordAudit({ timestamp: startedAt, action: 'webmcp_call_tool', tabId, url: origin || tab.url || null, tool: name, success: outcome.success, error: outcome.error });
  }
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
/** A watch check loads the watched page in a background tab first, which alone can take
 * longer than 30 s on a slow site; closing the tab mid-check would fail every check. */
const MONITOR_EXEC_TIMEOUT_MS = 120000;

function routineTimeoutMs(routine) {
  return (routine?.action?.type === 'btask_monitor' || routine?.actionType === 'btask_monitor') ? MONITOR_EXEC_TIMEOUT_MS : ROUTINE_EXEC_TIMEOUT_MS;
}
const TAB_OPEN_WAIT_MS = 20000;

/** @type {{tabId: number, url: string, wsId: string|null, lastSeen: number}|null} */
let lastKnownWorkspaceTab = null;

/** @type {Map<string, {resolve: Function, timer: ReturnType<typeof setTimeout>}>} routineId -> pending execution */
const pendingRoutineExecutions = new Map();

/** @type {Map<number, Function>} tabId -> resolve fn, for tabs we're waiting on to report ready */
const pendingReadyWaiters = new Map();

/** Tabs the scheduler opened for a routine and will close again. Browser-task
 * drafts and requests must never be delivered to one of these. */
const schedulerOwnedTabs = new Set();

/** True while an alarm is processing due routines, so a slow run is not
 * started a second time by the next minute's alarm. */
let schedulerBusy = false;

// ── Workspace reference (survives service-worker restarts) ────────
//
// lastKnownWorkspaceTab alone lives in memory and is lost when the worker is
// killed. {wsId, url, lastSeen} is mirrored to chrome.storage.local so a cold
// start can still open the workspace in a background tab.

const WORKSPACE_REF_KEY = 'workspaceRef';

/** Remember the live workspace tab (memory now, storage.local best-effort) if its origin is allowed. */
function rememberWorkspace({ tabId, url, wsId }) {
  const lastSeen = Date.now();
  lastKnownWorkspaceTab = { tabId, url, wsId, lastSeen };
  persistWorkspaceRef({ wsId, url, lastSeen }).catch(() => {});
}

async function persistWorkspaceRef(ref) {
  if (!isClawserUrl(ref.url, await getCustomOrigin())) return;
  await chrome.storage.local.set({ [WORKSPACE_REF_KEY]: ref });
}

/** Load the persisted reference once at worker start; a live message that arrived first wins. */
async function loadWorkspaceRef() {
  try {
    const stored = (await chrome.storage.local.get(WORKSPACE_REF_KEY))?.[WORKSPACE_REF_KEY];
    if (!stored || typeof stored !== 'object') return;
    const { wsId, url, lastSeen } = stored;
    if (wsId !== null && (typeof wsId !== 'string' || wsId.length > 100)) return;
    if (typeof url !== 'string' || url.length > BTASK_MAX_URL) return;
    if (!isClawserUrl(url, await getCustomOrigin())) return; // origin no longer allowed: do not open it
    if (!lastKnownWorkspaceTab) {
      lastKnownWorkspaceTab = { tabId: -1, url, wsId, lastSeen: Number.isFinite(lastSeen) ? lastSeen : 0 };
    }
  } catch { /* storage unavailable: behave as a fresh start */ }
}

const workspaceRefLoaded = loadWorkspaceRef();

// ── Routine sync from the page ────────────────────────────────────
//
// The page and the extension have separate IndexedDB stores (different
// origins), so the page pushes its schedulable routines here. The extension
// never receives an action payload: it only learns when each routine is due
// and asks the page to run it by id.

const SYNC_MAX_ROUTINES = 500;
const SYNC_MAX_NAME = 200;
const SYNC_MIN_INTERVAL_MS = 60000;
const SYNC_MAX_INTERVAL_MS = 366 * 24 * 3600 * 1000;
const SYNC_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

function sanitizeSyncedTrigger(t) {
  if (!t || typeof t !== 'object') return null;
  if (t.type === 'cron') {
    return typeof t.cron === 'string' && validateCronExpressionInline(t.cron) ? { type: 'cron', cron: t.cron.trim() } : null;
  }
  if (t.type === 'interval') {
    if (typeof t.intervalMs !== 'number' || !Number.isFinite(t.intervalMs)) return null;
    return { type: 'interval', intervalMs: Math.min(Math.max(Math.floor(t.intervalMs), SYNC_MIN_INTERVAL_MS), SYNC_MAX_INTERVAL_MS) };
  }
  if (t.type === 'once') {
    const at = typeof t.at === 'number' ? t.at : (typeof t.at === 'string' ? Date.parse(t.at) : NaN);
    return Number.isFinite(at) && at > 0 ? { type: 'once', at: Math.floor(at) } : null;
  }
  return null;
}

function sanitizeSyncedRoutines(list, wsId) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(list) ? list : []) {
    if (out.length >= SYNC_MAX_ROUTINES) break;
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !SYNC_ID_RE.test(r.id) || seen.has(r.id)) continue;
    const trigger = sanitizeSyncedTrigger(r.trigger);
    if (!trigger) continue;
    seen.add(r.id);
    const actionType = clampText(typeof r.actionType === 'string' ? r.actionType : '', 40);
    out.push({
      id: r.id,
      wsId,
      name: clampText(typeof r.name === 'string' ? r.name : r.id, SYNC_MAX_NAME),
      enabled: r.enabled === true,
      trigger,
      actionType,
      action: { type: actionType }, // informational only; never an executable payload
    });
  }
  return out;
}

async function handleRoutinesSync(msg, sender) {
  const tabId = sender?.tab?.id;
  const tabUrl = sender?.tab?.url;
  if (tabId === undefined || typeof tabUrl !== 'string') return;
  if (!isClawserUrl(tabUrl, await getCustomOrigin())) return;
  const wsId = msg.wsId;
  if (typeof wsId !== 'string' || wsId.length < 1 || wsId.length > 100) return;
  if (!Array.isArray(msg.routines)) return;

  rememberWorkspace({ tabId, url: tabUrl, wsId });
  const incoming = sanitizeSyncedRoutines(msg.routines, wsId);
  const now = Date.now();

  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('clawser_checkpoints', 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('checkpoints')) req.result.createObjectStore('checkpoints');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    // One readwrite transaction (get, then put): definitions come from the page, the
    // extension's own bookkeeping is kept by id, ids missing from the sync are removed,
    // and other workspaces' routines are left alone.
    await new Promise((resolve, reject) => {
      const tx = db.transaction('checkpoints', 'readwrite');
      const store = tx.objectStore('checkpoints');
      const get = store.get('background_routine_state');
      get.onsuccess = () => {
        const current = Array.isArray(get.result) ? get.result : [];
        const previous = new Map(current.filter((r) => r && r.wsId === wsId).map((r) => [r.id, r]));
        const others = current.filter((r) => !(r && r.wsId === wsId));
        const mine = incoming.map((r) => {
          const prev = previous.get(r.id);
          r.state = prev?.state && typeof prev.state === 'object' ? prev.state : {};
          r.meta = prev?.meta && typeof prev.meta === 'object' ? prev.meta : {};
          if (r.trigger.type === 'interval' && r.meta.lastFired == null) r.meta.lastFired = now; // first check one interval from now
          if (r.trigger.type === 'once' && prev && prev.trigger?.at !== r.trigger.at) delete r.meta.fired;
          return r;
        });
        store.put([...others, ...mine], 'background_routine_state');
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

// Set up the alarm on extension install/update
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SCHEDULER_ALARM_NAME, { periodInMinutes: 1 });
  return setupBrowserTasks({ menus: true });
});

// Also ensure alarm exists on startup
chrome.runtime.onStartup?.addListener(() => {
  chrome.alarms.create(SCHEDULER_ALARM_NAME, { periodInMinutes: 1 });
  return setupBrowserTasks({ menus: false });
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
      rememberWorkspace({ tabId, url: tabUrl, wsId: msg.wsId || null });
      const waiter = pendingReadyWaiters.get(tabId);
      if (waiter) { pendingReadyWaiters.delete(tabId); waiter(); }
    }
  } else if (msg.action === 'routines_sync') {
    handleRoutinesSync(msg, sender).catch((e) => console.warn('[clawser-ext] routines_sync failed:', e));
  } else if (msg.action === 'routine_executed') {
    const pending = pendingRoutineExecutions.get(msg.routineId);
    if (pending) {
      pendingRoutineExecutions.delete(msg.routineId);
      clearTimeout(pending.timer);
      pending.resolve({ success: !!msg.success, error: msg.error || null });
    }
  } else if (msg.action === 'pod_message') {
    // Relayed via pod-inject.js's extensionBridge (InjectedPod running in
    // the page's MAIN world) -> content.js -> here. content.js has already
    // enforced the localhost/127.0.0.1/file:// origin allowlist before this
    // ever reaches the background context (see content.js isAllowedOrigin()).
    recordAudit({
      timestamp: Date.now(),
      action: 'pod_message',
      tabId: tabId ?? null,
      url: tabUrl ?? null,
      success: true,
      error: null,
    });
  }
}

/** Ask a specific tab to run a routine now, and wait for its result. */
function requestRoutineExecution(tabId, routineId, timeoutMs = ROUTINE_EXEC_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRoutineExecutions.delete(routineId);
      resolve({ success: false, error: 'Timed out waiting for tab to execute routine' });
    }, timeoutMs);
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
async function delegateRoutineExecution(routineId, timeoutMs = ROUTINE_EXEC_TIMEOUT_MS) {
  if (lastKnownWorkspaceTab && lastKnownWorkspaceTab.tabId >= 0) {
    try {
      const tab = await chrome.tabs.get(lastKnownWorkspaceTab.tabId);
      if (tab && tab.url === lastKnownWorkspaceTab.url) {
        return await requestRoutineExecution(lastKnownWorkspaceTab.tabId, routineId, timeoutMs);
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
  schedulerOwnedTabs.add(openedTab.id);

  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => { pendingReadyWaiters.delete(openedTab.id); resolve(false); }, TAB_OPEN_WAIT_MS);
    pendingReadyWaiters.set(openedTab.id, () => { clearTimeout(timer); resolve(true); });
  });

  const result = ready
    ? await requestRoutineExecution(openedTab.id, routineId, timeoutMs)
    : { success: false, error: 'Opened a tab but it did not report ready in time' };

  try { await chrome.tabs.remove(openedTab.id); } catch { /* best-effort cleanup */ }
  schedulerOwnedTabs.delete(openedTab.id);
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
  if (schedulerBusy) return; // the previous alarm is still running its routines
  schedulerBusy = true;
  await workspaceRefLoaded; // a cold-started worker must know the workspace before deciding what runs

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
    const currentWsId = lastKnownWorkspaceTab?.wsId ?? null;
    for (const r of routines) {
      if (!r.enabled) continue;
      // Routines synced from a page carry their wsId: run only the known workspace's.
      // (Untagged routines predate the sync and run as before.)
      if (r.wsId != null && r.wsId !== currentWsId) continue;

      if (r.trigger?.type === 'interval' && Number.isFinite(r.trigger.intervalMs)) {
        if (now >= (r.meta?.lastFired || 0) + r.trigger.intervalMs) due.push(r);
        continue;
      }
      if (r.trigger?.type === 'once') {
        if (!r.meta?.fired && Number.isFinite(r.trigger.at) && now >= r.trigger.at) due.push(r);
        continue;
      }

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

    // What this run owns on each routine it ran. Applied later onto the *current*
    // stored array (the page may have added, paused, edited or deleted routines
    // while the slow run was going), never by writing back the array read above.
    const ran = [];
    for (const r of due) {
      const { success, error } = await delegateRoutineExecution(r.id, routineTimeoutMs(r));
      const lastResult = success ? 'executed' : `skipped: ${error}`;
      ran.push({
        id: r.id,
        lastRun: Date.now(),
        lastResult,
        lastCronMinute: r.trigger?.type === 'cron' ? Math.floor(now / 60000) : null,
        interval: r.meta?.scheduleType === 'interval' || r.trigger?.type === 'interval',
        once: r.meta?.scheduleType === 'once' || r.trigger?.type === 'once',
      });
      results.push({ routineId: r.id, success, error });
      if (!success) console.warn(`[clawser-ext] Routine "${r.name || r.id}" not executed: ${error}`);
    }

    if (results.length > 0) {
      // One readwrite transaction (get, then put) so the merge is atomic in IDB.
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const getRoutines = store.get(ROUTINE_KEY);
        getRoutines.onsuccess = () => {
          const current = Array.isArray(getRoutines.result) ? getRoutines.result : [];
          for (const o of ran) {
            const cur = current.find((c) => c && c.id === o.id);
            if (!cur) continue; // deleted meanwhile: never bring it back
            cur.state = cur.state || {};
            cur.state.lastRun = o.lastRun;
            cur.state.lastResult = o.lastResult;
            cur.state.runCount = (cur.state.runCount || 0) + 1;
            if (o.lastCronMinute !== null) cur.state.lastCronMinute = o.lastCronMinute;
            if (cur.meta && o.interval) cur.meta.lastFired = now;
            if (cur.meta && o.once) cur.meta.fired = true;
          }
          store.put(current, ROUTINE_KEY);
          const getLog = store.get(LOG_KEY);
          getLog.onsuccess = () => {
            const log = Array.isArray(getLog.result) ? getLog.result : [];
            log.push({ timestamp: now, results });
            while (log.length > 100) log.shift();
            store.put(log, LOG_KEY);
          };
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
      });
    }

    db.close();
  } catch (err) {
    console.warn('[clawser] Background scheduler error:', err);
    try { db?.close(); } catch { /* best-effort */ }
  } finally {
    schedulerBusy = false;
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


// ── Browser tasks: side panel, context menus, clawser origin ─────────
//
// The side panel (sidepanel.html), the options page and the context menus
// all hand work to the Clawser web app; nothing here runs a task. A draft is
// only a request for Clawser to show a draft the user must confirm.
//
// Transport to the Clawser tab (existing content-script bridge):
//   background --tabs.sendMessage--> content.js --window.postMessage--> page
//   { type: MARKER, direction: 'push', action: 'btask', id, request }
//   page --window.postMessage--> content.js --sendResponse--> background
//   { type: MARKER, direction: 'btask_response', id, result | error }
// where `request` is one of the clawser.btask.draft / .list / .inbox messages.

const UI_MARKER = '__clawser_ext_ui__';
const DEFAULT_CLAWSER_ORIGIN = 'https://clawser.erisera.com';
const CUSTOM_ORIGIN_KEY = 'clawserOrigin';
const CUSTOM_ORIGIN_SCRIPT_ID = 'clawser-custom-origin';

const BTASK_KINDS = ['extract', 'compare', 'monitor', 'workflow'];
const BTASK_MAX_SOURCES = 20;
const BTASK_MAX_TITLE = 200;
const BTASK_MAX_URL = 2000;
const BTASK_MAX_SELECTOR = 300;
const BTASK_MAX_HINT = 120;
const BTASK_REPLY_TIMEOUT_MS = 5000;
const BTASK_PING_TIMEOUT_MS = 1000;
const BTASK_DELIVERY_BUDGET_MS = 20000;
const BTASK_OPEN_ATTEMPTS = 25;
const BTASK_OPEN_RETRY_MS = 600;
const BTASK_MAX_CANDIDATE_TABS = 5;

const MENU_KINDS = new Map([
  ['clawser-extract', 'extract'],
  ['clawser-extract-page', 'extract'],
  ['clawser-compare', 'compare'],
  ['clawser-watch', 'monitor'],
]);

// ---- Origin validation ----
// KEEP IN SYNC with normalizeClawserOrigin() in content.js (a test runs the
// same table through both).

/**
 * Validate a user-supplied Clawser origin: an https origin only (no path,
 * query, credentials or wildcards), with a real multi-label hostname that is
 * not an IP literal or localhost (those are already built in).
 * @returns {{ok: true, origin: string} | {ok: false, error: string}}
 */
function normalizeClawserOrigin(input) {
  const fail = (error) => ({ ok: false, error });
  if (typeof input !== 'string') return fail('Enter an https origin such as https://clawser.example.com');
  const raw = input.trim();
  if (!raw) return fail('Enter an https origin such as https://clawser.example.com');
  if (raw.length > 200) return fail('That origin is too long');
  if (/[\s*<>"'\\^`{|}?#]/.test(raw)) return fail('Use a plain origin: no spaces, wildcards, path, query or fragment');
  let u;
  try { u = new URL(raw); } catch { return fail('That is not a valid URL'); }
  if (u.protocol !== 'https:') return fail('The origin must use https');
  if (u.username || u.password) return fail('The origin must not contain a username or password');
  if (u.pathname !== '/') return fail('Use only the origin, without a path');
  const host = u.hostname;
  if (!host || host.endsWith('.') || !host.includes('.')) return fail('Enter a full hostname such as clawser.example.com');
  if (/^[\d.]+$/.test(host) || host.startsWith('[')) return fail('IP addresses are not allowed here');
  if (host === 'localhost' || host.endsWith('.localhost')) return fail('localhost is already allowed by default');
  if (u.origin === DEFAULT_CLAWSER_ORIGIN) return fail('That origin is already allowed by default');
  return { ok: true, origin: u.origin };
}

/** Is this tab URL a Clawser page (built-in origins, or the configured custom origin)? */
function isClawserUrl(url, customOrigin) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'file:') return true;
  if ((u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
  if (u.protocol === 'https:') return u.origin === DEFAULT_CLAWSER_ORIGIN || (!!customOrigin && u.origin === customOrigin);
  return false;
}

/** The validated custom origin from storage, or null. A corrupt value counts as unset. */
async function getCustomOrigin() {
  try {
    const stored = await chrome.storage.local.get(CUSTOM_ORIGIN_KEY);
    const r = normalizeClawserOrigin(stored?.[CUSTOM_ORIGIN_KEY]);
    return r.ok ? r.origin : null;
  } catch {
    return null;
  }
}

// Serialises origin changes so storage and the registered content script can
// never end up describing different origins.
let originChain = Promise.resolve();

function runOriginJob(fn) {
  const run = originChain.then(fn, fn);
  originChain = run.catch(() => {});
  return run;
}

/** Make the registered dynamic content script match `origin` (or nothing). */
async function applyOriginRegistration(origin) {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CUSTOM_ORIGIN_SCRIPT_ID] });
  } catch { /* not registered yet */ }
  if (!origin) return;
  await chrome.scripting.registerContentScripts([{
    id: CUSTOM_ORIGIN_SCRIPT_ID,
    matches: [`${origin}/*`],
    js: ['content.js'],
    runAt: 'document_idle',
    persistAcrossSessions: true,
  }]);
}

async function injectIntoOpenClawserTabs() {
  try {
    const custom = await getCustomOrigin();
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.url || !isClawserUrl(tab.url, custom)) continue;
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
        .catch(() => {}); // ignore tabs where injection fails
    }
  } catch (e) {
    console.warn('[clawser-ext] Could not inject into existing tabs:', e);
  }
}

async function setClawserOrigin(input) {
  const wantsReset = typeof input === 'string' && input.trim() === '';
  let checked = null;
  if (!wantsReset) {
    checked = normalizeClawserOrigin(input);
    if (!checked.ok) return { ok: false, error: checked.error };
  }
  const origin = checked ? checked.origin : null;
  await runOriginJob(async () => {
    if (origin) await chrome.storage.local.set({ [CUSTOM_ORIGIN_KEY]: origin });
    else await chrome.storage.local.remove(CUSTOM_ORIGIN_KEY);
    await applyOriginRegistration(origin);
  });
  if (origin) await injectIntoOpenClawserTabs();
  return { ok: true, origin };
}

// ---- Setup (install / startup) ----

async function setupBrowserTasks({ menus }) {
  try {
    await runOriginJob(async () => applyOriginRegistration(await getCustomOrigin()));
  } catch (e) {
    console.warn('[clawser-ext] Could not sync custom Clawser origin:', e);
  }
  try {
    await chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
  } catch { /* side panel not supported here */ }
  if (menus) await createContextMenus();
}

/** Does this browser let a menu click resolve the right-clicked element? (Firefox: yes; Chrome: no.) */
function canResolveClickedElement() {
  return !!((chrome.menus && chrome.menus.getTargetElement) || (chrome.contextMenus && chrome.contextMenus.getTargetElement));
}

async function createContextMenus() {
  const api = chrome.contextMenus || chrome.menus;
  if (!api) return;
  try {
    await api.removeAll();
    if (canResolveClickedElement()) {
      // The clicked element can be found, so "section" is honest.
      const contexts = ['page', 'selection', 'link', 'image', 'video', 'audio', 'frame'];
      api.create({ id: 'clawser-extract', title: 'Extract data from this section', contexts });
      api.create({ id: 'clawser-compare', title: 'Compare with other tabs', contexts });
      api.create({ id: 'clawser-watch', title: 'Watch this section', contexts });
    } else {
      // Chrome cannot tell us which element was clicked, and a content script on
      // every site is not worth it. So offer exactly what we can do: the
      // selection, or the whole page.
      api.create({ id: 'clawser-extract', title: 'Extract data from the selection', contexts: ['selection'] });
      api.create({ id: 'clawser-extract-page', title: 'Extract data from this page', contexts: ['page'] });
      api.create({ id: 'clawser-compare', title: 'Compare with other tabs', contexts: ['page', 'selection'] });
      api.create({ id: 'clawser-watch', title: 'Watch the selection', contexts: ['selection'] });
    }
  } catch (e) {
    console.warn('[clawser-ext] Could not create context menus:', e);
  }
}

// ---- Helpers ----

function clampText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** http(s) URL with credentials stripped, or null. */
function safeHttpUrl(value) {
  if (typeof value !== 'string' || value.length > BTASK_MAX_URL * 2) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.username = '';
  u.password = '';
  const href = u.href;
  return href.length <= BTASK_MAX_URL ? href : null;
}

/** Only an extension page of this extension may drive the btask/origin actions. */
function isOwnExtensionPage(sender) {
  try {
    return !!sender && !!chrome.runtime.id && sender.id === chrome.runtime.id
      && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- UI message router ----

async function handleUiMessage(msg, sender) {
  if (!isOwnExtensionPage(sender)) throw new Error('Not allowed from this context');
  switch (msg.action) {
    case 'get_clawser_origin':
      return { origin: await getCustomOrigin(), defaultOrigin: DEFAULT_CLAWSER_ORIGIN };
    case 'set_clawser_origin':
      return setClawserOrigin(msg.origin);
    case 'btask_list':
      return btaskFetch('clawser.btask.list', 'definitions', normalizeDefinitions);
    case 'btask_inbox':
      return btaskFetch('clawser.btask.inbox', 'notifications', normalizeNotifications);
    case 'btask_draft':
      return btaskDraftFromPanel(msg);
    case 'btask_open':
      return btaskOpenClawser();
    case 'btask_notice':
      return { notice: publicNotice(await getNotice()) };
    case 'btask_dismiss':
      await clearNotice();
      return { ok: true };
    case 'btask_retry':
      return btaskRetry();
    default:
      throw new Error(`Unknown action: ${msg.action}`);
  }
}

// ---- Talking to the Clawser tab ----

let deliveryChain = Promise.resolve();

/** Draft deliveries run one at a time so two quick clicks cannot open two Clawser tabs. */
function serializedDelivery(fn) {
  const run = deliveryChain.then(fn, fn);
  deliveryChain = run.catch(() => {});
  return run;
}

/**
 * Send one request to one tab. Returns { transport: true } when nothing there
 * answered (no content script, no receiver, timeout), { error } when the page
 * answered with an error, { result } otherwise.
 */
async function sendToTab(tabId, request, timeoutMs) {
  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tabId, { type: MARKER, direction: 'btask_request', request, timeoutMs });
  } catch {
    return { transport: true };
  }
  if (!resp || resp.transportError) return { transport: true };
  if (resp.error) return { error: clampText(String(resp.error), 300) };
  return { result: resp.result };
}

/**
 * Ask one tab. A short handshake comes first: a tab whose page has no receiver
 * is given up on after ~1 s instead of waiting out the full reply timeout.
 * Any reply to the ping, even an error, shows a receiver is there.
 */
async function askClawserTab(tabId, request) {
  const ping = await sendToTab(tabId, { type: 'clawser.btask.ping' }, BTASK_PING_TIMEOUT_MS);
  if (ping.transport) return { transport: true };
  const r = await sendToTab(tabId, request, BTASK_REPLY_TIMEOUT_MS);
  if (r.error) return { error: clampText(String(r.error), 300) };
  return r;
}

async function findClawserTabs() {
  const custom = await getCustomOrigin();
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((t) => typeof t.url === 'string' && isClawserUrl(t.url, custom) && !schedulerOwnedTabs.has(t.id))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
    .slice(0, BTASK_MAX_CANDIDATE_TABS);
}

/**
 * Deliver a request to a connected Clawser tab. With `open`, opens Clawser
 * (configured origin, else production) when none answers and retries until
 * the new page acknowledges. The whole attempt is capped at
 * BTASK_DELIVERY_BUDGET_MS; after that it reports not connected and stops
 * sending.
 */
function deliverToClawser(request, { open }) {
  const state = { cancelled: false };
  let timer;
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => { state.cancelled = true; resolve({ connected: false, timedOut: true }); }, BTASK_DELIVERY_BUDGET_MS);
  });
  const work = deliverUnbounded(request, open, state).finally(() => clearTimeout(timer));
  work.catch(() => {}); // a late failure after the budget must not be an unhandled rejection
  return Promise.race([work, budget]);
}

async function deliverUnbounded(request, open, state) {
  for (const tab of await findClawserTabs()) {
    if (state.cancelled) return { connected: false };
    const r = await askClawserTab(tab.id, request);
    if (!r.transport) return { connected: true, tabId: tab.id, ...r };
  }
  if (!open || state.cancelled) return { connected: false };

  const custom = await getCustomOrigin();
  const tab = await chrome.tabs.create({ url: `${custom || DEFAULT_CLAWSER_ORIGIN}/`, active: true });
  for (let i = 0; i < BTASK_OPEN_ATTEMPTS && !state.cancelled; i++) {
    await sleep(BTASK_OPEN_RETRY_MS);
    if (state.cancelled) break;
    const r = await askClawserTab(tab.id, request);
    if (!r.transport) return { connected: true, opened: true, tabId: tab.id, ...r };
    try { await chrome.tabs.get(tab.id); } catch { break; } // user closed it
  }
  return { connected: false, opened: true };
}

async function focusTab(tabId) {
  try {
    const t = await chrome.tabs.update(tabId, { active: true });
    if (t && t.windowId !== undefined) await chrome.windows.update(t.windowId, { focused: true });
  } catch { /* focus is best-effort */ }
}

/** Send a validated draft to Clawser and bring that tab forward. */
async function sendDraft({ kind, sources, origin }) {
  const request = { type: 'clawser.btask.draft', kind, sources, origin };
  const r = await serializedDelivery(() => deliverToClawser(request, { open: true }));
  if (!r.connected) return { ok: false, opened: !!r.opened, error: 'Clawser did not respond. Open clawser and try again.' };
  if (r.error) return { ok: false, error: r.error };
  await focusTab(r.tabId);
  return { ok: true, opened: !!r.opened };
}

async function btaskDraftFromPanel(msg) {
  if (!BTASK_KINDS.includes(msg.kind)) throw new Error('Unknown task kind');
  const raw = msg.sources;
  if (!Array.isArray(raw) || raw.length < 1) throw new Error('Choose at least one tab');
  if (raw.length > BTASK_MAX_SOURCES) throw new Error(`At most ${BTASK_MAX_SOURCES} sources`);
  const sources = [];
  for (const item of raw) {
    const tabId = item?.tabId;
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Invalid tab');
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { throw new Error('A selected tab is no longer open'); }
    const url = safeHttpUrl(tab?.url);
    if (!url) throw new Error('Only http and https pages can be used');
    sources.push({ kind: 'tab', url, title: clampText(tab.title, BTASK_MAX_TITLE), tabId, capturedAt: new Date().toISOString() });
  }
  // The origin is decided here, never taken from the caller.
  return sendDraft({ kind: msg.kind, sources, origin: 'sidepanel' });
}

/** Bring a Clawser tab forward, opening Clawser if none is open. */
async function btaskOpenClawser() {
  return serializedDelivery(async () => {
    const [existing] = await findClawserTabs();
    if (existing) { await focusTab(existing.id); return { ok: true, opened: false }; }
    const custom = await getCustomOrigin();
    await chrome.tabs.create({ url: `${custom || DEFAULT_CLAWSER_ORIGIN}/`, active: true });
    return { ok: true, opened: true };
  });
}

function normalizeDefinitions(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 100).map((d) => {
    const lr = d?.lastRun;
    return {
      id: clampText(String(d?.id ?? ''), 100),
      kind: clampText(String(d?.kind ?? ''), 20),
      name: clampText(String(d?.name ?? ''), 200),
      updatedAt: clampText(String(d?.updatedAt ?? ''), 40),
      lastRun: lr && typeof lr === 'object'
        ? { id: clampText(String(lr.id ?? ''), 100), status: clampText(String(lr.status ?? ''), 40), finishedAt: lr.finishedAt == null ? null : clampText(String(lr.finishedAt), 40) }
        : null,
    };
  }).filter((d) => d.id);
}

function normalizeNotifications(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 50).map((n) => {
    const out = {
      id: clampText(String(n?.id ?? ''), 100),
      kind: clampText(String(n?.kind ?? ''), 20),
      at: clampText(String(n?.at ?? ''), 40),
      title: clampText(String(n?.title ?? ''), 200),
      body: clampText(String(n?.body ?? ''), 500),
      read: n?.read === true,
    };
    if (n?.runId) out.runId = clampText(String(n.runId), 100);
    if (n?.definitionId) out.definitionId = clampText(String(n.definitionId), 100);
    return out;
  }).filter((n) => n.id);
}

/** list / inbox: read-only, never opens or focuses anything. */
async function btaskFetch(type, field, normalize) {
  const r = await deliverToClawser({ type }, { open: false });
  if (!r.connected) return { connected: false };
  if (r.error) return { connected: true, error: r.error };
  return { connected: true, [field]: normalize(r.result?.[field]) };
}

// ---- Notices (undelivered drafts, capture fallbacks) ----
// A context-menu action happens outside any UI, so a problem must be visible:
// the toolbar badge + title say so, and the side panel shows the notice (with
// Retry for an undelivered draft) until it is delivered or dismissed.

const NOTICE_KEY = 'btaskNotice';
const ACTION_DEFAULT_TITLE = 'Clawser browser tasks';
let memoryNotice = null; // fallback when chrome.storage.session is unavailable

async function getNotice() {
  try {
    if (chrome.storage?.session) {
      const o = await chrome.storage.session.get(NOTICE_KEY);
      return o?.[NOTICE_KEY] || null;
    }
  } catch { /* fall through to memory */ }
  return memoryNotice;
}

async function setNotice(notice) {
  memoryNotice = notice;
  try { await chrome.storage?.session?.set({ [NOTICE_KEY]: notice }); } catch { /* memory copy remains */ }
  try {
    await chrome.action?.setBadgeText({ text: notice.kind === 'undelivered' ? '!' : 'i' });
    await chrome.action?.setTitle({ title: notice.message });
  } catch { /* badge is best-effort */ }
}

async function clearNotice() {
  memoryNotice = null;
  try { await chrome.storage?.session?.remove(NOTICE_KEY); } catch { /* ignore */ }
  try {
    await chrome.action?.setBadgeText({ text: '' });
    await chrome.action?.setTitle({ title: ACTION_DEFAULT_TITLE });
  } catch { /* ignore */ }
}

function publicNotice(n) {
  if (!n) return null;
  return {
    kind: n.kind,
    message: clampText(n.message, 300),
    detail: n.fellBack ? clampText(n.fellBack, 300) : null,
    canRetry: n.kind === 'undelivered' && !!n.draft,
    draftKind: n.draft ? n.draft.kind : null,
    sources: n.draft ? n.draft.sources.map((x) => ({ title: x.title, url: x.url })) : [],
  };
}

async function btaskRetry() {
  const notice = await getNotice();
  if (!notice || notice.kind !== 'undelivered' || !notice.draft) return { ok: false, error: 'There is no undelivered draft to retry' };
  const r = await sendDraft(notice.draft);
  if (r.ok) {
    if (notice.fellBack) await setNotice({ kind: 'fallback', message: notice.fellBack, at: Date.now() });
    else await clearNotice();
  }
  return r;
}

// ---- Context menus ----

(chrome.contextMenus || chrome.menus)?.onClicked.addListener((info, tab) => {
  return handleMenuClick(info, tab).catch((e) => console.warn('[clawser-ext] Context-menu action failed:', e));
});

async function handleMenuClick(info, tab) {
  const id = info?.menuItemId;
  if (typeof id !== 'string' || !MENU_KINDS.has(id)) return;
  const kind = MENU_KINDS.get(id);
  const url = safeHttpUrl(tab?.url);
  if (!url || !Number.isInteger(tab.id)) return;

  const selected = typeof info.selectionText === 'string' ? clampText(info.selectionText, 500) : '';
  // Compare takes the whole tab unless the user selected something.
  const wantSection = id !== 'clawser-extract-page' && (kind !== 'compare' || selected !== '');
  const section = wantSection ? await captureSection(tab.id, info, selected) : null;

  const source = { kind: section ? 'section' : 'tab', url, title: clampText(tab.title, BTASK_MAX_TITLE), tabId: tab.id, capturedAt: new Date().toISOString() };
  if (section) source.section = section;
  // Capture can fail on its own (restricted page, no frame access, the browser
  // not offering the clicked element). Fall back to the whole tab, and say so.
  const fellBack = wantSection && !section
    ? `Couldn't pick out that section on "${source.title || source.url}", so the whole tab was sent. Choose the section in clawser.`
    : null;

  const draft = { kind, sources: [source], origin: 'contextmenu' };
  const r = await sendDraft(draft);
  if (r.ok) {
    if (fellBack) await setNotice({ kind: 'fallback', message: fellBack, at: Date.now() });
    else await clearNotice();
    return;
  }
  console.warn('[clawser-ext] Draft not delivered:', r.error);
  await setNotice({
    kind: 'undelivered',
    message: "Couldn't send to clawser: open clawser and try again",
    fellBack,
    draft,
    at: Date.now(),
  });
}

/**
 * Capture a stable selector and a short text hint for the clicked element, in
 * the top frame only (a selector from a sub-frame would not resolve against the
 * tab's URL). Everything the page returns is untrusted: re-validated here.
 */
async function captureSection(tabId, info, selectedText) {
  if (Number.isInteger(info.frameId) && info.frameId > 0) return null;
  let res;
  try {
    res = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: captureSectionInPage,
      args: [Number.isInteger(info.targetElementId) ? info.targetElementId : null, selectedText],
    });
  } catch {
    return null;
  }
  const out = res?.[0]?.result;
  if (!out || typeof out !== 'object') return null;
  const selector = out.selector;
  if (typeof selector !== 'string' || selector.length < 1 || selector.length > BTASK_MAX_SELECTOR || /[\u0000-\u001f\u007f]/.test(selector)) return null;
  return { selector, textHint: clampText(out.textHint, BTASK_MAX_HINT) };
}

/**
 * Runs IN THE PAGE (serialised by chrome.scripting.executeScript, so it must
 * stay self-contained). Finds the right-clicked element and returns a short
 * unique selector plus a bounded text hint. Never reads form-control values.
 * @returns {{selector: string|null, textHint: string}}
 */
function captureSectionInPage(targetElementId, selectionText) {
  const MAX_SELECTOR = 300;
  const MAX_HINT = 120;
  const MAX_DEPTH = 12;
  const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, MAX_HINT);

  let el = null;
  try {
    const getTarget = (chrome.menus && chrome.menus.getTargetElement) || (chrome.contextMenus && chrome.contextMenus.getTargetElement);
    if (targetElementId != null && getTarget) el = getTarget.call(chrome.menus && chrome.menus.getTargetElement ? chrome.menus : chrome.contextMenus, targetElementId);
  } catch (e) { el = null; }
  if (!el) {
    try {
      const sel = window.getSelection();
      const n = sel && sel.anchorNode;
      if (n) el = n.nodeType === 1 ? n : n.parentElement;
    } catch (e) { el = null; }
  }
  if (!el || el.nodeType !== 1) return { selector: null, textHint: flat(selectionText) };

  const isForm = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable === true;
  let hint = '';
  if (!isForm) hint = flat(selectionText) || flat(String(el.textContent || '').slice(0, 2000));

  const esc = (s) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  const unique = (sel, node) => {
    try { const m = document.querySelectorAll(sel); return m.length === 1 && m[0] === node; } catch (e) { return false; }
  };
  const unstableId = (id) => !id || id.length > 64 || /\d{4,}/.test(id) || id.indexOf(':') !== -1 || /^[a-f0-9-]{20,}$/i.test(id);
  const anchorFor = (node) => {
    if (!unstableId(node.id)) {
      const s = '#' + esc(node.id);
      if (unique(s, node)) return s;
    }
    const tid = node.getAttribute && node.getAttribute('data-testid');
    if (tid && tid.length <= 64 && !/["\\\n\r]/.test(tid)) {
      const s = '[data-testid="' + tid + '"]';
      if (unique(s, node)) return s;
    }
    return null;
  };

  const segs = [];
  let anchor = null;
  let node = el;
  for (let depth = 0; node && node.nodeType === 1 && depth <= MAX_DEPTH; depth++) {
    anchor = anchorFor(node);
    if (anchor) break;
    const tag = String(node.tagName).toLowerCase();
    if (tag === 'body') { anchor = 'body'; break; }
    if (tag === 'html' || !/^[a-z][a-z0-9-]*$/.test(tag) || !node.parentElement) break;
    const sameTag = Array.prototype.filter.call(node.parentElement.children, (c) => c.tagName === node.tagName);
    segs.unshift(tag + ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')');
    node = node.parentElement;
  }
  let selector = null;
  if (anchor) {
    const candidate = [anchor].concat(segs).join(' > ');
    if (candidate.length <= MAX_SELECTOR && unique(candidate, el)) selector = candidate;
  }
  return { selector, textHint: hint };
}
