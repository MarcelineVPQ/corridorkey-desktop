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
pub(crate) const DIM_RANGES: [(usize, usize); 8] = [(128, 512), (640, 896), (1024, 1280), (1408, 1664), (1792, 2176), (2304, 2816), (2944, 3456), (3584, 4096)];
/// The largest padded side TensorRT is used for: 4096 (DCI 4K, 4096x2160, pads to 2176x4096).
pub(crate) const MAX_SIDE: usize = 4096;
/// The largest engine shape (a range's largest H x W) TensorRT is used for: 2176 x 4096, the largest measured
/// (BACKLOG row 12, step 3, 2026-10-24, RTX 5080 16 GB: all five networks build for the 4K range at the 8/4
/// low-VRAM window, stage 1 in 139 s with a 7.2 GB workspace, peak 13.1 GB on the card). A range past it (open gate
/// 4096x3072 pads into h2944-3456) runs on CUDA until measured.
pub(crate) const MAX_AREA: usize = 2176 * 4096;
/// Frames per call of the foundation models in low-VRAM mode (pipeline.rs, the foundations prepass).
pub(crate) const FOUNDATION_CHUNK: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Bucket {
    pub(crate) h: (usize, usize),
    pub(crate) w: (usize, usize),
    /// stage-1 window lengths (1 ..= the job's window)
    pub(crate) t: (usize, usize),
    /// foundation-model batch (1 ..= FOUNDATION_CHUNK in low-VRAM mode, else the window)
    pub(crate) f: (usize, usize),
}

fn range_of(v: usize, ranges: &[(usize, usize)]) -> Option<(usize, usize)> {
    ranges.iter().copied().find(|(lo, hi)| v >= *lo && v <= *hi)
}

/// The engine set for padded (H, W) and the job's window (the CUDA path's choice; measured 2026-10-24: at the
/// same window TensorRT's mattes match CUDA's within fp16 rounding, at a shorter one they don't). None: outside
/// every range, larger than MAX_SIDE, or in a range larger than MAX_AREA (CUDA runs it).
pub(crate) fn bucket_for(shape_h: usize, shape_w: usize, window: usize, low_vram: bool) -> Option<Bucket> {
    if shape_h > MAX_SIDE || shape_w > MAX_SIDE || window == 0 {
        return None;
    }
    let h = range_of(shape_h, &DIM_RANGES)?;
    let w = range_of(shape_w, &DIM_RANGES)?;
    if h.1 * w.1 > MAX_AREA {
        return None;
    }
    let f = if low_vram { FOUNDATION_CHUNK.min(window) } else { window };
    Some(Bucket { h, w, t: (1, window), f: (1, f) })
}

impl Bucket {
    /// "h1024-1280_w1024-1280_t1-48_f1-4": the folder of this range's engines.
    pub(crate) fn key(&self) -> String {
        format!("h{}-{}_w{}-{}_t{}-{}_f{}-{}", self.h.0, self.h.1, self.w.0, self.w.1, self.t.0, self.t.1, self.f.0, self.f.1)
    }
}

/// Channel counts of the exported networks (scripts/onnx_spike/wrappers.py).
pub(crate) const CRADIO_CH: usize = 1152;
pub(crate) const MOGE_CH: usize = 768;
pub(crate) const RVM_CH: usize = 384;
pub(crate) const BATON_CH: usize = 512;

