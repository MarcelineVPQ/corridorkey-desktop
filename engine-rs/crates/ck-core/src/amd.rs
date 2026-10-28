//! The AMD card the MIGraphX provider runs on (Linux), read from the kernel without creating a GPU context: which card
//! is HIP's device 0 (libamdhip64's hipDeviceGetPCIBusId, so HIP_VISIBLE_DEVICES / ROCR_VISIBLE_DEVICES count as HIP
//! counts them), its graphics memory from the amdgpu driver's sysfs files (mem_info_vram_total / _used: what amd-smi
//! and rocm-smi read), its gfx target from the KFD topology (gfx_target_version), and what this process holds from the
//! DRM fdinfo of its own render-node files (drm-resident-vram, docs/gpu/drm-usage-stats in the kernel).
//! Opened only when the runtime chose the MIGraphX provider (runtime.rs), so nothing here runs on an NVIDIA setup.
use crate::gpu::GpuInfo;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const KFD_NODES: &str = "/sys/class/kfd/kfd/topology/nodes";

/// One GPU node of the KFD topology (CPU nodes have no SIMDs and gfx target 0).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Node {
    /// /dev/dri/renderD<minor>
    pub(crate) minor: u64,
    /// "gfx1100", "gfx942", "gfx1201"
    pub(crate) gfx: String,
}

/// A KFD node's `properties` file ("name value" lines) as numbers.
pub(crate) fn kfd_props(text: &str) -> BTreeMap<String, u64> {
    // loop: NOT-WORTH — a few dozen lines per node, once per process
    text.lines().filter_map(|l| l.split_once(' ')).filter_map(|(k, v)| Some((k.to_string(), v.trim().parse().ok()?))).collect()
}

/// The gfx target name of KFD's gfx_target_version (major * 10000 + minor * 100 + stepping, minor and stepping written
/// in hex in the name): 110000 = gfx1100, 90402 = gfx942, 90010 = gfx90a, 120001 = gfx1201. None for 0 (a CPU node).
pub(crate) fn gfx_name(v: u64) -> Option<String> {
    (v > 0).then(|| format!("gfx{}{:x}{:x}", v / 10000, (v / 100) % 100, v % 100))
}

/// The GPU node of a properties file, or None for a CPU node.
pub(crate) fn gpu_node(props: &BTreeMap<String, u64>) -> Option<Node> {
    if props.get("simd_count").copied().unwrap_or(0) == 0 {
        return None;
    }
    Some(Node { minor: *props.get("drm_render_minor")?, gfx: gfx_name(*props.get("gfx_target_version")?)? })
}

/// Which of the machine's AMD GPU nodes is HIP's device 0: the one at `hip0`'s PCI bus id (`pci` gives each node's),
/// else the only one; several and no HIP to ask: none rather than the wrong card's numbers.
pub(crate) fn pick<'a>(nodes: &'a [(Node, String)], hip0: Option<&str>) -> Option<&'a (Node, String)> {
    match hip0 {
        Some(bus) => nodes.iter().find(|(_, pci)| crate::gpu::same_pci(pci, bus)),
        None if nodes.len() == 1 => nodes.first(),
        None => None,
    }
}

/// (total, free) bytes from mem_info_vram_total and mem_info_vram_used (decimal bytes).
pub(crate) fn vram(total: &str, used: &str) -> Option<(u64, u64)> {
    let (t, u) = (total.trim().parse::<u64>().ok()?, used.trim().parse::<u64>().ok()?);
    Some((t, t.saturating_sub(u)))
}

/// One fdinfo file of an amdgpu render node on the card at `pdev`: (drm-client-id, bytes resident in VRAM). The
/// resident count (drm-resident-vram) where the kernel has it, else the older drm-memory-vram. Values are "N KiB",
/// "N MiB" or plain bytes.
pub(crate) fn fdinfo_vram(text: &str, pdev: &str) -> Option<(u64, u64)> {
    // loop: NOT-WORTH — one fdinfo file's ~30 lines
    let field = |k: &str| text.lines().find_map(|l| l.strip_prefix(k)?.strip_prefix(':').map(str::trim));
    if field("drm-driver")? != "amdgpu" || !crate::gpu::same_pci(field("drm-pdev")?, pdev) {
        return None;
    }
    let client = field("drm-client-id")?.parse().ok()?;
    let v = field("drm-resident-vram").or_else(|| field("drm-memory-vram"))?;
    let (n, unit) = v.split_once(' ').unwrap_or((v, ""));
    let mult = match unit.trim() {
        "KiB" => 1 << 10,
        "MiB" => 1 << 20,
        "GiB" => 1 << 30,
        _ => 1,
    };
    Some((client, n.parse::<u64>().ok()? * mult))
}

