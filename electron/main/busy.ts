// What the app is doing that a restart would cut short (review 2026-10-28 #4): the restart into an update waits for it.

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

/** Why the restart into an update must wait (null: it can go): it would kill the work, or leave a cache move half done. */
export function restartRefusal(s: BusyState): string | null {
  if (s.queue) return "The queue is running: stop it or let it finish, then restart.";
  if (s.consoleGpu) return "The Console is running corridorkey: wait for it, or stop it (Ctrl+C in the Console), then restart.";
  if (s.download) return "A download is running: wait for it, or stop it, then restart.";
  if (s.cacheMoving) return "The cache folder is moving: wait for it, then restart.";
  if (s.trtBuild) return "TensorRT is building its engines in the background: wait for it to finish, then restart.";
  return null;
}
