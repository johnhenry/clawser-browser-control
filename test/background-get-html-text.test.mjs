// Run with: node --test test/background-get-html-text.test.mjs
// get_html / get_text: optional strip and maxChars params, plus truncated/length in the result.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './_load-background.mjs';

/** Minimal fake node tree: just what the in-page functions touch. */
function node(tag, { html, children = [], comment = false } = {}) {
  const n = { tagName: tag.toUpperCase(), nodeType: comment ? 8 : 1, children, parent: null, removed: false, _html: html };
  children.forEach((c) => { c.parent = n; });
  n.remove = () => { n.removed = true; if (n.parent) n.parent.children = n.parent.children.filter((c) => c !== n); };
  n.cloneNode = () => cloneOf(n);
  n.querySelectorAll = (sel) => {
    const tags = sel.split(',').map((s) => s.trim().toUpperCase());
    const out = [];
    (function walk(x) { for (const c of x.children) { if (c.nodeType === 1 && tags.includes(c.tagName)) out.push(c); walk(c); } })(n);
    return out;
  };
  Object.defineProperty(n, 'outerHTML', {
    get() {
      const inner = n.children.map((c) => (c.nodeType === 8 ? '<!--c-->' : c.outerHTML)).join('');
      return `<${n.tagName.toLowerCase()}>${n._html ?? ''}${inner}</${n.tagName.toLowerCase()}>`;
    },
  });
  return n;
}
function cloneOf(n) {
  const c = node(n.tagName, { html: n._html, comment: n.nodeType === 8, children: n.children.map(cloneOf) });
  return c;
}

function boot(documentElement, { text = '' } = {}) {
  let sandbox;
  const bg = loadBackground({
    scripting: {
      executeScript: async ({ func, args }) => {
        sandbox.document = {
          documentElement,
          querySelector: (s) => (s === 'html' ? documentElement : s === 'article' || s === 'main' ? null : null),
          body: { innerText: text },
          title: 'T',
          createTreeWalker: (root) => {
            const found = [];
            (function walk(x) { for (const c of x.children) { if (c.nodeType === 8) found.push(c); walk(c); } })(root);
            let i = -1;
            return { nextNode: () => found[++i] || null };
          },
        };
        sandbox.location = { href: 'https://x.test/' };
        return [{ result: await func(...args) }];
      },
    },
  });
  sandbox = bg.sandbox;
  return async (action, params) => JSON.parse(JSON.stringify((await bg.send(action, params)).result));
}

const page = (bodyHtml = 'hello') => node('html', { children: [
  node('head', { children: [node('meta'), node('link'), node('style', { html: 'a{}' }), node('script', { html: 'var x' })] }),
  node('body', { html: bodyHtml, children: [node('svg', { html: '<path/>' }), node('noscript'), node('template'), node('iframe'), node('div', { html: 'keep' }), node('span', { comment: true })] }),
] });

