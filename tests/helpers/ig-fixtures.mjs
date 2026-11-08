import { jsonResponse } from "./harness.mjs";

export const ME = { id: "12345", username: "tester" };

export function igUser(n) {
  return { pk: String(1000 + n), username: `user${n}`, full_name: `User ${n}`, profile_pic_url: "" };
}

/**
 * Fake Instagram router for content.js direct-fetch fallback. Lists come from
 * `lists.following` / `lists.followers` (arrays of igUser), single page each,
 * unless `overrides(url)` returns a response first.
 */
export function igRouter({ lists = {}, overrides } = {}) {
  return async (url) => {
    const custom = overrides ? await overrides(url) : undefined;
    if (custom) return custom;
    if (url.includes("graphql/query/?query_hash=")) {
      return jsonResponse({ data: { user: { id: ME.id, username: ME.username } } });
    }
    if (url.includes("web_profile_info/?username=tester")) {
      const following = lists.following?.length ?? 0;
      const followers = lists.followers?.length ?? 0;
      return jsonResponse({
        data: {
          user: {
            id: ME.id,
            username: ME.username,
            edge_followed_by: { count: followers },
            edge_follow: { count: following },
          },
        },
      });
    }
    if (url.includes("web_profile_info/?username=")) {
      return jsonResponse({ data: { user: { edge_followed_by: { count: 1 }, edge_follow: { count: 1 }, edge_owner_to_timeline_media: { count: 1 } } } });
    }
    const m = url.match(/friendships\/\d+\/(following|followers)\//);
    if (m) return jsonResponse({ users: lists[m[1]] || [], next_max_id: null });
    throw new Error(`unrouted fake IG url: ${url}`);
  };
}
