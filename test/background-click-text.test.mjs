// Run with: node --test test/background-click-text.test.mjs
// #27: clicking by text must reach the labelled control, never a broad ancestor like <main>.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './_load-background.mjs';
import { el, makeDocument } from './_fake-dom.mjs';

/** Run an action against a fixture document, in the real executeScript path. */
function run(body, action, params) {
  let sandbox;
  const bg = loadBackground({
    scripting: {
      executeScript: async ({ func, args }) => {
        sandbox.document = makeDocument(body);
        sandbox.window = {};
        sandbox.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c) };
        return [{ result: await func(...args.map((a) => (a === undefined ? null : a))) }];
      },
    },
  });
  sandbox = bg.sandbox;
  sandbox.MouseEvent = class MouseEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } };
  return bg.send(action, params).then((r) => ({ ...r, body }));
}

const seleniumForm = () => {
  const c1 = el('input', { type: 'checkbox', id: 'my-check-1', class: 'form-check-input', checked: true });
  const c2 = el('input', { type: 'checkbox', id: 'my-check-2', class: 'form-check-input' });
  const r1 = el('input', { type: 'radio', id: 'my-radio-1', name: 'my-radio', checked: true });
  const r2 = el('input', { type: 'radio', id: 'my-radio-2', name: 'my-radio' });
  return {
    body: el('body', {}, [
      el('main', {}, [
        el('h1', {}, [], 'Web form'),
        el('form', {}, [
          el('label', { for: 'my-check-1' }, [c1], ' Checked checkbox'),
          el('label', { for: 'my-check-2' }, [c2], ' Default checkbox'),
          el('label', { for: 'my-radio-1' }, [r1], ' Checked radio'),
          el('label', { for: 'my-radio-2' }, [r2], ' Default radio'),
          el('button', { type: 'submit', class: 'btn' }, [], 'Submit'),
        ]),
      ]),
    ]),
    c1, c2, r1, r2,
  };
};

describe('click by text reaches the labelled control (the audit failure)', () => {
  it('"Default checkbox" checks #my-check-2 and reports it, not <main>', async () => {
    const f = seleniumForm();
    const r = await run(f.body, 'click', { text: 'Default checkbox' });
    assert.equal(r.error, undefined);
    assert.equal(r.result.clicked, 'INPUT');
    assert.equal(f.c2.checked, true);
    assert.equal(r.result.checked, true);
    assert.equal(r.result.element.tag, 'input');
    assert.equal(r.result.element.selector, '#my-check-2');
    assert.match(r.result.element.name, /Default checkbox/);
  });

  it('clicking again unchecks it, and the result says so', async () => {
    const f = seleniumForm();
    await run(f.body, 'click', { text: 'Checked checkbox' });
    assert.equal(f.c1.checked, false);
    const r = await run(f.body, 'click', { text: 'Checked checkbox' });
    assert.equal(r.result.checked, true);
  });

  it('a radio is selected and the others in its group are not', async () => {
    const f = seleniumForm();
    const r = await run(f.body, 'click', { text: 'Default radio' });
    assert.equal(f.r2.checked, true);
    assert.equal(f.r1.checked, false);
    assert.equal(r.result.checked, true);
    assert.equal(r.result.element.selector, '#my-radio-2');
  });

  it('never clicks <main> or <form>', async () => {
    const f = seleniumForm();
    await run(f.body, 'click', { text: 'Default checkbox' });
    const main = f.body.children[0];
    assert.deepEqual(main.events, []);
    assert.deepEqual(main.children[1].events, []);
  });

  it('a button by its text, reporting tag, role and name', async () => {
    const f = seleniumForm();
    const r = await run(f.body, 'click', { text: 'Submit' });
    assert.equal(r.result.clicked, 'BUTTON');
    assert.equal(r.result.element.role, 'button');
    assert.equal(r.result.element.name, 'Submit');
    assert.equal('checked' in r.result, false, 'checked only for checkboxes and radios');
  });
});

