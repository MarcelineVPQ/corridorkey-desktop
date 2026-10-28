//! Colour management through OpenColorIO (backlog row 29; the study: docs/OCIO_STUDY_2026-10.md).
//!
//! The real OCIO C++ library (2.5.x, built from source and linked in: `ocio-rs` with `bundled`). The model takes
//! scene-linear Rec.709 (`MODEL_SPACE`): a job's input colour space is converted to it before the model's views
//! are made (decode.rs), and the foreground back to the job's output colour space after despill (render.rs).
//! Processors are built with OCIO's LOSSLESS optimisation (the default one has a 15-bit fast pow/log: up to 4.7e-5
//! off on camera logs, measured in the study) and run in float32 on the CPU, rows in parallel.
//!
//! The config a job uses: its own `color_config` (a path or an `ocio://` name), else `$OCIO` (how studios point
//! every tool at the show's config), else OCIO's built-in ACES studio config, recorded by its versioned name.
use crate::Error;

/// The space the networks were trained in: scene-linear Rec.709 / sRGB primaries, D65 (the study, section 1), by
/// its name in OCIO's built-in ACES configs.
pub const MODEL_SPACE: &str = "Linear Rec.709 (sRGB)";

/// The built-in config used when neither the job nor `$OCIO` names one (resolved to its versioned name).
pub const DEFAULT_CONFIG: &str = "ocio://studio-config-latest";

/// The optimisation every processor is built with, as `_settings.txt` records it.
pub const OPTIMIZATION: &str = "LOSSLESS";

fn optimization_flags() -> u64 {
    ocio_rs::OptimizationFlags::LOSSLESS.0 as u64
}

/// Whether this engine has the real OCIO library. Without `bundled`, `ocio-rs` builds a stub whose calls do no
/// colour work; an engine built that way must never run (the study, section 4).
pub fn require_real_ocio() -> Result<(), String> {
    check_not_stub(ocio_rs::is_stub_build())
}

fn check_not_stub(stub: bool) -> Result<(), String> {
    if stub {
        Err("this engine was built without OpenColorIO (a stub build: ocio-rs without `bundled`); rebuild it with the `ocio` feature".into())
    } else {
        Ok(())
    }
}

/// The linked OCIO's version ("2.5.2"); "stub" for a stub build.
pub fn version() -> String {
    if ocio_rs::is_stub_build() {
        return "stub".into();
    }
    ocio_rs::version().unwrap_or_else(|| "unknown".into())
}

/// Where a job's config came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigSource {
    /// the request's `color_config`
    Request,
    /// the `OCIO` environment variable
    Env,
    /// OCIO's built-in ACES studio config
    BuiltIn,
}

impl ConfigSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConfigSource::Request => "request",
            ConfigSource::Env => "$OCIO",
            ConfigSource::BuiltIn => "built-in",
        }
    }
}

/// A loaded config with what identifies it.
pub struct LoadedConfig {
    pub config: ocio_rs::Config,
    /// the config's name as loaded: a file path, or a built-in's versioned `ocio://` name (never `…-latest`)
    pub name: String,
    pub source: ConfigSource,
    /// OCIO's cache id: changes with the config's contents and the context variables it uses ($SHOT)
    pub cache_id: String,
}

/// A config by its path or `ocio://` name; an `ocio://…-latest` or `ocio://default` name is resolved to the versioned
/// built-in it stands for. A bad-request carrying OCIO's message when it can't be read.
fn load(name: &str, source: ConfigSource) -> Result<LoadedConfig, Error> {
    let name = if name.starts_with("ocio://") {
        ocio_rs::resolve_config_path(name).map_err(|e| Error::bad_request(format!("colour config {name:?}: {}", ocio_message(&e))))?
    } else {
        name.to_string()
    };
    let config = ocio_rs::Config::from_file(&name).map_err(|e| Error::bad_request(format!("colour config {name:?}: {}", ocio_message(&e))))?;
    let cache_id = config.cache_id().unwrap_or_default();
    Ok(LoadedConfig { config, name, source, cache_id })
}

