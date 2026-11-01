/**
 * Build extension ZIP with current timestamps (avoids Chrome "1 Jan 1970" issue).
 * Usage: node scripts/package-zip.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const version = manifest.version;
const zipName = `instagram-follow-checker-v${version}.zip`;
const zipPath = path.join(root, zipName);
const stage = path.join(root, "_release_stage");

const files = [
  "manifest.json",
  "content.js",
  "ig-bridge.js",
  "fc-shared.js",
  "github.js",
  "bluesky.js",
  "platforms.js",
  "popup.html",
  "popup.js",
  "popup.css",
  "i18n.js",
  "analytics.js",
  "LICENSE",
  "README.md",
  "PRIVACY.md",
];

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function touch(p) {
  const now = new Date();
  fs.utimesSync(p, now, now);
}

rmrf(stage);
rmrf(zipPath);
fs.mkdirSync(stage, { recursive: true });

for (const f of files) {
  const src = path.join(root, f);
  if (fs.existsSync(src)) {
    const dest = path.join(stage, f);
    fs.copyFileSync(src, dest);
    touch(dest);
  }
}
fs.cpSync(path.join(root, "icons"), path.join(stage, "icons"), { recursive: true });
for (const f of fs.readdirSync(path.join(stage, "icons"))) {
  touch(path.join(stage, "icons", f));
}

// Use tar if available (good timestamps on Windows/Linux)
try {
  execFileSync("tar", ["-a", "-c", "-f", zipPath, ...fs.readdirSync(stage)], {
    cwd: stage,
    stdio: "inherit",
  });
} catch {
  // Fallback: PowerShell Compress-Archive
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${stage.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
    ],
    { stdio: "inherit" }
  );
}

rmrf(stage);
console.log(`Created ${zipPath}`);
