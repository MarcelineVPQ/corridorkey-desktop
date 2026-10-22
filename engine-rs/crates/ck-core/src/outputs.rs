//! Render and hand-off on their own thread, so the graphics card doesn't wait for them.
//!
//! `RenderWorker` takes the job's writers for as long as it lives: stage 2's raw outputs go in (in frame order),
//! the worker renders them (render.rs) and hands the frames to every writer. After each frame it sends back the
//! number of frames every writer has taken (the protocol's `frames`, counted when handed to the writers, as
//! before). The writers go back to the caller's list when the worker is finished or dropped (also on an early
//! error), so the caller can release them and check what was written.
use crate::render::{render, RenderOpts};
use crate::writers::Writer;
use crate::Error;
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TryRecvError};
use std::thread::JoinHandle;

pub type Writers = Vec<(String, Box<dyn Writer>)>;

/// Where the frames go and how they are cut out of the padded model shape.
#[derive(Clone)]
pub struct Geometry {
    pub shape: (usize, usize),
    pub crop: (usize, usize),
    pub hw: (usize, usize),
}

/// Frames queued between stage 2 and the render thread (each up to 4 x H x W floats).
const QUEUE: usize = 2;

pub struct RenderWorker<'a> {
    home: &'a mut Writers,
    tx: Option<SyncSender<Vec<f32>>>,
    done_rx: Receiver<usize>,
    handle: Option<JoinHandle<(Writers, Result<(), Error>)>>,
    /// render + hand-off seconds on the worker (reported by `finish`)
    pub seconds: std::sync::Arc<std::sync::Mutex<f64>>,
}

impl<'a> RenderWorker<'a> {
    pub fn start(home: &'a mut Writers, ro: RenderOpts, checker: Vec<f32>, geo: Geometry) -> RenderWorker<'a> {
        let mut writers = std::mem::take(home);
        let (tx, rx) = sync_channel::<Vec<f32>>(QUEUE);
        let (done_tx, done_rx) = sync_channel::<usize>(1 << 16);
        let seconds = std::sync::Arc::new(std::sync::Mutex::new(0.0));
        let secs = seconds.clone();
        let handle = std::thread::spawn(move || {
            let mut res = Ok(());
            // loop: SERIAL-REQUIRED — frames reach the writers in order; ends when the sender is dropped
            for logits in rx {
                let t = std::time::Instant::now();
                let rendered = render(&ro, &logits, geo.shape, geo.crop, geo.hw, &checker);
                drop(logits);
                // loop: NOT-WORTH — at most four outputs
                for (name, batch) in rendered {
                    let r = match writers.iter().position(|(n, _)| n == name) {
                        Some(i) => writers[i].1.write_many(batch, 1),
                        None => Err(Error::engine(format!("no writer for {name}"))),
                    };
                    if let Err(e) = r {
                        res = Err(e);
                        break;
                    }
                }
                *secs.lock().unwrap() += t.elapsed().as_secs_f64();
                if res.is_err() {
                    break;
                }
                let done = writers.iter().map(|(_, w)| w.frames()).min().unwrap_or(0);
                let _ = done_tx.send(done);
            }
            (writers, res)
        });
        RenderWorker { home, tx: Some(tx), done_rx, handle: Some(handle), seconds }
    }

    /// Queue one frame's stage-2 output (blocks while `QUEUE` frames wait). If the worker stopped, its own
    /// failure (a writer's error) is returned and the writers are back with the caller.
    pub fn send(&mut self, logits: Vec<f32>) -> Result<(), Error> {
        match &self.tx {
            Some(tx) if tx.send(logits).is_ok() => Ok(()),
            _ => Err(self.join().err().unwrap_or_else(|| Error::engine("the render thread stopped".into()))),
        }
    }

    /// The latest frame count every writer has taken, if it changed since the last call.
    pub fn done(&mut self) -> Option<usize> {
        let mut last = None;
        // loop: NOT-WORTH — drains what is queued (at most a few counts)
        loop {
            match self.done_rx.try_recv() {
                Ok(n) => last = Some(n),
                Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => return last,
            }
        }
    }

    /// Wait for every queued frame, give the writers back, return the worker's failure if any.
    pub fn finish(mut self) -> Result<(), Error> {
        self.join()
    }

    fn join(&mut self) -> Result<(), Error> {
        self.tx = None;
        let Some(h) = self.handle.take() else { return Ok(()) };
        match h.join() {
            Ok((writers, res)) => {
                *self.home = writers;
                res
            }
            Err(_) => Err(Error::engine("the render thread panicked".into())),
        }
    }
}

impl Drop for RenderWorker<'_> {
    fn drop(&mut self) {
        let _ = self.join();
    }
}
