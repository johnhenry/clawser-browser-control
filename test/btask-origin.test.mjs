// Run with: node --test test/btask-origin.test.mjs
// Configurable clawser origin: validation, storage, dynamic content-script
// registration, and who may change it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './_load-background.mjs';

import { GOOD, BAD } from './_origin-cases.mjs';

describe('normalizeClawserOrigin', () => {
  const { sandbox } = loadBackground();
  for (const [input, want] of GOOD) {
    it(`accepts ${JSON.stringify(input)}`, () => {
      assert.deepEqual({ ...sandbox.normalizeClawserOrigin(input) }, { ok: true, origin: want });
    });
  }
  for (const input of BAD) {
    it(`rejects ${JSON.stringify(input)?.slice(0, 40)}`, () => {
      const r = sandbox.normalizeClawserOrigin(input);
      assert.equal(r.ok, false);
      assert.equal(typeof r.error, 'string');
    });
  }
});

describe('isClawserUrl', () => {
  const { sandbox } = loadBackground();
  const yes = ['http://localhost:5173/x', 'https://localhost/', 'http://127.0.0.1:8080/', 'file:///a/b.html', 'https://clawser.erisera.com/'];
  const no = ['https://evil.localhost.attacker.com/', 'https://localhost.attacker.com/', 'http://clawser.erisera.com/',
    'https://clawser.erisera.com.evil.com/', 'https://example.com/', 'chrome://extensions', 'not a url', '', null];
  for (const u of yes) it(`true for ${u}`, () => assert.equal(sandbox.isClawserUrl(u, null), true));
  for (const u of no) it(`false for ${u}`, () => assert.equal(sandbox.isClawserUrl(u, null), false));
  it('honours the custom origin exactly', () => {
    assert.equal(sandbox.isClawserUrl('https://c.example.com/app', 'https://c.example.com'), true);
    assert.equal(sandbox.isClawserUrl('https://c.example.com:444/app', 'https://c.example.com'), false);
    assert.equal(sandbox.isClawserUrl('https://x.c.example.com/', 'https://c.example.com'), false);
  });
});

describe('set_clawser_origin (options page)', () => {
  it('stores a valid origin and registers a content script for exactly that origin', async () => {
    const b = loadBackground();
    const r = await b.sendUi({ action: 'set_clawser_origin', origin: 'https://c.example.com/' }, { id: 'ext-id', url: 'chrome-extension://ext-id/options.html' });
    assert.equal(r.result.ok, true);
    assert.equal(b.localStore.clawserOrigin, 'https://c.example.com');
    assert.equal(b.registered.length, 1);
    assert.deepEqual([...b.registered[0].matches], ['https://c.example.com/*']);
    assert.deepEqual([...b.registered[0].js], ['content.js']);
    assert.equal(b.registered[0].persistAcrossSessions, true);
  });

  it('replaces (never accumulates) the registration on a second change', async () => {
    const b = loadBackground();
    const s = { id: 'ext-id', url: 'chrome-extension://ext-id/options.html' };
    await b.sendUi({ action: 'set_clawser_origin', origin: 'https://one.example.com' }, s);
    await b.sendUi({ action: 'set_clawser_origin', origin: 'https://two.example.com' }, s);
    assert.equal(b.registered.length, 1);
    assert.deepEqual([...b.registered[0].matches], ['https://two.example.com/*']);
  });

  it('concurrent changes end with exactly one registration matching the stored value', async () => {
    const b = loadBackground();
    const s = { id: 'ext-id', url: 'chrome-extension://ext-id/options.html' };
    await Promise.all(['a', 'b', 'c', 'd'].map((x) => b.sendUi({ action: 'set_clawser_origin', origin: `https://${x}.example.com` }, s)));
    assert.equal(b.registered.length, 1);
    assert.deepEqual([...b.registered[0].matches], [`${b.localStore.clawserOrigin}/*`]);
  });

  it('rejects invalid input without storing or registering anything', async () => {
    const b = loadBackground();
    const r = await b.sendUi({ action: 'set_clawser_origin', origin: 'https://*.example.com' }, { id: 'ext-id', url: 'chrome-extension://ext-id/options.html' });
    assert.equal(r.result.ok, false);
    assert.equal(b.localStore.clawserOrigin, undefined);
    assert.equal(b.registered.length, 0);
  });

  it('reset clears storage and the registration', async () => {
    const b = loadBackground();
    const s = { id: 'ext-id', url: 'chrome-extension://ext-id/options.html' };
    await b.sendUi({ action: 'set_clawser_origin', origin: 'https://c.example.com' }, s);
    const r = await b.sendUi({ action: 'set_clawser_origin', origin: '' }, s);
    assert.equal(r.result.ok, true);
    assert.equal(b.localStore.clawserOrigin, undefined);
    assert.equal(b.registered.length, 0);
  });

  it('refuses callers that are not an extension page (content script, web page, other extension)', async () => {
    const b = loadBackground();
    const callers = [
      { id: 'ext-id', tab: { id: 3, url: 'http://localhost/x' }, url: 'http://localhost/x' }, // content script in a tab
      { id: 'other-ext', url: 'chrome-extension://other-ext/options.html' },
      { id: 'ext-id', url: 'https://evil.example/' },
      {},
    ];
    for (const sender of callers) {
      const r = await b.sendUi({ action: 'set_clawser_origin', origin: 'https://c.example.com' }, sender);
      assert.ok(r?.error, `should refuse ${JSON.stringify(sender)}`);
    }
    assert.equal(b.localStore.clawserOrigin, undefined);
    assert.equal(b.registered.length, 0);
  });

  it('cannot be reached through the page relay (MARKER action) at all', async () => {
    const b = loadBackground();
    const r = await b.send('set_clawser_origin', { origin: 'https://evil.example.com' }, { tab: { id: 1, url: 'http://localhost/' } });
    assert.match(r.error, /Unknown action/i);
    assert.equal(b.localStore.clawserOrigin, undefined);
  });

  it('get_clawser_origin returns the stored value or the default', async () => {
    const b = loadBackground({}, { storage: { clawserOrigin: 'https://c.example.com' } });
    const s = { id: 'ext-id', url: 'chrome-extension://ext-id/options.html' };
    const r = await b.sendUi({ action: 'get_clawser_origin' }, s);
    assert.equal(r.result.origin, 'https://c.example.com');
    assert.equal(r.result.defaultOrigin, 'https://clawser.erisera.com');
  });

  it('ignores a corrupted stored origin (treated as unset)', async () => {
    const b = loadBackground({}, { storage: { clawserOrigin: 'http://evil.example.com/*' } });
    const r = await b.sendUi({ action: 'get_clawser_origin' }, { id: 'ext-id', url: 'chrome-extension://ext-id/options.html' });
    assert.equal(r.result.origin, null);
  });
});
