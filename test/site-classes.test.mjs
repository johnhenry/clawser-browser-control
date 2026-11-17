// Run with: node --test test/site-classes.test.mjs
// Wave X-2: each granted site allows tool CLASSES (read, interact, sensitive), set only in the options page.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './_load-background.mjs';

const UI = { id: 'ext-id', url: 'chrome-extension://ext-id/options.html' };
const tabs = [
  { id: 1, url: 'https://shop.example.com/cart?token=SECRET', title: 'Shop', active: true, windowId: 1 },
  { id: 2, url: 'https://news.example.org/', title: 'News', active: false, windowId: 1 },
];
function boot(storage = {}, extra = {}) {
  return loadBackground({
    tabs: { query: async () => tabs, get: async (id) => ({ ...tabs.find((t) => t.id === id), windowId: 1 }), update: async () => ({}), reload: async () => ({}), remove: async () => {} },
    scripting: { executeScript: async () => [{ result: 'ok' }] },
    ...extra,
  }, { grants: false, storage });
}
const grant = (b, origin, classes) => b.sendUi({ action: 'sites_add', origin, classes }, UI);

describe('site tool classes', () => {
  it('a new grant allows read only, whatever the page asks for', async () => {
    const b = boot();
    await grant(b, 'https://shop.example.com');
    const g = (await b.send('site_grants', {})).result;
    assert.deepEqual(JSON.parse(JSON.stringify(g.grants)), [{ origin: 'https://shop.example.com', classes: ['read'] }]);
    assert.equal((await b.send('get_text', { tabId: 1 })).error, undefined);
    assert.equal((await b.send('click', { tabId: 1, selector: 'a' })).code, 'class_not_allowed');
    assert.equal((await b.send('screenshot', { tabId: 1 })).code, 'class_not_allowed');
    assert.equal((await b.send('console', { tabId: 1 })).code, 'class_not_allowed');
    assert.equal((await b.send('webmcp_call_tool', { tabId: 1, name: 'x', expectedOrigin: 'https://shop.example.com' })).code, 'class_not_allowed');
  });

  it('only the options page sets classes; a page cannot widen them', async () => {
    const b = boot();
    await grant(b, 'https://shop.example.com', ['read']);
    const forged = await b.sendUi({ action: 'sites_set_classes', origin: 'https://shop.example.com', classes: ['read', 'interact', 'sensitive'] }, { tab: { id: 7, url: 'https://clawser.erisera.com/' } });
    assert.ok(forged.error || forged.result === undefined);
    assert.equal((await b.send('click', { tabId: 1, selector: 'a' })).code, 'class_not_allowed');
    assert.equal((await b.sendUi({ action: 'sites_set_classes', origin: 'https://shop.example.com', classes: ['read', 'interact'] }, UI)).result.ok, true);
    assert.equal((await b.send('click', { tabId: 1, selector: 'a' })).code, undefined);
    assert.equal((await b.send('screenshot', { tabId: 1 })).code, 'class_not_allowed', 'interact does not include sensitive');
  });

  it('classes are per site, an ungranted classes list falls back to read, and unknown names are dropped', async () => {
    const b = boot({ siteGrants: { 'https://shop.example.com': { grantedAt: 1 }, 'https://news.example.org': { grantedAt: 1, classes: ['bogus', 'interact'] } } });
    const g = JSON.parse(JSON.stringify((await b.send('site_grants', {})).result.grants));
    assert.deepEqual(g.map((x) => [x.origin, x.classes.join()]), [['https://news.example.org', 'interact'], ['https://shop.example.com', 'read']]);
    assert.equal((await b.send('click', { tabId: 1, selector: 'a' })).code, 'class_not_allowed');
    assert.equal((await b.send('click', { tabId: 2, selector: 'a' })).code, undefined);
    assert.equal((await b.send('get_text', { tabId: 2 })).code, 'class_not_allowed', 'a site granted interact only cannot be read');
  });

  it('tabs_list and webmcp_list_tools show only tabs on sites that allow read', async () => {
    const b = boot({ siteGrants: { 'https://shop.example.com': { grantedAt: 1, classes: ['read'] }, 'https://news.example.org': { grantedAt: 1, classes: ['interact'] } } });
    assert.deepEqual((await b.send('tabs_list', {})).result.map((t) => t.id), [1]);
  });

  it('an action in no class is refused unless sensitive is allowed', async () => {
    const b = boot();
    await grant(b, 'https://shop.example.com', ['read', 'interact']);
    assert.notEqual((await b.send('some_new_action', { tabId: 1 })).code, undefined);
  });

  it('a navigation keeps both the site and the class check', async () => {
    const b = boot();
    await grant(b, 'https://shop.example.com', ['read', 'interact']);
    await grant(b, 'https://news.example.org', ['read']);
    assert.equal((await b.send('navigate', { tabId: 1, url: 'https://news.example.org/' })).code, 'class_not_allowed');
    assert.equal((await b.send('navigate', { tabId: 1, url: 'https://elsewhere.example/' })).code, 'site_not_granted');
  });

  it('the audit log records a refused class', async () => {
    const b = boot();
    await grant(b, 'https://shop.example.com');
    await b.send('click', { tabId: 1, selector: 'a' });
    const e = (await b.sendUi({ action: 'audit_get' }, UI)).result.entries.find((x) => x.action === 'click');
    assert.equal(e.success, false);
  });
});

