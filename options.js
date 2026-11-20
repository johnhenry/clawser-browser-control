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

  // ---- Browser permission for a site ----
  // The browser only shows its permission prompt for a call made while handling the person's click, so these run first in the
  // click handler (before any await). The background then records the grant only if the browser really holds the permission.
  // KEEP IN SYNC with normalizeSiteOrigin() in background.js (a test runs the same table through both).
  /** `<origin>/*` for a clean http(s) origin, or null (the background then explains what is wrong). */
  function hostPattern(input) {
    if (typeof input !== 'string') return null;
    const raw = input.trim();
    if (!raw || raw.length > 200 || /[\s*<>"'\\^`{|}?#]/.test(raw)) return null;
    let u;
    try { u = new URL(raw); } catch { return null; }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.pathname !== '/') return null;
    return `${u.origin}/*`;
  }
  const perms = () => chrome.permissions;
  /** Ask the browser for one origin. Resolves true only if the person approved its prompt. */
  async function askBrowser(pattern) {
    try { return (await perms().request({ origins: [pattern] })) === true; } catch { return false; }
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
      const pattern = hostPattern(value);
      if (pattern && !(await askBrowser(pattern))) {
        $('origin-error').textContent = 'Not saved: the browser did not give the extension access to that origin.';
        return;
      }
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

  $('origin-form').addEventListener('submit', (ev) => { ev.preventDefault(); const v = $('origin').value; save(v); });
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

  const CLASS_HELP = {
    read: 'read: see the page (text, structure, form values with passwords, payment and one-time-code fields blanked), find, wait, watch, list its WebMCP tools',
    interact: 'interact: open, navigate, click, type, fill, scroll, and call the WebMCP tools the page registered',
    sensitive: 'sensitive: screenshots and GIFs, console and network monitoring, cookies, cors_fetch, evaluate',
  };

  async function renderSites() {
    const list = $('sites-list');
    list.replaceChildren();
    let o;
    try { o = await call('sites_overview'); } catch (e) { say(`Could not read granted sites: ${e.message}`); return; }
    const cap = $('capture-state');
    cap.textContent = o.capture ? 'On: the browser has given the extension access to all sites so it can capture pixels. The extension still captures only granted sites that allow sensitive tools.' : 'Off: screenshots and GIF recording are refused.';
    $('btn-capture-on').hidden = o.capture === true;
    $('btn-capture-off').hidden = o.capture !== true;
    const banner = $('migration-note');
    if (o.migration) {
      banner.hidden = false;
      banner.textContent = `Updated from ${o.migration.from}. Version 0.6 no longer asks the browser for access to every site. ${o.migration.needing.length} granted site${o.migration.needing.length === 1 ? ' needs' : 's need'} your approval again (marked below): until you approve one, the extension refuses it.`;
    } else {
      banner.hidden = true;
      banner.textContent = '';
    }
    if (o.sites.length === 0) list.append(el('p', 'No sites are granted. Pages cannot act on any tab.'));
    for (const site of o.sites) {
      const row = el('div', undefined, { class: 'row' });
      row.append(el('code', site.origin));
      if (!site.permitted) {
        row.append(el('strong', ' needs approval in the browser '));
        const a = el('button', 'Approve', { type: 'button', 'aria-label': `Approve browser access to ${site.origin}` });
        a.addEventListener('click', async () => {
          const ok = await askBrowser(hostPattern(site.origin));
          say(ok ? `${site.origin}: approved.` : `${site.origin}: the browser did not give access.`);
          renderSites();
        });
        row.append(a);
      }
      for (const cls of o.classes) {
        const label = el('label', undefined, { title: CLASS_HELP[cls] });
        const box = el('input', undefined, { type: 'checkbox', 'aria-label': `${site.origin}: allow ${cls} tools` });
        box.checked = site.classes.includes(cls);
        box.addEventListener('change', async () => {
          const next = o.classes.filter((c) => (c === cls ? box.checked : site.classes.includes(c)));
          const r = await call('sites_set_classes', { origin: site.origin, classes: next });
          say(r.ok ? `${site.origin}: ${next.join(', ') || 'read'} tools` : r.error);
          renderSites();
        });
        label.append(box, ` ${cls} `);
        row.append(label);
      }
      const b = el('button', 'Revoke', { type: 'button', 'aria-label': `Revoke ${site.origin}` });
      b.addEventListener('click', async () => { await call('sites_remove', { origin: site.origin }); say(`Revoked ${site.origin}`); renderSites(); });
      row.append(b);
      list.append(row);
    }
  }

  $('site-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('site-error').textContent = '';
    const typed = $('site-origin').value;
    const pattern = hostPattern(typed);
    // First, and before any await: the browser's prompt needs this click.
    const asked = pattern ? askBrowser(pattern) : Promise.resolve(true);
    try {
      if (!(await asked)) { $('site-error').textContent = 'Not granted: the browser did not give the extension access to that site.'; return; }
      const classes = ['read', 'interact', 'sensitive'].filter((c) => $(`site-class-${c}`).checked);
      const r = await call('sites_add', { origin: typed, classes });
      if (!r.ok) {
        if (pattern) { try { await perms().remove({ origins: [pattern] }); } catch { /* ignore */ } }
        $('site-error').textContent = `Not granted: ${r.error}`;
        return;
      }
      $('site-origin').value = '';
      say(`Granted ${r.origin}.`);
      renderSites();
    } catch (e) { $('site-error').textContent = `Not granted: ${e.message}`; }
  });

  // The browser's screenshot API works only with access to all sites, so pixels are a separate switch (first line of the click handler: the prompt needs it).
  $('btn-capture-on').addEventListener('click', async () => {
    const ok = await askBrowser('<all_urls>');
    say(ok ? 'Screenshots and GIFs are on.' : 'The browser did not give access to all sites. Screenshots and GIFs stay off.');
    renderSites();
  });
  $('btn-capture-off').addEventListener('click', async () => {
    try { await perms().remove({ origins: ['<all_urls>'] }); } catch { /* not held */ }
    say('Screenshots and GIFs are off.');
    renderSites();
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
  renderSites();
  renderAudit();
})();
