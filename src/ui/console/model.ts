// The Console page's view model, pure (tests/unit/consoleBlocks.test.ts): the typed line's colouring from the shared
// parser's tokens, and the output blocks as the page shows them (merged by id, cleared by cls or Ctrl+L, their status
// words, the paths a command wrote, the text Copy output puts on the clipboard), and where the input line wants focus.
import type { Parsed, Token } from "../../shared/console/parse";
import { expandHistory, hasExpansion, type HistoryLine } from "../../shared/console/expand";
import { fullName, type Registry } from "../../shared/console/registry";
import type { ConsoleBlock, ConsoleEntry, DoctorRow } from "../../shared/types";
import { shortenPath } from "../paths";
import { fileSizeText } from "../../shared/units";

/**
 * Does the input line take focus? When the page opens and when the narrow-window drawer that covered it closes
 * (Escape, the dimmed page, the rail item); never while the drawer covers it. `wasCovered` is null on the first run.
 */
export function inputTakesFocus(wasCovered: boolean | null, covered: boolean): boolean {
  return !covered && wasCovered !== false;
}

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
    // a value with a ${name} in it is checked once it is filled in (when it runs), not as typed
    const text = line.slice(start, end);
    if (end > start) out.push(t.kind === "error" && text.includes("${") ? { text, kind: "value" } : { text, kind: kindOf(t, parsed.expecting), title: t.error });
    pos = Math.max(pos, end);
  }
  if (pos < line.length) out.push({ text: line.slice(pos), kind: "plain" });
  // `sudo` itself, and a line that will need it, read as a warning
  // loop: HOT-PATH-OK — the line's few spans, per keystroke
  const first = out.findIndex((sp) => sp.kind === "command");
  if (parsed.sudo && first >= 0) out[first] = { ...out[first], kind: "danger" };
  return out;
}

/**
 * The prompt's folder (SME review 2026-10-26 N9: the last folder alone, `key`, says nothing when every shot has
 * comp/key): inside a bookmark, `@sh010` and the rest (`@sh010/key`, `@sh010/…/key`); else the last two folders
 * (`comp/key`); `~` at home.
 */
export function promptFolder(cwd: string, home: string, bookmarks: Readonly<Record<string, string>>): string {
  const sep = (p: string) => p.replace(/[\\/]+$/, "");
  const at = sep(cwd);
  if (at === sep(home)) return "~";
  let best: [string, string] | null = null;
  // loop: NOT-WORTH — ≤ 200 bookmarks, per folder change
  for (const [name, folder] of Object.entries(bookmarks)) {
    const f = sep(folder);
    if ((at === f || at.startsWith(f + "/") || at.startsWith(f + "\\")) && (!best || f.length > best[1].length)) best = [name, f];
  }
  // loop: NOT-WORTH — a path's few parts
  const parts = (p: string) => p.split(/[\\/]/).filter(Boolean);
  if (best) {
    const rest = parts(at.slice(best[1].length));
    return `@${best[0]}${rest.length === 0 ? "" : rest.length === 1 ? `/${rest[0]}` : `/…/${rest[rest.length - 1]}`}`;
  }
  const all = parts(at);
  return all.length ? all.slice(-2).join("/") : cwd;
}

/** Blocks the page keeps (oldest dropped first); each keeps at most 2000 lines and 256 000 characters (the main process's caps). */
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
    byId.set(b.id, withLines(byId.get(b.id), b));
    if (b.clear) clearedTo = Math.max(clearedTo, b.id);
  }
  // loop: HOT-PATH-OK — as above, sorted by id (the order they were typed)
  const blocks = [...byId.values()].sort((a, b) => a.id - b.id).slice(-BLOCKS_KEPT);
  return { blocks, clearedTo };
}

/**
 * A pushed block with the page's earlier lines in front of the appended ones (`linesFrom`: the number of the first),
 * then the front the main process dropped (its `linesDropped`) dropped here too. A block pushed whole has no
 * `linesFrom`. Lines the page never got (it started after them) count as not kept.
 */
