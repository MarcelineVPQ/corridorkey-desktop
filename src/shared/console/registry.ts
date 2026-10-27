// The Console's commands (backlog row 95): its own built-ins and the `corridorkey` command line, read from the CLI's
// own description (cliSpec.json: tools/gen_cli_spec.mjs from `corridorkey __spec --json`), so the Console and the farm
// CLI never differ. Pure data and lookups: the page's highlighting, completion and hints and the main process's checks
// (which always decide) use the same entries.
import cliSpec from "./cliSpec.json";

/** switch: no value; command: a Console command's name (help's argument). */
export type ArgKind = "switch" | "path" | "enum" | "number" | "frames" | "string" | "command";

export interface ConsoleArg {
  id: string;
  long: string | null;
  short: string | null;
  positional: boolean;
  kind: ArgKind;
  valueName: string | null;
  /** an enum's values */
  values: readonly string[];
  /** a number's inclusive range, when the CLI states one (0-1) */
  range: readonly [number, number] | null;
  /** whole numbers only (N) */
  integer: boolean;
  help: string;
  multiple: boolean;
  required: boolean;
  /** a path written to: only inside the chosen folders (docs/CONSOLE.md "File scope") */
  writes: boolean;
  /** replaces or deletes the user's files: needs `sudo` */
  destructive: boolean;
  /** why the Console refuses this flag (null: allowed) */
  refused: string | null;
  /** the ids of the arguments it can't be used with (the CLI's conflicts_with, as declared on this one) */
  conflicts: readonly string[];
  /** DOS spellings (dir's /w, /b, /a, /o:d), read on every system */
  dos: readonly string[];
}

export interface ConsoleCommand {
  name: string;
  aliases: readonly string[];
  about: string;
  args: readonly ConsoleArg[];
  examples: readonly string[];
  kind: "builtin" | "cli";
  /** `corridorkey`'s render / verify / prepare / info */
  subcommands: readonly ConsoleCommand[];
  /** a CLI subcommand that uses the graphics card (one GPU job at a time with the queue) */
  gpu: boolean;
}

export interface Registry {
  commands: readonly ConsoleCommand[];
  /** `corridorkey` itself */
  cli: ConsoleCommand;
}

interface SpecArg {
  id: string;
  long: string | null;
  short: string | null;
  positional: boolean;
  value_name: string | null;
  possible_values: string[];
  help: string | null;
  required: boolean;
  multiple: boolean;
  takes_value: boolean;
  hidden: boolean;
  conflicts_with?: string[];
}
interface SpecCommand {
  name: string;
  about: string | null;
  args: SpecArg[];
  examples: string[];
}
export interface CliSpec {
  about: string | null;
  commands: SpecCommand[];
}

/** The CLI's value names that are paths (docs/CLI.md: INPUT, DIR|PATTERN, FILE.json, LIB, CONFIG…). */
const PATH_VALUES = new Set(["INPUT", "DIR", "DIR|PATTERN", "FILE", "FILE.json", "PATH", "LIB", "CONFIG"]);
/** Flags whose path the CLI writes to (verify only reads its -o). */
const WRITES: Record<string, readonly string[]> = { render: ["output", "report", "temp"], verify: ["report", "temp"], prepare: ["report"] };
/** Flags that replace the user's files (--skip-existing keys a set again, all of it, unless every frame is there and whole). */
const DESTRUCTIVE: Record<string, readonly string[]> = { render: ["overwrite", "skip-existing"] };
const REFUSED: Record<string, string> = { "progress-format": "the Console sets it (it shows the progress itself)" };
const GPU = new Set(["render", "prepare"]);

function kindOf(a: SpecArg): Pick<ConsoleArg, "kind" | "values" | "range" | "integer"> {
  const plain = { values: [] as string[], range: null, integer: false };
  const v = a.value_name ?? "";
  if (!a.takes_value) return { ...plain, kind: "switch" };
  if (a.possible_values.length) return { ...plain, kind: "enum", values: a.possible_values };
  // exr|video, half|float, 8|16: the CLI's own list of values (DIR|PATTERN, N|UUID are kinds, not values)
  // loop: NOT-WORTH — a value name's few alternatives, once per flag at start
  if (/^[a-z0-9]+(\|[a-z0-9]+)+$/.test(v)) return { ...plain, kind: "enum", values: v.split("|") };
  if (PATH_VALUES.has(v)) return { ...plain, kind: "path" };
  if (v === "SPEC") return { ...plain, kind: "frames" };
  if (v === "N") return { ...plain, kind: "number", integer: true };
  const r = /^(\d+)-(\d+)$/.exec(v);
  if (r) return { ...plain, kind: "number", range: [Number(r[1]), Number(r[2])] };
  if (["GB", "FPS", "S", "G", "C", "P"].includes(v)) return { ...plain, kind: "number" };
  return { ...plain, kind: "string" };
}

