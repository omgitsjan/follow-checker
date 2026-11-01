/**
 * Content script – runs on instagram.com with the user's session.
 * Loads followers/following via the same web endpoints as Instagram.com.
 */

const IG_APP_ID = "936619743392459";
const PAGE_SIZE = 50;
const DELAY_MS = 900; // Pause zwischen Seiten, um Rate-Limits zu vermeiden

let igWwwClaim = "";
let igBridgeState = "unknown";
let igCsrfToken = "";
let igCookieLookupDone = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/** App id / ASBD / claim from the page Instagram already rendered. */
function scrapeIgBootstrap() {
  const found = { appId: "", asbd: "", claim: "", lsd: "", dtsg: "", csrf: "" };
  const scripts = document.querySelectorAll("script:not([src])");
  for (const script of scripts) {
    const text = script.textContent || "";
    if (text.length < 20) continue;
    if (!found.appId) {
      const match = text.match(/"(?:APP_ID|X-IG-App-ID|appId)"\s*:\s*"(\d{6,})"/);
      if (match) found.appId = match[1];
    }
    if (!found.asbd) {
      const match = text.match(/"(?:ASBD_ID|asbdId|asbd_id)"\s*:\s*"?(\d{4,})"?/);
      if (match) found.asbd = match[1];
    }
    if (!found.claim) {
      const match = text.match(/"www_claim"\s*:\s*"([^"]+)"/);
      if (match) found.claim = match[1];
    }
    if (!found.lsd) {
      const match = text.match(/"LSD"\s*,\s*\[\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/);
      if (match) found.lsd = match[1];
    }
    if (!found.dtsg) {
      const match = text.match(/"DTSGInitialData"\s*,\s*\[\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/);
      if (match) found.dtsg = match[1];
    }
    if (!found.csrf) {
      const match = text.match(/"csrf_token"\s*:\s*"([^"]{8,})"/);
      if (match) found.csrf = match[1];
    }
    if (found.appId && found.asbd && found.claim && found.lsd && found.dtsg && found.csrf) break;
  }
  return found;
}

function igHeaders() {
  const boot = scrapeIgBootstrap();
  const headers = {
    "x-ig-app-id": boot.appId || IG_APP_ID,
    "x-requested-with": "XMLHttpRequest",
    "x-csrftoken": getCookie("csrftoken") || igCsrfToken || boot.csrf || "",
    Accept: "*/*",
  };
  if (boot.asbd) headers["x-asbd-id"] = boot.asbd;
  headers["x-ig-www-claim"] = igWwwClaim || boot.claim || "0";
  if (boot.lsd) headers["x-fb-lsd"] = boot.lsd;
  return headers;
}

function pageFetch(url, options) {
  if (igBridgeState === "missing") {
    return Promise.reject(new Error("bridge-missing"));
  }
  return new Promise((resolve, reject) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      if (igBridgeState !== "ok") igBridgeState = "missing";
      reject(new Error("bridge-missing"));
    }, igBridgeState === "ok" ? 20000 : 1500);

    function onMessage(event) {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== "fc-bridge" || data.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      if (data.error) {
        reject(new Error(data.error));
        return;
      }
      igBridgeState = "ok";
      resolve(data);
    }

    window.addEventListener("message", onMessage);
    window.postMessage(
      {
        source: "fc-content",
        type: "FC_FETCH",
        id,
        url,
        method: options.method || "GET",
        headers: options.headers || {},
        body: options.body || null,
      },
      location.origin
    );
  });
}

