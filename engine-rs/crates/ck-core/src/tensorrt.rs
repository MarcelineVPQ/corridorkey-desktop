//! TensorRT, opt-in per job (docs/BACKLOG.md row 12; OFF by default, the CUDA provider is the normal path).
//!
//! TensorRT engines are built for shape RANGES, not single shapes: the padded height and width (multiples of
//! the runtime's 128 px quantum, each axis on its own, so the aspect ratio counts) and the stage-1 window
//! length each fall in one range; one engine set per (height range, width range, window range) is built
//! once and cached on disk, under a folder named for the card, its driver, TensorRT and ONNX Runtime. A
//! driver or TensorRT change gives a new folder; the stale ones are removed and the engine says so. A clip
//! outside every range runs on the CUDA provider, and the reply says why. Frame rate and input bit depth
//! don't matter: every input is float32 (or float16) before the networks.
use std::path::{Path, PathBuf};

/// Padded height / width ranges (inclusive, multiples of 128).
pub const DIM_RANGES: [(usize, usize); 4] = [(128, 640), (768, 1152), (1280, 2176), (2304, 4096)];
/// Stage-1 window length ranges (the auto-VRAM table's windows: 1-8, 24, 48, 80).
pub const T_RANGES: [(usize, usize); 4] = [(1, 8), (9, 24), (25, 48), (49, 80)];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Bucket {
    pub h: (usize, usize),
    pub w: (usize, usize),
    pub t: (usize, usize),
}

fn range_of(v: usize, ranges: &[(usize, usize)]) -> Option<(usize, usize)> {
    ranges.iter().copied().find(|(lo, hi)| v >= *lo && v <= *hi)
}

/// The engine set a job needs: padded (H, W) and window length T. None: outside every range (CUDA runs it).
pub fn bucket_for(shape_h: usize, shape_w: usize, t: usize) -> Option<Bucket> {
    Some(Bucket { h: range_of(shape_h, &DIM_RANGES)?, w: range_of(shape_w, &DIM_RANGES)?, t: range_of(t, &T_RANGES)? })
}

impl Bucket {
    /// "h768-1152_w1280-2176_t9-24": the folder of this range's engines.
    pub fn key(&self) -> String {
        format!("h{}-{}_w{}-{}_t{}-{}", self.h.0, self.h.1, self.w.0, self.w.1, self.t.0, self.t.1)
    }
}

/// Channel counts of the exported networks (scripts/onnx_spike/wrappers.py).
pub const CRADIO_CH: usize = 1152;
pub const MOGE_CH: usize = 768;
pub const RVM_CH: usize = 384;
pub const BATON_CH: usize = 512;

/// The optimisation profile of one network for a bucket: (min, opt, max) shape strings in ORT's TensorRT
/// format ("input:1x3x256x384,state:..."). opt = the range's largest shape (1080p and UHD land at the top
/// of their ranges).
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
    // foundations run on a whole window (or 4 frames in low-VRAM mode): batch 1..T
    let tmin = if piece == "cradio" || piece == "moge" { 1 } else { b.t.0 };
    Some((at(b.h.0, b.w.0, tmin), at(b.h.1, b.w.1, b.t.1), at(b.h.1, b.w.1, b.t.1)))
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

/// Whether a bucket's engines for `piece` exist already (ORT writes *.engine files into the cache path).
pub fn built(dir: &Path) -> bool {
    std::fs::read_dir(dir).map(|rd| rd.flatten().any(|e| e.path().extension().map(|x| x == "engine").unwrap_or(false))).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_per_axis() {
        // 1080p: 1152 x 1920
        let b = bucket_for(1152, 1920, 24).unwrap();
        assert_eq!(b.key(), "h768-1152_w1280-2176_t9-24");
        // portrait 1080x1920 -> 1920 x 1152: a different bucket (aspect ratio counts)
        assert_eq!(bucket_for(1920, 1152, 24).unwrap().key(), "h1280-2176_w768-1152_t9-24");
        // UHD 2160 x 3840 padded to 2176 x 3840
        assert_eq!(bucket_for(2176, 3840, 8).unwrap().key(), "h1280-2176_w2304-4096_t1-8");
        // 8K: outside every range
        assert_eq!(bucket_for(4352, 7680, 8), None);
        assert_eq!(bucket_for(256, 384, 81), None);
    }

    #[test]
    fn profiles_cover_the_range() {
        let b = bucket_for(1152, 1920, 24).unwrap();
        let (min, opt, max) = profile("stage1", &b).unwrap();
        assert!(min.starts_with("rgb:1x9x3x768x1280,"), "{min}");
        assert!(max.contains("cradio:1x24x1152x18x34"), "{max}");
        assert_eq!(opt, max);
        let (min, _, max) = profile("rvm", &b).unwrap();
        assert_eq!(min, "frame:1x3x192x320,state:1x241x384");
        assert_eq!(max, "frame:1x3x288x544,state:1x613x384");
        let (min, _, max) = profile("moge", &b).unwrap();
        assert_eq!((min.as_str(), max.as_str()), ("rgb:1x3x168x280", "rgb:24x3x252x476"));
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
        assert!(!built(&cur));
        std::fs::write(cur.join("x.engine"), b"").unwrap();
        assert!(built(&cur));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
