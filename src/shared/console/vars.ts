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
    // the word's value, read as the tokenizer reads it, with ${name} filled in where it counts
    let value = "";
    let used = false;
    let quote: string | null = null;
    // loop: NOT-WORTH — one word's characters
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        if (c === quote) quote = null;
        else if (quote === '"' && c === "\\" && !opts.windows && (src[i + 1] === '"' || src[i + 1] === "\\")) value += src[++i];
        else if (quote === '"' && c === "$" && src[i + 1] === "{") {
          const r = take(src, i, lookup);
          if ("error" in r) return r;
          [value, i, used] = [value + r.value, r.end, true];
        } else value += c;
        continue;
      }
      if (c === "'" || c === '"') quote = c;
      else if (c === "\\" && !opts.windows && i + 1 < src.length) value += src[++i];
      else if (c === "$" && src[i + 1] === "{") {
        const r = take(src, i, lookup);
        if ("error" in r) return r;
        [value, i, used] = [value + r.value, r.end, true];
      } else value += c;
    }
    if (!used) continue;
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
  if (name === null || !VAR_NAME.test(name)) return { error: `${src}: a variable is \${name} (letters, digits, _); quote a literal \${ with '…'` };
  const v = lookup(name);
  if (v === undefined) return { error: `\${${name}}: no such variable (set lists them; set ${name}=value makes it)` };
  return { value: v, end: close };
}
