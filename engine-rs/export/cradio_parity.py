"""C-RADIO parity on portrait, landscape and square inputs (CPU).

usage: python cradio_parity.py [--onnx FILE ...] [--shapes 1280x768,768x1280,...] [--N 2]

Shapes are the padded model resolution H x W (multiple of 128); C-RADIO takes
(N, 3, H/4, W/4). Reference: upstream PyTorch fp32 (CradioPiece, unpatched).
Prints per shape: patched PyTorch vs upstream (must be 0: the patch is exact),
then each ONNX file vs upstream: max / mean abs difference of `feat`.
"""
import argparse
import json

import numpy as np
import torch

from common import load_cpu_model


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--onnx", nargs="*", default=[])
    ap.add_argument("--shapes", default="1280x768,768x1280,1152x640,640x1152,768x768,1920x1152")
    ap.add_argument("--N", type=int, default=2)
    a = ap.parse_args()

    import onnx_patches
    import wrappers as wr
    model = load_cpu_model()
    piece = wr.CradioPiece(model.foundations).eval()
    onnx_patches.apply_cradio()
    import sys
    cls = sys.modules["_corridorkey_cradio_snapshot.vit_patch_generator"].ViTPatchGenerator

    import onnxruntime as ort
    sessions = []
    for f in a.onnx:
        so = ort.SessionOptions()
        sessions.append((f, ort.InferenceSession(f, so, providers=["CPUExecutionProvider"])))

    g = torch.Generator().manual_seed(0)
    rows = []
    for shp in a.shapes.split(","):
        H, W = (int(v) for v in shp.split("x"))
        # Smooth random images (low-res noise upsampled), closer to real frames than white noise.
        x = torch.rand(a.N, 3, max(H // 64, 1), max(W // 64, 1), generator=g)
        x = torch.nn.functional.interpolate(x, size=(H // 4, W // 4), mode="bilinear", align_corners=False)
        x = (x + 0.05 * torch.rand(x.shape, generator=g)).clamp(0, 1)
        cls._get_pos_embeddings = onnx_patches._ORIG_CRADIO_POS  # upstream
        with torch.no_grad():
            ref = piece(x).numpy()
        cls._get_pos_embeddings = onnx_patches.cradio_pos_embeddings  # patched
        with torch.no_grad():
            pat = piece(x).numpy()
        rec = {"shape": [H, W], "feat": list(ref.shape), "ref_absmax": float(np.abs(ref).max()),
               "patched_torch_max": float(np.abs(pat - ref).max())}
        for f, s in sessions:
            try:
                out = s.run(None, {"rgb": x.numpy()})[0]
                d = np.abs(out.astype(np.float64) - ref)
                rec["/".join(f.rsplit("/", 2)[-2:])] = {"max": float(d.max()), "mean": float(d.mean()),
                                             "nonfinite": int((~np.isfinite(out)).sum())}
            except Exception as e:  # record the exact error
                rec["/".join(f.rsplit("/", 2)[-2:])] = {"error": f"{type(e).__name__}: {str(e)[:300]}"}
        print("CRADIO_PARITY " + json.dumps(rec), flush=True)
        rows.append(rec)


if __name__ == "__main__":
    main()
