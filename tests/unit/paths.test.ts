import { describe, expect, it } from "vitest";
import { shortenPath } from "../../src/ui/paths";

describe("shortenPath", () => {
  it("shows the home folder as ~", () => {
    expect(shortenPath("/home/marcy/clips/take1.mp4", "/home/marcy")).toBe("~/clips/take1.mp4");
    expect(shortenPath("/home/marcy", "/home/marcy/")).toBe("~");
  });
  it("leaves a folder that only starts with the home's name alone", () => {
    expect(shortenPath("/home/marcy2/a.mp4", "/home/marcy")).toBe("/home/marcy2/a.mp4");
  });
  it("leaves a short path whole", () => {
    expect(shortenPath("/srv/plates/a.exr", "/home/marcy")).toBe("/srv/plates/a.exr");
  });
  it("cuts the middle folders of a long path, keeping its start and its end", () => {
    const s = shortenPath("/home/marcy/.cache/claude-scratch/ui-pass/clips/out_walking_sitting/walking_sitting_alpha.mp4", "/home/marcy", 52);
    expect(s).toBe("~/…/out_walking_sitting/walking_sitting_alpha.mp4");
    expect(s.length).toBeLessThanOrEqual(52);
  });
  it("cuts a path from the root the same way", () => {
    expect(shortenPath("/mnt/raid/projects/show/episode-104/plates/sh010/sh010_bg_v003.exr", "/home/marcy", 40)).toBe("/…/plates/sh010/sh010_bg_v003.exr");
  });
  it("cuts inside a name that is too long on its own, keeping its extension", () => {
    const s = shortenPath(`/home/marcy/${"x".repeat(80)}.mp4`, "/home/marcy", 40);
    expect(s.startsWith("~/…/xxxx")).toBe(true);
    expect(s.endsWith("xx.mp4")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(40);
  });
  it("handles Windows paths and their case-insensitive home", () => {
    expect(shortenPath("C:\\Users\\Marcy\\Videos\\a.mp4", "c:\\users\\marcy")).toBe("~\\Videos\\a.mp4");
    expect(shortenPath("D:\\footage\\show\\episode-104\\plates\\sh010\\sh010_bg_v003.mov", "C:\\Users\\Marcy", 30)).toBe("D:\\…\\sh010\\sh010_bg_v003.mov");
  });
});
