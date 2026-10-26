"""Build (or reuse) one network's TensorRT engine through ONNX Runtime's TensorRT provider and time it.

usage: python trt_build.py PIECE FILE.onnx CACHE_DIR --min SHAPES --opt SHAPES --max SHAPES
         [--fp16] [--bf16] [--workspace-gb 4] [--level 3] [--runs 5] [--verbose]

SHAPES in ORT's format, e.g. "rgb:1x3x288x480". The engine runs exactly as the Rust engine configures it
(engine-rs runtime.rs: engine + timing cache in CACHE_DIR, CUDA provider behind it for anything TensorRT
can't take). Prints TRT_BUILD {piece, session_s (= build or load), first_run_s, run_ms at opt and min,
outputs, nodes on TensorRT vs other providers}.

Host memory: run it under memrun.sh; the peak it prints is the build's host peak.
"""
import argparse
import json
import re
import time

import numpy as np


def parse_shapes(s):
    out = {}
    # loop: NOT-WORTH — the few name:shape parts of an argument
    for part in s.split(","):
        name, dims = part.split(":")
        # loop: NOT-WORTH — one shape's few dims
        out[name] = [int(d) for d in dims.split("x")]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("piece")
    ap.add_argument("file")
    ap.add_argument("cache")
    ap.add_argument("--min", required=True)
    ap.add_argument("--opt", required=True)
    ap.add_argument("--max", required=True)
    ap.add_argument("--fp16", action="store_true")
    ap.add_argument("--bf16", action="store_true")
    ap.add_argument("--workspace-gb", type=float, default=4.0)
    ap.add_argument("--level", type=int, default=3, help="trt_builder_optimization_level")
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--extra", default="", help="more TRT EP options: k=v;k=v")
    a = ap.parse_args()

    import onnxruntime as ort
    ort.preload_dlls()
    opts = {
        "device_id": 0,
        "trt_fp16_enable": a.fp16,
        "trt_engine_cache_enable": True,
        "trt_engine_cache_path": a.cache,
        "trt_timing_cache_enable": True,
        "trt_timing_cache_path": a.cache,
        "trt_profile_min_shapes": a.min,
        "trt_profile_opt_shapes": a.opt,
        "trt_profile_max_shapes": a.max,
        "trt_max_workspace_size": str(int(a.workspace_gb * 2**30)),
        "trt_builder_optimization_level": a.level,
    }
    if a.bf16:
        opts["trt_bf16_enable"] = True
    # loop: NOT-WORTH — the few extra options given
    for kv in filter(None, a.extra.split(";")):
        k, v = kv.split("=", 1)
        opts[k] = v
    so = ort.SessionOptions()
    so.log_severity_level = 0 if a.verbose else 1
    import os
    os.makedirs(a.cache, exist_ok=True)
    t0 = time.perf_counter()
    s = ort.InferenceSession(a.file, so, providers=[("TensorrtExecutionProvider", opts),
                                                    ("CUDAExecutionProvider", {"device_id": 0}), "CPUExecutionProvider"])
    session_s = time.perf_counter() - t0
    # loop: NOT-WORTH — one session's few inputs
    dt = {i.name: (np.float16 if i.type == "tensor(float16)" else np.float32) for i in s.get_inputs()}
    rng = np.random.default_rng(0)

    def feeds(shapes):
        f = {}
        # loop: NOT-WORTH — a piece's few inputs, one random array each
        for k, shp in shapes.items():
            if k == "hint_quality":
                f[k] = np.full(shp, 0.95, dt[k])
            elif k in ("rgb", "frame", "hint"):
                f[k] = rng.random(shp, dtype=np.float32).astype(dt[k])
            else:
                f[k] = rng.standard_normal(shp, dtype=np.float32).astype(dt[k])
        return f

    # loop: NOT-WORTH — the few provider options
    res = {"piece": a.piece, "file": a.file, "session_s": round(session_s, 2), "opts": {k: v for k, v in opts.items() if "path" not in k}}
    # loop: SERIAL-REQUIRED — two shapes timed one after the other on one GPU session
    for tag in ("opt", "min"):
        f = feeds(parse_shapes(getattr(a, tag)))
        t = time.perf_counter()
        outs = s.run(None, f)
        first = time.perf_counter() - t
        times = []
        # loop: SERIAL-REQUIRED — the timed runs: each must finish before the next is timed
        for _ in range(a.runs):
            t = time.perf_counter()
            s.run(None, f)
            times.append(time.perf_counter() - t)
        res[tag] = {"first_run_s": round(first, 3), "run_ms": round(1000 * float(np.median(times)), 2),
                    # loop: NOT-WORTH — one run's few outputs
                    "outputs": [list(o.shape) for o in outs],
                    # loop: NOT-WORTH — one run's few outputs
                    "nonfinite": int(sum((~np.isfinite(o.astype(np.float32))).sum() for o in outs))}
    # loop: NOT-WORTH — the cache folder's few engine files
    engines = [f for f in os.listdir(a.cache) if f.endswith(".engine")]
    # loop: NOT-WORTH — the cache folder's few engine files
    res["engines"] = {f: os.path.getsize(os.path.join(a.cache, f)) for f in engines}
    print("TRT_BUILD " + json.dumps(res))


if __name__ == "__main__":
    main()
