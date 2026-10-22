// The app's own updates. Placeholder until the real updater lands (branch
// feat/updater: signed feeds, AppImage packaging, release workflow). With no
// release channel set up it reports "unsupported", and App settings → Updates
// says so instead of offering buttons that do nothing (rule 4).
import type { UpdateChannel, UpdateState } from "../../src/shared/types";

export class Updater {
  state: UpdateState;

  constructor(private readonly deps: { changed: () => void; version: string }) {
    this.state = { feed: null, channel: "stable", automatic: true, status: "unsupported", current: deps.version, latest: null, notes: null, progress: null, error: null, checkedAt: null };
  }

  start(): void {}
  stop(): void {}
  async check(_asked: boolean): Promise<void> {}
  setChannel(channel: UpdateChannel): void {
    this.state = { ...this.state, channel };
    this.deps.changed();
  }
  setAutomatic(on: boolean): void {
    this.state = { ...this.state, automatic: on };
    this.deps.changed();
  }
  async download(): Promise<void> {}
  restart(): void {}
}