function parseIgBody(status, text) {
  const trimmed = String(text || "").replace(/^(\)\]\}'|for\s*\(;;\);)+/, "").trim();
  if (/^<!DOCTYPE|^<html/i.test(trimmed)) {
    throw new Error(
      "Instagram returned a page instead of data. Reload instagram.com and make sure you are logged in."
    );
  }
  if (status === 401 || status === 403) {
    throw new Error("Not logged in or blocked. Log in on instagram.com and try again later.");
  }
  if (status === 429) {
    throw new Error("Instagram rate-limited requests (429). Wait a few minutes and try again.");
  }
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    throw new Error(status ? `HTTP ${status}: non-JSON response` : "Instagram returned a non-JSON response.");
  }
  if (!status || status >= 400) {
    const detail = data?.message ? String(data.message).slice(0, 160) : "";
    throw new Error(detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`);
  }
  if (data?.status === "fail" || data?.require_login || data?.checkpoint_required) {
    throw new Error(
      data.message ||
        "Instagram refused the request. Resolve any checkpoint in the tab, then try again."
    );
  }
  return data;
}

async function igFetch(url, options = {}) {
  const method = options.method || "GET";
  if (!getCookie("csrftoken") && !igCsrfToken && !igCookieLookupDone) await getIgCookies();
  const headers = {
    ...igHeaders(),
    ...(options.headers || {}),
  };

  let status;
  let text;
  let responseHeaders = {};
  try {
    const bridged = await pageFetch(url, { method, headers, body: options.body || null });
    status = bridged.status;
    text = bridged.text || "";
    responseHeaders = bridged.headers || {};
  } catch (err) {
    if (err?.message !== "bridge-missing") throw err;
    const res = await fetch(url, {
      method,
      credentials: "include",
      headers,
      body: options.body,
      referrer: location.href,
    });
    status = res.status;
    text = await res.text();
    const claim = res.headers.get("x-ig-set-www-claim");
    if (claim) responseHeaders["x-ig-set-www-claim"] = claim;
  }

  if (responseHeaders["x-ig-set-www-claim"]) {
    igWwwClaim = responseHeaders["x-ig-set-www-claim"];
  }
  return parseIgBody(status, text);
}

/** Follow / unfollow / remove follower via Instagram web endpoints */
async function friendshipAction(userId, action) {
  // action: "create" | "destroy" | "remove_follower"
  let url;
  if (action === "remove_follower") {
    // Web UI: remove someone from your followers
    url = `https://www.instagram.com/api/v1/web/friendships/${userId}/remove_follower/`;
  } else {
    url = `https://www.instagram.com/api/v1/friendships/${action}/${userId}/`;
  }

  let data;
  try {
    data = await igFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-instagram-ajax": "1",
      },
      body: "",
    });
  } catch (err) {
    // Fallback path used by some website builds
    if (action === "remove_follower") {
      data = await igFetch(
        `https://www.instagram.com/api/v1/friendships/remove_follower/${userId}/`,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-instagram-ajax": "1",
          },
          body: "",
        }
      );
    } else {
      throw err;
    }
  }

  if (data?.status && data.status !== "ok") {
    throw new Error(data.message || `Action failed (${data.status})`);
  }

  // friendship_status.following / outgoing_request / followed_by
  const fs = data?.friendship_status || {};
  return {
    ok: true,
    following: Boolean(fs.following),
    outgoingRequest: Boolean(fs.outgoing_request),
    followedBy: fs.followed_by === undefined ? undefined : Boolean(fs.followed_by),
    raw: data,
  };
}

/** Profilbild als Data-URL laden (falls CDN im Popup blockt) */
async function fetchImageAsDataUrl(imageUrl) {
  if (!imageUrl) return null;
  try {
    const res = await fetch(imageUrl, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------- */
/* Account detection                                                          */
/* Instagram keeps moving where the logged-in user is exposed. Every source   */
/* below is optional; the first one that yields an id + username wins.        */
/* ------------------------------------------------------------------------- */

const IG_RESERVED_PATHS = new Set([
  "accounts", "explore", "reels", "reel", "direct", "stories", "p", "tv",
  "about", "legal", "developer", "challenge", "emails", "session", "web",
  "api", "graphql", "privacy", "terms", "lite", "nametag", "directory", "ar",
]);
const IG_VIEWER_QUERY_HASH = "d6f4427fbe92d846298cf93df0b937d3";
const IG_PROFILE_DOC_ID = "25980296051578533"; // PolarisProfilePageContentQuery

function isIgUserId(value) {
  return /^\d{3,25}$/.test(String(value || ""));
}

function isIgUsername(value) {
  const v = String(value || "");
  return /^[A-Za-z0-9._]{1,30}$/.test(v) && !IG_RESERVED_PATHS.has(v.toLowerCase());
}

function decodeJsonString(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

/** ds_user_id / csrftoken – document.cookie first, then the extension cookie API (HttpOnly-safe). */
async function getIgCookies() {
  const out = {
    dsUserId: getCookie("ds_user_id") || "",
    csrftoken: getCookie("csrftoken") || igCsrfToken || "",
  };
  if (!isIgUserId(out.dsUserId) || !out.csrftoken) {
    igCookieLookupDone = true;
    try {
      const res = await chrome.runtime.sendMessage({ type: "FC_IG_COOKIES" });
      if (res?.ok) {
        if (!isIgUserId(out.dsUserId) && isIgUserId(res.dsUserId)) out.dsUserId = res.dsUserId;
        if (!out.csrftoken && res.csrftoken) out.csrftoken = res.csrftoken;
      }
    } catch {
      /* background not reachable (e.g. extension reloaded) */
    }
  }
  if (!isIgUserId(out.dsUserId)) out.dsUserId = "";
  if (out.csrftoken) igCsrfToken = out.csrftoken;
  return out;
}

/** Viewer data from the page's own JS modules (MAIN world via ig-bridge.js). */
function bridgeViewer() {
  if (igBridgeState === "missing") return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve(null);
    }, 1500);
    function onMessage(event) {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== "fc-bridge" || data.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(data.viewer || null);
    }
    window.addEventListener("message", onMessage);
    window.postMessage({ source: "fc-content", type: "FC_VIEWER", id }, location.origin);
  });
}

