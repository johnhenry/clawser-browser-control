// Run with: node --test test/background-retry-failures.test.mjs
// A failed background run must not look like a success: the routine retries at the next due
// attempt with a bounded backoff, attempts are logged, and the page can read recent failures.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './_load-background.mjs';

const KEY = 'background_routine_state';
const FAIL_KEY = 'background_routine_failures';
const URL_WS = 'https://clawser.erisera.com/#workspace/ws1';
const MIN = 60000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const cronR = (id = 'r', extra = {}) => ({ id, wsId: 'ws1', name: id, enabled: true, trigger: { type: 'cron', cron: '* * * * *' }, actionType: 'btask_monitor', action: { type: 'btask_monitor' }, state: {}, meta: {}, ...extra });
const intervalR = (id = 'r', ms = 3600000, extra = {}) => ({ ...cronR(id), trigger: { type: 'interval', intervalMs: ms }, meta: { lastFired: 0 }, ...extra });
const onceR = (id = 'r') => ({ ...cronR(id), trigger: { type: 'once', at: 1 } });

/** A restarted worker whose attempts fail (`fail`) or succeed. */
function boot(routines, { fail = true, openTabs = [], execError = 'boom' } = {}) {
  const created = []; const executed = [];
  let b;
  b = loadBackground({
    tabs: {
      get: async () => { throw new Error('gone'); },
      query: async () => openTabs,
      create: async (o) => {
        if (fail === 'create') throw new Error('cannot open');
        const tab = { id: 900 + created.length, url: o.url }; created.push(tab);
        setTimeout(() => b.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: tab.id, url: o.url } }), 3);
        return tab;
      },
      sendMessage: async (tabId, msg) => {
        if (msg.action !== 'execute_routine') return;
        executed.push(msg.routineId);
        setTimeout(() => b.notify('routine_executed', { routineId: msg.routineId, success: fail !== true, error: fail === true ? execError : null }, { tab: { id: tabId } }), 3);
      },
      remove: async () => {},
    },
  }, { storage: { workspaceRef: { wsId: 'ws1', url: URL_WS, lastSeen: 1 } }, idbStore: new Map([[KEY, routines]]) });
  return { b, created, executed };
}
const rt = (b, i = 0) => b.idbStore.get(KEY)[i];

describe('a failed attempt does not advance the schedule', () => {
  it('cron: lastCronMinute stays; failures and retryAt are recorded', async () => {
    const { b } = boot([cronR()]);
    const before = Date.now();
    await b.fireAlarm();
    const r = rt(b);
    assert.equal(r.state.lastCronMinute, undefined);
    assert.equal(r.state.failures, 1);
    assert.ok(r.state.retryAt >= before + MIN - 1000 && r.state.retryAt <= Date.now() + MIN + 1000);
    assert.match(r.state.lastResult, /^skipped: boom/);
    assert.equal(r.state.runCount, 1);
  });

  it('interval: meta.lastFired stays; once: meta.fired stays unset', async () => {
    const i = boot([intervalR('i', 3600000, { meta: { lastFired: 1 } })]);
    await i.b.fireAlarm();
    assert.equal(rt(i.b).meta.lastFired, 1);
    const o = boot([onceR('o')]);
    await o.b.fireAlarm();
    assert.equal(rt(o.b).meta.fired, undefined);
  });

  it('success clears the failure bookkeeping and advances normally', async () => {
    const { b } = boot([cronR('r', { state: { failures: 3, retryAt: 1 } })], { fail: false });
    await b.fireAlarm();
    const r = rt(b);
    assert.equal(r.state.failures, undefined);
    assert.equal(r.state.retryAt, undefined);
    assert.ok(r.state.lastCronMinute > 0);
    assert.equal(r.state.lastResult, 'executed');
  });
});