/// The optimisation profile of one network for a bucket: (min, opt, max) shape strings in ck-trt-build's (and
/// ORT's) format ("frame:1x3x256x384,state:..."). opt = the range's largest shape.
pub(crate) fn profile(piece: &str, b: &Bucket) -> Option<(String, String, String)> {
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

/// The engine builder: `explicit` (CK_ENGINE_TRT_BUILD, config.rs), else `ck-trt-build` (`ck-trt-build.exe` on
/// Windows) next to this program.
pub(crate) fn builder_path(explicit: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = explicit {
        return Some(p.to_path_buf());
    }
    let exe = std::env::current_exe().ok()?;
    let p = exe.parent()?.join(builder_name());
    p.exists().then_some(p)
}

/// The builder's file name on this system.
pub(crate) fn builder_name() -> String {
    format!("ck-trt-build{}", std::env::consts::EXE_SUFFIX)
}

/// Build `piece`'s engine for bucket `b` into `dir` (`<piece>.engine`) with ck-trt-build, a child process (its
/// host memory goes back when it ends). Ok(seconds), Err(why). `workspace_mb`: TensorRT's working-memory limit.
/// `timeout`: the longest the build may take (CK_ENGINE_TRT_BUILD_TIMEOUT_S, default 1800 s; measured builds on
/// the RTX 5080: 23-93 s per network; a hung build is stopped and the network runs on CUDA).
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_engine(
    builder: &Path,
    onnx: &Path,
    piece: &str,
    b: &Bucket,
    dir: &Path,
    workspace_mb: u64,
    timing_cache: &Path,
    timeout: std::time::Duration,
) -> Result<f64, BuildError> {
    let (min, opt, max) = profile(piece, b).ok_or_else(|| BuildError::transient("unknown network".into()))?;
    std::fs::create_dir_all(dir).map_err(|e| BuildError::transient(format!("{}: {e}", dir.display())))?;
    let t = std::time::Instant::now();
    let mut cmd = std::process::Command::new(builder);
    // a killed engine takes its builder with it (it holds the card for minutes). Linux: the death signal follows the
    // spawning THREAD, so this runs on the engine's main thread (trt_prepare, called by Pipeline::run from the
    // protocol loop); never call build_engine from a worker thread (proc::die_with_parent)
    crate::proc::die_with_parent(&mut cmd);
    cmd.arg("--onnx")
        .arg(onnx)
        .arg("--engine")
        .arg(engine_path(dir, piece))
        .args(["--min", &min, "--opt", &opt, "--max", &max, "--workspace-mb", &workspace_mb.to_string()])
        .arg("--timing-cache")
        .arg(timing_cache);
    // loop: SERIAL-REQUIRED — one engine build at a time (the builder needs the card to itself); deadline `timeout` (CK_ENGINE_TRT_BUILD_TIMEOUT_S, 1800 s)
    // a timeout or a builder that can't start is never remembered as a failed build
    let out = crate::proc::output_timeout(&mut cmd, timeout).map_err(|e| BuildError::transient(format!("ck-trt-build: {e}")))?;
    // loop: NOT-WORTH — the builder's output lines, once per build
    let line = String::from_utf8_lossy(&out.stdout).lines().last().unwrap_or("").to_string();
    if out.status.success() && line.contains("\"ok\":true") {
        return Ok(t.elapsed().as_secs_f64());
    }
    match serde_json::from_str::<serde_json::Value>(&line).ok().and_then(|v| v["error"].as_str().map(|s| s.to_string())) {
        // the builder's own answer: remembered only when it says the network can't be built
        Some(why) => Err(BuildError { deterministic: deterministic_failure(&why), why }),
        // a crash or a kill (no answer line): may go another way next time
        None => Err(BuildError::transient(format!(
            "ck-trt-build exited with {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")
        ))),
    }
}

/// A failed engine build: why, and whether the same build would fail again (`deterministic`: the network can't
/// be parsed or no tactic fits; only those are remembered in `.failed`, never a timeout, a lack of memory or a
/// busy card).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct BuildError {
    pub(crate) why: String,
    pub(crate) deterministic: bool,
}

impl BuildError {
    pub(crate) fn transient(why: String) -> BuildError {
        BuildError { why, deterministic: false }
    }
}

/// Whether the builder's error says the build itself can't succeed with these inputs: the ONNX parser refused the
/// network, the arguments are wrong, or TensorRT found no implementation (tactic) for a node within the workspace.
/// A lack of graphics or host memory, a busy or unavailable card, or a CUDA error is not: the next job may have the
/// card to itself.
pub(crate) fn deterministic_failure(why: &str) -> bool {
    let low = why.to_lowercase();
    const TRANSIENT: [&str; 12] = [
        "out of memory",
        "outofmemory",
        "cudaerrormemoryallocation",
        "could not be allocated",
        "failed to allocate",
        "insufficient memory",
        "bad_alloc",
        "busy",
        "unavailable",
        "timed out",
        "no answer within",
        "cuda error",
    ];
    if TRANSIENT.iter().any(|m| low.contains(m)) {
        return false;
    }
    const DETERMINISTIC: [&str; 7] = ["could not find any implementation", "no tactic", "parse:", "bad shapes", "no shape range", "missing --", "bad argument"];
    DETERMINISTIC.iter().any(|m| low.contains(m))
}

