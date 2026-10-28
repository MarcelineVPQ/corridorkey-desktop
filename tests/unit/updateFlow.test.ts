// A whole update against a local signed test feed (the CK_UPDATE_MANIFEST
// path): signature, size + SHA-512, install beside the running AppImage, the
// stable symlink, restart, Back to stable, and every refusal.
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadVerified } from "../../electron/main/download";
import { appImageName, feedSource, FIRST_CHECK_MS } from "../../electron/main/updateFeed";
import { UpdateFlow, type FileOps, type UpdatePlatform } from "../../electron/main/updateFlow";
import type { UpdateChannel } from "../../src/shared/types";

// The test server: path -> body (or a status).
const files = new Map<string, Buffer | number>();
let server: Server;
let base = "";
let requests: string[] = [];
let key: KeyObject;
let pub = "";

beforeAll(async () => {
  const k = generateKeyPairSync("ed25519");
  key = k.privateKey;
  pub = k.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  // lifetime: OK — closed in afterAll
  server = createServer((req, res) => {
    requests.push(req.url ?? "");
    const body = files.get(req.url ?? "");
    if (body === undefined || typeof body === "number") {
      res.writeHead(typeof body === "number" ? body : 404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-length": body.length });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const appBytes = (version: string) => Buffer.from(`#!/bin/sh\necho CorridorKey ${version}\n`.repeat(2000));

// Publish `version` on `channel` (signed with `signer`), optionally lying about the file.
function publish(channel: UpdateChannel, version: string, o: { signer?: KeyObject; bytes?: Buffer; sha512?: string; size?: number } = {}) {
  const bytes = appBytes(version);
  const file = appImageName(version);
  files.set(`/v${version}/${file}`, o.bytes ?? bytes);
  const feed =
    JSON.stringify(
      {
        channel,
        version,
        file,
        url: `${base}v${version}/${file}`,
        sha512: o.sha512 ?? createHash("sha512").update(bytes).digest("hex"),
        size: o.size ?? bytes.length,
        notes: `What's new in ${version}`,
      },
      null,
      2,
    ) + "\n";
  const name = channel === "dev" ? "latest-dev.json" : "latest.json";
  files.set(`/${name}`, Buffer.from(feed));
  files.set(`/${name}.sig`, Buffer.from(sign(null, Buffer.from(feed), o.signer ?? key).toString("base64") + "\n"));
}

const realFs: FileOps = {
  readdir: (d) => readdirSync(d),
  rm: (p) => rmSync(p, { force: true }),
  chmod: (p, m) => chmodSync(p, m),
  rename: (a, b) => renameSync(a, b),
  exists: (p) => existsSync(p),
  kind: (p) => {
    const st = lstatSync(p, { throwIfNoEntry: false });
    return !st ? null : st.isSymbolicLink() ? "link" : "file";
  },
  symlink: (t, p) => symlinkSync(t, p),
};

let dir = "";
let relaunched: string[] = [];
let changes = 0;
beforeEach(() => {
  files.clear();
  requests = [];
  relaunched = [];
  changes = 0;
  dir = mkdtempSync(join(tmpdir(), "ck-update-test-"));
  mkdirSync(join(dir, "apps"));
  mkdirSync(join(dir, "userData"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function flow(version: string, o: { appImage?: string | null; unsupported?: string | null; env?: Record<string, string> } = {}) {
  const running = join(dir, "apps", appImageName(version));
  writeFileSync(running, appBytes(version), { mode: 0o755 });
  const p: UpdatePlatform = {
    version,
    source: feedSource(o.env ?? { CK_UPDATE_MANIFEST: `${base}latest.json`, CK_UPDATE_PUBKEY: pub }),
    appImage: o.appImage === undefined ? running : o.appImage,
    unsupported: o.unsupported ?? null,
    prefsFile: join(dir, "userData", "updates.json"),
    fetchText: async (url) => {
      const r = await fetch(url);
      return { status: r.status, text: r.ok ? await r.text() : "" };
    },
    fetch: (url, init) => fetch(url, init),
    fs: realFs,
    relaunch: (t) => relaunched.push(t),
    now: () => Date.now(),
    log: () => undefined,
  };
  return new UpdateFlow(p, () => changes++);
}

describe("update flow", () => {
  it("check → download → installed beside the running AppImage → restart", async () => {
    publish("stable", "0.2.0");
    const u = flow("0.1.0");
    expect(u.state).toMatchObject({ status: "idle", channel: "stable", automatic: true, current: "0.1.0", feed: `${base}latest.json` });
    await u.check(true);
    expect(u.state).toMatchObject({ status: "available", latest: "0.2.0", notes: "What's new in 0.2.0", error: null });
    expect(u.state.checkedAt).toBeTypeOf("number");
    await u.download();
    expect(u.state).toMatchObject({ status: "ready", progress: null, error: null });
    expect(changes).toBeGreaterThan(3);
    const installed = join(dir, "apps", appImageName("0.2.0"));
    expect(readFileSync(installed)).toEqual(appBytes("0.2.0"));
    expect(statSync(installed).mode & 0o777).toBe(0o755);
    // the old version stays for rollback; the stable link points at the new one
    expect(existsSync(join(dir, "apps", appImageName("0.1.0")))).toBe(true);
    expect(readlinkSync(join(dir, "apps", "CorridorKey-Desktop.AppImage"))).toBe(appImageName("0.2.0"));
    expect(existsSync(`${installed}.part`)).toBe(false);
    // once installed, only a restart moves on
    await u.check(true);
    expect(u.state.status).toBe("ready");
    u.restart();
    expect(relaunched).toEqual([join(dir, "apps", "CorridorKey-Desktop.AppImage")]);
  });

  it("nothing newer: current", async () => {
    publish("stable", "0.1.0");
    const u = flow("0.1.0");
    await u.check(true);
    expect(u.state).toMatchObject({ status: "current", latest: "0.1.0" });
    await u.download();
    expect(u.state.status).toBe("current");
  });

  it("never downgrades on a plain check", async () => {
    publish("stable", "0.1.0");
    const u = flow("0.2.0-dev.1");
    u.setChannel("stable");
    await u.check(true);
    expect(u.state).toMatchObject({ status: "current", latest: "0.1.0" });
  });

  it("refuses a feed no trusted key signed", async () => {
    publish("stable", "0.2.0", { signer: generateKeyPairSync("ed25519").privateKey });
    const u = flow("0.1.0");
    await u.check(true);
    expect(u.state).toMatchObject({ status: "error", error: "Couldn't check for updates: update refused: latest.json is not signed by a trusted key" });
  });

  it("the test key is trusted only with a loopback feed", async () => {
    publish("stable", "0.2.0");
    const u = flow("0.1.0", { env: { CK_UPDATE_PUBKEY: pub } });
    expect(u.state.feed).toBe("https://raw.githubusercontent.com/MarcelineVPQ/corridorkey-desktop/main/latest.json");
  });

  it("refuses a download whose SHA-512 doesn't match, and keeps nothing", async () => {
    publish("stable", "0.2.0", { sha512: "0".repeat(128) });
    const u = flow("0.1.0");
    await u.check(true);
    await u.download();
    expect(u.state.status).toBe("error");
    expect(u.state.error).toBe("The update didn't install: update refused: the download's SHA-512 doesn't match the signed feed. Your current version is untouched.");
    expect(readdirSync(join(dir, "apps"))).toEqual([appImageName("0.1.0")]);
  });

  it("refuses a download bigger than the feed says", async () => {
    publish("stable", "0.2.0", { size: 100 });
    const u = flow("0.1.0");
    await u.check(true);
    await u.download();
    expect(u.state.error).toMatch(/bigger than the signed feed/);
    expect(readdirSync(join(dir, "apps"))).toEqual([appImageName("0.1.0")]);
  });

  it("says when nothing is published yet", async () => {
    const u = flow("0.1.0");
    await u.check(true);
    expect(u.state).toMatchObject({ status: "error", error: "Couldn't check for updates: no release has been published on the Stable channel yet" });
  });

  it("Development: reads latest-dev.json; Back to stable offers the older stable release", async () => {
    publish("dev", "0.3.0-dev.2");
    publish("stable", "0.2.0");
    const u = flow("0.3.0-dev.1");
    expect(u.state.channel).toBe("dev"); // a dev build starts on Development
    await u.check(true);
    expect(u.state).toMatchObject({ status: "available", latest: "0.3.0-dev.2", feed: `${base}latest-dev.json` });
    u.setAutomatic(false);
    u.setChannel("stable");
    expect(u.state).toMatchObject({ status: "idle", latest: null, channel: "stable" });
    await u.check(true);
    expect(u.state).toMatchObject({ status: "current", latest: "0.2.0" });
    await u.backToStable();
    expect(u.state).toMatchObject({ status: "available", latest: "0.2.0", channel: "stable" });
    // a routine check can't take the offer back
    await u.check(false);
    expect(u.state).toMatchObject({ status: "available", latest: "0.2.0" });
    await u.download();
    expect(u.state.status).toBe("ready");
    expect(readlinkSync(join(dir, "apps", "CorridorKey-Desktop.AppImage"))).toBe(appImageName("0.2.0"));
  });

  it("picking Development again ends Back to stable", async () => {
    publish("stable", "0.2.0");
    const u = flow("0.3.0-dev.1");
    u.setAutomatic(false);
    await u.backToStable();
    expect(u.state.status).toBe("available");
    u.setChannel("dev");
    u.setChannel("stable");
    await u.check(true);
    expect(u.state).toMatchObject({ status: "current", latest: "0.2.0" });
  });

  it("an automatic check that fails keeps the offer on screen", async () => {
    publish("stable", "0.2.0");
    const u = flow("0.1.0");
    await u.check(false);
    expect(u.state.status).toBe("available");
    files.clear();
    files.set("/latest.json", 500);
    await u.check(false);
    expect(u.state).toMatchObject({ status: "available", latest: "0.2.0" });
    await u.check(true);
    expect(u.state).toMatchObject({ status: "error", error: "Couldn't check for updates: the update server answered HTTP 500" });
  });

  it("never replaces a real file that has the stable link's name", async () => {
    publish("stable", "0.2.0");
    const u = flow("0.1.0");
    writeFileSync(join(dir, "apps", "CorridorKey-Desktop.AppImage"), "mine");
    await u.check(true);
    await u.download();
    expect(readFileSync(join(dir, "apps", "CorridorKey-Desktop.AppImage"), "utf8")).toBe("mine");
    u.restart();
    expect(relaunched).toEqual([join(dir, "apps", appImageName("0.2.0"))]);
  });

  it("restart says so when the installed file is gone", async () => {
    publish("stable", "0.2.0");
    const u = flow("0.1.0");
    await u.check(true);
    await u.download();
    rmSync(join(dir, "apps", appImageName("0.2.0")));
    rmSync(join(dir, "apps", "CorridorKey-Desktop.AppImage"));
    u.restart();
    expect(relaunched).toEqual([]);
    expect(u.state).toMatchObject({ status: "error" });
    expect(u.state.error).toMatch(/is gone/);
  });

  it("unsupported (not an AppImage): says why and never goes online", async () => {
    publish("stable", "0.2.0");
    const u = flow("0.1.0", { appImage: null, unsupported: "Updates come with the AppImage build; this copy runs from source." });
    expect(u.state).toMatchObject({ status: "unsupported", error: "Updates come with the AppImage build; this copy runs from source." });
    u.start();
    await u.check(true);
    await u.download();
    expect(u.state.status).toBe("unsupported");
    expect(requests).toEqual([]);
    u.stop();
  });

  it("automatic off: nothing online on its own; on: a check 20 s after start", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
    publish("stable", "0.2.0");
    const u = flow("0.1.0");
    u.setAutomatic(false);
    u.start();
    await vi.advanceTimersByTimeAsync(3 * 3600 * 1000);
    expect(requests).toEqual([]);
    u.setChannel("dev");
    expect(requests).toEqual([]);
    u.setChannel("stable");
    u.setAutomatic(true);
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS - 1);
    expect(requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    // the timer's check runs against the real server (setImmediate isn't faked)
    // loop: NOT-WORTH — test wait, ≤ 500 turns of the event loop
    for (let i = 0; i < 500 && u.state.status !== "available"; i++) await new Promise((r) => setImmediate(r));
    expect(u.state).toMatchObject({ status: "available", latest: "0.2.0" });
    u.stop();
  });

  it("persists the channel and the switch (atomic file)", () => {
    const u = flow("0.1.0");
    u.setChannel("dev");
    u.setAutomatic(false);
    expect(JSON.parse(readFileSync(join(dir, "userData", "updates.json"), "utf8"))).toEqual({ channel: "dev", automatic: false, installed: [] });
    expect(existsSync(join(dir, "userData", "updates.json.tmp"))).toBe(false);
    const again = flow("0.1.0");
    expect(again.state).toMatchObject({ channel: "dev", automatic: false });
  });

  it("start() prunes old versions and cut-short downloads the updater installed, keeping the previous version", () => {
    for (const n of [appImageName("0.0.8"), appImageName("0.0.9"), `${appImageName("0.2.0")}.part`]) writeFileSync(join(dir, "apps", n), "x");
    // loop: NOT-WORTH — three names in a test
    const installed = [appImageName("0.0.8"), appImageName("0.0.9"), appImageName("0.2.0")].map((n) => join(dir, "apps", n));
    writeFileSync(join(dir, "userData", "updates.json"), JSON.stringify({ channel: "stable", automatic: false, installed }));
    const u = flow("0.1.0");
    u.start();
    expect(readdirSync(join(dir, "apps")).sort()).toEqual([appImageName("0.0.9"), appImageName("0.1.0")]);
    // the record drops what is gone
    expect(JSON.parse(readFileSync(join(dir, "userData", "updates.json"), "utf8")).installed).toEqual([installed[1]]);
    u.stop();
  });

  it("start() never removes AppImages the updater didn't install (review 2026-10-27: every start deleted the user's older copies)", () => {
    for (const n of [appImageName("0.0.8"), appImageName("0.0.9"), `${appImageName("0.2.0")}.part`]) writeFileSync(join(dir, "apps", n), "x");
    const u = flow("0.1.0");
    u.setAutomatic(false);
    u.start();
    expect(readdirSync(join(dir, "apps")).sort()).toEqual([appImageName("0.0.8"), appImageName("0.0.9"), appImageName("0.1.0"), `${appImageName("0.2.0")}.part`]);
    u.stop();
  });

  it("records the AppImage it installs, so a later start may prune it", async () => {
    publish("stable", "0.2.0");
    const u = flow("0.1.0");
    await u.check(true);
    await u.download();
    expect(JSON.parse(readFileSync(join(dir, "userData", "updates.json"), "utf8")).installed).toEqual([join(dir, "apps", appImageName("0.2.0"))]);
    u.stop();
  });
});

describe("downloadVerified", () => {
  it("fails a download that stops sending data, and keeps nothing", async () => {
    // lifetime: OK — closed at the end of this test
    const slow = createServer((_req, res) => {
      res.writeHead(200, { "content-length": 100 });
      res.write("partial");
    });
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(slow.address() as AddressInfo).port}/x`;
    const path = join(dir, "x.part");
    await expect(
      downloadVerified(
        (u, i) => fetch(u, i),
        { url, size: 100, sha512: "0".repeat(128) },
        path,
        () => undefined,
        undefined,
        200,
      ),
    ).rejects.toThrow(/stopped/);
    expect(existsSync(path)).toBe(false);
    slow.closeAllConnections();
    await new Promise<void>((r) => slow.close(() => r()));
  });
});
