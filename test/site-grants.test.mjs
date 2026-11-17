// Run with: node --test test/site-grants.test.mjs
// D21: a paired page acts only on tabs whose exact origin a person granted in the extension UI.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './_load-background.mjs';

const UI = { id: 'ext-id', url: 'chrome-extension://ext-id/options.html' };
const PAGE = { tab: { id: 7, url: 'https://clawser.erisera.com/' } };
const tabs = [
  { id: 1, url: 'https://shop.example.com/cart', title: 'Shop', active: true, windowId: 1 },
  { id: 2, url: 'https://bank.example.org/', title: 'Bank', active: false, windowId: 1 },
];
function fresh(extra = {}) {
  return loadBackground({
    tabs: { query: async () => tabs, get: async (id) => ({ ...tabs.find((t) => t.id === id), windowId: 1 }) },
  }, { grants: false, ...extra });
}

describe('per-site grants', () => {
  it('start empty: tabs_list is empty and every tab action is refused with site_not_granted', async () => {
    const b = fresh();
    assert.equal((await b.send('tabs_list', {})).result.length, 0);
    for (const action of ['read_page', 'screenshot', 'click', 'get_text']) {
      const r = await b.send(action, { tabId: 1, selector: 'a' });
      assert.equal(r.code, 'site_not_granted', action);
    }
    assert.equal((await b.send('tab_open', { url: 'https://shop.example.com/' })).code, 'site_not_granted');
    assert.equal((await b.send('cors_fetch', { url: 'https://shop.example.com/' })).code, 'site_not_granted');
  });

  it('only the extension UI grants a site, by exact origin', async () => {
    const b = fresh();
    const forged = await b.sendUi({ action: 'sites_add', origin: 'https://shop.example.com' }, PAGE);
    assert.ok(forged.error || forged.result === undefined, 'a page cannot reach the UI router');
    assert.deepEqual([...(await b.send('site_grants', {})).result.sites], []);
    assert.equal((await b.sendUi({ action: 'sites_add', origin: 'https://shop.example.com' }, UI)).result.ok, true);
    assert.deepEqual([...(await b.send('site_grants', {})).result.sites], ['https://shop.example.com']);
    assert.equal((await b.send('tabs_list', {})).result.length, 1);
    assert.equal((await b.send('read_page', { tabId: 2 })).code, 'site_not_granted');
  });

  it('refuses wildcards, paths, credentials, non-web schemes and <all_urls>', async () => {
    const b = fresh();
    for (const bad of ['*', '<all_urls>', 'https://*.example.com', 'https://example.com/path', 'https://u:p@example.com', 'file:///tmp/x', 'chrome://extensions', 'javascript:alert(1)', '', 5]) {
      const r = (await b.sendUi({ action: 'sites_add', origin: bad }, UI)).result;
      assert.equal(r.ok, false, String(bad));
    }
    assert.equal((await b.sendUi({ action: 'sites_overview' }, UI)).result.sites.length, 0);
  });

  it('a navigation off a granted site is refused, and revoking takes effect at once', async () => {
    const b = fresh();
    await b.sendUi({ action: 'sites_add', origin: 'https://shop.example.com' }, UI);
    assert.equal((await b.send('navigate', { tabId: 1, url: 'https://bank.example.org/' })).code, 'site_not_granted');
    await b.sendUi({ action: 'sites_remove', origin: 'https://shop.example.com' }, UI);
    assert.equal((await b.send('read_page', { tabId: 1 })).code, 'site_not_granted');
    assert.equal((await b.send('tabs_list', {})).result.length, 0);
  });

  it('an action with no tabId acts on the active tab only when that tab is granted', async () => {
    const b = fresh({ storage: {} });
    assert.equal((await b.send('read_page', {})).code, 'site_not_granted');
  });
});

describe('audit log persistence', () => {
  it('survives a service-worker restart and only the extension UI clears it', async () => {
    const a = fresh();
    await a.send('read_page', { tabId: 1 }); // refused, still audited
    await a.sendUi({ action: 'audit_get' }, UI);
    await new Promise((r) => setTimeout(r, 400)); // debounce
    assert.ok(Array.isArray(a.localStore.auditLog) && a.localStore.auditLog.length > 0);
    const b = fresh({ storage: { auditLog: a.localStore.auditLog } });
    const entries = (await b.sendUi({ action: 'audit_get' }, UI)).result.entries;
    assert.ok(entries.some((e) => e.action === 'read_page'));
    assert.ok((await b.send('audit_log', { clear: true })).result.entries.length >= entries.length, 'a page cannot clear');
    await b.sendUi({ action: 'audit_clear' }, UI);
    assert.equal(b.localStore.auditLog.length, 0);
  });
});
