// The Console's small scripting language (Phase 4, SME review item 7): a typed line or a script file is a list of
// commands joined by `;` (or a new line), `&&` (run the next only if this one ended 0) and `||` (only if it didn't);
// `for NAME in WORDS; do …; done`; `if LIST; then …; [else …;] fi`; `time COMMAND`. Nothing else: no subshells, no
// pipes, no redirections, no background jobs; each command is one Console line, read by the one parser (parse.ts) when
// it runs. The separators are found with the tokenizer's own quote and escape rules, so a `;` or `&&` in quotes is part
// of a word. Pure: the page colours a line with it, the main process runs it.
import { parse, tokenize, type ParseOptions, type Parsed, type Token } from "./parse";
import type { Registry } from "./registry";
import { READ_ONLY, VAR_NAME } from "./vars";

export type Op = ";" | "&&" | "||";

export interface CmdNode {
  kind: "cmd";
  /** the command's text (one Console line), its range in the source, the source line it starts on */
  text: string;
  start: number;
  line: number;
  /** `time COMMAND`: how long it took is printed after it */
  time: boolean;
}
export interface ForNode {
  kind: "for";
  name: string;
  /** the words after `in`, as typed (filled in and expanded when the loop starts) */
  items: string;
  itemsStart: number;
  body: List;
  line: number;
}
export interface IfNode {
  kind: "if";
  cond: List;
  then: List;
  else: List | null;
  line: number;
}
export type ScriptNode = CmdNode | ForNode | IfNode;
/** Each item with the operator before it (null: the first). */
export interface List {
  items: { op: Op | null; node: ScriptNode }[];
}

export interface ScriptError {
  message: string;
  start: number;
  end: number;
}

/** A piece of the source between two separators: [start, end), and the separator after it. */
interface Piece {
  start: number;
  end: number;
  sep: Op | "\n" | null;
}

const KEYWORDS = new Set(["for", "do", "done", "if", "then", "else", "fi", "time"]);
/** The keywords that end a list (the caller checks it is the one it expects). */
const CLOSERS = ["do", "done", "then", "else", "fi"];
const SPACE = /[ \t\r]/;

/** The source cut at its separators (outside quotes and escapes); `#` at a line's start is a comment to its end. */
function pieces(src: string, opts: ParseOptions): Piece[] | ScriptError {
  const r = scan(src, opts);
  return "message" in r ? r : r.pieces;
}

/**
 * Whether a line leaves a quote open at its end. Pasted lines are refused then: joined into one script, the quote would
 * run into the next line, which isn't "each line as a typed one" (P4 senior review N3).
 */
export function leavesQuoteOpen(line: string, opts: ParseOptions): boolean {
  const r = scan(line, opts);
  return !("message" in r) && r.quote !== null;
}

/** pieces(), and the quote still open at the end (null: none). */
function scan(src: string, opts: ParseOptions): { pieces: Piece[]; quote: string | null } | ScriptError {
  const out: Piece[] = [];
  let start = 0;
  let quote: string | null = null;
  let lineStart = true;
  // loop: HOT-PATH-OK — one pass over a typed line (≤ 8 KiB, per keystroke in the page) or a script (≤ 1 MiB, once)
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\" && quote === '"' && !opts.windows && (src[i + 1] === '"' || src[i + 1] === "\\")) i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (lineStart && c === "#") {
      const nl = src.indexOf("\n", i);
      const end = nl < 0 ? src.length : nl;
      // the comment is cut out: what came before it on the line (only spaces) ends there
      out.push({ start, end: i, sep: null });
      start = end;
      i = end - 1;
      continue;
    }
    if (!SPACE.test(c)) lineStart = false;
    if (c === "'" || c === '"') quote = c;
    else if (c === "\\" && !opts.windows) i++;
    else if (c === "\n" || c === ";") {
      out.push({ start, end: i, sep: c === "\n" ? "\n" : ";" });
      start = i + 1;
      lineStart = c === "\n";
    } else if ((c === "&" && src[i + 1] === "&") || (c === "|" && src[i + 1] === "|")) {
      out.push({ start, end: i, sep: c === "&" ? "&&" : "||" });
      start = i + 2;
      i++;
    } else if (c === "|") return { message: "| (a pipe) isn't part of the Console: one command's output never goes to another; quote a name with | in it", start: i, end: i + 1 };
  }
  out.push({ start, end: src.length, sep: null });
  return { pieces: out, quote };
}

