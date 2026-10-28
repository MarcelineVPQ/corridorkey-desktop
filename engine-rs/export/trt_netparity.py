"""Per-network parity on real data: TensorRT engines (and the CUDA fp16 production files) against the
production fp32 networks.

usage:
  python trt_netparity.py ref  CLIP_DIR OUT.npz [--frames 4]
      runs the production fp32 set on ORT CUDA (TF32 off) through pipeline.run_clip (window = frames,
      stride = frames/2) and records every network's inputs and outputs of the first window: RVM's first
      two steps, C-RADIO + MoGe, stage 1, stage 2's first two frames.
  python trt_netparity.py test REF.npz --models DIR --prec fp16|fp32|tensorrt-fp16|tensorrt-fp32 --ep trt|cuda [--bf16] [--cache DIR]
      feeds the recorded inputs to DIR's networks (TensorRT: an engine per network, built for exactly
      these shapes) and prints NETPARITY {piece: {max_abs, mean_abs, ref_absmax, rel_max}} per output.
"""
import argparse
import sys
import json
import os

import numpy as np

PIECES = ("rvm", "cradio", "moge", "stage1", "stage2")
INPUTS = {"rvm": ("frame", "state"), "cradio": ("rgb",), "moge": ("rgb",),
          "stage1": ("rgb", "hint", "hint_quality", "moge", "cradio", "rvm"), "stage2": ("rgb", "baton")}


def session(models, prec, ep, p, bf16=False, cache=None, shape=None, extra=None):
    """One network's session (one at a time, so the process holds one network's memory)."""
    import onnxruntime as ort
    files = json.load(open(os.path.join(models, "models.json")))[prec]
    so = ort.SessionOptions()
    so.log_severity_level = 2
    cuda = ("CUDAExecutionProvider", {"use_tf32": 0, "gpu_mem_limit": str(10 << 30)})
    if ep == "cuda":
        prov = [cuda, "CPUExecutionProvider"]
    elif ep == "ctx":
        # strongly typed engine from ck-trt-build, run through an EPContext stub (what corridorkey-engine does)
        import subprocess
        import time
        d = os.path.join(cache, p)
        os.makedirs(d, exist_ok=True)
        eng, stub = os.path.join(d, f"{p}.engine"), os.path.join(d, f"{p}_ctx.onnx")
        if not os.path.exists(eng):
            t = time.perf_counter()
            # loop: SERIAL-REQUIRED — one ck-trt-build per network on one GPU [bounded: timeout=1800 s, the engine's own per-build deadline]
            r = subprocess.run([os.environ["CK_TRT_BUILD"], "--onnx", os.path.join(models, files[p]), "--engine", eng,
                                "--min", shape, "--opt", shape, "--max", shape, "--workspace-mb", "4096"],
                               capture_output=True, text=True, timeout=1800)
            print(f"BUILD {p} rc={r.returncode} {time.perf_counter() - t:.1f}s {r.stdout.strip()} {r.stderr.strip()[-300:]}", flush=True)
        # loop: SERIAL-REQUIRED — writes one EPContext stub [bounded: timeout=300 s]
        subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "trt_ctx.py"),
                        os.path.join(models, files[p]), stub, f"{p}.engine"], check=True, capture_output=True, timeout=300)
        return ort.InferenceSession(stub, so, providers=[("TensorrtExecutionProvider", {}), cuda, "CPUExecutionProvider"])
    else:
        o = {"trt_fp16_enable": prec.endswith("fp16") and not bf16, "trt_engine_cache_enable": True,
             "trt_engine_cache_path": os.path.join(cache, p), "trt_timing_cache_enable": True,
             "trt_timing_cache_path": os.path.join(cache, p),
             "trt_profile_min_shapes": shape, "trt_profile_opt_shapes": shape, "trt_profile_max_shapes": shape,
             "trt_max_workspace_size": str(4 << 30)}
        if bf16:
            o["trt_bf16_enable"] = True
        o.update(extra or {})
        os.makedirs(os.path.join(cache, p), exist_ok=True)
        prov = [("TensorrtExecutionProvider", o), cuda, "CPUExecutionProvider"]
    return ort.InferenceSession(os.path.join(models, files[p]), so, providers=prov)


