// Run with: node --test test/background-routines-sync.test.mjs
// clawser#377: the page and the extension have SEPARATE IndexedDB stores, so routines reach the
// scheduler only through a `routines_sync` notify. These tests never seed the extension's store
// directly; they push from "the page" and, for the cold start, rebuild the service worker.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground, makeFakeIndexedDB } from './_load-background.mjs';

const KEY = 'background_routine_state';
const URL_WS = 'https://clawser.erisera.com/#workspace/ws1';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const interval = (id, extra = {}) => ({ id, name: id, enabled: true, trigger: { type: 'interval', intervalMs: 60000 }, actionType: 'btask_monitor', ...extra });
const cron = (id, expr = '* * * * *') => ({ id, name: id, enabled: true, trigger: { type: 'cron', cron: expr }, actionType: 'prompt' });
const once = (id, at) => ({ id, name: id, enabled: true, trigger: { type: 'once', at }, actionType: 'prompt' });
const stored = (b) => b.idbStore.get(KEY) || [];

/** Page tab that executes whatever it is asked to, reporting success. */
function liveTabs(b, executed, extra = {}) {
  return {
    get: async (id) => ({ id, windowId: 1, url: URL_WS }),
    sendMessage: async (tabId, msg) => {
      if (msg.action !== 'execute_routine') return;
      executed.push(msg.routineId);
      setTimeout(() => b().notify('routine_executed', { routineId: msg.routineId, success: true, error: null }, { tab: { id: tabId } }), 2);
    },
    ...extra,
  };
}

describe('the harness keeps the two origins apart', () => {
  it('the page store and the extension store are different instances', () => {
    const b = loadBackground();
    assert.notEqual(b.pageIdb, b.idbStore);
    b.pageIdb.set(KEY, [{ id: 'page-only' }]);
    assert.equal(b.idbStore.get(KEY), undefined);
  });

  it('routines written only to the page store never run', async () => {
    const executed = [];
    let b; b = loadBackground({ tabs: liveTabs(() => b, executed) });
    b.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: 5, url: URL_WS } });
    b.pageIdb.set(KEY, [{ id: 'a', enabled: true, trigger: { type: 'cron', cron: '* * * * *' }, state: {} }]);
    await b.fireAlarm();
    assert.deepEqual(executed, []);
  });
});

