// Run with: node --test test/btask-contextmenu.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './_load-background.mjs';

const CLAWSER = { id: 50, windowId: 7, url: 'https://clawser.erisera.com/', title: 'Clawser', lastAccessed: 1 };
const PAGE = { id: 11, windowId: 7, url: 'https://shop.example.com/list?q=1', title: 'Shop list' };

function setup({ capture, tabs = [CLAWSER, PAGE], reply } = {}) {
  const sent = [];
  const execCalls = [];
  const b = loadBackground({
    tabs: {
      query: async () => tabs.map((t) => ({ ...t })),
      get: async (id) => ({ ...tabs.find((t) => t.id === id) }),
      sendMessage: async (tabId, msg) => { sent.push({ tabId, msg }); return reply ? reply(tabId, msg) : { result: { accepted: true } }; },
      update: async () => ({}),
    },
    windows: { update: async () => ({}) },
    scripting: {
      executeScript: async (inj) => {
        if (!inj.func) return [{ result: null }]; // init()'s content.js re-injection
        execCalls.push(inj);
        if (capture instanceof Error) throw capture;
        return [{ result: capture }];
      },
      registerContentScripts: async () => {}, unregisterContentScripts: async () => {},
    },
  }, { setTimeoutImpl: (fn, ms) => setTimeout(fn, Math.min(ms, 1)) });
  return { b, sent, execCalls };
}

describe('context menu registration', () => {
  it('creates the three entries on install', async () => {
    const { b } = setup();
    await b.install();
    const byId = Object.fromEntries(b.menusCreated.map((m) => [m.id, m]));
    assert.equal(byId['clawser-extract'].title, 'Extract data from this section');
    assert.equal(byId['clawser-compare'].title, 'Compare with other tabs');
    assert.equal(byId['clawser-watch'].title, 'Watch this section');
    assert.equal(b.menusCreated.length, 3);
  });

  it('install is idempotent (removeAll before create)', async () => {
    const { b } = setup();
    await b.install();
    await b.install();
    assert.equal(b.menusCreated.length, 3);
  });

  it('makes the toolbar button open the side panel when the API exists', async () => {
    const { b } = setup();
    await b.install();
    assert.deepEqual(JSON.parse(JSON.stringify(b.panelBehavior)), [{ openPanelOnActionClick: true }]);
  });

  it('does not throw when sidePanel is unavailable (Firefox)', async () => {
    const b = loadBackground({ sidePanel: undefined });
    await b.install();
    assert.equal(b.menusCreated.length, 3);
  });
});

