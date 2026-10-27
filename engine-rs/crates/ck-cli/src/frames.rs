//! Frame lists and file patterns as compositors and renderers write them (docs/CLI.md "Frames" and "Paths"):
//! Nuke's `1001-1100`, `1001-1100x2` (also `:2`), lists `1001,1005,1010-1020`; `key.####.exr`, `key.%04d.exr` and
//! Houdini's `key.$F4.exr`, the padding taken from the pattern.
use std::path::{Path, PathBuf};

/// The most frames one request may name (a typo like 1-100000000 would otherwise allocate a list of them).
const MAX_FRAMES: u64 = 1_000_000;

/// The frames a spec names, sorted, each once, and the end of its ranges (the largest B: `1001-1100x2` names
/// 1001-1099 and ends at 1100). Pieces are separated by commas or spaces: `N`, `A-B`, `A-BxS` or `A-B:S` (every
/// S-th frame from A). Err: what is wrong and what to type instead.
pub fn parse_frames(spec: &str) -> Result<(Vec<u64>, u64), String> {
    let mut out = Vec::new();
    let mut end = 0;
    // loop: NOT-WORTH — the few pieces of one spec, once per run
    for piece in spec.split([',', ' ']).map(str::trim).filter(|p| !p.is_empty()) {
        let (range, step) = match piece.split_once(['x', ':']) {
            Some((r, s)) => (r, Some(s)),
            None => (piece, None),
        };
        let num = |s: &str| -> Result<u64, String> {
            if s.starts_with('-') || s.is_empty() && piece.starts_with('-') {
                return Err(format!("{piece:?}: negative frame numbers aren't supported"));
            }
            s.trim().parse::<u64>().map_err(|_| format!("{piece:?}: {s:?} is not a frame number (write 1001-1100, 1001-1100x2 or 1001,1005)"))
        };
        let (a, b) = match range.split_once('-') {
            Some((a, b)) => (num(a)?, num(b)?),
            None => {
                let n = num(range)?;
                (n, n)
            }
        };
        if a > b {
            return Err(format!("{piece:?}: the first frame is after the last (write {b}-{a})"));
        }
        let step = match step {
            Some(s) => s
                .trim()
                .parse::<u64>()
                .ok()
                .filter(|s| *s > 0)
                .ok_or_else(|| format!("{piece:?}: the step must be a whole number above 0 (as in 1001-1100x2)"))?,
            None => 1,
        };
        if (b - a) / step + 1 + out.len() as u64 > MAX_FRAMES {
            return Err(format!("{piece:?}: more than {MAX_FRAMES} frames"));
        }
        // loop: NOT-WORTH — the frames of one piece (≤ MAX_FRAMES), once per run
        out.extend((a..=b).step_by(step as usize));
        end = end.max(b);
    }
    if out.is_empty() {
        return Err("no frames given (write 1001-1100, 1001-1100x2 or 1001,1005)".into());
    }
    out.sort_unstable();
    out.dedup();
    Ok((out, end))
}

/// A file pattern with one frame number in its file name: `prefix` + the number zero-padded to `pad` + `suffix`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pattern {
    /// the folder the files go in ("" for the current one)
    pub dir: PathBuf,
    /// the file name before and after the number
    pub prefix: String,
    pub suffix: String,
    /// digits of zero padding (1: none)
    pub pad: usize,
}

