// Run with: node --test test/background-monitor-routines.test.mjs
// Clawser's btask_monitor routines ride the same scheduler as every other routine: the
// extension only decides *when* a routine is due and runs it in a live or a background tab.
// These tests pin the contract that matters for monitors: background tab, never active,
// always closed, no focus steal, no double runs, and not mistaken for the user's tab.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './_load-background.mjs';

const URL_WS = 'https://clawser.erisera.com/#workspace/ws1';
const PANEL = { id: 'ext-id', url: 'chrome-extension://ext-id/sidepanel.html' };

/** A routine as clawser's RoutineEngine mirrors it into IndexedDB for a monitor. */
function monitorRoutine(overrides = {}) {
  return {
    id: 'rt_mon1',
    name: 'Watch: Price',
    enabled: true,
    trigger: { type: 'cron', cron: '* * * * *' },
    action: { type: 'btask_monitor', definitionId: 'def_1' },
    state: {},
    ...overrides,
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Scheduler harness with a gone live tab and observable tab/window calls. */
function boot({ readyAfter = 5, execAfter = 5, execResult = { success: true, error: null }, createFails = false, sendFails = false, setTimeoutImpl } = {}) {
  const extra = []; const created = []; const removed = []; const sent = []; const windowCalls = []; const tabUpdates = [];
  const b = loadBackground({
    tabs: {
      query: async () => [...created.filter((t) => !removed.includes(t.id)), ...extra].map((t) => ({ ...t })),
      get: async () => { throw new Error('tab no longer exists'); },
      create: async (opts) => {
        if (createFails) throw new Error('boom');
        const tab = { id: 40 + created.length, url: opts.url, active: opts.active };
        created.push({ ...tab, createOpts: opts });
        if (readyAfter !== null) setTimeout(() => b.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: tab.id, url: opts.url } }), readyAfter);
        return tab;
      },
      sendMessage: async (tabId, msg) => {
        sent.push({ tabId, msg });
        if (msg.direction === 'btask_request') return { result: msg.request.type === 'clawser.btask.list' ? { definitions: [] } : { pong: true } };
        if (msg.action !== 'execute_routine') return { result: {} };
        if (sendFails) throw new Error('no receiver');
        if (execAfter !== null) setTimeout(() => b.notify('routine_executed', { routineId: msg.routineId, success: execResult.success, error: execResult.error }, { tab: { id: tabId } }), execAfter);
      },
      remove: async (id) => { removed.push(id); },
      update: async (id, props) => { tabUpdates.push({ id, props }); return { id, windowId: 1 }; },
    },
    windows: { update: async (id, props) => { windowCalls.push({ id, props }); return { id }; } },
  }, { setTimeoutImpl });
  b.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: 5, url: URL_WS } });
  return { b, extra, created, removed, sent, windowCalls, tabUpdates };
}

