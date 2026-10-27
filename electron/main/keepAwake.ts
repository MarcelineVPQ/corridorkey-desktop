// The computer stays awake while the queue runs. Measured on the Mac mini (2026-10-27): with no power assertion held,
// macOS put the Mac to sleep in the middle of Core ML work and a 0.08 s network call took 300 s (the sleep's length).
// "prevent-app-suspension" keeps the system awake (the display may still sleep); it is released when the queue stops.

/** Electron's powerSaveBlocker, as this uses it. */
export interface PowerBlocker {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): unknown;
}

/** A function to call with the queue's running state: holds one blocker while it runs, none otherwise. */
export function keepAwakeWhile(blocker: PowerBlocker): (running: boolean) => void {
  let id: number | null = null;
  return (running) => {
    if (running && id === null) id = blocker.start("prevent-app-suspension");
    else if (!running && id !== null) {
      blocker.stop(id);
      id = null;
    }
  };
}