/** Viewer data from inline JSON Instagram ships with the page. */
function scrapeViewerFromPage() {
  const found = { ids: [], username: "", fullName: "", profilePic: "", csrf: "" };
  const addId = (v) => {
    if (isIgUserId(v) && !found.ids.includes(v)) found.ids.push(v);
  };
  const readBlock = (text, start) => {
    const block = text.slice(start, start + 4000);
    const id = block.match(/"(?:id|pk|user_id)"\s*:\s*"?(\d{3,25})"?/);
    const username = block.match(/"username"\s*:\s*"([A-Za-z0-9._]{1,30})"/);
    const fullName = block.match(/"full_name"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const pic = block.match(/"profile_pic_url(?:_hd)?"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return {
      id: id ? id[1] : "",
      username: username ? username[1] : "",
      fullName: fullName ? decodeJsonString(fullName[1]) : "",
      profilePic: pic ? decodeJsonString(pic[1]) : "",
    };
  };

  const scripts = document.querySelectorAll("script:not([src])");
  for (const script of scripts) {
    const text = script.textContent || "";
    if (text.length < 20) continue;

    // Viewer objects (PolarisViewer module, XIGSharedData config.viewer)
    for (const marker of ['"PolarisViewer"', '"viewer":{', '"viewer": {']) {
      let idx = text.indexOf(marker);
      while (idx !== -1 && !found.username) {
        const block = readBlock(text, idx);
        if (block.username && isIgUsername(block.username)) {
          addId(block.id);
          found.username = block.username;
          found.fullName = block.fullName;
          found.profilePic = block.profilePic;
        }
        idx = text.indexOf(marker, idx + marker.length);
      }
    }

    for (const re of [
      /"viewerId"\s*:\s*"(\d{3,25})"/,
      /"viewer_id"\s*:\s*"(\d{3,25})"/,
      /"NON_FACEBOOK_USER_ID"\s*:\s*"(\d{3,25})"/,
    ]) {
      const m = text.match(re);
      if (m) addId(m[1]);
    }

    if (!found.csrf) {
      const m = text.match(/"csrf_token"\s*:\s*"([^"]{8,})"/);
      if (m) found.csrf = m[1];
    }
  }
  return found;
}

/** Last resort: the profile link in Instagram's nav whose avatar alt text names the user. */
function scrapeUsernameFromNav() {
  const links = document.querySelectorAll('nav a[href^="/"], [role="navigation"] a[href^="/"]');
  for (const a of links) {
    const m = (a.getAttribute("href") || "").match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
    if (!m || !isIgUsername(m[1])) continue;
    const img = a.querySelector("img[alt]");
    const alt = (img?.getAttribute("alt") || "").toLowerCase();
    if (alt.includes(m[1].toLowerCase())) return m[1];
  }
  return "";
}

function meFromUserObject(u, fallbackId = "") {
  if (!u) return null;
  const id = String(u.pk || u.id || u.pk_id || fallbackId || "");
  if (!isIgUserId(id) && !u.username) return null;
  return {
    id: isIgUserId(id) ? id : "",
    username: u.username || "",
    fullName: u.full_name || "",
    profilePic: u.profile_pic_url_hd || u.hd_profile_pic_url_info?.url || u.profile_pic_url || "",
    followersCount: u.follower_count ?? u.edge_followed_by?.count ?? null,
    followingCount: u.following_count ?? u.edge_follow?.count ?? null,
  };
}

async function fetchProfileByUsername(username) {
  const data = await igFetch(
    `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`
  );
  return meFromUserObject(data?.data?.user);
}

async function fetchProfileByIdGraphql(userId) {
  const boot = scrapeIgBootstrap();
  const params = new URLSearchParams({
    variables: JSON.stringify({ id: String(userId), render_surface: "PROFILE" }),
    doc_id: IG_PROFILE_DOC_ID,
    server_timestamps: "true",
  });
  if (boot.lsd) params.set("lsd", boot.lsd);
  if (boot.dtsg) params.set("fb_dtsg", boot.dtsg);
  const data = await igFetch("https://www.instagram.com/graphql/query", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  return meFromUserObject(data?.data?.user, userId);
}

async function getCurrentUser() {
  const errors = [];
  const attempt = async (label, fn) => {
    try {
      return await fn();
    } catch (err) {
      errors.push(`${label}: ${err?.message || err}`);
      return null;
    }
  };

  // --- 1) Id candidates without extra API calls ---
  const cookies = await getIgCookies();
  const page = scrapeViewerFromPage();
  if (page.csrf && !igCsrfToken && !getCookie("csrftoken")) igCsrfToken = page.csrf;
  const bridged = await bridgeViewer();

  const ids = [];
  const addId = (v) => {
    if (isIgUserId(v) && !ids.includes(String(v))) ids.push(String(v));
  };
  addId(cookies.dsUserId);
  addId(bridged?.id);
  page.ids.forEach(addId);
  const userId = ids[0] || "";

  const finish = (profile, base) => ({
    ...profile,
    fullName: profile.fullName || base?.fullName || "",
    profilePic: profile.profilePic || base?.profilePic || "",
  });

  /**
   * Resolve a username to the full profile. `strong` = the source is known to
   * describe the logged-in viewer; weak hints must match the known user id.
   */
  const resolve = async (base, strong) => {
    if (!base?.username) return null;
    const profile = await attempt("web_profile_info", () => fetchProfileByUsername(base.username));
    if (profile?.id) {
      if (strong || !userId || profile.id === userId) return finish(profile, base);
      return null; // weak hint pointed at someone else
    }
    if (!strong) return null;
    const id = base.id || userId;
    if (!id) return null;
    let counts = base;
    if (counts.followersCount == null) {
      counts = (await attempt("profile query", () => fetchProfileByIdGraphql(id))) || base;
    }
    return {
      id,
      username: base.username,
      fullName: base.fullName || counts.fullName || "",
      profilePic: base.profilePic || counts.profilePic || "",
      followersCount: counts.followersCount ?? null,
      followingCount: counts.followingCount ?? null,
    };
  };

  // --- 2) Sources, cheapest / most reliable first ---
  const sources = [
    // Instagram's own JS modules in the page (MAIN world)
    async () =>
      bridged?.username && isIgUsername(bridged.username)
        ? [meFromUserObject({ id: bridged.id, username: bridged.username, full_name: bridged.fullName, profile_pic_url: bridged.profilePic }, userId), true]
        : null,
    // Inline viewer JSON in the HTML
    async () =>
      page.username
        ? [meFromUserObject({ id: page.ids[0], username: page.username, full_name: page.fullName, profile_pic_url: page.profilePic }, userId), false]
        : null,
    // Legacy viewer GraphQL query (still used by instaloader's login check)
    async () => {
      const data = await igFetch(
        `https://www.instagram.com/graphql/query/?query_hash=${IG_VIEWER_QUERY_HASH}&variables=%7B%7D`
      );
      return [meFromUserObject(data?.data?.user, userId), true];
    },
    // Edit-profile form data (web endpoint, logged-in user only)
    async () => {
      const data = await igFetch("https://www.instagram.com/api/v1/accounts/edit/web_form_data/");
      const f = data?.form_data;
      return f?.username ? [meFromUserObject({ username: f.username, full_name: f.first_name }, userId), true] : null;
    },
    // Old user info endpoint (fails with "useragent mismatch" on many web sessions)
    async () => {
      if (!userId) return null;
      const data = await igFetch(`https://www.instagram.com/api/v1/users/${userId}/info/`);
      return [meFromUserObject(data?.user, userId), true];
    },
    // Profile GraphQL query by id
    async () => (userId ? [await fetchProfileByIdGraphql(userId), true] : null),
    // Avatar link in Instagram's navigation
    async () => {
      const name = scrapeUsernameFromNav();
      return name ? [{ id: "", username: name }, false] : null;
    },
    // Profile URL of the current tab
    async () => {
      const m = location.pathname.match(/^\/([A-Za-z0-9._]+)\/?$/);
      return m && isIgUsername(m[1]) ? [{ id: "", username: m[1] }, false] : null;
    },
  ];

  const tried = new Set();
  for (const [i, source] of sources.entries()) {
    const hit = await attempt(`source ${i + 1}`, source);
    if (!hit || !hit[0]?.username) continue;
    const key = hit[0].username.toLowerCase();
    if (tried.has(key) && !hit[1]) continue;
    tried.add(key);
    const me = await resolve(hit[0], hit[1]);
    if (me?.id) return me;
  }

  // Logged-in id but Instagram would not reveal the username: lists still work by id.
  if (userId) {
    if (errors.length) console.warn("[Follow Checker] username lookup failed:", errors);
    return {
      id: userId,
      username: "",
      fullName: "",
      profilePic: "",
      followersCount: null,
      followingCount: null,
    };
  }

  if (errors.length) console.warn("[Follow Checker] account detection failed:", errors);
  throw new Error(
    "Could not detect your account. Reload instagram.com while logged in, open your profile once, then try again."
  );
}

function pickProfilePic(u) {
  const raw =
    u.profile_pic_url_hd ||
    u.profile_pic_url ||
    u.hd_profile_pic_url_info?.url ||
    u.profile_pic_url_info?.url ||
    (Array.isArray(u.hd_profile_pic_versions) && u.hd_profile_pic_versions[0]?.url) ||
    "";
  if (!raw) return "";
  if (raw.startsWith("//")) return `https:${raw}`;
  return raw;
}

function mapUser(u) {
  const followerCount =
    u.follower_count ?? u.followers_count ?? u.edge_followed_by?.count ?? null;
  const followingCount =
    u.following_count ?? u.follow_count ?? u.edge_follow?.count ?? null;
  const mediaCount =
    u.media_count ?? u.total_igtv_videos ?? u.edge_owner_to_timeline_media?.count ?? null;

  return {
    id: String(u.pk ?? u.id ?? u.pk_id ?? ""),
    username: u.username || "",
    fullName: u.full_name || "",
    profilePic: pickProfilePic(u),
    isPrivate: Boolean(u.is_private),
    isVerified: Boolean(u.is_verified),
    hasAnonymousProfilePic: Boolean(
      u.has_anonymous_profile_picture || u.is_anonymous_profile_picture
    ),
    followerCount: followerCount != null ? Number(followerCount) : null,
    followingCount: followingCount != null ? Number(followingCount) : null,
    mediaCount: mediaCount != null ? Number(mediaCount) : null,
  };
}

function shortCodeFromId(idOrCode) {
  const s = String(idOrCode || "");
  // Media pk often "123_456" — shortcode is separate `code` field when present
  if (/^[A-Za-z0-9_-]+$/.test(s) && !s.includes("_")) return s;
  return s.split("_")[0] || s;
}

function mapMediaItem(item, fallbackAuthor = null) {
  const user = item.user || item.owner || fallbackAuthor || {};
  const captionObj = item.caption;
  const caption =
    (typeof captionObj === "object" && captionObj?.text) ||
    (typeof captionObj === "string" ? captionObj : "") ||
    item.accessibility_caption ||
    "";
  const thumb =
    item.image_versions2?.candidates?.[0]?.url ||
    item.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url ||
    item.thumbnail_url ||
    "";
  const code = item.code || shortCodeFromId(item.pk ?? item.id ?? "");
  const id = String(item.pk ?? item.id ?? code);
  const likeCount = item.like_and_view_counts_disabled
    ? null
    : item.like_count != null
      ? Number(item.like_count)
      : null;
  const commentCount =
    item.comment_count != null ? Number(item.comment_count) : null;
  const playCount =
    item.play_count ?? item.ig_play_count ?? item.view_count ?? item.video_view_count ?? null;

  return {
    id,
    code: String(code),
    caption: typeof caption === "string" ? caption : "",
    thumb: thumb.startsWith("//") ? `https:${thumb}` : thumb,
    takenAt: item.taken_at || item.device_timestamp || null,
    likeCount: likeCount != null ? Number(likeCount) : null,
    commentCount: commentCount != null ? Number(commentCount) : null,
    playCount: playCount != null ? Number(playCount) : null,
    mediaType: item.media_type ?? null, // 1 image, 2 video, 8 carousel
    productType: item.product_type || "",
    author: {
      id: String(user.pk ?? user.id ?? ""),
      username: user.username || "",
      fullName: user.full_name || "",
      profilePic: pickProfilePic(user),
    },
    permalink: `https://www.instagram.com/p/${encodeURIComponent(String(code))}/`,
  };
}

function engagementScore(p) {
  return (p.likeCount || 0) + (p.commentCount || 0) * 3;
}

function sortPostsByEngagement(posts) {
  return [...posts].sort((a, b) => {
    const d = engagementScore(b) - engagementScore(a);
    if (d !== 0) return d;
    return (b.takenAt || 0) - (a.takenAt || 0);
  });
}

function sortPostsByRecency(posts) {
  return [...posts].sort((a, b) => (b.takenAt || 0) - (a.takenAt || 0));
}

function mapGraphMediaNode(n, meAuthor) {
  return mapMediaItem(
    {
      pk: n.id,
      id: n.id,
      code: n.shortcode,
      caption: n.edge_media_to_caption?.edges?.[0]?.node?.text || n.caption || "",
      taken_at: n.taken_at_timestamp || n.taken_at,
      like_count: n.edge_liked_by?.count ?? n.edge_media_preview_like?.count,
      comment_count: n.edge_media_to_comment?.count,
      thumbnail_url: n.thumbnail_src || n.display_url,
      image_versions2: n.display_url
        ? { candidates: [{ url: n.display_url }] }
        : undefined,
      media_type: n.is_video ? 2 : 1,
      user: meAuthor,
    },
    meAuthor
  );
}

/** First page via web_profile_info (often works when feed/user fails). */
async function fetchOwnPostsViaWebProfile(username, meAuthor) {
  if (!username) return [];
  const data = await igFetch(
    `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`
  );
  const user = data?.data?.user;
  const edges = user?.edge_owner_to_timeline_media?.edges || [];
  return edges.map((e) => mapGraphMediaNode(e.node || e, meAuthor));
}

/** GraphQL user media (legacy query_hash still works for many sessions). */
async function fetchOwnPostsViaGraphql(userId, meAuthor, onProgress, maxPages = 5) {
  const results = [];
  let after = null;
  for (let page = 1; page <= maxPages; page++) {
    const variables = { id: String(userId), first: 12, after };
    const url =
      "https://www.instagram.com/graphql/query/?query_hash=69cba40317214236af40e7efa697781d&variables=" +
      encodeURIComponent(JSON.stringify(variables));
    const data = await igFetch(url);
    const conn = data?.data?.user?.edge_owner_to_timeline_media;
    const edges = conn?.edges || [];
    for (const e of edges) {
      results.push(mapGraphMediaNode(e.node || e, meAuthor));
    }
    if (onProgress) {
      onProgress({
        phase: "posts",
        loaded: results.length,
        page,
        hasMore: Boolean(conn?.page_info?.has_next_page),
      });
    }
    if (!conn?.page_info?.has_next_page) break;
    after = conn.page_info.end_cursor || null;
    if (!after) break;
    await sleep(DELAY_MS);
  }
  return results;
}

/**
 * Own posts with multiple strategies (feed/user often fails / 400).
 */
async function fetchOwnPosts(userId, onProgress, { maxPages = 8 } = {}) {
  let me = null;
  let meAuthor = null;
  try {
    me = await getCurrentUser();
    meAuthor = {
      pk: me.id,
      id: me.id,
      username: me.username,
      full_name: me.fullName,
      profile_pic_url: me.profilePic,
    };
    if (!userId) userId = me.id;
  } catch {
    /* continue */
  }

  if (!userId && !me?.username) {
    throw new Error("Could not resolve your account for posts. Stay logged in on instagram.com.");
  }

  const results = [];
  const seen = new Set();
  const pushAll = (list) => {
    for (const p of list) {
      if (!p?.id || seen.has(p.id)) continue;
      seen.add(p.id);
      results.push(p);
    }
  };

  const errors = [];

  // Strategy A: classic feed/user
  try {
    let maxId = null;
    let page = 0;
    do {
      page += 1;
      let url = `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(userId)}/?count=12`;
      if (maxId) url += `&max_id=${encodeURIComponent(maxId)}`;
      const data = await igFetch(url);
      const list = Array.isArray(data.items) ? data.items : [];
      pushAll(list.map((raw) => mapMediaItem(raw.media || raw, meAuthor)));
      if (onProgress) {
        onProgress({
          phase: "posts",
          loaded: results.length,
          page,
          hasMore: Boolean(data.more_available),
        });
      }
      maxId =
        data.next_max_id ||
        (data.more_available && list.length
          ? String(list[list.length - 1].pk || list[list.length - 1].id || "")
          : null);
      if (!maxId || !data.more_available || page >= maxPages) break;
      await sleep(DELAY_MS);
    } while (maxId);
  } catch (err) {
    errors.push(`feed/user: ${err?.message || err}`);
  }

  // Strategy B: web_profile_info
  if (!results.length) {
    try {
      const viaProfile = await fetchOwnPostsViaWebProfile(me?.username, meAuthor);
      pushAll(viaProfile);
      if (onProgress) {
        onProgress({
          phase: "posts",
          loaded: results.length,
          page: 1,
          hasMore: false,
          note: "web_profile",
        });
      }
    } catch (err) {
      errors.push(`web_profile: ${err?.message || err}`);
    }
  }

  // Strategy C: GraphQL user media
  if (!results.length && userId) {
    try {
      const viaGql = await fetchOwnPostsViaGraphql(
        userId,
        meAuthor,
        onProgress,
        Math.min(5, maxPages)
      );
      pushAll(viaGql);
    } catch (err) {
      errors.push(`graphql: ${err?.message || err}`);
    }
  }

  if (!results.length) {
    throw new Error(
      `Could not load your posts. ${errors.join(" · ") || "Unknown error"}. Open your profile on instagram.com and try again.`
    );
  }

  return sortPostsByEngagement(results);
}

/** Likers of one media id (pk). */
async function fetchMediaLikers(mediaId) {
  const id = encodeURIComponent(String(mediaId).split("_")[0] || mediaId);
  const urls = [
    `https://www.instagram.com/api/v1/media/${id}/likers/`,
    `https://www.instagram.com/api/v1/media/${encodeURIComponent(mediaId)}/likers/`,
  ];
  let lastErr = null;
  for (const url of urls) {
    try {
      const data = await igFetch(url);
      return (data.users || []).map(mapUser);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("Likers unavailable");
}

/**
 * Load own posts + rank fans by how many of your recent posts they liked.
 * Tie-break: likes on newer posts rank higher (recency score).
 */
async function analyzeOwnPostsWithFans(onProgress, options = {}) {
  const maxPostPages = options.maxPostPages ?? 6;
  const maxPostsForLikers = options.maxPostsForLikers ?? 12;

  const me = await getCurrentUser();
  const postsRanked = await fetchOwnPosts(me.id, onProgress, {
    maxPages: maxPostPages,
  });

  // Recency order (newest first) for weight assignment
  const chronological = sortPostsByRecency(postsRanked);
  const scan = chronological.slice(0, maxPostsForLikers);
  const n = scan.length;

  /** @type {Map<string, {user: object, count: number, recencyScore: number, postIds: string[]}>} */
  const fanMap = new Map();

  for (let i = 0; i < n; i++) {
    const post = scan[i];
    // Newer posts get higher weight → win ties when like-counts equal
    const weight = n - i;
    if (onProgress) {
      onProgress({
        phase: "likers",
        postIndex: i + 1,
        postTotal: n,
        loaded: postsRanked.length,
        fans: fanMap.size,
      });
    }
    try {
      const likers = await fetchMediaLikers(post.id);
      for (const u of likers) {
        if (!u.id || u.id === me.id) continue;
        let entry = fanMap.get(u.id);
        if (!entry) {
          entry = { user: u, count: 0, recencyScore: 0, postIds: [] };
          fanMap.set(u.id, entry);
        }
        if (!entry.postIds.includes(post.id)) {
          entry.count += 1;
          entry.recencyScore += weight;
          entry.postIds.push(post.id);
          // Prefer richer profile fields if later liker payload has more
          if (!entry.user.profilePic && u.profilePic) entry.user = u;
        }
      }
    } catch {
      // skip post if likers blocked
    }
    await sleep(DELAY_MS);
  }

  const topFans = [...fanMap.values()]
    .map((e) => ({
      ...e.user,
      postsLiked: e.count,
      recencyScore: e.recencyScore,
      likedPostIds: e.postIds,
    }))
    .sort((a, b) => {
      if (b.postsLiked !== a.postsLiked) return b.postsLiked - a.postsLiked;
      if (b.recencyScore !== a.recencyScore) return b.recencyScore - a.recencyScore;
      return (a.username || "").localeCompare(b.username || "");
    });

  return {
    posts: postsRanked,
    chronological,
    topFans,
    postsScannedForLikers: n,
    me,
  };
}

function listPayload(data) {
  if (Array.isArray(data?.users)) {
    return {
      users: data.users,
      next: data.next_max_id ? String(data.next_max_id) : null,
    };
  }
  const buckets = data?.data && typeof data.data === "object" ? Object.values(data.data) : [];
  for (const node of buckets) {
    if (node && Array.isArray(node.users)) {
      return {
        users: node.users,
        next: node.next_max_id ? String(node.next_max_id) : null,
      };
    }
  }
  return { users: [], next: null };
}

async function fetchListPage(userId, type, maxId, variant, count) {
  let url = `https://www.instagram.com/api/v1/friendships/${userId}/${type}/?count=${count}`;
  if (variant === "surface") url += "&search_surface=follow_list_page";
  if (maxId) url += `&max_id=${encodeURIComponent(maxId)}`;
  return listPayload(await igFetch(url));
}

async function fetchList(userId, type, onProgress, expectedCount = null) {
  const results = [];
  const seen = new Set();
  let maxId = null;
  let page = 0;
  let variant = "plain";
  const expected = Number(expectedCount);
  const expectSome = Number.isFinite(expected) && expected > 0;

  do {
    page += 1;
    let payload;
    try {
      payload = await fetchListPage(userId, type, maxId, variant, PAGE_SIZE);
    } catch (err) {
      const message = String(err?.message || err);
      if (page === 1 && variant === "plain" && /HTTP 400|HTTP 404/.test(message)) {
        variant = "surface";
        payload = await fetchListPage(userId, type, maxId, variant, 25);
      } else {
        throw err;
      }
    }

    if (page === 1 && variant === "plain" && payload.users.length === 0 && expectSome) {
      variant = "surface";
      payload = await fetchListPage(userId, type, null, "surface", 25);
    }

    if (page === 1 && payload.users.length === 0 && expectSome) {
      throw new Error(
        `Instagram returned an empty ${type} list even though the profile count is ${expected}. Reload instagram.com while logged in, open your profile once, then start again.`
      );
    }

    for (const user of payload.users.map(mapUser)) {
      if (!user.id || seen.has(user.id)) continue;
      seen.add(user.id);
      results.push(user);
    }

    if (onProgress) {
      onProgress({
        type,
        loaded: results.length,
        page,
        hasMore: Boolean(payload.next),
      });
    }

    maxId = payload.next;
    if (!maxId) break;
    await sleep(DELAY_MS);
  } while (maxId);

  return results;
}

function applyProfileInfoToUser(u, info) {
  if (!info) return false;
  let changed = false;
  // REST user object
  if (info.follower_count != null) {
    u.followerCount = Number(info.follower_count);
    changed = true;
  }
  if (info.following_count != null) {
    u.followingCount = Number(info.following_count);
    changed = true;
  }
  if (info.media_count != null) {
    u.mediaCount = Number(info.media_count);
    changed = true;
  }
  // web_profile_info graph shape
  if (info.edge_followed_by?.count != null) {
    u.followerCount = Number(info.edge_followed_by.count);
    changed = true;
  }
  if (info.edge_follow?.count != null) {
    u.followingCount = Number(info.edge_follow.count);
    changed = true;
  }
  if (info.edge_owner_to_timeline_media?.count != null) {
    u.mediaCount = Number(info.edge_owner_to_timeline_media.count);
    changed = true;
  }
  if (info.is_private != null) u.isPrivate = Boolean(info.is_private);
  if (info.is_verified != null) u.isVerified = Boolean(info.is_verified);
  if (info.has_anonymous_profile_picture != null) {
    u.hasAnonymousProfilePic = Boolean(info.has_anonymous_profile_picture);
  }
  if (!u.profilePic && (info.profile_pic_url || info.profile_pic_url_hd)) {
    u.profilePic = pickProfilePic(info);
  }
  if (!u.fullName && info.full_name) u.fullName = info.full_name;
  return changed;
}

/**
 * Fill missing public counts. List API almost never includes them on web.
 * Prefer web_profile_info by username (more reliable than users/{id}/info on web).
 */
async function enrichUsersWithCounts(users, onProgress, { max = 120, delayMs = 550 } = {}) {
  const targets = (users || []).filter(
    (u) =>
      u.username &&
      (u.followerCount == null ||
        u.followingCount == null ||
        u.mediaCount == null)
  );
  // Prefer sparse / digit-heavy accounts so bot heuristics get counts where useful
  targets.sort((a, b) => {
    const hint = (u) => {
      let s = 0;
      const un = (u.username || "").toLowerCase();
      if (u.hasAnonymousProfilePic || !u.profilePic) s += 3;
      if (/\d{4,}$/.test(un) || (un.match(/\d/g) || []).length >= 5) s += 3;
      if (!(u.fullName || "").trim()) s += 1;
      if (u.isPrivate) s += 1;
      return s;
    };
    return hint(b) - hint(a);
  });
  const slice = targets.slice(0, max);
  let ok = 0;
  for (let i = 0; i < slice.length; i++) {
    const u = slice[i];
    let got = false;
    // 1) web_profile_info (public profiles)
    try {
      const data = await igFetch(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(u.username)}`
      );
      got = applyProfileInfoToUser(u, data?.data?.user);
    } catch {
      /* try next */
    }
    // 2) users/{id}/info fallback
    if (!got && u.id) {
      try {
        const data = await igFetch(
          `https://www.instagram.com/api/v1/users/${encodeURIComponent(u.id)}/info/`
        );
        got = applyProfileInfoToUser(u, data?.user);
      } catch {
        /* skip */
      }
    }
    if (got) ok += 1;
    if (onProgress) {
      onProgress({ enriched: i + 1, total: slice.length, ok });
    }
    await sleep(delayMs);
  }
  return users;
}

function compareLists(following, followers) {
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
    a.username.localeCompare(b.username, undefined, { sensitivity: "base" });

  mutual.sort(byName);
  notFollowingBack.sort(byName);
  notFollowedByMe.sort(byName);

  return { mutual, notFollowingBack, notFollowedByMe };
}

let running = false;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "PING") {
    sendResponse({ ok: true, platform: "instagram" });
    return false;
  }

  if (msg?.type === "GET_ME") {
    (async () => {
      try {
        const me = await getCurrentUser();
        sendResponse({ ok: true, me });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "FRIENDSHIP") {
    // action: "follow" | "unfollow" | "remove_follower"
    (async () => {
      try {
        const userId = String(msg.userId || "");
        if (!userId) throw new Error("No user id.");
        let apiAction = "destroy";
        if (msg.action === "follow") apiAction = "create";
        else if (msg.action === "unfollow") apiAction = "destroy";
        else if (msg.action === "remove_follower") apiAction = "remove_follower";
        else throw new Error(`Unknown friendship action: ${msg.action}`);
        const result = await friendshipAction(userId, apiAction);
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true; // async sendResponse
  }

  if (
    msg?.type === "FETCH_OWN_POSTS" ||
    msg?.type === "FETCH_LIKED" ||
    msg?.type === "ANALYZE_OWN_POSTS"
  ) {
    (async () => {
      try {
        const onProgress = (p) => {
          chrome.runtime
            .sendMessage({
              type: "PROGRESS",
              stage: "posts",
              ...p,
            })
            .catch(() => {});
        };

        // Full analysis: posts ranked + fan ranking by likes on your posts
        const result = await analyzeOwnPostsWithFans(onProgress, {
          maxPostPages: msg.maxPages ?? 6,
          maxPostsForLikers: msg.maxPostsForLikers ?? 12,
        });

        sendResponse({
          ok: true,
          posts: result.posts,
          liked: result.posts,
          topFans: result.topFans,
          postsScannedForLikers: result.postsScannedForLikers,
          me: result.me,
          finishedAt: Date.now(),
        });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "FETCH_AVATAR") {
    (async () => {
      try {
        const dataUrl = await fetchImageAsDataUrl(msg.url);
        sendResponse({ ok: Boolean(dataUrl), dataUrl });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "ANALYZE") {
    if (running) {
      sendResponse({ ok: false, error: "Analysis already running." });
      return false;
    }

    running = true;
    (async () => {
      try {
        const me = await getCurrentUser();

        chrome.runtime
          .sendMessage({
            type: "PROGRESS",
            stage: "user",
            me,
          })
          .catch(() => {});

        const following = await fetchList(
          me.id,
          "following",
          (p) => {
            chrome.runtime
              .sendMessage({
                type: "PROGRESS",
                stage: "following",
                loaded: p.loaded,
                total: me.followingCount,
              })
              .catch(() => {});
          },
          me.followingCount
        );

        const followers = await fetchList(
          me.id,
          "followers",
          (p) => {
            chrome.runtime
              .sendMessage({
                type: "PROGRESS",
                stage: "followers",
                loaded: p.loaded,
                total: me.followersCount,
              })
              .catch(() => {});
          },
          me.followersCount
        );

        // Light enrich for bots heuristics only (charts use list buckets, no counts needed)
        await enrichUsersWithCounts(
          followers,
          (p) => {
            chrome.runtime
              .sendMessage({
                type: "PROGRESS",
                stage: "enrich",
                target: "followers",
                enriched: p.enriched,
                total: p.total,
                ok: p.ok,
              })
              .catch(() => {});
          },
          { max: 40, delayMs: 450 }
        );

        const lists = compareLists(following, followers);
        const result = {
          type: "RESULT",
          ok: true,
          platform: "instagram",
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

        // Persist if popup was closed
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
