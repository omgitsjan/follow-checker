/**
 * Loads the real popup scripts (i18n, analytics, platforms, fc-shared, popup)
 * against a permissive fake DOM and fake chrome.* APIs. Tabs are simulated:
 * `tabMessages` records what the popup sends to a content script and
 * `onTabMessage` lets a test answer.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { ROOT, FakeClock, createStorage, flush } from "./harness.mjs";

class FakeClassList {
  constructor(el) {
    this.el = el;
    this.set = new Set();
  }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : Boolean(force);
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
}

export class FakeElement {
  constructor(tag = "div", id = "") {
    this.tagName = String(tag).toUpperCase();
    this.id = id;
    this.children = [];
    this.parentNode = null;
    this.classList = new FakeClassList(this);
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this._text = "";
    this._html = "";
    this.disabled = false;
    this.title = "";
    this.value = "";
    this.checked = false;
  }
  get className() { return [...this.classList.set].join(" "); }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this._text = String(v ?? ""); this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v ?? ""); this._text = this._html.replace(/<[^>]+>/g, ""); this.children = []; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get hidden() { return this.classList.contains("hidden"); }
  appendChild(c) { if (c) { c.parentNode = this; this.children.push(c); } return c; }
  append(...cs) { cs.forEach((c) => (typeof c === "string" ? (this._text += c) : this.appendChild(c))); }
  prepend(...cs) { this.children.unshift(...cs.filter((c) => typeof c !== "string")); }
  insertBefore(c) { return this.appendChild(c); }
  replaceChildren(...cs) { this.children = []; this._text = ""; this.append(...cs); }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === "id") this.id = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }
  hasAttribute(k) { return k in this.attributes; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  dispatch(type, extra = {}) {
    const ev = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...extra };
    for (const fn of this.listeners[type] || []) fn(ev);
  }
  click() { this.dispatch("click"); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const match = (el) => {
      if (sel.startsWith(".")) return el.classList.contains(sel.slice(1));
      if (sel.startsWith("[data-")) return Object.keys(el.dataset).length > 0;
      return el.tagName === sel.toUpperCase();
    };
    const walk = (el) => el.children.forEach((c) => { if (match(c)) out.push(c); walk(c); });
    walk(this);
    return out;
  }
  closest() { return null; }
  contains(o) { return o === this || this.children.some((c) => c.contains(o)); }
  focus() {}
  blur() {}
  scrollIntoView() {}
  scrollTo() {}
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }
  cloneNode() { return new FakeElement(this.tagName); }
  getContext() {
    // no-op 2D context for chart drawing
    const noop = () => {};
    return new Proxy({}, { get: (_t, k) => (k === "measureText" ? () => ({ width: 0 }) : noop), set: () => true });
  }
}

export function createDocument() {
  const byId = new Map();
  const body = new FakeElement("body");
  const doc = {
    body,
    documentElement: new FakeElement("html"),
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, new FakeElement("div", id));
      return byId.get(id);
    },
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createTextNode: (text) => { const el = new FakeElement("#text"); el.textContent = text; return el; },
    createDocumentFragment: () => new FakeElement("#fragment"),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    byId,
  };
  return doc;
}

export async function loadPopup({ storageInitial = {}, storage, tabs = [{ id: 7, url: "https://www.instagram.com/" }], onTabMessage, clock } = {}) {
  clock ||= new FakeClock();
  storage ||= createStorage({ initial: storageInitial });
  const document = createDocument();
  const runtimeListeners = [];
  const tabMessages = [];
  const created = [];
  const chrome = {
    runtime: {
      id: "test-extension",
      onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
      sendMessage: async () => undefined,
      getURL: (p) => `chrome-extension://test/${p}`,
    },
    storage: { local: storage },
    tabs: {
      async query(q) {
        if (q.active) return tabs.slice(0, 1);
        return tabs.filter((t) => (q.url || []).some((pattern) => t.url.startsWith(pattern.replace("*", ""))));
      },
      async get(id) {
        const tab = tabs.find((t) => t.id === id);
        if (!tab) throw new Error("No tab with id");
        return tab;
      },
      async sendMessage(tabId, msg) {
        tabMessages.push({ tabId, msg: structuredClone(msg) });
        if (msg.type === "PING") return { ok: true, platform: "instagram" };
        if (onTabMessage) return onTabMessage(msg, tabId);
        if (msg.type === "GET_ME") return { ok: false };
        return { ok: false, error: "no handler" };
      },
      async create(opts) {
        created.push(opts);
        return { id: 99, ...opts };
      },
    },
    scripting: { executeScript: async () => [] },
  };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const win = { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  const ctx = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    chrome,
    document,
    window: win,
    navigator: { language: "en-US", languages: ["en-US"] },
    location: { href: "chrome-extension://test/popup.html" },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    requestAnimationFrame: (fn) => clock.setTimeout(fn, 16),
    Date: FakeDate,
    URL: Object.assign(function URLShim(u, b) { return new URL(u, b); }, { createObjectURL: () => "blob:x", revokeObjectURL() {} }),
    Blob: class {},
    Image: class { set src(_v) {} },
    structuredClone,
  };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  Object.assign(win, ctx, { window: win });
  vm.createContext(ctx);
  for (const file of ["i18n.js", "analytics.js", "platforms.js", "fc-shared.js", "popup.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), ctx, { filename: file });
  }
  await flush(40);
  const run = (expr) => vm.runInContext(expr, ctx);
  const deliver = async (msg) => {
    for (const fn of runtimeListeners) fn(structuredClone(msg), {}, () => {});
    await flush(40);
  };
  return { ctx, run, document, storage, chrome, clock, tabMessages, created, deliver, $: (id) => document.getElementById(id) };
}
