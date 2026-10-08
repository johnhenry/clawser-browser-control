// Run with: node --test test/background-execute-args.test.mjs
//
// chrome.scripting.executeScript rejects `undefined` in `args` ("Value is unserializable"). The stub
// in _load-background.mjs calls the function directly and never noticed, so a click by selector
// alone (no text, no x/y) failed in a real browser. This stub behaves like Chrome.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './_load-background.mjs';

function boot(page) {
  let sandbox;
  const calls = [];
  const bg = loadBackground({
    scripting: {
      executeScript: async ({ func, args }) => {
        calls.push(args);
        args.forEach((a, i) => { if (a === undefined) throw new Error(`Error at parameter 'injection': Error at property 'args': Error at index ${i}: Value is unserializable.`); });
        sandbox.document = page.document;
        return [{ result: await func(...args) }];
      },
    },
  });
  sandbox = bg.sandbox;
  sandbox.MouseEvent = class MouseEvent { constructor(type) { this.type = type; } };
  sandbox.Event = class Event { constructor(type) { this.type = type; } };
  return { send: async (...a) => JSON.parse(JSON.stringify(await bg.send(...a))), calls };
}

const el = (tag, extra = {}) => ({ tagName: tag, textContent: 'Go', dispatchEvent() {}, ...extra });

describe('optional arguments reach the page as null, not undefined', () => {
  it('click by selector only', async () => {
    const hit = [];
    const { send, calls } = boot({ document: { querySelector: (s) => { hit.push(s); return el('BUTTON'); } } });
    const { result, error } = await send('click', { selector: '#go' });
    assert.equal(error, undefined);
    assert.equal(result.clicked, 'BUTTON');
    assert.deepEqual(hit, ['#go']);
    assert.deepEqual([...calls[0]], ['#go', null, null, null]);
  });

  it('click by coordinates still uses elementFromPoint, and by text still finds the element', async () => {
    const points = [];
    const a = boot({ document: { elementFromPoint: (x, y) => { points.push([x, y]); return el('DIV'); } } });
    assert.equal((await a.send('click', { x: 5, y: 7 })).result.clicked, 'DIV');
    assert.deepEqual(points, [[5, 7]]);
    const b = boot({ document: { querySelectorAll: () => [el('A', { textContent: ' Go home ' })] } });
    assert.equal((await b.send('click', { text: 'Go' })).result.clicked, 'A');
  });

  it('select_option by text only', async () => {
    const select = { tagName: 'SELECT', options: [{ value: 'a', textContent: 'Alpha', selected: false }, { value: 'b', textContent: 'Beta', selected: false }], dispatchEvent() {} };
    const { send } = boot({ document: { querySelector: () => select } });
    const { result, error } = await send('select_option', { selector: '#s', text: 'Beta' });
    assert.equal(error, undefined);
    assert.equal(result.selected, 'b');
  });
});
