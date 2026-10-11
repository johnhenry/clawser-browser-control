// Run with: node --test test/content-presence-query.test.mjs
// The page can ask for presence: clawser's ExtensionClient is built long after content.js loads,
// so the single initial announcement is missed on a slow-booting (e.g. hidden background) tab.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from './_load-content.mjs';

const MARKER = '__clawser_ext__';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const loc = (href) => { const u = new URL(href); return { href, protocol: u.protocol, hostname: u.hostname, origin: u.origin }; };
const QUERY = { type: MARKER, direction: 'presence', action: 'query' };

async function freshLoad(t, chromeOverrides = {}, opts = {}) {
  const ctx = loadContent(chromeOverrides, opts);
  t.after(() => ctx.stop());
  await tick();
  ctx.popPosted(); // the announcement nobody was listening for yet
  return ctx;
}

describe('page-initiated presence query', () => {
  it('answers a query immediately with a presence announcement', async (t) => {
    const ctx = await freshLoad(t);
    ctx.postFromPage(QUERY);
    await tick();
    const [p] = ctx.popPosted().filter((m) => m.direction === 'presence');
    assert.equal(p.action, 'present');
    assert.equal(p.type, MARKER);
    assert.ok(Array.isArray(p.capabilities));
  });

  it('a cold, hidden background tab that missed the initial announcement connects after the query', async (t) => {
    const ctx = await freshLoad(t, { sendMessage: async () => ({ result: [{ name: 'tabs', available: true }] }) }, { hidden: true, location: loc('https://clawser.erisera.com/#workspace/ws1') });
    assert.deepEqual(ctx.popPosted(), []);
    assert.equal(ctx.liveIntervals.size, 1, 'and it keeps announcing on its own while hidden');
    ctx.postFromPage(QUERY);
    await tick();
    const [p] = ctx.popPosted().filter((m) => m.direction === 'presence');
    assert.deepEqual(JSON.parse(JSON.stringify(p.capabilities)), [{ name: 'tabs', available: true }]);
  });

  it('every query is answered (the page watchdog may re-ask)', async (t) => {
    const ctx = await freshLoad(t);
    for (let i = 0; i < 3; i++) ctx.postFromPage(QUERY);
    await tick();
    assert.equal(ctx.popPosted().filter((m) => m.direction === 'presence').length, 3);
  });

  it('ignores a query from another window or from a disallowed origin', async (t) => {
    const ctx = await freshLoad(t);
    ctx.postFromOtherWindow(QUERY);
    await tick();
    assert.deepEqual(ctx.popPosted(), []);
    const bad = await freshLoad(t, {}, { location: loc('https://example.com/') });
    bad.postFromPage(QUERY);
    await tick();
    assert.deepEqual(bad.popPosted(), []);
  });

  it('does not answer its own announcements (no loop) or other presence actions', async (t) => {
    const ctx = await freshLoad(t);
    ctx.postFromPage({ type: MARKER, direction: 'presence', action: 'present' });
    ctx.postFromPage({ type: MARKER, direction: 'presence', action: 'whatever' });
    ctx.postFromPage({ type: MARKER, direction: 'presence' });
    await tick();
    assert.deepEqual(ctx.popPosted(), []);
  });

  it('stays silent when the extension runtime is gone', async (t) => {
    const ctx = await freshLoad(t);
    ctx.chrome.runtime.sendMessage = async () => { throw new Error('Extension context invalidated'); };
    // the cached capabilities are still fine, but a fresh query refreshes them; with the
    // runtime dead there is nothing honest to announce once the cache is cleared
    ctx.chrome.runtime.id = undefined;
    ctx.postFromPage(QUERY);
    await tick();
    assert.deepEqual(ctx.popPosted().filter((m) => m.direction === 'presence'), []);
  });
});
