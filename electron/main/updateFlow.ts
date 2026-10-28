// The self-update flow, free of Electron (network, files, relaunch and the
// running AppImage are passed in) so vitest drives a whole update against a
// local signed test feed (tests/unit/updateFlow.test.ts). updater.ts binds it
// to Electron. Ported from Marcy's DS5 app (electron/main/updater.ts) and
// Sonata (updater.js):
//
//   check -> "X is available" -> download (progress) -> verified + installed
//   beside the running AppImage -> "Restart now" (the main process gates it
//   while the queue runs) -> the new version.
//
// Rules:
// - Nothing installs before the feed's Ed25519 signature checks out, then the
//   download's size and SHA-512 (updateFeed.ts, download.ts); a mismatch
//   deletes the download and says so. Every failure is shown verbatim.
// - Never a downgrade, except Back to stable: from the Development channel,
//   the newest stable release is offered even when it is older than this build.
//   The offer stays until it is installed or Development is picked again.
// - Never interrupts work: the update installs beside the running AppImage
//   (as CorridorKey-Desktop-X.AppImage, never over the running file: it is
//   FUSE-mounted, SIGBUS) and starts on the next start or on restart().
//   CorridorKey-Desktop.AppImage, a symlink, is repointed at it. The previous
//   version stays beside it for rollback; older ones the updater installed
//   (recorded in the prefs file) are pruned at start, never a copy the user put there.
// - Check automatically off = nothing online on its own: no timer, no check
//   at start, none on a channel switch; only check(true) goes online.
import { basename, dirname, join } from "node:path";
import type { UpdateChannel, UpdateState } from "../../src/shared/types";
import { lowerFirst, NO_RELEASE_CHANNEL } from "../../src/shared/texts";
import { downloadVerified, type FetchFn } from "./download";
import { CHECK_EVERY_MS, downloadAllowed, feedSignedBy, FIRST_CHECK_MS, freshUrl, offers, parseFeed, STABLE_LINK, staleFiles, type Feed, type FeedSource } from "./updateFeed";
import { loadUpdatePrefs, saveUpdatePrefs } from "./updatePrefs";

export interface FileOps {
  readdir(dir: string): string[];
  rm(path: string): void;
  chmod(path: string, mode: number): void;
  rename(from: string, to: string): void;
  exists(path: string): boolean;
  // "link": a symlink; "file": anything else; null: nothing there
  kind(path: string): "link" | "file" | null;
  symlink(target: string, path: string): void;
}

export interface UpdatePlatform {
  version: string;
  source: FeedSource;
  // The running AppImage's real (versioned) path, or null.
  appImage: string | null;
  // Why this copy can't update itself (shown as is), or null.
  unsupported: string | null;
  prefsFile: string;
  // One GET; rejects only when the server can't be reached.
  fetchText(url: string, fresh: boolean): Promise<{ status: number; text: string }>;
  fetch: FetchFn;
  fs: FileOps;
  // Start `target` cleanly and quit this copy.
  relaunch(target: string): void;
  now(): number;
  log(message: string): void;
}

export const PROGRESS_EVERY_MS = 250;

export class UpdateFlow {
  state: UpdateState;
  // cache: OK — key=channel (offerChannel); invalidated=each check, a channel switch; bound=1 entry (the feed the offer on screen came from)
  private offer: Feed | null = null;
  private offerChannel: UpdateChannel | null = null;
  private returningToStable = false;
  // Each check's number: only the newest check's answer is used.
  private checkSeq = 0;
  private inflight: Promise<void> | null = null;
  private installed: string | null = null;
  // the AppImages this updater installed (full paths, kept in the prefs file): the only ones prune() removes
  private installedFiles: string[];
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private everyTimer: ReturnType<typeof setInterval> | null = null;
  private abort: AbortController | null = null;
  private lastProgress = 0;

  constructor(
    private readonly p: UpdatePlatform,
    private readonly changed: () => void,
  ) {
    const prefs = loadUpdatePrefs(p.prefsFile, p.version);
    this.state = {
      feed: null,
      channel: prefs.channel,
      automatic: prefs.automatic,
      status: p.unsupported ? "unsupported" : "idle",
      current: p.version,
      latest: null,
      notes: null,
      progress: null,
      error: p.unsupported,
      checkedAt: null,
    };
    this.state.feed = this.feedUrl(prefs.channel);
    this.installedFiles = prefs.installed;
  }

  private feedUrl(channel: UpdateChannel): string | null {
    return this.p.source.keys.length ? this.p.source.urls[channel] : null;
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.changed();
  }

