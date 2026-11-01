/**
 * Lightweight validation for the unpacked Chrome extension.
 * No dependencies – runs with Node.js only.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const warnings = [];

function fail(msg) {
  errors.push(msg);
}
function warn(msg) {
  warnings.push(msg);
}

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

function readJson(rel) {
  const full = path.join(root, rel);
  try {
    return JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (e) {
    fail(`${rel}: invalid JSON – ${e.message}`);
    return null;
  }
}

// --- required files ---
const required = [
  "manifest.json",
  "content.js",
  "ig-bridge.js",
  "background.js",
  "fc-shared.js",
  "github.js",
  "bluesky.js",
  "platforms.js",
  "popup.html",
  "popup.js",
  "popup.css",
  "i18n.js",
  "analytics.js",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png",
  "LICENSE",
  "README.md",
];

for (const f of required) {
  if (!exists(f)) fail(`Missing required file: ${f}`);
}

// --- manifest ---
const manifest = readJson("manifest.json");
if (manifest) {
  if (manifest.manifest_version !== 3) {
    fail("manifest_version must be 3");
  }
  if (!manifest.name) fail("manifest.name is required");
  if (!manifest.version) fail("manifest.version is required");
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version))) {
    warn(`manifest.version "${manifest.version}" is not semver x.y.z`);
  }
  if (!manifest.action?.default_popup) {
    fail("manifest.action.default_popup is required");
  } else if (!exists(manifest.action.default_popup)) {
    fail(`default_popup file missing: ${manifest.action.default_popup}`);
  }

  const iconSets = [manifest.icons, manifest.action?.default_icon].filter(Boolean);
  for (const icons of iconSets) {
    for (const [size, file] of Object.entries(icons)) {
      if (!exists(file)) fail(`Icon ${size} missing: ${file}`);
    }
  }

  const sw = manifest.background?.service_worker;
  if (sw && !exists(sw)) fail(`background service_worker missing: ${sw}`);

  for (const cs of manifest.content_scripts || []) {
    for (const js of cs.js || []) {
      if (!exists(js)) fail(`content_scripts js missing: ${js}`);
    }
  }

  const risky = (manifest.permissions || []).filter((p) =>
    ["debugger", "webRequestBlocking", "proxy"].includes(p)
  );
  if (risky.length) warn(`Unusual permissions: ${risky.join(", ")}`);
}

// --- basic HTML / CSS presence checks ---
if (exists("popup.html")) {
  const html = fs.readFileSync(path.join(root, "popup.html"), "utf8");
  if (!html.includes("popup.js")) fail("popup.html does not reference popup.js");
  if (!html.includes("popup.css")) fail("popup.html does not reference popup.css");
}

// --- summary ---
if (warnings.length) {
  console.log("Warnings:");
  for (const w of warnings) console.log(`  ⚠  ${w}`);
  console.log("");
}

if (errors.length) {
  console.error("Validation failed:");
  for (const e of errors) console.error(`  ✖  ${e}`);
  process.exit(1);
}

console.log("✓ Extension structure looks good");
console.log(`  name:    ${manifest?.name}`);
console.log(`  version: ${manifest?.version}`);
console.log(`  files:   ${required.filter(exists).length}/${required.length} required present`);
