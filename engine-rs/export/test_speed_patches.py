"""Parity of speed_patches.py (CPU, fp32). usage: python test_speed_patches.py ORIG_DIR NEW_DIR
1. each rewritten ConvTranspose alone (the network's real weights) against the original node;
2. each window-pad rewrite alone (rank 4 and 5, odd sizes);
3. whole stage 1 / stage 2, original file vs patched file, same random inputs."""
import sys
import numpy as np, onnx, onnxruntime as ort
from onnx import helper, numpy_helper, TensorProto
from speed_patches import patch

ORIG, NEW = sys.argv[1], sys.argv[2]
rng = np.random.default_rng(0)
cpu = ["CPUExecutionProvider"]


def run(m, feed):
    s = ort.InferenceSession(m.SerializeToString(), providers=cpu)
    return s.run(None, feed)


def deconv_case(piece, node_name, h, w):
    full = onnx.load(f"{ORIG}/ck2-{piece}-fp32.onnx", load_external_data=True)
    node = next(n for n in full.graph.node if n.name == node_name)
    inits = [i for i in full.graph.initializer if i.name in node.input]
    cin = numpy_helper.to_array(inits[0]).shape[0] if inits[0].name == node.input[1] else None
    wt = next(numpy_helper.to_array(i) for i in inits if i.name == node.input[1])
    cin, cout = wt.shape[:2]
    g = helper.make_graph([helper.make_node("ConvTranspose", ["X", node.input[1], node.input[2]], ["Y"], name="ct",
                                            **{a.name: helper.get_attribute_value(a) for a in node.attribute})],
                          "t", [helper.make_tensor_value_info("X", TensorProto.FLOAT, [1, cin, h, w])],
                          [helper.make_tensor_value_info("Y", TensorProto.FLOAT, [None] * 4)], inits)
    m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 23)], ir_version=10)
    x = rng.standard_normal((1, cin, h, w), dtype=np.float32)
    ref = run(m, {"X": x})[0]
    m2 = onnx.load_from_string(m.SerializeToString())
    assert patch(m2) == (0, 1)
    out = run(m2, {"X": x})[0]
    print(f"NODE {piece} {node_name} in {(1, cin, h, w)} out {ref.shape}: max|diff| {np.abs(out - ref).max():.3e} (max|ref| {np.abs(ref).max():.3f})")
    return float(np.abs(out - ref).max())


def dw_case(piece, node_name, h, w, n=1):
    full = onnx.load(f"{ORIG}/ck2-{piece}-fp32.onnx", load_external_data=True)
    prod = {o: x for x in full.graph.node for o in x.output}
    inits = {i.name: i for i in full.graph.initializer}
    node = next(x for x in full.graph.node if x.name == node_name)
    rs = prod[node.input[1]]; cat = prod[rs.input[0]]; uns = [prod[u] for u in cat.input]
    rs_shape = prod[rs.input[1]] if rs.input[1] in prod else None
    keep = [inits[u.input[0]] for u in uns] + [inits[node.input[2]]]
    extra_nodes = []
    for nm in [u.input[1] for u in uns] + [rs.input[1]]:
        if nm in inits: keep.append(inits[nm])
        elif nm in prod: extra_nodes.append(prod[nm])
    keep = list({k.name: k for k in keep}.values())
    g = int(next(helper.get_attribute_value(a) for a in node.attribute if a.name == "group"))
    nodes = extra_nodes + uns + [cat, rs, node]
    nodes = [x for i, x in enumerate(nodes) if x not in nodes[:i]]
    gr = helper.make_graph(nodes, "d", [helper.make_tensor_value_info(node.input[0], TensorProto.FLOAT, [n, g, h, w])],
                           [helper.make_tensor_value_info(node.output[0], TensorProto.FLOAT, [None] * 4)], keep)
    m = helper.make_model(gr, opset_imports=[helper.make_opsetid("", 23)], ir_version=10)
    x = rng.standard_normal((n, g, h, w), dtype=np.float32)
    ref = run(m, {node.input[0]: x})[0]
    m2 = onnx.load_from_string(m.SerializeToString())
    patch(m2)
    assert patch.last_dw == 1
    out = run(m2, {node.input[0]: x})[0]
    d = float(np.abs(out - ref).max())
    print(f"DW {piece} {node_name} in {(n, g, h, w)} out {ref.shape}: max|diff| {d:.3e} (max|ref| {np.abs(ref).max():.3f})")
    return d


