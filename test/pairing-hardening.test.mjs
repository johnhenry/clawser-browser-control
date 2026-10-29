// Run with: node --test test/pairing-hardening.test.mjs
// Pairing, per-origin tokens and capabilities, ext wait, redaction and the audit log.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBackground, TEST_TOKEN } from './_load-background.mjs';
import { el } from './_fake-dom.mjs';

const DEFAULT = 'https://clawser.erisera.com';
const tab = (url, id = 1) => ({ tab: { id, url } });
const UI = { id: 'ext-id', url: 'chrome-extension://ext-id/options.html' };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** A background with NO auto-pairing; returns helpers that talk to it like a content script would. */
function strict(chromeOverrides = {}, opts = {}) {
  const b = loadBackground(chromeOverrides, { ...opts, unpaired: true });
  const hello = (url) => b.sendRaw({ direction: 'hello' }, tab(url));
  const call = (url, action, params = {}, token) => b.sendRaw({ id: 'r1', action, params, token }, tab(url));
  return { ...b, hello, call };
}

describe('pairing: exact-origin allowlist', () => {
  it('does not trust any localhost port, 127.0.0.1 or file: page by default', async () => {
    const b = strict();
    for (const url of ['http://localhost:5173/', 'http://localhost/', 'http://127.0.0.1:4173/', 'file:///tmp/x.html', 'https://example.com/']) {
      const r = await b.call(url, 'status', {}, TEST_TOKEN);
      assert.equal(r.code, 'not_paired', url);
      assert.deepEqual((await b.hello(url)).paired, false, url);
    }
  });

  it('pre-lists the built-in clawser origin and hands the content script a token for it', async () => {
    const b = strict();
    const h = await b.hello(`${DEFAULT}/app`);
    assert.equal(h.paired, true);
    assert.match(h.token, /^[0-9a-f]{64}$/);
    assert.deepEqual((await b.call(`${DEFAULT}/`, 'status', {}, h.token)).result.connected, true);
  });

  it('pre-lists the configured custom origin, but only that exact origin', async () => {
    const b = strict({}, { storage: { clawserOrigin: 'https://c.example.com' } });
    assert.equal((await b.hello('https://c.example.com/x')).paired, true);
    assert.equal((await b.hello('https://c.example.com:444/x')).paired, false);
    assert.equal((await b.hello('http://c.example.com/x')).paired, false);
  });

  it('a person pairs one localhost port in the extension UI; other ports stay unpaired', async () => {
    const b = strict();
    assert.equal((await b.hello('http://localhost:5173/')).paired, false);
    const overview = await b.sendUi({ action: 'pairing_overview' });
    assert.deepEqual([...overview.result.pending], ['http://localhost:5173']); // visible to the person, not yet trusted
    const added = await b.sendUi({ action: 'pairing_add', origin: 'http://localhost:5173' }, UI);
    assert.equal(added.result.ok, true);
    const h = await b.hello('http://localhost:5173/page');
    assert.equal(h.paired, true);
    assert.equal((await b.hello('http://localhost:4173/')).paired, false);
    assert.equal((await b.hello('https://localhost:5173/')).paired, false);
    assert.deepEqual([...(await b.sendUi({ action: 'pairing_overview' })).result.pending], ['http://localhost:4173', 'https://localhost:5173']);
  });

  it('refuses to pair file:, wildcards, paths and arbitrary hosts', async () => {
    const b = strict();
    for (const o of ['file:///tmp/x.html', 'http://localhost:5173/app', 'http://*.localhost', 'https://evil.example', 'http://192.168.1.2:3000', '', null, 5]) {
      const r = await b.sendUi({ action: 'pairing_add', origin: o });
      assert.equal(r.result.ok, false, String(o));
    }
  });

  it('cannot be paired from a page: not by a page message, not by a UI message from a tab', async () => {
    const b = strict();
    const asPage = await b.sendRaw({ id: 1, action: 'pairing_add', params: { origin: 'http://localhost:5173' }, token: TEST_TOKEN }, tab('http://localhost:5173/'));
    assert.equal(asPage.code, 'not_paired');
    const forged = await b.sendUi({ action: 'pairing_add', origin: 'http://localhost:5173' }, tab('http://localhost:5173/'));
    assert.match(forged.error, /Not allowed/);
    assert.equal((await b.hello('http://localhost:5173/')).paired, false);
  });

  it('unpairing removes access', async () => {
    const b = strict();
    await b.sendUi({ action: 'pairing_add', origin: 'http://localhost:5173' });
    const { token } = await b.hello('http://localhost:5173/');
    assert.equal((await b.call('http://localhost:5173/', 'status', {}, token)).result.connected, true);
    await b.sendUi({ action: 'pairing_remove', origin: 'http://localhost:5173' });
    assert.equal((await b.call('http://localhost:5173/', 'status', {}, token)).code, 'not_paired');
  });
});

