// Tab completion for the Console (docs/CONSOLE.md): the word at the cursor, read with the same parser that runs the
// line. Commands, subcommands, flags and enum values come from the registry; paths from the file system (async; read
// anywhere, as the Console reads). Every insert is quoted as the line's rules need.
import type { Dirent } from "node:fs";
import { posix, win32 } from "node:path";
import { naturalCompare } from "../media";
import { parse, quoteArg, tokenize, type ParseOptions } from "../../../src/shared/console/parse";
import { commandNames, findCommand, type ConsoleArg, type ConsoleCommand, type Registry } from "../../../src/shared/console/registry";
import { groupSequences } from "../../../src/shared/console/sequences";
import { commandStart } from "../../../src/shared/console/script";
import type { ConsoleCompletion, ConsoleCompletionItem } from "../../../src/shared/types";
import { expandHome } from "./paths";

export const COMPLETIONS_MAX = 200;

export interface CompleteDeps {
  registry: Registry;
  platform: NodeJS.Platform;
  home: string;
  readdir: (p: string) => Promise<Dirent[]>;
  /** a link's target is a folder? */
  isDir: (p: string) => Promise<boolean>;
  /** the bookmarks (`@name` completes to one; `@name/` goes on inside it) */
  bookmarks: () => Readonly<Record<string, string>>;
}

// loop: NOT-WORTH — two names per flag
const flagNames = (a: ConsoleArg) => [a.long ? `--${a.long}` : null, a.short ? `-${a.short}` : null].filter((n): n is string => !!n);

export async function complete(line: string, cursor: number, cwd: string, d: CompleteDeps): Promise<ConsoleCompletion> {
  const opts: ParseOptions = { windows: d.platform === "win32" };
  const head = line.slice(0, Math.max(0, Math.min(cursor, line.length)));
  // a line with ; && || do then else time: the command the cursor is in, completed on its own
  const at = commandStart(head, opts);
  if (at > 0) {
    const r = await complete(line.slice(at), cursor - at, cwd, d);
    return { ...r, start: r.start + at, end: r.end + at };
  }
  const { words } = tokenize(head, opts);
  const last = words[words.length - 1];
  // the cursor right after a word (no space): that word is completed; else a new, empty one
  const current = last && last.end === head.length ? last : null;
  const start = current ? current.start : head.length;
  const prefix = current ? current.value : "";
  const before = current ? words.slice(0, -1) : words;
  const p = parse(head, d.registry, opts);
  const done = (items: ConsoleCompletionItem[], from = start): ConsoleCompletion => ({ start: from, end: head.length, items: items.slice(0, COMPLETIONS_MAX) });
  const starts = (s: string) => s.startsWith(prefix);

  // for NAME in WORDS: the words are files (or patterns)
  if (before.length >= 3 && !before[0].quoted && before[0].value === "for" && before[2].value === "in") return done(await paths(prefix, cwd, d, opts));
  // the command word (after an optional sudo)
  const lead = before.length && !before[0].quoted && before[0].value === "sudo" ? 1 : 0;
  if (before.length === lead) {
    // loop: NOT-WORTH — a dozen names, once per Tab
    const names = commandNames(d.registry).filter(starts);
    // loop: NOT-WORTH — a dozen names
    return done(names.sort().map((n) => ({ insert: n, label: n, kind: "command", help: findCommand(d.registry, n)?.about ?? "" })));
  }
  const first = findCommand(d.registry, before[lead].value);
  if (!first) return done([]);
  if (first.subcommands.length && before.length === lead + 1) {
    // loop: NOT-WORTH — four subcommands
    return done(first.subcommands.filter((c) => starts(c.name)).map((c) => ({ insert: c.name, label: c.name, kind: "command", help: c.about })));
  }
  const cmd: ConsoleCommand | null = p.command;
  if (!cmd) return done([]);

  // the argument the current word is (or is the value of): the parser's token at the cursor
  // loop: NOT-WORTH — the line's tokens, once per Tab
  const tok = current ? p.tokens.find((t) => t.start >= current.start && t.end <= current.end) : undefined;
  // `--output=fo`: the value part after the =
  if (current && current.value.startsWith("--") && current.value.includes("=")) {
    const name = current.value.slice(2, current.value.indexOf("="));
    // loop: NOT-WORTH — a command's flags
    const arg = cmd.args.find((a) => a.long === name);
    return done(arg ? await valuesFor(arg, current.value.slice(current.value.indexOf("=") + 1), cwd, d, opts, `--${name}=`) : []);
  }
  if (current && !current.quoted && current.value.startsWith("-") && !(tok && tok.kind !== "flag" && tok.kind !== "error")) {
    // loop: NOT-WORTH — the flags already given (a non-repeatable one isn't offered again)
    const used = new Set(p.options.filter((o) => o.word !== words.length - 1).map((o) => o.arg.id));
    const items: ConsoleCompletionItem[] = [];
    // loop: NOT-WORTH — a command's ~50 flags, once per Tab
    for (const a of cmd.args) {
      if (a.positional || a.refused || (used.has(a.id) && !a.multiple)) continue;
      // loop: NOT-WORTH — two names per flag
      for (const n of flagNames(a))
        if (starts(n) && (prefix.startsWith("--") ? n.startsWith("--") : true)) items.push({ insert: n, label: n + (a.valueName ? ` ${a.valueName}` : ""), kind: "flag", help: a.help });
    }
    // long names before short ones, then by name
    // loop: NOT-WORTH — sorts ≤ 100 items
    items.sort((x, y) => Number(y.insert.startsWith("--")) - Number(x.insert.startsWith("--")) || x.insert.localeCompare(y.insert));
    return done(items);
  }
  // a value: the flag before it, else the next positional
  const arg = current ? (tok?.arg ?? null) : (p.expecting ?? nextPositional(cmd, p.positionals));
  if (!arg) return done([]);
  return done(await valuesFor(arg, prefix, cwd, d, opts, ""));
}

