#!/usr/bin/env node
// Engine bench: drives an engine through docs/ENGINE_PROTOCOL.md (spawn → ping → run → result, one engine
// process per clip) and records what the engine itself reports plus what the system measures:
//   engine, version, provider/precision; load-to-first-frame (spawn → first `frames` reply with done > 0);
//   steady frames/s from the engine's own `frames` replies after the first window; total wall time;
//   peak VRAM (nvidia-smi every 250 ms, the engine's process tree); peak RSS (/proc, the same tree);
//   the memory window used (`memory` reply). Writes <out>/bench.json, <out>/bench.md and every reply to
//   <out>/<clip>.replies.jsonl (the engine's own logs, e.g. the Rust engine's timing line); outputs go to
//   <out>/out/<clip>/ for tools/matte_compare.py --roots.
//
//   node tools/engine_bench.mjs rust   --bin BIN --models DIR [--ort LIB] [--device cuda|cpu] --out DIR [opts] CLIP...
//   node tools/engine_bench.mjs python --python VENV_PY --script engine/ck_engine.py --package-root CK --out DIR [opts] CLIP...
//   node tools/engine_bench.mjs footprint NAME=PATH[,PATH...] ...      (install size with du)
//
// opts: --vram-budget GB (the run option vram_budget_gb, same for both engines), --tensorrt,
//       --stall-s S (default 600: an engine silent that long is killed and the clip recorded as stalled;
//       the longest silence measured is one TensorRT engine build, 93 s),
//       --option key=json (any extra run option), --env K=V (engine environment), --cpu (no GPU guard; CPU only).
// Defaults for both engines: outputs alpha+fg, automatic memory window, no hint.
// GPU guard: refuses to start, and stops between clips, while Sonata runs or another process holds > 1 GiB.
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

const SAMPLE_MS = 250;
const STALL_S = 600;

export function parseArgs(argv) {
  const a = { clips: [], option: {}, env: {}, kind: argv[0], stallS: STALL_S };
  // loop: NOT-WORTH — the command line
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === "--bin") a.bin = next();
    else if (k === "--models") a.models = next();
    else if (k === "--ort") a.ort = next();
    else if (k === "--device") a.device = next();
    else if (k === "--python") a.python = next();
    else if (k === "--script") a.script = next();
    else if (k === "--package-root") a.packageRoot = next();
    else if (k === "--out") a.out = next();
    else if (k === "--vram-budget") a.vramBudget = Number(next());
    else if (k === "--tensorrt") a.tensorrt = true;
    else if (k === "--stall-s") a.stallS = Number(next());
    else if (k === "--cpu") a.cpu = true;
    else if (k === "--option") {
      const [key, ...v] = next().split("=");
      a.option[key] = JSON.parse(v.join("="));
    } else if (k === "--env") {
      const [key, ...v] = next().split("=");
      a.env[key] = v.join("=");
    } else a.clips.push(k);
  }
  return a;
}

/** The run options both engines get: alpha+fg, auto memory, no hint (+ the shared budget). */
export function runOptions(a) {
  const o = { outputs: ["alpha", "fg"], ...a.option };
  if (a.vramBudget) o.vram_budget_gb = a.vramBudget;
  if (a.tensorrt) o.tensorrt = true;
  return o;
}

export function engineCommand(a) {
  if (a.kind === "rust") {
    const args = ["--models", a.models];
    if (a.ort) args.push("--ort", a.ort);
    if (a.device) args.push("--device", a.device);
    return [a.bin, args];
  }
  return [a.python, ["-u", a.script, "--package-root", a.packageRoot]];
}

/** The process tree under `root` (children from /proc/<pid>/task/<tid>/children). */
export function tree(root) {
  const all = [root];
  // loop: HOT-PATH-OK — a few processes (engine + ffmpeg writers), every 250 ms
  for (let i = 0; i < all.length; i++) {
    try {
      // loop: NOT-WORTH — the threads of one process
      for (const t of readdirSync(`/proc/${all[i]}/task`)) {
        // loop: HOT-PATH-OK — the engine's few processes, every 250 ms while a bench clip runs
        all.push(...readFileSync(`/proc/${all[i]}/task/${t}/children`, "utf8").split(" ").filter(Boolean).map(Number));
      }
    } catch {
      // error: NOT-WORTH — the process ended between listing and reading
    }
  }
  return all;
}

