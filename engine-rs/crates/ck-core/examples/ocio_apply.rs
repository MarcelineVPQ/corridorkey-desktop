//! The engine's own colour processors on a file of float32 RGB pixels, for checking them against PyOpenColorIO
//! (tools/ocio_compare.py) and across platforms (the Windows build under Wine).
//!
//!   ocio_apply in|out SPACE IN.f32 OUT.f32 [CONFIG]
//!
//! `in`: SPACE -> the model's linear Rec.709, as decode.rs applies it (a planar frame, rows in parallel);
//! `out`: linear Rec.709 -> SPACE, as render.rs applies it (rows of 3840 pixels in parallel). CONFIG: a path or an `ocio://` name;
//! absent = `$OCIO`, else the built-in ACES studio config. IN/OUT: little-endian float32, packed RGB.
use ck_core::ocio;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 5 || (a[1] != "in" && a[1] != "out") {
        eprintln!("usage: ocio_apply in|out SPACE IN.f32 OUT.f32 [CONFIG]");
        std::process::exit(2);
    }
    if let Err(e) = ocio::require_real_ocio() {
        eprintln!("{e}");
        std::process::exit(1);
    }
    let fail = |m: String| -> ! {
        eprintln!("{m}");
        std::process::exit(1)
    };
    let cfg = ocio::resolve_config(a.get(5).map(String::as_str), ocio::env_ocio().as_deref()).unwrap_or_else(|e| fail(e.message));
    let model = ocio::model_config().unwrap_or_else(|e| fail(e.message));
    let bytes = std::fs::read(&a[3]).unwrap_or_else(|e| fail(format!("{}: {e}", a[3])));
    // loop: NOT-WORTH — a test tool reading its input once
    let mut v: Vec<f32> = bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    let n = v.len() / 3;
    // only the processor itself is timed (not its creation, nor this tool's packed <-> planar copies)
    let secs;
    if a[1] == "in" {
        let x = ocio::to_model(&cfg, &model, &a[2]).unwrap_or_else(|e| fail(e.message));
        // as a frame of rows of up to 3840 pixels: planar, the decoder's layout
        let w = n.clamp(1, 3840);
        let h = n.div_ceil(w);
        let mut planar = vec![0f32; 3 * h * w];
        // loop: NOT-WORTH — a test tool, once per run
        for i in 0..n {
            // loop: NOT-WORTH — three channels
            for c in 0..3 {
                planar[c * h * w + i] = v[3 * i + c];
            }
        }
        let t = std::time::Instant::now();
        x.apply_planar(&mut planar, h, w);
        secs = t.elapsed().as_secs_f64();
        // loop: NOT-WORTH — as above
        for i in 0..n {
            // loop: NOT-WORTH — three channels
            for c in 0..3 {
                v[3 * i + c] = planar[c * h * w + i];
            }
        }
    } else {
        use rayon::prelude::*;
        let x = ocio::from_model(&cfg, &model, &a[2]).unwrap_or_else(|e| fail(e.message));
        // loop: PARALLELIZE — rows of 3840 pixels in parallel, as render.rs applies the output processor
        let t = std::time::Instant::now();
        v.par_chunks_mut(3 * 3840).for_each(|row| x.apply(row, 3));
        secs = t.elapsed().as_secs_f64();
    }
    // loop: NOT-WORTH — a test tool writing its output once
    let out: Vec<u8> = v.iter().flat_map(|x| x.to_le_bytes()).collect();
    std::fs::write(&a[4], out).unwrap_or_else(|e| fail(format!("{}: {e}", a[4])));
    eprintln!("ocio_apply: OCIO {}, config {} ({}), {} {} px in {:.3} s", ocio::version(), cfg.name, cfg.source.as_str(), a[1], n, secs);
}
