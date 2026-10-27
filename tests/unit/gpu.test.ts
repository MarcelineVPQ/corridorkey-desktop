import { describe, expect, it } from "vitest";
import { isOurs, otherGpuUsers, parentPid, parseApps, parseGpuLine, processName } from "../../electron/main/gpu";

describe("the app's own GPU processes", () => {
  it("counts the TensorRT builder the engine started as ours, not as another program", () => {
    // /proc/<pid>/stat as Linux writes it: pid (comm) state ppid …; a name may hold spaces and parentheses
    const stats: Record<number, string> = { 1961206: "1961206 (ck-trt-build) R 1958754 1958754 1909457 0 -1", 777: "777 (my (odd) app) S 1 777 777", 888: "" };
    const stat = (pid: number) => stats[pid] ?? "";
    expect(parentPid(stats[777])).toBe(1);
    const engine = new Set([1958754]);
    expect(isOurs(1958754, engine, stat)).toBe(true);
    expect(isOurs(1961206, engine, stat)).toBe(true);
    expect(isOurs(777, engine, stat)).toBe(false);
    expect(isOurs(888, engine, stat)).toBe(false);
    expect(isOurs(1961206, new Set(), stat)).toBe(false);
  });
});

describe("nvidia-smi parsing", () => {
  it("reads the GPU line and the compute apps", () => {
    expect(parseGpuLine("NVIDIA GeForce RTX 5080, 16303, 2214, 7")).toEqual({ name: "NVIDIA GeForce RTX 5080", totalMb: 16303, usedMb: 2214, utilization: 7 });
    expect(parseGpuLine("garbage")).toBeNull();
    expect(parseApps("6534, /usr/bin/kwin_wayland, 96\n2428610, C:\\Program Files\\A, B\\app.exe, 2948\n")).toEqual([
      { pid: 6534, exe: "/usr/bin/kwin_wayland", usedMb: 96 },
      { pid: 2428610, exe: "C:\\Program Files\\A, B\\app.exe", usedMb: 2948 },
    ]);
    // Windows has no /proc: the name comes from nvidia-smi's path
    expect(processName("C:\\Program Files\\Blender\\blender.exe")).toBe("blender.exe");
  });
  it("names Sonata and its engine", () => {
    expect(processName("/tmp/.mount_SonataXy/sonata\0--x")).toBe("Sonata");
    expect(processName("/home/u/.local/share/sonata-align/venv/bin/python\0server.py")).toBe("Sonata's word timing");
    expect(processName("/usr/bin/blender\0-b")).toBe("blender");
  });
});

// bug hunt 2026-10-26 P6 (measured in an isolated copy: a paused build resumed at the queue's end was "blocked" by
// "corridorkey-engine is using the graphics card", the queue's own engine still quitting, then waited a minute)
describe("other programs on the card, for the background TensorRT build", () => {
  it("leaves out the app's own processes (its quitting engine) and small users", async () => {
    let asked: Set<number> | null = null;
    const read = async (ours: Set<number>) => {
      asked = ours;
      const procs = [
        { pid: 50, name: "corridorkey-engine", usedMb: 9000, parent: 4242 },
        { pid: 60, name: "Sonata's word timing", usedMb: 2100, parent: 1 },
        { pid: 70, name: "firefox", usedMb: 90, parent: 1 },
      ];
      // loop: NOT-WORTH — three processes in a test
      return {
        name: "GPU",
        totalMb: 16303,
        usedMb: 11000,
        utilization: 0,
        at: 0,
        processes: procs.map((p) => ({ pid: p.pid, name: p.name, usedMb: p.usedMb, ours: isOurs(p.pid, ours, () => `${p.pid} (x) S ${p.parent} `) })),
      };
    };
    expect(await otherGpuUsers(read, 4242)).toEqual(["Sonata's word timing"]);
    expect([...asked!]).toEqual([4242]);
  });
});
