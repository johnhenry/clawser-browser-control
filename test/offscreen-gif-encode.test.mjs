// Run with: node --test test/offscreen-gif-encode.test.mjs
//
// offscreen.js was previously only exercised in a real browser (see
// clawser-browser-control#14 item 6). It's a real ES module, so unlike
// content.js/background.js (loaded into a vm context — see _load-content.mjs)
// this can be `import`ed directly once the browser-only globals it needs
// (chrome.runtime.onMessage, OffscreenCanvas, fetch, createImageBitmap) are
// stubbed on globalThis first. The real gifenc.js encoder runs unstubbed —
// this is the same frame → canvas → quantize/applyPalette → GIF pipeline
// gifenc-encoding.test.mjs already validates the encoder half of, but here
// through offscreen.js's actual message handler and canvas glue.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

const MARKER = '__clawser_ext__';

/** A 1x1 solid-color PNG-shaped fake "blob" — the stubbed fetch/createImageBitmap
 *  pipeline below never actually decodes real image bytes, it just carries
 *  the intended pixel color through from data URL to ImageData. */
function fakeDataUrl(width, height, [r, g, b, a]) {
  return `fake-frame:${width}x${height}:${r},${g},${b},${a}`;
}

class FakeCanvasContext {
  drawImage(bitmap) {
    this._bitmap = bitmap;
  }
  getImageData(_x, _y, width, height) {
    const { r, g, b, a } = this._bitmap;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) data.set([r, g, b, a], i * 4);
    return { data, width, height };
  }
}

class FakeOffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }
  getContext() {
    if (!this._ctx) this._ctx = new FakeCanvasContext();
    return this._ctx;
  }
}

let capturedListener = null;

before(async () => {
  globalThis.chrome = {
    runtime: {
      onMessage: {
        addListener: (fn) => { capturedListener = fn; },
      },
    },
  };
  globalThis.OffscreenCanvas = FakeOffscreenCanvas;
  globalThis.fetch = async (dataUrl) => ({
    blob: async () => ({ __fakeDataUrl: dataUrl }),
  });
  globalThis.createImageBitmap = async (blob) => {
    // fake-frame:4x4:255,0,0,255
    const [, dims, rgba] = blob.__fakeDataUrl.split(':');
    const [width, height] = dims.split('x').map(Number);
    const [r, g, b, a] = rgba.split(',').map(Number);
    return { width, height, r, g, b, a };
  };

  await import('../offscreen.js');
});

/** Send a fake chrome.runtime message to offscreen.js's real registered listener. */
function sendToOffscreen(msg) {
  return new Promise((resolve) => {
    const keepAlive = capturedListener(
      { type: MARKER, target: 'offscreen', ...msg },
      {},
      (response) => resolve(response),
    );
    assert.equal(keepAlive, true, 'listener should return true to keep sendResponse alive for async work');
  });
}

describe('offscreen.js — encode_gif message handler', () => {
  it('registers a chrome.runtime.onMessage listener on load', () => {
    assert.equal(typeof capturedListener, 'function');
  });

  it('ignores messages not targeting offscreen/encode_gif', () => {
    const result = capturedListener({ type: MARKER, target: 'other', action: 'noop' }, {}, () => {});
    assert.equal(result, false);
  });

  it('encodes a single frame into a valid GIF data URL', async () => {
    const frames = [fakeDataUrl(4, 4, [255, 0, 0, 255])];
    const { dataUrl, error } = await sendToOffscreen({ action: 'encode_gif', frames, delayCs: 50 });

    assert.equal(error, undefined);
    assert.ok(dataUrl.startsWith('data:image/gif;base64,'));

    const bytes = Buffer.from(dataUrl.slice('data:image/gif;base64,'.length), 'base64');
    assert.equal(bytes.subarray(0, 6).toString('ascii'), 'GIF89a');
    assert.equal(bytes[bytes.length - 1], 0x3b, 'missing GIF trailer byte');
  });

  it('encodes multiple frames into an animated GIF', async () => {
    const frames = [
      fakeDataUrl(2, 2, [255, 0, 0, 255]),
      fakeDataUrl(2, 2, [0, 255, 0, 255]),
      fakeDataUrl(2, 2, [0, 0, 255, 255]),
    ];
    const { dataUrl, error } = await sendToOffscreen({ action: 'encode_gif', frames, delayCs: 25 });

    assert.equal(error, undefined);
    const bytes = Buffer.from(dataUrl.slice('data:image/gif;base64,'.length), 'base64');

    let gceCount = 0;
    for (let i = 0; i < bytes.length - 1; i++) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9) gceCount++;
    }
    assert.equal(gceCount, frames.length, 'each input frame should produce one Graphic Control Extension block');
  });

  it('responds with an error instead of throwing when frames is empty', async () => {
    const { dataUrl, error } = await sendToOffscreen({ action: 'encode_gif', frames: [], delayCs: 50 });
    assert.equal(dataUrl, undefined);
    assert.match(error, /no frames/i);
  });
});
