//! Where a job's frames come from, and the stage-1 windows' sequential readers over them.
//!
//! Each pass reads the clip from its first frame, in order: the RVM prepass, the low-VRAM foundations, the stage-1
//! windows and the low-VRAM stage 2. The engine's frames are the probed clip, decoded (`ClipMeta` is a
//! `FrameSource`); the pipeline's tests hand it frames made in memory.
use crate::clip::ClipMeta;
use crate::decode::{FrameReader, FrameStream, HintReader, Prefetch, Prepped};
use crate::Error;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

/// A job's frames: each `open` reads them again from the first.
pub(crate) trait FrameSource: Sync {
    /// The frames in order; `display_only`: only the display view (the RVM and foundation passes need no more).
    fn open(&self, display_only: bool) -> Result<Box<dyn FrameStream>, Error>;
}

/// The probed clip, decoded (video through ffmpeg, frame folders on the pool).
impl FrameSource for ClipMeta {
    fn open(&self, display_only: bool) -> Result<Box<dyn FrameStream>, Error> {
        let r = FrameReader::open(self)?;
        Ok(Box::new(if display_only { r.display_only() } else { r }))
    }
}

/// Sequential window access to the decoded frames (SequentialVideoWindowReader / ...FrameDirWindowReader).
pub(crate) struct WindowReader {
    pub(crate) reader: Prefetch,
    cache: BTreeMap<usize, Prepped>,
    next: usize,
}

impl WindowReader {
    pub(crate) fn open(frames: &dyn FrameSource) -> Result<WindowReader, Error> {
        Ok(WindowReader { reader: Prefetch::new("frame-decode", frames.open(false)?, 8)?, cache: BTreeMap::new(), next: 0 })
    }
    /// Frames t0..t1 (decoding up to t1); frames before t0 are dropped.
    pub(crate) fn window(&mut self, t0: usize, t1: usize) -> Result<Vec<Prepped>, Error> {
        // loop: SERIAL-REQUIRED — frames decode in order
        while self.next < t1 {
            let f = self.reader.next_frame()?.ok_or_else(|| Error::input(format!("decoded only {} frames", self.next)))?;
            self.cache.insert(self.next, f);
            self.next += 1;
        }
        // loop: HOT-PATH-OK — a window's frames (≤ 80): Arc clones, no pixel copies
        let out = (t0..t1).map(|t| self.cache[&t].clone()).collect();
        self.cache = self.cache.split_off(&t0);
        Ok(out)
    }
}

/// Full hint, read in window order with its own cache.
pub(crate) struct HintWindows {
    reader: HintReader,
    cache: BTreeMap<usize, Arc<Vec<f32>>>,
    next: usize,
}

impl HintWindows {
    pub(crate) fn open(path: &Path, meta: &ClipMeta) -> Result<HintWindows, Error> {
        Ok(HintWindows { reader: HintReader::open(path, meta)?, cache: BTreeMap::new(), next: 0 })
    }
    pub(crate) fn window(&mut self, t0: usize, t1: usize) -> Result<Vec<Arc<Vec<f32>>>, Error> {
        // loop: SERIAL-REQUIRED — hint frames decode in order
        while self.next < t1 {
            let h = self.reader.next_frame()?;
            self.cache.insert(self.next, Arc::new(h));
            self.next += 1;
        }
        // loop: HOT-PATH-OK — a window's hint frames (≤ 80): Arc clones
        let out = (t0..t1).map(|t| self.cache[&t].clone()).collect();
        self.cache = self.cache.split_off(&t0);
        Ok(out)
    }
}