describe('context menu clicks', () => {
  it('extract: captures the clicked section and sends an extract draft with origin "contextmenu"', async () => {
    const { b, sent, execCalls } = setup({ capture: { selector: '#prices > table:nth-of-type(1)', textHint: 'Plan Price Basic $5' } });
    await b.clickMenu({ menuItemId: 'clawser-extract', frameId: 0, targetElementId: 77, selectionText: '' }, PAGE);
    assert.equal(execCalls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(execCalls[0].target)), { tabId: 11, frameIds: [0] });
    assert.deepEqual(JSON.parse(JSON.stringify(execCalls[0].args)), [77, '']);
    const req = sent[0].msg.request;
    assert.equal(req.type, 'clawser.btask.draft');
    assert.equal(req.kind, 'extract');
    assert.equal(req.origin, 'contextmenu');
    assert.equal(req.sources.length, 1);
    const s = req.sources[0];
    assert.equal(s.kind, 'section');
    assert.equal(s.url, PAGE.url);
    assert.equal(s.title, 'Shop list');
    assert.equal(s.tabId, 11);
    assert.deepEqual(JSON.parse(JSON.stringify(s.section)), { selector: '#prices > table:nth-of-type(1)', textHint: 'Plan Price Basic $5' });
    assert.match(s.capturedAt, /^\d{4}-\d\d-\d\dT/);
  });

  it('watch maps to kind "monitor"', async () => {
    const { b, sent } = setup({ capture: { selector: 'body > div:nth-of-type(1)', textHint: 'x' } });
    await b.clickMenu({ menuItemId: 'clawser-watch', frameId: 0, targetElementId: 1 }, PAGE);
    assert.equal(sent[0].msg.request.kind, 'monitor');
    assert.equal(sent[0].msg.request.sources[0].kind, 'section');
  });

  it('compare without a selection sends the whole tab and does not touch the page', async () => {
    const { b, sent, execCalls } = setup();
    await b.clickMenu({ menuItemId: 'clawser-compare', frameId: 0, targetElementId: 5 }, PAGE);
    assert.equal(execCalls.length, 0);
    const s = sent[0].msg.request.sources[0];
    assert.equal(sent[0].msg.request.kind, 'compare');
    assert.equal(s.kind, 'tab');
    assert.equal('section' in s, false);
  });

  it('compare with a selection sends that section', async () => {
    const { b, sent } = setup({ capture: { selector: '#a', textHint: 'hello' } });
    await b.clickMenu({ menuItemId: 'clawser-compare', frameId: 0, targetElementId: 5, selectionText: 'hello' }, PAGE);
    assert.equal(sent[0].msg.request.sources[0].kind, 'section');
  });

  it('falls back to a whole-tab source when capture fails or finds no usable selector', async () => {
    for (const capture of [new Error('Cannot access contents'), null, { selector: null, textHint: 'only text' }, 'junk', { selector: 42, textHint: {} }]) {
      const { b, sent } = setup({ capture });
      await b.clickMenu({ menuItemId: 'clawser-extract', frameId: 0, targetElementId: 1 }, PAGE);
      const s = sent[0].msg.request.sources[0];
      assert.equal(s.kind, 'tab', `capture=${String(capture)}`);
      assert.equal('section' in s, false);
    }
  });

  it('clamps page-controlled capture output (selector <= 300, hint <= 120, single line)', async () => {
    const { b, sent } = setup({ capture: { selector: '#' + 'a'.repeat(5000), textHint: 'x\n\n y'.repeat(500) } });
    await b.clickMenu({ menuItemId: 'clawser-extract', frameId: 0, targetElementId: 1 }, PAGE);
    const s = sent[0].msg.request.sources[0];
    // an over-long selector is not stable enough to keep: whole tab, no section
    assert.equal(s.kind, 'tab');
    const { b: b2, sent: sent2 } = setup({ capture: { selector: '#ok', textHint: 'x\n\n y'.repeat(500) } });
    await b2.clickMenu({ menuItemId: 'clawser-extract', frameId: 0, targetElementId: 1 }, PAGE);
    const hint = sent2[0].msg.request.sources[0].section.textHint;
    assert.ok(hint.length <= 120);
    assert.ok(!/[\n\r]/.test(hint));
  });

  it('does not forward extra fields a hostile page smuggles into the capture result', async () => {
    const { b, sent } = setup({ capture: { selector: '#ok', textHint: 'h', url: 'https://evil.example/', kind: 'tab', requires: {}, __proto__: { x: 1 } } });
    await b.clickMenu({ menuItemId: 'clawser-extract', frameId: 0, targetElementId: 1 }, PAGE);
    const s = sent[0].msg.request.sources[0];
    assert.equal(s.url, PAGE.url);
    assert.equal(s.kind, 'section');
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(s.section))).sort(), ['selector', 'textHint']);
  });

  it('ignores clicks on non-http(s) tabs, unknown menu ids, and missing tabs', async () => {
    const { b, sent, execCalls } = setup({ capture: { selector: '#a', textHint: 'h' } });
    await b.clickMenu({ menuItemId: 'clawser-extract', frameId: 0 }, { ...PAGE, url: 'chrome://extensions' });
    await b.clickMenu({ menuItemId: 'clawser-extract', frameId: 0 }, { ...PAGE, url: 'file:///etc/passwd' });
    await b.clickMenu({ menuItemId: 'clawser-extract', frameId: 0 }, undefined);
    await b.clickMenu({ menuItemId: 'something-else', frameId: 0 }, PAGE);
    await b.clickMenu({ menuItemId: '__proto__', frameId: 0 }, PAGE);
    assert.equal(sent.length, 0);
    assert.equal(execCalls.length, 0);
  });

  it('sanitises frameId to a non-negative integer', async () => {
    const { b, execCalls } = setup({ capture: { selector: '#a', textHint: 'h' } });
    await b.clickMenu({ menuItemId: 'clawser-extract', frameId: '1; drop', targetElementId: 1 }, PAGE);
    assert.deepEqual(JSON.parse(JSON.stringify(execCalls[0].target.frameIds)), [0]);
  });

  it('strips credentials from the tab URL', async () => {
    const { b, sent } = setup();
    await b.clickMenu({ menuItemId: 'clawser-compare', frameId: 0 }, { ...PAGE, url: 'https://user:secret@shop.example.com/x' });
    assert.equal(sent[0].msg.request.sources[0].url, 'https://shop.example.com/x');
  });
});

// ── captureSectionInPage against a fake DOM ──────────────────────────

