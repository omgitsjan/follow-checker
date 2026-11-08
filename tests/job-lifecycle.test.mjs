// F1: analysis job lifecycle on the content-script side (Instagram + shared GitHub/Bluesky listener).
import test from "node:test";
import assert from "node:assert/strict";
import { loadExtension, createWindow, createStorage, FakeClock, jsonResponse, advanceUntil, later } from "./helpers/harness.mjs";
import { igRouter, igUser } from "./helpers/ig-fixtures.mjs";

const GOOD_IG = {
  type: "RESULT",
  ok: true,
  platform: "instagram",
  me: { id: "12345", username: "tester" },
  counts: { following: 1, followers: 1, mutual: 1, notFollowingBack: 0, notFollowedByMe: 0 },
  following: [{ id: "1", username: "a" }],
  followers: [{ id: "1", username: "a" }],
  mutual: [{ id: "1", username: "a" }],
  notFollowingBack: [],
  notFollowedByMe: [],
  finishedAt: 1_700_000_000_000,
};

function igEnv({ storageInitial = {}, lists, overrides, storage } = {}) {
  const clock = new FakeClock();
  return loadExtension(["fc-shared.js", "content.js"], {
    clock,
    window: createWindow(),
    storage: storage || createStorage({ initial: storageInitial }),
    cookie: "csrftoken=tok; ds_user_id=12345",
    fetch: igRouter({
      lists: lists || { following: [igUser(1), igUser(2)], followers: [igUser(2), igUser(3)] },
      overrides,
    }),
  });
}

const results = (env) => env.chrome.runtime.sent.filter((m) => m.type === "RESULT");

async function runToResult(env, count = 1) {
  const ok = await advanceUntil(env.clock, () => results(env).length >= count, { step: 500, max: 4000 });
  assert.ok(ok, "job finished");
  return results(env)[count - 1];
}

test("success stores the result per platform, ends the job and tags messages with the job id", async () => {
  const env = igEnv();
  const res = await env.chrome.dispatch({ type: "ANALYZE" });
  assert.equal(res.ok, true);
  assert.equal(res.started, true);
  assert.ok(res.jobId);
  const result = await runToResult(env);
  assert.equal(result.ok, true);
  assert.equal(result.jobId, res.jobId);
  assert.equal(result.platform, "instagram");
  const stored = env.storage.data["fcResult:instagram"];
  assert.equal(stored.ok, true);
  assert.equal(stored.counts.mutual, 1);
  assert.equal(env.storage.data["fcJob:instagram"].status, "succeeded");
  assert.equal(env.storage.data["fcJob:instagram"].id, res.jobId);
  assert.ok(env.chrome.runtime.sent.filter((m) => m.type === "PROGRESS").every((m) => m.jobId === res.jobId));
});

test("failure keeps the last good result and records the error separately", async () => {
  const env = igEnv({
    storageInitial: { lastResult: GOOD_IG, "fcResult:instagram": GOOD_IG },
    overrides: (url) => (url.includes("/following/") ? jsonResponse({ message: "boom" }, 500) : undefined),
  });
  const res = await env.chrome.dispatch({ type: "ANALYZE" });
  const result = await runToResult(env);
  assert.equal(result.ok, false);
  assert.equal(result.platform, "instagram");
  assert.equal(result.jobId, res.jobId);
  assert.deepEqual(env.storage.data["fcResult:instagram"], GOOD_IG, "good result kept");
  assert.deepEqual(env.storage.data.lastResult, GOOD_IG, "legacy slot not overwritten by a failure");
  const err = env.storage.data["fcError:instagram"];
  assert.match(err.error, /HTTP 500/);
  assert.equal(err.jobId, res.jobId);
  assert.equal(env.storage.data["fcJob:instagram"].status, "failed");
});

test("while running, the persisted job shows stage + fresh heartbeat (popup can reconstruct it)", async () => {
  const env = igEnv({
    overrides: (url) =>
      url.includes("/followers/") ? later(env.clock, 60_000, jsonResponse({ users: [igUser(2)], next_max_id: null })) : undefined,
  });
  const res = await env.chrome.dispatch({ type: "ANALYZE" });
  await env.clock.advance(5_000);
  let job = env.storage.data["fcJob:instagram"];
  assert.equal(job.status, "running");
  assert.equal(job.id, res.jobId);
  assert.equal(job.stage, "followers");
  const hb1 = job.heartbeatAt;
  await env.clock.advance(40_000);
  job = env.storage.data["fcJob:instagram"];
  assert.equal(job.status, "running");
  assert.ok(job.heartbeatAt > hb1, "heartbeat keeps the job fresh during long requests");
  await runToResult(env);
});