const rssMb = (pids) =>
  // loop: HOT-PATH-OK — the engine's few processes, every 250 ms while a bench clip runs
  pids.reduce((s, p) => {
    try {
      return s + Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${p}/status`, "utf8"))[1]) / 1024;
    } catch {
      return s;
    }
  }, 0);

function gpuApps() {
  try {
    // loop: HOT-PATH-OK — one nvidia-smi call every 250 ms while a bench clip runs [bounded: 5 s timeout (this pass: had none)]
    return (
      execFileSync("nvidia-smi", ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"], { encoding: "utf8", timeout: 5000 })
        .split("\n")
        // loop: HOT-PATH-OK — a few compute processes, every 250 ms
        .filter(Boolean)
        .map((l) => l.split(",").map((s) => Number(s.trim())))
    );
  } catch {
    return [];
  }
}

const vramMb = (pids) => {
  const set = new Set(pids);
  return (
    gpuApps()
      // loop: HOT-PATH-OK — a few compute processes, every 250 ms
      .filter(([pid]) => set.has(pid))
      .reduce((s, [, mb]) => s + mb, 0)
  );
};

/** null when the GPU may be used, else why not (Sonata playing, or another process holding > 1 GiB). */
export function gpuBusy(ownPids = []) {
  const pattern = ["mount_s", "onata|S", "onata.AppImage"].join("");
  try {
    // helper command lines under ~/.cache/claude-scratch (other agents' guards and test copies) are not Sonata
    // loop: NOT-WORTH — pgrep once per clip (the GPU guard) [bounded: pgrep reads /proc and exits]
    const out = execFileSync("pgrep", ["-fai", pattern], { encoding: "utf8" })
      .split("\n")
      // loop: NOT-WORTH — pgrep's few lines, once per clip
      .filter((l) => l.trim() && !l.includes("claude-scratch") && !l.includes("pgrep"));
    if (out.length) return `Sonata is running (${out[0]})`;
  } catch {
    // pgrep exits 1 when nothing matches
  }
  const own = new Set(ownPids);
  // loop: NOT-WORTH — a few compute processes, once per clip
  const big = gpuApps().filter(([pid, mb]) => !own.has(pid) && mb > 1024);
  // loop: NOT-WORTH — a few compute processes, once per clip
  return big.length ? `another process holds graphics memory: ${big.map(([p, m]) => `${p} ${m} MiB`).join(", ")}` : null;
}

/** frames/s after the first window: from the first `frames` reply after "window 1/n done" to the last. */
export function steadyFps(frames, firstWindowAt) {
  // loop: NOT-WORTH — the clip's frames replies (≤ a few hundred), once per clip
  const f = frames.filter(([t, d]) => d > 0 && (firstWindowAt === undefined || t >= firstWindowAt));
  if (f.length < 2) return null;
  const [t0, d0] = f[0];
  const [t1, d1] = f[f.length - 1];
  return t1 > t0 ? (d1 - d0) / (t1 - t0) : null;
}

async function runClip(a, clip) {
  const name = basename(clip, extname(clip));
  const [cmd, args] = engineCommand(a);
  const t0 = performance.now();
  const sec = () => (performance.now() - t0) / 1000;
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONUNBUFFERED: "1", ...a.env } });
  const r = { clip: name, input: resolve(clip), engine: a.kind, peakVramMb: 0, peakRssMb: 0, memory: null, provider: null, error: null };
  const frames = [];
  const stderr = [];
  createInterface({ input: child.stderr }).on("line", (l) => {
    stderr.push(l);
    if (stderr.length > 30) stderr.shift();
  });
  // lifetime: OK — cleared when the engine exits
  // loop: HOT-PATH-OK — /proc reads + one nvidia-smi call every 250 ms while a bench clip runs
  let lastReply = 0;
  // loop: HOT-PATH-OK — the 250 ms sampler while a clip runs; also the stall watchdog (STALL_S, this pass: a silent engine is killed instead of holding the GPU lock)
  const sampler = setInterval(() => {
    if (sec() - lastReply > a.stallS && r.exit === undefined && !r.stalled) {
      // a wait that never ends would hold the GPU lock: the silent engine is stopped and the clip says so
      r.stalled = true;
      r.error = `stalled: no engine reply for ${a.stallS} s`;
      child.kill("SIGKILL");
    }
    const p = tree(child.pid);
    if (!a.cpu) r.peakVramMb = Math.max(r.peakVramMb, vramMb(p));
    r.peakRssMb = Math.max(r.peakRssMb, Math.round(rssMb(p)));
  }, SAMPLE_MS);
  const done = new Promise((res) => {
    const replies = join(a.out, `${name}.replies.jsonl`);
    writeFileSync(replies, "");
    createInterface({ input: child.stdout }).on("line", (line) => {
      appendFileSync(replies, line + "\n");
      lastReply = sec();
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      const now = sec();
      if (m.type === "pong") {
        Object.assign(r, {
          engineName: m.engine,
          version: m.version,
          pongProvider: m.provider ?? m.device,
          precision: m.precision ?? (m.torch ? "bf16-autocast" : null),
          runtime: m.ort ? `onnxruntime ${m.ort}` : m.torch ? `torch ${m.torch}` : null,
        });
        child.stdin.write(JSON.stringify({ cmd: "run", id: name, input: resolve(clip), output_dir: join(a.out, "out", name), temp_dir: join(a.out, "tmp", name), options: runOptions(a) }) + "\n");
      } else if (m.type === "provider") r.provider = { ...(r.provider ?? {}), ...m };
      else if (m.type === "clip") Object.assign(r, { width: m.width, height: m.height, totalFrames: m.frames });
      else if (m.type === "memory") r.memory = m;
      else if (m.type === "progress" && m.stage === "keying" && typeof m.p === "number" && r.firstWindowAt === undefined) r.firstWindowAt = now;
      else if (m.type === "frames") {
        if (r.firstFrameAt === undefined && m.done > 0) r.firstFrameAt = now;
        frames.push([now, m.done]);
      } else if (m.type === "result") {
        r.totalS = now;
        r.engineSeconds = m.seconds;
        child.stdin.write('{"cmd":"quit"}\n');
      } else if (m.type === "error") {
        r.error = `${m.code}: ${m.message}`;
        child.stdin.write('{"cmd":"quit"}\n');
      }
    });
    child.on("exit", (code, signal) => {
      r.exit = signal ?? code;
      res();
    });
  });
  child.stdin.write('{"cmd":"ping"}\n');
  await done;
  clearInterval(sampler);
  r.steadyFps = steadyFps(frames, r.firstWindowAt);
  r.framesDone = frames.length ? frames[frames.length - 1][1] : 0;
  if (r.error || r.exit !== 0) r.stderrTail = stderr;
  return r;
}

const fmt = (v, d = 1, unit = "") => (v === null || v === undefined || Number.isNaN(v) ? "n/a" : `${Number(v).toFixed(d)}${unit}`);

export function markdown(rows) {
  const head =
    "| clip | engine | provider / precision | size | frames | window | load→first frame | steady fps | total | peak VRAM | peak RSS | result |\n" +
    "|---|---|---|---|---|---|---|---|---|---|---|---|\n";
  return (
    head +
    rows
      // loop: NOT-WORTH — the bench's rows, once per report
      .map((r) => {
        const m = r.memory;
        const win = m ? `${m.hann_chunk}/${m.hann_stride}${m.low_vram ? " low" : ""}${m.auto ? " auto" : ""}` : "n/a";
        const prov = `${r.provider?.provider ?? r.pongProvider ?? "?"} / ${r.provider?.precision ?? r.precision ?? "?"}`;
        return `| ${r.clip} | ${r.engineName ?? r.engine} ${r.version ?? ""} | ${prov} | ${r.width ?? "?"}×${r.height ?? "?"} | ${r.framesDone}/${r.totalFrames ?? "?"} | ${win} | ${fmt(r.firstFrameAt, 1, " s")} | ${fmt(r.steadyFps, 2)} | ${fmt(r.totalS, 1, " s")} | ${fmt(r.peakVramMb / 1024, 2, " GB")} | ${fmt(r.peakRssMb / 1024, 2, " GB")} | ${r.error ?? "ok"} |`;
      })
      .join("\n") +
    "\n"
  );
}

function du(paths) {
  // loop: NOT-WORTH — a few install paths
  let total = 0;
  // loop: NOT-WORTH — a few install paths, du once each [bounded: du over a local folder]
  for (const p of paths) total += Number(execFileSync("du", ["-sbL", p], { encoding: "utf8" }).split("\t")[0]);
  return total;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.kind === "footprint") {
    // loop: NOT-WORTH — the command line's clips
    const rows = a.clips.map((spec) => {
      const [name, list] = spec.split("=");
      const paths = list.split(",");
      return { name, paths, bytes: du(paths) };
    });
    // loop: NOT-WORTH — a few rows
    for (const r of rows) console.log(`${r.name}: ${(r.bytes / 1e9).toFixed(2)} GB  (${r.paths.join(", ")})`);
    return;
  }
  if (!["rust", "python"].includes(a.kind) || !a.out || !a.clips.length) {
    console.error("usage: engine_bench.mjs rust|python ... --out DIR CLIP...  (see the header)");
    process.exit(2);
  }
  mkdirSync(a.out, { recursive: true });
  const rows = [];
  // loop: SERIAL-REQUIRED — one engine on one GPU at a time; clips run in order
  for (const clip of a.clips) {
    const why = a.cpu ? null : gpuBusy();
    if (why) {
      console.error(`GPU guard: ${why}; stopping before ${clip}`);
      break;
    }
    const r = await runClip(a, clip);
    rows.push(r);
    console.log(JSON.stringify(r));
    writeFileSync(join(a.out, "bench.json"), JSON.stringify({ kind: a.kind, options: runOptions(a), rows }, null, 2));
    writeFileSync(join(a.out, "bench.md"), markdown(rows));
  }
  console.log(markdown(rows));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) await main();
