// F2: Instagram page bridge + cookie lookup state (content.js).
import test from "node:test";
import assert from "node:assert/strict";
import {
  loadExtension,
  loadBridge,
  createWindow,
  FakeClock,
  jsonResponse,
  later,
  spyPostMessage,
  flush,
} from "./helpers/harness.mjs";

const IG_FILES = ["fc-shared.js", "content.js"];
const URL_A = "https://www.instagram.com/api/v1/test/a/";

function setup({ bridge = true, bridgeFetch, directFetch, cookie = "csrftoken=tok123", cookieReply } = {}) {
  const clock = new FakeClock();
  const win = createWindow();
  const pings = spyPostMessage(win);
  let bridgeCtx = null;
  if (bridge) {
    bridgeCtx = loadBridge(win, { clock, fetch: bridgeFetch || (async () => jsonResponse({ status: "ok", via: "bridge" })) });
  }
  const ext = loadExtension(IG_FILES, {
    clock,
    window: win,
    cookie,
    cookieReply,
    fetch: directFetch || (async () => jsonResponse({ status: "ok", via: "direct" })),
  });
  return { ...ext, clock, win, pings, bridgeCtx };
}

test("slow first bridged request is not treated as a missing bridge and is not re-sent directly", async () => {
  const env = setup({ bridgeFetch: (url) => later(env.clock, 3000, jsonResponse({ status: "ok", via: "bridge" })) });
  const p = env.run(`igFetch(${JSON.stringify(URL_A)})`);
  await env.clock.advance(3500);
  const data = await p;
  assert.equal(data.via, "bridge");
  assert.equal(env.bridgeCtx.calls.length, 1);
  assert.equal(env.fetchCalls.length, 0, "no duplicate direct request");
  // second request still goes through the bridge
  const p2 = env.run(`igFetch(${JSON.stringify(URL_A)})`);
  await env.clock.advance(3500);
  assert.equal((await p2).via, "bridge");
  assert.equal(env.fetchCalls.length, 0);
});

test("missing bridge falls back to direct fetch, but is re-probed after the TTL (not sticky)", async () => {
  const clock = new FakeClock();
  const win = createWindow();
  const ext = loadExtension(IG_FILES, {
    clock,
    window: win,
    cookie: "csrftoken=tok",
    fetch: async () => jsonResponse({ status: "ok", via: "direct" }),
  });
  const p = ext.run(`igFetch(${JSON.stringify(URL_A)})`);
  await clock.advance(2000);
  assert.equal((await p).via, "direct");

  // The bridge shows up later (e.g. slow document_start / re-injected by the popup).
  const bridge = loadBridge(win, { clock, fetch: async () => jsonResponse({ status: "ok", via: "bridge" }) });

  // Within the TTL: no re-probe, still direct.
  const p2 = ext.run(`igFetch(${JSON.stringify(URL_A)})`);
  await clock.advance(2000);
  assert.equal((await p2).via, "direct");

  await clock.advance(60_000);
  const p3 = ext.run(`igFetch(${JSON.stringify(URL_A)})`);
  await clock.advance(2000);
  assert.equal((await p3).via, "bridge");
  assert.equal(bridge.calls.length, 1);
});

test("concurrent requests share one presence probe; no ping spam while missing", async () => {
  const env = setup({ bridge: false });
  const all = Promise.all([
    env.run(`igFetch(${JSON.stringify(URL_A)})`),
    env.run(`igFetch(${JSON.stringify(URL_A)})`),
    env.run(`igFetch(${JSON.stringify(URL_A)})`),
  ]);
  await env.clock.advance(2000);
  await all;
  assert.equal(env.pings.FC_PING, 1, "exactly one probe for three parallel requests");
  for (let i = 0; i < 5; i++) {
    const p = env.run(`igFetch(${JSON.stringify(URL_A)})`);
    await env.clock.advance(1000);
    await p;
  }
  assert.equal(env.pings.FC_PING, 1, "no further probes inside the TTL");
  assert.equal(env.pings.FC_FETCH || 0, 0, "no bridged fetch attempts while missing");
});

