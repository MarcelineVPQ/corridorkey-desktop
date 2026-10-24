// Client for the CorridorKey engine (docs/ENGINE_PROTOCOL.md): JSON lines over
// the child's stdin/stdout, the Sonata helper pattern. Two engines speak it:
// the Rust one on ONNX Runtime (engine-rs/, `corridorkey-engine --models DIR`,
// the default when it is set up) and the PyTorch one (engine/ck_engine.py run
// with a CorridorKey2.0 checkout's venv), kept as the Rust engine's benchmark reference (Marcy 2026-10-22).
//
// lifetime: at most ONE engine process. Spawned when the queue starts, sent
// `quit` when the queue ends (a loaded model holds GBs of graphics memory:
// rule 11, share the machine), killed for a cancel or on app quit. A running
// job can't be interrupted inside the model, so cancel = kill the process group
// (the engine and its ffmpeg writers) and delete the job's temp folder.
import { addToPathList, isMac, isWin, PLATFORM } from "./platform";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const PROTOCOL = 1;
const PING_TIMEOUT_MS = 120_000; // PyTorch engine: importing torch + CUDA init; more when the disk cache is cold
const QUIT_GRACE_MS = 10_000;
const STDERR_LINES = 40;

export type EngineReply = { type: string; id?: string; [key: string]: unknown };

export interface PythonLaunch {
  kind?: "python";
  python: string;
  script: string;
  packageRoot: string;
  env: NodeJS.ProcessEnv;
}

export interface RustLaunch {
  kind: "rust";
  binary: string;
  models: string;
  // libonnxruntime.so for the GPU build (null: the engine's own, or CK_ENGINE_ORT)
  ort: string | null;
  env: NodeJS.ProcessEnv;
  // the TensorRT engine cache (the app's cache folder + "tensorrt"); a CK_ENGINE_TRT_CACHE in `env` wins
  trtCache?: string;
}

export type EngineLaunch = PythonLaunch | RustLaunch;

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

