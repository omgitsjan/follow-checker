/**
 * Minimal, dependency-free harness that loads the real extension scripts into
 * a vm context with fake browser/extension APIs. Nothing here talks to the
 * network: every fetch is answered by the test, every timer runs on a fake clock.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const realImmediate = (fn) => setImmediate(fn);

/** Let pending promise chains and queued message deliveries run. */
export async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => realImmediate(r));
}

export class FakeClock {
  constructor(start = 1_800_000_000_000) {
    this.now = start;
    this.timers = new Map();
    this.nextId = 1;
  }
  setTimeout = (fn, ms = 0, ...args) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + Math.max(0, Number(ms) || 0), fn, args, every: null });
    return id;
  };
  setInterval = (fn, ms = 0, ...args) => {
    const id = this.nextId++;
    const every = Math.max(1, Number(ms) || 0);
    this.timers.set(id, { at: this.now + every, fn, args, every });
    return id;
  };
  clearTimeout = (id) => {
    this.timers.delete(id);
  };
  clearInterval = (id) => {
    this.timers.delete(id);
  };
  pending() {
    return this.timers.size;
  }
  /** Advance time, firing due timers in order and flushing microtasks between them. */
  async advance(ms) {
    const target = this.now + ms;
    await flush();
    for (;;) {
      let nextId = null;
      let next = null;
      for (const [id, t] of this.timers) {
        if (t.at <= target && (!next || t.at < next.at)) {
          next = t;
          nextId = id;
        }
      }
      if (!next) break;
      this.now = next.at;
      if (next.every) next.at += next.every;
      else this.timers.delete(nextId);
      next.fn(...next.args);
      await flush();
    }
    this.now = target;
    await flush();
  }
}

export function createStorage({ initial = {} } = {}) {
  const data = { ...structuredClone(initial) };
  const failures = { get: null, set: null, remove: null };
  const writes = [];
  const area = {
    data,
    failures,
    writes,
    async get(keys) {
      if (failures.get) throw new Error(failures.get);
      const out = {};
      const list = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(items) {
      if (failures.set) throw new Error(failures.set);
      writes.push(Object.keys(items));
      for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v);
    },
    async remove(keys) {
      if (failures.remove) throw new Error(failures.remove);
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
  };
  return area;
}

/** Deliver one runtime message to a set of onMessage listeners, honouring async sendResponse. */
function deliverTo(listeners, msg, sender) {
  return new Promise((resolve) => {
    let answered = false;
    const sendResponse = (res) => {
      if (answered) return;
      answered = true;
      resolve(res === undefined ? undefined : structuredClone(res));
    };
    let keepOpen = false;
    for (const fn of listeners) {
      if (fn(structuredClone(msg), sender, sendResponse) === true) keepOpen = true;
      if (answered) return;
    }
    if (!keepOpen) resolve(undefined);
  });
}

/**
 * The real background.js (MV3 service worker) in its own context. Only one
 * instance is "alive" at a time; restart() drops it (in-memory state lost, as
 * on SW suspend) and starts a fresh one on the same storage.
 */
export function createBus({ storage, clock }) {
  const bus = { dropped: new Set(), background: null, instances: 0 };
  const boot = () => {
    const listeners = [];
    const chrome = {
      runtime: {
        id: "test-extension",
        getURL: (p) => `chrome-extension://test-extension/${p}`,
        onMessage: { addListener: (fn) => listeners.push(fn) },
      },
      storage: { local: storage },
      cookies: { get: async () => null },
    };
    class FakeDate extends Date {
      constructor(...args) {
        super(...(args.length ? args : [clock.now]));
      }
      static now() {
        return clock.now;
      }
    }
    const ctx = {
      chrome,
      console: { log() {}, warn() {}, error() {} },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      Date: FakeDate,
      structuredClone,
    };
    ctx.globalThis = ctx;
    ctx.self = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), ctx, { filename: "background.js" });
    bus.instances += 1;
    bus.background = { ctx, deliver: (msg, sender) => deliverTo(listeners, msg, sender) };
  };
  boot();
  bus.restart = boot;
  /** Message from an extension context to the service worker. */
  bus.send = async (msg, sender) => {
    if (sender.tab && bus.dropped.has(sender.tab.id)) {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    }
    return bus.background.deliver(msg, sender);
  };
  return bus;
}

