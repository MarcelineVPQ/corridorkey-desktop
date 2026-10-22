// The update choices (channel, check automatically), kept in their own small
// file in userData so they never race the main settings file. Atomic write:
// temp file + rename, so a crash never leaves half a file.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { UpdateChannel } from "../../src/shared/types";
import { isDevVersion } from "./updateFeed";

export interface UpdatePrefs {
  channel: UpdateChannel;
  automatic: boolean;
}

// No file yet: a development build starts on the Development channel (it would
// otherwise wait for the next stable release), a release on Stable; automatic
// checks on (as in Sonata and the DS5 app).
export function loadUpdatePrefs(file: string, version: string): UpdatePrefs {
  const fallback: UpdatePrefs = { channel: isDevVersion(version) ? "dev" : "stable", automatic: true };
  let saved: Partial<UpdatePrefs> = {};
  try {
    saved = JSON.parse(readFileSync(file, "utf8")) as Partial<UpdatePrefs>;
  } catch {
    // error: NOT-WORTH — no file yet (first start) or unreadable: the defaults
    return fallback;
  }
  return {
    channel: saved.channel === "dev" || saved.channel === "stable" ? saved.channel : fallback.channel,
    automatic: typeof saved.automatic === "boolean" ? saved.automatic : fallback.automatic,
  };
}

export function saveUpdatePrefs(file: string, prefs: UpdatePrefs): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(prefs, null, 2) + "\n");
  renameSync(tmp, file);
}
