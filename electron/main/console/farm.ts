// farm export (Phase 4, docs/CONSOLE.md): queued clips as ready-to-submit render farm jobs, from the farm/ templates
// (farm/README.md), with each clip's settings as the queue would run them (src/shared/console/jobCommand.ts). Pure: the
// runner checks the folder, the files already there and sudo, and writes what this returns. The farm writes EXR frames
// (a video output can't be split into tasks), at <the clip's results folder>/<clip>.####.exr.
import openjdTemplate from "../../../farm/openjd/corridorkey/template.yaml?raw";
import deadlinePlugin from "../../../farm/deadline10/CorridorKey/CorridorKey.py?raw";
import deadlineParam from "../../../farm/deadline10/CorridorKey/CorridorKey.param?raw";
import deadlineOptions from "../../../farm/deadline10/CorridorKey/CorridorKey.options?raw";
import opencueSubmit from "../../../farm/opencue/corridorkey_submit.py?raw";
import flamencoJobType from "../../../farm/flamenco/corridorkey.js?raw";
import shellFarm from "../../../farm/shell/corridorkey-farm.sh?raw";
import { flagWords, jobFlags, type Flag, type JobLike } from "../../../src/shared/console/jobCommand";
import { quoteArg } from "../../../src/shared/console/parse";

export const FARM_FORMATS = ["openjd", "deadline", "opencue", "flamenco", "shell"] as const;
export type FarmFormat = (typeof FARM_FORMATS)[number];

export interface FarmJob extends JobLike {
  /** the clip's name as corridorkey names its outputs (runner.ts clipName) */
  name: string;
  /** the shot's first and last frame numbers (as corridorkey numbers them), when known */
  range: [number, number] | null;
}

export interface FarmEnv {
  /** this computer's model set and ONNX Runtime (the workers' may differ: the notes say so) */
  models: string | null;
  ort: string | null;
}

export interface FarmExport {
  /** relative to the export folder; `/` separated */
  files: { path: string; text: string }[];
  /** what to do with them, and what was left out */
  notes: string[];
  /** why nothing can be exported (then no files) */
  error?: string;
}

/** Flags a farm job carries: the job's, without the video ones (the farm writes EXR) and without --outputs. */
// loop: NOT-WORTH — a job's few flags
const farmFlags = (j: FarmJob): Flag[] => jobFlags({ ...j.options, outputFormat: "exr" }, j.clip.kind, false).filter(([n]) => n !== "outputs");
const outputs = (j: FarmJob) => j.options.outputs.join(",");
const pattern = (j: FarmJob) => `${j.outputDir.replace(/[\\/]+$/, "")}/${j.name}.####.exr`;
/** POSIX shell words (the scripts and the extra-argument fields are read as a shell would). */
// loop: NOT-WORTH — a command's few words
const sh = (words: readonly string[]) => words.map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(" ");
/** A YAML double-quoted scalar (JSON's string syntax is valid YAML). */
const y = (s: string) => JSON.stringify(s);
const runtimeWords = (env: FarmEnv) => [...(env.models ? ["--models", env.models] : []), ...(env.ort ? ["--ort", env.ort] : [])];
const RUNTIME_NOTE = "The models folder and ONNX Runtime library are this computer's: change them to the workers' paths.";

/** A new line, tab, NUL or other control character: it would start a line or a column of its own in a farm file. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Why `jobs` can't be exported: a control character in a clip's name or path, its results folder, a flag's value or
 * the runtime's paths (senior review 2026-10-27 M1: a new line in a name added lines to the key=value files, the shot
 * lists and the scripts, and no quoting saves key=value or a tab-separated list). Null: it can.
 */
function refusal(jobs: readonly FarmJob[], env: FarmEnv): string | null {
  // loop: NOT-WORTH — the exported jobs and their few values
  for (const j of jobs) {
    // loop: NOT-WORTH — a job's few flags
    const values = [j.name, j.clip.path, j.outputDir, ...farmFlags(j).map(([, v]) => v ?? "")];
    // loop: NOT-WORTH — as above
    const bad = values.find((v) => CONTROL.test(v));
    if (bad !== undefined)
      return `${JSON.stringify(j.clip.path)}: ${JSON.stringify(bad)} has a control character (a new line, a tab) that would add lines to the farm's files; rename it, then export again.`;
  }
  // loop: NOT-WORTH — two paths
  const bad = [env.models, env.ort].find((v) => v !== null && CONTROL.test(v));
  return bad ? `${JSON.stringify(bad)} (this computer's runtime) has a control character (a new line, a tab); rename it, then export again.` : null;
}

