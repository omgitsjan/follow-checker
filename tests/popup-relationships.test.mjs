// F3: manual relationship care in the popup (local marks only, list invariants).
import test from "node:test";
import assert from "node:assert/strict";
import { loadPopup } from "./helpers/popup-harness.mjs";
import { FakeClock, flush } from "./helpers/harness.mjs";

const T0 = 1_800_000_000_000;
const A = { id: "1", username: "alice" }; // mutual
const B = { id: "2", username: "bob" }; // you follow, not back
const C = { id: "3", username: "carol" }; // follows you, you don't
const D = { id: "4", username: "dave" }; // mutual

function base() {
  return {
    type: "RESULT",
    ok: true,
    platform: "instagram",
    me: { id: "12345", username: "tester" },
    counts: { following: 3, followers: 3, mutual: 2, notFollowingBack: 1, notFollowedByMe: 1 },
    following: [A, B, D],
    followers: [A, C, D],
    mutual: [A, D],
    notFollowingBack: [B],
    notFollowedByMe: [C],
    finishedAt: T0 - 600_000,
  };
}

function assertInvariants(p) {
  const ids = (expr) => p.run(`${expr}.map((u) => u.id).sort()`);
  const following = new Set(ids("state.following"));
  const followers = new Set(ids("state.followers"));
  const mutual = [...following].filter((id) => followers.has(id)).sort();
  const notBack = [...following].filter((id) => !followers.has(id)).sort();
  const notMe = [...followers].filter((id) => !following.has(id)).sort();
  assert.deepEqual(ids("state.mutual"), mutual, "mutual = following ∩ followers");
  assert.deepEqual(ids("state.notFollowingBack"), notBack, "notBack = following \\ followers");
  assert.deepEqual(ids("state.notFollowedByMe"), notMe, "notMe = followers \\ following");
  const counts = p.run("state.counts");
  assert.equal(counts.following, following.size);
  assert.equal(counts.followers, followers.size);
  assert.equal(counts.mutual, mutual.length);
  assert.equal(counts.notFollowingBack, notBack.length);
  assert.equal(counts.notFollowedByMe, notMe.length);
  for (const list of ["following", "followers", "mutual", "notFollowingBack", "notFollowedByMe"]) {
    const arr = ids(`state.${list}`);
    assert.equal(new Set(arr).size, arr.length, `${list} has no duplicates`);
  }
}

async function manual(p, user, action, listKey) {
  p.ctx.__u = user;
  const call = `handleFriendship(__u, ${JSON.stringify(action)}, ${JSON.stringify(listKey)}, __btn, __row)`;
  p.ctx.__btn = p.document.createElement("button");
  p.ctx.__row = p.document.createElement("div");
  await p.run(call); // 1st tap: opens the profile, remembers the pending action
  await p.run(call); // 2nd tap ("Done"): local mark
  await flush(20);
}

test("manual 'Done' is a local mark: no site action, honest wording, analysis time kept", async () => {
  const clock = new FakeClock(T0);
  const p = await loadPopup({ clock, storageInitial: { "fcResult:instagram": base() } });
  await manual(p, B, "unfollow", "notBack");
  assert.equal(p.created.length, 1, "profile opened once");
  assert.match(p.created[0].url, /instagram\.com\/bob\//);
  assert.equal(p.tabMessages.filter((m) => m.msg.type === "FRIENDSHIP").length, 0, "no unfollow request sent");
  const status = p.$("status").textContent;
  assert.match(status, /Marked @bob/);
  assert.doesNotMatch(status, /^Unfollowed/);
  const stored = p.storage.data["fcResult:instagram"];
  assert.equal(stored.finishedAt, T0 - 600_000, "a local edit is not presented as a fresh analysis");
  assert.equal(stored.following.some((u) => u.id === B.id), false);
  assertInvariants(p);
});

test("manual remove-follower uses local wording too", async () => {
  const clock = new FakeClock(T0);
  const p = await loadPopup({ clock, storageInitial: { "fcResult:instagram": base() } });
  await manual(p, C, "remove_follower", "notMe");
  assert.match(p.$("status").textContent, /Marked @carol/);
  assertInvariants(p);
});

test("set invariants hold across a sequence of manual marks", async () => {
  const clock = new FakeClock(T0);
  const p = await loadPopup({ clock, storageInitial: { "fcResult:instagram": base() } });
  assertInvariants(p);
  await manual(p, A, "unfollow", "mutual"); // mutual → only follows you
  assertInvariants(p);
  assert.deepEqual(p.run("state.notFollowedByMe.map((u) => u.id).sort()"), ["1", "3"]);
  await manual(p, D, "remove_follower", "mutual"); // mutual → you follow, not back
  assertInvariants(p);
  assert.deepEqual(p.run("state.notFollowingBack.map((u) => u.id).sort()"), ["2", "4"]);
  await manual(p, A, "remove_follower", "notMe");
  assertInvariants(p);
  await manual(p, B, "unfollow", "notBack");
  assertInvariants(p);
});

test("a fresh analysis resolves opened-profile reminders it can confirm, keeps the others", async () => {
  const clock = new FakeClock(T0);
  const p = await loadPopup({
    clock,
    storageInitial: {
      "fcResult:instagram": base(),
      pendingManual: { "instagram:2": "unfollow", "instagram:1": "unfollow", "github:2": "unfollow" },
    },
  });
  // New analysis: bob is gone from following (really unfollowed), alice is still followed.
  const fresh = { ...base(), following: [A, D], notFollowingBack: [], counts: { ...base().counts, following: 2, notFollowingBack: 0 }, finishedAt: T0, jobId: "j2" };
  await p.deliver(fresh);
  assert.deepEqual(p.run("state.pendingManual"), { "instagram:1": "unfollow", "github:2": "unfollow" });
  assert.deepEqual(p.storage.data.pendingManual, { "instagram:1": "unfollow", "github:2": "unfollow" });
});
