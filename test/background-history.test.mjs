// Run with: node --test test/background-history.test.mjs
// #28: navigate, then back, then forward. chrome.tabs.update() resolves BEFORE the navigation
// commits, so a back issued right after it found no earlier history entry and Chrome answered
// with its (misleading) "Cannot find a next page in history". navigate now waits for the commit.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './_load-background.mjs';

const A = 'https://a.example/';
const B = 'https://b.example/';
const C = 'https://c.example/';

/**
 * A tab with a real-ish session history. Navigations commit `commitMs` after being requested,
 * and tabs.goBack / goForward fail the way Chrome does when there is nowhere to go (including
 * the same "next page" wording for both directions).
 */
function browser({ commitMs = 15, neverCommit = false, errorPage = false } = {}) {
  const history = [A]; let idx = 0; let shown = null;
  const tab = () => ({ id: 1, windowId: 1, url: shown || history[idx], status: 'complete' });
  let b;
  const commit = (url, to) => {
    if (neverCommit) return;
    setTimeout(() => {
      if (to === undefined) { history.splice(idx + 1); history.push(url); idx = history.length - 1; } else idx = to;
      const finalUrl = errorPage ? 'chrome-error://chromewebdata/' : history[idx];
      shown = errorPage ? finalUrl : null;
      b.tabUpdated(1, { status: 'loading', url: finalUrl }, { ...tab(), url: finalUrl });
      b.tabUpdated(1, { status: 'complete' }, { ...tab(), url: finalUrl });
    }, commitMs);
  };
  b = loadBackground({
    tabs: {
      query: async () => [tab()],
      get: async () => tab(),
      update: async (id, props) => { if (props.url) commit(props.url); return { ...tab(), url: A, pendingUrl: props.url }; }, // resolves BEFORE the commit
      goBack: async () => { if (idx <= 0) throw new Error('Cannot find a next page in history.'); commit(null, idx - 1); },
      goForward: async () => { if (idx >= history.length - 1) throw new Error('Cannot find a next page in history.'); commit(null, idx + 1); },
    },
  }, { setTimeoutImpl: (fn, ms) => setTimeout(fn, Math.min(ms, 120)) });
  return { b, history, current: () => history[idx] };
}

describe('navigate waits for the navigation to commit', () => {
  it('returns the committed URL, not the one it started from', async () => {
    const { b, current } = browser();
    const r = await b.send('navigate', { tabId: 1, url: B });
    assert.equal(r.result.url, B);
    assert.equal(r.result.committed, true);
    assert.equal(current(), B);
  });

  it('A -> navigate B -> back -> forward works', async () => {
    const { b, current } = browser();
    await b.send('navigate', { tabId: 1, url: B });
    const back = await b.send('go_back', { tabId: 1 });
    assert.equal(back.error, undefined);
    assert.equal(current(), A);
    assert.equal(back.result.url, A);
    const fwd = await b.send('go_forward', { tabId: 1 });
    assert.equal(fwd.error, undefined);
    assert.equal(current(), B);
    assert.equal(fwd.result.url, B);
  });

  it('three pages deep: back twice, forward once', async () => {
    const { b, current } = browser();
    await b.send('navigate', { tabId: 1, url: B });
    await b.send('navigate', { tabId: 1, url: C });
    await b.send('go_back', { tabId: 1 });
    await b.send('go_back', { tabId: 1 });
    assert.equal(current(), A);
    await b.send('go_forward', { tabId: 1 });
    assert.equal(current(), B);
  });

  it('a back issued while the navigate is still in flight waits for it', async () => {
    const { b, current } = browser({ commitMs: 40 });
    const nav = b.send('navigate', { tabId: 1, url: B });
    const back = b.send('go_back', { tabId: 1 });
    const [n, bk] = await Promise.all([nav, back]);
    assert.equal(n.error, undefined);
    assert.equal(bk.error, undefined, 'back must not fail just because B had not committed yet');
    assert.equal(current(), A);
  });

  it('gives up after the commit timeout and says so, instead of hanging', async () => {
    const { b } = browser({ neverCommit: true });
    const r = await b.send('navigate', { tabId: 1, url: B });
    assert.equal(r.error, undefined);
    assert.equal(r.result.committed, false);
    assert.equal(r.result.url, B, 'the requested URL is still reported');
  });

  it('an unreachable host (Chrome error page) is an error, not a success', async () => {
    const { b } = browser({ errorPage: true });
    const r = await b.send('navigate', { tabId: 1, url: B });
    assert.match(r.error, /Navigation failed/);
    assert.match(r.error, /b\.example/);
  });

  it('does not leak onUpdated listeners', async () => {
    const { b } = browser();
    const before = b.hooks.tabUpdatedListeners.size;
    await b.send('navigate', { tabId: 1, url: B });
    await b.send('go_back', { tabId: 1 });
    await b.send('go_forward', { tabId: 1 });
    assert.equal(b.hooks.tabUpdatedListeners.size, before);
  });

  it('ignores updates for other tabs while waiting', async () => {
    const { b } = browser({ commitMs: 30 });
    const nav = b.send('navigate', { tabId: 1, url: B });
    b.tabUpdated(99, { status: 'complete', url: 'https://other.example/' }, { id: 99, url: 'https://other.example/' });
    const r = await nav;
    assert.equal(r.result.url, B);
  });

  it('still validates its input', async () => {
    const { b } = browser();
    assert.match((await b.send('navigate', { tabId: 1 })).error, /url is required/);
  });
});

describe('back and forward errors say what they mean', () => {
  it('back with nothing earlier: "No earlier page", not "next page"', async () => {
    const { b } = browser();
    const r = await b.send('go_back', { tabId: 1 });
    assert.match(r.error, /No earlier page in this tab's history/);
    assert.doesNotMatch(r.error, /next page/);
  });

  it('forward with nothing later: "No later page"', async () => {
    const { b } = browser();
    const r = await b.send('go_forward', { tabId: 1 });
    assert.match(r.error, /No later page in this tab's history/);
  });

  it('other errors pass through unchanged', async () => {
    const b = loadBackground({ tabs: { get: async () => ({ id: 1, url: A }), goBack: async () => { throw new Error('No tab with id: 1.'); } } });
    assert.match((await b.send('go_back', { tabId: 1 })).error, /No tab with id/);
  });
});
