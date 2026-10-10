// Run with: node --test test/sidepanel.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadSidepanel } from './_load-sidepanel.mjs';

const TABS = [
  { id: 1, url: 'https://a.example.com/x', title: 'Alpha', active: true, lastFocusedWindow: true },
  { id: 2, url: 'https://b.example.com/y', title: 'Beta' },
  { id: 3, url: 'chrome://extensions', title: 'Extensions' },
  { id: 4, url: 'https://c.example.com/', title: '' },
];
const disconnected = (m) => ({ result: { connected: false } });
const connected = (m) => {
  if (m.action === 'btask_list') return { result: { connected: true, definitions: [
    { id: 'd1', kind: 'compare', name: 'Prices', updatedAt: '2026-10-01T00:00:00Z', lastRun: { id: 'r1', status: 'completed_with_issues', finishedAt: '2026-10-09T10:00:00Z' } },
    { id: 'd2', kind: 'extract', name: 'Jobs', updatedAt: '2026-10-02T00:00:00Z', lastRun: { id: 'r2', status: 'failed', finishedAt: '2026-10-10T10:00:00Z' } },
    { id: 'd3', kind: 'extract', name: 'New', updatedAt: 'x', lastRun: null },
  ] } };
  if (m.action === 'btask_inbox') return { result: { connected: true, notifications: [{ id: 'n1', kind: 'run_finished', at: '2026-10-10T10:00:00Z', title: 'Jobs failed', body: 'Source unreadable', read: false }] } };
  return { result: { ok: true } };
};

describe('side panel: tasks, inbox, last run', () => {
  it('says "Open clawser to see your tasks" when no clawser tab is connected, with no invented data', async () => {
    const p = loadSidepanel({ tabs: TABS, respond: disconnected });
    await p.tick(); await p.tick();
    assert.match(p.$('tasks-state').textContent, /Open clawser to see your tasks/);
    assert.match(p.$('inbox-state').textContent, /Open clawser/);
    assert.equal(p.$('task-list').children.length, 0);
    assert.equal(p.$('inbox-list').children.length, 0);
    assert.equal(p.$('btn-open-clawser').hidden, false);
    assert.match(p.$('last-run').textContent, /unavailable/i);
  });

  it('renders exactly what clawser returned, as text', async () => {
    const p = loadSidepanel({ tabs: TABS, respond: connected });
    await p.tick(); await p.tick();
    const tasks = p.$('task-list').children;
    assert.equal(tasks.length, 3);
    assert.match(tasks[0].textContent, /Prices/);
    assert.match(tasks[0].textContent, /Completed with issues/);
    assert.match(tasks[2].textContent, /Never run/);
    assert.match(p.$('inbox-list').children[0].textContent, /Jobs failed/);
    assert.match(p.$('inbox-state').textContent, /1 unread/);
    assert.equal(p.$('btn-open-clawser').hidden, true);
  });

  it('last-run shows the most recently finished run, in words', async () => {
    const p = loadSidepanel({ tabs: TABS, respond: connected });
    await p.tick(); await p.tick();
    assert.match(p.$('last-run').textContent, /Jobs: Failed/);
  });

  it('shows an empty state, not fake rows, when clawser has no tasks', async () => {
    const p = loadSidepanel({ tabs: TABS, respond: (m) => (m.action === 'btask_list' ? { result: { connected: true, definitions: [] } } : { result: { connected: true, notifications: [] } }) });
    await p.tick(); await p.tick();
    assert.match(p.$('tasks-state').textContent, /No saved tasks/);
    assert.match(p.$('inbox-state').textContent, /empty/);
  });

  it('shows clawser-side errors as text', async () => {
    const p = loadSidepanel({ tabs: TABS, respond: () => ({ result: { connected: true, error: 'workspace locked' } }) });
    await p.tick(); await p.tick();
    assert.match(p.$('tasks-state').textContent, /workspace locked/);
  });

  it('an extension failure is reported as text', async () => {
    const p = loadSidepanel({ tabs: TABS, respond: () => ({ error: 'boom' }) });
    await p.tick(); await p.tick();
    assert.match(p.$('tasks-state').textContent, /boom/);
  });

  it('a slow, older refresh cannot overwrite a newer one', async () => {
    let n = 0; const gates = [];
    const p = loadSidepanel({ tabs: TABS, respond: (m) => {
      if (m.action !== 'btask_list') return connected(m);
      const my = ++n;
      return new Promise((res) => gates.push(() => res(my === 1 ? disconnected(m) : connected(m))));
    } });
    await p.tick();
    p.$('btn-refresh').click();
    await p.tick();
    gates[1]();           // newer reply first
    await p.tick(); await p.tick();
    gates[0]();           // stale reply arrives late
    await p.tick(); await p.tick();
    assert.equal(p.$('task-list').children.length, 3);
  });

  it('refreshes periodically', () => {
    const p = loadSidepanel({ tabs: TABS, respond: disconnected });
    assert.ok(p.intervals.length >= 1);
  });
});

