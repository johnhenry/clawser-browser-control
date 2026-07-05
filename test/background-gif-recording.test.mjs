// Run with: node --test test/background-gif-recording.test.mjs
//
// Covers the gif_record_start/stop state machine (validation, fps
// clamping, frame-count math, double-start rejection, auto-stop at the
// frame cap). The actual encode step (which needs chrome.offscreen or a
// real DOM/canvas) is exercised separately in gifenc-encoding.test.mjs
// against the vendored encoder directly with synthetic RGBA data — real
// browser-canvas integration can only be verified in a real browser,
// same limitation as this repo's existing screenshot/DOM actions.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './_load-background.mjs';

describe('gif_record_start validation', () => {
  it('rejects maxDurationSec outside [1, 60]', async () => {
    const { send } = loadBackground();
    assert.match((await send('gif_record_start', { maxDurationSec: 0 })).error, /maxDurationSec must be between 1 and 60/);
    assert.match((await send('gif_record_start', { maxDurationSec: 61 })).error, /maxDurationSec must be between 1 and 60/);
    assert.match((await send('gif_record_start', { maxDurationSec: -5 })).error, /maxDurationSec must be between 1 and 60/);
  });

  it('clamps fps to Chrome\'s captureVisibleTab rate limit (2/sec)', async () => {
    const { send } = loadBackground();
    const { result } = await send('gif_record_start', { fps: 10, maxDurationSec: 5 });
    assert.equal(result.fps, 2);
  });

  it('computes maxFrames from the clamped fps and requested duration', async () => {
    const { send } = loadBackground();
    const { result } = await send('gif_record_start', { fps: 2, maxDurationSec: 3 });
    assert.equal(result.maxFrames, 6); // 3s @ 2fps
  });

  it('rejects starting a second recording while one is already in progress', async () => {
    const { send } = loadBackground();
    await send('gif_record_start', { maxDurationSec: 5 });
    const { error } = await send('gif_record_start', { maxDurationSec: 5 });
    assert.match(error, /already in progress/);
  });
});

describe('gif_record_stop', () => {
  it('errors when nothing is recording', async () => {
    const { send } = loadBackground();
    const { error } = await send('gif_record_stop', {});
    assert.match(error, /No GIF recording in progress/);
  });

  it('returns a null result with zero frames if stopped before any frame was captured', async () => {
    let captureCount = 0;
    const { send } = loadBackground({
      tabs: { captureVisibleTab: async () => { captureCount++; return 'data:image/jpeg;base64,AAA'; } },
    });
    await send('gif_record_start', { maxDurationSec: 5 });
    // Stop immediately, before the first ~500ms capture interval fires.
    const { result } = await send('gif_record_stop', {});
    assert.equal(result.frameCount, 0);
    assert.equal(result.dataUrl, null);
    assert.equal(captureCount, 0);
  });

  it('auto-stops once maxFrames is reached, capturing exactly that many frames', async () => {
    let captureCount = 0;
    const { send } = loadBackground({
      tabs: { captureVisibleTab: async () => { captureCount++; return 'data:image/jpeg;base64,AAA'; } },
      offscreen: {
        createDocument: async () => {},
        closeDocument: async () => {},
      },
      runtime: {
        getContexts: async () => [],
        sendMessage: async (msg) => {
          if (msg.target === 'offscreen' && msg.action === 'encode_gif') {
            return { dataUrl: `data:image/gif;base64,FAKE(${msg.frames.length} frames)` };
          }
          return {};
        },
      },
    });

    await send('gif_record_start', { fps: 2, maxDurationSec: 1 }); // maxFrames = 2, intervalMs = 500
    // Ticks at 500ms and 1000ms each capture a frame (length -> 1, then 2);
    // the auto-stop check only fires on the *next* tick after the cap is
    // reached, i.e. the tick at 1500ms — so we must wait past that, not
    // just past the last capture.
    await new Promise((r) => setTimeout(r, 1700));

    assert.equal(captureCount, 2);

    // A subsequent explicit stop should now report "nothing in progress",
    // proving the auto-stop already cleared gifRecordingState.
    const { error } = await send('gif_record_stop', {});
    assert.match(error, /No GIF recording in progress/);
  });
});
