//! One job, end to end (runtime.run_inference and hann_stage1_stream, the non-low-VRAM and the staged
//! low-VRAM paths):
//!  1. probe the clip, pick the Hann window (automatic from free graphics memory, or the job's);
//!  2. RVM prepass: one recurrent step per frame over the whole clip, features kept as float16 in temp_dir;
//!  3. stage 1 on overlapping windows (C-RADIO and MoGe features per window, hint / carry hint / first-frame
//!     hint), the hidden states blended with the taper weights;
//!  4. stage 2 per frame as soon as its blended state is final, rendered and handed to the writers.
//!
//! Low-VRAM mode stages it: foundations first (to temp_dir), then stage 1 (states to temp_dir), then
//! stage 2, with only that phase's networks loaded.
//!
//! This module: the job's setup (probe, window, provider, TensorRT engines, writers, settings file), the
//! out-of-memory retry (`attempts`) and the networks' loading. The passes of steps 2-4 are in keying.rs, the seam
//! to ONNX Runtime in network.rs, where the frames come from in frames.rs, the temporary files in temps.rs.
mod frames;
mod keying;
pub mod network;
mod temps;

use crate::clip::{probe_frame_dir, probe_video, raw_clip_name, Source};
use crate::config::ArenaShrink;
use crate::job::{suffix, JobConfig};
use crate::outputs::Writers;
use crate::runtime::{ModelSet, Precision, Provider, Runtime, TrtSettings};
use crate::vram::{estimate_peak_vram_gb, select_vram_profile};
use crate::writers::{ExrType, ExrWriter, VideoWriter, Writer};
use crate::Error;
use keying::{JobCtx, JobPlan};
use network::{Loader, Network, OrtLoader};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Where replies go (the engine adds "id"). Every message is a protocol reply object with its "type".
pub trait Sink {
    fn send(&mut self, msg: Value);
    /// A model print: a `log` reply (and a copy on stderr).
    fn log(&mut self, text: &str) {
        eprintln!("{text}");
        self.send(json!({"type": "log", "text": text}));
    }
    /// Whether the job should stop now (`corridorkey render` on SIGTERM / SIGINT; the app kills the engine instead).
    /// Asked before each RVM step, foundation chunk, stage-1 window and stage-2 frame: the job then ends `cancelled`,
    /// its temporary files removed, the frames already written left whole.
    fn stop_requested(&mut self) -> bool {
        false
    }
}

pub(crate) const FRAMES_EVERY_S: f64 = 0.25;

/// `frames` replies: frames handed to every writer (the slowest), at most 4 per second plus the last.
struct FrameReport {
    total: usize,
    last_sent: Option<Instant>,
    last_done: Option<usize>,
}

impl FrameReport {
    fn report(&mut self, writers: &[(String, Box<dyn Writer>)], sink: &mut dyn Sink, force: bool) {
        let done = writers.iter().map(|(_, w)| w.frames()).min().unwrap_or(0);
        self.count(done, sink, force);
    }

    /// `done`: frames every writer has taken (the render thread's count).
    fn count(&mut self, done: usize, sink: &mut dyn Sink, force: bool) {
        if self.last_done == Some(done) {
            return;
        }
        let now = Instant::now();
        if !force && done < self.total && self.last_sent.is_some_and(|t| now.duration_since(t).as_secs_f64() < FRAMES_EVERY_S) {
            return;
        }
        self.last_sent = Some(now);
        self.last_done = Some(done);
        sink.send(json!({"type": "frames", "done": done, "total": self.total}));
    }
}

/// The loaded networks and what they were loaded for.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ModelKey {
    pub(crate) provider: Provider,
    pub(crate) precision: Precision,
    /// TensorRT: the shape range's cache folder
    pub(crate) trt_cache: Option<PathBuf>,
    /// the job's graphics memory budget (bytes): each session's arena limit
    pub(crate) vram_cap: Option<u64>,
    /// Core ML: the fixed-shape files this job's size and window take (`coreml_key`)
    pub(crate) coreml: Option<CoremlFiles>,
}

/// The Core ML set's files for one job: one per network, built for the job's padded size and frames per call.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct CoremlFiles {
    pub(crate) files: BTreeMap<&'static str, PathBuf>,
    /// frames per C-RADIO / MoGe call the files take: a shorter call (the low-memory prepass's last chunk) is
    /// padded with copies of its last frame, and only its own frames' features are kept (each frame is its own
    /// batch item: the copies don't change them)
    pub(crate) foundation_batch: usize,
    /// the runtime's Core ML compute units and cache root (for the `provider` reply)
    pub(crate) units: &'static str,
    pub(crate) cache: PathBuf,
}

/// A network loading ahead on its own thread: (network, the key it is for, the load: the network and its seconds).
type PendingLoad<N> = (&'static str, ModelKey, std::thread::JoinHandle<Result<(N, f64), Error>>);

/// One network's measured totals in this job, kept across low-VRAM unloads (its `NetCounters` folded in).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct NetTotals {
    pub(crate) run_s: f64,
    pub(crate) convert_s: f64,
    pub(crate) calls: usize,
    /// seconds of the first calls (each session's first run after a fold)
    pub(crate) first_s: f64,
}

/// One job at a time, end to end. `L` loads the networks: ONNX Runtime sessions in the engine (`OrtLoader`, the
/// default), fakes in the tests.
pub struct Pipeline<L: Loader = OrtLoader> {
    loader: L,
    pub models: ModelSet,
    /// CK_ENGINE_ARENA_SHRINK, read once at startup (the runtime's settings)
    arena_shrink: ArenaShrink,
    key: Option<ModelKey>,
    nets: HashMap<&'static str, L::Net>,
    /// TensorRT jobs: networks TensorRT could not build, and why (they run on CUDA)
    trt_fallbacks: BTreeMap<&'static str, String>,
    /// TensorRT jobs: seconds each network took to build its engine (built in this job) or to load it (reused)
    trt_seconds: BTreeMap<&'static str, (f64, bool)>,
    /// measured once per process: graphics memory the CUDA context and libraries take (bytes), outside any arena
    gpu_overhead: Option<u64>,
    /// this job's measured seconds per network, kept across low-VRAM unloads
    stats: BTreeMap<&'static str, NetTotals>,
    /// this job's seconds spent loading sessions, in all and per network
    load_s: f64,
    load_each: BTreeMap<&'static str, f64>,
    /// low-VRAM phases: the next phase's networks loading on their own thread while this phase runs, with the
    /// key they are for; `ensure` takes them (waiting if they aren't done)
    pending: Vec<PendingLoad<L::Net>>,
    /// this job's seconds of session loads done ahead on their own thread
    preload_s: f64,
    /// this job's main-thread seconds around stage 2: [inputs, waiting for the render thread]
    s2_host: [f64; 2],
    /// TensorRT jobs: the number of fallbacks the last `provider` reply carried (None: none sent yet), so a later
    /// low-VRAM phase whose network falls back to CUDA sends it again
    trt_reported: Option<usize>,
}

pub struct JobResult {
    pub outputs: Vec<String>,
    pub settings_file: String,
}

fn f1(v: f64) -> String {
    format!("{v:.1}")
}

/// A TensorRT range for one job: its bucket, the card's cache folder, the range's folder, and whether it is built.
struct TrtRange {
    bucket: crate::tensorrt::Bucket,
    card_dir: PathBuf,
    dir: PathBuf,
    built: bool,
}

/// The `fallback_reason` of a `tensorrt_build: false` job whose range isn't built yet.
pub(crate) const TRT_NOT_BUILT: &str = "TensorRT for this resolution range isn't built yet";

/// The `fallback_reason` of a `tensorrt_build: false` job whose size is built, but for other windows than the one the
/// job picked (a range is used only at its own window, so the mattes match CUDA's; bug hunt 2026-10-26 T1).
fn trt_other_window(built: &[usize], window: usize) -> String {
    // loop: NOT-WORTH — a few built windows, once per job
    let w: Vec<String> = built.iter().map(|t| t.to_string()).collect();
    format!("TensorRT for this resolution is built for a window of {} frames; this job's automatic window is {window}", w.join(" or "))
}

