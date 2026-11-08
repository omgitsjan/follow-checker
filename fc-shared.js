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
   *   idle --start [no fresh job]--> running(stage, heartbeat) --ok--> succeeded
   *                                                            \--error--> failed
   *   running with a heartbeat older than STALE_MS = interrupted (tab closed or
   *   reloaded mid-run); it no longer blocks a new start.
   *
   * Storage (chrome.storage.local, one key per platform so platforms never
   * overwrite each other):
   *   fcJob:<platform>    { id, platform, kind, owner, status, stage, startedAt, heartbeatAt, endedAt, error }
   *   fcResult:<platform> last *successful* result only
   *   fcError:<platform>  last failure { error, at, jobId }, kept apart from the result
   * Storage errors never wedge a job: the in-memory guard is always released.
   */
  globalThis.fcJobs = (() => {
    const STALE_MS = 120000;
    const HEARTBEAT_MS = 15000;
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

    async function write(items) {
      try {
        await chrome.storage.local.set(items);
        return true;
      } catch {
        return false;
      }
    }

    function publicJob(job) {
      if (!job) return null;
      const { heartbeatTimer, persist, ...rest } = job;
      return rest;
    }

    /** Claim the single job slot of this content script (and of the platform, across tabs). */
    async function start(platform, kind, { persist = true } = {}) {
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
        persist,
      };
      active = job; // claimed synchronously: concurrent messages see it immediately
      if (persist) {
        const existing = await read(keys(platform).job);
        if (existing && existing.owner !== owner && isActive(existing)) {
          active = null;
          return { ok: false, busy: true, job: existing };
        }
        await write({ [keys(platform).job]: publicJob(job) });
        job.heartbeatTimer = setInterval(() => {
          job.heartbeatAt = Date.now();
          write({ [keys(platform).job]: publicJob(job) });
        }, HEARTBEAT_MS);
      }
      return { ok: true, job };
    }

    function progress(job, stage) {
      if (!job || job.status !== "running") return;
      const changed = stage && stage !== job.stage;
      if (stage) job.stage = stage;
      job.heartbeatAt = Date.now();
      if (job.persist && changed) write({ [keys(job.platform).job]: publicJob(job) });
    }

    async function finish(job, outcome) {
      if (!job) return;
      clearInterval(job.heartbeatTimer);
      job.status = outcome.ok ? "succeeded" : "failed";
      job.endedAt = Date.now();
      if (!outcome.ok) job.error = outcome.error;
      try {
        if (job.persist) {
          const k = keys(job.platform);
          const items = { [k.job]: publicJob(job) };
          if (outcome.ok) items[k.result] = outcome.result;
          else items[k.error] = { error: outcome.error, at: job.endedAt, jobId: job.id, kind: job.kind };
          await write(items);
        }
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
        try {
          const result = { ...(await work(report)), type: "RESULT", ok: true, platform, jobId: job.id };
          await finish(job, { ok: true, result });
          message = result;
        } catch (err) {
          const error = err?.message || String(err);
          await finish(job, { ok: false, error });
          message = { type: "RESULT", ok: false, platform, jobId: job.id, error };
        }
        chrome.runtime.sendMessage(message).catch(() => {});
      })();
      return { ok: true, started: true, jobId: job.id };
    }

    return { STALE_MS, HEARTBEAT_MS, owner, keys, isActive, isInterrupted, read, write, start, progress, finish, runAnalysis, current: () => publicJob(active) };
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
          .then((res) => sendResponse(res.ok ? res : { ...res, error: "Analysis already running." }));
        return true;
      }

      return false;
    });
  };
}
