import { describe, expect, it } from "vitest";
import { gpuReadoutWanted, isOurs, otherGpuUsers, parentPid, parseApps, parseGpuLine, processName, readAmdGpu } from "../../electron/main/gpu";

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
    // backlog row 171 (NorthXL's GPU card): temperature, fan, clock and power, the line as this RTX 5080 gave it
    // (--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu,fan.speed,clocks.gr,power.draw)
    expect(parseGpuLine("NVIDIA GeForce RTX 5080, 16303, 7628, 0, 43, 30, 2662, 52.53")).toEqual({
      name: "NVIDIA GeForce RTX 5080",
      totalMb: 16303,
      usedMb: 7628,
      utilization: 0,
      tempC: 43,
      fanPct: 30,
      clockMhz: 2662,
      powerW: 52.53,
    });
    expect(parseApps("6534, /usr/bin/kwin_wayland, 96\n2428610, C:\\Program Files\\A, B\\app.exe, 2948\n")).toEqual([
      { pid: 6534, exe: "/usr/bin/kwin_wayland", usedMb: 96 },
      { pid: 2428610, exe: "C:\\Program Files\\A, B\\app.exe", usedMb: 2948 },
    ]);
    // Windows has no /proc: the name comes from nvidia-smi's path
    expect(processName("C:\\Program Files\\Blender\\blender.exe")).toBe("blender.exe");
  });
  it("leaves out what the card doesn't report, never a 0 (a laptop has no fan reading, older cards no power)", () => {
    const g = parseGpuLine("NVIDIA GeForce RTX 4060 Laptop GPU, 8188, 512, 3, 51, [N/A], 1470, [Not Supported]")!;
    expect(g).toMatchObject({ tempC: 51, clockMhz: 1470 });
    expect("fanPct" in g).toBe(false);
    expect("powerW" in g).toBe(false);
    // an older driver's four-field line still reads
    expect(Object.keys(parseGpuLine("GPU, 100, 50, 7")!).sort()).toEqual(["name", "totalMb", "usedMb", "utilization"]);
  });
  it("names Sonata and its engine", () => {
    expect(processName("/tmp/.mount_SonataXy/sonata\0--x")).toBe("Sonata");
    expect(processName("/home/u/.local/share/sonata-align/venv/bin/python\0server.py")).toBe("Sonata's word timing");
    expect(processName("/usr/bin/blender\0-b")).toBe("blender");
  });
});

