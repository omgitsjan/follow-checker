const $ = (id) => document.getElementById(id);

const startBtn = $("startBtn");
const statusEl = $("status");
const progressWrap = $("progressWrap");
const progressFill = $("progressFill");
const progressText = $("progressText");
const stats = $("stats");
const tabs = $("tabs");
const panels = $("panels");
const searchRow = $("searchRow");
const searchInput = $("searchInput");
const exportBtn = $("exportBtn");
const accountLine = $("accountLine");
const headerLogo = $("headerLogo");
const settingsBtn = $("settingsBtn");
const settingsPanel = $("settingsPanel");
const appMain = $("appMain");

const state = {
  me: null,
  following: [],
  followers: [],
  mutual: [],
  notFollowingBack: [],
  notFollowedByMe: [],
  counts: null,
  liked: [],
  topFans: [],
  postsScannedForLikers: 0,
  postsTopic: "posts",
  postsQuery: "",
  activeTab: "mutual",
  activeSection: "relationships",
  analyticsCache: null,
  query: "",
  botQuery: "",
  igTabId: null,
  lang: "en",
  statusIsIdle: true,
  likedLoaded: false,
  analysisRuns: 0,
  postsLoads: 0,
  analysisRunning: false,
  platformId: "instagram",
  resultPlatform: null,
  unfollowMode: "safe",
  pendingManual: {},
};

function platformById(id) {
  const list = typeof PLATFORMS !== "undefined" ? PLATFORMS : [];
  return list.find((p) => p.id === id) || list[0] || null;
}

function currentPlatform() {
  return platformById(state.platformId);
}

function profileUrlFor(username) {
  const platform = currentPlatform();
  if (platform?.profileUrl) return platform.profileUrl(username);
  return `https://www.instagram.com/${encodeURIComponent(username)}/`;
}

function safeUnfollowActive() {
  const platform = currentPlatform();
  if (!platform?.supportsDirectUnfollow) return true;
  return state.unfollowMode !== "direct";
}

function pendingKey(userId) {
  return `${state.resultPlatform || state.platformId || "instagram"}:${userId}`;
}

function rememberPending(userId, action) {
  state.pendingManual[pendingKey(userId)] = action;
  chrome.storage.local.set({ pendingManual: state.pendingManual }).catch(() => {});
}

function forgetPending(userId) {
  const key = pendingKey(userId);
  if (!state.pendingManual[key]) return;
  delete state.pendingManual[key];
  chrome.storage.local.set({ pendingManual: state.pendingManual }).catch(() => {});
}

const BOT_SCORE_MIN = 25;
const tipModal = $("tipModal");
const tipModalContinue = $("tipModalContinue");
const tipModalCancel = $("tipModalCancel");
let tipModalResolver = null;

const ALL_TABS = ["following", "followers", "mutual", "notBack", "notMe"];
const SECTIONS = ["relationships", "analytics", "bots", "liked", "admire"];
const sectionNav = $("sectionNav");
const botSearchInput = $("botSearchInput");
const navAdmire = $("navAdmire");

/* ---------- i18n ---------- */

function t(key, vars = {}) {
  const pack = I18N[state.lang] || I18N.en;
  let s = pack[key] ?? I18N.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) {
    s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

function applyStaticI18n() {
  document.documentElement.lang = state.lang === "de" ? "de" : "en";
  document.title = t("appTitle");

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (!key) return;
    // Don't overwrite live @username in account line
    if (el.id === "accountLine" && state.me?.username) return;
    el.textContent = t(key);
  });

  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    const key = el.getAttribute("data-i18n-html");
    if (!key) return;
    if (el.id === "status" && !state.statusIsIdle) return;
    el.innerHTML = t(key);
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
  });

  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.getAttribute("data-i18n-title"));
    if (el.hasAttribute("aria-label")) {
      el.setAttribute("aria-label", t(el.getAttribute("data-i18n-title")));
    }
  });

  // Language toggle UI
  document.querySelectorAll(".lang-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.lang === state.lang);
  });

  // Keep gear/X label in the open language
  if (typeof isSettingsOpen === "function") {
    syncSettingsToggleUi(isSettingsOpen());
  }

  if (!state.me?.username) {
    accountLine.textContent = t("tagline");
  }
  if (typeof applyUnfollowModeUi === "function") applyUnfollowModeUi();

  // Re-render dynamic lists so button labels update
  if (state.counts) {
    renderAll();
    renderAnalytics();
    renderBots();
    if (state.statusIsIdle === false && state.counts) {
      setStatus(
        t("doneSummary", {
          notBack: state.counts.notFollowingBack,
          notMe: state.counts.notFollowedByMe,
          mutual: state.counts.mutual,
        }),
        "ok"
      );
      state.statusIsIdle = false;
    }
  }
}

function switchSection(name) {
  if (!SECTIONS.includes(name)) name = "relationships";
  state.activeSection = name;
  // Leaving settings full-page if open
  closeSettings();

  document.querySelectorAll(".section-btn").forEach((btn) => {
    const on = btn.dataset.section === name;
    btn.classList.toggle("active", on);
  });

  for (const s of SECTIONS) {
    const el = $(`section-${s}`);
    if (!el) continue;
    el.classList.toggle("hidden", s !== name);
  }

  if (name === "analytics") renderAnalytics();
  if (name === "bots") renderBots();
  // posts + admire are static "coming soon" panels
}

function miniAvatar(u) {
  if (u.profilePic) {
    const img = document.createElement("img");
    img.className = "avatar";
    img.style.width = "28px";
    img.style.height = "28px";
    img.src = u.profilePic;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.loading = "lazy";
    return img;
  }
  const d = placeholderAvatar(u.username);
  d.style.width = "28px";
  d.style.height = "28px";
  d.style.fontSize = "11px";
  return d;
}

