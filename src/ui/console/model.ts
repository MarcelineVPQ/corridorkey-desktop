// The Console page's view model, pure (tests/unit/consoleBlocks.test.ts): the typed line's colouring from the shared
// parser's tokens, and the output blocks as the page shows them (merged by id, cleared by cls or Ctrl+L, their status
// words, the paths a command wrote, the text Copy output puts on the clipboard).
import type { Parsed, Token } from "../../shared/console/parse";
import type { Registry } from "../../shared/console/registry";
import type { ConsoleBlock } from "../../shared/types";

export type SpanKind = "plain" | "command" | "flag" | "value" | "path" | "string" | "error" | "danger";

export interface Span {
  text: string;
  kind: SpanKind;
  /** an error token's message (its tooltip) */
  title?: string;
}

const kindOf = (t: Token, expecting: Parsed["expecting"]): SpanKind => {
  // a flag the line ends on, still waiting for its value, is not a mistake yet
  if (t.kind === "error") return expecting && t.arg === expecting ? "flag" : "error";
  if (t.arg?.destructive) return "danger";
  return t.kind === "subcommand" ? "command" : t.kind;
};

/** The line cut into coloured spans: every character exactly once, in order. */
export function highlight(line: string, parsed: Parsed): Span[] {
  const out: Span[] = [];
  let pos = 0;
  // loop: HOT-PATH-OK — the line's tokens (sorted, ≤ a few dozen), per keystroke
  for (const t of parsed.tokens) {
    const start = Math.max(t.start, pos);
    const end = Math.min(Math.max(t.end, start), line.length);
    if (start > pos) out.push({ text: line.slice(pos, start), kind: "plain" });
    if (end > start) out.push({ text: line.slice(start, end), kind: kindOf(t, parsed.expecting), title: t.error });
    pos = Math.max(pos, end);
  }
  if (pos < line.length) out.push({ text: line.slice(pos), kind: "plain" });
  // `sudo` itself, and a line that will need it, read as a warning
  // loop: HOT-PATH-OK — the line's few spans, per keystroke
  const first = out.findIndex((sp) => sp.kind === "command");
  if (parsed.sudo && first >= 0) out[first] = { ...out[first], kind: "danger" };
  return out;
}

/** Blocks the page keeps (oldest dropped first); each keeps at most 2000 lines (the main process's cap). */
export const BLOCKS_KEPT = 200;

export interface BlockList {
  blocks: ConsoleBlock[];
  /** blocks with an id up to this one were cleared (cls, Ctrl+L), unless they still run */
  clearedTo: number;
}

/** New or changed blocks in: replaced by id, appended in id order; a `cls` clears what came before it. */
export function mergeBlocks(list: BlockList, incoming: readonly ConsoleBlock[]): BlockList {
  // loop: HOT-PATH-OK — ≤ BLOCKS_KEPT blocks, per push (≤ 10/s while a command prints)
  const byId = new Map(list.blocks.map((b) => [b.id, b]));
  let clearedTo = list.clearedTo;
  // loop: HOT-PATH-OK — the few blocks of one push
  for (const b of incoming) {
    byId.set(b.id, b);
    if (b.clear) clearedTo = Math.max(clearedTo, b.id);
  }
  // loop: HOT-PATH-OK — as above, sorted by id (the order they were typed)
  const blocks = [...byId.values()].sort((a, b) => a.id - b.id).slice(-BLOCKS_KEPT);
  return { blocks, clearedTo };
}

/** Ctrl+L: the screen is cleared at a block's edge (a command still running stays, whole). */
export function clearScreen(list: BlockList): BlockList {
  // loop: NOT-WORTH — ≤ BLOCKS_KEPT blocks, per Ctrl+L
  const last = list.blocks.reduce((m, b) => Math.max(m, b.id), list.clearedTo);
  return { ...list, clearedTo: last };
}

