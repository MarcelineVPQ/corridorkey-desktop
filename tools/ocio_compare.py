#!/usr/bin/env python3
"""The engine's OCIO processors against PyOpenColorIO, the reference (backlog row 29, docs/OCIO_STUDY_2026-10.md §7
tests 2, 7 and 8).

  PY=<venv with opencolorio==2.5.x and numpy>/bin/python
  $PY tools/ocio_compare.py --bin engine-rs/target/release/examples/ocio_apply --work DIR [--json OUT.json]
  $PY tools/ocio_compare.py ... --studio            also test 7: a studio config on disk ($OCIO) with a show LUT
                                                    found through $SHOT and a CDL (the study's E4 config)
  $PY tools/ocio_compare.py ... --wine BIN.exe      also test 8: the Windows build of ocio_apply under Wine against
                                                    the Linux one, bit for bit, and how far apart where not (float32
                                                    steps, max_ulp; relative, max_rel). Never on the desktop:
      env -u WAYLAND_DISPLAY WINEPREFIX=<scratch prefix> WINEDEBUG=-all WINEDLLOVERRIDES="mscoree,mshtml=" \
        xvfb-run -a $PY tools/ocio_compare.py ... --wine BIN.exe

The Windows ocio_apply: cargo build --release -p ck-core --example ocio_apply --target x86_64-pc-windows-gnu
--no-default-features --features ort-dynamic,ocio (from engine-rs/).

ocio_apply (engine-rs/crates/ck-core/examples) runs the engine's own processors: `in` = colour space -> the model's
linear Rec.709 (the decoder's planar, rows-in-parallel path), `out` = back (the renderer's row path), LOSSLESS. The
reference builds the same processors: GetProcessorFromConfigs(config, space, built-in studio config, "Linear Rec.709
(sRGB)") and back, getOptimizedCPUProcessor(OPTIMIZATION_LOSSLESS), applyRGB on the whole buffer.

Inputs, the same for every space and direction (float32): a 64³ lattice over [-1, 16], a 64³ lattice of codes over
[0, 1], 2^20 random signed HDR values (magnitudes 2^-14 to 2^8) and 2^18 random codes. Results compare as bits (NaN =
NaN when the bits match). Same OCIO version on both sides: the pass is bit-identical; across versions the study's
tolerance is 5e-5 of the pixel's largest channel (printed as max_rel).
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

import numpy as np
import PyOpenColorIO as ocio

MODEL = "Linear Rec.709 (sRGB)"
BUILTIN = "ocio://studio-config-latest"
# Windows against Linux, relative to the pixel's largest channel (about 8 float32 steps; a bfloat16 step is 3.9e-3)
WINDOWS_TOLERANCE = 1e-6


def lattice(lo, hi, n=64):
    s = np.linspace(lo, hi, n, dtype=np.float64)
    g = np.stack(np.meshgrid(s, s, s, indexing="ij"), -1).reshape(-1, 3)
    return g.astype(np.float32)


def inputs():
    rng = np.random.default_rng(29)
    mag = np.exp2(rng.uniform(-14, 8, (1 << 20, 3)))
    sign = np.where(rng.uniform(size=(1 << 20, 3)) < 0.5, -1.0, 1.0)
    hdr = (mag * sign).astype(np.float32)
    codes = rng.uniform(0, 1, (1 << 18, 3)).astype(np.float32)
    return np.concatenate([lattice(-1.0, 16.0), lattice(0.0, 1.0), hdr, codes])


def reference(cfg, builtin, space, direction, x):
    if direction == "in":
        p = ocio.Config.GetProcessorFromConfigs(cfg, space, builtin, MODEL)
    else:
        p = ocio.Config.GetProcessorFromConfigs(builtin, MODEL, cfg, space)
    y = np.ascontiguousarray(x.copy())
    p.getOptimizedCPUProcessor(ocio.OPTIMIZATION_LOSSLESS).applyRGB(y)
    return y


def engine(cmd, space, direction, x, work, config, env):
    src, dst = os.path.join(work, "in.f32"), os.path.join(work, "out.f32")
    x.astype("<f4").tofile(src)
    args = cmd + [direction, space, src, dst] + ([config] if config else [])
    # loop: NOT-WORTH — one child per space and direction; a test tool, 600 s deadline
    r = subprocess.run(args, capture_output=True, text=True, env=env, timeout=600)
    if r.returncode:
        return None, r.stderr.strip()[-300:]
    return np.fromfile(dst, "<f4").reshape(x.shape), r.stderr.strip()


def compare(y, ref):
    same = y.view(np.uint32) == ref.view(np.uint32)
    fin = np.isfinite(ref).all(1) & np.isfinite(y).all(1)
    yf, rf = y[fin].astype(np.float64), ref[fin].astype(np.float64)
    rel = np.abs(yf - rf).max(1) / np.maximum(np.abs(rf).max(1), 1e-6)
    return {"identical": float(same.mean()), "pixels": int(len(y)), "max_rel": float(rel.max()) if rel.size else 0.0}


def run_spaces(label, cmd, cfg_name, cfg, builtin, spaces, x, work, env, config_arg, results, keep=None):
    # loop: NOT-WORTH — the config's spaces x two directions, once per run (a test tool)
    for space in spaces:
        # loop: NOT-WORTH — two directions
        for direction in ("in", "out"):
            key = f"{label} | {space} | {direction}"
            try:
                ref = reference(cfg, builtin, space, direction, x)
            except Exception as e:  # the reference can't build it either: say so, don't count it
                results[key] = {"skipped": f"PyOpenColorIO: {e}"[:200]}
                continue
            y, log = engine(cmd, space, direction, x, work, config_arg, env)
            if y is None:
                results[key] = {"error": log}
                continue
            results[key] = compare(y, ref)
            results[key]["engine"] = log.splitlines()[-1] if log else ""
            if keep is not None:
                # on disk, not in memory (110 results x 22 MB)
                path = os.path.join(work, f"linux_{len(keep)}.f32")
                y.tofile(path)
                keep[(space, direction)] = path


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bin", required=True, help="the Linux ocio_apply")
    ap.add_argument("--work", required=True, help="a scratch folder")
    ap.add_argument("--json")
    ap.add_argument("--studio", action="store_true", help="also the studio config test (7)")
    ap.add_argument("--wine", help="the Windows ocio_apply.exe: byte-identity with Linux under Wine (8)")
    ap.add_argument("--spaces", help="comma-separated subset of the built-in config's spaces")
    a = ap.parse_args()
    os.makedirs(a.work, exist_ok=True)
    env = dict(os.environ)
    env.pop("OCIO", None)
    x = inputs()
    builtin = ocio.Config.CreateFromFile(ocio.ResolveConfigPath(BUILTIN))
    cfg_name = ocio.ResolveConfigPath(BUILTIN)
    # loop: NOT-WORTH — the config's spaces, once
    spaces = [cs.getName() for cs in builtin.getColorSpaces()]
    if a.spaces:
        # loop: NOT-WORTH — the subset given
        spaces = [s for s in a.spaces.split(",") if s]
    results = {"_versions": {"PyOpenColorIO": ocio.__version__, "config": cfg_name, "inputs": int(len(x))}}
    linux = {}
    run_spaces("built-in", [a.bin], cfg_name, builtin, builtin, spaces, x, a.work, env, BUILTIN, results, keep=linux if a.wine else None)

    if a.studio:
        # the study's E4 config: the ACES studio config plus a colour space built from a show LUT ($SHOT on the search
        # path) and a CDL, read through $OCIO (no config in the request)
        d = tempfile.mkdtemp(prefix="ocio-e4-", dir=a.work)
        os.makedirs(os.path.join(d, "luts"))
        base = ocio.Config.CreateFromFile(cfg_name)
        b = ocio.Baker()
        b.setConfig(base)
        b.setFormat("resolve_cube")
        b.setInputSpace("ACEScct")
        b.setTargetSpace("ARRI LogC4")
        b.setCubeSize(33)
        with open(os.path.join(d, "luts", "sh010_grade.cube"), "w") as f:
            f.write(b.bake())
        base.setSearchPath("luts")
        base.addEnvironmentVar("SHOT", "sh000")
        cs = ocio.ColorSpace(ocio.REFERENCE_SPACE_SCENE, "Show Plate (graded LogC4)")
        grp = ocio.GroupTransform()
        grp.appendTransform(ocio.ColorSpaceTransform(src="ACES2065-1", dst="ACEScct"))
        grp.appendTransform(ocio.FileTransform(src="${SHOT}_grade.cube", interpolation=ocio.INTERP_TETRAHEDRAL))
        grp.appendTransform(ocio.CDLTransform(slope=[1.1, 1.0, 0.9], offset=[0.01, 0.0, -0.01], power=[1.0, 1.05, 1.0], sat=0.9))
        cs.setTransform(grp, ocio.COLORSPACE_DIR_FROM_REFERENCE)
        base.addColorSpace(cs)
        base.validate()
        path = os.path.join(d, "show.ocio")
        with open(path, "w") as f:
            f.write(base.serialize())
        # $SHOT picks the LUT (the config's default, sh000, has no file): set in both processes' environments
        os.environ["SHOT"] = "sh010"
        studio = ocio.Config.CreateFromFile(path)
        senv = dict(env, OCIO=path, SHOT="sh010")
        run_spaces("studio $OCIO", [a.bin], path, studio, builtin, ["Show Plate (graded LogC4)", "ACEScg", "ARRI LogC4"], x, a.work, senv, None, results)

    if a.wine:
        # loop: NOT-WORTH — the spaces x two directions, once per run
        for (space, direction), path in linux.items():
            y_linux = np.fromfile(path, np.float32).reshape(x.shape)
            os.remove(path)
            y, log = engine(["wine", a.wine], space, direction, x, a.work, BUILTIN, env)
            key = f"windows vs linux | {space} | {direction}"
            if y is None:
                results[key] = {"error": log}
            else:
                # as bits, and how far apart when not: float32 steps (units in the last place) and relative to the
                # pixel's largest channel
                ent = compare(y, y_linux)
                fin = np.isfinite(y).all(1) & np.isfinite(y_linux).all(1)
                ulp = np.abs(y[fin].view(np.int32).astype(np.int64) - y_linux[fin].view(np.int32).astype(np.int64))
                ent.update(byte_identical=bool(y.tobytes() == y_linux.tobytes()), max_ulp=int(ulp.max()) if ulp.size else 0)
                results[key] = ent

    bad = near = 0
    # loop: NOT-WORTH — one line per result
    for k, v in results.items():
        if k.startswith("_"):
            continue
        ok = v.get("identical") == 1.0 or v.get("byte_identical") is True or "skipped" in v
        # Windows against Linux: the C library's pow / log / exp round differently in a few values (measured
        # 2026-10-24: at most 7.5e-7 of the pixel's largest channel); within WINDOWS_TOLERANCE it is "near", not a failure
        close = not ok and k.startswith("windows") and "max_rel" in v and v["max_rel"] <= WINDOWS_TOLERANCE
        bad += 0 if ok or close else 1
        near += 1 if close else 0
        print(("ok   " if ok else "near " if close else "DIFF ") + k, json.dumps(v))
    # loop: NOT-WORTH — one pass over the results for the summary
    counted = [v for k, v in results.items() if not k.startswith("_") and "skipped" not in v]
    print(f"{len(counted) - bad - near}/{len(counted)} identical, {near} within {WINDOWS_TOLERANCE} (Windows), {bad} different "
          f"(PyOpenColorIO {ocio.__version__}, {len(x)} pixels each)")
    if a.json:
        with open(a.json, "w") as f:
            json.dump(results, f, indent=1)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