def pad_case(shape):
    r = len(shape)
    H, W = shape[-3], shape[-2]
    Hp, Wp = -(-H // 16) * 16, -(-W // 16) * 16
    z = numpy_helper.from_array(np.array([0], np.int64), "z")
    nodes = [helper.make_node("Constant", [], ["hp"], value=numpy_helper.from_array(np.array([Hp - H], np.int64))),
             helper.make_node("Constant", [], ["wp"], value=numpy_helper.from_array(np.array([Wp - W], np.int64)))]
    pads = ["z"] * r + ["z"] * (r - 3) + ["hp", "wp", "z"]
    nodes += [helper.make_node("Concat", pads, ["pads"], axis=0), helper.make_node("Pad", ["X", "pads"], ["Y"], mode="constant")]
    g = helper.make_graph(nodes, "p", [helper.make_tensor_value_info("X", TensorProto.FLOAT, list(shape))],
                          [helper.make_tensor_value_info("Y", TensorProto.FLOAT, [None] * r)], [z])
    m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 23)], ir_version=10)
    x = rng.standard_normal(shape, dtype=np.float32)
    ref = run(m, {"X": x})[0]
    m2 = onnx.load_from_string(m.SerializeToString())
    assert patch(m2) == (1, 0)
    out = run(m2, {"X": x})[0]
    assert out.shape == ref.shape, (out.shape, ref.shape)
    d = float(np.abs(out - ref).max())
    print(f"PAD {shape} -> {ref.shape}: max|diff| {d:.3e}")
    return d


def whole(piece, H, W, T):
    H64, W64, H16, W16 = H // 64, W // 64, H // 16, W // 16
    shapes = {"stage2": {"rgb": (1, T, 3, H, W), "baton": (1, T, 512, H16, W16)},
              "stage1": {"rgb": (1, T, 3, H, W), "hint": (1, T, 1, H, W), "hint_quality": (1, T), "moge": (1, T, 768, H64, W64),
                         "cradio": (1, T, 1152, H64, W64), "rvm": (1, T, 384, H64, W64)}}[piece]
    feed = {k: rng.random(v, dtype=np.float32) for k, v in shapes.items()}
    if piece == "stage1":
        feed["hint_quality"][:] = -1
        feed["baton_dummy"] = None
        del feed["baton_dummy"]
    so = ort.SessionOptions()
    a = ort.InferenceSession(f"{ORIG}/ck2-{piece}-fp32.onnx", so, providers=cpu).run(None, feed)
    b = ort.InferenceSession(f"{NEW}/ck2-{piece}-fp32.onnx", so, providers=cpu).run(None, feed)
    for i, (x, y) in enumerate(zip(a, b)):
        print(f"WHOLE {piece} {W}x{H} T={T} output {i} {x.shape}: max|diff| {np.abs(x - y).max():.3e} (max|ref| {np.abs(x).max():.3f})")


if __name__ == "__main__":
    which = sys.argv[3:] or ["node", "dw", "pad", "stage2", "stage1"]
    if "node" in which:
        deconv_case("stage2", "node_convolution", 72, 80)
        deconv_case("stage2", "node_convolution", 5, 3)
        deconv_case("stage1", "node_convolution_1", 72, 80)
    if "dw" in which:
        dw_case("stage2", "node_conv2d_1", 78, 86)
        dw_case("stage1", "node_conv2d_1", 30, 22, n=3)
        dw_case("stage1", "node_conv2d_11", 24, 26, n=2)
    if "pad" in which:
        for sh in [(1, 72, 80, 64), (2, 9, 13, 8), (1, 3, 72, 80, 16), (2, 2, 16, 16, 4)]:
            pad_case(sh)
    if "stage2" in which:
        whole("stage2", 384, 640, 1)
        whole("stage2", 256, 384, 2)
    if "stage1" in which:
        whole("stage1", 384, 640, 2)