/// One engine process builds a range's engines at a time: `<range folder>/build.lock`, made with create_new (the
/// file system's own exclusive create, on every system), removed when the guard drops. Two engines (two app copies,
/// a bench next to the app) building the same range at once would each spend minutes of the card on the same
/// engines and replace each other's files.
pub(crate) struct BuildLock {
    path: PathBuf,
}

/// How often a waiting engine looks at another engine's build lock.
const LOCK_POLL: std::time::Duration = std::time::Duration::from_millis(500);

impl BuildLock {
    /// Take `dir`'s build lock. Held by another engine: wait for it (`waiting` is called once), at most `deadline`; a
    /// lock not refreshed for `stale_after` (its engine was killed or crashed) is taken over, as is one still held
    /// at the deadline (its builds have run past their own deadlines by then). Ok((lock, waited)); Err: the lock
    /// file can't be made (the folder isn't writable: the build then fails on its own and says why).
    pub(crate) fn acquire(
        dir: &Path,
        stale_after: std::time::Duration,
        deadline: std::time::Duration,
        mut waiting: impl FnMut(),
    ) -> std::io::Result<(BuildLock, bool)> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("build.lock");
        let end = std::time::Instant::now() + deadline;
        let mut waited = false;
        // loop: SERIAL-REQUIRED — waits for another engine's build of the same range, a poll every LOCK_POLL [bounded: `deadline`, then the lock is taken over]
        loop {
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut f) => {
                    use std::io::Write;
                    let _ = writeln!(f, "{}", std::process::id());
                    return Ok((BuildLock { path }, waited));
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e),
            }
            let age = std::fs::metadata(&path).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok());
            if age.is_some_and(|a| a > stale_after) || std::time::Instant::now() >= end {
                // gone stale, or past the deadline: take it over (a removal that loses a race just loops again)
                let _ = std::fs::remove_file(&path);
                continue;
            }
            if !waited {
                waited = true;
                waiting();
            }
            // loop: SERIAL-REQUIRED — the lock poll's sleep (not a spin), until `deadline`
            std::thread::sleep(LOCK_POLL);
        }
    }

    /// Show the lock is still held (before each build, so a waiting engine doesn't take it over as stale).
    pub(crate) fn touch(&self) {
        let _ = std::fs::write(&self.path, format!("{}\n", std::process::id()));
    }
}

impl Drop for BuildLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// `<dir>/<piece>.engine`
pub(crate) fn engine_path(dir: &Path, piece: &str) -> PathBuf {
    dir.join(format!("{piece}.engine"))
}

/// `<dir>/<piece>_ctx.onnx`: the EPContext stub ONNX Runtime opens (its `ep_cache_context` is `<piece>.engine`)
pub(crate) fn stub_path(dir: &Path, piece: &str) -> PathBuf {
    dir.join(format!("{piece}_ctx.onnx"))
}

