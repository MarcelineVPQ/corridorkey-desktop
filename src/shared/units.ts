// Units shown to people, one definition each (shared by the main process and the pages).

/** A byte count in decimal GB (10^9 bytes), as disks and downloads are sold and as `du --si` shows. */
export function gbBytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** A byte count in GiB (2^30 bytes), as graphics memory is counted (nvidia-smi's MiB, the engine's `*_gb` fields). */
export function gibBytes(bytes: number): string {
  return `${(bytes / 1073741824).toFixed(1)} GiB`;
}

/** A smaller byte count in decimal MB below 1 GB, else as gbBytes (the cache's sizes per clip: stills are KB to MB). */
export function mbOrGbBytes(bytes: number): string {
  return bytes < 1e9 ? `${(bytes / 1e6).toFixed(1)} MB` : gbBytes(bytes);
}

/** A file's size in a listing (1 KiB = 1024 bytes, as the file managers show it); null: unknown ("?"). */
export function fileSizeText(bytes: number | null): string {
  if (bytes === null) return "?";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = bytes / 1024;
  let u = 0;
  // loop: NOT-WORTH — at most three steps
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}
