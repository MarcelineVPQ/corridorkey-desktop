import { describe, expect, it } from "vitest";
import { checkAll, checkSystems, packagedSystems, uninstallProblems } from "../../tools/check_platform_docs.mjs";

// Uninstall.md before 2026-10-27: Linux and Windows only.
const OLD_UNINSTALL = "# Uninstall\n\n| What | Linux | Windows |\n| --- | --- | --- |\n\n## Linux\n\n1. Quit.\n\n## Windows\n\n1. Uninstall.\n";
const NEW_UNINSTALL = OLD_UNINSTALL.replace("| What | Linux | Windows |", "| What | Linux | Windows | macOS |") + "\n## macOS\n\n1. Bin.\n";

describe("the per-OS docs gate", () => {
  it("passes on this repository", () => {
    expect(checkAll()).toEqual([]);
  });

  it("reads the packaged systems", () => {
    expect(packagedSystems("appId: x\nlinux:\n  target: []\nwin:\n  x: 1\nnsis:\n  y: 2\nmac:\n  z: 3\n")).toEqual(["Linux", "Windows", "macOS"]);
  });

  it("(b) the old Uninstall.md fails for macOS: no section, no column", () => {
    expect(uninstallProblems("Linux", OLD_UNINSTALL)).toEqual([]);
    expect(uninstallProblems("macOS", OLD_UNINSTALL)).toEqual([expect.stringContaining('no "## macOS" section'), expect.stringContaining("no macOS column")]);
    expect(uninstallProblems("macOS", NEW_UNINSTALL)).toEqual([]);
  });

  it("(a) a missing install page fails unless listed; a stale exception fails", () => {
    const wiki = { "Uninstall.md": NEW_UNINSTALL, "Installing-on-Linux.md": "x" };
    const none = new Map<string, string>();
    expect(checkSystems(["Linux", "macOS"], wiki, none)).toEqual([expect.stringContaining("Installing-on-macOS.md is missing")]);
    const listed = new Map([["Installing-on-macOS.md", "no Mac build yet"]]);
    expect(checkSystems(["Linux", "macOS"], wiki, listed)).toEqual([]);
    expect(checkSystems(["Linux", "macOS"], { ...wiki, "Installing-on-macOS.md": "x" }, listed)).toEqual([expect.stringContaining("exists now")]);
    expect(checkSystems(["Linux"], wiki, listed)).toEqual([expect.stringContaining("for no packaged system")]);
    expect(checkSystems(["Linux", "macOS"], wiki, new Map([...listed, ["Uninstall.md#macOS", "x"]]))).toEqual([expect.stringContaining('"Uninstall.md#macOS", which is there now')]);
  });
});
