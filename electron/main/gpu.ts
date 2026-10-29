// The graphics card as nvidia-smi reports it: memory, load and every compute
// process with its name, so the app can say who else is using the card
// (rule 11). Read on demand only: at queue start and every GPU_POLL_MS while
// a job runs AND the window is shown. Nothing reads it while idle or hidden.
import { readdirSync, readFileSync } from "node:fs";
import { run } from "./run";
import { OTHER_GPU_USER_MB, type GpuInfo, type GpuProcess } from "../../src/shared/types";

export const GPU_POLL_MS = 2000;
// nvidia-smi answers in ~50 ms; a driver in trouble can hang it: the read gives up (and says so) instead.
export const GPU_READ_TIMEOUT_MS = 5000;
/** How long taking the card waits for the engines it stopped to exit (a killed process ends in milliseconds). */
export const GPU_RELEASE_MS = 5000;

/**
 * Resolves once `ending()` is false (the engines stopped for the Console's corridorkey have exited, so their graphics
 * memory is free; senior review 2026-10-26 N9), or after `maxMs`.
 */
export async function untilEnded(ending: () => boolean, maxMs = GPU_RELEASE_MS, stepMs = 50): Promise<void> {
  const end = Date.now() + maxMs;
  // loop: SERIAL-REQUIRED — a look every 50 ms at the stopped engines, once per Console command that uses the card [bounded: maxMs]
  while (ending() && Date.now() < end) await new Promise((r) => setTimeout(r, stepMs));
}

/** The query: the card, its memory and load, then NorthXL's GPU card readings (backlog row 171). */
export const GPU_QUERY = "name,memory.total,memory.used,utilization.gpu,temperature.gpu,fan.speed,clocks.gr,power.draw";

/** A reading that is a number, else left out: nvidia-smi says "[N/A]" or "[Not Supported]" for what a card lacks. */
const num = (s: string | undefined): number | undefined => (s && s.trim() !== "" && Number.isFinite(Number(s)) ? Number(s) : undefined);

/** Only the readings there are: a missing one is left out of the object, never a 0. */
type Readings = Pick<GpuInfo, "tempC" | "fanPct" | "clockMhz" | "powerW">;
function present(r: Readings): Readings {
  // loop: NOT-WORTH — four readings, every GPU_POLL_MS while a job runs and the window is shown
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined));
}

/** Parse `nvidia-smi --query-gpu=${GPU_QUERY} --format=csv,noheader,nounits` (an older four-field line still reads). */
export function parseGpuLine(line: string): Omit<GpuInfo, "processes" | "at"> | null {
  // loop: NOT-WORTH — eight fields, every GPU_POLL_MS while a job runs and the window is shown
  const parts = line.split(",").map((s) => s.trim());
  if (parts.length < 4) return null;
  const [name, total, used, util, temp, fan, clock, power] = parts;
  if (!Number.isFinite(Number(total))) return null;
  return { name, totalMb: Number(total), usedMb: Number(used), utilization: Number(util) || 0, ...present({ tempC: num(temp), fanPct: num(fan), clockMhz: num(clock), powerW: num(power) }) };
}

/** Rule 11: the card is read only while a job runs AND the window is shown, and never on a Mac (no nvidia-smi there). */
export function gpuReadoutWanted(s: { shown: boolean; running: boolean; mac: boolean }): boolean {
  return s.shown && s.running && !s.mac;
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
    run("nvidia-smi", [`--query-gpu=${GPU_QUERY}`, "--format=csv,noheader,nounits"], { timeout: GPU_READ_TIMEOUT_MS }),
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
 * AMD (the CK_AMD switch; docs/AMD.md): the card's memory and load from the amdgpu driver's sysfs files (what amd-smi
 * reads: mem_info_vram_total / _used, gpu_busy_percent), its name from product_name where the board has one. NorthXL's
 * readings (backlog row 171) from the driver's hwmon folder (docs.kernel.org/gpu/amdgpu/thermal.html): temp1_input
 * (m°C), pwm1 of pwm1_max (the fan level), freq1_input (the gfx clock, Hz), power1_average (µW; power1_input where the
 * card has no average); each one the card lacks is left out. No per-program list yet (the driver keeps it per process
 * in /proc/<pid>/fdinfo): `processes` stays empty.
 */
// loop: HOT-PATH-OK — up to eleven small sysfs reads (sync, microseconds), every GPU_POLL_MS only while a job runs and the window is shown
export function readAmdGpu(card: { gfx: string; minor: number }, read: (p: string) => string = (p) => readFileSync(p, "utf8"), ls: (p: string) => string[] = (p) => readdirSync(p)): GpuInfo {
  const dev = `/sys/class/drm/renderD${card.minor}/device`;
  const mib = (f: string) => {
    // loop: HOT-PATH-OK — one small sysfs read per value, every GPU_POLL_MS only while a job runs and the window is shown
    const n = Number(read(`${dev}/${f}`).trim());
    if (!Number.isFinite(n)) throw new Error(`the amdgpu driver's ${f} gave no number`);
    return Math.round(n / 2 ** 20);
  };
  let name = `AMD ${card.gfx}`;
  try {
    // loop: HOT-PATH-OK — as above
    const product = read(`${dev}/product_name`).trim();
    if (product) name = `${product} (${card.gfx})`;
  } catch {
    // error: NOT-WORTH — most Radeon boards have no product_name: the gfx target names the card
  }
  // loop: HOT-PATH-OK — as above
  const busy = Number(read(`${dev}/gpu_busy_percent`).trim());
  return { name, totalMb: mib("mem_info_vram_total"), usedMb: mib("mem_info_vram_used"), utilization: Number.isFinite(busy) ? busy : 0, ...amdSensors(dev, read, ls), processes: [], at: Date.now() };
}

/** The hwmon readings, each left out where its file isn't there or gives no number. */
function amdSensors(dev: string, read: (p: string) => string, ls: (p: string) => string[]): Readings {
  let hw: string | undefined;
  try {
    // loop: HOT-PATH-OK — one sysfs folder listing (one entry), every GPU_POLL_MS only while a job runs and the window is shown
    hw = ls(`${dev}/hwmon`).find((d) => d.startsWith("hwmon"));
  } catch {
    // error: NOT-WORTH — no hwmon folder: memory and load only, the other readings left out
  }
  if (!hw) return {};
  const at = (f: string) => {
    try {
      // loop: HOT-PATH-OK — one small sysfs read per reading, as above
      return num(read(`${dev}/hwmon/${hw}/${f}`).trim());
    } catch {
      // error: NOT-WORTH — the card has no such sensor: that reading is left out
      return undefined;
    }
  };
  const temp = at("temp1_input");
  const pwm = at("pwm1");
  const pwmMax = at("pwm1_max");
  const freq = at("freq1_input");
  const power = at("power1_average") ?? at("power1_input");
  return present({
    tempC: temp === undefined ? undefined : temp / 1000,
    fanPct: pwm === undefined || !pwmMax ? undefined : Math.round((pwm / pwmMax) * 100),
    clockMhz: freq === undefined ? undefined : Math.round(freq / 1e6),
    powerW: power === undefined ? undefined : power / 1e6,
  });
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
