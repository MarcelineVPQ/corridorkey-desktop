//! Render and hand-off on their own thread, so the graphics card doesn't wait for them.
//!
//! `RenderWorker` takes the job's writers for as long as it lives: stage 2's raw outputs go in (in frame order),
//! the worker renders them (render.rs) and hands the frames to every writer. After each frame it sends back the
//! number of frames every writer has taken (the protocol's `frames`, counted when handed to the writers, as
//! before). The writers go back to the caller's list when the worker is finished or dropped (also on an early
//! error), so the caller can release them and check what was written.
use crate::render::{render, RenderOpts};
use crate::runtime::Data;
use crate::writers::Writer;
use crate::Error;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;
use std::thread::JoinHandle;

pub(crate) type Writers = Vec<(String, Box<dyn Writer>)>;

/// Where the frames go and how they are cut out of the padded model shape.
#[derive(Clone)]
pub(crate) struct Geometry {
    pub(crate) shape: (usize, usize),
    pub(crate) crop: (usize, usize),
    pub(crate) hw: (usize, usize),
}

/// Frames queued between stage 2 and the render thread (each up to 4 x H x W floats).
const QUEUE: usize = 2;

/// What the render thread gives back when it ends: the writers, its failure if any, and its render + hand-off seconds.
type WorkerEnd = (Writers, Result<(), Error>, f64);

pub(crate) struct RenderWorker<'a> {
    home: &'a mut Writers,
    tx: Option<SyncSender<Data<'static>>>,
    /// frames every writer has taken, as the render thread last counted them
    done: Arc<AtomicUsize>,
    /// the count `done()` last returned
    seen: Option<usize>,
    handle: Option<JoinHandle<WorkerEnd>>,
}

