// Run with: node --test test/host-permissions.test.mjs
// Wave R-3 (0.6.0): the browser's own host permission matches the person's grants. <all_urls> is optional and requested per site from the
// options page; a grant counts only while the browser also holds the permission; the extension refuses an ungranted site even when the browser
// permission exists; 0.5.0 users are told which sites need approving again; pod-inject.js is not in the default build.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBackground } from './_load-background.mjs';
import { stage } from '../scripts/package.mjs';

const UI = { id: 'ext-id', url: 'chrome-extension://ext-id/options.html' };
const SHOP = 'https://shop.example.com';
const tabs = [{ id: 1, url: `${SHOP}/cart`, title: 'Shop', active: true, windowId: 1 }];
const chromeStub = { tabs: { query: async () => tabs, get: async (id) => ({ ...tabs.find((t) => t.id === id), windowId: 1 }) } };
const fresh = (opts = {}) => loadBackground(chromeStub, { grants: false, ...opts });
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

describe('granting needs the browser permission', () => {
  it('the options page grants only after the browser holds the permission for that exact origin', async () => {
    const b = fresh({ hostPermissions: false });
    const refused = (await b.sendUi({ action: 'sites_add', origin: SHOP }, UI)).result;
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'permission_missing');
    assert.equal((await b.sendUi({ action: 'sites_overview' }, UI)).result.sites.length, 0, 'nothing was recorded');
    await b.chrome.permissions.request({ origins: [`${SHOP}/*`] }); // what options.js does from the person's click
    assert.equal((await b.sendUi({ action: 'sites_add', origin: SHOP }, UI)).result.ok, true);
    assert.equal((await b.send('tabs_list', {})).result.length, 1);
  });

  it('an ungranted site is refused even when the browser permission exists', async () => {
    const b = fresh({ hostPermissions: [SHOP] }); // the browser holds shop.example.com, the person granted nothing
    assert.equal((await b.send('read_page', { tabId: 1 })).code, 'site_not_granted');
    assert.equal((await b.send('tabs_list', {})).result.length, 0);
    assert.equal((await b.send('tab_open', { url: `${SHOP}/` })).code, 'site_not_granted');
  });

  it('even with the blanket permission held, only granted sites are reachable', async () => {
    const b = fresh(); // every origin held, as 0.5.0 did
    assert.equal((await b.send('read_page', { tabId: 1 })).code, 'site_not_granted');
  });
});

describe('a grant counts only while the browser also holds the permission', () => {
  const grants = { [SHOP]: { grantedAt: 1, classes: ['read', 'interact', 'sensitive'] } };
  it('a grant with no browser permission is refused (site_permission_needed) and its tab is not listed', async () => {
    const b = fresh({ hostPermissions: false, storage: { siteGrants: grants } });
    for (const action of ['read_page', 'click', 'screenshot']) assert.equal((await b.send(action, { tabId: 1, selector: 'a' })).code, 'site_permission_needed', action);
    assert.equal((await b.send('tabs_list', {})).result.length, 0);
    assert.deepEqual([...(await b.send('site_grants', {})).result.sites], []);
    const o = (await b.sendUi({ action: 'sites_overview' }, UI)).result;
    assert.equal(o.sites[0].permitted, false, 'the options page still lists it, marked as needing approval');
  });
  it('approving it in the browser makes it work again, with no new grant', async () => {
    const b = fresh({ hostPermissions: false, storage: { siteGrants: grants } });
    await b.chrome.permissions.request({ origins: [`${SHOP}/*`] });
    assert.equal((await b.send('tabs_list', {})).result.length, 1);
  });
  it('taking the permission away in the browser closes the site at once', async () => {
    const b = fresh({ hostPermissions: [SHOP], storage: { siteGrants: grants } });
    assert.equal((await b.send('tabs_list', {})).result.length, 1);
    await b.chrome.permissions.remove({ origins: [`${SHOP}/*`] });
    assert.equal((await b.send('read_page', { tabId: 1 })).code, 'site_permission_needed');
  });
  it('without a permissions API the extension fails closed', async () => {
    const b = loadBackground({ ...chromeStub, permissions: undefined }, { grants: false, storage: { siteGrants: grants } });
    assert.equal((await b.send('read_page', { tabId: 1 })).code, 'site_permission_needed');
  });
});

describe('revoking', () => {
  it('removes the grant and the browser permission, and the site is refused afterwards', async () => {
    const b = fresh({ hostPermissions: [SHOP] });
    await b.sendUi({ action: 'sites_add', origin: SHOP }, UI);
    assert.equal((await b.send('tabs_list', {})).result.length, 1);
    const r = (await b.sendUi({ action: 'sites_remove', origin: SHOP }, UI)).result;
    assert.equal(r.ok, true);
    assert.deepEqual(b.hostPerms.removed, [`${SHOP}/*`]);
    assert.equal(await b.chrome.permissions.contains({ origins: [`${SHOP}/*`] }), false);
    assert.equal((await b.send('read_page', { tabId: 1 })).code, 'site_not_granted');
  });
});

