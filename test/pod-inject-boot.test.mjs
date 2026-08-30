// Run with: node --test test/pod-inject-boot.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadPodInjectBoot } from './_load-pod-inject-boot.mjs';

describe('pod-inject.js boot wrapper — extensionBridge wiring', () => {
  it('constructs InjectedPod with a real extensionBridge (not {} / no-args)', () => {
    const { capturedOpts } = loadPodInjectBoot();
    assert.ok(capturedOpts, 'InjectedPod constructor was never called');
    assert.ok(capturedOpts.extensionBridge, 'InjectedPod was constructed without an extensionBridge option');
    assert.equal(typeof capturedOpts.extensionBridge.postMessage, 'function');
  });

  it('the same extensionBridge instance was passed to InjectedPod as is exposed at boot scope', () => {
    const { capturedOpts, extensionBridge } = loadPodInjectBoot();
    assert.equal(capturedOpts.extensionBridge, extensionBridge);
  });

  it('extensionBridge.postMessage relays through globalThis.postMessage as a MARKER-tagged notify, wrapping the pod message in params.msg', () => {
    const { extensionBridge, posted } = loadPodInjectBoot();

    const podMsg = { type: 'pod:message', from: 'pod-abc', to: 'pod-xyz', data: { hello: 'world' } };
    extensionBridge.postMessage(podMsg);

    assert.equal(posted.length, 1);
    const [{ data, targetOrigin }] = posted;
    assert.equal(data.type, '__clawser_ext__');
    assert.equal(data.direction, 'notify');
    assert.equal(data.action, 'pod_message');
    // The pod message crosses the vm sandbox's realm boundary, so its
    // prototype differs from this realm's Object.prototype — compare
    // structurally via JSON rather than assert.deepEqual's strict,
    // prototype-sensitive comparison.
    assert.equal(JSON.stringify(data.params), JSON.stringify({ msg: podMsg }));
    assert.equal(targetOrigin, '*');
  });

  it('extensionBridge.postMessage does not throw if globalThis.postMessage itself throws (e.g. invalidated context)', () => {
    const { extensionBridge } = loadPodInjectBoot({
      postMessageImpl: () => { throw new Error('boom'); },
    });
    assert.doesNotThrow(() => extensionBridge.postMessage({ type: 'pod:message' }));
  });
});
