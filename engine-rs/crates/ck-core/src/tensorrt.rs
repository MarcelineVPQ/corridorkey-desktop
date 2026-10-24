//! TensorRT, opt-in per job (docs/BACKLOG.md row 12; OFF by default, the CUDA provider is the normal path).
//!
//! Engines are built for shape RANGES, not single shapes: the padded height and width (multiples of the
//! runtime's 128 px quantum, each axis on its own, so the aspect ratio counts) each fall in one range. A TensorRT
//! job uses exactly the window (and low-VRAM staging) the CUDA path picks for the clip, so both give the same
//! matte; its engines are built for that window. One engine set per range is built once, by
//! `ck-trt-build` (strongly typed: the TensorRT-ready exports keep their weight GEMMs and convolutions in FP32,
//! the rest FP16, which matches the CUDA FP16 parity; ONNX Runtime's own TensorRT build is weakly typed and
//! measured 2-4x the error), and cached on disk under a folder named for the card, its driver, TensorRT and
//! ONNX Runtime. ONNX Runtime runs each engine through an EPContext stub next to it. A driver or TensorRT
//! change gives a new folder; the stale ones are removed and the engine says so. A clip outside every range
//! runs on the CUDA provider, and the reply says why.
use std::path::{Path, PathBuf};

/// Padded height / width ranges (inclusive, multiples of 128), 3-4 quanta wide so a range's largest shape stays
/// close to the clips in it (TensorRT sizes its working memory, and so the longest window, for the largest shape).
/// 720p pads to 768x1280, 1080p to 1152x1920, UHD to 2176x3840.
pub const DIM_RANGES: [(usize, usize); 8] = [(128, 512), (640, 896), (1024, 1280), (1408, 1664), (1792, 2176), (2304, 2816), (2944, 3456), (3584, 4096)];
/// The largest padded side TensorRT is used for. UHD (2176 x 3840 and up) runs on CUDA until its builds are
/// measured (BACKLOG row 12, step 3).
pub const MAX_SIDE: usize = 2176;
/// Frames per call of the foundation models in low-VRAM mode (pipeline.rs, the foundations prepass).
pub const FOUNDATION_CHUNK: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Bucket {
    pub h: (usize, usize),
    pub w: (usize, usize),
    /// stage-1 window lengths (1 ..= the job's window)
    pub t: (usize, usize),
    /// foundation-model batch (1 ..= FOUNDATION_CHUNK in low-VRAM mode, else the window)
    pub f: (usize, usize),
}

fn range_of(v: usize, ranges: &[(usize, usize)]) -> Option<(usize, usize)> {
    // loop: NOT-WORTH — eight ranges
    ranges.iter().copied().find(|(lo, hi)| v >= *lo && v <= *hi)
}

/// The engine set for padded (H, W) and the job's window (the CUDA path's choice; measured 2026-10-24: at the
/// same window TensorRT's mattes match CUDA's within fp16 rounding, at a shorter one they don't). None: outside
/// every range or larger than MAX_SIDE (CUDA runs it).
pub fn bucket_for(shape_h: usize, shape_w: usize, window: usize, low_vram: bool) -> Option<Bucket> {
    if shape_h > MAX_SIDE || shape_w > MAX_SIDE || window == 0 {
        return None;
    }
    let h = range_of(shape_h, &DIM_RANGES)?;
    let w = range_of(shape_w, &DIM_RANGES)?;
    let f = if low_vram { FOUNDATION_CHUNK.min(window) } else { window };
    Some(Bucket { h, w, t: (1, window), f: (1, f) })
}

impl Bucket {
    /// "h1024-1280_w1024-1280_t1-48_f1-4": the folder of this range's engines.
    pub fn key(&self) -> String {
        format!("h{}-{}_w{}-{}_t{}-{}_f{}-{}", self.h.0, self.h.1, self.w.0, self.w.1, self.t.0, self.t.1, self.f.0, self.f.1)
    }
}

/// Channel counts of the exported networks (scripts/onnx_spike/wrappers.py).
pub const CRADIO_CH: usize = 1152;
pub const MOGE_CH: usize = 768;
pub const RVM_CH: usize = 384;
pub const BATON_CH: usize = 512;

