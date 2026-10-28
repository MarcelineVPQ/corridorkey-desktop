#!/usr/bin/env node
// Check the published feeds the way the app does: the signature by a key in
// TRUSTED_KEYS, then every field (electron/main/updateFeed.ts). Run it after
// any release or feed change, before calling it done.
//   node tools/verify-feed.mjs            the live feeds on GitHub (both channels)
//   node tools/verify-feed.mjs --channel dev --version 1.0.0-dev.2
//                                         only that channel's live feed, which must name that version (tools/release.sh)
//   node tools/verify-feed.mjs latest.json latest-dev.json   local files (+ .sig beside them)
// Live feeds are read through GitHub's contents API at the feed branch: the pushed commit's bytes, not a CDN copy
// that can lag minutes behind a push. Uses GITHUB_TOKEN when set.
import { readFileSync } from "node:fs";
import { FEED_BRANCH, FEED_URLS, feedSignedBy, parseFeed, REPO, TRUSTED_KEYS } from "./feed-rules.mjs";

// the deadline of one feed read
const FEED_TIMEOUT_MS = 30_000;
const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const only = opt("--channel");
const want = opt("--version");
if (only !== undefined && only !== "stable" && only !== "dev") throw new Error(`unknown channel ${only}`);
if (want !== undefined && only === undefined) throw new Error("--version needs --channel");
// loop: NOT-WORTH — a few arguments
const local = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const headers = { Accept: "application/vnd.github.raw", "User-Agent": "corridorkey-feed-verifier" };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
const read = async (src) => {
  if (local.length) return readFileSync(src, "utf8");
  const name = src.slice(src.lastIndexOf("/") + 1);
  // loop: SERIAL-REQUIRED — one feed read per check (release.sh, or by hand) [bounded: FEED_TIMEOUT_MS]
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${name}?ref=${FEED_BRANCH}`, { headers, cache: "no-store", signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return r.text();
};
// loop: NOT-WORTH — one or two feeds
const all = local.length ? local.map((f) => ({ src: f, channel: /latest-dev\.json$/.test(f) ? "dev" : "stable" })) : Object.entries(FEED_URLS).map(([channel, src]) => ({ src, channel }));
// loop: NOT-WORTH — one or two feeds
const items = only ? all.filter((i) => i.channel === only) : all;
if (!items.length) throw new Error(`no ${only} feed given`);
let bad = 0;
// loop: NOT-WORTH — two feeds
for (const { src, channel } of items) {
  try {
    const [text, sig] = await Promise.all([read(src), read(`${src}.sig`)]);
    if (!feedSignedBy(text, sig, TRUSTED_KEYS)) throw new Error("not signed by a trusted key");
    const f = parseFeed(text, channel);
    if (want !== undefined && f.version !== want) throw new Error(`names ${f.version}, not ${want}`);
    console.log(`OK   ${src}: ${f.version} (${f.size} bytes)`);
  } catch (e) {
    bad++;
    console.log(`FAIL ${src}: ${e.message}`);
  }
}
process.exit(bad ? 1 : 0);
