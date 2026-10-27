#!/usr/bin/env node
// The wiki gate (Marcy 2026-10-26: "keep the wiki up to date — make that a gate", "especially important for the
// command line"). The wiki's source is docs/wiki/ (one .md per page, as GitHub's wiki names them); tools/publish_wiki.mjs
// copies it into the wiki repository, and tools/release.sh refuses to release while the published wiki differs.
// Offline: it reads only this repository. It fails when
//   (a) a `corridorkey` command or flag (src/shared/console/cliSpec.json, the CLI's own `__spec --json`) is missing
//       from Command-Line.md, or a flag is in no example of a command that takes it (a fenced line `corridorkey <cmd> …`);
//   (b) an exit code (engine-rs/crates/ck-cli/src/exit.rs) has no row in Command-Line.md;
//   (c) a progress format (`--progress-format`'s values) is missing from Command-Line.md;
//   (d) a Console built-in (src/shared/console/registry.ts) is missing from Console.md;
//   (e) an engine message written for people (ck-core's errors that start with a capital letter, and the no-GPU
//       reason) is missing from Troubleshooting.md;
//   (f) a relative wiki link (`Page`, `Page#anchor`, `#anchor`) or a link into this repository on GitHub
//       (`…/corridorkey-desktop/blob/main/<file>#anchor`) doesn't resolve;
//   (g) an engine run option (ck-core job.rs) is missing: its flag (ck-cli args.rs) from Command-Line.md, or, without
//       a flag, its name from every page (unless WIKI_EXCEPTIONS says why); or a clip setting's on-screen label
//       (src/ui/JobSettings.tsx: a Section's title, a Row's label) is on no page;
//   (h) an app setting (src/shared/types.ts Settings and Appearance, electron/main/updatePrefs.ts UpdatePrefs) has no
//       row in SETTINGS below, or its label isn't on screen any more, or isn't on the wiki page the row names;
//   (i) a rail page (src/ui/rail/railModel.ts ITEMS) has no wiki page or section (a heading with its name).
// Its own sources only: it never reads the command line's parity manifest (tools/check_cli_parity.mjs, a gate of
// its own; Marcy 2026-10-27).
//
//   node tools/check_wiki.mjs                    the gate (npm run gates)
//   node tools/check_wiki.mjs --published DIR    exit 1 when the wiki clone in DIR differs from docs/wiki/ (release.sh)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
export const WIKI = join(APP, "docs", "wiki");
const REPO_URL = "https://github.com/MarcelineVPQ/corridorkey-desktop";

/** The wiki's pages: name (without .md) → text. */
export function readPages(dir = WIKI) {
  const pages = {};
  // loop: NOT-WORTH — the wiki's few dozen pages, once per gate run
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".md"))) pages[f.slice(0, -3)] = readFileSync(join(dir, f), "utf8");
  return pages;
}

/** The lines inside ``` fences, and the text outside them. */
export function splitFences(text) {
  const code = [];
  const prose = [];
  let inside = false;
  // loop: NOT-WORTH — one page's lines
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) inside = !inside;
    else (inside ? code : prose).push(line);
  }
  return { code, prose: prose.join("\n") };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const flagRe = (f) => new RegExp(`(^|[\\s\`(|,\\[])${esc(f)}(?=[\\s\`=,)|\\]]|$)`, "m");

/** The CLI's commands and their flags (hidden ones left out). */
export function cliCommands(spec) {
  // loop: NOT-WORTH — the CLI's four commands and their flags
  return spec.commands
    .filter((c) => !c.hidden)
    .map((c) => ({
      name: c.name,
      // loop: NOT-WORTH — one command's flags
      flags: c.args.filter((a) => !a.hidden && !a.positional && a.long).map((a) => ({ long: `--${a.long}`, short: a.short ? `-${a.short}` : null })),
    }));
}

/** `--progress-format`'s values. */
export function progressFormats(spec) {
  // loop: NOT-WORTH — the commands' flags, once
  const pf = spec.commands.flatMap((c) => c.args).find((a) => a.long === "progress-format");
  return pf?.possible_values ?? [];
}

/** The exit codes ck-cli declares (`pub const NAME: i32 = N;` in exit.rs). */
export function exitCodes(exitRs) {
  // loop: NOT-WORTH — a dozen constants
  return [...exitRs.matchAll(/pub const \w+: i32 = (\d+);/g)].map((m) => Number(m[1]));
}