export function farmExport(format: FarmFormat, jobs: readonly FarmJob[], env: FarmEnv): FarmExport {
  const error = refusal(jobs, env);
  if (error) return { files: [], notes: [], error };
  const notes: string[] = [];
  // loop: NOT-WORTH — the exported jobs
  const video = jobs.filter((j) => j.options.outputFormat === "video").map((j) => j.name);
  if (video.length) notes.push(`${video.join(", ")}: set to video outputs in the queue; the farm writes EXR frames (a video can't be split into tasks).`);
  const needRange = format === "deadline" || format === "opencue";
  // loop: NOT-WORTH — as above
  const ranged = needRange ? jobs.filter((j) => j.range) : jobs;
  // loop: NOT-WORTH — as above
  const unranged = jobs.filter((j) => !ranged.includes(j)).map((j) => j.name);
  if (unranged.length) notes.push(`${unranged.join(", ")}: not exported (its frame range isn't known: the clip couldn't be read; ${format} needs it).`);
  const files: FarmExport["files"] = [];
  switch (format) {
    case "openjd":
      // loop: NOT-WORTH — one job bundle per clip
      for (const j of ranged) files.push(...openjd(j, env));
      notes.push(`One job bundle per clip: openjd check <clip>/template.yaml, then deadline bundle submit <clip>. ${RUNTIME_NOTE}`);
      break;
    case "deadline":
      // loop: NOT-WORTH — two files per clip
      for (const j of ranged) files.push(...deadline(j));
      files.push(
        { path: "CorridorKey/CorridorKey.py", text: deadlinePlugin },
        { path: "CorridorKey/CorridorKey.param", text: deadlineParam },
        { path: "CorridorKey/CorridorKey.options", text: deadlineOptions },
      );
      notes.push("Copy the CorridorKey folder to <repository>/custom/plugins/ once and set its paths (Configure Plugins); then deadlinecommand <clip>_job_info.txt <clip>_plugin_info.txt.");
      break;
    case "opencue":
      // loop: NOT-WORTH — one script per clip
      for (const j of ranged) files.push(opencue(j, env));
      files.push({ path: "corridorkey_submit.py", text: opencueSubmit });
      notes.push(`Submit with CUE_SHOW=<show> sh <clip>_opencue.sh (PyOutline installed). ${RUNTIME_NOTE}`);
      break;
    case "flamenco":
      // loop: NOT-WORTH — one job per clip
      for (const j of ranged) files.push(flamenco(j, env));
      files.push({ path: "scripts/corridorkey.js", text: flamencoJobType });
      notes.push(
        `Put scripts/corridorkey.js in the Manager's scripts folder once; submit each job with curl -X POST <manager>/api/v3/jobs -H 'Content-Type: application/json' -d @<clip>.flamenco.json. ${RUNTIME_NOTE}`,
      );
      break;
    case "shell":
      files.push(...shell(ranged, env));
      notes.push(`Run: bash run-shots.sh (one shot per graphics card at a time; --gpus 0,1 in it for more cards). ${RUNTIME_NOTE}`);
      break;
  }
  return { files, notes };
}

/** An OpenJD job bundle: the template with the clip's other flags in its Key step, and its parameter values. */
function openjd(j: FarmJob, env: FarmEnv): FarmExport["files"] {
  // scene-linear and low-memory are the template's own parameters; every other flag goes in the Key step's arguments
  // loop: NOT-WORTH — a job's few flags
  const extra = flagWords(farmFlags(j).filter(([n]) => n !== "linear" && n !== "low-vram"));
  const anchor = '            - "{{Param.Outputs}}"\n';
  const at = openjdTemplate.indexOf(anchor) + anchor.length;
  // loop: NOT-WORTH — a job's few words
  const template = openjdTemplate.slice(0, at) + extra.map((w) => `            - ${y(w)}\n`).join("") + openjdTemplate.slice(at);
  const values: [string, string | null][] = [
    ["Input", j.clip.path],
    ["OutputDir", j.outputDir],
    ["OutputPattern", `${j.name}.####.exr`],
    ["Outputs", outputs(j)],
    ["Linear", String(j.clip.kind === "frames" && j.options.frameDirLinear)],
    ["LowVram", String(!j.options.memory.auto && j.options.memory.lowVram)],
    ["Models", env.models],
    ["OnnxRuntime", env.ort],
  ];
  // loop: NOT-WORTH — eight values
  const params = values.filter(([, v]) => v !== null).map(([n, v]) => `  - name: ${n}\n    value: ${y(v!)}\n`);
  return [
    { path: `${j.name}/template.yaml`, text: template },
    { path: `${j.name}/parameter_values.yaml`, text: `# corridorkey farm export: ${j.name}\nparameterValues:\n${params.join("")}` },
  ];
}

