import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CACHE_MARKER, cacheDirFor, cacheInfo, cacheUnavailable, clearOldCache, moveCache, prepareTarget, remapMedia, targetProblem } from "../../electron/main/cacheFolder";
import { job } from "./fixtures";

// the cache folder's location (backlog row 44): only the app's own folders are ever written or removed
describe("cache folder", () => {
  const root = mkdtempSync(join(tmpdir(), "ck-cache-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  let n = 0;
  const fresh = () => join(root, `t${++n}`);
  /** A location the user chose: a folder that is there. */
  const place = () => {
    const p = fresh();
    mkdirSync(p);
    return p;
  };
  const put = (p: string, text: string) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  };
  /** A system cache folder with stills, a TensorRT range and a job folder. */
  const filled = () => {
    const dir = join(fresh(), "corridorkey-desktop");
    put(join(dir, "media", "a.jpg"), "still a");
    put(join(dir, "media", "b.jpg"), "still b!");
    put(join(dir, "tensorrt", "1280x720-1920x1088", "stage1.engine"), "engine bytes");
    return dir;
  };
  const tree = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir, { recursive: true, withFileTypes: true })
          .filter((d) => d.isFile())
          .map((d) => join(d.parentPath, d.name).slice(dir.length + 1))
          .sort()
      : [];

  it("a chosen location gets the app's own folder inside it; none: the system's", () => {
    expect(cacheDirFor("/media/fast", "/home/m/.cache/corridorkey-desktop")).toBe(join("/media/fast", "corridorkey-desktop"));
    expect(cacheDirFor(null, "/home/m/.cache/corridorkey-desktop")).toBe("/home/m/.cache/corridorkey-desktop");
  });

  it("refuses the same folder, one inside the other, and someone else's folder", () => {
    const from = filled();
    expect(targetProblem(from, from, false)).toMatch(/already there/);
    expect(targetProblem(from, join(from, "media", "x"), false)).toMatch(/inside the current/);
    expect(targetProblem(from, dirname(from), true)).toMatch(/current cache folder is inside/);
    const theirs = fresh();
    put(join(theirs, "holiday.mov"), "not ours");
    expect(targetProblem(from, theirs, false)).toMatch(/isn't a CorridorKey cache folder/);
    // absent, empty, or one of ours (the marker): fine; the system's folder is always ours
    expect(targetProblem(from, fresh(), false)).toBeNull();
    const empty = fresh();
    mkdirSync(empty);
    expect(targetProblem(from, empty, false)).toBeNull();
    const ours = fresh();
    put(join(ours, CACHE_MARKER), "");
    put(join(ours, "media", "old.jpg"), "x");
    expect(targetProblem(from, ours, false)).toBeNull();
    expect(targetProblem(from, theirs, true)).toBeNull();
  });

  it("moves: every file copied and verified, then the originals removed; the new folder carries the marker", async () => {
    const from = filled();
    const to = join(place(), "corridorkey-desktop");
    const r = await moveCache(from, to, false, true);
    expect(r).toMatchObject({ ok: true, message: null, files: 3, bytes: "still a".length + "still b!".length + "engine bytes".length });
    expect(tree(to)).toEqual([CACHE_MARKER, "media/a.jpg", "media/b.jpg", "tensorrt/1280x720-1920x1088/stage1.engine"].sort());
    expect(readFileSync(join(to, "tensorrt", "1280x720-1920x1088", "stage1.engine"), "utf8")).toBe("engine bytes");
    // the system's folder stays (empty); its moved parts are gone
    expect(existsSync(from)).toBe(true);
    expect(tree(from)).toEqual([]);
  });

  it("a chosen folder moved away from is removed once empty (marker and all), anything else in it stays", async () => {
    const from = join(fresh(), "corridorkey-desktop");
    put(join(from, CACHE_MARKER), "");
    put(join(from, "media", "a.jpg"), "a");
    const back = join(fresh(), "sys");
    expect((await moveCache(from, back, true, false)).ok).toBe(true);
    expect(existsSync(from)).toBe(false);
    expect(tree(back)).toEqual(["media/a.jpg"]);
    // something not ours left in it: the folder and that file stay
    const from2 = join(fresh(), "corridorkey-desktop");
    put(join(from2, CACHE_MARKER), "");
    put(join(from2, "media", "a.jpg"), "a");
    put(join(from2, "notes.txt"), "someone's");
    expect((await moveCache(from2, join(place(), "x"), false, false)).ok).toBe(true);
    expect(tree(from2)).toEqual([CACHE_MARKER, "notes.txt"].sort());
  });

  it("any error: nothing removed from the old cache, only its own copies taken back, the target left as it was", async () => {
    // a link inside the cache (not a plain file): refused before anything is copied
    const from = filled();
    symlinkSync(join(from, "media", "a.jpg"), join(from, "media", "link.jpg"));
    const to = join(place(), "corridorkey-desktop");
    const r = await moveCache(from, to, false, true);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Nothing was moved: .*link\.jpg/);
    expect(tree(from)).toEqual(["media/a.jpg", "media/b.jpg", "tensorrt/1280x720-1920x1088/stage1.engine"]);
    expect(existsSync(to)).toBe(false);

    // a file already in the target (one of our folders): never overwritten; the copies made before it are taken back
    const from2 = filled();
    const ours = fresh();
    put(join(ours, CACHE_MARKER), "");
    put(join(ours, "media", "b.jpg"), "theirs, older");
    const r2 = await moveCache(from2, ours, false, true);
    expect(r2.ok).toBe(false);
    expect(tree(from2)).toEqual(["media/a.jpg", "media/b.jpg", "tensorrt/1280x720-1920x1088/stage1.engine"]);
    expect(tree(ours)).toEqual([CACHE_MARKER, "media/b.jpg"].sort());
    expect(readFileSync(join(ours, "media", "b.jpg"), "utf8")).toBe("theirs, older");
  });

  it("an unplugged drive: the chosen location is never made, only the app's own folder inside one that is there", async () => {
    const from = filled();
    const gone = join(fresh(), "disk");
    const to = join(gone, "corridorkey-desktop");
    expect(targetProblem(from, to, false)).toMatch(/isn't there: is its drive connected\?/);
    await expect(prepareTarget(to, false)).rejects.toThrow(/isn't there: is its drive connected\?/);
    const r = await moveCache(from, to, false, true);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/drive connected/);
    expect(existsSync(gone)).toBe(false);
    expect(tree(from)).toEqual(["media/a.jpg", "media/b.jpg", "tensorrt/1280x720-1920x1088/stage1.engine"]);
    // a location that is there: only its own folder is made
    const there = place();
    await prepareTarget(join(there, "corridorkey-desktop"), false);
    expect(tree(there)).toEqual([join("corridorkey-desktop", CACHE_MARKER)]);
  });

  it("the chosen folder is unavailable when its location is gone or the marked folder isn't in it (Linux, Windows, macOS paths)", () => {
    expect(cacheUnavailable(null)).toBeNull();
    const there = new Set(["/media/m/disk", "E:\\", "/Volumes/Fast", join("/Volumes/Fast", "corridorkey-desktop", CACHE_MARKER)]);
    const exists = (p: string) => there.has(p);
    expect(cacheUnavailable("/Volumes/Fast", exists)).toBeNull();
    expect(cacheUnavailable("/Volumes/Gone", exists)).toMatch(/\/Volumes\/Gone isn't there/);
    expect(cacheUnavailable("F:\\", exists)).toMatch(/isn't there: is its drive connected/);
    // an empty mount point left behind (the drive not mounted): the marked folder isn't in it
    expect(cacheUnavailable("/media/m/disk", exists)).toMatch(/The cache folder isn't in \/media\/m\/disk/);
    // real folders
    const ours = place();
    put(join(ours, "corridorkey-desktop", CACHE_MARKER), "");
    expect(cacheUnavailable(ours)).toBeNull();
    expect(cacheUnavailable(join(root, "unplugged"))).toMatch(/isn't there/);
  });

  it("starting fresh removes only the old cache's own parts", async () => {
    const from = filled();
    put(join(from, "jobs", "j1", "frame.bin"), "x");
    put(join(from, "settings-note.txt"), "not a cache part");
    expect(await clearOldCache(from, true)).toBeNull();
    expect(tree(from)).toEqual(["settings-note.txt"]);
  });

  it("measures per clip in the queue, the stills of clips no longer queued, and per TensorRT range", () => {
    const dir = filled();
    put(join(dir, "jobs", "j1", "work.bin"), "12345");
    const url = (f: string) => `ck-media://f/${encodeURIComponent(f)}`;
    const fileOf = (u: string) => decodeURIComponent(new URL(u).pathname.slice(1));
    const jobs = [
      job("j1", { clip: { ...job("j1").clip, name: "shot01", thumb: url(join(dir, "media", "a.jpg")) } }),
      job("j2", { clip: { ...job("j2").clip, name: "shot02" }, stills: [{ output: "alpha", url: url("/elsewhere/x.jpg") }] }),
    ];
    const info = cacheInfo(dir, "/sys", jobs, fileOf);
    expect(info.shots).toEqual([
      { name: "shot01", bytes: "still a".length + 5 },
      { name: "shot02", bytes: 0 },
    ]);
    expect(info.otherBytes).toBe("still b!".length);
    expect(info.trtRanges).toEqual([{ range: "1280x720-1920x1088", bytes: "engine bytes".length }]);
    expect(info.bytes).toBe("still a".length + "still b!".length + "engine bytes".length + 5);
    expect(info.isDefault).toBe(false);
  });

  it("a moved still's URL points into the new folder; anything else stays", () => {
    const url = (f: string) => `ck-media://f/${encodeURIComponent(f)}`;
    const fileOf = (u: string) => decodeURIComponent(new URL(u).pathname.slice(1));
    expect(remapMedia(url("/old/media/a.jpg"), "/old/media", "/new/media", fileOf, url)).toBe(url("/new/media/a.jpg"));
    expect(remapMedia(url("/other/a.jpg"), "/old/media", "/new/media", fileOf, url)).toBe(url("/other/a.jpg"));
  });
});
