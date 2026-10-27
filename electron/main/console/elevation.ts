// The Console's elevation (docs/CONSOLE.md, Source's sv_cheats model): a command that replaces or deletes files runs
// only as `sudo <command>`, and the first one asks in a native dialog naming the exact command and its targets. Then
// the session stays elevated for ELEVATION_TTL_MS; each elevated command extends it, never past ELEVATION_CAP_MS
// after the confirmation. Dropped by `sudo -k`, a screen lock, sleep, the time limit, quit and restart, never by
// the window losing focus (Alt+Tab to Nuke to judge an edge and back is the look-dev loop it exists for), except on a
// Linux whose screen lock can't be read (LinuxLockWatch, below). Lives in memory only:
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

/**
 * Linux has no `lock-screen` event (Electron's powerMonitor: macOS and Windows only; senior review 2026-10-27 S1). While
 * the Console is elevated, logind's LockedHint (set by KDE's and GNOME's screen lockers) is read every LOCK_POLL_MS and a
 * locked screen drops the elevation. Where it can't be read (no systemd-logind, no busctl, not in a login session) the
 * window losing focus drops it instead: the look-dev loop then asks again, but a locked screen never stays elevated.
 */
export const LOCK_POLL_MS = 5_000;

/** busctl's answer for a boolean property ("b true"), or null when it isn't one. */
export function parseLockedHint(out: string): boolean | null {
  const m = /^b (true|false)$/.exec(out.trim());
  return m ? m[1] === "true" : null;
}

export class LinuxLockWatch {
  private timer: NodeJS.Timeout | null = null;
  /** the lock can't be read here: the window's blur drops the elevation instead */
  private blurDrops = false;

  /** `locked`: the session's LockedHint, or null when it can't be read; `active`: elevated now. */
  constructor(
    private readonly locked: () => Promise<boolean | null>,
    private readonly active: () => boolean,
    private readonly drop: (reason: string) => void,
  ) {}

  /** Once at start: can the lock be read here? */
  async probe(): Promise<void> {
    this.blurDrops = (await this.locked()) === null;
  }

  /** The session changed: read the lock while elevated, never otherwise. */
  update(): void {
    if (!this.active()) return this.stop();
    if (this.timer || this.blurDrops) return;
    // lifetime: OK — cleared when the elevation ends (update) or the lock can't be read
    // loop: NOT-WORTH — one busctl read every LOCK_POLL_MS, only while elevated [bounded: ELEVATION_CAP_MS]
    this.timer = setInterval(() => void this.poll(), LOCK_POLL_MS);
    this.timer.unref?.();
  }

  private async poll(): Promise<void> {
    if (!this.active()) return this.stop();
    const locked = await this.locked();
    if (locked === null) {
      this.blurDrops = true;
      this.stop();
    } else if (locked) this.drop("the screen was locked");
  }

  /** The window lost focus: drops the elevation only where the lock can't be read. */
  blur(): void {
    if (this.blurDrops && this.active()) this.drop("the window lost focus (this system's screen lock can't be read)");
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
