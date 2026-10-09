// Run with: node --test test/background-webmcp-tabs.test.mjs
//
// webmcp_list_tools / webmcp_call_tool: read and call document.modelContext tools of
// other open tabs. The in-page functions are real; the stubbed chrome.scripting runs
// them against a fake `document` / `navigator` chosen per target tab.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './_load-background.mjs';

/**
 * Boot background.js with a set of fake tabs. chrome.scripting.executeScript runs the injected
 * function inside background.js's own vm context, so the fake page is installed as that
 * context's `document` / `navigator` for the duration of the call.
 */
function boot(tabs) {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  let sandbox;
  const chrome = {
    tabs: {
      query: async () => tabs.map(({ page, ...t }) => t),
      get: async (id) => {
        const t = byId.get(id);
        if (!t) throw new Error(`No tab with id: ${id}`);
        const { page, ...rest } = t;
        return rest;
      },
    },
    scripting: {
      executeScript: async ({ target, func, args }) => {
        const t = byId.get(target.tabId);
        if (t.restricted) throw new Error('Cannot access a chrome:// URL');
        sandbox.document = t.page?.document;
        sandbox.navigator = t.page?.navigator ?? {};
        return [{ result: await func(...(args || [])) }];
      },
    },
  };
  const bg = loadBackground(chrome);
  sandbox = bg.sandbox;
  // Results come out of another vm realm; round-trip them so deepEqual compares plain values.
  return { ...bg, send: async (...a) => JSON.parse(JSON.stringify(await bg.send(...a))) };
}

const tool = (name, extra = {}) => ({ name, title: '', description: `does ${name}`, inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, ...extra });

describe('webmcp_list_tools', () => {
  it('lists tools from every http(s) tab that exposes document.modelContext, skipping the rest', async () => {
    const { send } = boot([
      { id: 1, url: 'https://shop.test/cart', title: 'Cart', page: { document: { modelContext: { getTools: async () => [tool('add_to_cart'), tool('checkout')] } } } },
      { id: 2, url: 'https://plain.test/', title: 'Plain', page: { document: {} } },
      { id: 3, url: 'chrome://extensions', title: 'Ext' },
      { id: 4, url: 'https://blocked.test/', title: 'Blocked', restricted: true, page: {} },
    ]);
    const { result, error } = await send('webmcp_list_tools', {});
    assert.equal(error, undefined);
    assert.equal(result.pages.length, 1);
    assert.deepEqual(
      { tabId: result.pages[0].tabId, origin: result.pages[0].origin, api: result.pages[0].api },
      { tabId: 1, origin: 'https://shop.test', api: 'document.modelContext' },
    );
    assert.deepEqual(result.pages[0].tools.map((t) => t.name), ['add_to_cart', 'checkout']);
    assert.equal(result.skipped, 1, 'a page the extension cannot script is counted, not fatal');
  });

  it('parses JSON-string schemas (Chrome 149-153) and the older navigator.modelContextTesting API', async () => {
    const { send } = boot([
      { id: 1, url: 'https://a.test/', page: { document: { modelContext: { getTools: async () => [tool('t', { inputSchema: '{"type":"object","properties":{"n":{"type":"number"}}}' })] } } } },
      { id: 2, url: 'https://b.test/', page: { document: {}, navigator: { modelContextTesting: { listTools: () => [{ name: 'old', description: 'legacy', inputSchema: '{"type":"object"}' }] } } } },
    ]);
    const { result } = await send('webmcp_list_tools', {});
    const a = result.pages.find((p) => p.tabId === 1);
    const b = result.pages.find((p) => p.tabId === 2);
    assert.deepEqual(a.tools[0].inputSchema.properties, { n: { type: 'number' } });
    assert.equal(b.api, 'navigator.modelContextTesting');
    assert.equal(b.tools[0].name, 'old');
  });

  it('treats page-supplied metadata as untrusted: clamps sizes, drops readOnlyHint, keeps destructiveHint', async () => {
    const huge = 'x'.repeat(50000);
    const { send } = boot([
      { id: 1, url: 'https://evil.test/', page: { document: { modelContext: { getTools: async () => [
        tool('big', { description: huge, inputSchema: { type: 'object', properties: { p: { description: huge } } } }),
        tool('claims_safe', { annotations: { readOnlyHint: true, idempotentHint: true } }),
        tool('claims_danger', { annotations: { destructiveHint: true } }),
        { name: '' }, null, { description: 'nameless' },
      ] } } } },
    ]);
    const { result } = await send('webmcp_list_tools', { tabId: 1 });
    const [big, safe, danger, ...rest] = result.pages[0].tools;
    assert.equal(big.description.length, 2000);
    assert.equal(big.inputSchema['x-truncated'], true);
    assert.equal(safe.annotations, undefined, 'a page cannot mark its own tool read-only');
    assert.deepEqual(danger.annotations, { destructiveHint: true });
    assert.equal(rest.length, 0, 'malformed entries are dropped');
  });

  it('refuses to read a non-web tab by id', async () => {
    const { send } = boot([{ id: 3, url: 'chrome://extensions', page: {} }]);
    const { error } = await send('webmcp_list_tools', { tabId: 3 });
    assert.match(error, /only be read from http\(s\) pages/);
  });
});