/// The job's config: `requested` (the request's `color_config`), else `env_ocio` ($OCIO, read by the caller), else
/// the built-in studio config. Empty strings count as absent.
pub fn resolve_config(requested: Option<&str>, env_ocio: Option<&str>) -> Result<LoadedConfig, Error> {
    match (requested.filter(|s| !s.trim().is_empty()), env_ocio.filter(|s| !s.trim().is_empty())) {
        (Some(r), _) => load(r.trim(), ConfigSource::Request),
        (None, Some(e)) => load(e.trim(), ConfigSource::Env),
        (None, None) => load(DEFAULT_CONFIG, ConfigSource::BuiltIn),
    }
}

/// `$OCIO` as this process sees it.
pub fn env_ocio() -> Option<String> {
    std::env::var("OCIO").ok()
}

/// The input processor: `space` in the job's config -> MODEL_SPACE in the built-in config, joined through the two
/// configs' `aces_interchange` role (works for a studio config with no Rec.709 space of its own; measured in the
/// study: bit-identical to the same conversion inside one config). LOSSLESS.
pub fn to_model(cfg: &LoadedConfig, model: &LoadedConfig, space: &str) -> Result<Xform, Error> {
    let p = ocio_rs::Config::processor_from_configs(&cfg.config, space, &model.config, MODEL_SPACE)
        .map_err(|e| Error::bad_request(format!("input colour space {space:?} in {}: {}", cfg.name, ocio_message(&e))))?;
    Xform::new(p, format!("{space} -> {MODEL_SPACE}"))
}

/// The output processor: MODEL_SPACE in the built-in config -> `space` in the job's config. LOSSLESS.
pub fn from_model(cfg: &LoadedConfig, model: &LoadedConfig, space: &str) -> Result<Xform, Error> {
    let p = ocio_rs::Config::processor_from_configs(&model.config, MODEL_SPACE, &cfg.config, space)
        .map_err(|e| Error::bad_request(format!("output colour space {space:?} in {}: {}", cfg.name, ocio_message(&e))))?;
    Xform::new(p, format!("{MODEL_SPACE} -> {space}"))
}

/// The built-in config the model's space is taken from (the one OCIO calls `studio-config-latest`).
pub fn model_config() -> Result<LoadedConfig, Error> {
    load(DEFAULT_CONFIG, ConfigSource::BuiltIn).map_err(|e| Error::engine(format!("OCIO's built-in studio config: {}", e.message)))
}

/// OCIO's own words from an `ocio-rs` error.
fn ocio_message(e: &ocio_rs::OcioError) -> String {
    match e {
        ocio_rs::OcioError::Ocio(m) => m.clone(),
        other => other.to_string(),
    }
}

/// Pixels per parallel block of `Xform::apply_planar` (192 KB of packed RGB: stays in a core's L2 cache).
const PLANAR_BLOCK: usize = 16384;

/// An OCIO CPU processor run over float32 RGB pixels.
pub struct Xform {
    cpu: ocio_rs::CPUProcessor,
    /// `"<from> -> <to>"`, for logs
    pub what: String,
}

// SAFETY: OCIO's CPUProcessor is immutable once built and `apply` is a const method (OCIO treats processors as
// thread-safe once created); the ocio-rs bridge keeps its error slot thread-local (bridge.cpp
// `thread_local g_last_error`). Only `apply` is used across threads; the rows-in-parallel result is checked
// bit-identical to one whole-buffer apply (tests, and tools/ocio_compare.py against PyOpenColorIO).
unsafe impl Sync for Xform {}

impl Xform {
    fn new(p: ocio_rs::Processor, what: String) -> Result<Xform, Error> {
        let cpu = p.optimized_cpu_processor(optimization_flags()).map_err(|e| Error::bad_request(format!("{what}: {}", ocio_message(&e))))?;
        Ok(Xform { cpu, what })
    }

    /// Whether the processor leaves every value as it is (e.g. linear Rec.709 to itself).
    pub fn is_no_op(&self) -> bool {
        self.cpu.is_no_op()
    }

    /// Apply to `n` pixels of RGB at `stride` floats apart (3 for packed RGB, 4 for the RGB of RGBA, alpha untouched).
    pub fn apply(&self, px: &mut [f32], stride: usize) {
        let n = if stride == 0 { 0 } else { px.len().div_ceil(stride) };
        if n == 0 {
            return;
        }
        // the slice is sized for n pixels at this stride (checked by ocio-rs); OCIO itself only fails on a bad buffer
        if let Err(e) = self.cpu.try_apply_rgb_pixels(px, n as i64, stride as i64) {
            panic!("OCIO {}: {}", self.what, ocio_message(&e));
        }
    }

