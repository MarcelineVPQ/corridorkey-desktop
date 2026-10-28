//! The command line's words (docs/CLI.md): subcommands like git's, GNU long options, the short ones farm tools and
//! renderers already use (`-F` Nuke's frames, `-s` / `-e` Blender's start and end, `-o`, `-t`, `-v`, `-q`).
//! Every run option of the engine (ck-core job.rs, docs/ENGINE_PROTOCOL.md) has a flag here (`RUN_OPTIONS`), except
//! `num_frames`, `start_mode` and `seed`: they pick a preview sample of a video in the app; on a farm `--frames` picks
//! the frames (a `--job` file that sets them is refused, saying so).
use clap::{Arg, ArgAction, Command};

/// How a flag becomes its run option's value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// a text (a path, a name)
    Text,
    /// a number, checked by the engine as the protocol's own option (its range, a finite value)
    Number,
    /// a switch that sets the option true
    On,
    /// a switch that sets the option false
    Off,
}

/// (flag, run option, kind, value name, help) for every run option a flag maps to one to one.
pub const RUN_OPTIONS: [(&str, &str, Kind, &str, &str); 30] = [
    ("hint", "hint_first_frame", Kind::Text, "FILE", "first-frame matte (a PNG's alpha, an EXR's A), for the shot's first frame"),
    ("hint-video", "hint_video", Kind::Text, "PATH", "a hint matte for every frame: a video or a frame folder"),
    ("hint-quality", "hint_quality", Kind::Number, "0-1", "trust in the hint [default: 0.95]"),
    ("no-carry-hint", "carry_hint", Kind::Off, "", "don't carry each window's matte into the next as a hint"),
    ("carry-hint-quality", "carry_hint_quality", Kind::Number, "0-1", "trust in the carried hint [default: 0.95]"),
    ("low-vram", "low_vram", Kind::On, "", "one phase's networks at a time (less graphics memory, slower)"),
    ("format", "output_format", Kind::Text, "exr|video", "EXR sequences, or videos (whole shots only) [default: exr]"),
    ("datatype", "exr_dtype", Kind::Text, "half|float", "EXR pixel type [default: half]"),
    ("despill", "despill_strength", Kind::Number, "0-1", "despill strength [default: 0.5]"),
    ("cutout-linear", "cutout_linear", Kind::On, "", "a video cutout in linear light"),
    ("fps", "frame_dir_fps", Kind::Number, "FPS", "a frame folder's rate, for video outputs [default: 24]"),
    ("linear", "frame_dir_linear", Kind::On, "", "read a frame folder scene-linear [default: when its first frame is EXR]"),
    ("no-linear", "frame_dir_linear", Kind::Off, "", "read a frame folder display-coded, clipped to 0-1 [default: when its first frame isn't EXR]"),
    ("model-scale", "model_scale", Kind::Number, "S", "run the networks at S times the plate's size, above 0 up to 2 [default: 1]"),
    ("brightness", "linear_brightness", Kind::Number, "G", "linear gain before keying (video inputs) [default: 1]"),
    ("contrast", "linear_contrast", Kind::Number, "C", "linear contrast before keying (video inputs) [default: 1]"),
    ("contrast-pivot", "linear_contrast_pivot", Kind::Number, "P", "the contrast's pivot [default: 0.18]"),
    ("codec", "video_codec", Kind::Text, "NAME", "video outputs: h264-crf12, h264-lossless or dnxhr444 [default: h264-crf12]"),
    ("crf", "crf", Kind::Number, "N", "video outputs: x264's CRF [default: 12]"),
    ("preset", "preset", Kind::Text, "NAME", "video outputs: x264's preset [default: medium]"),
    ("pix-fmt", "pix_fmt", Kind::Text, "FMT", "video outputs: the pixel format [default: yuv444p10le]"),
    ("tensorrt", "tensorrt", Kind::On, "", "TensorRT (build its range first: corridorkey prepare --tensorrt-size WxH)"),
    ("no-tensorrt-build", "tensorrt_build", Kind::Off, "", "never build TensorRT inside the job: a range not built yet runs on CUDA"),
    ("max-vram", "vram_budget_gb", Kind::Number, "GB", "graphics memory this job may use [default: what is free]"),
    ("ocio", "color_config", Kind::Text, "CONFIG", "OCIO config: a path or an ocio:// name [default: $OCIO, else the ACES studio config]"),
    ("input-colorspace", "input_colorspace", Kind::Text, "NAME", "the plates' colour space (EXR and image sequences)"),
    ("output-colorspace", "output_colorspace", Kind::Text, "NAME", "the EXR outputs' colour space [default: the input's]"),
    ("input-bit-depth", "input_bit_depth", Kind::Text, "8|16", "8 reads as CorridorKey 2.0 does; 16 keeps a deep source's bits [default: 8]"),
    ("preroll", "preroll", Kind::Number, "N", "warm-up frames keyed before the range and never written [default: 0]"),
    ("tail", "tail", Kind::Number, "N", "frames keyed after the range and never written [default: 0]"),
];

