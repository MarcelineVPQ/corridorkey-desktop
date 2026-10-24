// Units shown to people, one definition each (shared by the main process and the pages).

/** A byte count in decimal GB (10^9 bytes), as disks and downloads are sold and as `du --si` shows. */
export function gbBytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}