describe('label forms', () => {
  it('label[for] pointing at a control that is elsewhere in the page', async () => {
    const box = el('input', { type: 'checkbox', id: 'far' });
    const body = el('body', {}, [el('div', {}, [el('label', { for: 'far' }, [], 'Send me updates')]), el('footer', {}, [box])]);
    const r = await run(body, 'click', { text: 'Send me updates' });
    assert.equal(box.checked, true);
    assert.equal(r.result.element.selector, '#far');
  });

  it('a label wrapping its input (no for)', async () => {
    const box = el('input', { type: 'checkbox' });
    const body = el('body', {}, [el('p', {}, [el('label', {}, [box], ' Remember me')])]);
    const r = await run(body, 'click', { text: 'Remember me' });
    assert.equal(box.checked, true);
    assert.equal(r.result.element.tag, 'input');
    assert.match(r.result.element.selector, /input/);
  });

  it('aria-label and aria-labelledby give controls their names', async () => {
    const a = el('button', { 'aria-label': 'Close dialog' }, [], 'x');
    const heading = el('span', { id: 'lbl' }, [], 'Open settings');
    const b = el('button', { 'aria-labelledby': 'lbl' }, [], 'icon');
    const body = el('body', {}, [a, heading, b]);
    assert.equal((await run(body, 'click', { text: 'Close dialog' })).result.element.selector, 'body > button:nth-of-type(1)');
    const r = await run(body, 'click', { text: 'Open settings' });
    assert.equal(r.result.clicked, 'BUTTON');
    assert.equal(r.result.element.name, 'Open settings');
  });

  it('links and submit inputs by their accessible name', async () => {
    const link = el('a', { href: '/x' }, [], 'Read the docs');
    const sub = el('input', { type: 'submit', value: 'Send now' });
    const body = el('body', {}, [link, sub]);
    assert.equal((await run(body, 'click', { text: 'Read the docs' })).result.clicked, 'A');
    assert.equal((await run(body, 'click', { text: 'Send now' })).result.clicked, 'INPUT');
  });
});

describe('ancestors and containers are not clicked', () => {
  it('nested text: only the innermost element is a target, never <main> or <section>', async () => {
    const p = el('p', {}, [], 'Default checkbox');
    const section = el('section', {}, [p]);
    const main = el('main', {}, [section]);
    const body = el('body', {}, [main]);
    const r = await run(body, 'click', { text: 'Default checkbox' });
    assert.equal(r.result.clicked, 'P');
    assert.deepEqual(main.events, []);
    assert.deepEqual(section.events, []);
  });

  it('text that matches nothing clickable is "Element not found", not a guess', async () => {
    const main = el('main', {}, [el('section', {}, [el('p', {}, [], 'Hello'), el('p', {}, [], 'World')])]);
    const body = el('body', {}, [main]);
    const r = await run(body, 'click', { text: 'Hello World' }); // only true of the combined container text
    assert.match(r.result.error, /Element not found/);
    assert.deepEqual(main.events, []);
  });

  it('prefers the specific interactive element over an interactive ancestor', async () => {
    const inner = el('a', { href: '#' }, [], 'Pay now');
    const outer = el('div', { role: 'button', tabindex: '0' }, [inner]);
    const body = el('body', {}, [outer]);
    const r = await run(body, 'click', { text: 'Pay now' });
    assert.equal(r.result.clicked, 'A');
    assert.deepEqual(outer.events, []);
  });

  it('a lone leaf element (script-driven click target) may be clicked, but never its containers', async () => {
    const leaf = el('span', {}, [], 'Click me');
    const wrapper = el('div', {}, [leaf, el('span', {}, [], 'other')]);
    const body = el('body', {}, [wrapper]);
    const r = await run(body, 'click', { text: 'Click me' });
    assert.equal(r.result.clicked, 'SPAN');
    assert.deepEqual(wrapper.events, []);
  });

  it('substring matches only count when no exact match exists', async () => {
    const a = el('button', {}, [], 'Save');
    const b = el('button', {}, [], 'Save and close');
    const body = el('body', {}, [a, b]);
    assert.equal((await run(body, 'click', { text: 'Save' })).result.element.name, 'Save');
    assert.equal((await run(body, 'click', { text: 'close' })).result.element.name, 'Save and close');
  });

  it('matching ignores case and extra whitespace', async () => {
    const body = el('body', {}, [el('button', {}, [], '  Add   to\n cart ')]);
    assert.equal((await run(body, 'click', { text: 'add to cart' })).result.clicked, 'BUTTON');
  });
});

