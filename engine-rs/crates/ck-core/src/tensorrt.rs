//! TensorRT, opt-in per job (docs/BACKLOG.md row 12; OFF by default, the CUDA provider is the normal path).
//!
//! Engines are built for shape RANGES, not single shapes: the padded height and width (multiples of the
//! runtime's 128 px quantum, each axis on its own, so the aspect ratio counts) each fall in one range. A TensorRT
//! job uses exactly the window (and low-VRAM staging) the CUDA path picks for the clip. Its engines are its own
//! window's range, or (1.0.0-dev.7) a built range of its size for a longer window (Bucket::serves), used only when
//! that range's own memory need fits the job's budget (pipeline trt_serving). One engine set per range is built once, by
//! `ck-trt-build` (strongly typed: the TensorRT-ready exports keep their weight GEMMs and convolutions in FP32,
//! the rest FP16, which matches the CUDA FP16 parity; ONNX Runtime's own TensorRT build is weakly typed and
//! measured 2-4x the error), and cached on disk under a folder named for the card, its driver, TensorRT and
//! ONNX Runtime. ONNX Runtime runs each engine through an EPContext stub next to it. A driver or TensorRT
//! change gives a new folder; folders of another driver are removed, those of another TensorRT or ONNX Runtime
//! after 30 days unused (another installed copy may use them), and the engine says so. A clip outside every range
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
/// low-VRAM window, stage 1 in 139 s with a 7.2 GiB workspace, peak 12.8 GiB on the card). A range past it (open gate
/// 4096x3072 pads into h2944-3456) runs on CUDA until measured.
pub(crate) const MAX_AREA: usize = 2176 * 4096;
/// Frames per call of the foundation models (C-RADIO / MoGe) in low-VRAM mode: the low-memory foundations prepass
/// (pipeline/keying.rs) feeds them this many frames, and a low-VRAM range's engines are built for it (bucket `f`).
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
/// same window TensorRT's mattes match CUDA's within fp16 rounding, at a shorter one they don't). A job may also run
/// on a range built for a longer window (Bucket::serves); that its mattes still match CUDA's at the job's window is
/// unmeasured (review 2026-10-29 S4: one GPU check). None: outside every range, larger than MAX_SIDE, or in a range
/// larger than MAX_AREA (CUDA runs it).
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

    /// The bucket a range folder's name (`key`) stands for; None for any other name.
    pub(crate) fn from_key(name: &str) -> Option<Bucket> {
        let mut parts = name.split('_');
        let mut pair = |tag: char| -> Option<(usize, usize)> {
            let (a, b) = parts.next()?.strip_prefix(tag)?.split_once('-')?;
            Some((a.parse().ok()?, b.parse().ok()?))
        };
        let b = Bucket { h: pair('h')?, w: pair('w')?, t: pair('t')?, f: pair('f')? };
        (parts.next().is_none() && b.key() == name).then_some(b)
    }

    /// Whether this range's engines run `need`'s shapes: the same height and width ranges, and stage-1 windows and a
    /// foundation batch reaching `need`'s (an engine built for windows 1..N takes every window up to N).
    pub(crate) fn serves(&self, need: &Bucket) -> bool {
        self.h == need.h && self.w == need.w && self.t.0 <= need.t.0 && self.t.1 >= need.t.1 && self.f.0 <= need.f.0 && self.f.1 >= need.f.1
    }
}

/// Channel counts of the exported networks (scripts/onnx_spike/wrappers.py).
pub(crate) const CRADIO_CH: usize = 1152;
pub(crate) const MOGE_CH: usize = 768;
pub(crate) const RVM_CH: usize = 384;
pub(crate) const BATON_CH: usize = 512;

/// The optimisation profile of one network for a bucket: (min, opt, max) shape strings in ck-trt-build's (and
/// ORT's) format ("frame:1x3x256x384,state:..."). opt = the range's largest shape. Whether TensorRT then holds the
/// working memory of the largest shape for a job at a shorter window is unmeasured (review 2026-10-29 M1), so a job
/// takes a longer range only when that range's own window fits its budget (pipeline trt_serving).
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

