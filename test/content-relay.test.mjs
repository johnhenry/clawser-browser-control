// Run with: node --test test/content-relay.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from './_load-content.mjs';

const MARKER = '__clawser_ext__';

// Let the microtask/macrotask queue drain (e.g. content.js's fire-and-forget
// presence announcement and async request handling) before asserting.
function tick(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Load content.js for one test, registering its heartbeat interval for
 * cleanup and draining the initial presence-announcement postMessage
 * (which content.js fires asynchronously right at load, before the test
 * gets to send anything) so it doesn't pollute popPosted() assertions.
 */
async function freshLoad(t, chromeOverrides = {}, opts = {}) {
  const ctx = loadContent(chromeOverrides, opts);
  t.after(() => ctx.stop());
  await tick(); // let the initial announcePresence().then(...) resolve and post
  ctx.popPosted();
  return ctx;
}

describe('content.js — page → background relay', () => {
  it('ignores messages from a different window (postMessage spoofing guard)', async (t) => {
    const { postFromOtherWindow, chrome } = await freshLoad(t);
    let called = false;
    chrome.runtime.sendMessage = async () => { called = true; return { result: 1 }; };
    postFromOtherWindow({ type: MARKER, direction: 'request', id: 1, action: 'ping' });
    await tick();
    assert.equal(called, false);
  });

  it('ignores non-Clawser messages (missing/foreign type marker)', async (t) => {
    const { postFromPage, chrome } = await freshLoad(t);
    let called = false;
    chrome.runtime.sendMessage = async () => { called = true; return { result: 1 }; };
    postFromPage({ type: 'some-other-extension', direction: 'request', id: 1, action: 'ping' });
    await tick();
    assert.equal(called, false);
  });

  it('ignores a request with no id — cannot be correlated to a response', async (t) => {
    const { postFromPage, popPosted, chrome } = await freshLoad(t);
    let called = false;
    chrome.runtime.sendMessage = async () => { called = true; return { result: 1 }; };
    postFromPage({ type: MARKER, direction: 'request', action: 'ping' }); // no id
    await tick();
    assert.equal(called, false);
    assert.deepEqual(popPosted().filter((m) => m.direction === 'response'), []);
  });

  it('relays a well-formed request to the background and posts its response back with the same id', async (t) => {
    const { postFromPage, popPosted, chrome } = await freshLoad(t);
    let receivedMsg = null;
    chrome.runtime.sendMessage = async (msg) => { receivedMsg = msg; return { result: { ok: true } }; };

    postFromPage({ type: MARKER, direction: 'request', id: 7, action: 'tabs_list', params: { foo: 1 } });
    await tick();

    assert.equal(receivedMsg.action, 'tabs_list');
    assert.deepEqual(receivedMsg.params, { foo: 1 });
    assert.equal(receivedMsg.id, 7);

    const [response] = popPosted().filter((m) => m.direction === 'response');
    assert.equal(response.id, 7);
    assert.deepEqual(response.result, { ok: true });
    assert.equal(response.error, null);
  });

  it('posts an error response when the background returns one', async (t) => {
    const { postFromPage, popPosted, chrome } = await freshLoad(t);
    chrome.runtime.sendMessage = async () => ({ error: 'boom' });

    postFromPage({ type: MARKER, direction: 'request', id: 8, action: 'whatever' });
    await tick();

    const [response] = popPosted().filter((m) => m.direction === 'response');
    assert.equal(response.id, 8);
    assert.equal(response.result, null);
    assert.equal(response.error, 'boom');
  });

  it('posts an error response if chrome.runtime.sendMessage itself throws (e.g. invalidated context)', async (t) => {
    const { postFromPage, popPosted, chrome } = await freshLoad(t);
    chrome.runtime.sendMessage = async () => { throw new Error('Extension context invalidated'); };

    postFromPage({ type: MARKER, direction: 'request', id: 9, action: 'whatever' });
    await tick();

    const [response] = popPosted().filter((m) => m.direction === 'response');
    assert.equal(response.id, 9);
    assert.equal(response.result, null);
    assert.match(response.error, /invalidated/);
  });

  it('times out and posts an error response if the background never calls sendResponse', async (t) => {
    // content.js's only setTimeout use is the request-relay timeout race
    // (RELAY_TIMEOUT_MS = 35000ms) — substitute an immediate-fire version so
    // this test doesn't need a real 35s wait. The `ms` argument passed by
    // withTimeout() is deliberately ignored here.
    const { postFromPage, popPosted, chrome } = await freshLoad(t, {}, {
      setTimeoutImpl: (fn) => setTimeout(fn, 0),
    });
    // Simulate a hung background: sendMessage's promise never settles.
    chrome.runtime.sendMessage = () => new Promise(() => {});

    postFromPage({ type: MARKER, direction: 'request', id: 10, action: 'whatever' });
    await tick(10);

    const [response] = popPosted().filter((m) => m.direction === 'response');
    assert.equal(response.id, 10);
    assert.equal(response.result, null);
    assert.match(response.error, /did not respond within 35000ms/);
  });

  it('forwards a notify message fire-and-forget, with no response posted', async (t) => {
    const { postFromPage, popPosted, chrome } = await freshLoad(t);
    let received = null;
    chrome.runtime.sendMessage = async (msg) => { received = msg; return { unused: true }; };

    postFromPage({ type: MARKER, direction: 'notify', action: 'workspace_ready', wsId: 'ws1' });
    await tick();

    assert.equal(received.action, 'workspace_ready');
    assert.equal(received.wsId, 'ws1');
    assert.deepEqual(popPosted(), []); // nothing relayed back to the page
  });
});

describe('content.js — background → page relay (push)', () => {
  it('relays a push message from the background down to the page unmodified', async (t) => {
    const { pushFromBackground, popPosted } = await freshLoad(t);

    const pushMsg = { type: MARKER, direction: 'push', action: 'execute_routine', routineId: 'r1' };
    pushFromBackground(pushMsg);
    await tick();

    const [posted] = popPosted();
    assert.deepEqual(posted, pushMsg);
  });

  it('ignores non-push messages arriving via chrome.runtime.onMessage', async (t) => {
    const { pushFromBackground, popPosted } = await freshLoad(t);

    pushFromBackground({ type: MARKER, direction: 'request', action: 'nope' });
    await tick();

    assert.deepEqual(popPosted(), []);
  });
});
