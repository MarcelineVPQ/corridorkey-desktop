// The Console's help text: `help`, `help <command>` / `<command> ?`, and `help -k <term>` / `apropos <term>`. Built from the registry, so it
// says exactly what the parser accepts.
import { EXIT_MEANINGS, fullName, type ConsoleArg, type ConsoleCommand, type Registry } from "../../../src/shared/console/registry";

const flagLabel = (a: ConsoleArg): string => {
  // loop: NOT-WORTH — two names
  const names = [a.short ? `-${a.short}` : null, a.long ? `--${a.long}` : null, ...a.dos].filter(Boolean).join(", ");
  return a.kind === "switch" ? names : `${names} ${a.valueName ?? "VALUE"}`;
};

const notes = (a: ConsoleArg): string => [a.destructive ? " (needs sudo)" : "", a.writes ? " (only into chosen folders)" : ""].join("");

/** `render [OPTIONS] [INPUT]` */
export function usage(reg: Registry, c: ConsoleCommand): string {
  // loop: NOT-WORTH — a command's few positionals
  const pos = c.args.filter((a) => a.positional).map((a) => (a.required ? (a.valueName ?? a.id) : `[${a.valueName ?? a.id}]`) + (a.multiple ? "…" : ""));
  // loop: NOT-WORTH — a command's flags
  const hasFlags = c.args.some((a) => !a.positional);
  // loop: NOT-WORTH — four subcommands, once per help
  if (c.subcommands.length) return `${c.name} <${c.subcommands.map((s) => s.name).join("|")}> [OPTIONS]`;
  // loop: NOT-WORTH — a few words
  return [fullName(reg, c), hasFlags ? "[OPTIONS]" : "", ...pos].filter(Boolean).join(" ");
}

/** `help` alone: every command, one line each. */
export function overview(reg: Registry): string[] {
  const row = (name: string, about: string) => `  ${name.padEnd(14)} ${about}`;
  const lines = ["Commands (help <command> or <command> ? for its options and examples; Tab completes):"];
  // loop: NOT-WORTH — a dozen commands
  for (const c of reg.commands) if (c !== reg.cli) lines.push(row([c.name, ...c.aliases].join(", "), c.about));
  lines.push("", `${reg.cli.name}: ${reg.cli.about}`, "Its commands also work on their own (render … is corridorkey render …):");
  // loop: NOT-WORTH — four subcommands
  for (const c of reg.cli.subcommands) lines.push(row(c.name, c.about + (c.gpu ? " (uses the graphics card)" : "")));
  return lines;
}

/** One command: usage, what it does, every option, examples. */
export function commandHelp(reg: Registry, c: ConsoleCommand): string[] {
  // loop: NOT-WORTH — four subcommands, once per help
  if (c === reg.cli) return [`usage: ${usage(reg, c)}`, c.about, "", ...reg.cli.subcommands.map((s) => `  ${s.name.padEnd(10)} ${s.about}`), "", "help <command> for each one's options."];
  const lines = [`usage: ${usage(reg, c)}`, c.about];
  // loop: NOT-WORTH — a command's ~50 arguments
  const args = c.args.filter((a) => !a.refused);
  if (args.length) lines.push("");
  // loop: NOT-WORTH — as above
  const width = Math.min(34, Math.max(...args.map((a) => (a.positional ? (a.valueName ?? a.id).length : flagLabel(a).length))));
  // loop: NOT-WORTH — as above
  for (const a of args) lines.push(`  ${(a.positional ? (a.valueName ?? a.id) : flagLabel(a)).padEnd(width)}  ${a.help}${notes(a)}`);
  // loop: NOT-WORTH — a few examples, once per help
  if (c.examples.length) lines.push("", "Examples:", ...c.examples.map((e) => `  ${e}`));
  return lines;
}

/** `help -k <term>` / `apropos <term>`: commands and options whose name or description has every word. */
export function findLines(reg: Registry, terms: string[]): string[] {
  // loop: NOT-WORTH — a few words
  const words = terms.map((t) => t.toLowerCase()).filter(Boolean);
  // loop: NOT-WORTH — a few words per text
  const has = (text: string) => words.every((w) => text.toLowerCase().includes(w));
  const out: string[] = [];
  // loop: NOT-WORTH — a dozen commands and their ~50 flags, once per search
  for (const c of [...reg.commands, ...reg.cli.subcommands]) {
    const name = fullName(reg, c);
    if (has(`${name} ${c.aliases.join(" ")} ${c.about}`)) out.push(`  ${name.padEnd(20)} ${c.about}`);
    // loop: NOT-WORTH — as above
    for (const a of c.args) if (!a.refused && !a.positional && has(`${a.long ?? ""} ${a.short ?? ""} ${a.help}`)) out.push(`  ${`${name} ${flagLabel(a)}`.padEnd(20)} ${a.help}${notes(a)}`);
  }
  return out.length ? out : [`Nothing matches ${terms.join(" ")}. help lists every command.`];
}

