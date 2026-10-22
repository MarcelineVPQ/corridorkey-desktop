#!/usr/bin/env node
// Sign a feed file: an Ed25519 signature over its exact bytes, base64, written
// to <file>.sig. The app refuses a feed no key in TRUSTED_KEYS
// (electron/main/updateFeed.ts) signed.
//   CK_FEED_KEY="$(cat key.pem)" node tools/sign-feed.mjs latest.json
// The key is the CK_FEED_KEY Actions secret; without it this fails, so CI can
// never publish an unsigned feed. It never prints the private key.
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
