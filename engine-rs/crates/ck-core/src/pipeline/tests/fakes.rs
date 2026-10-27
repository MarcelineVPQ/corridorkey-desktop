//! Fakes for running whole jobs in a test: networks that return shaped values made from their inputs (and log
//! every load, drop and run), frames made in memory, writers that count and hash what they are handed, a sink
//! that keeps every reply. No ONNX Runtime session, ffmpeg, file decode or graphics card.
use crate::clip::{ClipMeta, Source};
use crate::decode::{FrameStream, Prepped};
use crate::pipeline::frames::FrameSource;
use crate::pipeline::network::{Loader, NetCounters, Network, Output};
use crate::pipeline::Sink;
use crate::runtime::{Data, Input, Provider};
use crate::tensorrt::{BATON_CH, CRADIO_CH, MOGE_CH, RVM_CH};
use crate::writers::{Batch, Writer};
use crate::Error;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// FNV-1a, 64 bits: a hash that stays the same across Rust releases (the golden tests pin its values).
#[derive(Clone, Copy)]
pub(crate) struct Fnv(pub(crate) u64);

impl Fnv {
    pub(crate) fn new() -> Fnv {
        Fnv(0xcbf2_9ce4_8422_2325)
    }
    pub(crate) fn bytes(&mut self, b: &[u8]) {
        // loop: HOT-PATH-OK — test hashing of small tensors
        for &x in b {
            self.0 ^= x as u64;
            self.0 = self.0.wrapping_mul(0x0100_0000_01b3);
        }
    }
    pub(crate) fn u64(&mut self, v: u64) {
        self.bytes(&v.to_le_bytes());
    }
    pub(crate) fn f32s(&mut self, v: &[f32]) {
        // loop: HOT-PATH-OK — test hashing of small tensors
        for x in v {
            self.bytes(&x.to_bits().to_le_bytes());
        }
    }
}

/// One network run, as the fake saw it.
#[derive(Clone, Debug)]
pub(crate) struct Run {
    pub(crate) piece: &'static str,
    /// (input name, shape), in the order given
    pub(crate) shapes: Vec<(String, Vec<usize>)>,
    /// every input's name, shape and values (in the type the network takes, as float32 bits)
    pub(crate) hash: u64,
    /// each input's first value
    pub(crate) firsts: Vec<f32>,
}

impl Run {
    /// The shape of input `name`.
    pub(crate) fn shape(&self, name: &str) -> &[usize] {
        // loop: NOT-WORTH — ≤ six inputs
        &self.shapes.iter().find(|(n, _)| n == name).unwrap().1
    }
}

