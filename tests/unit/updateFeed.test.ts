import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  appImageName,
  DOWNLOAD_PREFIX,
  downloadAllowed,
  FEED_URLS,
  feedSignedBy,
  feedSource,
  feedText,
  freshUrl,
  isDevVersion,
  isNewerVersion,
  offers,
  parseFeed,
  REPO,
  selectRelease,
  staleFiles,
  TRUSTED_KEYS,
  versionKey,
} from "../../electron/main/updateFeed";

const keys = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, pub: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
};
const sha = "a".repeat(128);

describe("versions", () => {
  it("orders dev builds before their release", () => {
    expect(isNewerVersion("0.2.0", "0.2.0-dev.9")).toBe(true);
    expect(isNewerVersion("0.2.0-dev.2", "0.2.0-dev.1")).toBe(true);
    expect(isNewerVersion("0.2.0-dev.1", "0.1.9")).toBe(true);
    expect(isNewerVersion("0.2.0-dev.1", "0.2.0")).toBe(false);
    expect(isNewerVersion("0.10.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.2.0", "0.2.0")).toBe(false);
  });
  it("never calls an unreadable version newer", () => {
    expect(isNewerVersion("v0.3.0", "0.2.0")).toBe(false);
    expect(isNewerVersion("0.3.0", "garbage")).toBe(false);
    expect(versionKey("0.3.0-beta.1")).toBeNull();
    expect(isDevVersion("0.3.0-dev.1")).toBe(true);
    expect(isDevVersion("0.3.0")).toBe(false);
  });
  it("offers newer only, except Back to stable", () => {
    expect(offers("0.2.0", "0.2.0", false)).toBe(false);
    expect(offers("0.1.0", "0.2.0-dev.1", false)).toBe(false);
    expect(offers("0.1.0", "0.2.0-dev.1", true)).toBe(true);
    expect(offers("0.2.0-dev.1", "0.1.0", true)).toBe(false); // Back to stable never takes a dev build
    expect(offers("0.2.0", "0.2.0", true)).toBe(false);
  });
});

describe("the feed's signature", () => {
  it("accepts the exact bytes signed by a trusted key, nothing else", () => {
    const { privateKey, pub } = keys();
    const text = '{"a":1}\n';
    const sig = sign(null, Buffer.from(text), privateKey).toString("base64");
    expect(feedSignedBy(text, sig, [pub])).toBe(true);
    expect(feedSignedBy(text + " ", sig, [pub])).toBe(false);
    expect(feedSignedBy(text, sig, TRUSTED_KEYS)).toBe(false);
    expect(feedSignedBy(text, "", [pub])).toBe(false);
    expect(feedSignedBy(text, sig, ["not a key"])).toBe(false);
  });
  it("trusts one real key, an Ed25519 SPKI", () => {
    expect(TRUSTED_KEYS).toHaveLength(1);
    expect(Buffer.from(TRUSTED_KEYS[0], "base64")).toHaveLength(44);
  });
});

describe("parseFeed", () => {
  const good = (o: Record<string, unknown> = {}) =>
    JSON.stringify({ channel: "stable", version: "0.2.0", file: appImageName("0.2.0"), url: `${DOWNLOAD_PREFIX}v0.2.0/${appImageName("0.2.0")}`, sha512: sha, size: 10, notes: "hi", ...o });
  it("reads a good feed", () => {
    const f = parseFeed(good(), "stable");
    expect(f).toMatchObject({ version: "0.2.0", file: "CorridorKey-Desktop-0.2.0.AppImage", size: 10, notes: "hi" });
  });
  it("refuses everything off the rules", () => {
    expect(() => parseFeed("{", "stable")).toThrow(/not valid JSON/);
    expect(() => parseFeed(good(), "dev")).toThrow(/stable channel, not dev/);
    expect(() => parseFeed(good({ version: "0.3.0-dev.1", file: appImageName("0.3.0-dev.1"), url: `${DOWNLOAD_PREFIX}v0.3.0-dev.1/${appImageName("0.3.0-dev.1")}` }), "stable")).toThrow(
      /development build on Stable/,
    );
    expect(() => parseFeed(good({ file: "evil.AppImage" }), "stable")).toThrow(/unexpected file/);
    expect(() => parseFeed(good({ url: `https://github.com/someone/else/releases/download/v0.2.0/${appImageName("0.2.0")}` }), "stable")).toThrow(/outside/);
    expect(() => parseFeed(good({ sha512: "abc" }), "stable")).toThrow(/SHA-512/);
    expect(() => parseFeed(good({ size: 0 }), "stable")).toThrow(/size/);
    expect(() => parseFeed(good({ version: "latest" }), "stable")).toThrow(/version/);
  });
  it("round-trips what CI writes (feedText)", () => {
    const text = feedText("dev", { tag: "v0.3.0-dev.2", version: "0.3.0-dev.2", notes: " notes " }, { sha512: sha, size: 99 });
    expect(parseFeed(text, "dev")).toMatchObject({ version: "0.3.0-dev.2", size: 99, notes: "notes", url: `${DOWNLOAD_PREFIX}v0.3.0-dev.2/CorridorKey-Desktop-0.3.0-dev.2.AppImage` });
    expect(() => feedText("stable", { tag: "v0.3.0-dev.2", version: "0.3.0-dev.2" }, { sha512: sha, size: 1 })).toThrow();
    expect(() => feedText("stable", { tag: "v0.3.1", version: "0.3.0" }, { sha512: sha, size: 1 })).toThrow();
  });
});

