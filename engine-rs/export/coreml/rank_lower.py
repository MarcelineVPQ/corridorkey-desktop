"""Rank lowering + empty-tensor removal for a FIXED-shape ONNX graph (Core ML: rank <= 5, no 0-sized dims).

Every tensor of rank > 5 is stored as a <= 5-D tensor with the same row-major element order (its "physical"
shape C(t)). Each node that touches one runs on a merged-axis view of its inputs, between free Reshapes:
  elementwise / broadcast ops : adjacent axes with the same broadcast pattern merge
  Reshape/Squeeze/Unsqueeze/Flatten : one Reshape from the physical shape
  Transpose : axes that stay adjacent merge; if more than 5 groups remain, a chain of 4-D block swaps
  Slice / Pad : untouched adjacent axes merge
  Concat / Split / Gather / Softmax / Reduce* on one axis : (before, axis, after)
Tensors with a 0-sized dim are removed: a Concat drops such inputs; nodes whose outputs are all empty go.
Also: Gather with a scalar index on rank-5 data (Core ML EP: rank <= 4) -> Slice + Reshape.
All rewrites move or select the same elements: bit-identical.
"""
import numpy as np
import onnx
from onnx import helper, numpy_helper, shape_inference, TensorProto

ELEMENTWISE_UNARY = {"Cast", "Sigmoid", "Relu", "Tanh", "Erf", "Sqrt", "Exp", "Neg", "Abs", "Gelu", "Identity",
                     "Reciprocal", "Sin", "Cos", "Clip", "Softplus", "Floor", "Ceil", "Round", "LeakyRelu"}
BROADCAST = {"Add", "Sub", "Mul", "Div", "Pow", "Max", "Min", "Where", "Equal", "Less", "Greater", "And", "Or"}
RESHAPES = {"Reshape", "Squeeze", "Unsqueeze", "Flatten"}


class Bail(Exception):
    pass


def shapes_of(m):
    mi = shape_inference.infer_shapes(m, strict_mode=False, data_prop=True)
    sh, ty = {}, {}
    for v in list(mi.graph.value_info) + list(mi.graph.input) + list(mi.graph.output):
        t = v.type.tensor_type
        ty[v.name] = t.elem_type
        if t.HasField("shape") and all(d.HasField("dim_value") for d in t.shape.dim):
            sh[v.name] = [d.dim_value for d in t.shape.dim]
    for i in m.graph.initializer:
        sh[i.name] = list(i.dims)
        ty[i.name] = i.data_type
    return sh, ty


def canon(s):
    """physical <= 5-D shape for a high-rank shape: merge the leading axes."""
    if len(s) <= 5:
        return list(s)
    return [int(np.prod(s[: len(s) - 4]))] + list(s[len(s) - 4:])


def merge_runs(sig):
    """sig: per-axis signature (None = size-1 axis, joins any group). -> list of contiguous axis groups."""
    groups, cur, cs, pending = [], [], None, []
    for i, s in enumerate(sig):
        if s is None:
            (cur if cur else pending).append(i)
            continue
        if cur and s == cs:
            cur.append(i)
        else:
            if cur:
                groups.append(cur)
            cur, cs, pending = pending + [i], s, []
    if cur:
        groups.append(cur + pending)
    elif pending:
        groups.append(pending)
    return groups


