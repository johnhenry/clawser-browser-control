// Run with: node --test test/background-locked.test.mjs
// clawser#380 / R2-A2: while the vault is locked the page can run only btask_monitor routines.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './_load-background.mjs';

const KEY = 'background_routine_state';
const URL_WS = 'https://clawser.erisera.com/#workspace/ws1';
const PANEL = { id: 'ext-id', url: 'chrome-extension://ext-id/sidepanel.html' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const routine = (id, actionType) => ({ id, wsId: 'ws1', name: id, enabled: true, trigger: { type: 'cron', cron: '* * * * *' }, actionType, action: { type: actionType }, state: {}, meta: {} });
const MON = 'btask_monitor';
const LOCKED_READY = { locked: true, capabilities: ['btask_monitor'] };

/**
 * A restarted worker with routine `id` of `actionType`. `ready` is what a tab we open announces;
 * `openTabs` are tabs the user already has (answering pings with `pong(tabId)`);
 * `execReply` is how a page answers execute_routine.
 */
function boot({ actionType = MON, ready = LOCKED_READY, openTabs = [], pong = () => ({ transportError: 'no_response' }), execReply, lastKnown = null } = {}) {
  const created = []; const removed = []; const executed = [];
  let b;
  b = loadBackground({
    tabs: {
      get: async (id) => { const t = openTabs.find((x) => x.id === id); if (!t) throw new Error('gone'); return { ...t }; },
      query: async () => [...openTabs, ...created.filter((c) => !removed.includes(c.id))].map((t) => ({ ...t })),
      create: async (o) => {
        const tab = { id: 900 + created.length, url: o.url };
        created.push({ ...tab, active: o.active });
        setTimeout(() => b.notify('workspace_ready', { wsId: 'ws1', ...ready }, { tab: { id: tab.id, url: o.url } }), 5);
        return tab;
      },
      sendMessage: async (tabId, msg) => {
        if (msg.direction === 'btask_request') return pong(tabId);
        if (msg.action !== 'execute_routine') return;
        executed.push({ tabId, id: msg.routineId });
        const reply = execReply ? execReply(tabId, msg) : { success: true, error: null };
        setTimeout(() => b.notify('routine_executed', { routineId: msg.routineId, ...reply }, { tab: { id: tabId } }), 5);
      },
      remove: async (id) => { removed.push(id); },
    },
    windows: { update: async () => ({}) },
  }, {
    storage: { workspaceRef: { wsId: 'ws1', url: URL_WS, lastSeen: 1 } },
    idbStore: new Map([[KEY, [routine('r', actionType)]]]),
  });
  if (lastKnown) b.notify('workspace_ready', { wsId: 'ws1', ...lastKnown }, { tab: { id: 5, url: URL_WS } });
  return { b, created, removed, executed };
}
const lastResult = (b) => b.idbStore.get(KEY)[0].state.lastResult;
const status = async (b) => (await b.sendUi({ action: 'btask_sched_status' }, PANEL)).result;
const mine = (id) => ({ id, windowId: 1, url: URL_WS, lastAccessed: 1 });
const pongOf = (map) => (tabId) => (tabId in map ? { result: { pong: true, wsId: 'ws1', ...map[tabId] } } : { transportError: 'no_response' });

describe('a background tab that stops at the vault prompt', () => {
  it('the first (locked) workspace_ready counts as ready for a monitor, which then runs and the tab is closed', async () => {
    const { b, created, removed, executed } = boot();
    await b.fireAlarm();
    assert.equal(created[0].active, false);
    assert.deepEqual(executed, [{ tabId: 900, id: 'r' }]);
    assert.deepEqual(removed, [900]);
    assert.equal(lastResult(b), 'executed');
    assert.equal((await status(b)).lockedSkipped, false);
  });

  it('a non-monitor routine is not sent to it: "not run: Clawser is locked", tab closed, status shown', async () => {
    const { b, executed, removed } = boot({ actionType: 'prompt' });
    await b.fireAlarm();
    assert.deepEqual(executed, []);
    assert.deepEqual(removed, [900]);
    assert.equal(lastResult(b), 'not run: Clawser is locked');
    assert.equal((await status(b)).lockedSkipped, true);
  });

  it('a locked tab that does not advertise btask_monitor gets nothing, even for a monitor', async () => {
    for (const ready of [{ locked: true }, { locked: true, capabilities: [] }, { locked: true, capabilities: ['other'] }]) {
      const { b, executed } = boot({ ready });
      await b.fireAlarm();
      assert.deepEqual(executed, [], JSON.stringify(ready));
      assert.equal(lastResult(b), 'not run: Clawser is locked');
    }
  });

  it('an unlocked ready tab runs any routine as before', async () => {
    const { b, executed } = boot({ actionType: 'prompt', ready: {} });
    await b.fireAlarm();
    assert.equal(executed.length, 1);
    assert.equal(lastResult(b), 'executed');
  });

  it('a page that answers "locked" is recorded as not run, not as a failure to retry', async () => {
    const { b } = boot({ actionType: 'prompt', ready: {}, execReply: () => ({ success: false, error: 'locked', locked: true }) });
    await b.fireAlarm();
    assert.equal(lastResult(b), 'not run: Clawser is locked');
    assert.equal((await status(b)).lockedSkipped, true);
  });

  it('no retry storm: another alarm in the same minute does nothing; the next due time applies', async () => {
    const { b, executed, created } = boot({ actionType: 'prompt' });
    await b.fireAlarm();
    await b.fireAlarm();
    assert.equal(created.length, 1);
    assert.deepEqual(executed, []);
  });
});

describe('replies from a locked page (locked:true is set on every reply from the locked runner)', () => {
  it('a successful monitor check is "executed", not "not run"', async () => {
    const { b } = boot({ execReply: () => ({ success: true, error: null, locked: true }) });
    await b.fireAlarm();
    assert.equal(lastResult(b), 'executed');
    assert.equal((await status(b)).lockedSkipped, false);
  });

  it('a monitor check that threw keeps its own error and does not claim the tab was locked', async () => {
    const { b } = boot({ execReply: () => ({ success: false, error: 'readSource exploded', locked: true }) });
    await b.fireAlarm();
    assert.equal(lastResult(b), 'skipped: readSource exploded');
    assert.equal((await status(b)).lockedSkipped, false);
  });

  it('only the refusal {error:"locked"} counts as a locked skip', async () => {
    const { b } = boot({ actionType: 'prompt', ready: {}, execReply: () => ({ success: false, error: 'locked', locked: true }) });
    await b.fireAlarm();
    assert.equal(lastResult(b), 'not run: Clawser is locked');
    assert.equal((await status(b)).lockedSkipped, true);
  });
});

describe('the user already has a locked clawser tab', () => {
  it('a monitor is run in it (it advertises btask_monitor) and nothing is opened', async () => {
    const { b, created, executed } = boot({ openTabs: [mine(11)], pong: pongOf({ 11: LOCKED_READY }) });
    await b.fireAlarm();
    assert.deepEqual(created, []);
    assert.deepEqual(executed, [{ tabId: 11, id: 'r' }]);
  });

  it('a non-monitor routine is not run and no background tab is opened for it', async () => {
    const { b, created, executed } = boot({ actionType: 'prompt', openTabs: [mine(11)], pong: pongOf({ 11: LOCKED_READY }) });
    await b.fireAlarm();
    assert.deepEqual(created, []);
    assert.deepEqual(executed, []);
    assert.equal(lastResult(b), 'not run: Clawser is locked');
    assert.equal((await status(b)).lockedSkipped, true);
  });

  it('a locked tab without the capability is not used for a monitor; a background tab is opened', async () => {
    const { b, created } = boot({ openTabs: [mine(11)], pong: pongOf({ 11: { locked: true } }) });
    await b.fireAlarm();
    assert.equal(created.length, 1);
  });

  it('an unlocked tab for the same workspace is preferred over a locked one', async () => {
    const { b, executed } = boot({ openTabs: [mine(11), mine(12)], pong: pongOf({ 11: LOCKED_READY, 12: {} }) });
    await b.fireAlarm();
    assert.deepEqual(executed, [{ tabId: 12, id: 'r' }]);
  });

  it('a remembered tab that is locked: monitor goes through, other routines are skipped without a message', async () => {
    const m = boot({ openTabs: [mine(5)], lastKnown: LOCKED_READY });
    m.b.hooks; await m.b.fireAlarm();
    assert.deepEqual(m.executed, [{ tabId: 5, id: 'r' }]);
    const p = boot({ actionType: 'prompt', openTabs: [mine(5)], lastKnown: LOCKED_READY });
    await p.b.fireAlarm();
    assert.deepEqual(p.executed, []);
    assert.equal(lastResult(p.b), 'not run: Clawser is locked');
  });
});

describe('unlocking clears the status', () => {
  it('workspace_ready with locked:false (or absent) clears "Clawser is locked"', async () => {
    const { b } = boot({ actionType: 'prompt' });
    await b.fireAlarm();
    assert.equal((await status(b)).lockedSkipped, true);
    b.notify('workspace_ready', { wsId: 'ws1', locked: false }, { tab: { id: 5, url: URL_WS } });
    await wait(15);
    assert.equal((await status(b)).lockedSkipped, false);
  });

  it('a later successful non-monitor run clears it too', async () => {
    const { b } = boot({ actionType: 'prompt', ready: {}, execReply: () => ({ success: true, error: null }) });
    await b.sendUi({ action: 'btask_dismiss' }, PANEL);
    b.sessionStore.btaskLockedSkip = { at: 1 };
    await b.fireAlarm();
    assert.equal((await status(b)).lockedSkipped, false);
  });

  it('the status call is extension-pages only', async () => {
    const { b } = boot();
    assert.ok((await b.sendUi({ action: 'btask_sched_status' }, { id: 'ext-id', tab: { id: 1 }, url: 'http://localhost/' })).error);
  });
});
