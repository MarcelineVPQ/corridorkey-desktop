//! What a run prints (docs/CLI.md "Progress"): progress, phase and failure lines on stdout in the farm's own words,
//! flushed per line; the human log on stderr. Progress is the engine's own count of frames handed to the writers
//! (its `frames` replies), never an estimate; phases are its `progress` replies.
use ck_core::pipeline::Sink;
use serde_json::{json, Value};
use std::io::Write;
use std::time::Instant;

/// `--progress-format`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    /// both farms' progress lines (`openjd_progress: N` and `PROGRESS: N%`), OpenJD's status and fail lines
    Both,
    /// Open Job Description (AWS Deadline Cloud): `openjd_progress:`, `openjd_status:`, `openjd_fail:`
    OpenJd,
    /// Deadline 10's plugin handlers: `PROGRESS: N%`, `STATUS:`, `ERROR:`
    Deadline,
    /// for people: `45% (45/100 frames)`, the phase, `failed: …`
    Plain,
    /// one JSON object per line: {"event": "progress" | "status" | "fail", …}
    Json,
}

impl Format {
    pub const NAMES: [&'static str; 4] = ["openjd", "deadline", "plain", "json"];

    pub fn parse(s: &str) -> Option<Format> {
        match s {
            "openjd" => Some(Format::OpenJd),
            "deadline" => Some(Format::Deadline),
            "plain" => Some(Format::Plain),
            "json" => Some(Format::Json),
            _ => None,
        }
    }

    /// The lines for `done` of `total` frames written.
    pub fn progress(self, done: usize, total: usize) -> Vec<String> {
        let pct = if total == 0 { 100 } else { done * 100 / total };
        match self {
            Format::Both => vec![format!("openjd_progress: {pct}"), format!("PROGRESS: {pct}%")],
            Format::OpenJd => vec![format!("openjd_progress: {pct}")],
            Format::Deadline => vec![format!("PROGRESS: {pct}%")],
            Format::Plain => vec![format!("{pct}% ({done}/{total} frames)")],
            Format::Json => vec![json!({"event": "progress", "percent": pct, "done": done, "total": total}).to_string()],
        }
    }

    /// The lines for a phase (`loading the models`, `keying: window 3/10 done`).
    pub fn status(self, text: &str) -> Vec<String> {
        match self {
            Format::Both | Format::OpenJd => vec![format!("openjd_status: {text}")],
            Format::Deadline => vec![format!("STATUS: {text}")],
            Format::Plain => vec![text.to_string()],
            Format::Json => vec![json!({"event": "status", "text": text}).to_string()],
        }
    }

    /// The lines before a non-zero exit.
    pub fn fail(self, exit: i32, message: &str) -> Vec<String> {
        let reason = crate::exit::reason(exit);
        let one = message.lines().next().unwrap_or("");
        match self {
            Format::Both | Format::OpenJd => vec![format!("openjd_fail: {one} (exit {exit}, {reason})")],
            Format::Deadline => vec![format!("ERROR: {one} (exit {exit}, {reason})")],
            Format::Plain => vec![format!("failed: {one} (exit {exit}, {reason})")],
            Format::Json => vec![json!({"event": "fail", "exit_code": exit, "reason": reason, "message": message}).to_string()],
        }
    }
}

/// The phase a `progress` reply names, in words.
fn phase(msg: &Value) -> Option<String> {
    let stage = msg.get("stage")?.as_str()?;
    let words = match stage {
        "load" => "loading the models",
        "probe" => "reading the clip",
        "optimize" => "building TensorRT",
        "rvm" => "RVM pass (warm-up frames included)",
        "foundations" => "foundation pass",
        "keying" => "keying",
        other => other,
    };
    Some(match msg.get("detail").and_then(|d| d.as_str()) {
        Some(d) => format!("{words}: {d}"),
        None => words.to_string(),
    })
}

/// How much goes to stderr: `-q` errors only, `-v` the engine's every reply too.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Verbosity {
    Quiet,
    Normal,
    Verbose,
}

