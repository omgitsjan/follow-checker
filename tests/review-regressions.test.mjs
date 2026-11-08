// Regressions from the independent review of c47d188 (I1, M1–M4, M6).
import test from "node:test";
import assert from "node:assert/strict";
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
import { loadPopup } from "./helpers/popup-harness.mjs";

const T0 = 1_800_000_000_000;
const LISTS = { following: [igUser(1), igUser(2)], followers: [igUser(2), igUser(3)] };
const hang = () => new Promise(() => {});

function world() {
  const clock = new FakeClock(T0);
  const storage = createStorage();
  const bus = createBus({ storage, clock });
  const tab = (tabId, opts = {}) =>
    loadExtension(opts.files || ["fc-shared.js", "content.js"], {
      clock,
      storage,
      bus,
      tabId,
      url: opts.url,
      document: opts.document,
      window: createWindow(),
      cookie: opts.cookie ?? "csrftoken=tok; ds_user_id=12345",
      cookieReply: opts.cookieReply,
      fetch: opts.fetch || igRouter({ lists: LISTS, overrides: opts.overrides }),
    });
  return { clock, storage, bus, tab };
}
const resultsOf = (env) => env.chrome.runtime.sent.filter((m) => m.type === "RESULT");

/* ---------- I1: a hung request must not hold the lease forever ---------- */

test("I1/R5: a followers request that never answers ends the job and frees the lease (1h)", async () => {
  const w = world();
  const a = w.tab(1, { overrides: (url) => (url.includes("/followers/") ? hang() : undefined) });
  const ra = await a.chrome.dispatch({ type: "ANALYZE" });
  assert.equal(ra.started, true);
  await w.clock.advance(60 * 60_000);
  const job = w.storage.data["fcJob:instagram"];
  assert.notEqual(job.status === "running" && w.clock.now - job.heartbeatAt < 120000, true, "lease not kept alive");
  const res = resultsOf(a).find((m) => m.jobId === ra.jobId);
  assert.ok(res, "the hung job reports an end");
  assert.equal(res.ok, false);
  assert.match(res.error, /timed out/i);
  const b = w.tab(2);
  assert.equal((await b.chrome.dispatch({ type: "ANALYZE" })).started, true, "another tab can start");
});

test("I1: a hung response body (headers came, body never ends) is bounded too", async () => {
  const w = world();
  const a = w.tab(1, {
    overrides: (url) =>
      url.includes("/followers/") ? { status: 200, ok: true, headers: { get: () => null }, text: hang, json: hang } : undefined,
  });
  const ra = await a.chrome.dispatch({ type: "ANALYZE" });
  await w.clock.advance(5 * 60_000);
  const res = resultsOf(a).find((m) => m.jobId === ra.jobId);
  assert.ok(res && res.ok === false && /timed out/i.test(res.error));
});

test("I1: the heartbeat only renews the lease while the work makes progress (watchdog)", async () => {
  const w = world();
  const a = w.tab(1);
  // Work that hangs outside any request (e.g. an unanswered extension message).
  const claim = await a.run(`fcJobs.runAnalysis("instagram", () => new Promise(() => {}))`);
  assert.equal(claim.started, true);
  await w.clock.advance(10 * 60_000);
  const job = w.storage.data["fcJob:instagram"];
  assert.ok(w.clock.now - job.heartbeatAt >= 120000, "no self-renewing heartbeat");
  const b = w.tab(2);
  assert.equal((await b.chrome.dispatch({ type: "ANALYZE" })).started, true);
});

test("I1: a timed-out POST is not replayed and a 429 is not retried", async () => {
  const calls = [];
  const w = world();
  const a = w.tab(1, {
    fetch: async (url, init) => {
      calls.push(`${init.method || "GET"} ${url}`);
      if ((init.method || "GET") === "POST") return hang();
      return jsonResponse({ message: "wait" }, 429);
    },
  });
  const post = a.run(`igFetch("https://www.instagram.com/api/v1/friendships/destroy/1/", { method: "POST", body: "" })`);
  let postErr = null;
  post.catch((e) => (postErr = e));
  const get = a.run(`igFetch("https://www.instagram.com/api/v1/x/")`);
  let getErr = null;
  get.catch((e) => (getErr = e));
  await w.clock.advance(2 * 60_000);
  assert.match(String(postErr?.message), /timed out/i);
  assert.match(String(getErr?.message), /429/);
  assert.equal(calls.filter((c) => c.startsWith("POST")).length, 1);
  assert.equal(calls.filter((c) => c.startsWith("GET")).length, 1);
});

