import { describe, expect, it } from "vitest";
import { isOurs, parentPid, parseApps, parseGpuLine, processName } from "../../electron/main/gpu";
import { checkCheckout } from "../../electron/main/settings";

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

describe("checkCheckout", () => {
  it("lists exactly what is missing", () => {
    const have = new Set(["/ck/corridorkey/runtime.py", "/ck/venv/bin/python"]);
    const r = checkCheckout("/ck", (p) => have.has(p));
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(3);
    expect(checkCheckout(null).problems[0]).toMatch(/Choose/);
  });
});
