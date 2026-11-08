/**
 * Service worker:
 * 1. Read the two Instagram cookies the content script needs (ds_user_id = your
 *    numeric account id, csrftoken = request header) when Instagram marks them
 *    HttpOnly. Values are passed to the Instagram tab that asked and are never
 *    stored or sent anywhere else. sessionid is never read.
 * 2. Coordinate analysis jobs across tabs (see "Analysis job lease" below).
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

/* ------------------------------------------------------------------------- */
/* Analysis job lease (one per platform, extension-wide)                      */
/*                                                                            */
/* Content scripts in different tabs cannot coordinate through               */
/* chrome.storage (read + write from two contexts is not atomic). The service */
/* worker is the single writer of the job records: every claim / heartbeat /  */
/* finish runs through one promise queue, so a read-decide-write step never   */
/* interleaves with another. The lease itself lives in chrome.storage.local,  */
/* so it survives the worker being suspended or restarted.                    */
/*                                                                            */
/* Lease = fcJob:<platform> { id, platform, kind, owner, status, stage,       */
/*   startedAt, heartbeatAt, endedAt?, error? }. A running lease without a    */
/* heartbeat for JOB_STALE_MS is expired and may be taken over. Heartbeat and */
/* finish are fenced: they only apply if the stored lease still has the same  */
/* job id + owner and is running, so a late write from an expired job can     */
/* never overwrite a newer one. Any storage error fails closed.               */
/* ------------------------------------------------------------------------- */
const JOB_STALE_MS = 120000;
const JOB_PLATFORM_URLS = {
  instagram: /^https:\/\/www\.instagram\.com\//,
  github: /^https:\/\/github\.com\//,
  bluesky: /^https:\/\/bsky\.app\//,
};
const JOB_KINDS = new Set(["analyze", "posts"]);
let jobQueue = Promise.resolve();

function serialized(fn) {
  const run = jobQueue.then(fn);
  jobQueue = run.catch(() => {});
  return run;
}

function leaseActive(job, now) {
  return Boolean(job && job.status === "running" && now - (job.heartbeatAt || job.startedAt || 0) < JOB_STALE_MS);
}

/** Persisted errors are short, single-line and free of URLs / token-like strings. */
function safeError(value) {
  return String(value || "Unknown error")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b[\w-]*(token|session|csrf|secret|password|auth)[\w-]*\s*[=:]\s*\S+/gi, "[redacted]")
    .replace(/[A-Za-z0-9_\-]{24,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function jobSenderOk(sender, platform) {
  if (sender?.id !== chrome.runtime.id) return false;
  const pattern = JOB_PLATFORM_URLS[platform];
  const url = sender.url || sender.tab?.url || "";
  return Boolean(pattern && sender.tab && pattern.test(url));
}

async function jobOp(msg) {
  const platform = msg.platform;
  const keys = { job: `fcJob:${platform}`, result: `fcResult:${platform}`, error: `fcError:${platform}` };
  const current = (await chrome.storage.local.get(keys.job))?.[keys.job] || null;
  const now = Date.now();

  if (msg.op === "claim") {
    if (!JOB_KINDS.has(msg.kind)) return { ok: false, error: "bad job" };
    if (leaseActive(current, now)) return { ok: false, busy: true, job: current };
    const job = {
      id: String(msg.jobId),
      platform,
      kind: msg.kind,
      owner: String(msg.owner),
      status: "running",
      stage: "start",
      startedAt: now,
      heartbeatAt: now,
    };
    await chrome.storage.local.set({ [keys.job]: job });
    return { ok: true, job };
  }

  const mine =
    current && current.id === msg.jobId && current.owner === msg.owner && current.status === "running";
  if (!mine) return { ok: false, fenced: true };

  if (msg.op === "heartbeat") {
    const job = { ...current, heartbeatAt: now };
    if (typeof msg.stage === "string" && msg.stage) job.stage = msg.stage.slice(0, 32);
    await chrome.storage.local.set({ [keys.job]: job });
    return { ok: true };
  }

  if (msg.op === "finish") {
    const ok = Boolean(msg.ok);
    const job = { ...current, status: ok ? "succeeded" : "failed", endedAt: now, heartbeatAt: now };
    const items = { [keys.job]: job };
    if (!ok) {
      job.error = safeError(msg.error);
      // Only analysis failures are reported as "last analysis failed".
      if (current.kind === "analyze") {
        items[keys.error] = { error: job.error, at: now, jobId: job.id, kind: job.kind };
      }
    } else if (current.kind === "analyze" && msg.result?.ok) {
      items[keys.result] = { ...msg.result, platform, jobId: job.id };
    }
    await chrome.storage.local.set(items);
    return { ok: true, error: job.error };
  }

  return { ok: false, error: "bad op" };
}

/** Popup edits of the shown result: only applied to the result they were based on. */
async function resultEditOp(msg) {
  const key = `fcResult:${msg.platform}`;
  const got = await chrome.storage.local.get([key]);
  const current = got?.[key] || null;
  const same =
    !current ||
    (current.jobId ? current.jobId === msg.baseJobId : !msg.baseJobId && current.finishedAt === msg.baseFinishedAt);
  if (!same) return { ok: false, stale: true };
  const result = { ...msg.result, platform: msg.platform };
  if (current?.jobId) result.jobId = current.jobId;
  await chrome.storage.local.set({ [key]: result });
  await chrome.storage.local.remove(["lastResult"]);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "FC_JOB") {
    if (!jobSenderOk(sender, msg.platform)) {
      sendResponse({ ok: false, error: "not allowed" });
      return false;
    }
    serialized(() => jobOp(msg)).then(sendResponse, () =>
      sendResponse({ ok: false, error: "job store unavailable" })
    );
    return true;
  }
  if (msg?.type === "FC_RESULT_EDIT") {
    const fromPopup =
      sender?.id === chrome.runtime.id && !sender.tab && String(sender.url || "").startsWith(chrome.runtime.getURL("popup.html"));
    if (!fromPopup || !JOB_PLATFORM_URLS[msg.platform]) {
      sendResponse({ ok: false, error: "not allowed" });
      return false;
    }
    serialized(() => resultEditOp(msg)).then(sendResponse, () =>
      sendResponse({ ok: false, error: "result store unavailable" })
    );
    return true;
  }
  return false;
});
