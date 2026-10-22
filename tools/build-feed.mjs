#!/usr/bin/env node
// Build latest.json (Stable) or latest-dev.json (Development), the update feed
// the app reads, from what is ALREADY published on GitHub. The AppImage is
// downloaded and hashed here, so a feed can never point at a file that doesn't
// exist or doesn't match. Never edit the feeds by hand: run the release or the
// "Update feed" workflow (.github/workflows/feed.yml). docs/RELEASING.md.
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

async function measure(asset) {
  // loop: SERIAL-REQUIRED — one release asset download per feed build (CI) [bounded: the feed job's timeout-minutes: 20]
  const r = await fetch(asset.browser_download_url, { redirect: "follow" });
  if (!r.ok || !r.body) throw new Error(`${asset.name}: download returned ${r.status}`);
  const hash = createHash("sha512");
  let size = 0;
  // loop: SERIAL-REQUIRED — the hash is sequential; one AppImage, once per feed per CI run
  for await (const chunk of r.body) {
    size += chunk.byteLength;
    hash.update(chunk);
  }
  if (size !== asset.size) throw new Error(`${asset.name}: size ${size} != ${asset.size}`);
  return { sha512: hash.digest("hex"), size };
}

// loop: SERIAL-REQUIRED — one GitHub API read per feed build (CI) [bounded: the feed job's timeout-minutes: 20]
const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=50`, { headers });
if (!r.ok) throw new Error(`GitHub API returned ${r.status}`);
const picked = selectRelease(await r.json(), channel);
if (!picked) {
  console.error(`No ${channel} release with an AppImage yet; not writing ${out}.`);
  process.exit(2);
}
const measured = await measure(picked.asset);
const rel = picked.release;
writeFileSync(out, feedText(channel, { tag: rel.tag_name, version: picked.version, date: rel.published_at ?? "", notesUrl: rel.html_url ?? "", notes: rel.body ?? "" }, measured));
console.log(`Wrote ${out}: ${picked.version}`);
