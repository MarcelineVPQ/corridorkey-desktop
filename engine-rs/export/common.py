"""Shared helpers for the ONNX spike (load model on CPU, scratch paths)."""
import os
import sys
from pathlib import Path

# the CorridorKey2.0 clone (model code + weights); these scripts live in corridorkey-desktop
REPO = Path(os.environ.get("CK2_REPO", Path.home() / "projects/CorridorKey2.0")).resolve()
SCRATCH = Path(os.environ.get(
    "CK_ONNX_SCRATCH", Path.home() / ".cache/claude-scratch/corridorkey-onnx"))
ONNX_DIR = SCRATCH / "onnx"
ONNX_DIR.mkdir(parents=True, exist_ok=True)
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))


def load_cpu_model():
    import torch
    from corridorkey.runtime import RuntimePaths, load_model
    torch.set_grad_enabled(False)
    paths = RuntimePaths.from_package(REPO)
    model = load_model(paths, device="cpu")
    return model.float().eval()
