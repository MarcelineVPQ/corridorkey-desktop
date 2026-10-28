#!/usr/bin/env node
// Protocol gate (audit row 6): docs/ENGINE_PROTOCOL.md describes every reply the engines send, and the app speaks
// only what the engine knows. Sources of truth: the replies in the Rust engine (ck-engine/src, ck-core/src without
// tests: each `{"type": "…", …}` object and each `msg["key"] = json!(…)`), the reference engine
// (tools/reference/ck_engine.py), ck-core's ErrorCode::as_str and ck-engine's request match. It fails when
//   (a) a reply type isn't in the doc as `"type":"…"`;
//   (b) a reply's top-level key isn't in the doc (as "key" or `key`);
//   (c) an error code is missing from the doc's error reply line;
//   (d) the app (electron/main) sends a `cmd` the Rust engine doesn't handle, or the doc has no `"cmd":"…"` for it;
//   (e) the app handles a reply type (`x.type === "…"`, a `switch (x.type)` case) no engine sends;
//   (f) the app reads a pong field (queue.ts `pong.x`) the Rust engine's pong doesn't send, or a pong field is neither
//       read nor in PONG_NOT_READ (with why), or PONG_NOT_READ lists a field that is read or no longer sent.
//   node tools/check_protocol_doc.mjs    the gate (npm run gates)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = join(dirname(fileURLToPath(import.meta.url)), "..");

// The Rust engine's pong fields the app doesn't read, and why. A new pong field gets read or a line here.
export const PONG_NOT_READ = new Map([
  ["type", "the reply's kind"],
  ["coreml_available", "for Marcy (2026-10-27): show the engine's no-provider reason on the engine card? Not shown today"],
  ["unavailable", "for Marcy (2026-10-27): show the engine's no-provider reason on the engine card? Not shown today"],
  ["tensorrt_available", "the app asks for TensorRT only with the setting on and its parts installed (install.ts trtReady)"],
  ["python", "the PyTorch reference engine's field; null in the Rust engine"],
  ["torch", "the PyTorch reference engine's field; null in the Rust engine"],
  ["config", "diagnostics: the engine's settings, also on its stderr"],
  ["decoders", "diagnostics: each job's _settings.txt and log say the same"],
  ["ocio", "diagnostics: each OCIO job's _settings.txt says the version"],
]);

/** Skip a string literal starting at s[i] (a quote); returns the index of its closing quote. */
function endOfString(s, i) {
  let j = i + 1;
  // loop: NOT-WORTH — one string literal's characters
  while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
  return j;
}

/** Each reply object in a source: `{ "type": "x", … }` → { type, keys (top-level), at }. */
export function replyObjects(src) {
  const out = [];
  // loop: NOT-WORTH — the replies of one source file
  for (const m of src.matchAll(/"type":\s*"(\w+)"/g)) {
    let depth = 0;
    let i = m.index - 1;
    // loop: NOT-WORTH — back to the object's opening brace (one object) [bounded: i ≥ 0]
    for (; i >= 0; i--) {
      if (src[i] === "}") depth++;
      else if (src[i] === "{" && depth-- === 0) break;
    }
    if (i < 0) continue;
    const keys = [];
    depth = 0;
    // loop: NOT-WORTH — one object's characters [bounded: the source's length]
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      if (c === "{" || c === "[") depth++;
      else if ((c === "}" || c === "]") && --depth === 0) break;
      else if (c === '"') {
        const end = endOfString(src, j);
        if (depth === 1 && /^\s*:/.test(src.slice(end + 1, end + 4))) keys.push(src.slice(j + 1, end));
        j = end;
      }
    }
    out.push({ type: m[1], keys, at: src.slice(0, m.index).split("\n").length });
  }
  return out;
}

/** Keys a Rust source adds to a reply after building it: `msg["key"] = json!(…)`. */
export function assignedKeys(rs) {
  // loop: NOT-WORTH — one file's assignments
  return [...rs.matchAll(/\w+\["(\w+)"\]\s*=\s*json!/g)].map((m) => m[1]);
}