/** The Console's built-in commands (`builtin("name", …)` in registry.ts). */
export function builtinNames(registryTs) {
  // loop: NOT-WORTH — a few dozen built-ins
  return [...registryTs.matchAll(/builtin\(\s*"([^"]+)"/g)].map((m) => m[1]);
}

/** The text of the parenthesised (or braced) span starting at `open` (its index), string literals skipped whole. */
function span(src, open) {
  const close = src[open] === "{" ? "}" : ")";
  let depth = 0;
  // loop: NOT-WORTH — the characters of one call, bounded by its source file
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      // loop: NOT-WORTH — the characters of one string literal
      for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === "\\") i++;
    } else if (c === "'" && /^'(\\.|[^\\'])'/.test(src.slice(i, i + 4))) {
      i += src[i + 1] === "\\" ? 3 : 2;
    } else if (c === src[open]) depth++;
    else if (c === close && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

const literals = (s) =>
  // loop: NOT-WORTH — the literals of one call
  [...s.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((m) => m[1].replace(/\\(["\\'])/g, "$1").replace(/\\\n\s*/g, ""));

/**
 * The engine's messages written for people: from each ck-core error a user can act on (`Error::input(…)`, `Error::new(…)`,
 * …; not `Error::engine`, a bug the message names) its
 * first string literal, and every literal of `fn unavailable_reason` / `fn no_provider_reason` (no usable card); each up to its first `{`
 * placeholder, kept when it starts with a capital letter (a sentence; the lower-case ones are protocol and internal
 * details, such as "id missing"). `files`: [{path, text}] of ck-core's sources.
 */
export function engineMessages(files) {
  const heads = new Set();
  // loop: NOT-WORTH — ck-core's two dozen source files, once per gate run
  for (const { path, text } of files) {
    if (/[\\/]tests[\\/]/.test(path)) continue;
    const src = text.split("#[cfg(test)]")[0];
    const found = [];
    // loop: NOT-WORTH — the error constructors in one file
    for (const m of src.matchAll(/Error::(?:input|assets|oom|no_gpu|bad_request|new)\(/g)) {
      const first = literals(span(src, m.index + m[0].length - 1))[0];
      if (first !== undefined) found.push(first);
    }
    // loop: NOT-WORTH — at most two such functions per file
    for (const m of src.matchAll(/fn (?:unavailable_reason|no_provider_reason)\([^)]*\)[^{]*\{/g)) found.push(...literals(span(src, m.index + m[0].length - 1)));
    // loop: NOT-WORTH — one file's messages
    for (const lit of found) {
      const head = lit.split("{")[0].trim();
      if (/^[A-Z]/.test(head) && head.length >= 8) heads.add(head);
    }
  }
  // loop: NOT-WORTH — sorts a few dozen messages once
  return [...heads].sort();
}

/** ck-core's .rs files under `root` (tests included: engineMessages skips them). */
export function rustFiles(root) {
  const out = [];
  const walk = (d) => {
    // loop: NOT-WORTH — ck-core's source tree, once per gate run
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".rs")) out.push({ path: p, text: readFileSync(p, "utf8") });
    }
  };
  walk(root);
  return out;
}

/** GitHub's heading anchor (lower case, punctuation dropped, spaces as -). */
export function slug(heading) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/ /g, "-");
}

/** A page's anchors: its headings' slugs (outside code fences; repeats as GitHub numbers them). */
export function anchors(text) {
  const seen = new Map();
  const out = new Set();
  // loop: NOT-WORTH — one page's headings
  for (const line of splitFences(text).prose.split("\n")) {
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const s = slug(m[1]);
    const n = seen.get(s) ?? 0;
    seen.set(s, n + 1);
    out.add(n ? `${s}-${n}` : s);
  }
  return out;
}

/** (a), (b), (c): Command-Line.md against the CLI's spec, its exit codes and progress formats. */
export function checkCommandLine(page, spec, exits) {
  if (page === undefined) return ["Command-Line.md is missing"];
  const problems = [];
  const { code, prose } = splitFences(page);
  const text = prose + "\n" + code.join("\n");
  const commands = cliCommands(spec);
  const examplesOf = (name) =>
    // loop: NOT-WORTH — the page's code lines, per command
    code.filter((l) => new RegExp(`(^|[\\s;(])corridorkey\\s+${esc(name)}(\\s|$)`).test(l));
  // loop: NOT-WORTH — four commands
  for (const c of commands) {
    const ex = examplesOf(c.name);
    if (!ex.length) problems.push(`Command-Line.md: no example of \`corridorkey ${c.name}\` (a fenced line)`);
    // loop: NOT-WORTH — one command's flags
    for (const f of c.flags) {
      if (!flagRe(f.long).test(text)) problems.push(`Command-Line.md: \`corridorkey ${c.name} ${f.long}\` is missing`);
      if (f.short && !flagRe(f.short).test(text)) problems.push(`Command-Line.md: \`corridorkey ${c.name} ${f.short}\` (${f.long}) is missing`);
    }
  }
  // a flag is shown by an example of any command that takes it (verify takes render's flags: one example serves both)
  const flags = new Map();
  // loop: NOT-WORTH — four commands' flags
  for (const c of commands) for (const f of c.flags) flags.set(f.long, { f, cmds: [...(flags.get(f.long)?.cmds ?? []), c.name] });
  // loop: NOT-WORTH — the CLI's flags
  for (const { f, cmds } of flags.values()) {
    // loop: NOT-WORTH — a flag's commands and their example lines
    const used = cmds.some((n) => examplesOf(n).some((l) => flagRe(f.long).test(l) || (f.short && flagRe(f.short).test(l))));
    if (!used) problems.push(`Command-Line.md: no example uses ${f.long} (a fenced line \`corridorkey ${cmds[0]} … ${f.long} …\`)`);
  }
  // loop: NOT-WORTH — a dozen exit codes
  for (const x of exits) if (!new RegExp(`^\\|\\s*\`?${x}\`?\\s*\\|`, "m").test(prose)) problems.push(`Command-Line.md: exit code ${x} has no table row`);
  // loop: NOT-WORTH — four formats
  for (const f of progressFormats(spec)) if (!prose.includes(`\`${f}\``)) problems.push(`Command-Line.md: progress format \`${f}\` is missing`);
  return problems;
}

/** (d): Console.md against the Console's built-ins. */
export function checkConsole(page, builtins) {
  if (page === undefined) return ["Console.md is missing"];
  // loop: NOT-WORTH — a few dozen built-ins
  return builtins.filter((b) => !new RegExp(`\`${esc(b)}[\\s\`]`).test(page)).map((b) => `Console.md: the built-in \`${b}\` is missing`);
}

/** (e): Troubleshooting.md against the engine's messages (backticks and white space don't count). */
export function checkTroubleshooting(page, messages) {
  if (page === undefined) return ["Troubleshooting.md is missing"];
  const norm = (s) => s.replace(/`/g, "").replace(/\s+/g, " ");
  const text = norm(page);
  // loop: NOT-WORTH — a few dozen messages
  return messages.filter((m) => !text.includes(norm(m))).map((m) => `Troubleshooting.md: the engine's message "${m}…" is missing`);
}

/** (f): every relative wiki link and every link into this repository resolves. `repoFile(path)` → text or null. */
export function checkLinks(pages, repoFile) {
  const problems = [];
  const pageAnchors = {};
  // loop: NOT-WORTH — the wiki's pages
  for (const [n, t] of Object.entries(pages)) pageAnchors[n] = anchors(t);
  const repoAnchors = new Map();
  // loop: NOT-WORTH — the wiki's pages and their links
  for (const [name, text] of Object.entries(pages)) {
    // loop: NOT-WORTH — one page's links
    for (const m of splitFences(text).prose.matchAll(/\]\(([^)\s]+)\)/g)) {
      const link = m[1];
      const bad = (why) => problems.push(`${name}.md: link (${link}) ${why}`);
      if (link.startsWith(REPO_URL + "/blob/main/")) {
        const [path, anchor] = link.slice(REPO_URL.length + "/blob/main/".length).split("#");
        const text = repoFile(decodeURIComponent(path));
        if (text === null) bad(`names ${path}, which isn't in the repository`);
        else if (anchor !== undefined) {
          if (!repoAnchors.has(path)) repoAnchors.set(path, anchors(text));
          if (!repoAnchors.get(path).has(anchor)) bad(`has no heading #${anchor} in ${path}`);
        }
      } else if (link.startsWith(REPO_URL + "/wiki/")) {
        const [p, anchor] = link.slice(REPO_URL.length + "/wiki/".length).split("#");
        if (!pages[p]) bad(`names the wiki page ${p}, which docs/wiki/ doesn't have`);
        else if (anchor !== undefined && !pageAnchors[p].has(anchor)) bad(`has no heading #${anchor} on ${p}`);
      } else if (/^[a-z]+:/i.test(link)) {
        continue;
      } else {
        const [p, anchor] = link.split("#");
        const target = p === "" ? name : p;
        if (!pages[target]) bad(`names the wiki page ${target}, which docs/wiki/ doesn't have`);
        else if (anchor !== undefined && !pageAnchors[target].has(anchor)) bad(`has no heading #${anchor} on ${target}`);
      }
    }
  }
  return problems;
}

/** (g) run options the wiki needn't name, and why (each must still be one the engine reads). */
export const WIKI_EXCEPTIONS = {
  num_frames: "the original's movie sample (docs/ENGINE_PROTOCOL.md): neither the app nor the command line sets it",
  start_mode: "the original's movie sample (docs/ENGINE_PROTOCOL.md): neither the app nor the command line sets it",
  seed: "the original's movie sample (docs/ENGINE_PROTOCOL.md): neither the app nor the command line sets it",
};

/**
 * (h) Every app setting: its label on screen (src/ui, the Console's registry) and the wiki page that explains it, or
 * `internal` and why it needs no page.
 */
export const SETTINGS = {
  lastOptions: { internal: "a new clip's settings, the last ones used (Your-First-Key says so); each is a clip setting, rule (g)" },
  appearance: { internal: "the group of theme, accent and glass below" },
  theme: { label: "Theme", page: "Your-First-Key" },
  accent: { label: "Accent color", page: "Your-First-Key" },
  glass: { label: "Glass", page: "Your-First-Key" },
  outputRoot: { label: "Where results go", page: "Your-First-Key" },
  engineBinary: { label: "Engine program", page: "Troubleshooting" },
  modelsDir: { label: "Models folder", page: "Troubleshooting" },
  ortLibrary: { label: "ONNX Runtime library", page: "Troubleshooting" },
  tensorrt: { label: "Use TensorRT", page: "TensorRT" },
  vramLimitGb: { label: "Memory limit", page: "Graphics-Memory-and-the-Window" },
  trtSizes: { label: "A size of my own", page: "TensorRT" },
  cacheRoot: { label: "Cache folder", page: "Uninstall" },
  consoleWriteFolders: { label: "May write in", page: "Console" },
  consoleBookmarks: { label: "bookmark", page: "Console" },
  consoleVariables: { label: "set -p", page: "Console" },
  channel: { label: "Channel", page: "Updates-and-Channels" },
  automatic: { label: "Check automatically", page: "Updates-and-Channels" },
};

/** The engine's run options: `(o, "key"` and `o.get("key")` / `o.contains_key("key")` in ck-core job.rs, tests left out. */
export function runOptions(jobRs) {
  // loop: NOT-WORTH — the run request's ~40 options, once per gate run
  return [...new Set([...jobRs.split("#[cfg(test)]")[0].matchAll(/\bo,\s*"(\w+)"|\bo\.(?:get|contains_key)\("(\w+)"\)/g)].map((m) => m[1] ?? m[2]))];
}

/** Each run option's flags (ck-cli args.rs: RUN_OPTIONS ("flag", "option", …), OTHER_OPTIONS ("option", "--flag")). */
export function optionFlags(argsRs) {
  const out = new Map();
  const add = (o, f) => out.set(o, [...(out.get(o) ?? []), f]);
  // loop: NOT-WORTH — ~30 tuples
  for (const m of argsRs.matchAll(/\("([a-z-]+)", "([a-z_]+)", Kind::/g)) add(m[2], `--${m[1]}`);
  // loop: NOT-WORTH — five tuples
  for (const m of argsRs.matchAll(/\("([a-z_]+)", "(--[a-z-]+)"\)/g)) add(m[1], m[2]);
  return out;
}

/** A panel's on-screen labels: each `<Section … title="X"` and `<Row … label="X"` (non-empty literals). */
export function screenLabels(tsx) {
  // loop: NOT-WORTH — a panel's few dozen rows
  return [...new Set([...tsx.matchAll(/<(?:Section|Row)\b[^>]*?\b(?:title|label)="([^"]+)"/g)].map((m) => m[1]))];
}

/** The keys of `interface <name> { … }` (one per line, two-space indent). */
export function interfaceKeys(ts, name) {
  const at = ts.indexOf(`interface ${name} {`);
  if (at < 0) return [];
  // loop: NOT-WORTH — one interface's keys
  return [...ts.slice(at, ts.indexOf("\n}", at)).matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
}

/** The rail's page names (railModel.ts ITEMS' labels). */
export function railLabels(railTs) {
  const at = railTs.indexOf("export const ITEMS");
  // loop: NOT-WORTH — five items
  return [...railTs.slice(at, railTs.indexOf("];", at)).matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
}

const has = (text, words) => text.toLowerCase().includes(words.toLowerCase());

/** (g): the run options and the clip settings' labels. `flags`: optionFlags; `exceptions`: WIKI_EXCEPTIONS. */
export function checkRunOptions(pages, options, flags, labels, exceptions = WIKI_EXCEPTIONS) {
  const problems = [];
  const cli = pages["Command-Line"] ?? "";
  // loop: NOT-WORTH — the wiki's pages, once
  const all = Object.values(pages).join("\n");
  // loop: NOT-WORTH — ~40 options
  for (const o of options) {
    const fl = flags.get(o) ?? [];
    if (fl.length) {
      // loop: NOT-WORTH — one or two flags
      if (!fl.some((f) => flagRe(f).test(cli))) problems.push(`Command-Line.md: the run option \`${o}\` (${fl.join(" / ")}) is missing`);
    } else if (!exceptions[o] && !all.includes(`\`${o}\``))
      problems.push(`the run option \`${o}\` (ck-core job.rs) has no flag and no wiki page names it: document it, or add it to WIKI_EXCEPTIONS in tools/check_wiki.mjs with why`);
  }
  // loop: NOT-WORTH — three exceptions
  for (const o of Object.keys(exceptions)) if (!options.includes(o)) problems.push(`WIKI_EXCEPTIONS (tools/check_wiki.mjs): \`${o}\` isn't a run option any more: remove it`);
  // loop: NOT-WORTH — a panel's few dozen labels
  for (const l of labels) if (!has(all, l)) problems.push(`the clip setting "${l}" (src/ui/JobSettings.tsx) is on no wiki page: say what it does (Your-First-Key.md or its own page)`);
  return problems;
}

/** (h): every app setting has a row in `table`; a label still on screen (`ui`: the UI's source) and on its page. */
export function checkSettings(pages, keys, ui, table = SETTINGS) {
  const problems = [];
  // loop: NOT-WORTH — ~20 settings
  for (const k of keys) {
    const row = table[k];
    if (!row) {
      problems.push(`the app setting \`${k}\` has no row in SETTINGS (tools/check_wiki.mjs): its on-screen label and wiki page, or internal: why`);
      continue;
    }
    if (row.internal) continue;
    if (!ui.includes(row.label)) problems.push(`SETTINGS (tools/check_wiki.mjs): "${row.label}" (\`${k}\`) isn't on screen any more (src/ui): fix the label`);
    if (pages[row.page] === undefined) problems.push(`SETTINGS (tools/check_wiki.mjs): \`${k}\` names the wiki page ${row.page}, which docs/wiki/ doesn't have`);
    else if (!has(pages[row.page], row.label)) problems.push(`${row.page}.md: the app setting "${row.label}" (\`${k}\`) is missing`);
  }
  // loop: NOT-WORTH — ~20 rows
  for (const k of Object.keys(table)) if (!keys.includes(k)) problems.push(`SETTINGS (tools/check_wiki.mjs): \`${k}\` isn't an app setting any more: remove it`);
  return problems;
}

/** (i): every rail page has a wiki page or section: a heading with its name (any case). */
export function checkRail(pages, labels) {
  const headings = [];
  // loop: NOT-WORTH — the wiki's pages
  for (const t of Object.values(pages))
    // loop: NOT-WORTH — one page's lines
    for (const line of splitFences(t).prose.split("\n")) {
      const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
      if (m) headings.push(m[1].replace(/\*\*/g, "").toLowerCase());
    }
  // loop: NOT-WORTH — five rail pages
  return labels.filter((l) => !headings.includes(l.toLowerCase())).map((l) => `the rail page "${l}" (src/ui/rail/railModel.ts) has no wiki page or section (a heading "${l}")`);
}

/** Everything, on this repository. */
export function checkAll(app = APP) {
  const pages = readPages(join(app, "docs", "wiki"));
  const spec = JSON.parse(readFileSync(join(app, "src", "shared", "console", "cliSpec.json"), "utf8"));
  const exits = exitCodes(readFileSync(join(app, "engine-rs", "crates", "ck-cli", "src", "exit.rs"), "utf8"));
  const builtins = builtinNames(readFileSync(join(app, "src", "shared", "console", "registry.ts"), "utf8"));
  const messages = engineMessages(rustFiles(join(app, "engine-rs", "crates", "ck-core", "src")));
  const read = (...p) => readFileSync(join(app, ...p), "utf8");
  const repoFile = (p) => {
    const f = join(app, p);
    return existsSync(f) && statSync(f).isFile() ? readFileSync(f, "utf8") : existsSync(f) ? "" : null;
  };
  return [
    ...checkCommandLine(pages["Command-Line"], spec, exits),
    ...checkConsole(pages["Console"], builtins),
    ...checkTroubleshooting(pages["Troubleshooting"], messages),
    ...checkLinks(pages, repoFile),
    ...checkRunOptions(
      pages,
      runOptions(read("engine-rs", "crates", "ck-core", "src", "job.rs")),
      optionFlags(read("engine-rs", "crates", "ck-cli", "src", "args.rs")),
      screenLabels(read("src", "ui", "JobSettings.tsx")),
    ),
    ...checkSettings(pages, settingKeys(app), uiText(app)),
    ...checkRail(pages, railLabels(read("src", "ui", "rail", "railModel.ts"))),
  ];
}

/** The app's settings (Settings, Appearance, UpdatePrefs). */
function settingKeys(app) {
  const types = readFileSync(join(app, "src", "shared", "types.ts"), "utf8");
  const prefs = readFileSync(join(app, "electron", "main", "updatePrefs.ts"), "utf8");
  return [...interfaceKeys(types, "Settings"), ...interfaceKeys(types, "Appearance"), ...interfaceKeys(prefs, "UpdatePrefs")];
}

/** The text on screen, as source: src/ui's .tsx files and the Console's registry (its commands are its controls). */
function uiText(app) {
  const out = [readFileSync(join(app, "src", "shared", "console", "registry.ts"), "utf8")];
  const walk = (d) => {
    // loop: NOT-WORTH — src/ui's few dozen files, once per gate run
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".tsx")) out.push(readFileSync(p, "utf8"));
    }
  };
  walk(join(app, "src", "ui"));
  return out.join("\n");
}

/** The pages that differ between docs/wiki/ and a wiki clone (added, removed or changed; line ends don't count). */
export function diffPublished(src, published) {
  const a = readPages(src);
  const b = readPages(published);
  const lf = (s) => s.replace(/\r\n/g, "\n");
  // loop: NOT-WORTH — the two sets of page names
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  // loop: NOT-WORTH — the wiki's pages
  return names
    .filter((n) => a[n] === undefined || b[n] === undefined || lf(a[n]) !== lf(b[n]))
    .map((n) => `${n}.md: ${a[n] === undefined ? "only published" : b[n] === undefined ? "not published" : "differs"}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const i = process.argv.indexOf("--published");
  if (i > 0) {
    const diff = diffPublished(WIKI, process.argv[i + 1]);
    if (diff.length) {
      console.log("The published wiki isn't docs/wiki/ (publish it: node tools/publish_wiki.mjs <wiki clone>):\n" + diff.join("\n"));
      process.exit(1);
    }
    console.log("check_wiki: the published wiki is docs/wiki/");
  } else {
    const problems = checkAll();
    if (problems.length) {
      console.log("Wiki gate (docs/wiki/, tools/check_wiki.mjs):\n" + problems.join("\n"));
      process.exit(1);
    }
  }
}