function nextPositional(cmd: ConsoleCommand, given: { arg: ConsoleArg }[]): ConsoleArg | null {
  // loop: NOT-WORTH — a command's few positionals
  return cmd.args.find((a) => a.positional && (a.multiple || !given.some((g) => g.arg === a))) ?? null;
}

async function valuesFor(arg: ConsoleArg, prefix: string, cwd: string, d: CompleteDeps, opts: ParseOptions, lead: string): Promise<ConsoleCompletionItem[]> {
  if (arg.kind === "enum")
    // loop: NOT-WORTH — a few values
    // any case typed (EX → exr), as the parser takes it
    return arg.values.filter((v) => v.startsWith(prefix.toLowerCase())).map((v) => ({ insert: lead + v, label: v, kind: "value", help: arg.help }));
  if (arg.kind === "command")
    // loop: NOT-WORTH — a dozen names
    return commandNames(d.registry)
      .filter((n) => n.startsWith(prefix))
      .sort()
      .map((n) => ({ insert: lead + n, label: n, kind: "command", help: findCommand(d.registry, n)?.about ?? "" }));
  // loop: NOT-WORTH — at most COMPLETIONS_MAX items, once per Tab
  if (arg.kind === "path") return (await paths(prefix, cwd, d, opts, arg.folderOnly)).map((i) => ({ ...i, insert: lead + i.insert }));
  return [];
}

/** Files and folders starting with the typed name, in the typed folder (relative to the Console's folder); `folders`:
 * folders only (cd, pushd: SME review 2026-10-26 N1; a typed frame pattern still goes to its folder). */