describe('duplicate text is an error, not a guess', () => {
  it('two buttons with the same text: ambiguity error listing selectors, nothing clicked', async () => {
    const a = el('button', {}, [], 'Delete');
    const b = el('button', {}, [], 'Delete');
    const body = el('body', {}, [a, b]);
    const r = await run(body, 'click', { text: 'Delete' });
    assert.match(r.result.error, /Ambiguous/);
    assert.match(r.result.error, /2 matches/);
    assert.match(r.result.error, /body > button:nth-of-type\(1\)/);
    assert.match(r.result.error, /body > button:nth-of-type\(2\)/);
    assert.deepEqual(a.events, []);
    assert.deepEqual(b.events, []);
  });

  it('the same text on a label and its control is ONE target', async () => {
    const f = seleniumForm();
    const r = await run(f.body, 'click', { text: 'Default checkbox' });
    assert.equal(r.result.error, undefined);
  });

  it('a selector still disambiguates', async () => {
    const a = el('button', { id: 'one' }, [], 'Delete');
    const b = el('button', { id: 'two' }, [], 'Delete');
    const body = el('body', {}, [a, b]);
    const r = await run(body, 'click', { selector: '#two' });
    assert.equal(r.result.clicked, 'BUTTON');
    assert.deepEqual(a.events, []);
    assert.ok(b.events.includes('click'));
  });
});

describe('disabled controls', () => {
  it('are reported, not silently "clicked"', async () => {
    const btn = el('button', { disabled: true }, [], 'Buy');
    const body = el('body', {}, [btn]);
    const r = await run(body, 'click', { text: 'Buy' });
    assert.match(r.result.error, /disabled/i);
    assert.deepEqual(btn.events, []);
  });

  it('an enabled match is preferred over a disabled duplicate', async () => {
    const off = el('button', { disabled: true }, [], 'Buy');
    const on = el('button', {}, [], 'Buy');
    const body = el('body', {}, [off, on]);
    const r = await run(body, 'click', { text: 'Buy' });
    assert.equal(r.result.error, undefined);
    assert.ok(on.events.includes('click'));
  });
});

describe('the other pointer actions share the resolver', () => {
  it('double, triple, right click and hover resolve a labelled checkbox the same way', async () => {
    for (const [action, key, expectEvent] of [['double_click', 'doubleClicked', 'dblclick'], ['triple_click', 'tripleClicked', 'click'], ['right_click', 'rightClicked', 'contextmenu'], ['hover', 'hovered', 'mouseover']]) {
      const f = seleniumForm();
      const r = await run(f.body, action, { text: 'Default checkbox' });
      assert.equal(r.result[key], 'INPUT', action);
      assert.ok(f.c2.events.includes(expectEvent), action);
      assert.equal(r.result.element.selector, '#my-check-2', action);
    }
  });

  it('the same ambiguity error applies', async () => {
    const body = el('body', {}, [el('button', {}, [], 'Go'), el('button', {}, [], 'Go')]);
    for (const action of ['double_click', 'triple_click', 'right_click', 'hover']) {
      assert.match((await run(body, action, { text: 'Go' })).result.error, /Ambiguous/, action);
    }
  });

  it('event sequences are unchanged (double: detail 2; right: button 2)', async () => {
    const f = seleniumForm();
    await run(f.body, 'double_click', { selector: '#my-check-2' });
    assert.deepEqual(f.c2.events, ['mousedown', 'mouseup', 'dblclick']);
    const g = seleniumForm();
    await run(g.body, 'triple_click', { selector: '#my-check-2' });
    assert.equal(g.c2.events.filter((e) => e === 'click').length, 3);
  });
});

describe('coordinates and selectors still work and are described', () => {
  it('by coordinates', async () => {
    const f = seleniumForm();
    let sandbox;
    const bg = loadBackground({ scripting: { executeScript: async ({ func, args }) => { sandbox.document = { ...makeDocument(f.body), elementFromPoint: () => f.c2 }; sandbox.CSS = undefined; return [{ result: await func(...args.map((a) => (a === undefined ? null : a))) }]; } } });
    sandbox = bg.sandbox; sandbox.MouseEvent = class { constructor(t) { this.type = t; } };
    const r = (await bg.send('click', { x: 4, y: 5 })).result;
    assert.equal(r.clicked, 'INPUT');
    assert.equal(r.checked, true);
  });

  it('a missing selector is still "Element not found"', async () => {
    const body = el('body', {}, []);
    assert.match((await run(body, 'click', { selector: '#nope' })).result.error, /Element not found/);
  });
});
