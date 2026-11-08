// F4: list pagination ends (complete / stalled / rate limited / capped).
import test from "node:test";
import assert from "node:assert/strict";
import { loadExtension, createWindow, FakeClock, jsonResponse, advanceUntil } from "./helpers/harness.mjs";
import { igUser } from "./helpers/ig-fixtures.mjs";

function ig(fetchImpl) {
  const clock = new FakeClock();
  const env = loadExtension(["fc-shared.js", "content.js"], {
    clock,
    window: createWindow(),
    cookie: "csrftoken=tok; ds_user_id=12345",
    fetch: fetchImpl,
  });
  return env;
}

async function settle(env, promise, { step = 1000, max = 500 } = {}) {
  let outcome = null;
  promise.then(
    (value) => (outcome = { value }),
    (error) => (outcome = { error })
  );
  await advanceUntil(env.clock, () => outcome !== null, { step, max });
  assert.ok(outcome, "promise settled");
  return outcome;
}

const LIST = (url) => /friendships\/\d+\/following\//.test(url);

test("IG: normal multi-page list completes with all unique users", async () => {
  let n = 0;
  const env = ig(async (url) => {
    if (!LIST(url)) throw new Error(url);
    n += 1;
    const users = [igUser(n * 2), igUser(n * 2 + 1)];
    return jsonResponse({ users, next_max_id: n < 3 ? `c${n}` : null });
  });
  const out = await settle(env, env.run(`fetchList("12345", "following", null, 6)`));
  assert.equal(out.error, undefined);
  assert.equal(out.value.length, 6);
});

test("IG: a cursor that does not advance ends with an explicit error, not an endless loop", async () => {
  let calls = 0;
  const env = ig(async (url) => {
    calls += 1;
    if (calls > 20) throw new Error("runaway pagination in test");
    return jsonResponse({ users: [igUser(calls)], next_max_id: "same-cursor" });
  });
  const out = await settle(env, env.run(`fetchList("12345", "following", null, 50)`));
  assert.ok(out.error, "rejects");
  assert.match(out.error.message, /stopped|stalled/i);
  assert.ok(calls <= 3, `bounded requests, got ${calls}`);
});

test("IG: pages that keep returning only known users end with an explicit error", async () => {
  let calls = 0;
  const env = ig(async () => {
    calls += 1;
    if (calls > 20) throw new Error("runaway pagination in test");
    return jsonResponse({ users: [igUser(1)], next_max_id: `c${calls}` });
  });
  const out = await settle(env, env.run(`fetchList("12345", "following", null, 50)`));
  assert.ok(out.error);
  assert.match(out.error.message, /stopped|stalled/i);
  assert.ok(calls <= 5, `bounded requests, got ${calls}`);
});

test("IG: 429 on a later page stops immediately and is reported (no retries, no partial list)", async () => {
  let calls = 0;
  const env = ig(async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ users: [igUser(1)], next_max_id: "c1" });
    return jsonResponse({ message: "Please wait a few minutes" }, 429);
  });
  const out = await settle(env, env.run(`fetchList("12345", "following", null, 50)`));
  assert.ok(out.error);
  assert.match(out.error.message, /429/);
  assert.equal(calls, 2);
});

test("IG: enrichment stops at the first 429 instead of continuing to hit Instagram", async () => {
  let calls = 0;
  const env = ig(async () => {
    calls += 1;
    return jsonResponse({ message: "rate limited" }, 429);
  });
  const users = Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1), username: `bot${i}1234567` }));
  const out = await settle(env, env.run(`enrichUsersWithCounts(${JSON.stringify(users)}, null, { max: 10, delayMs: 10 })`));
  assert.equal(out.error, undefined, "enrichment is optional: list stays usable");
  assert.equal(out.value.length, 10);
  assert.equal(calls, 1, `one request then stop, got ${calls}`);
});

function github(fetchImpl) {
  const clock = new FakeClock();
  return loadExtension(["fc-shared.js", "github.js"], {
    clock,
    url: "https://github.com/octo",
    window: createWindow(),
    document: {
      cookie: "",
      querySelectorAll: () => [],
      querySelector: (sel) => (sel === 'meta[name="user-login"]' ? { content: "octo" } : null),
    },
    fetch: fetchImpl,
  });
}

async function analyze(env, { max = 3000 } = {}) {
  const res = await env.chrome.dispatch({ type: "ANALYZE" });
  assert.equal(res?.started, true);
  await advanceUntil(env.clock, () => env.chrome.runtime.sent.some((m) => m.type === "RESULT"), { step: 500, max });
  return env.chrome.runtime.sent.find((m) => m.type === "RESULT");
}

test("GitHub: hitting the page cap with more data is reported as incomplete, not as a full list", async () => {
  let id = 0;
  const env = github(async (url) => {
    if (url.endsWith("/users/octo")) return jsonResponse({ id: 1, login: "octo", followers: 20000, following: 3 });
    if (url.includes("/following")) return jsonResponse([{ id: 2, login: "a" }, { id: 3, login: "b" }, { id: 4, login: "c" }]);
    const batch = Array.from({ length: 100 }, () => ({ id: (id += 1) + 100, login: `f${id}` }));
    return jsonResponse(batch);
  });
  const result = await analyze(env);
  assert.equal(result.ok, false);
  assert.match(result.error, /incomplete|stopped/i);
});

function bluesky(fetchImpl) {
  const clock = new FakeClock();
  return loadExtension(["fc-shared.js", "bluesky.js"], {
    clock,
    url: "https://bsky.app/",
    window: createWindow(),
    document: {
      cookie: "",
      querySelectorAll: () => [],
      querySelector: (sel) => (sel.includes("Profile") ? { getAttribute: () => "/profile/me.bsky.social" } : null),
    },
    fetch: fetchImpl,
  });
}

test("Bluesky: a repeating cursor ends with an explicit error instead of duplicating users", async () => {
  let calls = 0;
  const env = bluesky(async (url) => {
    if (url.includes("getProfile")) {
      return jsonResponse({ did: "did:plc:me", handle: "me.bsky.social", followersCount: 1, followsCount: 500 });
    }
    calls += 1;
    if (calls > 50) throw new Error("runaway pagination in test");
    return jsonResponse({ follows: [{ did: "did:plc:x", handle: "x.bsky.social" }], cursor: "same" });
  });
  const result = await analyze(env);
  assert.equal(result.ok, false);
  assert.match(result.error, /stopped|stalled/i);
  assert.ok(calls <= 3, `bounded requests, got ${calls}`);
});

test("Bluesky: hitting the page cap with a cursor left is reported as incomplete", async () => {
  let n = 0;
  const env = bluesky(async (url) => {
    if (url.includes("getProfile")) {
      return jsonResponse({ did: "did:plc:me", handle: "me.bsky.social", followersCount: 1, followsCount: 50000 });
    }
    n += 1;
    const follows = Array.from({ length: 100 }, (_, i) => ({ did: `did:plc:u${n}-${i}`, handle: `u${n}-${i}.bsky.social` }));
    return jsonResponse({ follows, followers: follows, cursor: `c${n}` });
  });
  const result = await analyze(env, { max: 5000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /incomplete|stopped/i);
});
