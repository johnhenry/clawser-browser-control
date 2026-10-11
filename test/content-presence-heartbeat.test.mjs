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

describe('content.js — presence heartbeat keeps running while hidden', () => {
  // content.js only runs on clawser origins now, and a background tab opened by the
  // scheduler is hidden from birth: pausing the heartbeat there meant the page never
  // heard presence (clawser boots slowly) and never connected.
  it('starts the heartbeat interval when the tab is visible on load', async (t) => {
    const { liveIntervals } = await freshLoad(t);
    assert.equal(liveIntervals.size, 1, 'heartbeat interval should be running');
  });

  it('starts the heartbeat interval even when the tab starts hidden', async (t) => {
    const { liveIntervals } = await freshLoad(t, {}, { hidden: true });
    assert.equal(liveIntervals.size, 1, 'a background tab must still announce itself');
  });

  it('keeps the heartbeat interval when the tab becomes hidden', async (t) => {
    const { liveIntervals, setHidden } = await freshLoad(t);
    setHidden(true);
    assert.equal(liveIntervals.size, 1);
  });

  it('re-announces immediately when the tab becomes visible, without a second interval', async (t) => {
    const { liveIntervals, setHidden, popPosted } = await freshLoad(t, {}, { hidden: true });
    setHidden(false);
    await tick();
    assert.equal(liveIntervals.size, 1);
    assert.ok(popPosted().find((m) => m.direction === 'presence'));
  });

  it('toggling hidden repeatedly never leaves more than one live interval', async (t) => {
    const { liveIntervals, setHidden } = await freshLoad(t);
    for (let i = 0; i < 5; i++) {
      setHidden(true);
      setHidden(false);
    }
    assert.equal(liveIntervals.size, 1);
  });
});