/** The blocks on screen: after the last clear (a running one always), never the `cls` lines themselves. */
export function visibleBlocks(list: BlockList): ConsoleBlock[] {
  // loop: HOT-PATH-OK — ≤ BLOCKS_KEPT blocks, per render
  return list.blocks.filter((b) => !b.clear && (b.id > list.clearedTo || b.state === "running"));
}

export type Tone = "running" | "ok" | "error" | "stopped";

/** The block's status: a word, its tone, the exit code, and what a non-zero code means (docs/CLI.md). */
export function blockStatus(b: ConsoleBlock): { word: string; tone: Tone; exit: string | null; meaning: string | null } {
  const exit = b.exitCode === null || b.state === "running" || b.state === "refused" ? null : `exit ${b.exitCode}`;
  const meaning = exit && b.exitCode !== 0 ? b.exitMeaning : null;
  const word = { running: "running", done: "done", failed: "failed", refused: "refused", cancelled: "stopped" }[b.state];
  const tone: Tone = { running: "running", done: "ok", failed: "error", refused: "error", cancelled: "stopped" }[b.state] as Tone;
  return { word, tone, exit, meaning };
}

/** How long it took ("0.4 s", "2 min 05 s"); null while it runs. */
export function duration(b: ConsoleBlock): string | null {
  if (b.finishedAt === null) return null;
  const s = Math.max(0, (b.finishedAt - b.startedAt) / 1000);
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(Math.round(s - m * 60)).padStart(2, "0")} s`;
}

/** The paths a corridorkey command wrote (its -o and --report as resolved and run; not the Console's own temp). */
export function writtenPaths(b: ConsoleBlock, reg: Registry): { flag: string; path: string }[] {
  if (!b.argv || !b.argv.length) return [];
  // loop: NOT-WORTH — four subcommands
  const cmd = reg.cli.subcommands.find((c) => c.name === b.argv![0]);
  if (!cmd) return [];
  const out: { flag: string; path: string }[] = [];
  // loop: NOT-WORTH — the run's few arguments, per finished block
  for (let i = 1; i < b.argv.length - 1; i++) {
    const w = b.argv[i];
    if (w === "--") break;
    // loop: NOT-WORTH — a command's ~50 flags, per flag word
    const arg = cmd.args.find((a) => (a.long && w === `--${a.long}`) || (a.short && w === `-${a.short}`));
    if (arg?.writes && arg.id !== "temp") out.push({ flag: w, path: b.argv[++i] });
  }
  return out;
}

/** Copy output: what the block printed, as text (a listing as its rows). */
export function blockText(b: ConsoleBlock): string {
  // loop: NOT-WORTH — ≤ 2000 lines, per Copy press
  const lines = b.lines.map((l) => l.text);
  if (b.entries)
    // loop: NOT-WORTH — ≤ 5000 rows, per Copy press
    for (const e of b.entries) lines.push(`${e.folder ? "<DIR>".padStart(14) : (e.bytes === null ? "?" : String(e.bytes)).padStart(14)}  ${e.name}${e.folder ? "/" : ""}`);
  return lines.join("\n");
}

/** A file's size in a listing (1 KiB = 1024 bytes, as the file managers show it). */
export function sizeText(bytes: number | null): string {
  if (bytes === null) return "?";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = bytes / 1024;
  let u = 0;
  // loop: NOT-WORTH — at most three steps
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

/** A refused line cut at its mistakes (the block's command shows where each one is). */
export function errorSpans(line: string, errors: readonly { start: number; end: number; message: string }[]): Span[] {
  // loop: NOT-WORTH — a line's few mistakes, per refused block render
  const marks = errors.filter((e) => e.end > e.start).sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  let pos = 0;
  // loop: NOT-WORTH — as above
  for (const e of marks) {
    const start = Math.max(pos, e.start);
    const end = Math.min(line.length, e.end);
    if (end <= start) continue;
    if (start > pos) out.push({ text: line.slice(pos, start), kind: "plain" });
    out.push({ text: line.slice(start, end), kind: "error", title: e.message });
    pos = end;
  }
  if (pos < line.length) out.push({ text: line.slice(pos), kind: "plain" });
  return out;
}
