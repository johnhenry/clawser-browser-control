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

  handleAction(msg.action, msg.params || {})
    .then((result) => sendResponse({ result }))
    .catch((err) => sendResponse({ error: err.message || String(err) }));

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

    // ── Monitoring ──
    case 'console': return actionConsole(params);
    case 'network': return actionNetwork(params);

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

async function actionGetHtml({ tabId, selector, ref }) {
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (sel) => {
    const el = sel ? document.querySelector(sel) : document.documentElement;
    if (!el) return { error: `Element not found: ${sel}` };
    return { html: el.outerHTML.slice(0, 50000) };
  }, [selector || ref || 'html']);
}

// -- Input Simulation --

async function actionClick({ tabId, selector, text, x, y }) {
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (sel, txt, cx, cy) => {
    let el;
    if (cx !== undefined && cy !== undefined) {
      el = document.elementFromPoint(cx, cy);
    } else if (sel) {
      el = document.querySelector(sel);
    } else if (txt) {
      const all = document.querySelectorAll('a, button, [role=button], [role=link], input[type=submit]');
      for (const e of all) {
        if (e.textContent?.trim()?.includes(txt)) { el = e; break; }
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
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (sel, txt, cx, cy) => {
    let el;
    if (cx !== undefined && cy !== undefined) el = document.elementFromPoint(cx, cy);
    else if (sel) el = document.querySelector(sel);
    else if (txt) {
      for (const e of document.querySelectorAll('*')) {
        if (e.textContent?.trim()?.includes(txt) && e.children.length < 3) { el = e; break; }
      }
    }
    if (!el) return { error: 'Element not found' };
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    return { doubleClicked: el.tagName };
  }, [selector, text, x, y]);
}

async function actionTripleClick({ tabId, selector, x, y }) {
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (sel, cx, cy) => {
    let el;
    if (cx !== undefined && cy !== undefined) el = document.elementFromPoint(cx, cy);
    else if (sel) el = document.querySelector(sel);
    if (!el) return { error: 'Element not found' };
    for (let i = 0; i < 3; i++) {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: i + 1 }));
    }
    return { tripleClicked: el.tagName };
  }, [selector, x, y]);
}

async function actionRightClick({ tabId, selector, x, y }) {
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (sel, cx, cy) => {
    let el;
    if (cx !== undefined && cy !== undefined) el = document.elementFromPoint(cx, cy);
    else if (sel) el = document.querySelector(sel);
    if (!el) return { error: 'Element not found' };
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    return { rightClicked: el.tagName };
  }, [selector, x, y]);
}

async function actionHover({ tabId, selector, x, y }) {
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (sel, cx, cy) => {
    let el;
    if (cx !== undefined && cy !== undefined) el = document.elementFromPoint(cx, cy);
    else if (sel) el = document.querySelector(sel);
    if (!el) return { error: 'Element not found' };
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    return { hovered: el.tagName };
  }, [selector, x, y]);
}

async function actionDrag({ tabId, startSelector, startX, startY, endX, endY }) {
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (sel, sx, sy, ex, ey) => {
    let el;
    if (sel) el = document.querySelector(sel);
    else if (sx !== undefined && sy !== undefined) el = document.elementFromPoint(sx, sy);
    if (!el) return { error: 'Element not found' };
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: sx || 0, clientY: sy || 0 }));
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ex || 0, clientY: ey || 0 }));
    document.elementFromPoint(ex || 0, ey || 0)
      ?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: ex || 0, clientY: ey || 0 }));
    return { dragged: true };
  }, [startSelector, startX, startY, endX, endY]);
}

async function actionScroll({ tabId, selector, direction, amount }) {
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (sel, dir, amt) => {
    const pixels = (amt || 3) * 100;
    const target = sel ? document.querySelector(sel) : window;
    if (!target) return { error: 'Scroll target not found' };
    const opts = { behavior: 'smooth' };
    switch (dir) {
      case 'up': opts.top = -pixels; break;
      case 'down': opts.top = pixels; break;
      case 'left': opts.left = -pixels; break;
      case 'right': opts.left = pixels; break;
      default: opts.top = pixels;
    }
    (target === window ? window : target).scrollBy(opts);
    return { scrolled: dir || 'down', pixels };
  }, [selector, direction, amount]);
}