test("I1: GitHub and Bluesky requests are bounded as well", async () => {
  const w = world();
  const gh = w.tab(3, {
    files: ["fc-shared.js", "github.js"],
    url: "https://github.com/octo",
    document: { cookie: "", querySelectorAll: () => [], querySelector: (s) => (s === 'meta[name="user-login"]' ? { content: "octo" } : null) },
    fetch: async (url) => (url.endsWith("/users/octo") ? jsonResponse({ id: 1, login: "octo", followers: 1, following: 1 }) : hang()),
  });
  await gh.chrome.dispatch({ type: "ANALYZE" });
  await w.clock.advance(5 * 60_000);
  const r = resultsOf(gh)[0];
  assert.ok(r && r.ok === false && /timed out/i.test(r.error));
  assert.notEqual(w.storage.data["fcJob:github"].status, "running");
});

/* ---------- M4: storage error on finish must not hide the real error ---------- */

test("M4: when finish cannot be stored, the popup still gets the original failure reason", async () => {
  const w = world();
  const a = w.tab(1, { overrides: (url) => (url.includes("/following/") ? jsonResponse({ message: "boom" }, 500) : undefined) });
  await a.chrome.dispatch({ type: "ANALYZE" });
  await w.clock.advance(1000);
  w.storage.failures.set = "QUOTA_BYTES quota exceeded";
  await advanceUntil(w.clock, () => resultsOf(a).length > 0, { step: 500, max: 400 });
  assert.match(resultsOf(a)[0].error, /HTTP 500/);
});

/* ---------- M3: exact page-cap boundaries ---------- */

function ghWorld(followers, { link }) {
  const w = world();
  let followerPages = 0;
  const gh = w.tab(3, {
    files: ["fc-shared.js", "github.js"],
    url: "https://github.com/octo",
    document: { cookie: "", querySelectorAll: () => [], querySelector: (s) => (s === 'meta[name="user-login"]' ? { content: "octo" } : null) },
    fetch: async (url) => {
      if (url.endsWith("/users/octo")) return jsonResponse({ id: 1, login: "octo", followers, following: 1 });
      const m = url.match(/\/(followers|following)\?per_page=100&page=(\d+)/);
      if (m[1] === "following") return jsonResponse([{ id: 5, login: "x" }]);
      followerPages += 1;
      const page = Number(m[2]);
      const start = (page - 1) * 100;
      const n = Math.max(0, Math.min(100, followers - start));
      const batch = Array.from({ length: n }, (_, i) => ({ id: 100000 + start + i, login: `u${start + i}` }));
      const headers = {};
      if (link) headers.link = start + n < followers ? `<https://api.github.com/x?page=${page + 1}>; rel="next"` : `<https://api.github.com/x?page=1>; rel="first"`;
      return jsonResponse(batch, 200, headers);
    },
  });
  return { w, gh, pages: () => followerPages };
}

async function ghResult(env) {
  await env.gh.chrome.dispatch({ type: "ANALYZE" });
  await advanceUntil(env.w.clock, () => resultsOf(env.gh).length > 0, { step: 1000, max: 3000 });
  return resultsOf(env.gh)[0];
}

test("M3/R4: GitHub exactly 10000 followers with Link headers completes without an extra request", async () => {
  const env = ghWorld(10000, { link: true });
  const r = await ghResult(env);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.counts.followers, 10000);
  assert.equal(env.pages(), 100);
});

test("M3: GitHub exactly 10000 followers without Link header: one probe page, then complete", async () => {
  const env = ghWorld(10000, { link: false });
  const r = await ghResult(env);
  assert.equal(r.ok, true, r.error);
  assert.equal(env.pages(), 101);
});

test("M3: GitHub 10001 followers is incomplete; the last good result is kept", async () => {
  const env = ghWorld(10001, { link: true });
  const good = { type: "RESULT", ok: true, platform: "github", jobId: "old", counts: {}, following: [], followers: [], mutual: [], notFollowingBack: [], notFollowedByMe: [], finishedAt: 1 };
  env.w.storage.data["fcResult:github"] = structuredClone(good);
  const r = await ghResult(env);
  assert.equal(r.ok, false);
  assert.match(r.error, /incomplete/i);
  assert.equal(env.pages(), 100, "Link already proves more data: no probe");
  assert.deepEqual(env.w.storage.data["fcResult:github"], good);
});

