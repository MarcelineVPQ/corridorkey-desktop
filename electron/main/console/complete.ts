// Tab completion for the Console (docs/CONSOLE.md): the word at the cursor, read with the same parser that runs the
// line. Commands, subcommands, flags and enum values come from the registry; paths from the file system (async; read
// anywhere, as the Console reads). Every insert is quoted as the line's rules need.
import type { Dirent } from "node:fs";
import { posix, win32 } from "node:path";
import { naturalCompare } from "../media";
import { parse, quoteArg, tokenize, type ParseOptions } from "../../../src/shared/console/parse";
import { commandNames, findCommand, type ConsoleArg, type ConsoleCommand, type Registry } from "../../../src/shared/console/registry";
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
}

// loop: NOT-WORTH — two names per flag
const flagNames = (a: ConsoleArg) => [a.long ? `--${a.long}` : null, a.short ? `-${a.short}` : null].filter((n): n is string => !!n);

export async function complete(line: string, cursor: number, cwd: string, d: CompleteDeps): Promise<ConsoleCompletion> {
  const opts: ParseOptions = { windows: d.platform === "win32" };
  const head = line.slice(0, Math.max(0, Math.min(cursor, line.length)));
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
    return arg.values.filter((v) => v.startsWith(prefix)).map((v) => ({ insert: lead + v, label: v, kind: "value", help: arg.help }));
  if (arg.kind === "command")
    // loop: NOT-WORTH — a dozen names
    return commandNames(d.registry)
      .filter((n) => n.startsWith(prefix))
      .sort()
      .map((n) => ({ insert: lead + n, label: n, kind: "command", help: findCommand(d.registry, n)?.about ?? "" }));
  // loop: NOT-WORTH — at most COMPLETIONS_MAX items, once per Tab
  if (arg.kind === "path") return (await paths(prefix, cwd, d, opts)).map((i) => ({ ...i, insert: lead + i.insert }));
  return [];
}

/** Files and folders starting with the typed name, in the typed folder (relative to the Console's folder). */
async function paths(prefix: string, cwd: string, d: CompleteDeps, opts: ParseOptions): Promise<ConsoleCompletionItem[]> {
  const a = d.platform === "win32" ? win32 : posix;
  const cut = Math.max(prefix.lastIndexOf("/"), opts.windows ? prefix.lastIndexOf("\\") : -1);
  const dirPart = prefix.slice(0, cut + 1);
  const namePart = prefix.slice(cut + 1);
  const dir = a.resolve(cwd, expandHome(dirPart || ".", { home: d.home, platform: d.platform }));
  const fold = d.platform === "win32" || d.platform === "darwin" ? (s: string) => s.toLowerCase() : (s: string) => s;
  let entries: Dirent[];
  try {
    // loop: NOT-WORTH — one async readdir per Tab
    entries = await d.readdir(dir);
  } catch {
    // error: NOT-WORTH — no such folder (or unreadable): nothing to offer
    return [];
  }
  const sep = opts.windows ? "\\" : "/";
  const items: ConsoleCompletionItem[] = [];
  // loop: NOT-WORTH — sorts one folder's names, once per Tab
  const matching = entries.filter((e) => fold(e.name).startsWith(fold(namePart)) && (namePart.startsWith(".") || !e.name.startsWith("."))).sort((x, y) => naturalCompare(x.name, y.name));
  // loop: NOT-WORTH — at most COMPLETIONS_MAX entries, an async stat only for a link
  for (const e of matching.slice(0, COMPLETIONS_MAX)) {
    const folder = e.isDirectory() || (e.isSymbolicLink() && (await d.isDir(a.join(dir, e.name))));
    items.push({ insert: quoteArg(dirPart + e.name + (folder ? sep : ""), opts), label: e.name + (folder ? sep : ""), kind: folder ? "folder" : "file", help: "" });
  }
  return items;
}