function chartLabel(key) {
  const map = {
    mutual: t("chartMutual"),
    notBack: t("chartNotBack"),
    notMe: t("chartNotMe"),
    following: t("following"),
    followers: t("followers"),
    public: t("chartPublic"),
    private: t("chartPrivate"),
    verified: t("chartVerified"),
    notVerified: t("chartNotVerified"),
    riskHigh: t("chartRiskHigh"),
    riskMid: t("chartRiskMid"),
    riskFlagged: t("chartRiskFlagged"),
    riskClean: t("chartRiskClean"),
  };
  return map[key] || key;
}

function buildChartCard(title, segments, centerText, centerSub) {
  const card = document.createElement("div");
  card.className = "chart-card";

  const h = document.createElement("h3");
  h.className = "chart-title";
  h.textContent = title;
  card.appendChild(h);

  const body = document.createElement("div");
  body.className = "chart-body";

  const canvas = document.createElement("canvas");
  canvas.className = "chart-canvas";
  body.appendChild(canvas);

  const legend = document.createElement("ul");
  legend.className = "chart-legend";
  const total = segments.reduce((s, x) => s + (Number(x.value) || 0), 0);
  for (const seg of segments) {
    const li = document.createElement("li");
    const pct = total > 0 ? Math.round(((Number(seg.value) || 0) / total) * 100) : 0;
    li.innerHTML = `
      <span class="swatch" style="background:${seg.color}"></span>
      <span class="lab">${escapeHtml(chartLabel(seg.key || seg.label))}</span>
      <span class="num">${escapeHtml(String(seg.value))} · ${pct}%</span>`;
    legend.appendChild(li);
  }
  body.appendChild(legend);
  card.appendChild(body);

  // Draw after in DOM
  requestAnimationFrame(() => {
    if (window.IGAnalytics?.drawDoughnut) {
      window.IGAnalytics.drawDoughnut(canvas, segments, {
        size: 132,
        hole: 0.58,
        centerText,
        centerSub,
      });
    }
  });

  return card;
}

function renderAnalytics() {
  const summaryEl = $("analyticsSummary");
  const panel = $("panel-analytics");
  if (!summaryEl || !panel || !window.IGAnalytics) return;

  if (!state.counts) {
    summaryEl.innerHTML = `<div class="empty" style="grid-column:1/-1">${escapeHtml(t("needAnalysisFirst"))}</div>`;
    panel.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = t("needAnalysisFirst");
    panel.appendChild(empty);
    state.analyticsCache = null;
    return;
  }

  const A = window.IGAnalytics;
  const s = A.buildAnalyticsSummary(state);
  state.analyticsCache = s;

  summaryEl.innerHTML = `
    <div class="metric"><strong>${A.formatCount(s.followingCount)}</strong><span>${escapeHtml(t("following"))}</span></div>
    <div class="metric"><strong>${A.formatCount(s.followersCount)}</strong><span>${escapeHtml(t("followers"))}</span></div>
    <div class="metric"><strong>${A.formatPct(s.mutualRate)}</strong><span>${escapeHtml(t("metricMutualRate"))}</span></div>
    <div class="metric"><strong>${A.formatPct(s.notBackRate)}</strong><span>${escapeHtml(t("metricNotBackRate"))}</span></div>
    <div class="metric"><strong>${A.formatPct(s.oneWayFollowerRate)}</strong><span>${escapeHtml(t("metricOneWayFollowers"))}</span></div>
    <div class="metric"><strong>${A.formatCount(s.botFlaggedCount)}</strong><span>${escapeHtml(t("metricBotFlagged"))}</span></div>
  `;

  panel.replaceChildren();

  const wrap = document.createElement("div");
  wrap.className = "charts-grid";
  wrap.appendChild(
    buildChartCard(
      t("chartFollowingTitle"),
      s.followingSplit,
      A.formatCount(s.followingCount),
      t("following")
    )
  );
  wrap.appendChild(
    buildChartCard(
      t("chartFollowersTitle"),
      s.followersSplit,
      A.formatCount(s.followersCount),
      t("followers")
    )
  );
  wrap.appendChild(
    buildChartCard(
      t("chartNetworkTitle"),
      s.networkMix,
      A.formatPct(s.mutualRate),
      t("metricMutualRate")
    )
  );
  wrap.appendChild(
    buildChartCard(
      t("chartAudienceTitle"),
      s.audienceBalance,
      A.formatCount(s.followingCount + s.followersCount),
      t("chartAudienceCenter")
    )
  );
  wrap.appendChild(
    buildChartCard(
      t("chartPrivacyTitle"),
      s.followersPrivacy,
      A.formatCount(s.followersCount),
      t("followers")
    )
  );
  wrap.appendChild(
    buildChartCard(
      t("chartVerifiedTitle"),
      s.followingVerified,
      A.formatCount(s.verifiedFollowing),
      t("chartVerified")
    )
  );
  wrap.appendChild(
    buildChartCard(
      t("chartBotRiskTitle"),
      s.followersBotRisk,
      A.formatCount(s.botFlaggedCount),
      t("metricBotFlagged")
    )
  );
  panel.appendChild(wrap);
}

