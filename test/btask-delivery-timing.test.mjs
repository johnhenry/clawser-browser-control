// Run with: node --test test/btask-delivery-timing.test.mjs
// Delivery must fail fast when clawser is open but nothing answers (virtual clock, no real waiting).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './_load-background.mjs';

/** Virtual clock: timers fire in order as time is advanced; microtasks are flushed between steps. */
function clock() {
  let now = 0; let seq = 0; const timers = [];
  return {
    get now() { return now; },
    setTimeout(fn, ms = 0) { const id = ++seq; timers.push({ id, at: now + ms, fn }); return id; },
    clearTimeout(id) { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    async run(promise, limit = 600000) {
      let done = false; let value; let error;
      promise.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
      while (!done) {
        for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
        if (done) break;
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const t = timers.shift();
        if (!t) throw new Error('deadlock: no timers and promise pending');
        now = t.at; if (now > limit) throw new Error('virtual time limit exceeded');
        t.fn();
      }
      if (error) throw error;
      return value;
    },
  };
}

const PANEL = { id: 'ext-id', url: 'chrome-extension://ext-id/sidepanel.html' };
const NEWS = { id: 11, windowId: 7, url: 'https://news.example.com/a', title: 'News' };

function boot(tabs, onSend) {
  const vt = clock();
  const calls = [];
  const all = [...tabs];
  const b = loadBackground({
    tabs: {
      query: async () => all.map((t) => ({ ...t })),
      get: async (id) => { const t = all.find((x) => x.id === id); if (!t) throw new Error('gone'); return { ...t }; },
      create: async (o) => { const t = { id: 900, windowId: 7, url: o.url }; all.push(t); return t; },
      update: async () => ({ windowId: 7 }),
      sendMessage: async (tabId, msg) => { calls.push({ at: vt.now, tabId, type: msg.request?.type, timeoutMs: msg.timeoutMs }); return onSend(tabId, msg, vt); },
    },
    windows: { update: async () => ({}) },
  }, { setTimeoutImpl: (fn, ms) => vt.setTimeout(fn, ms) });
  b.sandbox.clearTimeout = (id) => vt.clearTimeout(id);
  return { b, vt, calls };
}

// A page whose content script is there but nothing answers: the reply only comes back after the timeout asked for.
const silent = (_t, msg, vt) => new Promise((r) => vt.setTimeout(() => r({ transportError: 'no_response' }), msg.timeoutMs || 5000));

describe('delivery is quick when clawser has no receiver', () => {
  it('pings first with a short timeout and skips tabs that do not answer', async () => {
    const tabs = [1, 2, 3, 4, 5].map((i) => ({ id: 50 + i, windowId: 7, url: 'https://clawser.erisera.com/', lastAccessed: i }));
    const { b, vt, calls } = boot([...tabs, NEWS], silent);
    const r = await vt.run(b.sendUi({ action: 'btask_list' }, PANEL));
    assert.deepEqual(JSON.parse(JSON.stringify(r.result)), { connected: false });
    assert.ok(calls.every((c) => c.type === 'clawser.btask.ping'), 'the full request is never sent to a silent tab');
    assert.ok(calls.every((c) => c.timeoutMs <= 1500));
    assert.ok(vt.now <= 6000, `took ${vt.now}ms of virtual time`);
  });

  it('a tab that answers the ping then gets the real request', async () => {
    const { b, vt, calls } = boot([{ id: 50, windowId: 7, url: 'https://clawser.erisera.com/', lastAccessed: 1 }, NEWS],
      (_t, msg) => ({ result: msg.request.type === 'clawser.btask.ping' ? { pong: true } : { definitions: [] } }));
    const r = await vt.run(b.sendUi({ action: 'btask_list' }, PANEL));
    assert.equal(r.result.connected, true);
    assert.deepEqual(calls.map((c) => c.type), ['clawser.btask.ping', 'clawser.btask.list']);
  });

  it('an error reply to the ping still counts as a live receiver', async () => {
    const { b, vt, calls } = boot([{ id: 50, windowId: 7, url: 'https://clawser.erisera.com/', lastAccessed: 1 }, NEWS],
      (_t, msg) => (msg.request.type === 'clawser.btask.ping' ? { error: 'unsupported request' } : { result: { definitions: [] } }));
    const r = await vt.run(b.sendUi({ action: 'btask_list' }, PANEL));
    assert.equal(r.result.connected, true);
    assert.equal(calls.length, 2);
  });

  it('opening clawser and never getting an answer gives up within about 20 seconds and shows the badge', async () => {
    const { b, vt } = boot([NEWS], silent);
    await vt.run(b.clickMenu({ menuItemId: 'clawser-extract-page', frameId: 0 }, { id: 11, windowId: 7, url: NEWS.url, title: 'News' }));
    assert.ok(vt.now <= 21000, `took ${vt.now}ms of virtual time`);
    assert.ok(vt.now >= 15000, 'but it did keep trying for a while');
    assert.equal(b.badge.text, '!');
  });

  it('the side panel gets a failure result within the budget too', async () => {
    const { b, vt } = boot([NEWS], silent);
    const r = await vt.run(b.sendUi({ action: 'btask_draft', kind: 'extract', sources: [{ kind: 'tab', tabId: 11 }] }, PANEL));
    assert.equal(r.result.ok, false);
    assert.ok(vt.now <= 21000, `took ${vt.now}ms`);
  });

  it('a late answer after the budget does not resurrect the delivery', async () => {
    let calls = 0;
    const { b, vt, calls: log } = boot([NEWS], (_t, msg, v) => { calls++; return silent(_t, msg, v); });
    await vt.run(b.sendUi({ action: 'btask_draft', kind: 'extract', sources: [{ kind: 'tab', tabId: 11 }] }, PANEL));
    const seen = log.length;
    await vt.run(new Promise((r) => vt.setTimeout(r, 60000)));
    assert.equal(log.length, seen, 'no further sends after giving up');
  });
});