describe('pairing: token checked in the background on every message', () => {
  it('rejects a missing, wrong or other-origin token for requests', async () => {
    const b = strict();
    await b.sendUi({ action: 'pairing_add', origin: 'http://localhost:5173' });
    const a = await b.hello('http://localhost:5173/');
    const c = await b.hello(`${DEFAULT}/`);
    assert.notEqual(a.token, c.token);
    for (const token of [undefined, '', 'nope', c.token, a.token + 'x']) {
      assert.equal((await b.call('http://localhost:5173/', 'status', {}, token)).code, 'bad_token', String(token));
    }
    assert.equal((await b.call('http://localhost:5173/', 'status', {}, a.token)).result.connected, true);
  });

  it('a re-paired origin gets a new token; the old one stops working', async () => {
    const b = strict();
    await b.sendUi({ action: 'pairing_add', origin: 'http://localhost:5173' });
    const old = (await b.hello('http://localhost:5173/')).token;
    await b.sendUi({ action: 'pairing_remove', origin: 'http://localhost:5173' });
    await b.sendUi({ action: 'pairing_add', origin: 'http://localhost:5173' });
    assert.equal((await b.call('http://localhost:5173/', 'status', {}, old)).code, 'bad_token');
  });

  it('drops notify and cancel without a valid token', async () => {
    const b = strict();
    const { token } = await b.hello(`${DEFAULT}/`);
    const sender = tab(`${DEFAULT}/`, 5);
    const sync = (t) => b.hooks.listener({ type: '__clawser_ext__', direction: 'notify', action: 'routines_sync', wsId: 'ws1', routines: [{ id: 'a', name: 'a', trigger: { type: 'cron', cron: '* * * * *' }, enabled: true }], token: t }, sender, () => {});
    sync(undefined); sync('bad'); await tick(20);
    assert.equal([...b.idbStore.keys()].length, 0);
    // a cancel without a token must not abort a running request
    let release; const gate = new Promise((r) => { release = r; });
    const slow = strict({ scripting: { executeScript: async () => { await gate; return [{ result: { clicked: 'x' } }]; } } });
    const t2 = (await slow.hello(`${DEFAULT}/`)).token;
    const replies = [];
    slow.hooks.listener({ type: '__clawser_ext__', id: 'c1', action: 'click', params: { selector: '#a' }, token: t2 }, tab(`${DEFAULT}/`), (r) => replies.push(r));
    await tick(20);
    slow.hooks.listener({ type: '__clawser_ext__', direction: 'cancel', id: 'c1' }, tab(`${DEFAULT}/`), () => {});
    await tick(20);
    assert.equal(replies.length, 0);
    release(); await tick(20);
    assert.equal(replies[0].result.clicked, 'x');
  });

  it('records refused attempts in the audit log', async () => {
    const b = strict();
    await b.call('http://localhost:5173/', 'status', {}, 'x');
    const log = (await b.sendUi({ action: 'audit_get' })).result.entries;
    assert.equal(log.at(-1).success, false);
    assert.equal(log.at(-1).error, 'not_paired');
  });
});

describe('stored custom origin', () => {
  it('ignores a corrupt or hostile stored value: nothing is pre-listed from it', async () => {
    for (const bad of ['*://*/*', 'http://evil.example.com', 'https://evil.example.com/path', '<all_urls>', 42, null]) {
      const b = strict({}, { storage: { clawserOrigin: bad } });
      assert.equal((await b.hello('https://evil.example.com/')).paired, false, String(bad));
    }
  });
});

