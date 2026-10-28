#!/usr/bin/env node
// Build latest.json (Stable) or latest-dev.json (Development), the update feed
// the app reads, from what is ALREADY published on GitHub. The AppImage is
// downloaded and hashed here, so a feed can never point at a file that doesn't
// exist or doesn't match. Never edit the feeds by hand: tools/release.sh runs
// this, signs and verifies the result. docs/RELEASING.md.
//
//   node tools/build-feed.mjs --channel stable|dev [--out latest.json]
//
// The rules (which release, the exact text) are the app's own
// (electron/main/updateFeed.ts: selectRelease, feedText), tested in
// tests/unit/updateFeed.test.ts, loaded through tools/feed-rules.mjs.
// Exit 2: no matching release yet (nothing written). Uses GITHUB_TOKEN when set.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { feedText, REPO, selectRelease } from "./feed-rules.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const channel = opt("--channel", "stable");
if (channel !== "stable" && channel !== "dev") throw new Error(`unknown channel ${channel}`);
const out = opt("--out", channel === "dev" ? "latest-dev.json" : "latest.json");
const headers = { Accept: "application/vnd.github+json", "User-Agent": "corridorkey-feed-builder" };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
// the deadlines of the two network reads (tools/release.sh runs this on the release PC; a stalled read fails the release)
const API_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
// GitHub's release list, 100 per page
const MAX_PAGES = 10;

async function measure(asset) {
  // loop: SERIAL-REQUIRED — one release asset download per feed build [bounded: DOWNLOAD_TIMEOUT_MS, body included]
  const r = await fetch(asset.browser_download_url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!r.ok || !r.body) throw new Error(`${asset.name}: download returned ${r.status}`);
  const hash = createHash("sha512");
  let size = 0;
  // loop: SERIAL-REQUIRED — the hash is sequential; one AppImage, once per feed build [bounded: DOWNLOAD_TIMEOUT_MS]
  for await (const chunk of r.body) {
    size += chunk.byteLength;
    hash.update(chunk);
  }
  if (size !== asset.size) throw new Error(`${asset.name}: size ${size} != ${asset.size}`);
  return { sha512: hash.digest("hex"), size };
}

// every release, page by page (GitHub lists 100 at most per page; model sets and dev builds add up), newest first
const releases = [];
let next = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
// loop: SERIAL-REQUIRED — GitHub's release list, one page after the other (each names the next) [bounded: MAX_PAGES pages, API_TIMEOUT_MS each]
for (let page = 0; next && page < MAX_PAGES; page++) {
  // loop: SERIAL-REQUIRED — one GitHub API read per page [bounded: API_TIMEOUT_MS]
  const r = await fetch(next, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`GitHub API returned ${r.status}`);
  releases.push(...(await r.json()));
  next = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get("link") ?? "")?.[1];
}
if (next) throw new Error(`more than ${MAX_PAGES * 100} releases: raise MAX_PAGES`);
const picked = selectRelease(releases, channel);
if (!picked) {
  console.error(`No ${channel} release with an AppImage yet; not writing ${out}.`);
  process.exit(2);
}
const measured = await measure(picked.asset);
const rel = picked.release;
writeFileSync(out, feedText(channel, { tag: rel.tag_name, version: picked.version, date: rel.published_at ?? "", notesUrl: rel.html_url ?? "", notes: rel.body ?? "" }, measured));
console.log(`Wrote ${out}: ${picked.version}`);
