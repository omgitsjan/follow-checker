/**
 * GitHub content script. Reads public follower/following lists for the
 * logged-in user via the official REST API. Unfollow is manual (open profile).
 */
(() => {
  if (globalThis.__fcGithub) return;
  globalThis.__fcGithub = true;

  function mapUser(u) {
    return {
      id: String(u.id),
      username: u.login || "",
      fullName: "",
      profilePic: u.avatar_url || "",
      isPrivate: false,
      isVerified: false,
    };
  }

  async function ghJson(url) {
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      credentials: "omit",
    });
    if (res.status === 403 || res.status === 429) {
      const left = res.headers.get("x-ratelimit-remaining");
      if (left === "0") {
        throw new Error("GitHub rate limit reached. Wait a while and try again.");
      }
    }
    if (!res.ok) throw new Error(`GitHub responded with HTTP ${res.status}`);
    return res.json();
  }

  async function getMe() {
    const login = document.querySelector('meta[name="user-login"]')?.content || "";
    if (!login) {
      throw new Error("Log in on github.com and keep that tab open.");
    }
    const user = await ghJson(`https://api.github.com/users/${encodeURIComponent(login)}`);
    return {
      id: String(user.id),
      username: user.login || login,
      fullName: user.name || "",
      profilePic: user.avatar_url || "",
      followersCount: user.followers ?? null,
      followingCount: user.following ?? null,
    };
  }

  async function fetchList(login, kind, onProgress, expected) {
    const users = [];
    for (let page = 1; page <= 100; page += 1) {
      const batch = await ghJson(
        `https://api.github.com/users/${encodeURIComponent(login)}/${kind}?per_page=100&page=${page}`
      );
      if (!Array.isArray(batch) || batch.length === 0) break;
      users.push(...batch.map(mapUser));
      if (onProgress) onProgress(users.length);
      if (batch.length < 100) break;
      await fcSleep(400);
    }
    if (expected > 0 && users.length === 0) {
      throw new Error(
        `GitHub returned an empty ${kind} list even though the profile count is ${expected}.`
      );
    }
    return users;
  }

  async function analyze(onProgress) {
    const me = await getMe();
    onProgress({ type: "PROGRESS", stage: "user", me });
    const following = await fetchList(me.username, "following", (loaded) => {
      onProgress({
        type: "PROGRESS",
        stage: "following",
        loaded,
        total: me.followingCount,
      });
    }, me.followingCount);
    const followers = await fetchList(me.username, "followers", (loaded) => {
      onProgress({
        type: "PROGRESS",
        stage: "followers",
        loaded,
        total: me.followersCount,
      });
    }, me.followersCount);
    return { me, following, followers };
  }

  fcListen("github", { getMe, analyze });
})();
