"""Run the real ORT 1.31 Core ML EP partitioner (Linux build: model is generated, never executed; on a Mac the model
is also compiled). COREML_PROBE_UNITS: Core ML's MLComputeUnits (default ALL; CPUAndGPU on a 16 GB Mac, where ALL
compiles for the Neural Engine and can run out of memory).
usage: ep_probe.py MODEL.onnx [MLProgram|NeuralNetwork] [static0|static1]  -> verbose log on stderr"""
import sys, os, time, onnxruntime as ort
model = sys.argv[1]
fmt = sys.argv[2] if len(sys.argv) > 2 else "MLProgram"
static = sys.argv[3] if len(sys.argv) > 3 else "static0"
cache = os.environ.get("COREML_PROBE_CACHE") or os.path.join(os.path.dirname(os.path.abspath(model)), "coreml-probe-cache", os.path.basename(model) + "-" + fmt)
os.makedirs(cache, exist_ok=True)
so = ort.SessionOptions()
so.log_severity_level = 0
so.log_verbosity_level = 0
# loop: NOT-WORTH — the few dimension overrides given
for kv in os.environ.get("FREE_DIMS", "").split(","):
    if kv:
        k, v = kv.split("=")
        so.add_free_dimension_override_by_name(k, int(v))
t = time.time()
s = ort.InferenceSession(model, so, providers=[("CoreMLExecutionProvider",
        {"ModelFormat": fmt, "RequireStaticInputShapes": "1" if static == "static1" else "0", "ModelCacheDirectory": cache,
         "MLComputeUnits": os.environ.get("COREML_PROBE_UNITS", "ALL")}),
        "CPUExecutionProvider"])
print("SESSION_OK", model, fmt, static, f"{time.time()-t:.1f}s", file=sys.stderr)
