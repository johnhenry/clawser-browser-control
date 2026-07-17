// Run with: node --test test/content-presence-heartbeat.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from './_load-content.mjs';

function tick(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

async function freshLoad(t, chromeOverrides = {}, opts = {}) {
  const ctx = loadContent(chromeOverrides, opts);
  t.after(() => ctx.stop());
  await tick(); // let the initial announcePresence().then(...) resolve and post
  ctx.popPosted();
  return ctx;
}

describe('content.js — presence heartbeat visibility pause', () => {
  it('starts the heartbeat interval when the tab is visible on load', async (t) => {
    const { liveIntervals } = await freshLoad(t);
    assert.equal(liveIntervals.size, 1, 'heartbeat interval should be running');
  });

  it('does not start the heartbeat interval when the tab starts hidden', async (t) => {
    const { liveIntervals } = await freshLoad(t, {}, { hidden: true });
    assert.equal(liveIntervals.size, 0, 'heartbeat interval should not start while hidden');
  });

  it('stops the heartbeat interval when the tab becomes hidden', async (t) => {
    const { liveIntervals, setHidden } = await freshLoad(t);
    assert.equal(liveIntervals.size, 1);

    setHidden(true);

    assert.equal(liveIntervals.size, 0, 'heartbeat interval should be cleared on hide');
  });

  it('resumes the heartbeat interval and re-announces when the tab becomes visible again', async (t) => {
    const { liveIntervals, setHidden, popPosted } = await freshLoad(t, {}, { hidden: true });
    assert.equal(liveIntervals.size, 0);

    setHidden(false);
    await tick();

    assert.equal(liveIntervals.size, 1, 'heartbeat interval should resume on show');
    const posted = popPosted();
    const presence = posted.find((m) => m.direction === 'presence');
    assert.ok(presence, 'should re-announce presence immediately on becoming visible');
  });

  it('toggling hidden repeatedly never leaves more than one live interval', async (t) => {
    const { liveIntervals, setHidden } = await freshLoad(t);
    for (let i = 0; i < 5; i++) {
      setHidden(true);
      setHidden(false);
    }
    assert.ok(liveIntervals.size <= 1, `expected at most 1 live interval, got ${liveIntervals.size}`);
  });
});
