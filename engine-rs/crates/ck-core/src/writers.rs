//! The output writers (video_io.ThreadedVideoWriter, ExrSequenceWriter): each encodes on its own thread with
//! a queue of at most 2 batches. The runtime's ffmpeg command and file names; the codec is the job's (VideoCodec).
use crate::clip::FrameNumbers;
use crate::Error;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

/// The video codec of a job's video outputs (backlog row 26; the protocol's `video_codec`). None of them carries an
/// alpha channel (ffmpeg's DNxHR encoder has none and stops at 10 bits): a video cutout is premultiplied colour and
/// its alpha is the matte output, which a video job with a cutout always writes (render.rs, job.rs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VideoCodec {
    /// libx264 `-qp 0`, High 4:4:4 Predictive, yuv444p10le: only the 10-bit YCbCr rounding is lost
    H264Lossless,
    /// ffmpeg's dnxhd encoder, profile dnxhr_444, 10-bit 4:4:4, in a .mov
    Dnxhr444,
    /// libx264 CRF 12 (the job's `crf` / `pix_fmt`): the original's output, small files
    H264Crf12,
}

impl VideoCodec {
    /// the protocol's names, in the order the app offers them
    pub const NAMES: [&'static str; 3] = ["h264-lossless", "dnxhr444", "h264-crf12"];

    pub fn parse(s: &str) -> Option<VideoCodec> {
        match s {
            "h264-lossless" => Some(VideoCodec::H264Lossless),
            "dnxhr444" => Some(VideoCodec::Dnxhr444),
            "h264-crf12" => Some(VideoCodec::H264Crf12),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            VideoCodec::H264Lossless => "h264-lossless",
            VideoCodec::Dnxhr444 => "dnxhr444",
            VideoCodec::H264Crf12 => "h264-crf12",
        }
    }

    /// The container: MP4 for H.264; MOV for DNxHR. ffmpeg's MXF muxer refuses frame rates outside the broadcast
    /// set (measured with ffmpeg 8.0.1: 12.5 and 29.97 fps wrote nothing) and a frame folder can have any rate; MOV
    /// takes any rate and size, carries the colour tags, and Resolve and Nuke read DNxHR in it.
    pub fn ext(self) -> &'static str {
        match self {
            VideoCodec::Dnxhr444 => "mov",
            _ => "mp4",
        }
    }
}

/// DNxHR 444's pixel format (README, Quality, "Video outputs": measured against the other one the encoder takes).
const DNXHR_PIX_FMT: &str = "yuv444p10le";

/// ffmpeg settings for the video path (video_io.WriterConfig; the desktop engine's threads=2). `crf`, `pix_fmt` and
/// `bitrate` apply to `H264Crf12` only, `preset` to both H.264 codecs.
#[derive(Clone, Debug, PartialEq)]
pub struct WriterConfig {
    pub codec: VideoCodec,
    pub crf: i64,
    pub preset: String,
    pub pix_fmt: String,
    pub bitrate: Option<String>,
    pub threads: usize,
}

impl Default for WriterConfig {
    fn default() -> Self {
        WriterConfig { codec: VideoCodec::H264Crf12, crf: 12, preset: "medium".into(), pix_fmt: "yuv444p10le".into(), bitrate: None, threads: 2 }
    }
}

