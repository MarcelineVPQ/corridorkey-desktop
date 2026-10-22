//! The output writers (video_io.ThreadedVideoWriter, ExrSequenceWriter): each encodes on its own thread with
//! a queue of at most 2 batches. Same ffmpeg commands, codecs, pixel formats and file names as the runtime.
use crate::Error;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

/// ffmpeg settings for the video path (video_io.WriterConfig; the desktop engine's threads=2).
#[derive(Clone, Debug, PartialEq)]
pub struct WriterConfig {
    pub codec: String,
    pub crf: i64,
    pub preset: String,
    pub pix_fmt: String,
    pub bitrate: Option<String>,
    pub threads: usize,
}

impl Default for WriterConfig {
    fn default() -> Self {
        WriterConfig { codec: "libx264".into(), crf: 12, preset: "medium".into(), pix_fmt: "yuv444p10le".into(), bitrate: None, threads: 2 }
    }
}

/// The ffmpeg arguments ThreadedVideoWriter builds (after the binary name).
pub fn ffmpeg_args(path: &Path, fps: f64, w: usize, h: usize, cfg: &WriterConfig, channels: usize, color_trc: &str) -> Vec<String> {
    // loop: NOT-WORTH — ffmpeg arguments, once per writer
    let mut a: Vec<String> = ["-y", "-hide_banner", "-loglevel", "error", "-nostats", "-f", "rawvideo", "-pix_fmt"].iter().map(|s| s.to_string()).collect();
    a.push(if channels == 4 { "bgra64le" } else { "bgr48le" }.into());
    a.extend(["-s:v".into(), format!("{w}x{h}"), "-r".into(), format!("{fps:.8}")]);
    // The colour tags on the input too: ffmpeg 8 keeps a raw input's (unset) primaries and transfer and drops the
    // output-side ones below (measured: every output read color_transfer=unknown, color_primaries=unknown; a linear
    // cutout wasn't tagged linear). Tagged here, they reach the file; the pixels are the same (frame md5 equal).
    a.extend(["-colorspace".into(), "bt709".into(), "-color_primaries".into(), "bt709".into(), "-color_trc".into(), color_trc.into()]);
    a.extend(["-i".into(), "pipe:0".into(), "-an".into()]);
    if channels == 4 {
        // loop: NOT-WORTH — ffmpeg arguments, once per writer
        a.extend(["-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le"].iter().map(|s| s.to_string()));
    } else {
        a.extend(["-c:v".into(), cfg.codec.clone(), "-preset".into(), cfg.preset.clone(), "-pix_fmt".into(), cfg.pix_fmt.clone()]);
        match &cfg.bitrate {
            Some(b) => a.extend(["-b:v".into(), b.clone()]),
            None => a.extend(["-crf".into(), cfg.crf.to_string()]),
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

pub trait Writer: Send {
    /// The output's path (a file, or the EXR folder).
    fn path(&self) -> &Path;
    /// Hand over `n` frames; counted as soon as they are queued (the protocol's `frames`).
    fn write_many(&mut self, batch: Batch, n: usize) -> Result<(), Error>;
    fn frames(&self) -> usize;
    /// Finish: drain the queue, close the encoder, report its failure.
    fn release(&mut self) -> Result<(), Error>;
}

type Shared = Arc<Mutex<Option<String>>>;

// The video writers hand ffmpeg the samples' bytes as they are in memory (bgr48le): little-endian hosts only.
#[cfg(not(target_endian = "little"))]
compile_error!("the ffmpeg writers and temp files assume a little-endian host");

/// How long a writer may take to finish its file once the last frame is queued (measured: 0.5 s after the last
/// frame at 1280x1080; x264's lookahead at UHD takes seconds, not minutes).
pub const FINISH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

pub struct VideoWriter {
    path: PathBuf,
    channels: usize,
    frame_len: usize,
    tx: Option<SyncSender<Vec<u16>>>,
    thread: Option<JoinHandle<()>>,
    child: Option<Child>,
    err: Shared,
    frames: usize,
}

impl VideoWriter {
    pub fn new(path: &Path, fps: f64, w: usize, h: usize, cfg: &WriterConfig, channels: usize, color_trc: &str) -> Result<VideoWriter, Error> {
        let mut child = Command::new("ffmpeg")
            .args(ffmpeg_args(path, fps, w, h, cfg, channels, color_trc))
            .stdin(Stdio::piped())
            .stdout(Stdio::null()) // stdout is the engine's protocol channel
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| Error::assets(format!("ffmpeg binary not found or not runnable: {e}")))?;
        let mut stdin = child.stdin.take().unwrap();
        let (tx, rx): (SyncSender<Vec<u16>>, Receiver<Vec<u16>>) = sync_channel(2);
        let err: Shared = Arc::new(Mutex::new(None));
        let e2 = err.clone();
        // loop: SERIAL-REQUIRED — the ffmpeg feeding thread: frames in order; ends when the queue closes or ffmpeg's pipe fails
        let thread = std::thread::spawn(move || {
            // loop: SERIAL-REQUIRED — frames go to ffmpeg in order; ends when the sender is dropped
            for buf in rx {
                // the samples' own bytes: little-endian on the hosts this runs on (bgr48le / bgra64le)
                if let Err(e) = stdin.write_all(bytemuck::cast_slice(&buf)) {
                    *e2.lock().unwrap() = Some(format!("ffmpeg writer: {e}"));
                    return;
                }
            }
        });
        Ok(VideoWriter {
            path: path.to_path_buf(),
            channels,
            frame_len: w * h * channels,
            tx: Some(tx),
            thread: Some(thread),
            child: Some(child),
            err,
            frames: 0,
        })
    }
}

impl Writer for VideoWriter {
    fn path(&self) -> &Path {
        &self.path
    }
    fn write_many(&mut self, batch: Batch, n: usize) -> Result<(), Error> {
        if let Some(e) = self.err.lock().unwrap().clone() {
            return Err(Error::engine(e));
        }
        let Batch::U16(v) = batch else { return Err(Error::engine("video writer expects uint16 frames".into())) };
        if v.len() != n * self.frame_len {
            return Err(Error::engine(format!("expected {n} frames of {} channels", self.channels)));
        }
        self.tx.as_ref().unwrap().send(v).map_err(|_| Error::engine(format!("ffmpeg writer stopped: {}", self.path.display())))?;
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
            let _ = t.join();
        }
        let rc = match self.child.take() {
            // loop: SERIAL-REQUIRED — ffmpeg finishing the file, within FINISH_TIMEOUT 300 s (this pass: it had no deadline)
            Some(mut c) => match crate::proc::wait_timeout(&mut c, end.saturating_duration_since(std::time::Instant::now())) {
                Ok(Some(s)) if !timed_out => s.code().unwrap_or(-1),
                Ok(_) => return Err(Error::engine(format!("ffmpeg writer did not finish within {} s: {}", FINISH_TIMEOUT.as_secs(), self.path.display()))),
                Err(_) => -1,
            },
            None => 0,
        };
        if let Some(e) = self.err.lock().unwrap().clone() {
            return Err(Error::engine(e));
        }
        if rc != 0 {
            return Err(Error::engine(format!("ffmpeg writer failed with exit code {rc}: {}", self.path.display())));
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
pub enum ExrType {
    Half,
    Float,
}

pub struct ExrWriter {
    dir: PathBuf,
    channels: usize,
    frame_len: usize,
    tx: Option<SyncSender<(usize, usize, Vec<f32>)>>,
    thread: Option<JoinHandle<()>>,
    err: Shared,
    frames: usize,
}

/// One EXR frame as cv2.imwrite writes it: channels R, G, B (+A) from BGR(A) data, or Y; ZIP compression.
pub fn write_exr(path: &Path, w: usize, h: usize, channels: usize, nhwc: &[f32], ty: ExrType) -> Result<(), String> {
    use exr::prelude::*;
    let names: &[&str] = match channels {
        1 => &["Y"],
        3 => &["B", "G", "R"],
        4 => &["B", "G", "R", "A"],
        _ => return Err(format!("{channels} channels")),
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
    Image::from_layer(layer).write().to_file(path).map_err(|e| format!("{}: {e}", path.display()))
}

impl ExrWriter {
    pub fn new(dir: &Path, w: usize, h: usize, channels: usize, ty: ExrType, frame_name: &str) -> Result<ExrWriter, Error> {
        std::fs::create_dir_all(dir).map_err(|e| Error::engine(format!("{}: {e}", dir.display())))?;
        let (tx, rx) = sync_channel::<(usize, usize, Vec<f32>)>(2);
        let err: Shared = Arc::new(Mutex::new(None));
        let (e2, d2, name) = (err.clone(), dir.to_path_buf(), frame_name.to_string());
        // loop: SERIAL-REQUIRED — the EXR writing thread: batches in order; ends when the queue closes or a write fails
        let thread = std::thread::spawn(move || {
            // loop: SERIAL-REQUIRED — batches in order; ends when the sender is dropped
            for (idx0, n, data) in rx {
                let len = w * h * channels;
                // loop: HOT-PATH-OK — the frames of one batch (1 at the default batch size)
                for j in 0..n {
                    let p = d2.join(format!("{name}_{:06}.exr", idx0 + j));
                    if let Err(e) = write_exr(&p, w, h, channels, &data[j * len..(j + 1) * len], ty) {
                        *e2.lock().unwrap() = Some(format!("EXR write failed: {e}"));
                        return;
                    }
                }
            }
        });
        Ok(ExrWriter { dir: dir.to_path_buf(), channels, frame_len: w * h * channels, tx: Some(tx), thread: Some(thread), err, frames: 0 })
    }
}

impl Writer for ExrWriter {
    fn path(&self) -> &Path {
        &self.dir
    }
    fn write_many(&mut self, batch: Batch, n: usize) -> Result<(), Error> {
        if let Some(e) = self.err.lock().unwrap().clone() {
            return Err(Error::engine(e));
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
            let _ = t.join();
        }
        match self.err.lock().unwrap().clone() {
            Some(e) => Err(Error::engine(e)),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffmpeg_command_matches_the_runtime() {
        let a = ffmpeg_args(Path::new("/o/shot_alpha.mp4"), 23.976023976023978, 1920, 1080, &WriterConfig::default(), 3, "iec61966-2-1");
        let want = "-y -hide_banner -loglevel error -nostats -f rawvideo -pix_fmt bgr48le -s:v 1920x1080 -r 23.97602398 \
                    -colorspace bt709 -color_primaries bt709 -color_trc iec61966-2-1 -i pipe:0 -an \
                    -c:v libx264 -preset medium -pix_fmt yuv444p10le -crf 12 -threads 2 -colorspace bt709 -color_primaries bt709 \
                    -color_trc iec61966-2-1 -movflags +write_colr /o/shot_alpha.mp4";
        assert_eq!(a.join(" "), want.split_whitespace().collect::<Vec<_>>().join(" "));
        let c = ffmpeg_args(Path::new("/o/c.mov"), 24.0, 8, 8, &WriterConfig::default(), 4, "linear").join(" ");
        assert!(
            c.contains("-pix_fmt bgra64le") && c.contains("-c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le -threads 2") && c.contains("-color_trc linear")
        );
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
        // loop: NOT-WORTH — two test files
        for (name, ch, trc) in [("a.mp4", 3, "iec61966-2-1"), ("c.mov", 4, "linear")] {
            let p = dir.join(name);
            let mut wr = VideoWriter::new(&p, 24.0, 16, 8, &WriterConfig::default(), ch, trc).unwrap();
            wr.write_many(Batch::U16(vec![30000; 16 * 8 * ch * 2]), 2).unwrap();
            wr.release().unwrap();
            let out = Command::new("ffprobe")
                .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_transfer,color_primaries,color_space", "-of", "csv=p=0"])
                .arg(&p)
                .output()
                .unwrap();
            tags.push(String::from_utf8_lossy(&out.stdout).trim().to_string());
        }
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(tags, vec!["bt709,iec61966-2-1,bt709", "bt709,linear,bt709"]);
    }

    #[test]
    fn exr_round_trip() {
        let dir = std::env::temp_dir().join(format!("ck-exr-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("f.exr");
        // BGR data: blue 0.25, green 0.5, red 2.0 (HDR survives)
        write_exr(&p, 2, 1, 3, &[0.25, 0.5, 2.0, 0.25, 0.5, 2.0], ExrType::Float).unwrap();
        let img = crate::decode::read_image_rgb(&p).unwrap();
        assert_eq!(img.data, vec![2.0, 2.0, 0.5, 0.5, 0.25, 0.25]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
