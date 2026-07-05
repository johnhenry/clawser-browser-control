// Run with: node --test test/background-input-validation.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './_load-background.mjs';

describe('coordinate validation (click/dblclick/triple-click/right-click/hover)', () => {
  for (const action of ['click', 'double_click', 'triple_click', 'right_click', 'hover']) {
    it(`${action}: requires selector, text, or x/y`, async () => {
      const { send } = loadBackground();
      const { error } = await send(action, {});
      assert.match(error, /selector, text, or x\/y is required/);
    });

    it(`${action}: rejects negative coordinates`, async () => {
      const { send } = loadBackground();
      const { error } = await send(action, { x: -1, y: 5 });
      assert.match(error, /x\/y must be given together/);
    });

    it(`${action}: rejects x without y`, async () => {
      const { send } = loadBackground();
      const { error } = await send(action, { x: 5 });
      assert.match(error, /x\/y must be given together/);
    });

    it(`${action}: accepts a selector alone (no coordinate validation triggered)`, async () => {
      const { send } = loadBackground({
        scripting: { executeScript: async () => [{ result: { error: 'Element not found' } }] },
      });
      const { result } = await send(action, { selector: '#missing' });
      assert.equal(result.error, 'Element not found');
    });
  }
});

describe('actionDrag coordinate validation', () => {
  it('requires endX/endY', async () => {
    const { send } = loadBackground();
    const { error } = await send('drag', { startX: 0, startY: 0 });
    assert.match(error, /endX\/endY are required/);
  });

  it('rejects out-of-bounds coordinates', async () => {
    const { send } = loadBackground();
    const { error } = await send('drag', { startX: 0, startY: 0, endX: 999999, endY: 0 });
    assert.match(error, /endX\/endY must be given together/);
  });
});

describe('actionScroll direction handling', () => {
  it('normalizes case-insensitive directions before dispatch (capture args, no real DOM needed)', async () => {
    for (const [input, expected] of [['UP', 'up'], ['Down', 'down'], ['LEFT', 'left'], ['right', 'right']]) {
      let capturedArgs;
      const { send } = loadBackground({
        scripting: { executeScript: async ({ args }) => { capturedArgs = args; return [{ result: null }]; } },
      });
      const { result, error } = await send('scroll', { direction: input });
      assert.equal(error, undefined);
      assert.equal(result, null);
      // args = [selector, normalizedDirection, amount]
      assert.equal(capturedArgs[1], expected);
    }
  });

  it('rejects an unrecognized direction instead of silently defaulting', async () => {
    const { send } = loadBackground();
    const { error } = await send('scroll', { direction: 'sideways' });
    assert.match(error, /Invalid direction/);
  });

  it('defaults to "down" when no direction is given', async () => {
    let capturedArgs;
    const { send } = loadBackground({
      scripting: { executeScript: async ({ args }) => { capturedArgs = args; return [{ result: null }]; } },
    });
    const { error } = await send('scroll', {});
    assert.equal(error, undefined);
    assert.equal(capturedArgs[1], 'down');
  });
});

describe('actionType', () => {
  it('requires text', async () => {
    const { send } = loadBackground();
    const { error } = await send('type', {});
    assert.match(error, /text is required/);
  });
});

describe('actionFormInput', () => {
  it('requires a selector', async () => {
    const { send } = loadBackground();
    const { error } = await send('form_input', { value: 'x' });
    assert.match(error, /selector is required/);
  });
});

describe('actionSelectOption', () => {
  it('requires a selector', async () => {
    const { send } = loadBackground();
    const { error } = await send('select_option', { value: 'x' });
    assert.match(error, /selector is required/);
  });

  it('requires value or text', async () => {
    const { send } = loadBackground();
    const { error } = await send('select_option', { selector: '#s' });
    assert.match(error, /value or text is required/);
  });
});

describe('actionWait / actionWaitCancel', () => {
  it('requires selector or condition', async () => {
    const { send } = loadBackground();
    const { error } = await send('wait', {});
    assert.match(error, /selector or condition is required/);
  });

  it('wait_cancel resolves even with nothing waiting', async () => {
    const { send } = loadBackground({
      scripting: { executeScript: async () => [{ result: undefined }] },
    });
    const { result } = await send('wait_cancel', {});
    assert.equal(result.cancelled, true);
  });
});
