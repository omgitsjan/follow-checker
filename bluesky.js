/**
 * Bluesky content script. Reads follows through the public AT Protocol API
 * for the account open on bsky.app. Unfollow is manual (open profile).
 */
(() => {
  if (globalThis.__fcBluesky) return;
  globalThis.__fcBluesky = true;

  const API = "https://public.api.bsky.app/xrpc";

  function mapUser(u) {
    return {
      id: String(u.did || ""),
      username: u.handle || "",
      fullName: u.displayName || "",
      profilePic: u.avatar || "",
      isPrivate: false,
      isVerified: false,
    };
  }

  function selfFromPage() {
    let handle = "";
    let did = "";

    const link =
      document.querySelector('a[aria-label="Profile"][href^="/profile/"]') ||
      document.querySelector('nav a[href^="/profile/"]') ||
      document.querySelector('a[href^="/profile/"]');
    const href = link?.getAttribute("href") || "";
    const path = href.match(/^\/profile\/([^/?#]+)/);
    if (path) handle = decodeURIComponent(path[1]);

    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const raw = localStorage.getItem(localStorage.key(i)) || "";
        if (raw.length > 200000 || !raw.includes("did:plc:")) continue;
        const didMatch = raw.match(/did:plc:[a-z0-9]+/);
        const handleMatch = raw.match(/"handle"\s*:\s*"([^"]+)"/);
        if (didMatch) did = didMatch[0];
        if (handleMatch) handle = handleMatch[1];
        if (did && handle) break;
      }
    } catch {
      /* private storage */
    }

    if (!handle && !did) {
      throw new Error("Could not see your Bluesky account. Open bsky.app while logged in.");
    }
    return { handle, did };
  }

  async function bskyGet(method, params) {
    const url = new URL(`${API}/${method}`);
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }
    const res = await fcFetchText(url.toString(), { credentials: "omit" }, { label: "Bluesky request" });
    if (res.status === 429) {
      throw new Error("Bluesky rate-limited requests (429). Wait a minute and try again.");
    }
    if (!res.ok) throw new Error(`Bluesky responded with HTTP ${res.status}`);
    try {
      return JSON.parse(res.text);
    } catch {
      throw new Error("Bluesky returned a non-JSON response.");
    }
  }

  async function getMe() {
    const self = selfFromPage();
    const profile = await bskyGet("app.bsky.actor.getProfile", {
      actor: self.handle || self.did,
    });
    return {
      id: profile.did,
      username: profile.handle,
      fullName: profile.displayName || "",
      profilePic: profile.avatar || "",
      followersCount: profile.followersCount ?? null,
      followingCount: profile.followsCount ?? null,
    };
  }

  const MAX_PAGES = 200;

  async function fetchList(actor, method, listKey, onProgress, expected) {
    const users = [];
    const seen = new Set();
    const guard = fcPageGuard(`Bluesky ${listKey}`);
    let cursor = "";
    const add = (batch) => {
      const before = users.length;
      for (const user of batch.map(mapUser)) {
        if (!user.id || seen.has(user.id)) continue;
        seen.add(user.id);
        users.push(user);
      }
      return users.length - before;
    };
    for (let page = 0; ; page += 1) {
      const data = await bskyGet(method, { actor, limit: "100", cursor });
      const batch = Array.isArray(data[listKey]) ? data[listKey] : [];
      const added = add(batch);
      if (onProgress) onProgress(users.length);
      cursor = data.cursor || "";
      if (!cursor || batch.length === 0) break;
      if (page + 1 >= MAX_PAGES) {
        // A cursor is not proof of more data: one probe page decides.
        await fcSleep(350);
        const probe = await bskyGet(method, { actor, limit: "100", cursor });
        const probeBatch = Array.isArray(probe[listKey]) ? probe[listKey] : [];
        if (probeBatch.length > 0 && probe.cursor) throw fcIncompleteError(`Bluesky ${listKey}`, users.length);
        add(probeBatch);
        if (onProgress) onProgress(users.length);
        break;
      }
      guard.check(cursor, added, users.length);
      await fcSleep(350);
    }
    if (expected > 0 && users.length === 0) {
      throw new Error(
        `Bluesky returned an empty list even though the profile count is ${expected}.`
      );
    }
    return users;
  }

  async function analyze(onProgress) {
    const me = await getMe();
    onProgress({ type: "PROGRESS", stage: "user", me });
    const following = await fetchList(
      me.id,
      "app.bsky.graph.getFollows",
      "follows",
      (loaded) => {
        onProgress({
          type: "PROGRESS",
          stage: "following",
          loaded,
          total: me.followingCount,
        });
      },
      me.followingCount
    );
    const followers = await fetchList(
      me.id,
      "app.bsky.graph.getFollowers",
      "followers",
      (loaded) => {
        onProgress({
          type: "PROGRESS",
          stage: "followers",
          loaded,
          total: me.followersCount,
        });
      },
      me.followersCount
    );
    return { me, following, followers };
  }

  fcListen("bluesky", { getMe, analyze });
})();