/** What a built-in's block ends with, as ${status} reads it (runner.ts statusOf). */
const BUILTIN_STATUS: [string, string][] = [
  ["0", "done"],
  ["1", "failed (the block says why)"],
  ["2", "refused: a mistake in the line, or a check said no; nothing ran"],
  ["130", "stopped (Ctrl+C)"],
];

/**
 * `man <command>` (SME review 2026-10-26: man pages, backlog row 130): the long form of `help <command>`, built from
 * the same registry (the CLI's own spec for corridorkey's commands), so it can't drift from what the parser takes:
 * NAME, SYNOPSIS, every option in full (its values, limits, what it writes, what it can't be used with), EXAMPLES,
 * EXIT STATUS, SEE ALSO.
 */
export function manPage(reg: Registry, c: ConsoleCommand): string[] {
  const name = fullName(reg, c);
  if (c === reg.cli)
    return [
      "NAME",
      `    ${c.name} - ${c.about}`,
      "",
      "SYNOPSIS",
      `    ${usage(reg, c)}`,
      "",
      "COMMANDS",
      // loop: NOT-WORTH — four subcommands
      ...c.subcommands.map((s) => `    ${s.name.padEnd(10)} ${s.about}${s.gpu ? " (uses the graphics card)" : ""}`),
      "",
      "SEE ALSO",
      // loop: NOT-WORTH — as above
      `    ${c.subcommands.map((s) => `man ${s.name}`).join(", ")}`,
    ];
  const lines = ["NAME", `    ${name} - ${c.about}`];
  if (c.aliases.length) lines.push(`    (also: ${c.aliases.join(", ")})`);
  lines.push("", "SYNOPSIS", `    ${usage(reg, c)}`);
  // loop: NOT-WORTH — a command's ~50 arguments
  const args = c.args.filter((a) => !a.refused);
  // loop: NOT-WORTH — as above
  const pos = args.filter((a) => a.positional);
  // loop: NOT-WORTH — as above
  const flags = args.filter((a) => !a.positional);
  if (pos.length) lines.push("", "ARGUMENTS");
  // loop: NOT-WORTH — a command's few positionals
  for (const a of pos) lines.push(`    ${a.valueName ?? a.id}`, `        ${a.help}`, ...details(c, a));
  if (flags.length) lines.push("", "OPTIONS");
  // loop: NOT-WORTH — a command's ~50 flags
  for (const a of flags) lines.push(`    ${flagLabel(a)}`, `        ${a.help}`, ...details(c, a));
  // loop: NOT-WORTH — the refused flags (the Console's own)
  const refused = c.args.filter((a) => a.refused);
  // loop: NOT-WORTH — as above
  if (refused.length) lines.push("", "NOT IN THE CONSOLE", ...refused.map((a) => `    ${flagLabel(a)}: ${a.refused}`));
  // loop: NOT-WORTH — a few examples
  if (c.examples.length) lines.push("", "EXAMPLES", ...c.examples.map((e) => `    ${e}`));
  lines.push("", "EXIT STATUS");
  // loop: NOT-WORTH — a dozen codes
  if (c.kind === "cli") lines.push(...Object.entries(EXIT_MEANINGS).map(([k, v]) => `    ${k.padStart(3)}  ${v}`));
  // loop: NOT-WORTH — four codes
  else lines.push(...BUILTIN_STATUS.map(([k, v]) => `    ${k.padStart(3)}  ${v}`));
  lines.push("", "SEE ALSO", `    help ${c.name} (the short form), help -k <term>${c.kind === "cli" ? ", man corridorkey" : ""}`);
  return lines;
}

/** One argument's facts beyond its help: its values or limits, what it writes, what it can't go with. */
function details(c: ConsoleCommand, a: ConsoleArg): string[] {
  const out: string[] = [];
  if (a.kind === "enum") out.push(`one of: ${a.values.join(", ")}`);
  if (a.kind === "number") out.push(`${a.integer ? "a whole number" : "a number"}${a.range ? ` from ${a.range[0]} to ${a.range[1]}` : ""}`);
  if (a.kind === "frames") out.push("frames: 1001-1100, 1001-1100x2 (every 2nd), 1001,1005");
  if (a.kind === "path") out.push(a.folderOnly ? "a folder (Tab offers folders)" : "a path (Tab completes it; ~ and @bookmark work)");
  if (a.writes) out.push("written: only into the folders the Console may write to (allow <folder> adds one)");
  if (a.destructive) out.push("replaces files: runs only as sudo, after you confirm it");
  if (a.multiple) out.push("may be given more than once");
  if (a.required) out.push("required");
  // loop: NOT-WORTH — the argument's few conflicts
  const other = a.conflicts.map((id) => c.args.find((x) => x.id === id)).filter((x): x is ConsoleArg => !!x);
  // loop: NOT-WORTH — as above
  if (other.length) out.push(`not with: ${other.map((x) => (x.positional ? (x.valueName ?? x.id) : flagLabel(x))).join(", ")}`);
  // loop: NOT-WORTH — a few facts
  return out.map((l) => `        (${l})`);
}