/// The other run options' flags (for messages: the engine names an option, the user typed a flag).
pub const OTHER_OPTIONS: [(&str, &str); 5] =
    [("outputs", "--outputs"), ("hann_chunk", "--window"), ("hann_stride", "--window"), ("frame_start", "--frames"), ("frame_end", "--frames")];

/// An engine message about a run option, in the command line's words: the option's name becomes its flag.
pub fn in_flag_words(message: &str) -> String {
    // loop: NOT-WORTH — ~35 option names, once per failed request
    let flag = RUN_OPTIONS
        .iter()
        .map(|(f, k, ..)| (*k, format!("--{f}")))
        .chain(OTHER_OPTIONS.iter().map(|(k, f)| (*k, f.to_string())))
        .find(|(k, _)| message.starts_with(k) && !message[k.len()..].starts_with(|c: char| c.is_alphanumeric() || c == '_'));
    match flag {
        Some((k, f)) => format!("{f}{}", &message[k.len()..]),
        None => message.to_string(),
    }
}

/// `-v` / `-q`, `--progress-format`, `--report`.
fn reporting(c: Command) -> Command {
    c.arg(Arg::new("verbose").short('v').long("verbose").action(ArgAction::SetTrue).help("the engine's every reply on stderr too"))
        .arg(Arg::new("quiet").short('q').long("quiet").action(ArgAction::SetTrue).conflicts_with("verbose").help("stderr: failures only"))
        .arg(
            Arg::new("progress-format")
                .long("progress-format")
                .value_name("openjd|deadline|plain|json")
                .value_parser(crate::progress::Format::NAMES)
                .help("progress lines on stdout [default: both openjd_progress: N and PROGRESS: N%]"),
        )
        .arg(Arg::new("report").long("report").value_name("FILE.json").help("write the run as JSON (docs/CLI.md \"Report\"), however it ends"))
}

/// The engine's runtime: models, ONNX Runtime, device, card, threads.
fn runtime(c: Command) -> Command {
    c.arg(Arg::new("models").long("models").value_name("DIR").help("the ONNX model set's folder [env: CK_ENGINE_MODELS]"))
        .arg(Arg::new("ort").long("ort").value_name("LIB").help("ONNX Runtime's library (libonnxruntime.so / onnxruntime.dll) [env: CK_ENGINE_ORT]"))
        .arg(
            Arg::new("device")
                .long("device")
                .value_name("auto|cuda|cpu|coreml|migraphx")
                .help("auto: the graphics card; cuda: NVIDIA; migraphx: AMD (Linux); cpu: ONNX Runtime's CPU provider (slow); coreml: macOS [default: auto]"),
        )
        .arg(
            Arg::new("gpu")
                .long("gpu")
                .value_name("N|UUID")
                .help("the card: an index in CUDA's order or its GPU-/MIG- UUID [env: CUDA_VISIBLE_DEVICES, CUE_GPU_CORES]"),
        )
        .arg(
            Arg::new("threads")
                .short('t')
                .long("threads")
                .value_name("N")
                .value_parser(clap::value_parser!(u32))
                .help("CPU threads per network (0: ONNX Runtime's choice)"),
        )
}

