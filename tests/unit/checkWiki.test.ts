import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  anchors,
  builtinNames,
  checkAll,
  checkCommandLine,
  checkConsole,
  checkLinks,
  checkRail,
  checkRunOptions,
  checkSettings,
  checkTroubleshooting,
  diffPublished,
  engineMessages,
  exitCodes,
  interfaceKeys,
  optionFlags,
  railLabels,
  runOptions,
  screenLabels,
  slug,
  type CliSpecIn,
} from "../../tools/check_wiki.mjs";

// A small CLI: render (with -o and --overwrite) and info (--json); --progress-format with two values.
const SPEC: CliSpecIn = {
  commands: [
    {
      name: "render",
      args: [
        { long: null, short: null, positional: true },
        { long: "output", short: "o" },
        { long: "overwrite", short: null },
        { long: "progress-format", short: null, possible_values: ["openjd", "json"] },
        { long: "secret", short: null, hidden: true },
      ],
    },
    { name: "info", args: [{ long: "json", short: null }] },
    { name: "__spec", hidden: true, args: [] },
  ],
};
const GOOD_CLI = [
  "# Command line",
  "| code | meaning |",
  "| --- | --- |",
  "| 0 | done |",
  "| 4 | output |",
  "Formats: `openjd`, `json`. Flags: `-o`, `--output`.",
  "```sh",
  "corridorkey render shot.mov -o out/ --overwrite --progress-format json",
  "corridorkey info --json",
  "```",
].join("\n");

