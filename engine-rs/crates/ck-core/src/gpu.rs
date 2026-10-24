//! The NVIDIA card through NVML (libnvidia-ml.so.1, opened at run time; it creates no CUDA context, so
//! asking costs no graphics memory): name, total and free memory, driver, and what this process holds.
use libloading::{Library, Symbol};
use std::ffi::{c_char, c_int, c_uint, c_void, CStr};

#[derive(Clone, Debug, PartialEq)]
pub struct GpuInfo {
    pub name: String,
    pub total: u64,
    pub free: u64,
    pub driver: String,
}

#[repr(C)]
#[derive(Default)]
struct Memory {
    total: u64,
    free: u64,
    used: u64,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct ProcInfo {
    pid: c_uint,
    used: u64,
    gpu_instance: c_uint,
    compute_instance: c_uint,
}

/// One NVML card: NVML's index (PCI order), its PCI bus id and UUID ("GPU-…").
#[derive(Clone, Debug, PartialEq)]
pub struct Card {
    pub index: u32,
    pub pci: String,
    pub uuid: String,
}

/// CUDA's device 0 as the CUDA driver itself reports it (cuInit applies CUDA_VISIBLE_DEVICES and
/// CUDA_DEVICE_ORDER, UUID and MIG entries included).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CudaDevice {
    pub pci: Option<String>,
    pub uuid: Option<String>,
}

/// What CUDA's device 0 is as a card NVML can read.
#[derive(Clone, Debug, PartialEq)]
pub enum Pick {
    /// CUDA sees no card (CUDA_VISIBLE_DEVICES="" / "-1" / an invalid first entry).
    Hidden,
    /// this NVML index
    Card(u32),
    /// a MIG instance, read by its UUID
    Mig(String),
    /// several cards and no way to tell CUDA's order (no CUDA driver, default FASTEST_FIRST order):
    /// no card rather than the wrong card's numbers
    Unknown,
}

/// A PCI bus id in one spelling: NVML writes "00000000:01:00.0", CUDA "0000:01:00.0".
fn pci_key(s: &str) -> Option<(u32, u32, u32, u32)> {
    let s = s.trim().trim_end_matches('\0');
    let (domain, rest) = s.split_once(':')?;
    let (bus, rest) = rest.split_once(':')?;
    let (dev, func) = rest.split_once('.').unwrap_or((rest, "0"));
    let hex = |x: &str| u32::from_str_radix(x, 16).ok();
    Some((hex(domain)?, hex(bus)?, hex(dev)?, hex(func)?))
}

