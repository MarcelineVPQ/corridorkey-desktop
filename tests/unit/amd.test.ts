import { describe, expect, it } from "vitest";
import { amdSwitchOn, findAmdCard, gfxName, KFD_NODES, type AmdSys } from "../../electron/main/amd";

// a CPU node and an RX 7900 XTX as the kernel writes them (abridged KFD properties; the engine's amd.rs fixtures)
const CPU = "cpu_cores_count 16\nsimd_count 0\ngfx_target_version 0\ndrm_render_minor 0\n";
const XTX = "cpu_cores_count 0\nsimd_count 192\ngfx_target_version 110000\nvendor_id 4098\ndrm_render_minor 128\n";

/** A fake sysfs: KFD nodes by number, and the device files this user may open. */
function sys(nodes: Record<string, string> | null, open: string[] = ["/dev/kfd", "/dev/dri/renderD128"]): AmdSys {
  return {
    list: (dir) => {
      if (dir !== KFD_NODES || !nodes) throw new Error("ENOENT");
      return Object.keys(nodes);
    },
    read: (file) => {
      const n = nodes && Object.entries(nodes).find(([k]) => file === `${KFD_NODES}/${k}/properties`);
      if (!n) throw new Error("ENOENT");
      return n[1];
    },
    canOpen: (dev) => open.includes(dev),
  };
}

describe("AMD cards (on by default; CK_AMD=0 turns them off)", () => {
  it("is on unless CK_AMD=0", () => {
    expect(amdSwitchOn({})).toBe(true);
    expect(amdSwitchOn({ CK_AMD: "1" })).toBe(true);
    expect(amdSwitchOn({ CK_AMD: "0" })).toBe(false);
  });

  it("names gfx targets as the engine does (minor and stepping in hex)", () => {
    expect([gfxName(110000), gfxName(90402), gfxName(90010), gfxName(120001), gfxName(0)]).toEqual(["gfx1100", "gfx942", "gfx90a", "gfx1201", null]);
  });

  it("finds the first GPU node, skipping CPU nodes, and whether this user may open it", () => {
    expect(findAmdCard(sys({ "0": CPU, "1": XTX }))).toEqual({ gfx: "gfx1100", minor: 128, access: true });
    // not in the render group: the card is there, its device files aren't open to us
    expect(findAmdCard(sys({ "0": CPU, "1": XTX }, ["/dev/kfd"]))).toEqual({ gfx: "gfx1100", minor: 128, access: false });
    expect(findAmdCard(sys({ "0": CPU, "1": XTX }, []))?.access).toBe(false);
  });

  it("takes the first supported card: a Ryzen iGPU (gfx1036) listed before an RX 7900 is skipped", () => {
    const IGPU = "cpu_cores_count 0\nsimd_count 4\ngfx_target_version 100306\nvendor_id 4098\ndrm_render_minor 129\n";
    const supported = (gfx: string) => gfx === "gfx1100";
    const nodes = { "0": CPU, "1": IGPU, "2": XTX };
    expect(findAmdCard(sys(nodes, ["/dev/kfd", "/dev/dri/renderD128", "/dev/dri/renderD129"]), supported)).toEqual({ gfx: "gfx1100", minor: 128, access: true });
    // no supported card: the first GPU node, so the setup can say its gfx target isn't supported
    expect(findAmdCard(sys({ "0": CPU, "1": IGPU }), supported)).toEqual({ gfx: "gfx1036", minor: 129, access: false });
    // without a rule every GPU node counts (the first one)
    expect(findAmdCard(sys(nodes))?.gfx).toBe("gfx1036");
  });

  it("finds nothing without the KFD driver or a GPU node", () => {
    expect(findAmdCard(sys(null))).toBeNull();
    expect(findAmdCard(sys({ "0": CPU }))).toBeNull();
  });
});
