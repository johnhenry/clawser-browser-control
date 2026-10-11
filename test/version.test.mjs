// Run with: node --test test/version.test.mjs
// #29: the v0.2.0 tag shipped a hardcoded VERSION = '0.1.0', so clawser showed "Connected (v0.1.0)".
// The version the extension reports must be the manifest's, in both the Chrome and Firefox builds.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadContent } from './_load-content.mjs';
import { loadBackground } from './_load-background.mjs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const firefox = JSON.parse(read('firefox/manifest.json'));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('reported version equals the manifest version', () => {
  it('the manifests agree with each other', () => {
    assert.equal(firefox.version, manifest.version);
  });

  it('the presence announcement carries the manifest version', async (t) => {
    // The stub returns the REAL manifest, as chrome.runtime.getManifest() does in the browser.
    const ctx = loadContent({ getManifest: () => manifest });
    t.after(() => ctx.stop());
    await tick(5);
    const presence = ctx.popPosted().find((m) => m.direction === 'presence');
    assert.ok(presence, 'content.js announced itself');
    assert.equal(presence.version, manifest.version);
  });

  it('follows whatever the manifest says (not a baked-in number)', async (t) => {
    const ctx = loadContent({ getManifest: () => ({ version: '9.8.7' }) });
    t.after(() => ctx.stop());
    await tick(5);
    assert.equal(ctx.popPosted().find((m) => m.direction === 'presence').version, '9.8.7');
  });

  it('the status action reports the manifest version too', async () => {
    const b = loadBackground({ runtime: { getManifest: () => manifest } });
    const r = await b.send('status', {});
    assert.equal(r.result.version, manifest.version);
    const b2 = loadBackground({ runtime: { getManifest: () => ({ version: '9.8.7' }) } });
    assert.equal((await b2.send('status', {})).result.version, '9.8.7');
  });

  it('no source file hardcodes a version string', () => {
    for (const f of ['content.js', 'background.js']) {
      assert.doesNotMatch(read(f), /\bVERSION\s*=\s*['"]\d/, `${f} must read chrome.runtime.getManifest().version`);
    }
  });
});