function withLines(old: ConsoleBlock | undefined, b: ConsoleBlock): ConsoleBlock {
  if (b.linesFrom === undefined) return b;
  const joins = old !== undefined && old.linesDropped <= b.linesFrom && b.linesFrom <= old.linesDropped + old.lines.length;
  const start = joins ? old.linesDropped : b.linesFrom;
  const lines = joins ? old.lines.slice(0, b.linesFrom - start).concat(b.lines) : b.lines;
  const dropped = Math.max(b.linesDropped, start);
  return { ...b, lines: lines.slice(dropped - start), linesDropped: dropped, linesFrom: undefined };
}

/** Ctrl+L: the screen is cleared at a block's edge (a command still running stays, whole). */
export function clearScreen(list: BlockList): BlockList {
  // loop: NOT-WORTH — ≤ BLOCKS_KEPT blocks, per Ctrl+L
  const last = list.blocks.reduce((m, b) => Math.max(m, b.id), list.clearedTo);
  return { ...list, clearedTo: last };
}

/**
 * The blocks on screen: after the last clear (a running one always), never the `cls` lines themselves; the queue's
 * echoed jobs only with `echoes` (Console settings → GUI jobs as commands).
 */
export function visibleBlocks(list: BlockList, echoes = true): ConsoleBlock[] {
  // loop: HOT-PATH-OK — ≤ BLOCKS_KEPT blocks, per render
  return list.blocks.filter((b) => !b.clear && (echoes || !b.echo) && (b.id > list.clearedTo || b.state === "running"));
}

/**
 * The blocks shown with "Failed only" (SME review 2026-10-26 N8, Warp's filter): those that failed or were refused, and
 * any still running (it may yet fail); with the count left out, which the page says.
 */
export function filterBlocks(blocks: readonly ConsoleBlock[], failedOnly: boolean): { blocks: readonly ConsoleBlock[]; hidden: number } {
  if (!failedOnly) return { blocks, hidden: 0 };
  // loop: HOT-PATH-OK — ≤ BLOCKS_KEPT blocks, per render with the filter on
  const kept = blocks.filter((b) => b.state === "failed" || b.state === "refused" || b.state === "running");
  return { blocks: kept, hidden: blocks.length - kept.length };
}

/**
 * Ctrl+↑ / Ctrl+↓ among the blocks shown (top-level ones: a program's commands go with it): the one before or after
 * `current`; from the input (null) ↑ is the newest; past the newest is null (back at the input).
 */
export function nextBlock(ids: readonly number[], current: number | null, by: -1 | 1): number | null {
  if (!ids.length) return null;
  const i = current === null ? ids.length : ids.indexOf(current);
  const j = (i < 0 ? ids.length : i) + by;
  if (j >= ids.length) return null;
  return ids[Math.max(0, j)];
}

export type Tone = "running" | "ok" | "error" | "stopped";

/** The block's status: a word, its tone, the exit code, and what a non-zero code means (docs/CLI.md). */
export function blockStatus(b: ConsoleBlock): { word: string; tone: Tone; exit: string | null; meaning: string | null } {
  // a queue job's line (teach by echo): where it came from, never an exit code
  if (b.echo) return { word: "from the queue", tone: "ok", exit: null, meaning: null };
  const exit = b.exitCode === null || b.state === "running" || b.state === "refused" ? null : `exit ${b.exitCode}`;
  const meaning = exit && b.exitCode !== 0 ? b.exitMeaning : null;
  const word = { running: "running", done: "done", failed: "failed", refused: "refused", cancelled: "stopped" }[b.state];
  const tone: Tone = { running: "running", done: "ok", failed: "error", refused: "error", cancelled: "stopped" }[b.state] as Tone;
  return { word, tone, exit, meaning };
}

/**
 * What a screen reader hears (the page's one polite status region): the newest command's start and end, as a word and
 * its exit, never the streamed lines, the progress or a listing's rows (the output itself isn't a live region).
 */
