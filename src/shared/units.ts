// Units shown to people, one definition each (shared by the main process and the pages).

/** A byte count in decimal GB (10^9 bytes), as disks and downloads are sold and as `du --si` shows. */
export function gbBytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** A byte count in GiB (2^30 bytes), as graphics memory is counted (nvidia-smi's MiB, the engine's `*_gb` fields). */
export function gibBytes(bytes: number): string {
  return `${(bytes / 1073741824).toFixed(1)} GiB`;
}
