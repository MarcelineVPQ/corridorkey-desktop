// farm export's files (electron/main/console/farm.ts): each format's files parse as their farm reads them and carry the
// clip's frames, paths and flags. OpenJD: `openjd check` isn't installed here, so the bundle is checked structurally
// (js-yaml; the 2023-09 schema's parameter and format-string rules that matter here); the template itself passes
// `openjd check` (farm/README.md).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { farmExport, type FarmJob } from "../../electron/main/console/farm";
import { tokenize } from "../../src/shared/console/parse";
import { DEFAULT_OPTIONS, type JobOptions } from "../../src/shared/types";

// js-yaml comes with the build tools (electron-builder); it has no types of its own
const yaml = (await import("js-yaml" as string)) as { load: (s: string) => unknown };

const env = { models: "/opt/ck/models", ort: "/opt/ck/libonnxruntime.so" };
const fj = (name: string, options: Partial<JobOptions> = {}, kind: "video" | "frames" = "video"): FarmJob => ({
  name,
  clip: { path: kind === "video" ? `/shots/${name}.mov` : `/shots/${name}/plates`, kind },
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
      OutputPattern: "sh010.####.exr",
      Outputs: "alpha",
      Linear: "false",
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
      Frames: "1001-1024",
      ChunkSize: "24",
      OutputDirectory0: "/renders/sh010",
      OutputFilename0: "sh010.####.exr",
    });
    const plugin = kv(file(e, "sh010_plugin_info.txt"));
    expect(plugin).toMatchObject({ Command: "render", InputPath: "/shots/sh010.mov", OutputPath: "/renders/sh010/sh010.####.exr", Outputs: "alpha", MaxVram: "10" });
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
    expect([at("--shot"), at("-i"), at("-o"), at("--range"), at("--gpu-memory"), at("--models")]).toEqual([
      "sh010",
      "/shots/sh010.mov",
      "/renders/sh010/sh010.####.exr",
      "1001-1024",
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
    expect(job.settings).toMatchObject({ input: "/shots/sh020/plates", output: "/renders/sh020/sh020.####.exr", outputs: "alpha,fg", linear: true, frames: "", chunk_size: 0 });
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
      ["/shots/sh010.mov", "/renders/sh010/sh010.####.exr"],
      ["/shots/sh030.mov", "/renders/sh030/sh030.####.exr"],
    ]);
    const run = file(e, "run-shots.sh")
      .split("\n")
      .filter((l) => l.startsWith("bash"));
    expect(run).toHaveLength(2);
    const w = words(run[0].replace(/ &&$/, ""));
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
