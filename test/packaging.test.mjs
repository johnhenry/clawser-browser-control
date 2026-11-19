// Run with: node --test test/packaging.test.mjs
// Store packaging (wave X-3): the three builds are staged from one file list, and every permission each manifest asks for is justified, in terms of
// per-site grants and tool classes, in store/permission-justifications.txt (Chrome and Edge) or its Firefox section.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stage, distFiles, BROWSERS } from '../scripts/package.mjs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const chrome = JSON.parse(read('manifest.json'));
const firefox = JSON.parse(read('firefox/manifest.json'));
const just = read('store/permission-justifications.txt');

/** The text of one named section ("== CHROME AND EDGE ==" ...) of the justifications file. */
const section = (name) => {
  const m = just.match(new RegExp(`^=== ${name} ===\\n([\\s\\S]*?)(?=^=== |$(?![\\s\\S]))`, 'm'));
  assert.ok(m, `section "${name}" exists`);
  return m[1];
};
const heading = (text, perm) => new RegExp(`^${perm.replace(/[.*+?^${}()|[\]\\<>]/g, '\\$&')}( \\(optional\\))?\\n-+$`, 'm').test(text);

describe('staged builds', () => {
  const out = mkdtempSync(join(tmpdir(), 'cbc-pkg-'));
  for (const b of Object.keys(BROWSERS)) {
    it(`${b}: every shipped file is present, with that browser's manifest at the root`, (t) => {
      t.after(() => rmSync(out, { recursive: true, force: true }));
      const dir = stage(b, out);
      for (const f of distFiles()) assert.ok(existsSync(join(dir, f)), `${b} has ${f}`);
      assert.equal(readFileSync(join(dir, 'manifest.json'), 'utf8'), read(BROWSERS[b].manifest));
    });
  }
  it('edge ships the very bytes chrome does (the Chromium MV3 package)', () => {
    const o = mkdtempSync(join(tmpdir(), 'cbc-pkg-'));
    try {
      assert.equal(readFileSync(join(stage('edge', o), 'manifest.json'), 'utf8'), readFileSync(join(stage('chrome', o), 'manifest.json'), 'utf8'));
    } finally { rmSync(o, { recursive: true, force: true }); }
  });
  it('an unknown browser is refused', () => assert.throws(() => stage('safari', tmpdir()), /unknown browser/));
});

describe('manifests', () => {
  it('firefox asks for nothing Firefox lacks (no sidePanel, offscreen, debugger) and declares an id and its data collection', () => {
    for (const p of ['sidePanel', 'offscreen', 'debugger']) assert.ok(![...(firefox.permissions || []), ...(firefox.optional_permissions || [])].includes(p), p);
    assert.ok(firefox.browser_specific_settings?.gecko?.id);
    assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions?.required, ['none']);
  });
  it('the firefox permissions are a subset of the chrome ones', () => {
    for (const p of firefox.permissions) assert.ok(chrome.permissions.includes(p), p);
  });
});

describe('permission justifications', () => {
  const cases = [
    ['CHROME AND EDGE', () => [...chrome.permissions, ...(chrome.optional_permissions || []), ...chrome.host_permissions]],
    ['FIREFOX', () => [...firefox.permissions, ...firefox.host_permissions]],
  ];
  for (const [name, perms] of cases) {
    it(`${name}: every permission has its own heading`, () => {
      const text = section(name);
      for (const p of perms()) assert.ok(heading(text, p), `${name}: no heading for ${p}`);
    });
    it(`${name}: no heading justifies a permission the manifest does not ask for`, () => {
      const text = section(name);
      const known = new Set(perms());
      for (const m of text.matchAll(/^(\S+?)( \(optional\))?\n-+$/gm)) assert.ok(known.has(m[1]), `${name}: stale heading ${m[1]}`);
    });
    it(`${name}: the blanket host permission is explained as per-site grants and tool classes, not "any page"`, () => {
      const text = section(name);
      assert.match(text, /per-site grant|site grant/i);
      for (const c of ['read', 'interact', 'sensitive']) assert.match(text, new RegExp(`\\b${c}\\b`), `${name} names the ${c} class`);
      assert.match(text, /site_not_granted|refuses?/i);
      assert.doesNotMatch(text, /any web page the user directs/i);
    });
  }
  it('the optional debugger permission is not claimed as used', () => {
    assert.match(section('CHROME AND EDGE'), /debugger \(optional\)\n-+\n[^\n]*(not used|never used|unused|not currently used)/i);
  });
  it('every store listing field fits its limit', () => {
    const line = (label) => (just.match(new RegExp(`^${label}: (.+)$`, 'm')) || [])[1];
    assert.ok(line('SHORT DESCRIPTION').length <= 132, 'Chrome and Edge short description <= 132');
    assert.ok(line('FIREFOX SUMMARY').length <= 250, 'AMO summary <= 250');
    assert.equal(chrome.description.length <= 132, true);
  });
});
