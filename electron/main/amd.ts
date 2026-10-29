// AMD graphics cards on Linux (ROCm 10.1 and AMD's MIGraphX provider; docs/AMD.md, backlog row 166), behind one
// switch: CK_AMD=1 in the app's environment. Off (the default) nothing here reads the system and the app is what it
// was: an AMD card gets the "no NVIDIA driver" message. Untested on a real AMD card.
// The card comes from the kernel's KFD topology, the same files and rule as the engine's (engine-rs ck-core amd.rs):
// a GPU node has SIMDs and a gfx target; /dev/kfd and the node's render device must open for reading and writing
// (else the user isn't in the render group yet).
import { accessSync, constants, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The switch: `CK_AMD=1` turns the AMD path on (setup detection, the AMD runtime, MIGraphX's models). */
export const AMD_SWITCH = "CK_AMD";
export const amdSwitchOn = (env: NodeJS.ProcessEnv): boolean => env[AMD_SWITCH] === "1";

export const KFD_NODES = "/sys/class/kfd/kfd/topology/nodes";

/** An AMD card as the kernel shows it: its gfx target ("gfx1100"), its render node and whether this user may open it. */
export interface AmdCard {
  gfx: string;
  // /dev/dri/renderD<minor>; its sysfs folder /sys/class/drm/renderD<minor>/device has the memory files (gpu.ts)
  minor: number;
  access: boolean;
}

/** What findAmdCard reads (tests pass a fake sysfs). */
export interface AmdSys {
  list: (dir: string) => string[];
  read: (file: string) => string;
  canOpen: (dev: string) => boolean;
}

/**
 * The gfx target name of KFD's gfx_target_version (major * 10000 + minor * 100 + stepping, minor and stepping in hex
 * in the name): 110000 = gfx1100, 90402 = gfx942, 90010 = gfx90a, 120001 = gfx1201. Null for 0 (a CPU node).
 */
export function gfxName(v: number): string | null {
  return v > 0 ? `gfx${Math.floor(v / 10000)}${(Math.floor(v / 100) % 100).toString(16)}${(v % 100).toString(16)}` : null;
}

/** A KFD node's `properties` file ("name value" lines) as numbers. */
function props(text: string): Map<string, number> {
  const m = new Map<string, number>();
  // loop: NOT-WORTH — a few dozen lines per node, once per setup check
  for (const line of text.split("\n")) {
    const [k, v] = line.trim().split(" ");
    if (k && /^\d+$/.test(v ?? "")) m.set(k, Number(v));
  }
  return m;
}

const realSys: AmdSys = {
  // loop: NOT-WORTH — the KFD topology's few nodes, once per setup check
  list: (dir) => readdirSync(dir),
  // loop: NOT-WORTH — one small sysfs file per node
  read: (file) => readFileSync(file, "utf8"),
  canOpen: (dev) => {
    try {
      // loop: NOT-WORTH — two access checks per setup check
      accessSync(dev, constants.R_OK | constants.W_OK);
      return true;
    } catch {
      // error: SHOWN — no access: the setup says to join the render group
      return false;
    }
  },
};

/**
 * The machine's first AMD GPU node whose gfx target `supported` takes (KFD's node order), else its first GPU node (so
 * the setup can say that card isn't supported), or null when there is none (no amdgpu/KFD driver, or no GPU node):
 * a Ryzen iGPU listed before a supported card is skipped. Limit: the engine runs on HIP's device 0 (amd.rs, by PCI
 * bus id), which the app can't ask for without HIP; with several AMD GPUs that may be another card (docs/AMD.md says
 * how to pick it). Only the chosen card's device libraries are downloaded.
 */
export function findAmdCard(sys: AmdSys = realSys, supported: (gfx: string) => boolean = () => true): AmdCard | null {
  let nodes: string[];
  try {
    nodes = sys.list(KFD_NODES);
  } catch {
    // error: NOT-WORTH — no KFD driver: no AMD card ROCm can use (the setup says so)
    return null;
  }
  let first: AmdCard | null = null;
  // loop: NOT-WORTH — the topology's few nodes (CPU and GPU), once per setup check
  for (const n of [...nodes].sort((a, b) => Number(a) - Number(b))) {
    let p: Map<string, number>;
    try {
      p = props(sys.read(join(KFD_NODES, n, "properties")));
    } catch {
      // error: NOT-WORTH — a node without a readable properties file is skipped
      continue;
    }
    const gfx = gfxName(p.get("gfx_target_version") ?? 0);
    const minor = p.get("drm_render_minor");
    if (!gfx || !(p.get("simd_count") ?? 0) || minor === undefined) continue;
    const card = { gfx, minor, access: sys.canOpen("/dev/kfd") && sys.canOpen(`/dev/dri/renderD${minor}`) };
    if (supported(gfx)) return card;
    first ??= card;
  }
  return first;
}