/// The optimisation profile of one network for a bucket: (min, opt, max) shape strings in ck-trt-build's (and
/// ORT's) format ("frame:1x3x256x384,state:..."). opt = the range's largest shape.
pub fn profile(piece: &str, b: &Bucket) -> Option<(String, String, String)> {
    let at = |h: usize, w: usize, t: usize| -> String {
        let (h4, w4, h64, w64) = (h / 4, w / 4, h / 64, w / 64);
        match piece {
            "cradio" => format!("rgb:{t}x3x{h4}x{w4}"),
            "moge" => format!("rgb:{t}x3x{}x{}", h * 7 / 32, w * 7 / 32),
            "rvm" => format!("frame:1x3x{h4}x{w4},state:1x{}x{RVM_CH}", 1 + h64 * w64),
            "stage1" => format!(
                "rgb:1x{t}x3x{h}x{w},hint:1x{t}x1x{h}x{w},hint_quality:1x{t},moge:1x{t}x{MOGE_CH}x{h64}x{w64},cradio:1x{t}x{CRADIO_CH}x{h64}x{w64},rvm:1x{t}x{RVM_CH}x{h64}x{w64}"
            ),
            "stage2" => format!("rgb:1x1x3x{h}x{w},baton:1x1x{BATON_CH}x{}x{}", h / 16, w / 16),
            _ => String::new(),
        }
    };
    if !["cradio", "moge", "rvm", "stage1", "stage2"].contains(&piece) {
        return None;
    }
    // RVM and stage 2 take one frame; stage 1 a window; the foundations a window, or FOUNDATION_CHUNK in low-VRAM mode
    let t = if piece == "cradio" || piece == "moge" { b.f } else { b.t };
    Some((at(b.h.0, b.w.0, t.0), at(b.h.1, b.w.1, t.1), at(b.h.1, b.w.1, t.1)))
}

/// The engine builder: CK_ENGINE_TRT_BUILD, else `ck-trt-build` next to this program.
pub fn builder_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CK_ENGINE_TRT_BUILD") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    let exe = std::env::current_exe().ok()?;
    let p = exe.parent()?.join("ck-trt-build");
    p.exists().then_some(p)
}

/// The longest one engine build may take: CK_ENGINE_TRT_BUILD_TIMEOUT_S, default 1800 s (measured builds on the
/// RTX 5080: 23-93 s per network; slower cards take longer, a hung build is stopped and the network runs on CUDA).
pub fn build_timeout() -> std::time::Duration {
    let s = std::env::var("CK_ENGINE_TRT_BUILD_TIMEOUT_S").ok().and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(1800);
    std::time::Duration::from_secs(s.max(1))
}

