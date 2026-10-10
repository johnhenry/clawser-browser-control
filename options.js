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
})();
