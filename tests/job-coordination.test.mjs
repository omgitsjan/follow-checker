// F1 follow-up: extension-wide job lease (claim / heartbeat / finish) coordinated
// by the background service worker. Two content-script instances (two tabs)
// run in separate contexts against one shared storage + one service worker.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  loadExtension,
  createWindow,
  createStorage,
  createBus,
  FakeClock,
  jsonResponse,
  advanceUntil,
  flush,
} from "./helpers/harness.mjs";
import { igRouter, igUser } from "./helpers/ig-fixtures.mjs";

const LISTS = { following: [igUser(1), igUser(2)], followers: [igUser(2), igUser(3)] };

/**
 * Hold every storage.get() until `parties` reads are waiting at the same time
 * (both callers then see the same snapshot), or release a lone reader after a
 * few event-loop turns so a serialized caller is not deadlocked.
 */
function gateReads(storage, parties = 2) {
  const realGet = storage.get.bind(storage);
  let waiting = [];
  const stats = { maxConcurrent: 0 };
  const release = () => {
    const batch = waiting;
    waiting = [];
    batch.forEach((fn) => fn());
  };
  storage.get = (keys) =>
    new Promise((resolve, reject) => {
      // snapshot taken now, delivered later: a real read/write race window
      const snapshot = realGet(keys);
      waiting.push(() => snapshot.then(resolve, reject));
      stats.maxConcurrent = Math.max(stats.maxConcurrent, waiting.length);
      if (waiting.length >= parties) release();
      else {
        let turns = 0;
        const tick = () => (++turns > 30 || !waiting.length ? release() : setImmediate(tick));
        setImmediate(tick);
      }
    });
  return stats;
}

function world({ storageInitial = {} } = {}) {
  const clock = new FakeClock();
  const storage = createStorage({ initial: storageInitial });
  const bus = createBus({ storage, clock });
  const tab = (tabId, { files = ["fc-shared.js", "content.js"], url, overrides, document } = {}) =>
    loadExtension(files, {
      clock,
      storage,
      bus,
      tabId,
      url,
      document,
      window: createWindow(),
      cookie: "csrftoken=tok; ds_user_id=12345",
      fetch: igRouter({ lists: LISTS, overrides }),
    });
  return { clock, storage, bus, tab };
}

const resultsOf = (env) => env.chrome.runtime.sent.filter((m) => m.type === "RESULT");

test("two tabs starting at the same moment (same empty snapshot) get exactly one job", async () => {
  const w = world();
  const stats = gateReads(w.storage);
  const a = w.tab(1);
  const b = w.tab(2);
  const [ra, rb] = await Promise.all([a.chrome.dispatch({ type: "ANALYZE" }), b.chrome.dispatch({ type: "ANALYZE" })]);
  const started = [ra, rb].filter((r) => r?.started);
  const busy = [ra, rb].filter((r) => r?.busy);
  assert.equal(started.length, 1, `exactly one start, got ${JSON.stringify([ra, rb])}`);
  assert.equal(busy.length, 1);
  assert.equal(busy[0].job.id, started[0].jobId, "the loser is told which job owns the lease");
  await advanceUntil(w.clock, () => resultsOf(a).length + resultsOf(b).length >= 1, { step: 500, max: 4000 });
  const loser = ra.started ? b : a;
  assert.equal(loser.fetchCalls.length, 0, "the refused tab never touches Instagram");
  assert.ok(stats.maxConcurrent >= 1);
});

test("analysis in one tab and FETCH_OWN_POSTS in another tab are exclusive for the platform", async () => {
  const w = world();
  const slow = (url) => (url.includes("/followers/") ? new Promise(() => {}) : undefined);
  const a = w.tab(1, { overrides: slow });
  const b = w.tab(2);
  assert.equal((await a.chrome.dispatch({ type: "ANALYZE" })).started, true);
  const posts = await b.chrome.dispatch({ type: "FETCH_OWN_POSTS" });
  assert.equal(posts.ok, false);
  assert.equal(posts.busy, true);
  assert.equal(b.fetchCalls.length, 0);
});