async function paths(prefix: string, cwd: string, d: CompleteDeps, opts: ParseOptions, folderOnly = false): Promise<ConsoleCompletionItem[]> {
  const a = d.platform === "win32" ? win32 : posix;
  const cut = Math.max(prefix.lastIndexOf("/"), opts.windows ? prefix.lastIndexOf("\\") : -1);
  const dirPart = prefix.slice(0, cut + 1);
  const namePart = prefix.slice(cut + 1);
  const sep = opts.windows ? "\\" : "/";
  const marks = d.bookmarks();
  // @na: the bookmarks starting so (a frame token's @@ is never one: a name starts with a letter or digit)
  if (cut < 0 && /^@[\p{L}\p{N}]?[\p{L}\p{N}_.-]*$/u.test(prefix))
    // loop: NOT-WORTH — ≤ 200 bookmarks, once per Tab
    return Object.keys(marks)
      .filter((n) => `@${n}`.startsWith(prefix))
      .sort(naturalCompare)
      .map((n) => ({ insert: `@${n}${sep}`, label: `@${n}${sep}`, kind: "folder", help: marks[n] }));
  // @name/…: inside the bookmark's folder
  const mark = /^@([^\\/]+)[\\/]/.exec(dirPart);
  const base = mark && Object.hasOwn(marks, mark[1]) ? marks[mark[1]] + dirPart.slice(mark[0].length - 1) : dirPart;
  const dir = a.resolve(cwd, expandHome(base || ".", { home: d.home, platform: d.platform }));
  const fold = d.platform === "win32" || d.platform === "darwin" ? (s: string) => s.toLowerCase() : (s: string) => s;
  let entries: Dirent[];
  try {
    // loop: NOT-WORTH — one async readdir per Tab
    entries = await d.readdir(dir);
  } catch (e) {
    // a folder that didn't answer in time (a hung share) says so, the typed name unchanged if taken
    if ((e as NodeJS.ErrnoException | null)?.code === "ETIMEDOUT")
      return [{ insert: quoteArg(prefix, opts), label: `${dir} didn't answer`, kind: "value", help: "a drive or network share that is busy or gone" }];
    // error: NOT-WORTH — no such folder (or unreadable): nothing to offer
    return [];
  }
  // loop: NOT-WORTH — one folder's names, once per Tab
  const matching = entries.filter((e) => fold(e.name).startsWith(fold(namePart)) && (namePart.startsWith(".") || !e.name.startsWith(".")));
  const folders = new Set<string>();
  let links = 0;
  // loop: NOT-WORTH — the matching names; an async stat only for a link, at most COMPLETIONS_MAX of them
  for (const e of matching) if (e.isDirectory() || (e.isSymbolicLink() && links++ < COMPLETIONS_MAX && (await d.isDir(a.join(dir, e.name))))) folders.add(e.name);
  // a plate folder's frames are one pattern per sequence (sh010_plate.####.exr, as the CLI reads it), not a name per frame
  // loop: NOT-WORTH — the matching names, once per Tab
  const { sequences, singles } = groupSequences(matching.filter((e) => !folders.has(e.name)).map((e) => e.name));
  const item = (name: string, kind: "file" | "folder", help: string): ConsoleCompletionItem => ({
    insert: quoteArg(dirPart + name + (kind === "folder" ? sep : ""), opts),
    label: name + (kind === "folder" ? sep : ""),
    kind,
    help,
  });
  if (folderOnly)
    // loop: NOT-WORTH — the matching folders, once per Tab
    return [...folders]
      .map((n) => item(n, "folder", ""))
      .sort((x, y) => naturalCompare(x.label, y.label))
      .slice(0, COMPLETIONS_MAX);
  const items = [
    // loop: NOT-WORTH — the sequences found
    ...sequences.map((q) => item(q.pattern, "file", `frames ${q.range} (${q.count})${q.missing ? `, missing ${q.missing}` : ""}`)),
    // loop: NOT-WORTH — the single files
    ...singles.map((n) => item(n, "file", "")),
    ...[...folders].map((n) => item(n, "folder", "")),
  ];
  // loop: NOT-WORTH — sorts ≤ one folder's items, once per Tab
  return items.sort((x, y) => naturalCompare(x.label, y.label)).slice(0, COMPLETIONS_MAX);
}