/// Whether a failed build ran short of graphics memory: the card's memory ran out (another program may hold it), or
/// TensorRT found no implementation within its working memory. The background build reports those as failed, with a
/// retry (pipeline trt_build), never as built.
pub(crate) fn memory_failure(why: &str) -> bool {
    let low = why.to_lowercase();
    const MEMORY: [&str; 9] = [
        "out of memory",
        "outofmemory",
        "cudaerrormemoryallocation",
        "could not be allocated",
        "failed to allocate",
        "insufficient memory",
        "bad_alloc",
        "could not find any implementation",
        "no tactic",
    ];
    MEMORY.iter().any(|m| low.contains(m))
}

/// The stage-1 builds measured on the RTX 5080 16 GB within TensorRT's 8 GiB working-memory cap, as (the range's
/// largest height, width, window): the 4K range at t1-8 and the HD range (1280x2176) at t1-24 built and ran on
/// 2026-10-25; the 1.6 MP range (1280x1280: 1280x1080 clips) at t1-48 built on 2026-10-24 (a 6.1 GB tactic within a
/// 7 GiB working memory, pipeline trt_prepare). Longer builds are unmeasured (the 1.6 MP range at 80 frames found no
/// tactic, 2026-10-24), so no build goes past these until one is measured (reviews 2026-10-29 M2, N-M1).
pub(crate) const MEASURED_BUILDS: [(usize, usize, usize); 3] = [(2176, 4096, 8), (1280, 2176, 24), (1280, 1280, 48)];

/// The longest stage-1 window a build of `b`'s size is made for, and whether a build of that size and window was
/// measured (MEASURED_BUILDS). A measured size: its own window. Another size: the next measured size up (the smallest
/// measured range at least as large), within that build's pixels x frames, at least 1 — not measured.
pub(crate) fn build_cap(b: &Bucket) -> (usize, bool) {
    // loop: NOT-WORTH — three measured builds, once per job or build
    if let Some(&(_, _, t)) = MEASURED_BUILDS.iter().find(|m| (m.0, m.1) == (b.h.1, b.w.1)) {
        return (t, true);
    }
    let area = b.h.1 * b.w.1;
    // loop: NOT-WORTH — as above
    let up = MEASURED_BUILDS.iter().filter(|m| m.0 * m.1 >= area).min_by_key(|m| m.0 * m.1);
    // (none larger: bucket_for keeps every range within the 4K one, MAX_AREA)
    (up.map(|m| m.0 * m.1 * m.2 / area.max(1)).unwrap_or(1).max(1), false)
}

/// One engine process builds a range's engines at a time: `<range folder>/build.lock`, made with create_new (the
/// file system's own exclusive create, on every system), removed when the guard drops. Two engines (two app copies,
/// a bench next to the app) building the same range at once would each spend minutes of the card on the same
/// engines and replace each other's files.
pub(crate) struct BuildLock {
    path: PathBuf,
}