/// The windows of `b`'s size (same height and width ranges) that the range folders `names` hold for another window
/// than `b`'s, where `built` says the folder is built; sorted, once each.
fn other_windows(b: &crate::tensorrt::Bucket, names: &[String], built: impl Fn(&str) -> bool) -> Vec<usize> {
    let prefix = format!("h{}-{}_w{}-{}_t1-", b.h.0, b.h.1, b.w.0, b.w.1);
    // loop: NOT-WORTH — the few range folders of one card, once per job
    let mut out: Vec<usize> = names
        .iter()
        .filter_map(|name| {
            // loop: NOT-WORTH — splits one short folder name
            let t: usize = name.strip_prefix(&prefix)?.split('_').next()?.parse().ok()?;
            (t != b.t.1 && built(name)).then_some(t)
        })
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

/// A PNG file's bit depth from its header (IHDR's depth byte), None for anything else or an unreadable file.
fn png_bit_depth(path: &Path) -> Option<u8> {
    use std::io::Read;
    let mut head = [0u8; 25];
    // loop: NOT-WORTH — 25 bytes of one local file, once per job [bounded: a local read]
    std::fs::File::open(path).ok()?.read_exact(&mut head).ok()?;
    (head[..8] == *b"\x89PNG\r\n\x1a\n" && head[12..16] == *b"IHDR").then_some(head[24])
}

/// Whether a TensorRT job may use its range: a built one always; one not built yet only when the job may build it
/// (`tensorrt_build`), else Err with the reason it runs on CUDA.
fn trt_job_may_use(r: TrtRange, may_build: bool) -> Result<TrtRange, String> {
    if r.built || may_build {
        Ok(r)
    } else {
        Err(TRT_NOT_BUILT.to_string())
    }
}

/// The job's colour management (backlog row 29, ocio.rs), checked before anything loads: None when the job sets no
/// colour space (today's behaviour, no config read). Phase 1 takes EXR and image sequences only: a colour space on
/// a video input is refused (its YCbCr matrix and range must be decoded as tagged first, the study §1).
pub(crate) fn color_setup(job: &JobConfig, is_dir: bool, sink: &mut dyn Sink) -> Result<Option<crate::ocio::ColorJob>, Error> {
    if !is_dir && job.input_colorspace.is_some() {
        return Err(Error::bad_request(
            "input_colorspace is set for a video: colour-managed video input comes in the next version. For now, give the plate as an EXR or 16-bit image sequence (or key the video without a colour space).".into(),
        ));
    }
    let env = crate::ocio::env_ocio();
    let color = crate::ocio::color_job(job.color_config.as_deref(), env.as_deref(), job.input_colorspace.as_deref(), job.output_colorspace.as_deref())?;
    if let Some(c) = &color {
        sink.log(&format!(
            "  colour: OCIO {} config {} ({}), input {}, output {}, {}",
            c.ocio_version,
            c.config_name,
            c.config_source.as_str(),
            c.input_space.as_deref().unwrap_or("as CorridorKey 2.0"),
            c.output_space.as_deref().unwrap_or(crate::ocio::MODEL_SPACE),
            crate::ocio::OPTIMIZATION
        ));
        if !job.exr && c.output_space.is_some() {
            sink.log(&format!(
                "  colour: the output colour space ({}) applies to EXR outputs only; these video outputs stay display sRGB / Rec.709",
                c.output_space.as_deref().unwrap_or_default()
            ));
        }
    }
    Ok(color)
}

impl Pipeline<OrtLoader> {
    /// The engine's pipeline: ONNX Runtime sessions in the process's runtime `rt`.
    pub fn new(rt: &'static Runtime, models: ModelSet) -> Pipeline {
        Pipeline::with_loader(OrtLoader { rt }, models, rt.cfg.arena_shrink.clone())
    }

    /// The process's runtime (its settings, provider and card).
    pub fn rt(&self) -> &'static Runtime {
        self.loader.rt
    }
}

impl<L: Loader> Pipeline<L> {
    pub(crate) fn with_loader(loader: L, models: ModelSet, arena_shrink: ArenaShrink) -> Pipeline<L> {
        Pipeline {
            loader,
            models,
            arena_shrink,
            key: None,
            nets: HashMap::new(),
            trt_fallbacks: BTreeMap::new(),
            trt_seconds: BTreeMap::new(),
            gpu_overhead: None,
            stats: BTreeMap::new(),
            load_s: 0.0,
            load_each: BTreeMap::new(),
            pending: Vec::new(),
            preload_s: 0.0,
            s2_host: [0.0; 2],
            trt_reported: None,
        }
    }

    /// Drop every loaded network (frees the graphics memory their sessions hold), and give the host memory
    /// their loading used back to the system.
    pub(crate) fn unload(&mut self) {
        self.fold_stats();
        let had = !self.nets.is_empty();
        self.nets.clear();
        self.key = None;
        if had {
            trim_host_memory();
        }
    }

    /// Move the loaded networks' counters into `stats` (and zero them).
    fn fold_stats(&mut self) {
        for (p, n) in self.nets.iter_mut() {
            let e = self.stats.entry(*p).or_default();
            let c = n.counters();
            e.run_s += c.run_s;
            e.convert_s += c.convert_s;
            e.calls += c.calls;
            if c.calls > 0 {
                e.first_s += c.first_s.take().unwrap_or(0.0);
            }
            c.run_s = 0.0;
            c.convert_s = 0.0;
            c.calls = 0;
        }
    }

