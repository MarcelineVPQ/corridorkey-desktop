// Client for the CorridorKey engine (engine/ck_engine.py, docs/ENGINE_PROTOCOL.md):
// JSON lines over the child's stdin/stdout, the Sonata helper pattern.
//
// lifetime: at most ONE engine process. Spawned when the queue starts, sent
// `quit` when the queue ends (a loaded model holds GBs of graphics memory:
// rule 11, share the machine), killed for a cancel or on app quit. A running
// job can't be interrupted inside the model, so cancel = kill the process group
// (the engine and its ffmpeg writers) and delete the job's temp folder.
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createInterface } from "node:readline";

export const PROTOCOL = 1;
const PING_TIMEOUT_MS = 120_000; // importing torch + CUDA init; more when the disk cache is cold
const QUIT_GRACE_MS = 10_000;
const STDERR_LINES = 40;

export type EngineReply = { type: string; id?: string; [key: string]: unknown };

export interface EngineLaunch {
  python: string;
  script: string;
  packageRoot: string;
  env: NodeJS.ProcessEnv;
}

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
    const { python, script, packageRoot, env } = this.launch;
    // detached: its own process group, so a cancel also ends the ffmpeg writers it started
    const child = this.spawnFn(python, ["-u", script, "--package-root", packageRoot], { env: engineEnv(env), stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.child = child;
    // lifetime: OK — both readers end with the child's streams
    createInterface({ input: child.stdout! }).on("line", (line) => this.line(line));
    createInterface({ input: child.stderr! }).on("line", (line) => {
      this.stderr.push(line);
      if (this.stderr.length > STDERR_LINES) this.stderr.shift();
    });
    child.on("error", (err) => this.fail(new Error(`engine could not start: ${err.message}`)));
    child.on("exit", (code, signal) => {
      this.exited = true;
      this.child = null;
      this.fail(new Error(`engine exited before answering (${signal ?? `code ${code}`})`));
      this.onExit(code, signal, [...this.stderr]);
    });
    return new Promise<EngineReply>((resolve, reject) => {
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
    setTimeout(() => {
      if (this.child === child) this.kill();
    }, QUIT_GRACE_MS).unref();
  }

  /** SIGKILL the whole process group (engine + ffmpeg). */
  kill(): void {
    const pid = this.child?.pid;
    if (!pid || this.exited) return;
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
      this.stderr.push(`[stdout] ${line}`);
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
