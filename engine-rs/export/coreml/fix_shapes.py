"""Write a fixed-shape copy of an ONNX graph next to the original (shares the .onnx.data file).
usage: fix_shapes.py IN.onnx OUT.onnx H W T   (padded H, W multiples of 128; T = window / batch)"""
import sys, os, onnx
src, dst, H, W, T = sys.argv[1], sys.argv[2], *map(int, sys.argv[3:6])
assert os.path.dirname(os.path.abspath(src)) == os.path.dirname(os.path.abspath(dst)), "same folder: shares .data"
dims = {"N": T, "T": T, "B": T, "H": H, "W": W, "H4": H // 4, "W4": W // 4, "HM": 7 * H // 32, "WM": 7 * W // 32,
        "H64": H // 64, "W64": W // 64, "H16": H // 16, "W16": W // 16, "NTOK": 1 + (H // 64) * (W // 64)}
m = onnx.load(src, load_external_data=False)
# loop: NOT-WORTH — a graph's few inputs, once
for v in m.graph.input:
    # loop: NOT-WORTH — one input's few dims
    for d in v.type.tensor_type.shape.dim:
        if d.dim_param:
            d.dim_value = dims[d.dim_param]
# loop: NOT-WORTH — a graph's few outputs, once
for v in m.graph.output:  # let ORT infer the outputs
    v.type.tensor_type.ClearField("shape")
onnx.save(m, dst)
# loop: NOT-WORTH — one print of the few inputs and their dims
print(dst, [(i.name, [d.dim_value for d in i.type.tensor_type.shape.dim]) for i in m.graph.input])
