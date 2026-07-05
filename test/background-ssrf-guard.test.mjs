// Run with: node --test test/background-ssrf-guard.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackground } from './_load-background.mjs';

describe('cors_fetch SSRF guard', () => {
  it('blocks 127.0.0.1 and other loopback/localhost forms', async () => {
    const { send } = loadBackground();
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      const result = await send('cors_fetch', { url: `http://${host}/admin` });
      assert.ok(result.error, `expected ${host} to be blocked`);
      assert.match(result.error, /private|reserved/i);
    }
  });

  it('blocks RFC1918 private ranges', async () => {
    const { send } = loadBackground();
    for (const host of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1']) {
      const result = await send('cors_fetch', { url: `http://${host}/` });
      assert.ok(result.error, `expected ${host} to be blocked`);
    }
  });

  it('does not block a 172.x address outside the RFC1918 range (172.32.x)', async () => {
    const fetchImpl = async () => ({
      redirected: false,
      status: 200,
      headers: { forEach: () => {} },
      text: async () => 'ok',
    });
    const { send } = loadBackground({}, { fetchImpl });
    // 172.32.x is outside 172.16-172.31, so the SSRF regex should NOT
    // block it — it should reach the (stubbed) fetch and succeed.
    const result = await send('cors_fetch', { url: 'http://172.32.0.1/' });
    assert.equal(result.error, undefined);
    assert.equal(result.result.status, 200);
  });

  it('blocks decimal-encoded IP addresses', async () => {
    const { send } = loadBackground();
    const result = await send('cors_fetch', { url: 'http://2130706433/' }); // 127.0.0.1 as a decimal
    assert.ok(result.error);
    assert.match(result.error, /private|reserved/i);
  });

  it('blocks file: URLs', async () => {
    const { send } = loadBackground();
    const result = await send('cors_fetch', { url: 'file:///etc/passwd' });
    assert.ok(result.error);
  });

  it('rejects invalid URLs with a clear error', async () => {
    const { send } = loadBackground();
    const result = await send('cors_fetch', { url: 'not a url' });
    assert.ok(result.error);
    assert.match(result.error, /Invalid URL/);
  });

  it('requires a url', async () => {
    const { send } = loadBackground();
    const result = await send('cors_fetch', {});
    assert.ok(result.error);
    assert.match(result.error, /url is required/);
  });
});
