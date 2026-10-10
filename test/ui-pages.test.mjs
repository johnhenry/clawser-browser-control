// Run with: node --test test/ui-pages.test.mjs
// Static checks on the manifests, the shipped file list, and the extension pages.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');
const chromeManifest = JSON.parse(read('manifest.json'));
const firefoxManifest = JSON.parse(read('firefox/manifest.json'));

const MATCHES = [
  'http://localhost/*', 'https://localhost/*', 'http://127.0.0.1/*', 'https://127.0.0.1/*', 'file:///*',
  'https://clawser.erisera.com/*',
];

describe('manifests', () => {
  for (const [name, m] of [['chrome', chromeManifest], ['firefox', firefoxManifest]]) {
    it(`${name}: content script matches are exactly the hardened set plus production clawser`, () => {
      assert.deepEqual([...m.content_scripts[0].matches].sort(), [...MATCHES].sort());
    });
    it(`${name}: web_accessible_resources matches follow the same set`, () => {
      assert.deepEqual([...m.web_accessible_resources[0].matches].sort(), [...MATCHES].sort());
    });
    it(`${name}: requests contextMenus`, () => assert.ok(m.permissions.includes('contextMenus')));
    it(`${name}: has an options page`, () => {
      assert.equal(m.options_ui.page, 'options.html');
      assert.ok(existsSync(path.join(root, 'options.html')));
    });
  }
  it('chrome: sidePanel permission and default_path', () => {
    assert.ok(chromeManifest.permissions.includes('sidePanel'));
    assert.equal(chromeManifest.side_panel.default_path, 'sidepanel.html');
    assert.ok(existsSync(path.join(root, 'sidepanel.html')));
  });
  it('chrome: toolbar action exists so the side panel can be opened', () => {
    assert.ok(chromeManifest.action.default_title);
  });
  it('chrome: only sidePanel and contextMenus were added to permissions; no new host access', () => {
    const base = ['tabs', 'activeTab', 'scripting', 'userScripts', 'webRequest', 'cookies', 'storage', 'alarms', 'offscreen'];
    assert.deepEqual([...chromeManifest.permissions].sort(), [...base, 'sidePanel', 'contextMenus'].sort());
    assert.deepEqual(chromeManifest.host_permissions, ['<all_urls>']);
  });
  it('version is untouched (owner releases)', () => {
    assert.equal(chromeManifest.version, '0.1.1');
    assert.equal(firefoxManifest.version, '0.1.1');
  });
  it('declares no extension CSP loosening', () => {
    assert.equal(chromeManifest.content_security_policy, undefined);
  });
});

describe('shipped files', () => {
  const list = read('scripts/dist-files.txt').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const f of ['sidepanel.html', 'sidepanel.js', 'sidepanel.css', 'options.html', 'options.js']) {
    it(`dist-files.txt lists ${f}`, () => assert.ok(list.includes(f)));
  }
  it('every listed file exists', () => {
    for (const f of list) assert.ok(existsSync(path.join(root, f)), f);
  });
});

for (const page of ['sidepanel.html', 'options.html']) {
  describe(page, () => {
    const html = read(page);
    it('has lang, title and viewport', () => {
      assert.match(html, /<html[^>]*\slang="en"/);
      assert.match(html, /<title>[^<]+<\/title>/);
      assert.match(html, /name="viewport"/);
    });
    it('loads only local files: no remote URLs, no inline script, no inline handlers', () => {
      assert.doesNotMatch(html, /(src|href)\s*=\s*["']?(https?:)?\/\//i);
      assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/i);
      assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
      assert.doesNotMatch(html, /javascript:/i);
    });
    it('has a polite aria-live status region', () => {
      assert.match(html, /aria-live="(polite|assertive)"/);
    });
    it('has a main landmark and a single h1', () => {
      assert.match(html, /<main[\s>]/);
      assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
    });
  });
}

describe('sidepanel.html content', () => {
  const html = read('sidepanel.html');
  it('offers the four entry actions', () => {
    for (const label of ['Compare tabs', 'Extract data', 'Watch page', 'Create workflow']) assert.ok(html.includes(label), label);
  });
  it('says plainly that only Create workflow is not available yet', () => {
    assert.equal((html.match(/Coming in a later release/g) || []).length, 1);
    assert.match(html, /id="btn-workflow"[^>]*aria-disabled="true"/);
    assert.doesNotMatch(html, /id="btn-watch"[^>]*aria-disabled/);
  });
  it('has sections for tasks and inbox and last run', () => {
    assert.match(html, /id="task-list"/);
    assert.match(html, /id="inbox-list"/);
    assert.match(html, /id="last-run"/);
  });
});

describe('page scripts', () => {
  for (const f of ['sidepanel.js', 'options.js']) {
    it(`${f} avoids innerHTML / eval / remote loading`, () => {
      const js = read(f);
      assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|importScripts|https?:\/\/(?!clawser\.erisera\.com)/);
    });
  }
  it('sidepanel.css never hides focus outlines without a replacement', () => {
    const css = read('sidepanel.css');
    assert.match(css, /:focus-visible/);
    assert.doesNotMatch(css, /outline\s*:\s*(none|0)\s*[;}](?![^}]*box-shadow)/);
  });
});
