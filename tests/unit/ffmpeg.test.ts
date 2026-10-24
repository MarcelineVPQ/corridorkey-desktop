import { describe, expect, it } from "vitest";
import { checkFfmpeg, installFfmpeg, installPlan } from "../../electron/main/ffmpeg";

const ENCODERS = " V....D libx264              libx264 H.264\n V....D prores_ks            Apple ProRes (iCodec Pro)\n";
const runs = (answers: Record<string, string | Error>) => async (cmd: string) => {
  const a = answers[cmd];
  if (a === undefined || a instanceof Error) throw a ?? Object.assign(new Error("not found"), { code: "ENOENT" });
  return a;
};

describe("ffmpeg check", () => {
  it("is ok with ffprobe and both encoders", async () => {
    expect(await checkFfmpeg(runs({ ffprobe: "ffprobe version 8", ffmpeg: ENCODERS }))).toEqual({ ok: true, problem: null });
  });
  it("says it isn't installed", async () => {
    expect((await checkFfmpeg(runs({}))).problem).toBe("ffmpeg isn't installed (ffprobe not found)");
  });
  it("catches a build without libx264 (Fedora's ffmpeg-free)", async () => {
    const r = await checkFfmpeg(runs({ ffprobe: "x", ffmpeg: " V....D prores_ks  ProRes\n V....D libopenh264  OpenH264\n" }));
    expect(r).toEqual({ ok: false, problem: "This ffmpeg can't write libx264 (a build without it)" });
  });
});

describe("ffmpeg install", () => {
  it("installs with apt on Ubuntu, Kubuntu and Mint (ID_LIKE)", () => {
    expect(installPlan("ID=ubuntu\nID_LIKE=debian\n").argv).toEqual(["apt-get", "install", "-y", "ffmpeg"]);
    expect(installPlan('ID=linuxmint\nID_LIKE="ubuntu debian"\n').command).toBe("sudo apt install ffmpeg");
  });
  it("installs with pacman on Arch and its family", () => {
    expect(installPlan("ID=endeavouros\nID_LIKE=arch\n").argv).toEqual(["pacman", "-S", "--noconfirm", "--needed", "ffmpeg"]);
  });
  it("doesn't install Fedora's or openSUSE's H.264-less ffmpeg; says what to enable", () => {
    const f = installPlan("ID=fedora\n");
    expect(f.argv).toBeNull();
    expect(f.note).toContain("RPM Fusion");
    expect(installPlan('ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n').note).toContain("Packman");
  });
  it("falls back to plain advice on an unknown system", () => {
    expect(installPlan("")).toEqual({ command: "Install ffmpeg with your distribution's package manager", argv: null, note: null });
  });
  it("runs pkexec and turns its failures into words", async () => {
    const plan = installPlan("ID=ubuntu\n");
    const calls: string[][] = [];
    await installFfmpeg(plan, async (cmd, args) => {
      calls.push([cmd, ...args]);
      return "";
    });
    expect(calls).toEqual([["pkexec", "apt-get", "install", "-y", "ffmpeg"]]);
    await expect(installFfmpeg(plan, async () => Promise.reject(Object.assign(new Error(), { code: 126 })))).rejects.toThrow("the password prompt was cancelled");
    await expect(installFfmpeg(plan, async () => Promise.reject(Object.assign(new Error(), { code: "ENOENT" })))).rejects.toThrow(
      'pkexec isn\'t available: run "sudo apt install ffmpeg" in a terminal',
    );
    await expect(installFfmpeg(installPlan("ID=fedora\n"), async () => "")).rejects.toThrow("can't install");
  });
});
