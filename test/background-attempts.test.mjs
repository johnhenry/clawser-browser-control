// Run with: node --test test/background-attempts.test.mjs
// johnhenry/clawser-browser-control#22: a background attempt must never be lost silently.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './_load-background.mjs';

const KEY = 'background_routine_state';
const ATTEMPTS = 'background_routine_attempts';
const LOG = 'background_execution_log';
const FAILS = 'background_routine_failures';
const URL_WS = 'https://clawser.erisera.com/#workspace/ws1';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ROUTINE = () => ({ id: 'r', wsId: 'ws1', name: 'r', enabled: true, trigger: { type: 'cron', cron: '* * * * *' }, actionType: 'btask_monitor', action: { type: 'btask_monitor' }, state: {}, meta: {} });

/** Shared "browser" and "extension storage" that outlive a worker. */
function world() {
  return { idb: new Map([[KEY, [ROUTINE()]]]), storage: { workspaceRef: { wsId: 'ws1', url: URL_WS, lastSeen: 1 } }, tabs: new Map(), created: [], removed: [] };
}

/** A fresh worker on that world. `ready`: when (ms) the opened tab announces itself, or null for never. */
function worker(w, { ready = null, execOk = true, hang = false } = {}) {
  let b;
  b = loadBackground({
    tabs: {
      get: async (id) => { const t = w.tabs.get(id); if (!t) throw new Error('No tab'); return { ...t }; },
      query: async () => [...w.tabs.values()].map((t) => ({ ...t })),
      create: async (o) => {
        const tab = { id: 900 + w.created.length, url: o.url };
        w.tabs.set(tab.id, tab); w.created.push({ ...tab, active: o.active });
        if (ready !== null) setTimeout(() => b.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: tab.id, url: o.url } }), ready);
        return tab;
      },
      sendMessage: async (tabId, msg) => {
        if (msg.action === 'execute_routine') setTimeout(() => b.notify('routine_executed', { routineId: msg.routineId, success: execOk, error: execOk ? null : 'boom' }, { tab: { id: tabId } }), 3);
      },
      remove: async (id) => { w.tabs.delete(id); w.removed.push(id); },
    },
  }, {
    storage: w.storage, idbStore: w.idb,
    // "hang": this worker's timers never fire, as if the process were frozen/killed mid-wait
    setTimeoutImpl: hang ? () => 0 : undefined,
  });
  return b;
}

describe('a worker killed mid-wait', () => {
  it('leaves an "attempt started" record (routine, workspace, time, tab) before waiting', async () => {
    const w = world();
    const b1 = worker(w, { hang: true });
    b1.fireAlarm(); // never settles: the worker is "killed" here
    await wait(30);
    const rec = w.idb.get(ATTEMPTS);
    assert.equal(rec.length, 1);
    assert.equal(rec[0].routineId, 'r');
    assert.equal(rec[0].wsId, 'ws1');
    assert.equal(rec[0].tabId, 900);
    assert.ok(rec[0].at > 0);
    assert.equal(w.tabs.has(900), true, 'the tab is still open');
  });

  it('the next alarm records the failure (log, backoff, routine_failures) and closes the leftover tab', async () => {
    const w = world();
    worker(w, { hang: true }).fireAlarm();
    await wait(30);

    const b2 = worker(w); // new worker, no memory
    b2.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: 5, url: URL_WS } });
    await b2.fireAlarm();

    assert.deepEqual(w.removed, [900], 'leftover tab closed');
    const r = w.idb.get(KEY)[0];
    assert.equal(r.state.failures, 1);
    assert.ok(r.state.retryAt > Date.now());
    assert.match(r.state.lastResult, /interrupted/);
    assert.equal(r.state.lastCronMinute, undefined, 'schedule not advanced');
    const entry = w.idb.get(LOG).at(-1).results[0];
    assert.equal(entry.routineId, 'r');
    assert.equal(entry.success, false);
    assert.match(entry.error, /interrupted/);
    const f = w.idb.get(FAILS);
    assert.equal(f.length, 1);
    assert.equal(f[0].wsId, 'ws1');
    assert.equal(w.idb.get(ATTEMPTS).length, 0, 'record cleared');
    assert.equal(w.created.length, 1, 'no new attempt in the same alarm: the backoff applies');
  });

  it('and the failure is visible through routine_failures', async () => {
    const w = world();
    worker(w, { hang: true }).fireAlarm();
    await wait(30);
    const b2 = worker(w);
    b2.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: 5, url: URL_WS } });
    await b2.fireAlarm();
    const r = await b2.send('routine_failures', { wsId: 'ws1', since: 0 }, { tab: { id: 5, url: URL_WS } });
    assert.equal(r.result.failures.length, 1);
    assert.match(r.result.failures[0].error, /interrupted/);
  });

  it('does not close a tab that is no longer on a clawser origin (id reuse)', async () => {
    const w = world();
    worker(w, { hang: true }).fireAlarm();
    await wait(30);
    w.tabs.set(900, { id: 900, url: 'https://news.example.com/' }); // the id now belongs to something else
    const b2 = worker(w);
    b2.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: 5, url: URL_WS } });
    await b2.fireAlarm();
    assert.deepEqual(w.removed, []);
    assert.equal(w.idb.get(KEY)[0].state.failures, 1);
  });

  it('copes when the leftover tab is already gone', async () => {
    const w = world();
    worker(w, { hang: true }).fireAlarm();
    await wait(30);
    w.tabs.delete(900);
    const b2 = worker(w);
    b2.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: 5, url: URL_WS } });
    await b2.fireAlarm();
    assert.equal(w.idb.get(KEY)[0].state.failures, 1);
  });

  it('an attempt for a routine the page deleted meanwhile is cleared and not resurrected', async () => {
    const w = world();
    worker(w, { hang: true }).fireAlarm();
    await wait(30);
    w.idb.set(KEY, []);
    const b2 = worker(w);
    b2.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: 5, url: URL_WS } });
    await b2.fireAlarm();
    assert.deepEqual(w.idb.get(KEY), []);
    assert.equal(w.idb.get(ATTEMPTS).length, 0);
  });

  it('a record owned by a LIVE attempt in this worker is not treated as orphaned', async () => {
    const w = world();
    const b = worker(w, { ready: 40, execOk: true });
    const run = b.fireAlarm();
    await wait(10);
    await b.fireAlarm(); // overlapping alarm: guard returns, and must not "recover" the live attempt
    await run;
    assert.equal(w.idb.get(KEY)[0].state.lastResult, 'executed');
    assert.equal(w.idb.get(KEY)[0].state.failures, undefined);
  });
});