/// HIP's device 0: its PCI bus id ("0000:03:00.0") and name ("Radeon RX 7900 XTX"), from libamdhip64 (hipInit,
/// hipDeviceGetPCIBusId and hipDeviceGetName create no context). None: no HIP library, or HIP sees no device. The
/// library stays loaded (an initialised runtime keeps threads).
fn hip_device0() -> Option<(String, Option<String>)> {
    // the ROCm 7 runtime first (the onnxruntime-migraphx wheel links libamdhip64.so.7), then older; ROCm's own folder
    // when the loader's path doesn't have it (the provider finds it through its RUNPATH /opt/rocm/lib)
    const NAMES: [&str; 3] = ["libamdhip64.so.7", "libamdhip64.so.6", "libamdhip64.so"];
    // loop: NOT-WORTH — three names in two places, once per process
    let lib = NAMES.iter().flat_map(|n| [n.to_string(), format!("/opt/rocm/lib/{n}")]).find_map(|n| {
        // SAFETY: loading ROCm's HIP runtime library; its initialisers only set up the runtime
        unsafe { libloading::Library::new(n).ok() }
    })?;
    let lib = std::mem::ManuallyDrop::new(lib);
    // SAFETY: HIP's documented C signatures (hip_runtime_api.h); the buffer is sized as passed
    unsafe {
        let init: libloading::Symbol<unsafe extern "C" fn(u32) -> i32> = lib.get(b"hipInit\0").ok()?;
        let pci: libloading::Symbol<unsafe extern "C" fn(*mut std::ffi::c_char, i32, i32) -> i32> = lib.get(b"hipDeviceGetPCIBusId\0").ok()?;
        if init(0) != 0 {
            return None;
        }
        let mut buf = [0 as std::ffi::c_char; 64];
        if pci(buf.as_mut_ptr(), buf.len() as i32, 0) != 0 {
            return None;
        }
        let bus = std::ffi::CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned();
        let mut nb = [0 as std::ffi::c_char; 256];
        let name = lib
            .get::<unsafe extern "C" fn(*mut std::ffi::c_char, i32, i32) -> i32>(b"hipDeviceGetName\0")
            .ok()
            .filter(|f| f(nb.as_mut_ptr(), nb.len() as i32, 0) == 0)
            .map(|_| std::ffi::CStr::from_ptr(nb.as_ptr()).to_string_lossy().trim().to_string())
            .filter(|n| !n.is_empty());
        Some((bus, name))
    }
}

/// HIP's device 0 as the kernel shows it.
pub(crate) struct Card {
    /// /sys/class/drm/renderD<minor>/device
    dev: PathBuf,
    /// its PCI bus id, the fdinfo's drm-pdev
    pci: String,
    pub(crate) gfx: String,
    name: String,
    driver: String,
}

fn read(p: &Path) -> Option<String> {
    std::fs::read_to_string(p).ok()
}

impl Card {
    fn open() -> Option<Card> {
        let mut nodes = Vec::new();
        // loop: NOT-WORTH — the machine's few KFD nodes, once per process
        for e in std::fs::read_dir(KFD_NODES).ok()?.flatten() {
            let Some(node) = read(&e.path().join("properties")).and_then(|t| gpu_node(&kfd_props(&t))) else { continue };
            let dev = PathBuf::from(format!("/sys/class/drm/renderD{}/device", node.minor));
            let Some(pci) = std::fs::read_link(&dev).ok().and_then(|l| Some(l.file_name()?.to_string_lossy().into_owned())) else { continue };
            nodes.push((node, pci));
        }
        let hip = hip_device0();
        let (node, pci) = pick(&nodes, hip.as_ref().map(|h| h.0.as_str()))?.clone();
        let dev = PathBuf::from(format!("/sys/class/drm/renderD{}/device", node.minor));
        // HIP's marketing name, else the board's own (product_name: server cards), else the gfx target alone
        let name = hip
            .and_then(|h| h.1)
            .or_else(|| read(&dev.join("product_name")).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
            .map(|n| format!("{n} ({})", node.gfx))
            .unwrap_or_else(|| format!("AMD {}", node.gfx));
        let driver = read(Path::new("/sys/module/amdgpu/version"))
            .or_else(|| read(Path::new("/proc/sys/kernel/osrelease")).map(|k| format!("amdgpu (Linux {})", k.trim())))
            .unwrap_or_default();
        Some(Card { dev, pci, gfx: node.gfx, name, driver: driver.trim().to_string() })
    }

    pub(crate) fn info(&self) -> Option<GpuInfo> {
        let (total, free) = vram(&read(&self.dev.join("mem_info_vram_total"))?, &read(&self.dev.join("mem_info_vram_used"))?)?;
        Some(GpuInfo { name: self.name.clone(), total, free, driver: self.driver.clone() })
    }

    /// Graphics memory this process holds on the card (its render-node files, each DRM client once), None when the
    /// kernel doesn't say.
    pub(crate) fn own(&self) -> Option<u64> {
        let mut clients = BTreeMap::new();
        // loop: NOT-WORTH — this process's open files, once per budget read (job start, first session)
        for e in std::fs::read_dir("/proc/self/fdinfo").ok()?.flatten() {
            if let Some((client, bytes)) = read(&e.path()).and_then(|t| fdinfo_vram(&t, &self.pci)) {
                clients.insert(client, bytes);
            }
        }
        (!clients.is_empty()).then(|| clients.values().sum())
    }
}

static CARD: std::sync::OnceLock<Option<Card>> = std::sync::OnceLock::new();

/// HIP's device 0, opened once per process (runtime.rs calls this only for the MIGraphX provider).
pub(crate) fn card() -> Option<&'static Card> {
    CARD.get_or_init(Card::open).as_ref()
}