test("a bridged POST that times out is not replayed via direct fetch", async () => {
  const env = setup({ bridgeFetch: () => new Promise(() => {}) });
  const p = env.run(
    `igFetch("https://www.instagram.com/api/v1/friendships/destroy/1/", { method: "POST", body: "" })`
  );
  let error = null;
  p.catch((e) => (error = e));
  await env.clock.advance(25_000);
  assert.ok(error, "request rejected");
  assert.match(String(error.message), /timed out/i);
  assert.equal(env.fetchCalls.length, 0, "POST must not be duplicated through the direct path");
});

test("a bridged GET that times out may fall back once and the bridge is re-probed next time", async () => {
  let hang = true;
  const env = setup({
    bridgeFetch: () => (hang ? new Promise(() => {}) : Promise.resolve(jsonResponse({ status: "ok", via: "bridge" }))),
  });
  const p = env.run(`igFetch(${JSON.stringify(URL_A)})`);
  await env.clock.advance(25_000);
  assert.equal((await p).via, "direct");
  assert.equal(env.fetchCalls.length, 1);
  hang = false;
  const pingsBefore = env.pings.FC_PING || 0;
  const p2 = env.run(`igFetch(${JSON.stringify(URL_A)})`);
  await env.clock.advance(2000);
  assert.equal((await p2).via, "bridge");
  assert.equal(env.pings.FC_PING, pingsBefore + 1, "state was reset to unknown, one fresh probe");
});

test("late bridge answers after a timeout are ignored and leave no listeners behind", async () => {
  const env = setup({ bridgeFetch: (url) => later(env.clock, 40_000, jsonResponse({ status: "ok", via: "late" })) });
  const baseline = env.win.listenerCount();
  const p = env.run(`igFetch(${JSON.stringify(URL_A)})`);
  await env.clock.advance(25_000);
  assert.equal((await p).via, "direct");
  await env.clock.advance(20_000); // late answer arrives now
  await flush();
  assert.equal(env.win.listenerCount(), baseline);
});

test("failed cookie lookup is retried after backoff instead of being sticky", async () => {
  let calls = 0;
  const env = setup({
    bridge: false,
    cookie: "",
    cookieReply: () => {
      calls += 1;
      if (calls === 1) throw new Error("Could not establish connection. Receiving end does not exist.");
      return { ok: true, dsUserId: "12345", csrftoken: "fromBackground" };
    },
  });
  const p1 = env.run(`igFetch(${JSON.stringify(URL_A)})`);
  await env.clock.advance(2000);
  await p1;
  assert.equal(calls, 1);

  // immediately again: still inside backoff → no new lookup (no spam)
  const p2 = env.run(`igFetch(${JSON.stringify(URL_A)})`);
  await env.clock.advance(1000);
  await p2;
  assert.equal(calls, 1);

  await env.clock.advance(30_000);
  const p3 = env.run(`igFetch(${JSON.stringify(URL_A)})`);
  await env.clock.advance(2000);
  await p3;
  assert.equal(calls, 2, "lookup retried after backoff");
  assert.equal(env.run("igCsrfToken"), "fromBackground");
});

test("parallel requests wait for one shared cookie lookup and all carry the token", async () => {
  const seen = [];
  let calls = 0;
  const env = setup({
    bridge: false,
    cookie: "",
    cookieReply: async () => {
      calls += 1;
      await later(env.clock, 100);
      return { ok: true, dsUserId: "12345", csrftoken: "shared" };
    },
    directFetch: async (url, init) => {
      seen.push(init.headers["x-csrftoken"]);
      return jsonResponse({ status: "ok" });
    },
  });
  const all = Promise.all([env.run(`igFetch(${JSON.stringify(URL_A)})`), env.run(`igFetch(${JSON.stringify(URL_A)})`)]);
  await env.clock.advance(3000);
  await all;
  assert.equal(calls, 1);
  assert.deepEqual(seen, ["shared", "shared"]);
});