function bskyWorld(probe) {
  const w = world();
  let pages = 0;
  const bs = w.tab(4, {
    files: ["fc-shared.js", "bluesky.js"],
    url: "https://bsky.app/",
    document: { cookie: "", querySelectorAll: () => [], querySelector: (s) => (s.includes("Profile") ? { getAttribute: () => "/profile/me.bsky.social" } : null) },
    fetch: async (url) => {
      if (url.includes("getProfile")) return jsonResponse({ did: "did:plc:me", handle: "me.bsky.social", followersCount: 1, followsCount: 20000 });
      if (url.includes("getFollowers")) return jsonResponse({ followers: [{ did: "did:plc:f", handle: "f.bsky.social" }] });
      pages += 1;
      if (pages > 200) return jsonResponse(probe);
      const follows = Array.from({ length: 100 }, (_, i) => ({ did: `did:plc:u${pages}-${i}`, handle: `u${pages}-${i}.bsky.social` }));
      return jsonResponse({ follows, cursor: `c${pages}` });
    },
  });
  return { w, bs, pages: () => pages };
}

async function bsResult(env) {
  await env.bs.chrome.dispatch({ type: "ANALYZE" });
  await advanceUntil(env.w.clock, () => resultsOf(env.bs).length > 0, { step: 1000, max: 3000 });
  return resultsOf(env.bs)[0];
}

test("M3: Bluesky 200 full pages with a trailing cursor but nothing more: one probe, complete", async () => {
  const env = bskyWorld({ follows: [] });
  const r = await bsResult(env);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.counts.following, 20000);
  assert.equal(env.pages(), 201);
});

test("M3: Bluesky probe page with a last partial batch completes the list", async () => {
  const env = bskyWorld({ follows: [{ did: "did:plc:last", handle: "last.bsky.social" }] });
  const r = await bsResult(env);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.counts.following, 20001);
});

test("M3: Bluesky probe page that still has more is reported incomplete", async () => {
  const env = bskyWorld({ follows: [{ did: "did:plc:more", handle: "more.bsky.social" }], cursor: "c-more" });
  const r = await bsResult(env);
  assert.equal(r.ok, false);
  assert.match(r.error, /incomplete/i);
  assert.equal(env.pages(), 201);
});

/* ---------- M1: popup only follows its own job / platform ---------- */

function igResult(extra = {}) {
  const a = { id: "1", username: "alice" };
  return {
    type: "RESULT", ok: true, platform: "instagram", me: { id: "12345", username: "tester" },
    counts: { following: 1, followers: 1, mutual: 1, notFollowingBack: 0, notFollowedByMe: 0 },
    following: [a], followers: [a], mutual: [a], notFollowingBack: [], notFollowedByMe: [], finishedAt: T0, ...extra,
  };
}
const ghForeign = (clockNow) => ({
  type: "RESULT", ok: true, platform: "github", jobId: "gh-old", me: { id: "9", username: "gh-someone" },
  counts: { following: 1, followers: 0, mutual: 0, notFollowingBack: 1, notFollowedByMe: 0 },
  following: [{ id: "a", username: "a" }], followers: [], mutual: [], notFollowingBack: [{ id: "a", username: "a" }], notFollowedByMe: [], finishedAt: clockNow,
});

test("M1/R2: while waiting for the IG job, a GitHub job's PROGRESS/RESULT do not touch the IG view", async () => {
  const clock = new FakeClock(T0);
  const p = await loadPopup({
    clock,
    storageInitial: { "fcResult:instagram": igResult({ jobId: "ig-prev", finishedAt: T0 - 1000 }) },
    onTabMessage: (msg) => (msg.type === "ANALYZE" ? { ok: true, started: true, jobId: "ig-job" } : { ok: false }),
  });
  p.$("startBtn").click();
  await flush(60);
  assert.equal(p.run("state.jobId"), "ig-job");
  await p.deliver({ type: "PROGRESS", stage: "user", platform: "github", jobId: "gh-old", me: { id: "9", username: "gh-someone" } });
  assert.equal(p.run("state.me.username"), "tester");
  await p.deliver(ghForeign(clock.now));
  assert.equal(p.run("state.resultPlatform"), "instagram");
  assert.equal(p.run("state.mutual.length"), 1);
  assert.equal(p.run("state.analysisRunning"), true);
  assert.equal(p.run("state.jobId"), "ig-job");
  await p.deliver({ ...igResult({ finishedAt: T0 + 5 }), jobId: "ig-job" });
  assert.equal(p.run("state.analysisRunning"), false);
  assert.equal(p.run("state.resultJobId"), "ig-job");
});