/** A Rust file without its `#[cfg(test)] mod tests` (at the end, as this repository writes them). */
export function withoutTests(rs) {
  const t = rs.search(/^\s*#\[cfg\(test\)\]\s*\n\s*mod tests/m);
  return t < 0 ? rs : rs.slice(0, t);
}

const documented = (doc, key) => doc.includes(`"${key}"`) || doc.includes(`\`${key}\``);

/** (a)–(c): the doc against the engines' replies (`sources`: { path, text } without tests) and error codes. */
export function checkDoc(doc, sources, errorCodes) {
  const out = [];
  const seen = new Set();
  // loop: NOT-WORTH — the engines' source files, once per gate run
  for (const { path, text } of sources) {
    // loop: NOT-WORTH — the replies of one file
    for (const r of replyObjects(text)) {
      if (!seen.has(`type:${r.type}`) && !new RegExp(`"type"\\s*:\\s*"${r.type}"`).test(doc)) out.push(`${path}:${r.at}: reply type "${r.type}" isn't in docs/ENGINE_PROTOCOL.md`);
      seen.add(`type:${r.type}`);
      // loop: NOT-WORTH — one reply's keys
      for (const k of r.keys) {
        if (!seen.has(k) && !documented(doc, k)) out.push(`${path}:${r.at}: the "${r.type}" reply's key "${k}" isn't in docs/ENGINE_PROTOCOL.md`);
        seen.add(k);
      }
    }
    // loop: NOT-WORTH — one file's assignments
    for (const k of path.endsWith(".rs") ? assignedKeys(text) : []) {
      if (!seen.has(k) && !documented(doc, k)) out.push(`${path}: a reply's key "${k}" (assigned) isn't in docs/ENGINE_PROTOCOL.md`);
      seen.add(k);
    }
  }
  const line = doc.match(/"type":"error".*?"code":"([^"]+)"/);
  const listed = line ? line[1].split("|") : [];
  // loop: NOT-WORTH — eight error codes
  for (const c of errorCodes) if (!listed.includes(c)) out.push(`docs/ENGINE_PROTOCOL.md: the error reply's code list misses "${c}"`);
  return out;
}

