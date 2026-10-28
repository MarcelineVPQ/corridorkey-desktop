#!/usr/bin/env node
// Sign a feed file (or the release's SUMS): an Ed25519 signature over its exact bytes, base64, written
// to <file>.sig. The app refuses a feed no key in TRUSTED_KEYS
// (electron/main/updateFeed.ts) signed.
//   CK_FEED_KEY="$(cat key.pem)" node tools/sign-feed.mjs latest.json
// tools/release.sh reads the key from ~/.config/corridorkey-release/feed-signing.pem
// on the release PC into CK_FEED_KEY; without it this fails, so an unsigned feed is
// never published. It never prints the private key. release.sh also signs the
// release's SHA256SUMS / SHA512SUMS with it.
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2] || "latest.json";
const pem = process.env.CK_FEED_KEY;
if (!pem) {
  console.error("CK_FEED_KEY is not set: refusing to publish an unsigned feed.");
  process.exit(1);
}
const key = createPrivateKey(pem);
const data = readFileSync(file);
const signature = sign(null, data, key);
if (!verify(null, data, createPublicKey(key), signature)) throw new Error("signature self-check failed");
writeFileSync(`${file}.sig`, signature.toString("base64") + "\n");
console.log(`${file}.sig written (key ${createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64")})`);