// Marcy 2026-10-27: the Engine page showed other programs' whole command lines (Chromium rewrites its /proc cmdline
// into one space-separated string, so the first NUL-separated part held every argument and the home path)
describe("other programs' names leak nothing", () => {
  const leaks = [
    [
      "/opt/Mullvad VPN/mullvad-gui --type=gpu-process --user-data-dir=/home/someone/.config/Mullvad VPN --gpu-preferences=WAAAAAAAAAAgAAAEAAAAAAAAAAAAAAAAAABgAAEAAAA4AAAAAAAAAAAAAAAEAAAAAAAAABAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAACAAAAAAAAAA= --shared-files --field-trial-handle=3,i,1\0\0\0",
      "mullvad-gui",
    ],
    [
      "/tmp/.mount_ds5dXyZ12/ds5-dongle-configurator --type=gpu-process --enable-crash-reporter=abc,production --user-data-dir=/home/someone/.config/ds5-dongle-configurator --ozone-platform=wayland",
      "ds5-dongle-configurator",
    ],
    ["/tmp/.mount_ds5dXyZ12/ds5-dongle-configurator\0--type=gpu-process\0--user-data-dir=/home/someone/.config/ds5\0", "ds5-dongle-configurator"],
  ];
  it.each(leaks)("names %s by its program alone", (cmdline, name) => {
    const shown = processName(cmdline);
    expect(shown).toBe(name);
    expect(shown).not.toMatch(/[\\/\s]|--|home/);
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

// backlog row 166 (the CK_AMD switch): an AMD card has no nvidia-smi; the amdgpu driver's sysfs files
describe("the AMD card's readout", () => {
  const dev = "/sys/class/drm/renderD128/device";
  const files = (extra: Record<string, string> = {}) => {
    const f: Record<string, string> = { [`${dev}/mem_info_vram_total`]: "25753026560\n", [`${dev}/mem_info_vram_used`]: "1073741824\n", [`${dev}/gpu_busy_percent`]: "37\n", ...extra };
    return (p: string) => {
      if (!(p in f)) throw new Error("ENOENT");
      return f[p];
    };
  };
  it("reads memory and load from the driver, names the card by its gfx target or product name", () => {
    expect(readAmdGpu({ gfx: "gfx1100", minor: 128 }, files())).toMatchObject({ name: "AMD gfx1100", totalMb: 24560, usedMb: 1024, utilization: 37, processes: [] });
    expect(readAmdGpu({ gfx: "gfx942", minor: 128 }, files({ [`${dev}/product_name`]: "AMD Instinct MI300X\n" })).name).toBe("AMD Instinct MI300X (gfx942)");
  });
  // the amdgpu driver's hwmon files (docs.kernel.org/gpu/amdgpu/thermal.html): temp1_input m°C, pwm1 of pwm1_max,
  // freq1_input Hz (the gfx clock), power1_average µW (power1_input where the card has no average)
  const hw = `${dev}/hwmon/hwmon3`;
  const ls = (p: string) => {
    if (p !== `${dev}/hwmon`) throw new Error("ENOENT");
    return ["hwmon3"];
  };
  it("reads temperature, fan, clock and power from the driver's hwmon files", () => {
    const sensors = { [`${hw}/temp1_input`]: "48000\n", [`${hw}/pwm1`]: "77\n", [`${hw}/pwm1_max`]: "255\n", [`${hw}/freq1_input`]: "2482000000\n", [`${hw}/power1_average`]: "212000000\n" };
    expect(readAmdGpu({ gfx: "gfx1100", minor: 128 }, files(sensors), ls)).toMatchObject({ tempC: 48, fanPct: 30, clockMhz: 2482, powerW: 212 });
    const input = { [`${hw}/power1_input`]: "95500000\n" };
    expect(readAmdGpu({ gfx: "gfx1100", minor: 128 }, files(input), ls).powerW).toBe(95.5);
  });
  it("leaves out each sensor the card doesn't have (no hwmon folder: memory and load only)", () => {
    const g = readAmdGpu({ gfx: "gfx1100", minor: 128 }, files({ [`${hw}/temp1_input`]: "51000\n" }), ls);
    expect(g.tempC).toBe(51);
    // loop: NOT-WORTH — three keys in a test
    for (const k of ["fanPct", "clockMhz", "powerW"]) expect(k in g).toBe(false);
    const none = readAmdGpu({ gfx: "gfx1100", minor: 128 }, files(), () => {
      throw new Error("ENOENT");
    });
    // loop: NOT-WORTH — four keys in a test
    for (const k of ["tempC", "fanPct", "clockMhz", "powerW"]) expect(k in none).toBe(false);
  });
  it("says so when the driver's files aren't there", () => {
    expect(() => readAmdGpu({ gfx: "gfx1100", minor: 129 }, files())).toThrow();
  });
});

// rule 11 (share the machine): the readout is read only while a job runs AND the window is shown; never on a Mac
// (no nvidia-smi or amdgpu files there)
describe("when the graphics card is read", () => {
  it.each([
    [true, true, false, true],
    [false, true, false, false],
    [true, false, false, false],
    [false, false, false, false],
    [true, true, true, false],
  ])("shown %s, job running %s, Mac %s: read %s", (shown, running, mac, want) => {
    expect(gpuReadoutWanted({ shown, running, mac })).toBe(want);
  });
});
