// Run with: node --test test/gifenc-encoding.test.mjs
//
// Verifies the vendored gifenc.js (see THIRD-PARTY-LICENSES.md) actually
// produces valid GIF output from raw RGBA frames. This is the real risk
// in the GIF recording feature — the browser-specific canvas/screenshot
// capture glue (offscreen.js, background.js's frame-capture loop) can
// only be fully exercised in a real browser, same limitation as this
// repo's existing screenshot/DOM actions — but the encoder itself needs
// no browser APIs at all and is fully testable here.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GIFEncoder, quantize, applyPalette } from '../gifenc.js';

function solidFrame(width, height, [r, g, b, a]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data.set([r, g, b, a], i * 4);
  }
  return data;
}

describe('vendored gifenc encoder', () => {
  it('encodes a single-frame GIF with a valid header and trailer', () => {
    const width = 4, height = 4;
    const frame = solidFrame(width, height, [255, 0, 0, 255]);
    const gif = GIFEncoder();
    const palette = quantize(frame, 256);
    const index = applyPalette(frame, palette);
    gif.writeFrame(index, width, height, { palette, delay: 50 });
    gif.finish();
    const bytes = gif.bytes();

    assert.ok(bytes.length > 20, 'encoded GIF should be a reasonable size, not empty/truncated');
    assert.equal(String.fromCharCode(...bytes.slice(0, 6)), 'GIF89a');
    assert.equal(bytes[bytes.length - 1], 0x3b, 'missing GIF trailer byte');
  });

  it('encodes a multi-frame animated GIF', () => {
    const width = 2, height = 2;
    const frames = [
      solidFrame(width, height, [255, 0, 0, 255]),
      solidFrame(width, height, [0, 255, 0, 255]),
      solidFrame(width, height, [0, 0, 255, 255]),
    ];
    const gif = GIFEncoder();
    for (const frame of frames) {
      const palette = quantize(frame, 256);
      const index = applyPalette(frame, palette);
      gif.writeFrame(index, width, height, { palette, delay: 50 });
    }
    gif.finish();
    const bytes = gif.bytes();

    assert.equal(String.fromCharCode(...bytes.slice(0, 6)), 'GIF89a');
    assert.equal(bytes[bytes.length - 1], 0x3b);
    // Each frame contributes a Graphic Control Extension block (0x21 0xF9)
    // — a rough but real signal that all three frames actually got written,
    // not just the first.
    let gceCount = 0;
    for (let i = 0; i < bytes.length - 1; i++) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9) gceCount++;
    }
    assert.equal(gceCount, frames.length);
  });

  it('rejects non-RGBA-shaped input rather than silently producing garbage', () => {
    assert.throws(() => quantize('not an array', 256));
  });
});