/// The NVML card that is CUDA's device 0 (bug hunt 2026-10 C6, backlog row 17): the CUDA driver's own answer,
/// matched by UUID or PCI bus id; without a CUDA driver, CUDA_VISIBLE_DEVICES' first entry read as CUDA reads it
/// (an index in CUDA's order, a GPU-/MIG- UUID or a unique UUID prefix). CUDA's default order (FASTEST_FIRST) is
/// not NVML's (PCI), so an index maps to an NVML card only under CUDA_DEVICE_ORDER=PCI_BUS_ID or with one card.
pub fn pick_card(visible: Option<&str>, order: Option<&str>, cuda0: Option<&CudaDevice>, cards: &[Card]) -> Pick {
    let first = match visible {
        None => "0".to_string(),
        // CUDA reads the list up to its first invalid entry: an empty list or "-1" first hides every card
        // loop: NOT-WORTH — the first entry of one environment variable
        Some(v) => v.split(',').next().unwrap_or("").trim().to_string(),
    };
    if first.is_empty() || first.starts_with('-') {
        return Pick::Hidden;
    }
    if first.len() > 4 && first[..4].eq_ignore_ascii_case("MIG-") {
        return Pick::Mig(first);
    }
    if let Some(c) = cuda0 {
        // loop: NOT-WORTH — the machine's few cards, once per NVML open
        let by_uuid = c.uuid.as_ref().and_then(|u| cards.iter().find(|k| k.uuid.eq_ignore_ascii_case(u)));
        let key = c.pci.as_deref().and_then(pci_key);
        // loop: NOT-WORTH — the machine's few cards, once per NVML open
        let by_pci = key.and_then(|k| cards.iter().find(|card| pci_key(&card.pci) == Some(k)));
        if let Some(card) = by_uuid.or(by_pci) {
            return Pick::Card(card.index);
        }
    }
    if first.len() > 4 && first[..4].eq_ignore_ascii_case("GPU-") {
        let want = first.to_ascii_lowercase();
        // loop: NOT-WORTH — the machine's few cards, once per NVML open
        let hits: Vec<&Card> = cards.iter().filter(|k| k.uuid.to_ascii_lowercase().starts_with(&want)).collect();
        return if hits.len() == 1 { Pick::Card(hits[0].index) } else { Pick::Hidden };
    }
    let Ok(i) = first.parse::<usize>() else { return Pick::Hidden };
    // loop: NOT-WORTH — the machine's few cards
    let mut by_pci: Vec<&Card> = cards.iter().collect();
    // loop: NOT-WORTH — sorting the machine's few cards
    by_pci.sort_by_key(|k| pci_key(&k.pci));
    let pci_order = order.is_some_and(|o| o.trim().eq_ignore_ascii_case("PCI_BUS_ID"));
    match by_pci.get(i) {
        None => Pick::Hidden,
        Some(card) if pci_order || cards.len() == 1 => Pick::Card(card.index),
        Some(_) => Pick::Unknown,
    }
}