    /// Make sure `pieces` are loaded for `key` (anything loaded for another key is dropped first).
    fn ensure(
        &mut self,
        key: &ModelKey,
        pieces: &[&'static str],
        trt: Option<&dyn Fn(&str) -> TrtSettings>,
        sink: &mut dyn Sink,
        job_stage: &str,
    ) -> Result<(), Error> {
        if self.key.as_ref() != Some(key) {
            self.nets.clear();
            self.key = Some(key.clone());
        }
        // loop: NOT-WORTH — ≤ five networks per phase
        let need: Vec<&'static str> = pieces.iter().copied().filter(|p| !self.nets.contains_key(p)).collect();
        if need.is_empty() {
            return Ok(());
        }
        sink.send(json!({"type": "progress", "stage": job_stage}));
        // loop: NOT-WORTH — at most five networks
        for piece in need {
            // loop: NOT-WORTH — ≤ two pending loads
            if let Some(i) = self.pending.iter().position(|(p, k, _)| *p == piece && k == key) {
                // loaded ahead (or still loading): wait for it here
                let (_, _, h) = self.pending.remove(i);
                let t = Instant::now();
                // loop: SERIAL-REQUIRED — takes a network loaded ahead; waits only for the part not yet done [bounded: ORT session creation ends (succeeds or fails)]
                let (net, secs) = crate::ahead::joined(h)??;
                self.load_s += t.elapsed().as_secs_f64();
                *self.load_each.entry(piece).or_insert(0.0) += t.elapsed().as_secs_f64();
                self.preload_s += secs;
                self.nets.insert(piece, net);
                self.set_shrink();
                continue;
            }
            let file = match &key.coreml {
                Some(c) => c.files.get(piece).cloned().ok_or_else(|| Error::assets(format!("no Core ML model for {piece} in this job's set")))?,
                None => self
                    .models
                    .file(piece, key.precision)
                    .ok_or_else(|| Error::assets(format!("missing ONNX model {piece} ({}) in {}", key.precision.name(), self.models.dir.display())))?,
            };
            let t = Instant::now();
            let settings = trt.map(|f| f(piece));
            let cap = self.arena_limit(key, piece);
            let net = if key.provider == Provider::TensorRt {
                // the engine trt_prepare built (or found); a network without one runs on CUDA with the normal file
                // (the same precision), and the `provider` reply says why
                let tried = match (self.trt_fallbacks.get(piece), settings.as_ref()) {
                    (Some(why), _) => Err(why.clone()),
                    (None, Some(st)) => {
                        self.loader
                            .load(piece, Provider::TensorRt, &crate::tensorrt::stub_path(&st.dir, piece), cap)
                            // loop: NOT-WORTH — first line of an error message
                            .map_err(|e| format!("loading its engine: {}", e.message.lines().next().unwrap_or("")))
                    }
                    (None, None) => Err("no TensorRT folder".to_string()),
                };
                match tried {
                    Ok(n) => n,
                    Err(why) => {
                        if !self.trt_fallbacks.contains_key(piece) {
                            sink.log(&format!("  TensorRT could not run {piece}; it runs on CUDA: {why}"));
                            self.trt_fallbacks.insert(piece, why);
                        }
                        self.loader.load(piece, Provider::Cuda, &file, cap)?
                    }
                }
            } else {
                self.loader.load(piece, key.provider, &file, cap)?
            };
            eprintln!(
                "  loaded {piece} ({}, {}) in {:.1} s, arena limit {}: {}",
                net.provider().name(),
                key.precision.name(),
                t.elapsed().as_secs_f64(),
                cap.map(|c| format!("{:.2} GiB", c as f64 / 1073741824.0)).unwrap_or_else(|| "none".into()),
                file.display()
            );
            self.load_s += t.elapsed().as_secs_f64();
            *self.load_each.entry(piece).or_insert(0.0) += t.elapsed().as_secs_f64();
            self.nets.insert(piece, net);
            self.set_shrink();
            if self.gpu_overhead.is_none() && key.vram_cap.is_some() {
                // the first session made the CUDA context: what this process holds beyond its weights
                if let Some((_, _, own)) = crate::gpu::budget() {
                    let w = crate::runtime::model_bytes(&file);
                    self.gpu_overhead = Some(own.saturating_sub(w));
                    eprintln!(
                        "  graphics memory outside the arenas (CUDA context, libraries): {:.2} GiB measured",
                        own.saturating_sub(w) as f64 / 1073741824.0
                    );
                }
            }
        }
        if key.provider == Provider::CoreMl {
            self.send_coreml_provider(key, sink);
        }
        // a later low-VRAM phase's network fell back to CUDA: the `provider` reply sent after the first phase said
        // "tensorrt" with no fallbacks (measured: a broken stage-1 engine ran on CUDA, the only reply said TensorRT)
        if key.provider == Provider::TensorRt && self.trt_reported.is_some_and(|n| n != self.trt_fallbacks.len()) {
            self.send_trt_provider(sink);
        }
        Ok(())
    }

    /// Core ML jobs: the `provider` reply once sessions exist. A Core ML session is made with ONNX Runtime's CPU
    /// fallback switched off, so each loaded network runs every node on Core ML (ORT doesn't say how many partitions
    /// it made: the study measured one per network; reported as unknown here).
    fn send_coreml_provider(&self, key: &ModelKey, sink: &mut dyn Sink) {
        // loop: NOT-WORTH — ≤ five networks, once per load phase
        let pieces: BTreeMap<&str, &str> = self.nets.iter().map(|(k, n)| (*k, n.provider().name())).collect();
        let cm = key.coreml.as_ref();
        let files: BTreeMap<&str, String> = cm
            .map(|c| {
                c.files
                    // loop: NOT-WORTH — ≤ five files
                    .iter()
                    .filter(|(p, _)| pieces.contains_key(*p))
                    .map(|(p, f)| (*p, f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()))
                    .collect()
            })
            .unwrap_or_default();
        sink.send(json!({
            "type": "provider", "provider": "coreml", "precision": key.precision.name(), "pieces": pieces,
            "coreml": {"files": files, "nodes": "all", "partitions": null, "compute_units": cm.map(|c| c.units),
                       "model_format": "MLProgram", "cpu_fallback": false, "cache": cm.map(|c| c.cache.to_string_lossy().into_owned())}
        }));
    }

    /// Core ML jobs: the set's files for padded size `shape`, `tc` frames per stage-1 window and the foundations'
    /// batch (4 in low-memory mode, the prepass's chunk; else the window). Err (bad-request): the set doesn't have
    /// that size or window, or the job asks for fp32 (the Core ML set is fp16).
    fn coreml_key(
        &self,
        base: &ModelKey,
        shape: (usize, usize),
        tc: usize,
        low_vram: bool,
        cfg: &crate::config::EngineConfig,
        sink: &mut dyn Sink,
    ) -> Result<ModelKey, Error> {
        if base.precision != Precision::Fp16 {
            return Err(Error::input("--device coreml: the Core ML model set is fp16 (CK_ENGINE_PRECISION=fp32 can't run on it)".into()));
        }
        let fb = if low_vram { crate::tensorrt::FOUNDATION_CHUNK } else { tc };
        let mut files = BTreeMap::new();
        // loop: NOT-WORTH — five networks, once per job
        for (piece, t) in [("rvm", 1), ("cradio", fb), ("moge", fb), ("stage1", tc), ("stage2", 1)] {
            let f = self.models.coreml_file(piece, shape, t).map_err(Error::input)?;
            files.insert(piece, f);
        }
        sink.log(&format!(
            "  Core ML: the set's files for {}x{} (padded), stage 1 at {tc} frames per window, C-RADIO / MoGe at {fb} per call, compute units {}",
            shape.1,
            shape.0,
            cfg.coreml_units.name()
        ));
        let cm = CoremlFiles { files, foundation_batch: fb, units: cfg.coreml_units.name(), cache: cfg.coreml_cache.clone() };
        Ok(ModelKey { coreml: Some(cm), ..base.clone() })
    }

    /// Low-VRAM mode: start loading `pieces` (the next phase's networks) on their own thread while the current
    /// phase runs; `ensure` takes them. Their memory is within the job's budget by construction: every session's
    /// arena limit already leaves room for all the other networks' weights (`arena_limit`). Measured per load
    /// (RTX 5080, fp16): C-RADIO 0.75 s, MoGe 0.11 s, stage 1 1.7 s, stage 2 0.55 s.
    fn preload(&mut self, key: &ModelKey, pieces: &[&'static str]) {
        // CUDA only: TensorRT jobs don't stage, and on the CPU provider (tests) a session loaded on another thread
        // left its host memory in that thread's malloc arena (measured: the CPU end-to-end run went from 5.3 GB
        // to past its 8 GB cap)
        if key.provider != Provider::Cuda {
            return;
        }
        // loop: NOT-WORTH — at most two networks
        for &piece in pieces {
            // loop: NOT-WORTH — ≤ two pending loads
            if self.nets.contains_key(piece) || self.pending.iter().any(|(p, k, _)| *p == piece && k == key) {
                continue;
            }
            let Some(file) = self.models.file(piece, key.precision) else { continue };
            let cap = self.arena_limit(key, piece);
            let (loader, prov, prec) = (self.loader.clone(), key.provider, key.precision);
            // loop: PARALLELIZE — the next low-VRAM phase's network loads while this phase runs (measured: 1.3-1.5 s less per job)
            let started = crate::ahead::spawn_named(&format!("load-{piece}"), move || {
                let t = Instant::now();
                let net = loader.load(piece, prov, &file, cap)?;
                eprintln!("  loaded {piece} ahead ({}, {}) in {:.1} s on its own thread", prov.name(), prec.name(), t.elapsed().as_secs_f64());
                Ok((net, t.elapsed().as_secs_f64()))
            });
            // a load that couldn't start ahead is made when its phase comes (`ensure`)
            if let Ok(h) = started {
                self.pending.push((piece, key.clone(), h));
            }
        }
    }

    /// After a job panicked (the engine caught it): drop the loads started ahead and every loaded network, and the
    /// TensorRT job state, so the next job loads what it needs from scratch instead of reusing what the panic left
    /// half-made.
    pub fn reset(&mut self) {
        self.drop_pending();
        self.unload();
        self.trt_fallbacks.clear();
        self.trt_seconds.clear();
        self.trt_reported = None;
    }

    /// Drop loads started ahead (a job ends or restarts).
    fn drop_pending(&mut self) {
        for (_, _, h) in self.pending.drain(..) {
            // loop: NOT-WORTH — joins loads that were started ahead [bounded: ORT session creation ends]
            let _ = h.join();
        }
    }

    /// Arena shrinkage for what is loaded now (`crate::runtime::shrinks`).
    fn set_shrink(&mut self) {
        let shared = self.nets.contains_key("stage1") && self.nets.contains_key("stage2");
        let setting = &self.arena_shrink;
        for (p, n) in self.nets.iter_mut() {
            n.set_shrink(n.provider() != Provider::Cpu && crate::runtime::shrinks(p, setting, shared));
        }
    }

    /// The job's budget for one session's arena, so the whole process stays within it: the budget minus the
    /// CUDA context (measured after the first session; 0.5 GiB assumed until then), minus every other network's
    /// weights (their size on disk), minus a 0.5 GiB reserve (measured: without it the process peaked 0.17-0.22 GiB
    /// over a 12 GiB budget: memory the arenas don't account for). The arenas give their working memory back after
    /// each run.
    fn arena_limit(&self, key: &ModelKey, piece: &str) -> Option<u64> {
        let cap = key.vram_cap?;
        let others: u64 = crate::runtime::PIECES
            .iter()
            .filter(|p| **p != piece)
            .filter_map(|p| self.models.file(p, key.precision))
            .map(|f| crate::runtime::model_bytes(&f))
            .sum();
        let overhead = self.gpu_overhead.unwrap_or(512 << 20);
        Some(cap.saturating_sub(overhead).saturating_sub(others).saturating_sub(512 << 20).max(256 << 20))
    }

    fn net(&mut self, piece: &str) -> Result<&mut L::Net, Error> {
        self.nets.get_mut(piece).ok_or_else(|| Error::engine(format!("{piece} is not loaded")))
    }

    /// Steps 2-4 (`keying`) at `plan`'s window. An automatic window that runs out of graphics memory in the phase it
    /// sizes (`keying`'s `in_windows`) before any frame reached the writers is halved and the job restarted (the
    /// table the window comes from is an estimate, docs/ENGINE_RUST.md); `retried` hears each new window (the settings
    /// file). An out-of-memory anywhere else fails at once with its own cause: a smaller window doesn't change those
    /// phases (senior Rust review 2026-10-26 S2: a low-VRAM stage 2 out of memory re-ran the RVM pass, the
    /// foundations and all of stage 1 up to 7 times before failing anyway). `plan` ends as the window really used.
    fn attempts(
        &mut self,
        ctx: &JobCtx<'_>,
        plan: &mut JobPlan,
        writers: &mut Writers,
        report: &mut FrameReport,
        sink: &mut dyn Sink,
        retried: &mut dyn FnMut(&JobPlan, &mut dyn Sink),
    ) -> Result<(), Error> {
        let job = ctx.job;
        let mut res;
        // loop: SERIAL-REQUIRED — one attempt at a time [bounded: the window halves each round, and only while nothing was written: ≤ log2(80) ≈ 7 rounds]
        loop {
            let mut in_windows = false;
            res = self.keying(ctx, plan, writers, report, sink, &mut in_windows);
            // loop: NOT-WORTH — ≤ four writers, once per attempt
            let nothing_written = writers.iter().all(|(_, w)| w.frames() == 0);
            match &res {
                Err(e) if e.code == crate::ErrorCode::Oom && in_windows && !job.manual && nothing_written && plan.chunk > 1 => {
                    let (old_chunk, old_stride) = (plan.chunk, plan.stride);
                    plan.chunk = (plan.chunk / 2).max(1);
                    plan.stride = (plan.chunk / 2).max(1);
                    let (chunk, stride) = (plan.chunk, plan.stride);
                    sink.log(&format!("  out of graphics memory at window {old_chunk}/{old_stride}: retrying at {chunk}/{stride}"));
                    sink.send(json!({
                        "type": "memory", "hann_chunk": chunk, "hann_stride": stride, "low_vram": plan.low_vram, "auto": true,
                        "provider": plan.key.provider.name(), "retry_after_oom": {"hann_chunk": old_chunk, "hann_stride": old_stride, "message": e.message},
                        "budget_cap_gb": job.vram_budget_gb
                    }));
                    retried(plan, sink);
                    self.unload();
                }
                _ => break,
            }
        }
        // a load started ahead for a phase that never came (an error) is not kept
        self.drop_pending();
        res
    }
}

impl Pipeline<OrtLoader> {
    /// Run one job. Replies go to `sink` (progress, clip, memory, provider, frames, log); the result or the
    /// failure is returned for the engine to send.
    pub fn run(&mut self, job: &JobConfig, sink: &mut dyn Sink) -> Result<JobResult, Error> {
        // the engine-wide default budget (CK_ENGINE_VRAM_BUDGET_GB) for a job that sets none
        let mut job = job.clone();
        if job.vram_budget_gb.is_none() {
            job.vram_budget_gb = self.loader.rt.cfg.vram_budget_gb;
        }
        let r = self.run_job(&job, sink);
        // the job's frames, windows and writers are freed by now: give that host memory back too, not only
        // the sessions' (unload), so the next job in the queue starts from the same footprint
        trim_host_memory();
        r
    }

    fn run_job(&mut self, job: &JobConfig, sink: &mut dyn Sink) -> Result<JobResult, Error> {
        let job_t = Instant::now();
        let Some(provider) = self.loader.rt.provider() else {
            return Err(Error::no_gpu(self.loader.rt.unavailable_reason()));
        };
        let precision = self.loader.rt.precision(provider);
        let missing = self.models.missing(precision);
        if !missing.is_empty() {
            return Err(Error::assets(format!("missing ONNX model(s) {} ({}) in {}", missing.join(", "), precision.name(), self.models.dir.display())));
        }
        // ffmpeg -version once per job, 30 s deadline: it must run, and its version goes into the settings file
        let Ok(ffmpeg_version) = crate::decode::tool_version("ffmpeg") else {
            return Err(Error::assets("ffmpeg binary not found: ffmpeg. Install ffmpeg.".into()));
        };
        let decoders = crate::decode::Decoders::read(Some(ffmpeg_version));
        sink.log(&format!("  decoders: JPEG {}, ffmpeg {}, ffprobe {}", decoders.jpeg, decoders.ffmpeg, decoders.ffprobe));
        if !Path::new(&job.input).exists() {
            return Err(Error::input(format!("input not found: {}", job.input)));
        }
        let is_dir = Path::new(&job.input).is_dir();
        // colour management (backlog row 29), before any network loads: a bad config or space is a bad-request now
        let color = color_setup(job, is_dir, sink)?;
        let vram_cap = match provider {
            Provider::Cpu | Provider::CoreMl => None,
            _ => job.vram_budget_gb.map(|g| (g * 1073741824.0) as u64),
        };
        let base_key = ModelKey { provider, precision, trt_cache: None, vram_cap, coreml: None };
        // a manual normal-mode job loads the CUDA / CPU networks before the probe, as the runtime's load_model
        // (TensorRT's depend on the clip). An automatic window loads them once the window is chosen: measured, the
        // early load cost ~3 s per job when the window then came out low-VRAM (every network loaded again per
        // phase). The automatic budget is free + own memory, the same either way.
        // (Core ML: its files depend on the clip's size, so they load after the probe)
        if job.manual && !job.low_vram && !job.tensorrt && provider != Provider::CoreMl {
            self.ensure(&base_key, &crate::runtime::PIECES, None, sink, "load")?;
        }
        sink.send(json!({"type": "progress", "stage": "probe"}));
        std::fs::create_dir_all(&job.temp_dir).map_err(|e| Error::write("the temporary folder", &job.temp_dir, &e))?;
        std::fs::create_dir_all(&job.output_dir).map_err(|e| Error::write("the output folder", &job.output_dir, &e))?;
        let mut meta = if is_dir {
            probe_frame_dir(Path::new(&job.input), job.num_frames, job.frame_dir_fps, job.frame_dir_linear, job.model_scale)?
        } else {
            probe_video(Path::new(&job.input), &job.probe_opts())?
        };
        // a frame range (frame_start / frame_end / preroll / tail): only its span is decoded and keyed
        if let Some(r) = &job.frame_range {
            meta.select_range(r, job.exr, crate::clip::none_path(job.hint_first_frame.as_deref()).is_some())?;
        }
        if is_dir {
            if let Source::Frames(p) = &meta.source {
                sink.log(&format!(
                    "  probed {} frames from {} @ {}x{} (native {}x{}, fps {:.2}, exr_linear={}, pad=({}, {}, {}, {}))",
                    p.len(),
                    job.input,
                    meta.shape_w,
                    meta.shape_h,
                    meta.w,
                    meta.h,
                    meta.fps,
                    crate::settings::py_bool(meta.exr_linear),
                    meta.pad.l,
                    meta.pad.r,
                    meta.pad.t,
                    meta.pad.b
                ));
                if !job.frame_dir_linear
                    && color.as_ref().is_none_or(|c| c.input_space.is_none())
                    && p.first().is_some_and(|f| f.to_string_lossy().to_lowercase().ends_with(".exr"))
                {
                    sink.log("  [WARNING] EXR input frames are being treated as display-coded and clipped to [0, 1]. For scene-linear HDR EXR plates, pass --frame_dir_linear.");
                }
            }
        } else {
            sink.log(&format!(
                "  probed {} frames @ {}x{} (native {}x{}, fps {:.2}, start={}, pad=({}, {}, {}, {}))",
                meta.num_frames, meta.shape_w, meta.shape_h, meta.w, meta.h, meta.fps, meta.start_frame, meta.pad.l, meta.pad.r, meta.pad.t, meta.pad.b
            ));
        }
        if let (Some(r), Some(range)) = (&job.frame_range, &meta.range) {
            sink.log(&format!(
                "  frame range: writing {} ({} frames), keying {}-{} ({} warm-up frames of {} asked, {} tail frames of {} asked)",
                range.numbers.describe(),
                meta.write_range().len(),
                range.keyed.0,
                range.keyed.1,
                range.write.0,
                r.preroll,
                meta.num_frames - range.write.1,
                r.tail
            ));
        } else if job.frame_range.is_some() {
            sink.log("  frame range: the whole shot (keyed as one job)");
        }
        if meta.scaled() {
            sink.log(&format!(
                "  model scale {}: the networks run at {}x{} (Lanczos-4 in from {}x{}, back out to it)",
                crate::settings::py_float(job.model_scale),
                meta.model_w,
                meta.model_h,
                meta.w,
                meta.h
            ));
        }
        // upstream's frame-folder probe fixes the linear adjust at the identity: the frames are read as they are
        if is_dir && !job.adjust().is_identity() {
            sink.log("  linear brightness / contrast: not applied (as in the original, only video inputs take them)");
        }
        meta.exr_linear = is_dir && job.frame_dir_linear;
        // `input_bit_depth` (backlog row 27): 8 (the default) reads as CorridorKey 2.0 does; 16 keeps a deep source's bits
        meta.deep_input = job.input_bits == 16;
        if !is_dir && meta.video_bits > 8 {
            sink.log(&if meta.decode_deep() {
                format!("  input: a {}-bit video, read at 16 bits (input_bit_depth 16; differs from CorridorKey 2.0)", meta.video_bits)
            } else {
                format!("  input: a {}-bit video, read at 8 bits as CorridorKey 2.0 reads it (input_bit_depth 16 keeps every bit)", meta.video_bits)
            });
        }
        // a 16-bit PNG folder says how it is read too (bug hunt 2026-10-26 I11: the line existed for video only)
        if let crate::clip::Source::Frames(frames) = &meta.source {
            if frames.first().is_some_and(|f| png_bit_depth(f) == Some(16)) {
                sink.log(if meta.deep_input {
                    "  input: 16-bit PNG frames, read at 16 bits (input_bit_depth 16; differs from CorridorKey 2.0)"
                } else {
                    "  input: 16-bit PNG frames, read at 8 bits as CorridorKey 2.0 reads them (input_bit_depth 16 keeps every bit)"
                });
            }
        }
        // a colour-managed clip goes through its input processor instead (decode.rs prep_frame_views)
        meta.color_in = color.as_ref().and_then(|c| c.input.clone());
        let (mut chunk, mut stride, mut low_vram) = (job.hann_chunk, job.hann_stride, job.low_vram);
        // why a `tensorrt_build: false` job skips TensorRT (its range isn't built), decided with the window below
        let mut trt_skip: Option<String> = None;
        if job.manual {
            sink.send(json!({"type": "memory", "hann_chunk": chunk, "hann_stride": stride, "low_vram": low_vram, "auto": false, "provider": provider.name()}));
        }
        let mut clip_reply = json!({"type": "clip", "width": meta.w, "height": meta.h, "fps": meta.fps, "frames": meta.num_frames});
        if let Some(r) = &meta.range {
            // additive: the frames written and the frames keyed (source numbers); `frames` above counts the keyed ones
            let (a, b) = (r.numbers.numbers.first().copied(), r.numbers.numbers.last().copied());
            clip_reply["range"] = json!({"first": a, "last": b, "keyed_first": r.keyed.0, "keyed_last": r.keyed.1, "written": meta.write_range().len()});
        }
        sink.send(clip_reply);
        crate::clip::model_shape_supported(meta.shape_h, meta.shape_w, meta.model_w, meta.model_h, self.models.takes_portrait())?;
        let t_all = meta.num_frames;
        let (sh, sw) = (meta.shape_h, meta.shape_w);
        // TensorRT jobs take the same window as the CUDA path (the automatic one in low-VRAM mode, below), so the
        // mattes match (low-VRAM staging gives identical output; tensorrt.rs bucket_for); their engines are built for it
        if !job.manual && provider == Provider::CoreMl {
            // Core ML, phase 1: the window comes from the set (the smallest stage-1 window it was built for at this
            // size), low-memory mode; there is no graphics memory reading on a Mac to size it from
            let Some(&c) = self.models.coreml_batches("stage1", (sh, sw)).first() else {
                return Err(Error::input(self.models.coreml_file("stage1", (sh, sw), 1).err().unwrap_or_default()));
            };
            (chunk, stride, low_vram) = (c, (c / 2).max(1), true);
            sink.log(&format!(
                "  Core ML window: hann_chunk={chunk}, hann_stride={stride}, low_vram=True (the smallest window the Core ML set has at {sw}x{sh})"
            ));
            sink.send(json!({"type": "memory", "hann_chunk": chunk, "hann_stride": stride, "low_vram": low_vram, "auto": true, "estimate_basis": "coreml-set", "provider": provider.name()}));
        } else if !job.manual {
            // the budget the runtime's apply_auto_vram sees: free memory plus what this process holds
            let (seen, source) = match provider {
                Provider::Cpu => (crate::gpu::host_available().unwrap_or(0) as f64 / 1073741824.0, "host"),
                _ => (crate::gpu::budget().map(|b| b.0).unwrap_or(0) as f64 / 1073741824.0, "gpu"),
            };
            // the job's budget caps what the card has free
            let budget = match job.vram_budget_gb {
                Some(cap) if provider != Provider::Cpu => seen.min(cap),
                _ => seen,
            };
            // a TensorRT job keeps low-VRAM mode: the table's normal-mode peaks are CUDA's, TensorRT's are
            // unmeasured (row 41; lifted once they are). A later fallback to CUDA runs the low mode, as before.
            let mut tensorrt = job.tensorrt && provider == Provider::Cuda && self.loader.rt.tensorrt_ep;
            // `tensorrt_build: false`: a range not built yet (or one TensorRT can't take) runs exactly as a job without
            // TensorRT, CUDA's own window included, instead of building inside the job
            if tensorrt && !job.tensorrt_build {
                let p = select_vram_profile((sh, sw), t_all, budget, true);
                let why = match self.trt_range((sh, sw), p.chunk, p.low_vram) {
                    Ok(r) if r.built => None,
                    Ok(r) => {
                        let other = self.trt_built_windows(&r);
                        Some(if other.is_empty() { TRT_NOT_BUILT.to_string() } else { trt_other_window(&other, p.chunk) })
                    }
                    Err(why) => Some(why),
                };
                if let Some(why) = why {
                    sink.log(&format!("  TensorRT not used: {why}; this job runs on CUDA with CUDA's own window"));
                    trt_skip = Some(why);
                    tensorrt = false;
                }
            }
            let p = select_vram_profile((sh, sw), t_all, budget, tensorrt);
            chunk = p.chunk;
            stride = p.stride;
            low_vram = p.low_vram;
            sink.log(&format!(
                "  Auto VRAM: {} GB available at {}x{} -> hann_chunk={}, hann_stride={}, low_vram={} (estimated peak {} GB)",
                f1(budget),
                sw,
                sh,
                chunk,
                stride,
                crate::settings::py_bool(low_vram),
                f1(p.estimate_gb)
            ));
            if !p.fits(budget) {
                sink.log("  [WARNING] Even a single-frame window may not fit this GPU at this resolution. Inference may run out of memory.");
            }
            let est = estimate_peak_vram_gb((sh * sw) as f64 / 1e6, chunk.min(t_all), low_vram);
            sink.send(json!({
                "type": "memory", "hann_chunk": chunk, "hann_stride": stride, "low_vram": low_vram, "auto": true,
                "budget_gb": (budget * 100.0).round() / 100.0, "estimate_gb": (est * 100.0).round() / 100.0,
                "budget_source": source, "free_gb": (seen * 100.0).round() / 100.0, "budget_cap_gb": job.vram_budget_gb,
                "estimate_basis": "onnxruntime-cuda-measured", "provider": provider.name()
            }));
        }
        // which provider really runs this job
        let (key, trt_info) = if provider == Provider::CoreMl {
            if job.tensorrt {
                sink.log("  TensorRT was asked for: not on Core ML (ignored)");
            }
            (self.coreml_key(&base_key, (sh, sw), chunk.min(t_all), low_vram, &self.loader.rt.cfg, sink)?, None)
        } else {
            self.job_key(job, &base_key, (sh, sw), chunk, low_vram, trt_skip.as_deref(), sink)?
        };
        if key.provider == Provider::TensorRt {
            if trt_info.as_ref().is_some_and(|i| !i.1) {
                sink.log("  TensorRT: optimizing for this resolution range (a one-time build; later clips in this range reuse it)");
            }
            let bucket = crate::tensorrt::bucket_for(sh, sw, chunk, low_vram).ok_or_else(|| Error::engine("no TensorRT range".into()))?;
            self.trt_prepare(&key, &bucket, sink)?;
        }
        let trt_dir = key.trt_cache.clone();
        let trt_fn = trt_dir.as_ref().map(|dir| {
            let dir = dir.clone();
            move |piece: &str| -> TrtSettings { TrtSettings { dir: dir.join(piece) } }
        });
        let trt_ref: Option<&dyn Fn(&str) -> TrtSettings> = trt_fn.as_ref().map(|f| f as &dyn Fn(&str) -> TrtSettings);

        let clip = raw_clip_name(&job.input);
        let (h, w) = (meta.h, meta.w);
        let fps = meta.fps;
        let mut writers: Vec<(String, Box<dyn Writer>)> = Vec::new();
        // EXR frames carry the source's frame numbers (a frame folder's own, else 1001 + index; backlog row 30 a)
        // (a ranged job's: the shot's numbers of the written frames, ClipMeta::exr_numbers)
        let exr_numbers = job.exr.then(|| std::sync::Arc::new(meta.exr_numbers()));
        if let Some(n) = &exr_numbers {
            match &n.fallback {
                Some(why) => sink.log(&format!("  EXR frame numbers: {} ({why}: numbered from 1001 instead)", n.describe())),
                None => sink.log(&format!("  EXR frame numbers: {}", n.describe())),
            }
        }
        // loop: NOT-WORTH — at most four outputs
        for name in &job.outputs {
            let sfx = suffix(name, job.despill_strength);
            let wr: Box<dyn Writer> = if job.exr {
                let ch = if name == "cutout" {
                    4
                } else if name == "alpha" {
                    1
                } else {
                    3
                };
                let ty = if job.exr_float { ExrType::Float } else { ExrType::Half };
                let numbers = exr_numbers.clone().ok_or_else(|| Error::engine("EXR frame numbers missing".into()))?;
                Box::new(ExrWriter::new(&job.output_dir.join(format!("{clip}_{sfx}_exr")), w, h, ch, ty, &format!("{clip}_{sfx}"), numbers)?)
            } else {
                let ext = job.writer.codec.ext();
                let trc = if name == "cutout" && job.cutout_linear { "linear" } else { "iec61966-2-1" };
                Box::new(VideoWriter::new(&job.output_dir.join(format!("{clip}_{sfx}.{ext}")), fps, w, h, &job.writer, trc)?)
            };
            writers.push((name.clone(), wr));
        }
        if !job.exr {
            sink.log(&format!("  Video codec: {}", job.writer.codec.name()));
            // loop: NOT-WORTH — at most four outputs, once per job
            if job.outputs.iter().any(|x| x == "cutout") {
                let added = if job.alpha_for_cutout { " (added for the cutout)" } else { "" };
                sink.log(&format!("  Video cutout: premultiplied colour, no alpha channel; its alpha is the alpha output{added}"));
            }
        }
        let settings_path = job.output_dir.join(format!("{clip}_settings.txt"));
        let write_settings = |chunk: usize, stride: usize, low_vram: bool, sink: &mut dyn Sink| {
            let text = crate::settings::settings_text(&crate::settings::SettingsLog {
                input: &job.input,
                output_dir: &job.output_dir.to_string_lossy(),
                w,
                h,
                fps,
                outputs: &job.outputs,
                output_format: if job.exr { "exr" } else { "video" },
                exr_dtype: if job.exr_float { "float" } else { "half" },
                video_codec: (!job.exr).then(|| job.writer.codec.name()),
                hint_first_frame: job.hint_first_frame.as_deref(),
                hint_video: job.hint_video.as_deref(),
                hint_quality: job.hint_quality,
                carry_hint: job.carry_hint,
                carry_hint_quality: job.carry_hint_quality,
                despill_strength: job.despill_strength,
                cutout_linear: job.cutout_linear,
                frame_dir_linear: job.frame_dir_linear,
                hann_chunk: chunk,
                hann_stride: stride,
                low_vram,
                num_frames: job.num_frames,
                model_scale: job.model_scale,
                start_mode: job.start_mode.name(),
                seed: job.seed,
                linear_brightness: job.linear_brightness,
                linear_contrast: job.linear_contrast,
                linear_contrast_pivot: job.linear_contrast_pivot,
                start_frame: meta.start_frame,
                adjust_applied: !meta.adjust.is_identity(),
                decoders: &decoders,
                exr_frames: exr_numbers.as_ref().map(|n| n.describe()),
                color: color.as_ref().map(|c| c.settings_lines()),
                input_bit_depth: job.input_bits,
                range: meta.range.as_ref().map(|r| {
                    let (a, b) = (r.numbers.numbers.first().copied().unwrap_or(0), r.numbers.numbers.last().copied().unwrap_or(0));
                    (format!("{a}-{b}"), format!("{}-{} (warm-up {}, tail {})", r.keyed.0, r.keyed.1, r.write.0, meta.num_frames - r.write.1))
                }),
            });
            if let Err(e) = std::fs::write(&settings_path, text) {
                sink.log(&format!("[WARNING] Failed to write settings file: {e}"));
            }
        };
        write_settings(chunk, stride, low_vram, sink);

        // `frames` counts the frames written (a ranged job's warm-up and tail are keyed, never written)
        let written = meta.write_range().len();
        let mut report = FrameReport { total: written, last_sent: None, last_done: None };
        let setup_s = job_t.elapsed().as_secs_f64();
        let mut ctx = JobCtx::new(job, &meta, &meta, trt_ref, &clip);
        // colour-managed EXR outputs only: video outputs stay display sRGB / Rec.709 (decision 2)
        if let Some(c) = color.as_ref().filter(|_| job.exr) {
            ctx.color_out = c.output.clone();
            ctx.out_linear = c.output_linear;
        }
        let mut plan = JobPlan { chunk, stride, low_vram, key };
        let res = self.attempts(&ctx, &mut plan, &mut writers, &mut report, sink, &mut |p, sink| write_settings(p.chunk, p.stride, p.low_vram, sink));
        // release every writer (its encoder finishes the file), the first failure wins
        let rel_t = Instant::now();
        let mut rel: Result<(), Error> = Ok(());
        for (_, wr) in writers.iter_mut() {
            if let Err(e) = wr.release() {
                if rel.is_ok() {
                    rel = Err(e);
                }
            }
        }
        if plan.low_vram {
            self.unload();
        }
        sink.log(&format!(
            "  job: setup {setup_s:.1} s (probe, writers), writers finishing {:.1} s, total {:.1} s",
            rel_t.elapsed().as_secs_f64(),
            job_t.elapsed().as_secs_f64()
        ));
        res?;
        rel?;
        report.report(&writers, sink, true);
        sink.log(&format!("  wrote {} output video(s) for {clip} ({written} frames @ {w}x{h})", writers.len()));
        Ok(JobResult {
            // loop: NOT-WORTH — ≤ four outputs, once per job
            outputs: writers.iter().map(|(_, w)| w.path().to_string_lossy().into_owned()).collect(),
            settings_file: settings_path.to_string_lossy().into_owned(),
        })
    }

    /// The TensorRT range a padded shape (H, W) and window fall in, its engines' folder, and whether it is built
    /// (every network with a TensorRT-ready export built, or remembered as failing to build). Err: why TensorRT
    /// can't take it (the `fallback_reason`). Needs the CUDA provider with TensorRT (the caller checks).
    fn trt_range(&self, (sh, sw): (usize, usize), window: usize, low_vram: bool) -> Result<TrtRange, String> {
        let Some(bucket) = crate::tensorrt::bucket_for(sh, sw, window, low_vram) else {
            return Err(format!(
                "{sw}x{sh} is outside the TensorRT ranges (more than {} px a side, or a larger frame than 4096x2176, runs on CUDA)",
                crate::tensorrt::MAX_SIDE
            ));
        };
        let trt_prec = Precision::Fp16;
        // loop: NOT-WORTH — five networks, once per TensorRT job
        let ready: Vec<&str> = crate::runtime::PIECES.iter().copied().filter(|p| self.models.trt_file(p, trt_prec).is_some()).collect();
        if ready.is_empty() {
            return Err("the models folder has no TensorRT-ready models".to_string());
        }
        let Some(gpu) = self.loader.rt.gpu.clone() else {
            return Err("TensorRT needs the graphics card".to_string());
        };
        let trt_ver = crate::gpu::tensorrt_version().unwrap_or_else(|| "unknown".into());
        let root = self.loader.rt.cfg.trt_cache.clone();
        let card_dir = crate::tensorrt::cache_dir(&root, &gpu.name, &gpu.driver, &trt_ver, &self.loader.rt.ort_version, "fp16");
        let dir = card_dir.join(bucket.key());
        let built = self.trt_dir_built(&dir);
        Ok(TrtRange { bucket, card_dir, dir, built })
    }

    /// Whether every network with a TensorRT-ready export is built in `dir` (or remembered as failing to build).
    fn trt_dir_built(&self, dir: &Path) -> bool {
        let trt_prec = Precision::Fp16;
        // loop: NOT-WORTH — five networks, once per TensorRT job
        crate::runtime::PIECES.iter().copied().filter(|p| self.models.trt_file(p, trt_prec).is_some()).all(|p| {
            let stamp = self.models.trt_file(p, trt_prec).map(|f| crate::tensorrt::source_stamp(&f)).unwrap_or_default();
            crate::tensorrt::built(&dir.join(p), p, &stamp) || crate::tensorrt::failed_before(&dir.join(p), p, &stamp, None).is_some()
        })
    }

    /// The windows other ranges of `r`'s size are built for (same height and width ranges, another window), sorted.
    fn trt_built_windows(&self, r: &TrtRange) -> Vec<usize> {
        let Ok(entries) = std::fs::read_dir(&r.card_dir) else { return Vec::new() };
        // loop: NOT-WORTH — the few range folders of one card, once per job
        let names: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        other_windows(&r.bucket, &names, |name| self.trt_dir_built(&r.card_dir.join(name)))
    }

    /// Remove the engines built for this card under another driver, TensorRT or ONNX Runtime (they can't be used);
    /// their folder names, for the `provider` reply's `cache_invalidated`.
    fn trt_drop_stale(&self, card_dir: &Path, sink: &mut dyn Sink) -> Vec<String> {
        let Some(gpu) = self.loader.rt.gpu.as_ref() else { return Vec::new() };
        let stale = crate::tensorrt::stale_dirs(&self.loader.rt.cfg.trt_cache, card_dir, &gpu.name);
        // loop: NOT-WORTH — a few stale cache folders, once per TensorRT job
        let names: Vec<String> = stale.iter().filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).collect();
        if !names.is_empty() {
            sink.log(&format!("  TensorRT: the graphics driver or TensorRT changed; engines built for {} can't be used and were removed", names.join(", ")));
        }
        for s in &stale {
            let _ = std::fs::remove_dir_all(s);
        }
        names
    }

    /// The networks' key for this job and, for TensorRT, (cache folder, already built). Sends the
    /// `provider` reply. `shape`: the clip's model shape (H, W); `window`: the job's window; `skip`: why this
    /// `tensorrt_build: false` job already chose CUDA (its range isn't built).
    #[allow(clippy::too_many_arguments)]
    fn job_key(
        &mut self,
        job: &JobConfig,
        base: &ModelKey,
        (sh, sw): (usize, usize),
        window: usize,
        low_vram: bool,
        skip: Option<&str>,
        sink: &mut dyn Sink,
    ) -> Result<(ModelKey, Option<(PathBuf, bool)>), Error> {
        let mut msg = json!({"type": "provider", "provider": base.provider.name(), "precision": base.precision.name(), "tensorrt_requested": job.tensorrt});
        if !job.tensorrt {
            sink.send(msg);
            return Ok((base.clone(), None));
        }
        let why = if base.provider != Provider::Cuda {
            Err("TensorRT needs the graphics card".to_string())
        } else if !self.loader.rt.tensorrt_ep {
            Err("this ONNX Runtime has no TensorRT provider".to_string())
        } else if let Some(s) = skip {
            Err(s.to_string())
        } else {
            self.trt_range((sh, sw), window, low_vram).and_then(|r| trt_job_may_use(r, job.tensorrt_build))
        };
        let r = match why {
            Ok(r) => r,
            Err(why) => {
                msg["fallback_reason"] = json!(why);
                sink.send(msg);
                return Ok((base.clone(), None));
            }
        };
        let names = self.trt_drop_stale(&r.card_dir, sink);
        if !names.is_empty() {
            msg["cache_invalidated"] = json!(names);
        }
        msg["provider"] = json!("tensorrt");
        msg["precision"] = json!("fp16");
        msg["range"] = json!(r.bucket.key());
        msg["cache"] = json!(if r.built { "reused" } else { "build" });
        sink.send(msg);
        Ok((
            ModelKey { provider: Provider::TensorRt, precision: Precision::Fp16, trt_cache: Some(r.dir.clone()), vram_cap: base.vram_cap, coreml: None },
            Some((r.dir, r.built)),
        ))
    }

    /// The `trt_build` command: build the TensorRT engines a clip of `width` x `height` (and `frames` frames) would
    /// use, as a job would before keying (the same automatic window, the same builder), without a clip. Progress goes
    /// to `sink` (`optimize`, with `piece`); the `trt_built` reply's fields are returned.
    pub fn trt_build(&mut self, width: usize, height: usize, frames: usize, vram_budget_gb: Option<f64>, sink: &mut dyn Sink) -> Result<Value, Error> {
        if self.loader.rt.provider() != Some(Provider::Cuda) || !self.loader.rt.tensorrt_ep {
            return Err(Error::bad_request("trt_build needs the graphics card and ONNX Runtime's TensorRT provider".into()));
        }
        let (sh, sw) = (crate::image::ceil_to_multiple(height, crate::clip::SHAPE_QUANTUM), crate::image::ceil_to_multiple(width, crate::clip::SHAPE_QUANTUM));
        let seen = crate::gpu::budget().map(|b| b.0).unwrap_or(0) as f64 / 1073741824.0;
        let budget = vram_budget_gb.or(self.loader.rt.cfg.vram_budget_gb).map(|cap| seen.min(cap)).unwrap_or(seen);
        // the window a TensorRT job of this size picks (run_job: low-VRAM mode, the same table)
        let p = select_vram_profile((sh, sw), frames, budget, true);
        let r = self.trt_range((sh, sw), p.chunk, p.low_vram).map_err(Error::bad_request)?;
        self.trt_drop_stale(&r.card_dir, sink);
        sink.log(&format!("  TensorRT build for {width}x{height}: window {}/{} at {} GB available, range {}", p.chunk, p.stride, f1(budget), r.bucket.key()));
        let cap = vram_budget_gb.or(self.loader.rt.cfg.vram_budget_gb).map(|g| (g * 1073741824.0) as u64);
        let key = ModelKey { provider: Provider::TensorRt, precision: Precision::Fp16, trt_cache: Some(r.dir.clone()), vram_cap: cap, coreml: None };
        let was_built = r.built;
        self.trt_prepare(&key, &r.bucket, sink)?;
        // nothing stays loaded: the builder ran in its own process, and this engine quits after
        self.unload();
        trim_host_memory();
        // loop: NOT-WORTH — five networks, once per build
        let built: BTreeMap<&str, f64> = self.trt_seconds.iter().filter(|(_, v)| v.1).map(|(k, v)| (*k, v.0)).collect();
        Ok(json!({
            "type": "trt_built", "width": width, "height": height, "range": r.bucket.key(),
            "hann_chunk": p.chunk, "hann_stride": p.stride, "reused": was_built,
            "built_s": built, "fallbacks": self.trt_fallbacks
        }))
    }

    /// TensorRT jobs: build every engine this range is missing (one network at a time, ck-trt-build in a child
    /// process, before any network is loaded, so the builder has the card to itself) and put each engine's
    /// EPContext stub next to it. A network without a TensorRT-ready export, or whose build fails, is recorded
    /// and runs on CUDA.
    fn trt_prepare(&mut self, key: &ModelKey, bucket: &crate::tensorrt::Bucket, sink: &mut dyn Sink) -> Result<(), Error> {
        self.unload();
        self.trt_fallbacks.clear();
        self.trt_seconds.clear();
        self.trt_reported = None;
        self.key = Some(key.clone());
        let Some(dir) = key.trt_cache.clone() else { return Ok(()) };
        let timing = dir.parent().map(|p| p.join("timing.cache")).unwrap_or_else(|| dir.join("timing.cache"));
        let builder = crate::tensorrt::builder_path(self.loader.rt.cfg.trt_build.as_deref());
        // TensorRT's working memory while it builds: 60 % of the job's budget (else of the card's free memory), at
        // most 8 GiB. Measured 2026-10-24: stage 1 for 48-frame windows at 1152x1280 needs a 6.1 GB tactic (a
        // 4 GiB cap found none; 7 GiB built it, peak 13.9 GB on the card). A build that still finds no tactic
        // runs that network on CUDA at the same window.
        let budget = key.vram_cap.or_else(|| crate::gpu::budget().map(|b| b.0)).unwrap_or(8 << 30);
        let workspace_mb = ((budget >> 20) * 6 / 10).clamp(512, 8192);
        let stamp = |p: &str| self.models.trt_file(p, key.precision).map(|f| crate::tensorrt::source_stamp(&f)).unwrap_or_default();
        let missing = || -> Vec<&'static str> {
            crate::runtime::PIECES
                // loop: NOT-WORTH — five networks, once per TensorRT job
                .iter()
                .copied()
                .filter(|p| {
                    !crate::tensorrt::built(&dir.join(p), p, &stamp(p))
                        && crate::tensorrt::failed_before(&dir.join(p), p, &stamp(p), Some(workspace_mb)).is_none()
                })
                .collect()
        };
        let mut todo = missing();
        // one engine process builds this range at a time; one that waited finds what the other built
        let mut lock = None;
        if !todo.is_empty() && builder.is_some() {
            let per_build = self.loader.rt.cfg.trt_build_timeout + std::time::Duration::from_secs(120);
            let waiting = || {
                sink.send(json!({"type": "progress", "stage": "optimize", "detail": "waiting for another CorridorKey engine building this range"}));
                sink.log("  TensorRT: another CorridorKey engine is building this range's engines; waiting for it");
            };
            match crate::tensorrt::BuildLock::acquire(&dir, per_build, per_build * crate::runtime::PIECES.len() as u32, waiting) {
                Ok((l, waited)) => {
                    if waited {
                        todo = missing();
                    }
                    lock = Some(l);
                }
                Err(e) => sink.log(&format!("  TensorRT: no build lock in {} ({e}); building without it", dir.display())),
            }
        }
        // loop: NOT-WORTH — five networks
        for (i, piece) in crate::runtime::PIECES.iter().copied().enumerate() {
            let pdir = dir.join(piece);
            let (Some(onnx), Some(stub)) = (self.models.trt_file(piece, key.precision), self.models.trt_stub(piece, key.precision)) else {
                self.trt_fallbacks.insert(piece, format!("no TensorRT-ready export of {piece} in the models folder"));
                continue;
            };
            let source = crate::tensorrt::source_stamp(&onnx);
            if crate::tensorrt::built(&pdir, piece, &source) {
                continue;
            }
            if let Some(why) = crate::tensorrt::failed_before(&pdir, piece, &source, Some(workspace_mb)) {
                sink.log(&format!("  TensorRT: {piece} failed to build before; it runs on CUDA (built again when the driver, TensorRT, the models or the memory budget change)"));
                self.trt_fallbacks.insert(piece, why);
                continue;
            }
            let Some(b) = &builder else {
                self.trt_fallbacks.insert(piece, "the TensorRT engine builder (ck-trt-build) is not installed".into());
                continue;
            };
            // loop: NOT-WORTH — five names
            let n = todo.iter().position(|p| *p == piece).map(|k| k + 1).unwrap_or(i + 1);
            // `piece` (additive): which network builds, for a progress bar weighted by the measured build times
            sink.send(json!({"type": "progress", "stage": "optimize", "piece": piece, "detail": format!("{} ({n}/{})", piece_name(piece), todo.len())}));
            sink.log(&format!("  TensorRT: building the {} engine for {} (one time)", piece_name(piece), bucket.key()));
            if let Some(l) = &lock {
                l.touch();
            }
            match crate::tensorrt::build_engine(b, &onnx, piece, bucket, &pdir, workspace_mb, &timing, self.loader.rt.cfg.trt_build_timeout) {
                Ok(secs) => {
                    std::fs::copy(&stub, crate::tensorrt::stub_path(&pdir, piece)).map_err(|e| Error::engine(format!("{}: {e}", pdir.display())))?;
                    std::fs::write(crate::tensorrt::source_path(&pdir, piece), &source).map_err(|e| Error::engine(format!("{}: {e}", pdir.display())))?;
                    sink.log(&format!("  TensorRT: {} engine built in {secs:.1} s", piece_name(piece)));
                    self.trt_seconds.insert(piece, ((secs * 10.0).round() / 10.0, true));
                }
                Err(err) => {
                    sink.log(&format!("  TensorRT could not build {piece}; it runs on CUDA: {}", err.why));
                    match crate::tensorrt::note_failure(&pdir, piece, &source, workspace_mb, &err) {
                        Ok(true) => {}
                        Ok(false) => {
                            sink.log("  TensorRT: not remembered as a failed build (it may work when the card has more room); the next job tries again")
                        }
                        Err(e) => sink.log(&format!("  TensorRT: couldn't note the failed build ({e}); the next job tries again")),
                    }
                    self.trt_fallbacks.insert(piece, err.why);
                }
            }
        }
        Ok(())
    }
}

