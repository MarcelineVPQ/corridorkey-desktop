"""Exact speed rewrites of the production stage-1 / stage-2 graphs (set 2.0.0-onnx.2).

usage: python speed_patches.py IN.onnx OUT.onnx [--no-pad] [--no-deconv] [--no-dw]

Both rewrites only move data or reorder the same products; measured on CUDA, RTX 5080, ORT 1.31
(docs/ONNX_EXPORT.md, "Speed rewrites").

1. Window padding (`--no-pad` skips it). The mask-free Swin blocks pad channel-last tensors
   (B, H, W, C) / (B, T, H, W, C) at the end of H and W (`F.pad(x, (0, 0, 0, Wp-W, 0, Hp-H))`, pads
   computed in the graph). ORT's CUDA Pad runs those through its generic N-d kernel (~2 ms per call at
   1280x1152 for stage 2, ~7 ms at T=8 for stage 1). Rewritten as
       Reshape(x, (-1, 1, H, W*C)) -> Pad(0,0,0,0, 0,0,Hp-H,(Wp-W)*C) -> Reshape(..., Hp, Wp, C)
   which is the same zero padding (row-major: padding W*C at the end of each row = padding W by
   Wp-W columns of C values), and hits ORT's 4D "pad along H and W" kernel.

2. Depatchify ConvTranspose (`--no-deconv` skips it). stride s, kernel 2s, pad s/2, groups 1:
   out_full[s*q + r] = X[q] * Wt[r] + X[q-1] * Wt[r + s]   (q = 0..h, r = 0..s-1, X[-1] = X[h] = 0)
   i.e. a 2x2 Conv over X zero-padded by 1 to Cout*s*s channels (channel co*s*s + ry*s + rx, tap t
   taking block 1-t of the kernel), DepthToSpace(s, CRD), then the crop of s/2 the ConvTranspose's
   pads do. Same products and bias, different summation order.

3. Grouped 7x7 convs with two filters per channel (`--no-dw` skips it). DepthwiseSwiGLU2D runs value and
   gate as one Conv(group=dim, 2*dim filters); cuDNN's grouped kernel takes ~6x the time of a plain
   depthwise conv of the same output size. The input channels are repeated in place
   (Unsqueeze -> Expand(m) -> Reshape: channel c*m + j = channel c) and the same weights run with
   group = 2*dim: identical products per output channel.
"""
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto


class G:
    def __init__(self, m):
        self.m = m
        self.g = m.graph
        self.k = 0
        # loop: NOT-WORTH — one pass over the initializers, offline
        self.inits = {i.name: i for i in self.g.initializer}
        # loop: NOT-WORTH — one pass over the nodes' outputs, offline
        self.prod = {o: n for n in self.g.node for o in n.output}

    def name(self, base):
        self.k += 1
        return f"speed_{base}_{self.k}"

    def const(self, base, arr):
        n = self.name(base)
        self.g.initializer.append(numpy_helper.from_array(np.asarray(arr), n))
        return n

    def node(self, op, ins, base, **attrs):
        out = self.name(base)
        return helper.make_node(op, ins, [out], name=out + "_n", **attrs), out

    def value(self, name):
        """A small constant input's value (initializer or Constant node), else None."""
        if name in self.inits:
            i = self.inits[name]
            if i.data_location == TensorProto.EXTERNAL:
                return None
            return numpy_helper.to_array(i)
        n = self.prod.get(name)
        if n is not None and n.op_type == "Constant":
            return numpy_helper.to_array(n.attribute[0].t)
        return None


def window_pad_rank(G_, pad_node):
    """Rank of the padded tensor if this is the Swin window pad (constant mode, pads = Concat of 2r
    one-element pieces, all zero except the ends of H and W), else None."""
    # loop: NOT-WORTH — one node's few attributes
    attrs = {a.name: helper.get_attribute_value(a) for a in pad_node.attribute}
    if attrs.get("mode", b"constant") != b"constant" or len(pad_node.input) < 2:
        return None
    if len(pad_node.input) > 3 and pad_node.input[3]:
        return None  # axes input
    cat = G_.prod.get(pad_node.input[1])
    if cat is None or cat.op_type != "Concat":
        return None
    n = len(cat.input)
    if n % 2 or n < 8:
        return None
    r = n // 2
    # loop: NOT-WORTH — one Concat's few inputs
    for idx, src in enumerate(cat.input):
        if idx in (2 * r - 3, 2 * r - 2):
            continue  # end of H, end of W: computed
        v = G_.value(src)
        if v is None or v.size != 1 or int(v.reshape(-1)[0]) != 0:
            return None
    return r


