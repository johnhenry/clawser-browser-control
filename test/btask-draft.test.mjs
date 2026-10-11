// Run with: node --test test/btask-draft.test.mjs
// Side panel -> background -> clawser tab: draft, list, inbox.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './_load-background.mjs';

const MARKER = '__clawser_ext__';
const PANEL = { id: 'ext-id', url: 'chrome-extension://ext-id/sidepanel.html' };

const CLAWSER_TAB = { id: 50, windowId: 7, url: 'https://clawser.erisera.com/', title: 'Clawser', active: false, lastAccessed: 100 };
const NEWS_TAB = { id: 11, windowId: 7, url: 'https://news.example.com/a?x=1', title: 'News A', active: true };
const SHOP_TAB = { id: 12, windowId: 7, url: 'https://shop.example.com/p', title: 'Shop P', active: false };

/** Build a background with the given tabs and a programmable clawser page. */
function setup({ tabs = [CLAWSER_TAB, NEWS_TAB, SHOP_TAB], reply, storage } = {}) {
  const sent = []; // { tabId, msg } for real requests (pings excluded)
  const calls = []; // every tabs.sendMessage, pings included
  const updates = [];
  const winUpdates = [];
  const created = [];
  const allTabs = [...tabs];
  const b = loadBackground({
    tabs: {
      query: async () => allTabs.map((t) => ({ ...t })),
      get: async (id) => { const t = allTabs.find((x) => x.id === id); if (!t) throw new Error('No tab with id'); return { ...t }; },
      sendMessage: async (tabId, msg) => {
        calls.push({ tabId, msg });
        if (msg.request?.type !== 'clawser.btask.ping') sent.push({ tabId, msg });
        const t = allTabs.find((x) => x.id === tabId);
        if (!t) throw new Error('Could not establish connection');
        return reply ? reply(tabId, msg) : { result: { accepted: true } };
      },
      update: async (id, props) => { updates.push({ id, props }); return { id, windowId: 7 }; },
      create: async (o) => { const t = { id: 900 + created.length, windowId: 7, url: o.url }; created.push(o); allTabs.push(t); return t; },
    },
    windows: { update: async (id, props) => { winUpdates.push({ id, props }); return { id }; } },
  }, { storage, setTimeoutImpl: (fn, ms) => setTimeout(fn, ms >= 10000 ? ms : Math.min(ms, 1)) });
  return { b, sent, calls, updates, winUpdates, created, allTabs };
}

const tabSource = (t) => ({ kind: 'tab', tabId: t.id });

