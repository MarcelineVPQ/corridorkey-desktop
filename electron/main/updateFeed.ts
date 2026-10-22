// The update feed and its rules, free of Electron so vitest drives them
// (tests/unit/updateFeed.test.ts). The same design as Marcy's DS5 app
// (electron/main/feedSignature.ts, src/update/manifest.ts there) and Sonata
// (update-feed.js):
//
// CI writes latest.json (Stable) and latest-dev.json (Development) on the
// releases repository's main branch, signs each file's exact bytes with an
// Ed25519 key that exists only as the CK_FEED_KEY Actions secret
// (tools/sign-feed.mjs), and commits the signature beside it as <feed>.sig
// (base64). The app refuses a feed no key in TRUSTED_KEYS signed, a feed whose
// download isn't this repository's release file for that version, and a
// download whose size or SHA-512 differs from the signed feed.
// See docs/RELEASING.md. Never edit the feeds by hand.
import { createPublicKey, verify } from "node:crypto";
import type { UpdateChannel } from "../../src/shared/types";

// The one place that names where releases and feeds live.
export const REPO = "MarcelineVPQ/corridorkey-desktop";
export const FEED_BRANCH = "main";
export const FEED_URLS: Record<UpdateChannel, string> = {
  stable: `https://raw.githubusercontent.com/${REPO}/${FEED_BRANCH}/latest.json`,
  dev: `https://raw.githubusercontent.com/${REPO}/${FEED_BRANCH}/latest-dev.json`,
};
export const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;

// base64 SPKI DER (`openssl pkey -pubout -outform DER | base64`). A list so the
// key can be rotated: ship the new key in one release, start signing with it in the next.
export const TRUSTED_KEYS: readonly string[] = [
  "MCowBQYDK2VwAyEAuUIsZgGZQ7RSvVoCGijbgkuw/TsHnSxRLke55eRhbnk=", // 2026-10, ~/.config/corridorkey-release/feed-signing.pem on the developer's PC
];

// Automatic checks: 20 s after start, then every CHECK_EVERY_HOURS (Sonata's rhythm).
export const FIRST_CHECK_MS = 20_000;
export const CHECK_EVERY_HOURS = 2;
export const CHECK_EVERY_MS = CHECK_EVERY_HOURS * 3600 * 1000;

// The AppImage's file name; the feed must name exactly this for its version.
export const appImageName = (version: string): string => `CorridorKey-Desktop-${version}.AppImage`;
export const APPIMAGE_RE = /^CorridorKey-Desktop-(\d+\.\d+\.\d+(?:-dev\.\d+)?)\.AppImage$/;
// The stable name beside the versioned files: a symlink to the newest one, for menu entries and scripts.
export const STABLE_LINK = "CorridorKey-Desktop.AppImage";

export function feedSignedBy(text: string, signatureB64: string, keys: readonly string[]): boolean {
  const signature = Buffer.from(String(signatureB64 ?? "").trim(), "base64");
  if (signature.length !== 64) return false;
  // loop: NOT-WORTH — N = 1 trusted key (2 during a rotation)
  return keys.some((k) => {
    try {
      const key = createPublicKey({ key: Buffer.from(k, "base64"), format: "der", type: "spki" });
      return verify(null, Buffer.from(text, "utf8"), key, signature);
    } catch {
      // error: NOT-WORTH — a key that can't be read verifies nothing: the feed is refused as unsigned, which the error says
      return false;
    }
  });
}

// X.Y.Z or X.Y.Z-dev.N -> [X, Y, Z, N]; a release sorts after its dev builds
// (0.2.0-dev.2 < 0.2.0 < 0.2.1-dev.1). Anything else -> null.
export function versionKey(v: string | null | undefined): [number, number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?$/.exec(String(v ?? ""));
  return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? Infinity : +m[4]] : null;
}

export const isDevVersion = (v: string | null | undefined): boolean => /^\d+\.\d+\.\d+-dev\.\d+$/.test(String(v ?? ""));

// Strictly newer; false when either can't be read (an updater that can't read
// a version does nothing rather than risk moving someone backwards).
export function isNewerVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = versionKey(a);
  const y = versionKey(b);
  if (!x || !y) return false;
  // loop: NOT-WORTH — 4 fixed fields
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// Is `remote` offered to a copy running `current`? Newer only. Back to stable
// (explicit, from the Development channel): any stable release but the same one,
// even an older one. The one path that may go backwards.
export function offers(remote: string, current: string, returningToStable: boolean): boolean {
  if (!versionKey(remote) || !versionKey(current)) return false;
  if (returningToStable) return remote !== current && !isDevVersion(remote);
  return isNewerVersion(remote, current);
}

