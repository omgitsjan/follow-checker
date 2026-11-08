/**
 * Page-world fetch bridge for instagram.com.
 * The content script asks for a same-origin fetch so the request uses the
 * logged-in page (cookies, referrer). It does not wrap Instagram's own traffic.
 * It can also read the logged-in viewer (id / username) from Instagram's own
 * page modules, because the isolated content script cannot see them.
 */
(() => {
  if (globalThis.__fcIgBridge) return;
  globalThis.__fcIgBridge = true;

  function pageModule(name) {
    try {
      const req = typeof window.require === "function" ? window.require : null;
      return req ? req(name) : null;
    } catch {
      return null;
    }
  }

  function str(value) {
    return value === undefined || value === null ? "" : String(value);
  }

  function readViewer() {
    const viewer = { id: "", username: "", fullName: "", profilePic: "" };
    const take = (u) => {
      if (!u || typeof u !== "object") return;
      if (!viewer.id) viewer.id = str(u.id || u.pk || u.pk_id || u.user_id);
      if (!viewer.username) viewer.username = str(u.username);
      if (!viewer.fullName) viewer.fullName = str(u.full_name || u.fullName);
      if (!viewer.profilePic) viewer.profilePic = str(u.profile_pic_url_hd || u.profile_pic_url);
    };

    const polaris = pageModule("PolarisViewer");
    if (polaris) {
      take(polaris.data);
      if (typeof polaris.get === "function") {
        try {
          take(polaris.get());
        } catch {
          /* ignore */
        }
      }
    }
    const shared = pageModule("XIGSharedData");
    take(shared?.native?.config?.viewer);
    take(shared?.config?.viewer);
    if (!viewer.id) {
      const current = pageModule("CurrentUserInitialData");
      const id = str(current?.NON_FACEBOOK_USER_ID);
      if (/^\d+$/.test(id) && id !== "0") viewer.id = id;
    }
    if (!/^\d+$/.test(viewer.id)) viewer.id = "";
    if (!/^[A-Za-z0-9._]{1,30}$/.test(viewer.username)) viewer.username = "";
    return viewer.id || viewer.username ? viewer : null;
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (msg && msg.source === "fc-content" && msg.type === "FC_PING" && msg.id) {
      // Presence probe: answer immediately, independent of any network request.
      window.postMessage({ source: "fc-bridge", type: "FC_PONG", id: msg.id }, location.origin);
      return;
    }
    if (msg && msg.source === "fc-content" && msg.type === "FC_VIEWER" && msg.id) {
      window.postMessage(
        { source: "fc-bridge", type: "FC_VIEWER_RESULT", id: msg.id, viewer: readViewer() },
        location.origin
      );
      return;
    }
    if (!msg || msg.source !== "fc-content" || msg.type !== "FC_FETCH" || !msg.id) return;
    if (typeof msg.url !== "string" || !msg.url.startsWith("https://www.instagram.com/")) return;

    const reply = { source: "fc-bridge", type: "FC_FETCH_RESULT", id: msg.id };
    try {
      const res = await fetch(msg.url, {
        method: msg.method || "GET",
        credentials: "include",
        headers: msg.headers || {},
        body: msg.body || undefined,
        referrer: location.href,
      });
      reply.status = res.status;
      reply.text = await res.text();
      const claim = res.headers.get("x-ig-set-www-claim");
      reply.headers = claim ? { "x-ig-set-www-claim": claim } : {};
    } catch (err) {
      reply.error = err?.message || String(err);
    }
    window.postMessage(reply, location.origin);
  });
})();
