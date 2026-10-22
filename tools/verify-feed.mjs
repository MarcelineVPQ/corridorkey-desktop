#!/usr/bin/env node
// Check the published feeds the way the app does: the signature by a key in
// TRUSTED_KEYS, then every field (electron/main/updateFeed.ts). Run it after
// any release or feed change, before calling it done.
//   node tools/verify-feed.mjs            the live feeds on GitHub
//   node tools/verify-feed.mjs latest.json latest-dev.json   local files (+ .sig beside them)
import { readFileSync } from "node:fs";
import { FEED_URLS, feedSignedBy, parseFeed, TRUSTED_KEYS } from "./feed-rules.mjs";

const local = process.argv.slice(2);
const read = async (src) => {
  if (local.length) return readFileSync(src, "utf8");
  // loop: SERIAL-REQUIRED — one feed read per check (CI / by hand) [bounded: the feed job's timeout-minutes: 20]
  const r = await fetch(src, { cache: "no-store" });
  if (!r.ok) throw new Error(`${src}: HTTP ${r.status}`);
  return r.text();
};
// loop: NOT-WORTH — one or two feeds
const items = local.length ? local.map((f) => ({ src: f, channel: /latest-dev\.json$/.test(f) ? "dev" : "stable" })) : Object.entries(FEED_URLS).map(([channel, src]) => ({ src, channel }));
let bad = 0;
// loop: NOT-WORTH — two feeds
for (const { src, channel } of items) {
  try {
    const [text, sig] = await Promise.all([read(src), read(`${src}.sig`)]);
    if (!feedSignedBy(text, sig, TRUSTED_KEYS)) throw new Error("not signed by a trusted key");
    const f = parseFeed(text, channel);
    console.log(`OK   ${src}: ${f.version} (${f.size} bytes)`);
  } catch (e) {
    bad++;
    console.log(`FAIL ${src}: ${e.message}`);
  }
}
process.exit(bad ? 1 : 0);