describe('a normal attempt leaves no stale record', () => {
  it('success', async () => {
    const w = world();
    const b = worker(w, { ready: 5 });
    await b.fireAlarm();
    assert.equal(w.idb.get(KEY)[0].state.lastResult, 'executed');
    assert.deepEqual(w.idb.get(ATTEMPTS), []);
    assert.deepEqual(w.removed, [900]);
  });

  it('a failed run (page reports an error)', async () => {
    const w = world();
    const b = worker(w, { ready: 5, execOk: false });
    await b.fireAlarm();
    assert.deepEqual(w.idb.get(ATTEMPTS), []);
    assert.equal(w.idb.get(KEY)[0].state.failures, 1);
    // a second worker finds nothing to recover (no double failure)
    const b2 = worker(w);
    b2.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: 5, url: URL_WS } });
    await b2.fireAlarm();
    assert.equal(w.idb.get(KEY)[0].state.failures, 1);
  });

  it('a tab that cannot be created', async () => {
    const w = world();
    const b = worker(w);
    b.chrome.tabs.create = async () => { throw new Error('nope'); };
    await b.fireAlarm();
    assert.deepEqual(w.idb.get(ATTEMPTS), []);
  });
});

describe('fail fast when the opened tab cannot load', () => {
  const errorUpdate = (b, tabId) => b.tabUpdated(tabId, { url: 'chrome-error://chromewebdata/', status: 'complete' }, { id: tabId, url: 'chrome-error://chromewebdata/' });

  it('a navigation error records the failure within seconds, not after 60 s', async () => {
    const w = world();
    const b = worker(w); // the tab never announces itself
    const t0 = Date.now();
    const run = b.fireAlarm();
    await wait(20);
    errorUpdate(b, 900);
    await run;
    assert.ok(Date.now() - t0 < 2000);
    const r = w.idb.get(KEY)[0];
    assert.equal(r.state.failures, 1);
    assert.match(r.state.lastResult, /could not load|navigation/i);
    assert.deepEqual(w.removed, [900]);
    assert.deepEqual(w.idb.get(ATTEMPTS), []);
    assert.equal(w.idb.get(FAILS).length, 1);
  });

  it('also detects the error page from tab.url alone', async () => {
    const w = world();
    const b = worker(w);
    const run = b.fireAlarm();
    await wait(20);
    b.tabUpdated(900, { status: 'complete' }, { id: 900, url: 'chrome-error://chromewebdata/' });
    await run;
    assert.equal(w.idb.get(KEY)[0].state.failures, 1);
  });

  it('ignores updates for other tabs and ordinary page loads', async () => {
    const w = world();
    const b = worker(w, { ready: 60 });
    const run = b.fireAlarm();
    await wait(15);
    errorUpdate(b, 12345);
    b.tabUpdated(900, { status: 'loading', url: URL_WS }, { id: 900, url: URL_WS });
    b.tabUpdated(900, { status: 'complete' }, { id: 900, url: URL_WS });
    await run;
    assert.equal(w.idb.get(KEY)[0].state.lastResult, 'executed');
  });

  it('an error after the page already connected does not fail a healthy run', async () => {
    const w = world();
    const b = worker(w, { ready: 5 });
    const run = b.fireAlarm();
    await wait(30);
    errorUpdate(b, 900); // too late: the wait is over
    await run;
    assert.equal(w.idb.get(KEY)[0].state.lastResult, 'executed');
  });
});

describe('manifest', () => {
  it('uses tabs.onUpdated (existing "tabs" permission): no webNavigation permission was added', async () => {
    const { readFileSync } = await import('node:fs');
    const m = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    assert.ok(m.permissions.includes('tabs'));
    assert.ok(!m.permissions.includes('webNavigation'));
  });
});