/// "nvidia-geforce-rtx-5080": a folder-safe card name.
pub(crate) fn slug(s: &str) -> String {
    let mut out = String::new();
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
pub(crate) fn cache_dir(root: &Path, gpu: &str, driver: &str, trt: &str, ort: &str, precision: &str) -> PathBuf {
    root.join(format!("{}__drv{}__trt{}__ort{}__{}", slug(gpu), driver, trt, ort, precision))
}

/// Cache folders of the same card that were made for another driver / TensorRT / ORT: they can no longer be
/// used (TensorRT engines are tied to the versions that built them).
pub(crate) fn stale_dirs(root: &Path, current: &Path, gpu: &str) -> Vec<PathBuf> {
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
pub(crate) fn source_stamp(onnx: &Path) -> String {
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
pub(crate) fn source_path(dir: &Path, piece: &str) -> PathBuf {
    dir.join(format!("{piece}.source"))
}

/// `<dir>/<piece>.failed`: a build that found no tactic, remembered so later jobs don't spend minutes on it again
/// (measured 2026-10-24: stage 1 for 80-frame windows retried its failing build on every 80-frame job, ~2.5 min each).
pub(crate) fn failed_path(dir: &Path, piece: &str) -> PathBuf {
    dir.join(format!("{piece}.failed"))
}

/// Remember that `piece` failed to build from the export with `stamp` and `workspace_mb` of working memory.
pub(crate) fn record_failure(dir: &Path, piece: &str, stamp: &str, workspace_mb: u64, why: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(failed_path(dir, piece), format!("{stamp}\n{workspace_mb}\n{why}\n"))
}

/// Remember a failed build only when it would fail the same way again (`BuildError::deterministic`); a timeout,
/// a lack of memory or a busy card is tried again by the next job. Ok(true): remembered.
pub(crate) fn note_failure(dir: &Path, piece: &str, stamp: &str, workspace_mb: u64, err: &BuildError) -> std::io::Result<bool> {
    if !err.deterministic {
        return Ok(false);
    }
    record_failure(dir, piece, stamp, workspace_mb, &err.why).map(|_| true)
}

/// Why `piece` failed before, if it failed from this export with at least `workspace_mb` (None: any workspace).
/// The cache folder is already per card, driver, TensorRT and ONNX Runtime, so a change of any of those, of the
/// models, or a bigger workspace (a larger memory budget) tries the build again.
pub(crate) fn failed_before(dir: &Path, piece: &str, stamp: &str, workspace_mb: Option<u64>) -> Option<String> {
    let text = std::fs::read_to_string(failed_path(dir, piece)).ok()?;
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
pub(crate) fn built(dir: &Path, piece: &str, stamp: &str) -> bool {
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
        // 4K (step 3): DCI 4K and UHD share the 2176 x 4096 range, portrait too; the 8/4 low-VRAM window
        assert_eq!(bucket_for(2176, 4096, 8, true).unwrap().key(), "h1792-2176_w3584-4096_t1-8_f1-4");
        assert_eq!(bucket_for(2176, 3840, 8, true).unwrap().key(), "h1792-2176_w3584-4096_t1-8_f1-4");
        assert_eq!(bucket_for(4096, 2176, 8, true).unwrap().key(), "h3584-4096_w1792-2176_t1-8_f1-4");
        // past the largest measured shape (open gate 4096x3072 -> 3072 x 4096) and past the ranges: CUDA
        assert_eq!(bucket_for(3072, 4096, 8, true), None);
        assert_eq!(bucket_for(4224, 4096, 8, true), None);
        assert_eq!(bucket_for(4352, 7680, 4, true), None);
        assert_eq!(bucket_for(1152, 1280, 0, true), None);
    }

    #[test]
    fn shapes_up_to_2176_keep_their_step_2_buckets() {
        // the step-2 rule (MAX_SIDE 2176, no area limit), unchanged for every padded shape it took
        let step2 = |h: usize, w: usize, t: usize, low: bool| -> Option<Bucket> {
            if h > 2176 || w > 2176 || t == 0 {
                return None;
            }
            let f = if low { FOUNDATION_CHUNK.min(t) } else { t };
            Some(Bucket { h: range_of(h, &DIM_RANGES)?, w: range_of(w, &DIM_RANGES)?, t: (1, t), f: (1, f) })
        };
        // loop: NOT-WORTH — a test over 17 x 17 shapes x a few windows
        for h in (128..=2176).step_by(128) {
            for w in (128..=2176).step_by(128) {
                for (t, low) in [(1, true), (8, true), (48, true), (80, true), (16, false), (24, false)] {
                    assert_eq!(bucket_for(h, w, t, low), step2(h, w, t, low), "{h}x{w} t{t} low {low}");
                }
            }
        }
    }

    #[test]
    fn the_4k_profiles() {
        let b = bucket_for(2176, 4096, 8, true).unwrap();
        let (min, _, max) = profile("stage1", &b).unwrap();
        assert!(min.starts_with("rgb:1x1x3x1792x3584,"), "{min}");
        assert!(max.starts_with("rgb:1x8x3x2176x4096,") && max.contains("cradio:1x8x1152x34x64"), "{max}");
        assert_eq!(profile("cradio", &b).unwrap().2, "rgb:4x3x544x1024");
        assert_eq!(profile("rvm", &b).unwrap().2, "frame:1x3x544x1024,state:1x2177x384");
        assert_eq!(profile("stage2", &b).unwrap().2, "rgb:1x1x3x2176x4096,baton:1x1x512x136x256");
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

    #[test]
    fn only_builds_that_would_fail_again_are_remembered() {
        // the builder's answers (ck_trt_build.cpp `fail`) and TensorRT's own error texts
        // loop: NOT-WORTH — a test's few messages
        for why in [
            "build: [optimizer.cpp::computeCosts] Error Code 10: Internal Error (Could not find any implementation for node /blocks/MatMul.)",
            "parse: Unsupported ONNX data type: UINT8 (2)",
            "bad shapes",
            "no shape range for input hint",
            "bad argument: stoull",
        ] {
            assert!(deterministic_failure(why), "{why}");
        }
        // loop: NOT-WORTH — a test's few messages
        for why in [
            "build: Error Code 2: OutOfMemory (Requested size was 6442450944 bytes.)",
            "build: [resizingAllocator.cpp] Error Code 1: Cuda Runtime (out of memory)",
            "build: Requested amount of GPU memory (7000000000 bytes) could not be allocated",
            "build: Error Code 1: Cuda Runtime (CUDA-capable device(s) is/are busy or unavailable)",
            "ck-trt-build: no answer within 1800 s; stopped",
            "ck-trt-build exited with signal: 9 (SIGKILL): ",
            "TensorRT builder: CUDA initialization failure with error: 999",
            // no tactic because the memory ran out is still a lack of memory
            "build: Could not find any implementation for node X due to insufficient memory",
        ] {
            assert!(!deterministic_failure(why), "{why}");
        }
        let dir = std::env::temp_dir().join(format!("ck-trt-note-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let oom = BuildError { why: "build: Error Code 2: OutOfMemory".into(), deterministic: false };
        assert!(!note_failure(&dir, "stage1", "s1", 7000, &oom).unwrap());
        assert_eq!(failed_before(&dir, "stage1", "s1", Some(7000)), None);
        let timeout = BuildError::transient("ck-trt-build: no answer within 1800 s; stopped".into());
        assert!(!note_failure(&dir, "stage1", "s1", 7000, &timeout).unwrap());
        assert_eq!(failed_before(&dir, "stage1", "s1", None), None);
        let tactic = BuildError { why: "build: Could not find any implementation for node X".into(), deterministic: true };
        assert!(note_failure(&dir, "stage1", "s1", 7000, &tactic).unwrap());
        assert!(failed_before(&dir, "stage1", "s1", Some(7000)).is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn one_engine_builds_a_range_at_a_time() {
        use std::time::{Duration, Instant};
        let dir = std::env::temp_dir().join(format!("ck-trt-lock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let long = Duration::from_secs(30);
        let (first, waited) = BuildLock::acquire(&dir, long, long, || {}).unwrap();
        assert!(!waited && dir.join("build.lock").exists());
        // a second engine waits until the first lets go
        let d2 = dir.clone();
        let t = Instant::now();
        let second = std::thread::spawn(move || {
            let mut said = 0;
            let (l, waited) = BuildLock::acquire(&d2, long, long, || said += 1).unwrap();
            drop(l);
            (waited, said)
        });
        std::thread::sleep(Duration::from_millis(700));
        first.touch();
        drop(first);
        // loop: NOT-WORTH — joins the waiting test thread [bounded: the lock was just released]
        assert_eq!(second.join().unwrap(), (true, 1));
        assert!(t.elapsed() >= Duration::from_millis(700));
        assert!(!dir.join("build.lock").exists(), "released on drop");
        // a stale lock (its engine died) is taken over at once; one held past the deadline too
        std::fs::write(dir.join("build.lock"), "1\n").unwrap();
        std::thread::sleep(Duration::from_millis(50));
        let t = Instant::now();
        let (l, _) = BuildLock::acquire(&dir, Duration::from_millis(10), long, || {}).unwrap();
        assert!(t.elapsed() < Duration::from_secs(1));
        let t = Instant::now();
        let (l2, waited) = BuildLock::acquire(&dir, long, Duration::from_millis(300), || {}).unwrap();
        assert!(waited && t.elapsed() < Duration::from_secs(3));
        drop((l, l2));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_builder_has_the_systems_program_name() {
        let n = builder_name();
        assert!(n.starts_with("ck-trt-build"));
        assert_eq!(n.ends_with(".exe"), cfg!(windows));
    }
}