/// The ffmpeg arguments ThreadedVideoWriter builds (after the binary name): the render's 16-bit BGR frames in
/// (bgr48le: no 8-bit step), the job's codec out.
pub(crate) fn ffmpeg_args(path: &Path, fps: f64, w: usize, h: usize, cfg: &WriterConfig, color_trc: &str) -> Vec<String> {
    // loop: NOT-WORTH — ffmpeg arguments, once per writer
    let s = |v: &[&str]| -> Vec<String> { v.iter().map(|x| x.to_string()).collect() };
    let mut a = s(&["-y", "-hide_banner", "-loglevel", "error", "-nostats", "-f", "rawvideo", "-pix_fmt", "bgr48le"]);
    a.extend(["-s:v".into(), format!("{w}x{h}"), "-r".into(), format!("{fps:.8}")]);
    // The colour tags on the input too: ffmpeg 8 keeps a raw input's (unset) primaries and transfer and drops the
    // output-side ones below (measured: every output read color_transfer=unknown, color_primaries=unknown; a linear
    // cutout wasn't tagged linear). Tagged here, they reach the file; the pixels are the same (frame md5 equal).
    a.extend(["-colorspace".into(), "bt709".into(), "-color_primaries".into(), "bt709".into(), "-color_trc".into(), color_trc.into()]);
    a.extend(["-i".into(), "pipe:0".into(), "-an".into()]);
    match cfg.codec {
        // x264 is lossless at quantiser 0 (CRF 0 is lossless only at 8 bits); High 4:4:4 Predictive is the profile
        // that allows it
        VideoCodec::H264Lossless => a.extend(s(&["-c:v", "libx264", "-preset", &cfg.preset, "-profile:v", "high444", "-pix_fmt", "yuv444p10le", "-qp", "0"])),
        VideoCodec::Dnxhr444 => a.extend(s(&["-c:v", "dnxhd", "-profile:v", "dnxhr_444", "-pix_fmt", DNXHR_PIX_FMT])),
        VideoCodec::H264Crf12 => {
            a.extend(s(&["-c:v", "libx264", "-preset", &cfg.preset, "-pix_fmt", &cfg.pix_fmt]));
            match &cfg.bitrate {
                Some(b) => a.extend(["-b:v".into(), b.clone()]),
                None => a.extend(["-crf".into(), cfg.crf.to_string()]),
            }
        }
    }
    a.extend([
        "-threads".into(),
        cfg.threads.max(1).to_string(),
        "-colorspace".into(),
        "bt709".into(),
        "-color_primaries".into(),
        "bt709".into(),
        "-color_trc".into(),
        color_trc.into(),
        "-movflags".into(),
        "+write_colr".into(),
        path.to_string_lossy().into_owned(),
    ]);
    a
}

/// A batch handed to a writer: NHWC frames, BGR(A) (or 1-channel) order.
pub enum Batch {
    U16(Vec<u16>),
    F32(Vec<f32>),
}

pub(crate) trait Writer: Send {
    /// The output's path (a file, or the EXR folder).
    fn path(&self) -> &Path;
    /// Hand over `n` frames; counted as soon as they are queued (the protocol's `frames`).
    fn write_many(&mut self, batch: Batch, n: usize) -> Result<(), Error>;
    fn frames(&self) -> usize;
    /// Finish: drain the queue, close the encoder, report its failure.
    fn release(&mut self) -> Result<(), Error>;
}

/// The first failure of a writer's thread, with its code (a full disk is `output`, not `engine`).
type Shared = Arc<Mutex<Option<Error>>>;

// The video writers hand ffmpeg the samples' bytes as they are in memory (bgr48le): little-endian hosts only.
#[cfg(not(target_endian = "little"))]
compile_error!("the ffmpeg writers and temp files assume a little-endian host");

/// How long a writer may take to finish its file once the last frame is queued (measured: 0.5 s after the last
/// frame at 1280x1080; x264's lookahead at UHD takes seconds, not minutes).
pub(crate) const FINISH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// The last lines of ffmpeg's stderr a writer keeps for its error message.
const TAIL_LINES: usize = 6;

/// How long a failed writer waits for ffmpeg to exit (and say why) before it is killed.
const FAIL_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

pub(crate) struct VideoWriter {
    path: PathBuf,
    channels: usize,
    frame_len: usize,
    tx: Option<SyncSender<Vec<u16>>>,
    thread: Option<JoinHandle<()>>,
    child: Option<Child>,
    err: Shared,
    frames: usize,
    /// reads ffmpeg's stderr: each line goes on to the engine's stderr (as before) and the last TAIL_LINES are kept
    log: Option<JoinHandle<()>>,
    tail: Arc<Mutex<std::collections::VecDeque<String>>>,
    /// the failure with what ffmpeg said, once composed (asked again, the same error)
    said: Option<Error>,
}

