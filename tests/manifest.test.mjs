// Packaging invariants touched by this change: shared helpers load first, no new permissions.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { ROOT } from "./helpers/harness.mjs";

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

test("every isolated-world content script that uses fc-shared helpers loads fc-shared.js first", () => {
  for (const script of ["content.js", "github.js", "bluesky.js"]) {
    const entry = manifest.content_scripts.find((cs) => cs.js.includes(script));
    assert.ok(entry, `${script} registered`);
    assert.ok(entry.js.indexOf("fc-shared.js") > -1 && entry.js.indexOf("fc-shared.js") < entry.js.indexOf(script), script);
  }
});

test("popup re-injection uses the same script order (PLATFORMS.shared)", () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "platforms.js"), "utf8") + "\n;globalThis.__p = PLATFORMS;", ctx);
  for (const p of ctx.__p) assert.equal(p.shared, true, p.id);
});

test("permissions and host permissions are unchanged", () => {
  assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "storage", "cookies"]);
  assert.deepEqual(manifest.host_permissions, [
    "https://www.instagram.com/*",
    "https://*.cdninstagram.com/*",
    "https://*.fbcdn.net/*",
    "https://github.com/*",
    "https://api.github.com/*",
    "https://bsky.app/*",
    "https://public.api.bsky.app/*",
  ]);
});
