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
mod frames;
pub mod network;

use crate::ahead::Ahead;
use crate::clip::{probe_frame_dir, probe_video, raw_clip_name, ClipMeta, Source};
use crate::color::{bf16_round, LinearAdjust};
use crate::config::ArenaShrink;
use crate::decode::{load_initial_hint, Prefetch, Prepped};
use crate::hann::{taper_weights, window_starts, BatonBlend};
use crate::image::{resize_area, resize_bilinear, Planar};
use crate::job::{suffix, JobConfig};
use crate::outputs::{Geometry, RenderWorker};
use crate::render::{make_checker, RenderOpts};
use crate::runtime::{Data, ModelSet, Precision, Provider, Runtime, TrtSettings};
use crate::tensorrt::{BATON_CH, CRADIO_CH, MOGE_CH, RVM_CH};
use crate::vram::{estimate_peak_vram_gb, select_vram_profile};
use crate::writers::{ExrType, ExrWriter, VideoWriter, Writer};
use crate::Error;
use frames::{FrameSource, HintWindows, WindowReader};
use network::{Loader, Network, OrtLoader};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

/// Where replies go (the engine adds "id"). Every message is a protocol reply object with its "type".
pub trait Sink {
    fn send(&mut self, msg: Value);
    /// A model print: a `log` reply (and a copy on stderr).
    fn log(&mut self, text: &str) {
        eprintln!("{text}");
        self.send(json!({"type": "log", "text": text}));
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
        // loop: NOT-WORTH — ≤ four writers, ≤ 4 times per second
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
}

pub struct JobResult {
    pub outputs: Vec<String>,
    pub settings_file: String,
}

/// Temp files of a job, removed when it ends (runtime.run_inference's finally).
struct Temps(Vec<PathBuf>);
impl Drop for Temps {
    fn drop(&mut self) {
        // loop: NOT-WORTH — four temp files at the job's end
        self.0.iter().for_each(|p| {
            let _ = std::fs::remove_file(p);
        });
    }
}

fn open_rw(p: &Path) -> Result<File, Error> {
    std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(true).open(p).map_err(|e| Error::write("a temporary file", p, &e))
}

fn temp_err(e: std::io::Error) -> Error {
    match crate::write_failure(&e) {
        // the temporary folder's disk filled up (the RVM features and states take GBs on long clips)
        Some(why) => Error::new(crate::ErrorCode::Output, format!("Can't write the job's temporary files: {why} ({e})")),
        None => Error::engine(format!("temp file: {e}")),
    }
}

/// A float16 (T, C*H*W) array on disk (the runtime's np.memmap files): written and read as raw float16, no
/// conversion on the way.
struct F16File {
    f: File,
    frame: usize,
}

impl F16File {
    fn create(p: &Path, frame: usize) -> Result<F16File, Error> {
        Ok(F16File { f: open_rw(p)?, frame })
    }
    /// frames from `t` on (`v` holds whole frames)
    fn put(&mut self, t: usize, v: &[half::f16]) -> Result<(), Error> {
        self.f.seek(SeekFrom::Start((t * self.frame * 2) as u64)).and_then(|_| self.f.write_all(bytemuck::cast_slice(v))).map_err(temp_err)
    }
    /// frames t0..t1
    fn get(&mut self, t0: usize, t1: usize) -> Result<Vec<half::f16>, Error> {
        let mut out = vec![half::f16::ZERO; (t1 - t0) * self.frame];
        // loop: HOT-PATH-OK — one RVM window or baton frame from the local temp file, read straight into float16 (this pass: no byte buffer + conversion) [bounded: a local file read]
        self.f.seek(SeekFrom::Start((t0 * self.frame * 2) as u64)).and_then(|_| self.f.read_exact(bytemuck::cast_slice_mut(&mut out))).map_err(temp_err)?;
        Ok(out)
    }
}

/// The low-VRAM foundation features on disk, (T, C*H*W) in the type the network made them (float16 for the fp16
/// models, float32 for fp32): kept exactly, half the bytes of the float32 file for fp16.
struct FeatFile {
    f: File,
    frame: usize,
    /// set by the first `put`: float16 (true) or float32
    half: Option<bool>,
}

impl FeatFile {
    fn create(p: &Path, frame: usize) -> Result<FeatFile, Error> {
        Ok(FeatFile { f: open_rw(p)?, frame, half: None })
    }
    /// frames from `t` on
    fn put(&mut self, t: usize, v: &Data) -> Result<(), Error> {
        let (half, bytes): (bool, &[u8]) = match v {
            Data::F16(x) => (true, bytemuck::cast_slice(x)),
            Data::F32(x) => (false, bytemuck::cast_slice(x)),
            Data::Bf16(_) | Data::F16Ref(_) | Data::F32Ref(_) => return Err(Error::engine("foundation features as bfloat16 or borrowed".into())),
        };
        if *self.half.get_or_insert(half) != half {
            return Err(Error::engine("foundation features changed type".into()));
        }
        let size = if half { 2 } else { 4 };
        self.f.seek(SeekFrom::Start((t * self.frame * size) as u64)).and_then(|_| self.f.write_all(bytes)).map_err(temp_err)
    }
    /// frames t0..t1
    fn get(&mut self, t0: usize, t1: usize) -> Result<Data<'static>, Error> {
        let n = (t1 - t0) * self.frame;
        let half = self.half.ok_or_else(|| Error::engine("foundation features not written".into()))?;
        let size = if half { 2 } else { 4 };
        self.f.seek(SeekFrom::Start((t0 * self.frame * size) as u64)).map_err(temp_err)?;
        Ok(if half {
            let mut out = vec![half::f16::ZERO; n];
            // loop: HOT-PATH-OK — one window's foundation features from the local temp file, in their own type (this pass: float16, half the bytes) [bounded: a local file read]
            self.f.read_exact(bytemuck::cast_slice_mut(&mut out)).map_err(temp_err)?;
            Data::F16(out)
        } else {
            let mut out = vec![0f32; n];
            // loop: HOT-PATH-OK — the float32 (CPU / fp32) case of the same read [bounded: a local file read]
            self.f.read_exact(bytemuck::cast_slice_mut(&mut out)).map_err(temp_err)?;
            Data::F32(out)
        })
    }
}

