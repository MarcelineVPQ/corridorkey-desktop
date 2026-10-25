"""Write <scratch>/models/manifest.json for the production ONNX set.

usage: python make_manifest.py VERSION [MODELS_DIR]

MODELS_DIR defaults to <scratch>/models. A set whose stage 1 / stage 2 went through speed_patches.py
(2.0.0-onnx.2 on) says so in "exporter" and per model in "rewrites".

One entry per model file: name, piece, precision, opset imports, IR version,
inputs/outputs (name, element type, dims; strings are dynamic axes), and
size + sha256 of the .onnx and its external .onnx.data. Also records the
sha256 of the source checkpoint the set was exported from.
"""
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import onnx

from common import REPO, SCRATCH

MODELS = SCRATCH / "models"
PIECES = ("cradio", "moge", "rvm", "stage1", "stage2")
ELEM = {1: "float32", 10: "float16", 7: "int64", 9: "bool", 6: "int32"}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 24), b""):
            h.update(b)
    return h.hexdigest()


def io(vs):
    return [{"name": v.name, "dtype": ELEM.get(v.type.tensor_type.elem_type, str(v.type.tensor_type.elem_type)),
             "dims": [d.dim_param or d.dim_value for d in v.type.tensor_type.shape.dim]} for v in vs]


def main():
    global MODELS
    version = sys.argv[1]
    if len(sys.argv) > 2:
        MODELS = Path(sys.argv[2]).expanduser().resolve()
    sped = version not in ("2.0.0-onnx.1",)
    portrait = version not in ("2.0.0-onnx.1", "2.0.0-onnx.2")  # C-RADIO with a non-square position grid
    # MoGe, RVM, stage 1, stage 2 fp16 under the original's precision policy (export.py --amp), onnx.4 on
    amp = version not in ("2.0.0-onnx.1", "2.0.0-onnx.2", "2.0.0-onnx.3")
    entries = []
    for piece in PIECES:
        for prec in ("fp32", "fp16"):
            f = MODELS / f"ck2-{piece}-{prec}.onnx"
            data = f.with_name(f.name + ".data")
            m = onnx.load(str(f), load_external_data=False)
            ops = sorted({(n.domain or "ai.onnx") + "::" + n.op_type for n in m.graph.node
                          if n.op_type in ("Attention", "MultiHeadAttention")})
            entries.append({
                "name": f.name, "piece": piece, "precision": prec,
                "precision_note": ("mixed: fp32 weights, fp16 compute (exported under fp16 autocast)"
                                   if piece == "cradio" and prec == "fp16" else
                                   "mixed, the original's autocast policy: fp16 conv/matmul/attention and fp16 "
                                   "weights for them, fp32 where CUDA autocast keeps fp32 (export.py --amp, fold_casts.py)"
                                   if amp and prec == "fp16" else prec),
                "opset": {o.domain or "ai.onnx": o.version for o in m.opset_import},
                "ir_version": m.ir_version, "attention_ops": ops,
                "rewrites": (["speed_patches.py: window pads, depatchify ConvTranspose, grouped 7x7 convs"]
                             if sped and piece in ("stage1", "stage2") else [])
                + (["onnx_patches.cradio_pos_embeddings: position grid follows the input's rows x cols (portrait)"]
                   if portrait and piece == "cradio" else []),
                "inputs": io(m.graph.input), "outputs": io(m.graph.output),
                "files": [{"file": p.name, "bytes": p.stat().st_size, "sha256": sha256(p)} for p in (f, data)],
            })
            print("MANIFEST", f.name, entries[-1]["files"][1]["bytes"])
    # CK_CHECKPOINT: the checkpoint file when this checkout has none (a worktree: weights/ is not in git)
    ckpt = Path(os.environ.get("CK_CHECKPOINT", REPO / "weights" / "corridorkey_v2.safetensors")).resolve()
    man = {
        "format": "corridorkey-onnx-models/1",
        "version": version,
        "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "source_checkpoint": {"file": ckpt.name, "sha256": sha256(ckpt)},
        "onnxruntime_min": "1.31.0",
        "exporter": "torch.onnx.export(dynamo=True) torch 2.9.1, onnxscript 0.7.2; "
                    "engine-rs/export/build_models.sh (onnx_patches v2 + to_mha.py"
                    + (" + fold_casts.py on the --amp fp16 exports" if version not in ("2.0.0-onnx.1", "2.0.0-onnx.2", "2.0.0-onnx.3") else "")
                    + (" + speed_patches.py on stage 1 / stage 2)" if sped else ")"),
        "contract": "docs/ONNX_EXPORT.md section 'Production model set' (host-side steps, shapes, session options)",
        "models": entries,
    }
    (MODELS / "manifest.json").write_text(json.dumps(man, indent=2) + "\n")
    # Lookup table in the format the Rust engine's runtime.rs reads (models.json).
    lookup = {prec: {e["piece"]: e["name"] for e in entries if e["precision"] == prec} for prec in ("fp16", "fp32")}
    (MODELS / "models.json").write_text(json.dumps(lookup, indent=2) + "\n")
    print("MANIFEST written", MODELS / "manifest.json", len(entries), "models")


if __name__ == "__main__":
    main()