describe('btask_draft from the side panel', () => {
  it('sends the contract draft to the connected clawser tab and focuses it', async () => {
    const { b, sent, updates, winUpdates } = setup();
    const r = await b.sendUi({ action: 'btask_draft', kind: 'compare', sources: [tabSource(NEWS_TAB), tabSource(SHOP_TAB)] }, PANEL);
    assert.equal(r.result.ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].tabId, 50);
    assert.equal(sent[0].msg.type, MARKER);
    assert.equal(sent[0].msg.direction, 'btask_request');
    const req = sent[0].msg.request;
    assert.equal(req.type, 'clawser.btask.draft');
    assert.equal(req.kind, 'compare');
    assert.equal(req.origin, 'sidepanel');
    assert.equal(req.sources.length, 2);
    assert.equal(req.sources[0].kind, 'tab');
    assert.equal(req.sources[0].url, NEWS_TAB.url);   // re-resolved from the real tab
    assert.equal(req.sources[0].title, 'News A');
    assert.equal(req.sources[0].tabId, 11);
    assert.match(req.sources[0].capturedAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal('id' in req.sources[0], false);       // amendment A1: no id / requires
    assert.equal('requires' in req.sources[0], false);
    assert.deepEqual(JSON.parse(JSON.stringify(updates)), [{ id: 50, props: { active: true } }]);
    assert.deepEqual(JSON.parse(JSON.stringify(winUpdates)), [{ id: 7, props: { focused: true } }]);
  });

  it('takes url/title from the real tab, not from what the panel claims', async () => {
    const { b, sent } = setup();
    await b.sendUi({ action: 'btask_draft', kind: 'extract', sources: [{ kind: 'tab', tabId: 11, url: 'https://lies.example/', title: 'lies' }] }, PANEL);
    assert.equal(sent[0].msg.request.sources[0].url, NEWS_TAB.url);
    assert.equal(sent[0].msg.request.sources[0].title, 'News A');
  });

  it('origin is forced to "sidepanel" regardless of what the caller sends', async () => {
    const { b, sent } = setup();
    await b.sendUi({ action: 'btask_draft', kind: 'extract', origin: 'contextmenu', sources: [tabSource(NEWS_TAB)] }, PANEL);
    assert.equal(sent[0].msg.request.origin, 'sidepanel');
  });

  it('accepts kind "monitor" (Watch page) and forwards it unchanged', async () => {
    const { b, sent } = setup();
    const r = await b.sendUi({ action: 'btask_draft', kind: 'monitor', sources: [tabSource(NEWS_TAB)] }, PANEL);
    assert.equal(r.result.ok, true);
    assert.equal(sent[0].msg.request.kind, 'monitor');
    assert.equal(sent[0].msg.request.origin, 'sidepanel');
  });

  it('rejects an unknown kind, no sources, too many sources, and non-http(s) tabs', async () => {
    const { b, sent } = setup({ tabs: [CLAWSER_TAB, NEWS_TAB, { id: 13, windowId: 7, url: 'chrome://extensions', title: 'x' }] });
    const bad = [
      { kind: 'delete', sources: [tabSource(NEWS_TAB)] },
      { kind: 'extract', sources: [] },
      { kind: 'extract' },
      { kind: 'extract', sources: Array.from({ length: 21 }, () => tabSource(NEWS_TAB)) },
      { kind: 'extract', sources: [{ kind: 'tab', tabId: 13 }] },
      { kind: 'extract', sources: [{ kind: 'tab', tabId: 404 }] },
      { kind: 'extract', sources: [{ kind: 'tab', tabId: 'x' }] },
    ];
    for (const m of bad) {
      const r = await b.sendUi({ action: 'btask_draft', ...m }, PANEL);
      assert.ok(r.error || r.result?.ok === false, `should reject ${JSON.stringify(m).slice(0, 80)}`);
    }
    assert.equal(sent.length, 0);
  });

  it('refuses callers that are not an extension page', async () => {
    const { b, sent } = setup();
    const r = await b.sendUi({ action: 'btask_draft', kind: 'extract', sources: [tabSource(NEWS_TAB)] },
      { id: 'ext-id', tab: { id: 11 }, url: 'https://news.example.com/a' });
    assert.ok(r.error);
    assert.equal(sent.length, 0);
  });

  it('cannot be reached through the page relay', async () => {
    const { b, sent } = setup();
    const r = await b.send('btask_draft', { kind: 'extract', sources: [tabSource(NEWS_TAB)] });
    assert.match(r.error, /Unknown action/i);
    assert.equal(sent.length, 0);
  });

  it('prefers the most recently used clawser tab', async () => {
    const other = { id: 51, windowId: 8, url: 'http://localhost:5173/', title: 'Clawser dev', lastAccessed: 999 };
    const { b, sent } = setup({ tabs: [CLAWSER_TAB, other, NEWS_TAB] });
    await b.sendUi({ action: 'btask_draft', kind: 'extract', sources: [tabSource(NEWS_TAB)] }, PANEL);
    assert.equal(sent[0].tabId, 51);
  });

  it('falls through to the next clawser tab when the first has no responding page', async () => {
    const other = { id: 51, windowId: 8, url: 'http://localhost:5173/', title: 'dev', lastAccessed: 999 };
    const { b, sent, calls } = setup({
      tabs: [CLAWSER_TAB, other, NEWS_TAB],
      reply: (tabId) => (tabId === 51 ? { transportError: 'no_response' } : { result: { accepted: true } }),
    });
    const r = await b.sendUi({ action: 'btask_draft', kind: 'extract', sources: [tabSource(NEWS_TAB)] }, PANEL);
    assert.equal(r.result.ok, true);
    assert.deepEqual(calls.map((s) => s.tabId), [51, 50, 50]);
    assert.deepEqual(sent.map((s) => s.tabId), [50]);
  });

  it('surfaces a validation error returned by clawser without trying other tabs or focusing', async () => {
    const { b, sent, updates } = setup({ reply: () => ({ error: 'too many sources' }) });
    const r = await b.sendUi({ action: 'btask_draft', kind: 'extract', sources: [tabSource(NEWS_TAB)] }, PANEL);
    assert.equal(r.result.ok, false);
    assert.match(r.result.error, /too many sources/);
    assert.equal(sent.length, 1);
    assert.equal(updates.length, 0);
  });

  it('does not use a tab that merely looks like clawser', async () => {
    const fake = { id: 60, windowId: 7, url: 'https://clawser.erisera.com.evil.com/', title: 'fake', lastAccessed: 9999 };
    const { b, sent } = setup({ tabs: [fake, NEWS_TAB, CLAWSER_TAB] });
    await b.sendUi({ action: 'btask_draft', kind: 'extract', sources: [tabSource(NEWS_TAB)] }, PANEL);
    assert.ok(sent.every((s) => s.tabId !== 60));
  });
});