/// The frame token in a file name: (where it starts, its length, its padding). `####` (one digit per #), `%04d` /
/// `%d`, `$F4` / `$F` (Houdini).
fn find_token(name: &str) -> Option<(usize, usize, usize)> {
    let b = name.as_bytes();
    // loop: NOT-WORTH — one short file name
    for i in 0..b.len() {
        match b[i] {
            b'#' => {
                // loop: NOT-WORTH — the run of #
                let n = b[i..].iter().take_while(|c| **c == b'#').count();
                return Some((i, n, n));
            }
            b'%' => {
                // loop: NOT-WORTH — the digits of %0Nd
                let digits = b[i + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
                if b.get(i + 1 + digits) == Some(&b'd') {
                    let pad = if digits == 0 { 1 } else { name[i + 1..i + 1 + digits].parse::<usize>().ok()?.max(1) };
                    return Some((i, digits + 2, pad));
                }
            }
            b'$' if b.get(i + 1) == Some(&b'F') => {
                return Some(match b.get(i + 2) {
                    Some(d) if d.is_ascii_digit() && *d != b'0' => (i, 3, (d - b'0') as usize),
                    _ => (i, 2, 1),
                });
            }
            _ => {}
        }
    }
    None
}

impl Pattern {
    /// None: `s` has no frame token (a folder, a video or a single file). Err: a token outside the file name, or two.
    pub fn parse(s: &str) -> Option<Result<Pattern, String>> {
        let p = Path::new(s);
        let name = p.file_name()?.to_string_lossy().into_owned();
        let Some((at, len, pad)) = find_token(&name) else {
            // a token in a folder's name isn't one
            return find_token(s).map(|_| Err(format!("{s}: the frame number (####, %04d or $F4) goes in the file name, not a folder's")));
        };
        if find_token(&name[at + len..]).is_some() {
            return Some(Err(format!("{s}: one frame number per file name")));
        }
        if pad > 18 {
            return Some(Err(format!("{s}: at most 18 digits of padding")));
        }
        let dir = p.parent().map(Path::to_path_buf).unwrap_or_default();
        Some(Ok(Pattern { dir, prefix: name[..at].to_string(), suffix: name[at + len..].to_string(), pad }))
    }

    /// The file name of frame `n`.
    pub fn file_name(&self, n: u64) -> String {
        format!("{}{n:0w$}{}", self.prefix, self.suffix, w = self.pad)
    }

    /// The path of frame `n`.
    pub fn path(&self, n: u64) -> PathBuf {
        self.dir.join(self.file_name(n))
    }

    /// The frame number of a file name this pattern makes (padding as the pattern's, or wider for a larger number).
    pub fn frame_of(&self, file_name: &str) -> Option<u64> {
        let digits = file_name.strip_prefix(&self.prefix)?.strip_suffix(&self.suffix)?;
        let ok = !digits.is_empty()
            && digits.bytes().all(|c| c.is_ascii_digit())
            && (digits.len() == self.pad || digits.len() > self.pad && !digits.starts_with('0'));
        ok.then(|| digits.parse().ok()).flatten()
    }

    /// The pattern of one output when a job writes several: the output's name joins the file name before the number
    /// (`key.####.exr` → `key_alpha.####.exr`, `key_####.exr` → `key_alpha_####.exr`).
    pub fn for_output(&self, output: &str) -> Pattern {
        let stem = self.prefix.trim_end_matches(['.', '_', '-']);
        let sep = &self.prefix[stem.len()..];
        let prefix = if stem.is_empty() { format!("{output}{}", if sep.is_empty() { "_" } else { sep }) } else { format!("{stem}_{output}{sep}") };
        Pattern { prefix, ..self.clone() }
    }

    /// The settings file beside the frames (`key.####.exr` → `key_settings.txt`).
    pub fn settings_path(&self) -> PathBuf {
        let stem = self.prefix.trim_end_matches(['.', '_', '-']);
        self.dir.join(if stem.is_empty() { "settings.txt".to_string() } else { format!("{stem}_settings.txt") })
    }
}

/// Where the results go: a folder (the engine's own layout inside it) or a pattern (one file per frame).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Output {
    Folder(PathBuf),
    Pattern(Pattern),
}

/// `-o`: a pattern when it has a frame token; else a folder. A file name without a token is refused (a sequence needs
/// a frame number, and a video's name comes from the clip).
pub fn parse_output(s: &str) -> Result<Output, String> {
    if let Some(p) = Pattern::parse(s) {
        return p.map(Output::Pattern);
    }
    let ext = Path::new(s).extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if ["exr", "png", "jpg", "tif", "tiff", "dpx", "mov", "mp4", "mxf"].contains(&ext.as_str()) && !Path::new(s).is_dir() {
        let stem = Path::new(s).with_extension("");
        return Err(format!(
            "{s} names one file: give a folder (-o {}/) or a frame pattern (-o {}.####.exr)",
            Path::new(s).parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new(".")).display(),
            stem.display()
        ));
    }
    Ok(Output::Folder(PathBuf::from(s)))
}