/// What the engine told the run, for the report (each the last one sent: an out-of-memory retry's window wins).
#[derive(Clone, Debug, Default)]
pub struct Seen {
    /// the `provider` reply
    pub provider: Option<Value>,
    /// the `memory` reply: the window used
    pub window: Option<Value>,
    /// the `clip` reply
    pub clip: Option<Value>,
    /// seconds from the run's start at which each written frame was reported handed to the writers (in order; frames
    /// reported together share a time: the engine reports at most four times a second)
    pub frame_done_s: Vec<f64>,
}

/// The run's sink: engine replies in, lines out.
pub struct CliSink<'a> {
    fmt: Format,
    verbosity: Verbosity,
    out: &'a mut dyn Write,
    err: &'a mut dyn Write,
    started: Instant,
    last_pct: Option<usize>,
    last_status: Option<String>,
    pub seen: Seen,
}

impl<'a> CliSink<'a> {
    pub fn new(fmt: Format, verbosity: Verbosity, out: &'a mut dyn Write, err: &'a mut dyn Write) -> CliSink<'a> {
        CliSink { fmt, verbosity, out, err, started: Instant::now(), last_pct: None, last_status: None, seen: Seen::default() }
    }

    fn lines(&mut self, lines: Vec<String>) {
        // a closed stdout (the farm's reader gone) ends nothing: the run's result is its exit code
        // loop: NOT-WORTH — one or two lines
        for l in lines {
            let _ = writeln!(self.out, "{l}");
        }
        let _ = self.out.flush();
    }

    /// A phase line (once per change).
    pub fn status(&mut self, text: &str) {
        if self.last_status.as_deref() != Some(text) {
            self.last_status = Some(text.to_string());
            let l = self.fmt.status(text);
            self.lines(l);
        }
    }

    /// The lines before a non-zero exit (and the message on stderr, even with -q).
    pub fn fail(&mut self, exit: i32, message: &str) {
        let _ = writeln!(self.err, "corridorkey: {message}");
        let l = self.fmt.fail(exit, message);
        self.lines(l);
    }

    /// A line for people on stderr (not with -q).
    pub fn note(&mut self, text: &str) {
        if self.verbosity > Verbosity::Quiet {
            let _ = writeln!(self.err, "{text}");
        }
    }

    fn frames(&mut self, done: usize, total: usize) {
        let t = self.started.elapsed().as_secs_f64();
        if done > self.seen.frame_done_s.len() {
            self.seen.frame_done_s.resize(done, t);
        }
        let pct = if total == 0 { 100 } else { done * 100 / total };
        if self.last_pct != Some(pct) {
            self.last_pct = Some(pct);
            let l = self.fmt.progress(done, total);
            self.lines(l);
        }
    }
}

