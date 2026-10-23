// Run with: node --test test/background-cancel.test.mjs
// RPC cancellation (#35): { type, direction: 'cancel', id } aborts that request's in-flight work.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './_load-background.mjs';

const MARKER = '__clawser_ext__';
const SENDER = { tab: { id: 1, url: 'https://example.com' } };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Send a request WITH an id (as content.js relays it) and collect every reply. */
function sendWithId(ctx, id, action, params = {}, sender = SENDER) {
  const replies = [];
  ctx.hooks.listener({ type: MARKER, id, action, params }, sender, (r) => replies.push(r));
  return replies;
}
function cancel(ctx, id, sender = SENDER) {
  return ctx.hooks.listener({ type: MARKER, direction: 'cancel', id }, sender, () => {});
}

describe('cancel — protocol and capability', () => {
  it('advertises "cancel" in status, the capability list and the announced capabilities', async () => {
    const { send } = loadBackground();
    const { result: status } = await send('status', {});
    assert.ok(status.availableCapabilities.includes('cancel'));
    assert.ok(status.capabilities.some((c) => c.name === 'cancel' && c.available));
    const { result: caps } = await send('get_available_capabilities', {});
    assert.ok(caps.includes('cancel'));
  });

  it('a cancel message needs no response (listener returns false)', () => {
    const ctx = loadBackground();
    assert.equal(cancel(ctx, 'nope'), false);
  });
});

describe('cancel — in-flight work stops', () => {
  it('cancelling a long wait replies cancelled, stops the in-page poll, and never sends a success reply', async () => {
    let pageFlag = null;
    const ctx = loadBackground({
      scripting: {
        executeScript: async ({ func, args }) => {
          const src = String(func);
          if (src.includes('__clawserWaitCancelled = true')) { pageFlag = true; return [{ result: null }]; }
          return new Promise(() => {}); // the wait itself: never settles
        },
      },
    });
    const replies = sendWithId(ctx, 'w1', 'wait', { tabId: 1, selector: '#never', timeout: 60000 });
    await tick(5);
    assert.equal(replies.length, 0);
    cancel(ctx, 'w1');
    await tick(5);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].cancelled, true);
    assert.match(replies[0].error, /cancel/i);
    assert.equal(replies[0].result, undefined);
    assert.equal(pageFlag, true, 'asked the page to stop polling');
    await tick(20);
    assert.equal(replies.length, 1, 'no later reply');
  });

  it('cancelling a navigate stops waiting for the commit and stops its commit timer', async () => {
    const ctx = loadBackground();
    const baseline = ctx.hooks.tabUpdatedListeners.size; // background's permanent listener
    const replies = sendWithId(ctx, 'n1', 'navigate', { tabId: 1, url: 'https://example.com/slow' });
    await tick(5);
    assert.equal(replies.length, 0); // waiting for the commit
    cancel(ctx, 'n1');
    await tick(5);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].cancelled, true);
    assert.equal(ctx.hooks.tabUpdatedListeners.size, baseline, 'commit listener removed');
    // A late commit event must not produce a second (success) reply.
    ctx.tabUpdated(1, { url: 'https://example.com/slow', status: 'complete' });
    await tick(10);
    assert.equal(replies.length, 1);
  });

  it('cancelling cors_fetch aborts the fetch', async () => {
    let seenSignal = null;
    const ctx = loadBackground({}, {
      fetchImpl: (url, opts) => new Promise((_, reject) => {
        seenSignal = opts.signal;
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    });
    const replies = sendWithId(ctx, 'f1', 'cors_fetch', { url: 'https://example.org/x' });
    await tick(5);
    cancel(ctx, 'f1');
    await tick(5);
    assert.equal(seenSignal.aborted, true);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].cancelled, true);
  });

  it('a handler that finishes after being cancelled does not send a success reply', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const ctx = loadBackground({ tabs: { goBack: async () => { await gate; } } });
    const replies = sendWithId(ctx, 'g1', 'go_back', { tabId: 1 });
    await tick(5);
    cancel(ctx, 'g1');
    release();
    ctx.tabUpdated(1, { status: 'complete' });
    await tick(20);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].cancelled, true);
  });

  it('cancel frees the concurrency slot', async () => {
    const ctx = loadBackground({ scripting: { executeScript: () => new Promise(() => {}) } });
    for (let i = 0; i < 20; i++) sendWithId(ctx, 'r' + i, 'click', { selector: '#x' });
    const blocked = sendWithId(ctx, 'over', 'click', { selector: '#x' });
    await tick(5);
    assert.match(blocked[0].error, /Too many concurrent/);
    cancel(ctx, 'r0');
    await tick(5);
    const ok = sendWithId(ctx, 'again', 'click', { selector: '#x' });
    await tick(5);
    assert.equal(ok.length, 0, 'accepted (pending), not rejected');
  });

  it('a queued step that has not started yet is skipped when its request is cancelled first', async () => {
    let clicks = 0;
    const ctx = loadBackground({ scripting: { executeScript: async () => { clicks++; return [{ result: null }]; } } });
    // Pre-aborted: the cancel arrives before the handler's first await resumes.
    sendWithId(ctx, 's1', 'click', { selector: '#x' });
    cancel(ctx, 's1');
    await tick(10);
    assert.equal(clicks, 0);
  });
});

describe('cancel — no-ops and old clients', () => {
  it('cancel for an unknown id is a no-op', async () => {
    const ctx = loadBackground();
    assert.doesNotThrow(() => cancel(ctx, 'ghost'));
    assert.doesNotThrow(() => ctx.hooks.listener({ type: MARKER, direction: 'cancel' }, SENDER, () => {}));
    const { result } = await ctx.send('status', {});
    assert.equal(result.connected, true);
  });

  it('cancel after the request finished is a no-op and does not alter the delivered reply', async () => {
    const ctx = loadBackground();
    const replies = sendWithId(ctx, 'done1', 'status');
    await tick(10);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].result.connected, true);
    cancel(ctx, 'done1');
    await tick(10);
    assert.equal(replies.length, 1);
  });

  it('an id-less request (old client) and an id\'d request that is never cancelled behave as before', async () => {
    const ctx = loadBackground();
    const { result } = await ctx.send('status', {});
    assert.equal(result.connected, true);
    const replies = sendWithId(ctx, 'plain', 'status');
    await tick(10);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].cancelled, undefined);
    assert.equal(replies[0].result.connected, true);
  });

  it('only the tab that sent a request can cancel it', async () => {
    const ctx = loadBackground();
    const replies = sendWithId(ctx, 'mine', 'navigate', { tabId: 1, url: 'https://example.com/a' });
    await tick(5);
    cancel(ctx, 'mine', { tab: { id: 77, url: 'https://evil.test' } });
    await tick(5);
    assert.equal(replies.length, 0, 'foreign tab cannot cancel');
    cancel(ctx, 'mine');
    await tick(5);
    assert.equal(replies[0].cancelled, true);
  });

  it('a reused id after completion is a fresh request', async () => {
    const ctx = loadBackground();
    sendWithId(ctx, 'dup', 'status');
    await tick(10);
    const replies = sendWithId(ctx, 'dup', 'navigate', { tabId: 1, url: 'https://example.com/b' });
    await tick(5);
    cancel(ctx, 'dup');
    await tick(5);
    assert.equal(replies[0].cancelled, true);
  });
});