async function actionType({ tabId, selector, text, submit }) {
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (sel, txt, doSubmit) => {
    const el = sel ? document.querySelector(sel) : document.activeElement;
    if (!el) return { error: 'Element not found' };
    el.focus();
    if (el.value !== undefined) {
      el.value = txt;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = txt;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (doSubmit) {
      const form = el.closest('form');
      if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    return { typed: txt.length + ' chars', submitted: !!doSubmit };
  }, [selector, text, submit]);
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
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return { error: `Element not found: ${sel}` };
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
  const tid = await resolveTabId({ tabId });
  return executeInTab(tid, (sel, val, txt) => {
    const el = document.querySelector(sel);
    if (!el || el.tagName !== 'SELECT') return { error: 'Select element not found' };
    for (const opt of el.options) {
      if ((val && opt.value === val) || (txt && opt.textContent?.trim() === txt)) {
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
    return new Promise((resolve) => {
      const start = Date.now();

      function check() {
        if (sel) {
          const el = document.querySelector(sel);
          if (el) return resolve({ found: true, elapsed: Date.now() - start });
        }
        if (cond) {
          try {
            if ((0, eval)(cond)) return resolve({ found: true, elapsed: Date.now() - start });
          } catch {}
        }
        if (Date.now() - start > timeoutMs) {
          return resolve({ found: false, timeout: true, elapsed: Date.now() - start });
        }
        setTimeout(check, 200);
      }
      check();
    });
  }, [selector, condition, ms]);
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

const SCHEDULER_ALARM_NAME = 'clawser-scheduler';

// Set up the alarm on extension install/update
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SCHEDULER_ALARM_NAME, { periodInMinutes: 1 });
});

// Also ensure alarm exists on startup
chrome.runtime.onStartup?.addListener(() => {
  chrome.alarms.create(SCHEDULER_ALARM_NAME, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SCHEDULER_ALARM_NAME) return;

  // Import BackgroundSchedulerRunner from the web app via IndexedDB
  // In a MV3 extension SW, we can't import ES modules. Instead, we
  // read routine state from IndexedDB and execute due routines inline.
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

    // Inline cron matching (can't import ES modules in MV3 service worker)
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
      if (parts.length < 5) return false;
      const fields = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];
      for (let i = 0; i < 5; i++) {
        if (!cronFieldMatches(parts[i], fields[i])) return false;
      }
      return true;
    }

    for (const r of routines) {
      if (!r.enabled) continue;
      let shouldFire = false;

      // Cron check — evaluate the actual cron expression
      if (r.trigger?.type === 'cron' && r.trigger?.cron) {
        const lastMinute = r.state?.lastCronMinute || 0;
        const thisMinute = Math.floor(now / 60000);
        if (thisMinute > lastMinute && cronMatches(r.trigger.cron, nowDate)) shouldFire = true;
      }
      // Interval check
      if (r.meta?.scheduleType === 'interval') {
        const lastFired = r.meta.lastFired || 0;
        if (now >= lastFired + (r.meta.intervalMs || 60000)) shouldFire = true;
      }
      // Once check
      if (r.meta?.scheduleType === 'once' && !r.meta.fired && now >= (r.meta.fireAt || 0)) {
        shouldFire = true;
      }

      if (shouldFire) {
        r.state = r.state || {};
        r.state.lastRun = now;
        r.state.lastResult = 'background_executed';
        r.state.runCount = (r.state.runCount || 0) + 1;
        if (r.trigger?.type === 'cron') r.state.lastCronMinute = Math.floor(now / 60000);
        if (r.meta?.scheduleType === 'interval') r.meta.lastFired = now;
        if (r.meta?.scheduleType === 'once') r.meta.fired = true;
        results.push({ routineId: r.id, result: 'background_executed' });
      }
    }

    if (results.length > 0) {
      await write(ROUTINE_KEY, routines);
      // Append to execution log
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