describe('migrating from 0.5.0', () => {
  const grants = { [SHOP]: { grantedAt: 1, classes: ['read'] }, 'https://other.example': { grantedAt: 1, classes: ['read'] } };
  it('an update from 0.5.0 marks the granted sites that need approving, and says which', async () => {
    const b = fresh({ hostPermissions: ['https://other.example'], storage: { siteGrants: grants } });
    await b.update('0.5.0');
    const o = (await b.sendUi({ action: 'sites_overview' }, UI)).result;
    assert.deepEqual([...o.migration.needing], [SHOP]);
    assert.equal(o.migration.from, '0.5.0');
    assert.equal(JSON.stringify(o.sites.map((s) => [s.origin, s.permitted]).sort()), JSON.stringify([[SHOP, false], ['https://other.example', true]].sort()));
  });
  it('the note goes away once the person approves the site', async () => {
    const b = fresh({ hostPermissions: false, storage: { siteGrants: grants } });
    await b.update('0.5.0');
    await b.chrome.permissions.request({ origins: [`${SHOP}/*`, 'https://other.example/*'] });
    assert.equal((await b.sendUi({ action: 'sites_overview' }, UI)).result.migration, null);
  });
  it('a fresh install and an update from 0.6 or later leave no note', async () => {
    for (const how of [(b) => b.install(), (b) => b.update('0.6.0'), (b) => b.update('1.0.0')]) {
      const b = fresh({ hostPermissions: false, storage: { siteGrants: grants } });
      await how(b);
      assert.equal((await b.sendUi({ action: 'sites_overview' }, UI)).result.migration, null);
    }
  });
});

describe('pod-inject.js is not in the default build (CLW-XT-05)', () => {
  it('the default build lists no inject_pod capability and the action reports it is not in this build', async () => {
    const b = fresh();
    await b.sendUi({ action: 'sites_add', origin: SHOP, classes: ['read', 'interact', 'sensitive'] }, UI);
    assert.ok(!(await b.sendUi({ action: 'pairing_overview' }, UI)).result.capabilities.includes('inject_pod'));
    assert.equal((await b.send('inject_pod', { tabId: 1 })).code, 'not_in_build');
  });
  it('the opt-in build lists it (still off until a person turns it on)', async () => {
    const b = fresh({ podInject: true });
    assert.ok((await b.sendUi({ action: 'pairing_overview' }, UI)).result.capabilities.includes('inject_pod'));
  });
  it('neither manifest, the shipped file list, nor the staged default builds carry pod-inject.js', () => {
    for (const f of ['manifest.json', 'firefox/manifest.json']) assert.ok(!read(f).includes('pod-inject'), f);
    assert.ok(!read('scripts/dist-files.txt').includes('pod-inject'));
    const out = mkdtempSync(join(tmpdir(), 'cbc-r3-'));
    try {
      for (const br of ['chrome', 'edge', 'firefox']) {
        const dir = stage(br, out);
        assert.ok(!existsSync(join(dir, 'pod-inject.js')), br);
        assert.equal(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).web_accessible_resources, undefined, br);
      }
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
  it('--with-pod-inject stages the file and declares it, only on the Clawser origins', () => {
    const out = mkdtempSync(join(tmpdir(), 'cbc-r3-'));
    try {
      for (const br of ['chrome', 'firefox']) {
        const dir = stage(br, out, { podInject: true });
        assert.ok(existsSync(join(dir, 'pod-inject.js')), br);
        const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
        assert.deepEqual(m.web_accessible_resources[0].resources, ['pod-inject.js']);
        assert.ok(!m.web_accessible_resources[0].matches.includes('<all_urls>'));
      }
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
});

describe('the options page asks for the same origin the background would grant', () => {
  // hostPattern() in options.js must accept exactly what normalizeSiteOrigin() in background.js accepts.
  const src = read('options.js');
  const fnSrc = src.slice(src.indexOf('function hostPattern'), src.indexOf('const perms ='));
  const ctx = vm.createContext({ URL });
  vm.runInContext(`${fnSrc}; this.hostPattern = hostPattern;`, ctx);
  const b = fresh();
  const cases = ['https://shop.example.com', 'https://shop.example.com/', ' http://localhost:5173 ', 'https://a.b:8443', 'https://shop.example.com/path', 'https://*.example.com', '<all_urls>', '*', 'https://u:p@example.com', 'file:///tmp/x', 'chrome://extensions', 'javascript:alert(1)', 'https://example.com?x=1', 'https://example.com#f', '', 5, null, 'x'.repeat(300)];
  for (const c of cases) {
    it(`agrees on ${JSON.stringify(c).slice(0, 40)}`, () => {
      const bg = b.sandbox.normalizeSiteOrigin(c);
      const pat = ctx.hostPattern(c);
      if (bg.ok) assert.equal(pat, `${bg.origin}/*`);
      else assert.equal(pat, null);
    });
  }
  it('the options page requests before it awaits anything, and only from the form and button handlers', () => {
    assert.match(src, /const asked = pattern \? askBrowser\(pattern\)/);
    assert.match(src, /perms\(\)\.remove/);
    assert.ok(!/permissions\.request/.test(read('background.js').replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')), 'the background never calls permissions.request (it has no user gesture)');
  });
});