/// Whether a build lock's holder (the pid it holds) has ended: false when that can't be told (no pid, or `alive`
/// is unsure and says alive), so only the lock's age decides there.
pub(crate) fn lock_holder_gone(text: &str, alive: impl Fn(u32) -> bool) -> bool {
    text.trim().parse::<u32>().ok().is_some_and(|p| !alive(p))
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
            // the app ends its background build by killing that engine: its lock then names a process that is gone
            let gone = std::fs::read_to_string(&path).is_ok_and(|t| lock_holder_gone(&t, crate::proc::pid_alive));
            if gone || age.is_some_and(|a| a > stale_after) || std::time::Instant::now() >= end {
                // gone stale, or past the deadline: take it over (a removal that loses a race just loops again); one
                // that can't be removed (a read-only folder) fails the build and says why, instead of spinning
                match std::fs::remove_file(&path) {
                    Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
                    _ => {}
                }
                // loop: SERIAL-REQUIRED — a poll's sleep after a take-over too, so a lock that comes back isn't spun on
                std::thread::sleep(LOCK_POLL);
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

/// A card folder not used for this long (no TensorRT job or build of this card and versions) is removed.
pub(crate) const UNUSED_FOR: std::time::Duration = std::time::Duration::from_secs(30 * 24 * 3600);

/// `<card folder>/last-used`: its modification time is when a TensorRT job or build last used the folder.
const LAST_USED: &str = "last-used";

/// Note that a job or build uses `card_dir` now (so another install's `stale_dirs` keeps it).
pub(crate) fn mark_used(card_dir: &Path) {
    let _ = std::fs::create_dir_all(card_dir);
    let _ = std::fs::write(card_dir.join(LAST_USED), b"");
}

/// Why a card folder is removed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stale {
    /// built under a graphics driver that is no longer installed: its engines can never load again
    Driver,
    /// built for another TensorRT or ONNX Runtime and not used for UNUSED_FOR
    Unused,
}

/// Cache folders of the same card that can go: those built under another graphics driver than the installed
/// `driver` (TensorRT engines are tied to it), and those of the same driver and another TensorRT or ONNX Runtime not
/// used for UNUSED_FOR. A folder that differs only by TensorRT or ONNX Runtime may belong to another installed copy
/// (a stable app beside a dev build, a separately installed `corridorkey`), so it costs disk, not a rebuild, while
/// it is in use (final review 2026-10-28 S2: every job deleted the other copy's engines). A folder with a range
/// whose `build.lock` names a running process (`alive`) is never removed.
pub(crate) fn stale_dirs(
    root: &Path,
    current: &Path,
    gpu: &str,
    driver: &str,
    now: std::time::SystemTime,
    alive: impl Fn(u32) -> bool,
) -> Vec<(PathBuf, Stale)> {
    let prefix = format!("{}__", slug(gpu));
    let Ok(rd) = std::fs::read_dir(root) else { return vec![] };
    let mut v: Vec<(PathBuf, Stale)> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && p != current)
        .filter_map(|p| {
            let name = p.file_name()?.to_string_lossy().into_owned();
            let rest = name.strip_prefix(&prefix)?;
            let its_driver = rest.strip_prefix("drv").and_then(|r| r.split("__trt").next());
            let why = if its_driver != Some(driver) {
                Stale::Driver
            } else {
                let used = std::fs::metadata(p.join(LAST_USED)).or_else(|_| std::fs::metadata(&p)).and_then(|m| m.modified()).ok()?;
                if now.duration_since(used).unwrap_or_default() < UNUSED_FOR {
                    return None;
                }
                Stale::Unused
            };
            (!building(&p, &alive)).then_some((p, why))
        })
        .collect();
    v.sort_by(|a, b| a.0.cmp(&b.0));
    v
}

