// The graphics card as nvidia-smi reports it: memory, load and every compute
// process with its name, so the app can say who else is using the card
// (rule 11). Read on demand only: at queue start and every GPU_POLL_MS while
// a job runs AND the window is shown. Nothing reads it while idle or hidden.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { GpuInfo, GpuProcess } from "../../src/shared/types";

const run = promisify(execFile);
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

/** Parse `--query-compute-apps=pid,used_memory --format=csv,noheader,nounits`. */
export function parseApps(text: string): { pid: number; usedMb: number }[] {
  return (
    text
      .split("\n")
      // loop: NOT-WORTH — a few compute processes, every GPU_POLL_MS while a job runs and the window is shown
      .map((l) => l.split(",").map((s) => s.trim()))
      .filter((p) => p.length >= 2 && Number.isFinite(Number(p[0])) && p[0] !== "")
      .map(([pid, used]) => ({ pid: Number(pid), usedMb: Number(used) || 0 }))
  );
}

/** A readable name for a process: Sonata and its engine by name, else the command's basename. */
export function processName(cmdline: string): string {
  const lower = cmdline.toLowerCase();
  if (/mount_sonata|sonata\.appimage/.test(lower)) return "Sonata";
  if (/sonata-align|sonata_align|sonata-engine/.test(lower)) return "Sonata's word timing";
  if (/ck_engine\.py/.test(lower)) return "CorridorKey engine";
  const first = cmdline.split("\0")[0] || cmdline;
  return first.split("/").pop() || "unknown";
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

export async function readGpu(ourPids: Set<number>): Promise<GpuInfo> {
  const [gpu, apps] = await Promise.all([
    // loop: HOT-PATH-OK — nvidia-smi every 2 s while a job runs and the window is shown; GPU_READ_TIMEOUT_MS 5 s and one read at a time (this pass)
    run("nvidia-smi", ["--query-gpu=name,memory.total,memory.used,utilization.gpu", "--format=csv,noheader,nounits"], { timeout: GPU_READ_TIMEOUT_MS }),
    // loop: HOT-PATH-OK — the same read's second query, same timeout
    run("nvidia-smi", ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"], { timeout: GPU_READ_TIMEOUT_MS }),
  ]);
  const head = parseGpuLine(gpu.stdout.split("\n")[0] ?? "");
  if (!head) throw new Error("nvidia-smi gave no GPU line");
  // loop: HOT-PATH-OK — a few compute processes, every GPU_POLL_MS only while a job runs and the window is shown
  const processes: GpuProcess[] = parseApps(apps.stdout).map(({ pid, usedMb }) => ({ pid, usedMb, name: processName(cmdline(pid)), ours: ourPids.has(pid) }));
  return { ...head, processes, at: Date.now() };
}
