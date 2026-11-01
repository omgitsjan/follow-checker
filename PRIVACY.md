# Privacy Policy – Follow Checker

**Last updated:** 2026-08-28  
**Developer:** omgitsjan ([GitHub](https://github.com/omgitsjan))  
**Extension:** Follow Checker  
**Source code:** https://github.com/omgitsjan/instagram-follow-checker  

This privacy policy explains how the **Follow Checker** Chrome extension (“the Extension”) handles information when you use it.

The Extension is unofficial and is **not** affiliated with, endorsed by, or sponsored by Meta or related companies.

---

## 1. Summary

- The Extension runs **locally in your browser**.
- It does **not** send your follower/following lists, website data, or analysis results to our servers.
- We do **not** operate a backend that collects personal data for this Extension.
- Optional links (GitHub, PayPal tip) open third-party websites outside the Extension; those sites have their own policies.

---

## 2. Single purpose

The Extension has one purpose only:

**Help you review follow relationships** (mutual follows, people who do not follow you back, and people you do not follow) using the Instagram, GitHub, or Bluesky session already open in your browser. Unfollow can open the profile for you to do it yourself, or — on Instagram only, if you turn Direct on — send the unfollow from the extension.

---

## 3. What data is processed

When you run an analysis while logged into Instagram, GitHub, or Bluesky in Chrome, the Extension may process **in your browser**:

| Data | Examples | Where it is handled |
|------|----------|---------------------|
| Account identifiers | Your user id / username (from the open session) | Locally in the browser |
| Relationship lists | Usernames, display names, profile picture URLs, private/public flags of accounts in your followers/following lists | Locally in the browser |
| Analysis results | Mutual / not following back / not followed lists | Locally in Chrome storage (optional cache) |
| Preferences | UI language (English/German), unfollow mode (safe/direct) | Locally in Chrome storage |

The Extension does **not** ask you to enter your website password into the Extension UI. It uses the session you already have on the site you opened.

### What we do **not** collect

We do **not** intentionally collect or transmit to the developer:

- Name, email, address, government ID  
- Health or financial information  
- Authentication secrets (passwords, PINs) typed into the Extension  
- Private messages / DMs content for our own storage  
- Precise location or IP addresses for our own analytics  
- Browsing history outside instagram.com pages needed for the feature  
- Keystroke/mouse analytics for tracking  

---

## 4. How data is used

Data processed by the Extension is used **only** to:

1. Load and compare your followers and following lists  
2. Display results in the Extension popup  
3. Perform follow/unfollow actions you explicitly trigger  
4. Remember language preference and optionally the last local analysis result  

Data is **not** used for advertising, credit scoring, resale, or unrelated analytics.

---

## 5. Storage and retention

- Preferences and the last analysis result may be stored via `chrome.storage.local` **on your device**.  
- You can remove this data by removing the Extension or clearing extension storage in Chrome.  
- We do not maintain a cloud copy of your lists.

---

## 6. Third parties

### Instagram / Meta  
Using the Instagram website is subject to Meta terms and privacy policies. Network requests the Extension makes while you use that website go to that site’s infrastructure (same kind of web endpoints the website uses). We do not control Meta’s processing.

### GitHub (open source link)  
If you open the open-source link, GitHub’s privacy policy applies.

### PayPal (optional tip)  
If you open the tip/donation link, PayPal’s privacy policy applies. The Extension does not process payment card data.

### No sale of data  
We do **not** sell or rent user data. We do **not** transfer extension analysis data to data brokers.

---

## 7. Remote code

The Extension does **not** load or execute remote JavaScript/Wasm. All extension scripts ship inside the package (`popup.js`, `content.js`, `i18n.js`, etc.).

---

## 8. Permissions (why they exist)

| Permission | Reason |
|------------|--------|
| `activeTab` / tab messaging | Communicate with the open Instagram, GitHub, or Bluesky tab to start analysis and actions |
| `scripting` | Inject/ensure the content script on that site when needed |
| `storage` | Save language, unfollow mode, and the last local result |
| Host access to `instagram.com`, `github.com`, `api.github.com`, `bsky.app`, `public.api.bsky.app` (and Instagram image CDNs) | Read relationship lists via the logged-in session and show profile pictures |

---

## 9. Children

The Extension is not directed at children under 13 (or the minimum age required by local law / the website). Do not use it if you are not allowed to use instagram.com.

---

## 10. Your choices

- Do not start an analysis if you do not want relationship lists processed locally.  
- Uninstall the Extension to stop processing and remove local extension data (subject to Chrome behavior).  
- Use the website’s own settings and tools for account-level privacy.

---

## 11. Changes

We may update this policy when the Extension changes. The “Last updated” date at the top will change. Continued use after updates means you accept the revised policy for future use.

---

## 12. Contact

Questions about this policy or the Extension:  
open an issue on the repository:  
https://github.com/omgitsjan/instagram-follow-checker/issues  

Or contact the developer via their GitHub profile:  
https://github.com/omgitsjan  

---

## 13. German short notice / Deutsch

Diese Erweiterung verarbeitet Follower-/Following-Informationen **nur lokal in deinem Browser**, speichert optional Sprache und das letzte Ergebnis in `chrome.storage.local` und **sendet keine Analyse-Daten an Server des Entwicklers**. Es gibt **keinen Remotecode**. Inoffiziell, nicht mit Meta verbunden. Nutzung von instagram.com unterliegt den Regeln von Meta. Optional Links zu GitHub und PayPal führen zu Drittanbietern mit eigenen Datenschutzregeln.  
Vollständige Angaben siehe Abschnitte oben (English is the full legal text).
