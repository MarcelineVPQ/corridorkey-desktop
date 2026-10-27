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
  checkTroubleshooting,
  diffPublished,
  engineMessages,
  exitCodes,
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
