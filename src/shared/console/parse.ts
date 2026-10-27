// The Console's one tokenizer and parser (backlog row 95): the page's highlighting and completion and the main
// process's execution read a line the same way. Pure: no file system, no platform of its own (the caller says whether
// the line follows Windows' rules). Never a shell: no variables, globs, pipes or redirections; a word is a word.
//
// Words: separated by spaces or tabs. Quotes: '…' takes everything literally; "…" too, except (Linux, macOS) \" and \\.
// Backslash: on Linux and macOS it escapes the next character outside quotes (bash's rule); on Windows it is a
// path separator and always literal (cmd's rule), so C:\shots\sh010 needs no quoting. `--` ends the options; an
// unquoted `?` (or -h, --help, /?) asks for the command's help. Every token and error carries its source range
// (UTF-16 offsets, the page's string indices).
import { ANSWERS, assignmentAnswer, commandNames, MEANINGS, findCommand, fullName, suggest, type ConsoleArg, type ConsoleCommand, type Registry } from "./registry";

export interface ParseOptions {
  /** Windows' rules: backslash literal */
  windows: boolean;
}

export interface Word {
  /** the word after quotes and escapes */
  value: string;
  /** source range: [start, end) */
  start: number;
  end: number;
  /** any part of it quoted or escaped (never a flag, `?` or `--` then) */
  quoted: boolean;
}

export interface ParseError {
  message: string;
  start: number;
  end: number;
}

export type TokenKind = "command" | "subcommand" | "flag" | "value" | "path" | "string" | "error";

export interface Token {
  kind: TokenKind;
  start: number;
  end: number;
  /** the argument this token is (or is the value of) */
  arg?: ConsoleArg;
  /** set on an error token */
  error?: string;
}

export interface ParsedOption {
  arg: ConsoleArg;
  /** the flag as typed (--output, -o) */
  name: string;
  /** null for a switch, or a value that is missing (an error says so) */
  value: string | null;
  word: number;
}

export interface ParsedPositional {
  arg: ConsoleArg;
  value: string;
  word: number;
}

export interface Parsed {
  words: Word[];
  tokens: Token[];
  errors: ParseError[];
  /** `sudo <command>` */
  sudo: boolean;
  command: ConsoleCommand | null;
  help: boolean;
  options: ParsedOption[];
  positionals: ParsedPositional[];
  /** the flag whose value the line ends without (completion offers its values) */
  expecting: ConsoleArg | null;
  /** `corridorkey --version`, `render --version` / `-V`: the version (as the CLI prints it) */
  version: boolean;
}

const SPACE = /[ \t\r\n]/;

/** Split a line into words. An unterminated quote is an error; its word runs to the end of the line. */
export function tokenize(line: string, opts: ParseOptions): { words: Word[]; error: ParseError | null } {
  const words: Word[] = [];
  let error: ParseError | null = null;
  let i = 0;
  // loop: HOT-PATH-OK — one pass over a typed line (≤ 8 KiB), per keystroke in the page
  while (i < line.length) {
    if (SPACE.test(line[i])) {
      i++;
      continue;
    }
    const start = i;
    let value = "";
    let quoted = false;
    // loop: HOT-PATH-OK — the characters of one word
    while (i < line.length && !SPACE.test(line[i])) {
      const c = line[i];
      if (c === "'" || c === '"') {
        quoted = true;
        const close = c;
        const qStart = i++;
        let closed = false;
        // loop: HOT-PATH-OK — the characters inside one quote
        while (i < line.length) {
          const d = line[i];
          if (d === close) {
            closed = true;
            i++;
            break;
          }
          if (close === '"' && d === "\\" && !opts.windows && (line[i + 1] === '"' || line[i + 1] === "\\")) {
            value += line[i + 1];
            i += 2;
            continue;
          }
          value += d;
          i++;
        }
        if (!closed && !error) error = { message: `unterminated ${close} quote (close it with ${close})`, start: qStart, end: line.length };
        continue;
      }
      if (c === "\\" && !opts.windows && i + 1 < line.length) {
        quoted = true;
        value += line[i + 1];
        i += 2;
        continue;
      }
      value += c;
      i++;
    }
    words.push({ value, start, end: i, quoted });
  }
  return { words, error };
}

