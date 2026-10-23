"""Check that to_trt.py's rewrite computes the same function as the production file (ORT CPU, fp32).

usage: python trt_conv_check.py PIECE H W T PROD.onnx TRT.onnx

H, W: padded model resolution (multiple of 128); T: window / batch. Random inputs in the networks' ranges
(seeded), both files on ONNX Runtime's CPU provider. Prints CONV {piece, shape, max_abs, mean_abs, ref_absmax}.
"""
import json
import sys

import numpy as np
import onnxruntime as ort


def inputs(piece, H, W, T, rng):
    h64, w64 = H // 64, W // 64
    u = lambda *s: rng.random(s, dtype=np.float32)
    n = lambda *s: rng.standard_normal(s, dtype=np.float32)
    if piece == "cradio":
        return {"rgb": u(T, 3, H // 4, W // 4)}
    if piece == "moge":
        return {"rgb": u(T, 3, H * 7 // 32, W * 7 // 32)}
    if piece == "rvm":
        return {"frame": u(1, 3, H // 4, W // 4), "state": n(1, 1 + h64 * w64, 384)}
    if piece == "stage1":
        return {"rgb": n(1, T, 3, H, W) * 0.5, "hint": u(1, T, 1, H, W), "hint_quality": np.full((1, T), 0.95, np.float32),
                "moge": n(1, T, 768, h64, w64), "cradio": n(1, T, 1152, h64, w64), "rvm": n(1, T, 384, h64, w64)}
    if piece == "stage2":
        return {"rgb": n(1, T, 3, H, W) * 0.5, "baton": n(1, T, 512, H // 16, W // 16)}
    raise SystemExit(piece)


def main():
    piece, H, W, T, a, b = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5], sys.argv[6]
    feeds = inputs(piece, H, W, T, np.random.default_rng(0))
    res = []
    for f in (a, b):
        s = ort.InferenceSession(f, providers=["CPUExecutionProvider"])
        dt = {i.name: (np.float16 if i.type == "tensor(float16)" else np.float32) for i in s.get_inputs()}
        res.append([o.astype(np.float32) for o in s.run(None, {k: v.astype(dt[k]) for k, v in feeds.items()})])
        del s
    out = {"piece": piece, "H": H, "W": W, "T": T, "outputs": []}
    for x, y in zip(*res):
        d = np.abs(x - y)
        out["outputs"].append({"shape": list(x.shape), "max_abs": float(d.max()), "mean_abs": float(d.mean()),
                               "ref_absmax": float(np.abs(x).max()), "nonfinite": int((~np.isfinite(y)).sum())})
    print("CONV " + json.dumps(out))


if __name__ == "__main__":
    main()
