"""C-RADIO, stage 1, stage 2 of two model sets on the same seeded inputs (ONNX Runtime): max / mean |diff| per output.

usage: python net_parity.py OLD_SET NEW_SET --prec fp16|fp32 [--ep cpu|cuda] [--pieces cradio,stage1,stage2] HxWxT ...
  H, W: padded size (multiples of 128); T: stage 1's and C-RADIO's frames (stage 2 runs one frame).
Stage 2 is also compared as a matte: sigmoid of its alpha logit (channel 0), the value the engine writes, so the
row 53 bar (<= 1/255) reads directly. One network session at a time.
"""
import argparse
import json

import numpy as np
import onnxruntime as ort


def feeds(piece, H, W, T, f16, rng):
    lo = np.float16 if f16 else np.float32
    r = lambda shape, dt=np.float32: rng.random(shape, dtype=np.float32).astype(dt)  # noqa: E731
    if piece == "cradio":
        return {"rgb": r((T, 3, H // 4, W // 4))}
    if piece == "stage1":
        return {"rgb": (r((1, T, 3, H, W)) - 0.5).astype(lo), "hint": r((1, T, 1, H, W), lo),
                "hint_quality": np.full((1, T), 0.95, lo), "moge": r((1, T, 768, H // 64, W // 64)),
                "cradio": r((1, T, 1152, H // 64, W // 64)), "rvm": r((1, T, 384, H // 64, W // 64))}
    return {"rgb": (r((1, 1, 3, H, W)) - 0.5).astype(lo), "baton": r((1, 1, 512, H // 16, W // 16))}


def run(path, feed, ep):
    prov = ["CUDAExecutionProvider", "CPUExecutionProvider"] if ep == "cuda" else ["CPUExecutionProvider"]
    s = ort.InferenceSession(path, providers=prov)
    if ep == "cuda" and s.get_providers()[0] != "CUDAExecutionProvider":
        raise SystemExit(f"CUDA provider not loaded for {path} (got {s.get_providers()}): set LD_LIBRARY_PATH")
    # loop: NOT-WORTH — a network's few inputs
    names = {i.name for i in s.get_inputs()}
    # loop: NOT-WORTH — one or two outputs
    return [o.astype(np.float32) for o in s.run(None, {k: v for k, v in feed.items() if k in names})]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("old")
    ap.add_argument("new")
    ap.add_argument("sizes", nargs="+")
    ap.add_argument("--prec", default="fp16", choices=["fp16", "fp32"])
    ap.add_argument("--ep", default="cpu", choices=["cpu", "cuda"])
    ap.add_argument("--pieces", default="cradio,stage2,stage1")
    a = ap.parse_args()
    # loop: SERIAL-REQUIRED — one size at a time (memory)
    for size in a.sizes:
        # loop: NOT-WORTH — three numbers of one size
        H, W, T = (int(v) for v in size.lower().split("x"))
        # loop: SERIAL-REQUIRED — up to three networks, one session at a time
        for piece in a.pieces.split(","):
            feed = feeds(piece, H, W, T, a.prec == "fp16", np.random.default_rng(0))
            f = f"ck2-{piece}-{a.prec}.onnx"
            old, new = run(f"{a.old}/{f}", feed, a.ep), run(f"{a.new}/{f}", feed, a.ep)
            rec = {"piece": piece, "size": size, "prec": a.prec, "ep": a.ep, "outputs": []}
            # loop: NOT-WORTH — one or two outputs
            for x, y in zip(old, new):
                d = np.abs(x - y)
                rec["outputs"].append({"shape": list(x.shape), "max": float(d.max()), "mean": float(d.mean()),
                                       "absmax_old": float(np.abs(x).max()), "nonfinite_new": int((~np.isfinite(y)).sum())})
            if piece == "stage2":
                sig = lambda v: 1 / (1 + np.exp(-v[:, :, 0]))  # noqa: E731
                dm = np.abs(sig(old[0]) - sig(new[0]))
                rec["matte"] = {"max": float(dm.max()), "mean": float(dm.mean()), "max_x255": float(dm.max() * 255)}
            print("NET_PARITY " + json.dumps(rec), flush=True)


if __name__ == "__main__":
    main()