impl<'a> RenderWorker<'a> {
    pub(crate) fn start(home: &'a mut Writers, ro: RenderOpts, checker: Vec<f32>, geo: Geometry) -> Result<RenderWorker<'a>, Error> {
        let mut writers = std::mem::take(home);
        let (tx, rx) = sync_channel::<Data<'static>>(QUEUE);
        let done = Arc::new(AtomicUsize::new(0));
        let done2 = done.clone();
        // loop: SERIAL-REQUIRED — the render thread: frames to the writers in order; ends when the sender is dropped or a writer fails
        let handle = crate::ahead::spawn_named("render", move || {
            let mut res = Ok(());
            let mut secs = 0.0;
            // loop: SERIAL-REQUIRED — frames reach the writers in order; ends when the sender is dropped
            for logits in rx {
                let t = std::time::Instant::now();
                // read in stage 2's own type (float16 values converted as they are used, off the card's thread)
                let rendered = match &logits {
                    Data::F16(v) => render(&ro, v, geo.shape, geo.crop, geo.hw, &checker),
                    Data::F32(v) => render(&ro, v, geo.shape, geo.crop, geo.hw, &checker),
                    Data::Bf16(_) | Data::F16Ref(_) | Data::F32Ref(_) => {
                        res = Err(Error::engine("stage 2 logits as bfloat16".into()));
                        break;
                    }
                };
                drop(logits);
                // loop: NOT-WORTH — at most four outputs
                for (name, batch) in rendered {
                    // loop: NOT-WORTH — ≤ four writers per rendered output
                    let r = match writers.iter().position(|(n, _)| n == name) {
                        Some(i) => writers[i].1.write_many(batch, 1),
                        None => Err(Error::engine(format!("no writer for {name}"))),
                    };
                    if let Err(e) = r {
                        res = Err(e);
                        break;
                    }
                }
                secs += t.elapsed().as_secs_f64();
                if res.is_err() {
                    break;
                }
                // loop: NOT-WORTH — ≤ four writers per frame
                let n = writers.iter().map(|(_, w)| w.frames()).min().unwrap_or(0);
                done2.store(n, Ordering::Relaxed);
            }
            (writers, res, secs)
        })?;
        Ok(RenderWorker { home, tx: Some(tx), done, seen: None, handle: Some(handle) })
    }

    /// Queue one frame's stage-2 output (blocks while `QUEUE` frames wait). If the worker stopped, its own
    /// failure (a writer's error) is returned and the writers are back with the caller.
    pub(crate) fn send(&mut self, logits: Data<'static>) -> Result<(), Error> {
        match &self.tx {
            Some(tx) if tx.send(logits).is_ok() => Ok(()),
            // loop: SERIAL-REQUIRED — the render thread already stopped (its channel closed) [bounded: it has ended or is ending]
            _ => Err(self.join().err().unwrap_or_else(|| Error::engine("the render thread stopped".into()))),
        }
    }

    /// The latest frame count every writer has taken, if it changed since the last call.
    pub(crate) fn done(&mut self) -> Option<usize> {
        let n = self.done.load(Ordering::Relaxed);
        if n == 0 || self.seen == Some(n) {
            return None;
        }
        self.seen = Some(n);
        Some(n)
    }

    /// Wait for every queued frame, give the writers back; the render thread's seconds, or its failure.
    pub(crate) fn finish(mut self) -> Result<f64, Error> {
        // loop: SERIAL-REQUIRED — waits for the queued frames (≤ QUEUE = 2) to be rendered and handed off [bounded: the sender is dropped first, so the thread ends after them]
        self.join()
    }

    fn join(&mut self) -> Result<f64, Error> {
        self.tx = None;
        let Some(h) = self.handle.take() else { return Ok(0.0) };
        // loop: SERIAL-REQUIRED — joins the render thread after dropping its sender [bounded: ≤ 2 queued frames, then the thread ends]
        // a panic there: "the render thread panicked: <what it said>" (its writers were dropped with it, which stops
        // their encoders)
        let (writers, res, secs) = crate::ahead::joined(h)?;
        *self.home = writers;
        res.map(|_| secs)
    }
}

impl Drop for RenderWorker<'_> {
    fn drop(&mut self) {
        // loop: NOT-WORTH — drop path: the same join [bounded: the sender is dropped first]
        let _ = self.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::writers::Batch;

    /// Counts frames; fails on frame `fail_at` (0 = never).
    struct Counting {
        frames: usize,
        fail_at: usize,
    }

    impl Writer for Counting {
        fn path(&self) -> &std::path::Path {
            std::path::Path::new("/dev/null")
        }
        fn write_many(&mut self, _batch: Batch, n: usize) -> Result<(), Error> {
            if self.fail_at > 0 && self.frames + 1 == self.fail_at {
                return Err(Error::input("disk full".into()));
            }
            self.frames += n;
            Ok(())
        }
        fn frames(&self) -> usize {
            self.frames
        }
        fn release(&mut self) -> Result<(), Error> {
            Ok(())
        }
    }

    fn opts() -> RenderOpts {
        RenderOpts {
            alpha: true,
            fg: false,
            checker: false,
            cutout: false,
            despill: 0.5,
            cutout_linear: false,
            exr: false,
            adjust: Default::default(),
            color_out: None,
            out_linear: true,
        }
    }

    #[test]
    fn frame_counts_and_seconds_come_back() {
        let mut writers: Writers = vec![("alpha".into(), Box::new(Counting { frames: 0, fail_at: 0 }))];
        let geo = Geometry { shape: (2, 2), crop: (0, 0), hw: (2, 2) };
        let mut w = RenderWorker::start(&mut writers, opts(), vec![0.5; 4], geo).unwrap();
        assert_eq!(w.done(), None);
        // loop: NOT-WORTH — three frames
        for _ in 0..3 {
            w.send(Data::F32(vec![0.0; 16])).unwrap();
        }
        let secs = w.finish().unwrap();
        assert!(secs >= 0.0);
        assert_eq!(writers[0].1.frames(), 3);
    }

    #[test]
    fn a_writer_failure_comes_back_with_the_writers() {
        let mut writers: Writers = vec![("alpha".into(), Box::new(Counting { frames: 0, fail_at: 2 }))];
        let geo = Geometry { shape: (2, 2), crop: (0, 0), hw: (2, 2) };
        let e = {
            let mut w = RenderWorker::start(&mut writers, opts(), vec![0.5; 4], geo).unwrap();
            let mut err = None;
            // loop: NOT-WORTH — up to five frames
            for _ in 0..5 {
                if let Err(e) = w.send(Data::F32(vec![0.0; 16])) {
                    err = Some(e);
                    break;
                }
            }
            match err {
                Some(e) => e,
                None => w.finish().unwrap_err(),
            }
        };
        assert_eq!(e.message, "disk full");
        assert_eq!(writers.len(), 1);
        assert_eq!(writers[0].1.frames(), 1);
    }
}
