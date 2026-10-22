//! What a job's input is (video_io.probe_video_meta / probe_frame_dir_meta, raw_clip_name, frame_paths,
//! none_path): native size, the padded model shape (128 px quantum), frame count and rate.
use crate::image::{ceil_to_multiple, center_pad, Pad};
use crate::Error;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const SHAPE_QUANTUM: usize = 128;

#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    Video(PathBuf),
    /// frame paths in order (num_frames applied)
    Frames(Vec<PathBuf>),
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClipMeta {
    pub source: Source,
    pub fps: f64,
    /// native (= output = model at model_scale 1.0) height, width
    pub h: usize,
    pub w: usize,
    /// padded model shape
    pub shape_h: usize,
    pub shape_w: usize,
    pub pad: Pad,
    pub num_frames: usize,
    /// frame folders of scene-linear EXRs (frame_dir_linear)
    pub exr_linear: bool,
}

impl ClipMeta {
    fn with_shape(source: Source, fps: f64, h: usize, w: usize, num_frames: usize, exr_linear: bool) -> ClipMeta {
        let (shape_h, shape_w) = (ceil_to_multiple(h, SHAPE_QUANTUM), ceil_to_multiple(w, SHAPE_QUANTUM));
        ClipMeta { source, fps, h, w, shape_h, shape_w, pad: center_pad(h, w, shape_h, shape_w), num_frames, exr_linear }
    }
    pub fn is_frames(&self) -> bool {
        matches!(self.source, Source::Frames(_))
    }
}

/// video_io.none_path: "", none, null, off, false, - mean no path.
pub fn none_path(p: Option<&str>) -> Option<&str> {
    let p = p?;
    match p.trim().to_lowercase().as_str() {
        "" | "none" | "null" | "off" | "false" | "-" => None,
        _ => Some(p),
    }
}

/// video_io.raw_clip_name: the file stem, or the parent folder's name for input/frames/rgb.
pub fn raw_clip_name(path: &str) -> String {
    let norm = normpath(path);
    let p = Path::new(&norm);
    let base = p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let name = splitext(&base);
    if ["input", "frames", "rgb"].contains(&name.to_lowercase().as_str()) {
        let parent = p.parent().and_then(|q| q.file_name()).map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        if !parent.is_empty() {
            return parent;
        }
    }
    name
}

/// os.path.splitext's stem: a leading dot is not an extension.
fn splitext(base: &str) -> String {
    let trimmed = base.trim_start_matches('.');
    match trimmed.rfind('.') {
        Some(i) => base[..base.len() - trimmed.len() + i].to_string(),
        None => base.to_string(),
    }
}

/// os.path.normpath for the cases a clip path has (trailing slashes, `.` and `..`).
fn normpath(path: &str) -> String {
    let abs = path.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    // loop: NOT-WORTH — the components of one path
    for c in path.split('/') {
        match c {
            "" | "." => {}
            ".." if parts.last().is_some_and(|l| *l != "..") => {
                parts.pop();
            }
            ".." if abs => {}
            _ => parts.push(c),
        }
    }
    let j = parts.join("/");
    if abs {
        format!("/{j}")
    } else if j.is_empty() {
        ".".into()
    } else {
        j
    }
}

/// video_io.frame_paths: *.exr, *.png, *.jpg, *.jpeg directly in the folder (case-sensitive, as glob on
/// Linux), sorted by path.
pub fn frame_paths(dir: &Path) -> Result<Vec<PathBuf>, Error> {
    let mut out: Vec<String> = Vec::new();
    let rd = std::fs::read_dir(dir).map_err(|e| Error::input(format!("{}: {e}", dir.display())))?;
    // loop: HOT-PATH-OK — one pass over the folder's entries
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        // loop: NOT-WORTH — four extensions per file name, once per probe
        let ok = [".exr", ".png", ".jpg", ".jpeg"].iter().any(|x| name.ends_with(x) && name.len() > x.len() && !name.starts_with('.'));
        if ok && e.path().is_file() {
            out.push(e.path().to_string_lossy().into_owned());
        }
    }
    out.sort();
    // loop: NOT-WORTH — the folder's file names, once per probe
    Ok(out.into_iter().map(PathBuf::from).collect())
}

/// What ffprobe says about the first video stream.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct VideoProbe {
    pub w: usize,
    pub h: usize,
    pub fps: f64,
    pub frames: usize,
}

fn rational(s: &str) -> f64 {
    match s.split_once('/') {
        Some((a, b)) => {
            let (a, b): (f64, f64) = (a.trim().parse().unwrap_or(0.0), b.trim().parse().unwrap_or(0.0));
            if b == 0.0 {
                0.0
            } else {
                a / b
            }
        }
        None => s.trim().parse().unwrap_or(0.0),
    }
}

