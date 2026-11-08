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
    let running = false;

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
        if (running) {
          sendResponse({ ok: false, error: "Analysis already running." });
          return false;
        }
        running = true;
        (async () => {
          try {
            const payload = await handlers.analyze((progress) => {
              chrome.runtime.sendMessage(progress).catch(() => {});
            });
            const result = fcBuildResult(platform, payload.me, payload.following, payload.followers);
            try {
              await chrome.storage.local.set({ lastResult: result });
            } catch {
              /* ignore */
            }
            chrome.runtime.sendMessage(result).catch(() => {});
          } catch (err) {
            const fail = {
              type: "RESULT",
              ok: false,
              platform,
              error: err?.message || String(err),
            };
            try {
              await chrome.storage.local.set({ lastResult: fail });
            } catch {
              /* ignore */
            }
            chrome.runtime.sendMessage(fail).catch(() => {});
          } finally {
            running = false;
          }
        })();
        sendResponse({ ok: true, started: true });
        return false;
      }

      return false;
    });
  };
}