def run(s, feeds):
    # loop: NOT-WORTH — one session's few inputs
    dt = {i.name: (np.float16 if i.type == "tensor(float16)" else np.float32) for i in s.get_inputs()}
    # loop: NOT-WORTH — a run's few outputs and feeds, one cast each
    return [o.astype(np.float32) for o in s.run(None, {k: np.asarray(v).astype(dt[k]) for k, v in feeds.items()})]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode")
    ap.add_argument("a")
    ap.add_argument("b", nargs="?")
    ap.add_argument("--frames", type=int, default=4)
    ap.add_argument("--models")
    ap.add_argument("--prec", default="fp16")
    ap.add_argument("--ep", default="trt")
    ap.add_argument("--bf16", action="store_true")
    ap.add_argument("--cache")
    ap.add_argument("--extra", default="", help="more TensorRT EP options: k=v;k=v")
    ap.add_argument("--only", default="", help="comma list of networks")
    a = ap.parse_args()
    import onnxruntime as ort
    ort.preload_dlls()

    if a.mode == "ref":
        import torch
        import pipeline
        from common import SCRATCH
        S = str(SCRATCH / "models")
        # loop: NOT-WORTH — five paths, once
        be = pipeline.OrtBackend({p: os.path.join(S, f"ck2-{p}-fp32.onnx") for p in PIECES},
                                 [("CUDAExecutionProvider", {"use_tf32": 0}), "CPUExecutionProvider"], name="ref")
        rec, calls = {}, {}
        orig = be._run

        def recording(k, feeds):
            outs = orig(k, feeds)
            n = calls.get(k, 0)
            calls[k] = n + 1
            if n < 2 and not (n == 1 and k in ("cradio", "moge", "stage1")):
                # loop: NOT-WORTH — one recorded call's few feeds (the first two calls per network)
                for name, v in feeds.items():
                    rec[f"{k}{n}.in.{name}"] = np.asarray(v, np.float32)
                # loop: NOT-WORTH — one recorded call's few outputs
                for i, o in enumerate(outs):
                    rec[f"{k}{n}.out{i}"] = o
            return outs
        be._run = recording
        pipeline.run_clip(be, a.a, chunk=a.frames, stride=max(1, a.frames // 2), num_frames=a.frames, log=lambda *_: None)
        np.savez(a.b, **rec)
        # loop: NOT-WORTH — the recorded keys, once
        print("REF saved", a.b, sorted({k.split(".")[0] for k in rec}))
        return

    ref = dict(np.load(a.a))
    # loop: NOT-WORTH — the reference's keys, once
    keys = sorted({k.split(".")[0] for k in ref})
    shapes = {}
    # loop: NOT-WORTH — the reference's few calls (two per network at most)
    for k in keys:
        p = k[:-1]  # "<piece><call index 0|1>"
        if p not in shapes:
            # loop: NOT-WORTH — a network's few inputs and their dims
            shapes[p] = ",".join(f"{n}:{'x'.join(str(d) for d in ref[f'{k}.in.{n}'].shape)}" for n in INPUTS[p])
    # loop: NOT-WORTH — the few extra options given
    extra = dict(kv.split("=", 1) for kv in a.extra.split(";") if kv)
    res = {}
    # loop: SERIAL-REQUIRED — five networks, one session at a time on one GPU
    for p in PIECES:
        if a.only and p not in a.only.split(","):
            continue
        sess = session(a.models, a.prec, a.ep, p, a.bf16, a.cache, shapes.get(p), extra)
        # loop: SERIAL-REQUIRED — a network's one or two recorded calls, one run each on the GPU
        for k in [k for k in keys if k[:-1] == p]:  # "<piece><call index 0|1>"
            # loop: NOT-WORTH — a network's few inputs
            outs = run(sess, {n: ref[f"{k}.in.{n}"] for n in INPUTS[p]})
            # loop: NOT-WORTH — one comparison per output (a few)
            for i, o in enumerate(outs):
                r = ref[f"{k}.out{i}"]
                d = np.abs(o - r)
                res[f"{k}.out{i}"] = {"max_abs": float(d.max()), "mean_abs": float(d.mean()),
                                      "ref_absmax": float(np.abs(r).max()), "rel_max": float(d.max() / max(np.abs(r).max(), 1e-12)),
                                      "nonfinite": int((~np.isfinite(o)).sum())}
                if p == "stage2":
                    al = np.abs(np.clip(o[:, :, 0], 0, 1) - np.clip(r[:, :, 0], 0, 1))
                    res[f"{k}.out{i}"].update({"alpha_max": float(al.max()), "alpha_mae": float(al.mean()),
                                               "alpha_pct_gt_1_255": float((al > 1 / 255).mean() * 100)})
        del sess
    print("NETPARITY " + json.dumps({"models": a.models, "prec": a.prec, "ep": a.ep, "bf16": a.bf16, "extra": a.extra, "res": res}))


if __name__ == "__main__":
    main()