    /// Apply to a (3, h, w) planar float32 frame: blocks of PLANAR_BLOCK pixels in parallel, each gathered to packed
    /// RGB, converted and scattered back (OCIO works per pixel, so the blocking doesn't change a value).
    pub fn apply_planar(&self, data: &mut [f32], h: usize, w: usize) {
        use rayon::prelude::*;
        if self.is_no_op() {
            return;
        }
        let n = h * w;
        assert_eq!(data.len(), 3 * n);
        let (r, gb) = data.split_at_mut(n);
        let (g, b) = gb.split_at_mut(n);
        // loop: HOT-PATH-OK — one pass per frame, blocks in parallel; one packed buffer per worker (for_each_init)
        r.par_chunks_mut(PLANAR_BLOCK).zip(g.par_chunks_mut(PLANAR_BLOCK)).zip(b.par_chunks_mut(PLANAR_BLOCK)).for_each_init(
            || vec![0f32; 3 * PLANAR_BLOCK],
            |buf, ((r, g), b)| {
                let buf = &mut buf[..3 * r.len()];
                // loop: HOT-PATH-OK — one block of pixels to packed RGB
                for (((p, &rv), &gv), &bv) in buf.chunks_exact_mut(3).zip(r.iter()).zip(g.iter()).zip(b.iter()) {
                    p[0] = rv;
                    p[1] = gv;
                    p[2] = bv;
                }
                self.apply(buf, 3);
                // loop: HOT-PATH-OK — and back
                for (((p, rv), gv), bv) in buf.chunks_exact(3).zip(r.iter_mut()).zip(g.iter_mut()).zip(b.iter_mut()) {
                    *rv = p[0];
                    *gv = p[1];
                    *bv = p[2];
                }
            },
        );
    }
}

/// A shared processor as job settings hold it (ClipMeta, RenderOpts): compared by identity, shown by what it does.
#[derive(Clone)]
pub struct XformRef(pub std::sync::Arc<Xform>);

impl std::fmt::Debug for XformRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Xform({})", self.0.what)
    }
}

impl PartialEq for XformRef {
    fn eq(&self, other: &Self) -> bool {
        std::sync::Arc::ptr_eq(&self.0, &other.0)
    }
}

impl std::ops::Deref for XformRef {
    type Target = Xform;
    fn deref(&self) -> &Xform {
        &self.0
    }
}

/// A job's colour management: the config, the spaces and the processors to and from the model's space.
pub struct ColorJob {
    pub config_name: String,
    pub config_source: ConfigSource,
    pub cache_id: String,
    pub ocio_version: String,
    /// the clip's colour space (None: the clip is read as CorridorKey 2.0 reads it)
    pub input_space: Option<String>,
    /// where the foreground goes (None: linear Rec.709, as today)
    pub output_space: Option<String>,
    /// input space -> MODEL_SPACE (None without an input space; kept even as a no-op: it marks the values linear)
    pub input: Option<XformRef>,
    /// MODEL_SPACE -> output space (None without an output space, or when it is a no-op)
    pub output: Option<XformRef>,
    /// the output space is scene-linear: the EXR cutout is premultiplied there, straight otherwise (study §6)
    pub output_linear: bool,
}

impl ColorJob {
    /// Lines for `_settings.txt` (additive).
    pub fn settings_lines(&self) -> String {
        format!(
            "OCIO: {}\nOCIO Config: {} ({})\nOCIO Config Cache ID: {}\nInput Colorspace: {}\nOutput Colorspace: {}\nOCIO Optimization: {OPTIMIZATION}\n",
            self.ocio_version,
            self.config_name,
            self.config_source.as_str(),
            self.cache_id,
            self.input_space.as_deref().unwrap_or("None (as CorridorKey 2.0)"),
            self.output_space.as_deref().unwrap_or(MODEL_SPACE),
        )
    }
}

