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
    ["man"],
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
    "bookmark",
    "name a folder (none: the current one) so cd @name goes there; -d removes one; alone: the bookmarks",
    [
      arg({ id: "name", kind: "string", positional: true, valueName: "NAME", help: "the bookmark's name (letters, digits, _ . -)" }),
      arg({ id: "folder", kind: "path", positional: true, valueName: "FOLDER", help: "the folder (default: the current one)" }),
      arg({ id: "delete", short: "d", kind: "switch", help: "remove the bookmark" }),
    ],
    ["bookmark sh010", "bookmark plates ~/shots/sh010/plates", "cd @sh010", "bookmark -d sh010"],
  ),
  builtin("bookmarks", "the bookmarks (cd @name goes to one)", [], ["bookmarks"]),
  builtin(
    "j",
    "jump to the folder you use most and lately whose path has these parts (the last one in its name); alone: the folders ranked, best first",
    [arg({ id: "parts", kind: "string", positional: true, multiple: true, valueName: "PART", help: "parts of the folder's path, in order" })],
    ["j sh010", "j sq01 key", "j"],
    ["z"],
  ),
  builtin(
    "pushd",
    "go to a folder and remember the one you were in (popd comes back); alone: swap the two newest",
    [arg({ id: "folder", kind: "path", positional: true, valueName: "FOLDER", help: "the folder" })],
    ["pushd ~/renders", "pushd @sh010", "pushd"],
  ),
  builtin("popd", "go back to the folder pushd remembered last", [], ["popd"]),
  builtin(
    "set",
    "set variables for later lines: set name=value (this session; -p keeps it after a restart); ${name} in a line is its value; alone: the variables",
    [
      arg({ id: "assign", kind: "string", positional: true, multiple: true, valueName: "NAME=VALUE", help: "a name (letters, digits, _) and its value; a name alone prints it" }),
      arg({ id: "persist", short: "p", kind: "switch", help: "keep it after a restart (in settings)" }),
    ],
    ["set shot=sh010", "set -p show=/mnt/show", "dir ${show}/${shot}", "set"],
  ),
  builtin(
    "unset",
    "remove variables (kept ones too)",
    [arg({ id: "names", kind: "string", positional: true, multiple: true, required: true, valueName: "NAME", help: "the variable's name" })],
    ["unset shot"],
  ),
  builtin(
    "echo",
    "print its words (with ${name} filled in)",
    [arg({ id: "words", kind: "string", positional: true, multiple: true, valueName: "WORD", help: "what to print" })],
    ["echo ${shot} ${date}", "echo ${status}"],
  ),
  builtin("dirs", "the folders pushd remembered, newest first (0 is where you are)", [], ["dirs"]),
  builtin(
    "dir",
    "list a folder's files with their sizes and dates",
    [
      arg({ id: "folder", kind: "path", positional: true, valueName: "FOLDER", help: "the folder (default: the current one), or the files a pattern matches there (*.exr)" }),
      arg({ id: "long", short: "l", kind: "switch", help: "sizes and dates (the table dir always shows)" }),
      arg({ id: "human", short: "h", kind: "switch", help: "human sizes (ls -lh; dir always shows them)" }),
      arg({ id: "all", short: "a", dos: ["/a"], kind: "switch", help: "dot files too" }),
      arg({ id: "time", short: "t", kind: "switch", help: "newest first" }),
      arg({ id: "size", short: "S", kind: "switch", help: "largest first" }),
      arg({ id: "reverse", short: "r", kind: "switch", help: "the other way round" }),
      arg({ id: "frames", short: "f", kind: "switch", help: "each frame of a sequence on its own row (sequences are one row: name.####.exr 1001-1100)" }),
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
    ["dir", "ls plates", "ls -la", "ls -lh *.exr", "ls -tr", "dir /o:-d"],
    ["ls"],
  ),
  builtin(
    "allow",
    "let the Console write in a folder (and every folder inside it), after you confirm; none: the folders allowed",
    [arg({ id: "folder", kind: "path", positional: true, valueName: "FOLDER", help: "the folder (App settings → Console removes it again)" })],
    ["allow /mnt/show/sq01", "allow"],
    ["trust"],
  ),
  builtin(
    "allow-server",
    "Windows: let the Console open a network server's paths (\\\\server\\…) until the app quits; none: the servers allowed",
    [arg({ id: "server", kind: "string", positional: true, valueName: "SERVER", help: "the server's name (nas for \\\\nas\\show)" })],
    ["allow-server nas", "allow-server"],
  ),
  builtin(
    "open",
    "show a folder (or a file) in the file manager, as Show in folder does; it never opens or runs a file",
    [arg({ id: "path", kind: "path", positional: true, valueName: "PATH", help: "what to show (default: the current folder)" })],
    ["open .", "start plates"],
    ["start"],
  ),
  builtin("cls", "clear the screen", [], ["cls"], ["clear"]),
  builtin("version", "the app's version, which is its corridorkey command line's (also corridorkey --version)", [], ["version", "corridorkey --version"]),
  builtin(
    "history",
    "the commands typed before (newest last), numbered, with when and how each ended; a line typed with a leading space isn't kept",
    [
      arg({ id: "which", kind: "string", positional: true, valueName: "N|TERM", help: "the last N lines, or the lines (and folders) containing TERM" }),
      arg({ id: "audit", long: "audit", kind: "switch", help: "the elevated (sudo) commands' log instead" }),
    ],
    ["history", "history 20", "history sh010", "history --audit"],
  ),
  builtin(
    "run",
    "run a script of Console commands (.ckcmd): one per line (or joined with ; && ||), for and if; stops at the first that fails",
    [
      arg({ id: "file", kind: "path", positional: true, required: true, valueName: "FILE.ckcmd", help: "the script" }),
      arg({ id: "keep-going", long: "keep-going", kind: "switch", help: "go on after a command fails (the script still ends failed)" }),
    ],
    ["run nightly.ckcmd", "run --keep-going nightly.ckcmd"],
  ),
  builtin(
    "time",
    "run a command and say how long it took (a render's frames per second too)",
    [arg({ id: "command", kind: "string", positional: true, multiple: true, required: true, valueName: "COMMAND", help: "the command line" })],
    ["time render shot.mov -o ~/renders/sh010", "time verify -i plates/sh010.####.exr -o out/key.####.exr"],
  ),
  builtin(
    "cat",
    "print a text file (its first 2000 lines; a binary file is refused)",
    [arg({ id: "files", kind: "path", positional: true, multiple: true, required: true, valueName: "FILE", help: "the file" })],
    ["cat notes.txt", "type nightly.ckcmd"],
    ["type"],
  ),
  builtin(
    "head",
    "print a text file's first lines",
    [
      arg({ id: "lines", short: "n", kind: "number", integer: true, valueName: "N", help: "how many (default 10, at most 2000)" }),
      arg({ id: "file", kind: "path", positional: true, required: true, valueName: "FILE", help: "the file" }),
    ],
    ["head report.json", "head -n 40 notes.txt"],
  ),
  builtin(
    "tail",
    "print a text file's last lines (a long log's end)",
    [
      arg({ id: "lines", short: "n", kind: "number", integer: true, valueName: "N", help: "how many (default 10, at most 2000)" }),
      arg({ id: "file", kind: "path", positional: true, required: true, valueName: "FILE", help: "the file" }),
    ],
    ["tail render.log", "tail -n 100 render.log"],
  ),
  builtin(
    "wc",
    "count a text file's lines, words and bytes",
    [arg({ id: "files", kind: "path", positional: true, multiple: true, required: true, valueName: "FILE", help: "the file" })],
    ["wc shots.txt", "wc notes.txt shots.txt"],
  ),
  builtin(
    "du",
    "how much the folders take on disk: each folder inside, then the total",
    [arg({ id: "folders", kind: "path", positional: true, multiple: true, valueName: "FOLDER", help: "the folder (default: the current one)" })],
    ["du", "du ~/renders"],
  ),
  builtin(
    "tree",
    "a folder and the folders inside it, as a tree (sequences as one row)",
    [
      arg({ id: "folder", kind: "path", positional: true, valueName: "FOLDER", help: "the folder (default: the current one)" }),
      arg({ id: "level", short: "L", kind: "number", integer: true, valueName: "N", help: "how deep (default 2, at most 6)" }),
      arg({ id: "all", short: "a", kind: "switch", help: "dot files too" }),
    ],
    ["tree", "tree -L 3 ~/shots/sh010"],
  ),
  builtin(
    "doctor",
    "check this computer in one go: the corridorkey command line, the graphics card and driver, ONNX Runtime, the models, TensorRT, ffmpeg, the folders the Console writes to and their free space; each problem with its fix",
    [arg({ id: "json", long: "json", kind: "switch", help: "the checks as JSON" })],
    ["doctor", "doctor --json"],
  ),
  builtin(
    "farm",
    "write ready-to-submit render farm jobs for clips in the queue, with their settings: OpenJD, Deadline 10, OpenCue, Flamenco or a shell shot list",
    [
      arg({ id: "action", kind: "enum", positional: true, required: true, values: ["export"], valueName: "export", help: "export: write the job files" }),
      arg({
        id: "format",
        kind: "enum",
        positional: true,
        required: true,
        values: ["openjd", "deadline", "opencue", "flamenco", "shell"],
        valueName: "FORMAT",
        help: "openjd (a job bundle), deadline (job and plugin info), opencue (a submit script), flamenco (a job), shell (a shot list)",
      }),
      arg({ id: "clips", kind: "path", positional: true, multiple: true, valueName: "CLIP", help: "clips in the queue (their path or name)" }),
      arg({ id: "queue", long: "queue", kind: "switch", help: "every clip in the queue" }),
      arg({ id: "output", short: "o", long: "output", kind: "path", valueName: "FOLDER", writes: true, help: "the folder the job files go in" }),
      arg({ id: "overwrite", long: "overwrite", kind: "switch", destructive: true, help: "replace job files already there" }),
      arg({ id: "models", long: "models", kind: "string", valueName: "DIR", help: "the model set's folder on the workers (default: this computer's, and the block says so)" }),
      arg({ id: "ort", long: "ort", kind: "string", valueName: "LIB", help: "ONNX Runtime's library on the workers (default: this computer's)" }),
      arg({ id: "pool", long: "pool", kind: "string", valueName: "NAME", help: "Deadline: the pool (default: the repository's)" }),
      arg({ id: "group", long: "group", kind: "string", valueName: "NAME", help: "Deadline: your GPU group, so the job only goes to workers with a graphics card (default: none)" }),
      arg({ id: "priority", long: "priority", kind: "number", integer: true, range: [0, 100], valueName: "N", help: "Deadline: the jobs' priority (default 50)" }),
      arg({
        id: "platform",
        long: "platform",
        kind: "enum",
        values: ["linux", "windows", "darwin"],
        valueName: "OS",
        help: "Flamenco: the computer that submits, whose paths its variables translate (default: this one)",
      }),
    ],
    [
      "farm export openjd --queue -o ~/farm/sq01 --models /opt/ck/models --ort /opt/ck/libonnxruntime.so",
      "farm export deadline sh010.mov -o ~/farm/sh010 --group gpu --priority 60",
      "farm export shell --queue -o ~/farm",
    ],
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
 * Words a line can't start with, and what to type instead: other command lines' names, each with an answer for what
 * it would do there (find: kept free for a file search in a later version; rm: the Console never deletes).
 */
const NEVER_DELETES = "the Console never deletes files (render's --overwrite replaces only its own outputs, as sudo); delete them in your file manager (open . shows this folder there)";
const NO_COPY = "the Console doesn't copy or move files; render -o writes its outputs where you say";
const SHOW_FILE = "cat <file> (or type) prints a text file, head and tail its start or end; the output block scrolls";
const STAYS_OPEN = "the Console stays open (it is a tab: the rail leaves it); cls or Ctrl+L clears the screen";
export const ANSWERS: Readonly<Record<string, string>> = {
  find: "find (a file search) comes in a later version; to search the commands and their options: help -k <term> (or apropos <term>)",
  exit: STAYS_OPEN,
  quit: STAYS_OPEN,
  logout: STAYS_OPEN,
  rm: NEVER_DELETES,
  rmdir: NEVER_DELETES,
  del: NEVER_DELETES,
  erase: NEVER_DELETES,
  rd: NEVER_DELETES,
  unlink: NEVER_DELETES,
  cp: NO_COPY,
  copy: NO_COPY,
  mv: NO_COPY,
  move: NO_COPY,
  ren: NO_COPY,
  rename: NO_COPY,
  more: SHOW_FILE,
  less: SHOW_FILE,
  which: "corridorkey is the app's own: version prints its version, corridorkey info checks its engine",
  where: "corridorkey is the app's own: version prints its version, corridorkey info checks its engine",
};

/**
 * Words with the meaning of one of the CLI's values, per argument id: suggested ("did you mean auto?"), never taken in
 * its place (the Console accepts what the CLI accepts). Each target is the CLI's own value (a test checks it against
 * the spec); docs/CLI.md says what each value means (--device's auto: the graphics card).
 */
export const MEANINGS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  device: { gpu: "auto", card: "auto", graphics: "auto", nvidia: "cuda", metal: "coreml", mac: "coreml", apple: "coreml" },
  format: { mov: "video", mp4: "video", movie: "video", sequence: "exr", frames: "exr", openexr: "exr" },
  datatype: { "16": "half", "32": "float", fp16: "half", fp32: "float", f16: "half", f32: "float" },
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
