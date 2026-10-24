// Unpacks chosen files from a zip (a Python wheel: the first-run install's GPU runtime, install.ts).
// Streams each file straight to disk (the CUDA libraries are hundreds of MB each); nothing is held in
// memory but the zip's directory. Stored and deflated entries; Zip64 is refused (no wheel we use needs it).
// The wheel itself is SHA-256 checked before this runs, so entries aren't CRC-checked again.
import { createReadStream, createWriteStream, mkdirSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  mode: number;
}

function readAt(fd: number, offset: number, length: number): Buffer {
  const b = Buffer.alloc(length);
  // loop: NOT-WORTH — one positioned read of the zip's end record or one local header
  readSync(fd, b, 0, length, offset);
  return b;
}

/** The zip's directory. */
export function listZip(file: string): ZipEntry[] {
  // loop: NOT-WORTH — opens the zip once per unpack
  const fd = openSync(file, "r");
  try {
    // loop: NOT-WORTH — one stat per unpack
    const size = fstatSync(fd).size;
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    // loop: NOT-WORTH — scans back over the zip comment (≤ 64 KiB) for the end record, once per unpack
    for (let i = tail.length - 22; i >= 0; i--)
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    if (eocd < 0) throw new Error("not a zip file");
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("Zip64 isn't supported");
    const cd = readAt(fd, cdOffset, cdSize);
    const out: ZipEntry[] = [];
    let p = 0;
    // loop: NOT-WORTH — one pass over the directory (a few hundred entries per wheel)
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error("damaged zip directory");
      const method = cd.readUInt16LE(p + 10);
      const compressedSize = cd.readUInt32LE(p + 20);
      const sizeU = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const external = cd.readUInt32LE(p + 38);
      const localOffset = cd.readUInt32LE(p + 42);
      if (compressedSize === 0xffffffff || sizeU === 0xffffffff || localOffset === 0xffffffff) throw new Error("Zip64 isn't supported");
      out.push({ name: cd.toString("utf8", p + 46, p + 46 + nameLen), method, compressedSize, size: sizeU, localOffset, mode: (external >>> 16) & 0o777 });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    // loop: NOT-WORTH — closes the zip once per unpack
    closeSync(fd);
  }
}

/** Unpack the entries `keep` picks into `dest` (paths as in the zip). Returns how many were unpacked. */
export async function unzip(file: string, dest: string, keep: (name: string) => boolean, abort?: AbortSignal): Promise<number> {
  // loop: NOT-WORTH — filters a few hundred directory entries once per wheel
  const entries = listZip(file).filter((e) => !e.name.endsWith("/") && keep(e.name));
  // loop: NOT-WORTH — opens the zip once per unpack
  const fd = openSync(file, "r");
  try {
    // loop: SERIAL-REQUIRED — one file at a time, streamed (they are hundreds of MB; disk-bound)
    for (const e of entries) {
      // a Stop takes effect between files and inside one (the CUDA libraries take seconds each)
      abort?.throwIfAborted();
      const target = normalize(join(dest, e.name));
      if (!target.startsWith(normalize(dest) + sep)) throw new Error(`refused a path outside the folder: ${e.name}`);
      if (e.method !== 0 && e.method !== 8) throw new Error(`${e.name}: compression method ${e.method} isn't supported`);
      const local = readAt(fd, e.localOffset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new Error("damaged zip entry");
      const start = e.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      // loop: NOT-WORTH — one mkdir per unpacked file
      mkdirSync(dirname(target), { recursive: true });
      const source = createReadStream(file, { start, end: start + e.compressedSize - 1 });
      const sink = createWriteStream(target, { mode: e.mode || 0o644 });
      // loop: SERIAL-REQUIRED — the stream of one file [bounded: the entry's size]
      await (e.method === 8 ? pipeline(source, createInflateRaw(), sink, { signal: abort }) : pipeline(source, sink, { signal: abort }));
    }
  } finally {
    // loop: NOT-WORTH — closes the zip once per unpack
    closeSync(fd);
  }
  return entries.length;
}
