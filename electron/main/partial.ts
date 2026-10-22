// A job's results are written into a staging folder inside its output folder and moved into place only when the
// job succeeds (bug hunt 2026-10 E12, backlog row 19). So a failed, cancelled or crashed job removes exactly the
// files it had started (the staging folder holds nothing else), and results an earlier run left in the output
// folder survive it untouched: the engines write the same names, which used to overwrite them at once.
// The app does this, not the engine: a cancel kills the engine's process group, so the engine never gets to clean up,
// and both engines (Rust, PyTorch) get the same treatment.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, sep } from "node:path";

/** The staging folder's name inside an output folder (one job per output folder at a time: uniqueOutputDir). */
export const PARTIAL_DIR = ".corridorkey-partial";

export function stagingDir(outputDir: string): string {
  return join(outputDir, PARTIAL_DIR);
}

/** Before a run: makes the output folder (remembering whether this job made it) and clears what a crashed app left
 * in the staging folder (ours by name). The engine gets the staging folder as its output_dir. */
export function prepare(outputDir: string): { staging: string; madeOutputDir: boolean } {
  // loop: NOT-WORTH — one stat per job start
  const madeOutputDir = !existsSync(outputDir);
  const staging = stagingDir(outputDir);
  // loop: NOT-WORTH — one folder per job start (normally absent)
  rmSync(staging, { recursive: true, force: true });
  // loop: NOT-WORTH — one mkdir per job start
  mkdirSync(staging, { recursive: true });
  return { staging, madeOutputDir };
}

/** A path the engine reported inside the staging folder, as it is after the move. */
export function finalPath(outputDir: string, p: string): string {
  const s = stagingDir(outputDir);
  return p === s ? outputDir : p.startsWith(s + sep) ? join(outputDir, p.slice(s.length + 1)) : p;
}

/** After success: every entry of the staging folder replaces the same-named one in the output folder. A replaced
 * folder (an EXR sequence) is set aside and removed in the background, never in this (main) process's turn.
 * The settings file names the staging folder as its output directory: rewritten to the real one. */
export function promote(outputDir: string): { moved: number; error: string | null } {
  const staging = stagingDir(outputDir);
  let names: string[];
  try {
    // loop: NOT-WORTH — the staging folder's few entries (≤ four outputs + the settings file), once per job
    names = readdirSync(staging);
  } catch (e) {
    // error: SHOWN — the caller reports it on the job (nothing to move: an engine that wrote no file)
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { moved: 0, error: null } : { moved: 0, error: String((e as Error).message) };
  }
  let moved = 0;
  try {
    // loop: NOT-WORTH — ≤ five entries, once per finished job
    for (const name of names) {
      const from = join(staging, name);
      const to = join(outputDir, name);
      if (name.endsWith("_settings.txt")) {
        // loop: NOT-WORTH — one small text file per job
        const text = readFileSync(from, "utf8");
        // loop: NOT-WORTH — one small text file per job
        writeFileSync(from, text.split(staging).join(outputDir));
      }
      // loop: NOT-WORTH — one lstat per entry
      const old = lstatSync(to, { throwIfNoEntry: false });
      if (old?.isDirectory()) {
        const aside = join(staging, `.replaced-${name}`);
        // loop: NOT-WORTH — one rename per replaced folder
        renameSync(to, aside);
        // loop: NOT-WORTH — one rename per entry
        renameSync(from, to);
        // lifetime: OK — a background removal of the replaced folder; its failure leaves it for the next prepare()
        // loop: NOT-WORTH — one folder removal per replaced EXR output, once per job
        void rm(aside, { recursive: true, force: true })
          .then(() => removeStagingWhenEmpty(staging))
          .catch(() => {});
      } else {
        // a file is replaced in one rename
        // loop: NOT-WORTH — one rename per entry
        renameSync(from, to);
      }
      moved++;
    }
  } catch (e) {
    // error: SHOWN — the caller fails the job with this, the staging folder keeps what was not moved
    return { moved, error: String((e as Error).message) };
  }
  removeStagingWhenEmpty(staging);
  return { moved, error: null };
}

// The staging folder goes once it is empty (a replaced folder still being removed keeps it: the removal calls this again).
function removeStagingWhenEmpty(staging: string): void {
  try {
    // loop: NOT-WORTH — one rmdir per job; it fails while anything is in the folder
    rmdirSync(staging);
  } catch {
    // error: NOT-WORTH — not empty yet, or already gone; a staging folder left behind is cleared by the next prepare()
  }
}

/** After a failure, cancel or crash: removes the staging folder (only this job's files) and the output folder too
 * when this job made it and it is left empty. Returns what the job's row says about it. */
export function discard(outputDir: string, madeOutputDir: boolean): string {
  const staging = stagingDir(outputDir);
  let n = 0;
  try {
    // loop: NOT-WORTH — the staging folder's few entries, once per failed job
    n = readdirSync(staging).filter((x) => !x.startsWith(".replaced-")).length;
  } catch {
    // error: NOT-WORTH — no staging folder: the engine never got to write
    n = 0;
  }
  try {
    // loop: NOT-WORTH — removes one failed job's started files (a few videos or EXR folders) once; ≤ 2 retries 50 ms apart
    // for a file a killed engine's last syscall was still creating [bounded: 2 retries]
    rmSync(staging, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  } catch (e) {
    // error: SHOWN — the row names the folder and the reason
    return `Couldn't remove the files it had started in ${staging}: ${(e as Error).message}`;
  }
  if (madeOutputDir) {
    try {
      // loop: NOT-WORTH — one rmdir; it fails (and is left) when anything else is in the folder
      rmdirSync(outputDir);
    } catch {
      // error: NOT-WORTH — the folder holds something else now: it stays
    }
  }
  const files = n === 1 ? "the 1 file it had started" : `the ${n} files it had started`;
  return n === 0 ? "It hadn't written any files." : `Removed ${files}; earlier results in the folder are untouched.`;
}
