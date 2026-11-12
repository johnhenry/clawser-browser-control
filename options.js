// options.js — extension options page. Validation and storage live in
// background.js (the single writer); this page only collects the value and
// shows the result as text.
(() => {
  const UI = '__clawser_ext_ui__';
  const $ = (id) => document.getElementById(id);

  function say(text) { $('status').textContent = text; }

  async function call(action, extra) {
    const resp = await chrome.runtime.sendMessage({ type: UI, action, ...extra });
    if (!resp) throw new Error('The extension did not respond');
    if (resp.error) throw new Error(resp.error);
    return resp.result;
  }

  async function load() {
    try {
      const r = await call('get_clawser_origin');
      $('origin').value = r.origin || '';
      say(r.origin ? `Custom origin in use: ${r.origin}` : `Using the default origins only (${r.defaultOrigin}).`);
    } catch (e) {
      say(`Could not read the current setting: ${e.message}`);
    }
  }

  async function save(value) {
    $('origin-error').textContent = '';
    try {
      const r = await call('set_clawser_origin', { origin: value });
      if (!r.ok) {
        $('origin-error').textContent = `Not saved: ${r.error}`;
        $('origin').setAttribute('aria-invalid', 'true');
        $('origin').focus();
        return;
      }
      $('origin').removeAttribute('aria-invalid');
      $('origin').value = r.origin || '';
      say(r.origin ? `Saved. Clawser will be recognised at ${r.origin}.` : 'Saved. Only the default origins are used.');
    } catch (e) {
      $('origin-error').textContent = `Not saved: ${e.message}`;
    }
  }

  $('origin-form').addEventListener('submit', (ev) => { ev.preventDefault(); save($('origin').value); });
  $('btn-reset').addEventListener('click', () => { $('origin').value = ''; save(''); });
  load();

  // ---- Pairing and capabilities (only a person, on this page, can change these) ----
  const CAP_LABELS = {
    evaluate: 'Run JavaScript in tabs',
    cookies: 'Read cookies',
    cors_fetch: 'Fetch URLs with my cookies',
    inject_pod: 'Inject a pod into tabs',
  };

  function el(tag, text, attrs) {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    return e;
  }

  async function renderPairing() {
    const paired = $('paired-list');
    const pending = $('pending-list');
    paired.replaceChildren();
    pending.replaceChildren();
    let o;
    try { o = await call('pairing_overview'); } catch (e) { say(`Could not read pairings: ${e.message}`); return; }
    if (o.origins.length === 0) paired.append(el('p', 'No pages are paired.'));
    for (const item of o.origins) {
      const box = el('fieldset');
      box.append(el('legend', item.origin + (item.builtin ? ' (built in)' : item.custom ? ' (custom origin)' : '')));
      for (const cap of o.capabilities) {
        const id = `cap-${item.origin}-${cap}`;
        const input = el('input', undefined, { type: 'checkbox', id });
        input.checked = item.caps[cap] === true;
        input.addEventListener('change', async () => {
          try { await call('pairing_set_capability', { origin: item.origin, capability: cap, enabled: input.checked }); say(`${CAP_LABELS[cap]}: ${input.checked ? 'on' : 'off'} for ${item.origin}`); }
          catch (e) { input.checked = !input.checked; say(`Not saved: ${e.message}`); }
        });
        const label = el('label', ` ${CAP_LABELS[cap]}`, { for: id });
        const row = el('div'); row.append(input, label);
        box.append(row);
      }
      if (!item.builtin && !item.custom) {
        const b = el('button', 'Unpair', { type: 'button' });
        b.addEventListener('click', async () => { await call('pairing_remove', { origin: item.origin }); say(`Unpaired ${item.origin}`); renderPairing(); });
        box.append(b);
      }
      paired.append(box);
    }
    if (o.pending.length === 0) pending.append(el('p', 'None.'));
    for (const origin of o.pending) {
      const row = el('div', undefined, { class: 'row' });
      row.append(el('code', origin));
      const b = el('button', 'Pair', { type: 'button' });
      b.addEventListener('click', async () => {
        const r = await call('pairing_add', { origin });
        say(r.ok ? `Paired ${r.origin}. Its risky capabilities are off.` : `Not paired: ${r.error}`);
        renderPairing();
      });
      row.append(b);
      pending.append(row);
    }
  }

  $('pair-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('pair-error').textContent = '';
    try {
      const r = await call('pairing_add', { origin: $('pair-origin').value });
      if (!r.ok) { $('pair-error').textContent = `Not paired: ${r.error}`; return; }
      $('pair-origin').value = '';
      say(`Paired ${r.origin}. Its risky capabilities are off.`);
      renderPairing();
    } catch (e) { $('pair-error').textContent = `Not paired: ${e.message}`; }
  });

  async function renderAudit() {
    try {
      const { entries } = await call('audit_get');
      $('audit-view').textContent = entries.map((e) => `${new Date(e.timestamp).toISOString()} ${e.success ? 'ok  ' : 'FAIL'} ${e.action} ${e.url || ''}${e.error ? ' - ' + e.error : ''}`).join('\n') || '(empty)';
    } catch (e) { $('audit-view').textContent = `Could not read the audit log: ${e.message}`; }
  }
  $('btn-audit-refresh').addEventListener('click', renderAudit);
  $('btn-audit-clear').addEventListener('click', async () => {
    try { const r = await call('audit_clear'); say(`Cleared ${r.cleared} audit entries.`); } catch (e) { say(`Not cleared: ${e.message}`); }
    renderAudit();
  });
  renderPairing();
  renderAudit();
})();
