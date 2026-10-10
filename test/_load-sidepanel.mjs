// test/_load-sidepanel.mjs — runs the real sidepanel.js against a tiny fake DOM.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

class FakeEl {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.doc = doc; this.attrs = {}; this.children = []; this.listeners = {};
    this._text = ''; this.hidden = false; this.checked = false; this.value = ''; this.id = '';
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'value') this.value = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { this.children.push(c); return c; }
  replaceChildren(...kids) { this.children = kids; this._text = ''; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  focus() { this.doc.focused = this; }
  click() { return this.fire('click'); }
  fire(type, ev = {}) { for (const fn of this.listeners[type] || []) fn({ preventDefault() {}, ...ev }); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  find(pred, out = []) { if (pred(this)) out.push(this); this.children.forEach((c) => c.find(pred, out)); return out; }
}

export function loadSidepanel({ tabs = [], respond, noHtml } = {}) {
  const doc = { focused: null, hidden: false, byId: new Map(), listeners: {} };
  doc.getElementById = (id) => { if (!doc.byId.has(id)) { const e = new FakeEl('div', doc); e.id = id; doc.byId.set(id, e); } return doc.byId.get(id); };
  doc.createElement = (tag) => new FakeEl(tag, doc);
  doc.addEventListener = (t, fn) => { (doc.listeners[t] ||= []).push(fn); };
  const sentMessages = [];
  const intervals = [];
  const sandbox = {
    document: doc,
    console,
    Date, Number, Object, Promise, Array, Math, JSON, String,
    setTimeout: () => 0,
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    chrome: {
      runtime: { sendMessage: async (m) => { sentMessages.push(m); return respond(m); } },
      tabs: { query: async () => tabs },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(root, 'sidepanel.js'), 'utf8'), sandbox, { filename: 'sidepanel.js' });
  const $ = (id) => doc.getElementById(id);
  const tick = () => new Promise((r) => setImmediate(r));
  return { doc, $, sentMessages, intervals, tick };
}
