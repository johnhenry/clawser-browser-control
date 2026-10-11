// Run with: node --test test/background-cold-start-live-tab.test.mjs
// After a service-worker restart the worker has only the persisted workspace reference. If the user
// already has that workspace open, use that tab instead of opening a duplicate background tab.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './_load-background.mjs';

const KEY = 'background_routine_state';
const URL_WS = 'https://clawser.erisera.com/#workspace/ws1';

/**
 * A restarted worker (persisted ref + synced routines) in a browser that has `openTabs`.
 * Each open tab answers pings with its own wsId (or nothing, or a different shape).
 */
function restarted({ openTabs, pong, execAfter = 5 }) {
  const created = []; const removed = []; const executed = []; const pings = []; const updates = [];
  let b;
  b = loadBackground({
    tabs: {
      get: async (id) => { const t = openTabs.find((x) => x.id === id); if (!t) throw new Error('gone'); return { ...t }; },
      query: async () => [...openTabs, ...created.filter((c) => !removed.includes(c.id))].map((t) => ({ ...t })),
      create: async (o) => {
        const tab = { id: 900 + created.length, url: o.url };
        created.push({ ...tab, active: o.active });
        setTimeout(() => b.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: tab.id, url: o.url } }), 5);
        return tab;
      },
      sendMessage: async (tabId, msg) => {
        if (msg.direction === 'btask_request') {
          pings.push({ tabId, type: msg.request.type, timeoutMs: msg.timeoutMs });
          return pong(tabId);
        }
        if (msg.action === 'execute_routine') {
          executed.push({ tabId, id: msg.routineId });
          setTimeout(() => b.notify('routine_executed', { routineId: msg.routineId, success: true, error: null }, { tab: { id: tabId } }), execAfter);
        }
      },
      remove: async (id) => { removed.push(id); },
      update: async (id, p) => { updates.push([id, p]); return {}; },
    },
    windows: { update: async () => ({}) },
  }, {
    storage: { workspaceRef: { wsId: 'ws1', url: URL_WS, lastSeen: 1 } },
    idbStore: new Map([[KEY, [{ id: 'a', wsId: 'ws1', name: 'a', enabled: true, trigger: { type: 'cron', cron: '* * * * *' }, actionType: 'btask_monitor', action: { type: 'btask_monitor' }, state: {}, meta: {} }]]]),
  });
  return { b, created, removed, executed, pings, updates };
}

const mine = (id) => ({ id, windowId: 1, url: 'https://clawser.erisera.com/#workspace/ws1', lastAccessed: 1 });
const pongWith = (map) => (tabId) => (tabId in map ? { result: { pong: true, wsId: map[tabId] } } : { transportError: 'no_response' });

describe('cold start with clawser already open', () => {
  it('runs the routine in the open tab for that workspace and opens nothing', async () => {
    const { b, created, removed, executed, updates } = restarted({ openTabs: [mine(11)], pong: pongWith({ 11: 'ws1' }) });
    await b.fireAlarm();
    assert.deepEqual(created, []);
    assert.deepEqual(removed, [], 'the user\'s tab is never closed');
    assert.deepEqual(executed, [{ tabId: 11, id: 'a' }]);
    assert.deepEqual(updates, []);
    assert.equal(b.idbStore.get(KEY)[0].state.lastResult, 'executed');
  });

  it('pings with the short handshake timeout', async () => {
    const { b, pings } = restarted({ openTabs: [mine(11)], pong: pongWith({ 11: 'ws1' }) });
    await b.fireAlarm();
    assert.ok(pings.every((p) => p.type === 'clawser.btask.ping' && p.timeoutMs <= 1500));
  });

  it('prefers the tab whose announced wsId matches, over another workspace\'s tab', async () => {
    const { b, executed, created } = restarted({
      openTabs: [{ ...mine(11), url: 'https://clawser.erisera.com/#workspace/other' }, mine(12)],
      pong: pongWith({ 11: 'other', 12: 'ws1' }),
    });
    await b.fireAlarm();
    assert.deepEqual(executed, [{ tabId: 12, id: 'a' }]);
    assert.deepEqual(created, []);
  });

  it('remembers the tab it found, so the next run goes straight to it', async () => {
    const { b, pings, executed } = restarted({ openTabs: [mine(11)], pong: pongWith({ 11: 'ws1' }) });
    await b.fireAlarm();
    const before = pings.length;
    b.idbStore.get(KEY)[0].state.lastCronMinute = 0;
    await b.fireAlarm();
    assert.equal(executed.length, 2);
    assert.equal(pings.length, before, 'no second search once the tab is known');
  });

  it('opens a background tab only when no live tab for that workspace answers', async () => {
    for (const pong of [pongWith({}), pongWith({ 11: 'other' }), () => ({ result: { pong: true } }) /* older page: no wsId */]) {
      const { b, created, removed, executed } = restarted({ openTabs: [mine(11)], pong });
      await b.fireAlarm();
      assert.equal(created.length, 1);
      assert.equal(created[0].active, false);
      assert.deepEqual(executed, [{ tabId: 900, id: 'a' }]);
      assert.deepEqual(removed, [900]);
    }
  });

  it('never considers tabs on origins that are not clawser', async () => {
    const { b, pings, created } = restarted({ openTabs: [{ id: 11, windowId: 1, url: 'https://evil.example/#workspace/ws1' }], pong: pongWith({ 11: 'ws1' }) });
    await b.fireAlarm();
    assert.deepEqual(pings, []);
    assert.equal(created.length, 1);
  });
});

describe('the same routine never runs in two tabs at once', () => {
  it('two overlapping alarms after a cold start execute the routine once', async () => {
    const { b, executed, created } = restarted({ openTabs: [mine(11)], pong: pongWith({ 11: 'ws1' }), execAfter: 40 });
    const first = b.fireAlarm();
    await new Promise((r) => setTimeout(r, 10));
    const second = b.fireAlarm();
    await Promise.all([first, second]);
    assert.equal(executed.length, 1);
    assert.equal(created.length, 0);
  });

  it('a second request for a routine that is already executing is refused, not queued behind it', async () => {
    const { b, executed } = restarted({ openTabs: [mine(11)], pong: pongWith({ 11: 'ws1' }), execAfter: 40 });
    const first = b.sandbox.requestRoutineExecution(11, 'a', 1000);
    const second = await b.sandbox.requestRoutineExecution(12, 'a', 1000);
    assert.equal(second.success, false);
    assert.match(second.error, /already running/i);
    assert.deepEqual(executed.map((e) => e.tabId), [11]);
    b.notify('routine_executed', { routineId: 'a', success: true, error: null }, { tab: { id: 11 } });
    assert.equal((await first).success, true);
  });
});