function renderBots() {
  const panel = $("panel-bots");
  if (!panel || !window.IGAnalytics) return;
  panel.replaceChildren();

  if (!state.followers.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = state.counts ? t("botNeedFollowers") : t("needAnalysisFirst");
    panel.appendChild(empty);
    return;
  }

  // Hide low-risk accounts (score < 25) — most likely not bots
  let list = window.IGAnalytics.sortByBotScoreDesc(state.followers).filter(
    (u) => (u.botScore ?? 0) >= BOT_SCORE_MIN
  );
  const q = state.botQuery.trim().toLowerCase();
  if (q) {
    list = list.filter(
      (u) =>
        u.username.toLowerCase().includes(q) ||
        (u.fullName || "").toLowerCase().includes(q)
    );
  }

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = q ? t("noSearchResults") : t("botsNoneAboveThreshold");
    panel.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const u of list.slice(0, 200)) {
    const row = document.createElement("div");
    row.className = "user-card";
    row.dataset.userId = u.id;

    const link = document.createElement("a");
    link.className = "user-link";
    link.href = profileUrlFor(u.username);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.appendChild(buildAvatar(u));
    const meta = document.createElement("div");
    meta.className = "user-meta";
    const iFollow = state.following.some((x) => x.id === u.id);
    const sub = [
      u.followerCount != null
        ? `${window.IGAnalytics.formatCount(u.followerCount)} fl.`
        : null,
      u.followingCount != null
        ? `${window.IGAnalytics.formatCount(u.followingCount)} fg.`
        : null,
      (u.botReasons || []).slice(0, 2).join(", "),
    ]
      .filter(Boolean)
      .join(" · ");
    meta.innerHTML = `<div class="name">@${escapeHtml(u.username)}</div><div class="full">${escapeHtml(sub)}</div>`;
    link.appendChild(meta);
    row.appendChild(link);

    const actions = document.createElement("div");
    actions.className = "user-actions";

    const pill = document.createElement("span");
    pill.className =
      "score-pill " + (u.botScore >= 55 ? "high" : u.botScore >= 30 ? "mid" : "low");
    pill.textContent = t("botScore", { n: u.botScore });
    actions.appendChild(pill);

    // Remove from your followers
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn action remove-follower";
    const manual = safeUnfollowActive();
    const removePending = manual && state.pendingManual[pendingKey(u.id)] === "remove_follower";
    removeBtn.textContent = removePending
      ? t("markRemoved")
      : manual
        ? t("openToUnfollow")
        : t("removeFollower");
    if (removePending) removeBtn.dataset.opened = "1";
    removeBtn.title = removePending
      ? t("markUnfollowedHint", { user: u.username })
      : manual
        ? t("openProfile", { user: u.username })
        : t("removeFollowerUser", { user: u.username });
    removeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleFriendship(u, "remove_follower", "bots", removeBtn, row);
    });
    actions.appendChild(removeBtn);

    // Unfollow if you follow them
    if (iFollow) {
      const unf = document.createElement("button");
      unf.type = "button";
      unf.className = "btn action unfollow";
      const unfollowPending = manual && state.pendingManual[pendingKey(u.id)] === "unfollow";
      unf.textContent = unfollowPending
        ? t("markUnfollowed")
        : manual
          ? t("openToUnfollow")
          : t("unfollow");
      if (unfollowPending) unf.dataset.opened = "1";
      unf.title = unfollowPending
        ? t("markUnfollowedHint", { user: u.username })
        : manual
          ? t("openProfile", { user: u.username })
          : t("unfollowUser", { user: u.username });
      unf.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleFriendship(u, "unfollow", "bots", unf, row);
      });
      actions.appendChild(unf);
    }

    row.appendChild(actions);
    frag.appendChild(row);
  }
  panel.appendChild(frag);
}

async function setLanguage(lang) {
  if (!I18N[lang]) return;
  state.lang = lang;
  try {
    await chrome.storage.local.set({ lang });
  } catch {
    /* ignore */
  }
  applyStaticI18n();
}

/* ---------- header / UI helpers ---------- */

function setHeaderLogoFallback() {
  if (!headerLogo) return;
  headerLogo.classList.remove("has-photo");
  headerLogo.innerHTML = '<span class="logo-fallback">FC</span>';
}

function setHeaderPhoto(person) {
  if (!headerLogo) return;
  if (!person?.profilePic && !person?.profilePicData) {
    setHeaderLogoFallback();
    return;
  }
  const pic = person.profilePicData || person.profilePic;
  const img = document.createElement("img");
  img.className = "logo-photo";
  img.alt = person.username ? `@${person.username}` : "";
  img.src = pic;
  img.addEventListener(
    "error",
    async () => {
      if (person.profilePic && !person.profilePicData) {
        try {
          const tabId = await resolveIgTabId();
          if (tabId) {
            await ensureContentScript(tabId);
            const res = await chrome.tabs.sendMessage(tabId, {
              type: "FETCH_AVATAR",
              url: person.profilePic,
            });
            if (res?.ok && res.dataUrl) {
              person.profilePicData = res.dataUrl;
              img.src = res.dataUrl;
              return;
            }
          }
        } catch {
          /* fallback */
        }
      }
      setHeaderLogoFallback();
    },
    { once: true }
  );
  img.addEventListener(
    "load",
    () => {
      headerLogo.classList.add("has-photo");
      headerLogo.replaceChildren(img);
    },
    { once: true }
  );
  headerLogo.classList.add("has-photo");
  headerLogo.replaceChildren(img);
}

function refreshHeaderDisplay() {
  const me = state.me;
  if (me?.username) {
    accountLine.removeAttribute("data-i18n");
    accountLine.textContent = `@${me.username}`;
    setHeaderPhoto(me);
    return;
  }

  accountLine.setAttribute("data-i18n", "tagline");
  accountLine.textContent = t("tagline");
  setHeaderLogoFallback();
}

function setHeaderAccount(me) {
  if (me?.username) {
    state.me = { ...(state.me || {}), ...me };
  }
  refreshHeaderDisplay();
}

