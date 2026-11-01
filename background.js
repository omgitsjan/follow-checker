/**
 * Service worker – only job: read the two Instagram cookies the content script
 * needs (ds_user_id = your numeric account id, csrftoken = request header) when
 * Instagram marks them HttpOnly. Values are passed to the Instagram tab that
 * asked and are never stored or sent anywhere else. sessionid is never read.
 */
const IG_URL = "https://www.instagram.com/";
const IG_COOKIE_NAMES = ["ds_user_id", "csrftoken"];

function fromInstagramTab(sender) {
  if (sender?.id !== chrome.runtime.id) return false;
  const url = sender.url || sender.tab?.url || "";
  return /^https:\/\/www\.instagram\.com\//.test(url);
}

async function readCookie(name) {
  try {
    const cookie = await chrome.cookies.get({ url: IG_URL, name });
    return cookie?.value || "";
  } catch {
    return "";
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "FC_IG_COOKIES") return false;
  if (!fromInstagramTab(sender)) {
    sendResponse({ ok: false });
    return false;
  }
  (async () => {
    const [dsUserId, csrftoken] = await Promise.all(IG_COOKIE_NAMES.map(readCookie));
    sendResponse({
      ok: true,
      dsUserId: /^\d+$/.test(dsUserId) ? dsUserId : "",
      csrftoken,
    });
  })();
  return true;
});