function cliCommand(c: SpecCommand): ConsoleCommand {
  return {
    name: c.name,
    aliases: [],
    about: c.about ?? "",
    // loop: NOT-WORTH — a subcommand's ~50 flags, once at start
    args: c.args.map((a) => ({
      id: a.id,
      long: a.long,
      short: a.short,
      positional: a.positional,
      ...kindOf(a),
      valueName: a.value_name,
      help: a.help ?? "",
      multiple: a.multiple,
      required: a.required,
      // loop: NOT-WORTH — one or three names
      writes: (WRITES[c.name] ?? []).includes(a.id),
      // loop: NOT-WORTH — as above
      destructive: (DESTRUCTIVE[c.name] ?? []).includes(a.id),
      refused: REFUSED[a.id] ?? null,
      conflicts: a.conflicts_with ?? [],
      dos: [],
    })),
    examples: c.examples,
    kind: "cli",
    subcommands: [],
    gpu: GPU.has(c.name),
  };
}

type ArgIn = Partial<ConsoleArg> & Pick<ConsoleArg, "id" | "kind" | "help">;
const arg = (a: ArgIn): ConsoleArg => ({
  long: null,
  short: null,
  positional: false,
  valueName: null,
  values: [],
  range: null,
  integer: false,
  multiple: false,
  required: false,
  writes: false,
  destructive: false,
  refused: null,
  conflicts: [],
  dos: [],
  ...a,
});
const builtin = (name: string, about: string, args: ConsoleArg[], examples: string[], aliases: string[] = []): ConsoleCommand => ({
  name,
  aliases,
  about,
  args,
  examples,
  kind: "builtin",
  subcommands: [],
  gpu: false,
});

const BUILTINS: ConsoleCommand[] = [
  builtin(
    "help",
    "the commands, or one command's options and examples (also: <command> ?)",
    [
      arg({ id: "command", kind: "command", positional: true, valueName: "COMMAND", help: "the command to explain" }),
      arg({ id: "keyword", short: "k", kind: "string", valueName: "TERM", help: "search the commands and their options instead (man -k)" }),
    ],
    ["help", "help render", "render ?", "help -k overwrite"],
  ),
  builtin(
    "apropos",
    "search the commands and their options by name and description (help -k)",
    [arg({ id: "term", kind: "string", positional: true, required: true, multiple: true, valueName: "TERM", help: "words to look for" })],
    ["apropos overwrite", "apropos frames"],
  ),
  builtin(
    "cd",
    "change the Console's current folder (none: your home folder)",
    [arg({ id: "folder", kind: "path", positional: true, valueName: "FOLDER", help: "the folder" })],
    ["cd ~/shots/sh010", "cd .."],
  ),
  builtin("pwd", "print the current folder", [], ["pwd"]),
  builtin(
    "dir",
    "list a folder's files with their sizes and dates",
    [
      arg({ id: "folder", kind: "path", positional: true, valueName: "FOLDER", help: "the folder (default: the current one)" }),
      arg({ id: "long", short: "l", kind: "switch", help: "sizes and dates (the table dir always shows)" }),
      arg({ id: "all", short: "a", dos: ["/a"], kind: "switch", help: "dot files too" }),
      arg({ id: "time", short: "t", kind: "switch", help: "newest first" }),
      arg({ id: "size", short: "S", kind: "switch", help: "largest first" }),
      arg({ id: "reverse", short: "r", kind: "switch", help: "the other way round" }),
      arg({ id: "names", short: "1", dos: ["/w", "/b"], kind: "switch", help: "names only" }),
      arg({
        id: "order",
        dos: ["/o"],
        kind: "enum",
        values: ["n", "s", "d", "-n", "-s", "-d"],
        valueName: "ORDER",
        help: "DOS's order: /o:n name, /o:s smallest first, /o:d oldest first; /o:-d the other way round",
      }),
    ],
    ["dir", "ls plates", "ls -la", "ls -tr", "dir /o:-d"],
    ["ls"],
  ),
  builtin("cls", "clear the screen", [], ["cls"], ["clear"]),
  builtin("version", "the app's version, which is its corridorkey command line's (also corridorkey --version)", [], ["version", "corridorkey --version"]),
  builtin(
    "history",
    "the commands typed before (newest last)",
    [arg({ id: "audit", long: "audit", kind: "switch", help: "the elevated (sudo) commands' log instead" })],
    ["history", "history --audit"],
  ),
  builtin(
    "run",
    "run a script of Console commands (.ckcmd), one per line; stops at the first that fails",
    [arg({ id: "file", kind: "path", positional: true, required: true, valueName: "FILE.ckcmd", help: "the script" })],
    ["run nightly.ckcmd"],
  ),
  builtin(
    "sudo",
    "run a command that replaces or deletes files, after you confirm it (elevated for 5 minutes); sudo -k drops it",
    [arg({ id: "drop", short: "k", kind: "switch", help: "drop the elevation now" })],
    ["sudo render shot.mov -o out/ --overwrite", "sudo -k"],
  ),
];