describe('retry with bounded backoff', () => {
  it('is not due again before retryAt (no tab opened every minute)', async () => {
    const { b, created } = boot([cronR()]);
    await b.fireAlarm();
    await b.fireAlarm();
    await b.fireAlarm();
    assert.equal(created.length, 1);
  });

  it('retries once retryAt has passed, even if the cron expression would not match now', async () => {
    const { b, created } = boot([cronR('r', { trigger: { type: 'cron', cron: '0 3 1 1 *' }, state: { failures: 1, retryAt: Date.now() - 1000 } })]);
    await b.fireAlarm();
    assert.equal(created.length, 1);
  });

  it('delays are 1, 2, 5, 10 minutes and then stay at 10', async () => {
    const { b } = boot([cronR()]);
    const delays = [];
    for (let i = 0; i < 6; i++) {
      const list = b.idbStore.get(KEY); if (i > 0) { list[0].state.retryAt = 1; b.idbStore.set(KEY, list); }
      const t0 = Date.now();
      await b.fireAlarm();
      delays.push(Math.round((rt(b).state.retryAt - t0) / MIN));
    }
    assert.deepEqual(delays, [1, 2, 5, 10, 10, 10]);
    assert.equal(rt(b).state.failures, 6);
  });

  it('is capped at the routine\'s own interval', async () => {
    const { b } = boot([intervalR('i', 90000, { meta: { lastFired: 0 }, state: { failures: 3 } })]);
    const t0 = Date.now();
    await b.fireAlarm();
    assert.ok(rt(b).state.retryAt - t0 <= 90000 + 1000);
  });

  it('a disabled routine is never retried', async () => {
    const { b, created } = boot([cronR('r', { enabled: false, state: { failures: 1, retryAt: 1 } })]);
    await b.fireAlarm();
    assert.equal(created.length, 0);
  });

  it('a locked refusal is a deliberate skip, not a failure: it advances normally', async () => {
    const { b } = boot([{ ...cronR(), actionType: 'prompt', action: { type: 'prompt' } }], { fail: true, execError: 'locked' });
    // make the page answer with the locked refusal
    b.chrome.tabs.sendMessage = async (tabId, msg) => {
      if (msg.action === 'execute_routine') setTimeout(() => b.notify('routine_executed', { routineId: msg.routineId, success: false, error: 'locked', locked: true }, { tab: { id: tabId } }), 3);
    };
    await b.fireAlarm();
    assert.equal(rt(b).state.failures, undefined);
    assert.ok(rt(b).state.lastCronMinute > 0);
  });
});

describe('attempts are recorded in the execution log', () => {
  it('each attempt logs routine, error, attempt number and the next retry', async () => {
    const { b } = boot([cronR()]);
    await b.fireAlarm();
    const log = b.idbStore.get('background_execution_log');
    const entry = log[0].results[0];
    assert.equal(entry.routineId, 'r');
    assert.equal(entry.success, false);
    assert.match(entry.error, /boom/);
    assert.equal(entry.attempt, 1);
    assert.ok(entry.nextRetryAt > Date.now());
  });
});

describe('opening a background tab waits up to 60 seconds for the page', () => {
  it('a tab that reports ready at 50 s is used; one that never does gives up after 60 s', async () => {
    let now = 0; let seq = 0; const timers = [];
    const vt = {
      setTimeout(fn, ms = 0) { const id = ++seq; timers.push({ id, at: now + ms, fn }); return id; },
      clearTimeout(id) { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
      async advance(ms) {
        const target = now + ms;
        for (;;) {
          for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
          timers.sort((a, c) => a.at - c.at || a.id - c.id);
          if (!timers.length || timers[0].at > target) break;
          const t = timers.shift(); now = t.at; t.fn();
        }
        now = target; for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
      },
    };
    const removed = []; const executed = [];
    let b;
    b = loadBackground({
      tabs: {
        get: async () => { throw new Error('gone'); }, query: async () => [],
        create: async (o) => ({ id: 77, url: o.url }),
        sendMessage: async (tabId, msg) => { if (msg.action === 'execute_routine') { executed.push(msg.routineId); vt.setTimeout(() => b.notify('routine_executed', { routineId: msg.routineId, success: true, error: null }, { tab: { id: tabId } }), 1); } },
        remove: async (id) => removed.push(id),
      },
    }, { storage: { workspaceRef: { wsId: 'ws1', url: URL_WS, lastSeen: 1 } }, idbStore: new Map([[KEY, [cronR()]]]), setTimeoutImpl: (fn, ms) => vt.setTimeout(fn, ms) });
    b.sandbox.clearTimeout = (id) => vt.clearTimeout(id);
    const run = b.fireAlarm();
    await vt.advance(50000);
    b.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: 77, url: URL_WS } });
    await vt.advance(5000);
    await run;
    assert.deepEqual(executed, ['r'], 'ready at 50 s was still in time');
    assert.deepEqual(removed, [77]);

    // never ready: still waiting at 59 s, failed (and closed) just after 60 s
    removed.length = 0; executed.length = 0;
    const list = b.idbStore.get(KEY); list[0].state = {}; b.idbStore.set(KEY, list);
    const run2 = b.fireAlarm();
    await vt.advance(59000);
    assert.deepEqual(removed, []);
    await vt.advance(2000);
    await run2;
    assert.deepEqual(removed, [77]);
    assert.match(rt(b).state.lastResult, /did not report ready/);
  });
});