describe('capabilities per origin', () => {
  const GATED = [['evaluate', { script: '1+1' }], ['cookies', { url: 'https://a.test/' }], ['cors_fetch', { url: 'https://a.test/' }], ['inject_pod', { tabId: 2 }]];

  it('evaluate, cookies, cors_fetch and inject_pod are off by default and announced as off', async () => {
    const b = strict();
    const { token, capabilities } = await b.hello(`${DEFAULT}/`);
    for (const [action, params] of GATED) {
      const r = await b.call(`${DEFAULT}/`, action, params, token);
      assert.equal(r.code, 'capability_disabled', action);
    }
    for (const c of ['evaluate', 'cookies', 'cors_fetch', 'inject_pod']) assert.ok(!capabilities.includes(c), c);
    assert.ok(capabilities.includes('tabs'));
    const caps = (await b.call(`${DEFAULT}/`, 'get_available_capabilities', {}, token)).result;
    assert.ok(!caps.includes('cors_fetch') && !caps.includes('cookies'));
  });

  it('a person enables one capability for one origin only', async () => {
    const b = strict();
    await b.sendUi({ action: 'pairing_add', origin: 'http://localhost:5173' });
    const other = (await b.hello(`${DEFAULT}/`)).token;
    const mine = (await b.hello('http://localhost:5173/')).token;
    const set = await b.sendUi({ action: 'pairing_set_capability', origin: 'http://localhost:5173', capability: 'evaluate', enabled: true });
    assert.equal(set.result.ok, true);
    assert.equal((await b.call('http://localhost:5173/', 'evaluate', { script: '1+1' }, mine)).result.result, 2);
    assert.equal((await b.call(`${DEFAULT}/`, 'evaluate', { script: '1+1' }, other)).code, 'capability_disabled');
    assert.equal((await b.call('http://localhost:5173/', 'cookies', { url: 'https://a.test/' }, mine)).code, 'capability_disabled');
    assert.ok((await b.hello('http://localhost:5173/')).capabilities.includes('evaluate'));
  });

  it('cannot be enabled from a page', async () => {
    const b = strict();
    const { token } = await b.hello(`${DEFAULT}/`);
    const r = await b.call(`${DEFAULT}/`, 'pairing_set_capability', { origin: DEFAULT, capability: 'evaluate', enabled: true }, token);
    assert.match(r.error, /Unknown action/);
    const forged = await b.sendUi({ action: 'pairing_set_capability', origin: DEFAULT, capability: 'evaluate', enabled: true }, tab(`${DEFAULT}/`));
    assert.match(forged.error, /Not allowed/);
    assert.equal((await b.call(`${DEFAULT}/`, 'evaluate', { script: '1' }, token)).code, 'capability_disabled');
  });
});

describe('audit log is append-only from a page', () => {
  it('audit_log ignores clear; only the extension UI clears it', async () => {
    const b = loadBackground();
    await b.send('status', {});
    await b.send('status', {});
    const first = (await b.send('audit_log', { clear: true })).result.entries.length;
    assert.ok(first >= 2);
    const second = (await b.send('audit_log', {})).result.entries.length;
    assert.ok(second > first - 1, 'entries survived a page-side clear');
    const forged = await b.sendUi({ action: 'audit_clear' }, tab('https://example.com/'));
    assert.match(forged.error, /Not allowed/);
    assert.ok((await b.send('audit_log', {})).result.entries.length >= second);
    const cleared = await b.sendUi({ action: 'audit_clear' });
    assert.equal(cleared.result.ok, true);
    assert.ok((await b.sendUi({ action: 'audit_get' })).result.entries.length <= 1);
  });
});

describe('wait: selector or text only', () => {
  function waiter(doc) {
    let sandbox;
    const b = loadBackground({
      scripting: { executeScript: async ({ func, args }) => { sandbox.window = {}; sandbox.document = doc; return [{ result: await func(...args) }]; } },
    });
    sandbox = b.sandbox;
    sandbox.Date = Date;
    return b;
  }

  it('rejects a condition expression and never evaluates it', async () => {
    let evaluated = false;
    const b = waiter({ querySelector: () => null, body: { innerText: '' } });
    b.sandbox.__probe = () => { evaluated = true; };
    const r = await b.send('wait', { condition: '__probe() || true' });
    assert.match(r.error, /condition/);
    const r2 = await b.send('wait', { selector: '#a', condition: '1' });
    assert.match(r2.error, /condition/);
    assert.equal(evaluated, false);
  });

  it('waits for a selector or for visible text', async () => {
    const b = waiter({ querySelector: (s) => (s === '#here' ? {} : null), body: { innerText: 'Order complete' } });
    assert.equal((await b.send('wait', { selector: '#here', timeout: 500 })).result.found, true);
    assert.equal((await b.send('wait', { text: 'Order complete', timeout: 500 })).result.found, true);
    assert.equal((await b.send('wait', { text: 'nope', timeout: 50 })).result.timeout, true);
  });

  it('needs a selector or text', async () => {
    const b = waiter({});
    assert.match((await b.send('wait', {})).error, /selector or text/);
  });

  it('background.js no longer evals the wait condition', () => {
    const src = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
    const waitFn = src.slice(src.indexOf('async function actionWait('), src.indexOf('async function actionWaitCancel'));
    assert.ok(!/eval/.test(waitFn.replace(/never evaluates|no longer evals|eval path/g, '')));
  });
});