#[derive(Clone, Debug)]
pub(crate) enum Event {
    Load(&'static str, Provider),
    Drop(&'static str),
    Run(Run),
}

/// A run's failure, decided from the network and its input shapes (None: it runs).
pub(crate) type FailRun = Arc<dyn Fn(&str, &[(String, Vec<usize>)]) -> Option<Error> + Send + Sync>;
/// A load's failure, decided from the network and the provider (None: it loads).
pub(crate) type FailLoad = Arc<dyn Fn(&str, Provider) -> Option<Error> + Send + Sync>;

/// How the fake networks behave.
#[derive(Clone)]
pub(crate) struct FakeCfg {
    /// the padded model shape (H, W)
    pub(crate) shape: (usize, usize),
    /// the fp16 models: float16 inputs and outputs (else float32, the CPU models)
    pub(crate) half: bool,
    /// the mixed-precision fp16 set (2.0.0-onnx.4 on, the original's autocast types): float16 only for
    /// `MIXED_F16` (overrides `half`)
    pub(crate) mixed: bool,
    /// stage 1's baton: base_term x (a function of the window's inputs) + window_term x (the window's number)
    pub(crate) base_term: f32,
    pub(crate) window_term: f32,
    pub(crate) fail_run: Option<FailRun>,
    pub(crate) fail_load: Option<FailLoad>,
}

impl FakeCfg {
    pub(crate) fn new(shape: (usize, usize)) -> FakeCfg {
        FakeCfg { shape, half: true, mixed: false, base_term: 1.0, window_term: 0.125, fail_run: None, fail_load: None }
    }
}

#[derive(Clone)]
pub(crate) struct FakeLoader {
    pub(crate) cfg: Arc<FakeCfg>,
    pub(crate) log: Arc<Mutex<Vec<Event>>>,
    pub(crate) caps: Arc<Mutex<Caps>>,
}

/// Each load's arena limit (the session's gpu_mem_limit), in load order.
pub(crate) type Caps = Vec<(&'static str, Option<u64>)>;

impl FakeLoader {
    pub(crate) fn new(cfg: FakeCfg) -> FakeLoader {
        FakeLoader { cfg: Arc::new(cfg), log: Arc::default(), caps: Arc::default() }
    }
    pub(crate) fn events(&self) -> Vec<Event> {
        self.log.lock().unwrap().clone()
    }
    pub(crate) fn runs(&self) -> Vec<Run> {
        // loop: NOT-WORTH — a test job's events
        self.events()
            .into_iter()
            .filter_map(|e| match e {
                Event::Run(r) => Some(r),
                _ => None,
            })
            .collect()
    }
    pub(crate) fn runs_of(&self, piece: &str) -> Vec<Run> {
        // loop: NOT-WORTH — a test job's runs
        self.runs().into_iter().filter(|r| r.piece == piece).collect()
    }
}

impl Loader for FakeLoader {
    type Net = FakeNet;
    fn load(&self, piece: &'static str, provider: Provider, _file: &Path, vram_cap: Option<u64>) -> Result<FakeNet, Error> {
        if let Some(e) = self.cfg.fail_load.as_ref().and_then(|f| f(piece, provider)) {
            return Err(e);
        }
        self.caps.lock().unwrap().push((piece, vram_cap));
        self.log.lock().unwrap().push(Event::Load(piece, provider));
        Ok(FakeNet { piece, provider, cfg: self.cfg.clone(), log: self.log.clone(), counters: NetCounters::default(), calls: 0, shrink: false })
    }
}

pub(crate) struct FakeNet {
    piece: &'static str,
    provider: Provider,
    cfg: Arc<FakeCfg>,
    log: Arc<Mutex<Vec<Event>>>,
    counters: NetCounters,
    /// runs of this network since it was loaded (stage 1: the window's number)
    calls: usize,
    shrink: bool,
}

impl Drop for FakeNet {
    fn drop(&mut self) {
        if let Ok(mut l) = self.log.lock() {
            l.push(Event::Drop(self.piece));
        }
    }
}

fn mean(v: &[f32]) -> f32 {
    // loop: HOT-PATH-OK — test tensors
    v.iter().sum::<f32>() / v.len().max(1) as f32
}

/// The 2.0.0-onnx.4 fp16 set's float16 inputs and outputs (manifest.json): (network, tensor). Every other
/// tensor is float32: the features, RVM's frame and state, C-RADIO and MoGe, stage 1's baton.
pub(crate) const MIXED_F16: [(&str, &str); 6] =
    [("stage1", "rgb"), ("stage1", "hint"), ("stage1", "hint_quality"), ("stage1", "aux"), ("stage2", "rgb"), ("stage2", "logits")];

impl FakeNet {
    fn is_f16(&self, tensor: &str) -> bool {
        if self.cfg.mixed {
            MIXED_F16.contains(&(self.piece, tensor))
        } else {
            self.cfg.half
        }
    }
    fn out(&self, name: &str, shape: Vec<usize>, v: Vec<f32>) -> Output {
        if self.is_f16(name) {
            (shape, Data::F16(Data::F32(v).into_f16()))
        } else {
            (shape, Data::F32(v))
        }
    }
}

impl Network for FakeNet {
    fn run(&mut self, inputs: Vec<Input<'_>>) -> Result<Vec<Output>, Error> {
        let mut h = Fnv::new();
        let mut shapes = Vec::new();
        let mut vals: Vec<Vec<f32>> = Vec::new();
        // loop: NOT-WORTH — ≤ six inputs
        for (name, shape, data) in inputs {
            // converted to the type the network takes, as ONNX Runtime's Net does
            let v: Vec<f32> = if self.wants_f16(name) {
                // loop: HOT-PATH-OK — test tensors
                data.into_f16().iter().map(|x| x.to_f32()).collect()
            } else {
                data.into_f32()
            };
            h.bytes(name.as_bytes());
            // loop: NOT-WORTH — ≤ five dims
            shape.iter().for_each(|&d| h.u64(d as u64));
            h.f32s(&v);
            shapes.push((name.to_string(), shape));
            vals.push(v);
        }
        // loop: NOT-WORTH — ≤ six inputs
        let firsts = vals.iter().map(|v| v.first().copied().unwrap_or(f32::NAN)).collect();
        self.log.lock().unwrap().push(Event::Run(Run { piece: self.piece, shapes: shapes.clone(), hash: h.0, firsts }));
        if let Some(e) = self.cfg.fail_run.as_ref().and_then(|f| f(self.piece, &shapes)) {
            return Err(e);
        }
        let call = self.calls;
        self.calls += 1;
        self.counters.calls += 1;
        self.counters.first_s.get_or_insert(0.0);
        let (sh, sw) = self.cfg.shape;
        let (h64, w64, h16, w16) = (sh / 64, sw / 64, sh / 16, sw / 16);
        let input = |name: &str| -> &Vec<f32> {
            // loop: NOT-WORTH — ≤ six inputs
            &vals[shapes.iter().position(|(n, _)| n == name).unwrap_or_else(|| panic!("{}: no input {name}", self.piece))]
        };
        Ok(match self.piece {
            "rvm" => {
                let (frame, state) = (input("frame"), input("state"));
                let m = mean(frame);
                // loop: HOT-PATH-OK — test tensors
                let feat = (0..RVM_CH * h64 * w64).map(|k| m + state[0] * 0.5 + (k % 5) as f32 * 0.01).collect();
                // loop: HOT-PATH-OK — test tensors
                let next = state.iter().map(|s| s * 0.5 + m).collect();
                vec![self.out("feat", vec![1, RVM_CH, h64, w64], feat), self.out("new_state", shapes[1].1.clone(), next)]
            }
            "cradio" | "moge" => {
                let ch = if self.piece == "cradio" { CRADIO_CH } else { MOGE_CH };
                let rgb = input("rgb");
                let n = shapes[0].1[0];
                let per = rgb.len() / n;
                let mut v = Vec::with_capacity(n * ch * h64 * w64);
                // loop: HOT-PATH-OK — test frames
                for i in 0..n {
                    let m = mean(&rgb[i * per..(i + 1) * per]);
                    // loop: HOT-PATH-OK — test tensors
                    v.extend((0..ch * h64 * w64).map(|k| m * (1.0 + (k % 3) as f32 * 0.5)));
                }
                vec![self.out("feat", vec![n, ch, h64, w64], v)]
            }
            "stage1" => {
                let tc = shapes[0].1[1];
                let (rgb, hint, hq) = (input("rgb"), input("hint"), input("hint_quality"));
                let (moge, cradio, rvm) = (input("moge"), input("cradio"), input("rvm"));
                let per = |v: &Vec<f32>| v.len() / tc;
                let bf = BATON_CH * h16 * w16;
                let (mut baton, mut aux) = (Vec::with_capacity(tc * bf), Vec::with_capacity(tc * 4 * h16 * w16));
                // loop: HOT-PATH-OK — test frames
                for j in 0..tc {
                    let at = |v: &Vec<f32>| v[j * per(v)];
                    let m = mean(&rgb[j * per(rgb)..(j + 1) * per(rgb)]);
                    let hm = mean(&hint[j * per(hint)..(j + 1) * per(hint)]);
                    let base = m + 0.5 * hm + 0.25 * hq[j] + 0.1 * (at(cradio) + at(moge) + at(rvm));
                    let (b, w) = (self.cfg.base_term, self.cfg.window_term);
                    // loop: HOT-PATH-OK — test tensors
                    baton.extend((0..bf).map(|k| b * (base + (k % 4) as f32 * 0.01) + w * call as f32));
                    let a = (m * 3.0 + call as f32 * 0.1).fract().abs();
                    // loop: HOT-PATH-OK — test tensors
                    aux.extend((0..4 * h16 * w16).map(|k| (a + (k % 7) as f32 * 0.05).min(1.0)));
                }
                vec![self.out("baton", vec![1, tc, BATON_CH, h16, w16], baton), self.out("aux", vec![1, tc, 4, h16, w16], aux)]
            }
            "stage2" => {
                let (rgb, baton) = (input("rgb"), input("baton"));
                let plane = sh * sw;
                // loop: HOT-PATH-OK — test tensors
                let logits =
                    (0..4 * plane).map(|k| (baton[0] - 0.5) * 4.0 + rgb[((k / plane) % 3) * plane + k % plane] - 0.5 + (k / plane) as f32 * 0.1).collect();
                vec![self.out("logits", vec![1, 4, sh, sw], logits)]
            }
            other => panic!("fake network {other}"),
        })
    }
    fn wants_f16(&self, name: &str) -> bool {
        self.is_f16(name)
    }
    fn provider(&self) -> Provider {
        self.provider
    }
    fn set_shrink(&mut self, on: bool) {
        self.shrink = on;
    }
    fn counters(&mut self) -> &mut NetCounters {
        &mut self.counters
    }
}

/// `n` frames of the model shape made in memory (no padding): each value a function of the frame, channel and
/// position. `fail_at`: the stream fails at that frame (each time it is read). `first`: the shot's frame the stream
/// starts at (a ranged job's span, as the decoders start at `ClipMeta::start_frame`); its frames are the shot's.
pub(crate) struct FakeFrames {
    pub(crate) n: usize,
    pub(crate) first: usize,
    pub(crate) shape: (usize, usize),
    pub(crate) fail_at: Option<usize>,
}

impl FakeFrames {
    pub(crate) fn meta(&self) -> ClipMeta {
        let (sh, sw) = self.shape;
        let pad = crate::image::center_pad(sh, sw, sh, sw);
        ClipMeta {
            source: Source::Frames(vec![]),
            fps: 24.0,
            h: sh,
            w: sw,
            model_h: sh,
            model_w: sw,
            model_scale: 1.0,
            start_frame: 0,
            adjust: Default::default(),
            shape_h: sh,
            shape_w: sw,
            pad,
            num_frames: self.n,
            exr_linear: false,
            video_bits: 8,
            deep_input: false,
            color_in: None,
            range: None,
        }
    }
}

impl FrameSource for FakeFrames {
    fn open(&self, display_only: bool) -> Result<Box<dyn FrameStream>, Error> {
        Ok(Box::new(FakeStream { n: self.first + self.n, shape: self.shape, fail_at: self.fail_at, display_only, t: self.first }))
    }
}

struct FakeStream {
    n: usize,
    shape: (usize, usize),
    fail_at: Option<usize>,
    display_only: bool,
    t: usize,
}

impl FrameStream for FakeStream {
    fn next_frame(&mut self) -> Result<Option<Prepped>, Error> {
        let t = self.t;
        if t >= self.n {
            return Ok(None);
        }
        if self.fail_at == Some(t) {
            return Err(Error::input(format!("frame {t} can't be read")));
        }
        self.t += 1;
        let len = 3 * self.shape.0 * self.shape.1;
        // loop: HOT-PATH-OK — one test frame
        let display: Vec<half::bf16> = (0..len).map(|i| half::bf16::from_f32(((t * 31 + i * 7) % 97) as f32 / 96.0)).collect();
        let model = if self.display_only {
            Vec::new()
        } else {
            // loop: HOT-PATH-OK — one test frame
            display.iter().map(|d| half::bf16::from_f32(d.to_f32() * 2.0 - 0.5)).collect()
        };
        Ok(Some(Prepped { model: Arc::new(model), display: Arc::new(display) }))
    }
    fn seconds(&self) -> f64 {
        0.0
    }
}

/// What one in-memory writer was handed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Written {
    pub(crate) frames: usize,
    pub(crate) hash: u64,
}

/// A writer that keeps nothing but the count and a hash of what it was handed (shared, readable after the job).
pub(crate) struct MemWriter {
    pub(crate) seen: Arc<Mutex<Written>>,
    path: PathBuf,
}

impl MemWriter {
    pub(crate) fn new(name: &str) -> (MemWriter, Arc<Mutex<Written>>) {
        let seen = Arc::new(Mutex::new(Written { frames: 0, hash: Fnv::new().0 }));
        (MemWriter { seen: seen.clone(), path: PathBuf::from(format!("/mem/{name}")) }, seen)
    }
}

impl Writer for MemWriter {
    fn path(&self) -> &Path {
        &self.path
    }
    fn write_many(&mut self, batch: Batch, n: usize) -> Result<(), Error> {
        let mut s = self.seen.lock().unwrap();
        let mut h = Fnv(s.hash);
        match &batch {
            Batch::U16(v) => h.bytes(bytemuck::cast_slice(v)),
            Batch::F32(v) => h.f32s(v),
        }
        s.hash = h.0;
        s.frames += n;
        Ok(())
    }
    fn frames(&self) -> usize {
        self.seen.lock().unwrap().frames
    }
    fn release(&mut self) -> Result<(), Error> {
        Ok(())
    }
}

/// Keeps every reply (and every log line as a `log` reply), prints nothing.
#[derive(Default)]
pub(crate) struct RecSink {
    pub(crate) msgs: Vec<Value>,
    /// asks the job to stop at its stop point number `stop_at` (counted from 0: Some(0) stops it at its first)
    pub(crate) stop_at: Option<usize>,
    /// the stop points the job has passed
    pub(crate) stop_checks: usize,
}

impl Sink for RecSink {
    fn send(&mut self, msg: Value) {
        self.msgs.push(msg);
    }
    fn log(&mut self, text: &str) {
        self.msgs.push(serde_json::json!({"type": "log", "text": text}));
    }
    fn stop_requested(&mut self) -> bool {
        self.stop_checks += 1;
        self.stop_at.is_some_and(|n| self.stop_checks > n)
    }
}

impl RecSink {
    pub(crate) fn of_type(&self, ty: &str) -> Vec<&Value> {
        // loop: NOT-WORTH — a test job's replies
        self.msgs.iter().filter(|m| m["type"] == ty).collect()
    }
    pub(crate) fn logs(&self) -> Vec<String> {
        // loop: NOT-WORTH — a test job's replies
        self.of_type("log").iter().map(|m| m["text"].as_str().unwrap_or("").to_string()).collect()
    }
}
