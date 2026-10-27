//! The seam between the pipeline and ONNX Runtime: a `Network` runs named inputs to outputs in the pipeline's own
//! tensor types (runtime::Data), a `Loader` makes one for a network file on a provider. The engine's networks are
//! ORT sessions (`runtime::Net`, loaded by `OrtLoader`); the pipeline's tests run whole jobs on fakes of both.
//!
//! The pipeline is generic over its `Loader`, so the real path is monomorphised: the same direct calls into
//! `Net` as before, no boxing or dynamic dispatch.
use crate::runtime::{Data, Input, Net, Provider, Runtime};
use crate::Error;
use std::path::Path;

/// One output of a run: its shape and its values in the type the network made them (float32 or float16).
pub type Output = (Vec<usize>, Data<'static>);

/// A network's measured counters (zeroed by the pipeline per job and when it folds them into its totals).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NetCounters {
    /// seconds inside the network's run
    pub run_s: f64,
    /// seconds converting its inputs and outputs
    pub convert_s: f64,
    pub calls: usize,
    /// seconds of the first run since the counters were last folded (cuDNN's algorithm search happens there)
    pub first_s: Option<f64>,
}

/// A loaded network.
pub trait Network: Send + 'static {
    /// Run; each input converted (once) to the type the network takes. Outputs in the network's output order.
    fn run(&mut self, inputs: Vec<Input<'_>>) -> Result<Vec<Output>, Error>;
    /// Whether the network takes input `name` as float16 (else float32).
    fn wants_f16(&self, name: &str) -> bool;
    /// The provider it really runs on (a TensorRT job's network may run on CUDA).
    fn provider(&self) -> Provider;
    /// Whether its runs give their working memory back afterwards (runtime::shrinks).
    fn set_shrink(&mut self, on: bool);
    fn counters(&mut self) -> &mut NetCounters;
}

/// Loads networks: `piece` from `file` on `provider`, its working memory capped at `vram_cap` bytes. Cloned onto
/// the threads that load a low-VRAM phase's networks ahead.
pub trait Loader: Clone + Send + 'static {
    type Net: Network;
    fn load(&self, piece: &'static str, provider: Provider, file: &Path, vram_cap: Option<u64>) -> Result<Self::Net, Error>;
    /// Called on the job's own thread as a load of `piece` starts (also one ahead, before its thread is spawned).
    /// The engine's loader does nothing; the tests' fake logs it, so which networks share the card is seen in the
    /// job thread's own order, whatever the load-ahead thread's timing.
    fn starting(&self, _piece: &'static str) {}
}

/// The engine's loader: ONNX Runtime sessions in the process's runtime.
#[derive(Clone, Copy)]
pub struct OrtLoader {
    pub rt: &'static Runtime,
}

impl Loader for OrtLoader {
    type Net = Net;
    #[inline]
    fn load(&self, piece: &'static str, provider: Provider, file: &Path, vram_cap: Option<u64>) -> Result<Net, Error> {
        Net::load(self.rt, piece, provider, file, vram_cap)
    }
}

impl Network for Net {
    #[inline]
    fn run(&mut self, inputs: Vec<Input<'_>>) -> Result<Vec<Output>, Error> {
        Net::run(self, inputs)
    }
    #[inline]
    fn wants_f16(&self, name: &str) -> bool {
        Net::wants_f16(self, name)
    }
    #[inline]
    fn provider(&self) -> Provider {
        self.provider
    }
    #[inline]
    fn set_shrink(&mut self, on: bool) {
        self.shrink = on;
    }
    #[inline]
    fn counters(&mut self) -> &mut NetCounters {
        &mut self.counters
    }
}