test("M1: an untracked message without job id, or of another platform, is not adopted", async () => {
  const clock = new FakeClock(T0);
  const p = await loadPopup({ clock, storageInitial: { "fcResult:instagram": igResult({ jobId: "ig-prev" }) } });
  await p.deliver({ ...ghForeign(clock.now) });
  await p.deliver({ type: "PROGRESS", stage: "following", platform: "github", jobId: "gh-x" });
  await p.deliver({ ...igResult({ mutual: [], counts: { following: 0, followers: 0, mutual: 0, notFollowingBack: 0, notFollowedByMe: 0 } }), jobId: undefined });
  assert.equal(p.run("state.resultPlatform"), "instagram");
  assert.equal(p.run("state.mutual.length"), 1);
  assert.equal(p.run("state.analysisRunning"), false);
});

test("M1: parallel GitHub result still lands in storage and is shown on the next open", async () => {
  const clock = new FakeClock(T0);
  const storage = createStorage({ initial: { "fcResult:instagram": igResult({ jobId: "ig-prev", finishedAt: T0 - 5000 }) } });
  const p = await loadPopup({ clock, storage });
  storage.data["fcResult:github"] = { ...ghForeign(T0) }; // written by the worker for the GitHub tab
  await p.deliver(ghForeign(T0));
  assert.equal(p.run("state.resultPlatform"), "instagram");
  const reopened = await loadPopup({ clock, storage });
  assert.equal(reopened.run("state.resultPlatform"), "github");
});

/* ---------- M2: opened-profile reminders bound to account + platform ---------- */

function pendingValue(p, key) {
  return p.storage.data.pendingManual?.[key];
}

test("M2/R9: a result of account B never drops a reminder of account A", async () => {
  const clock = new FakeClock(T0);
  const p = await loadPopup({
    clock,
    storageInitial: { pendingManual: { "instagram:123:77": { action: "unfollow", at: T0 - 10_000 } } },
  });
  await p.deliver({ ...igResult({ me: { id: "999", username: "accountB" }, following: [], followers: [], mutual: [], counts: { following: 0, followers: 0, mutual: 0, notFollowingBack: 0, notFollowedByMe: 0 } }), jobId: "j" });
  assert.ok(pendingValue(p, "instagram:123:77"));
});

test("M2: legacy reminders without account are never auto-removed", async () => {
  const clock = new FakeClock(T0);
  const p = await loadPopup({ clock, storageInitial: { pendingManual: { "instagram:123": "unfollow" } } });
  await p.deliver({ ...igResult({ me: { id: "999", username: "b" }, following: [], followers: [], mutual: [] }), jobId: "j" });
  assert.equal(pendingValue(p, "instagram:123"), "unfollow");
});

test("M2: same account, analysis newer than the reminder: confirmed reminder dropped (live and on restore)", async () => {
  const clock = new FakeClock(T0);
  const pending = {
    "instagram:12345:2": { action: "unfollow", at: T0 - 60_000 }, // bob gone → resolved
    "instagram:12345:1": { action: "unfollow", at: T0 - 60_000 }, // alice still followed → keep
    "instagram:12345:3": { action: "unfollow", at: T0 + 60_000 }, // created after the analysis → keep
  };
  // restore path: result finished after the reminders were created
  const restored = await loadPopup({ clock, storageInitial: { pendingManual: structuredClone(pending), "fcResult:instagram": igResult({ jobId: "j1" }) } });
  assert.deepEqual(Object.keys(restored.storage.data.pendingManual).sort(), ["instagram:12345:1", "instagram:12345:3"]);
  // live path: same comparison
  const live = await loadPopup({ clock, storageInitial: { pendingManual: structuredClone(pending) } });
  await live.deliver({ ...igResult(), jobId: "j2" });
  assert.deepEqual(Object.keys(live.storage.data.pendingManual).sort(), ["instagram:12345:1", "instagram:12345:3"]);
});

