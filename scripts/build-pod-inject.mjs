#!/usr/bin/env node
// scripts/build-pod-inject.mjs — regenerates pod-inject.js.
//
// pod-inject.js is injected into arbitrary pages' MAIN world via
// chrome.scripting.executeScript({ files: ['pod-inject.js'], world: 'MAIN' })
// (see actionInjectPod in background.js). Chrome extension content-script
// injection has no ES module support in that mode, so the pod runtime
// (published as the browsermesh-pod / browsermesh-primitives npm packages)
// has to be flattened into a single classic-script IIFE rather than loaded
// as modules directly.
//
// This is a small, purpose-built concatenator, not a general bundler: the
// pod runtime is exactly six leaf source files with no build-time branching,
// so a generic bundler (esbuild/rollup) would be more moving parts than the
// problem needs. It reads each file from the pinned npm packages below,
// mechanically strips their import/export statements (every import here is
// resolved by manually listing files in dependency order instead), and
// concatenates them with the same section-header style the previous
// hand-maintained bundle used.
//
// Run with: node scripts/build-pod-inject.mjs   (or: npm run build:pod-inject)

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

// Neither package's `exports` map exposes ./package.json, so resolve the
// main entry point (./src/index.mjs) and walk up two directories instead.
const POD_PKG_DIR = path.resolve(path.dirname(require.resolve('browsermesh-pod')), '..');
const PRIMITIVES_PKG_DIR = path.resolve(path.dirname(require.resolve('browsermesh-primitives')), '..');
const podPkg = JSON.parse(readFileSync(path.join(POD_PKG_DIR, 'package.json'), 'utf8'));
const primitivesPkg = JSON.parse(readFileSync(path.join(PRIMITIVES_PKG_DIR, 'package.json'), 'utf8'));

/**
 * Strip this file's own `import ... from '...'` statements (single- or
 * multi-line) and the `export` keyword from top-level declarations. Every
 * cross-file reference among the six files bundled below is satisfied by
 * concatenation order (each file's dependencies are emitted earlier in the
 * bundle), so the import target itself never needs to survive — just the
 * bound names it introduces, which import stripping leaves untouched.
 */
function stripModuleSyntax(src) {
  return src
    .replace(/^import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]\s*\n/gm, '')
    .replace(/^import\s+\w+\s+from\s*['"][^'"]+['"]\s*\n/gm, '')
    .replace(/^export\s+(class|function|async function|const|let|var)\b/gm, '$1');
}

/** One entry per bundled file, in dependency order (each depends only on files above it). */
const SECTIONS = [
  { label: 'browsermesh-primitives/identity.mjs', file: path.join(PRIMITIVES_PKG_DIR, 'src', 'identity.mjs') },
  { label: 'browsermesh-pod/detect-kind.mjs', file: path.join(POD_PKG_DIR, 'src', 'detect-kind.mjs') },
  { label: 'browsermesh-pod/capabilities.mjs', file: path.join(POD_PKG_DIR, 'src', 'capabilities.mjs') },
  { label: 'browsermesh-pod/messages.mjs', file: path.join(POD_PKG_DIR, 'src', 'messages.mjs') },
  { label: 'browsermesh-pod/pod.mjs', file: path.join(POD_PKG_DIR, 'src', 'pod.mjs') },
  { label: 'browsermesh-pod/injected-pod.mjs', file: path.join(POD_PKG_DIR, 'src', 'injected-pod.mjs') },
];

const bundledSections = SECTIONS.map(({ label, file }) => {
  const src = stripModuleSyntax(readFileSync(file, 'utf8')).trim();
  return `// ── ${label} ──\n${src}`;
}).join('\n\n');

const BOOT_SECTION = `// ── Boot ──
// Relay page-originated Pod messages (peer/BroadcastChannel traffic) up
// through content.js's existing page -> background relay: content.js
// (isolated world, has chrome.runtime access) already listens for
// window.postMessage'd { type: MARKER, direction: 'notify', ... } envelopes
// from the page and forwards them to background.js via chrome.runtime —
// see content.js's window.addEventListener('message', ...) handler. This
// bridge reuses that exact channel rather than inventing a new one; this
// script runs as a MAIN-world content script, so it has no chrome.* API
// access of its own and must go through content.js regardless.
//
// content.js enforces its own localhost/127.0.0.1/file:// origin allowlist
// before relaying anything to background.js (defense in depth alongside the
// manifest's content_scripts/web_accessible_resources match patterns), so
// this bridge does no origin filtering itself — content.js is the trust
// boundary for what reaches the extension's privileged background context.
const extensionBridge = {
  postMessage(msg) {
    try {
      globalThis.postMessage({
        type: '__clawser_ext__',
        direction: 'notify',
        action: 'pod_message',
        params: { msg },
      }, '*');
    } catch {
      // No content.js listening here (extension not installed, or this
      // page is outside its match pattern) — nothing to relay to.
    }
  },
};
const pod = new InjectedPod({ extensionBridge });
pod.boot({ discoveryTimeout: 2000 }).then(() => {
  console.log('[pod-inject] Pod ready:', pod.podId);
}).catch((err) => {
  console.warn('[pod-inject] Boot failed:', err.message);
});`;

const output = `// pod-inject.js — Auto-generated IIFE bundle for Chrome/Firefox extension
// injection (chrome.scripting.executeScript world: 'MAIN'). Do not edit
// directly — regenerate with: node scripts/build-pod-inject.mjs
//
// Bundled from:
//   browsermesh-pod@${podPkg.version}
//   browsermesh-primitives@${primitivesPkg.version}
// (versions pinned in package.json devDependencies; regenerate after bumping
// either package there — CI fails if this file drifts from what the build
// script produces, so there's no separate generation-date stamp to keep in
// sync; git blame on this file is the generation-date record.)
(function() {
'use strict';
if (globalThis[Symbol.for('pod.runtime')]) return;

${bundledSections}

${BOOT_SECTION}
})();
`;

const outPath = path.join(REPO_ROOT, 'pod-inject.js');
writeFileSync(outPath, output);
console.log(`Wrote ${outPath} (${output.length} bytes) from browsermesh-pod@${podPkg.version} + browsermesh-primitives@${primitivesPkg.version}`);