export function announcement(blocks: readonly ConsoleBlock[]): string {
  const b = blocks.at(-1);
  if (!b) return "";
  const { word, exit, meaning } = blockStatus(b);
  if (b.state === "refused") return `${b.line}: refused${b.lines[0] ? `: ${b.lines[0].text}` : ""}`;
  return `${b.line}: ${word}${exit ? `, ${exit}` : ""}${meaning ? ` (${meaning})` : ""}`;
}

/** A built-in's block (no corridorkey argv, no progress) is drawn compact: the runs stand out in a long session. */
export const compactBlock = (b: ConsoleBlock): boolean => b.argv === null && b.progress === null;

/**
 * A program's command (a block with a parent) as one row (SME review 2026-10-27 S8: a 40-shot loop was a wall of
 * headers): a mark, the line, its time, its last output line. It shows whole while it runs, when it failed or was
 * refused (it opens on its own), and when the row is opened.
 */
export const childOpens = (b: ConsoleBlock): boolean => b.state === "running" || b.state === "failed" || b.state === "refused";

/**
 * The row's mark (✓ done, ✗ failed or refused, ■ stopped, … running), the command's last output line with its known
 * paths shown as the blocks show them (`full`: as printed, for hover), and what was typed when the line ran filled in
 * (the block's `from <what was typed>`), else null.
 */
export function childRow(b: ConsoleBlock, home: string): { mark: string; last: string | null; full: string | null; source: string | null } {
  const mark = { running: "…", done: "✓", failed: "✗", refused: "✗", cancelled: "■" }[b.state];
  // the last line it printed, not the Console's own note (from <what was typed>)
  // loop: NOT-WORTH — a block's lines, from the end, per render of a changed row
  const full = [...b.lines].reverse().find((l) => l.kind !== "info")?.text ?? null;
  const first = b.lines[0];
  const source = first?.kind === "info" && first.text.startsWith("from ") ? first.text : null;
  return { mark, last: full === null ? null : shortenKnown(full, b.paths, home), full, source };
}

/** The measured rate, as measured: "3.1 frames/s over the last 20 frames" (SME review 2026-10-26 N2; no ETA). */
export function rateText(r: { fps: number; frames: number }): string {
  return `${r.fps < 10 ? r.fps.toFixed(1) : Math.round(r.fps)} frames/s over the last ${r.frames} frame${r.frames === 1 ? "" : "s"}`;
}

/**
 * Copy as Nuke Read (SME review 2026-10-27 N8): a Read node per sequence a render wrote, as Nuke pastes it from the
 * clipboard: the file with %04d (forward slashes on every system, Nuke's own), its first and last frame there, a name
 * from the file. The path in braces (Tcl reads nothing inside), or in quotes with Tcl's specials escaped when it has a
 * brace itself.
 */
