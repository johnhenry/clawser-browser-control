#!/usr/bin/env node
// Stages (and optionally zips) the three store builds from one file list, scripts/dist-files.txt:
//   chrome   manifest.json              -> Chrome Web Store
//   edge     manifest.json (same bytes) -> Microsoft Edge Add-ons (Edge is Chromium; the store takes the Chrome MV3 package)
//   firefox  firefox/manifest.json      -> Firefox Add-ons (AMO); no offscreen document, no side panel
// Usage: node scripts/package.mjs [--out dist] [--zip] [chrome|edge|firefox ...]
// Without --zip it only stages directories (what the tests and the browser test load).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BROWSERS = {
  chrome: { manifest: 'manifest.json', zip: 'clawser-browser-control.zip' },
  edge: { manifest: 'manifest.json', zip: 'clawser-browser-control-edge.zip' },
  firefox: { manifest: 'firefox/manifest.json', zip: 'clawser-browser-control-firefox.zip' },
};

export const distFiles = () =>
  readFileSync(join(ROOT, 'scripts/dist-files.txt'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);

/** Copy the shipped files into <out>/<browser>-stage with that browser's manifest at the root. Returns the directory. */
export function stage(browser, out) {
  const spec = BROWSERS[browser];
  if (!spec) throw new Error(`unknown browser "${browser}" (chrome, edge, firefox)`);
  const dir = join(resolve(out), `${browser}-stage`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const f of distFiles()) {
    if (f === 'manifest.json') continue;
    if (!existsSync(join(ROOT, f))) throw new Error(`scripts/dist-files.txt names ${f}, which does not exist`);
    cpSync(join(ROOT, f), join(dir, f), { recursive: true });
  }
  writeFileSync(join(dir, 'manifest.json'), readFileSync(join(ROOT, spec.manifest)));
  return dir;
}

export function zip(browser, out) {
  const dir = stage(browser, out);
  const file = join(resolve(out), BROWSERS[browser].zip);
  rmSync(file, { force: true });
  execFileSync('zip', ['-qr', file, '.', '-x', '*.DS_Store'], { cwd: dir });
  return file;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const o = args.indexOf('--out');
  const out = o >= 0 ? args.splice(o, 2)[1] : 'dist';
  const doZip = args.includes('--zip');
  const names = args.filter((a) => !a.startsWith('--'));
  for (const b of names.length ? names : Object.keys(BROWSERS)) console.log(doZip ? zip(b, out) : stage(b, out));
}