describe("selectRelease", () => {
  const rel = (tag: string, prerelease: boolean, draft = false) => ({
    tag_name: tag,
    prerelease,
    draft,
    assets: [{ name: appImageName(tag.slice(1)), size: 1, browser_download_url: "x" }],
  });
  const list = [rel("v0.3.0-dev.1", true), rel("v0.2.0", false), rel("v0.2.1", false, true), rel("v0.1.0", false), { tag_name: "v0.4.0", prerelease: false, draft: false, assets: [] }];
  it("Stable: the newest published release with an AppImage", () => {
    expect(selectRelease(list, "stable")?.version).toBe("0.2.0");
  });
  it("Development: the newest of dev builds and releases", () => {
    expect(selectRelease(list, "dev")?.version).toBe("0.3.0-dev.1");
    expect(selectRelease([rel("v0.3.0-dev.1", true), rel("v0.3.0", false)], "dev")?.version).toBe("0.3.0");
  });
  it("nothing published yet", () => {
    expect(selectRelease([], "stable")).toBeNull();
  });
});

describe("sources and URLs", () => {
  it("one repository constant names every URL", () => {
    expect(REPO).toBe("MarcelineVPQ/corridorkey-desktop");
    expect(FEED_URLS.stable).toBe("https://raw.githubusercontent.com/MarcelineVPQ/corridorkey-desktop/main/latest.json");
    expect(FEED_URLS.dev).toBe("https://raw.githubusercontent.com/MarcelineVPQ/corridorkey-desktop/main/latest-dev.json");
    expect(freshUrl(FEED_URLS.dev)).toBe("https://api.github.com/repos/MarcelineVPQ/corridorkey-desktop/contents/latest-dev.json?ref=main");
  });
  it("the test feed is loopback only, and its key only with it", () => {
    const { pub } = keys();
    expect(feedSource({ CK_UPDATE_MANIFEST: "http://127.0.0.1:8765/latest.json", CK_UPDATE_PUBKEY: pub })).toMatchObject({
      test: true,
      urls: { stable: "http://127.0.0.1:8765/latest.json", dev: "http://127.0.0.1:8765/latest-dev.json" },
      keys: [...TRUSTED_KEYS, pub],
    });
    for (const bad of ["https://127.0.0.1/latest.json", "http://example.com/latest.json", "http://10.0.0.1/latest.json", "http://u:p@127.0.0.1/latest.json", "nonsense"]) {
      expect(feedSource({ CK_UPDATE_MANIFEST: bad, CK_UPDATE_PUBKEY: pub })).toMatchObject({ test: false, keys: TRUSTED_KEYS });
    }
    expect(feedSource({ CK_UPDATE_PUBKEY: pub }).keys).toEqual(TRUSTED_KEYS);
  });
  it("downloads only from this repository's releases", () => {
    const real = feedSource({});
    expect(downloadAllowed(`${DOWNLOAD_PREFIX}v0.2.0/x.AppImage`, real)).toBe(true);
    expect(downloadAllowed("https://github.com/other/repo/releases/download/v0.2.0/x.AppImage", real)).toBe(false);
    expect(downloadAllowed("http://github.com/MarcelineVPQ/corridorkey-desktop/releases/download/v1/x", real)).toBe(false);
    expect(downloadAllowed("http://127.0.0.1:8765/v0.2.0/x.AppImage", real)).toBe(false);
    const test = feedSource({ CK_UPDATE_MANIFEST: "http://127.0.0.1:8765/latest.json" });
    expect(downloadAllowed("http://127.0.0.1:8765/v0.2.0/x.AppImage", test)).toBe(true);
    expect(downloadAllowed(`${DOWNLOAD_PREFIX}v0.2.0/x.AppImage`, test)).toBe(false);
  });
});

describe("staleFiles", () => {
  it("removes cut-short downloads and older versions but keeps the previous one for rollback", () => {
    const names = [
      "CorridorKey-Desktop-0.3.0.AppImage",
      "CorridorKey-Desktop-0.2.0.AppImage",
      "CorridorKey-Desktop-0.2.1-dev.1.AppImage",
      "CorridorKey-Desktop-0.1.0.AppImage",
      "CorridorKey-Desktop-0.4.0.AppImage.part",
      "CorridorKey-Desktop-0.4.0.AppImage",
      "CorridorKey-Desktop.AppImage",
      "notes.txt",
    ];
    // loop: NOT-WORTH — a few names in a test
    const all = names.map((n) => n.replace(/\.part$/, ""));
    expect(staleFiles(names, "CorridorKey-Desktop-0.3.0.AppImage", "0.3.0", all).sort()).toEqual([
      "CorridorKey-Desktop-0.1.0.AppImage",
      "CorridorKey-Desktop-0.2.0.AppImage",
      "CorridorKey-Desktop-0.4.0.AppImage.part",
    ]);
  });
  it("only files the updater installed: a copy the user downloaded or a browser's .part stays (review 2026-10-27)", () => {
    const names = [
      "CorridorKey-Desktop-0.3.0.AppImage",
      "CorridorKey-Desktop-0.2.1-dev.1.AppImage",
      "CorridorKey-Desktop-0.2.0.AppImage",
      "CorridorKey-Desktop-0.1.0.AppImage",
      "CorridorKey-Desktop-0.4.0.AppImage.part",
    ];
    expect(staleFiles(names, "CorridorKey-Desktop-0.3.0.AppImage", "0.3.0", [])).toEqual([]);
    expect(staleFiles(names, "CorridorKey-Desktop-0.3.0.AppImage", "0.3.0", ["CorridorKey-Desktop-0.1.0.AppImage"])).toEqual(["CorridorKey-Desktop-0.1.0.AppImage"]);
  });
  it("never the running file", () => {
    expect(staleFiles(["CorridorKey-Desktop-0.1.0.AppImage"], "CorridorKey-Desktop-0.1.0.AppImage", "0.3.0", ["CorridorKey-Desktop-0.1.0.AppImage"])).toEqual([]);
  });
});