describe('routines_sync', () => {
  it('stores the page routines in the extension store, tagged with the wsId', async () => {
    const b = loadBackground();
    await b.pageSync([interval('a'), cron('b'), once('c', 5000)]);
    const list = stored(b);
    assert.deepEqual(list.map((r) => r.id), ['a', 'b', 'c']);
    assert.ok(list.every((r) => r.wsId === 'ws1'));
    assert.deepEqual(list[1].trigger, { type: 'cron', cron: '* * * * *' });
    assert.equal(list[0].actionType, 'btask_monitor');
  });

  it('a new interval routine waits one interval before its first run', async () => {
    const executed = [];
    let b; b = loadBackground({ tabs: liveTabs(() => b, executed) });
    b.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: 5, url: URL_WS } });
    await b.pageSync([interval('a')]);
    await b.fireAlarm();
    assert.deepEqual(executed, []);
    assert.ok(stored(b)[0].meta.lastFired > 0);
  });

  it('an interval routine that is due runs; a once routine runs once; a cron routine runs', async () => {
    const executed = [];
    let b; b = loadBackground({ tabs: liveTabs(() => b, executed) });
    b.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: 5, url: URL_WS } });
    await b.pageSync([interval('i'), cron('c'), once('o', 1000)]);
    const list = stored(b); list.find((r) => r.id === 'i').meta.lastFired = Date.now() - 120000; b.idbStore.set(KEY, list);
    await b.fireAlarm();
    await wait(30);
    assert.deepEqual(executed.sort(), ['c', 'i', 'o']);
    assert.equal(stored(b).find((r) => r.id === 'o').meta.fired, true);
    executed.length = 0;
    await b.fireAlarm();
    assert.ok(!executed.includes('o'), 'a fired one-shot never runs again');
  });

  it('a disabled routine never runs', async () => {
    const executed = [];
    let b; b = loadBackground({ tabs: liveTabs(() => b, executed) });
    b.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: 5, url: URL_WS } });
    await b.pageSync([cron('c', '* * * * *')].map((r) => ({ ...r, enabled: false })));
    await b.fireAlarm();
    assert.deepEqual(executed, []);
  });

  it('keeps the extension bookkeeping by id and takes definitions from the page', async () => {
    const b = loadBackground();
    await b.pageSync([interval('a'), interval('b')]);
    const list = stored(b);
    list[0].state = { lastRun: 11, lastResult: 'executed', runCount: 4, lastCronMinute: 7 };
    list[0].meta = { lastFired: 999 };
    b.idbStore.set(KEY, list);
    await b.pageSync([interval('a', { name: 'Renamed', enabled: false, trigger: { type: 'interval', intervalMs: 900000 } }), interval('b')]);
    const a = stored(b).find((r) => r.id === 'a');
    assert.equal(a.name, 'Renamed');
    assert.equal(a.enabled, false);
    assert.equal(a.trigger.intervalMs, 900000);
    assert.deepEqual(a.state, { lastRun: 11, lastResult: 'executed', runCount: 4, lastCronMinute: 7 });
    assert.equal(a.meta.lastFired, 999);
  });

  it('removes ids that are missing from the sync, and an empty list clears the workspace', async () => {
    const b = loadBackground();
    await b.pageSync([interval('a'), interval('b')]);
    await b.pageSync([interval('b')]);
    assert.deepEqual(stored(b).map((r) => r.id), ['b']);
    await b.pageSync([]);
    assert.deepEqual(stored(b), []);
  });

  it('is keyed by wsId: one workspace never removes or runs another one\'s routines', async () => {
    const executed = [];
    let b; b = loadBackground({ tabs: liveTabs(() => b, executed, { get: async (id) => ({ id, windowId: 1, url: 'https://clawser.erisera.com/#workspace/wsB' }) }) });
    await b.pageSync([cron('x')], { wsId: 'wsA' });
    await b.pageSync([cron('y')], { wsId: 'wsB', url: 'https://clawser.erisera.com/#workspace/wsB' });
    assert.deepEqual(stored(b).map((r) => `${r.wsId}:${r.id}`).sort(), ['wsA:x', 'wsB:y']);
    await b.pageSync([], { wsId: 'wsA' });
    assert.deepEqual(stored(b).map((r) => `${r.wsId}:${r.id}`), ['wsB:y']);
    // wsB is the workspace whose URL is known now, so only its routines run
    await b.pageSync([cron('x')], { wsId: 'wsA', url: 'https://clawser.erisera.com/#workspace/wsA' });
    b.notify('workspace_ready', { wsId: 'wsB' }, { tab: { id: 5, url: 'https://clawser.erisera.com/#workspace/wsB' } });
    await b.fireAlarm();
    await wait(30);
    assert.deepEqual(executed, ['y']);
  });

  it('the merge happens in one readwrite transaction (page sync during a run is not lost)', async () => {
    const executed = [];
    let b; b = loadBackground({ tabs: liveTabs(() => b, executed, {
      sendMessage: async (tabId, msg) => {
        if (msg.action !== 'execute_routine') return;
        await b.pageSync([cron('a'), cron('added-meanwhile')]);
        setTimeout(() => b.notify('routine_executed', { routineId: 'a', success: true, error: null }, { tab: { id: tabId } }), 2);
      },
    }) });
    b.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: 5, url: URL_WS } });
    await b.pageSync([cron('a')]);
    await b.fireAlarm();
    const list = stored(b);
    assert.deepEqual(list.map((r) => r.id).sort(), ['a', 'added-meanwhile']);
    assert.equal(list.find((r) => r.id === 'a').state.lastResult, 'executed');
  });
});