/** Deadline 10: the job info and the plugin info (farm/deadline10), one task over the whole shot. */
function deadline(j: FarmJob): FarmExport["files"] {
  const [a, b] = j.range!;
  // loop: NOT-WORTH — a job's few flags
  const flags = farmFlags(j).filter(([n]) => n !== "max-vram");
  // loop: NOT-WORTH — as above
  const maxVram = farmFlags(j).find(([n]) => n === "max-vram")?.[1];
  // loop: NOT-WORTH — a file's few keys
  const lines = (kv: [string, string][]) => kv.map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  return [
    {
      path: `${j.name}_job_info.txt`,
      text: lines([
        ["Plugin", "CorridorKey"],
        ["Name", `${j.name} key`],
        ["Frames", `${a}-${b}`],
        ["ChunkSize", String(b - a + 1)],
        ["OutputDirectory0", j.outputDir],
        ["OutputFilename0", `${j.name}.####.exr`],
      ]),
    },
    {
      path: `${j.name}_plugin_info.txt`,
      text: lines([
        ["Command", "render"],
        ["InputPath", j.clip.path],
        ["OutputPath", pattern(j)],
        ["Outputs", outputs(j)],
        ["Preroll", "0"],
        ...(maxVram ? [["MaxVram", maxVram] as [string, string]] : []),
        ["ExtraArguments", sh(flagWords(flags))],
      ]),
    },
  ];
}

/** OpenCue: the submit script's invocation (corridorkey_submit.py beside it), one task over the whole shot. */
function opencue(j: FarmJob, env: FarmEnv): FarmExport["files"][number] {
  const [a, b] = j.range!;
  // the booking is --max-vram for the task too (the script passes it): a limit set in the queue becomes the booking
  // loop: NOT-WORTH — a job's few flags
  const maxVram = farmFlags(j).find(([n]) => n === "max-vram")?.[1];
  // loop: NOT-WORTH — as above
  const flags = farmFlags(j).filter(([n]) => n !== "max-vram");
  const args = [
    "--shot",
    j.name,
    "-i",
    j.clip.path,
    "-o",
    pattern(j),
    "--range",
    `${a}-${b}`,
    ...runtimeWords(env),
    ...(maxVram ? ["--gpu-memory", String(Math.ceil(Number(maxVram)))] : []),
    "--",
    "--outputs",
    outputs(j),
    ...flagWords(flags),
  ];
  return {
    path: `${j.name}_opencue.sh`,
    text:
      `#!/bin/sh\n# corridorkey farm export: ${j.name} to OpenCue (PyOutline). The show comes from CUE_SHOW.\n` +
      `exec python3 "$(dirname "$0")/corridorkey_submit.py" --show "\${CUE_SHOW:?set CUE_SHOW to the show's name}" ${sh(args)}\n`,
  };
}

/** Flamenco 3.x: the job (POST /api/v3/jobs) for the CorridorKey job type, one task over the whole shot. */
function flamenco(j: FarmJob, env: FarmEnv): FarmExport["files"][number] {
  // loop: NOT-WORTH — a job's few flags
  const flags = farmFlags(j).filter(([n]) => n !== "linear");
  const job = {
    name: `${j.name} key`,
    type: "corridorkey",
    priority: 50,
    submitter_platform: "linux",
    settings: {
      corridorkey: "corridorkey",
      input: j.clip.path,
      output: pattern(j),
      outputs: outputs(j),
      linear: j.clip.kind === "frames" && j.options.frameDirLinear,
      frames: "",
      chunk_size: 0,
      preroll: 0,
      tail: 0,
      existing: "refuse",
      models: env.models ?? "",
      ort: env.ort ?? "",
      extra_args: sh(flagWords(flags)),
    },
    metadata: { "corridorkey.export": "the app's farm export" },
  };
  return { path: `${j.name}.flamenco.json`, text: JSON.stringify(job, null, 2) + "\n" };
}

/** The shell farm: shot lists (one per set of flags: the flags go to every shot of a list) and the line that runs them. */
function shell(jobs: readonly FarmJob[], env: FarmEnv): FarmExport["files"] {
  const lists = new Map<string, FarmJob[]>();
  // loop: NOT-WORTH — the exported jobs
  for (const j of jobs) {
    const key = sh(["--outputs", outputs(j), ...flagWords(farmFlags(j))]);
    lists.set(key, [...(lists.get(key) ?? []), j]);
  }
  const files: FarmExport["files"] = [{ path: "corridorkey-farm.sh", text: shellFarm }];
  const runs: string[] = [];
  // loop: NOT-WORTH — one list per set of flags
  for (const [i, [flags, list]] of [...lists].entries()) {
    const name = lists.size === 1 ? "shots.txt" : `shots-${i + 1}.txt`;
    // loop: NOT-WORTH — the list's shots
    files.push({ path: name, text: `# corridorkey farm export: INPUT<tab>OUTPUT per shot (the whole shot)\n${list.map((j) => `${j.clip.path}\t${pattern(j)}\n`).join("")}` });
    runs.push(`bash "$here/corridorkey-farm.sh" --logs "$here/logs" "$here/${name}" -- ${flags}${env.models || env.ort ? ` ${sh(runtimeWords(env))}` : ""}`);
  }
  files.push({ path: "run-shots.sh", text: `#!/bin/sh\n# corridorkey farm export: every shot list, one after the other\nhere="$(dirname "$0")"\n${runs.join(" &&\n")}\n` });
  return files;
}

/** The export folder's files as the Console lists them (quoted as typed). */
// loop: NOT-WORTH — the files written
export const fileList = (files: FarmExport["files"], windows: boolean) => files.map((f) => `  ${quoteArg(f.path, { windows })}`);