/// OpenCV's reading of an ffprobe answer (cap_ffmpeg get_fps / get_total_frames): the average frame rate,
/// else the real base rate, else 24 (probe_video_meta's `or 24.0`); nb_frames, else
/// round(duration * fps); a 90/270 degree rotation swaps width and height (both auto-rotate).
pub fn read_probe(json: &serde_json::Value) -> Result<VideoProbe, Error> {
    let st = json["streams"].get(0).ok_or_else(|| Error::input("no video stream".into()))?;
    let num = |v: &serde_json::Value| -> f64 {
        match v {
            serde_json::Value::String(s) => s.parse().unwrap_or(0.0),
            serde_json::Value::Number(n) => n.as_f64().unwrap_or(0.0),
            _ => 0.0,
        }
    };
    let (mut w, mut h) = (num(&st["width"]) as usize, num(&st["height"]) as usize);
    let mut fps = rational(st["avg_frame_rate"].as_str().unwrap_or("0/0"));
    if fps < 1e-6 {
        fps = rational(st["r_frame_rate"].as_str().unwrap_or("0/0"));
    }
    if fps < 1e-6 {
        fps = 24.0;
    }
    let mut frames = num(&st["nb_frames"]) as usize;
    if frames == 0 {
        let mut dur = num(&json["format"]["duration"]);
        if dur < 1e-6 {
            dur = num(&st["duration"]);
        }
        frames = (dur * fps + 0.5).floor().max(0.0) as usize;
    }
    let rot = st["side_data_list"]
        .as_array()
        // loop: NOT-WORTH — a stream's side data (a few entries), once per probe
        .and_then(|l| l.iter().find_map(|d| d.get("rotation").map(num)))
        .or_else(|| st["tags"].get("rotate").map(num))
        .unwrap_or(0.0);
    if (rot.abs().round() as i64) % 180 == 90 {
        std::mem::swap(&mut w, &mut h);
    }
    if w == 0 || h == 0 {
        return Err(Error::input("the video stream has no size".into()));
    }
    Ok(VideoProbe { w, h, fps, frames })
}

/// ffprobe's deadline.
pub const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

pub fn ffprobe(path: &Path) -> Result<VideoProbe, Error> {
    let mut cmd = Command::new("ffprobe");
    cmd.args(["-v", "error", "-select_streams", "v:0", "-show_entries"])
        .arg("stream=width,height,avg_frame_rate,r_frame_rate,nb_frames,duration:stream_tags=rotate:stream_side_data=rotation:format=duration")
        .args(["-of", "json"])
        .arg(path);
    // a local file answers in well under a second; a stalled mount or device doesn't hold the job
    // loop: SERIAL-REQUIRED — one ffprobe per clip, PROBE_TIMEOUT 120 s (added in this pass; it had no deadline)
    let out = crate::proc::output_timeout(&mut cmd, PROBE_TIMEOUT).map_err(|e| {
        if e.starts_with("no answer") {
            Error::input(format!("ffprobe on {}: {e}", path.display()))
        } else {
            Error::assets(format!("ffprobe could not run: {e}"))
        }
    })?;
    if !out.status.success() {
        return Err(Error::input(format!("Could not open video: {} ({})", path.display(), String::from_utf8_lossy(&out.stderr).trim())));
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| Error::input(format!("ffprobe output: {e}")))?;
    read_probe(&v)
}

/// probe_video_meta at native resolution, start "begin": the first `num_frames` frames (all when <= 0).
pub fn probe_video(path: &Path, num_frames: i64) -> Result<ClipMeta, Error> {
    let p = ffprobe(path)?;
    let n = if num_frames <= 0 { p.frames } else { (num_frames as usize).min(p.frames) };
    if n == 0 {
        return Err(Error::input(format!("{}: no frames", path.display())));
    }
    Ok(ClipMeta::with_shape(Source::Video(path.to_path_buf()), p.fps, p.h, p.w, n, false))
}

/// probe_frame_dir_meta: the folder's frames at `fps`; the size comes from the first frame.
pub fn probe_frame_dir(dir: &Path, num_frames: i64, fps: f64, exr_linear: bool) -> Result<ClipMeta, Error> {
    let mut paths = frame_paths(dir)?;
    if paths.is_empty() {
        return Err(Error::input(format!("No frames found under {}", dir.display())));
    }
    if num_frames > 0 {
        paths.truncate(num_frames as usize);
    }
    let (h, w) = crate::decode::image_size(&paths[0])?;
    let n = paths.len();
    Ok(ClipMeta::with_shape(Source::Frames(paths), fps, h, w, n, exr_linear))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_names() {
        assert_eq!(raw_clip_name("/clips/shot.mp4"), "shot");
        assert_eq!(raw_clip_name("/clips/shot01/rgb/"), "shot01");
        assert_eq!(raw_clip_name("/clips/shot01/Frames"), "shot01");
        assert_eq!(raw_clip_name("/clips/a.b.mov"), "a.b");
        assert_eq!(raw_clip_name("/clips/.hidden"), ".hidden");
        assert_eq!(raw_clip_name("clips/../x/take.mov"), "take");
    }

    #[test]
    fn none_paths() {
        assert_eq!(none_path(Some(" None ")), None);
        assert_eq!(none_path(Some("-")), None);
        assert_eq!(none_path(Some("/a.png")), Some("/a.png"));
        assert_eq!(none_path(None), None);
    }

    #[test]
    fn probe_reading() {
        let v = serde_json::json!({"streams":[{"width":960,"height":720,"avg_frame_rate":"24000/1001","r_frame_rate":"24000/1001","nb_frames":"349"}],"format":{"duration":"14.5"}});
        let p = read_probe(&v).unwrap();
        assert_eq!((p.w, p.h, p.frames), (960, 720, 349));
        assert!((p.fps - 23.976023976023978).abs() < 1e-12);
        let v = serde_json::json!({"streams":[{"width":1920,"height":1080,"avg_frame_rate":"0/0","r_frame_rate":"25/1","side_data_list":[{"rotation":-90}]}],"format":{"duration":"2.0"}});
        let p = read_probe(&v).unwrap();
        assert_eq!((p.w, p.h, p.frames, p.fps), (1080, 1920, 50, 25.0));
    }

    #[test]
    fn shape_and_pad() {
        let m = ClipMeta::with_shape(Source::Frames(vec![]), 24.0, 200, 320, 8, false);
        assert_eq!((m.shape_h, m.shape_w), (256, 384));
        assert_eq!(m.pad, Pad { l: 32, r: 32, t: 28, b: 28 });
    }
}