export function createChrome({ storage = createStorage(), cookieReply, bus, sender } = {}) {
  const listeners = [];
  const sent = [];
  const chrome = {
    runtime: {
      id: "test-extension",
      sent,
      onMessage: {
        addListener(fn) {
          listeners.push(fn);
        },
      },
      async sendMessage(msg) {
        sent.push(structuredClone(msg));
        if (msg?.type === "FC_IG_COOKIES" && cookieReply !== undefined) {
          if (typeof cookieReply === "function") return cookieReply(msg);
          return cookieReply;
        }
        if (bus && typeof msg?.type === "string" && msg.type.startsWith("FC_")) {
          return bus.send(msg, sender);
        }
        return undefined;
      },
    },
    storage: { local: storage },
  };
  /** Deliver a message to the content-script listeners like chrome.tabs.sendMessage would. */
  chrome.dispatch = (msg) =>
    new Promise((resolve) => {
      let answered = false;
      const sendResponse = (res) => {
        if (answered) return;
        answered = true;
        resolve(res);
      };
      for (const fn of listeners) {
        const keepOpen = fn(structuredClone(msg), { id: chrome.runtime.id }, sendResponse);
        if (answered) return;
        if (keepOpen === true) return;
      }
      if (!answered) resolve(undefined);
    });
  chrome.listeners = listeners;
  return chrome;
}

/** window with same-origin postMessage delivered asynchronously (like a task). */
export function createWindow() {
  const listeners = new Set();
  const win = {
    addEventListener(type, fn) {
      if (type === "message") listeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === "message") listeners.delete(fn);
    },
    postMessage(data) {
      const copy = structuredClone(data);
      realImmediate(() => {
        for (const fn of [...listeners]) fn({ source: win, data: copy });
      });
    },
    listenerCount: () => listeners.size,
  };
  return win;
}

export function jsonResponse(body, status = 200, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

/**
 * Build a context and load the given repo files into it, in order.
 * `fetch` must be supplied by the test (default: throw, so no request escapes).
 */
export function loadExtension(files, opts = {}) {
  const clock = opts.clock || new FakeClock();
  const storage = opts.storage || createStorage({ initial: opts.storageInitial });
  const bus = opts.bus || createBus({ storage, clock });
  const pageUrl = opts.url || "https://www.instagram.com/";
  const tabId = opts.tabId ?? 1;
  const sender = { id: "test-extension", tab: { id: tabId, url: pageUrl }, frameId: 0, url: pageUrl };
  const chrome = opts.chrome || createChrome({ storage, cookieReply: opts.cookieReply, bus, sender });
  const win = opts.window || createWindow();
  const fetchCalls = [];
  const fetchImpl =
    opts.fetch ||
    (async (url) => {
      throw new Error(`unexpected fetch in test: ${url}`);
    });
  const fetch = (url, init = {}) => {
    fetchCalls.push({ url: String(url), method: init.method || "GET" });
    return fetchImpl(String(url), init);
  };
  class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [clock.now]));
    }
    static now() {
      return clock.now;
    }
  }
  const document = opts.document || {
    cookie: opts.cookie || "",
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const ctx = {
    console: opts.console || { log() {}, warn() {}, error() {} },
    chrome,
    window: win,
    document,
    location: { origin: new URL(pageUrl).origin, href: pageUrl, pathname: new URL(pageUrl).pathname },
    fetch,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    Date: FakeDate,
    URL,
    URLSearchParams,
    AbortController,
    structuredClone,
    localStorage: { length: 0, key: () => null, getItem: () => null },
    ...(opts.globals || {}),
  };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  // Make window share globals the way the page world does for postMessage listeners.
  for (const file of files) {
    const code = fs.readFileSync(path.join(ROOT, file), "utf8");
    vm.runInContext(code, ctx, { filename: file });
  }
  const run = (expr) => vm.runInContext(expr, ctx);
  return { ctx, clock, storage, chrome, bus, tabId, window: win, fetchCalls, run };
}

/** Load ig-bridge.js in its own context (MAIN world) sharing the page window. */
export function loadBridge(win, { clock, fetch }) {
  const calls = [];
  const ctx = {
    window: win,
    location: { origin: "https://www.instagram.com", href: "https://www.instagram.com/" },
    fetch: (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || "GET", headers: init.headers || {} });
      return fetch(String(url), init);
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    console: { log() {}, warn() {}, error() {} },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "ig-bridge.js"), "utf8"), ctx, { filename: "ig-bridge.js" });
  return { calls };
}

/** Resolve after `ms` of fake time. */
export function later(clock, ms, value) {
  return new Promise((resolve) => clock.setTimeout(() => resolve(value), ms));
}

/** Advance the clock in steps until predicate() is true (or give up). */
export async function advanceUntil(clock, predicate, { step = 1000, max = 2000 } = {}) {
  for (let i = 0; i < max; i++) {
    if (predicate()) return true;
    await clock.advance(step);
  }
  return predicate();
}

/** Count postMessage calls by message type. */
export function spyPostMessage(win) {
  const counts = {};
  const orig = win.postMessage.bind(win);
  win.postMessage = (data, origin) => {
    const key = data?.type || "?";
    counts[key] = (counts[key] || 0) + 1;
    return orig(data, origin);
  };
  return counts;
}