  private persist(): void {
    try {
      saveUpdatePrefs(this.p.prefsFile, { channel: this.state.channel, automatic: this.state.automatic, installed: this.installedFiles });
    } catch (e) {
      // error: LOGGED-OK — the choice holds for this run; logged with the reason it couldn't be kept
      this.p.log(`update settings could not be saved: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  start(): void {
    if (this.state.status === "unsupported") return;
    this.prune();
    this.schedule();
  }

  stop(): void {
    this.unschedule();
    this.abort?.abort();
  }

  private schedule(): void {
    this.unschedule();
    if (!this.state.automatic || this.state.status === "unsupported") return;
    // lifetime: OK — fires once; cleared by stop(), setAutomatic(false)
    // loop: NOT-WORTH — the first update check, once per start
    this.firstTimer = setTimeout(() => {
      this.firstTimer = null;
      void this.check(false);
    }, FIRST_CHECK_MS);
    // lifetime: OK — cleared by stop(), setAutomatic(false)
    // loop: NOT-WORTH — one feed check every 2 hours, only with Check automatically on
    this.everyTimer = setInterval(() => void this.check(false), CHECK_EVERY_MS);
  }

  private unschedule(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.everyTimer) clearInterval(this.everyTimer);
    this.firstTimer = null;
    this.everyTimer = null;
  }

  // Leftovers of this updater beside the running AppImage: cut-short downloads
  // and versions older than the previous one (local files only, no network).
  private prune(): void {
    const running = this.p.appImage;
    if (!running) return;
    try {
      const dir = dirname(running);
      // loop: NOT-WORTH — a few recorded AppImages, once at start
      const ours = this.installedFiles.filter((f) => dirname(f) === dir).map((f) => basename(f));
      // loop: NOT-WORTH — a few stale files, once at start
      for (const name of staleFiles(this.p.fs.readdir(dir), basename(running), this.p.version, ours)) {
        try {
          this.p.fs.rm(join(dir, name));
        } catch {
          // error: NOT-WORTH — not removable now: tried again next start
        }
      }
    } catch {
      // error: NOT-WORTH — folder unreadable: nothing pruned; updates still work
    }
    // the record keeps what is still there (a download cut short keeps its name while its .part is left)
    // loop: NOT-WORTH — a few recorded AppImages, once at start
    const kept = this.installedFiles.filter((f) => this.p.fs.exists(f) || this.p.fs.exists(`${f}.part`));
    if (kept.length !== this.installedFiles.length) {
      this.installedFiles = kept;
      this.persist();
    }
  }

  private busy(): boolean {
    return this.state.status === "checking" || this.state.status === "downloading" || this.state.status === "ready";
  }

  // A check while one runs shares its answer.
  check(asked: boolean): Promise<void> {
    if (this.state.status === "checking" && this.inflight) return this.inflight;
    if (this.state.status === "unsupported" || this.busy()) return Promise.resolve();
    const run = this.runCheck(asked);
    this.inflight = run;
    // error: NOT-WORTH — runCheck never rejects (every failure becomes status "error"); this only drops the reference
    void run.finally(() => {
      if (this.inflight === run) this.inflight = null;
    });
    return run;
  }

  private async runCheck(asked: boolean): Promise<void> {
    if (this.state.channel === "dev") this.returningToStable = false;
    const seq = ++this.checkSeq;
    const channel = this.state.channel;
    const returning = this.returningToStable;
    const before = this.state;
    const stale = () => seq !== this.checkSeq || channel !== this.state.channel;
    this.set({ status: "checking", error: null, progress: null });
    try {
      if (!this.state.feed) throw new Error(lowerFirst(NO_RELEASE_CHANNEL));
      const feed = await this.readFeed(returning ? "stable" : channel, asked);
      if (stale()) return;
      this.offer = feed;
      this.offerChannel = channel;
      const offered = offers(feed.version, this.p.version, returning);
      this.set({ status: offered ? "available" : "current", latest: feed.version, notes: offered ? feed.notes || null : null, checkedAt: this.p.now() });
    } catch (e) {
      if (stale()) return;
      const message = e instanceof Error ? e.message : String(e);
      this.p.log(`update check failed: ${message}`);
      // An automatic check that fails keeps an offer already on screen (a
      // network blip mustn't take it back); otherwise the reason is shown.
      if (!asked && before.status === "available" && this.offer && this.offerChannel === channel) {
        this.set({ status: "available", error: null });
        return;
      }
      // error: SHOWN — status "error", the message verbatim
      this.set({ status: "error", error: `Couldn't check for updates: ${message}`, checkedAt: this.p.now() });
    }
  }

  // The feed of `channel`: its text and its signature, verified before anything in it is read.
  private async readFeed(channel: UpdateChannel, asked: boolean): Promise<Feed> {
    const url = this.p.source.urls[channel];
    const name = url.split("/").pop()!;
    const fresh = asked && !this.p.source.test;
    const get = async (u: string) => {
      if (fresh) {
        try {
          const r = await this.p.fetchText(freshUrl(u), true);
          if (r.status === 200 || r.status === 404) return r;
          this.p.log(`update feed: fresh read answered HTTP ${r.status}; the cached copy instead`);
        } catch (e) {
          // error: LOGGED-OK — the API refused or failed (60 requests an hour); the CDN's answer below decides
          this.p.log(`update feed: fresh read failed (${e instanceof Error ? e.message : String(e)}); the cached copy instead`);
        }
      }
      try {
        return await this.p.fetchText(u, false);
      } catch (e) {
        // error: PASSES-ON — thrown in plain words to check(), which shows it
        throw new Error(`the update server can't be reached (${e instanceof Error ? e.message : String(e)})`);
      }
    };
    const [feed, sig] = await Promise.all([get(url), get(`${url}.sig`)]);
    if (feed.status === 404) throw new Error(`no release has been published on the ${channel === "dev" ? "Development" : "Stable"} channel yet`);
    if (feed.status !== 200) throw new Error(`the update server answered HTTP ${feed.status}`);
    if (sig.status !== 200 || !feedSignedBy(feed.text, sig.text, this.p.source.keys)) throw new Error(`update refused: ${name} is not signed by a trusted key`);
    return parseFeed(feed.text, channel, this.p.source.prefix);
  }

  setChannel(c: UpdateChannel): void {
    this.switchChannel(c, true);
  }

  private switchChannel(c: UpdateChannel, autoCheck: boolean): void {
    if (c !== "stable" && c !== "dev") return;
    if (c === "dev") this.returningToStable = false;
    if (c === this.state.channel) return;
    this.set({ channel: c, feed: this.feedUrl(c) });
    this.persist();
    // An offer from the other channel is forgotten (a dev build is never offered on Stable).
    if (this.state.status === "downloading" || this.state.status === "ready" || this.state.status === "unsupported") return;
    this.checkSeq++;
    this.offer = null;
    this.offerChannel = null;
    this.set({ status: "idle", latest: null, notes: null, error: null, progress: null });
    if (autoCheck && this.state.automatic) void this.check(false);
  }

  // Back to stable (the page confirms it first): the newest stable release,
  // even when it is older than this development build. The one way back.
  async backToStable(): Promise<void> {
    if (this.state.status === "unsupported" || this.busy()) return;
    this.switchChannel("stable", false);
    this.returningToStable = true;
    await this.check(true);
  }

  setAutomatic(on: boolean): void {
    if (on === this.state.automatic) return;
    this.set({ automatic: on });
    this.persist();
    if (on) this.schedule();
    else this.unschedule();
  }

  async download(): Promise<void> {
    const feed = this.offer;
    if (this.state.status !== "available" || !feed || this.offerChannel !== this.state.channel || !this.p.appImage) return;
    const running = this.p.appImage;
    const version = feed.version;
    this.abort = new AbortController();
    this.lastProgress = 0;
    this.set({ status: "downloading", progress: 0, error: null });
    try {
      if (!downloadAllowed(feed.url, this.p.source)) throw new Error("the download isn't one of this app's GitHub releases; refused");
      const dir = dirname(running);
      const target = join(dir, feed.file);
      // never write over the AppImage this process runs from (FUSE-mounted: SIGBUS)
      if (target === running) throw new Error("the update has the running file's name; refusing to overwrite it");
      const part = `${target}.part`;
      // recorded before the download, so prune() may remove its .part if this is cut short
      if (!this.installedFiles.includes(target)) {
        this.installedFiles = [...this.installedFiles, target];
        this.persist();
      }
      await downloadVerified(
        this.p.fetch,
        feed,
        part,
        (got, total) => {
          const t = this.p.now();
          if (t - this.lastProgress < PROGRESS_EVERY_MS && got < total) return;
          this.lastProgress = t;
          this.set({ progress: total ? got / total : 0 });
        },
        this.abort.signal,
      );
      this.p.fs.chmod(part, 0o755);
      this.p.fs.rename(part, target);
      this.installed = this.linkStable(target);
      this.returningToStable = false;
      this.set({ status: "ready", progress: null, latest: version });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.p.log(`update install failed: ${message}`);
      // error: SHOWN — status "error": why, and that the running version is untouched
      this.set({ status: "error", progress: null, error: `The update didn't install: ${message}. Your current version is untouched.` });
    } finally {
      this.abort = null;
    }
  }

  // Point CorridorKey-Desktop.AppImage (a symlink) at the new file, so menu
  // entries and scripts that start the stable name start the new version. A
  // real file with that name (someone renamed the AppImage) is never replaced.
  // Returns what restart() starts.
  private linkStable(target: string): string {
    const link = join(dirname(target), STABLE_LINK);
    try {
      const kind = this.p.fs.kind(link);
      if (kind === "file") return target;
      if (kind === "link") this.p.fs.rm(link);
      this.p.fs.symlink(basename(target), link);
      return link;
    } catch (e) {
      // error: LOGGED-OK — the folder refused the link: restart starts the versioned file itself
      this.p.log(`update: could not repoint ${STABLE_LINK}: ${e instanceof Error ? e.message : String(e)}`);
      return target;
    }
  }

  // Start the installed version and quit this one. The main process calls it
  // only while no queue runs.
  restart(): void {
    if (this.state.status !== "ready" || !this.installed) return;
    if (!this.p.fs.exists(this.installed)) {
      this.installed = null;
      // error: SHOWN — status "error"; Check for updates downloads it again
      this.set({ status: "error", error: "The downloaded update is gone (deleted?). Check for updates to download it again. Your current version is untouched." });
      return;
    }
    this.stop();
    this.p.relaunch(this.installed);
  }
}