test("only one job at a time: ANALYZE and FETCH_OWN_POSTS are refused while a job runs", async () => {
  let postsRequests = 0;
  const env = igEnv({
    overrides: (url) => {
      if (url.includes("/feed/") || url.includes("graphql/query/?doc_id") || url.includes("likers")) postsRequests += 1;
      return url.includes("/followers/") ? later(env.clock, 10_000, jsonResponse({ users: [], next_max_id: null })) : undefined;
    },
  });
  const first = await env.chrome.dispatch({ type: "ANALYZE" });
  assert.equal(first.started, true);
  const again = await env.chrome.dispatch({ type: "ANALYZE" });
  assert.equal(again.ok, false);
  assert.equal(again.busy, true);
  const posts = await env.chrome.dispatch({ type: "FETCH_OWN_POSTS" });
  assert.equal(posts.ok, false);
  assert.equal(posts.busy, true);
  assert.equal(postsRequests, 0);
  await runToResult(env);
  const third = await env.chrome.dispatch({ type: "ANALYZE" });
  assert.equal(third.started, true, "guard released after the job ended");
  await runToResult(env, 2);
});

test("a fresh running job from another tab blocks a second run; a stale one does not", async () => {
  const clock = new FakeClock();
  const other = { id: "job-other", platform: "instagram", kind: "analyze", owner: "other-tab", status: "running", stage: "following", startedAt: clock.now - 5000, heartbeatAt: clock.now - 1000 };
  const env = igEnv({ storageInitial: { "fcJob:instagram": other } });
  env.clock.now = clock.now;
  const busy = await env.chrome.dispatch({ type: "ANALYZE" });
  assert.equal(busy.ok, false);
  assert.equal(busy.busy, true);
  assert.equal(busy.job.id, "job-other");

  env.storage.data["fcJob:instagram"] = { ...other, heartbeatAt: env.clock.now - 10 * 60_000 };
  const started = await env.chrome.dispatch({ type: "ANALYZE" });
  assert.equal(started.started, true, "stale job (tab closed / reloaded) does not block forever");
  await runToResult(env);
});

test("storage write failures do not wedge the job: result still delivered, next run possible", async () => {
  const storage = createStorage();
  storage.failures.set = "QUOTA_BYTES quota exceeded";
  const env = igEnv({ storage });
  const res = await env.chrome.dispatch({ type: "ANALYZE" });
  assert.equal(res.started, true);
  const result = await runToResult(env);
  assert.equal(result.ok, true);
  const second = await env.chrome.dispatch({ type: "ANALYZE" });
  assert.equal(second.started, true);
  await runToResult(env, 2);
});

function githubEnv({ storageInitial = {}, fail = false } = {}) {
  const clock = new FakeClock();
  return loadExtension(["fc-shared.js", "github.js"], {
    clock,
    window: createWindow(),
    storage: createStorage({ initial: storageInitial }),
    document: {
      cookie: "",
      querySelectorAll: () => [],
      querySelector: (sel) => (sel === 'meta[name="user-login"]' ? { content: "octo" } : null),
    },
    fetch: async (url) => {
      if (url.endsWith("/users/octo")) return jsonResponse({ id: 1, login: "octo", followers: 1, following: 1 });
      if (fail) return jsonResponse({ message: "nope" }, 502);
      return jsonResponse([{ id: 7, login: "pal" }]);
    },
  });
}

test("platforms are isolated: a GitHub failure or success never touches the Instagram result", async () => {
  const failing = githubEnv({ storageInitial: { "fcResult:instagram": GOOD_IG }, fail: true });
  const r1 = await failing.chrome.dispatch({ type: "ANALYZE" });
  assert.equal(r1.started, true);
  const fail = await runToResult(failing);
  assert.equal(fail.ok, false);
  assert.equal(fail.platform, "github");
  assert.deepEqual(failing.storage.data["fcResult:instagram"], GOOD_IG);
  assert.match(failing.storage.data["fcError:github"].error, /502/);
  assert.equal(failing.storage.data["fcError:instagram"], undefined);

  const ok = githubEnv({ storageInitial: { "fcResult:instagram": GOOD_IG } });
  await ok.chrome.dispatch({ type: "ANALYZE" });
  const success = await runToResult(ok);
  assert.equal(success.ok, true);
  assert.equal(ok.storage.data["fcResult:github"].platform, "github");
  assert.deepEqual(ok.storage.data["fcResult:instagram"], GOOD_IG);
});