describe('monitor routines in a background tab', () => {
  it('opens the tab with active:false, runs the routine id, closes it, and records success', async () => {
    const { b, created, removed, sent } = boot();
    b.idbStore.set('background_routine_state', [monitorRoutine()]);
    await b.fireAlarm();
    assert.equal(created.length, 1);
    assert.equal(created[0].createOpts.active, false);
    assert.equal(created[0].url, URL_WS);
    assert.equal(sent.filter((s) => s.msg.action === 'execute_routine')[0].msg.routineId, 'rt_mon1');
    assert.deepEqual(removed, [40]);
    assert.equal(b.idbStore.get('background_routine_state')[0].state.lastResult, 'executed');
  });

  it('never focuses or activates anything while doing so', async () => {
    const { b, windowCalls, tabUpdates } = boot();
    b.idbStore.set('background_routine_state', [monitorRoutine()]);
    await b.fireAlarm();
    assert.deepEqual(windowCalls, []);
    assert.deepEqual(tabUpdates, []);
  });

  it('closes the tab even when the page reports failure', async () => {
    const { b, removed } = boot({ execResult: { success: false, error: 'source_failed' } });
    b.idbStore.set('background_routine_state', [monitorRoutine()]);
    await b.fireAlarm();
    assert.deepEqual(removed, [40]);
    assert.match(b.idbStore.get('background_routine_state')[0].state.lastResult, /^skipped: source_failed/);
  });

  it('closes the tab when it never reports ready', async () => {
    const { b, removed, sent } = boot({ readyAfter: null, setTimeoutImpl: (fn, ms) => setTimeout(fn, Math.min(ms, 5)) });
    b.idbStore.set('background_routine_state', [monitorRoutine()]);
    await b.fireAlarm();
    assert.deepEqual(removed, [40]);
    assert.equal(sent.filter((s) => s.msg.action === 'execute_routine').length, 0);
    assert.match(b.idbStore.get('background_routine_state')[0].state.lastResult, /did not report ready/);
  });

  it('closes the tab when the page never reports the result', async () => {
    const { b, removed } = boot({ execAfter: null, setTimeoutImpl: (fn, ms) => setTimeout(fn, Math.min(ms, 5)) });
    b.idbStore.set('background_routine_state', [monitorRoutine()]);
    await b.fireAlarm();
    assert.deepEqual(removed, [40]);
    assert.match(b.idbStore.get('background_routine_state')[0].state.lastResult, /Timed out/);
  });

  it('closes the tab when the message cannot be delivered', async () => {
    const { b, removed } = boot({ sendFails: true });
    b.idbStore.set('background_routine_state', [monitorRoutine()]);
    await b.fireAlarm();
    assert.deepEqual(removed, [40]);
    assert.match(b.idbStore.get('background_routine_state')[0].state.lastResult, /Could not reach tab/);
  });

  it('records an honest skip (and opens nothing) if the tab cannot be created', async () => {
    const { b, removed } = boot({ createFails: true });
    b.idbStore.set('background_routine_state', [monitorRoutine()]);
    await b.fireAlarm();
    assert.deepEqual(removed, []);
    assert.match(b.idbStore.get('background_routine_state')[0].state.lastResult, /Could not open a tab/);
  });

  it('runs two due monitors one after the other, each in its own closed tab', async () => {
    const { b, created, removed } = boot();
    b.idbStore.set('background_routine_state', [monitorRoutine({ id: 'a' }), monitorRoutine({ id: 'b', action: { type: 'btask_monitor', definitionId: 'def_2' } })]);
    await b.fireAlarm();
    assert.equal(created.length, 2);
    assert.deepEqual(removed, [40, 41]);
  });

  it('a monitor on an interval schedule (minutes converted to intervalMs) fires when due', async () => {
    const { b, created } = boot();
    b.idbStore.set('background_routine_state', [monitorRoutine({ trigger: {}, meta: { scheduleType: 'interval', intervalMs: 15 * 60000, lastFired: Date.now() - 16 * 60000 } })]);
    await b.fireAlarm();
    assert.equal(created.length, 1);
  });

  it('a paused (disabled) monitor opens nothing', async () => {
    const { b, created } = boot();
    b.idbStore.set('background_routine_state', [monitorRoutine({ enabled: false })]);
    await b.fireAlarm();
    assert.equal(created.length, 0);
  });
});

describe('overlapping alarms', () => {
  it('a second alarm while a run is still in progress does not start the same routine again', async () => {
    const { b, created } = boot({ readyAfter: 30, execAfter: 30 });
    b.idbStore.set('background_routine_state', [monitorRoutine()]);
    const first = b.fireAlarm();
    await wait(5);
    const second = b.fireAlarm();
    await Promise.all([first, second]);
    assert.equal(created.length, 1);
  });

  it('a later alarm after the first finished runs normally (the guard releases)', async () => {
    const { b, created } = boot();
    b.idbStore.set('background_routine_state', [monitorRoutine({ trigger: {}, meta: { scheduleType: 'interval', intervalMs: 1, lastFired: 0 } })]);
    await b.fireAlarm();
    await wait(5);
    await b.fireAlarm();
    assert.equal(created.length, 2);
  });
});

describe('the temporary routine tab is not a place to deliver drafts', () => {
  it('btask_list/draft never go to a tab the scheduler opened and is about to close', async () => {
    const { b, sent } = boot({ readyAfter: 5, execAfter: 40 });
    b.idbStore.set('background_routine_state', [monitorRoutine()]);
    const run = b.fireAlarm();
    await wait(15); // tab 40 exists and is running the check
    const r = await b.sendUi({ action: 'btask_list' }, PANEL);
    await run;
    assert.deepEqual(JSON.parse(JSON.stringify(r.result)), { connected: false });
    assert.equal(sent.filter((s) => s.tabId === 40 && s.msg.direction === 'btask_request').length, 0);
  });

  it('the temporary tab is forgotten once closed (a later tab with that id is deliverable)', async () => {
    const { b, extra, sent } = boot();
    b.idbStore.set('background_routine_state', [monitorRoutine()]);
    await b.fireAlarm();
    extra.push({ id: 40, windowId: 1, url: URL_WS, lastAccessed: 1 });
    const r = await b.sendUi({ action: 'btask_list' }, PANEL);
    assert.equal(r.result.connected, true);
    assert.ok(sent.some((s) => s.tabId === 40 && s.msg.direction === 'btask_request'));
  });
});
