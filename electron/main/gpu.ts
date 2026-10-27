// The graphics card as nvidia-smi reports it: memory, load and every compute
// process with its name, so the app can say who else is using the card
// (rule 11). Read on demand only: at queue start and every GPU_POLL_MS while
// a job runs AND the window is shown. Nothing reads it while idle or hidden.
import { readFileSync } from "node:fs";
import { run } from "./run";
import { OTHER_GPU_USER_MB, type GpuInfo, type GpuProcess } from "../../src/shared/types";

export const GPU_POLL_MS = 2000;
// nvidia-smi answers in ~50 ms; a driver in trouble can hang it: the read gives up (and says so) instead.
export const GPU_READ_TIMEOUT_MS = 5000;

/** Parse `nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu --format=csv,noheader,nounits`. */
export function parseGpuLine(line: string): Omit<GpuInfo, "processes" | "at"> | null {
  // loop: NOT-WORTH — four fields, every GPU_POLL_MS while a job runs and the window is shown
  const parts = line.split(",").map((s) => s.trim());
  if (parts.length < 4) return null;
  const [name, total, used, util] = parts;
  if (!Number.isFinite(Number(total))) return null;
  return { name, totalMb: Number(total), usedMb: Number(used), utilization: Number(util) || 0 };
}

/** Parse `--query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits` (the name may hold commas). */
export function parseApps(text: string): { pid: number; exe: string; usedMb: number }[] {
  return (
    text
      .split("\n")
      // loop: NOT-WORTH — a few compute processes, every GPU_POLL_MS while a job runs and the window is shown
      // pid, the program's path as it is (commas and spaces kept), memory
      .map((l) => /^\s*(\d+)\s*,\s*(.*?)\s*,\s*([\d.]+|\[N\/A\])\s*$/.exec(l))
      // loop: NOT-WORTH — as above
      .filter((m): m is RegExpExecArray => m !== null)
      // loop: NOT-WORTH — as above
      .map((m) => ({ pid: Number(m[1]), exe: m[2], usedMb: Number(m[3]) || 0 }))
  );
}

/** A readable name for a process: Sonata and its engine by name, else the command's basename. */
export function processName(cmdline: string): string {
  const lower = cmdline.toLowerCase();
  if (/mount_sonata|sonata\.appimage/.test(lower)) return "Sonata";
  if (/sonata-align|sonata_align|sonata-engine/.test(lower)) return "Sonata's word timing";
  // the program alone, never its arguments: Chromium/Electron rewrite /proc cmdline into one space-separated string
  // ("/opt/Mullvad VPN/mullvad-gui --type=gpu-process --user-data-dir=/home/…"), so cut at the first " -" too
  const first = (cmdline.split("\0")[0] || cmdline).split(/\s+-/)[0].trim();
  // either separator: Linux paths, and Windows' as nvidia-smi gives them
  return first.split(/[\\/]/).pop() || "unknown";
}

function cmdline(pid: number): string {
  try {
    // loop: HOT-PATH-OK — one /proc/<pid>/cmdline read per compute process (a few), every 2 s only while a job runs and the window is shown
    return readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    // error: NOT-WORTH — the process ended between the two reads (or isn't ours to read): shown as "unknown"
    return "";
  }
}

/** The parent pid in `/proc/<pid>/stat` (its 4th field, after the name in parentheses, which may hold spaces). */
export function parentPid(stat: string): number | null {
  const m = /^\)\s+\S+\s+(\d+)/.exec(stat.slice(stat.lastIndexOf(")")));
  return m ? Number(m[1]) : null;
}

/**
 * Whether a compute process is the app's own: the engine, or a child it started (the TensorRT engine builder,
 * ck-trt-build, holds the card while it builds; Linux reads the parent from /proc, elsewhere the engine alone counts).
 */
export function isOurs(pid: number, ourPids: Set<number>, stat: (pid: number) => string = procStat): boolean {
  if (ourPids.has(pid)) return true;
  const parent = parentPid(stat(pid));
  return parent !== null && ourPids.has(parent);
}

function procStat(pid: number): string {
  try {
    // loop: HOT-PATH-OK — one /proc/<pid>/stat read per compute process (a few), every 2 s only while a job runs and the window is shown
    return readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    // error: NOT-WORTH — no /proc (Windows), or the process ended: not counted as ours
    return "";
  }
}

export async function readGpu(ourPids: Set<number>): Promise<GpuInfo> {
  const [gpu, apps] = await Promise.all([
    // loop: HOT-PATH-OK — nvidia-smi every 2 s while a job runs and the window is shown; GPU_READ_TIMEOUT_MS 5 s and one read at a time (this pass)
    run("nvidia-smi", ["--query-gpu=name,memory.total,memory.used,utilization.gpu", "--format=csv,noheader,nounits"], { timeout: GPU_READ_TIMEOUT_MS }),
    // loop: HOT-PATH-OK — the same read's second query, same timeout
    run("nvidia-smi", ["--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"], { timeout: GPU_READ_TIMEOUT_MS }),
  ]);
  const head = parseGpuLine(gpu.stdout.split("\n")[0] ?? "");
  if (!head) throw new Error("nvidia-smi gave no GPU line");
  // loop: HOT-PATH-OK — a few compute processes, every GPU_POLL_MS only while a job runs and the window is shown
  // the full command line where /proc has it (Linux: Sonata runs as python, its script names it), else nvidia-smi's program name
  const processes: GpuProcess[] = parseApps(apps.stdout).map(({ pid, exe, usedMb }) => ({ pid, usedMb, name: processName(cmdline(pid) || exe), ours: isOurs(pid, ourPids) }));
  return { ...head, processes, at: Date.now() };
}

/**
 * The other programs using the card (their names), for the background TensorRT build's start: compute processes holding
 * OTHER_GPU_USER_MB or more that aren't this app's own. The app's own children count as ours: the queue's engine is
 * still quitting (its model in graphics memory) for a few seconds after the queue ends, exactly when a paused build
 * goes on, and was taken for another program (bug hunt 2026-10-26 P6: "corridorkey-engine is using the graphics card",
 * then a minute's wait).
 */
export async function otherGpuUsers(read: (ours: Set<number>) => Promise<GpuInfo> = readGpu, appPid: number = process.pid): Promise<string[]> {
  // loop: NOT-WORTH — a few compute processes, once per automatic start
  return (await read(new Set([appPid]))).processes.filter((p) => !p.ours && p.usedMb >= OTHER_GPU_USER_MB).map((p) => p.name);
}