function setStatus(text, kind = "") {
  // Final / idle messages live above the progress area — not during loading
  show(statusEl, true);
  statusEl.innerHTML = text;
  statusEl.className = "status" + (kind ? ` ${kind}` : "");
  state.statusIsIdle = false;
}

function setIdleStatus() {
  show(statusEl, true);
  statusEl.innerHTML = t("statusIdle");
  statusEl.className = "status";
  state.statusIsIdle = true;
}

/** Show only the bar + one line under it (hide duplicate top status). */
function setProgressUi(active, text = "") {
  show(progressWrap, active);
  if (active) {
    show(statusEl, false);
    if (text) progressText.textContent = String(text).replace(/<[^>]+>/g, "");
  } else {
    show(statusEl, true);
    progressText.textContent = "";
  }
}

function show(el, yes = true) {
  el.classList.toggle("hidden", !yes);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function placeholderAvatar(username) {
  const d = document.createElement("div");
  d.className = "avatar placeholder";
  d.textContent = (username || "?").slice(0, 1).toUpperCase();
  return d;
}

function buildAvatar(u) {
  const wrap = document.createElement("div");
  wrap.className = "avatar-wrap";

  if (!u.profilePic) {
    wrap.appendChild(placeholderAvatar(u.username));
    return wrap;
  }

  const img = document.createElement("img");
  img.className = "avatar";
  img.src = u.profilePic;
  img.alt = `@${u.username}`;
  img.referrerPolicy = "no-referrer";
  img.loading = "lazy";
  img.decoding = "async";

  img.onerror = async () => {
    img.onerror = null;
    try {
      const tabId = await resolveIgTabId();
      if (!tabId) {
        img.replaceWith(placeholderAvatar(u.username));
        return;
      }
      await ensureContentScript(tabId);
      const res = await chrome.tabs.sendMessage(tabId, {
        type: "FETCH_AVATAR",
        url: u.profilePic,
      });
      if (res?.ok && res.dataUrl) {
        img.src = res.dataUrl;
        u.profilePicData = res.dataUrl;
      } else {
        img.replaceWith(placeholderAvatar(u.username));
      }
    } catch {
      img.replaceWith(placeholderAvatar(u.username));
    }
  };

  if (u.profilePicData) {
    img.src = u.profilePicData;
  }

  wrap.appendChild(img);
  return wrap;
}

/**
 * @param {object} u
 * @param {"mutual"|"notBack"|"notMe"} listKey
 */
function userCard(u, listKey) {
  const row = document.createElement("div");
  row.className = "user-card";
  row.dataset.userId = u.id;

  const link = document.createElement("a");
  link.className = "user-link";
  link.href = profileUrlFor(u.username);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.title = t("openProfile", { user: u.username });

  link.appendChild(buildAvatar(u));

  const meta = document.createElement("div");
  meta.className = "user-meta";
  meta.innerHTML = `
    <div class="name">@${escapeHtml(u.username)}</div>
    <div class="full">${escapeHtml(u.fullName || "")}</div>
  `;
  link.appendChild(meta);
  row.appendChild(link);

  const actions = document.createElement("div");
  actions.className = "user-actions";

  if (u.isPrivate) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = t("private");
    actions.appendChild(tag);
  }

  const canUnfollow =
    listKey === "notBack" || listKey === "following" || listKey === "mutual";
  const canFollow =
    listKey === "notMe" ||
    (listKey === "followers" && !state.following.some((x) => x.id === u.id));

  if (canUnfollow) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn action unfollow";
    const manualUnfollow = safeUnfollowActive();
    const unfollowPending = manualUnfollow && state.pendingManual[pendingKey(u.id)] === "unfollow";
    btn.textContent = unfollowPending
      ? t("markUnfollowed")
      : manualUnfollow
        ? t("openToUnfollow")
        : t("unfollow");
    if (unfollowPending) btn.dataset.opened = "1";
    btn.title = unfollowPending
      ? t("markUnfollowedHint", { user: u.username })
      : manualUnfollow
        ? t("openProfile", { user: u.username })
        : t("unfollowUser", { user: u.username });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleFriendship(u, "unfollow", listKey, btn, row);
    });
    actions.appendChild(btn);
  }

  if (canFollow) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn action follow";
    btn.textContent = t("follow");
    btn.title = t("followUser", { user: u.username });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleFriendship(u, "follow", listKey, btn, row);
    });
    actions.appendChild(btn);
  }

  row.appendChild(actions);
  return row;
}

function commitRemoveFollower(u, row) {
  forgetPending(u.id);
  removeUserFromLists(u.id, ["followers", "mutual", "notMe", "notFollowedByMe"]);
  if (state.following.some((x) => x.id === u.id)) {
    if (!state.notFollowingBack.some((x) => x.id === u.id)) {
      state.notFollowingBack.push(u);
      state.notFollowingBack.sort((a, b) =>
        a.username.localeCompare(b.username, undefined, { sensitivity: "base" })
      );
    }
  }
  if (state.counts) {
    state.counts.followers = state.followers.length;
    state.counts.mutual = state.mutual.length;
    state.counts.notFollowedByMe = state.notFollowedByMe.length;
    state.counts.notFollowingBack = state.notFollowingBack.length;
  }
  setStatus(t("followerRemoved", { user: escapeHtml(u.username) }), "ok");
  row.classList.add("removing");
  setTimeout(() => {
    row.remove();
    refreshPanelsAfterAction();
  }, 180);
  updateBadgesAndStats();
  persistState();
}

