// Run with: node --test test/background-scheduler.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './_load-background.mjs';

function routine(overrides = {}) {
  return {
    id: 'r1',
    name: 'Test Routine',
    enabled: true,
    trigger: { type: 'cron', cron: '* * * * *' },
    state: {},
    ...overrides,
  };
}

describe('scheduler: cron validation', () => {
  it('skips a routine with a malformed cron expression rather than crashing', async () => {
    const { fireAlarm, idbStore } = loadBackground();
    idbStore.set('background_routine_state', [routine({ trigger: { type: 'cron', cron: 'not a cron' } })]);
    await fireAlarm();
    await new Promise((r) => setTimeout(r, 20));
    const [r] = idbStore.get('background_routine_state');
    assert.deepEqual(r.state, {}); // never touched — correctly never considered "due"
  });

  it('skips a cron field out of range (e.g. minute 99)', async () => {
    const { fireAlarm, idbStore } = loadBackground();
    idbStore.set('background_routine_state', [routine({ trigger: { type: 'cron', cron: '99 * * * *' } })]);
    await fireAlarm();
    await new Promise((r) => setTimeout(r, 20));
    const [r] = idbStore.get('background_routine_state');
    assert.deepEqual(r.state, {});
  });
});

describe('scheduler: delegation — no known workspace tab', () => {
  it('marks the routine as skipped with an honest reason instead of pretending success', async () => {
    const { fireAlarm, idbStore } = loadBackground();
    idbStore.set('background_routine_state', [routine()]);
    await fireAlarm();
    await new Promise((r) => setTimeout(r, 20));
    const [r] = idbStore.get('background_routine_state');
    assert.equal(r.state.runCount, 1);
    assert.match(r.state.lastResult, /^skipped:/);
    assert.match(r.state.lastResult, /No known Clawser tab/);
  });
});

describe('scheduler: delegation — known tab already open', () => {
  it('pushes execute_routine to the tab and records success once it reports back', async () => {
    let sentTo = null;
    const { fireAlarm, idbStore, notify } = loadBackground({
      tabs: {
        get: async (id) => ({ id, windowId: 1, url: 'https://clawser.example/#workspace/ws1' }),
        sendMessage: async (tabId, msg) => {
          sentTo = { tabId, msg };
          // Simulate the page executing it and reporting back.
          queueMicrotask(() => notify('routine_executed', { routineId: msg.routineId, success: true, error: null }, { tab: { id: tabId } }));
        },
      },
    });

    notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: 5, url: 'https://clawser.example/#workspace/ws1' } });
    idbStore.set('background_routine_state', [routine()]);

    await fireAlarm();
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(sentTo.tabId, 5);
    assert.equal(sentTo.msg.action, 'execute_routine');
    const [r] = idbStore.get('background_routine_state');
    assert.equal(r.state.lastResult, 'executed');
  });

  it('records the routine-reported error when execution fails', async () => {
    const { fireAlarm, idbStore, notify } = loadBackground({
      tabs: {
        get: async (id) => ({ id, windowId: 1, url: 'https://clawser.example/#workspace/ws1' }),
        sendMessage: async (tabId, msg) => {
          queueMicrotask(() => notify('routine_executed', { routineId: msg.routineId, success: false, error: 'agent exploded' }, { tab: { id: tabId } }));
        },
      },
    });

    notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: 5, url: 'https://clawser.example/#workspace/ws1' } });
    idbStore.set('background_routine_state', [routine()]);

    await fireAlarm();
    await new Promise((r) => setTimeout(r, 20));

    const [r] = idbStore.get('background_routine_state');
    assert.equal(r.state.lastResult, 'skipped: agent exploded');
  });
});

describe('scheduler: delegation — known tab gone, auto-opens a new one', () => {
  it('opens a tab at the last-known URL, waits for ready, delegates, then closes it', async () => {
    const opened = [];
    const removed = [];
    const { fireAlarm, idbStore, notify } = loadBackground({
      tabs: {
        get: async () => { throw new Error('tab no longer exists'); },
        create: async (opts) => {
          const tab = { id: 42, url: opts.url };
          opened.push(tab);
          // Simulate the new tab booting and announcing itself — a real
          // setTimeout, not queueMicrotask: opening a real browser tab and
          // running its JS takes measurable time, so the code's own
          // pendingReadyWaiters registration (which happens on the next
          // microtask tick after chrome.tabs.create resolves) is
          // guaranteed to run first. queueMicrotask here would race that
          // registration and flakily "arrive" before it's set up.
          setTimeout(() => notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: 42, url: opts.url } }), 5);
          return tab;
        },
        sendMessage: async (tabId, msg) => {
          setTimeout(() => notify('routine_executed', { routineId: msg.routineId, success: true, error: null }, { tab: { id: tabId } }), 5);
        },
        remove: async (id) => { removed.push(id); },
      },
    });

    // A previously-seen (now closed) tab establishes the last-known URL.
    notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: 5, url: 'https://clawser.example/#workspace/ws1' } });
    idbStore.set('background_routine_state', [routine()]);

    await fireAlarm();
    await new Promise((r) => setTimeout(r, 50)); // two serial 5ms handoffs (ready, then executed)

    assert.equal(opened.length, 1);
    assert.equal(opened[0].url, 'https://clawser.example/#workspace/ws1');
    assert.deepEqual(removed, [42]);
    const [r] = idbStore.get('background_routine_state');
    assert.equal(r.state.lastResult, 'executed');
  });
});

describe('scheduler: trigger types', () => {
  it('fires an interval routine once its intervalMs has elapsed', async () => {
    const { fireAlarm, idbStore } = loadBackground();
    idbStore.set('background_routine_state', [
      routine({ trigger: {}, meta: { scheduleType: 'interval', intervalMs: 1000, lastFired: Date.now() - 5000 } }),
    ]);
    await fireAlarm();
    await new Promise((r) => setTimeout(r, 20));
    const [r] = idbStore.get('background_routine_state');
    assert.equal(r.state.runCount, 1);
  });

  it('fires a "once" routine exactly once, then never again', async () => {
    const { fireAlarm, idbStore } = loadBackground();
    idbStore.set('background_routine_state', [
      routine({ trigger: {}, meta: { scheduleType: 'once', fireAt: Date.now() - 1000 } }),
    ]);
    await fireAlarm();
    await new Promise((r) => setTimeout(r, 20));
    let [r] = idbStore.get('background_routine_state');
    assert.equal(r.state.runCount, 1);
    assert.equal(r.meta.fired, true);

    await fireAlarm();
    await new Promise((r) => setTimeout(r, 20));
    [r] = idbStore.get('background_routine_state');
    assert.equal(r.state.runCount, 1); // not re-fired
  });

  it('skips disabled routines entirely', async () => {
    const { fireAlarm, idbStore } = loadBackground();
    idbStore.set('background_routine_state', [routine({ enabled: false })]);
    await fireAlarm();
    await new Promise((r) => setTimeout(r, 20));
    const [r] = idbStore.get('background_routine_state');
    assert.deepEqual(r.state, {});
  });
});
