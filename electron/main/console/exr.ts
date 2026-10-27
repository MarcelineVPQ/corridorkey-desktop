// `exrheader` (SME review 2026-10-27 N6): an OpenEXR file's header as a TD reads it before keying a plate ("is this the
// 4K one? does it have alpha?"), without leaving for OpenEXR's own exrheader. Pure: the bytes of the file's start in,
// the header's facts out (the OpenEXR file layout: magic, version and flags, then each part's attributes, name\0 type\0
// size value, ended by an empty name). Only what is read is said; an attribute it doesn't know is listed by name.

/** The bytes read from a file's start: a header longer than this (thousands of channels) is said, not guessed. */
export const EXR_HEADER_MAX = 256 * 1024;

export interface ExrChannel {
  name: string;
  type: "uint" | "half" | "float" | "unknown";
  xSampling: number;
  ySampling: number;
}

export interface ExrPart {
  name: string | null;
  channels: ExrChannel[];
  compression: string | null;
  dataWindow: [number, number, number, number] | null;
  displayWindow: [number, number, number, number] | null;
  lineOrder: string | null;
  pixelAspectRatio: number | null;
  /** the part's type attribute (scanlineimage, tiledimage, deepscanline, deeptile), multi-part files */
  type: string | null;
  /** the other attributes' names and types */
  other: string[];
}

export interface ExrHeader {
  version: number;
  tiled: boolean;
  deep: boolean;
  multipart: boolean;
  parts: ExrPart[];
}

const COMPRESSION = ["none", "RLE", "ZIPS", "ZIP", "PIZ", "PXR24", "B44", "B44A", "DWAA", "DWAB", "HTJ2K"];
const LINE_ORDER = ["increasing y", "decreasing y", "random y"];
const PIXEL = ["uint", "half", "float"] as const;

/** The header in `buf` (the file's first bytes), or why it can't be read. */
export function parseExrHeader(buf: Buffer): ExrHeader | { error: string } {
  if (buf.length < 8 || buf.readUInt32LE(0) !== 20000630) return { error: "isn't an OpenEXR file (its first bytes aren't the EXR magic number)" };
  const v = buf.readUInt32LE(4);
  const head: ExrHeader = { version: v & 0xff, tiled: (v & 0x200) !== 0, deep: (v & 0x800) !== 0, multipart: (v & 0x1000) !== 0, parts: [] };
  let at = 8;
  const short = { error: `its header doesn't end within the first ${EXR_HEADER_MAX / 1024} KiB read (or the file is cut short)` };
  const cstr = (): string | null => {
    const end = buf.indexOf(0, at);
    if (end < 0) return null;
    const s = buf.toString("latin1", at, end);
    at = end + 1;
    return s;
  };
  // loop: NOT-WORTH — a file's parts (one, or a multi-part file's few) [bounded: the bytes read]
  for (;;) {
    const part: ExrPart = { name: null, channels: [], compression: null, dataWindow: null, displayWindow: null, lineOrder: null, pixelAspectRatio: null, type: null, other: [] };
    // loop: NOT-WORTH — one part's attributes (a few dozen) [bounded: the bytes read]
    for (;;) {
      const name = cstr();
      if (name === null) return short;
      if (name === "") break;
      const type = cstr();
      if (type === null || at + 4 > buf.length) return short;
      const size = buf.readInt32LE(at);
      at += 4;
      if (size < 0 || at + size > buf.length) return short;
      const val = buf.subarray(at, at + size);
      at += size;
      if (type === "chlist") part.channels = channels(val);
      else if (type === "compression" && size >= 1) part.compression = COMPRESSION[val[0]] ?? `unknown (${val[0]})`;
      else if (type === "box2i" && size >= 16 && (name === "dataWindow" || name === "displayWindow")) part[name] = [val.readInt32LE(0), val.readInt32LE(4), val.readInt32LE(8), val.readInt32LE(12)];
      else if (type === "lineOrder" && size >= 1) part.lineOrder = LINE_ORDER[val[0]] ?? `unknown (${val[0]})`;
      else if (name === "pixelAspectRatio" && type === "float" && size >= 4) part.pixelAspectRatio = val.readFloatLE(0);
      else if (name === "name" && type === "string") part.name = val.toString("utf8");
      else if (name === "type" && type === "string") part.type = val.toString("utf8");
      else part.other.push(`${name} (${type})`);
    }
    head.parts.push(part);
    // a single-part file has one header; a multi-part one ends its list of headers with an empty one
    if (!head.multipart) break;
    if (at >= buf.length) return short;
    if (buf[at] === 0) break;
  }
  return head;
}

