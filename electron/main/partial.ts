// A job's results are written into a staging folder inside its output folder and moved into place only when the
// job succeeds (bug hunt 2026-10 E12, backlog row 19). So a failed, cancelled or crashed job removes exactly the
// files it had started (the staging folder holds nothing else), and results an earlier run left in the output
// folder survive it untouched: the engines write the same names, which used to overwrite them at once.
// The app does this, not the engine: a cancel kills the engine's process group, so the engine never gets to clean up,
// and the app does it the same way for every job.
// Every call here is async (fs/promises): output folders are the user's choice and often on a NAS, and a share that
// stops answering must not freeze the window (loop pass 2026-10-26, finding 2).
import { access, lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";

/** The staging folder's name inside an output folder (one job per output folder at a time: uniqueOutputDir). */
export const PARTIAL_DIR = ".corridorkey-partial";

export function stagingDir(outputDir: string): string {
  return join(outputDir, PARTIAL_DIR);
}

/** Before a run: makes the output folder (remembering whether this job made it) and clears what a crashed app left
 * in the staging folder (ours by name). The engine gets the staging folder as its output_dir. */
/** The background deletes still running (discard); discardsSettled() waits for them (tests; a quit deletes at once, discard `now`). */
const discarding = new Set<Promise<void>>();
export async function discardsSettled(): Promise<void> {
  // loop: SERIAL-REQUIRED — waits for the few deletes in flight [bounded: each is one folder's rm]
  await Promise.all([...discarding]);
}

/** A discarded staging folder's name while it is deleted in the background (hidden, ours by name). */
export const DISCARD_PREFIX = ".corridorkey-discarded-";

export async function prepare(outputDir: string): Promise<{ staging: string; madeOutputDir: boolean }> {
  // loop: NOT-WORTH — one async stat per job start
  const madeOutputDir = await access(outputDir).then(
    () => false,
    () => true,
  );
  const staging = stagingDir(outputDir);
  // loop: NOT-WORTH — one folder per job start (normally absent), async
  await rm(staging, { recursive: true, force: true });
  // a discarded job's files whose background delete didn't finish (the app quit meanwhile)
  try {
    // loop: NOT-WORTH — one async readdir per job start, then the rare leftovers
    for (const n of (await readdir(outputDir)).filter((x) => x.startsWith(DISCARD_PREFIX))) void rm(join(outputDir, n), { recursive: true, force: true });
  } catch {
    // error: NOT-WORTH — no output folder yet: nothing left over
  }
  // loop: NOT-WORTH — one async mkdir per job start
  await mkdir(staging, { recursive: true });
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
export async function promote(outputDir: string): Promise<{ moved: number; error: string | null }> {
  const staging = stagingDir(outputDir);
  let names: string[];
  try {
    // loop: NOT-WORTH — the staging folder's few entries (≤ four outputs + the settings file), once per job, async
    names = await readdir(staging);
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
        // loop: NOT-WORTH — one small text file per job, async
        const text = await readFile(from, "utf8");
        // loop: NOT-WORTH — one small text file per job, async
        await writeFile(from, text.split(staging).join(outputDir));
      }
      // loop: NOT-WORTH — one async lstat per entry
      const old = await lstat(to).catch(() => null);
      if (old?.isDirectory()) {
        const aside = join(staging, `.replaced-${name}`);
        // loop: NOT-WORTH — one async rename per replaced folder
        await rename(to, aside);
        // loop: NOT-WORTH — one async rename per entry
        await rename(from, to);
        // lifetime: OK — a background removal of the replaced folder; its failure leaves it for the next prepare()
        // loop: NOT-WORTH — one folder removal per replaced EXR output, once per job
        void rm(aside, { recursive: true, force: true })
          .then(() => removeStagingWhenEmpty(staging))
          .catch(() => {});
      } else {
        // a file is replaced in one rename
        // loop: NOT-WORTH — one async rename per entry
        await rename(from, to);
      }
      moved++;
    }
  } catch (e) {
    // error: SHOWN — the caller fails the job with this, the staging folder keeps what was not moved
    return { moved, error: String((e as Error).message) };
  }
  await removeStagingWhenEmpty(staging);
  return { moved, error: null };
}

// The staging folder goes once it is empty (a replaced folder still being removed keeps it: the removal calls this again).
async function removeStagingWhenEmpty(staging: string): Promise<void> {
  try {
    // loop: NOT-WORTH — one async rmdir per job; it fails while anything is in the folder
    await rmdir(staging);
  } catch {
    // error: NOT-WORTH — not empty yet, or already gone; a staging folder left behind is cleared by the next prepare()
  }
}

/** After a failure, cancel or crash: removes the staging folder (only this job's files) and the output folder too
 * when this job made it and it is left empty. Returns what the job's row says about it. `now`: the app quits, so the
 * delete runs before it returns (a background one would be cut short with the process). */
export async function discard(outputDir: string, madeOutputDir: boolean, now = false): Promise<string> {
  const staging = stagingDir(outputDir);
  let n = 0;
  try {
    // loop: NOT-WORTH — the staging folder's few entries, once per failed job, async
    n = (await readdir(staging)).filter((x) => !x.startsWith(".replaced-")).length;
  } catch {
    // error: NOT-WORTH — no staging folder: the engine never got to write
    n = 0;
  }
  // The folder is renamed aside at once (it leaves the output folder in one step) and deleted in the background: a
  // cancelled 4K EXR job holds thousands of frames, and deleting them here blocked the window (leak audit 2026-10-24, #11).
  const aside = join(outputDir, `${DISCARD_PREFIX}${Date.now()}`);
  try {
    // loop: NOT-WORTH — one async rename per failed job
    await rename(staging, aside);
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") {
      // error: SHOWN — the row names the folder and the reason
      return `Couldn't remove the files it had started in ${staging}: ${(e as Error).message}`;
    }
  }
  const removeMadeFolder = async () => {
    if (!madeOutputDir) return;
    try {
      // loop: NOT-WORTH — one async rmdir; it fails (and is left) when anything else is in the folder
      await rmdir(outputDir);
    } catch {
      // error: NOT-WORTH — the folder holds something else now: it stays
    }
  };
  const files = n === 1 ? "the 1 file it had started" : `the ${n} files it had started`;
  const said = n === 0 ? "It hadn't written any files." : `Removed ${files}; earlier results in the folder are untouched.`;
  if (now) {
    // the app quits: measured (bug hunt 2026-10-26 Q1), a background delete was cut short by the exit and left 1.7 GB of a
    // cancelled EXR job's frames hidden in the output folder; the quit waits for it instead (index.ts before-quit, async
    // with a deadline, so an output share that stopped answering can't hold the quit)
    try {
      // loop: NOT-WORTH — one delete at quit, awaited; ≤ 2 retries 50 ms apart [bounded: 2 retries; the quit's QUIT_CLEANUP_MS]
      await rm(aside, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      await removeMadeFolder();
    } catch (e) {
      // error: SHOWN — logged; prepare() removes a leftover aside folder at the next run into this folder
      console.error(`[partial] could not remove ${aside}:`, e);
    }
    return said;
  }
  // loop: NOT-WORTH — one background delete per failed job; ≤ 2 retries 50 ms apart for a file a killed engine was still
  // creating [bounded: 2 retries]
  const done = rm(aside, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
    .then(removeMadeFolder)
    // error: SHOWN — logged; prepare() removes a leftover aside folder at the next run into this folder
    .catch((e: unknown) => console.error(`[partial] could not remove ${aside}:`, e))
    .finally(() => discarding.delete(done));
  discarding.add(done);
  return said;
}