/// `render`'s arguments, which `verify` shares (re-run the render line with `verify` to check its frames).
fn job_args(c: Command) -> Command {
    let mut c = c
        .arg(Arg::new("clip").value_name("INPUT").help("the clip: a video, a frame folder or a plate.####.exr pattern"))
        .arg(Arg::new("input").short('i').long("input").value_name("INPUT").conflicts_with("clip").help("the clip (as INPUT)"))
        .arg(
            Arg::new("output")
                .short('o')
                .long("output")
                .value_name("DIR|PATTERN")
                .help("a folder, or one file per frame: key.####.exr, key.%04d.exr, key.$F4.exr"),
        )
        .arg(
            Arg::new("frames")
                .short('F')
                .long("frames")
                .value_name("SPEC")
                .action(ArgAction::Append)
                .help("frames to write: 1001-1100, 1001-1100x2 (or :2), 1001,1005,1010-1020; repeatable [default: the whole shot]"),
        )
        .arg(
            Arg::new("start")
                .short('s')
                .long("start")
                .value_name("N")
                .value_parser(clap::value_parser!(u64))
                .conflicts_with("frames")
                .help("the first frame to write [default: the shot's first]"),
        )
        .arg(
            Arg::new("end")
                .short('e')
                .long("end")
                .value_name("N")
                .value_parser(clap::value_parser!(u64))
                .conflicts_with("frames")
                .help("the last frame to write [default: the shot's last]"),
        )
        .arg(Arg::new("outputs").long("outputs").value_name("LIST").help("alpha, fg, cutout, checker, comma-separated [default: alpha,fg]"))
        .arg(Arg::new("window").long("window").value_name("C/S").help("a manual Hann window: C frames, stride S (C alone: S = C/2) [default: automatic]"))
        .arg(Arg::new("job").long("job").value_name("FILE.json").help("the engine protocol's run object (input, output_dir, options); flags win over it"))
        .arg(Arg::new("temp").long("temp").value_name("DIR").help("temporary files, in a folder of the run's own [env: OPENJD_SESSION_WORKING_DIR, TMPDIR]"))
        .arg(Arg::new("overwrite").long("overwrite").action(ArgAction::SetTrue).help("replace frames already at the output's names"))
        .arg(
            Arg::new("skip-existing")
                .long("skip-existing")
                .action(ArgAction::SetTrue)
                .conflicts_with("overwrite")
                .help("do nothing when every requested frame is already there and whole (else key them all again)"),
        );
    // loop: NOT-WORTH — the run options' flags, once per process
    for (flag, _, kind, value, help) in RUN_OPTIONS {
        let a = Arg::new(flag).long(flag).help(help);
        c = c.arg(match kind {
            Kind::On | Kind::Off => a.action(ArgAction::SetTrue),
            Kind::Text | Kind::Number => a.value_name(value),
        });
    }
    runtime(reporting(c.mut_arg("no-linear", |a| a.conflicts_with("linear"))))
}

const RENDER_EXAMPLES: &str = "Examples:
  corridorkey render -i plates/sh010.####.exr -o key/sh010_key.####.exr
  corridorkey render -i plates/sh010.####.exr -o key/ --no-linear
  corridorkey render shot.mov -o out/ -F 1001-1100 --preroll 16 --outputs alpha
  corridorkey render -i plates/ -o key.%04d.exr -s 1001 -e 1050 --gpu 1 --progress-format openjd
  corridorkey render --job job.json --report sh010.report.json -q

Exit codes: 0 done, 2 usage, 3 input, 4 output, 5 no GPU, 6 out of graphics memory, 7 models or runtime
missing, 8 engine, 130/143 stopped by SIGINT/SIGTERM. docs/CLI.md has the rest.";