/// Read a child's stderr to its end: every line on to ours, the last TAIL_LINES kept in `tail`.
fn keep_tail(name: &str, err: std::process::ChildStderr, tail: Arc<Mutex<std::collections::VecDeque<String>>>) -> Result<JoinHandle<()>, Error> {
    // loop: SERIAL-REQUIRED — one reader per ffmpeg writer; ends when ffmpeg exits (its stderr closes)
    crate::ahead::spawn_named(name, move || {
        use std::io::BufRead;
        let mut r = std::io::BufReader::new(err);
        let mut buf = Vec::new();
        // loop: SERIAL-REQUIRED — ffmpeg's error lines in order [bounded: ends at the pipe's end, when ffmpeg exits or is killed]
        loop {
            buf.clear();
            match r.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let line = String::from_utf8_lossy(&buf).trim_end().to_string();
            if line.is_empty() {
                continue;
            }
            eprintln!("{line}");
            let mut t = tail.lock().unwrap();
            if t.len() == TAIL_LINES {
                t.pop_front();
            }
            t.push_back(line);
        }
    })
}

/// A writer's failure with what ffmpeg said: `Output` in words when ffmpeg couldn't write the file (a full disk, a
/// folder it may not write to), else the failure with ffmpeg's last lines added.
pub(crate) fn with_ffmpeg_tail(base: Error, path: &Path, tail: &[String]) -> Error {
    if tail.is_empty() {
        return base;
    }
    let said = tail.join(" | ");
    // loop: NOT-WORTH — ≤ TAIL_LINES lines of one failed writer
    match tail.iter().find_map(|l| crate::write_failure_text(l)) {
        Some(why) if base.code == crate::ErrorCode::Engine => {
            Error::new(crate::ErrorCode::Output, format!("Can't write {}: {why} (ffmpeg: {said})", path.display()))
        }
        _ => Error { message: format!("{}; ffmpeg said: {said}", base.message), ..base },
    }
}

impl VideoWriter {
    pub(crate) fn new(path: &Path, fps: f64, w: usize, h: usize, cfg: &WriterConfig, color_trc: &str) -> Result<VideoWriter, Error> {
        // every video output is 3-channel BGR (the alpha as three equal channels; the cutout premultiplied, render.rs)
        let channels = 3;
        let mut child = Command::new("ffmpeg")
            .args(ffmpeg_args(path, fps, w, h, cfg, color_trc))
            .stdin(Stdio::piped())
            .stdout(Stdio::null()) // stdout is the engine's protocol channel
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| Error::assets(format!("ffmpeg binary not found or not runnable: {e}")))?;
        let tail = Arc::new(Mutex::new(std::collections::VecDeque::new()));
        let log = match child.stderr.take() {
            Some(s) => Some(keep_tail("ffmpeg-log", s, tail.clone())?),
            None => None,
        };
        let mut stdin = child.stdin.take().unwrap();
        let (tx, rx): (SyncSender<Vec<u16>>, Receiver<Vec<u16>>) = sync_channel(2);
        let err: Shared = Arc::new(Mutex::new(None));
        let e2 = err.clone();
        // loop: SERIAL-REQUIRED — the ffmpeg feeding thread: frames in order; ends when the queue closes or ffmpeg's pipe fails
        let thread = crate::ahead::spawn_named("ffmpeg-feed", move || {
            // loop: SERIAL-REQUIRED — frames go to ffmpeg in order; ends when the sender is dropped
            for buf in rx {
                // the samples' own bytes: little-endian on the hosts this runs on (bgr48le)
                if let Err(e) = stdin.write_all(bytemuck::cast_slice(&buf)) {
                    *e2.lock().unwrap() = Some(Error::engine(format!("ffmpeg writer: {e}")));
                    return;
                }
            }
        })?;
        Ok(VideoWriter {
            path: path.to_path_buf(),
            channels,
            frame_len: w * h * channels,
            tx: Some(tx),
            thread: Some(thread),
            child: Some(child),
            err,
            frames: 0,
            log,
            tail,
            said: None,
        })
    }

    /// `base` with what ffmpeg said: ffmpeg is given FAIL_WAIT to exit (then killed) so its stderr is complete, and
    /// the composed error is kept, so `release` reports the same.
    fn ffmpeg_failed(&mut self, base: Error) -> Error {
        if let Some(e) = self.said.clone() {
            return e;
        }
        if let Some(mut c) = self.child.take() {
            // loop: SERIAL-REQUIRED — a failed ffmpeg exiting, FAIL_WAIT 5 s, then killed
            let _ = crate::proc::wait_timeout(&mut c, FAIL_WAIT);
        }
        if let Some(l) = self.log.take() {
            // loop: SERIAL-REQUIRED — joins the stderr reader [bounded: ffmpeg has exited or was killed, so its stderr is closed]
            let _ = crate::ahead::joined(l);
        }
        // loop: NOT-WORTH — ≤ TAIL_LINES lines, once per failed writer
        let tail: Vec<String> = self.tail.lock().unwrap().iter().cloned().collect();
        let e = with_ffmpeg_tail(base, &self.path, &tail);
        *self.err.lock().unwrap() = Some(e.clone());
        self.said = Some(e.clone());
        e
    }
}