function commitUnfollow(u, listKey, row) {
  forgetPending(u.id);
  removeUserFromLists(u.id, ["following", "mutual", "notBack"]);
  if (state.counts) {
    state.counts.following = state.following.length;
    state.counts.mutual = state.mutual.length;
    state.counts.notFollowingBack = state.notFollowingBack.length;
    if (state.followers.some((x) => x.id === u.id)) {
      if (!state.notFollowedByMe.some((x) => x.id === u.id)) {
        state.notFollowedByMe.push(u);
        state.notFollowedByMe.sort((a, b) =>
          a.username.localeCompare(b.username, undefined, { sensitivity: "base" })
        );
      }
      state.counts.notFollowedByMe = state.notFollowedByMe.length;
    }
  }
  setStatus(t("unfollowed", { user: escapeHtml(u.username) }), "ok");
  if (listKey === "bots") {
    updateBadgesAndStats();
    persistState();
    renderBots();
    return;
  }
  row.classList.add("removing");
  setTimeout(() => {
    row.remove();
    refreshPanelsAfterAction();
  }, 180);
  updateBadgesAndStats();
  persistState();
}

async function handleFriendship(u, action, listKey, btn, row) {
  if (btn.disabled) return;
  const manual =
    (action === "unfollow" || action === "remove_follower") && safeUnfollowActive();
  if (manual) {
    try {
      if (btn.dataset.opened === "1" || state.pendingManual[pendingKey(u.id)] === action) {
        btn.disabled = true;
        if (action === "remove_follower") commitRemoveFollower(u, row);
        else commitUnfollow(u, listKey, row);
        return;
      }
      btn.disabled = true;
      rememberPending(u.id, action);
      await chrome.tabs.create({ url: profileUrlFor(u.username), active: true });
      btn.disabled = false;
      btn.dataset.opened = "1";
      btn.textContent = action === "remove_follower" ? t("markRemoved") : t("markUnfollowed");
      btn.title = t("markUnfollowedHint", { user: u.username });
      setStatus(
        t(action === "remove_follower" ? "openedToRemove" : "openedToUnfollow", {
          user: escapeHtml(u.username),
        }),
        "ok"
      );
    } catch (err) {
      btn.disabled = false;
      setStatus(escapeHtml(err?.message || String(err)), "error");
    }
    return;
  }

  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "…";

  try {
    const tabId = await resolveIgTabId();
    if (!tabId) {
      throw new Error(t("noIgTab"));
    }
    await ensureContentScript(tabId);
    const res = await chrome.tabs.sendMessage(tabId, {
      type: "FRIENDSHIP",
      action,
      userId: u.id,
    });

    if (!res?.ok) {
      throw new Error(res?.error || t("actionFailed"));
    }

    if (action === "follow" && res.outgoingRequest && !res.following) {
      btn.textContent = t("requested");
      btn.classList.add("done");
      setStatus(t("followRequestSent", { user: escapeHtml(u.username) }), "ok");
      // pending request: remove from "you don't follow" views
      removeUserFromLists(u.id, ["notMe"]);
      row.classList.add("removing");
      setTimeout(() => {
        row.remove();
        refreshPanelsAfterAction();
      }, 180);
      updateBadgesAndStats();
      persistState();
      return;
    }

    if (action === "remove_follower") {
      commitRemoveFollower(u, row);
      return;
    }

    if (action === "unfollow") {
      commitUnfollow(u, listKey, row);
      return;
    }

    {
      // follow: add to following; if they follow you → mutual, else notBack
      if (!state.following.some((x) => x.id === u.id)) {
        state.following.push(u);
        state.following.sort((a, b) =>
          a.username.localeCompare(b.username, undefined, { sensitivity: "base" })
        );
      }
      removeUserFromLists(u.id, ["notMe", "notFollowedByMe"]);
      const theyFollow = state.followers.some((x) => x.id === u.id);
      if (theyFollow) {
        if (!state.mutual.some((x) => x.id === u.id)) {
          state.mutual.push(u);
          state.mutual.sort((a, b) =>
            a.username.localeCompare(b.username, undefined, {
              sensitivity: "base",
            })
          );
        }
        removeUserFromLists(u.id, ["notBack"]);
      } else if (!state.notFollowingBack.some((x) => x.id === u.id)) {
        state.notFollowingBack.push(u);
        state.notFollowingBack.sort((a, b) =>
          a.username.localeCompare(b.username, undefined, {
            sensitivity: "base",
          })
        );
      }
      if (state.counts) {
        state.counts.following = state.following.length;
        state.counts.mutual = state.mutual.length;
        state.counts.notFollowingBack = state.notFollowingBack.length;
        state.counts.notFollowedByMe = state.notFollowedByMe.length;
      }
      setStatus(t("nowFollowing", { user: escapeHtml(u.username) }), "ok");
    }

    row.classList.add("removing");
    setTimeout(() => {
      row.remove();
      refreshPanelsAfterAction();
    }, 180);

    updateBadgesAndStats();
    persistState();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = label;
    setStatus(escapeHtml(err?.message || String(err)), "error");
  }
}

function listForKey(key) {
  if (key === "following") return state.following;
  if (key === "followers") return state.followers;
  if (key === "mutual") return state.mutual;
  if (key === "notBack") return state.notFollowingBack;
  return state.notFollowedByMe;
}

function removeUserFromLists(userId, keys) {
  const filter = (arr) => arr.filter((x) => x.id !== userId);
  for (const key of keys) {
    if (key === "following") state.following = filter(state.following);
    if (key === "followers") state.followers = filter(state.followers);
    if (key === "mutual") state.mutual = filter(state.mutual);
    if (key === "notBack") state.notFollowingBack = filter(state.notFollowingBack);
    if (key === "notMe" || key === "notFollowedByMe") {
      state.notFollowedByMe = filter(state.notFollowedByMe);
    }
  }
  if (state.counts) {
    state.counts.following = state.following.length;
    state.counts.followers = state.followers.length;
    state.counts.mutual = state.mutual.length;
    state.counts.notFollowingBack = state.notFollowingBack.length;
    state.counts.notFollowedByMe = state.notFollowedByMe.length;
  }
}

