// test/_fake-dom.mjs — a tiny DOM, just enough for the in-page functions of background.js
// (which run in a vm sandbox with no real DOM). Elements behave like the browser where it
// matters for these tests: a click toggles a checkbox / selects a radio.

export function el(tag, attrs = {}, children = [], text = '') {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    attrs: { ...attrs },
    children,
    parentElement: null,
    _text: text,
    events: [],
    checked: attrs.checked !== undefined && attrs.checked !== false,
    disabled: attrs.disabled !== undefined && attrs.disabled !== false,
    value: attrs.value ?? '',
    get id() { return this.attrs.id || ''; },
    get type() { return (this.attrs.type || (this.tagName === 'INPUT' ? 'text' : '')).toLowerCase(); },
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
    getAttribute(n) { return n in this.attrs ? String(this.attrs[n]) : null; },
    hasAttribute(n) { return n in this.attrs; },
    contains(other) { for (let n = other; n; n = n.parentElement) if (n === this) return true; return false; },
    dispatchEvent(ev) {
      this.events.push(ev.type);
      if (ev.type === 'click') {
        if (this.tagName === 'INPUT' && this.type === 'checkbox' && !this.disabled) this.checked = !this.checked;
        if (this.tagName === 'INPUT' && this.type === 'radio' && !this.disabled) {
          const root = this.root();
          for (const o of walk(root)) if (o.tagName === 'INPUT' && o.type === 'radio' && o.attrs.name === this.attrs.name) o.checked = false;
          this.checked = true;
        }
      }
      return true;
    },
    root() { let n = this; while (n.parentElement) n = n.parentElement; return n; },
  };
  for (const c of children) c.parentElement = node;
  return node;
}

export function* walk(n) {
  for (const c of n.children) { yield c; yield* walk(c); }
}

/** A document whose body is `body`. */
export function makeDocument(body) {
  const html = el('html', {}, [el('head'), body]);
  return {
    documentElement: html,
    body,
    title: 'Fixture',
    querySelector: (sel) => {
      if (sel.startsWith('#')) return [...walk(html)].find((e) => e.id === sel.slice(1)) || null;
      return null;
    },
    elementFromPoint: () => null,
  };
}