/// Give freed host memory back to the system (glibc keeps it per malloc arena otherwise). Measured, four jobs
/// in one engine process (locked_backdrop, with_motion_blur, locked_backdrop, metal_glasses): sessions loaded
/// on their own thread left their freed host memory in that thread's arena, and the engine's resident memory
/// grew from job to job (3.8 -> 9.1 GB after each job, peak 12.3 GB); trimming after each unload keeps it flat.
pub(crate) fn trim_host_memory() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        extern "C" {
            fn malloc_trim(pad: usize) -> std::os::raw::c_int;
        }
        // SAFETY: glibc's malloc_trim(3) takes a pad size and only releases free memory
        unsafe {
            malloc_trim(0);
        }
    }
}

/// The TensorRT engine cache root: CK_ENGINE_TRT_CACHE (the app passes its cache folder's `tensorrt`), else the
/// system's cache folder (the app's own, electron/main/platform.ts appDirs): Linux $XDG_CACHE_HOME (or
/// ~/.cache)/corridorkey-desktop/tensorrt, Windows %LOCALAPPDATA%\corridorkey-desktop\cache\tensorrt, macOS
/// ~/Library/Caches/corridorkey-desktop/tensorrt. For system `os` ("linux", "windows", "macos") and an environment
/// lookup; read once at startup (config.rs, EngineConfig::trt_cache).
pub(crate) fn trt_root_for(os: &str, env: impl Fn(&str) -> Option<String>) -> PathBuf {
    let var = |k: &str| env(k).filter(|s| !s.is_empty()).map(PathBuf::from);
    if let Some(p) = var("CK_ENGINE_TRT_CACHE") {
        return p;
    }
    let app = "corridorkey-desktop";
    match os {
        "windows" => {
            let local = var("LOCALAPPDATA").or_else(|| var("USERPROFILE").map(|h| h.join("AppData").join("Local"))).unwrap_or_else(|| PathBuf::from("."));
            local.join(app).join("cache").join("tensorrt")
        }
        "macos" => var("HOME").unwrap_or_else(|| PathBuf::from(".")).join("Library").join("Caches").join(app).join("tensorrt"),
        _ => var("XDG_CACHE_HOME").unwrap_or_else(|| var("HOME").unwrap_or_else(|| PathBuf::from(".")).join(".cache")).join(app).join("tensorrt"),
    }
}

/// A network's name for people (progress details and logs).
pub(crate) fn piece_name(piece: &str) -> &'static str {
    match piece {
        "cradio" => "C-RADIO",
        "moge" => "MoGe",
        "rvm" => "RVM",
        "stage1" => "stage 1",
        "stage2" => "stage 2",
        _ => "network",
    }
}

#[cfg(test)]
mod tests;