describe('opening clawser when none is connected', () => {
  it('opens the production origin, retries until the page acks, then focuses it', async () => {
    let attempts = 0;
    const { b, created, updates, calls } = setup({
      tabs: [NEWS_TAB],
      reply: () => { attempts++; if (attempts < 3) throw new Error('Could not establish connection. Receiving end does not exist.'); return { result: { accepted: true } }; },
    });
    const r = await b.sendUi({ action: 'btask_draft', kind: 'extract', sources: [tabSource(NEWS_TAB)] }, PANEL);
    assert.equal(r.result.ok, true);
    assert.equal(r.result.opened, true);
    assert.equal(created.length, 1);
    assert.equal(created[0].url, 'https://clawser.erisera.com/');
    assert.ok(calls.length >= 3);
    assert.equal(updates.at(-1).id, 900);
  });

  it('opens the configured custom origin when one is set', async () => {
    const { b, created } = setup({ tabs: [NEWS_TAB], storage: { clawserOrigin: 'https://c.example.com' } });
    await b.sendUi({ action: 'btask_draft', kind: 'extract', sources: [tabSource(NEWS_TAB)] }, PANEL);
    assert.equal(created[0].url, 'https://c.example.com/');
  });

  it('two rapid drafts open only one clawser tab', async () => {
    let ready = false;
    const { b, created } = setup({
      tabs: [NEWS_TAB, SHOP_TAB],
      reply: () => { if (!ready) { ready = true; throw new Error('no receiver'); } return { result: { accepted: true } }; },
    });
    const [a, c] = await Promise.all([
      b.sendUi({ action: 'btask_draft', kind: 'extract', sources: [tabSource(NEWS_TAB)] }, PANEL),
      b.sendUi({ action: 'btask_draft', kind: 'extract', sources: [tabSource(SHOP_TAB)] }, PANEL),
    ]);
    assert.equal(created.length, 1);
    assert.equal(a.result.ok, true);
    assert.equal(c.result.ok, true);
  });

  it('gives up with a clear error if the opened page never answers', async () => {
    const { b } = setup({ tabs: [NEWS_TAB], reply: () => { throw new Error('no receiver'); } });
    const r = await b.sendUi({ action: 'btask_draft', kind: 'extract', sources: [tabSource(NEWS_TAB)] }, PANEL);
    assert.equal(r.result.ok, false);
    assert.match(r.result.error, /did not respond|open clawser/i);
  });
});