impl Writer for VideoWriter {
    fn path(&self) -> &Path {
        &self.path
    }
    fn write_many(&mut self, batch: Batch, n: usize) -> Result<(), Error> {
        let failed = self.err.lock().unwrap().clone();
        if let Some(e) = failed {
            return Err(self.ffmpeg_failed(e));
        }
        let Batch::U16(v) = batch else { return Err(Error::engine("video writer expects uint16 frames".into())) };
        if v.len() != n * self.frame_len {
            return Err(Error::engine(format!("expected {n} frames of {} channels", self.channels)));
        }
        if self.tx.as_ref().unwrap().send(v).is_err() {
            return Err(self.ffmpeg_failed(Error::engine(format!("ffmpeg writer stopped: {}", self.path.display()))));
        }
        self.frames += n;
        Ok(())
    }
    fn frames(&self) -> usize {
        self.frames
    }
    fn release(&mut self) -> Result<(), Error> {
        // closing the queue ends the feeding thread once ffmpeg has taken what is queued; ffmpeg then finishes
        // the file. Both within FINISH_TIMEOUT, else ffmpeg is killed (the blocked write then fails, the thread ends).
        self.tx.take();
        let end = std::time::Instant::now() + FINISH_TIMEOUT;
        let mut timed_out = false;
        if let Some(t) = self.thread.take() {
            // loop: SERIAL-REQUIRED — waits for one feeding thread, a poll every 50 ms [bounded: FINISH_TIMEOUT, then ffmpeg is killed]
            while !t.is_finished() && std::time::Instant::now() < end {
                // loop: SERIAL-REQUIRED — the finish poll's 50 ms sleep (not a spin), until FINISH_TIMEOUT
                std::thread::sleep(crate::proc::POLL);
            }
            if !t.is_finished() {
                timed_out = true;
                if let Some(c) = self.child.as_mut() {
                    let _ = c.kill();
                }
            }
            // loop: SERIAL-REQUIRED — joins the feeding thread [bounded: it finished, or ffmpeg was just killed so its blocked write fails]
            if let Err(e) = crate::ahead::joined(t) {
                self.err.lock().unwrap().get_or_insert(e);
            }
        }
        let rc = match self.child.take() {
            // loop: SERIAL-REQUIRED — ffmpeg finishing the file, within FINISH_TIMEOUT 300 s
            Some(mut c) => match crate::proc::wait_timeout(&mut c, end.saturating_duration_since(std::time::Instant::now())) {
                Ok(Some(s)) if !timed_out => s.code().unwrap_or(-1),
                Ok(_) => {
                    let e = Error::engine(format!("ffmpeg writer did not finish within {} s: {}", FINISH_TIMEOUT.as_secs(), self.path.display()));
                    return Err(self.ffmpeg_failed(e));
                }
                Err(_) => -1,
            },
            None => 0,
        };
        let failed = self.err.lock().unwrap().clone();
        if let Some(e) = failed {
            return Err(self.ffmpeg_failed(e));
        }
        if rc != 0 {
            return Err(self.ffmpeg_failed(Error::engine(format!("ffmpeg writer failed with exit code {rc}: {}", self.path.display()))));
        }
        if let Some(l) = self.log.take() {
            // loop: SERIAL-REQUIRED — joins the stderr reader [bounded: ffmpeg has exited, so its stderr is closed]
            let _ = crate::ahead::joined(l);
        }
        Ok(())
    }
}

