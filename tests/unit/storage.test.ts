import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { folderBytes, pruneCache, storageItems } from "../../electron/main/storage";

describe("storage", () => {
  const dir = mkdtempSync(join(tmpdir(), "ck-storage-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const day = 86_400_000;
  const now = Date.UTC(2026, 9, 24);
  const still = (name: string, bytes: number, ageDays: number) => {
    const p = join(dir, "media", name);
    writeFileSync(p, Buffer.alloc(bytes));
    const t = (now - ageDays * day) / 1000;
    utimesSync(p, t, t);
  };

  it("measures folders, nested ones too, and an absent one as 0", () => {
    mkdirSync(join(dir, "data", "models", "set"), { recursive: true });
    writeFileSync(join(dir, "data", "models", "set", "a.onnx"), Buffer.alloc(1000));
    writeFileSync(join(dir, "data", "models", "b.json"), Buffer.alloc(24));
    expect(folderBytes(join(dir, "data", "models"))).toBe(1024);
    expect(folderBytes(join(dir, "nope"))).toBe(0);
    const items = storageItems(join(dir, "data"), dir, "ONNX Runtime, CUDA, cuDNN");
    expect(items.map((i) => [i.id, i.bytes])).toEqual([
      ["runtime", 0],
      ["models", 1024],
      ["cache", 0],
    ]);
  });

  it("prunes cached stills older than 30 days, then the oldest until under the cap", () => {
    mkdirSync(join(dir, "media"), { recursive: true });
    still("old.jpg", 100, 40);
    still("mid.jpg", 300, 10);
    still("new.jpg", 300, 1);
    // the old one goes for its age; then 600 bytes > a 400-byte cap: the next oldest goes too
    expect(pruneCache(join(dir, "media"), now, 30, 400)).toBe(2);
    expect(readdirSync(join(dir, "media"))).toEqual(["new.jpg"]);
    expect(pruneCache(join(dir, "media"), now, 30, 400)).toBe(0);
    expect(pruneCache(join(dir, "absent"), now)).toBe(0);
  });
});
