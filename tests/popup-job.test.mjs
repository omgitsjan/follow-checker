// F1 (popup side): reopen/reconstruct a running job, keep good results next to errors.
import test from "node:test";
import assert from "node:assert/strict";
import { loadPopup } from "./helpers/popup-harness.mjs";
import { FakeClock, flush } from "./helpers/harness.mjs";

const T0 = 1_800_000_000_000;

function result(platform, finishedAt, extra = {}) {
  const a = { id: "1", username: "alice" };
  const b = { id: "2", username: "bob" };
  return {
    type: "RESULT",
    ok: true,
    platform,
    me: { id: "12345", username: "tester" },
    counts: { following: 2, followers: 1, mutual: 1, notFollowingBack: 1, notFollowedByMe: 0 },
    following: [a, b],
    followers: [a],
    mutual: [a],
    notFollowingBack: [b],
    notFollowedByMe: [],
    finishedAt,
    ...extra,
  };
}

const runningJob = (platform, now, extra = {}) => ({
  id: "job-1",
  platform,
  kind: "analyze",
  owner: "tab-a",
  status: "running",
  stage: "followers",
  startedAt: now - 20_000,
  heartbeatAt: now - 2_000,
  ...extra,
});

test("reopening the popup during a run shows the running job and does not start a second one", async () => {
  const clock = new FakeClock(T0);
  const p = await loadPopup({
    clock,
    storageInitial: {
      "fcResult:instagram": result("instagram", T0 - 3_600_000),
      "fcJob:instagram": runningJob("instagram", T0),
    },
  });
  assert.equal(p.run("state.analysisRunning"), true);
  assert.equal(p.$("startBtn").disabled, true);
  assert.equal(p.$("progressWrap").hidden, false);
  assert.equal(p.run("state.mutual.length"), 1, "previous result still visible");

  p.$("startBtn").click();
  await flush(40);
  assert.equal(p.tabMessages.filter((m) => m.msg.type === "ANALYZE").length, 0);

  await p.deliver({ ...result("instagram", T0 + 1000), jobId: "job-1" });
  assert.equal(p.run("state.analysisRunning"), false);
  assert.equal(p.$("startBtn").disabled, false);
});

test("a stale running job is reported as interrupted and does not block a new start", async () => {
  const clock = new FakeClock(T0);
  const p = await loadPopup({
    clock,
    storageInitial: {
      "fcResult:instagram": result("instagram", T0 - 3_600_000),
      "fcJob:instagram": runningJob("instagram", T0, { heartbeatAt: T0 - 30 * 60_000 }),
    },
  });
  assert.equal(p.run("state.analysisRunning"), false);
  assert.equal(p.$("startBtn").disabled, false);
  assert.match(p.$("status").textContent, /interrupted/i);
});

test("a newer failed run is shown as an error while the last good result stays visible", async () => {
  const clock = new FakeClock(T0);
  const p = await loadPopup({
    clock,
    storageInitial: {
      "fcResult:instagram": result("instagram", T0 - 3_600_000),
      "fcError:instagram": { error: "Instagram rate-limited requests (429).", at: T0 - 60_000, jobId: "job-x" },
      "fcJob:instagram": { ...runningJob("instagram", T0), status: "failed", endedAt: T0 - 60_000 },
    },
  });
  assert.equal(p.run("state.mutual.length"), 1);
  assert.equal(p.run("state.notFollowingBack.length"), 1);
  const status = p.$("status");
  assert.ok(status.classList.contains("error"));
  assert.match(status.textContent, /429/);
});

test("legacy lastResult from older versions is still restored", async () => {
  const clock = new FakeClock(T0);
  const p = await loadPopup({ clock, storageInitial: { lastResult: result("instagram", T0 - 120_000) } });
  assert.equal(p.run("state.mutual.length"), 1);
  assert.equal(p.run("state.resultPlatform"), "instagram");
});

test("a live failure keeps the shown lists and reports the error", async () => {
  const clock = new FakeClock(T0);
  const p = await loadPopup({ clock, storageInitial: { "fcResult:instagram": result("instagram", T0 - 1000) } });
  await p.deliver({ type: "RESULT", ok: false, platform: "instagram", jobId: "j", error: "HTTP 500" });
  assert.equal(p.run("state.mutual.length"), 1);
  assert.match(p.$("status").textContent, /HTTP 500/);
});

test("while waiting, the popup notices a job that ended without a message reaching it", async () => {
  const clock = new FakeClock(T0);
  const p = await loadPopup({
    clock,
    storageInitial: {
      "fcResult:instagram": result("instagram", T0 - 3_600_000),
      "fcJob:instagram": runningJob("instagram", T0),
    },
  });
  assert.equal(p.run("state.analysisRunning"), true);
  p.storage.data["fcJob:instagram"] = { ...runningJob("instagram", T0), status: "failed", endedAt: T0 + 1000 };
  p.storage.data["fcError:instagram"] = { error: "HTTP 502", at: T0 + 1000, jobId: "job-1" };
  await clock.advance(15_000);
  assert.equal(p.run("state.analysisRunning"), false);
  assert.equal(p.$("startBtn").disabled, false);
  assert.match(p.$("status").textContent, /HTTP 502/);
});

test("results of different platforms are kept apart; the newest one is shown", async () => {
  const clock = new FakeClock(T0);
  const p = await loadPopup({
    clock,
    storageInitial: {
      "fcResult:instagram": result("instagram", T0 - 7_200_000),
      "fcResult:github": result("github", T0 - 60_000, { mutual: [], counts: { following: 2, followers: 1, mutual: 0, notFollowingBack: 2, notFollowedByMe: 1 } }),
    },
  });
  assert.equal(p.run("state.resultPlatform"), "github");
  // a manual edit of the shown result is written to its own platform slot only
  await p.run("persistState()");
  assert.equal(p.storage.data["fcResult:instagram"].finishedAt, T0 - 7_200_000);
  assert.equal(p.storage.data["fcResult:github"].platform, "github");
});

test("a busy answer from the content script switches to the running view instead of an error-only state", async () => {
  const clock = new FakeClock(T0);
  const p = await loadPopup({
    clock,
    onTabMessage: (msg) => {
      if (msg.type === "ANALYZE") return { ok: false, busy: true, error: "Analysis already running.", job: runningJob("instagram", clock.now) };
      return { ok: false };
    },
  });
  p.$("startBtn").click();
  await flush(60);
  assert.equal(p.run("state.analysisRunning"), true);
  assert.equal(p.$("startBtn").disabled, true);
});
