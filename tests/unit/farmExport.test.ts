// farm export's files (electron/main/console/farm.ts): each format's files parse as their farm reads them and carry the
// clip's frames, paths and flags. OpenJD: `openjd check` isn't installed here, so the bundle is checked structurally
// (js-yaml; the 2023-09 schema's parameter and format-string rules that matter here); the template itself passes
// `openjd check` (farm/README.md).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { farmExport, type FarmJob } from "../../electron/main/console/farm";
import { jobArgs } from "../../src/shared/console/jobCommand";
import { tokenize } from "../../src/shared/console/parse";
import { DEFAULT_OPTIONS, type JobOptions } from "../../src/shared/types";
import { engineOptions } from "../../electron/main/queue";
import { cliOptions, lineOf, REPRESENTATIVE, sameOptions } from "./cliOptions";

// js-yaml comes with the build tools (electron-builder); it has no types of its own
const yaml = (await import("js-yaml" as string)) as { load: (s: string) => unknown };

const env = { models: "/opt/ck/models", ort: "/opt/ck/libonnxruntime.so" };
const fj = (name: string, options: Partial<JobOptions> = {}, kind: "video" | "frames" = "video"): FarmJob => ({
  name,
  // a frame folder here is EXR plates
  clip: { path: kind === "video" ? `/shots/${name}.mov` : `/shots/${name}/plates`, kind, exrFrames: kind === "frames" },
  outputDir: `/renders/${name}`,
  options: { ...DEFAULT_OPTIONS, ...options },
  range: kind === "video" ? [1001, 1024] : [1001, 1100],
});
const sh010 = fj("sh010", { outputs: ["alpha"], despillStrength: 0.3, memory: { auto: false, hannChunk: 8, hannStride: 4, lowVram: true }, vramLimitGb: 10 });
const sh020 = fj("sh020", { frameDirLinear: true, outputFormat: "exr" }, "frames");
const file = (e: ReturnType<typeof farmExport>, path: string) => e.files.find((f) => f.path === path)?.text ?? "";
/** a shell line's words, as a POSIX shell reads them (the Console's tokenizer has the same quote rules) */
// loop: NOT-WORTH — a line's words
const words = (line: string) => tokenize(line, { windows: false }).words.map((w) => w.value);

