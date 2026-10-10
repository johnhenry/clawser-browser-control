// Run with: node --test test/background-routine-timeouts.test.mjs
// A btask_monitor check gets 120 s (it loads the watched page in a background tab); every other
// routine keeps 30 s. The tab is closed on timeout either way, and the overlapping-alarm guard
// holds for the whole 120 s.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './_load-background.mjs';

const URL_WS = 'https://clawser.erisera.com/#workspace/ws1';

function clock() {
  let now = 0; let seq = 0; const timers = [];
  return {
    get now() { return now; },
    setTimeout(fn, ms = 0) { const id = ++seq; timers.push({ id, at: now + ms, fn }); return id; },
    clearTimeout(id) { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    async flush() { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); },
    /** Advance virtual time by `ms`, firing timers in order. */
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        await this.flush();
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        if (!timers.length || timers[0].at > target) break;
        const t = timers.shift(); now = t.at; t.fn();
      }
      now = target; await this.flush();
    },
  };
}

function boot({ never = true } = {}) {
  const vt = clock();
  const created = []; const removed = []; const executes = [];
  const b = loadBackground({
    tabs: {
      get: async () => { throw new Error('gone'); },
      create: async (o) => {
        const tab = { id: 40 + created.length, url: o.url };
        created.push({ ...tab, active: o.active });
        vt.setTimeout(() => b.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: tab.id, url: o.url } }), 100);
        return tab;
      },
      sendMessage: async (tabId, msg) => { if (msg.action === 'execute_routine') executes.push({ tabId, at: vt.now, id: msg.routineId }); },
      remove: async (id) => { removed.push({ id, at: vt.now }); },
    },
  }, { setTimeoutImpl: (fn, ms) => vt.setTimeout(fn, ms) });
  b.sandbox.clearTimeout = (id) => vt.clearTimeout(id);
  b.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: 5, url: URL_WS } });
  return { b, vt, created, removed, executes };
}

const routine = (action) => ({ id: 'r1', name: 'r', enabled: true, trigger: { type: 'cron', cron: '* * * * *' }, action, state: {} });
const MONITOR = { type: 'btask_monitor', definitionId: 'd1' };

describe('routine execution timeout depends on the action', () => {
  it('a monitor check is still running at 119 s, and times out at 120 s with its tab closed', async () => {
    const { b, vt, removed, executes } = boot();
    b.idbStore.set('background_routine_state', [routine(MONITOR)]);
    const run = b.fireAlarm();
    await vt.advance(119000);
    assert.equal(executes.length, 1);
    assert.deepEqual(removed, [], 'tab must stay open while the check may still finish');
    await vt.advance(2000);
    await run;
    assert.equal(removed.length, 1);
    assert.match(b.idbStore.get('background_routine_state')[0].state.lastResult, /Timed out/);
  });

  it('a monitor check that finishes at 90 s is recorded as executed', async () => {
    const { b, vt, removed } = boot();
    b.idbStore.set('background_routine_state', [routine(MONITOR)]);
    const run = b.fireAlarm();
    await vt.advance(90000);
    b.notify('routine_executed', { routineId: 'r1', success: true, error: null }, { tab: { id: 40 } });
    await run;
    assert.equal(b.idbStore.get('background_routine_state')[0].state.lastResult, 'executed');
    assert.equal(removed.length, 1);
  });

  it('any other routine still times out at 30 s and closes its tab', async () => {
    for (const action of [{ type: 'prompt', prompt: 'hi' }, undefined, { type: 'btask_monitor_other' }]) {
      const { b, vt, removed, executes } = boot();
      b.idbStore.set('background_routine_state', [routine(action)]);
      const run = b.fireAlarm();
      await vt.advance(29000);
      assert.equal(executes.length, 1);
      assert.deepEqual(removed, [], 'still waiting at 29 s');
      await vt.advance(2000);
      await run;
      assert.equal(removed.length, 1, JSON.stringify(action));
      assert.match(b.idbStore.get('background_routine_state')[0].state.lastResult, /Timed out/);
    }
  });

  it('a live known tab uses the same per-action timeout (no tab to close)', async () => {
    const vt = clock();
    const sent = [];
    const b = loadBackground({ tabs: { get: async (id) => ({ id, windowId: 1, url: URL_WS }), sendMessage: async (t, m) => { sent.push(m); } } }, { setTimeoutImpl: (fn, ms) => vt.setTimeout(fn, ms) });
    b.sandbox.clearTimeout = (id) => vt.clearTimeout(id);
    b.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: 5, url: URL_WS } });
    b.idbStore.set('background_routine_state', [routine(MONITOR)]);
    const run = b.fireAlarm();
    await vt.advance(60000);
    assert.equal(b.idbStore.get('background_routine_state')[0].state.runCount, undefined, 'still running at 60 s');
    await vt.advance(61000);
    await run;
    assert.match(b.idbStore.get('background_routine_state')[0].state.lastResult, /Timed out/);
  });
});

describe('overlapping-alarm guard across the 120 s window', () => {
  it('alarms at 60 s and 100 s do not start a second run; one after completion does', async () => {
    const { b, vt, created } = boot();
    b.idbStore.set('background_routine_state', [routine(MONITOR)]);
    const first = b.fireAlarm();
    await vt.advance(60000);
    await b.fireAlarm();
    await vt.advance(40000);
    await b.fireAlarm();
    assert.equal(created.length, 1, 'no second tab while the first check is inside its 120 s');
    await vt.advance(30000);
    await first;
    // next minute's alarm after the run ended
    b.idbStore.get('background_routine_state')[0].state.lastCronMinute = 0;
    const next = b.fireAlarm();
    await vt.advance(1000);
    assert.equal(created.length, 2);
    await vt.advance(125000);
    await next;
  });
});