/** The engine's environment: ours minus what an AppImage/Electron sets that breaks a venv (Sonata's helperEnv). */
export function engineEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  // loop: NOT-WORTH — six names, once per engine spawn
  for (const k of ["LD_LIBRARY_PATH", "LD_PRELOAD", "PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "ELECTRON_RUN_AS_NODE"]) delete out[k];
  out.PYTHONUNBUFFERED = "1";
  out.PYTHONDONTWRITEBYTECODE = "1";
  return out;
}

/**
 * The Rust engine's environment: ours minus what an AppImage/Electron sets, plus the folders of
 * ONNX Runtime's library and of the CUDA / cuDNN / TensorRT libraries a pip-wheel layout keeps next to
 * it (site-packages/onnxruntime/capi → site-packages/nvidia/<x>/lib, site-packages/tensorrt_libs).
 */
// loop: NOT-WORTH — a few stats + one readdir per engine spawn (the CUDA library folders)
export function rustEngineEnv(
  env: NodeJS.ProcessEnv,
  ort: string | null,
  exists: (p: string) => boolean = existsSync,
  list: (p: string) => string[] = (p) => readdirSync(p),
  platform: NodeJS.Platform = PLATFORM,
): NodeJS.ProcessEnv {
  const win = isWin(platform);
  const mac = isMac(platform);
  const out: NodeJS.ProcessEnv = { ...env };
  // loop: NOT-WORTH — five names, once per engine spawn
  for (const k of ["LD_PRELOAD", "ELECTRON_RUN_AS_NODE", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES"]) delete out[k];
  const dirs: string[] = [];
  if (ort) {
    const capi = dirname(ort);
    dirs.push(capi);
    const site = dirname(dirname(capi));
    const nvidia = join(site, "nvidia");
    if (exists(nvidia)) {
      // loop: NOT-WORTH — a handful of CUDA library folders
      // Linux: nvidia/<x>/lib; Windows: nvidia/<x>/bin (CUDA 13 one level deeper, bin/x86_64)
      for (const d of list(nvidia).sort()) {
        // loop: NOT-WORTH — two candidate folders per CUDA package
        for (const sub of win ? [join("bin", "x86_64"), "bin"] : ["lib"]) if (exists(join(nvidia, d, sub))) dirs.push(join(nvidia, d, sub));
      }
    }
    if (exists(join(site, "tensorrt_libs"))) dirs.push(join(site, "tensorrt_libs"));
    // Windows: Microsoft's Visual C++ runtime from the msvc-runtime wheel, which onnxruntime.dll needs (install.ts)
    if (win && exists(site))
      // loop: NOT-WORTH — the runtime folder's few entries, once per engine spawn
      for (const d of list(site).filter((n) => /^msvc_runtime-[\d.]+\.data$/.test(n))) if (exists(join(site, d, "data", "Scripts"))) dirs.push(join(site, d, "data", "Scripts"));
    out.CK_ENGINE_ORT = ort;
  }
  // the engine ends with this app on every system (engine-rs proc.rs end_with_parent; Windows waits on this pid)
  out.CK_ENGINE_PARENT_PID = String(process.pid);
  // loop: NOT-WORTH — a user's extra library folders, once per engine spawn
  if (env.CK_ENGINE_LD_LIBRARY_PATH) dirs.push(...env.CK_ENGINE_LD_LIBRARY_PATH.split(win ? ";" : ":").filter(Boolean));
  // Windows finds DLLs on PATH (the folders go first); Linux on LD_LIBRARY_PATH; macOS on DYLD_LIBRARY_PATH
  // loop: NOT-WORTH — a few folders joined, once per engine spawn
  if (dirs.length && win) out.PATH = addToPathList(env.PATH ?? env.Path, dirs, "front", ";");
  else if (dirs.length && mac) out.DYLD_LIBRARY_PATH = dirs.join(":");
  else if (dirs.length) out.LD_LIBRARY_PATH = dirs.join(":");
  return out;
}

/** The command line and environment of an engine launch. */
export function launchCommand(launch: EngineLaunch): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (launch.kind === "rust") {
    const args = ["--models", launch.models];
    if (launch.ort) args.push("--ort", launch.ort);
    const env = rustEngineEnv(launch.env, launch.ort);
    // TensorRT engines go to the app's own cache folder on every system (engine-rs pipeline.rs trt_root)
    if (launch.trtCache && !launch.env.CK_ENGINE_TRT_CACHE) env.CK_ENGINE_TRT_CACHE = launch.trtCache;
    return { cmd: launch.binary, args, env };
  }
  return { cmd: launch.python, args: ["-u", launch.script, "--package-root", launch.packageRoot], env: engineEnv(launch.env) };
}

export class EngineProcess {
  private child: ChildProcess | null = null;
  private stderr: string[] = [];
  private pongWait: { resolve: (r: EngineReply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private exited = false;

  constructor(
    private readonly launch: EngineLaunch,
    private readonly onReply: (reply: EngineReply) => void,
    private readonly onExit: (code: number | null, signal: NodeJS.Signals | null, stderrTail: string[]) => void,
    private readonly spawnFn: SpawnFn = nodeSpawn,
  ) {}

  /** Spawn and ping. Resolves with the pong; rejects (and kills) on a bad protocol or no answer. */
  start(): Promise<EngineReply> {
    const { cmd, args, env } = launchCommand(this.launch);
    // detached: its own process group, so a cancel also ends the ffmpeg writers it started (Linux; on Windows
    // detached would open a console window, and taskkill /T ends the tree instead)
    const win = isWin();
    const child = this.spawnFn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"], detached: !win, windowsHide: true });
    this.child = child;
    // lifetime: OK — both readers end with the child's streams
    createInterface({ input: child.stdout! }).on("line", (line) => this.line(line));
    createInterface({ input: child.stderr! }).on("line", (line) => {
      this.tail(line);
    });
    child.on("error", (err) => this.fail(new Error(`engine could not start: ${err.message}`)));
    child.on("exit", (code, signal) => {
      this.exited = true;
      this.child = null;
      this.fail(new Error(`engine exited before answering (${signal ?? `code ${code}`})`));
      this.onExit(code, signal, [...this.stderr]);
    });
    return new Promise<EngineReply>((resolve, reject) => {
      // loop: SERIAL-REQUIRED — the ping deadline (PING_TIMEOUT_MS), once per engine start
      const timer = setTimeout(() => {
        this.fail(new Error(`engine did not answer within ${PING_TIMEOUT_MS / 1000} s`));
        this.kill();
      }, PING_TIMEOUT_MS);
      this.pongWait = { resolve, reject, timer };
      this.send({ cmd: "ping" });
    });
  }

  send(msg: Record<string, unknown>): void {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  /** Keep the last STDERR_LINES lines (stderr, and stdout that isn't protocol), never more (leak audit 2026-10-24, #1). */
  private tail(line: string): void {
    this.stderr.push(line);
    // loop: NOT-WORTH — drops at most one line per added line
    while (this.stderr.length > STDERR_LINES) this.stderr.shift();
  }

  stderrTail(): string[] {
    return [...this.stderr];
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get running(): boolean {
    return this.child !== null && !this.exited;
  }

  /** Ask it to quit; kill it if it hasn't after QUIT_GRACE_MS. */
  quit(): void {
    if (!this.running) return;
    this.send({ cmd: "quit" });
    const child = this.child;
    // lifetime: OK — one timer per quit, a no-op once the child is gone
    // loop: SERIAL-REQUIRED — the quit grace (QUIT_GRACE_MS), then kill; once per engine stop
    setTimeout(() => {
      if (this.child === child) this.kill();
    }, QUIT_GRACE_MS).unref();
  }

  /** SIGKILL the whole process group (engine + ffmpeg); on Windows, taskkill the process tree. */
  kill(): void {
    const pid = this.child?.pid;
    if (!pid || this.exited) return;
    if (isWin()) {
      // loop: NOT-WORTH — one taskkill per cancel [bounded: taskkill ends by itself]
      nodeSpawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => this.child?.kill());
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // error: NOT-WORTH — the group is already gone; the exit handler reports it
      this.child?.kill("SIGKILL");
    }
  }

  private line(line: string): void {
    let reply: EngineReply;
    try {
      reply = JSON.parse(line) as EngineReply;
    } catch {
      // error: SHOWN — a non-protocol line on stdout goes to the stderr tail the error report shows
      this.tail(`[stdout] ${line}`);
      return;
    }
    if (reply.type === "pong" && this.pongWait) {
      const wait = this.pongWait;
      this.pongWait = null;
      clearTimeout(wait.timer);
      if (reply.protocol !== PROTOCOL) {
        wait.reject(new Error(`engine speaks protocol ${String(reply.protocol)}, this app needs ${PROTOCOL}`));
        this.kill();
        return;
      }
      wait.resolve(reply);
      return;
    }
    this.onReply(reply);
  }

  private fail(err: Error): void {
    if (!this.pongWait) return;
    const wait = this.pongWait;
    this.pongWait = null;
    clearTimeout(wait.timer);
    wait.reject(err);
  }
}
