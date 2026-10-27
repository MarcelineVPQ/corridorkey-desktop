// The computer stays awake while the queue or the Console's corridorkey runs. Measured on the Mac mini (2026-10-27):
// with no power assertion held, macOS put the Mac to sleep in the middle of Core ML work and a 0.08 s network call took
// 300 s (the sleep's length). "prevent-app-suspension" keeps the system awake (the display may still sleep); it is
// released when neither runs.

/** Electron's powerSaveBlocker, as this uses it. */
export interface PowerBlocker {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): unknown;
}

/**
 * A function to call with each holder's running state ("queue", "console"): one blocker while any of them runs, none
 * otherwise.
 */
export function keepAwakeWhile(blocker: PowerBlocker): (holder: string, running: boolean) => void {
  const holders = new Set<string>();
  let id: number | null = null;
  return (holder, running) => {
    if (running) holders.add(holder);
    else holders.delete(holder);
    if (holders.size > 0 && id === null) id = blocker.start("prevent-app-suspension");
    else if (holders.size === 0 && id !== null) {
      blocker.stop(id);
      id = null;
    }
  };
}