test("platform isolation: an Instagram job does not block GitHub", async () => {
  const w = world();
  const a = w.tab(1, { overrides: (url) => (url.includes("/followers/") ? new Promise(() => {}) : undefined) });
  assert.equal((await a.chrome.dispatch({ type: "ANALYZE" })).started, true);
  const gh = loadExtension(["fc-shared.js", "github.js"], {
    clock: w.clock,
    storage: w.storage,
    bus: w.bus,
    tabId: 3,
    url: "https://github.com/octo",
    window: createWindow(),
    document: { cookie: "", querySelectorAll: () => [], querySelector: (s) => (s === 'meta[name="user-login"]' ? { content: "octo" } : null) },
    fetch: async (url) =>
      url.endsWith("/users/octo") ? jsonResponse({ id: 1, login: "octo", followers: 1, following: 1 }) : jsonResponse([{ id: 7, login: "pal" }]),
  });
  assert.equal((await gh.chrome.dispatch({ type: "ANALYZE" })).started, true);
  await advanceUntil(w.clock, () => resultsOf(gh).length > 0, { step: 500, max: 200 });
  assert.equal(resultsOf(gh)[0].ok, true);
  assert.equal(w.storage.data["fcJob:instagram"].status, "running");
});

test("service worker restart mid-job: lease survives, competitor refused, owner finishes normally", async () => {
  const w = world();
  let releaseFollowers;
  const hold = new Promise((r) => (releaseFollowers = r));
  const a = w.tab(1, {
    overrides: (url) => (url.includes("/followers/") ? hold.then(() => jsonResponse({ users: [igUser(2)], next_max_id: null })) : undefined),
  });
  const ra = await a.chrome.dispatch({ type: "ANALYZE" });
  await w.clock.advance(5000);
  w.bus.restart(); // MV3 suspend: in-memory state of the worker is gone
  const b = w.tab(2);
  const rb = await b.chrome.dispatch({ type: "ANALYZE" });
  assert.equal(rb.busy, true);
  assert.equal(rb.job.id, ra.jobId);
  await w.clock.advance(30_000); // heartbeats now go to the new worker instance
  assert.equal(w.storage.data["fcJob:instagram"].id, ra.jobId);
  assert.equal(w.storage.data["fcJob:instagram"].status, "running");
  releaseFollowers();
  await advanceUntil(w.clock, () => resultsOf(a).length > 0, { step: 500, max: 4000 });
  assert.equal(resultsOf(a)[0].ok, true);
  assert.equal(w.storage.data["fcResult:instagram"].jobId, ra.jobId);
  assert.equal(w.storage.data["fcJob:instagram"].status, "succeeded");
});

test("crashed tab: lease expires without heartbeats and a new job can start", async () => {
  const w = world();
  const a = w.tab(1, { overrides: (url) => (url.includes("/followers/") ? new Promise(() => {}) : undefined) });
  await a.chrome.dispatch({ type: "ANALYZE" });
  w.bus.dropped.add(1); // tab gone: no more heartbeats arrive
  await w.clock.advance(3 * 60_000);
  const b = w.tab(2);
  assert.equal((await b.chrome.dispatch({ type: "ANALYZE" })).started, true);
});

test("stale-owner fence: late heartbeat/result/failure of an expired job never overwrite the new job", async () => {
  const w = world();
  let releaseA;
  const holdA = new Promise((r) => (releaseA = r));
  const a = w.tab(1, {
    overrides: (url) => (url.includes("/followers/") ? holdA.then(() => jsonResponse({ users: [igUser(9)], next_max_id: null })) : undefined),
  });
  const ra = await a.chrome.dispatch({ type: "ANALYZE" });
  w.bus.dropped.add(1); // tab A frozen (e.g. throttled background tab)
  await w.clock.advance(3 * 60_000);

  const b = w.tab(2);
  const rb = await b.chrome.dispatch({ type: "ANALYZE" });
  assert.equal(rb.started, true);
  await advanceUntil(w.clock, () => resultsOf(b).length > 0, { step: 500, max: 4000 });
  const resultB = structuredClone(w.storage.data["fcResult:instagram"]);
  assert.equal(resultB.jobId, rb.jobId);

  // A wakes up: its heartbeat and its result arrive late.
  w.bus.dropped.delete(1);
  await w.clock.advance(20_000);
  releaseA();
  await advanceUntil(w.clock, () => a.run("fcJobs.current()") === null, { step: 500, max: 4000 });
  await flush();
  assert.deepEqual(w.storage.data["fcResult:instagram"], resultB, "B's result untouched");
  assert.equal(w.storage.data["fcJob:instagram"].id, rb.jobId);
  assert.equal(w.storage.data["fcJob:instagram"].status, "succeeded");
  assert.equal(w.storage.data["fcError:instagram"], undefined, "fenced job's failure is not recorded either");
  assert.equal(resultsOf(a).filter((m) => m.jobId === ra.jobId).length, 0, "fenced job does not broadcast a result");
});