function panelIdFor(key) {
  return `panel-${key}`;
}

function refreshPanelsAfterAction() {
  renderAll();
  // keep current tab visible after re-render
  switchTab(state.activeTab, { force: true });
  state.analyticsCache = null;
  if (state.activeSection === "analytics") renderAnalytics();
  if (state.activeSection === "bots") renderBots();
}

function updateBadgesAndStats() {
  if (!state.counts) return;
  $("statFollowing").textContent = state.counts.following;
  $("statFollowers").textContent = state.counts.followers;
  $("badgeMutual").textContent = state.counts.mutual;
  $("badgeNotBack").textContent = state.counts.notFollowingBack;
  $("badgeNotMe").textContent = state.counts.notFollowedByMe;
}

async function persistState() {
  if (!state.counts || !state.me) return;
  const result = {
    type: "RESULT",
    ok: true,
    platform: state.resultPlatform || state.platformId,
    me: state.me,
    counts: state.counts,
    following: state.following,
    followers: state.followers,
    mutual: state.mutual,
    notFollowingBack: state.notFollowingBack,
    notFollowedByMe: state.notFollowedByMe,
    finishedAt: Date.now(),
  };
  try {
    await chrome.storage.local.set({ lastResult: result });
  } catch {
    /* ignore */
  }
}

function filtered(list) {
  const q = state.query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (u) =>
      u.username.toLowerCase().includes(q) ||
      (u.fullName || "").toLowerCase().includes(q)
  );
}

function renderPanel(panelId, list, listKey) {
  const panel = $(panelId);
  panel.replaceChildren();
  const items = filtered(list);

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = state.query ? t("noSearchResults") : t("emptyList");
    panel.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const u of items) frag.appendChild(userCard(u, listKey));
  panel.appendChild(frag);
}

function renderAll() {
  renderPanel("panel-following", state.following, "following");
  renderPanel("panel-followers", state.followers, "followers");
  renderPanel("panel-mutual", state.mutual, "mutual");
  renderPanel("panel-notBack", state.notFollowingBack, "notBack");
  renderPanel("panel-notMe", state.notFollowedByMe, "notMe");
}

function switchTab(name, { force = false } = {}) {
  if (!ALL_TABS.includes(name)) name = "mutual";
  if (!force && state.activeTab === name) {
    // still ensure panels match
  }
  state.activeTab = name;

  // Top tiles (following / followers)
  document.querySelectorAll(".stat-btn").forEach((btn) => {
    const on = btn.dataset.tab === name;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });

  // Bottom relationship tabs
  document.querySelectorAll("#tabs .tab").forEach((btn) => {
    const on = btn.dataset.tab === name;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });

  for (const key of ALL_TABS) {
    const panel = $(panelIdFor(key));
    if (!panel) continue;
    const on = key === name;
    panel.classList.toggle("active", on);
    panel.hidden = !on;
  }
}

function platformForUrl(url) {
  const list = typeof PLATFORMS !== "undefined" ? PLATFORMS : [];
  return list.find((p) => p.match(url || "")) || null;
}

async function getIgTab() {
  const tabsFound = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  const active = tabsFound[0];
  const activePlatform = platformForUrl(active?.url);
  if (active?.id && activePlatform) {
    state.igTabId = active.id;
    state.platformId = activePlatform.id;
    return active;
  }
  const list = typeof PLATFORMS !== "undefined" ? PLATFORMS : [];
  for (const platform of list) {
    const found = await chrome.tabs.query({ url: platform.queries });
    if (found[0]?.id) {
      state.igTabId = found[0].id;
      state.platformId = platform.id;
      return found[0];
    }
  }
  throw new Error(t("openIgFirst"));
}

async function resolveIgTabId() {
  if (state.igTabId) {
    try {
      const tTab = await chrome.tabs.get(state.igTabId);
      const platform = platformForUrl(tTab?.url);
      if (platform) {
        state.platformId = platform.id;
        return state.igTabId;
      }
    } catch {
      state.igTabId = null;
    }
  }
  try {
    const tab = await getIgTab();
    return tab.id;
  } catch {
    return null;
  }
}

async function ensureContentScript(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const platform = platformForUrl(tab?.url);
  if (!platform) throw new Error(t("openIgFirst"));
  state.platformId = platform.id;
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    if (res?.ok && res.platform === platform.id) return;
  } catch {
    /* inject */
  }
  if (platform.bridge) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [platform.bridge],
      world: "MAIN",
    });
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: platform.shared ? ["fc-shared.js", platform.script] : [platform.script],
    });
  } catch {
    throw new Error(t("reloadTab"));
  }
}

function formatProgress(msg) {
  if (msg.stage === "user" && msg.me) {
    return t("progressAccount", { user: msg.me.username || msg.me.id });
  }
  if (msg.stage === "following") {
    const total =
      msg.total != null ? t("totalApprox", { n: msg.total }) : "";
    return t("progressFollowing", { loaded: msg.loaded ?? 0, total });
  }
  if (msg.stage === "followers") {
    const total =
      msg.total != null ? t("totalApprox", { n: msg.total }) : "";
    return t("progressFollowers", { loaded: msg.loaded ?? 0, total });
  }
  if (msg.stage === "enrich") {
    return t("progressEnrich", {
      target: msg.target || "",
      enriched: msg.enriched ?? 0,
      total: msg.total ?? 0,
    });
  }
  return msg.message || t("loading");
}