/// Whether a range folder in `card_dir` holds a `build.lock` whose engine still runs.
fn building(card_dir: &Path, alive: &impl Fn(u32) -> bool) -> bool {
    let Ok(rd) = std::fs::read_dir(card_dir) else { return false };
    // loop: NOT-WORTH — the few range folders of one card folder
    rd.flatten().any(|e| std::fs::read_to_string(e.path().join("build.lock")).is_ok_and(|t| !lock_holder_gone(&t, alive)))
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
    fn a_killed_builders_lock_is_taken_over() {
        // the app kills its background build's engine (pause, cancel): the lock it left names a pid that is gone
        assert!(lock_holder_gone("4242\n", |_| false));
        assert!(!lock_holder_gone("4242\n", |_| true));
        // no pid: only the lock's age decides
        assert!(!lock_holder_gone("", |_| false));
    }

    #[test]
    fn a_dead_holders_lock_is_taken_over_at_once_on_every_system() {
        // senior review 2026-10-28 S1: off Linux the dead holder went unseen, so the lock blocked the range until it
        // aged out (build timeout + 120 s, ~32 min). A real pid that has ended, with stale/deadline far away.
        use std::time::{Duration, Instant};
        let dir = std::env::temp_dir().join(format!("ck-trt-lock-dead-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut child =
            if cfg!(windows) { std::process::Command::new("cmd").args(["/C", "exit 0"]).spawn() } else { std::process::Command::new("true").spawn() }.unwrap();
        let pid = child.id();
        // loop: NOT-WORTH — reaps a child that exits at once [bounded: it runs nothing]
        child.wait().unwrap();
        std::fs::write(dir.join("build.lock"), format!("{pid}\n")).unwrap();
        let long = Duration::from_secs(600);
        let t = Instant::now();
        let (l, waited) = BuildLock::acquire(&dir, long, long, || {}).unwrap();
        assert!(!waited && t.elapsed() < Duration::from_secs(5), "waited {:?}", t.elapsed());
        drop(l);
        let _ = std::fs::remove_dir_all(&dir);
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
        let now = std::time::SystemTime::now();
        assert_eq!(stale_dirs(&root, &cur, "NVIDIA GeForce RTX 5080", "615.71", now, |_| false), vec![(old.clone(), Stale::Driver)]);
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
    fn source_stamp_is_bytes_and_whole_seconds() {
        // the app reads the same stamp to say a range is built (electron/main/trtPrebuild.ts sourceStamp; its test pins
        // these two strings): bytes and the modified time floored to seconds, the .onnx then its .onnx.data
        let dir = std::env::temp_dir().join(format!("ck-trt-stamp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let onnx = dir.join("x.onnx");
        std::fs::write(&onnx, b"abc").unwrap();
        let at = std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_792_943_067_900);
        std::fs::File::options().write(true).open(&onnx).unwrap().set_modified(at).unwrap();
        assert_eq!(source_stamp(&onnx), "3:1792943067,-");
        let data = dir.join("x.onnx.data");
        std::fs::write(&data, b"hello").unwrap();
        std::fs::File::options().write(true).open(&data).unwrap().set_modified(at).unwrap();
        assert_eq!(source_stamp(&onnx), "3:1792943067,5:1792943067");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn another_installed_versions_engines_are_kept() {
        // final review 2026-10-28 S2: a stable app and a dev build (or the CLI) with other ORT / TensorRT versions share
        // the cache root; each job deleted the other's engines
        let root = std::env::temp_dir().join(format!("ck-trt-keep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let gpu = "NVIDIA GeForce RTX 5080";
        let cur = cache_dir(&root, gpu, "615.71", "10.16.0", "1.31.0", "fp16");
        let other_ort = cache_dir(&root, gpu, "615.71", "10.16.0", "1.30.0", "fp16");
        let other_trt = cache_dir(&root, gpu, "615.71", "10.15.0", "1.31.0", "fp16");
        let old_driver = cache_dir(&root, gpu, "610.10", "10.16.0", "1.31.0", "fp16");
        let building_old_driver = cache_dir(&root, gpu, "600.01", "10.16.0", "1.31.0", "fp16");
        // loop: NOT-WORTH — five folders
        for d in [&cur, &other_ort, &other_trt, &old_driver, &building_old_driver] {
            std::fs::create_dir_all(d).unwrap();
        }
        mark_used(&other_ort);
        mark_used(&other_trt);
        std::fs::create_dir_all(building_old_driver.join("h640-896_w1024-1280_t1-80_f1-4")).unwrap();
        std::fs::write(building_old_driver.join("h640-896_w1024-1280_t1-80_f1-4").join("build.lock"), "4242\n").unwrap();
        let now = std::time::SystemTime::now();
        // used lately: kept; another driver: removed, unless its build lock's engine runs
        assert_eq!(stale_dirs(&root, &cur, gpu, "615.71", now, |p| p == 4242), vec![(old_driver.clone(), Stale::Driver)]);
        // that engine gone: removed too
        assert_eq!(
            stale_dirs(&root, &cur, gpu, "615.71", now, |_| false),
            vec![(building_old_driver.clone(), Stale::Driver), (old_driver.clone(), Stale::Driver)]
        );
        // unused for UNUSED_FOR: the other versions' folders go as well
        let later = now + UNUSED_FOR + std::time::Duration::from_secs(60);
        assert_eq!(
            stale_dirs(&root, &cur, gpu, "615.71", later, |p| p == 4242),
            vec![(old_driver.clone(), Stale::Driver), (other_trt.clone(), Stale::Unused), (other_ort.clone(), Stale::Unused)]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_build_short_of_memory_is_told_apart() {
        // review 2026-10-29 M2: the background build reports these as failed (with a retry), never as built
        // loop: NOT-WORTH — a test's few messages
        for why in [
            "build: Error Code 2: OutOfMemory (Requested size was 6442450944 bytes.)",
            "build: Requested amount of GPU memory (7000000000 bytes) could not be allocated",
            "build: [optimizer.cpp::computeCosts] Error Code 10: Internal Error (Could not find any implementation for node /blocks/MatMul.)",
        ] {
            assert!(memory_failure(why), "{why}");
        }
        // loop: NOT-WORTH — a test's few messages
        for why in [
            "parse: Unsupported ONNX data type: UINT8 (2)",
            "no TensorRT-ready export of stage1 in the models folder",
            "ck-trt-build: no answer within 1800 s; stopped",
        ] {
            assert!(!memory_failure(why), "{why}");
        }
    }

    #[test]
    fn a_build_stops_at_the_measured_window_of_its_size() {
        // review 2026-10-29 N-M1: each measured size its own measured window (no frame-area interpolation: HD is 24,
        // not 25), so 1280x1080 builds the 48 frames measured on 2026-10-24
        let cap = |h, w| build_cap(&bucket_for(h, w, 1, true).unwrap());
        assert_eq!(cap(2176, 4096), (8, true), "4K");
        assert_eq!(cap(1152, 1920), (24, true), "HD");
        assert_eq!(cap(1152, 1280), (48, true), "1280x1080");
        // other sizes: the next measured size up, within its pixels x frames, and said to be unmeasured
        assert_eq!(cap(1536, 2560), (2176 * 4096 * 8 / (1664 * 2816), false), "1440p, from 4K");
        assert_eq!(cap(768, 1280), (1280 * 1280 * 48 / (896 * 1280), false), "720p, from 1280x1080");
        assert!(cap(2176, 3840).1, "UHD is in the 4K range");
        assert_eq!(cap(2176, 1152), (1280 * 2176 * 24 / (2176 * 1280), false), "portrait HD: another range");
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

    #[cfg(unix)]
    #[test]
    fn a_lock_that_cant_be_taken_over_is_an_error_not_a_spin() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::Duration;
        let dir = std::env::temp_dir().join(format!("ck-trt-lock-ro-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("build.lock"), "999999\n").unwrap();
        std::thread::sleep(Duration::from_millis(50));
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        // root ignores the folder's mode: nothing to test there
        if std::fs::remove_file(dir.join("build.lock")).is_ok() {
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755));
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let d2 = dir.clone();
        // loop: NOT-WORTH — one test thread; the old code spun in it forever, the recv below has a deadline
        std::thread::spawn(move || {
            let _ = tx.send(BuildLock::acquire(&d2, Duration::from_millis(10), Duration::from_secs(30), || {}).map(|_| ()));
        });
        // loop: NOT-WORTH — waits for that thread [bounded: 5 s]
        let got = rx.recv_timeout(Duration::from_secs(5));
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755));
        let _ = std::fs::remove_dir_all(&dir);
        let err = got.expect("acquire returned").expect_err("a lock in a read-only folder can't be taken");
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn the_builder_has_the_systems_program_name() {
        let n = builder_name();
        assert!(n.starts_with("ck-trt-build"));
        assert_eq!(n.ends_with(".exe"), cfg!(windows));
    }
}
