// Run with: node --test test/background-scheduler-race.test.mjs
// The page and the scheduler both write `background_routine_state`. The scheduler must only
// touch what it owns on the routines it ran, using the *current* array, never the stale one it
// read before the (slow) run.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './_load-background.mjs';

const KEY = 'background_routine_state';
const URL_WS = 'https://clawser.erisera.com/#workspace/ws1';

const mon = (id, extra = {}) => ({
  id, name: id, enabled: true,
  trigger: {}, meta: { source: 'btask', scheduleType: 'interval', intervalMs: 60000, lastFired: 0 },
  action: { type: 'btask_monitor', definitionId: `d_${id}` }, state: {}, ...extra,
});

/** Run the alarm with a live tab whose "execution" lets the test write to IDB mid-run. */
async function run(seed, duringRun) {
  let b;
  b = loadBackground({
    tabs: {
      get: async (id) => ({ id, windowId: 1, url: URL_WS }),
      sendMessage: async (tabId, msg) => {
        if (msg.action !== 'execute_routine') return;
        // The page changes things while the routine runs, then reports back.
        await duringRun(b, msg.routineId);
        setTimeout(() => b.notify('routine_executed', { routineId: msg.routineId, success: true, error: null }, { tab: { id: tabId } }), 2);
      },
    },
  });
  b.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: 5, url: URL_WS } });
  b.idbStore.set(KEY, seed);
  await b.fireAlarm();
  return b.idbStore.get(KEY);
}

describe('scheduler write-back does not clobber the page', () => {
  it('a monitor paused during its own run stays paused (and the run is still recorded)', async () => {
    const final = await run([mon('a')], (b) => {
      const cur = b.idbStore.get(KEY); cur[0].enabled = false; b.idbStore.set(KEY, cur);
    });
    assert.equal(final[0].enabled, false);
    assert.equal(final[0].state.lastResult, 'executed');
    assert.ok(final[0].meta.lastFired > 0);
  });

  it('a routine added by the page during the run is kept', async () => {
    const final = await run([mon('a')], (b) => {
      b.idbStore.set(KEY, [...b.idbStore.get(KEY), mon('new')]);
    });
    assert.deepEqual(final.map((r) => r.id).sort(), ['a', 'new']);
    assert.deepEqual(final.find((r) => r.id === 'new').state, {});
  });

  it('a routine deleted by the page during the run is not re-added', async () => {
    const final = await run([mon('a'), mon('b', { meta: { source: 'btask', scheduleType: 'interval', intervalMs: 60000, lastFired: Date.now() } })], (b) => {
      b.idbStore.set(KEY, b.idbStore.get(KEY).filter((r) => r.id !== 'a'));
    });
    assert.deepEqual(final.map((r) => r.id), ['b']);
  });

  it('a schedule change made during the run is not overwritten; only lastFired/state change', async () => {
    const final = await run([mon('a')], (b) => {
      const cur = b.idbStore.get(KEY); cur[0].meta.intervalMs = 900000; cur[0].name = 'renamed'; cur[0].action.definitionId = 'd_other'; b.idbStore.set(KEY, cur);
    });
    assert.equal(final[0].meta.intervalMs, 900000);
    assert.equal(final[0].name, 'renamed');
    assert.equal(final[0].action.definitionId, 'd_other');
    assert.ok(final[0].meta.lastFired > 0);
  });

  it('routines that were not run are left exactly as the page last wrote them', async () => {
    const idle = mon('idle', { meta: { source: 'btask', scheduleType: 'interval', intervalMs: 60000, lastFired: Date.now() } });
    const final = await run([mon('a'), idle], (b) => {
      const cur = b.idbStore.get(KEY); cur[1].enabled = false; cur[1].state = { custom: 1 }; b.idbStore.set(KEY, cur);
    });
    const got = final.find((r) => r.id === 'idle');
    assert.equal(got.enabled, false);
    assert.deepEqual(got.state, { custom: 1 });
  });

  it('runCount increments from the current value, not the stale one', async () => {
    const final = await run([mon('a', { state: { runCount: 2 } })], (b) => {
      const cur = b.idbStore.get(KEY); cur[0].state.runCount = 10; b.idbStore.set(KEY, cur);
    });
    assert.equal(final[0].state.runCount, 11);
  });

  it('a "once" routine is marked fired; a cron routine records its minute', async () => {
    const once = mon('o', { meta: { scheduleType: 'once', fireAt: 1 } });
    const cron = mon('c', { trigger: { type: 'cron', cron: '* * * * *' }, meta: undefined });
    const final = await run([once, cron], () => {});
    assert.equal(final.find((r) => r.id === 'o').meta.fired, true);
    assert.ok(final.find((r) => r.id === 'c').state.lastCronMinute > 0);
  });

  it('with no interleaving, behaviour is unchanged (state recorded, execution log written)', async () => {
    const b = loadBackground({
      tabs: { get: async (id) => ({ id, windowId: 1, url: URL_WS }), sendMessage: async (tabId, msg) => { setTimeout(() => b.notify('routine_executed', { routineId: msg.routineId, success: true, error: null }, { tab: { id: tabId } }), 2); } },
    });
    b.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: 5, url: URL_WS } });
    b.idbStore.set(KEY, [mon('a')]);
    await b.fireAlarm();
    const log = b.idbStore.get('background_execution_log');
    assert.equal(log.length, 1);
    assert.equal(log[0].results[0].routineId, 'a');
    assert.equal(b.idbStore.get(KEY)[0].state.runCount, 1);
  });

  it('a page write that empties the store leaves it empty', async () => {
    const final = await run([mon('a')], (b) => { b.idbStore.set(KEY, []); });
    assert.deepEqual(final, []);
  });
});
