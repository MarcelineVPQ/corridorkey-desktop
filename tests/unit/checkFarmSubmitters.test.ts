import { describe, expect, it } from "vitest";
import { checkAll, checkFile, cliFlags } from "../../tools/check_farm_submitters.mjs";

const CLI = cliFlags({
  commands: [
    { args: [{ long: "input", short: "i" }, { long: "max-vram" }, { long: "progress-format", possible_values: ["openjd", "deadline", "plain", "json"] }] },
    { args: [{ long: null }, { long: "report" }] },
  ],
});

describe("the farm submitter gate", () => {
  it("passes on this repository's farm/", () => {
    expect(checkAll()).toEqual([]);
  });

  it("(a) a flag the CLI doesn't have fails; the file's own options don't", () => {
    const py = 'ap.add_argument("-i", "--input", required=True)\nap.add_argument("--chunk", type=int)\ncmd = ["render", "--input", x, "--max-vram", "10"]\n';
    expect(checkFile("submit.py", py, CLI)).toEqual([]);
    const sh = 'case "$1" in\n  --gpus) g=$2 ;;\n  -h | --help) usage ;;\nesac\ncorridorkey render --report r.json -- --max-vram 8\n';
    expect(checkFile("farm.sh", sh, CLI)).toEqual([]);
    // a renamed flag left behind in a template (the CLI says --max-vram)
    expect(checkFile("template.yaml", "args:\n  - --vram-limit\n  - '10'\n", CLI)).toEqual([expect.stringContaining("--vram-limit is neither")]);
  });

  it("(b) a --progress-format value the CLI doesn't take fails", () => {
    expect(checkFile("a.py", '"--progress-format", "plain"', CLI)).toEqual([]);
    expect(checkFile("t.yaml", "  - --progress-format\n  - openjd\n", CLI)).toEqual([]);
    expect(checkFile("a.js", '["--progress-format", "text"]', CLI)).toEqual([expect.stringContaining("--progress-format text")]);
  });

  it("(c) a quoted short flag the CLI doesn't have fails; the file's own don't", () => {
    expect(checkFile("submit.py", 'ap.add_argument("-n", "--name")\ncmd = ["render", "-i", x]\n', CLI)).toEqual([]);
    // -r isn't the CLI's (a Deadline plugin passing it would fail every task)
    expect(checkFile("plugin.py", 'args = ["render", "-i", a, "-r", b]\n', CLI)).toEqual([expect.stringContaining("-r is neither")]);
  });

  // release review 2026-10-28 #13: one flag set over every command let `prepare --frames` pass
  it("(d) a flag only another command takes fails where the file starts that command's arguments", () => {
    const named = cliFlags({
      commands: [
        { name: "render", args: [{ long: "frames", short: "F" }, { long: "report" }] },
        { name: "prepare", args: [{ long: "report" }, { long: "tensorrt-size" }] },
        { name: "run", hidden: true, args: [{ long: "keep-going" }] },
      ],
    });
    expect(checkFile("a.py", 'cmd = [ck, "render", "--frames", f, "-F", g]\nprep = [ck, "prepare", "--tensorrt-size", s]\n', named)).toEqual([]);
    expect(checkFile("a.py", 'prep = [ck, "prepare", "--frames", f, "--report", r]\n', named)).toEqual(["a.py:1: prepare is given --frames, which `corridorkey prepare` doesn't take (cliSpec.json)"]);
    expect(checkFile("a.js", '["prepare"].concat(common, ["-F", x])', named)).toEqual([expect.stringContaining("prepare is given -F")]);
    expect(checkFile("farm.sh", "args=(prepare --frames 1-2)\ncorridorkey render --tensorrt-size 1080\n", named)).toHaveLength(2);
    // a YAML list: the items under `- prepare` at its indent, up to the next key
    const yaml = "args:\n  - prepare\n  - --report\n  - r.json\n  - --frames\nother:\n  - --frames\n";
    expect(checkFile("t.yaml", yaml, named)).toEqual([expect.stringContaining("t.yaml:2: prepare is given --frames")]);
    // a hidden command's name is ordinary text ("run")
    expect(checkFile("a.py", '"run", "--frames"', named)).toEqual([]);
  });
});