/** A chlist value: name\0, pixel type (int), pLinear (byte), 3 reserved, x and y sampling (ints); an empty name ends it. */
function channels(val: Buffer): ExrChannel[] {
  const out: ExrChannel[] = [];
  let at = 0;
  // loop: NOT-WORTH — one header's channels [bounded: the attribute's bytes]
  while (at < val.length && val[at] !== 0) {
    const end = val.indexOf(0, at);
    if (end < 0 || end + 17 > val.length) break;
    const name = val.toString("latin1", at, end);
    out.push({ name, type: PIXEL[val.readInt32LE(end + 1)] ?? "unknown", xSampling: val.readInt32LE(end + 9), ySampling: val.readInt32LE(end + 13) });
    at = end + 17;
  }
  return out;
}

/** The header as the block prints it: resolution, data window, channels, alpha, compression, pixel types… */
export function exrLines(h: ExrHeader): string[] {
  const lines: string[] = [];
  const box = (b: [number, number, number, number]) => `${b[0]},${b[1]} - ${b[2]},${b[3]}`;
  const row = (k: string, v: string) => `  ${k.padEnd(13)}${v}`;
  if (h.multipart) lines.push(`${h.parts.length} parts`);
  // loop: NOT-WORTH — a file's few parts
  for (const [i, p] of h.parts.entries()) {
    if (h.multipart) lines.push(`part ${i}${p.name ? `: ${p.name}` : ""}${p.type ? ` (${p.type})` : ""}`);
    const d = p.displayWindow;
    const w = p.dataWindow;
    if (d) lines.push(row("resolution", `${d[2] - d[0] + 1} x ${d[3] - d[1] + 1}${p.pixelAspectRatio !== null && p.pixelAspectRatio !== 1 ? `, pixel aspect ${+p.pixelAspectRatio.toFixed(4)}` : ""}`));
    // loop: NOT-WORTH — four numbers
    const whole = d !== null && w !== null && w.every((x, k) => x === d[k]);
    if (w) lines.push(row("data window", `${box(w)}${whole ? " (the whole frame)" : `, ${w[2] - w[0] + 1} x ${w[3] - w[1] + 1}${d ? ` (display window ${box(d)})` : ""}`}`));
    // loop: NOT-WORTH — the part's channels
    const types = [...new Set(p.channels.map((c) => c.type))];
    // loop: NOT-WORTH — as above
    const names = p.channels.map((c) => (types.length > 1 ? `${c.name} ${c.type}` : c.name) + (c.xSampling !== 1 || c.ySampling !== 1 ? ` (sampled ${c.xSampling}x${c.ySampling})` : ""));
    lines.push(row("channels", `${p.channels.length}: ${names.join(", ") || "none"}`));
    if (types.length === 1) lines.push(row("pixel type", types[0]));
    // loop: NOT-WORTH — as above
    lines.push(row("alpha", p.channels.some((c) => c.name === "A" || c.name.endsWith(".A")) ? "yes" : "no"));
    if (p.compression) lines.push(row("compression", p.compression));
    if (p.lineOrder) lines.push(row("line order", p.lineOrder));
  }
  // loop: NOT-WORTH — the few parts
  lines.push(row("storage", `${h.deep ? "deep " : ""}${h.tiled || h.parts.some((p) => /tile/.test(p.type ?? "")) ? "tiles" : "scan lines"} (OpenEXR version ${h.version})`));
  // loop: NOT-WORTH — the parts' other attributes
  const other = [...new Set(h.parts.flatMap((p) => p.other))];
  if (other.length) lines.push(row("other", other.join(", ")));
  return lines;
}
