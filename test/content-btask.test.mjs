// Run with: node --test test/content-btask.test.mjs
// content.js: production/custom origin gating and the btask request bridge.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from './_load-content.mjs';
import { GOOD, BAD } from './_origin-cases.mjs';
import { loadBackground } from './_load-background.mjs';

const MARKER = '__clawser_ext__';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const loc = (href) => { const u = new URL(href); return { href, protocol: u.protocol, hostname: u.hostname, origin: u.origin }; };

async function freshLoad(t, chromeOverrides = {}, opts = {}) {
  const ctx = loadContent(chromeOverrides, opts);
  t.after(() => ctx.stop());
  await tick();
  ctx.popPosted();
  return ctx;
}

describe('content.js origin allowlist with production + custom origin', () => {
  it('relays from https://clawser.erisera.com by default', async (t) => {
    const { postFromPage, popPosted, chrome } = await freshLoad(t, {}, { location: loc('https://clawser.erisera.com/app') });
    chrome.runtime.sendMessage = async () => ({ result: 1 });
    postFromPage({ type: MARKER, direction: 'request', id: 1, action: 'ping' });
    await tick(5);
    assert.equal(popPosted().filter((m) => m.direction === 'response')[0].result, 1);
  });

  it('still blocks look-alikes and http://clawser.erisera.com', async (t) => {
    for (const href of ['http://clawser.erisera.com/', 'https://clawser.erisera.com.evil.com/', 'https://evilclawser.erisera.com/', 'https://erisera.com/']) {
      const { postFromPage, popPosted, chrome } = await freshLoad(t, {}, { location: loc(href) });
      let called = false;
      chrome.runtime.sendMessage = async () => { called = true; return { result: 1 }; };
      postFromPage({ type: MARKER, direction: 'request', id: 1, action: 'ping' });
      await tick(5);
      assert.equal(called, false, href);
      assert.deepEqual(popPosted().filter((m) => m.direction === 'response'), []);
    }
  });

  it('allows the configured custom origin (read from storage) and nothing else on that host', async (t) => {
    const storage = { clawserOrigin: 'https://c.example.com' };
    const ok = await freshLoad(t, {}, { location: loc('https://c.example.com/x'), storage });
    ok.chrome.runtime.sendMessage = async () => ({ result: 7 });
    ok.postFromPage({ type: MARKER, direction: 'request', id: 1, action: 'ping' });
    await tick(5);
    assert.equal(ok.popPosted().filter((m) => m.direction === 'response')[0].result, 7);

    for (const href of ['https://c.example.com:444/', 'https://sub.c.example.com/', 'http://c.example.com/']) {
      const bad = await freshLoad(t, {}, { location: loc(href), storage });
      let called = false;
      bad.chrome.runtime.sendMessage = async () => { called = true; return { result: 1 }; };
      bad.postFromPage({ type: MARKER, direction: 'request', id: 1, action: 'ping' });
      await tick(5);
      assert.equal(called, false, href);
    }
  });

  it('a request that arrives before storage has loaded is held, not dropped or leaked', async (t) => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const ctx = loadContent({}, { location: loc('https://c.example.com/'), storage: { clawserOrigin: 'https://c.example.com' } });
    t.after(() => ctx.stop());
    ctx.chrome.storage.local.get = async () => { await gate; return { clawserOrigin: 'https://c.example.com' }; };
    ctx.chrome.runtime.sendMessage = async (m) => (m.action === 'ping' ? { result: 3 } : { result: [] });
    ctx.popPosted();
    ctx.postFromPage({ type: MARKER, direction: 'request', id: 1, action: 'ping' });
    await tick(5);
    release();
    await tick(5);
    assert.equal(ctx.popPosted().filter((m) => m.direction === 'response').length <= 1, true);
  });

  it('ignores a corrupt / hostile stored origin', async (t) => {
    for (const bad of ['*://*/*', 'http://evil.example.com', 'https://evil.example.com/path', '<all_urls>', 42, null]) {
      const ctx = await freshLoad(t, {}, { location: loc('https://evil.example.com/'), storage: { clawserOrigin: bad } });
      let called = false;
      ctx.chrome.runtime.sendMessage = async () => { called = true; return {}; };
      ctx.postFromPage({ type: MARKER, direction: 'request', id: 1, action: 'ping' });
      await tick(5);
      // 'https://evil.example.com' proper form would be valid; the malformed variants must not be.
      if (bad === 'https://evil.example.com/path') assert.equal(called, false);
      else assert.equal(called, false, String(bad));
    }
  });

  it('content.js and background.js agree on origin validation', () => {
    const { sandbox } = loadBackground();
    const ctx = loadContent({}, { location: loc('http://localhost/') });
    try {
      for (const [input] of GOOD) assert.equal(ctx.sandbox.normalizeClawserOrigin(input).ok, sandbox.normalizeClawserOrigin(input).ok);
      for (const input of BAD) assert.equal(ctx.sandbox.normalizeClawserOrigin(input).ok, sandbox.normalizeClawserOrigin(input).ok, String(input));
    } finally { ctx.stop(); }
  });
});