/// Build a job's colour management. `input_space` / `output_space` as requested (empty = absent); the output
/// defaults to the input's own space when an input space is given (decision 1, Marcy 2026-10-24), else stays linear
/// Rec.709 (None). Returns None when neither is set: the job runs exactly as before and reads no config at all.
pub fn color_job(config: Option<&str>, env_ocio: Option<&str>, input_space: Option<&str>, output_space: Option<&str>) -> Result<Option<ColorJob>, Error> {
    let input_space = input_space.map(str::trim).filter(|s| !s.is_empty());
    let output_space = output_space.map(str::trim).filter(|s| !s.is_empty()).or(input_space);
    if input_space.is_none() && output_space.is_none() {
        return Ok(None);
    }
    let cfg = resolve_config(config, env_ocio)?;
    let model = model_config()?;
    let input = input_space.map(|s| to_model(&cfg, &model, s)).transpose()?;
    let (output, output_linear) = match output_space {
        Some(s) => (Some(from_model(&cfg, &model, s)?), cfg.config.is_color_space_linear(s, ocio_rs::ReferenceSpaceType::Scene)),
        None => (None, true),
    };
    // the input processor stays even as a no-op (an input space set means "these values are scene-linear in it");
    // a no-op output processor goes: the output is the model space itself, written exactly as without one
    let shared = |x: Xform| XformRef(std::sync::Arc::new(x));
    Ok(Some(ColorJob {
        config_name: cfg.name,
        config_source: cfg.source,
        cache_id: cfg.cache_id,
        ocio_version: version(),
        input_space: input_space.map(str::to_string),
        output_space: output_space.map(str::to_string),
        input: input.map(shared),
        output: output.filter(|x| !x.is_no_op()).map(shared),
        output_linear,
    }))
}