const VERIFY_EXAMPLES: &str = "Examples:
  corridorkey verify -i plates/sh010.####.exr -o key/sh010_key.####.exr -F 1001-1100
  corridorkey verify -i shot.mov -o out/ --outputs alpha,fg

Exit codes: 0 every frame whole, 9 a frame missing or cut, 2 usage, 3 input.";

/// The whole command line.
pub fn command() -> Command {
    Command::new("corridorkey")
        .version(crate::VERSION)
        // `corridorkey render --version` too: the first thing a wrangler types on a new box
        .propagate_version(true)
        .about("CorridorKey 2.0 on the command line: green-screen keys on render farms, offline (docs/CLI.md)")
        .subcommand_required(true)
        .arg_required_else_help(true)
        .subcommand(job_args(Command::new("render").about("key a clip: EXR sequences (or videos) of alpha, fg, cutout, checker")).after_help(RENDER_EXAMPLES))
        .subcommand(job_args(Command::new("verify").about("check that every requested frame is there and reads as a whole EXR")).after_help(VERIFY_EXAMPLES))
        .subcommand(
            runtime(reporting(Command::new("prepare").about("check models, runtime, card and memory before a farm's tasks start; build TensorRT")))
                .arg(Arg::new("tensorrt-size").long("tensorrt-size").value_name("WxH").help("build TensorRT's engines for clips of this size (one-time, minutes)"))
                .arg(Arg::new("max-vram").long("max-vram").value_name("GB").help("graphics memory a job may use (the window TensorRT is built for)"))
                .after_help("Examples:\n  corridorkey prepare --models ~/models/2.0.0-onnx.4 --ort /opt/ort/libonnxruntime.so\n  corridorkey prepare --gpu 0 --tensorrt-size 4096x2160"),
        )
        .subcommand(
            runtime(Command::new("info").about("version, model set, runtime, provider and card"))
                .arg(Arg::new("json").long("json").action(ArgAction::SetTrue).help("as JSON"))
                .after_help("Examples:\n  corridorkey info --models ~/models/2.0.0-onnx.4\n  corridorkey info --json --device cpu"),
        )
        .subcommand(
            Command::new("run")
                .about("run a .ckcmd script of Console commands without the app's window (cron, a farm's pre-job): the Console's parser and rules")
                .arg(Arg::new("keep-going").long("keep-going").action(ArgAction::SetTrue).help("go on after a command fails (the script still ends failed)"))
                .arg(Arg::new("file").value_name("FILE.ckcmd").required(true).help("the script"))
                .after_help(
                    "Examples:\n  corridorkey run nightly.ckcmd\n  corridorkey run --keep-going nightly.ckcmd\n\nIt runs the app's own Console code, so the app must be installed next to it (exit 7 when it isn't). It writes only into the folders the app's settings allow, never replaces files (no one is there to confirm a sudo line), and exits as the script ended.",
                ),
        )
        .subcommand(
            Command::new(crate::spec::NAME)
                .hide(true)
                .about("this command line's description as JSON, for tools (the app's Console)")
                .arg(Arg::new("json").long("json").action(ArgAction::SetTrue).required(true).help("as JSON")),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<clap::ArgMatches, clap::Error> {
        command().try_get_matches_from(std::iter::once("corridorkey").chain(args.iter().copied()))
    }

    #[test]
    fn familiar_short_and_long_options() {
        let m = parse(&["render", "-i", "plate.####.exr", "-o", "key.%04d.exr", "-F", "1001-1100x2", "-F", "1200", "-t", "8", "-v"]).unwrap();
        let (_, r) = m.subcommand().unwrap();
        assert_eq!(r.get_one::<String>("input").unwrap(), "plate.####.exr");
        assert_eq!(r.get_one::<String>("output").unwrap(), "key.%04d.exr");
        assert_eq!(r.get_many::<String>("frames").unwrap().collect::<Vec<_>>(), ["1001-1100x2", "1200"]);
        assert_eq!((r.get_one::<u32>("threads"), r.get_flag("verbose")), (Some(&8), true));
        // GNU's --flag=value, Blender's -s / -e, the clip as the first argument, `--` before a clip named like a flag
        let m = parse(&["render", "--output=out/", "-s", "1001", "-e", "1050", "--", "-shot.mov"]).unwrap();
        let (_, r) = m.subcommand().unwrap();
        assert_eq!((r.get_one::<u64>("start"), r.get_one::<u64>("end")), (Some(&1001), Some(&1050)));
        assert_eq!(r.get_one::<String>("clip").unwrap(), "-shot.mov");
        assert_eq!(r.get_one::<String>("output").unwrap(), "out/");
        // every run option's flag is there, on render and verify
        // loop: NOT-WORTH — the run options' flags
        for (flag, _, kind, ..) in RUN_OPTIONS {
            let a: Vec<String> = match kind {
                Kind::On | Kind::Off => vec![format!("--{flag}")],
                _ => vec![format!("--{flag}"), "1".into()],
            };
            // loop: NOT-WORTH — two subcommands
            for sub in ["render", "verify"] {
                let mut v = vec![sub];
                v.extend(a.iter().map(String::as_str));
                assert!(parse(&v).is_ok(), "{sub} {a:?}");
            }
        }
    }

    #[test]
    fn mistakes_are_usage_errors_that_say_what_to_type() {
        let e = parse(&["render", "--frame", "1-2"]).unwrap_err();
        assert_eq!(e.exit_code(), 2);
        assert!(e.to_string().contains("--frames"), "{e}");
        assert!(parse(&["render", "-F", "1-2", "-s", "1"]).is_err(), "-F and -s/-e are one or the other");
        assert!(parse(&["render", "--overwrite", "--skip-existing"]).is_err());
        assert!(parse(&["render", "-q", "-v"]).is_err());
        assert_eq!(parse(&["render", "--linear", "--no-linear"]).unwrap_err().kind(), clap::error::ErrorKind::ArgumentConflict);
        assert!(parse(&["render", "--progress-format", "nuke"]).unwrap_err().to_string().contains("openjd"));
        assert!(parse(&["render", "-s", "first"]).is_err());
        assert_eq!(parse(&[]).unwrap_err().exit_code(), 2);
    }

    #[test]
    fn help_and_version() {
        let e = parse(&["render", "--help"]).unwrap_err();
        assert_eq!(e.kind(), clap::error::ErrorKind::DisplayHelp);
        let help = e.to_string();
        assert!(help.contains("Examples:") && help.contains("-F, --frames") && help.contains("--preroll"), "{help}");
        assert_eq!(parse(&["help", "verify"]).unwrap_err().kind(), clap::error::ErrorKind::DisplayHelp);
        assert_eq!(parse(&["--version"]).unwrap_err().kind(), clap::error::ErrorKind::DisplayVersion);
        // loop: NOT-WORTH — four subcommands
        for sub in ["render", "verify", "prepare", "info"] {
            assert_eq!(parse(&[sub, "--version"]).unwrap_err().kind(), clap::error::ErrorKind::DisplayVersion, "{sub} --version");
            assert_eq!(parse(&[sub, "-V"]).unwrap_err().kind(), clap::error::ErrorKind::DisplayVersion, "{sub} -V");
        }
    }

    #[test]
    fn engine_messages_name_the_flag() {
        assert_eq!(in_flag_words("hint_quality must be between 0 and 1, got 2"), "--hint-quality must be between 0 and 1, got 2");
        assert_eq!(in_flag_words("vram_budget_gb must be above 0, got 0"), "--max-vram must be above 0, got 0");
        assert_eq!(in_flag_words("hann_stride (8) must not be larger than hann_chunk (4)"), "--window (8) must not be larger than hann_chunk (4)");
        assert_eq!(in_flag_words("crf must be between 0 and 51"), "--crf must be between 0 and 51");
        // a longer name that starts like another isn't it; other messages stay
        assert_eq!(in_flag_words("tensorrt_build: x"), "--no-tensorrt-build: x");
        assert_eq!(in_flag_words("input not found: /x"), "input not found: /x");
    }
}