impl Drop for VideoWriter {
    fn drop(&mut self) {
        self.tx.take();
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            // loop: NOT-WORTH — drop path: reaps ffmpeg after kill() [bounded: a killed child exits]
            let _ = c.wait();
        }
    }
}

/// EXR pixel type: half (float16, values clamped to +-65504 so they stay finite) or float.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ExrType {
    Half,
    Float,
}

pub(crate) struct ExrWriter {
    dir: PathBuf,
    channels: usize,
    frame_len: usize,
    tx: Option<SyncSender<(usize, usize, Vec<f32>)>>,
    thread: Option<JoinHandle<()>>,
    err: Shared,
    frames: usize,
}

/// One EXR frame: channels R, G, B (+A) from BGR(A) data as cv2.imwrite writes them, or a matte alone as `A` (the
/// studio convention: Nuke and OpenImageIO read it as alpha; cv2.imwrite's `Y` reads as grey RGB, backlog row 30 b);
/// ZIP compression.
pub(crate) fn write_exr(path: &Path, w: usize, h: usize, channels: usize, nhwc: &[f32], ty: ExrType) -> Result<(), crate::Error> {
    use exr::prelude::*;
    let names: &[&str] = match channels {
        1 => &["A"],
        3 => &["B", "G", "R"],
        4 => &["B", "G", "R", "A"],
        _ => return Err(crate::Error::engine(format!("{channels} channels"))),
    };
    let chans: Vec<AnyChannel<FlatSamples>> = names
        // loop: HOT-PATH-OK — EXR only: ≤ four channels per frame, each one pass (the exr crate takes owned channel buffers)
        .iter()
        .enumerate()
        .map(|(c, n)| {
            // loop: HOT-PATH-OK — EXR only: one channel's samples (a strided read), per frame
            let vals = (0..w * h).map(move |i| nhwc[i * channels + c]);
            let samples = match ty {
                ExrType::Half => FlatSamples::F16(vals.map(|v| half::f16::from_f32(v.clamp(-65504.0, 65504.0))).collect()),
                ExrType::Float => FlatSamples::F32(vals.collect()),
            };
            AnyChannel::new(*n, samples)
        })
        .collect();
    let layer = Layer::new(
        (w, h),
        LayerAttributes::default(),
        Encoding { compression: Compression::ZIP16, blocks: Blocks::ScanLines, line_order: LineOrder::Increasing },
        // loop: NOT-WORTH — ≤ four channels per frame
        AnyChannels::sort(chans.into_iter().collect()),
    );
    Image::from_layer(layer).write().to_file(path).map_err(|e| match e {
        exr::error::Error::Io(io) => crate::Error::write("an EXR frame", path, &io),
        other => crate::Error::engine(format!("{}: {other}", path.display())),
    })
}