describe('webmcp_call_tool', () => {
  const page = (exec) => ({ document: { modelContext: {
    getTools: async () => [tool('echo')],
    executeTool: exec,
  } } });

  it('calls the tool with JSON arguments (native executeTool(tool, jsonString)) and returns the text', async () => {
    let seen;
    const { send } = boot([
      { id: 1, url: 'https://app.test/x', page: page(async (t, json) => { seen = { name: t.name, json }; return JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }); }) },
    ]);
    const { result, error } = await send('webmcp_call_tool', { tabId: 1, name: 'echo', arguments: { q: 'hello' }, expectedOrigin: 'https://app.test' });
    assert.equal(error, undefined);
    assert.deepEqual(seen, { name: 'echo', json: '{"q":"hello"}' });
    assert.equal(JSON.parse(result.text).content[0].text, 'hi');
    assert.equal(result.origin, 'https://app.test');
  });

  it('falls back to the tool\'s own execute() and to navigator.modelContextTesting', async () => {
    const own = { id: 1, url: 'https://a.test/', page: { document: { modelContext: { getTools: async () => [{ name: 'echo', execute: async (a) => ({ got: a }) }] } } } };
    const testing = { id: 2, url: 'https://b.test/', page: { document: {}, navigator: { modelContextTesting: { executeTool: async (n, j) => `${n}:${j}` } } } };
    const { send } = boot([own, testing]);
    const r1 = await send('webmcp_call_tool', { tabId: 1, name: 'echo', arguments: { z: 1 }, expectedOrigin: 'https://a.test' });
    assert.equal(r1.result.text, '{"got":{"z":1}}');
    const r2 = await send('webmcp_call_tool', { tabId: 2, name: 'echo', arguments: {}, expectedOrigin: 'https://b.test' });
    assert.equal(r2.result.text, 'echo:{}');
  });

  it('refuses when the tab has navigated away from the origin the tool was listed on', async () => {
    let called = false;
    const { send } = boot([{ id: 1, url: 'https://other.test/', page: page(async () => { called = true; return '"x"'; }) }]);
    const { error } = await send('webmcp_call_tool', { tabId: 1, name: 'echo', arguments: {}, expectedOrigin: 'https://app.test' });
    assert.match(error, /now on https:\/\/other\.test, not https:\/\/app\.test/);
    assert.equal(called, false, 'the call must not reach the new page');
  });

  it('validates its inputs', async () => {
    const { send } = boot([{ id: 1, url: 'https://a.test/', page: page(async () => '1') }]);
    assert.match((await send('webmcp_call_tool', { name: 'echo', expectedOrigin: 'https://a.test' })).error, /tabId is required/);
    assert.match((await send('webmcp_call_tool', { tabId: 1, expectedOrigin: 'https://a.test' })).error, /name is required/);
    assert.match((await send('webmcp_call_tool', { tabId: 1, name: 'echo' })).error, /expectedOrigin is required/);
    assert.match((await send('webmcp_call_tool', { tabId: 1, name: 'echo', expectedOrigin: 'https://a.test', arguments: { a: 'x'.repeat(100001) } })).error, /too large/);
  });

  it('surfaces a page-side error, an unknown tool, and a missing API as errors', async () => {
    const { send } = boot([
      { id: 1, url: 'https://a.test/', page: page(async () => { throw new Error('boom'); }) },
      { id: 2, url: 'https://b.test/', page: { document: {} } },
    ]);
    assert.match((await send('webmcp_call_tool', { tabId: 1, name: 'echo', arguments: {}, expectedOrigin: 'https://a.test' })).error, /boom/);
    assert.match((await send('webmcp_call_tool', { tabId: 1, name: 'nope', arguments: {}, expectedOrigin: 'https://a.test' })).error, /No WebMCP tool named "nope"/);
    assert.match((await send('webmcp_call_tool', { tabId: 2, name: 'echo', arguments: {}, expectedOrigin: 'https://b.test' })).error, /exposes no WebMCP API/);
  });

  it('bounds the wait and the size of what a page can hand back', async () => {
    const { send } = boot([
      { id: 1, url: 'https://a.test/', page: page(() => new Promise(() => {})) },
      { id: 2, url: 'https://b.test/', page: page(async () => 'y'.repeat(150000)) },
    ]);
    const slow = await send('webmcp_call_tool', { tabId: 1, name: 'echo', arguments: {}, expectedOrigin: 'https://a.test', timeoutMs: 1000 });
    assert.match(slow.error, /timed out after 1000 ms/);
    const big = await send('webmcp_call_tool', { tabId: 2, name: 'echo', arguments: {}, expectedOrigin: 'https://b.test' });
    assert.equal(big.result.truncated, true);
    assert.equal(big.result.text.length, 100000);
  });

  it('audits which tool ran on which origin, never the arguments or the result', async () => {
    const { send } = boot([{ id: 1, url: 'https://app.test/secret/path?token=abc', page: page(async () => '"SECRET-RESULT"') }]);
    await send('webmcp_call_tool', { tabId: 1, name: 'echo', arguments: { password: 'hunter2' }, expectedOrigin: 'https://app.test' });
    await send('webmcp_call_tool', { tabId: 1, name: 'echo', arguments: {}, expectedOrigin: 'https://elsewhere.test' });
    const { result } = await send('audit_log', {});
    const mine = result.entries.filter((e) => e.action === 'webmcp_call_tool' && e.tool);
    assert.equal(mine.length, 2);
    assert.deepEqual(
      mine.map((e) => ({ url: e.url, tool: e.tool, success: e.success })),
      [{ url: 'https://app.test', tool: 'echo', success: true }, { url: 'https://app.test', tool: 'echo', success: false }],
    );
    const blob = JSON.stringify(result.entries);
    assert.ok(!blob.includes('hunter2') && !blob.includes('SECRET-RESULT') && !blob.includes('token=abc'));
  });
});

describe('capability advertisement', () => {
  it('announces webmcp_tabs so the Clawser app can feature-detect it', async () => {
    const { send } = loadBackground();
    const { result } = await send('get_available_capabilities', {});
    assert.ok(result.includes('webmcp_tabs'));
    const status = await send('status', {});
    assert.ok(status.result.capabilities.some((c) => c.name === 'webmcp_tabs' && c.available));
  });
});