/** (d)–(f): the app against the Rust engine. */
export function checkApp(appFiles, doc, engineCmds, replyTypes, pongKeys, notRead = PONG_NOT_READ) {
  const out = [];
  const read = new Set();
  // loop: NOT-WORTH — electron/main's files, once per gate run
  for (const { path, text } of appFiles) {
    // loop: NOT-WORTH — a few requests per file
    for (const m of text.matchAll(/\bcmd: "(\w+)"/g)) {
      if (!engineCmds.includes(m[1])) out.push(`${path}: sends cmd "${m[1]}", which ck-engine doesn't handle`);
      if (!new RegExp(`"cmd"\\s*:\\s*"${m[1]}"`).test(doc)) out.push(`${path}: cmd "${m[1]}" isn't in docs/ENGINE_PROTOCOL.md's requests`);
    }
    const handled = [];
    // loop: NOT-WORTH — a few type tests per file
    for (const m of text.matchAll(/\.type === "(\w+)"/g)) handled.push(m[1]);
    // loop: NOT-WORTH — a switch or two per file
    for (const m of text.matchAll(/switch \(\w+\.type\) \{/g)) {
      let depth = 0;
      let end = m.index;
      // loop: NOT-WORTH — one switch's characters [bounded: the file's length]
      for (; end < text.length; end++) {
        if (text[end] === "{") depth++;
        else if (text[end] === "}" && --depth === 0) break;
      }
      // loop: NOT-WORTH — the switch's cases
      for (const c of text.slice(m.index, end).matchAll(/case "(\w+)":/g)) handled.push(c[1]);
    }
    // loop: NOT-WORTH — a few handled types
    for (const t of handled) if (!replyTypes.includes(t)) out.push(`${path}: handles reply type "${t}", which no engine sends`);
    if (path.endsWith("queue.ts")) {
      // loop: NOT-WORTH — the pong's fields
      for (const m of text.matchAll(/\bpong\.(\w+)/g)) read.add(m[1]);
    }
  }
  // loop: NOT-WORTH — the pong's fields
  for (const k of read) if (!pongKeys.includes(k)) out.push(`electron/main/queue.ts: reads pong.${k}, which the Rust engine's pong doesn't send`);
  // loop: NOT-WORTH — the pong's fields
  for (const k of pongKeys)
    if (!read.has(k) && !notRead.has(k)) out.push(`the pong's "${k}": the app neither reads it (queue.ts) nor lists it in PONG_NOT_READ (tools/check_protocol_doc.mjs) with why`);
  // loop: NOT-WORTH — a few listed fields
  for (const k of notRead.keys()) if (read.has(k) || !pongKeys.includes(k)) out.push(`PONG_NOT_READ lists "${k}", which the app ${read.has(k) ? "reads" : "no longer gets"}: remove it`);
  return out;
}

function rustSources(app, root) {
  const out = [];
  const walk = (d) => {
    // loop: NOT-WORTH — the crate's source entries, once per gate run
    for (const n of readdirSync(join(app, d))) {
      const p = join(d, n);
      if (statSync(join(app, p)).isDirectory()) {
        if (n !== "tests") walk(p);
      } else if (p.endsWith(".rs")) out.push({ path: p, text: withoutTests(readFileSync(join(app, p), "utf8")) });
    }
  };
  walk(root);
  return out;
}

export function checkAll(app = APP) {
  const read = (p) => readFileSync(join(app, p), "utf8");
  const doc = read("docs/ENGINE_PROTOCOL.md");
  const rust = [...rustSources(app, "engine-rs/crates/ck-engine/src"), ...rustSources(app, "engine-rs/crates/ck-core/src")];
  const python = { path: "tools/reference/ck_engine.py", text: read("tools/reference/ck_engine.py") };
  // loop: NOT-WORTH — eight match arms
  const errorCodes = [...read("engine-rs/crates/ck-core/src/lib.rs").matchAll(/ErrorCode::\w+ => "([^"]+)"/g)].map((m) => m[1]);
  const lib = withoutTests(read("engine-rs/crates/ck-engine/src/lib.rs"));
  // loop: NOT-WORTH — the request match's arms
  const engineCmds = [...lib.matchAll(/^\s*"(\w+)" =>/gm)].map((m) => m[1]);
  // loop: NOT-WORTH — the engines' files and replies, once per gate run
  const replyTypes = [...new Set([...rust, python].flatMap((s) => replyObjects(s.text).map((r) => r.type)))];
  // loop: NOT-WORTH — the engine's replies
  const pong = replyObjects(read("engine-rs/crates/ck-engine/src/main.rs")).find((r) => r.type === "pong");
  if (!pong || !errorCodes.length || !engineCmds.length) return ["check_protocol_doc: found no pong, error codes or request match in the Rust engine (moved?)"];
  // loop: NOT-WORTH — electron/main's files, once per gate run
  const appFiles = readdirSync(join(app, "electron/main"))
    .filter((n) => n.endsWith(".ts"))
    .map((n) => ({ path: `electron/main/${n}`, text: read(`electron/main/${n}`) }));
  return [...checkDoc(doc, [...rust, python], errorCodes), ...checkApp(appFiles, doc, engineCmds, replyTypes, pong.keys)];
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const problems = checkAll();
  if (problems.length) {
    console.log("Protocol gate (docs/ENGINE_PROTOCOL.md, tools/check_protocol_doc.mjs):\n" + problems.join("\n"));
    process.exit(1);
  }
}