impl ExrWriter {
    /// Frames are named `<frame_name>.<number>.exr` with the job's frame numbers (clip.rs FrameNumbers).
    pub(crate) fn new(dir: &Path, w: usize, h: usize, channels: usize, ty: ExrType, frame_name: &str, numbers: Arc<FrameNumbers>) -> Result<ExrWriter, Error> {
        std::fs::create_dir_all(dir).map_err(|e| Error::write("the output folder", dir, &e))?;
        let (tx, rx) = sync_channel::<(usize, usize, Vec<f32>)>(2);
        let err: Shared = Arc::new(Mutex::new(None));
        let (e2, d2, name) = (err.clone(), dir.to_path_buf(), frame_name.to_string());
        // loop: SERIAL-REQUIRED — the EXR writing thread: batches in order; ends when the queue closes or a write fails
        let thread = crate::ahead::spawn_named("exr-write", move || {
            // loop: SERIAL-REQUIRED — batches in order; ends when the sender is dropped
            for (idx0, n, data) in rx {
                let len = w * h * channels;
                // loop: HOT-PATH-OK — the frames of one batch (1 at the default batch size)
                for j in 0..n {
                    let Some(file) = numbers.file_name(&name, idx0 + j) else {
                        *e2.lock().unwrap() = Some(Error::engine(format!("EXR write failed: frame {} has no frame number", idx0 + j)));
                        return;
                    };
                    let p = d2.join(file);
                    if let Err(e) = write_exr(&p, w, h, channels, &data[j * len..(j + 1) * len], ty) {
                        *e2.lock().unwrap() = Some(Error { message: format!("EXR write failed: {}", e.message), ..e });
                        return;
                    }
                }
            }
        })?;
        Ok(ExrWriter { dir: dir.to_path_buf(), channels, frame_len: w * h * channels, tx: Some(tx), thread: Some(thread), err, frames: 0 })
    }
}