/** Confirm re-run / second heavy action with tip popover */
function askTipConfirm() {
  return new Promise((resolve) => {
    tipModalResolver = resolve;
    if (!tipModal) {
      resolve(true);
      return;
    }
    // Refresh i18n inside modal
    tipModal.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (key) el.textContent = t(key);
    });
    tipModal.querySelectorAll("[data-i18n-html]").forEach((el) => {
      const key = el.getAttribute("data-i18n-html");
      if (key) el.innerHTML = t(key);
    });
    show(tipModal, true);
  });
}

function closeTipModal(result) {
  show(tipModal, false);
  if (tipModalResolver) {
    const r = tipModalResolver;
    tipModalResolver = null;
    r(result);
  }
}

function onProgress(msg) {
  setProgressUi(true);
  if (msg.stage === "user" && msg.me) {
    state.me = msg.me;
    refreshHeaderDisplay();
    progressFill.style.width = "8%";
  }
  if (msg.stage === "following") {
    progressFill.style.width = "28%";
  }
  if (msg.stage === "followers") {
    progressFill.style.width = "48%";
  }
  if (msg.stage === "enrich") {
    const base = msg.target === "followers" ? 72 : 55;
    const frac =
      msg.total > 0 ? (msg.enriched || 0) / msg.total : 0;
    progressFill.style.width = `${base + Math.round(frac * 12)}%`;
  }
  if (msg.stage === "liked" || msg.stage === "posts") {
    if (msg.phase === "likers") {
      progressFill.style.width = `${30 + Math.round((60 * (msg.postIndex || 0)) / Math.max(1, msg.postTotal || 1))}%`;
      setProgressUi(
        true,
        t("progressLikers", {
          i: msg.postIndex || 0,
          n: msg.postTotal || 0,
          fans: msg.fans || 0,
        })
      );
      return;
    }
    progressFill.style.width = "35%";
    setProgressUi(true, t("progressLiked", { loaded: msg.loaded ?? 0 }));
    return;
  }
  setProgressUi(true, formatProgress(msg));
}

function onResult(msg, { keepTab = false } = {}) {
  startBtn.disabled = false;
  state.analysisRunning = false;
  setProgressUi(false);

  if (!msg.ok) {
    setStatus(escapeHtml(msg.error || t("unknownError")), "error");
    return;
  }

  // Skip stale Impersonator results from older versions
  if (msg.impersonating) {
    return;
  }

  if (msg.platform) state.platformId = msg.platform;
  state.resultPlatform = msg.platform || state.platformId;
  state.me = msg.me;
  state.following = msg.following || [];
  state.followers = msg.followers || [];
  state.mutual = msg.mutual || [];
  state.notFollowingBack = msg.notFollowingBack || [];
  state.notFollowedByMe = msg.notFollowedByMe || [];
  state.counts = msg.counts;

  // Older cached results may lack full lists — rebuild when possible
  if (!state.following.length && state.mutual.length) {
    const map = new Map();
    for (const u of [...state.mutual, ...state.notFollowingBack]) map.set(u.id, u);
    state.following = [...map.values()].sort((a, b) =>
      a.username.localeCompare(b.username, undefined, { sensitivity: "base" })
    );
  }
  if (!state.followers.length && state.mutual.length) {
    const map = new Map();
    for (const u of [...state.mutual, ...state.notFollowedByMe]) map.set(u.id, u);
    state.followers = [...map.values()].sort((a, b) =>
      a.username.localeCompare(b.username, undefined, { sensitivity: "base" })
    );
  }
  if (state.counts) {
    state.counts.following = state.following.length || state.counts.following;
    state.counts.followers = state.followers.length || state.counts.followers;
  }

  refreshHeaderDisplay();
  updateBadgesAndStats();

  show(stats, true);
  show(tabs, true);
  show(searchRow, true);
  show(panels, true);
  show(sectionNav, true);
  renderAll();
  // Always refresh derived sections from the same global result
  state.analyticsCache = null;
  renderAnalytics();
  renderBots();
  if (!keepTab) switchTab("mutual");
  else switchTab(state.activeTab || "mutual", { force: true });
  switchSection(state.activeSection || "relationships");

  const done =
    t("doneSummary", {
      notBack: msg.counts.notFollowingBack,
      notMe: msg.counts.notFollowedByMe,
      mutual: msg.counts.mutual,
    }) +
    " " +
    t("doneGlobalHint");
  setStatus(done, "ok");
}

/* ---------- settings ---------- */

function isSettingsOpen() {
  return settingsPanel && !settingsPanel.classList.contains("hidden");
}

function syncSettingsToggleUi(open) {
  if (!settingsBtn) return;
  settingsBtn.setAttribute("aria-expanded", open ? "true" : "false");
  const label = open ? t("close") : t("settings");
  settingsBtn.title = label;
  settingsBtn.setAttribute("aria-label", label);
  // Prefer live title over static data-i18n-title while open
  if (open) {
    settingsBtn.removeAttribute("data-i18n-title");
  } else {
    settingsBtn.setAttribute("data-i18n-title", "settings");
  }
}

function applyUnfollowModeUi() {
  document.querySelectorAll("[data-unfollow-mode]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.unfollowMode === state.unfollowMode);
  });
  const help = $("unfollowModeHelp");
  if (help) {
    help.textContent =
      state.unfollowMode === "direct" ? t("unfollowDirectHelp") : t("unfollowSafeHelp");
  }
}