export interface Feed {
  channel: UpdateChannel;
  version: string;
  file: string;
  url: string;
  sha512: string; // 128 lowercase hex
  size: number;
  date: string;
  notesUrl: string;
  notes: string;
}

// The feed file, after its signature checked out. Every field is validated: the
// download must be this repository's release file for this version, and the
// Stable feed may never carry a development build.
export function parseFeed(text: string, channel: UpdateChannel, prefix: string = DOWNLOAD_PREFIX): Feed {
  const bad = (what: string) => new Error(`update refused: the signed feed ${what}`);
  let f: Record<string, unknown>;
  try {
    f = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // error: PASSES-ON — thrown as the refusal the updater shows
    throw bad("is not valid JSON");
  }
  if (!f || typeof f !== "object" || Array.isArray(f)) throw bad("is empty");
  if (f.channel !== channel) throw bad(`is for the ${String(f.channel)} channel, not ${channel}`);
  const version = typeof f.version === "string" ? f.version : "";
  if (!versionKey(version)) throw bad("has no valid version");
  if (channel === "stable" && isDevVersion(version)) throw bad("offers a development build on Stable");
  if (f.file !== appImageName(version)) throw bad("names an unexpected file");
  if (f.url !== `${prefix}v${version}/${f.file}`) throw bad("points outside this repository's releases");
  if (typeof f.sha512 !== "string" || !/^[0-9a-f]{128}$/.test(f.sha512)) throw bad("has no SHA-512");
  if (typeof f.size !== "number" || !Number.isSafeInteger(f.size) || f.size <= 0) throw bad("has no size");
  return {
    channel,
    version,
    file: f.file,
    url: f.url,
    sha512: f.sha512,
    size: f.size,
    date: typeof f.date === "string" ? f.date : "",
    notesUrl: typeof f.notes_url === "string" ? f.notes_url : "",
    notes: typeof f.notes === "string" ? f.notes.slice(0, 20_000) : "",
  };
}

// The feed file's exact text (what CI signs), from a release and the measured
// AppImage. Used by tools/build-feed.mjs; tested beside parseFeed so the two can't drift.
export function feedText(
  channel: UpdateChannel,
  release: { tag: string; version: string; date?: string; notesUrl?: string; notes?: string },
  measured: { sha512: string; size: number },
  prefix: string = DOWNLOAD_PREFIX,
): string {
  if (!versionKey(release.version) || release.tag !== `v${release.version}`) throw new Error(`bad release ${release.tag}`);
  if (channel === "stable" && isDevVersion(release.version)) throw new Error("a development build can't go on Stable");
  const file = appImageName(release.version);
  const feed = {
    channel,
    version: release.version,
    file,
    url: `${prefix}${release.tag}/${file}`,
    sha512: measured.sha512,
    size: measured.size,
    date: release.date ?? "",
    notes_url: release.notesUrl ?? "",
    notes: String(release.notes ?? "")
      .trim()
      .slice(0, 20_000),
  };
  return JSON.stringify(feed, null, 2) + "\n";
}

// From GitHub's release list: the release a channel's feed describes. Stable:
// the newest published vX.Y.Z. Development: the newest of the vX.Y.Z-dev.N
// prereleases and the stable releases (Development users get stable releases too).
export interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at?: string | null;
  html_url?: string;
  body?: string | null;
  assets?: { name: string; size: number; browser_download_url: string }[];
}
export function selectRelease(
  releases: GithubRelease[],
  channel: UpdateChannel,
): { release: GithubRelease; version: string; asset: { name: string; size: number; browser_download_url: string } } | null {
  let best: ReturnType<typeof selectRelease> = null;
  // loop: NOT-WORTH — one page of ≤ 50 releases, once per CI run
  for (const r of releases) {
    if (r.draft) continue;
    const m = !r.prerelease ? /^v(\d+\.\d+\.\d+)$/.exec(r.tag_name) : channel === "dev" ? /^v(\d+\.\d+\.\d+-dev\.\d+)$/.exec(r.tag_name) : null;
    if (!m) continue;
    // loop: NOT-WORTH — a release's few assets, once per update check
    const asset = (r.assets ?? []).find((a) => a.name === appImageName(m[1]));
    if (!asset) continue;
    if (!best || isNewerVersion(m[1], best.version)) best = { release: r, version: m[1], asset };
  }
  return best;
}