fn bf16_to_f32(v: &[half::bf16], out: &mut Vec<f32>) {
    use rayon::prelude::*;
    let start = out.len();
    out.resize(start + v.len(), 0.0);
    // loop: HOT-PATH-OK — one frame's display view to float32 (RVM / foundation inputs), parallel
    out[start..].par_iter_mut().with_min_len(1 << 14).zip(v.par_iter()).for_each(|(o, x)| *o = x.to_f32());
}

fn f1(v: f64) -> String {
    format!("{v:.1}")
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
        // loop: NOT-WORTH — at most five networks
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
            let file = self
                .models
                .file(piece, key.precision)
                .ok_or_else(|| Error::assets(format!("missing ONNX model {piece} ({}) in {}", key.precision.name(), self.models.dir.display())))?;
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
        Ok(())
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
            // loop: PARALLELIZE — the next low-VRAM phase's network loads while this phase runs (this pass; measured: 1.3-1.5 s less per job)
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
    }

    /// Drop loads started ahead (a job ends or restarts).
    fn drop_pending(&mut self) {
        // loop: NOT-WORTH — at most two loads [bounded: each load ends (ORT session creation)]
        for (_, _, h) in self.pending.drain(..) {
            // loop: NOT-WORTH — joins loads that were started ahead [bounded: ORT session creation ends]
            let _ = h.join();
        }
    }

    /// Arena shrinkage for what is loaded now (`crate::runtime::shrinks`).
    fn set_shrink(&mut self) {
        let shared = self.nets.contains_key("stage1") && self.nets.contains_key("stage2");
        let setting = &self.arena_shrink;
        // loop: NOT-WORTH — at most five networks
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
            // loop: NOT-WORTH — five model files' sizes, once per session load
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
            return Err(Error::no_gpu("CorridorKey needs an NVIDIA graphics card with CUDA.".into()));
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
        let vram_cap = match provider {
            Provider::Cpu => None,
            _ => job.vram_budget_gb.map(|g| (g * 1073741824.0) as u64),
        };
        let base_key = ModelKey { provider, precision, trt_cache: None, vram_cap };
        // a manual normal-mode job loads the CUDA / CPU networks before the probe, as the runtime's load_model
        // (TensorRT's depend on the clip). An automatic window loads them once the window is chosen: measured, the
        // early load cost ~3 s per job when the window then came out low-VRAM (every network loaded again per
        // phase). The automatic budget is free + own memory, the same either way.
        if job.manual && !job.low_vram && !job.tensorrt {
            self.ensure(&base_key, &crate::runtime::PIECES, None, sink, "load")?;
        }
        sink.send(json!({"type": "progress", "stage": "probe"}));
        std::fs::create_dir_all(&job.temp_dir).map_err(|e| Error::write("the temporary folder", &job.temp_dir, &e))?;
        std::fs::create_dir_all(&job.output_dir).map_err(|e| Error::write("the output folder", &job.output_dir, &e))?;
        let is_dir = Path::new(&job.input).is_dir();
        let mut meta = if is_dir {
            probe_frame_dir(Path::new(&job.input), job.num_frames, job.frame_dir_fps, job.frame_dir_linear)?
        } else {
            probe_video(Path::new(&job.input), job.num_frames)?
        };
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
                if !job.frame_dir_linear && p.first().is_some_and(|f| f.to_string_lossy().to_lowercase().ends_with(".exr")) {
                    sink.log("  [WARNING] EXR input frames are being treated as display-coded and clipped to [0, 1]. For scene-linear HDR EXR plates, pass --frame_dir_linear.");
                }
            }
        } else {
            sink.log(&format!(
                "  probed {} frames @ {}x{} (native {}x{}, fps {:.2}, start=0, pad=({}, {}, {}, {}))",
                meta.num_frames, meta.shape_w, meta.shape_h, meta.w, meta.h, meta.fps, meta.pad.l, meta.pad.r, meta.pad.t, meta.pad.b
            ));
        }
        meta.exr_linear = is_dir && job.frame_dir_linear;
        let (mut chunk, mut stride, mut low_vram) = (job.hann_chunk, job.hann_stride, job.low_vram);
        if job.manual {
            sink.send(json!({"type": "memory", "hann_chunk": chunk, "hann_stride": stride, "low_vram": low_vram, "auto": false, "provider": provider.name()}));
        }
        sink.send(json!({"type": "clip", "width": meta.w, "height": meta.h, "fps": meta.fps, "frames": meta.num_frames}));
        crate::clip::model_shape_supported(meta.shape_h, meta.shape_w, meta.w, meta.h, self.models.takes_portrait())?;
        let t_all = meta.num_frames;
        let (sh, sw) = (meta.shape_h, meta.shape_w);
        // TensorRT jobs take the same window (and low-VRAM staging) as the CUDA path, so the mattes match
        // (tensorrt.rs bucket_for); their engines are built for it
        if !job.manual {
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
            let p = select_vram_profile((sh, sw), t_all, budget);
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
                "estimate_basis": "pytorch-bf16-table", "provider": provider.name()
            }));
        }
        // which provider really runs this job
        let (key, trt_info) = self.job_key(job, &base_key, sh, sw, chunk, low_vram, sink)?;
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
        let load_stage = "load";

        let clip = raw_clip_name(&job.input);
        let (h, w) = (meta.h, meta.w);
        let fps = meta.fps;
        let mut writers: Vec<(String, Box<dyn Writer>)> = Vec::new();
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
                Box::new(ExrWriter::new(&job.output_dir.join(format!("{clip}_{sfx}_exr")), w, h, ch, ty, &sfx)?)
            } else {
                let ext = if name == "cutout" { "mov" } else { "mp4" };
                let ch = if name == "cutout" { 4 } else { 3 };
                let trc = if name == "cutout" && job.cutout_linear { "linear" } else { "iec61966-2-1" };
                Box::new(VideoWriter::new(&job.output_dir.join(format!("{clip}_{sfx}.{ext}")), fps, w, h, &job.writer, ch, trc)?)
            };
            writers.push((name.clone(), wr));
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
                decoders: &decoders,
            });
            if let Err(e) = std::fs::write(&settings_path, text) {
                sink.log(&format!("[WARNING] Failed to write settings file: {e}"));
            }
        };
        write_settings(chunk, stride, low_vram, sink);

        let mut report = FrameReport { total: t_all, last_sent: None, last_done: None };
        let setup_s = job_t.elapsed().as_secs_f64();
        let mut res;
        // An automatic window that runs out of graphics memory before any frame reached the writers is halved and
        // the job restarted (the PyTorch table the window comes from is not ONNX Runtime's measured memory,
        // docs/ENGINE_RUST.md).
        // loop: SERIAL-REQUIRED — one attempt at a time [bounded: the window halves each round, and only while nothing was written: ≤ log2(80) ≈ 7 rounds]
        loop {
            res = self.keying(job, &meta, &meta, &key, trt_ref, load_stage, chunk, stride, low_vram, &clip, &mut writers, &mut report, sink);
            // loop: NOT-WORTH — ≤ four writers, once per attempt
            let nothing_written = writers.iter().all(|(_, w)| w.frames() == 0);
            match &res {
                Err(e) if e.code == crate::ErrorCode::Oom && !job.manual && nothing_written && chunk > 1 => {
                    let (old_chunk, old_stride) = (chunk, stride);
                    chunk = (chunk / 2).max(1);
                    stride = (chunk / 2).max(1);
                    sink.log(&format!("  out of graphics memory at window {old_chunk}/{old_stride}: retrying at {chunk}/{stride}"));
                    sink.send(json!({
                        "type": "memory", "hann_chunk": chunk, "hann_stride": stride, "low_vram": low_vram, "auto": true,
                        "provider": key.provider.name(), "retry_after_oom": {"hann_chunk": old_chunk, "hann_stride": old_stride, "message": e.message},
                        "budget_cap_gb": job.vram_budget_gb
                    }));
                    write_settings(chunk, stride, low_vram, sink);
                    self.unload();
                }
                _ => break,
            }
        }
        // a load started ahead for a phase that never came (an error) is not kept
        self.drop_pending();
        // release every writer (its encoder finishes the file), the first failure wins
        let rel_t = Instant::now();
        let mut rel: Result<(), Error> = Ok(());
        // loop: NOT-WORTH — at most four writers
        for (_, wr) in writers.iter_mut() {
            if let Err(e) = wr.release() {
                if rel.is_ok() {
                    rel = Err(e);
                }
            }
        }
        if low_vram {
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
        sink.log(&format!("  wrote {} output video(s) for {clip} ({t_all} frames @ {w}x{h})", writers.len()));
        Ok(JobResult {
            // loop: NOT-WORTH — ≤ four outputs, once per job
            outputs: writers.iter().map(|(_, w)| w.path().to_string_lossy().into_owned()).collect(),
            settings_file: settings_path.to_string_lossy().into_owned(),
        })
    }

    /// The networks' key for this job and, for TensorRT, (cache folder, already built). Sends the
    /// `provider` reply.
    #[allow(clippy::too_many_arguments)]
    fn job_key(
        &mut self,
        job: &JobConfig,
        base: &ModelKey,
        sh: usize,
        sw: usize,
        window: usize,
        low_vram: bool,
        sink: &mut dyn Sink,
    ) -> Result<(ModelKey, Option<(PathBuf, bool)>), Error> {
        let mut msg = json!({"type": "provider", "provider": base.provider.name(), "precision": base.precision.name(), "tensorrt_requested": job.tensorrt});
        if !job.tensorrt {
            sink.send(msg);
            return Ok((base.clone(), None));
        }
        let fallback = |why: String, msg: &mut Value| {
            msg["fallback_reason"] = json!(why);
        };
        if base.provider != Provider::Cuda || !self.loader.rt.tensorrt_ep {
            let why = if base.provider != Provider::Cuda {
                "TensorRT needs the graphics card".to_string()
            } else {
                "this ONNX Runtime has no TensorRT provider".to_string()
            };
            fallback(why, &mut msg);
            sink.send(msg);
            return Ok((base.clone(), None));
        }
        let Some(bucket) = crate::tensorrt::bucket_for(sh, sw, window, low_vram) else {
            fallback(format!("{sw}x{sh} is outside the TensorRT ranges (larger than {} px a side runs on CUDA)", crate::tensorrt::MAX_SIDE), &mut msg);
            sink.send(msg);
            return Ok((base.clone(), None));
        };
        let gpu = self.loader.rt.gpu.clone().unwrap();
        let trt_ver = crate::gpu::tensorrt_version().unwrap_or_else(|| "unknown".into());
        let trt_prec = Precision::Fp16;
        // loop: NOT-WORTH — five networks, once per TensorRT job
        let ready: Vec<&str> = crate::runtime::PIECES.iter().copied().filter(|p| self.models.trt_file(p, trt_prec).is_some()).collect();
        if ready.is_empty() {
            fallback("the models folder has no TensorRT-ready models".to_string(), &mut msg);
            sink.send(msg);
            return Ok((base.clone(), None));
        }
        let root = self.loader.rt.cfg.trt_cache.clone();
        let dir = crate::tensorrt::cache_dir(&root, &gpu.name, &gpu.driver, &trt_ver, &self.loader.rt.ort_version, "fp16");
        let stale = crate::tensorrt::stale_dirs(&root, &dir, &gpu.name);
        if !stale.is_empty() {
            // loop: NOT-WORTH — a few stale cache folders, once per TensorRT job
            let names: Vec<String> = stale.iter().filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).collect();
            sink.log(&format!("  TensorRT: the graphics driver or TensorRT changed; engines built for {} can't be used and were removed", names.join(", ")));
            msg["cache_invalidated"] = json!(names);
            // loop: NOT-WORTH — a few stale folders
            for s in &stale {
                let _ = std::fs::remove_dir_all(s);
            }
        }
        let bdir = dir.join(bucket.key());
        // loop: NOT-WORTH — five networks' stamps, once per TensorRT job
        let built = ready.iter().all(|p| {
            let stamp = self.models.trt_file(p, trt_prec).map(|f| crate::tensorrt::source_stamp(&f)).unwrap_or_default();
            crate::tensorrt::built(&bdir.join(p), p, &stamp) || crate::tensorrt::failed_before(&bdir.join(p), p, &stamp, None).is_some()
        });
        msg["provider"] = json!("tensorrt");
        msg["precision"] = json!("fp16");
        msg["range"] = json!(bucket.key());
        msg["cache"] = json!(if built { "reused" } else { "build" });
        sink.send(msg);
        Ok((ModelKey { provider: Provider::TensorRt, precision: trt_prec, trt_cache: Some(bdir.clone()), vram_cap: base.vram_cap }, Some((bdir, built))))
    }

    /// TensorRT jobs: build every engine this range is missing (one network at a time, ck-trt-build in a child
    /// process, before any network is loaded, so the builder has the card to itself) and put each engine's
    /// EPContext stub next to it. A network without a TensorRT-ready export, or whose build fails, is recorded
    /// and runs on CUDA.
    fn trt_prepare(&mut self, key: &ModelKey, bucket: &crate::tensorrt::Bucket, sink: &mut dyn Sink) -> Result<(), Error> {
        self.unload();
        self.trt_fallbacks.clear();
        self.trt_seconds.clear();
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
            sink.send(json!({"type": "progress", "stage": "optimize", "detail": format!("{} ({n}/{})", piece_name(piece), todo.len())}));
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

impl<L: Loader> Pipeline<L> {
    /// Steps 2-4 (and the low-VRAM staging).
    #[allow(clippy::too_many_arguments)]
    fn keying(
        &mut self,
        job: &JobConfig,
        meta: &ClipMeta,
        frames: &dyn FrameSource,
        key: &ModelKey,
        trt: Option<&dyn Fn(&str) -> TrtSettings>,
        load_stage: &str,
        chunk: usize,
        stride: usize,
        low_vram: bool,
        clip: &str,
        writers: &mut Vec<(String, Box<dyn Writer>)>,
        report: &mut FrameReport,
        sink: &mut dyn Sink,
    ) -> Result<(), Error> {
        let t_all = meta.num_frames;
        let job_t0 = Instant::now();
        let mut decode_s = 0.0;
        let mut render_s = 0.0;
        self.nets.values_mut().for_each(|n| {
            let c = n.counters();
            c.run_s = 0.0;
            c.convert_s = 0.0;
            c.calls = 0;
        });
        self.stats.clear();
        self.drop_pending();
        self.load_s = 0.0;
        self.preload_s = 0.0;
        self.load_each.clear();
        self.s2_host = [0.0; 2];
        // wall seconds per phase (the low-VRAM phases include loading their networks)
        let mut phases: Vec<(&str, f64)> = Vec::new();
        let mut phase_t = Instant::now();
        let (sh, sw) = (meta.shape_h, meta.shape_w);
        let (h64, w64, h16, w16) = (sh / 64, sw / 64, sh / 16, sw / 16);
        let initial_hint = match crate::clip::none_path(job.hint_first_frame.as_deref()) {
            Some(p) => {
                let v = load_initial_hint(Path::new(p), meta)?;
                sink.log(&format!("  loaded initial frame-1 hint from {p}"));
                Some(v)
            }
            None => None,
        };
        let td = &job.temp_dir;
        let rvm_path = td.join(format!("{clip}_rvm_feat.f16"));
        let baton_path = td.join(format!("{clip}_baton.f16"));
        let cradio_path = td.join(format!("{clip}_foundation_cradio.bin"));
        let moge_path = td.join(format!("{clip}_foundation_moge.bin"));
        let _temps = Temps(vec![rvm_path.clone(), baton_path.clone(), cradio_path.clone(), moge_path.clone()]);

        // 2. RVM prepass
        if low_vram {
            self.unload();
        }
        let first: &[&'static str] = if low_vram { &["rvm"] } else { &crate::runtime::PIECES };
        self.ensure(key, first, trt, sink, load_stage)?;
        if key.provider == Provider::TensorRt {
            // loop: NOT-WORTH — five networks, once per TensorRT job
            let pieces: BTreeMap<&str, &str> = self.nets.iter().map(|(k, n)| (*k, n.provider().name())).collect();
            // loop: NOT-WORTH — five networks, once per TensorRT job
            let built: BTreeMap<&str, f64> = self.trt_seconds.iter().filter(|(_, v)| v.1).map(|(k, v)| (*k, v.0)).collect();
            sink.send(json!({"type": "provider", "provider": if self.trt_fallbacks.is_empty() { "tensorrt" } else if self.trt_fallbacks.len() == pieces.len() { "cuda" } else { "tensorrt+cuda" },
                "pieces": pieces, "fallbacks": self.trt_fallbacks, "build_s": built}));
        }
        if low_vram {
            // the foundations load while RVM runs
            self.preload(key, &["cradio", "moge"]);
        }
        sink.send(json!({"type": "progress", "stage": "rvm"}));
        let rvm_frame = RVM_CH * h64 * w64;
        let mut rvm_file = F16File::create(&rvm_path, rvm_frame)?;
        {
            let (he, we) = (sh / 4, sw / 4);
            sink.log(&format!("    RVM continuous prepass: T={t_all}, chunk={}, input={we}x{he}, grid={}x{}", chunk.clamp(1, 8), we / 16, he / 16));
            let ntok = 1 + (he / 16) * (we / 16);
            let mut state: Data<'static> = Data::F32(vec![0f32; ntok * RVM_CH]);
            // the small frames are made ahead on their own thread (they don't depend on the state)
            let mut reader = Prefetch::new("rvm-decode", frames.open(true)?, 8)?;
            let dec = crate::ahead::Seconds::default();
            let dec2 = dec.clone();
            let mut small_frames = Ahead::spawn("rvm-inputs", 4, move || {
                let Some(f) = reader.next_frame()? else {
                    dec2.set(reader.seconds());
                    return Ok(None);
                };
                let mut disp = Vec::with_capacity(f.display.len());
                bf16_to_f32(&f.display, &mut disp);
                let mut small = resize_bilinear(&Planar::from_vec(3, sh, sw, disp), he, we);
                small.map(|v| v.clamp(0.0, 1.0));
                Ok(Some(small.data))
            })?;
            let mut t = 0;
            let net = self.net("rvm")?;
            // loop: SERIAL-REQUIRED — RVM is recurrent: each frame's step takes the previous state
            while let Some(small) = small_frames.next_item()? {
                let outs = net.run(vec![("frame", vec![1, 3, he, we], small.into()), ("state", vec![1, ntok, RVM_CH], state)])?;
                // loop: NOT-WORTH — two outputs per RVM step
                let mut it = outs.into_iter();
                let (_, feat) = it.next().ok_or_else(|| Error::engine("rvm: no output".into()))?;
                let (_, st) = it.next().ok_or_else(|| Error::engine("rvm: no state".into()))?;
                state = st;
                rvm_file.put(t, &feat.into_f16())?;
                t += 1;
            }
            if t != t_all {
                return Err(Error::input(format!("{}: decoded only {t}/{t_all} requested frames", job.input)));
            }
            decode_s += dec.get();
            sink.log(&format!("    RVM inputs prepared on their own thread in {:.1} s", small_frames.seconds()));
        }
        phases.push(("rvm", phase_t.elapsed().as_secs_f64()));
        phase_t = Instant::now();

        // foundations prepass (low-VRAM only)
        let mut found_files: Option<(FeatFile, FeatFile)> = None;
        if low_vram {
            self.unload();
            self.ensure(key, &["cradio", "moge"], trt, sink, load_stage)?;
            // stage 1 loads while the foundations run
            self.preload(key, &["stage1"]);
            sink.send(json!({"type": "progress", "stage": "foundations"}));
            let fchunk = 4;
            sink.log(&format!("    frozen VFM prepass: T={t_all}, grid={w64}x{h64}, chunk={fchunk}"));
            let mut cf = FeatFile::create(&cradio_path, CRADIO_CH * h64 * w64)?;
            let mut mf = FeatFile::create(&moge_path, MOGE_CH * h64 * w64)?;
            // the resized inputs are made ahead on their own thread
            let mut reader = Prefetch::new("found-decode", frames.open(true)?, 8)?;
            let dec = crate::ahead::Seconds::default();
            let dec2 = dec.clone();
            let mut done_frames = 0;
            let mut chunks = Ahead::spawn("found-inputs", 2, move || {
                let mut frames = Vec::new();
                // loop: NOT-WORTH — up to four frames
                while frames.len() < fchunk && done_frames < t_all {
                    frames.push(reader.next_frame()?.ok_or_else(|| Error::input("short read".into()))?);
                    done_frames += 1;
                }
                if frames.is_empty() {
                    dec2.set(reader.seconds());
                    return Ok(None);
                }
                Ok(Some((frames.len(), foundation_inputs(&frames, sh, sw))))
            })?;
            let mut t0 = 0;
            // loop: SERIAL-REQUIRED — chunks of 4 frames, in order
            while let Some((n, (radio, moge))) = chunks.next_item()? {
                let (c, m) = self.foundation_run(n, radio, moge, sh, sw)?;
                cf.put(t0, &c)?;
                mf.put(t0, &m)?;
                t0 += n;
            }
            decode_s += dec.get();
            sink.log(&format!("    foundation inputs prepared on their own thread in {:.1} s", chunks.seconds()));
            found_files = Some((cf, mf));
            phases.push(("foundations", phase_t.elapsed().as_secs_f64()));
            phase_t = Instant::now();
        }

        let window_decode_s = crate::ahead::Seconds::default();
        // 3. stage 1 on Hann windows (+ 4. stage 2 streamed, normal mode)
        let starts = window_starts(t_all, chunk, stride);
        let overlap = chunk.saturating_sub(stride);
        sink.log(&format!("    Hann stage1: chunk={chunk}, stride={stride}, windows={}, baton_grid={w16}x{h16}", starts.len()));
        let ro = RenderOpts {
            // loop: NOT-WORTH — ≤ four output names, once per attempt
            alpha: job.outputs.iter().any(|o| o == "alpha"),
            // loop: NOT-WORTH — ≤ four output names, once per attempt
            fg: job.outputs.iter().any(|o| o == "fg"),
            // loop: NOT-WORTH — ≤ four output names, once per attempt
            checker: job.outputs.iter().any(|o| o == "checker"),
            // loop: NOT-WORTH — ≤ four output names, once per attempt
            cutout: job.outputs.iter().any(|o| o == "cutout"),
            despill: job.despill_strength as f32,
            cutout_linear: job.cutout_linear,
            exr: job.exr,
            adjust: LinearAdjust::default(),
        };
        let checker = make_checker(meta.h, meta.w);
        // render + hand-off to the writers on their own thread (the writers come back when `out` ends)
        let geo = Geometry { shape: (sh, sw), crop: (meta.pad.t, meta.pad.l), hw: (meta.h, meta.w) };
        let mut out = RenderWorker::start(writers, ro, checker, geo)?;
        // each window's inputs that don't depend on the previous window (decoded frames, hint video, foundation
        // and RVM features, or the foundations' resized inputs) are made on their own thread while the card runs
        // the window before (at most one window ahead: a rendezvous channel)
        let mut windows = {
            let mut reader = WindowReader::open(frames)?;
            let mut hints = match crate::clip::none_path(job.hint_video.as_deref()) {
                Some(p) => Some(HintWindows::open(Path::new(p), meta)?),
                None => None,
            };
            let mut found_files = found_files.take();
            let mut rvm_file = rvm_file;
            let starts = starts.clone();
            let dec = window_decode_s.clone();
            let mut i = 0;
            Ahead::spawn("window-inputs", 0, move || {
                let Some(&t0) = starts.get(i) else {
                    dec.set(reader.reader.seconds());
                    return Ok(None);
                };
                i += 1;
                let t1 = (t0 + chunk).min(t_all);
                let frames = reader.window(t0, t1)?;
                let hint_video = match hints.as_mut() {
                    Some(hw) => Some(hw.window(t0, t1)?),
                    None => None,
                };
                let found = match found_files.as_mut() {
                    None => Found::Inputs(foundation_inputs(&frames, sh, sw)),
                    Some((cf, mf)) => Found::Features(cf.get(t0, t1)?, mf.get(t0, t1)?),
                };
                let rvm = rvm_file.get(t0, t1)?;
                Ok(Some(WindowInputs { frames, hint_video, found, rvm }))
            })?
        };
        let baton_frame = BATON_CH * h16 * w16;
        let mut baton_file = if low_vram { Some(F16File::create(&baton_path, baton_frame)?) } else { None };
        let mut blend = BatonBlend::default();
        let mut carry: BTreeMap<usize, Vec<f32>> = BTreeMap::new();
        let mut stage2_frames: BTreeMap<usize, Arc<Vec<half::bf16>>> = BTreeMap::new();
        let plane = sh * sw;
        let hq_full = bf16_round(job.hint_quality as f32);
        let hq_carry = bf16_round(job.carry_hint_quality as f32);
        if low_vram {
            // stage 1 loads while the first window's inputs are made
            self.unload();
            self.ensure(key, &["stage1"], trt, sink, load_stage)?;
        }
        // the hint is made in the type stage 1 takes; windows without any matte share one all-zero buffer, made the
        // first time one is needed
        let hint_f16 = self.net("stage1")?.wants_f16("hint");
        let (zeros16, zeros32) = (std::cell::OnceCell::<Vec<half::f16>>::new(), std::cell::OnceCell::<Vec<f32>>::new());
        let zero_len = chunk.min(t_all) * plane;
        sink.send(json!({"type": "progress", "stage": "keying"}));
        // measured host seconds around stage 1: inputs (decode wait, features, hints) and after (carry, blend, hand-off)
        let (mut s1_in_s, mut s1_out_s) = (0.0f64, 0.0f64);
        // loop: SERIAL-REQUIRED — windows run in order: each one's carry hint feeds the next
        for (i, &t0) in starts.iter().enumerate() {
            let tw = Instant::now();
            let t1 = (t0 + chunk).min(t_all);
            let tc = t1 - t0;
            let WindowInputs { frames, hint_video, found, rvm } =
                windows.next_item()?.ok_or_else(|| Error::engine("the window input thread ended early".into()))?;
            // each frame's matte, if it has one (later sources win: the hint video, then the carry, then the
            // first-frame hint), and its quality
            let mut src: Vec<Option<&[f32]>> = vec![None; tc];
            let mut hq = vec![0f32; tc];
            if let Some(hv) = &hint_video {
                // loop: NOT-WORTH — the window's frames (≤ 80): slice references
                for (j, m) in hv.iter().enumerate() {
                    src[j] = Some(&m[..]);
                }
                // loop: NOT-WORTH — the window's hint qualities (≤ 80)
                hq.iter_mut().for_each(|q| *q = hq_full);
            }
            // loop: NOT-WORTH — the window's frames (≤ 80): slice references
            for (j, t) in (t0..t1).enumerate() {
                if let Some(c) = carry.get(&t) {
                    src[j] = Some(&c[..]);
                    hq[j] = hq_carry;
                }
            }
            if let (Some(ih), 0) = (&initial_hint, t0) {
                src[0] = Some(&ih[..]);
                hq[0] = hq_full;
            }
            // the hint in stage 1's own type, made once (it was a float32 window converted to float16 in the run): a
            // window without any matte feeds the job's one all-zero buffer, borrowed
            // loop: NOT-WORTH — the window's flags (≤ 80)
            let hint = if src.iter().all(|s| s.is_none()) {
                // loop: NOT-WORTH — the window's hint qualities (≤ 80)
                hq.iter_mut().for_each(|q| *q = -1.0);
                if hint_f16 {
                    Data::F16Ref(&zeros16.get_or_init(|| vec![half::f16::ZERO; zero_len])[..tc * plane])
                } else {
                    Data::F32Ref(&zeros32.get_or_init(|| vec![0f32; zero_len])[..tc * plane])
                }
            } else if hint_f16 {
                Data::F16(hint_window(&src, plane, half::f16::from_f32))
            } else {
                Data::F32(hint_window(&src, plane, |v| v))
            };
            drop(src);
            if !low_vram {
                // loop: HOT-PATH-OK — the window's frames
                for (j, t) in (t0..t1).enumerate() {
                    stage2_frames.entry(t).or_insert_with(|| frames[j].model.clone());
                }
            }
            let (cradio, moge) = match found {
                Found::Inputs((radio, moge)) => self.foundation_run(tc, radio, moge, sh, sw)?,
                Found::Features(c, m) => (c, m),
            };
            // the model views only (the display views are done with); converted once, to the type stage 1 takes
            // loop: HOT-PATH-OK — the window's frames (≤ 80): moves the model views out, the display views are dropped before the run
            let models: Vec<Arc<Vec<half::bf16>>> = frames.into_iter().map(|f| f.model).collect();
            s1_in_s += tw.elapsed().as_secs_f64();
            if low_vram && i + 1 == starts.len() {
                // stage 2 loads while the last stage-1 window runs
                self.preload(key, &["stage2"]);
            }
            let outs = self.net("stage1")?.run(vec![
                // loop: HOT-PATH-OK — ≤ 80 slice references; converted once inside the run (this pass: bf16 -> f32 -> f16 was two passes and an 850 MB float32 copy per 48-frame window)
                ("rgb", vec![1, tc, 3, sh, sw], Data::Bf16(models.iter().map(|m| &m[..]).collect())),
                ("hint", vec![1, tc, 1, sh, sw], hint),
                ("hint_quality", vec![1, tc], hq.into()),
                ("moge", vec![1, tc, MOGE_CH, h64, w64], moge),
                ("cradio", vec![1, tc, CRADIO_CH, h64, w64], cradio),
                ("rvm", vec![1, tc, RVM_CH, h64, w64], Data::F16(rvm)),
            ])?;
            drop(models);
            let tw = Instant::now();
            // loop: NOT-WORTH — two outputs per window
            let mut it = outs.into_iter();
            let (bs, baton) = it.next().ok_or_else(|| Error::engine("stage1: no baton".into()))?;
            let (as_, aux) = it.next().ok_or_else(|| Error::engine("stage1: no aux".into()))?;
            if bs != vec![1, tc, BATON_CH, h16, w16] || baton.len() != tc * baton_frame {
                return Err(Error::engine(format!("stage1: baton shape {bs:?}")));
            }
            let next_start = if i + 1 < starts.len() { starts[i + 1] } else { t_all };
            if job.carry_hint {
                use rayon::prelude::*;
                let (ah, aw) = (as_[3], as_[4]);
                let aplane = 4 * ah * aw;
                // only the frames the next window takes (t >= next_start) are kept: the others aren't made
                let ups: Vec<(usize, Vec<f32>)> = (next_start.max(t0)..t1)
                    // loop: HOT-PATH-OK — carry hints: only the frames the next window takes (≤ stride), in parallel, each a small upsample
                    .into_par_iter()
                    .map(|t| {
                        let j = t - t0;
                        let a0 = Planar::from_vec(1, ah, aw, aux.range_f32(j * aplane..j * aplane + ah * aw));
                        let mut up = resize_bilinear(&a0, sh, sw);
                        up.map(|v| bf16_round(v.clamp(0.0, 1.0)));
                        (t, up.data)
                    })
                    .collect();
                carry.extend(ups);
                carry = carry.split_off(&next_start);
            }
            let wts = taper_weights(tc, overlap, i == 0, i == starts.len() - 1);
            // loop: HOT-PATH-OK — the window's frames; each frame's values blended in parallel, read in stage 1's type
            for (j, t) in (t0..t1).enumerate() {
                let r = j * baton_frame..(j + 1) * baton_frame;
                match &baton {
                    Data::F16(v) => blend.add(t, &v[r], wts[j]),
                    Data::F32(v) => blend.add(t, &v[r], wts[j]),
                    Data::Bf16(_) | Data::F16Ref(_) | Data::F32Ref(_) => return Err(Error::engine("stage1: baton not float16 / float32".into())),
                }
            }
            drop(baton);
            let ready = blend.flush_before(next_start);
            s1_out_s += tw.elapsed().as_secs_f64();
            let tr = Instant::now();
            self.baton_frames(ready, &mut baton_file, &mut stage2_frames, meta, &mut out, report, sink)?;
            render_s += tr.elapsed().as_secs_f64();
            sink.log(&format!("      window {}/{} [{t0}:{t1}]", i + 1, starts.len()));
            sink.send(json!({"type": "progress", "stage": "keying", "p": ((i + 1) as f64 / starts.len() as f64 * 1e4).round() / 1e4, "detail": format!("window {}/{} done", i + 1, starts.len())}));
        }
        let ready = blend.flush_before(t_all + 1);
        self.baton_frames(ready, &mut baton_file, &mut stage2_frames, meta, &mut out, report, sink)?;

        drop(windows);
        decode_s += window_decode_s.get();
        phases.push((if low_vram { "stage1" } else { "windows+stage2" }, phase_t.elapsed().as_secs_f64()));
        phase_t = Instant::now();
        // low-VRAM phase 2: stage 2 over the stored states
        if let Some(mut bf) = baton_file {
            self.unload();
            self.ensure(key, &["stage2"], trt, sink, load_stage)?;
            // frames and stored states read and made into stage-2 inputs on their own thread, ahead of the card
            let mut reader = Prefetch::new("s2-decode", frames.open(false)?, 8)?;
            // the frame converted here, on the producer thread, to the type stage 2 takes
            let rgb_f16 = self.net("stage2")?.wants_f16("rgb");
            let (itx, irx) = std::sync::mpsc::sync_channel::<Result<(Data<'static>, Data<'static>), Error>>(2);
            // loop: SERIAL-REQUIRED — the low-VRAM stage-2 producer: frames in order; ends at the clip's end, an error, or a dropped receiver
            let producer = crate::ahead::spawn_named("s2-inputs", move || {
                let mut prep_s = 0.0;
                // loop: SERIAL-REQUIRED — frames in order; ends at the clip's end, an error, or a dropped receiver
                for t in 0..t_all {
                    let tp = Instant::now();
                    let item = reader.next_frame().and_then(|f| f.ok_or_else(|| Error::input("short read".into()))).and_then(|f| {
                        let b = bf.get(t, t + 1)?;
                        let rgb = Data::Bf16(vec![&f.model[..]]);
                        Ok((if rgb_f16 { Data::F16(rgb.into_f16()) } else { Data::F32(rgb.into_f32()) }, Data::F16(b)))
                    });
                    prep_s += tp.elapsed().as_secs_f64();
                    let stop = item.is_err();
                    if itx.send(item).is_err() || stop {
                        break;
                    }
                }
                (reader.seconds(), prep_s)
            })?;
            let mut res = Ok(());
            // loop: SERIAL-REQUIRED — frames in order to the writers
            for _ in 0..t_all {
                let tw = Instant::now();
                // loop: SERIAL-REQUIRED — stage 2's next input, in order [bounded: the producer sends every frame or its error, then ends]
                let item = irx.recv().map_err(|_| Error::engine("the stage-2 input thread stopped".into())).and_then(|r| r);
                self.s2_host[0] += tw.elapsed().as_secs_f64();
                if let Err(e) = item.and_then(|(rgb, b)| self.stage2_run(rgb, b, meta, &mut out, report, sink)) {
                    res = Err(e);
                    break;
                }
            }
            drop(irx);
            // loop: SERIAL-REQUIRED — joins the producer after the receiver is dropped [bounded: its next send fails and it ends]
            let (dec_s, prep_s) = crate::ahead::joined(producer)?;
            res?;
            sink.log(&format!("    stage 2 phase: inputs prepared on their own thread in {prep_s:.1} s"));
            decode_s += dec_s;
            phases.push(("stage2", phase_t.elapsed().as_secs_f64()));
        }
        // render + hand-off seconds on the render thread (all frames: finish waits for the queued ones)
        let worker_s = out.finish()?;
        // every frame is with the writers now (before they finish encoding): say so right away
        report.report(writers, sink, true);
        // measured time per part
        self.fold_stats();
        // loop: NOT-WORTH — five networks, once per job (the timing line)
        let each: Vec<String> = self.load_each.iter().map(|(p, s)| format!("{p} {s:.2}")).collect();
        let mut parts: Vec<String> = vec![
            format!("decode+prep {decode_s:.1} s"),
            format!("session loads {:.1} s on the main thread ({}), {:.1} s ahead on their own thread", self.load_s, each.join(", "), self.preload_s),
        ];
        // loop: NOT-WORTH — five networks
        for p in crate::runtime::PIECES {
            if let Some(NetTotals { run_s, convert_s, calls, first_s }) = self.stats.get(p) {
                parts.push(format!("{p} {run_s:.1} s run (first calls {first_s:.1} s) + {convert_s:.1} s convert ({calls} calls)"));
            }
        }
        parts.push(format!("stage 1 host: inputs {s1_in_s:.1} s, after {s1_out_s:.1} s"));
        parts.push(format!("stage 2 calls + hand-off in the windows {render_s:.1} s"));
        parts.push(format!(
            "stage 2 main thread: inputs {:.1} s, waiting for the render thread {:.1} s; render thread {worker_s:.1} s",
            self.s2_host[0], self.s2_host[1]
        ));
        // loop: NOT-WORTH — ≤ four phases, once per job
        let ph: Vec<String> = phases.iter().map(|(n, s)| format!("{n} {s:.1} s")).collect();
        parts.push(format!("phases: {}", ph.join(", ")));
        sink.log(&format!("  timing: {}; wall {:.1} s", parts.join(", "), job_t0.elapsed().as_secs_f64()));
        Ok(())
    }

    /// C-RADIO and MoGe on `n` frames' resized inputs (`foundation_inputs`).
    fn foundation_run(&mut self, n: usize, radio: Vec<f32>, moge: Vec<f32>, sh: usize, sw: usize) -> Result<(Data<'static>, Data<'static>), Error> {
        let (hr, wr) = (sh / 4, sw / 4);
        let (hm, wm) = (sh * 7 / 32, sw * 7 / 32);
        let c =
            // loop: NOT-WORTH — one output per C-RADIO call
            self.net("cradio")?.run(vec![("rgb", vec![n, 3, hr, wr], radio.into())])?.into_iter().next().ok_or_else(|| Error::engine("cradio: no output".into()))?;
        // loop: NOT-WORTH — one output per MoGe call
        let m =
            self.net("moge")?.run(vec![("rgb", vec![n, 3, hm, wm], moge.into())])?.into_iter().next().ok_or_else(|| Error::engine("moge: no output".into()))?;
        if c.0 != vec![n, CRADIO_CH, sh / 64, sw / 64] || m.0 != vec![n, MOGE_CH, sh / 64, sw / 64] {
            return Err(Error::engine(format!("foundation shapes {:?} / {:?}", c.0, m.0)));
        }
        Ok((c.1, m.1))
    }

    /// Blended states that are final: to the low-VRAM file, or straight to stage 2.
    #[allow(clippy::too_many_arguments)]
    fn baton_frames(
        &mut self,
        ready: Vec<(usize, Vec<half::f16>)>,
        baton_file: &mut Option<F16File>,
        stage2_frames: &mut BTreeMap<usize, Arc<Vec<half::bf16>>>,
        meta: &ClipMeta,
        out: &mut RenderWorker<'_>,
        report: &mut FrameReport,
        sink: &mut dyn Sink,
    ) -> Result<(), Error> {
        // loop: SERIAL-REQUIRED — frames go to the writers in order
        for (t, b) in ready {
            match baton_file {
                Some(f) => f.put(t, &b)?,
                None => {
                    let model = stage2_frames.remove(&t).ok_or_else(|| Error::engine(format!("frame {t} not cached for stage 2")))?;
                    // converted inside the run, once, to the type stage 2 takes
                    self.stage2_run(Data::Bf16(vec![&model[..]]), Data::F16(b), meta, out, report, sink)?;
                }
            }
        }
        Ok(())
    }

    /// Stage 2 on one frame; its output goes to the render thread (rendered and handed to every writer there).
    fn stage2_run(
        &mut self,
        rgb: Data<'_>,
        baton: Data<'_>,
        meta: &ClipMeta,
        out: &mut RenderWorker<'_>,
        report: &mut FrameReport,
        sink: &mut dyn Sink,
    ) -> Result<(), Error> {
        let (sh, sw) = (meta.shape_h, meta.shape_w);
        let outs = self.net("stage2")?.run(vec![("rgb", vec![1, 1, 3, sh, sw], rgb), ("baton", vec![1, 1, BATON_CH, sh / 16, sw / 16], baton)])?;
        // the logits go to the render thread as stage 2 made them (float16 there becomes float32 off this thread)
        // loop: NOT-WORTH — one output per stage-2 call
        let (_, logits) = outs.into_iter().next().ok_or_else(|| Error::engine("stage2: no logits".into()))?;
        if logits.len() != 4 * sh * sw {
            return Err(Error::engine(format!("stage2: {} logits for {}x{}", logits.len(), sw, sh)));
        }
        let t = Instant::now();
        let sent = out.send(logits);
        self.s2_host[1] += t.elapsed().as_secs_f64();
        if let Some(done) = out.done() {
            report.count(done, sink, false);
        }
        sent
    }
}

/// One stage-1 window's inputs made ahead (`keying`).
struct WindowInputs {
    frames: Vec<Prepped>,
    hint_video: Option<Vec<Arc<Vec<f32>>>>,
    found: Found,
    rvm: Vec<half::f16>,
}

/// The window's foundation features (low-VRAM: from the prepass files) or the inputs to compute them.
enum Found {
    Features(Data<'static>, Data<'static>),
    Inputs((Vec<f32>, Vec<f32>)),
}

/// A window's hint tensor in the graph's type: each frame's matte (`src[j]`, bfloat16-rounded values) through `conv`
/// (float16: `half::f16::from_f32`, the same rounding the float32 window's conversion in the run did), zero where a
/// frame has none.
fn hint_window<T: Copy + Default + Send + Sync>(src: &[Option<&[f32]>], plane: usize, conv: impl Fn(f32) -> T + Sync + Send) -> Vec<T> {
    use rayon::prelude::*;
    let mut out = vec![T::default(); src.len() * plane];
    // loop: HOT-PATH-OK — the window's frames (≤ 80); each matte converted once, in parallel
    for (dst, s) in out.chunks_mut(plane).zip(src) {
        if let Some(s) = s {
            // loop: HOT-PATH-OK — one frame's matte into the tensor, parallel
            dst.par_iter_mut().with_min_len(1 << 14).zip(s.par_iter()).for_each(|(d, &v)| *d = conv(v));
        }
    }
    out
}

/// C-RADIO's and MoGe's inputs for frames: display RGB area-resized to 1/4 and 7/32.
fn foundation_inputs(frames: &[Prepped], sh: usize, sw: usize) -> (Vec<f32>, Vec<f32>) {
    let n = frames.len();
    let (hr, wr) = (sh / 4, sw / 4);
    let (hm, wm) = (sh * 7 / 32, sw * 7 / 32);
    let mut radio = Vec::with_capacity(n * 3 * hr * wr);
    let mut moge = Vec::with_capacity(n * 3 * hm * wm);
    // loop: HOT-PATH-OK — the window's frames
    for f in frames {
        let mut d = Vec::with_capacity(f.display.len());
        bf16_to_f32(&f.display, &mut d);
        let p = Planar::from_vec(3, sh, sw, d);
        radio.extend(resize_area(&p, hr, wr).data);
        moge.extend(resize_area(&p, hm, wm).data);
    }
    (radio, moge)
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