describe("farm export", () => {
  it("openjd: a job bundle per clip; the template is 2023-09 with the clip's flags in its Key step, every value a parameter it defines", () => {
    const e = farmExport("openjd", [sh010, sh020], env);
    expect(e.files.map((f) => f.path)).toEqual(["sh010/template.yaml", "sh010/parameter_values.yaml", "sh020/template.yaml", "sh020/parameter_values.yaml"]);
    const t = yaml.load(file(e, "sh010/template.yaml")) as {
      specificationVersion: string;
      parameterDefinitions: { name: string }[];
      steps: { name: string; script: { actions: { onRun: { args: string[] } } } }[];
    };
    expect(t.specificationVersion).toBe("jobtemplate-2023-09");
    // loop: NOT-WORTH — the template's parameters
    const defined = new Set(t.parameterDefinitions.map((p) => p.name));
    const key = t.steps.find((s) => s.name === "Key")!.script.actions.onRun.args;
    expect(key.slice(key.indexOf("{{Param.Outputs}}") + 1, key.indexOf("--job"))).toEqual(["--despill", "0.3", "--window", "8/4", "--max-vram", "10"]);
    // every {{Param.X}} it uses is defined (a typo would fail openjd check)
    // loop: NOT-WORTH — the template's format strings
    for (const m of file(e, "sh010/template.yaml").matchAll(/\{\{Param\.(\w+)\}\}/g)) expect(defined, m[1]).toContain(m[1]);
    const v = yaml.load(file(e, "sh010/parameter_values.yaml")) as { parameterValues: { name: string; value: string }[] };
    // loop: NOT-WORTH — the values
    const values = Object.fromEntries(v.parameterValues.map((p) => [p.name, p.value]));
    // loop: NOT-WORTH — as above
    for (const n of Object.keys(values)) expect(defined).toContain(n);
    expect(values).toEqual({
      Input: "/shots/sh010.mov",
      OutputDir: "/renders/sh010",
      Outputs: "alpha",
      Linear: "null",
      ExistingFrames: "--overwrite",
      LowVram: "true",
      Models: "/opt/ck/models",
      OnnxRuntime: "/opt/ck/libonnxruntime.so",
    });
    expect((yaml.load(file(e, "sh020/parameter_values.yaml")) as typeof v).parameterValues.find((p) => p.name === "Linear")!.value).toBe("true");
    // the queue's video setting: the farm writes EXR, and says so
    expect(e.notes.join(" ")).toMatch(/sh010: set to video outputs .* the farm writes EXR/);
  });

  it("deadline: job info and plugin info as key=value, the whole shot in one task; the plugin beside them", () => {
    const e = farmExport("deadline", [sh010], env);
    const kv = (t: string) =>
      Object.fromEntries(
        t
          .trim()
          .split("\n")
          .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
      );
    expect(kv(file(e, "sh010_job_info.txt"))).toEqual({
      Plugin: "CorridorKey",
      Name: "sh010 key",
      BatchName: "corridorkey",
      Frames: "1001-1024",
      ChunkSize: "24",
      Priority: "50",
      OutputDirectory0: "/renders/sh010/sh010_alpha_exr",
      OutputFilename0: "sh010_alpha.####.exr",
    });
    const plugin = kv(file(e, "sh010_plugin_info.txt"));
    expect(plugin).toMatchObject({ Command: "render", InputPath: "/shots/sh010.mov", OutputPath: "/renders/sh010", Outputs: "alpha", MaxVram: "10" });
    expect(words(plugin.ExtraArguments)).toEqual(["--despill", "0.3", "--window", "8/4", "--low-vram"]);
    // the plugin's own file names (Deadline reads them by the plugin's name)
    expect(e.files.map((f) => f.path)).toContain("CorridorKey/CorridorKey.param");
  });

  it("opencue: the submit script's invocation, with the shot's range, the booking from the queue's limit, flags after --", () => {
    const e = farmExport("opencue", [sh010], env);
    const line = file(e, "sh010_opencue.sh")
      .split("\n")
      .find((l) => l.startsWith("exec "))!;
    const w = words(line);
    expect(w.slice(0, 2)).toEqual(["exec", "python3"]);
    const at = (f: string) => w[w.indexOf(f) + 1];
    expect([at("--shot"), at("-i"), at("-o"), at("--range"), at("--gpu-memory"), at("--max-vram"), at("--models")]).toEqual([
      "sh010",
      "/shots/sh010.mov",
      "/renders/sh010",
      "1001-1024",
      "10",
      "10",
      "/opt/ck/models",
    ]);
    expect(w.slice(w.indexOf("--") + 1)).toEqual(["--outputs", "alpha", "--despill", "0.3", "--window", "8/4", "--low-vram"]);
    expect(e.files.map((f) => f.path)).toContain("corridorkey_submit.py");
  });

  it("a clip whose frame range isn't known is left out of deadline and opencue, and said", () => {
    const e = farmExport("deadline", [{ ...sh010, range: null }], env);
    expect(e.files.filter((f) => f.path.endsWith(".txt"))).toEqual([]);
    expect(e.notes.join(" ")).toMatch(/sh010: not exported \(its frame range isn't known/);
  });

  it("flamenco: a job for the CorridorKey job type, its settings the type's own", () => {
    const e = farmExport("flamenco", [sh020], env);
    const job = JSON.parse(file(e, "sh020.flamenco.json")) as { type: string; settings: Record<string, unknown> };
    // loop: NOT-WORTH — the job type's settings
    const keys = [...readFileSync(new URL("../../farm/flamenco/corridorkey.js", import.meta.url), "utf8").matchAll(/\{ key: "(\w+)"|key: "(\w+)"/g)].map((m) => m[1] ?? m[2]);
    expect(job.type).toBe("corridorkey");
    expect(Object.keys(job.settings).sort()).toEqual([...new Set(keys)].sort());
    expect(job.settings).toMatchObject({ input: "/shots/sh020/plates", output: "/renders/sh020", outputs: "alpha,fg", linear: "scene-linear", frames: "", chunk_size: 0 });
  });

  it("shell: shot lists by their flags (tab-separated INPUT OUTPUT) and the lines that run them", () => {
    const e = farmExport("shell", [sh010, sh020, fj("sh030", { outputs: ["alpha"], despillStrength: 0.3, memory: { auto: false, hannChunk: 8, hannStride: 4, lowVram: true }, vramLimitGb: 10 })], env);
    expect(e.files.map((f) => f.path)).toEqual(["corridorkey-farm.sh", "shots-1.txt", "shots-2.txt", "run-shots.sh"]);
    // loop: NOT-WORTH — a few lines
    const shots = file(e, "shots-1.txt")
      .split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split("\t"));
    expect(shots).toEqual([
      ["/shots/sh010.mov", "/renders/sh010"],
      ["/shots/sh030.mov", "/renders/sh030"],
    ]);
    const run = file(e, "run-shots.sh")
      .split("\n")
      .filter((l) => l.startsWith("bash"));
    expect(run).toHaveLength(2);
    const w = words(run[0].replace(/ \|\| status=1$/, ""));
    expect(w.slice(w.indexOf("--") + 1)).toEqual([
      "--outputs",
      "alpha",
      "--despill",
      "0.3",
      "--window",
      "8/4",
      "--low-vram",
      "--max-vram",
      "10",
      "--models",
      "/opt/ck/models",
      "--ort",
      "/opt/ck/libonnxruntime.so",
    ]);
    expect(words(run[1])).toContain("--linear");
  });
});

// Marcy 2026-10-27 "make the CLI match the app": the CLI reads an EXR folder scene-linear by default, so every format
// says an EXR folder's choice both ways (the box off: --no-linear), and a PNG folder's only when it is on
describe("farm export: how a frame folder is read", () => {
  const exrOff = fj("sh021", { frameDirLinear: false }, "frames");
  const pngOff = { ...fj("sh022", { frameDirLinear: false }, "frames"), clip: { path: "/shots/sh022/plates", kind: "frames" as const, exrFrames: false } };
  const pngOn = { ...pngOff, name: "sh023", options: { ...pngOff.options, frameDirLinear: true } };
  const all = [sh010, sh020, exrOff, pngOff, pngOn];

  it("openjd: the Linear parameter (null: the CLI's own choice by the first frame)", () => {
    const e = farmExport("openjd", all, env);
    // loop: NOT-WORTH — five clips
    const linear = all.map(
      (j) => (yaml.load(file(e, `${j.name}/parameter_values.yaml`)) as { parameterValues: { name: string; value: string }[] }).parameterValues.find((p) => p.name === "Linear")!.value,
    );
    expect(linear).toEqual(["null", "true", "false", "null", "true"]);
    // never also a flag in the Key step
    expect(file(e, "sh021/template.yaml")).not.toMatch(/- "--(no-)?linear"/);
  });

  it("deadline, opencue, shell: --linear / --no-linear in the flags", () => {
    const flags = (j: FarmJob) => {
      // loop: NOT-WORTH — the formats' few lines
      const d = file(farmExport("deadline", [j], env), `${j.name}_plugin_info.txt`)
        .split("\n")
        .find((l) => l.startsWith("ExtraArguments="))!;
      const o = file(farmExport("opencue", [j], env), `${j.name}_opencue.sh`);
      const s = file(farmExport("shell", [j], env), "run-shots.sh");
      // loop: NOT-WORTH — three texts
      return [d, o, s].map((t) => (t.match(/--(no-)?linear\b/g) ?? []).join(" "));
    };
    expect(flags(sh020)).toEqual(["--linear", "--linear", "--linear"]);
    expect(flags(exrOff)).toEqual(["--no-linear", "--no-linear", "--no-linear"]);
    expect(flags(pngOff)).toEqual(["", "", ""]);
    expect(flags(pngOn)).toEqual(["--linear", "--linear", "--linear"]);
    expect(flags(sh010)).toEqual(["", "", ""]);
  });

  it("flamenco: the job type's linear setting, and the type writes the flag it names", () => {
    const e = farmExport("flamenco", all, env);
    // loop: NOT-WORTH — five clips
    const linear = all.map((j) => (JSON.parse(file(e, `${j.name}.flamenco.json`)) as { settings: { linear: string; extra_args: string } }).settings);
    expect(linear.map((s) => s.linear)).toEqual(["auto", "scene-linear", "display-coded", "auto", "scene-linear"]);
    // loop: NOT-WORTH — as above
    expect(linear.every((s) => !/--(no-)?linear/.test(s.extra_args))).toBe(true);
    // the job type compiled as the Manager compiles it (its author API and shellSplit faked): the render task's flag
    const type = readFileSync(new URL("../../farm/flamenco/corridorkey.js", import.meta.url), "utf8");
    const compileJob = new Function("author", "shellSplit", `${type}\nreturn compileJob;`)(
      {
        Task: () => ({
          args: [] as string[],
          addCommand(c: { args: string[] }) {
            this.args = c.args;
          },
          addDependency() {},
        }),
        Command: (_: string, c: unknown) => c,
      },
      (t: string) => t.split(" ").filter(Boolean),
    ) as (job: unknown) => void;
    const render = (settings: unknown) => {
      const tasks: { args: string[] }[] = [];
      compileJob({ settings, addTask: (t: { args: string[] }) => tasks.push(t) });
      // loop: NOT-WORTH — one task's words
      return tasks[0].args.filter((w) => /^--(no-)?linear$/.test(w));
    };
    // loop: NOT-WORTH — five clips
    expect(linear.map((s) => render(s))).toEqual([[], ["--linear"], ["--no-linear"], [], ["--linear"]]);
  });
});

// senior review 2026-10-27 M1 (probe P1): a clip, folder or flag value with a new line put its own lines into the farm
// files (the OpenCue script ran `touch PWNED`; Deadline's job info gained `Plugin=CommandLine`). Control characters are
// refused, with the clip and why; other hostile characters reach each farm exactly as they are.
describe("farm export: hostile names (review 2026-10-27 M1)", () => {
  const FORMATS = ["openjd", "deadline", "opencue", "flamenco", "shell"] as const;
  const hostile = (name: string): FarmJob => ({ ...fj("x"), name, clip: { path: `/shots/${name}.mov`, kind: "video", exrFrames: false } });

  it("refuses a control character in a clip's name, path, results folder, flag value or runtime path, in every format", () => {
    const cases: [string, FarmJob, typeof env][] = [
      ["new line (P1: OpenCue runs it)", hostile("x\ntouch PWNED\nx"), env],
      ["new line (P1: a Deadline key)", hostile("a\nPlugin=CommandLine\nb"), env],
      ["tab (a shot list's column)", hostile("a\tb"), env],
      ["NUL", hostile("a\u0000b"), env],
      ["carriage return", hostile("a\rb"), env],
      ["DEL", hostile("a\u007fb"), env],
      ["results folder", { ...fj("sh010"), outputDir: "/renders/a\nPlugin=CommandLine" }, env],
      ["a flag's value", fj("sh010", { hintMode: "video", hintVideo: "/hints/a\nb.mov" }), env],
      ["the models folder", fj("sh010"), { ...env, models: "/opt/ck\nmodels" }],
    ];
    // loop: NOT-WORTH — a test's few cases × five formats
    for (const [what, job, e] of cases)
      for (const f of FORMATS) {
        const x = farmExport(f, [job], e);
        expect(x.error, `${f}: ${what}`).toMatch(/control character .*rename/);
        expect(x.files, `${f}: ${what}`).toEqual([]);
      }
    // the proved lines are never written
    const p1 = farmExport("opencue", [hostile("x\ntouch PWNED\nx")], env);
    expect(p1.files.some((f) => /^touch PWNED$/m.test(f.text))).toBe(false);
    expect(farmExport("deadline", [hostile("a\nPlugin=CommandLine\nb")], env).files.some((f) => /^Plugin=CommandLine$/m.test(f.text))).toBe(false);
  });

  it("quotes, $, % and spaces reach each farm exactly as they are", () => {
    const name = `it's "a" $(touch P) %PATH% \`id\` x`;
    const j = hostile(name);
    const path = `/shots/${name}.mov`;
    const out = "/renders/x";
    const jj = { ...j, outputDir: "/renders/x" };
    // OpenJD: YAML values
    const o = farmExport("openjd", [jj], env);
    expect(o.error).toBeUndefined();
    const v = yaml.load(file(o, `${name}/parameter_values.yaml`)) as { parameterValues: { name: string; value: string }[] };
    expect(v.parameterValues.find((p) => p.name === "Input")!.value).toBe(path);
    // Deadline: one line per key, the value whole
    const d = farmExport("deadline", [jj], env);
    const plugin = file(d, `${name}_plugin_info.txt`).trim().split("\n");
    expect(plugin).toContain(`InputPath=${path}`);
    expect(plugin).toContain(`OutputPath=${out}`);
    // OpenCue: the script's words, as a POSIX shell reads them
    const c = farmExport("opencue", [jj], env);
    const w = words(
      file(c, `${name}_opencue.sh`)
        .split("\n")
        .find((l) => l.startsWith("exec "))!,
    );
    expect([w[w.indexOf("--shot") + 1], w[w.indexOf("-i") + 1], w[w.indexOf("-o") + 1]]).toEqual([name, path, out]);
    // Flamenco: JSON
    const fl = JSON.parse(file(farmExport("flamenco", [jj], env), `${name}.flamenco.json`)) as { settings: { input: string; output: string } };
    expect([fl.settings.input, fl.settings.output]).toEqual([path, out]);
    // shell: one INPUT<tab>OUTPUT row
    const rows = file(farmExport("shell", [jj], env), "shots.txt")
      .split("\n")
      .filter((l) => l && !l.startsWith("#"));
    expect(rows).toEqual([`${path}\t${out}`]);
  });
});

// senior review 2026-10-27 S3 (probe P2): /a/sh010.mov and /b/sh010.mov wrote "7 files" but the folder held one set
describe("farm export: two clips with one name (review 2026-10-27 S3)", () => {
  it("refuses them (names compared without case: a farm share may fold it) instead of one overwriting the other", () => {
    const a = { ...fj("sh010"), clip: { path: "/a/sh010.mov", kind: "video" as const, exrFrames: false } };
    const b = { ...fj("sh010"), clip: { path: "/b/sh010.mov", kind: "video" as const, exrFrames: false } };
    const B = { ...fj("SH010"), clip: { path: "/b/SH010.mov", kind: "video" as const, exrFrames: false } };
    // loop: NOT-WORTH — five formats
    for (const f of ["openjd", "deadline", "opencue", "flamenco", "shell"] as const) {
      expect(farmExport(f, [a, b], env).error, f).toBe(`"/a/sh010.mov" and "/b/sh010.mov" are both named sh010: their job files would replace each other; export them into separate folders.`);
      expect(farmExport(f, [a, B], env).error, f).toMatch(/are both named/);
      expect(farmExport(f, [a, b], env).files).toEqual([]);
    }
  });
});

// senior review 2026-10-27 S4 (probe P1b): ExtraArguments was POSIX-quoted, but the Deadline plugin appends it to the
// task's argument string, which Deadline (.NET) splits by the MSVC rules: '/hints/my hint.mov' became two arguments
describe("farm export: Deadline's ExtraArguments (review 2026-10-27 S4)", () => {
  /** the line split as farm/deadline10/test_quote.py's msvc_argv splits it (the plugin's own quoting test) */
  const msvcArgv = (line: string) =>
    JSON.parse(
      execFileSync(
        "python3",
        [
          "-I",
          "-c",
          "import sys, json; sys.path.insert(0, sys.argv[1]); from test_quote import msvc_argv; print(json.dumps(msvc_argv(sys.argv[2])))",
          fileURLToPath(new URL("../../farm/deadline10", import.meta.url)),
          line,
        ],
        { encoding: "utf8", timeout: 10_000 },
      ),
    ) as string[];

  it("a hint path with a space (or quotes, backslashes) stays one argument as Deadline splits the string", () => {
    // loop: NOT-WORTH — a test's few paths
    for (const hint of ["/hints/my hint.mov", "D:\\my hints\\h.mov", '/hints/it\'s "x".mov', "D:\\hints dir\\", '/hints/a\\"b c.mov']) {
      const e = farmExport("deadline", [fj("sh010", { hintMode: "video", hintVideo: hint, despillStrength: 0.3 })], env);
      const extra = file(e, "sh010_plugin_info.txt")
        .split("\n")
        .find((l) => l.startsWith("ExtraArguments="))!
        .slice("ExtraArguments=".length);
      expect(msvcArgv(extra), extra).toEqual(["--despill", "0.3", "--hint-video", hint]);
    }
  });
});

// SME review 2026-10-27 M1 (probe): the farm rendered -o <results>/<clip>.####.exr, so its frames were
// key/sh010_alpha.1001.exr while the queue's (and Copy as command's) are key/sh010_alpha_exr/sh010_alpha.1001.exr; and
// Deadline's OutputFilename0 named sh010_plate.####.exr where the files were sh010_plate_alpha.####.exr
describe("farm export: the queue's output layout (review 2026-10-27 M1)", () => {
  const j = { ...fj("sh010_plate", { outputs: ["alpha", "fg", "checker"], despillStrength: 0.5 }, "frames"), range: [1, 120] as [number, number], pad: 1 };
  const queueO = jobArgs(j, false)[jobArgs(j, false).indexOf("-o") + 1];

  it("every format gives corridorkey the queue's own -o folder", () => {
    expect(queueO).toBe("/renders/sh010_plate");
    const kv = (t: string) =>
      Object.fromEntries(
        t
          .trim()
          .split("\n")
          .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
      );
    const o = farmExport("openjd", [j], env);
    const t = file(o, "sh010_plate/template.yaml");
    expect(t).not.toContain("OutputPattern");
    // a PATH parameter in the job's name is RawParam (openjd check: Param.OutputDir "does not exist at this location")
    expect((yaml.load(t) as { name: string }).name).toBe("CorridorKey: {{RawParam.OutputDir}}");
    // loop: NOT-WORTH — the template's two steps
    for (const step of (yaml.load(t) as { steps: { script: { actions: { onRun: { args: string[] } } } }[] }).steps) {
      const a = step.script.actions.onRun.args;
      expect(a[a.indexOf("--output") + 1]).toBe("{{Param.OutputDir}}");
    }
    expect((yaml.load(file(o, "sh010_plate/parameter_values.yaml")) as { parameterValues: { name: string; value: string }[] }).parameterValues.find((p) => p.name === "OutputDir")!.value).toBe(queueO);
    expect(kv(file(farmExport("deadline", [j], env), "sh010_plate_plugin_info.txt")).OutputPath).toBe(queueO);
    const cue = words(
      file(farmExport("opencue", [j], env), "sh010_plate_opencue.sh")
        .split("\n")
        .find((l) => l.startsWith("exec "))!,
    );
    expect(cue[cue.indexOf("-o") + 1]).toBe(queueO);
    expect((JSON.parse(file(farmExport("flamenco", [j], env), "sh010_plate.flamenco.json")) as { settings: { output: string } }).settings.output).toBe(queueO);
    expect(file(farmExport("shell", [j], env), "shots.txt")).toContain(`\t${queueO}\n`);
  });

  it("Deadline names each output's real folder and frames (ck-cli run.rs: <clip>_<suffix>_exr/<clip>_<suffix>.<n>.exr)", () => {
    const d = farmExport("deadline", [j], env);
    expect(file(d, "sh010_plate_job_info.txt")).toContain(
      [
        "OutputDirectory0=/renders/sh010_plate/sh010_plate_alpha_exr",
        "OutputFilename0=sh010_plate_alpha.####.exr",
        "OutputDirectory1=/renders/sh010_plate/sh010_plate_fg_exr",
        "OutputFilename1=sh010_plate_fg.####.exr",
        "OutputDirectory2=/renders/sh010_plate/sh010_plate_checker_comp_despill050_exr",
        "OutputFilename2=sh010_plate_checker_comp_despill050.####.exr",
      ].join("\n"),
    );
    // a shot past 9999 pads wider, as corridorkey does; each export's notes say where the frames land
    expect(file(farmExport("deadline", [{ ...j, range: [9997, 10002], pad: 4 }], env), "sh010_plate_job_info.txt")).toContain("OutputFilename0=sh010_plate_alpha.#####.exr");
    expect(d.notes.join(" ")).toContain("The frames land where the queue writes them: /renders/sh010_plate/sh010_plate_alpha_exr/sh010_plate_alpha.####.exr");
  });
});

// SME review 2026-10-27 S3-S7 (probes): this desktop's runtime paths in every job; a thin Deadline export (no Verify,
// no Pool/Group/Priority/BatchName); Flamenco's hard-coded "linux" and a frames-already-there policy per format; the
// shell lists clobbering each other's logs and stopping at one failure; a frame folder as an OpenJD FILE input
describe("farm export for a wrangler (review 2026-10-27 S3-S7)", () => {
  const kv = (t: string) =>
    Object.fromEntries(
      t
        .trim()
        .split("\n")
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
  const workers = { models: "/farm/models", ort: "/farm/libonnxruntime.so", local: { models: false, ort: false } };

  it("S3: the workers' runtime paths when given; else the notes say plainly they are this computer's", () => {
    const o = farmExport("openjd", [sh010], workers);
    const v = yaml.load(file(o, "sh010/parameter_values.yaml")) as { parameterValues: { name: string; value: string }[] };
    expect(v.parameterValues.filter((p) => p.name === "Models" || p.name === "OnnxRuntime").map((p) => p.value)).toEqual(["/farm/models", "/farm/libonnxruntime.so"]);
    expect(o.notes.join(" ")).not.toMatch(/this computer's/);
    expect(farmExport("opencue", [sh010], env).notes.join(" ")).toMatch(
      /These jobs carry this computer's paths \(the models folder \/opt\/ck\/models and the ONNX Runtime library \/opt\/ck\/libonnxruntime.so\): give the workers' with farm export … --models <folder> --ort <library>/,
    );
  });

  it("S4: Deadline gets a Verify job after the render, one batch, Pool/Group/Priority; without a group the notes warn", () => {
    const e = farmExport("deadline", [sh010], { ...env, deadline: { batch: "sq01", pool: "show", group: "gpu", priority: 70 } });
    const job = kv(file(e, "sh010_job_info.txt"));
    const verify = kv(file(e, "sh010_verify_job_info.txt"));
    expect([job.BatchName, job.Pool, job.Group, job.Priority, verify.BatchName, verify.Name, verify.Frames]).toEqual(["sq01", "show", "gpu", "70", "sq01", "sh010 verify", "1001-1024"]);
    expect(kv(file(e, "sh010_verify_plugin_info.txt"))).toEqual({ ...kv(file(e, "sh010_plugin_info.txt")), Command: "verify" });
    expect(e.notes.join(" ")).toContain("-SubmitMultipleJobs -dependent -job <clip>_job_info.txt <clip>_plugin_info.txt -job <clip>_verify_job_info.txt <clip>_verify_plugin_info.txt");
    expect(e.notes.join(" ")).not.toMatch(/No --group/);
    expect(farmExport("deadline", [sh010], env).notes.join(" ")).toMatch(/No --group: .*--group <your GPU group>/);
  });

  it("S5: Flamenco's submitter platform is the one given; every format replaces frames already there, and says so", () => {
    const f = (platform: "linux" | "windows" | "darwin") =>
      JSON.parse(file(farmExport("flamenco", [sh020], { ...env, platform }), "sh020.flamenco.json")) as { submitter_platform: string; settings: { existing: string } };
    expect([f("windows").submitter_platform, f("darwin").submitter_platform, f("linux").settings.existing]).toEqual(["windows", "darwin", "overwrite"]);
    // loop: NOT-WORTH — five formats
    for (const fmt of ["openjd", "deadline", "opencue", "flamenco", "shell"] as const)
      expect(farmExport(fmt, [sh010], env).notes, fmt).toContain(
        "Frames already at the output's names are replaced (--overwrite in every format: a farm retries a task, and the retry must replace what its first try wrote).",
      );
    expect(file(farmExport("shell", [sh010], env), "run-shots.sh")).toContain('corridorkey-farm.sh" --overwrite');
  });

  it("S6: each shot list logs into its own folder, every list runs, the script's exit status says a failure", () => {
    const e = farmExport("shell", [sh010, sh020], env);
    const script = file(e, "run-shots.sh");
    expect(script).not.toContain("&&");
    const runs = script.split("\n").filter((l) => l.startsWith("bash"));
    // loop: NOT-WORTH — two lines
    expect(runs.map((l) => words(l)[words(l).indexOf("--logs") + 1])).toEqual(["$here/logs/shots-1", "$here/logs/shots-2"]);
    expect(runs.every((l) => l.endsWith(" || status=1"))).toBe(true);
    expect(script.trim().split("\n").slice(-1)).toEqual(["exit $status"]);
    // and as /bin/sh runs it: a failing first list doesn't stop the second, and the script ends 1
    const dir = mkdtempSync(join(tmpdir(), "ck-farm-sh-"));
    try {
      writeFileSync(join(dir, "corridorkey-farm.sh"), 'echo "$@" >> "$(dirname "$0")/ran"; case "$*" in *shots-1*) exit 1;; esac\n');
      writeFileSync(join(dir, "run-shots.sh"), script);
      let code = 0;
      try {
        execFileSync("/bin/sh", [join(dir, "run-shots.sh")], { timeout: 10_000 });
      } catch (x) {
        code = (x as { status: number }).status;
      }
      expect(code).toBe(1);
      expect(readFileSync(join(dir, "ran"), "utf8").trim().split("\n")).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("S7: a frame folder is an OpenJD DIRECTORY input chosen as a folder; a movie stays a FILE", () => {
    const e = farmExport("openjd", [sh010, sh020], env);
    const input = (c: string) =>
      (yaml.load(file(e, `${c}/template.yaml`)) as { parameterDefinitions: { name: string; objectType?: string; userInterface?: { control?: string } }[] }).parameterDefinitions.find(
        (p) => p.name === "Input",
      )!;
    expect([input("sh020").objectType, input("sh020").userInterface?.control]).toEqual(["DIRECTORY", "CHOOSE_DIRECTORY"]);
    expect([input("sh010").objectType, input("sh010").userInterface?.control]).toEqual(["FILE", "CHOOSE_INPUT_FILE"]);
    expect(e.notes.join(" ")).toMatch(/A frame folder goes in as a DIRECTORY input .* isn't run on Deadline Cloud yet/);
  });
});

// The CLI gate's behaviour half for the farm (tools/check_cli_parity.mjs checks that farm.ts takes Copy as command's
// table): each format's corridorkey line, put together as its submitter puts it (the shell farm script, OpenCue's
// corridorkey_submit.py, Deadline's CorridorKey.py, Flamenco's job type, the OpenJD template), gives the engine the
// app's own request for the clip as EXR (the farm writes EXR; TensorRT is each worker's own choice). Differences on
// purpose: Deadline and OpenCue key the shot's range (-s/-e); OpenCue's task gets --max-vram of its booking (the
// queue's limit rounded up, else 12 GiB).
describe("farm export: the CLI reproduces the app's job (round trip)", () => {
  const jobs: FarmJob[] = REPRESENTATIVE.map((r) => ({
    name: r.name,
    clip: { path: r.kind === "video" ? `/shots/${r.name}.mov` : `/shots/${r.name}/plates`, kind: r.kind, exrFrames: r.exrFrames },
    outputDir: `/renders/${r.name}`,
    options: { ...DEFAULT_OPTIONS, ...r.options },
    range: [1001, 1024],
  }));
  // loop: NOT-WORTH — a file's few lines
  const kv = (t: string) =>
    Object.fromEntries(
      t
        .trim()
        .split("\n")
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
  /** what the queue sends for the clip, as EXR and without TensorRT, plus what the format adds on purpose */
  const want = (j: FarmJob, extra: Record<string, unknown> = {}) => ({ ...engineOptions({ ...j.options, outputFormat: "exr" }, j.clip.kind, false), ...extra });
  const check = (j: FarmJob, words: string[], extra: Record<string, unknown>, what: string, jobFile: Record<string, unknown> = {}) => {
    const got = cliOptions(lineOf(words), j.clip.kind === "frames" && j.clip.exrFrames && jobFile.frame_dir_linear === undefined);
    expect([got.input, got.output], what).toEqual([j.clip.path, j.outputDir]);
    // a --job file's options, under the flags (flags win)
    sameOptions({ ...jobFile, ...got.options }, want(j, extra), `${what}: ${lineOf(words)}`);
  };

  it("shell", () => {
    const e = farmExport("shell", jobs, env);
    // loop: NOT-WORTH — the run lines and their shot lists
    for (const run of file(e, "run-shots.sh")
      .split("\n")
      .filter((l) => l.startsWith("bash"))) {
      const w = words(run.replace(/ \|\| status=1$/, ""));
      const list = w[w.indexOf("--logs") + 2].replace(/^.*\//, "");
      // loop: NOT-WORTH — the list's shots
      for (const [input, output] of file(e, list)
        .split("\n")
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => l.split("\t"))) {
        const j = jobs.find((x) => x.clip.path === input)!;
        check(j, ["render", "-i", input, "-o", output, "--overwrite", ...w.slice(w.indexOf("--") + 1)], {}, `shell ${j.name}`);
      }
    }
  });

  it("opencue", () => {
    const e = farmExport("opencue", jobs, env);
    // loop: NOT-WORTH — six clips
    for (const j of jobs) {
      const w = words(
        file(e, `${j.name}_opencue.sh`)
          .split("\n")
          .find((l) => l.startsWith("exec "))!,
      );
      const at = (f: string) => w[w.indexOf(f) + 1];
      // the script passes --max-vram only when given one (a queue limit); Auto leaves the engine its card's free memory
      const limit = w.includes("--max-vram") ? ["--max-vram", at("--max-vram")] : [];
      const cmd = ["render", "-i", at("-i"), "-o", at("-o"), ...w.slice(w.indexOf("--") + 1), "-s", "1001", "-e", "1024", "--overwrite", ...limit];
      check(j, cmd, { frame_start: 1001, frame_end: 1024 }, `opencue ${j.name}`);
    }
  });

  it("deadline", () => {
    const e = farmExport("deadline", jobs, env);
    // loop: NOT-WORTH — six clips
    for (const j of jobs) {
      const p = kv(file(e, `${j.name}_plugin_info.txt`));
      const f = kv(file(e, `${j.name}_job_info.txt`)).Frames.split("-");
      const cmd = ["render", "-i", p.InputPath, "-o", p.OutputPath, "-s", f[0], "-e", f[1], "--overwrite", "--outputs", p.Outputs];
      if (p.MaxVram) cmd.push("--max-vram", p.MaxVram);
      // loop: NOT-WORTH — the extra arguments (no spaces inside a value here)
      cmd.push(...p.ExtraArguments.split(" ").filter(Boolean));
      check(j, cmd, { frame_start: 1001, frame_end: 1024 }, `deadline ${j.name}`);
    }
  });

  it("flamenco", () => {
    const e = farmExport("flamenco", jobs, env);
    // loop: NOT-WORTH — six clips
    for (const j of jobs) {
      const s = (JSON.parse(file(e, `${j.name}.flamenco.json`)) as { settings: Record<string, string> }).settings;
      const linear = s.linear === "scene-linear" ? ["--linear"] : s.linear === "display-coded" ? ["--no-linear"] : [];
      check(j, ["render", "-i", s.input, "-o", s.output, "--outputs", s.outputs, ...linear, "--overwrite", ...words(s.extra_args)], {}, `flamenco ${j.name}`);
    }
  });

  it("openjd", () => {
    const e = farmExport("openjd", jobs, env);
    // loop: NOT-WORTH — six clips
    for (const j of jobs) {
      const t = yaml.load(file(e, `${j.name}/template.yaml`)) as { steps: { name: string; script: { actions: { onRun: { args: string[] } } } }[] };
      // loop: NOT-WORTH — the values
      const v = Object.fromEntries((yaml.load(file(e, `${j.name}/parameter_values.yaml`)) as { parameterValues: { name: string; value: string }[] }).parameterValues.map((p) => [p.name, p.value]));
      // loop: NOT-WORTH — the Key step's words
      const args = t.steps.find((s) => s.name === "Key")!.script.actions.onRun.args.map((a) => a.replace(/\{\{Param\.(\w+)\}\}/g, (_, n: string) => v[n] ?? ""));
      args.splice(args.indexOf("--job"), 2);
      // the farm's own progress lines: the Console refuses the flag (it shows progress itself)
      args.splice(args.indexOf("--progress-format"), 2);
      // the embedded options.json: {"frame_dir_linear": Linear, "low_vram": LowVram}, null = absent
      const jobFile: Record<string, unknown> = { low_vram: v.LowVram === "true" };
      if (v.Linear !== "null") jobFile.frame_dir_linear = v.Linear === "true";
      check(j, args, {}, `openjd ${j.name}`, jobFile);
    }
  });
});
