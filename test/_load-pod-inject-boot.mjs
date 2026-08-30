// test/_load-pod-inject-boot.mjs — shared helper for exercising the real,
// unmodified "// ── Boot ──" section of pod-inject.js in isolation.
//
// pod-inject.js is a single generated IIFE (see scripts/build-pod-inject.mjs)
// that bundles the full browsermesh-pod runtime (Ed25519 identity, peer
// discovery, BroadcastChannel transport, ...) before the boot wrapper at the
// bottom constructs and boots an InjectedPod. Driving that whole runtime
// through a real boot in a vm context is a lot of unrelated machinery for
// what we actually want to verify here: that the boot wrapper constructs
// InjectedPod with a real extensionBridge, and that the bridge relays
// through window.postMessage in the envelope shape content.js expects.
//
// So this helper extracts just the boot section's source text verbatim from
// the shipped file (byte-for-byte what ships to the browser) and runs *that*
// in a vm context with a stub InjectedPod substituted in — exercising the
// real boot wrapper code against a controlled pod, rather than reimplementing
// or duplicating its logic in the test.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POD_INJECT_SRC = readFileSync(path.join(__dirname, '..', 'pod-inject.js'), 'utf8');

const BOOT_MARKER = '// ── Boot ──';

function extractBootSection(src) {
  // lastIndexOf, not indexOf: Pod's own boot() phase-comment
  // ("// ── Boot ──────...") inside the bundled pod.mjs source also contains
  // this marker as a substring — the actual top-level boot wrapper is the
  // final occurrence, at the end of the file.
  const idx = src.lastIndexOf(BOOT_MARKER);
  if (idx === -1) throw new Error(`Could not find "${BOOT_MARKER}" in pod-inject.js — has the boot section been renamed?`);
  let bootSrc = src.slice(idx);
  // Strip the trailing IIFE closer (`})();`) that wraps the whole bundle.
  const closerMatch = bootSrc.match(/\n\}\)\(\);\s*$/);
  if (!closerMatch) throw new Error('Could not find the trailing IIFE closer after the boot section.');
  return bootSrc.slice(0, closerMatch.index);
}

/**
 * @param {object} [opts]
 * @param {Function} [opts.postMessageImpl] - replaces the sandbox's
 *   globalThis.postMessage entirely (default records calls in `posted`)
 * @returns {{postedFromBridge: Array, capturedOpts: object|null, podInstance: object|null}}
 */
export function loadPodInjectBoot(opts = {}) {
  const bootSrc = extractBootSection(POD_INJECT_SRC);

  const posted = []; // everything sent via globalThis.postMessage in the sandbox

  let capturedOpts = null;
  class StubInjectedPod {
    constructor(ctorOpts = {}) {
      capturedOpts = ctorOpts;
    }
    boot() {
      return Promise.resolve();
    }
  }

  const sandbox = {
    console,
    InjectedPod: StubInjectedPod,
    postMessage: opts.postMessageImpl || ((data, targetOrigin) => {
      posted.push({ data, targetOrigin });
    }),
  };
  vm.createContext(sandbox);

  // Run the real boot section verbatim, then expose its top-level `const`
  // bindings (extensionBridge, pod) onto the sandbox for the test to probe —
  // `const`/`let` declared here live in the vm context's shared lexical
  // scope, so a second statement appended to the same script can reach them.
  const probe = `${bootSrc}\nglobalThis.__test_extensionBridge = extensionBridge;\nglobalThis.__test_pod = pod;\n`;
  vm.runInContext(probe, sandbox, { filename: 'pod-inject.js (boot section)' });

  return {
    posted,
    capturedOpts,
    extensionBridge: sandbox.__test_extensionBridge,
    podInstance: sandbox.__test_pod,
  };
}
