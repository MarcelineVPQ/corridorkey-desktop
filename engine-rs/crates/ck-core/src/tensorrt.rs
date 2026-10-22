//! TensorRT, opt-in per job (docs/BACKLOG.md row 12; OFF by default, the CUDA provider is the normal path).
//!
//! Engines are built for shape RANGES, not single shapes: the padded height and width (multiples of the
//! runtime's 128 px quantum, each axis on its own, so the aspect ratio counts) each fall in one range, and the
//! range sets the longest stage-1 window its engines take. One engine set per range is built once, by
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
pub const DIM_RANGES: [(usize, usize); 8] =
    [(128, 512), (640, 896), (1024, 1280), (1408, 1664), (1792, 2176), (2304, 2816), (2944, 3456), (3584, 4096)];
/// Stage-1 window lengths a range can get: the longest whose window × largest frame fits PIXEL_FRAMES_MAX.
pub const WINDOWS: [usize; 5] = [24, 16, 12, 8, 4];
/// Measured (RTX 5080, TensorRT 10.16, 12 GB budget): stage 1 for windows up to 24 at 1152x1280 builds with
/// 6.5 GB of graphics memory and runs with a 3.1 GiB context; 24 at 1152x2176 doesn't build (no tactic fits),
/// 48 at 1152x2176 went past 12 GiB while building. So: window x largest frame <= 24 x 1152 x 1280.
pub const PIXEL_FRAMES_MAX: usize = 24 * 1152 * 1280;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Bucket {
    pub h: (usize, usize),
    pub w: (usize, usize),
    /// stage-1 window lengths (1 ..= the longest)
    pub t: (usize, usize),
}

fn range_of(v: usize, ranges: &[(usize, usize)]) -> Option<(usize, usize)> {
    ranges.iter().copied().find(|(lo, hi)| v >= *lo && v <= *hi)
}

/// The engine set for padded (H, W). None: outside every range, or even a 4-frame window is too big (CUDA runs it).
pub fn bucket_for(shape_h: usize, shape_w: usize) -> Option<Bucket> {
    let h = range_of(shape_h, &DIM_RANGES)?;
    let w = range_of(shape_w, &DIM_RANGES)?;
    let tmax = WINDOWS.iter().copied().find(|t| t * h.1 * w.1 <= PIXEL_FRAMES_MAX)?;
    Some(Bucket { h, w, t: (1, tmax) })
}

impl Bucket {
    /// "h1152-1536_w1152-1536_t1-16": the folder of this range's engines.
    pub fn key(&self) -> String {
        format!("h{}-{}_w{}-{}_t{}-{}", self.h.0, self.h.1, self.w.0, self.w.1, self.t.0, self.t.1)
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
    // RVM and stage 2 take one frame; the foundations and stage 1 a window (foundations: 4 in low-VRAM mode)
    Some((at(b.h.0, b.w.0, b.t.0), at(b.h.1, b.w.1, b.t.1), at(b.h.1, b.w.1, b.t.1)))
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

/// Build `piece`'s engine for bucket `b` into `dir` (`<piece>.engine`) with ck-trt-build, a child process (its
/// host memory goes back when it ends). Ok(seconds), Err(why). `workspace_mb`: TensorRT's working-memory limit.
pub fn build_engine(builder: &Path, onnx: &Path, piece: &str, b: &Bucket, dir: &Path, workspace_mb: u64, timing_cache: &Path) -> Result<f64, String> {
    let (min, opt, max) = profile(piece, b).ok_or("unknown network")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let t = std::time::Instant::now();
    let out = std::process::Command::new(builder)
        .arg("--onnx")
        .arg(onnx)
        .arg("--engine")
        .arg(engine_path(dir, piece))
        .args(["--min", &min, "--opt", &opt, "--max", &max, "--workspace-mb", &workspace_mb.to_string()])
        .arg("--timing-cache")
        .arg(timing_cache)
        .output()
        .map_err(|e| format!("{}: {e}", builder.display()))?;
    let line = String::from_utf8_lossy(&out.stdout).lines().last().unwrap_or("").to_string();
    if out.status.success() && line.contains("\"ok\":true") {
        return Ok(t.elapsed().as_secs_f64());
    }
    let why = serde_json::from_str::<serde_json::Value>(&line)
        .ok()
        .and_then(|v| v["error"].as_str().map(|s| s.to_string()))
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
    fn buckets_per_axis() {
        // 1080p: 1152 x 1920 -> windows up to 12 (12 x 1280 x 2176 fits, 16 doesn't)
        let b = bucket_for(1152, 1920).unwrap();
        assert_eq!(b.key(), "h1024-1280_w1792-2176_t1-12");
        // 1280x1080 -> 1152 x 1280: windows up to 16
        assert_eq!(bucket_for(1152, 1280).unwrap().key(), "h1024-1280_w1024-1280_t1-16");
        // 960x720 -> 768 x 1024, and 720p: 24
        assert_eq!(bucket_for(768, 1024).unwrap().key(), "h640-896_w1024-1280_t1-24");
        assert_eq!(bucket_for(768, 1280).unwrap().key(), "h640-896_w1024-1280_t1-24");
        // portrait: a different bucket (aspect ratio counts)
        assert_eq!(bucket_for(1920, 1152).unwrap().key(), "h1792-2176_w1024-1280_t1-12");
        // UHD 2176 x 3840: even 4 frames are too big
        assert_eq!(bucket_for(2176, 3840), None);
        assert_eq!(bucket_for(4352, 7680), None);
        // every bucket's longest window really fits
        // loop: NOT-WORTH — 8 x 8 ranges in a test
        for h in DIM_RANGES {
            // loop: NOT-WORTH — 8 ranges
            for w in DIM_RANGES {
                if let Some(b) = bucket_for(h.1, w.1) {
                    assert!(b.t.1 * h.1 * w.1 <= PIXEL_FRAMES_MAX);
                }
            }
        }
    }

    #[test]
    fn profiles_cover_the_range() {
        let b = bucket_for(1152, 1280).unwrap();
        let (min, opt, max) = profile("stage1", &b).unwrap();
        assert!(min.starts_with("rgb:1x1x3x1024x1024,"), "{min}");
        assert!(max.contains("cradio:1x16x1152x20x20"), "{max}");
        assert_eq!(opt, max);
        let (min, _, max) = profile("rvm", &b).unwrap();
        assert_eq!(min, "frame:1x3x256x256,state:1x257x384");
        assert_eq!(max, "frame:1x3x320x320,state:1x401x384");
        let (min, _, max) = profile("moge", &b).unwrap();
        assert_eq!((min.as_str(), max.as_str()), ("rgb:1x3x224x224", "rgb:16x3x280x280"));
        assert!(profile("nope", &b).is_none());
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