async function setUnfollowMode(mode) {
  if (mode !== "safe" && mode !== "direct") return;
  state.unfollowMode = mode;
  try {
    await chrome.storage.local.set({ unfollowMode: mode });
  } catch {
    /* ignore */
  }
  applyUnfollowModeUi();
  if (state.counts) {
    renderAll();
    renderBots();
  }
}

function openSettings() {
  // Full-page settings under fixed header; gear becomes ×
  if (appMain) show(appMain, false);
  show(settingsPanel, true);
  syncSettingsToggleUi(true);
}

function closeSettings() {
  show(settingsPanel, false);
  if (appMain) show(appMain, true);
  syncSettingsToggleUi(false);
}

settingsBtn?.addEventListener("click", () => {
  if (isSettingsOpen()) closeSettings();
  else openSettings();
});

document.querySelectorAll(".lang-btn").forEach((btn) => {
  btn.addEventListener("click", () => setLanguage(btn.dataset.lang));
});

document.querySelectorAll("[data-unfollow-mode]").forEach((btn) => {
  btn.addEventListener("click", () => setUnfollowMode(btn.dataset.unfollowMode));
});

/* ---------- messaging / init ---------- */

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "PROGRESS") onProgress(msg);
  if (msg?.type === "RESULT") onResult(msg);
});

async function init() {
  const stored = await chrome.storage.local.get([
    "lang",
    "lastResult",
    "lastLiked",
    "unfollowMode",
    "pendingManual",
  ]);
  // Drop leftover Impersonator keys from older builds
  try {
    await chrome.storage.local.remove([
      "impersonating",
      "impersonatorUsername",
      "readOnly",
    ]);
  } catch {
    /* ignore */
  }
  if (stored.lang && I18N[stored.lang]) {
    state.lang = stored.lang;
  }
  if (stored.unfollowMode === "direct" || stored.unfollowMode === "safe") {
    state.unfollowMode = stored.unfollowMode;
  }
  if (stored.pendingManual && typeof stored.pendingManual === "object") {
    state.pendingManual = stored.pendingManual;
  }
  applyStaticI18n();
  show(sectionNav, true);

  if (stored.lastResult?.ok && !stored.lastResult.impersonating) {
    if (stored.lastResult.platform) state.resultPlatform = stored.lastResult.platform;
    onResult(stored.lastResult, { keepTab: true });
    if (stored.lastResult.finishedAt) {
      const agoMin = Math.round(
        (Date.now() - stored.lastResult.finishedAt) / 60000
      );
      const ago = agoMin > 0 ? t("lastResultAgo", { n: agoMin }) : "";
      setStatus(t("lastResult", { ago }), "ok");
    }
  } else if (stored.lastResult?.impersonating) {
    try {
      await chrome.storage.local.remove(["lastResult"]);
    } catch {
      /* ignore */
    }
  }

  loadHeaderAccount();
}

async function loadHeaderAccount() {
  try {
    const tabId = await resolveIgTabId();
    if (!tabId) return;
    await ensureContentScript(tabId);
    const res = await chrome.tabs.sendMessage(tabId, { type: "GET_ME" });
    if (res?.ok && res.me) {
      if (
        state.resultPlatform &&
        state.platformId &&
        state.resultPlatform !== state.platformId
      ) {
        const label = currentPlatform()?.label || "";
        accountLine.textContent = label
          ? `@${res.me.username} · ${label}`
          : `@${res.me.username}`;
        return;
      }
      state.me = { ...(state.me || {}), ...res.me };
      refreshHeaderDisplay();
    }
  } catch {
    /* no website tab */
  }
}

async function runGlobalAnalysis() {
  if (state.analysisRunning) {
    setStatus(t("analysisRunning"), "error");
    return;
  }

  // Second+ run in this popup session → tip / own-risk popover
  if (state.analysisRuns >= 1) {
    const ok = await askTipConfirm();
    if (!ok) return;
  }

  state.analysisRunning = true;
  startBtn.disabled = true;
  progressFill.style.width = "8%";
  setProgressUi(true, t("connecting"));
  closeSettings();

  try {
    const tab = await getIgTab();
    await ensureContentScript(tab.id);
    const res = await chrome.tabs.sendMessage(tab.id, { type: "ANALYZE" });
    if (!res?.started && res?.error) {
      throw new Error(res.error);
    }
    state.analysisRuns += 1;
    setProgressUi(true, t("loadingLists"));
  } catch (err) {
    state.analysisRunning = false;
    startBtn.disabled = false;
    setProgressUi(false);
    setStatus(err?.message || String(err), "error");
  }
}

startBtn.addEventListener("click", () => runGlobalAnalysis());

tipModalContinue?.addEventListener("click", () => closeTipModal(true));
tipModalCancel?.addEventListener("click", () => closeTipModal(false));
tipModal?.addEventListener("click", (e) => {
  if (e.target === tipModal) closeTipModal(false);
});

document.querySelectorAll("#tabs .tab").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

document.querySelectorAll(".stat-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    switchSection("relationships");
    switchTab(btn.dataset.tab);
  });
});

document.querySelectorAll(".section-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchSection(btn.dataset.section));
});

botSearchInput?.addEventListener("input", () => {
  state.botQuery = botSearchInput.value;
  renderBots();
});

searchInput.addEventListener("input", () => {
  state.query = searchInput.value;
  renderAll();
  switchTab(state.activeTab, { force: true });
});

exportBtn.addEventListener("click", () => {
  if (!state.counts) return;
  const payload = {
    exportedAt: new Date().toISOString(),
    account: state.me,
    counts: state.counts,
    following: state.following,
    followers: state.followers,
    mutual: state.mutual,
    notFollowingBack: state.notFollowingBack,
    notFollowedByMe: state.notFollowedByMe,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `follow-check-${state.me?.username || "export"}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

init();
