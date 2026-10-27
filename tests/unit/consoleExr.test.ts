// exrheader (SME review 2026-10-27 N6, backlog row 145): an OpenEXR header read from a file's first bytes
// (electron/main/console/exr.ts), on headers built here byte by byte as the OpenEXR file layout lays them out.
import { describe, expect, it } from "vitest";
import { exrLines, parseExrHeader } from "../../electron/main/console/exr";
import { attr, box, chlist, exrFile, f32 } from "./exrBytes";

const plate = exrFile(0, [
  attr(
    "channels",
    "chlist",
    chlist([
      ["A", 1],
      ["B", 1],
      ["G", 1],
      ["R", 1],
    ]),
  ),
  attr("compression", "compression", Buffer.from([4])),
  attr("dataWindow", "box2i", box(0, 0, 4095, 2159)),
  attr("displayWindow", "box2i", box(0, 0, 4095, 2159)),
  attr("lineOrder", "lineOrder", Buffer.from([0])),
  attr("pixelAspectRatio", "float", f32(1)),
  attr("screenWindowWidth", "float", f32(1)),
]);

describe("exrheader", () => {
  it("reads resolution, data window, channels, alpha, pixel type, compression and line order", () => {
    const h = parseExrHeader(plate);
    if ("error" in h) throw new Error(h.error);
    expect(exrLines(h)).toEqual([
      "  resolution   4096 x 2160",
      "  data window  0,0 - 4095,2159 (the whole frame)",
      "  channels     4: A, B, G, R",
      "  pixel type   half",
      "  alpha        yes",
      "  compression  PIZ",
      "  line order   increasing y",
      "  storage      scan lines (OpenEXR version 2)",
      "  other        screenWindowWidth (float)",
    ]);
  });

  it("says a data window smaller than the frame, mixed pixel types, no alpha, tiles", () => {
    const h = parseExrHeader(
      exrFile(0x200, [
        attr(
          "channels",
          "chlist",
          chlist([
            ["R", 2],
            ["Z", 2],
            ["G", 1],
          ]),
        ),
        attr("compression", "compression", Buffer.from([8])),
        attr("dataWindow", "box2i", box(100, 50, 1099, 549)),
        attr("displayWindow", "box2i", box(0, 0, 1919, 1079)),
      ]),
    );
    if ("error" in h) throw new Error(h.error);
    const l = exrLines(h);
    expect(l).toContain("  data window  100,50 - 1099,549, 1000 x 500 (display window 0,0 - 1919,1079)");
    expect(l).toContain("  channels     3: R float, Z float, G half");
    expect(l).toContain("  alpha        no");
    expect(l).toContain("  compression  DWAA");
    expect(l.at(-1)).toBe("  storage      tiles (OpenEXR version 2)");
  });

  it("lists each part of a multi-part file by name", () => {
    const part = (name: string) => [attr("name", "string", Buffer.from(name)), attr("type", "string", Buffer.from("scanlineimage")), attr("channels", "chlist", chlist([["A", 1]]))];
    const h = parseExrHeader(exrFile(0x1000, [...part("beauty"), Buffer.from([0]), ...part("matte")], Buffer.from([0, 0])));
    if ("error" in h) throw new Error(h.error);
    expect(h.parts.map((p) => p.name)).toEqual(["beauty", "matte"]);
    expect(exrLines(h).slice(0, 2)).toEqual(["2 parts", "part 0: beauty (scanlineimage)"]);
  });

  it("refuses what isn't an EXR, and a header cut short, in words", () => {
    expect(parseExrHeader(Buffer.from("not an exr file"))).toEqual({ error: expect.stringMatching(/isn't an OpenEXR file/) });
    expect(parseExrHeader(plate.subarray(0, 40))).toEqual({ error: expect.stringMatching(/header doesn't end/) });
  });
});