/** The source line an offset is on (1-based): the new lines found once, then a binary search per command (S5 of the
 * senior review 2026-10-27: counting from the start for each command was quadratic). */
function lineFinder(src: string): (at: number) => number {
  const breaks: number[] = [];
  // loop: NOT-WORTH — one pass over the program's text, once per parse
  for (let i = src.indexOf("\n"); i !== -1; i = src.indexOf("\n", i + 1)) breaks.push(i);
  return (at) => {
    let lo = 0;
    let hi = breaks.length;
    // loop: NOT-WORTH — a binary search [bounded: log2 of the program's lines]
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (breaks[mid] < at) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
}

/** Read a whole program: a typed line or a script's text. */
export function parseProgram(src: string, opts: ParseOptions): { list: List } | { error: ScriptError } {
  const cut = pieces(src, opts);
  if (!Array.isArray(cut)) return { error: cut };
  const lineOf = lineFinder(src);
  // each piece's words (positions in the source); empty pieces dropped, the operator before kept
  const queue: { start: number; end: number; op: Op | null; words: { value: string; start: number; end: number; quoted: boolean }[] }[] = [];
  // the operator joining the next command to the one before (null: none yet)
  let pending: Op | null = null;
  // loop: NOT-WORTH — the program's pieces
  for (const p of cut) {
    const text = src.slice(p.start, p.end);
    // loop: NOT-WORTH — one piece's words
    const words = tokenize(text, opts).words.map((w) => ({ ...w, start: w.start + p.start, end: w.end + p.start }));
    if (words.length) {
      queue.push({ start: words[0].start, end: words[words.length - 1].end, op: pending, words });
      pending = null;
    } else if (p.sep === "&&" || p.sep === "||") return { error: { message: `${p.sep} needs a command before it`, start: p.end, end: p.end + 2 } };
    if (p.sep === "&&" || p.sep === "||") pending = p.sep;
    // a new line after && or || continues it (a && ⏎ b is a && b)
    else if (p.sep && pending !== "&&" && pending !== "||") pending = ";";
  }
  if (pending === "&&" || pending === "||") return { error: { message: `${pending} at the end: which command runs after it?`, start: src.length, end: src.length } };
  let at = 0;
  const kw = (q: (typeof queue)[number] | undefined) => (q && !q.words[0].quoted && KEYWORDS.has(q.words[0].value) ? q.words[0].value : null);
  const fail = (message: string, start: number, end: number) => ({ error: { message, start, end } });
  type Out<T> = T | { error: ScriptError };

  // a piece's rest after its first word (do cmd, then cmd, else cmd, time cmd): a piece of its own, or null
  const rest = (q: (typeof queue)[number], op: Op | null) => (q.words.length > 1 ? { start: q.words[1].start, end: q.end, op, words: q.words.slice(1) } : null);

  const list = (): Out<List> => {
    const items: List["items"] = [];
    // loop: NOT-WORTH — the program's pieces, each read once [bounded: the queue]
    while (at < queue.length && !CLOSERS.includes(kw(queue[at]) ?? "")) {
      const q = queue[at];
      const n = node(q);
      if ("error" in n) return n;
      items.push({ op: items.length ? (q.op ?? ";") : null, node: n });
    }
    return { items };
  };

  // the next pieces up to the keyword `word` (do, then, else): the list after it, the keyword's own rest first
  const block = (word: string, stop: readonly string[], what: string): Out<List> => {
    const q = queue[at];
    if (kw(q) !== word) return fail(`${what}: expected ${word} here`, q?.start ?? src.length, q?.end ?? src.length);
    const r = rest(q, null);
    if (r) queue[at] = r;
    else at++;
    const l = list();
    if ("error" in l) return l;
    if (!l.items.length) return fail(`${word} needs a command before ${stop.join(" or ")}`, q.start, q.end);
    return l;
  };

  const node = (q: (typeof queue)[number]): Out<ScriptNode> => {
    const k = kw(q);
    const line = lineOf(q.start);
    if (k === "for") {
      at++;
      const [, nameW, inW] = q.words;
      if (!nameW || !VAR_NAME.test(nameW.value) || nameW.quoted) return fail("for NAME in WORDS; do …; done: NAME is a variable's name", q.start, q.end);
      if ((READ_ONLY as readonly string[]).includes(nameW.value)) return fail(`\${${nameW.value}} is the Console's own: a loop can't set it`, nameW.start, nameW.end);
      if (!inW || inW.value !== "in" || inW.quoted) return fail(`for ${nameW.value} in WORDS: in comes after the name`, nameW.end, q.end);
      const itemsStart = q.words[3]?.start ?? inW.end;
      const items = src.slice(itemsStart, q.end);
      const body = block("do", ["done"], `for ${nameW.value}`);
      if ("error" in body) return body;
      const end = queue[at];
      if (kw(end) !== "done") return fail(`for ${nameW.value}: done is missing (for … ; do … ; done)`, q.start, src.length);
      if (end.words.length > 1) return fail("done ends the loop: put ; before the next command", end.words[1].start, end.end);
      at++;
      return { kind: "for", name: nameW.value, items, itemsStart, body, line };
    }
    if (k === "if") {
      const r = rest(q, null);
      if (!r) return fail("if needs a command (if COMMAND; then …; fi)", q.start, q.end);
      queue[at] = r;
      const cond = list();
      if ("error" in cond) return cond;
      const then = block("then", ["else", "fi"], "if");
      if ("error" in then) return then;
      let otherwise: List | null = null;
      if (kw(queue[at]) === "else") {
        const e = block("else", ["fi"], "else");
        if ("error" in e) return e;
        otherwise = e;
      }
      const end = queue[at];
      if (kw(end) !== "fi") return fail("if: fi is missing (if …; then …; fi)", q.start, src.length);
      if (end.words.length > 1) return fail("fi ends the if: put ; before the next command", end.words[1].start, end.end);
      at++;
      return { kind: "if", cond, then, else: otherwise, line };
    }
    if (k === "time") {
      at++;
      const r = rest(q, null);
      if (!r) return fail("time needs a command (time render …)", q.start, q.end);
      if (kw(r)) return fail(`time takes one command, not ${kw(r)}`, r.start, r.end);
      return { kind: "cmd", text: src.slice(r.start, r.end), start: r.start, line, time: true };
    }
    if (k) return fail(`${k} without its ${k === "done" || k === "do" ? "for" : "if"}`, q.start, q.words[0].end);
    at++;
    return { kind: "cmd", text: src.slice(q.start, q.end), start: q.start, line, time: false };
  };

  const top = list();
  if ("error" in top) return top;
  if (at < queue.length) {
    const q = queue[at];
    return fail(`${kw(q)} without its ${kw(q) === "done" || kw(q) === "do" ? "for" : "if"}`, q.start, q.words[0].end);
  }
  return { list: top };
}

/** Every command in a program, in order (inside loops and ifs too). */
export function commands(list: List): CmdNode[] {
  // loop: NOT-WORTH — a program's few nodes
  return list.items.flatMap(({ node: n }) => (n.kind === "cmd" ? [n] : n.kind === "for" ? commands(n.body) : [...commands(n.cond), ...commands(n.then), ...(n.else ? commands(n.else) : [])]));
}

/** A program that is more than one plain command: it runs as a script (one at a time, its own elevation). */
export function isCompound(list: List): boolean {
  return list.items.length > 1 || (list.items.length === 1 && (list.items[0].node.kind !== "cmd" || list.items[0].node.time));
}

/**
 * The page's reading of a typed line: each command parsed with the one parser, its tokens and mistakes at their place
 * in the line; the keywords as commands; the command the line ends in as the line's command (its hint, completion).
 */
export function parseLine(line: string, reg: Registry, opts: ParseOptions): Parsed {
  const prog = parseProgram(line, opts);
  if ("error" in prog || !isCompound(prog.list)) {
    const p = parse(line, reg, opts);
    if ("error" in prog) {
      p.errors.unshift(prog.error);
      p.tokens.push({ kind: "error", start: prog.error.start, end: Math.max(prog.error.end, prog.error.start), error: prog.error.message });
      // loop: NOT-WORTH — sorts the line's tokens, per keystroke
      p.tokens.sort((a, b) => a.start - b.start);
    }
    return p;
  }
  const cmds = commands(prog.list);
  const out = parse("", reg, opts);
  const extra: Token[] = [];
  // keywords (and a for's words) are coloured by where they are, from the tokenizer
  const { words } = tokenize(line, opts);
  // loop: NOT-WORTH — the line's words, per keystroke
  for (const w of words)
    // loop: NOT-WORTH — the line's few commands, per word
    if (!w.quoted && KEYWORDS.has(w.value) && !cmds.some((c) => w.start >= c.start && w.start < c.start + c.text.length)) extra.push({ kind: "subcommand", start: w.start, end: w.end });
  // loop: NOT-WORTH — the line's few commands
  for (const c of cmds) {
    const p = parse(c.text, reg, opts);
    // loop: NOT-WORTH — one command's tokens
    out.tokens.push(...p.tokens.map((t) => ({ ...t, start: t.start + c.start, end: t.end + c.start })));
    // loop: NOT-WORTH — one command's mistakes
    out.errors.push(...p.errors.map((e) => ({ ...e, start: e.start + c.start, end: e.end + c.start })));
    Object.assign(out, { command: p.command, sudo: out.sudo || p.sudo, help: p.help, options: p.options, positionals: p.positionals, expecting: p.expecting, version: p.version });
  }
  out.tokens.push(...extra);
  // loop: NOT-WORTH — sorts the line's tokens, per keystroke
  out.tokens.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * Where the command the cursor is in starts (Tab completes from there): after the last separator, and after a keyword
 * that takes a command (do, then, else, if, time, and && …).
 */
export function commandStart(head: string, opts: ParseOptions): number {
  const cut = pieces(head, opts);
  if (!Array.isArray(cut)) return 0;
  const last = cut[cut.length - 1];
  let start = last.start;
  // loop: NOT-WORTH — a keyword or two at a command's start
  for (;;) {
    const words = tokenize(head.slice(start), opts).words;
    const w = words[0];
    if (!w || w.quoted || !["do", "then", "else", "if", "time"].includes(w.value) || (words.length === 1 && w.end + start === head.length)) return start;
    start += w.end;
  }
}

/** A file-name pattern (`*`, `?`, `[a-z]`, `[!a-z]`) as a whole-name regular expression; `fold`: any case. */
export function globRegExp(pattern: string, fold: boolean, active?: readonly boolean[]): RegExp {
  let re = "";
  // loop: NOT-WORTH — one short pattern
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    // a character from a variable's value or quotes (active false) is itself (SME review 2026-10-27 M3)
    if (active && !active[i]) re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const close = pattern.indexOf("]", i + 2);
      if (close < 0) {
        re += "\\[";
        continue;
      }
      let body = pattern.slice(i + 1, close);
      const neg = body.startsWith("!") || body.startsWith("^");
      if (neg) body = body.slice(1);
      re += `[${neg ? "^" : ""}${body.replace(/[\\\]^]/g, "\\$&")}]`;
      i = close;
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, fold ? "iu" : "u");
}