/** The registry from the CLI's spec (the checked-in copy unless one is given: tests). */
export function makeRegistry(spec: CliSpec = cliSpec as CliSpec): Registry {
  const cli: ConsoleCommand = {
    name: "corridorkey",
    aliases: [],
    about: spec.about ?? "",
    args: [],
    examples: [],
    kind: "cli",
    // loop: NOT-WORTH — four subcommands, once at start
    subcommands: spec.commands.map(cliCommand),
    gpu: false,
  };
  return { commands: [...BUILTINS, cli], cli };
}

/**
 * Words a line can't start with, and what to type instead: names other command lines use for something else, kept
 * free here (find: a file search in a later version).
 */
export const ANSWERS: Readonly<Record<string, string>> = {
  find: "find (a file search) comes in a later version; to search the commands and their options: help -k <term> (or apropos <term>)",
};

/** A command by name or alias; bare `render` / `verify` / `prepare` / `info` are corridorkey's. */
export function findCommand(reg: Registry, word: string): ConsoleCommand | null {
  // loop: NOT-WORTH — a dozen commands per lookup
  return reg.commands.find((c) => c.name === word || c.aliases.includes(word)) ?? reg.cli.subcommands.find((c) => c.name === word) ?? null;
}

/** Every name a line can start with. */
export function commandNames(reg: Registry): string[] {
  // loop: NOT-WORTH — a dozen commands
  return [...reg.commands.flatMap((c) => [c.name, ...c.aliases]), ...reg.cli.subcommands.map((c) => c.name)];
}

/** The full command line a CLI subcommand runs as ("corridorkey render"), else its name. */
export const fullName = (reg: Registry, c: ConsoleCommand): string => (reg.cli.subcommands.includes(c) ? `${reg.cli.name} ${c.name}` : c.name);

/** Levenshtein distance (small words: the typo hint). */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  // loop: NOT-WORTH — two short words (a command or flag name), once per unknown word
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    // loop: NOT-WORTH — as above
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[b.length];
}

/** "did you mean": the closest candidate within 2 edits (and under half the word), else null. */
export function suggest(word: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  // loop: NOT-WORTH — a few dozen names, once per unknown word
  for (const c of candidates) {
    const d = editDistance(word.toLowerCase(), c.toLowerCase());
    if (d < bestD) [best, bestD] = [c, d];
  }
  return best !== null && bestD <= 2 && bestD < Math.max(2, word.length / 2) ? best : null;
}

/** The CLI's exit codes and what they mean (docs/CLI.md "Exit codes"). */
export const EXIT_MEANINGS: Readonly<Record<number, string>> = {
  0: "done",
  2: "usage: a bad flag, value, frame list or job file (fix the command)",
  3: "input: the clip, a hint or a frame can't be read, or isn't there",
  4: "output: the folder isn't writable, the disk is full, or frames are already there (no --overwrite)",
  5: "no usable graphics card",
  6: "out of graphics memory (try --max-vram lower, --low-vram or a smaller --window)",
  7: "the models, ONNX Runtime, ffmpeg or a library are missing (run corridorkey prepare)",
  8: "the engine failed (a bug: the message says what)",
  9: "verify: a requested frame is missing or not a whole EXR (re-render)",
  130: "stopped (Ctrl+C), cleanly",
  143: "stopped, cleanly",
};