/// The `colorspaces` reply (docs/ENGINE_PROTOCOL.md): the resolved config, its roles and every active colour space
/// with what the app needs to group them in menus.
pub fn describe(config: Option<&str>, env_ocio: Option<&str>) -> Result<serde_json::Value, Error> {
    use serde_json::json;
    let cfg = resolve_config(config, env_ocio)?;
    let c = &cfg.config;
    // loop: NOT-WORTH — a config's roles (about ten), once per request
    let roles: serde_json::Map<String, serde_json::Value> =
        (0..c.num_roles()).filter_map(|i| Some((c.role_name(i)?, json!(c.role_color_space_by_index(i).unwrap_or_default())))).collect();
    // loop: NOT-WORTH — a config's colour spaces (57 in the ACES studio config), once per request
    let spaces: Vec<serde_json::Value> = (0..c.num_color_spaces())
        .filter_map(|i| c.color_space_name_by_index(i))
        .filter_map(|name| {
            let cs = c.color_space(&name)?;
            // loop: NOT-WORTH — a colour space's few aliases
            let aliases: Vec<String> = (0..cs.num_aliases()).filter_map(|k| cs.alias(k)).collect();
            Some(json!({
                "name": name,
                "family": cs.family().unwrap_or_default(),
                "encoding": cs.encoding().unwrap_or_default(),
                "isdata": cs.is_data(),
                "linear": c.is_color_space_linear(&name, ocio_rs::ReferenceSpaceType::Scene),
                "aliases": aliases,
            }))
        })
        .collect();
    Ok(json!({
        "type": "colorspaces",
        "config": {"name": cfg.name, "source": cfg.source.as_str(), "cache_id": cfg.cache_id, "ocio": version()},
        "model_space": MODEL_SPACE,
        "roles": roles,
        "colorspaces": spaces,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test 10 (the study's build guard): a stub OCIO fails this test, so a stub engine can't pass `cargo test`.
    #[test]
    fn ocio_is_the_real_library() {
        assert!(!ocio_rs::is_stub_build(), "ocio-rs is a stub build: build with the `ocio` feature");
        assert!(require_real_ocio().is_ok());
        assert!(version().starts_with("2.5."), "{}", version());
        // the guard itself refuses a stub
        assert!(check_not_stub(true).is_err());
        assert!(check_not_stub(false).is_ok());
    }

    #[test]
    fn default_config_resolves_to_a_versioned_name() {
        let c = resolve_config(None, None).unwrap();
        assert_eq!(c.source, ConfigSource::BuiltIn);
        assert!(c.name.starts_with("ocio://studio-config-v") && !c.name.contains("latest"), "{}", c.name);
        assert!(!c.cache_id.is_empty());
        // $OCIO wins over the built-in, the request over $OCIO
        let e = resolve_config(None, Some("ocio://cg-config-latest")).unwrap();
        assert_eq!(e.source, ConfigSource::Env);
        assert!(e.name.starts_with("ocio://cg-config-v"), "{}", e.name);
        let r = resolve_config(Some("ocio://studio-config-latest"), Some("ocio://cg-config-latest")).unwrap();
        assert_eq!(r.source, ConfigSource::Request);
        assert!(r.name.starts_with("ocio://studio-config-v"));
    }

    #[test]
    fn unknown_config_or_space_is_a_bad_request_with_ocios_words() {
        let e = resolve_config(Some("/nonexistent/config.ocio"), None).err().unwrap();
        assert_eq!(e.code.as_str(), "bad-request");
        assert!(e.message.contains("/nonexistent/config.ocio"), "{}", e.message);
        let e = color_job(None, None, Some("No Such Space"), None).err().unwrap();
        assert_eq!(e.code.as_str(), "bad-request");
        assert!(e.message.contains("No Such Space"), "{}", e.message);
        let e = color_job(None, None, None, Some("Nor This")).err().unwrap();
        assert_eq!(e.code.as_str(), "bad-request");
    }

    #[test]
    fn no_spaces_means_no_colour_management() {
        // nothing set: today's behaviour, no config read at all (even a broken $OCIO doesn't matter)
        assert!(color_job(Some("/nonexistent.ocio"), Some("/also/missing.ocio"), None, Some("  ")).unwrap().is_none());
    }

    #[test]
    fn output_defaults_to_the_input_space() {
        let j = color_job(None, None, Some("ACEScg"), None).unwrap().unwrap();
        assert_eq!((j.input_space.as_deref(), j.output_space.as_deref()), (Some("ACEScg"), Some("ACEScg")));
        assert!(j.input.is_some() && j.output.is_some() && j.output_linear);
        let j = color_job(None, None, Some("ACEScct"), None).unwrap().unwrap();
        assert!(!j.output_linear, "ACEScct is a log space");
        // linear Rec.709 out is the model's own space: no output processor at all
        let j = color_job(None, None, Some("ACEScg"), Some(MODEL_SPACE)).unwrap().unwrap();
        assert!(j.output.is_none() && j.output_linear);
        let t = j.settings_lines();
        assert!(t.contains("Input Colorspace: ACEScg\n") && t.contains("OCIO Optimization: LOSSLESS\n") && t.contains("ocio://studio-config-v"), "{t}");
    }

    #[test]
    fn describe_lists_spaces_and_roles() {
        let d = describe(None, None).unwrap();
        assert_eq!(d["type"], "colorspaces");
        assert_eq!(d["roles"]["aces_interchange"], "ACES2065-1");
        let spaces = d["colorspaces"].as_array().unwrap();
        let cg = spaces.iter().find(|s| s["name"] == "ACEScg").unwrap();
        assert_eq!((cg["encoding"].as_str(), cg["isdata"].as_bool(), cg["linear"].as_bool()), (Some("scene-linear"), Some(false), Some(true)));
        assert!(spaces.iter().any(|s| s["name"] == MODEL_SPACE));
        assert!(spaces.iter().any(|s| s["isdata"] == true));
        assert!(spaces.len() > 40, "{}", spaces.len());
    }

    #[test]
    fn planar_apply_matches_packed_apply() {
        let j = color_job(None, None, Some("ARRI LogC4"), None).unwrap().unwrap();
        let x = j.input.unwrap();
        let (h, w) = (3, 5);
        // loop: NOT-WORTH — a 15-pixel test frame
        let planar: Vec<f32> = (0..3 * h * w).map(|i| (i as f32 * 0.037) % 1.0).collect();
        let mut packed = vec![0f32; 3 * h * w];
        // loop: NOT-WORTH — as above
        for i in 0..h * w {
            // loop: NOT-WORTH — three channels
            for c in 0..3 {
                packed[3 * i + c] = planar[c * h * w + i];
            }
        }
        let mut p = planar.clone();
        x.apply_planar(&mut p, h, w);
        x.apply(&mut packed, 3);
        // loop: NOT-WORTH — as above
        for i in 0..h * w {
            // loop: NOT-WORTH — three channels
            for c in 0..3 {
                assert_eq!(p[c * h * w + i].to_bits(), packed[3 * i + c].to_bits());
            }
        }
        assert_ne!(p, planar);
    }
}
