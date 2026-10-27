// The Console's variables (Phase 4, SME review item 6): `${name}` only, braces required. In this world `$F`, `$F4`,
// `$HIP`, `%04d`, `####`, `@@@@` and `!` are parts of file names, so nothing else is ever expanded. A `${name}` expands
// outside quotes and inside "…", never inside '…' or after a backslash (Linux, macOS). A word with a variable in it
// becomes ONE quoted word: a value never splits into words and is never read as a flag, `sudo`, `?`, `--` or a command
// name (so the destructive flags a line has are the ones typed). Pure.
import { tokenize, type ParseOptions } from "./parse";

/** A variable's name: a letter or _, then letters, digits, _ (never __proto__: names are an object's keys). */
export const VAR_NAME = /^(?!__proto__$)[A-Za-z_][A-Za-z0-9_]*$/;
/** The Console's own, read-only: the current folder, home, today (YYYY-MM-DD), now (HH-MM-SS), the last exit status. */
export const READ_ONLY = ["cwd", "home", "date", "time", "status"] as const;
/** A value's longest. */
export const VALUE_MAX = 4096;

export type VarExpansion = { line: string; changed: boolean } | { error: string };

/** Whether a line has a `${` to expand (cheap: the expansion itself says what is wrong). */
export const hasVars = (line: string): boolean => line.includes("${");

/** A word's value forced into quotes (expanded: never a flag), as the tokenizer reads it back; null when it can't be. */
function quoted(value: string, opts: ParseOptions): string | null {
  if (!opts.windows) return `"${value.replace(/[\\"]/g, "\\$&")}"`;
  // Windows: "…" and '…' are both literal (no escapes): a value with both quote marks can't be written as one word
  if (!value.includes('"')) return `"${value}"`;
  return value.includes("'") ? null : `'${value}'`;
}

/** A word as the tokenizer reads it, with `${name}` filled in where it counts. `active`: per character of `value`, typed
 * outside quotes and unescaped (only those can make a glob or a frame pattern: a value's characters never do). */
type WordValue = { value: string; active: boolean[]; used: boolean };

function readWord(src: string, lookup: (name: string) => string | undefined, opts: ParseOptions): WordValue | { error: string } {
  let value = "";
  const active: boolean[] = [];
  let used = false;
  let quote: string | null = null;
  const add = (t: string, on: boolean) => {
    value += t;
    // loop: NOT-WORTH — one value's characters
    for (let k = 0; k < t.length; k++) active.push(on);
  };
  // loop: NOT-WORTH — one word's characters
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && c === "\\" && !opts.windows && (src[i + 1] === '"' || src[i + 1] === "\\")) add(src[++i], false);
      else if (quote === '"' && c === "$" && src[i + 1] === "{") {
        const r = take(src, i, lookup);
        if ("error" in r) return r;
        add(r.value, false);
        [i, used] = [r.end, true];
      } else add(c, false);
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "\\" && !opts.windows && i + 1 < src.length) add(src[++i], false);
    else if (c === "$" && src[i + 1] === "{") {
      const r = take(src, i, lookup);
      if ("error" in r) return r;
      add(r.value, false);
      [i, used] = [r.end, true];
    } else add(c, true);
  }
  return { value, active, used };
}

/** The line with each `${name}` replaced by `lookup(name)`, or what is wrong (an unknown name, an unclosed brace). */
export function expandVars(line: string, lookup: (name: string) => string | undefined, opts: ParseOptions): VarExpansion {
  if (!hasVars(line)) return { line, changed: false };
  const { words } = tokenize(line, opts);
  let out = "";
  let pos = 0;
  let changed = false;
  // loop: NOT-WORTH — a typed line's words (≤ 8 KiB), once per line run
  for (const w of words) {
    const src = line.slice(w.start, w.end);
    if (!src.includes("${")) continue;
    const r = readWord(src, lookup, opts);
    if ("error" in r) return r;
    if (!r.used) continue;
    const value = r.value;
    const q = quoted(value, opts);
    if (q === null) return { error: `${src}: its value has both ' and ", which a word can't hold on Windows` };
    out += line.slice(pos, w.start) + q;
    pos = w.end;
    changed = true;
  }
  return { line: out + line.slice(pos), changed };
}

/** The `${name}` at `i` in `src`: its value and the index of its `}`, or what is wrong. */
function take(src: string, i: number, lookup: (name: string) => string | undefined): { value: string; end: number } | { error: string } {
  const close = src.indexOf("}", i + 2);
  const name = close < 0 ? null : src.slice(i + 2, close);
  if (name !== null && LIST.test(`\${${name}}`)) return { error: `\${${name}}: a list splits only as a whole word of a for loop (for s in \${${name}})` };
  if (name === null || !VAR_NAME.test(name)) return { error: `${src}: a variable is \${name} (letters, digits, _); quote a literal \${ with '…'` };
  const v = lookup(name);
  if (v === undefined) return { error: `\${${name}}: no such variable (set lists them; set ${name}=value makes it)` };
  return { value: v, end: close };
}

/** `${name[@]}`: a variable's value split at white space, as a whole word of a for loop (S10). */
const LIST = /^\$\{((?!__proto__\])[A-Za-z_][A-Za-z0-9_]*)\[@\]\}$/;

export interface ForWord {
  value: string;
  /** per character: typed outside quotes and unescaped (a glob's * ? [ and a frame token count only there) */
  active: boolean[];
}

/**
 * A for loop's words with `${name}` filled in (SME review 2026-10-27 M3): a variable no longer turns off the pattern
 * typed around it (`${show}/*.exr` is the files there), and its value's own characters are never a pattern. A whole
 * unquoted word `${name[@]}` is the value split at spaces, tabs and new lines, each piece one item (S10: lists); a
 * `${name}` with white space in it stays one item, and `notes` says how to split it.
 */
export function forWords(line: string, lookup: (name: string) => string | undefined, opts: ParseOptions): { words: ForWord[]; notes: string[] } | { error: string } {
  const words: ForWord[] = [];
  const notes: string[] = [];
  // loop: NOT-WORTH — a for loop's words (≤ 8 KiB)
  for (const w of tokenize(line, opts).words) {
    const src = line.slice(w.start, w.end);
    const list = LIST.exec(src);
    if (list) {
      const v = lookup(list[1]);
      if (v === undefined) return { error: `\${${list[1]}}: no such variable (set lists them; set ${list[1]}="a b c" makes a list)` };
      // loop: NOT-WORTH — one value's pieces
      for (const item of v.split(/\s+/).filter(Boolean)) words.push({ value: item, active: Array(item.length).fill(false) });
      continue;
    }
    const r = readWord(src, lookup, opts);
    if ("error" in r) return r;
    if (r.used && /\s/.test(r.value) && !/["']/.test(src)) {
      const name = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(src)?.[1];
      notes.push(`${src} is one item (a variable never splits)${name ? `: for s in \${${name}[@]} takes its words one by one` : ""}`);
    }
    words.push({ value: r.value, active: r.active });
  }
  return { words, notes };
}