/// UUID bytes as NVML spells them: GPU-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.
pub fn uuid_string(b: &[u8; 16]) -> String {
    // loop: NOT-WORTH — 16 bytes
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("GPU-{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/// CUDA's device 0 from the CUDA driver (libcuda.so.1). cuInit creates no context (no graphics memory).
/// Some(None): the driver is there and sees no device; None: no CUDA driver to ask.
/// Asked once per process (the variables can't change for an initialised driver), and the library stays loaded:
/// an initialised driver keeps its own threads, so unloading it under them is unsafe.
fn cuda_device0() -> Option<Option<CudaDevice>> {
    static ONCE: std::sync::OnceLock<Option<Option<CudaDevice>>> = std::sync::OnceLock::new();
    ONCE.get_or_init(ask_cuda_device0).clone()
}

/// The NVIDIA driver's libraries by their per-system names: the driver installs nvcuda.dll and nvml.dll into
/// System32 on Windows (found 2026-10-24 by the hardcoded-values pass: with only the Linux names, the Windows
/// engine saw no card and every job failed `no-gpu`).
#[cfg(windows)]
const CUDA_DRIVER_LIB: &str = "nvcuda.dll";
#[cfg(not(windows))]
const CUDA_DRIVER_LIB: &str = "libcuda.so.1";
#[cfg(windows)]
const NVML_LIB: &str = "nvml.dll";
#[cfg(not(windows))]
const NVML_LIB: &str = "libnvidia-ml.so.1";

fn ask_cuda_device0() -> Option<Option<CudaDevice>> {
    // SAFETY: the CUDA driver API's documented C signatures; buffers sized as passed
    unsafe {
        let lib = std::mem::ManuallyDrop::new(Library::new(CUDA_DRIVER_LIB).ok()?);
        let init: Symbol<unsafe extern "C" fn(c_uint) -> c_int> = lib.get(b"cuInit\0").ok()?;
        let get: Symbol<unsafe extern "C" fn(*mut c_int, c_int) -> c_int> = lib.get(b"cuDeviceGet\0").ok()?;
        match init(0) {
            0 => {}
            100 => return Some(None), // CUDA_ERROR_NO_DEVICE: CUDA_VISIBLE_DEVICES hides every card
            _ => return None,
        }
        let mut dev: c_int = 0;
        if get(&mut dev, 0) != 0 {
            return Some(None);
        }
        let mut out = CudaDevice::default();
        if let Ok(pci) = lib.get::<unsafe extern "C" fn(*mut c_char, c_int, c_int) -> c_int>(b"cuDeviceGetPCIBusId\0") {
            let mut buf = [0 as c_char; 32];
            if pci(buf.as_mut_ptr(), buf.len() as c_int, dev) == 0 {
                out.pci = Some(CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned());
            }
        }
        if let Ok(uuid) = lib.get::<unsafe extern "C" fn(*mut [u8; 16], c_int) -> c_int>(b"cuDeviceGetUuid_v2\0") {
            let mut b = [0u8; 16];
            if uuid(&mut b, dev) == 0 {
                out.uuid = Some(uuid_string(&b));
            }
        }
        Some(Some(out))
    }
}

#[repr(C)]
struct PciInfo {
    bus_id_legacy: [c_char; 16],
    domain: c_uint,
    bus: c_uint,
    device: c_uint,
    pci_device_id: c_uint,
    pci_sub_system_id: c_uint,
    bus_id: [c_char; 32],
}

type MemFn = unsafe extern "C" fn(*mut c_void, *mut Memory) -> c_int;
type NameFn = unsafe extern "C" fn(*mut c_void, *mut c_char, c_uint) -> c_int;
type DriverFn = unsafe extern "C" fn(*mut c_char, c_uint) -> c_int;
type ProcsFn = unsafe extern "C" fn(*mut c_void, *mut c_uint, *mut ProcInfo) -> c_int;

/// NVML's calls this engine makes, looked up once when NVML is opened (they were looked up on every read).
struct NvmlFns {
    mem: MemFn,
    name: NameFn,
    driver: DriverFn,
    /// absent on drivers older than NVML's v3 process list: what this process holds is then unknown
    procs: Option<ProcsFn>,
}

struct Nvml {
    /// keeps the function pointers in `f` valid (never unloaded while the Nvml lives: it lives for the process)
    _lib: Library,
    f: NvmlFns,
    dev: *mut c_void,
}

impl Nvml {
    fn open() -> Option<Nvml> {
        // SAFETY: NVML's documented C signatures; the handle stays valid while `lib` is loaded
        unsafe {
            let lib = Library::new(NVML_LIB).ok()?;
            let init: Symbol<unsafe extern "C" fn() -> c_int> = lib.get(b"nvmlInit_v2\0").ok()?;
            if init() != 0 {
                return None;
            }
            let cuda0 = match cuda_device0() {
                Some(None) => return None,
                Some(Some(d)) => Some(d),
                None => None,
            };
            let visible = std::env::var("CUDA_VISIBLE_DEVICES").ok();
            let order = std::env::var("CUDA_DEVICE_ORDER").ok();
            let dev = match pick_card(visible.as_deref(), order.as_deref(), cuda0.as_ref(), &Self::cards(&lib)) {
                Pick::Card(i) => {
                    let get: Symbol<unsafe extern "C" fn(c_uint, *mut *mut c_void) -> c_int> = lib.get(b"nvmlDeviceGetHandleByIndex_v2\0").ok()?;
                    let mut dev = std::ptr::null_mut();
                    if get(i, &mut dev) != 0 {
                        return None;
                    }
                    dev
                }
                Pick::Mig(uuid) => {
                    let get: Symbol<unsafe extern "C" fn(*const c_char, *mut *mut c_void) -> c_int> = lib.get(b"nvmlDeviceGetHandleByUUID\0").ok()?;
                    let c = std::ffi::CString::new(uuid).ok()?;
                    let mut dev = std::ptr::null_mut();
                    if get(c.as_ptr(), &mut dev) != 0 {
                        return None;
                    }
                    dev
                }
                Pick::Hidden | Pick::Unknown => return None,
            };
            let f = NvmlFns {
                mem: *lib.get::<MemFn>(b"nvmlDeviceGetMemoryInfo\0").ok()?,
                name: *lib.get::<NameFn>(b"nvmlDeviceGetName\0").ok()?,
                driver: *lib.get::<DriverFn>(b"nvmlSystemGetDriverVersion\0").ok()?,
                procs: lib.get::<ProcsFn>(b"nvmlDeviceGetComputeRunningProcesses_v3\0").ok().map(|s| *s),
            };
            Some(Nvml { _lib: lib, f, dev })
        }
    }

    /// Every card NVML sees, with its PCI bus id and UUID.
    fn cards(lib: &Library) -> Vec<Card> {
        // SAFETY: NVML's documented C signatures; buffers sized as passed
        unsafe {
            let (Ok(count), Ok(get), Ok(pci), Ok(uuid)) = (
                lib.get::<unsafe extern "C" fn(*mut c_uint) -> c_int>(b"nvmlDeviceGetCount_v2\0"),
                lib.get::<unsafe extern "C" fn(c_uint, *mut *mut c_void) -> c_int>(b"nvmlDeviceGetHandleByIndex_v2\0"),
                lib.get::<unsafe extern "C" fn(*mut c_void, *mut PciInfo) -> c_int>(b"nvmlDeviceGetPciInfo_v3\0"),
                lib.get::<unsafe extern "C" fn(*mut c_void, *mut c_char, c_uint) -> c_int>(b"nvmlDeviceGetUUID\0"),
            ) else {
                return Vec::new();
            };
            let mut n: c_uint = 0;
            if count(&mut n) != 0 {
                return Vec::new();
            }
            let mut out = Vec::new();
            // loop: NOT-WORTH — the machine's few cards, once per NVML open
            for index in 0..n.min(64) {
                let mut dev = std::ptr::null_mut();
                if get(index, &mut dev) != 0 {
                    continue;
                }
                let mut info: PciInfo = std::mem::zeroed();
                let p = if pci(dev, &mut info) == 0 { CStr::from_ptr(info.bus_id.as_ptr()).to_string_lossy().into_owned() } else { String::new() };
                let mut ub = [0 as c_char; 96];
                let u = if uuid(dev, ub.as_mut_ptr(), ub.len() as c_uint) == 0 {
                    CStr::from_ptr(ub.as_ptr()).to_string_lossy().into_owned()
                } else {
                    String::new()
                };
                out.push(Card { index, pci: p, uuid: u });
            }
            out
        }
    }

    fn info(&self) -> Option<GpuInfo> {
        // SAFETY: buffers are sized as passed; types as documented; the library behind the pointers stays loaded
        unsafe {
            let (mem, name, drv) = (self.f.mem, self.f.name, self.f.driver);
            let mut m = Memory::default();
            if mem(self.dev, &mut m) != 0 {
                return None;
            }
            let mut buf = [0 as c_char; 96];
            let nm = if name(self.dev, buf.as_mut_ptr(), buf.len() as c_uint) == 0 {
                CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned()
            } else {
                "NVIDIA".into()
            };
            let mut dbuf = [0 as c_char; 96];
            let dv =
                if drv(dbuf.as_mut_ptr(), dbuf.len() as c_uint) == 0 { CStr::from_ptr(dbuf.as_ptr()).to_string_lossy().into_owned() } else { String::new() };
            Some(GpuInfo { name: nm, total: m.total, free: m.free, driver: dv })
        }
    }

    /// Graphics memory held by `pid` (compute processes), None when NVML can't tell.
    fn used_by(&self, pid: u32) -> Option<u64> {
        // SAFETY: the buffer holds `n` entries as passed; the library behind the pointer stays loaded
        unsafe {
            let procs = self.f.procs?;
            let mut buf = [ProcInfo::default(); 128];
            let mut n = buf.len() as c_uint;
            if procs(self.dev, &mut n, buf.as_mut_ptr()) != 0 {
                return None;
            }
            // loop: NOT-WORTH — ≤ 128 compute processes, once per budget read (job start, first session)
            let mine: Vec<u64> = buf[..(n as usize).min(buf.len())].iter().filter(|p| p.pid == pid).map(|p| p.used).collect();
            if mine.contains(&u64::MAX) {
                return None; // NVML_VALUE_NOT_AVAILABLE
            }
            // loop: NOT-WORTH — this process's entries (one or two)
            Some(mine.iter().sum())
        }
    }
}

/// The card CUDA uses as device 0, or None (no driver library, no card, CUDA_VISIBLE_DEVICES hides every card, or
/// several cards in an order this can't tell).
pub fn nvidia() -> Option<GpuInfo> {
    nvml()?.info()
}

// SAFETY: NVML is thread-safe (NVIDIA's NVML API reference, "Thread safety"); the device handle is only read
unsafe impl Send for Nvml {}
unsafe impl Sync for Nvml {}

/// NVML, opened once per engine process (each open loaded the library and called nvmlInit again, per job).
fn nvml() -> Option<&'static Nvml> {
    static ONCE: std::sync::OnceLock<Option<Nvml>> = std::sync::OnceLock::new();
    ONCE.get_or_init(Nvml::open).as_ref()
}

/// The memory budget the runtime's apply_auto_vram uses: free memory plus what this process already holds
/// (its loaded models count for it). (budget bytes, free bytes, own bytes).
pub fn budget() -> Option<(u64, u64, u64)> {
    let n = nvml()?;
    let info = n.info()?;
    let own = n.used_by(std::process::id()).unwrap_or(0);
    Some((info.free + own, info.free, own))
}

/// TensorRT's library by its per-system names (TensorRT 10: libnvinfer.so.10 on Linux, nvinfer_10.dll on Windows).
#[cfg(windows)]
const NVINFER_LIBS: [&str; 2] = ["nvinfer_10.dll", "nvinfer.dll"];
#[cfg(not(windows))]
const NVINFER_LIBS: [&str; 2] = ["libnvinfer.so.10", "libnvinfer.so"];

/// TensorRT's version from libnvinfer (getInferLibVersion: major*10000 + minor*100 + patch for 10.x),
/// as "10.16.0"; None when the library is not there.
pub fn tensorrt_version() -> Option<String> {
    // loop: NOT-WORTH — two library names
    for name in NVINFER_LIBS {
        // SAFETY: getInferLibVersion takes nothing and returns an int32
        unsafe {
            if let Ok(lib) = Library::new(name) {
                if let Ok(f) = lib.get::<unsafe extern "C" fn() -> i32>(b"getInferLibVersion\0") {
                    let v = f();
                    return Some(trt_version_string(v));
                }
            }
        }
    }
    None
}

pub fn trt_version_string(v: i32) -> String {
    format!("{}.{}.{}", v / 10000, (v / 100) % 100, v % 100)
}

/// Host memory the system says is available (bytes): the CPU provider's budget. Linux: /proc/meminfo's
/// MemAvailable; Windows: GlobalMemoryStatusEx's ullAvailPhys; macOS: free + inactive pages (host_statistics64,
/// psutil's reading of "available"). None only where the system doesn't say.
pub fn host_available() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let s = std::fs::read_to_string("/proc/meminfo").ok()?;
        meminfo_available(&s)
    }
    #[cfg(windows)]
    {
        win_mem::avail_phys()
    }
    #[cfg(target_os = "macos")]
    {
        mac_mem::available()
    }
    #[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
    {
        None
    }
}

