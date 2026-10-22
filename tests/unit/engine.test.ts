import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { EngineProcess, engineEnv } from "../../electron/main/engine";

function fakeChild(onLine: (line: string, out: PassThrough) => void): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr: new PassThrough(), pid: undefined });
  stdin.on("data", (b: Buffer) =>
    b
      .toString()
      .trim()
      .split("\n")
      .forEach((l) => onLine(l, stdout)),
  );
  return child;
}

const launch = { python: "/py", script: "/s.py", packageRoot: "/ck", env: {} };

describe("EngineProcess", () => {
  it("resolves the pong and forwards other replies", async () => {
    const replies: unknown[] = [];
    const p = new EngineProcess(
      launch,
      (r) => replies.push(r),
      () => {},
      () =>
        fakeChild((l, out) => {
          if (JSON.parse(l).cmd === "ping") out.write('{"type":"pong","protocol":1,"version":"0.1.0"}\n{"type":"log","text":"hi"}\n');
        }),
    );
    expect((await p.start()).version).toBe("0.1.0");
    await new Promise((r) => setTimeout(r, 10));
    expect(replies).toEqual([{ type: "log", text: "hi" }]);
  });

  it("refuses an engine with another protocol", async () => {
    const p = new EngineProcess(
      launch,
      () => {},
      () => {},
      () => fakeChild((_l, out) => out.write('{"type":"pong","protocol":9}\n')),
    );
    await expect(p.start()).rejects.toThrow(/protocol 9/);
  });

  it("strips variables that break a venv", () => {
    const env = engineEnv({ LD_LIBRARY_PATH: "/x", PYTHONPATH: "/y", HOME: "/h" });
    expect(env).toEqual({ HOME: "/h", PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" });
  });
});
