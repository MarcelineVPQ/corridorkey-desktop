// The command line's parity gate (tools/check_cli_parity.mjs): each rule fails on a small fixture, and this
// repository passes. The behaviour (a job's line gives the engine the app's request) is in jobCommand.test.ts and
// farmExport.test.ts.
import { describe, expect, it } from "vitest";
import { appFields, checkAll, checkParity, cliTable, engineFields, writerFlags, type Manifest } from "../../tools/check_cli_parity.mjs";
import type { CliSpecIn } from "../../tools/check_wiki.mjs";

// a tiny engine (input, hint_quality, carry_hint, seed), its CLI and its app
const JOB_RS = [
  'let input = s("input").ok_or_else(|| x)?;',
  'hint_quality: unit(o, "hint_quality", 0.95)?,',
  'let manual = o.contains_key("carry_hint");',
  'seed: whole(o, "seed")?.unwrap_or(0),',
  "#[cfg(test)]",
  'mod tests { fn t() { unit(o, "only_in_a_test", 1.0); } }',
].join("\n");
const ARGS_RS = [
  "pub const RUN_OPTIONS: [(&str, &str, Kind, &str, &str); 2] = [",
  '    ("hint-quality", "hint_quality", Kind::Number, "0-1", "trust"),',
  '    ("no-carry-hint", "carry_hint", Kind::Off, "", "don\'t carry"),',
  "];",
  'pub const OTHER_OPTIONS: [(&str, &str); 1] = [("input", "--input")];',
  "",
].join("\n");
const arg = (long: string) => ({ long, short: null });
const SPEC: CliSpecIn = {
  commands: [
    { name: "render", args: [{ long: null, short: null, positional: true }, arg("input"), arg("hint-quality"), arg("no-carry-hint"), arg("quiet"), { long: "secret", short: null, hidden: true }] },
    { name: "verify", args: [arg("input"), arg("hint-quality"), arg("no-carry-hint"), arg("quiet")] },
    { name: "info", args: [arg("json")] },
  ],
};
const MANIFEST: Manifest = {
  fields: {
    input: { flags: ["--input"] },
    hint_quality: { flags: ["--hint-quality"] },
    carry_hint: { flags: ["--no-carry-hint"] },
    seed: { "not-on-cli": "a preview's sample" },
  },
  "cli-only": { "--quiet": "how much it prints" },
};
const QUEUE_TS =
  "export function engineOptions(o: JobOptions): Record<string, unknown> {\n  const out = {\n    hint_quality: o.hintQuality,\n  };\n  if (!o.carryHint) out.carry_hint = false;\n  return out;\n}\n";
const JOB_COMMAND_TS = 'export function jobFlags(o: JobOptions): Flag[] {\n  num("hint-quality", o.hintQuality);\n  if (!o.carryHint) f.push(["no-carry-hint", null]);\n  return f;\n}\n';
const FARM_TS = 'import { flagWords, jobFlags, type Flag } from "../../../src/shared/console/jobCommand";\nconst farmFlags = (j) => jobFlags(j.options);\n';

const good = () => ({
  manifest: structuredClone(MANIFEST),
  engine: engineFields(JOB_RS),
  spec: structuredClone(SPEC),
  table: cliTable(ARGS_RS),
  app: appFields(QUEUE_TS),
  writer: writerFlags(JOB_COMMAND_TS),
  farmTs: FARM_TS,
});

describe("the command-line parity gate", () => {
  it("passes on this repository", () => {
    expect(checkAll()).toEqual([]);
  });

  it("reads the sources it checks", () => {
    expect(engineFields(JOB_RS)).toEqual(["input", "hint_quality", "carry_hint", "seed"]);
    expect(cliTable(ARGS_RS)).toEqual([
      ["--hint-quality", "hint_quality"],
      ["--no-carry-hint", "carry_hint"],
      ["--input", "input"],
    ]);
    expect(appFields(QUEUE_TS)).toEqual(["hint_quality", "carry_hint"]);
    expect([...writerFlags(JOB_COMMAND_TS)]).toEqual(["--hint-quality", "--no-carry-hint"]);
    expect(checkParity(good())).toEqual([]);
  });

  it("(a) an engine field without a verdict fails", () => {
    const g = good();
    g.engine.push("model_scale");
    expect(checkParity(g)).toEqual([expect.stringMatching(/^\(a\) the engine reads `model_scale` .* no verdict/)]);
  });

  it("(b) a manifest flag the CLI hasn't, a CLI flag the manifest hasn't, or a flag mapped to another field fails", () => {
    const g = good();
    g.manifest.fields!.seed = { flags: ["--seed"] };
    expect(checkParity(g)).toEqual([expect.stringMatching(/^\(b\) docs\/cli-parity.json: --seed \(for seed\) isn't a render flag/)]);
    const h = good();
    h.spec.commands[1].args.push(arg("report"));
    expect(checkParity(h)).toEqual([expect.stringMatching(/^\(b\) corridorkey render --report has no entry/)]);
    const k = good();
    k.manifest.fields!.hint_quality = { flags: ["--no-carry-hint"] };
    expect(checkParity(k)).toEqual(expect.arrayContaining([expect.stringMatching(/^\(b\) ck-cli args.rs maps --hint-quality to `hint_quality`/)]));
    const both = good();
    both.manifest["cli-only"]!["--input"] = "x";
    expect(checkParity(both)).toEqual([expect.stringMatching(/--input is both a field's flag and cli-only/)]);
  });

  it("(c) a field the app sends without a flag, not written by Copy as command, or a farm export with its own table fails", () => {
    const g = good();
    g.app.push("seed");
    expect(checkParity(g)).toEqual([expect.stringMatching(/^\(c\) the app sends `seed` .* no flag for it/)]);
    const h = good();
    h.writer = writerFlags(JOB_COMMAND_TS.replace('  if (!o.carryHint) f.push(["no-carry-hint", null]);\n', ""));
    expect(checkParity(h)).toEqual([expect.stringMatching(/^\(c\) the app sends `carry_hint` but Copy as command doesn't write --no-carry-hint/)]);
    const k = good();
    k.farmTs = "const farmFlags = (j) => [];\n";
    expect(checkParity(k)).toEqual([expect.stringMatching(/^\(c\) electron\/main\/console\/farm.ts doesn't take its flags from jobFlags/)]);
  });

  it("(d) a stale entry (its field or cli-only flag gone) or one without exactly one verdict fails", () => {
    const g = good();
    g.engine = g.engine.filter((f) => f !== "seed");
    expect(checkParity(g)).toEqual([expect.stringMatching(/^\(d\) docs\/cli-parity.json: `seed` isn't a field the engine reads/)]);
    const h = good();
    h.manifest["cli-only"]!["--verbose"] = "how much it prints";
    expect(checkParity(h)).toEqual([expect.stringMatching(/^\(d\) .* the cli-only --verbose isn't a render flag/)]);
    const k = good();
    k.manifest.fields!.seed = {};
    expect(checkParity(k)).toEqual([expect.stringMatching(/^\(d\) .* `seed` needs exactly one verdict/)]);
    k.manifest.fields!.seed = { "not-on-cli": "  " };
    expect(checkParity(k)).toEqual([expect.stringMatching(/`seed` needs exactly one verdict/)]);
  });
});