/// MemAvailable of a /proc/meminfo text, in bytes.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn meminfo_available(s: &str) -> Option<u64> {
    // loop: NOT-WORTH — /proc/meminfo's ~55 lines, once per CPU job
    s.lines().find_map(|l| l.strip_prefix("MemAvailable:")).and_then(|r| r.trim().trim_end_matches("kB").trim().parse::<u64>().ok()).map(|kb| kb * 1024)
}

/// macOS "available" as psutil reads it: (free - speculative) + inactive pages.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn mac_available(free: u64, speculative: u64, inactive: u64, page: u64) -> u64 {
    (free.saturating_sub(speculative) + inactive) * page
}

#[cfg(windows)]
mod win_mem {
    /// MEMORYSTATUSEX (sysinfoapi.h)
    #[repr(C)]
    #[derive(Default)]
    #[allow(dead_code)]
    struct MemoryStatus {
        length: u32,
        memory_load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page_file: u64,
        avail_page_file: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended_virtual: u64,
    }
    const _: () = assert!(std::mem::size_of::<MemoryStatus>() == 64);
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(buf: *mut MemoryStatus) -> i32;
    }
    /// ullAvailPhys: physical memory that can be used without paging out (bytes).
    pub fn avail_phys() -> Option<u64> {
        let mut m = MemoryStatus { length: std::mem::size_of::<MemoryStatus>() as u32, ..Default::default() };
        // SAFETY: GlobalMemoryStatusEx fills a MEMORYSTATUSEX whose dwLength is set, as documented
        (unsafe { GlobalMemoryStatusEx(&mut m) } != 0).then_some(m.avail_phys)
    }
}

