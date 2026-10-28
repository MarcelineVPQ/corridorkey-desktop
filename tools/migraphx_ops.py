#!/usr/bin/env python3
"""Will MIGraphX take each network? Checked offline with MIGraphX's own library, no AMD card needed.

  python3 -I tools/migraphx_ops.py MODELS_DIR --migraphx-libs DIR [--set fp16] [--size 1280x1152] [--frames 4]
                                   [--ref] [--json OUT.json]

DIR: the migraphx_libs folder of AMD's migraphx-libs wheel (ROCm 10.1: migraphx_libs-2.18.0+rocm10.1.0, from
https://stable.repo.amd.com/rocm/migraphx/whl-next/migraphx-libs/). Its C library (libmigraphx_c.so.3) loads without
ROCm: the ONNX parser and the reference (CPU) target need no GPU libraries.

Per network of the models.json entry --set (default fp16):
  ops      the graph's op types MIGraphX's ONNX parser doesn't know (migraphx_get_onnx_operators: its own list)
  parse    migraphx_parse_onnx at the padded size and frames given, as the provider parses it on the card (ok, or
           failed: MIGraphX's message is on stderr)
  --ref    compile for MIGraphX's reference target, run seeded random inputs, compare with ONNX Runtime's CPU
           provider (max / mean |diff|): MIGraphX's reading of the graph, not the card's kernels. Slow: use a small size.
Exit 0 when every network parses. Needs numpy, onnx and onnxruntime.
"""
import argparse
import ctypes as C
import json
import pathlib
import sys
import time

import numpy as np
import onnx

PIECES = ["cradio", "moge", "rvm", "stage1", "stage2"]
HALF, FLOAT = 3, 4  # migraphx_shape_datatype_t: tuple, fp4x2, bool, half, float, ...