/// The card if `card()` opened one: gpu.rs reads AMD memory then, NVML otherwise.
pub(crate) fn opened() -> Option<&'static Card> {
    CARD.get().and_then(|c| c.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    // a CPU node and an RX 7900 XTX as the kernel writes them (abridged /sys/class/kfd/kfd/topology/nodes/N/properties)
    const CPU: &str =
        "cpu_cores_count 16\nsimd_count 0\nmem_banks_count 1\ngfx_target_version 0\nvendor_id 0\ndevice_id 0\nlocation_id 0\ndrm_render_minor 0\n";
    const XTX: &str = "cpu_cores_count 0\nsimd_count 192\nmem_banks_count 1\nmax_waves_per_simd 16\nlds_size_in_kb 64\nwave_front_size 32\n\
        gfx_target_version 110000\nvendor_id 4098\ndevice_id 29772\nlocation_id 768\ndomain 0\ndrm_render_minor 128\nhive_id 0\n\
        num_sdma_engines 2\nlocal_mem_size 0\nfw_version 2200\ncapability 671588992\nunique_id 1234567890123\nnum_xcc 1\n";

    #[test]
    fn kfd_nodes_and_gfx_targets() {
        assert_eq!(gpu_node(&kfd_props(CPU)), None);
        assert_eq!(gpu_node(&kfd_props(XTX)), Some(Node { minor: 128, gfx: "gfx1100".into() }));
        // MI300X, MI250, Radeon AI PRO R9700, this PC's Ryzen iGPU (read 2026-10-27)
        assert_eq!(
            (gfx_name(90402), gfx_name(90010), gfx_name(120001), gfx_name(100306)),
            (Some("gfx942".into()), Some("gfx90a".into()), Some("gfx1201".into()), Some("gfx1036".into()))
        );
        assert_eq!(gfx_name(0), None);
    }

    #[test]
    fn hip_device_0_is_matched_by_pci_bus_id() {
        let igpu = (Node { minor: 128, gfx: "gfx1036".into() }, "0000:79:00.0".to_string());
        let xtx = (Node { minor: 129, gfx: "gfx1100".into() }, "0000:03:00.0".to_string());
        let both = [igpu.clone(), xtx.clone()];
        assert_eq!(pick(&both, Some("0000:03:00.0")), Some(&xtx));
        assert_eq!(pick(&both, Some("0000:79:00.0")).map(|n| n.0.minor), Some(128));
        // no HIP to ask: one card is that card; several, none (never the wrong card's numbers)
        assert_eq!(pick(&both, None), None);
        assert_eq!(pick(&both[1..], None), Some(&xtx));
        assert_eq!(pick(&both, Some("0000:41:00.0")), None);
    }

    #[test]
    fn vram_from_the_driver_files() {
        // 24 GiB card with 1.5 GiB in use, as mem_info_vram_total / _used print it
        assert_eq!(vram("25753026560\n", "1610612736\n"), Some((25753026560, 25753026560 - 1610612736)));
        assert_eq!(vram("", "0"), None);
    }

    #[test]
    fn own_memory_from_fdinfo() {
        let f = "pos:\t0\nflags:\t02100002\nmnt_id:\t26\nino:\t1076\ndrm-driver:\tamdgpu\ndrm-client-id:\t16\ndrm-pdev:\t0000:03:00.0\n\
            pasid:\t32770\ndrm-total-gtt:\t2392 KiB\ndrm-resident-gtt:\t2392 KiB\ndrm-total-vram:\t44564 KiB\ndrm-shared-vram:\t31952 KiB\n\
            drm-resident-vram:\t44564 KiB\ndrm-memory-vram:\t44564 KiB\namd-requested-vram:\t44564 KiB\n";
        assert_eq!(fdinfo_vram(f, "0000:03:00.0"), Some((16, 44564 * 1024)));
        // another card, another driver, a plain file
        assert_eq!(fdinfo_vram(f, "0000:79:00.0"), None);
        assert_eq!(fdinfo_vram(&f.replace("amdgpu", "i915"), "0000:03:00.0"), None);
        assert_eq!(fdinfo_vram("pos:\t0\nflags:\t0100000\n", "0000:03:00.0"), None);
        // an older kernel: only drm-memory-vram
        let old = "drm-driver:\tamdgpu\ndrm-pdev:\t0000:03:00.0\ndrm-client-id:\t3\ndrm-memory-vram:\t2 MiB\n";
        assert_eq!(fdinfo_vram(old, "0000:03:00.0"), Some((3, 2 << 20)));
    }
}