test("job store unavailable: start fails closed, no Instagram request is made", async () => {
  const w = world();
  w.storage.failures.get = "storage unavailable";
  const a = w.tab(1);
  const res = await a.chrome.dispatch({ type: "ANALYZE" });
  assert.equal(res.ok, false);
  assert.notEqual(res.started, true);
  await w.clock.advance(10_000);
  assert.equal(a.fetchCalls.length, 0);
});

test("service worker unreachable: start fails closed", async () => {
  const w = world();
  const a = w.tab(1);
  w.bus.dropped.add(1);
  const res = await a.chrome.dispatch({ type: "ANALYZE" });
  assert.equal(res.ok, false);
  await w.clock.advance(10_000);
  assert.equal(a.fetchCalls.length, 0);
});

test("result-store write failure on finish: result still delivered, lease kept (fail closed) until it expires", async () => {
  const w = world();
  const a = w.tab(1);
  const ra = await a.chrome.dispatch({ type: "ANALYZE" });
  assert.equal(ra.started, true);
  w.storage.failures.set = "QUOTA_BYTES quota exceeded";
  await advanceUntil(w.clock, () => resultsOf(a).length > 0, { step: 500, max: 4000 });
  assert.equal(resultsOf(a)[0].ok, true, "data already loaded is not thrown away");
  w.storage.failures.set = null;
  const again = await a.chrome.dispatch({ type: "ANALYZE" });
  assert.equal(again.busy, true, "no second, uncoordinated run while the lease is unresolved");
  await w.clock.advance(3 * 60_000);
  assert.equal((await a.chrome.dispatch({ type: "ANALYZE" })).started, true);
});

test("persisted errors are short and contain no URLs or token-like values", async () => {
  const w = world();
  const secret = "https://www.instagram.com/api/v1/x/?access_token=IGQVJ" + "x".repeat(40);
  const a = w.tab(1, {
    overrides: (url) =>
      url.includes("/following/")
        ? jsonResponse({ message: `bad ${secret} csrftoken=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789` }, 500)
        : undefined,
  });
  await a.chrome.dispatch({ type: "ANALYZE" });
  await advanceUntil(w.clock, () => resultsOf(a).length > 0, { step: 500, max: 4000 });
  const stored = JSON.stringify([w.storage.data["fcError:instagram"], w.storage.data["fcJob:instagram"]]);
  assert.doesNotMatch(stored, /https?:\/\//);
  assert.doesNotMatch(stored, /access_token|IGQVJ|AbCdEfGhIjKlMnOpQrStUvWxYz/);
  assert.match(w.storage.data["fcError:instagram"].error, /HTTP 500/);
  assert.ok(w.storage.data["fcError:instagram"].error.length <= 200);
  assert.deepEqual(Object.keys(w.storage.data["fcError:instagram"]).sort(), ["at", "error", "jobId", "kind"]);
});

test("job messages from a tab of another site are rejected (platform bound to sender)", async () => {
  const w = world();
  const res = await w.bus.send(
    { type: "FC_JOB", op: "claim", platform: "instagram", kind: "analyze", jobId: "x", owner: "o" },
    { id: "test-extension", tab: { id: 5, url: "https://github.com/" }, url: "https://github.com/" }
  );
  assert.equal(res?.ok, false);
  assert.equal(w.storage.data["fcJob:instagram"], undefined);
});

test("worker lease expiry and popup/content staleness use the same window", () => {
  const w = world();
  const a = w.tab(1);
  assert.equal(vm.runInContext("JOB_STALE_MS", w.bus.background.ctx), a.run("fcJobs.STALE_MS"));
});