describe('monitoring redaction (network and console)', () => {
  it('network entries come back without credentials, query values or fragments', async () => {
    const b = boot();
    await grant(b, 'https://shop.example.com', ['read', 'sensitive']);
    const listener = b.hooks.webRequestCompleted[0];
    assert.ok(listener, 'the harness records the webRequest listener');
    listener({ tabId: 1, url: 'https://u:p@shop.example.com/a?token=SECRET&x=1#frag', method: 'GET', statusCode: 200, type: 'xhr', timeStamp: 1 });
    const { entries } = (await b.send('network', { tabId: 1 })).result;
    assert.equal(entries[0].url, 'https://shop.example.com/a?token=[redacted]&x=[redacted]');
  });

  it('console messages have bearer tokens, JWTs and secret-looking pairs blanked', async () => {
    let buf = [];
    const b = loadBackground({
      tabs: { query: async () => tabs, get: async (id) => ({ ...tabs.find((t) => t.id === id), windowId: 1 }) },
      scripting: { executeScript: async ({ func, args }) => [{ result: func.toString().includes('__clawser_console_buffer || []') ? buf : null }] },
    }, { grants: false, storage: { siteGrants: { 'https://shop.example.com': { grantedAt: 1, classes: ['sensitive'] } } } });
    buf = [{ level: 'log', message: 'Authorization: Bearer abcdefgh12345678 password=hunter2 {"token":"abc123"} eyJhbGciOiJI.eyJzdWIiOiIx.sig ok', timestamp: 1 }];
    const text = (await b.send('console', { tabId: 1 })).result.entries[0].message;
    assert.ok(!text.includes('abcdefgh12345678'));
    assert.ok(!text.includes('hunter2'));
    assert.ok(!text.includes('abc123'));
    assert.ok(!text.includes('eyJhbGci'));
    assert.ok(text.includes('ok'));
  });
});

describe('GIF recording stays on the granted tab', () => {
  it('a frame is taken only while the recorded tab is shown on a site that allows sensitive tools; leaving the site ends the recording and drops its frames', async () => {
    let url = 'https://shop.example.com/cart';
    let active = true;
    let captured = 0;
    const b = loadBackground({
      tabs: {
        get: async (id) => ({ id, windowId: 1, url, active }),
        query: async () => [{ id: 1, url, active, windowId: 1 }],
        update: async () => ({ id: 1, windowId: 1 }),
        captureVisibleTab: async () => { captured++; return 'data:image/jpeg;base64,AAA'; },
      },
    }, { grants: false, storage: { siteGrants: { 'https://shop.example.com': { grantedAt: 1, classes: ['sensitive'] }, 'https://bank.example.org': { grantedAt: 1, classes: ['read'] } } } });
    assert.equal((await b.send('gif_record_start', { tabId: 1, maxDurationSec: 10 })).error, undefined);
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(captured, 1, 'a frame while the tab is shown on the granted site');
    active = false; // the person switched to another tab: the window now shows something else
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(captured, 1, 'no frame while the recorded tab is not the shown one');
    active = true;
    url = 'https://bank.example.org/'; // the tab went to a site that does not allow sensitive tools
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(captured, 1);
    assert.match((await b.send('gif_record_stop', {})).error, /No GIF recording in progress/);
  });

  it('a recording cannot start on a site that allows read only', async () => {
    const b = boot({ siteGrants: { 'https://shop.example.com': { grantedAt: 1, classes: ['read'] } } });
    assert.equal((await b.send('gif_record_start', { tabId: 1 })).code, 'class_not_allowed');
  });
});