/// Build `piece`'s engine for bucket `b` into `dir` (`<piece>.engine`) with ck-trt-build, a child process (its
/// host memory goes back when it ends). Ok(seconds), Err(why). `workspace_mb`: TensorRT's working-memory limit.
pub fn build_engine(builder: &Path, onnx: &Path, piece: &str, b: &Bucket, dir: &Path, workspace_mb: u64, timing_cache: &Path) -> Result<f64, String> {
    let (min, opt, max) = profile(piece, b).ok_or("unknown network")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let t = std::time::Instant::now();
    let mut cmd = std::process::Command::new(builder);
    // a killed engine takes its builder with it (it holds the card for minutes)
    crate::proc::die_with_parent(&mut cmd);
    cmd.arg("--onnx")
        .arg(onnx)
        .arg("--engine")
        .arg(engine_path(dir, piece))
        .args(["--min", &min, "--opt", &opt, "--max", &max, "--workspace-mb", &workspace_mb.to_string()])
        .arg("--timing-cache")
        .arg(timing_cache);
    // loop: SERIAL-REQUIRED — one engine build at a time (the builder needs the card to itself); deadline build_timeout() 1800 s (this pass: it had none)
    let out = crate::proc::output_timeout(&mut cmd, build_timeout()).map_err(|e| format!("ck-trt-build: {e}"))?;
    // loop: NOT-WORTH — the builder's output lines, once per build
    let line = String::from_utf8_lossy(&out.stdout).lines().last().unwrap_or("").to_string();
    if out.status.success() && line.contains("\"ok\":true") {
        return Ok(t.elapsed().as_secs_f64());
    }
    let why = serde_json::from_str::<serde_json::Value>(&line)
        .ok()
        .and_then(|v| v["error"].as_str().map(|s| s.to_string()))
        // loop: NOT-WORTH — the builder's stderr, once per failed build
        .unwrap_or_else(|| format!("ck-trt-build exited with {}: {}", out.status, String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")));
    Err(why)
}

/// `<dir>/<piece>.engine`
pub fn engine_path(dir: &Path, piece: &str) -> PathBuf {
    dir.join(format!("{piece}.engine"))
}

/// `<dir>/<piece>_ctx.onnx`: the EPContext stub ONNX Runtime opens (its `ep_cache_context` is `<piece>.engine`)
pub fn stub_path(dir: &Path, piece: &str) -> PathBuf {
    dir.join(format!("{piece}_ctx.onnx"))
}

/// "nvidia-geforce-rtx-5080": a folder-safe card name.
pub fn slug(s: &str) -> String {
    let mut out = String::new();
    // loop: NOT-WORTH — one short name
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == '.' {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

/// The cache folder for this card + driver + TensorRT + ONNX Runtime + precision.
pub fn cache_dir(root: &Path, gpu: &str, driver: &str, trt: &str, ort: &str, precision: &str) -> PathBuf {
    root.join(format!("{}__drv{}__trt{}__ort{}__{}", slug(gpu), driver, trt, ort, precision))
}

/// Cache folders of the same card that were made for another driver / TensorRT / ORT: they can no longer be
/// used (TensorRT engines are tied to the versions that built them).
pub fn stale_dirs(root: &Path, current: &Path, gpu: &str) -> Vec<PathBuf> {
    let prefix = format!("{}__", slug(gpu));
    let Ok(rd) = std::fs::read_dir(root) else { return vec![] };
    let mut v: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && p != current && p.file_name().map(|n| n.to_string_lossy().starts_with(&prefix)).unwrap_or(false))
        .collect();
    v.sort();
    v
}

/// What an engine was built from: size and modification time of the TensorRT-ready export and its weights.
/// A changed export (a new model set) no longer matches, so its engine is rebuilt.
pub fn source_stamp(onnx: &Path) -> String {
    let data = PathBuf::from(format!("{}.data", onnx.display()));
    [onnx.to_path_buf(), data]
        // loop: NOT-WORTH — a few cache folders, once per TensorRT job
        .iter()
        .map(|p| match std::fs::metadata(p) {
            Ok(m) => format!("{}:{}", m.len(), m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0)),
            Err(_) => "-".into(),
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// `<dir>/<piece>.source`: the source stamp the engine was built from.
pub fn source_path(dir: &Path, piece: &str) -> PathBuf {
    dir.join(format!("{piece}.source"))
}

/// `<dir>/<piece>.failed`: a build that found no tactic, remembered so later jobs don't spend minutes on it again
/// (measured 2026-10-24: stage 1 for 80-frame windows retried its failing build on every 80-frame job, ~2.5 min each).
pub fn failed_path(dir: &Path, piece: &str) -> PathBuf {
    dir.join(format!("{piece}.failed"))
}

/// Remember that `piece` failed to build from the export with `stamp` and `workspace_mb` of working memory.
pub fn record_failure(dir: &Path, piece: &str, stamp: &str, workspace_mb: u64, why: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(failed_path(dir, piece), format!("{stamp}\n{workspace_mb}\n{why}\n"))
}

/// Why `piece` failed before, if it failed from this export with at least `workspace_mb` (None: any workspace).
/// The cache folder is already per card, driver, TensorRT and ONNX Runtime, so a change of any of those, of the
/// models, or a bigger workspace (a larger memory budget) tries the build again.
pub fn failed_before(dir: &Path, piece: &str, stamp: &str, workspace_mb: Option<u64>) -> Option<String> {
    let text = std::fs::read_to_string(failed_path(dir, piece)).ok()?;
    // loop: NOT-WORTH — the three lines of one small file, once per network per TensorRT job
    let mut lines = text.lines();
    if lines.next()?.trim() != stamp {
        return None;
    }
    let ws: u64 = lines.next()?.trim().parse().ok()?;
    if workspace_mb.is_some_and(|w| w > ws) {
        return None;
    }
    Some(lines.next().unwrap_or("").to_string())
}

/// Whether `piece`'s engine and its stub exist in `dir`, built from the export with this `stamp`.
pub fn built(dir: &Path, piece: &str, stamp: &str) -> bool {
    engine_path(dir, piece).exists()
        && stub_path(dir, piece).exists()
        && std::fs::read_to_string(source_path(dir, piece)).map(|s| s.trim() == stamp).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_follow_the_cuda_window() {
        // 1280x1080 -> 1152 x 1280 at CUDA's 48/24 low-VRAM window: foundations in fours
        assert_eq!(bucket_for(1152, 1280, 48, true).unwrap().key(), "h1024-1280_w1024-1280_t1-48_f1-4");
        // 960x720 -> 768 x 1024 at 80/40
        assert_eq!(bucket_for(768, 1024, 80, true).unwrap().key(), "h640-896_w1024-1280_t1-80_f1-4");
        // all networks loaded together: the foundations take the whole window
        assert_eq!(bucket_for(1152, 1280, 16, false).unwrap().key(), "h1024-1280_w1024-1280_t1-16_f1-16");
        // a window shorter than four frames
        assert_eq!(bucket_for(1152, 1280, 2, true).unwrap().f, (1, 2));
        // portrait: a different bucket (aspect ratio counts)
        assert_eq!(bucket_for(1920, 1152, 24, true).unwrap().key(), "h1792-2176_w1024-1280_t1-24_f1-4");
        // UHD stays on CUDA (step 3), and so does anything past the ranges
        assert_eq!(bucket_for(2176, 3840, 8, true), None);
        assert_eq!(bucket_for(4352, 7680, 4, true), None);
        assert_eq!(bucket_for(1152, 1280, 0, true), None);
    }

    #[test]
    fn profiles_cover_the_range() {
        let b = bucket_for(1152, 1280, 48, true).unwrap();
        let (min, opt, max) = profile("stage1", &b).unwrap();
        assert!(min.starts_with("rgb:1x1x3x1024x1024,"), "{min}");
        assert!(max.contains("cradio:1x48x1152x20x20"), "{max}");
        assert_eq!(opt, max);
        let (min, _, max) = profile("rvm", &b).unwrap();
        assert_eq!(min, "frame:1x3x256x256,state:1x257x384");
        assert_eq!(max, "frame:1x3x320x320,state:1x401x384");
        let (min, _, max) = profile("moge", &b).unwrap();
        assert_eq!((min.as_str(), max.as_str()), ("rgb:1x3x224x224", "rgb:4x3x280x280"));
        assert!(profile("nope", &b).is_none());
    }

    #[test]
    fn a_failed_build_is_remembered_until_something_changes() {
        let dir = std::env::temp_dir().join(format!("ck-trt-failed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(failed_before(&dir, "stage1", "s1", Some(7000)), None);
        record_failure(&dir, "stage1", "s1", 7000, "no tactic").unwrap();
        assert_eq!(failed_before(&dir, "stage1", "s1", Some(7000)).as_deref(), Some("no tactic"));
        assert_eq!(failed_before(&dir, "stage1", "s1", None).as_deref(), Some("no tactic"));
        // new models, or more working memory: try again
        assert_eq!(failed_before(&dir, "stage1", "s2", Some(7000)), None);
        assert_eq!(failed_before(&dir, "stage1", "s1", Some(8192)), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cache_folders() {
        let root = std::env::temp_dir().join(format!("ck-trt-{}", std::process::id()));
        let cur = cache_dir(&root, "NVIDIA GeForce RTX 5080", "615.71", "10.16.0", "1.31.0", "fp16");
        assert!(cur.ends_with("nvidia-geforce-rtx-5080__drv615.71__trt10.16.0__ort1.31.0__fp16"));
        let old = cache_dir(&root, "NVIDIA GeForce RTX 5080", "610.10", "10.16.0", "1.31.0", "fp16");
        let other = cache_dir(&root, "NVIDIA GeForce RTX 2070", "610.10", "10.16.0", "1.31.0", "fp16");
        // loop: NOT-WORTH — three folders
        for d in [&cur, &old, &other] {
            std::fs::create_dir_all(d).unwrap();
        }
        assert_eq!(stale_dirs(&root, &cur, "NVIDIA GeForce RTX 5080"), vec![old.clone()]);
        assert!(!built(&cur, "rvm", "1:2,-"));
        std::fs::write(engine_path(&cur, "rvm"), b"").unwrap();
        std::fs::write(stub_path(&cur, "rvm"), b"").unwrap();
        assert!(!built(&cur, "rvm", "1:2,-"));
        std::fs::write(source_path(&cur, "rvm"), b"1:2,-").unwrap();
        assert!(built(&cur, "rvm", "1:2,-"));
        assert!(!built(&cur, "rvm", "1:3,-"));
        let onnx = cur.join("x.onnx");
        std::fs::write(&onnx, b"abc").unwrap();
        assert!(source_stamp(&onnx).starts_with("3:") && source_stamp(&onnx).ends_with(",-"));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
