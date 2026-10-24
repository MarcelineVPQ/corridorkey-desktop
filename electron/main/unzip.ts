// Unpacks chosen files from a zip (a Python wheel: the first-run install's GPU runtime, install.ts).
// Streams each file straight to disk (the CUDA libraries are hundreds of MB each); nothing is held in
// memory but the zip's directory. Stored and deflated entries, Zip64 included (NVIDIA's 3.7 GB TensorRT wheel puts its
// offsets past 2 GiB in Zip64 fields, as Python's zipfile does).
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

// a Zip64 value; past 2^53 (8 PiB) a Number can't hold it exactly
function u64(b: Buffer, at: number): number {
  const n = b.readBigUInt64LE(at);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("damaged Zip64 value");
  return Number(n);
}

/** The zip's directory, read through an open file descriptor. */
export function listZip(fd: number): ZipEntry[] {
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
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // Zip64: the locator sits just before the end record and points at the Zip64 end record
    if (eocd < 20 || tail.readUInt32LE(eocd - 20) !== 0x07064b50) throw new Error("damaged Zip64 end record");
    const end64 = readAt(fd, u64(tail, eocd - 12), 56);
    if (end64.readUInt32LE(0) !== 0x06064b50) throw new Error("damaged Zip64 end record");
    count = u64(end64, 32);
    cdSize = u64(end64, 40);
    cdOffset = u64(end64, 48);
  }
  const cd = readAt(fd, cdOffset, cdSize);
  const out: ZipEntry[] = [];
  let p = 0;
  // loop: NOT-WORTH — one pass over the directory (a few hundred entries per wheel)
  for (let i = 0; i < count; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error("damaged zip directory");
    const method = cd.readUInt16LE(p + 10);
    let compressedSize = cd.readUInt32LE(p + 20);
    let sizeU = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const external = cd.readUInt32LE(p + 38);
    let localOffset = cd.readUInt32LE(p + 42);
    if (compressedSize === 0xffffffff || sizeU === 0xffffffff || localOffset === 0xffffffff) {
      // the real values are in the Zip64 extra field (id 1), only those marked 0xffffffff, in this order
      let x = p + 46 + nameLen;
      const xEnd = x + extraLen;
      // loop: NOT-WORTH — walks one entry's extra fields (a few)
      while (x + 4 <= xEnd && cd.readUInt16LE(x) !== 0x0001) x += 4 + cd.readUInt16LE(x + 2);
      if (x + 4 > xEnd) throw new Error("damaged Zip64 entry");
      let v = x + 4;
      const next = (): number => {
        if (v + 8 > x + 4 + cd.readUInt16LE(x + 2)) throw new Error("damaged Zip64 entry");
        const n = u64(cd, v);
        v += 8;
        return n;
      };
      if (sizeU === 0xffffffff) sizeU = next();
      if (compressedSize === 0xffffffff) compressedSize = next();
      if (localOffset === 0xffffffff) localOffset = next();
    }
    out.push({ name: cd.toString("utf8", p + 46, p + 46 + nameLen), method, compressedSize, size: sizeU, localOffset, mode: (external >>> 16) & 0o777 });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Unpack the entries `keep` picks into `dest` (paths as in the zip). Returns the names unpacked. */
export async function unzip(file: string, dest: string, keep: (name: string) => boolean, abort?: AbortSignal): Promise<string[]> {
  // loop: NOT-WORTH — opens the zip once per unpack
  const fd = openSync(file, "r");
  try {
    // loop: NOT-WORTH — filters a few hundred directory entries once per wheel
    const entries = listZip(fd).filter((e) => !e.name.endsWith("/") && keep(e.name));
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
      const sink = createWriteStream(target, { mode: e.mode || 0o644 });
      if (e.compressedSize === 0) {
        // an empty file (a stored 0-byte licence): a read stream can't cover zero bytes, so just create it
        // loop: SERIAL-REQUIRED — closes one empty file [bounded: an empty write]
        await new Promise<void>((resolve, reject) => sink.end((err?: Error | null) => (err ? reject(err) : resolve())));
        continue;
      }
      const source = createReadStream(file, { start, end: start + e.compressedSize - 1 });
      // loop: SERIAL-REQUIRED — the stream of one file [bounded: the entry's size]
      await (e.method === 8 ? pipeline(source, createInflateRaw(), sink, { signal: abort }) : pipeline(source, sink, { signal: abort }));
    }
    // loop: NOT-WORTH — the unpacked names, once per wheel
    return entries.map((e) => e.name);
  } finally {
    // loop: NOT-WORTH — closes the zip once per unpack
    closeSync(fd);
  }
}
