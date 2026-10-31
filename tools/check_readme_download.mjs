#!/usr/bin/env node
// README download gate (Marcy 2026-10-30: the README said "Download 1.0.0-dev.7" while dev.8 was out; "with a gate
// too"): the README's download names the newest published release. Source of truth: latest-dev.json, the signed
// Development feed, which names the newest of the dev and stable releases (docs/RELEASING.md). In README.md it fails
// when "Download X.Y.Z…" or a `releases/tag/vX.Y.Z…` link names another version.
//   node tools/check_readme_download.mjs          the gate (npm run gates)
//   node tools/check_readme_download.mjs --fix    rewrites them to the feed's version (tools/release.sh, in the feed commit)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = join(dirname(fileURLToPath(import.meta.url)), "..");

const VERSION = String.raw`\d+\.\d+\.\d+(?:-dev\.\d+)?`;
const DOWNLOAD = new RegExp(String.raw`(Download )(${VERSION})`, "g");
const TAG = new RegExp(String.raw`(releases/tag/v)(${VERSION})`, "g");

/** The README's download versions that aren't `version`, one problem each. */
export function checkDownload(readme, version) {
  const out = [];
  // loop: NOT-WORTH — the README's few download mentions
  for (const re of [DOWNLOAD, TAG]) {
    // loop: NOT-WORTH — as above
    for (const m of readme.matchAll(re)) {
      if (m[2] !== version) out.push(`README.md: "${m[0]}" isn't the newest release, ${version} (latest-dev.json): run node tools/check_readme_download.mjs --fix`);
    }
  }
  if (!readme.match(DOWNLOAD)) out.push(`README.md has no "Download ${version}"`);
  return out;
}

/** The README with every download version set to `version`. */
export const fixDownload = (readme, version) => readme.replace(DOWNLOAD, `$1${version}`).replace(TAG, `$1${version}`);

const feedVersion = (app) => JSON.parse(readFileSync(join(app, "latest-dev.json"), "utf8")).version;

export function checkAll(app = APP) {
  return checkDownload(readFileSync(join(app, "README.md"), "utf8"), feedVersion(app));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.includes("--fix")) {
    const p = join(APP, "README.md");
    writeFileSync(p, fixDownload(readFileSync(p, "utf8"), feedVersion(APP)));
  }
  const problems = checkAll();
  if (problems.length) {
    console.log("README download gate (README.md, latest-dev.json, tools/check_readme_download.mjs):\n" + problems.join("\n"));
    process.exit(1);
  }
}
