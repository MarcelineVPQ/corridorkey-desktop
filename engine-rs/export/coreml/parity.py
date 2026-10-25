"""CPU parity of two graphs with the same inputs/outputs (stock ORT, CPU EP).
usage: parity.py A.onnx B.onnx [basic|all]  -> per output: bit-identical?, max/mean abs diff, max |ref|"""
import sys, time, numpy as np, onnxruntime as ort
a, b = sys.argv[1], sys.argv[2]
lvl = {"none": ort.GraphOptimizationLevel.ORT_DISABLE_ALL, "basic": ort.GraphOptimizationLevel.ORT_ENABLE_BASIC, "all": ort.GraphOptimizationLevel.ORT_ENABLE_ALL}[
    sys.argv[3] if len(sys.argv) > 3 else "basic"]
rng = np.random.default_rng(0)
def sess(p):
    so = ort.SessionOptions(); so.graph_optimization_level = lvl; so.log_severity_level = 3
    so.intra_op_num_threads = 8
    return ort.InferenceSession(p, so, providers=["CPUExecutionProvider"])
A = sess(a)
feeds = {}
for i in A.get_inputs():
    dt = np.float16 if "float16" in i.type else np.float32
    if i.name in ("rgb", "frame", "hint"):
        x = rng.random(i.shape)
    elif i.name == "hint_quality":
        x = np.full(i.shape, 0.95)
    else:
        x = rng.standard_normal(i.shape)
    feeds[i.name] = x.astype(dt)
t = time.time(); ra = A.run(None, feeds); ta = time.time() - t
del A
B = sess(b)
t = time.time(); rb = B.run(None, feeds); tb = time.time() - t
names = [o.name for o in B.get_outputs()]
for n, x, y in zip(names, ra, rb):
    x32, y32 = x.astype(np.float64), y.astype(np.float64)
    d = np.abs(x32 - y32)
    print(f"PARITY {a.split('/')[-1]} vs {b.split('/')[-1]} [{n} {list(x.shape)} {x.dtype}] bit-identical={np.array_equal(x, y)} "
          f"max={d.max():.3g} mean={d.mean():.3g} max|ref|={np.abs(x32).max():.3g} ({ta:.1f}s / {tb:.1f}s)")
