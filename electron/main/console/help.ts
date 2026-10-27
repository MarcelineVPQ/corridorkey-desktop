// The Console's help text: `help`, `help <command>` / `<command> ?`, and `help -k <term>` / `apropos <term>`. Built from the registry, so it
// says exactly what the parser accepts.
import { fullName, type ConsoleArg, type ConsoleCommand, type Registry } from "../../../src/shared/console/registry";

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