#[cfg(target_os = "macos")]
mod mac_mem {
    use std::ffi::{c_char, c_int, c_uint, c_void};
    /// vm_statistics64 (mach/vm_statistics.h), filled by the kernel; only three counters are read
    #[repr(C, align(8))]
    #[allow(dead_code)]
    struct VmStats64 {
        free_count: c_uint,
        active_count: c_uint,
        inactive_count: c_uint,
        wire_count: c_uint,
        counters: [u64; 9],
        purgeable_count: c_uint,
        speculative_count: c_uint,
        more_counters: [u64; 4],
        pages: [c_uint; 4],
        uncompressed: u64,
    }
    const _: () = assert!(std::mem::size_of::<VmStats64>() == 152);
    const HOST_VM_INFO64: c_int = 4;
    extern "C" {
        fn mach_host_self() -> c_uint;
        fn host_statistics64(host: c_uint, flavor: c_int, info: *mut c_int, count: *mut c_uint) -> c_int;
        fn sysctlbyname(name: *const c_char, old: *mut c_void, oldlen: *mut usize, new: *mut c_void, newlen: usize) -> c_int;
    }
    /// An integer sysctl value (hw.pagesize, hw.memsize).
    fn sysctl_u64(name: &std::ffi::CStr) -> Option<u64> {
        let mut v: u64 = 0;
        let mut len = std::mem::size_of::<u64>();
        // SAFETY: sysctlbyname(3) writes at most `len` bytes into `v` (a smaller integer lands in its low bytes:
        // little-endian Apple Silicon)
        let rc = unsafe { sysctlbyname(name.as_ptr(), &mut v as *mut u64 as *mut c_void, &mut len, std::ptr::null_mut(), 0) };
        (rc == 0 && len > 0).then_some(v)
    }
    pub fn available() -> Option<u64> {
        let page = sysctl_u64(c"hw.pagesize")?;
        // SAFETY: an all-integer struct; host_statistics64 writes at most `count` 32-bit words into it
        unsafe {
            let mut st: VmStats64 = std::mem::zeroed();
            let mut count = (std::mem::size_of::<VmStats64>() / 4) as c_uint;
            if host_statistics64(mach_host_self(), HOST_VM_INFO64, &mut st as *mut VmStats64 as *mut c_int, &mut count) != 0 {
                // hw.memsize (the total) is not what is available: no answer rather than a wrong one
                return None;
            }
            Some(super::mac_available(st.free_count as u64, st.speculative_count as u64, st.inactive_count as u64, page))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{pick_card, uuid_string, Card, CudaDevice, Pick};

    // Two cards as NVML lists them (PCI order); CUDA's default order puts the faster one, NVML's 1, first.
    fn cards() -> Vec<Card> {
        vec![
            Card { index: 0, pci: "00000000:01:00.0".into(), uuid: "GPU-aaaaaaaa-1111-2222-3333-444444444444".into() },
            Card { index: 1, pci: "00000000:41:00.0".into(), uuid: "GPU-bbbbbbbb-1111-2222-3333-444444444444".into() },
        ]
    }

    #[test]
    fn cuda_device_0_is_matched_by_uuid_or_pci_not_by_nvml_index() {
        let c = cards();
        // the CUDA driver says device 0 is the card at 41:00.0 (FASTEST_FIRST): NVML's index 1, not 0
        let by_pci = CudaDevice { pci: Some("0000:41:00.0".into()), uuid: None };
        assert_eq!(pick_card(None, None, Some(&by_pci), &c), Pick::Card(1));
        assert_eq!(pick_card(Some("0"), None, Some(&by_pci), &c), Pick::Card(1));
        let by_uuid = CudaDevice { pci: None, uuid: Some("GPU-BBBBBBBB-1111-2222-3333-444444444444".into()) };
        assert_eq!(pick_card(Some("1,0"), None, Some(&by_uuid), &c), Pick::Card(1));
    }

    #[test]
    fn without_a_cuda_driver_the_variable_is_read_as_cuda_reads_it() {
        let c = cards();
        // UUID entries (also a unique prefix), never parsed as index 0
        assert_eq!(pick_card(Some("GPU-bbbbbbbb-1111-2222-3333-444444444444"), None, None, &c), Pick::Card(1));
        assert_eq!(pick_card(Some("GPU-bb,0"), None, None, &c), Pick::Card(1));
        assert_eq!(pick_card(Some("GPU-"), None, None, &c), Pick::Hidden);
        assert_eq!(pick_card(Some("MIG-0a1b2c3d-1111-2222-3333-444444444444"), None, None, &c), Pick::Mig("MIG-0a1b2c3d-1111-2222-3333-444444444444".into()));
        // an index is CUDA's order: NVML's PCI order only under CUDA_DEVICE_ORDER=PCI_BUS_ID (or one card)
        assert_eq!(pick_card(Some("1"), Some("PCI_BUS_ID"), None, &c), Pick::Card(1));
        assert_eq!(pick_card(None, Some("PCI_BUS_ID"), None, &c), Pick::Card(0));
        assert_eq!(pick_card(Some("1"), None, None, &c), Pick::Unknown);
        assert_eq!(pick_card(None, Some("FASTEST_FIRST"), None, &c), Pick::Unknown);
        assert_eq!(pick_card(None, None, None, &c[..1]), Pick::Card(0));
        // hidden: empty, -1, an invalid or out-of-range first entry
        assert_eq!(pick_card(Some(""), None, None, &c), Pick::Hidden);
        assert_eq!(pick_card(Some("-1"), None, None, &c), Pick::Hidden);
        assert_eq!(pick_card(Some("x,0"), None, None, &c), Pick::Hidden);
        assert_eq!(pick_card(Some("5"), Some("PCI_BUS_ID"), None, &c), Pick::Hidden);
    }

    #[test]
    fn cuda_uuid_bytes_read_as_nvml_spells_them() {
        let b = [0xaa, 0xaa, 0xaa, 0xaa, 0x11, 0x11, 0x22, 0x22, 0x33, 0x33, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44];
        assert_eq!(uuid_string(&b), "GPU-aaaaaaaa-1111-2222-3333-444444444444");
    }

    #[test]
    fn trt_versions() {
        assert_eq!(super::trt_version_string(101600), "10.16.0");
        assert_eq!(super::trt_version_string(100302), "10.3.2");
    }

    #[test]
    #[cfg(any(target_os = "linux", windows, target_os = "macos"))]
    fn host_memory_readable() {
        assert!(super::host_available().is_some_and(|b| b > 0));
    }

    #[test]
    fn host_memory_formulas() {
        let mi = "MemTotal:       61000000 kB\nMemFree:         2000000 kB\nMemAvailable:   33554432 kB\n";
        assert_eq!(super::meminfo_available(mi), Some(33554432 * 1024));
        assert_eq!(super::meminfo_available("MemTotal: 1 kB\n"), None);
        assert_eq!(super::mac_available(1000, 100, 500, 16384), 1400 * 16384);
        assert_eq!(super::mac_available(10, 100, 5, 4096), 5 * 4096);
    }
}