impl Writer for ExrWriter {
    fn path(&self) -> &Path {
        &self.dir
    }
    fn write_many(&mut self, batch: Batch, n: usize) -> Result<(), Error> {
        if let Some(e) = self.err.lock().unwrap().clone() {
            return Err(e);
        }
        let Batch::F32(v) = batch else { return Err(Error::engine("EXR writer expects float32 frames".into())) };
        if v.len() != n * self.frame_len {
            return Err(Error::engine(format!("expected {n} frames of {} channels", self.channels)));
        }
        self.tx.as_ref().unwrap().send((self.frames, n, v)).map_err(|_| Error::engine(format!("EXR writer stopped: {}", self.dir.display())))?;
        self.frames += n;
        Ok(())
    }
    fn frames(&self) -> usize {
        self.frames
    }
    fn release(&mut self) -> Result<(), Error> {
        self.tx.take();
        if let Some(t) = self.thread.take() {
            // loop: SERIAL-REQUIRED — joins the EXR thread after closing its queue [bounded: ≤ 2 queued frames, each one local file write]
            if let Err(e) = crate::ahead::joined(t) {
                self.err.lock().unwrap().get_or_insert(e);
            }
        }
        match self.err.lock().unwrap().clone() {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffmpeg_command_matches_the_runtime() {
        let a = ffmpeg_args(Path::new("/o/shot_alpha.mp4"), 23.976023976023978, 1920, 1080, &WriterConfig::default(), "iec61966-2-1");
        let want = "-y -hide_banner -loglevel error -nostats -f rawvideo -pix_fmt bgr48le -s:v 1920x1080 -r 23.97602398 \
                    -colorspace bt709 -color_primaries bt709 -color_trc iec61966-2-1 -i pipe:0 -an \
                    -c:v libx264 -preset medium -pix_fmt yuv444p10le -crf 12 -threads 2 -colorspace bt709 -color_primaries bt709 \
                    -color_trc iec61966-2-1 -movflags +write_colr /o/shot_alpha.mp4";
        assert_eq!(a.join(" "), want.split_whitespace().collect::<Vec<_>>().join(" "));
        let with = |codec| WriterConfig { codec, ..WriterConfig::default() };
        let l = ffmpeg_args(Path::new("/o/c.mp4"), 24.0, 8, 8, &with(VideoCodec::H264Lossless), "linear").join(" ");
        assert!(l.contains("-pix_fmt bgr48le") && l.contains("-c:v libx264 -preset medium -profile:v high444 -pix_fmt yuv444p10le -qp 0 -threads 2"), "{l}");
        assert!(!l.contains("-crf") && l.contains("-color_trc linear"), "{l}");
        let d = ffmpeg_args(Path::new("/o/c.mov"), 24.0, 8, 8, &with(VideoCodec::Dnxhr444), "iec61966-2-1").join(" ");
        assert!(d.contains("-c:v dnxhd -profile:v dnxhr_444 -pix_fmt yuv444p10le -threads 2") && !d.contains("-crf") && !d.contains("-preset"), "{d}");
    }

    #[test]
    fn codec_names_round_trip() {
        // loop: NOT-WORTH — three names
        for n in VideoCodec::NAMES {
            assert_eq!(VideoCodec::parse(n).unwrap().name(), n);
        }
        assert_eq!(VideoCodec::parse("prores"), None);
        assert_eq!((VideoCodec::H264Lossless.ext(), VideoCodec::Dnxhr444.ext(), VideoCodec::H264Crf12.ext()), ("mp4", "mov", "mp4"));
    }

    #[test]
    fn the_error_carries_what_ffmpeg_said() {
        let p = Path::new("/o/a_alpha.mp4");
        let base = Error::engine("ffmpeg writer failed with exit code 1: /o/a_alpha.mp4".into());
        let e = with_ffmpeg_tail(base.clone(), p, &["[out#0/mp4] Error opening output /o/a_alpha.mp4: No space left on device".into()]);
        assert_eq!(e.code, crate::ErrorCode::Output);
        assert!(e.message.starts_with("Can't write /o/a_alpha.mp4: the disk is full (ffmpeg: "), "{}", e.message);
        let e = with_ffmpeg_tail(base.clone(), p, &["Unknown encoder 'libx264'".into(), "Error selecting an encoder".into()]);
        assert_eq!(e.code, crate::ErrorCode::Engine);
        assert!(e.message.ends_with("; ffmpeg said: Unknown encoder 'libx264' | Error selecting an encoder"), "{}", e.message);
        assert_eq!(with_ffmpeg_tail(base.clone(), p, &[]), base);
    }

    #[test]
    #[cfg(unix)]
    fn a_folder_ffmpeg_cant_write_is_an_output_error_with_its_words() {
        if Command::new("ffmpeg").arg("-version").output().is_err() {
            eprintln!("no ffmpeg: skipped");
            return;
        }
        // an output path inside a file (not a folder): ffmpeg can't open it and says so on stderr
        let dir = std::env::temp_dir().join(format!("ck-wfail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("file"), b"").unwrap();
        let p = dir.join("file").join("a.mp4");
        let mut wr = VideoWriter::new(&p, 24.0, 16, 8, &WriterConfig::default(), "iec61966-2-1").unwrap();
        let mut err = None;
        // loop: NOT-WORTH — up to 50 tiny frames, until ffmpeg's pipe closes
        for _ in 0..50 {
            if let Err(e) = wr.write_many(Batch::U16(vec![30000; 16 * 8 * 3]), 1) {
                err = Some(e);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let e = match err {
            Some(e) => e,
            None => wr.release().unwrap_err(),
        };
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(e.message.contains("ffmpeg said: ") || e.message.contains("(ffmpeg: "), "{}", e.message);
        assert!(e.message.to_lowercase().contains("not a directory"), "{}", e.message);
        // asked again, the same error (the tail is added once)
        assert_eq!(wr.release().unwrap_err(), e);
    }

    #[test]
    fn video_files_carry_their_colour_tags() {
        if Command::new("ffprobe").arg("-version").output().is_err() {
            eprintln!("no ffmpeg: skipped");
            return;
        }
        let dir = std::env::temp_dir().join(format!("ck-colr-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut tags = Vec::new();
        // loop: NOT-WORTH — three test files
        for (codec, trc) in [(VideoCodec::H264Crf12, "iec61966-2-1"), (VideoCodec::H264Lossless, "linear"), (VideoCodec::Dnxhr444, "iec61966-2-1")] {
            let p = dir.join(format!("{}.{}", codec.name(), codec.ext()));
            // DNxHR 444 needs a frame of at least 256 x 120 (its macroblock layout)
            let (w, h) = if codec == VideoCodec::Dnxhr444 { (256, 128) } else { (16, 8) };
            let mut wr = VideoWriter::new(&p, 24.0, w, h, &WriterConfig { codec, ..WriterConfig::default() }, trc).unwrap();
            wr.write_many(Batch::U16(vec![30000; w * h * 3 * 2]), 2).unwrap();
            wr.release().unwrap();
            let out = Command::new("ffprobe")
                .args([
                    "-v",
                    "error",
                    "-select_streams",
                    "v:0",
                    "-show_entries",
                    "stream=codec_name,profile,pix_fmt,color_transfer,color_primaries,color_space",
                    "-of",
                    "csv=p=0",
                ])
                .arg(&p)
                .output()
                .unwrap();
            tags.push(String::from_utf8_lossy(&out.stdout).trim().to_string());
        }
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(
            tags,
            vec![
                "h264,High 4:4:4 Predictive,yuv444p10le,bt709,iec61966-2-1,bt709",
                "h264,High 4:4:4 Predictive,yuv444p10le,bt709,linear,bt709",
                "dnxhd,DNXHR 444,yuv444p10le,bt709,iec61966-2-1,bt709"
            ]
        );
    }

    #[test]
    fn exr_frames_carry_the_source_numbers() {
        // a plate's frames 65, 66, 67 (04_5d_00065.exr ...): the outputs keep them, name.NNNNN.exr (backlog row 30 a)
        let dir = std::env::temp_dir().join(format!("ck-exr-names-{}", std::process::id()));
        let src = crate::clip::Source::Frames((65..68).map(|i| PathBuf::from(format!("/p/04_5d_{i:05}.exr"))).collect());
        let numbers = Arc::new(FrameNumbers::for_source(&src, 3));
        let mut wr = ExrWriter::new(&dir, 2, 1, 1, ExrType::Half, "04_5d_alpha", numbers).unwrap();
        wr.write_many(Batch::F32(vec![0.5; 2 * 2]), 2).unwrap();
        wr.write_many(Batch::F32(vec![0.5; 2]), 1).unwrap();
        wr.release().unwrap();
        // loop: NOT-WORTH — three test files
        let mut names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(names, ["04_5d_alpha.00065.exr", "04_5d_alpha.00066.exr", "04_5d_alpha.00067.exr"]);
    }

    #[test]
    fn the_matte_alone_is_channel_a() {
        use exr::prelude::*;
        let dir = std::env::temp_dir().join(format!("ck-exr-a-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("m.exr");
        let matte = [0.0, 0.25, 0.5, 1.0];
        write_exr(&p, 2, 2, 1, &matte, ExrType::Half).unwrap();
        let img = read_all_flat_layers_from_file(&p).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        let ch = &img.layer_data[0].channel_data.list;
        // loop: NOT-WORTH — one channel
        let names: Vec<String> = ch.iter().map(|c| c.name.to_string()).collect();
        assert_eq!(names, ["A"]);
        // loop: NOT-WORTH — four samples
        let vals: Vec<f32> = ch[0].sample_data.values_as_f32().collect();
        assert_eq!(vals, matte);
    }

    #[test]
    fn exr_round_trip() {
        let dir = std::env::temp_dir().join(format!("ck-exr-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("f.exr");
        // BGR data: blue 0.25, green 0.5, red 2.0 (HDR survives)
        write_exr(&p, 2, 1, 3, &[0.25, 0.5, 2.0, 0.25, 0.5, 2.0], ExrType::Float).unwrap();
        let img = crate::decode::read_image_rgb(&p, false).unwrap();
        assert_eq!(img.data, vec![2.0, 2.0, 0.5, 0.5, 0.25, 0.25]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
