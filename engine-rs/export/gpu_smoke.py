"""Seconds-long CUDA EP smoke test (RVM step only, tiny input)."""
import onnxruntime as ort
ort.preload_dlls()
import gpu_guard
gpu_guard.start()
import numpy as np
from common import ONNX_DIR
for tag in ("op23", "op23fp16"):
    s = ort.InferenceSession(str(ONNX_DIR / f"rvm_{tag}.onnx"),
                             providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    dt = np.float16 if s.get_inputs()[0].type == "tensor(float16)" else np.float32
    f, st = s.run(None, {"frame": np.random.rand(1, 3, 64, 64).astype(dt),
                         "state": np.zeros((1, 17, 384), dt)})
    print("SMOKE", tag, s.get_providers()[0], f.shape, f.dtype, np.isfinite(f).all())
print("SMOKE peak_mib", gpu_guard.peak_mib()); gpu_guard.stop()