export function nukeRead(reads: readonly { path: string; first: number; last: number }[]): string {
  // loop: NOT-WORTH — a render's few outputs
  return reads
    .map((r) => {
      const slashed = r.path.replace(/\\/g, "/");
      const cut = slashed.lastIndexOf("/") + 1;
      // the frame token in the file's name only (a folder may have a # in its name)
      const file = slashed.slice(0, cut) + slashed.slice(cut).replace(/#+/, (h) => (h.length === 1 ? "%d" : `%0${h.length}d`));
      const tcl = /[{}]/.test(file) ? `"${file.replace(/[\\"$[\]{}]/g, "\\$&")}"` : `{${file}}`;
      const stem = (file.split("/").pop() ?? "").replace(/\.%0?\d*d.*$|%0?\d*d.*$/, "").replace(/[^A-Za-z0-9_]/g, "_");
      return [
        "Read {",
        " inputs 0",
        ` file ${tcl}`,
        ` first ${r.first}`,
        ` last ${r.last}`,
        ` origfirst ${r.first}`,
        ` origlast ${r.last}`,
        " origset true",
        ` name Read_${stem.replace(/^_+|_+$/g, "") || "corridorkey"}`,
        "}",
      ].join("\n");
    })
    .join("\n");
}

/** How long it took ("0.4 s", "2 min 05 s"); null while it runs. */
export function duration(b: ConsoleBlock): string | null {
  // a queue job's echoed line ran nothing here: no time to show
  if (b.finishedAt === null || b.echo) return null;
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

/** A listing's date: local time, YYYY-MM-DD HH:MM (sortable, the same in every studio); "" when unknown. */
export function isoTime(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A listing row's name cell: the name (a folder with /), a sequence's frames after it. */
export const entryName = (e: ConsoleEntry): string => (e.folder ? `${e.name}/` : e.name) + (e.sequence ? `  ${sequenceText(e.sequence)}` : "");

/** Copy output: what the block printed, as text; a listing as the table shows it (name, size, modified). */
export function blockText(b: ConsoleBlock): string {
  // loop: NOT-WORTH — ≤ 2000 lines, per Copy press
  return [...b.lines.map((l) => l.text), ...blockTable(b)].join("\n");
}

/** A block's table as text lines (a listing: name, size, modified; doctor's rows): Copy output, `corridorkey run`. */
export function blockTable(b: ConsoleBlock): string[] {
  const lines: string[] = [];
  if (b.entries?.length) {
    // loop: NOT-WORTH — ≤ 5000 rows, per Copy press
    const rows = b.entries.map((e) => [entryName(e), e.folder ? "folder" : fileSizeText(e.bytes), isoTime(e.modified)]);
    // loop: NOT-WORTH — as above
    const w = Math.max(4, ...rows.map((r) => r[0].length));
    // loop: NOT-WORTH — as above
    for (const r of [["Name", "Size", "Modified"], ...rows]) lines.push(`${r[0].padEnd(w)}  ${r[1].padEnd(10)}  ${r[2]}`.trimEnd());
  }
  if (b.doctor?.length) lines.push(...doctorText(b.doctor));
  return lines;
}

export const DOCTOR_MARK = { ok: "✓", warn: "⚠", fail: "✗" } as const;

/** doctor's rows as aligned text (Copy output): mark, check, detail, and a problem's fix under its detail; paths whole. */
export function doctorText(rows: readonly DoctorRow[]): string[] {
  // loop: NOT-WORTH — the few rows
  const w = Math.max(...rows.map((r) => r.check.length));
  // loop: NOT-WORTH — as above
  return rows.flatMap((r) => [`${DOCTOR_MARK[r.status]} ${r.check.padEnd(w)}  ${r.detail}`, ...(r.fix && r.status !== "ok" ? [`  ${" ".repeat(w)}  fix: ${r.fix}`] : [])]);
}

/** A block line with the absolute paths it is known to hold shown as the app shows paths (~, the middle as …). */
export function shortenKnown(text: string, paths: readonly string[] | null | undefined, home: string, max = 48): string {
  // the longest first, and only where a whole path ends (…/sh010 never inside …/sh010/plates)
  // loop: NOT-WORTH — a block's few paths (≤ 50), per line shown
  for (const p of [...(paths ?? [])].sort((x, y) => y.length - x.length))
    if (p && text.includes(p)) text = text.replace(new RegExp(`${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w./\\\\-])`, "g"), () => shortenPath(p, home, max));
  return text;
}

/** A sequence row's frames, lsseq-style: "1001-1100 · 96 frames · missing 1047, 1050-1052" (Copy output: all of it). */
export function sequenceText(q: NonNullable<ConsoleEntry["sequence"]>): string {
  return `${q.range} · ${q.count} frames${q.missing ? ` · missing ${q.missing}` : ""}${belowZeroText(q)}`;
}

const belowZeroText = (q: NonNullable<ConsoleEntry["sequence"]>) => (q.belowZero ? ` · ${q.belowZero} below 0 (corridorkey's patterns and -F start at 0)` : "");

/** A listing row's hover: the name whole; a sequence's range and count, and its gaps. */
export function entryTitle(e: ConsoleEntry): string {
  if (!e.sequence) return entryName(e);
  const c = sequenceCell(e.sequence);
  return `${e.name}\n${c.text}${c.title ? `\n${c.title}` : ""}`;
}

/**
 * The listing's cell for a sequence (SME review 2026-10-27 N5: the gaps were cut off with …): the range and the count
 * of what is there out of the range ("1001-1048 · 43/48 frames"); the gaps go in the hover, `title`.
 */
export function sequenceCell(q: NonNullable<ConsoleEntry["sequence"]>): { text: string; title: string | null } {
  const gaps = q.gaps ?? q.missing;
  const frames = gaps && q.span ? `${q.count}/${q.span} frames` : `${q.count} frames`;
  return { text: `${q.range} · ${frames}${belowZeroText(q)}`, title: gaps ? `missing ${gaps}` : null };
}

/**
 * A block's line as words for the page (SME review 2026-10-27 N4: the echoed queue line broke inside `--codec`): each
 * run of spaces as text, each word as its spans (a mistake's mark kept), drawn as one unit that wraps only at the spaces
 * (a word longer than the line still wraps inside itself).
 */
export function lineWords(spans: readonly Span[]): (string | Span[])[] {
  const out: (string | Span[])[] = [];
  // loop: NOT-WORTH — a line's few spans, per block render
  for (const sp of spans)
    // loop: NOT-WORTH — the span's words and spaces
    for (const part of sp.text.split(/(\s+)/)) {
      if (!part) continue;
      const last = out[out.length - 1];
      if (/^\s+$/.test(part)) out.push(typeof last === "string" ? (out.pop() as string) + part : part);
      else if (Array.isArray(last)) last.push({ ...sp, text: part });
      else out.push([{ ...sp, text: part }]);
    }
  return out;
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

/**
 * A line with a history shortcut (!!, !N, !$, ^old^new…): what Enter will run, from the history the page has (the main
 * process expands it again from the whole history), or why it can't. Null: nothing to expand.
 */
export function expansionHint(line: string, past: readonly HistoryLine[], windows: boolean): { text: string; error: boolean; line: string | null } | null {
  if (!hasExpansion(line, { windows })) return null;
  const x = expandHistory(line, past, { windows });
  return "error" in x ? { text: x.error, error: true, line: null } : { text: `Enter runs: ${x.line}`, error: false, line: x.line };
}

/** What the line says about itself: a mistake (with did-you-mean), else the help of the argument at the cursor. */
export function lineHint(p: Parsed, line: string, cursor: number, reg: Registry, typing: boolean): { text: string; error: boolean } | null {
  if (!line.trim()) return null;
  // what the line still needs at its end ("needs a value"), or a word still being typed toward a suggestion, is what
  // comes next, not a mistake
  const pending = (e: { end: number; message: string }) => e.end >= line.length && (typing || / needs /.test(e.message));
  // a value with a ${name} in it is checked once it is filled in
  // loop: HOT-PATH-OK — the line's few mistakes, per keystroke
  const errors = p.errors.filter((e) => !line.slice(e.start, e.end).includes("${"));
  // loop: HOT-PATH-OK — as above
  const err = errors.find((e) => !pending(e)) ?? errors[0];
  if (err && typing && pending(err)) return null;
  if (err) return { text: err.message, error: !pending(err) };
  // loop: HOT-PATH-OK — the line's tokens, per keystroke
  const tok = p.tokens.find((t) => t.arg && cursor >= t.start && cursor <= t.end);
  if (tok?.arg) {
    const a = tok.arg;
    const name = a.positional ? (a.valueName ?? a.id) : `${a.long ? `--${a.long}` : `-${a.short}`}${a.valueName ? ` ${a.valueName}` : ""}`;
    // "(needs sudo)" only until sudo is on the line
    return { text: `${name}: ${a.help}${a.destructive && !p.sudo ? " (needs sudo)" : ""}${a.writes ? " (only into chosen folders)" : ""}`, error: false };
  }
  if (p.command) return { text: `${fullName(reg, p.command)}: ${p.command.about}`, error: false };
  return null;
}
