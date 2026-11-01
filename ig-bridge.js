/**
 * Page-world fetch bridge for instagram.com.
 * The content script asks for a same-origin fetch so the request uses the
 * logged-in page (cookies, referrer). It does not wrap Instagram's own traffic.
 */
(() => {
  if (globalThis.__fcIgBridge) return;
  globalThis.__fcIgBridge = true;

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
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