describe('routines_sync validation and origin', () => {
  const synced = async (routines, opts) => { const b = loadBackground(); await b.pageSync(routines, opts); return stored(b); };

  it('accepts only senders on an allowed origin', async () => {
    for (const tabUrl of ['https://evil.example/', 'http://clawser.erisera.com/', 'https://clawser.erisera.com.evil.com/', 'chrome://x']) {
      assert.deepEqual(await synced([cron('a')], { tabUrl }), [], tabUrl);
    }
    for (const tabUrl of ['http://localhost:5173/', 'http://127.0.0.1:8080/', 'https://clawser.erisera.com/x', 'file:///a/index.html']) {
      assert.equal((await synced([cron('a')], { tabUrl })).length, 1, tabUrl);
    }
  });

  it('accepts the configured custom origin and nothing else on that host', async () => {
    const mk = () => loadBackground({}, { storage: { clawserOrigin: 'https://c.example.com' } });
    let b = mk(); await b.pageSync([cron('a')], { tabUrl: 'https://c.example.com/app' }); assert.equal(stored(b).length, 1);
    b = mk(); await b.pageSync([cron('a')], { tabUrl: 'https://c.example.com:444/app' }); assert.equal(stored(b).length, 0);
  });

  it('ignores a message with no sender tab, a bad wsId, or a non-array routine list', async () => {
    const b = loadBackground();
    b.hooks.listener({ type: '__clawser_ext__', direction: 'notify', action: 'routines_sync', wsId: 'ws1', routines: [cron('a')] }, {}, () => {});
    await wait(15);
    for (const wsId of ['', 42, null, 'x'.repeat(200)]) await b.pageSync([cron('a')], { wsId });
    await b.pageSync('nope');
    await b.pageSync(null);
    assert.deepEqual(stored(b), []);
  });

  it('drops invalid entries and keeps the valid ones', async () => {
    const list = await synced([
      cron('ok'),
      cron('bad-cron', '99 * * * *'),
      cron('bad-cron2', 'not a cron'),
      { id: '', name: 'x', enabled: true, trigger: { type: 'cron', cron: '* * * * *' } },
      { id: 'bad id!', name: 'x', enabled: true, trigger: { type: 'cron', cron: '* * * * *' } },
      { id: 'no-trigger', name: 'x', enabled: true },
      { id: 'weird-type', name: 'x', enabled: true, trigger: { type: 'webhook' } },
      { id: 'bad-interval', name: 'x', enabled: true, trigger: { type: 'interval', intervalMs: 'soon' } },
      { id: 'bad-once', name: 'x', enabled: true, trigger: { type: 'once', at: 'never' } },
      null, 7, 'str',
      interval('ok2'),
    ]);
    assert.deepEqual(list.map((r) => r.id), ['ok', 'ok2']);
  });

  it('clamps: interval at least 60000 ms, names to 200 characters, at most 500 routines', async () => {
    const list = await synced([interval('fast', { trigger: { type: 'interval', intervalMs: 5 } }), interval('long', { name: 'n'.repeat(500) })]);
    assert.equal(list[0].trigger.intervalMs, 60000);
    assert.equal(list[1].name.length, 200);
    const many = await synced(Array.from({ length: 700 }, (_, i) => cron(`r${i}`)));
    assert.equal(many.length, 500);
  });

  it('keeps the first of duplicate ids, treats enabled strictly, and never stores an action payload', async () => {
    const list = await synced([
      cron('d'), { ...cron('d'), name: 'second' },
      { ...cron('truthy'), enabled: 'yes' },
      { ...cron('payload'), action: { type: 'agent_prompt', prompt: 'rm -rf' }, actionPayload: { x: 1 } },
    ]);
    assert.equal(list.find((r) => r.id === 'd').name, 'd');
    assert.equal(list.find((r) => r.id === 'truthy').enabled, false);
    const p = list.find((r) => r.id === 'payload');
    assert.deepEqual(p.action, { type: 'prompt' });
    assert.equal('actionPayload' in p, false);
  });

  it('is not reachable from the request/response relay', async () => {
    const b = loadBackground();
    const r = await b.send('routines_sync', { wsId: 'ws1', routines: [cron('a')] });
    assert.match(r.error, /Unknown action/i);
    assert.deepEqual(stored(b), []);
  });
});

