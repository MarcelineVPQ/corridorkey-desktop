import sys, onnxruntime as ort
from common import ONNX_DIR
# loop: NOT-WORTH — the few pieces named on the command line, one load each
for p in sys.argv[2:]:
    try:
        ort.InferenceSession(str(ONNX_DIR / f"{p}_{sys.argv[1]}.onnx"), providers=["CPUExecutionProvider"]); print("LOAD_OK", p)
    except Exception as e:
        print("LOAD_FAIL", p, str(e)[:300])