test("M2: a reminder is keyed by the shown account and found again after reopening", async () => {
  const clock = new FakeClock(T0);
  const base = igResult({
    jobId: "j1",
    following: [{ id: "1", username: "alice" }, { id: "2", username: "bob" }],
    notFollowingBack: [{ id: "2", username: "bob" }],
    counts: { following: 2, followers: 1, mutual: 1, notFollowingBack: 1, notFollowedByMe: 0 },
  });
  const p = await loadPopup({ clock, storageInitial: { "fcResult:instagram": base } });
  p.ctx.__u = { id: "2", username: "bob" };
  p.ctx.__btn = p.document.createElement("button");
  p.ctx.__row = p.document.createElement("div");
  await p.run(`handleFriendship(__u, "unfollow", "notBack", __btn, __row)`);
  await flush(20);
  const stored = p.storage.data.pendingManual;
  assert.deepEqual(Object.keys(stored), ["instagram:12345:2"]);
  assert.equal(stored["instagram:12345:2"].action, "unfollow");
  const again = await loadPopup({ clock, storage: p.storage });
  assert.equal(again.run(`pendingAction("2")`), "unfollow");
});

/* ---------- M6: rejected local edits are reported ---------- */

async function manualMark(p, user) {
  p.ctx.__u = user;
  p.ctx.__btn = p.document.createElement("button");
  p.ctx.__row = p.document.createElement("div");
  const call = `handleFriendship(__u, "unfollow", "notBack", __btn, __row)`;
  await p.run(call);
  await p.run(call);
  await flush(40);
}

test("M6: a stale local edit is reported and the current stored result is loaded", async () => {
  const clock = new FakeClock(T0);
  const base = igResult({
    jobId: "job-old",
    following: [{ id: "1", username: "alice" }, { id: "2", username: "bob" }],
    notFollowingBack: [{ id: "2", username: "bob" }],
    counts: { following: 2, followers: 1, mutual: 1, notFollowingBack: 1, notFollowedByMe: 0 },
  });
  const p = await loadPopup({ clock, storageInitial: { "fcResult:instagram": base } });
  const newer = igResult({ jobId: "job-new", finishedAt: T0 + 1000 });
  p.storage.data["fcResult:instagram"] = structuredClone(newer);
  await manualMark(p, { id: "2", username: "bob" });
  assert.match(p.$("status").textContent, /not saved/i);
  assert.equal(p.run("state.resultJobId"), "job-new");
  assert.deepEqual(p.storage.data["fcResult:instagram"], newer);
});

test("M6: an edit the worker cannot store is reported, not shown as saved", async () => {
  const clock = new FakeClock(T0);
  const base = igResult({
    jobId: "j1",
    following: [{ id: "1", username: "alice" }, { id: "2", username: "bob" }],
    notFollowingBack: [{ id: "2", username: "bob" }],
    counts: { following: 2, followers: 1, mutual: 1, notFollowingBack: 1, notFollowedByMe: 0 },
  });
  const p = await loadPopup({ clock, storageInitial: { "fcResult:instagram": base } });
  p.storage.failures.set = "QUOTA_BYTES quota exceeded";
  await manualMark(p, { id: "2", username: "bob" });
  assert.match(p.$("status").textContent, /not saved/i);
});

test("M6: popup.html opened as a tab may edit (same extension page); web pages may not", async () => {
  const clock = new FakeClock(T0);
  const storage = createStorage({ initial: { "fcResult:instagram": igResult({ jobId: "j1" }) } });
  const bus = createBus({ storage, clock });
  const edit = { type: "FC_RESULT_EDIT", platform: "instagram", baseJobId: "j1", result: igResult({ mutual: [] }) };
  const asTab = await bus.send(edit, { id: "test-extension", tab: { id: 8, url: "chrome-extension://test-extension/popup.html" }, url: "chrome-extension://test-extension/popup.html" });
  assert.equal(asTab.ok, true);
  const fromPage = await bus.send(edit, { id: "test-extension", tab: { id: 9, url: "https://www.instagram.com/" }, url: "https://www.instagram.com/" });
  assert.equal(fromPage.ok, false);
});