def rewrite_pad(G_, pad_node, r):
    x, pads = pad_node.input[0], pad_node.input[1]
    out = pad_node.output[0]
    nodes = []

    def add(op, ins, base, **a):
        n, o = G_.node(op, ins, base, **a)
        nodes.append(n)
        return o

    i64 = lambda v: G_.const("c", np.array(v, dtype=np.int64))
    S = add("Shape", [x], "shape")
    H = add("Slice", [S, i64([-3]), i64([-2])], "H")
    W = add("Slice", [S, i64([-2]), i64([-1])], "W")
    C = add("Slice", [S, i64([-1]), i64([r])], "C")
    lead = add("Slice", [S, i64([0]), i64([r - 3])], "lead")
    hp = add("Slice", [pads, i64([2 * r - 3]), i64([2 * r - 2])], "hp")
    wp = add("Slice", [pads, i64([2 * r - 2]), i64([2 * r - 1])], "wp")
    WC = add("Mul", [W, C], "WC")
    shp4 = add("Concat", [i64([-1, 1]), H, WC], "shp4", axis=0)
    x4 = add("Reshape", [x, shp4], "x4")
    wpC = add("Mul", [wp, C], "wpC")
    pads4 = add("Concat", [i64([0, 0, 0, 0, 0, 0]), hp, wpC], "pads4", axis=0)
    pin = [x4, pads4] + ([pad_node.input[2]] if len(pad_node.input) > 2 and pad_node.input[2] else [])
    y4 = add("Pad", pin, "y4", mode="constant")
    Hp = add("Add", [H, hp], "Hp")
    Wp = add("Add", [W, wp], "Wp")
    shp = add("Concat", [lead, Hp, Wp, C], "shp", axis=0)
    nodes.append(helper.make_node("Reshape", [y4, shp], [out], name=G_.name("y") + "_n"))
    return nodes


