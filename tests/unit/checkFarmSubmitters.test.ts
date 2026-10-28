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
});
