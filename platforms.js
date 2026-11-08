/**
 * Sites the popup can analyse from an already logged-in tab.
 * Direct unfollow exists only where the site's own follow endpoint is used
 * (Instagram). Other sites always open the profile.
 */
var PLATFORMS = [
  {
    id: "instagram",
    label: "Instagram",
    script: "content.js",
    bridge: "ig-bridge.js",
    shared: true,
    supportsDirectUnfollow: true,
    queries: ["https://www.instagram.com/*"],
    match(url) {
      return /^https:\/\/(www\.)?instagram\.com\//.test(url || "");
    },
    profileUrl(username) {
      return `https://www.instagram.com/${encodeURIComponent(username)}/`;
    },
  },
  {
    id: "github",
    label: "GitHub",
    script: "github.js",
    bridge: null,
    shared: true,
    supportsDirectUnfollow: false,
    queries: ["https://github.com/*"],
    match(url) {
      return /^https:\/\/github\.com\//.test(url || "");
    },
    profileUrl(username) {
      return `https://github.com/${encodeURIComponent(username)}`;
    },
  },
  {
    id: "bluesky",
    label: "Bluesky",
    script: "bluesky.js",
    bridge: null,
    shared: true,
    supportsDirectUnfollow: false,
    queries: ["https://bsky.app/*"],
    match(url) {
      return /^https:\/\/bsky\.app\//.test(url || "");
    },
    profileUrl(username) {
      const handle = String(username || "").replace(/^@/, "");
      return `https://bsky.app/profile/${encodeURIComponent(handle)}`;
    },
  },
];
