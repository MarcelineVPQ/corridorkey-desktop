// Running a program and reading its output, the one way the main process does it for short checks (ffprobe,
// ffmpeg stills, nvidia-smi): a timeout, a buffer limit, and windowsHide (on Windows a console program started
// from the app would flash a terminal window). The de-duplication pass 2026-10-24 found this copied in media.ts
// and gpu.ts.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Run `cmd` with `args`; resolves with its stdout/stderr text, rejects on a non-zero exit or the timeout. */
export const run = (cmd: string, args: string[], opts: { timeout?: number; maxBuffer?: number }) => execFileP(cmd, args, { ...opts, windowsHide: true, encoding: "utf8" });
