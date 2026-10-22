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
    let mut a: Vec<String> = ["-y", "-hide_banner", "-loglevel", "error", "-nostats", "-f", "rawvideo", "-pix_fmt"].iter().map(|s| s.to_string()).collect();
    a.push(if channels == 4 { "bgra64le" } else { "bgr48le" }.into());
    a.extend(["-s:v".into(), format!("{w}x{h}"), "-r".into(), format!("{fps:.8}"), "-i".into(), "pipe:0".into(), "-an".into()]);
    if channels == 4 {
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

pub struct VideoWriter {
    path: PathBuf,
    channels: usize,
    frame_len: usize,
    tx: Option<SyncSender<Vec<u8>>>,
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
        let (tx, rx): (SyncSender<Vec<u8>>, Receiver<Vec<u8>>) = sync_channel(2);
        let err: Shared = Arc::new(Mutex::new(None));
        let e2 = err.clone();
        let thread = std::thread::spawn(move || {
            // loop: SERIAL-REQUIRED — frames go to ffmpeg in order; ends when the sender is dropped
            for buf in rx {
                if let Err(e) = stdin.write_all(&buf) {
                    *e2.lock().unwrap() = Some(format!("ffmpeg writer: {e}"));
                    return;
                }
            }
        });
        Ok(VideoWriter { path: path.to_path_buf(), channels, frame_len: w * h * channels, tx: Some(tx), thread: Some(thread), child: Some(child), err, frames: 0 })
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
        let bytes: Vec<u8> = v.iter().flat_map(|s| s.to_le_bytes()).collect();
        self.tx.as_ref().unwrap().send(bytes).map_err(|_| Error::engine(format!("ffmpeg writer stopped: {}", self.path.display())))?;
        self.frames += n;
        Ok(())
    }
    fn frames(&self) -> usize {
        self.frames
    }
    fn release(&mut self) -> Result<(), Error> {
        self.tx.take();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        let rc = match self.child.take() {
            Some(mut c) => c.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1),
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
        .iter()
        .enumerate()
        .map(|(c, n)| {
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
        let want = "-y -hide_banner -loglevel error -nostats -f rawvideo -pix_fmt bgr48le -s:v 1920x1080 -r 23.97602398 -i pipe:0 -an \
                    -c:v libx264 -preset medium -pix_fmt yuv444p10le -crf 12 -threads 2 -colorspace bt709 -color_primaries bt709 \
                    -color_trc iec61966-2-1 -movflags +write_colr /o/shot_alpha.mp4";
        assert_eq!(a.join(" "), want.split_whitespace().collect::<Vec<_>>().join(" "));
        let c = ffmpeg_args(Path::new("/o/c.mov"), 24.0, 8, 8, &WriterConfig::default(), 4, "linear").join(" ");
        assert!(c.contains("-pix_fmt bgra64le") && c.contains("-c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le -threads 2") && c.contains("-color_trc linear"));
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