describe('btask_list / btask_inbox', () => {
  it('returns clawser data verbatim-shaped when connected', async () => {
    const defs = [{ id: 'd1', kind: 'compare', name: 'Prices', updatedAt: '2026-10-10T00:00:00Z', lastRun: { id: 'r1', status: 'completed', finishedAt: '2026-10-10T00:01:00Z' } }];
    const { b, sent, updates } = setup({ reply: (_t, m) => ({ result: m.request.type === 'clawser.btask.list' ? { definitions: defs } : { notifications: [{ id: 'n1', title: 'Done', body: 'b', read: false, at: 'x', kind: 'run_finished' }] } }) });
    const l = await b.sendUi({ action: 'btask_list' }, PANEL);
    assert.deepEqual(JSON.parse(JSON.stringify(l.result)), { connected: true, definitions: defs });
    const i = await b.sendUi({ action: 'btask_inbox' }, PANEL);
    assert.equal(i.result.connected, true);
    assert.equal(i.result.notifications[0].id, 'n1');
    assert.equal(sent[0].msg.request.type, 'clawser.btask.list');
    assert.equal(updates.length, 0, 'list/inbox must not steal focus');
  });

  it('reports connected:false with no fake data and opens nothing when no clawser tab exists', async () => {
    const { b, created } = setup({ tabs: [NEWS_TAB] });
    const l = await b.sendUi({ action: 'btask_list' }, PANEL);
    assert.deepEqual(JSON.parse(JSON.stringify(l.result)), { connected: false });
    const i = await b.sendUi({ action: 'btask_inbox' }, PANEL);
    assert.deepEqual(JSON.parse(JSON.stringify(i.result)), { connected: false });
    assert.equal(created.length, 0);
  });

  it('reports connected:false when the clawser tab has no ready receiver', async () => {
    const { b } = setup({ reply: () => ({ transportError: 'no_response' }) });
    const l = await b.sendUi({ action: 'btask_list' }, PANEL);
    assert.equal(l.result.connected, false);
  });

  it('drops malformed replies instead of passing them on', async () => {
    const { b } = setup({ reply: () => ({ result: { definitions: 'nope' } }) });
    const l = await b.sendUi({ action: 'btask_list' }, PANEL);
    assert.equal(l.result.connected, true);
    assert.deepEqual([...l.result.definitions], []);
  });

  it('clamps oversized replies', async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ id: `d${i}`, kind: 'extract', name: 'x'.repeat(1000), updatedAt: 'u', lastRun: null }));
    const { b } = setup({ reply: () => ({ result: { definitions: many } }) });
    const l = await b.sendUi({ action: 'btask_list' }, PANEL);
    assert.ok(l.result.definitions.length <= 100);
    assert.ok(l.result.definitions[0].name.length <= 200);
  });

  it('refuses non-extension callers', async () => {
    const { b } = setup();
    const r = await b.sendUi({ action: 'btask_list' }, { id: 'ext-id', tab: { id: 1 }, url: 'http://localhost/' });
    assert.ok(r.error);
  });
});

describe('btask_open (side panel "Open clawser" button)', () => {
  it('focuses an existing clawser tab without creating one', async () => {
    const { b, created, updates } = setup();
    const r = await b.sendUi({ action: 'btask_open' }, PANEL);
    assert.equal(r.result.ok, true);
    assert.equal(created.length, 0);
    assert.equal(updates[0].id, 50);
  });

  it('opens the production origin when none exists', async () => {
    const { b, created } = setup({ tabs: [NEWS_TAB] });
    const r = await b.sendUi({ action: 'btask_open' }, PANEL);
    assert.equal(r.result.ok, true);
    assert.equal(created[0].url, 'https://clawser.erisera.com/');
  });

  it('refuses non-extension callers', async () => {
    const { b, created } = setup({ tabs: [NEWS_TAB] });
    const r = await b.sendUi({ action: 'btask_open' }, { id: 'ext-id', tab: { id: 1 }, url: 'http://localhost/' });
    assert.ok(r.error);
    assert.equal(created.length, 0);
  });
});
