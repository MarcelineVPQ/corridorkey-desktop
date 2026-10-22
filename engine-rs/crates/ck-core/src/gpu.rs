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

/// The card index CUDA would use first: None when CUDA_VISIBLE_DEVICES hides every card.
fn visible_index() -> Option<c_uint> {
    match std::env::var("CUDA_VISIBLE_DEVICES") {
        Ok(v) if v.trim().is_empty() || v.trim() == "-1" => None,
        // loop: NOT-WORTH — one environment variable, once per NVML open
        Ok(v) => Some(v.split(',').next().and_then(|x| x.trim().parse().ok()).unwrap_or(0)),
        Err(_) => Some(0),
    }
}

struct Nvml {
    lib: Library,
    dev: *mut c_void,
}

impl Nvml {
    fn open() -> Option<Nvml> {
        let index = visible_index()?;
        // SAFETY: NVML's documented C signatures; the handle stays valid while `lib` is loaded
        unsafe {
            let lib = Library::new("libnvidia-ml.so.1").ok()?;
            let init: Symbol<unsafe extern "C" fn() -> c_int> = lib.get(b"nvmlInit_v2\0").ok()?;
            if init() != 0 {
                return None;
            }
            let get: Symbol<unsafe extern "C" fn(c_uint, *mut *mut c_void) -> c_int> = lib.get(b"nvmlDeviceGetHandleByIndex_v2\0").ok()?;
            let mut dev = std::ptr::null_mut();
            if get(index, &mut dev) != 0 {
                return None;
            }
            Some(Nvml { lib, dev })
        }
    }

    fn info(&self) -> Option<GpuInfo> {
        // SAFETY: buffers are sized as passed; types as documented
        unsafe {
            let mem: Symbol<unsafe extern "C" fn(*mut c_void, *mut Memory) -> c_int> = self.lib.get(b"nvmlDeviceGetMemoryInfo\0").ok()?;
            let name: Symbol<unsafe extern "C" fn(*mut c_void, *mut c_char, c_uint) -> c_int> = self.lib.get(b"nvmlDeviceGetName\0").ok()?;
            let drv: Symbol<unsafe extern "C" fn(*mut c_char, c_uint) -> c_int> = self.lib.get(b"nvmlSystemGetDriverVersion\0").ok()?;
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
        // SAFETY: the buffer holds `n` entries as passed
        unsafe {
            let procs: Symbol<unsafe extern "C" fn(*mut c_void, *mut c_uint, *mut ProcInfo) -> c_int> =
                self.lib.get(b"nvmlDeviceGetComputeRunningProcesses_v3\0").ok()?;
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

/// The first visible NVIDIA card, or None (no driver library, no card, or CUDA_VISIBLE_DEVICES="").
pub fn nvidia() -> Option<GpuInfo> {
    Nvml::open()?.info()
}

/// The memory budget the runtime's apply_auto_vram uses: free memory plus what this process already holds
/// (its loaded models count for it). (budget bytes, free bytes, own bytes).
pub fn budget() -> Option<(u64, u64, u64)> {
    let n = Nvml::open()?;
    let info = n.info()?;
    let own = n.used_by(std::process::id()).unwrap_or(0);
    Some((info.free + own, info.free, own))
}

/// TensorRT's version from libnvinfer (getInferLibVersion: major*10000 + minor*100 + patch for 10.x),
/// as "10.16.0"; None when the library is not there.
pub fn tensorrt_version() -> Option<String> {
    // loop: NOT-WORTH — two library names
    for name in ["libnvinfer.so.10", "libnvinfer.so"] {
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

/// Host memory the kernel says is available (MemAvailable, bytes): the CPU provider's budget.
pub fn host_available() -> Option<u64> {
    let s = std::fs::read_to_string("/proc/meminfo").ok()?;
    // loop: NOT-WORTH — /proc/meminfo's ~55 lines, once per CPU job
    s.lines().find_map(|l| l.strip_prefix("MemAvailable:")).and_then(|r| r.trim().trim_end_matches("kB").trim().parse::<u64>().ok()).map(|kb| kb * 1024)
}

#[cfg(test)]
mod tests {
    #[test]
    fn trt_versions() {
        assert_eq!(super::trt_version_string(101600), "10.16.0");
        assert_eq!(super::trt_version_string(100302), "10.3.2");
    }

    #[test]
    fn host_memory_readable() {
        assert!(super::host_available().unwrap() > 0);
    }
}