function el(tag, attrs = {}, children = [], text = '') {
  const node = { nodeType: 1, tagName: tag.toUpperCase(), id: attrs.id || '', attrs, children, parentElement: null, _text: text,
    getAttribute(n) { return n === 'id' ? (this.id || null) : (n in attrs ? attrs[n] : null); },
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(' '); },
  };
  node.innerText = undefined; // force the textContent path in tests
  for (const c of children) c.parentElement = node;
  return node;
}
function makeDoc(body) {
  const html = el('html', {}, [body]);
  const all = [];
  (function walk(n) { all.push(n); n.children.forEach(walk); })(html);
  const nth = (n) => (n.parentElement ? n.parentElement.children.filter((c) => c.tagName === n.tagName).indexOf(n) + 1 : 1);
  function resolve(sel) {
    // supports: #id | [data-testid="v"] | body | (anchor) ( > tag:nth-of-type(n))*
    const parts = sel.split(' > ');
    const head = parts.shift();
    let cur;
    if (head === 'body') cur = all.filter((n) => n.tagName === 'BODY');
    else if (head.startsWith('#')) cur = all.filter((n) => n.id === head.slice(1));
    else if (head.startsWith('[data-testid=')) cur = all.filter((n) => `[data-testid="${n.attrs['data-testid']}"]` === head);
    else return [];
    for (const p of parts) {
      const m = /^([a-z0-9]+):nth-of-type\((\d+)\)$/.exec(p);
      if (!m) return [];
      cur = cur.flatMap((n) => n.children.filter((c) => c.tagName === m[1].toUpperCase() && nth(c) === Number(m[2])));
    }
    return cur;
  }
  return { documentElement: html, body, querySelectorAll: resolve };
}

function runCapture(doc, target, selectionText = '', anchor = null) {
  const b = loadBackground();
  b.sandbox.document = doc;
  b.sandbox.window = { getSelection: () => ({ toString: () => selectionText, anchorNode: anchor }) };
  b.sandbox.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c) };
  b.chrome.contextMenus.getTargetElement = (id) => (id === 1 ? target : null);
  return JSON.parse(JSON.stringify(b.sandbox.captureSectionInPage(1, selectionText)));
}

describe('captureSectionInPage', () => {
  it('uses a unique id when there is one', () => {
    const t = el('table', { id: 'prices' }, [], 'Plan Price');
    const doc = makeDoc(el('body', {}, [el('div', {}, [t])]));
    const r = runCapture(doc, t);
    assert.equal(r.selector, '#prices');
    assert.equal(r.textHint, 'Plan Price');
  });

  it('falls back to a structural path anchored at body, verified unique', () => {
    const t = el('table', {}, [], 'T2');
    const doc = makeDoc(el('body', {}, [el('div', {}, [el('table', {}, [], 'T1')]), el('div', {}, [t])]));
    const r = runCapture(doc, t);
    assert.equal(r.selector, 'body > div:nth-of-type(2) > table:nth-of-type(1)');
  });

  it('anchors the path on the nearest ancestor with a stable id', () => {
    const t = el('ul', {}, [], 'x');
    const doc = makeDoc(el('body', {}, [el('main', { id: 'content' }, [el('section', {}, [t])])]));
    assert.equal(runCapture(doc, t).selector, '#content > section:nth-of-type(1) > ul:nth-of-type(1)');
  });

  it('prefers data-testid when unique', () => {
    const t = el('div', { 'data-testid': 'price-box' }, [], 'p');
    const doc = makeDoc(el('body', {}, [t]));
    assert.equal(runCapture(doc, t).selector, '[data-testid="price-box"]');
  });

  it('ignores ids that look auto-generated or are duplicated', () => {
    const a = el('div', { id: 'react-aria-12345' }, [], 'a');
    const d1 = el('div', { id: 'dup' }, [], 'd1');
    const d2 = el('div', { id: 'dup' }, [], 'd2');
    const doc = makeDoc(el('body', {}, [a, d1, d2]));
    assert.equal(runCapture(doc, a).selector, 'body > div:nth-of-type(1)');
    assert.equal(runCapture(doc, d2).selector, 'body > div:nth-of-type(3)');
  });

  it('returns selector null when no short unique selector exists', () => {
    let node = el('span', {}, [], 'deep');
    const leaf = node;
    for (let i = 0; i < 200; i++) node = el('div', {}, [node]);
    const doc = makeDoc(el('body', {}, [node]));
    assert.equal(runCapture(doc, leaf).selector, null);
  });

  it('never reads form control values; hint is empty for inputs', () => {
    const t = el('input', { id: 'pw', type: 'password' }, [], 'secret-typed-value');
    const doc = makeDoc(el('body', {}, [t]));
    const r = runCapture(doc, t);
    assert.equal(r.textHint, '');
  });

  it('bounds and flattens the hint', () => {
    const t = el('p', { id: 'p1' }, [], ('word  \n\t ').repeat(1000));
    const doc = makeDoc(el('body', {}, [t]));
    const r = runCapture(doc, t);
    assert.ok(r.textHint.length <= 120);
    assert.ok(!/\s{2}|[\n\t]/.test(r.textHint));
  });

  it('prefers the selected text as the hint', () => {
    const t = el('p', { id: 'p1' }, [], 'long paragraph text');
    const doc = makeDoc(el('body', {}, [t]));
    assert.equal(runCapture(doc, t, 'selected bit').textHint, 'selected bit');
  });

  it('returns nulls when the target element cannot be resolved', () => {
    const doc = makeDoc(el('body', {}, []));
    const r = runCapture(doc, null);
    assert.equal(r.selector, null);
  });
});