def rewrite_deconv(G_, node):
    # loop: NOT-WORTH — one node's few attributes
    attrs = {a.name: helper.get_attribute_value(a) for a in node.attribute}
    k = list(attrs.get("kernel_shape", []))
    s = list(attrs.get("strides", [1, 1]))
    p = list(attrs.get("pads", [0, 0, 0, 0]))
    ok = (len(k) == 2 and k[0] == k[1] and s[0] == s[1] and k[0] == 2 * s[0] and s[0] % 2 == 0
          and p == [s[0] // 2] * 4 and attrs.get("group", 1) == 1
          and list(attrs.get("dilations", [1, 1])) == [1, 1]
          and list(attrs.get("output_padding", [0, 0])) == [0, 0]
          and attrs.get("auto_pad", b"NOTSET") == b"NOTSET" and "output_shape" not in attrs)
    if not ok or node.input[1] not in G_.inits:
        return None
    s = s[0]
    wt = numpy_helper.to_array(G_.inits[node.input[1]])  # (Cin, Cout, 2s, 2s)
    cin, cout = wt.shape[0], wt.shape[1]
    # K[co, ry, rx, ci, ty, tx] = Wt[ci, co, ry + s(1-ty), rx + s(1-tx)]
    w6 = wt.reshape(cin, cout, 2, s, 2, s)  # [ci, co, a, ry, b, rx], kernel index = a*s + ry
    w6 = w6[:, :, ::-1, :, ::-1, :]  # tap t = 1 - a
    K = np.ascontiguousarray(w6.transpose(1, 3, 5, 0, 2, 4)).reshape(cout * s * s, cin, 2, 2)
    nodes = []
    kname = G_.const("deconv_w", K.astype(wt.dtype))
    ins = [node.input[0], kname]
    if len(node.input) > 2 and node.input[2]:
        b = numpy_helper.to_array(G_.inits[node.input[2]])
        ins.append(G_.const("deconv_b", np.repeat(b, s * s).astype(b.dtype)))
    n, y = G_.node("Conv", ins, "deconv_conv", kernel_shape=[2, 2], pads=[1, 1, 1, 1], strides=[1, 1])
    nodes.append(n)
    n, z = G_.node("DepthToSpace", [y], "deconv_d2s", blocksize=s, mode="CRD")
    nodes.append(n)
    i64 = lambda v: G_.const("c", np.array(v, dtype=np.int64))
    # crop s/2 at each end of H and W: [s/2, end - s/2)
    nodes.append(helper.make_node("Slice", [z, i64([s // 2, s // 2]), i64([-(s // 2), -(s // 2)]), i64([2, 3])],
                                  [node.output[0]], name=G_.name("deconv_crop") + "_n"))
    return nodes, node.input[1]


def patch(m, do_pad=True, do_deconv=True, do_dw=True):
    """Apply the rewrites to model `m` in place: (window pads, ConvTranspose, grouped convs) rewritten."""
    G_ = G(m)
    new_nodes, n_pad, n_dc, dead = [], 0, 0, []
    n_dw = 0
    # loop: NOT-WORTH — one pass over the graph's nodes, offline (an export step)
    for node in m.graph.node:
        if do_dw and node.op_type == "Conv":
            gm = grouped_multiplier(G_, node)
            if gm is not None:
                new_nodes.extend(rewrite_grouped(G_, node, *gm))
                n_dw += 1
                continue
        if do_pad and node.op_type == "Pad":
            r = window_pad_rank(G_, node)
            if r is not None:
                new_nodes.extend(rewrite_pad(G_, node, r))
                n_pad += 1
                continue
        if do_deconv and node.op_type == "ConvTranspose":
            res = rewrite_deconv(G_, node)
            if res is not None:
                new_nodes.extend(res[0])
                dead.append(res[1])
                n_dc += 1
                continue
        new_nodes.append(node)
    del m.graph.node[:]
    m.graph.node.extend(new_nodes)
    # loop: NOT-WORTH — one pass over the nodes' inputs, offline
    used = {i for n in m.graph.node for i in n.input}
    # loop: NOT-WORTH — one pass over the initializers, offline
    keep = [i for i in m.graph.initializer if not (i.name in dead and i.name not in used)]
    del m.graph.initializer[:]
    m.graph.initializer.extend(keep)
    onnx.checker.check_model(m, full_check=False)
    patch.last_dw = n_dw
    return n_pad, n_dc


def grouped_multiplier(G_, node):
    """(g, m) if `node` is a grouped Conv with g groups of one input channel and m filters each, its weight built
    as Reshape(Concat(Unsqueeze(W_i, 1) for i < m)) from (g, 1, k, k) initializers (DepthwiseSwiGLU2D)."""
    # loop: NOT-WORTH — one node's few attributes
    attrs = {a.name: helper.get_attribute_value(a) for a in node.attribute}
    g = attrs.get("group", 1)
    if g <= 1:
        return None
    rs = G_.prod.get(node.input[1])
    cat = G_.prod.get(rs.input[0]) if rs is not None and rs.op_type == "Reshape" else None
    if cat is None or cat.op_type != "Concat":
        return None
    # loop: NOT-WORTH — one Concat's few inputs
    for u in cat.input:
        un = G_.prod.get(u)
        if un is None or un.op_type != "Unsqueeze" or un.input[0] not in G_.inits:
            return None
        dims = list(G_.inits[un.input[0]].dims)
        if len(dims) != 4 or dims[0] != g or dims[1] != 1:
            return None
    return g, len(cat.input)


def rewrite_grouped(G_, node, g, m):
    """Each input channel repeated m times in place (channel c*m + j = channel c): the same filters then run as
    a plain depthwise conv (group = g*m), output channel o reading input channel o // m as before."""
    x = node.input[0]
    nodes = []

    def add(op, ins, base, **a):
        n, o = G_.node(op, ins, base, **a)
        nodes.append(n)
        return o

    i64 = lambda v: G_.const("c", np.array(v, dtype=np.int64))
    S = add("Shape", [x], "dw_shape")
    xu = add("Unsqueeze", [x, i64([2])], "dw_unsq")
    xe = add("Expand", [xu, i64([1, 1, m, 1, 1])], "dw_expand")
    shp = add("Concat", [add("Slice", [S, i64([0]), i64([1])], "dw_n"), i64([g * m]),
                         add("Slice", [S, i64([2]), i64([4])], "dw_hw")], "dw_shp", axis=0)
    xr = add("Reshape", [xe, shp], "dw_rep")
    # loop: NOT-WORTH — one node's few attributes
    attrs = {a.name: helper.get_attribute_value(a) for a in node.attribute if a.name != "group"}
    nodes.append(helper.make_node("Conv", [xr] + list(node.input[1:]), list(node.output), name=G_.name("dw_conv") + "_n",
                                  group=g * m, **attrs))
    return nodes


def main():
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    do_pad, do_deconv = "--no-pad" not in sys.argv, "--no-deconv" not in sys.argv
    m = onnx.load(str(src), load_external_data=True)
    n_pad, n_dc = patch(m, do_pad, do_deconv, "--no-dw" not in sys.argv)
    # loop: NOT-WORTH — the output file and its .data, removed before saving
    for f in (dst, dst.with_name(dst.name + ".data")):
        if f.exists():
            f.unlink()
    onnx.save(m, str(dst), save_as_external_data=True, all_tensors_to_one_file=True,
              location=dst.name + ".data", size_threshold=1024)
    print(f"SPEED_PATCHES {src.name} -> {dst.name}: window pads {n_pad}, ConvTranspose {n_dc}, grouped convs {patch.last_dw}")


if __name__ == "__main__":
    main()