class Rewriter:
    def __init__(self, m):
        self.m = m
        self.g = m.graph
        self.sh, self.ty = shapes_of(m)
        self.inits = {i.name: i for i in self.g.initializer}
        self.n = 0
        self.out = []
        self.changed = 0

    def name(self, b):
        self.n += 1
        return f"rl_{b}_{self.n}"

    def const(self, arr, b="c"):
        nm = self.name(b)
        self.g.initializer.append(numpy_helper.from_array(np.asarray(arr), nm))
        self.inits[nm] = self.g.initializer[-1]
        return nm

    def cval(self, nm):
        return numpy_helper.to_array(self.inits[nm]) if nm in self.inits else None

    def phys(self, t):
        return canon(self.sh[t])

    def reshape(self, x, cur, new):
        """x currently has shape `cur`; return a name with shape `new` (same elements)."""
        if list(cur) == list(new):
            return x
        o = self.name("r")
        self.out.append(helper.make_node("Reshape", [x, self.const(np.array(new, np.int64), "s")], [o], name=o))
        return o

    def to_view(self, t, view):
        return self.reshape(t, self.phys(t), view)

    def from_view(self, x, view, t_out):
        """x has shape `view`; produce tensor named t_out with its physical shape."""
        ph = self.phys(t_out)
        if list(view) == list(ph):
            self.out.append(helper.make_node("Identity", [x], [t_out], name=self.name("id")))
        else:
            self.out.append(helper.make_node("Reshape", [x, self.const(np.array(ph, np.int64), "s")], [t_out],
                                             name=self.name("r")))

    # ---------------------------------------------------------------- per-op
    def high(self, nd):
        ts = [t for t in list(nd.input) + list(nd.output) if t]
        for t in ts:
            if t not in self.sh:
                if t in nd.output and all(i in self.sh and len(self.sh[i]) <= 5 for i in nd.input if i):
                    continue
                raise Bail(f"no static shape for {t} ({nd.op_type} {nd.name})")
        return any(len(self.sh[t]) > 5 for t in ts if t in self.sh)

    def do_unary(self, nd):
        x, y = nd.input[0], nd.output[0]
        v = self.phys(x)
        xi = self.to_view(x, v)
        o = self.name("u")
        self.out.append(helper.make_node(nd.op_type, [xi] + list(nd.input[1:]), [o], name=nd.name, domain=nd.domain,
                                         **{a.name: helper.get_attribute_value(a) for a in nd.attribute}))
        self.sh[o] = v
        self.from_view(o, v, y)

    def do_broadcast(self, nd):
        y = nd.output[0]
        so = self.sh[y]
        r = len(so)
        ins = [self.sh[i] for i in nd.input]
        al = [[1] * (r - len(s)) + list(s) for s in ins]
        sig = []
        for a in range(r):
            if so[a] == 1:
                sig.append(None)
            else:
                sig.append(tuple(s[a] == 1 for s in al))
        groups = merge_runs(sig)
        if len(groups) > 5:
            raise Bail(f"broadcast groups {len(groups)} > 5 at {nd.name}")
        new_in = []
        for i, s in zip(nd.input, al):
            v = [int(np.prod([s[a] for a in g])) for g in groups]
            if i in self.inits and self.inits[i].data_location != TensorProto.EXTERNAL and np.prod(s) < 1 << 20:
                arr = self.cval(i).reshape(v)
                new_in.append(self.const(arr, "bc"))
            else:
                cur = self.sh[i]
                new_in.append(self.reshape(i, canon(cur), v))
        vo = [int(np.prod([so[a] for a in g])) for g in groups]
        o = self.name("b")
        self.out.append(helper.make_node(nd.op_type, new_in, [o], name=nd.name,
                                         **{a.name: helper.get_attribute_value(a) for a in nd.attribute}))
        self.sh[o] = vo
        self.from_view(o, vo, y)

    def do_reshape(self, nd):
        x, y = nd.input[0], nd.output[0]
        ph = self.phys(y)
        self.out.append(helper.make_node("Reshape", [x, self.const(np.array(ph, np.int64), "s")], [y], name=nd.name))

    def transpose_chain(self, x, dims, perm):
        """x has shape dims (reduced, no size-1 axes, merged runs); return name of transposed tensor."""
        k = len(dims)
        if k <= 5:
            o = self.name("t")
            self.out.append(helper.make_node("Transpose", [x], [o], perm=list(perm), name=o))
            return o
        cur = list(range(k))
        size = dict(enumerate(dims))
        perm = list(perm)
        while cur != perm:
            j = next(i for i in range(k) if cur[i] != perm[i])
            m = cur.index(perm[j])
            L = 1
            while m + L < k and j + L < k and cur[m + L] == perm[j + L]:
                L += 1
            pre = int(np.prod([size[a] for a in cur[:j]])) if j else 1
            mid = int(np.prod([size[a] for a in cur[j:m]]))
            blk = int(np.prod([size[a] for a in cur[m:m + L]]))
            rest = int(np.prod([size[a] for a in cur[m + L:]])) if m + L < k else 1
            v = [pre, mid, blk, rest]
            xr = self.reshape(x, [], v) if True else x
            o = self.name("tb")
            self.out.append(helper.make_node("Transpose", [xr], [o], perm=[0, 2, 1, 3], name=o))
            x = o
            cur = cur[:j] + cur[m:m + L] + cur[j:m] + cur[m + L:]
        return x

    def do_transpose(self, nd):
        x, y = nd.input[0], nd.output[0]
        s = self.sh[x]
        perm = [a.ints for a in nd.attribute if a.name == "perm"][0]
        keep = [a for a in range(len(s)) if s[a] != 1]
        kidx = {a: n for n, a in enumerate(keep)}
        p2 = [kidx[a] for a in perm if s[a] != 1]
        s = [s[a] for a in keep]
        groups, i = [], 0
        while i < len(p2):
            gr = [p2[i]]
            while i + 1 < len(p2) and p2[i + 1] == gr[-1] + 1:
                i += 1
                gr.append(p2[i])
            groups.append(gr)
            i += 1
        order_in = sorted(groups, key=lambda g: g[0])
        dims = [int(np.prod([s[a] for a in g])) for g in order_in]
        idx = {tuple(g): n for n, g in enumerate(order_in)}
        rp = [idx[tuple(g)] for g in groups]
        xv = self.to_view(x, dims if dims else [1])
        if len(dims) <= 1:
            o = xv
        else:
            o = self.transpose_chain(xv, dims, rp)
        vo = [dims[i] for i in rp] if dims else [1]
        self.from_view(o, vo, y)

    def do_axis_op(self, nd, axis_attr="axis", default=0):
        """Concat / Split / Softmax / single-axis reductions / Gather: view (pre, axis, post)."""
        x = nd.input[0]
        s = self.sh[x]
        r = len(s)
        a = {at.name: helper.get_attribute_value(at) for at in nd.attribute}
        if nd.op_type.startswith("Reduce"):
            axes = self.cval(nd.input[1]) if len(nd.input) > 1 else a.get("axes")
            axes = [int(v) % r for v in np.atleast_1d(axes)]
            if len(axes) != 1:
                raise Bail(f"multi-axis reduce at {nd.name}")
            ax = axes[0]
        else:
            ax = int(a.get(axis_attr, default)) % r
        pre, post = int(np.prod(s[:ax])), int(np.prod(s[ax + 1:]))

        def v3(t):
            st = self.sh[t]
            return [pre, st[ax], int(np.prod(st[ax + 1:]))] if nd.op_type != "Gather" or t == x else None

        attrs = dict(a)
        if nd.op_type == "Gather":
            ind = nd.input[1]
            xi = self.to_view(x, [pre, s[ax], post])
            ishape = self.sh[ind]
            o = self.name("g")
            attrs["axis"] = 1
            self.out.append(helper.make_node("Gather", [xi, ind], [o], name=nd.name, **attrs))
            vo = [pre] + list(ishape) + [post]
            if len(vo) > 5:
                raise Bail(f"gather view rank at {nd.name}")
            self.from_view(o, vo, nd.output[0])
            return
        ins = []
        for t in nd.input:
            if not t:
                ins.append(t)
                continue
            if nd.op_type in ("Concat",) or t == x:
                ins.append(self.to_view(t, v3(t)))
            else:
                ins.append(t)  # split sizes / reduce axes
        if nd.op_type in ("Concat", "Split", "Softmax", "LogSoftmax"):
            attrs["axis"] = 1
        if nd.op_type.startswith("Reduce"):
            ins[1] = self.const(np.array([1], np.int64), "ax")
            attrs.pop("axes", None)
        outs = []
        for y in nd.output:
            outs.append(self.name("a"))
        self.out.append(helper.make_node(nd.op_type, ins, outs, name=nd.name, **attrs))
        for o, y in zip(outs, nd.output):
            sy = self.sh[y]
            vy = [pre, sy[ax] if len(sy) == r else 1, post] if len(sy) == r else None
            if vy is None:  # keepdims=0 reduce
                vy = [pre, post]
                o2 = self.reshape(o, [pre, 1, post], vy)
                o = o2
            self.sh[o] = vy
            self.from_view(o, vy, y)

    def do_slice_pad(self, nd):
        x, y = nd.input[0], nd.output[0]
        s, so = self.sh[x], self.sh[y]
        r = len(s)
        if nd.op_type == "Slice":
            st, en = self.cval(nd.input[1]), self.cval(nd.input[2])
            axes = self.cval(nd.input[3]) if len(nd.input) > 3 and nd.input[3] else np.arange(len(st))
            steps = self.cval(nd.input[4]) if len(nd.input) > 4 and nd.input[4] else np.ones(len(st), np.int64)
            if st is None or en is None or axes is None or steps is None:
                raise Bail(f"non-constant slice at {nd.name}")
            axes = [int(a) % r for a in axes]
            cut = set(a for a, b, e, p in zip(axes, st, en, steps) if not (b == 0 and e >= s[a] and p == 1))
        else:
            pads = self.cval(nd.input[1])
            if pads is None or (len(nd.input) > 3 and nd.input[3]):
                raise Bail(f"pad form at {nd.name}")
            cut = set(a for a in range(r) if pads[a] != 0 or pads[a + r] != 0)
        if not cut:  # no-op slice / pad: same elements, a view change only
            self.out.append(helper.make_node("Reshape", [x, self.const(np.array(self.phys(y), np.int64), "s")], [y],
                                             name=nd.name))
            return
        sig = [("cut", a) if a in cut else ("keep",) for a in range(r)]
        groups = merge_runs(sig)
        if len(groups) > 5:
            raise Bail(f"slice groups > 5 at {nd.name}")
        v = [int(np.prod([s[a] for a in g])) for g in groups]
        vo = [int(np.prod([so[a] for a in g])) for g in groups]
        xi = self.to_view(x, v)
        o = self.name("sl")
        gidx = {g[0]: n for n, g in enumerate(groups) if len(g) == 1}
        if nd.op_type == "Slice":
            ns, ne, na, npp = [], [], [], []
            for a, b, e, p in zip(axes, st, en, steps):
                if a in cut:
                    ns.append(int(b)); ne.append(int(e)); na.append(gidx[a]); npp.append(int(p))
            ins = [xi, self.const(np.array(ns, np.int64)), self.const(np.array(ne, np.int64)),
                   self.const(np.array(na, np.int64)), self.const(np.array(npp, np.int64))]
            self.out.append(helper.make_node("Slice", ins, [o], name=nd.name))
        else:
            k = len(groups)
            npads = [0] * (2 * k)
            for a in cut:
                npads[gidx[a]] = int(pads[a]); npads[gidx[a] + k] = int(pads[a + r])
            ins = [xi, self.const(np.array(npads, np.int64))] + list(nd.input[2:3])
            self.out.append(helper.make_node("Pad", ins, [o], name=nd.name,
                                             **{at.name: helper.get_attribute_value(at) for at in nd.attribute}))
        self.sh[o] = vo
        self.from_view(o, vo, y)

    def do_gather_scalar(self, nd):
        (x, ind), y = nd.input, nd.output[0]
        s = self.sh[x]
        ax = int(next((helper.get_attribute_value(a) for a in nd.attribute if a.name == "axis"), 0)) % len(s)
        i = int(self.cval(ind))
        i = i % s[ax]
        o = self.name("gs")
        self.out.append(helper.make_node("Slice", [x, self.const(np.array([i], np.int64)), self.const(np.array([i + 1], np.int64)),
                                                    self.const(np.array([ax], np.int64))], [o], name=nd.name))
        self.out.append(helper.make_node("Reshape", [o, self.const(np.array(self.sh[y], np.int64), "s")], [y], name=self.name("r")))

    def wrap(self, nd):
        """keep a node as is: its high-rank inputs/outputs go back to their real shapes around it."""
        ins = []
        for t in nd.input:
            if t and t in self.sh and len(self.sh[t]) > 5:
                ins.append(self.reshape(t, self.phys(t), self.sh[t]))
            else:
                ins.append(t)
        outs, fix = [], []
        for y in nd.output:
            if y and y in self.sh and len(self.sh[y]) > 5:
                o = self.name("w"); outs.append(o); fix.append((o, y))
            else:
                outs.append(y)
        nd2 = onnx.NodeProto(); nd2.CopyFrom(nd)
        del nd2.input[:]; nd2.input.extend(ins); del nd2.output[:]; nd2.output.extend(outs)
        self.out.append(nd2)
        for o, y in fix:
            self.from_view(o, self.sh[y], y)

    # ---------------------------------------------------------------- driver
    def empty_pass(self):
        g = self.g
        empty = {t for t, s in self.sh.items() if 0 in s}
        if not empty:
            return 0
        new, k = [], 0
        for nd in g.node:
            outs = [o for o in nd.output if o]
            if outs and all(o in empty for o in outs):
                k += 1
                continue  # produces nothing
            if nd.op_type == "Concat" and any(i in empty for i in nd.input):
                ins = [i for i in nd.input if i not in empty]
                k += 1
                if len(ins) == 1:
                    new.append(helper.make_node("Identity", ins, list(nd.output), name=nd.name))
                else:
                    nd2 = helper.make_node("Concat", ins, list(nd.output), name=nd.name,
                                           **{a.name: helper.get_attribute_value(a) for a in nd.attribute})
                    new.append(nd2)
                continue
            if any(i in empty for i in nd.input):
                raise Bail(f"empty tensor feeds {nd.op_type} {nd.name} with a non-empty output")
            new.append(nd)
        del g.node[:]
        g.node.extend(new)
        return k

    def run(self):
        import os
        only = set(filter(None, os.environ.get("RL_OPS", "").split(",")))
        k_empty = 0 if os.environ.get("RL_NOEMPTY") else self.empty_pass()
        self.out = []
        for nd in self.g.node:
            op = nd.op_type
            try:
                if only and op not in only and self.high(nd):
                    raise Bail(f"RL_OPS excludes {op}")
                if not os.environ.get("RL_NOGATHER") and op == "Gather" and nd.input[1] in self.inits and self.cval(nd.input[1]).ndim == 0 \
                        and nd.input[0] in self.sh and len(self.sh[nd.input[0]]) == 5:
                    self.do_gather_scalar(nd); self.changed += 1; continue
                if not self.high(nd):
                    self.out.append(nd); continue
                if op in ELEMENTWISE_UNARY:
                    self.do_unary(nd)
                elif op in BROADCAST:
                    self.do_broadcast(nd)
                elif op in RESHAPES:
                    self.do_reshape(nd)
                elif op == "Transpose":
                    self.do_transpose(nd)
                elif op in ("Slice", "Pad"):
                    self.do_slice_pad(nd)
                elif op in ("Concat", "Split", "Softmax", "LogSoftmax", "Gather") or op.startswith("Reduce"):
                    self.do_axis_op(nd)
                else:
                    raise Bail(f"no rule for {op} {nd.name} {[self.sh.get(t) for t in nd.input]}")
                self.changed += 1
            except Bail as e:
                print("RANK_LOWER skip:", e)
                self.wrap(nd)
        del self.g.node[:]
        self.g.node.extend(self.out)
        del self.g.value_info[:]
        return k_empty, self.changed


def lower(m):
    rw = Rewriter(m)
    k_empty, k = rw.run()
    print(f"RANK_LOWER empty-tensor nodes {k_empty}, rewritten nodes {k}")
    return k + k_empty
