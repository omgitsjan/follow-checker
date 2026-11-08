/**
 * Shared helpers for non-Instagram content scripts.
 * Function assignments stay idempotent if the file is injected twice.
 */
if (!globalThis.__fcSharedBoot) {
  globalThis.__fcSharedBoot = true;

  globalThis.fcSleep = function fcSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  };

  /**
   * Pagination end guard. A list is only "complete" when the site says there is
   * no next page. A cursor that repeats, or pages that add no new accounts,
   * end the run with an explicit error instead of looping or returning a
   * partial list as if it were complete.
   */
  globalThis.FC_MAX_IDLE_PAGES = 3;
  globalThis.fcPageGuard = function fcPageGuard(label) {
    const cursors = new Set();
    let idle = 0;
    return {
      check(nextCursor, newUnique, loaded) {
        idle = newUnique > 0 ? 0 : idle + 1;
        if (!nextCursor) return;
        const key = String(nextCursor);
        if (cursors.has(key) || idle >= FC_MAX_IDLE_PAGES) {
          throw new Error(
            `${label}: the list stopped advancing after ${loaded} accounts (pagination stalled). The result was not saved; try again later.`
          );
        }
        cursors.add(key);
      },
    };
  };

  globalThis.fcIncompleteError = function fcIncompleteError(label, loaded) {
    return new Error(
      `${label}: stopped at the safety limit after ${loaded} accounts, so the list would be incomplete. The result was not saved.`
    );
  };

  /**
   * Analysis job lifecycle, shared by all content scripts and read by the popup.
   *
   *   idle --claim (service worker grants lease)--> running(stage, heartbeat)
   *        --finish ok--> succeeded | --finish error--> failed
   *   running without heartbeat for STALE_MS = interrupted; the lease can be
   *   taken over, and the old owner is fenced (its later writes are refused).
   *
   * The background service worker is the only writer of these keys and
   * serializes claim/heartbeat/finish (background.js), so two tabs can never
   * both start a job for one platform. Content scripts only send messages.
   * If the worker or storage is unavailable, a start fails closed.
   *
   * Keys (chrome.storage.local, one set per platform):
   *   fcJob:<platform>    { id, platform, kind, owner, status, stage, startedAt, heartbeatAt, endedAt, error }
   *   fcResult:<platform> last *successful* analysis result only
   *   fcError:<platform>  last analysis failure { error, at, jobId, kind }, short and sanitized
   */
  globalThis.fcJobs = (() => {
    const STALE_MS = 120000;
    const HEARTBEAT_MS = 15000;
    const LEASE_LOST = "This analysis was taken over by a newer run.";
    const owner = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    let active = null;

    const keys = (platform) => ({
      job: `fcJob:${platform}`,
      result: `fcResult:${platform}`,
      error: `fcError:${platform}`,
    });

    const isActive = (job, now = Date.now()) =>
      Boolean(job && job.status === "running" && now - (job.heartbeatAt || job.startedAt || 0) < STALE_MS);

    const isInterrupted = (job, now = Date.now()) => Boolean(job && job.status === "running" && !isActive(job, now));

    async function read(key) {
      try {
        const got = await chrome.storage.local.get(key);
        return got?.[key] ?? null;
      } catch {
        return null;
      }
    }

    async function lease(payload) {
      try {
        return (await chrome.runtime.sendMessage({ type: "FC_JOB", owner, ...payload })) || null;
      } catch {
        return null; // worker unreachable
      }
    }

    function publicJob(job) {
      if (!job) return null;
      const { heartbeatTimer, fenced, ...rest } = job;
      return rest;
    }

    async function beat(job) {
      const res = await lease({ op: "heartbeat", platform: job.platform, jobId: job.id, stage: job.stage });
      if (res?.fenced) {
        job.fenced = true;
        clearInterval(job.heartbeatTimer);
      }
    }

    /** Claim the platform's job lease (extension-wide, via the service worker). */
    async function start(platform, kind) {
      if (active) return { ok: false, busy: true, job: publicJob(active) };
      const now = Date.now();
      const job = {
        id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        platform,
        kind,
        owner,
        status: "running",
        stage: "start",
        startedAt: now,
        heartbeatAt: now,
      };
      active = job; // also blocks concurrent messages inside this tab right away
      const res = await lease({ op: "claim", platform, kind, jobId: job.id });
      if (!res?.ok) {
        active = null;
        if (res?.busy) return { ok: false, busy: true, job: res.job };
        return {
          ok: false,
          error: "Could not reserve the analysis (extension background not reachable). Reload the tab and try again.",
        };
      }
      job.heartbeatTimer = setInterval(() => beat(job), HEARTBEAT_MS);
      return { ok: true, job };
    }

    /** Stage update from the running work; throws once the lease was lost. */
    function progress(job, stage) {
      if (!job) return;
      if (job.fenced) throw new Error(LEASE_LOST);
      job.heartbeatAt = Date.now();
      if (stage && stage !== job.stage) {
        job.stage = stage;
        beat(job);
      }
    }

    /** End the job; returns the worker's answer ({ok}, {fenced} or null if unreachable). */
    async function finish(job, outcome) {
      if (!job) return null;
      clearInterval(job.heartbeatTimer);
      try {
        return await lease({
          op: "finish",
          platform: job.platform,
          jobId: job.id,
          ok: Boolean(outcome.ok),
          result: outcome.ok ? outcome.result : undefined,
          error: outcome.ok ? undefined : outcome.error,
        });
      } finally {
        if (active === job) active = null;
      }
    }

    /** Run `work(report)` as the analysis job and broadcast PROGRESS / RESULT. */
    async function runAnalysis(platform, work) {
      const claim = await start(platform, "analyze");
      if (!claim.ok) return claim;
      const job = claim.job;
      const report = (msg) => {
        progress(job, msg?.stage);
        chrome.runtime.sendMessage({ ...msg, type: "PROGRESS", platform, jobId: job.id }).catch(() => {});
      };
      (async () => {
        let message;
        let answer;
        try {
          const result = { ...(await work(report)), type: "RESULT", ok: true, platform, jobId: job.id };
          answer = await finish(job, { ok: true, result });
          message = result;
        } catch (err) {
          const error = err?.message || String(err);
          answer = await finish(job, { ok: false, error });
          message = { type: "RESULT", ok: false, platform, jobId: job.id, error: answer?.error || error };
        }
        // A fenced (expired and taken over) job stays silent; its data is stale.
        if (answer?.fenced || job.fenced) return;
        chrome.runtime.sendMessage(message).catch(() => {});
      })();
      return { ok: true, started: true, jobId: job.id };
    }

    return { STALE_MS, HEARTBEAT_MS, owner, keys, isActive, isInterrupted, read, start, progress, finish, runAnalysis, current: () => publicJob(active) };
  })();

  globalThis.fcCompareLists = function fcCompareLists(following, followers) {
    const followerIds = new Set(followers.map((u) => u.id));
    const followingIds = new Set(following.map((u) => u.id));
    const mutual = [];
    const notFollowingBack = [];
    const notFollowedByMe = [];

    for (const u of following) {
      if (followerIds.has(u.id)) mutual.push(u);
      else notFollowingBack.push(u);
    }
    for (const u of followers) {
      if (!followingIds.has(u.id)) notFollowedByMe.push(u);
    }

    const byName = (a, b) =>
      (a.username || "").localeCompare(b.username || "", undefined, { sensitivity: "base" });
    mutual.sort(byName);
    notFollowingBack.sort(byName);
    notFollowedByMe.sort(byName);
    return { mutual, notFollowingBack, notFollowedByMe };
  };

  globalThis.fcBuildResult = function fcBuildResult(platform, me, following, followers) {
    const lists = fcCompareLists(following, followers);
    return {
      type: "RESULT",
      ok: true,
      platform,
      me,
      counts: {
        following: following.length,
        followers: followers.length,
        mutual: lists.mutual.length,
        notFollowingBack: lists.notFollowingBack.length,
        notFollowedByMe: lists.notFollowedByMe.length,
      },
      following,
      followers,
      mutual: lists.mutual,
      notFollowingBack: lists.notFollowingBack,
      notFollowedByMe: lists.notFollowedByMe,
      finishedAt: Date.now(),
    };
  };

  globalThis.fcAvatar = async function fcAvatar(imageUrl) {
    if (!imageUrl) return null;
    const res = await fetch(imageUrl, { credentials: "omit", referrerPolicy: "no-referrer" });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  globalThis.fcListen = function fcListen(platform, handlers) {
    if (globalThis.__fcListenerPlatform === platform) return;
    globalThis.__fcListenerPlatform = platform;

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === "PING") {
        sendResponse({ ok: true, platform });
        return false;
      }

      if (msg?.type === "GET_ME") {
        handlers
          .getMe()
          .then((me) => sendResponse({ ok: true, platform, me }))
          .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
      }

      if (msg?.type === "FETCH_AVATAR") {
        fcAvatar(msg.url)
          .then((dataUrl) => sendResponse({ ok: Boolean(dataUrl), dataUrl }))
          .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
      }

      if (msg?.type === "FRIENDSHIP") {
        sendResponse({
          ok: false,
          error: "This site has no direct unfollow. Safe mode opens the profile so you can do it yourself.",
        });
        return false;
      }

      if (msg?.type === "ANALYZE") {
        fcJobs
          .runAnalysis(platform, async (report) => {
            const payload = await handlers.analyze(report);
            return fcBuildResult(platform, payload.me, payload.following, payload.followers);
          })
          .then((res) => sendResponse(res.ok || !res.busy ? res : { ...res, error: "Analysis already running." }));
        return true;
      }

      return false;
    });
  };
}
