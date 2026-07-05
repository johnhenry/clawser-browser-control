// offscreen.js — Chrome-only. Runs in an offscreen document (real DOM +
// canvas), which an MV3 service worker doesn't have, to decode captured
// screenshot frames and encode them into an animated GIF via gifenc.js.
//
// Created on demand by background.js's actionGifRecordStop() via
// chrome.offscreen.createDocument(), closed again once encoding is done.

import { GIFEncoder, quantize, applyPalette } from './gifenc.js';

const MARKER = '__clawser_ext__';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== MARKER || msg.target !== 'offscreen' || msg.action !== 'encode_gif') return false;

  (async () => {
    try {
      const dataUrl = await encodeGif(msg.frames, msg.delayCs);
      sendResponse({ dataUrl });
    } catch (e) {
      sendResponse({ error: e.message || String(e) });
    }
  })();

  return true; // keep sendResponse alive for the async work above
});

/**
 * @param {string[]} frames - data URLs (from chrome.tabs.captureVisibleTab)
 * @param {number} delayCs - per-frame delay, in 1/100s units (GIF's native unit)
 * @returns {Promise<string>} a data:image/gif;base64,... URL
 */
async function encodeGif(frames, delayCs) {
  if (!Array.isArray(frames) || frames.length === 0) throw new Error('No frames to encode');

  const gif = GIFEncoder();
  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext('2d');

  for (const dataUrl of frames) {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    ctx.drawImage(bitmap, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, width, height, { palette, delay: delayCs });
  }

  gif.finish();
  const bytes = gif.bytes();
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return 'data:image/gif;base64,' + btoa(binary);
}