describe("the wiki gate", () => {
  it("passes on this repository's docs/wiki/", () => {
    expect(checkAll()).toEqual([]);
  });

  it("(a) a CLI command without an example, a flag missing, or a flag no example uses fails", () => {
    expect(checkCommandLine(GOOD_CLI, SPEC, [0, 4])).toEqual([]);
    expect(checkCommandLine(GOOD_CLI.replace("corridorkey info --json", "info"), SPEC, [0, 4])).toEqual(
      expect.arrayContaining([expect.stringContaining("no example of `corridorkey info`"), expect.stringContaining("no example uses --json")]),
    );
    // --overwrite only in prose, not in an example
    const prose = GOOD_CLI.replace(" --overwrite", "") + "\nUse `--overwrite` to replace.";
    expect(checkCommandLine(prose, SPEC, [0, 4])).toEqual([expect.stringContaining("no example uses --overwrite")]);
    // the short form missing (the example uses --output only)
    const noShort = GOOD_CLI.replace("`-o`, ", "").replace("-o out/", "--output out/");
    expect(checkCommandLine(noShort, SPEC, [0, 4])).toEqual([expect.stringContaining("`corridorkey render -o` (--output) is missing")]);
    // a hidden flag or command is never required
    expect(checkCommandLine(GOOD_CLI, SPEC, [0, 4]).join()).not.toMatch(/secret|__spec/);
    expect(checkCommandLine(undefined, SPEC, [])).toEqual(["Command-Line.md is missing"]);
  });

  it("(b) an exit code without a table row fails", () => {
    expect(checkCommandLine(GOOD_CLI, SPEC, [0, 4, 9])).toEqual(["Command-Line.md: exit code 9 has no table row"]);
    expect(exitCodes("pub const DONE: i32 = 0;\n/// x\npub const SIGTERM: i32 = 143;\nconst X: i32 = 7;")).toEqual([0, 143]);
  });

  it("(c) a progress format missing fails", () => {
    expect(checkCommandLine(GOOD_CLI.replace("`json`", "json"), SPEC, [0, 4])).toEqual(["Command-Line.md: progress format `json` is missing"]);
  });

  it("(d) a Console built-in missing from Console.md fails", () => {
    const reg = 'const B = [\n  builtin(\n    "help",\n    "the commands",\n  ),\n  builtin("pwd", "print"),\n  builtin("doctor", "check"),\n];';
    expect(builtinNames(reg)).toEqual(["help", "pwd", "doctor"]);
    expect(checkConsole("`help` and `pwd` and `doctor --json`", builtinNames(reg))).toEqual([]);
    expect(checkConsole("`help` and pwd, `doctors`", builtinNames(reg))).toEqual(["Console.md: the built-in `pwd` is missing", "Console.md: the built-in `doctor` is missing"]);
  });

  it("(e) an engine message missing from Troubleshooting.md fails; internal and test messages aren't required", () => {
    const rs = [
      'fn a() -> Result<(), Error> { Err(Error::input(format!("This clip is too large ({w}x{h}): at most {MAX}.")))?; Ok(()) }',
      "fn b() { Error::new(ErrorCode::Output, format!(\"Can't write the job's temporary files: {why}\")); }",
      'fn c() { Error::input("id missing".into()); Error::engine(format!("EXR writer stopped: {}", d)); }',
      'fn d() { Error::input(format!(\n    "At this model scale the networks would run at {w}x{h}"\n)); }',
      'pub fn unavailable_reason(&self) -> String { match d { X => format!("--device coreml: none"), _ => "CorridorKey needs an NVIDIA graphics card with CUDA.".into() } }',
      '#[cfg(test)]\nmod tests { fn t() { Error::input("Only in a test".into()); } }',
    ].join("\n");
    const msgs = engineMessages([
      { path: "src/clip.rs", text: rs },
      { path: "src/pipeline/tests/x.rs", text: 'Error::input("A test file".into())' },
    ]);
    expect(msgs).toEqual([
      "At this model scale the networks would run at",
      "Can't write the job's temporary files:",
      "CorridorKey needs an NVIDIA graphics card with CUDA.",
      "This clip is too large (",
    ]);
    const page = "> This clip is too large (`<w>x<h>`)\n| At this model scale the networks\nwould run at `<w>x<h>` |\nCan't write the job's temporary files: x";
    expect(checkTroubleshooting(page, msgs)).toEqual(['Troubleshooting.md: the engine\'s message "CorridorKey needs an NVIDIA graphics card with CUDA.…" is missing']);
  });

  it("(f) a broken wiki link, anchor or repository link fails", () => {
    expect(slug("Step 2: ffmpeg for reading and writing video")).toBe("step-2-ffmpeg-for-reading-and-writing-video");
    expect(slug("Video outputs: lossless H.264, DNxHR 444 or H.264 CRF 12 (1.0)")).toBe("video-outputs-lossless-h264-dnxhr-444-or-h264-crf-12-10");
    expect([...anchors("# A\n```sh\n# not a heading\n```\n## A\n## Can't read")]).toEqual(["a", "a-1", "cant-read"]);
    const pages = {
      Home: "[ok](Hints) [ok](Hints#the-hint) [ok](#top) [web](https://example.com) [x](Nope) [y](Hints#nope) [z](#gone)\n# Top",
      Hints: "## The hint",
    };
    const repo = (p: string) => (p === "README.md" ? "## Speed\n" : null);
    const R = "https://github.com/MarcelineVPQ/corridorkey-desktop";
    pages.Hints += `\n[r](${R}/blob/main/README.md#speed) [r2](${R}/blob/main/README.md#slow) [r3](${R}/blob/main/docs/GONE.md) [w](${R}/wiki/Home#top) [w2](${R}/wiki/Gone)`;
    expect(checkLinks(pages, repo)).toEqual([
      "Home.md: link (Nope) names the wiki page Nope, which docs/wiki/ doesn't have",
      "Home.md: link (Hints#nope) has no heading #nope on Hints",
      "Home.md: link (#gone) has no heading #gone on Home",
      `Hints.md: link (${R}/blob/main/README.md#slow) has no heading #slow in README.md`,
      `Hints.md: link (${R}/blob/main/docs/GONE.md) names docs/GONE.md, which isn't in the repository`,
      `Hints.md: link (${R}/wiki/Gone) names the wiki page Gone, which docs/wiki/ doesn't have`,
    ]);
  });

  it("(g) a run option's flag missing from Command-Line.md, one without a flag nowhere (and not excepted), or a clip setting's label on no page fails", () => {
    const jobRs = 'hint_quality: unit(o, "hint_quality", 0.95)?, seed: whole(o, "seed")?, x: o.get("outputs"), y: num(o, "frame_dir_fps")\n#[cfg(test)]\nunit(o, "test_only", 1.0)';
    expect(runOptions(jobRs)).toEqual(["hint_quality", "seed", "outputs", "frame_dir_fps"]);
    const argsRs =
      '("hint-quality", "hint_quality", Kind::Number, "0-1", "trust"),\n("fps", "frame_dir_fps", Kind::Number, "FPS", "rate"),\npub const OTHER_OPTIONS: [(&str, &str); 1] = [("outputs", "--outputs")];';
    const flags = optionFlags(argsRs);
    expect([...flags]).toEqual([
      ["hint_quality", ["--hint-quality"]],
      ["frame_dir_fps", ["--fps"]],
      ["outputs", ["--outputs"]],
    ]);
    const tsx = '<Section id="hint" icon={Wand2} title="Hint" status={s}>\n<Row label="Hint trust" hint="x" htmlFor="hq">\n<Row label="">\n<Segmented label="Not a row" />\n<Row label={dynamic}>';
    expect(screenLabels(tsx)).toEqual(["Hint", "Hint trust"]);
    const pages = { "Command-Line": "`--hint-quality`, `--outputs`, `--fps`", Hints: "## Hint trust\nThe **hint**." };
    const opts = runOptions(jobRs);
    expect(checkRunOptions(pages, opts, flags, ["Hint", "Hint trust"], { seed: "a sample" })).toEqual([]);
    expect(checkRunOptions({ ...pages, "Command-Line": "`--hint-quality`, `--outputs`" }, opts, flags, [], { seed: "a sample" })).toEqual([
      "Command-Line.md: the run option `frame_dir_fps` (--fps) is missing",
    ]);
    expect(checkRunOptions(pages, opts, flags, [], {})).toEqual([expect.stringMatching(/^the run option `seed` \(ck-core job.rs\) has no flag and no wiki page names it/)]);
    // named on a page: fine without an exception; an exception for an option the engine dropped is stale
    expect(checkRunOptions({ ...pages, X: "`seed`" }, opts, flags, [], { gone: "x" })).toEqual(["WIKI_EXCEPTIONS (tools/check_wiki.mjs): `gone` isn't a run option any more: remove it"]);
    expect(checkRunOptions(pages, opts, flags, ["Despill"], { seed: "a sample" })).toEqual([expect.stringMatching(/^the clip setting "Despill" \(src\/ui\/JobSettings.tsx\) is on no wiki page/)]);
  });

  it("(h) an app setting without a row, with a label gone from the screen, or missing from its page fails", () => {
    const ts = "export interface Settings {\n  // where results go\n  outputRoot: string | null;\n  lastOptions: JobOptions;\n  cacheRoot?: string;\n}\nexport interface Other {\n  no: 1;\n}";
    expect(interfaceKeys(ts, "Settings")).toEqual(["outputRoot", "lastOptions", "cacheRoot"]);
    const table = { outputRoot: { label: "Where results go", page: "Home" }, lastOptions: { internal: "the last clip's settings" } };
    const pages = { Home: "Use **App settings → Results → Where results go**." };
    const ui = '<Row label="Where results go">';
    expect(checkSettings(pages, ["outputRoot", "lastOptions"], ui, table)).toEqual([]);
    expect(checkSettings(pages, ["outputRoot", "lastOptions", "cacheRoot"], ui, table)).toEqual([expect.stringMatching(/^the app setting `cacheRoot` has no row in SETTINGS/)]);
    expect(checkSettings({ Home: "nothing" }, ["outputRoot", "lastOptions"], ui, table)).toEqual(['Home.md: the app setting "Where results go" (`outputRoot`) is missing']);
    expect(checkSettings(pages, ["outputRoot", "lastOptions"], '<Row label="Results folder">', table)).toEqual([expect.stringMatching(/"Where results go" \(`outputRoot`\) isn't on screen any more/)]);
    expect(checkSettings(pages, ["outputRoot"], ui, table)).toEqual(["SETTINGS (tools/check_wiki.mjs): `lastOptions` isn't an app setting any more: remove it"]);
    expect(checkSettings(pages, ["outputRoot", "lastOptions"], ui, { ...table, outputRoot: { label: "Where results go", page: "Gone" } })).toEqual([
      "SETTINGS (tools/check_wiki.mjs): `outputRoot` names the wiki page Gone, which docs/wiki/ doesn't have",
    ]);
  });

  it("(i) a rail page without a wiki page or section fails", () => {
    const rail =
      'export const ITEMS: RailItem[] = [\n  { id: "queue", label: "Queue", tip: "x" },\n  { id: "settings", label: "App settings", tip: "y" },\n];\nconst other = { label: "Not an item" };';
    expect(railLabels(rail)).toEqual(["Queue", "App settings"]);
    expect(checkRail({ Home: "# Queue\n### **App Settings**" }, railLabels(rail))).toEqual([]);
    // a heading in a code fence or a mention in prose isn't a section
    expect(checkRail({ Home: "# Queue\n```\n# App settings\n```\nOpen App settings." }, railLabels(rail))).toEqual([
      'the rail page "App settings" (src/ui/rail/railModel.ts) has no wiki page or section (a heading "App settings")',
    ]);
  });

  it("--published: a page changed, added or removed is a difference; line ends aren't", () => {
    const d = mkdtempSync(join(tmpdir(), "ck-wiki-"));
    try {
      const [a, b] = [join(d, "src"), join(d, "pub")];
      mkdirSync(a);
      mkdirSync(join(b, ".git"), { recursive: true });
      writeFileSync(join(a, "Home.md"), "a\nb\n");
      writeFileSync(join(b, "Home.md"), "a\r\nb\r\n");
      writeFileSync(join(a, "Same.md"), "x");
      writeFileSync(join(b, "Same.md"), "x");
      expect(diffPublished(a, b)).toEqual([]);
      writeFileSync(join(a, "New.md"), "n");
      writeFileSync(join(b, "Old.md"), "o");
      writeFileSync(join(b, "Same.md"), "y");
      expect(diffPublished(a, b)).toEqual(["New.md: not published", "Old.md: only published", "Same.md: differs"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