describe('side panel: entry actions', () => {
  it('Watch page and Create workflow only report that they are not available yet', async () => {
    const p = loadSidepanel({ tabs: TABS, respond: connected });
    await p.tick(); await p.tick();
    p.sentMessages.length = 0;
    p.$('btn-watch').click();
    assert.match(p.$('status').textContent, /later release/i);
    p.$('btn-workflow').click();
    assert.match(p.$('status').textContent, /later release/i);
    assert.equal(p.sentMessages.length, 0);
  });

  it('Compare lists only http(s) tabs with title and URL, and needs two selections', async () => {
    const p = loadSidepanel({ tabs: TABS, respond: connected });
    await p.tick(); await p.tick();
    p.$('btn-compare').click(); await p.tick();
    assert.equal(p.$('picker').hidden, false);
    const rows = p.$('tab-options').children;
    assert.equal(rows.length, 3);
    assert.match(rows[0].textContent, /Alpha/);
    assert.match(rows[0].textContent, /https:\/\/a\.example\.com\/x/);
    assert.match(rows[2].textContent, /https:\/\/c\.example\.com\//); // untitled tab falls back to its URL
    assert.equal(p.$('btn-send').getAttribute('aria-disabled'), 'true');
    assert.match(p.$('selected-count').textContent, /None selected/);
    assert.equal(p.doc.focused, p.$('picker-title'));
  });

  it('shows the explicit list of selected tabs and sends exactly those tab ids', async () => {
    const p = loadSidepanel({ tabs: TABS, respond: connected });
    await p.tick(); await p.tick();
    p.$('btn-compare').click(); await p.tick();
    const inputs = p.$('tab-options').find((e) => e.attrs.type === 'checkbox');
    inputs[0].checked = true; inputs[0].fire('change');
    assert.equal(p.$('btn-send').getAttribute('aria-disabled'), 'true');
    inputs[1].checked = true; inputs[1].fire('change');
    assert.equal(p.$('btn-send').getAttribute('aria-disabled'), null);
    assert.equal(p.$('selected-list').children.length, 2);
    assert.match(p.$('selected-list').children[1].textContent, /Beta/);
    p.sentMessages.length = 0;
    p.$('btn-send').click(); await p.tick(); await p.tick();
    const draft = p.sentMessages.find((m) => m.action === 'btask_draft');
    assert.equal(draft.kind, 'compare');
    assert.deepEqual(JSON.parse(JSON.stringify(draft.sources)), [{ kind: 'tab', tabId: 1 }, { kind: 'tab', tabId: 2 }]);
    assert.match(p.$('status').textContent, /Clawser has your draft/);
    assert.equal(p.$('picker').hidden, true);
  });

  it('a selected tab can be removed, and the button follows', async () => {
    const p = loadSidepanel({ tabs: TABS, respond: connected });
    await p.tick(); await p.tick();
    p.$('btn-compare').click(); await p.tick();
    const inputs = p.$('tab-options').find((e) => e.attrs.type === 'checkbox');
    for (const i of [0, 1]) { inputs[i].checked = true; inputs[i].fire('change'); }
    p.$('selected-list').children[0].find((e) => e.tagName === 'BUTTON')[0].click();
    assert.equal(p.$('selected-list').children.length, 1);
    assert.equal(p.$('btn-send').getAttribute('aria-disabled'), 'true');
  });

  it('does not send while fewer than two tabs are selected', async () => {
    const p = loadSidepanel({ tabs: TABS, respond: connected });
    await p.tick(); await p.tick();
    p.$('btn-compare').click(); await p.tick();
    p.sentMessages.length = 0;
    p.$('btn-send').click(); await p.tick();
    assert.equal(p.sentMessages.filter((m) => m.action === 'btask_draft').length, 0);
    assert.match(p.$('status').textContent, /at least 2/);
  });

  it('Extract preselects the active tab, single choice only', async () => {
    const p = loadSidepanel({ tabs: TABS, respond: connected });
    await p.tick(); await p.tick();
    p.$('btn-extract').click(); await p.tick();
    const radios = p.$('tab-options').find((e) => e.attrs.type === 'radio');
    assert.equal(radios.length, 3);
    assert.equal(radios[0].checked, true);
    radios[1].checked = true; radios[1].fire('change');
    assert.equal(p.$('selected-list').children.length, 1);
    p.sentMessages.length = 0;
    p.$('btn-send').click(); await p.tick(); await p.tick();
    const draft = p.sentMessages.find((m) => m.action === 'btask_draft');
    assert.equal(draft.kind, 'extract');
    assert.deepEqual(JSON.parse(JSON.stringify(draft.sources)), [{ kind: 'tab', tabId: 2 }]);
  });

  it('reports a failed delivery as text and keeps the picker open', async () => {
    const p = loadSidepanel({ tabs: TABS, respond: (m) => (m.action === 'btask_draft' ? { result: { ok: false, error: 'Clawser did not respond.' } } : connected(m)) });
    await p.tick(); await p.tick();
    p.$('btn-extract').click(); await p.tick();
    p.$('btn-send').click(); await p.tick(); await p.tick();
    assert.match(p.$('status').textContent, /not delivered: Clawser did not respond/);
    assert.equal(p.$('picker').hidden, false);
  });

  it('Cancel and Escape close the picker and return focus to the action', async () => {
    const p = loadSidepanel({ tabs: TABS, respond: connected });
    await p.tick(); await p.tick();
    p.$('btn-compare').click(); await p.tick();
    p.$('picker').fire('keydown', { key: 'Escape' });
    assert.equal(p.$('picker').hidden, true);
    assert.equal(p.doc.focused, p.$('btn-compare'));
  });

  it('never sends the same draft twice while one is in flight', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    const p = loadSidepanel({ tabs: TABS, respond: async (m) => { if (m.action === 'btask_draft') { await gate; return { result: { ok: true } }; } return connected(m); } });
    await p.tick(); await p.tick();
    p.$('btn-extract').click(); await p.tick();
    p.sentMessages.length = 0;
    p.$('btn-send').click(); p.$('btn-send').click(); p.$('btn-send').click();
    await p.tick();
    release(); await p.tick(); await p.tick();
    assert.equal(p.sentMessages.filter((m) => m.action === 'btask_draft').length, 1);
  });
});

describe('side panel: markup agreement', () => {
  it('every element id the script uses exists in sidepanel.html', () => {
    const js = readFileSync(new URL('../sidepanel.js', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../sidepanel.html', import.meta.url), 'utf8');
    const used = new Set([...js.matchAll(/\$\('([a-z-]+)'\)/g)].map((m) => m[1]));
    used.delete('tab-opt');
    for (const id of used) assert.match(html, new RegExp(`id="${id}"`), id);
  });
});