impl Sink for CliSink<'_> {
    fn send(&mut self, msg: Value) {
        if self.verbosity == Verbosity::Verbose {
            let _ = writeln!(self.err, "engine: {msg}");
        }
        match msg.get("type").and_then(|t| t.as_str()) {
            Some("progress") => {
                if let Some(p) = phase(&msg) {
                    self.status(&p);
                }
            }
            Some("frames") => {
                let n = |k: &str| msg.get(k).and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                self.frames(n("done"), n("total"));
            }
            Some("provider") => self.seen.provider = Some(msg),
            Some("memory") => self.seen.window = Some(msg),
            Some("clip") => self.seen.clip = Some(msg),
            _ => {}
        }
    }

    fn log(&mut self, text: &str) {
        // the engine's EXR warning names every surface; here it is --linear (it comes only after a choice: the CLI reads
        // EXR plates scene-linear by default)
        self.note(&text.replace(ck_core::pipeline::EXR_LINEAR_HINT, "For scene-linear HDR EXR plates, pass --linear."));
    }

    fn stop_requested(&mut self) -> bool {
        crate::signals::stopped_by().is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_format_says_progress_in_its_farms_words() {
        assert_eq!(Format::Both.progress(1, 4), ["openjd_progress: 25", "PROGRESS: 25%"]);
        assert_eq!(Format::OpenJd.progress(1, 3), ["openjd_progress: 33"]);
        assert_eq!(Format::Deadline.progress(4, 4), ["PROGRESS: 100%"]);
        assert_eq!(Format::Plain.progress(45, 100), ["45% (45/100 frames)"]);
        let j: Value = serde_json::from_str(&Format::Json.progress(2, 8)[0]).unwrap();
        assert_eq!(j, json!({"event": "progress", "percent": 25, "done": 2, "total": 8}));
        assert_eq!(Format::Both.status("loading the models"), ["openjd_status: loading the models"]);
        assert_eq!(Format::Deadline.status("keying"), ["STATUS: keying"]);
        assert_eq!(
            Format::Both.fail(6, "The graphics card ran out of memory\nmore"),
            ["openjd_fail: The graphics card ran out of memory (exit 6, out-of-graphics-memory)"]
        );
        assert_eq!(Format::Deadline.fail(3, "input not found: /x"), ["ERROR: input not found: /x (exit 3, input)"]);
        let j: Value = serde_json::from_str(&Format::Json.fail(143, "stopped")[0]).unwrap();
        assert_eq!(j, json!({"event": "fail", "exit_code": 143, "reason": "terminated", "message": "stopped"}));
        // loop: NOT-WORTH — four names
        for n in Format::NAMES {
            assert!(Format::parse(n).is_some(), "{n}");
        }
        assert_eq!(Format::parse("nuke"), None);
    }

    #[test]
    fn the_sink_prints_progress_once_per_percent_and_logs_on_stderr() {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let mut s = CliSink::new(Format::Both, Verbosity::Normal, &mut out, &mut err);
        s.send(json!({"type": "progress", "stage": "load"}));
        s.send(json!({"type": "progress", "stage": "load"}));
        s.send(json!({"type": "clip", "width": 320, "height": 200, "fps": 24.0, "frames": 4}));
        s.send(json!({"type": "memory", "hann_chunk": 4, "hann_stride": 2, "low_vram": false, "auto": false}));
        s.send(json!({"type": "provider", "provider": "cpu", "precision": "fp32"}));
        s.send(json!({"type": "progress", "stage": "keying", "p": 0.5, "detail": "window 1/2 done"}));
        s.send(json!({"type": "frames", "done": 1, "total": 4}));
        s.send(json!({"type": "frames", "done": 1, "total": 4}));
        s.send(json!({"type": "frames", "done": 4, "total": 4}));
        s.log("  probed 4 frames");
        s.log(&format!("  [WARNING] EXR input frames are being treated as display-coded and clipped to [0, 1]. {}", ck_core::pipeline::EXR_LINEAR_HINT));
        let seen = s.seen.clone();
        drop(s);
        let out = String::from_utf8(out).unwrap();
        assert_eq!(
            out.lines().collect::<Vec<_>>(),
            [
                "openjd_status: loading the models",
                "openjd_status: keying: window 1/2 done",
                "openjd_progress: 25",
                "PROGRESS: 25%",
                "openjd_progress: 100",
                "PROGRESS: 100%"
            ]
        );
        assert_eq!(
            String::from_utf8(err).unwrap(),
            "  probed 4 frames\n  [WARNING] EXR input frames are being treated as display-coded and clipped to [0, 1]. For scene-linear HDR EXR plates, pass --linear.\n"
        );
        assert_eq!(seen.frame_done_s.len(), 4);
        assert_eq!(seen.window.unwrap()["hann_chunk"], 4);
        assert_eq!(seen.provider.unwrap()["provider"], "cpu");
        assert_eq!(seen.clip.unwrap()["frames"], 4);
    }

    #[test]
    fn quiet_keeps_stderr_to_failures_and_verbose_adds_the_replies() {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let mut s = CliSink::new(Format::OpenJd, Verbosity::Quiet, &mut out, &mut err);
        s.log("a log line");
        s.fail(3, "input not found: /x");
        drop(s);
        assert_eq!(String::from_utf8(err).unwrap(), "corridorkey: input not found: /x\n");
        assert_eq!(String::from_utf8(out).unwrap(), "openjd_fail: input not found: /x (exit 3, input)\n");
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let mut s = CliSink::new(Format::Plain, Verbosity::Verbose, &mut out, &mut err);
        s.send(json!({"type": "frames", "done": 0, "total": 2}));
        drop(s);
        assert!(String::from_utf8(err).unwrap().starts_with("engine: {"));
        assert_eq!(String::from_utf8(out).unwrap(), "0% (0/2 frames)\n");
    }
}
