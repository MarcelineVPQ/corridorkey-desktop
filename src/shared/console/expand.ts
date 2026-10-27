// History expansion, as bash does it for a typed line (never in a script): `!!` the line before, `!N` line N (history's
// stable numbers), `!-N` the Nth line before, `!prefix` the newest line starting with prefix, `!$` the last word of the
// line before, `^old^new` the line before with its first `old` replaced. In this world `!`, `#`, `%04d`, `$F4` and `@`
// are parts of file names (SME review), so: a `!` expands only at the start of a word, outside quotes, not escaped,
// and only before `!`, a digit, `-` and a digit, `$` (not Houdini's `$F`) or a letter; everything else stays as typed.
// The expanded line is what runs, what the block shows and what the history keeps. Pure.
import { tokenize, type ParseOptions } from "./parse";

export interface HistoryLine {
  n: number;
  line: string;
}

export type Expansion = { line: string; changed: boolean } | { error: string };

const SPACE = /[ \t]/;

/** The designators in a line, with where each is: [start, end) and its spec ("!!", "!41", "!-2", "!ren", "!$"). */
function designators(line: string, opts: ParseOptions): { start: number; end: number; spec: string }[] {
  const out: { start: number; end: number; spec: string }[] = [];
  let quote: string | null = null;
  // loop: HOT-PATH-OK — one pass over a typed line (≤ 8 KiB), per keystroke in the page's preview
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      // "…" keeps \" (Linux, macOS), as the tokenizer reads it
      if (c === "\\" && quote === '"' && !opts.windows) i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "\\" && !opts.windows) i++;
    else if (c === "!" && (i === 0 || SPACE.test(line[i - 1]))) {
      const rest = line.slice(i + 1);
      const m = /^(!|\d+|-\d+|\$(?!F)|[A-Za-z][^\s'"]*)/.exec(rest);
      if (m) {
        out.push({ start: i, end: i + 1 + m[0].length, spec: "!" + m[0] });
        i += m[0].length;
      }
    }
  }
  return out;
}

/** Whether a typed line has anything to expand (the page's preview; the main process expands it). */
export function hasExpansion(line: string, opts: ParseOptions = { windows: false }): boolean {
  return line.startsWith("^") || designators(line, opts).length > 0;
}

/** The typed line with its history designators replaced, or what is wrong (bash's "event not found"). */
export function expandHistory(line: string, past: readonly HistoryLine[], opts: ParseOptions): Expansion {
  const prev = past[past.length - 1];
  if (line.startsWith("^")) {
    // ^old^new (a closing ^ optional): the line before, its first old replaced
    const m = /^\^([^^]+)\^([^^]*)\^?(.*)$/.exec(line);
    if (!m) return { error: `${line}: ^old^new replaces old with new in the line before` };
    if (!prev) return { error: `${line}: the history is empty` };
    if (!prev.line.includes(m[1])) return { error: `${line}: '${m[1]}' isn't in the line before (${prev.line})` };
    return { line: prev.line.replace(m[1], () => m[2]) + m[3], changed: true };
  }
  const found = designators(line, opts);
  if (!found.length) return { line, changed: false };
  let out = "";
  let pos = 0;
  // loop: NOT-WORTH — a line's few designators
  for (const d of found) {
    const s = d.spec.slice(1);
    let text: string;
    if (!past.length) return { error: `${d.spec}: the history is empty` };
    if (s === "!") text = prev.line;
    else if (s === "$") {
      const words = tokenize(prev.line, opts).words;
      const last = words[words.length - 1];
      text = last ? prev.line.slice(last.start, last.end) : "";
    } else if (/^\d+$/.test(s)) {
      // loop: NOT-WORTH — ≤ the history's lines, per !N typed
      const e = past.find((x) => x.n === Number(s));
      if (!e) return { error: `${d.spec}: no line ${s} in the history (history lists the numbers)` };
      text = e.line;
    } else if (/^-\d+$/.test(s)) {
      const e = past[past.length + Number(s)];
      if (!e || Number(s) === 0) return { error: `${d.spec}: the history has only ${past.length} lines` };
      text = e.line;
    } else {
      // loop: NOT-WORTH — ≤ the history's lines, newest first, per !prefix typed
      const e = [...past].reverse().find((x) => x.line.startsWith(s));
      if (!e) return { error: `${d.spec}: no line in the history starts with ${s}` };
      text = e.line;
    }
    out += line.slice(pos, d.start) + text;
    pos = d.end;
  }
  return { line: out + line.slice(pos), changed: true };
}