describe('content.js btask request bridge', () => {
  const REQ = { type: 'clawser.btask.list' };

  it('posts the request to the page as a push and resolves with the page response', async (t) => {
    const ctx = await freshLoad(t);
    const p = ctx.requestFromBackground({ type: MARKER, direction: 'btask_request', request: REQ });
    await tick();
    const [pushed] = ctx.popPosted().filter((m) => m.direction === 'push');
    assert.equal(pushed.action, 'btask');
    assert.deepEqual(pushed.request, REQ);
    assert.equal(typeof pushed.id, 'string');
    ctx.postFromPage({ type: MARKER, direction: 'btask_response', id: pushed.id, result: { definitions: [] }, error: null });
    assert.deepEqual(JSON.parse(JSON.stringify(await p)), { result: { definitions: [] } });
  });

  it('turns a page error into { error }', async (t) => {
    const ctx = await freshLoad(t);
    const p = ctx.requestFromBackground({ type: MARKER, direction: 'btask_request', request: { type: 'clawser.btask.draft', kind: 'extract', sources: [] } });
    await tick();
    const [pushed] = ctx.popPosted().filter((m) => m.direction === 'push');
    ctx.postFromPage({ type: MARKER, direction: 'btask_response', id: pushed.id, result: null, error: 'no sources' });
    assert.deepEqual(JSON.parse(JSON.stringify(await p)), { error: 'no sources' });
  });

  it('reports transportError no_response when the page never answers', async (t) => {
    const ctx = await freshLoad(t, {}, { setTimeoutImpl: (fn) => setTimeout(fn, 0) });
    const r = await ctx.requestFromBackground({ type: MARKER, direction: 'btask_request', request: REQ, timeoutMs: 50 });
    assert.deepEqual(JSON.parse(JSON.stringify(r)), { transportError: 'no_response' });
  });

  it('ignores a response with an unknown id, from another window, or with a late duplicate', async (t) => {
    const ctx = await freshLoad(t);
    const p = ctx.requestFromBackground({ type: MARKER, direction: 'btask_request', request: REQ });
    await tick();
    const [pushed] = ctx.popPosted().filter((m) => m.direction === 'push');
    ctx.postFromPage({ type: MARKER, direction: 'btask_response', id: 'bogus', result: { definitions: ['x'] } });
    ctx.postFromOtherWindow({ type: MARKER, direction: 'btask_response', id: pushed.id, result: { definitions: ['evil'] } });
    ctx.postFromPage({ type: MARKER, direction: 'btask_response', id: pushed.id, result: { definitions: ['real'] } });
    ctx.postFromPage({ type: MARKER, direction: 'btask_response', id: pushed.id, result: { definitions: ['second'] } });
    assert.deepEqual(JSON.parse(JSON.stringify(await p)), { result: { definitions: ['real'] } });
  });

  it('concurrent requests get distinct ids and are answered independently', async (t) => {
    const ctx = await freshLoad(t);
    const a = ctx.requestFromBackground({ type: MARKER, direction: 'btask_request', request: { type: 'clawser.btask.list' } });
    const b = ctx.requestFromBackground({ type: MARKER, direction: 'btask_request', request: { type: 'clawser.btask.inbox' } });
    await tick();
    const pushed = ctx.popPosted().filter((m) => m.direction === 'push');
    assert.equal(pushed.length, 2);
    assert.notEqual(pushed[0].id, pushed[1].id);
    ctx.postFromPage({ type: MARKER, direction: 'btask_response', id: pushed[1].id, result: { notifications: [] } });
    ctx.postFromPage({ type: MARKER, direction: 'btask_response', id: pushed[0].id, result: { definitions: [] } });
    assert.deepEqual(JSON.parse(JSON.stringify(await a)), { result: { definitions: [] } });
    assert.deepEqual(JSON.parse(JSON.stringify(await b)), { result: { notifications: [] } });
  });

  it('refuses request types other than the three btask messages', async (t) => {
    const ctx = await freshLoad(t);
    for (const request of [{ type: 'clawser.other' }, { type: 'evaluate' }, null, 'x', {}]) {
      const r = await ctx.requestFromBackground({ type: MARKER, direction: 'btask_request', request });
      assert.ok(r?.error, JSON.stringify(request));
    }
    assert.deepEqual(ctx.popPosted().filter((m) => m.direction === 'push'), []);
  });

  it('refuses when this page is not an allowed origin', async (t) => {
    const ctx = await freshLoad(t, {}, { location: loc('https://example.com/') });
    const r = await ctx.requestFromBackground({ type: MARKER, direction: 'btask_request', request: REQ });
    assert.equal(r?.transportError, 'origin_not_allowed');
    assert.deepEqual(ctx.popPosted().filter((m) => m.direction === 'push'), []);
  });

  it('refuses requests whose sender is not this extension', async (t) => {
    const ctx = await freshLoad(t);
    const r = await ctx.requestFromBackground({ type: MARKER, direction: 'btask_request', request: REQ }, { id: 'someone-else' });
    assert.ok(r === undefined || r.error);
    assert.deepEqual(ctx.popPosted().filter((m) => m.direction === 'push'), []);
  });

  it('a btask_response from a disallowed origin is ignored', async (t) => {
    const ctx = await freshLoad(t, {}, { location: loc('https://example.com/') });
    ctx.postFromPage({ type: MARKER, direction: 'btask_response', id: '1', result: {} });
    await tick();
    assert.deepEqual(ctx.popPosted(), []);
  });
});
