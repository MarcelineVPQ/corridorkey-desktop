// The Console's elevation (docs/CONSOLE.md, Source's sv_cheats model): a command that replaces or deletes files runs
// only as `sudo <command>`, and the first one asks in a native dialog naming the exact command and its targets. Then
// the session stays elevated for ELEVATION_TTL_MS; each elevated command extends it, never past ELEVATION_CAP_MS
// after the confirmation. Dropped by `sudo -k`, the window losing focus, quit and restart. Lives in memory only:
// nothing here is ever written to disk (the audit log records what happened, never the state).
export const ELEVATION_TTL_MS = 5 * 60_000;
export const ELEVATION_CAP_MS = 15 * 60_000;

export class Elevation {
  private grantedAt: number | null = null;
  private until = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** The confirmation was given: elevated from now. */
  grant(): void {
    this.grantedAt = this.now();
    this.until = this.grantedAt + ELEVATION_TTL_MS;
  }

  /** Elevated now? (Expired: dropped.) */
  get active(): boolean {
    if (this.grantedAt === null) return false;
    if (this.now() < this.until) return true;
    this.grantedAt = null;
    return false;
  }

  /** An elevated command ran: another TTL from now, capped. */
  extend(): void {
    if (!this.active) return;
    this.until = Math.min(this.now() + ELEVATION_TTL_MS, this.grantedAt! + ELEVATION_CAP_MS);
  }

  /** Dropped (sudo -k, blur, quit). True when it was active. */
  drop(): boolean {
    const was = this.active;
    this.grantedAt = null;
    return was;
  }

  /** When it ends (ms since the epoch), or null when not elevated. */
  get expiresAt(): number | null {
    return this.active ? this.until : null;
  }
}