/// The image files the engine reads from a folder (ck-core clip.rs frame_paths: .exr .png .jpg .jpeg, any case, not
/// hidden).
fn is_frame_file(name: &str) -> bool {
    let low = name.to_ascii_lowercase();
    !name.starts_with('.') && [".exr", ".png", ".jpg", ".jpeg"].iter().any(|x| low.ends_with(x) && name.len() > x.len())
}

/// The clip a `plate.####.exr` input names: its folder, when every frame file there is one of the pattern's (the
/// engine keys a whole folder). Err: no such frame, or other frames share the folder (named, with what to do).
pub fn input_folder(p: &Pattern) -> Result<PathBuf, String> {
    let dir = if p.dir.as_os_str().is_empty() { PathBuf::from(".") } else { p.dir.clone() };
    let rd = std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let (mut ours, mut other) = (0usize, Vec::new());
    // loop: HOT-PATH-OK — one pass over the folder's entries, once per run
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !is_frame_file(&name) {
            continue;
        }
        if p.frame_of(&name).is_some() {
            ours += 1;
        } else {
            other.push(name);
        }
    }
    if ours == 0 {
        return Err(format!("no frame of {} in {}", p.file_name(0).replace(&"0".repeat(p.pad), &"#".repeat(p.pad)), dir.display()));
    }
    if !other.is_empty() {
        other.sort();
        return Err(format!(
            "{} also holds other frames ({}{}): the engine keys a whole folder, so put this sequence in a folder of its own",
            dir.display(),
            other[0],
            if other.len() > 1 { format!(" and {} more", other.len() - 1) } else { String::new() }
        ));
    }
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nuke_style_frame_specs() {
        assert_eq!(parse_frames("1001-1005").unwrap().0, vec![1001, 1002, 1003, 1004, 1005]);
        assert_eq!(parse_frames("1001-1009x2").unwrap().0, vec![1001, 1003, 1005, 1007, 1009]);
        // the end of the ranges, not the last frame named: a step keys its whole range (farm review S1)
        assert_eq!(parse_frames("1001-1100x2").unwrap(), ((1001..=1099).step_by(2).collect(), 1100));
        assert_eq!(parse_frames("1050,1001-1010:4").unwrap().1, 1050);
        assert_eq!(parse_frames("1001-1010:3").unwrap().0, vec![1001, 1004, 1007, 1010]);
        assert_eq!(parse_frames("1001,1005,1010-1012").unwrap().0, vec![1001, 1005, 1010, 1011, 1012]);
        // Nuke also takes spaces between pieces; overlaps and repeats count once, in order
        assert_eq!(parse_frames("1010-1012 1001 1011").unwrap().0, vec![1001, 1010, 1011, 1012]);
        assert_eq!(parse_frames("7").unwrap().0, vec![7]);
        assert_eq!(parse_frames(" 0-2 ").unwrap().0, vec![0, 1, 2]);
    }

    #[test]
    fn bad_frame_specs_say_what_to_type() {
        let e = parse_frames("1100-1001").unwrap_err();
        assert!(e.contains("write 1001-1100"), "{e}");
        // loop: NOT-WORTH — a test's few specs
        for bad in ["", "a-b", "1001-1100x0", "1001-1100x", "-5", "1-2-3", "1-100000000"] {
            assert!(parse_frames(bad).is_err(), "{bad:?}");
        }
        assert!(parse_frames("-5").unwrap_err().contains("negative"));
    }

    #[test]
    fn patterns_take_their_padding() {
        let p = Pattern::parse("out/key.####.exr").unwrap().unwrap();
        assert_eq!((p.dir.clone(), p.prefix.as_str(), p.suffix.as_str(), p.pad), (PathBuf::from("out"), "key.", ".exr", 4));
        assert_eq!(p.path(1001), PathBuf::from("out/key.1001.exr"));
        assert_eq!(p.path(7), PathBuf::from("out/key.0007.exr"));
        assert_eq!(p.path(123456), PathBuf::from("out/key.123456.exr"));
        let p = Pattern::parse("out/key.%04d.exr").unwrap().unwrap();
        assert_eq!((p.prefix.as_str(), p.pad, p.file_name(12)), ("key.", 4, "key.0012.exr".to_string()));
        assert_eq!(Pattern::parse("key.%d.exr").unwrap().unwrap().file_name(12), "key.12.exr");
        let p = Pattern::parse("/shots/sh010/key.$F4.exr").unwrap().unwrap();
        assert_eq!((p.dir.clone(), p.file_name(9)), (PathBuf::from("/shots/sh010"), "key.0009.exr".to_string()));
        assert_eq!(Pattern::parse("key.$F.exr").unwrap().unwrap().file_name(9), "key.9.exr");
        assert_eq!(Pattern::parse("key_#####.exr").unwrap().unwrap().file_name(9), "key_00009.exr");
        // no token: a folder or a single file
        assert!(Pattern::parse("out/").is_none());
        assert!(Pattern::parse("shot.mov").is_none());
        // a token in a folder's name, or two tokens
        assert!(Pattern::parse("out_####/key.exr").unwrap().is_err());
        assert!(Pattern::parse("key.####.$F4.exr").unwrap().is_err());
    }

    #[test]
    fn a_pattern_reads_back_its_frame_numbers() {
        let p = Pattern::parse("plate.####.exr").unwrap().unwrap();
        assert_eq!(p.frame_of("plate.1001.exr"), Some(1001));
        assert_eq!(p.frame_of("plate.12345.exr"), Some(12345));
        assert_eq!(p.frame_of("plate.0007.exr"), Some(7));
        // loop: NOT-WORTH — a test's few names
        for other in ["plate.101.exr", "plate.01001.exr", "plate.1001.png", "plate_1001.exr", "plate..exr", "plate.10a1.exr"] {
            assert_eq!(p.frame_of(other), None, "{other}");
        }
    }

    #[test]
    fn several_outputs_share_one_pattern() {
        let p = Pattern::parse("out/key.####.exr").unwrap().unwrap();
        assert_eq!(p.for_output("alpha").path(1001), PathBuf::from("out/key_alpha.1001.exr"));
        assert_eq!(Pattern::parse("key_####.exr").unwrap().unwrap().for_output("fg").file_name(1), "key_fg_0001.exr");
        assert_eq!(Pattern::parse("key####.exr").unwrap().unwrap().for_output("fg").file_name(1), "key_fg0001.exr");
        assert_eq!(Pattern::parse("####.exr").unwrap().unwrap().for_output("fg").file_name(1), "fg_0001.exr");
        assert_eq!(p.settings_path(), PathBuf::from("out/key_settings.txt"));
    }

    #[test]
    fn output_is_a_folder_or_a_pattern() {
        assert_eq!(parse_output("out").unwrap(), Output::Folder(PathBuf::from("out")));
        assert_eq!(parse_output("out/").unwrap(), Output::Folder(PathBuf::from("out/")));
        assert!(matches!(parse_output("out/key.%04d.exr").unwrap(), Output::Pattern(_)));
        let e = parse_output("out/key.exr").unwrap_err();
        assert!(e.contains("-o out/key.####.exr") && e.contains("-o out/"), "{e}");
    }

    #[test]
    fn a_pattern_input_is_its_folder_when_it_holds_only_that_sequence() {
        let d = std::env::temp_dir().join(format!("ck-cli-plates-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        // loop: NOT-WORTH — three test files
        for n in [1001, 1002, 1003] {
            std::fs::write(d.join(format!("plate.{n}.exr")), b"").unwrap();
        }
        std::fs::write(d.join("notes.txt"), b"").unwrap();
        std::fs::write(d.join(".plate.1004.exr.partial"), b"").unwrap();
        let p = Pattern::parse(&d.join("plate.####.exr").to_string_lossy()).unwrap().unwrap();
        assert_eq!(input_folder(&p).unwrap(), d);
        std::fs::write(d.join("other.0001.exr"), b"").unwrap();
        let e = input_folder(&p).unwrap_err();
        assert!(e.contains("other.0001.exr") && e.contains("folder of its own"), "{e}");
        let none = Pattern::parse(&d.join("bg.####.exr").to_string_lossy()).unwrap().unwrap();
        assert!(input_folder(&none).unwrap_err().contains("no frame of bg.####.exr"));
        std::fs::remove_dir_all(&d).unwrap();
    }
}