// A check the user asked for reads the feed fresh: raw.githubusercontent.com's
// CDN keeps a file up to 5 minutes and ignores query strings (Sonata, measured
// 2026-10-19), so a check right after a release said "up to date". The same
// bytes through GitHub's contents API come from the repository (the caller
// sends Accept: application/vnd.github.raw). Automatic checks keep the CDN.
const RAW_RE = /^https:\/\/raw\.githubusercontent\.com\/([\w.-]+)\/([\w.-]+)\/([\w.-]+)\/([\w./-]+)$/;
export function freshUrl(url: string): string {
  const m = RAW_RE.exec(url);
  return m ? `https://api.github.com/repos/${m[1]}/${m[2]}/contents/${m[4]}?ref=${m[3]}` : url;
}

// Test feed: CK_UPDATE_MANIFEST=http://127.0.0.1:8765/latest.json points the
// updater at a server on this machine, so a whole update cycle (signature,
// hash, install, Back to stable) runs before anything is published. Loopback
// http only, so nothing on the network can stand in for GitHub; downloads must
// then come from the same server. CK_UPDATE_PUBKEY (base64 SPKI) adds a test
// key, only together with such a feed, never for the real one.
export interface FeedSource {
  urls: Record<UpdateChannel, string>;
  prefix: string;
  keys: readonly string[];
  test: boolean;
}
export function isLoopbackHttp(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.username === "" && u.password === "";
  } catch {
    // error: NOT-WORTH — not a URL: no test feed
    return false;
  }
}
export function feedSource(env: Record<string, string | undefined>): FeedSource {
  const raw = env.CK_UPDATE_MANIFEST;
  if (raw && isLoopbackHttp(raw) && /\/latest\.json$/.test(new URL(raw).pathname)) {
    const base = raw.replace(/latest\.json$/, "");
    const key = env.CK_UPDATE_PUBKEY && /^[A-Za-z0-9+/=]{40,200}$/.test(env.CK_UPDATE_PUBKEY) ? [env.CK_UPDATE_PUBKEY] : [];
    return { urls: { stable: raw, dev: `${base}latest-dev.json` }, prefix: base, keys: [...TRUSTED_KEYS, ...key], test: true };
  }
  return { urls: FEED_URLS, prefix: DOWNLOAD_PREFIX, keys: TRUSTED_KEYS, test: false };
}

// The download may come only from this repository's GitHub releases (or the loopback test feed's server).
export function downloadAllowed(url: string, source: FeedSource): boolean {
  if (source.test) return isLoopbackHttp(url) && url.startsWith(source.prefix);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // error: NOT-WORTH — not a URL: not allowed
    return false;
  }
  return u.protocol === "https:" && u.hostname === "github.com" && u.port === "" && u.username === "" && u.password === "" && url.startsWith(DOWNLOAD_PREFIX);
}

// Files beside the running AppImage to remove at start: downloads a crash or a
// quit cut short (.part), and versioned AppImages older than the running one,
// except the newest of those, kept for rollback (if the new version misbehaves,
// the previous one is still there to start). Never the running file.
export function staleFiles(names: string[], running: string, currentVersion: string): string[] {
  const out: string[] = [];
  const older: { name: string; version: string }[] = [];
  // loop: NOT-WORTH — the AppImage folder's entries, once at start
  for (const name of names) {
    if (name === running) continue;
    if (/^CorridorKey-Desktop-\d+\.\d+\.\d+(?:-dev\.\d+)?\.AppImage\.part$/.test(name)) out.push(name);
    const m = APPIMAGE_RE.exec(name);
    if (m && isNewerVersion(currentVersion, m[1])) older.push({ name, version: m[1] });
  }
  // loop: NOT-WORTH — a few old AppImages, once per cleanup
  older.sort((a, b) => (isNewerVersion(a.version, b.version) ? -1 : isNewerVersion(b.version, a.version) ? 1 : 0));
  // loop: NOT-WORTH — a few old AppImages, once per cleanup
  return [...out, ...older.slice(1).map((o) => o.name)];
}