def feeds(h, w, t, rng):
    """Each network's inputs at padded size h x w, t frames (the engine's shapes, pipeline/keying.rs)."""
    f16, f32 = np.float16, np.float32

    def r(shape, dt):
        return rng.random(shape, dtype=np.float32).astype(dt)

    return {
        "cradio": {"rgb": r((1, 3, h // 4, w // 4), f32)},
        "moge": {"rgb": r((1, 3, h * 7 // 32, w * 7 // 32), f32)},
        "rvm": {"frame": r((1, 3, h // 4, w // 4), f32), "state": np.zeros((1, 1 + (h // 64) * (w // 64), 384), f32)},
        "stage1": {"rgb": r((1, t, 3, h, w), f16), "hint": r((1, t, 1, h, w), f16), "hint_quality": np.ones((1, t), f16),
                   "moge": r((1, t, 768, h // 64, w // 64), f32), "cradio": r((1, t, 1152, h // 64, w // 64), f32),
                   "rvm": r((1, t, 384, h // 64, w // 64), f32)},
        "stage2": {"rgb": r((1, 1, 3, h, w), f16), "baton": r((1, 1, 512, h // 16, w // 16), f32)},
    }


class Mx:
    def __init__(self, libs: pathlib.Path):
        self.lib = C.CDLL(str(libs / "libmigraphx_c.so.3"))

    def ok(self, rc, what):
        if rc != 0:
            raise RuntimeError(f"{what}: MIGraphX status {rc}")

    def operators(self):
        n = C.c_size_t()
        self.ok(self.lib.migraphx_get_onnx_operators_size(C.byref(n)), "operators")
        out = set()
        # loop: NOT-WORTH — MIGraphX's ~190 op names, once
        for i in range(n.value):
            p = C.c_char_p()
            self.ok(self.lib.migraphx_get_onnx_operator_name_at_index(C.byref(p), C.c_size_t(i)), "operator name")
            out.add(p.value.decode())
        return out

    def parse(self, path: pathlib.Path, feed):
        opts = C.c_void_p()
        self.ok(self.lib.migraphx_onnx_options_create(C.byref(opts)), "onnx options")
        # loop: NOT-WORTH — a network's few inputs
        for k, v in feed.items():
            dims = (C.c_size_t * v.ndim)(*v.shape)
            self.ok(self.lib.migraphx_onnx_options_set_input_parameter_shape(opts, k.encode(), dims, C.c_size_t(v.ndim)), k)
        self.ok(self.lib.migraphx_onnx_options_set_external_data_path(opts, str(path.parent).encode()), "external data")
        prog = C.c_void_p()
        rc = self.lib.migraphx_parse_onnx(C.byref(prog), str(path).encode(), opts)
        return prog if rc == 0 else None

    def run_ref(self, prog, feed):
        tgt, co, params, outs = C.c_void_p(), C.c_void_p(), C.c_void_p(), C.c_void_p()
        self.ok(self.lib.migraphx_target_create(C.byref(tgt), b"ref"), "ref target")
        self.ok(self.lib.migraphx_compile_options_create(C.byref(co)), "compile options")
        self.ok(self.lib.migraphx_program_compile(prog, tgt, co), "compile (ref)")
        self.ok(self.lib.migraphx_program_parameters_create(C.byref(params)), "parameters")
        keep = []
        # loop: NOT-WORTH — a network's few inputs
        for k, v in feed.items():
            v = np.ascontiguousarray(v)
            keep.append(v)
            shp, arg = C.c_void_p(), C.c_void_p()
            dims = (C.c_size_t * v.ndim)(*v.shape)
            self.ok(self.lib.migraphx_shape_create(C.byref(shp), C.c_int(HALF if v.dtype == np.float16 else FLOAT), dims, C.c_size_t(v.ndim)), k)
            self.ok(self.lib.migraphx_argument_create(C.byref(arg), shp, v.ctypes.data_as(C.c_void_p)), k)
            self.ok(self.lib.migraphx_program_parameters_add(params, k.encode(), arg), k)
        self.ok(self.lib.migraphx_program_run(C.byref(outs), prog, params), "run (ref)")
        n = C.c_size_t()
        self.ok(self.lib.migraphx_arguments_size(C.byref(n), outs), "outputs")
        res = []
        # loop: NOT-WORTH — one or two outputs
        for i in range(n.value):
            a, s, buf = C.c_void_p(), C.c_void_p(), C.c_char_p()
            lp, ln, ty = C.POINTER(C.c_size_t)(), C.c_size_t(), C.c_int()
            self.ok(self.lib.migraphx_arguments_get(C.byref(a), outs, C.c_size_t(i)), "output")
            self.ok(self.lib.migraphx_argument_shape(C.byref(s), a), "output shape")
            self.ok(self.lib.migraphx_shape_lengths(C.byref(lp), C.byref(ln), s), "output lengths")
            self.ok(self.lib.migraphx_shape_type(C.byref(ty), s), "output type")
            self.ok(self.lib.migraphx_argument_buffer(C.byref(buf), a), "output buffer")
            # loop: NOT-WORTH — an output's ≤ 5 dims
            shape = [lp[j] for j in range(ln.value)]
            half = ty.value == HALF
            raw = np.ctypeslib.as_array(C.cast(buf, C.POINTER(C.c_uint16 if half else C.c_float)), shape=(int(np.prod(shape)),))
            res.append((raw.view(np.float16) if half else raw).astype(np.float32).reshape(shape))
        return res


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("models", type=pathlib.Path)
    ap.add_argument("--migraphx-libs", type=pathlib.Path, required=True)
    ap.add_argument("--set", default="fp16", help="models.json key (fp16, migraphx-fp16, ...)")
    ap.add_argument("--size", default="1280x1152", help="padded size WIDTHxHEIGHT (multiples of 64)")
    ap.add_argument("--frames", type=int, default=4, help="stage 1's frames per call")
    ap.add_argument("--ref", action="store_true", help="also run MIGraphX's reference target against ONNX Runtime (CPU)")
    ap.add_argument("--json", type=pathlib.Path)
    a = ap.parse_args()
    # loop: NOT-WORTH — two numbers
    w, h = (int(x) for x in a.size.lower().split("x"))
    mx = Mx(a.migraphx_libs)
    known = mx.operators()
    files = json.loads((a.models / "models.json").read_text())[a.set]
    all_feeds = feeds(h, w, a.frames, np.random.default_rng(0))
    report = {"migraphx_libs": str(a.migraphx_libs), "set": a.set, "size": a.size, "frames": a.frames, "networks": {}}
    # loop: NOT-WORTH — five networks
    for piece in PIECES:
        if piece not in files:
            continue
        path = a.models / files[piece]
        g = onnx.load(str(path), load_external_data=False).graph
        # loop: NOT-WORTH — one pass over the graph's nodes
        missing = sorted({n.op_type for n in g.node} - known)
        t0 = time.time()
        prog = mx.parse(path, all_feeds[piece])
        r = {"file": path.name, "nodes": len(g.node), "unknown_ops": missing, "parse": "ok" if prog else "failed"}
        line = f"{piece:7} parse {r['parse']:6} ({time.time() - t0:.1f} s)" + (f"; ops MIGraphX doesn't know: {', '.join(missing)}" if missing else "")
        if prog and a.ref:
            import onnxruntime as ort  # only for --ref
            t1 = time.time()
            got = mx.run_ref(prog, all_feeds[piece])
            # loop: NOT-WORTH — one or two outputs
            want = [o.astype(np.float32) for o in ort.InferenceSession(str(path), providers=["CPUExecutionProvider"]).run(None, all_feeds[piece])]
            # loop: NOT-WORTH — one or two outputs
            r["ref_vs_ort_cpu"] = [{"shape": list(x.shape), "max_abs": float(np.abs(x - y).max()), "mean_abs": float(np.abs(x - y).mean()),
                                    "mean_ort": float(np.abs(y).mean())} for x, y in zip(got, want)]
            # loop: NOT-WORTH — one or two outputs
            line += "".join(f"\n          ref vs ORT CPU out{i}: max |diff| {d['max_abs']:.4g}, mean {d['mean_abs']:.3g} (mean |ORT| {d['mean_ort']:.3g})"
                            for i, d in enumerate(r["ref_vs_ort_cpu"])) + f" [{time.time() - t1:.0f} s]"
        report["networks"][piece] = r
        print(line, flush=True)
    if a.json:
        a.json.write_text(json.dumps(report, indent=1) + "\n")
    # loop: NOT-WORTH — five networks
    return 0 if all(r["parse"] == "ok" for r in report["networks"].values()) else 1


if __name__ == "__main__":
    sys.exit(main())
