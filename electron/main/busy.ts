// What the app is doing that a quit or a restart would cut short (review 2026-10-28 #4, #5): the restart into an update
// waits for it, and closing the window or quitting asks first. One list for both, so they can't drift apart.

export interface BusyState {
  queue: boolean;
  /** the Console's corridorkey has the graphics card */
  consoleGpu: boolean;
  /** the runtime / models / TensorRT download */
  download: boolean;
  /** the cache folder is moving (or starting fresh) */
  cacheMoving: boolean;
  /** the background TensorRT build (trtPrebuild.ts) */
  trtBuild: boolean;
}

/**
 * The work a quit would stop, in words (empty: nothing). The background TensorRT build isn't asked about: it goes on by
 * itself at the next start.
 */
export function runningWork(s: BusyState): string[] {
  const out: string[] = [];
  if (s.queue) out.push("the queue is running");
  if (s.consoleGpu) out.push("the Console is running corridorkey");
  if (s.download) out.push("a download is running");
  if (s.cacheMoving) out.push("the cache folder is moving");
  return out;
}

/** Why the restart into an update must wait (null: it can go): it would kill the work, or leave a cache move half done. */
export function restartRefusal(s: BusyState): string | null {
  if (s.queue) return "The queue is running: stop it or let it finish, then restart.";
  if (s.consoleGpu) return "The Console is running corridorkey: wait for it, or stop it (Ctrl+C in the Console), then restart.";
  if (s.download) return "A download is running: wait for it, or stop it, then restart.";
  if (s.cacheMoving) return "The cache folder is moving: wait for it, then restart.";
  if (s.trtBuild) return "TensorRT is building its engines in the background: wait for it to finish, then restart.";
  return null;
}

/** The question before a quit that would stop `work` (runningWork): Keep running is the default. */
export function quitQuestion(work: readonly string[]): { message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number } {
  const what = work.join(", ");
  return {
    message: "Quit while work is running?",
    detail: `${what.charAt(0).toUpperCase()}${what.slice(1)}. Quitting stops it: a running job's started frames are deleted.`,
    buttons: ["Keep running", "Quit anyway"],
    defaultId: 0,
    cancelId: 0,
  };
}

/** The answer's index that quits. */
export const QUIT_ANYWAY = 1;