describe('routine_failures', () => {
  const ASKER = { tab: { id: 5, url: URL_WS } };
  const ask = async (b, params, sender = ASKER) => (await b.send('routine_failures', params, sender));

  async function withFailures() {
    const { b } = boot([cronR('r1'), cronR('r2', { wsId: 'other' })]);
    b.notify('workspace_ready', { wsId: 'ws1' }, ASKER);
    await b.fireAlarm();
    return b;
  }

  it('returns recent failed attempts for the requesting tab\'s workspace, oldest first', async () => {
    const b = await withFailures();
    const r = await ask(b, { wsId: 'ws1', since: 0 });
    assert.equal(r.result.failures.length, 1);
    const f = r.result.failures[0];
    assert.equal(f.routineId, 'r1');
    assert.match(f.error, /boom/);
    assert.ok(f.at > 0);
  });

  it('only entries newer than `since`', async () => {
    const b = await withFailures();
    const at = (await ask(b, { wsId: 'ws1', since: 0 })).result.failures[0].at;
    assert.equal((await ask(b, { wsId: 'ws1', since: at })).result.failures.length, 0);
    assert.equal((await ask(b, { wsId: 'ws1', since: at - 1 })).result.failures.length, 1);
  });

  it('never returns another workspace\'s failures, or any to a tab that announced a different workspace', async () => {
    const b = await withFailures();
    const other = await ask(b, { wsId: 'other', since: 0 });
    assert.ok(other.error, 'asking for a workspace the tab did not announce is refused');
    const store = b.idbStore.get(FAIL_KEY);
    assert.ok(store.some((f) => f.wsId === 'ws1'));
  });

  it('is refused from a tab outside the allowed origins', async () => {
    const b = await withFailures();
    const r = await ask(b, { wsId: 'ws1', since: 0 }, { tab: { id: 9, url: 'https://evil.example/' } });
    assert.ok(r.error);
  });

  it('validates since and wsId', async () => {
    const b = await withFailures();
    assert.ok((await ask(b, { wsId: 5, since: 0 })).error);
    assert.ok((await ask(b, { since: 0 })).error);
    assert.equal((await ask(b, { wsId: 'ws1', since: 'x' })).result.failures.length, 1, 'junk since means from the start');
  });

  it('is bounded at 50 entries and the stored log is bounded too', async () => {
    const b = await withFailures();
    const many = Array.from({ length: 300 }, (_, i) => ({ wsId: 'ws1', routineId: 'r1', at: 1000 + i, error: 'e'.repeat(1000) }));
    b.idbStore.set(FAIL_KEY, many);
    const r = await ask(b, { wsId: 'ws1', since: 0 });
    assert.equal(r.result.failures.length, 50);
    assert.ok(r.result.failures[49].at > r.result.failures[0].at, 'oldest first');
    assert.equal(r.result.failures[49].at, 1299, 'the newest 50 are kept');
    assert.ok(r.result.failures[0].error.length <= 300);
    // a further failing run keeps the stored log bounded
    const list = b.idbStore.get(KEY); list[0].state.retryAt = 1; b.idbStore.set(KEY, list);
    await b.fireAlarm();
    assert.ok(b.idbStore.get(FAIL_KEY).length <= 200);
  });

  it('successes are never listed', async () => {
    const { b } = boot([cronR()], { fail: false });
    b.notify('workspace_ready', { wsId: 'ws1' }, ASKER);
    await b.fireAlarm();
    assert.equal((await ask(b, { wsId: 'ws1', since: 0 })).result.failures.length, 0);
  });
});
