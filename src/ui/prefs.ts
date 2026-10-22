// Per-viewer UI conveniences (rail pin/lock, which panel is shown, which
// sections are pinned) in localStorage. Every read and write is guarded: a
// private window or blocked storage just means the defaults.
import { useCallback, useState } from "react";

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    // error: NOT-WORTH — storage unavailable or a bad value: the default
    return fallback;
  }
}

export function writePref<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // error: NOT-WORTH — storage unavailable: the choice lasts until the window closes
  }
}

/** A remembered value: state + a setter that also stores it. */
export function usePref<T>(key: string, fallback: T): [T, (v: T | ((old: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readPref(key, fallback));
  const set = useCallback(
    (v: T | ((old: T) => T)) =>
      setValue((old) => {
        const next = typeof v === "function" ? (v as (old: T) => T)(old) : v;
        writePref(key, next);
        return next;
      }),
    [key],
  );
  return [value, set];
}