describe('get_html', () => {
  it('no params: unchanged behaviour (50000 cap, scripts kept) plus truncated/length', async () => {
    const send = boot(page());
    const r = await send('get_html', {});
    assert.ok(r.html.includes('<script>var x</script>'));
    assert.ok(r.html.includes('<svg>'));
    assert.equal(r.truncated, false);
    assert.equal(r.length, r.html.length);
  });

  it('truncates at 50000 by default and reports the full length', async () => {
    const send = boot(page('x'.repeat(60000)));
    const r = await send('get_html', {});
    assert.equal(r.html.length, 50000);
    assert.equal(r.truncated, true);
    assert.ok(r.length > 60000);
  });

  it('maxChars raises the cap', async () => {
    const send = boot(page('x'.repeat(60000)));
    const r = await send('get_html', { maxChars: 100000 });
    assert.equal(r.truncated, false);
    assert.equal(r.html.length, r.length);
  });

  it('maxChars lowers the cap', async () => {
    const send = boot(page('x'.repeat(500)));
    const r = await send('get_html', { maxChars: 100 });
    assert.equal(r.html.length, 100);
    assert.equal(r.truncated, true);
  });

  it('maxChars is clamped to 2,000,000', async () => {
    const send = boot(page('x'.repeat(2_100_000)));
    const r = await send('get_html', { maxChars: 99_999_999 });
    assert.equal(r.html.length, 2_000_000);
    assert.equal(r.truncated, true);
  });

  it('garbage maxChars falls back to 50000', async () => {
    const send = boot(page('x'.repeat(60000)));
    for (const maxChars of ['abc', -5, 0, NaN, null, {}, [], Infinity]) {
      const r = await send('get_html', { maxChars });
      assert.equal(r.html.length, 50000, String(maxChars));
    }
  });

  it('numeric strings and fractions are accepted sensibly', async () => {
    const send = boot(page('x'.repeat(500)));
    assert.equal((await send('get_html', { maxChars: '200' })).html.length, 200);
    assert.equal((await send('get_html', { maxChars: 150.9 })).html.length, 150);
  });

  it('strip removes script, style, noscript, template, svg, iframe, link, meta and comments but keeps content', async () => {
    const send = boot(page());
    const r = await send('get_html', { strip: true });
    for (const t of ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'link', 'meta']) assert.ok(!r.html.includes(`<${t}>`), t);
    assert.ok(!r.html.includes('<!--'));
    assert.ok(r.html.includes('keep'));
    assert.ok(r.html.includes('hello'));
  });

  it('strip does not modify the live page (works on a clone)', async () => {
    const doc = page();
    const send = boot(doc);
    await send('get_html', { strip: true });
    assert.ok(doc.outerHTML.includes('<script>'));
    assert.equal(doc.children[0].children.some((c) => c.removed), false);
  });

  it('length is measured after stripping, before slicing', async () => {
    const send = boot(page('y'.repeat(1000)));
    const full = await send('get_html', { strip: true, maxChars: 2_000_000 });
    const cut = await send('get_html', { strip: true, maxChars: 10 });
    assert.equal(cut.length, full.length);
    assert.equal(cut.truncated, true);
  });

  it('strip must be exactly true; truthy junk does not strip', async () => {
    const send = boot(page());
    for (const strip of ['yes', 1, 'true', {}]) assert.ok((await send('get_html', { strip })).html.includes('<script>'), String(strip));
  });

  it('still reports a missing element', async () => {
    const doc = page();
    let sandbox;
    const bg = loadBackground({ scripting: { executeScript: async ({ func, args }) => { bg.sandbox.document = { querySelector: () => null, documentElement: doc }; return [{ result: await func(...args) }]; } } });
    const r = (await bg.send('get_html', { selector: '#nope' })).result;
    assert.match(r.error, /Element not found/);
  });
});

describe('get_text', () => {
  it('no params: unchanged 50000 cap plus truncated/length', async () => {
    const send = boot(page(), { text: 'w'.repeat(60000) });
    const r = await send('get_text', {});
    assert.equal(r.text.length, 50000);
    assert.equal(r.truncated, true);
    assert.equal(r.length, 60000);
    assert.equal(r.title, 'T');
  });

  it('short text is not truncated', async () => {
    const send = boot(page(), { text: '  hi  ' });
    const r = await send('get_text', {});
    assert.equal(r.text, 'hi');
    assert.equal(r.truncated, false);
    assert.equal(r.length, 2);
  });

  it('maxChars raises, lowers and clamps', async () => {
    const send = boot(page(), { text: 'w'.repeat(2_100_000) });
    assert.equal((await send('get_text', { maxChars: 100 })).text.length, 100);
    assert.equal((await send('get_text', { maxChars: 120000 })).text.length, 120000);
    assert.equal((await send('get_text', { maxChars: 1e12 })).text.length, 2_000_000);
    assert.equal((await send('get_text', { maxChars: 'nope' })).text.length, 50000);
  });
});