describe('redaction of sensitive fields', () => {
  const sensitive = [
    ['password', { type: 'password' }],
    ['cc-number', { type: 'text', autocomplete: 'cc-number' }],
    ['cc-csc with section token', { type: 'text', autocomplete: 'section-pay cc-csc' }],
    ['one-time-code', { type: 'text', autocomplete: 'one-time-code' }],
    ['card number by name', { type: 'text', name: 'cardNumber' }],
    ['cvc by id', { type: 'text', id: 'cvc' }],
    ['otp by name', { type: 'text', name: 'otp' }],
  ];
  const plain = { type: 'text', name: 'username' };

  function readPage(inputs) {
    let sandbox;
    const body = el('body', {}, inputs.map((a) => el('input', { ...a, value: 'SECRET-VALUE' })));
    const b = loadBackground({ scripting: { executeScript: async ({ func, args }) => { sandbox.document = { body }; return [{ result: await func(...args) }]; } } });
    sandbox = b.sandbox;
    return b.send('read_page', {});
  }

  it('read_page redacts the value of each sensitive field and keeps ordinary ones', async () => {
    const r = await readPage([...sensitive.map(([, a]) => a), plain]);
    const kids = JSON.parse(JSON.stringify(r.result.tree.children));
    for (let i = 0; i < sensitive.length; i++) assert.equal(kids[i].value, '[redacted]', sensitive[i][0]);
    assert.equal(kids.at(-1).value, 'SECRET-VALUE');
    assert.ok(!JSON.stringify(r).includes('SECRET-VALUE') || kids.at(-1).value === 'SECRET-VALUE');
  });

  /** A node with just what get_html and the watcher touch. */
  function fakeNode(tag, attrs = {}, children = [], text = '') {
    const n = {
      nodeType: 1, tagName: tag.toUpperCase(), attrs: { ...attrs }, children, _text: text,
      getAttribute(k) { return k in this.attrs ? String(this.attrs[k]) : null; },
      setAttribute(k, v) { this.attrs[k] = v; },
      removeAttribute(k) { delete this.attrs[k]; },
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
      set textContent(v) { this._text = v; this.children = []; },
      cloneNode() { return fakeNode(tag, this.attrs, this.children.map((c) => c.cloneNode()), this._text); },
      querySelectorAll(sel) {
        const tags = sel.split(',').map((s) => s.trim().toUpperCase());
        const out = [];
        (function w(x) { for (const c of x.children) { if (tags.includes(c.tagName)) out.push(c); w(c); } })(this);
        return out;
      },
      get outerHTML() {
        const a = Object.entries(this.attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
        return `<${tag}${a}>${this._text}${this.children.map((c) => c.outerHTML).join('')}</${tag}>`;
      },
    };
    return n;
  }

  it('get_html blanks sensitive values (strip and not) without touching the page', async () => {
    const live = fakeNode('div', {}, [
      ...sensitive.map(([, a]) => fakeNode('input', { ...a, value: 'SECRET-VALUE' })),
      fakeNode('textarea', { autocomplete: 'one-time-code' }, [], 'SECRET-VALUE'),
      fakeNode('input', { ...plain, value: 'public' }),
    ]);
    let sandbox;
    const b = loadBackground({ scripting: { executeScript: async ({ func, args }) => { sandbox.document = { documentElement: live, querySelector: () => live, createTreeWalker: () => ({ nextNode: () => null }) }; return [{ result: await func(...args) }]; } } });
    sandbox = b.sandbox;
    for (const strip of [false, true]) {
      const { result } = await b.send('get_html', { strip });
      assert.ok(!result.html.includes('SECRET-VALUE'), `strip=${strip}`);
      assert.ok(result.html.includes('value="public"'));
    }
    assert.equal(live.children[0].attrs.value, 'SECRET-VALUE'); // the live page is untouched
  });

  it('watch buffers redact sensitive text', async () => {
    const msg = fakeNode('div', {}, [fakeNode('span', {}, [], 'hello '), fakeNode('textarea', { name: 'otp' }, [], 'SECRET-VALUE')]);
    let observer;
    let sandbox;
    const b = loadBackground({ scripting: { executeScript: async ({ func, args }) => {
      sandbox.document = { querySelector: () => fakeNode('div', {}, []) };
      sandbox.window = sandbox.window || {};
      sandbox.MutationObserver = class { constructor(cb) { observer = cb; } observe() {} disconnect() {} };
      return [{ result: await func(...args) }];
    } } });
    sandbox = b.sandbox;
    await b.send('tab_watch_start', { selector: '#c' });
    observer([{ addedNodes: [msg] }]);
    const buf = sandbox.window.__clawserWatchBuffer;
    assert.equal(buf.length, 1);
    assert.ok(!buf[0].text.includes('SECRET-VALUE'));
    assert.ok(buf[0].text.includes('hello'));
  });

  it('the three in-page redaction helpers are identical', () => {
    const src = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
    const copies = [...src.matchAll(/const isSensitiveField = \(el\) => \{[\s\S]*?\n(\s*)\};\n/g)].map((m) => m[0].replace(/^\s+/gm, ''));
    assert.equal(copies.length, 3);
    assert.equal(copies[0], copies[1]);
    assert.equal(copies[1], copies[2]);
  });
});
