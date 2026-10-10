// sidepanel.js — the Clawser browser-tasks side panel.
//
// This page never runs a task. It (a) shows what Clawser reports about the
// user's tasks and inbox, fetched through the background worker from a
// connected Clawser tab, and (b) hands a draft to Clawser, which shows it for
// confirmation. When no Clawser tab is connected it says so; it never shows
// invented data. All dynamic text is set with textContent (no HTML parsing).
(() => {
  const UI = '__clawser_ext_ui__';
  const REFRESH_MS = 15000;
  const $ = (id) => document.getElementById(id);

  const PICKERS = {
    compare: {
      title: 'Compare tabs',
      legend: 'Open tabs (choose two or more)',
      hint: 'Choose the tabs to compare. Clawser will show a draft with these sources before anything is read.',
      min: 2,
      multiple: true,
    },
    extract: {
      title: 'Extract data',
      legend: 'Open tabs (choose one)',
      hint: 'Choose the tab that holds the table or list. Clawser will let you pick the exact section and fields.',
      min: 1,
      multiple: false,
    },
  };

  const STATUS_LABELS = {
    completed: 'Completed',
    completed_with_issues: 'Completed with issues',
    failed: 'Failed',
    cancelled: 'Cancelled',
    interrupted: 'Interrupted',
    running: 'Running',
    queued: 'Queued',
    waiting_approval: 'Waiting for approval',
    draft: 'Draft',
  };

  let mode = null;               // 'compare' | 'extract' | null (picker closed)
  let openTabs = [];             // http(s) tabs offered in the picker
  let selected = [];             // tab ids, in the order chosen
  let refreshSeq = 0;            // ignore out-of-date refresh replies
  let sending = false;

  function say(text) { $('status').textContent = text; }

  function make(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids) node.appendChild(kid);
    return node;
  }

  async function call(action, extra) {
    const resp = await chrome.runtime.sendMessage({ type: UI, action, ...extra });
    if (!resp) throw new Error('The extension did not respond');
    if (resp.error) throw new Error(resp.error);
    return resp.result;
  }

  // ── Task list, last run, inbox ─────────────────────────────────

  function when(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
  }

  function renderDisconnected() {
    $('tasks-state').textContent = 'Open clawser to see your tasks.';
    $('inbox-state').textContent = 'Open clawser to see your inbox.';
    $('last-run').textContent = 'Last run status is unavailable until clawser is open.';
    $('btn-open-clawser').hidden = false;
    $('task-list').replaceChildren();
    $('inbox-list').replaceChildren();
  }

  function renderTasks(res) {
    if (res.error) {
      $('tasks-state').textContent = `Clawser could not list your tasks: ${res.error}`;
      $('task-list').replaceChildren();
      $('last-run').textContent = 'Last run status is unavailable.';
      return;
    }
    const defs = res.definitions || [];
    $('tasks-state').textContent = defs.length ? `${defs.length} saved ${defs.length === 1 ? 'task' : 'tasks'}.` : 'No saved tasks yet.';
    const items = defs.map((d) => {
      const lr = d.lastRun;
      const runText = lr ? `Last run: ${STATUS_LABELS[lr.status] || lr.status}${lr.finishedAt ? `, ${when(lr.finishedAt)}` : ''}` : 'Never run';
      return make('li', { class: 'task' },
        make('span', { class: 'title', text: d.name || '(unnamed task)' }),
        make('span', { class: 'meta', text: `${d.kind} - ${runText}` }));
    });
    $('task-list').replaceChildren(...items);

    let latest = null;
    for (const d of defs) {
      const lr = d.lastRun;
      if (!lr) continue;
      const t = Date.parse(lr.finishedAt || '') || 0;
      if (!latest || t > latest.t) latest = { t, d, lr };
    }
    if (!latest) {
      $('last-run').textContent = defs.length ? 'No task has finished a run yet.' : 'No runs yet.';
    } else {
      const label = STATUS_LABELS[latest.lr.status] || latest.lr.status;
      $('last-run').textContent = `${latest.d.name || '(unnamed task)'}: ${label}${latest.lr.finishedAt ? `, ${when(latest.lr.finishedAt)}` : ''}.`;
    }
  }

  function renderInbox(res) {
    if (res.error) {
      $('inbox-state').textContent = `Clawser could not read your inbox: ${res.error}`;
      $('inbox-list').replaceChildren();
      return;
    }
    const notes = res.notifications || [];
    const unread = notes.filter((n) => !n.read).length;
    $('inbox-state').textContent = notes.length ? `${notes.length} ${notes.length === 1 ? 'message' : 'messages'}, ${unread} unread.` : 'Your inbox is empty.';
    $('inbox-list').replaceChildren(...notes.map((n) => make('li', { class: n.read ? 'note' : 'note unread' },
      make('span', { class: 'title', text: n.title || '(no title)' }),
      make('span', { class: 'meta', text: [n.body, when(n.at)].filter(Boolean).join(' - ') }))));
  }

  async function refresh() {
    const seq = ++refreshSeq;
    let list;
    let inbox;
    try {
      [list, inbox] = await Promise.all([call('btask_list'), call('btask_inbox')]);
    } catch (e) {
      if (seq !== refreshSeq) return;
      $('tasks-state').textContent = `Could not reach the extension: ${e.message}`;
      return;
    }
    if (seq !== refreshSeq) return; // a newer refresh superseded this one
    if (!list.connected && !inbox.connected) { renderDisconnected(); return; }
    $('btn-open-clawser').hidden = true;
    if (list.connected) renderTasks(list);
    else { $('tasks-state').textContent = 'Open clawser to see your tasks.'; $('task-list').replaceChildren(); }
    if (inbox.connected) renderInbox(inbox);
    else { $('inbox-state').textContent = 'Open clawser to see your inbox.'; $('inbox-list').replaceChildren(); }
  }

  // ── Tab picker ─────────────────────────────────────────────────

  function tabLabel(t) { return t.title || t.url; }

  function renderPicker() {
    const cfg = PICKERS[mode];
    const type = cfg.multiple ? 'checkbox' : 'radio';
    $('tab-options-empty').hidden = openTabs.length > 0;
    $('tab-options').replaceChildren(...openTabs.map((t) => {
      const id = `tab-opt-${t.id}`;
      const input = make('input', { type, id, name: 'tab', value: String(t.id) });
      input.checked = selected.includes(t.id);
      input.addEventListener('change', () => onToggle(t.id, input.checked));
      return make('li', {}, make('label', { class: 'tab-label', for: id },
        input, make('span', { class: 't', text: ` ${tabLabel(t)}` }), make('span', { class: 'u', text: t.url })));
    }));

    const chosen = selected.map((id) => openTabs.find((t) => t.id === id)).filter(Boolean);
    $('selected-count').textContent = chosen.length
      ? `${chosen.length} selected.${chosen.length < cfg.min ? ` Choose at least ${cfg.min}.` : ''}`
      : `None selected. Choose ${cfg.multiple ? `at least ${cfg.min}` : 'one'}.`;
    $('selected-list').replaceChildren(...chosen.map((t) => {
      const rm = make('button', { type: 'button', 'aria-label': `Remove ${tabLabel(t)} from the selection`, text: 'Remove' });
      rm.addEventListener('click', () => { onToggle(t.id, false); $('btn-send').focus(); });
      return make('li', {}, make('span', { text: `${tabLabel(t)} (${t.url}) ` }), rm);
    }));
    const ok = chosen.length >= cfg.min && !sending;
    if (ok) $('btn-send').removeAttribute('aria-disabled'); else $('btn-send').setAttribute('aria-disabled', 'true');
  }

  function onToggle(id, on) {
    const cfg = PICKERS[mode];
    if (!cfg.multiple) selected = on ? [id] : [];
    else if (on && !selected.includes(id)) selected = [...selected, id];
    else if (!on) selected = selected.filter((x) => x !== id);
    renderPicker();
  }

  async function openPicker(kind) {
    mode = kind;
    selected = [];
    const cfg = PICKERS[kind];
    $('picker-title').textContent = cfg.title;
    $('picker-legend').textContent = cfg.legend;
    $('picker-hint').textContent = cfg.hint;
    try {
      const tabs = await chrome.tabs.query({});
      openTabs = tabs.filter((t) => typeof t.url === 'string' && /^https?:\/\//i.test(t.url) && Number.isInteger(t.id));
      if (kind === 'extract') {
        const active = openTabs.find((t) => t.active && t.lastFocusedWindow) || openTabs.find((t) => t.active);
        if (active) selected = [active.id];
      }
    } catch (e) {
      openTabs = [];
      say(`Could not list tabs: ${e.message}`);
    }
    $('picker').hidden = false;
    renderPicker();
    $('picker-title').focus();
    say(`${cfg.title}: choose ${cfg.multiple ? 'two or more tabs' : 'a tab'}, then send the draft to clawser.`);
  }

  function closePicker(returnFocusTo) {
    mode = null;
    selected = [];
    $('picker').hidden = true;
    if (returnFocusTo) $(returnFocusTo).focus();
  }

  async function sendDraft() {
    if (!mode || sending) return;
    const cfg = PICKERS[mode];
    if (selected.length < cfg.min) {
      say(`Choose ${cfg.multiple ? `at least ${cfg.min} tabs` : 'a tab'} first.`);
      return;
    }
    sending = true;
    renderPicker();
    say('Sending the draft to clawser...');
    const kind = mode;
    try {
      const r = await call('btask_draft', { kind, sources: selected.map((tabId) => ({ kind: 'tab', tabId })) });
      if (r.ok) {
        say(r.opened ? 'Clawser was opened and has your draft. Confirm it there to run it.' : 'Clawser has your draft. Confirm it there to run it.');
        closePicker(kind === 'compare' ? 'btn-compare' : 'btn-extract');
      } else {
        say(`The draft was not delivered: ${r.error || 'unknown error'}`);
      }
    } catch (e) {
      say(`The draft was not delivered: ${e.message}`);
    } finally {
      sending = false;
      if (mode) renderPicker();
    }
  }

  // ── Wiring ─────────────────────────────────────────────────────

  $('btn-compare').addEventListener('click', () => openPicker('compare'));
  $('btn-extract').addEventListener('click', () => openPicker('extract'));
  for (const id of ['btn-watch', 'btn-workflow']) {
    $(id).addEventListener('click', () => say('Coming in a later release.'));
  }
  $('btn-send').addEventListener('click', () => {
    if ($('btn-send').getAttribute('aria-disabled') === 'true') {
      const cfg = PICKERS[mode];
      say(`Choose ${cfg.multiple ? `at least ${cfg.min} tabs` : 'a tab'} first.`);
      return;
    }
    sendDraft();
  });
  $('btn-cancel').addEventListener('click', () => { closePicker(mode === 'compare' ? 'btn-compare' : 'btn-extract'); say('Cancelled.'); });
  $('picker').addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); $('btn-cancel').click(); }
  });
  $('btn-refresh').addEventListener('click', () => { say('Refreshing...'); refresh().then(() => say('Updated.')); });
  $('btn-open-clawser').addEventListener('click', async () => {
    try {
      await call('btask_open');
      say('Opening clawser...');
      setTimeout(refresh, 2500);
    } catch (e) {
      say(`Could not open clawser: ${e.message}`);
    }
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  refresh();
})();