/** A word as it must be typed to mean `value` (Tab completion inserts this). */
export function quoteArg(value: string, opts: ParseOptions): string {
  const plain = opts.windows ? /^[\p{L}\p{N}_\-.,/\\:@%+=~#]+$/u : /^[\p{L}\p{N}_\-.,/:@%+=~#]+$/u;
  if (value !== "" && plain.test(value) && value !== "?" && value !== "--") return value;
  if (opts.windows) return value.includes('"') ? `'${value}'` : `"${value}"`;
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

/** A value-taking flag's next word is its value unless it looks like a flag (-0.5 is a value). */
const looksLikeFlag = (w: Word) => !w.quoted && /^-[^\d.]/.test(w.value);
const isHelp = (w: Word) => !w.quoted && ["?", "-h", "--help", "/?"].includes(w.value);
const isVersion = (w: Word) => !w.quoted && (w.value === "--version" || w.value === "-V");
const FRAMES = /^\d+(-\d+([x:]\d+)?)?([, ]+\d+(-\d+([x:]\d+)?)?)*$/;

/** An enum's value as the CLI spells it (any case typed), or null when it isn't one. */
export function enumValue(arg: ConsoleArg, v: string): string | null {
  // loop: HOT-PATH-OK — an enum's few values, per value typed
  return arg.values.find((x) => x.toLowerCase() === v.toLowerCase()) ?? null;
}

/** What is wrong with a flag's value, or null. */
export function valueProblem(arg: ConsoleArg, v: string): string | null {
  const name = arg.long ? `--${arg.long}` : arg.short ? `-${arg.short}` : (arg.dos[0] ?? arg.valueName ?? arg.id);
  // any case (EXR is exr: the Console passes the CLI's own spelling)
  if (arg.kind === "enum" && enumValue(arg, v) === null) {
    // a word with the same meaning first (gpu means auto, not cpu), else the closest spelling
    const s = MEANINGS[arg.id]?.[v.toLowerCase()] ?? suggest(v, arg.values);
    return `${name} takes ${arg.values.join(", ")}, not '${v}'${s ? ` (did you mean ${s}?)` : ""}`;
  }
  if (arg.kind === "number") {
    const n = Number(v);
    if (v.trim() === "" || !Number.isFinite(n)) return `${name} takes a number, not '${v}'`;
    if (arg.integer && (!Number.isInteger(n) || n < 0)) return `${name} takes a whole number, not '${v}'`;
    if (arg.range && (n < arg.range[0] || n > arg.range[1])) return `${name} must be between ${arg.range[0]} and ${arg.range[1]}, got ${v}`;
  }
  if (arg.kind === "frames" && !FRAMES.test(v.trim())) return `${name} takes frames like 1001-1100, 1001-1100x2 or 1001,1005, not '${v}'`;
  if ((arg.kind === "path" || arg.kind === "string") && v === "") return `${name} needs a value, not an empty one`;
  return null;
}

const valueKind = (a: ConsoleArg): TokenKind => (a.kind === "path" ? "path" : a.kind === "command" ? "command" : a.kind === "string" ? "string" : "value");
const flagName = (a: ConsoleArg) => (a.long ? `--${a.long}` : a.short ? `-${a.short}` : (a.dos[0] ?? a.id));

/** Parse a line against the registry. Never throws: every problem is an error with its range. */
export function parse(line: string, reg: Registry, opts: ParseOptions): Parsed {
  const { words, error } = tokenize(line, opts);
  const out: Parsed = { words, tokens: [], errors: error ? [error] : [], sudo: false, command: null, help: false, options: [], positionals: [], expecting: null, version: false };
  const fail = (message: string, start: number, end: number, arg?: ConsoleArg) => {
    out.errors.push({ message, start, end });
    out.tokens.push({ kind: "error", start, end, arg, error: message });
  };
  if (!words.length) return out;
  let i = 0;
  // `sudo <command>`: the prefix, then the command as usual; `sudo -k` and `sudo ?` are sudo's own
  if (!words[0].quoted && words[0].value === "sudo" && words[1] && !(words[1].value === "-k" || isHelp(words[1]))) {
    out.sudo = true;
    out.tokens.push({ kind: "command", start: words[0].start, end: words[0].end });
    i = 1;
  }
  const first = words[i];
  let cmd = first.quoted ? null : findCommand(reg, first.value);
  const answer = first.quoted ? undefined : (ANSWERS[first.value.toLowerCase()] ?? assignmentAnswer(first.value) ?? undefined);
  if (!cmd && answer) {
    fail(answer, first.start, first.end);
    // loop: HOT-PATH-OK — the rest of the line's words, per keystroke
    for (const w of words.slice(i + 1)) out.tokens.push({ kind: "string", start: w.start, end: w.end });
    return out;
  }
  if (!cmd) {
    const s = suggest(first.value, commandNames(reg));
    fail(`unknown command '${first.value}'${s ? ` (did you mean ${s}?)` : ""}; help lists the commands`, first.start, first.end);
    // loop: HOT-PATH-OK — the rest of the line's words, per keystroke
    for (const w of words.slice(i + 1)) out.tokens.push({ kind: "string", start: w.start, end: w.end });
    return out;
  }
  out.tokens.push({ kind: "command", start: first.start, end: first.end });
  i++;
  if (cmd.subcommands.length) {
    const w = words[i];
    if (!w || isHelp(w) || (!w.quoted && w.value === "help")) {
      out.command = cmd;
      out.help = true;
      if (w) out.tokens.push({ kind: "flag", start: w.start, end: w.end });
      // `corridorkey help render`: render's help
      // loop: NOT-WORTH — four subcommands
      const sub = w && words[i + 1] && cmd.subcommands.find((c) => c.name === words[i + 1].value);
      if (sub) {
        out.command = sub;
        out.tokens.push({ kind: "subcommand", start: words[i + 1].start, end: words[i + 1].end });
      }
      return out;
    }
    if (isVersion(w)) {
      out.command = cmd;
      out.version = true;
      out.tokens.push({ kind: "flag", start: w.start, end: w.end });
      return out;
    }
    // loop: NOT-WORTH — four subcommands
    const sub = w.quoted ? undefined : cmd.subcommands.find((c) => c.name === w.value);
    if (!sub) {
      // loop: NOT-WORTH — four subcommands
      const s = suggest(
        w.value,
        cmd.subcommands.map((c) => c.name),
      );
      fail(`${cmd.name} has no command '${w.value}'${s ? ` (did you mean ${s}?)` : ""}`, w.start, w.end);
      return out;
    }
    out.tokens.push({ kind: "subcommand", start: w.start, end: w.end });
    cmd = sub;
    i++;
  }
  out.command = cmd;
  // loop: HOT-PATH-OK — a command's ~50 arguments, once per parse
  const positional = cmd.args.filter((a) => a.positional);
  let nextPositional = 0;
  let endOfOptions = false;
  const seen = new Set<string>();
  // loop: HOT-PATH-OK — the line's words, per keystroke (a line is ≤ 8 KiB)
  while (i < words.length) {
    const w = words[i];
    const at = i++;
    if (!endOfOptions && isHelp(w)) {
      out.help = true;
      out.tokens.push({ kind: "flag", start: w.start, end: w.end });
      continue;
    }
    if (!endOfOptions && cmd.kind === "cli" && isVersion(w)) {
      out.version = true;
      out.tokens.push({ kind: "flag", start: w.start, end: w.end });
      continue;
    }
    if (!endOfOptions && !w.quoted && w.value === "--") {
      endOfOptions = true;
      out.tokens.push({ kind: "flag", start: w.start, end: w.end });
      continue;
    }
    // dir's DOS switches (/w, /b, /a, /o:d), on every system; a path that only starts like one stays a path
    const dos = endOfOptions || w.quoted ? null : /^(\/[a-z])(:?-?[a-z])?$/i.exec(w.value);
    // loop: HOT-PATH-OK — a command's few arguments, per word starting with /
    const dosArg = dos && cmd.args.find((a) => a.dos.includes(dos[1].toLowerCase()) && (a.kind === "switch" ? !dos[2] : true));
    if (dos && dosArg) {
      const value = dosArg.kind === "switch" ? null : (dos[2] ?? "n").replace(/^:/, "").toLowerCase();
      out.options.push({ arg: dosArg, name: dos[1].toLowerCase(), value, word: at });
      const problem = value === null ? null : valueProblem(dosArg, value);
      if (problem) fail(problem, w.start, w.end, dosArg);
      else out.tokens.push({ kind: "flag", start: w.start, end: w.end, arg: dosArg });
      continue;
    }
    const isLong = !endOfOptions && !w.quoted && w.value.startsWith("--");
    // -1 (ls's names only) is a flag where the command has it; elsewhere -0.5 is a value
    // loop: HOT-PATH-OK — a command's few arguments, per word
    const digitFlag = !w.quoted && /^-\d/.test(w.value) && cmd.args.some((a) => a.short === w.value[1]);
    const isShort = !endOfOptions && !isLong && (looksLikeFlag(w) || digitFlag) && !w.value.startsWith("--");
    if (isLong || isShort) {
      let name: string;
      let inline: string | null = null;
      let arg: ConsoleArg | undefined;
      if (isLong) {
        const eq = w.value.indexOf("=");
        name = eq < 0 ? w.value : w.value.slice(0, eq);
        inline = eq < 0 ? null : w.value.slice(eq + 1);
        // loop: HOT-PATH-OK — a command's ~50 flags, per flag word
        arg = cmd.args.find((a) => a.long === name.slice(2));
      } else {
        name = w.value.slice(0, 2);
        // loop: HOT-PATH-OK — as above
        arg = cmd.args.find((a) => a.short === w.value[1]);
        const rest = w.value.slice(2);
        if (arg && arg.kind !== "switch" && rest) inline = rest.startsWith("=") ? rest.slice(1) : rest;
        else if (arg && rest) {
          // -qv: several switches in one word
          // loop: HOT-PATH-OK — a few letters
          const more = [...rest].map((c) => cmd!.args.find((a) => a.short === c));
          // loop: HOT-PATH-OK — as above
          if (more.some((a) => !a || a.kind !== "switch")) {
            fail(`'${w.value}': only switches combine in one word (-qv); give a value-taking flag on its own`, w.start, w.end);
            continue;
          }
          out.tokens.push({ kind: "flag", start: w.start, end: w.end, arg });
          // loop: HOT-PATH-OK — as above
          for (const a of [arg, ...(more as ConsoleArg[])]) out.options.push({ arg: a, name: `-${a.short}`, value: null, word: at });
          continue;
        }
      }
      const flagEnd = inline === null ? w.end : w.start + name.length;
      if (!arg) {
        // loop: HOT-PATH-OK — the command's flag names, once per unknown flag
        const names = cmd.args.filter((a) => !a.positional && !a.refused).flatMap((a) => [a.long ? `--${a.long}` : null, a.short ? `-${a.short}` : null].filter((n): n is string => !!n));
        const s = suggest(name, names);
        fail(`${fullName(reg, cmd)} has no option ${name}${s ? ` (did you mean ${s}?)` : ""}`, w.start, flagEnd);
        // the flag it is likely a typo of takes a value: the next word is that value (one mistake, one error)
        // loop: HOT-PATH-OK — a command's ~50 flags, once per unknown flag
        const meant = s && cmd.args.find((a) => `--${a.long}` === s || `-${a.short}` === s);
        if (meant && meant.kind !== "switch" && inline === null && words[i] && !looksLikeFlag(words[i]) && !isHelp(words[i])) i++;
        continue;
      }
      const refusal = arg.refused ? `${flagName(arg)}: ${arg.refused}` : seen.has(arg.id) && !arg.multiple ? `${flagName(arg)} is given twice` : null;
      if (refusal) {
        fail(refusal, w.start, flagEnd, arg);
        // its value goes with it (never read as an argument of its own)
        if (arg.kind !== "switch" && inline === null && words[i] && !looksLikeFlag(words[i]) && !isHelp(words[i])) i++;
        continue;
      }
      seen.add(arg.id);
      out.tokens.push({ kind: "flag", start: w.start, end: flagEnd, arg });
      if (arg.kind === "switch") {
        if (inline !== null) fail(`${flagName(arg)} takes no value`, flagEnd, w.end, arg);
        out.options.push({ arg, name, value: null, word: at });
        continue;
      }
      let value: string | null = inline;
      let vStart = flagEnd + 1;
      let vEnd = w.end;
      if (value === null) {
        const next = words[i];
        if (!next || looksLikeFlag(next) || isHelp(next)) {
          if (!next) out.expecting = arg;
          fail(`${flagName(arg)} needs a value (${arg.valueName ?? "VALUE"})`, w.start, w.end, arg);
          out.options.push({ arg, name, value: null, word: at });
          continue;
        }
        value = next.value;
        [vStart, vEnd] = [next.start, next.end];
        i++;
      } else if (!isLong) vStart = w.start + 2 + (w.value[2] === "=" ? 1 : 0);
      out.options.push({ arg, name, value, word: at });
      const problem = valueProblem(arg, value);
      if (problem) fail(problem, vStart, vEnd, arg);
      else out.tokens.push({ kind: valueKind(arg), start: vStart, end: vEnd, arg });
      continue;
    }
    const arg = positional[nextPositional];
    if (!arg) {
      fail(`${fullName(reg, cmd)} takes no ${positional.length ? "more " : ""}arguments here: '${w.value}'`, w.start, w.end);
      continue;
    }
    if (!arg.multiple) nextPositional++;
    // watch's command: the rest of the line is its words, its flags too
    if (arg.rest) endOfOptions = true;
    out.positionals.push({ arg, value: w.value, word: at });
    const problem = valueProblem(arg, w.value);
    if (problem) fail(problem, w.start, w.end, arg);
    else out.tokens.push({ kind: valueKind(arg), start: w.start, end: w.end, arg });
  }
  if (!out.help) {
    // the CLI's conflicts (-F with -s/-e, -q with -v, --overwrite with --skip-existing, -i with INPUT): the later one is marked
    // loop: HOT-PATH-OK — the line's few arguments, in the order typed, per keystroke
    const given = [...out.options.map((o) => ({ arg: o.arg, name: o.name, word: o.word })), ...out.positionals.map((x) => ({ arg: x.arg, name: x.arg.valueName ?? x.arg.id, word: x.word }))].sort(
      (a, b) => a.word - b.word,
    );
    // loop: HOT-PATH-OK — as above
    for (const [n, g] of given.entries()) {
      // loop: HOT-PATH-OK — as above
      const e = given.slice(0, n).find((x) => x.arg !== g.arg && (g.arg.conflicts.includes(x.arg.id) || x.arg.conflicts.includes(g.arg.id)));
      if (e) fail(`${g.name} can't be used with ${e.name} (one or the other)`, words[g.word].start, words[g.word].end, g.arg);
    }
  }
  if (!out.help && cmd.name === "sudo" && cmd.kind === "builtin" && !out.options.length)
    fail("sudo needs a command (sudo render … --overwrite), or -k to drop the elevation", line.length, line.length);
  if (!out.help && !out.version) {
    // loop: NOT-WORTH — a command's few positionals
    for (const a of positional) {
      // loop: NOT-WORTH — the line's positionals
      if (a.required && !out.positionals.some((p) => p.arg === a)) fail(`${fullName(reg, cmd)} needs ${a.valueName ?? a.id}`, line.length, line.length, a);
    }
  }
  // loop: NOT-WORTH — sorts the line's tokens by position
  out.tokens.sort((a, b) => a.start - b.start);
  return out;
}
