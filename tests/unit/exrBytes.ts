// OpenEXR headers built byte by byte, as the file layout lays them out (consoleExr.test.ts, consoleRunner.test.ts).
export const i32 = (...n: number[]) => Buffer.concat(n.map((x) => Buffer.from(new Int32Array([x]).buffer)));
export const attr = (name: string, type: string, value: Buffer) => Buffer.concat([Buffer.from(`${name}\0${type}\0`, "latin1"), i32(value.length), value]);
export const chlist = (chs: [string, number][]) => Buffer.concat([...chs.map(([n, t]) => Buffer.concat([Buffer.from(`${n}\0`), i32(t), Buffer.from([0, 0, 0, 0]), i32(1, 1)])), Buffer.from([0])]);
export const box = (x0: number, y0: number, x1: number, y1: number) => i32(x0, y0, x1, y1);
export const f32 = (x: number) => Buffer.from(new Float32Array([x]).buffer);
/** magic, version 2 with flags, the attributes, the empty name that ends the header */
export const exrFile = (flags: number, attrs: Buffer[], tail: Buffer = Buffer.from([0])) => Buffer.concat([i32(20000630, 2 | flags), ...attrs, tail]);
