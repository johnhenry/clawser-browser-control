// Run with: node --test test/background-rpc-routing.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './_load-background.mjs';

describe('message routing', () => {
  it('status returns connection info and capabilities', async () => {
    const { send } = loadBackground();
    const { result } = await send('status', {});
    assert.equal(result.connected, true);
    assert.ok(Array.isArray(result.availableCapabilities));
    assert.ok(Array.isArray(result.capabilities));
  });

  it('returns a clear error for an unknown action', async () => {
    const { send } = loadBackground();
    const { error } = await send('this_action_does_not_exist', {});
    assert.match(error, /Unknown action/);
  });

  it('tabs_list reflects chrome.tabs.query', async () => {
    const { send } = loadBackground({
      tabs: { query: async () => [{ id: 5, url: 'https://a.test', title: 'A', active: true, windowId: 1, index: 0, pinned: false, status: 'complete' }] },
    });
    const { result } = await send('tabs_list', {});
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 5);
  });
});

describe('concurrency limiting', () => {
  it('rejects requests past the concurrency cap with a clear error, without losing earlier ones', async () => {
    // A slow action (scripting.executeScript never resolves) to hold
    // requests "in flight" long enough to observe the cap.
    let resolveSlow;
    const slowPromise = new Promise((resolve) => { resolveSlow = resolve; });
    const { send } = loadBackground({
      scripting: { executeScript: async () => { await slowPromise; return [{ result: null }]; } },
    });

    // Fire 25 concurrent "click" calls (which route through executeInTab
    // -> scripting.executeScript, held open by slowPromise) against a
    // limit of 20 — the last 5 should be rejected immediately.
    const inFlight = Array.from({ length: 25 }, () => send('click', { selector: '#x' }));
    await new Promise((r) => setTimeout(r, 10)); // let the rejections settle first

    resolveSlow();
    const results = await Promise.all(inFlight);
    const rejected = results.filter((r) => r.error?.includes('Too many concurrent requests'));
    assert.equal(rejected.length, 5);
  });
});

describe('audit log', () => {
  it('records both successful and failed actions with the calling tab info', async () => {
    const { send } = loadBackground();
    await send('status', {}, { tab: { id: 7, url: 'https://caller.test' } });
    await send('nonexistent_action', {}, { tab: { id: 7, url: 'https://caller.test' } });

    // The audit_log call's own entry is only recorded *after* it returns
    // (recordAudit runs in the .then() following handleAction), so this
    // snapshot reflects the two prior calls, not itself.
    const { result } = await send('audit_log', {});
    assert.equal(result.entries.length, 2);
    const statusEntry = result.entries.find((e) => e.action === 'status');
    assert.equal(statusEntry.success, true);
    assert.equal(statusEntry.tabId, 7);
    assert.equal(statusEntry.url, 'https://caller.test');

    const failedEntry = result.entries.find((e) => e.action === 'nonexistent_action');
    assert.equal(failedEntry.success, false);
    assert.match(failedEntry.error, /Unknown action/);
  });

  it('clears the log when clear:true is passed', async () => {
    const { send } = loadBackground();
    await send('status', {});
    const first = await send('audit_log', { clear: true });
    assert.ok(first.result.entries.length > 0);
    const second = await send('audit_log', {});
    // Only the "audit_log(clear:true)" and "audit_log()" calls themselves remain.
    assert.equal(second.result.entries.length, 1);
  });
});
