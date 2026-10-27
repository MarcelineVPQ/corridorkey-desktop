// The Console's elevation (docs/CONSOLE.md, Source's sv_cheats model): a command that replaces or deletes files runs
// only as `sudo <command>`, and the first one asks in a native dialog naming the exact command and its targets. Then
// the session stays elevated for ELEVATION_TTL_MS; each elevated command extends it, never past ELEVATION_CAP_MS
// after the confirmation. Dropped by `sudo -k`, a screen lock, sleep, the time limit, quit and restart, never by
// the window losing focus (Alt+Tab to Nuke to judge an edge and back is the look-dev loop it exists for). Lives in memory only:
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

  /** Dropped (sudo -k, a screen lock, sleep, quit). True when it was active. */
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

/** What drops the elevation besides sudo -k, the time limit and quit: the screen locking, the computer sleeping. */
const DROPS: Readonly<Record<string, string>> = { "lock-screen": "the screen was locked", suspend: "the computer went to sleep" };

/** Wires the drops to Electron's powerMonitor (index.ts), or a test's emitter. */
export function dropOnLockAndSleep(monitor: { on(event: string, listener: () => void): unknown }, drop: (reason: string) => void): void {
  // lifetime: OK — two listeners for the app's life, on the app-wide power monitor
  // loop: NOT-WORTH — two events, once at start
  for (const [event, reason] of Object.entries(DROPS)) monitor.on(event, () => drop(reason));
}