describe('workspace reference survives a service-worker restart', () => {
  it('persists {wsId, url, lastSeen} on workspace_ready and on routines_sync', async () => {
    const b = loadBackground();
    b.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: 5, url: URL_WS } });
    await wait(15);
    const ref = b.localStore.workspaceRef;
    assert.equal(ref.wsId, 'ws1'); assert.equal(ref.url, URL_WS); assert.ok(ref.lastSeen > 0);
    const b2 = loadBackground();
    await b2.pageSync([cron('a')], { wsId: 'ws9', url: 'https://clawser.erisera.com/#workspace/ws9' });
    assert.equal(b2.localStore.workspaceRef.wsId, 'ws9');
  });

  it('does not persist a reference from a disallowed origin', async () => {
    const b = loadBackground();
    await b.pageSync([cron('a')], { tabUrl: 'https://evil.example/' });
    assert.equal(b.localStore.workspaceRef, undefined);
  });

  it('COLD START: memory cleared, alarm fires, a background tab opens at the persisted URL and the routine executes', async () => {
    // Session 1: the page connects and syncs, then the service worker is killed.
    const first = loadBackground();
    first.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: 5, url: URL_WS } });
    await first.pageSync([cron('a')]);
    const persistedStore = first.localStore;
    const extIdb = first.idbStore;

    // Session 2: a brand-new worker (no memory), same extension storage and IndexedDB.
    const created = []; const removed = []; const executed = []; const updates = [];
    let b;
    b = loadBackground({
      tabs: {
        get: async () => { throw new Error('gone'); },
        query: async () => [],
        create: async (o) => {
          const tab = { id: 77, url: o.url }; created.push({ ...o });
          setTimeout(() => b.notify('workspace_ready', { wsId: 'ws1' }, { tab: { id: 77, url: o.url } }), 5);
          return tab;
        },
        sendMessage: async (tabId, msg) => {
          if (msg.action !== 'execute_routine') return;
          executed.push({ tabId, id: msg.routineId });
          setTimeout(() => b.notify('routine_executed', { routineId: msg.routineId, success: true, error: null }, { tab: { id: tabId } }), 5);
        },
        remove: async (id) => { removed.push(id); },
        update: async (id, p) => { updates.push([id, p]); return {}; },
      },
    }, { storage: persistedStore, idbStore: extIdb });
    await b.fireAlarm();
    assert.equal(created.length, 1);
    assert.equal(created[0].url, URL_WS);
    assert.equal(created[0].active, false);
    assert.deepEqual(executed, [{ tabId: 77, id: 'a' }]);
    assert.deepEqual(removed, [77]);
    assert.deepEqual(updates, []);
    assert.equal(extIdb.get(KEY)[0].state.lastResult, 'executed');
  });

  it('cold start does not open a persisted URL whose origin is no longer allowed', async () => {
    const created = [];
    const b = loadBackground({ tabs: { get: async () => { throw new Error('gone'); }, create: async (o) => { created.push(o); return { id: 1, url: o.url }; } } },
      { storage: { workspaceRef: { wsId: 'ws1', url: 'https://old-custom.example.com/#workspace/ws1', lastSeen: 1 } } });
    b.idbStore.set(KEY, [{ id: 'a', wsId: 'ws1', name: 'a', enabled: true, trigger: { type: 'cron', cron: '* * * * *' }, state: {}, meta: {} }]);
    await b.fireAlarm();
    assert.deepEqual(created, []);
    assert.equal(b.idbStore.get(KEY)[0].state.lastResult, undefined, 'a workspace with no known URL is not run');
  });

  it('cold start ignores a corrupt persisted reference', async () => {
    for (const workspaceRef of ['x', { wsId: 5, url: 'https://clawser.erisera.com/' }, { wsId: 'w', url: 'javascript:alert(1)' }, null]) {
      const created = [];
      const b = loadBackground({ tabs: { create: async (o) => { created.push(o); return { id: 1 }; } } }, { storage: { workspaceRef } });
      b.idbStore.set(KEY, [{ id: 'a', name: 'a', enabled: true, trigger: { type: 'cron', cron: '* * * * *' }, state: {} }]);
      await b.fireAlarm();
      assert.deepEqual(created, [], JSON.stringify(workspaceRef));
    }
  });

  it('a live workspace_ready that arrives before the stored reference loads wins', async () => {
    const b = loadBackground({}, { storage: { workspaceRef: { wsId: 'old', url: 'https://clawser.erisera.com/#old', lastSeen: 1 } } });
    b.notify('workspace_ready', { wsId: 'new' }, { tab: { id: 5, url: 'https://clawser.erisera.com/#new' } });
    await wait(20);
    assert.equal(b.localStore.workspaceRef.wsId, 'new');
  });
});
