"""Set 2.0.0-onnx.5: shifted-window attention without empty tensors, RMSNorm in plain ops.

Applied on top of onnx_patches (v2: MoGe / C-RADIO position grids, the Swin block wrappers). Corridor's code is
not changed: these replace methods at export time, as onnx_patches does.

Why (docs/AMD.md, docs/ONNX_EXPORT.md "onnx.5"): v2 splits each Swin block into four region groups whose sizes
follow the input size; at every size some group is empty, and MIGraphX can't take a zero-size tensor. ONNX
`RMSNormalization` (opset 23) is unknown to MIGraphX and to ORT's Core ML provider.

Stage 2 (2D, 256 tokens per window): ONE attention over all windows with the standard Swin additive mask
(0 where query and key share a region, -inf elsewhere), built from the same region labels as upstream
(`_shifted_region_ids_2d`: the slices (0, -w), (-w, -s), (-s, None) of the padded pre-shift grid, -1 = padding).
The mask is (B*windows, 1, 256, 256) and is built once per block shape.

Stage 1 (3D, 256*T tokens per window, T up to 80 in the engine): a mask would be (windows, N, N) with N = 256*T,
40 x 20480^2 values at 1920x1152 and T=80, so stage 1 stays mask-free. Its regions (full windows, halves,
quarters; onnx_patches v2's analysis) are taken straight from the token grid by ONE Gather per q / k / v, with one
zero region appended to every group (so no group is ever empty, at any size), run as four plain attentions, and
put back by ONE Gather. The gather indices depend only on the shape and the block's shift: the window
partition, the region split and the reverse are all in them (no per-group Slice / Reshape / Transpose chains).
Attention sets are upstream's for every real query; padding queries are cropped afterwards, as before.

RMSNorm (blocks.RMSNorm and LayerNorm2d): torch's own rms_norm composite (aten rms_norm: upcast to fp32,
x / sqrt(mean(x^2) + eps), back to the input type, times the weight) written out as Pow / ReduceMean / Add / Sqrt /
Div / Cast / Mul, the pattern ONNX Runtime fuses back into one SimplifiedLayerNormalization at load. LayerNorm2d
reduces over the channel axis in place instead of permuting to channels-last and back.
"""
import torch
import torch.nn.functional as F

from corridorkey import blocks as B

import onnx_patches as v2

_CACHE = {}


def _cached(key, make):
    """One index / mask tensor per block shape and shift: blocks with the same shift share it (fewer nodes)."""
    # loop: NOT-WORTH — the key's few shape values
    k = tuple(str(v) for v in key)
    if k not in _CACHE:
        _CACHE[k] = make()
    return _CACHE[k]


# ---------------------------------------------------------------------------
# RMSNorm
# ---------------------------------------------------------------------------

def _rms(x, dim, weight, eps):
    x32 = x.float()
    y = (x32 / (x32.pow(2).mean(dim, keepdim=True) + eps).sqrt()).to(x.dtype)
    return y if weight is None else y * weight.to(x.dtype)


def rmsnorm_forward(self, x):
    return _rms(x, -1, self.weight, self.eps)


def layernorm2d_forward(self, x):
    w = None if self.weight is None else self.weight.view(-1, 1, 1)
    return _rms(x, 1, w, self.eps)


# ---------------------------------------------------------------------------
# Stage 2: one masked attention
# ---------------------------------------------------------------------------

def _axis_labels(n_p, real, w, s):
    """Region label (0..2) and real flag per position of one axis, in the rolled (shifted) order."""
    p = torch.arange(n_p)
    o = p + s
    o = o - (o >= n_p).long() * n_p                    # rolled position -> pre-shift position ((p + s) mod n_p)
    lab = ((o >= n_p - w).long() + (o >= n_p - s).long()) if s else torch.zeros_like(p)
    return lab, o < real


def swin_bias_2d(Bn, Hp, Wp, H, W, w, sh, sw, dtype):
    """(Bn * windows, 1, w*w, w*w) additive mask: 0 inside a region, -inf across regions.
    Padding is its own region (-1): its queries see only padding and are cropped after."""
    lh, rh = _axis_labels(Hp, H, w, sh)
    lw, rw = _axis_labels(Wp, W, w, sw)
    lab = torch.where(rh[:, None] & rw[None, :], lh[:, None] * 3 + lw[None, :], -1)
    N = w * w
    lab = lab.reshape(Hp // w, w, Wp // w, w).permute(0, 2, 1, 3).reshape(-1, N)
    same = lab[:, :, None] == lab[:, None, :]
    bias = torch.zeros(same.shape, dtype=dtype).masked_fill(~same, float("-inf"))
    return bias.unsqueeze(0).expand(Bn, -1, -1, -1).reshape(-1, 1, N, N)


def swin_attn2d_forward(self, x, real_hw=None, shift=(0, 0)):
    """SwinAttention2D, one SDPA over all windows with the Swin mask. x is already padded+shifted when shifted."""
    Bn, H, W, C = x.shape
    w = self.window_size
    Hp, Wp = v2._ceil_to(H, w), v2._ceil_to(W, w)
    pad = (0, 0, 0, Wp - W, 0, Hp - H)
    N = w * w
    if self.qkv_dw is not None:
        y = F.pad(self.qkv_dw(self.qkv.qkv(x)), pad)
        windows, _ = B.window_partition_2d(y, w)
        nW_total = windows.shape[0]
        qkv = windows.reshape(nW_total, N, 3, self.num_heads, self.head_dim)
        q, k, v = qkv.permute(2, 0, 3, 1, 4).unbind(0)
        gw, _ = B.window_partition_2d(F.pad(x, pad), w)
        gate_tokens = gw.reshape(nW_total, N, C)
    else:
        windows, _ = B.window_partition_2d(F.pad(x, pad), w)
        nW_total = windows.shape[0]
        gate_tokens = windows.reshape(nW_total, N, C)
        q, k, v = self.qkv(gate_tokens)
    if self.qk_norm:
        q = self.q_norm(q)
        k = self.k_norm(k)
    cos, sin = self.rope.get_cos_sin(w, w, device=x.device)
    q = B.apply_rotary(q, cos, sin)
    k = B.apply_rotary(k, cos, sin)
    Hr, Wr = real_hw if real_hw is not None else (H, W)
    bias = _cached(("bias2d", Bn, Hp, Wp, Hr, Wr, w, shift, q.dtype),
                   lambda: swin_bias_2d(Bn, Hp, Wp, Hr, Wr, w, shift[0], shift[1], q.dtype))
    attn = F.scaled_dot_product_attention(q, k, v, attn_mask=bias.to(q.dtype), dropout_p=0.0)
    attn = self.attn_gate(gate_tokens, attn)
    attn = self.proj(attn.transpose(1, 2).reshape(nW_total, N, C))
    out = B.window_unpartition_2d(attn.reshape(nW_total, w, w, C), w, (Hp, Wp), Bn)
    return out[:, :H, :W, :]


# ---------------------------------------------------------------------------
# Stage 1: mask-free regions by one gather
# ---------------------------------------------------------------------------

def _axis(n, j, w):
    """One axis of the window grid, as (windows, place in window) tables: the first j windows are joined, the rest
    split into halves. Returns split flag, half, place in the region, region extent, windows of this kind, window
    index among them."""
    r = torch.arange(n)[:, None]
    i = torch.arange(w)[None, :]
    s = (r >= j).long()
    q = s * (i >= w // 2).long()
    return s, q, i - q * (w // 2), w - s * (w // 2), j + s * (n - 2 * j), r - s * j


def region_maps(Bn, Hp, Wp, H, W, w, sh, sw):
    """Gather indices for the region decomposition of a padded, rolled (Bn, Hp, Wp) token grid.

    Four groups (joined / split rows x joined / split columns); group g holds R_g regions of region_tokens[g]
    spatial tokens plus one zero region, so none is ever empty. Returns (fwd, back, sizes, region_tokens):
      back  (Bn*Hp*Wp,) the slot of each grid row in the concatenated groups
      fwd   (sum(sizes),) the grid row of each slot (its inverse); the zero regions' slots point at row
            Bn*Hp*Wp, the zero row the caller appends
    Built from broadcast ranges and compares only (no division), so every block shape exports as a few nodes.
    """
    nH, nW = Hp // w, Wp // w
    jh = v2._n_joined(nH, H, w, sh)
    jw = v2._n_joined(nW, W, w, sw)
    sizes, toks = [], []
    # loop: NOT-WORTH — four groups (joined/split rows x joined/split cols), unrolled at export
    for rs in (0, 1):
        # loop: NOT-WORTH — joined / split columns
        for cs in (0, 1):
            rows, cols = (nH - jh) if rs else jh, (nW - jw) if cs else jw
            tok = (w // (1 + rs)) * (w // (1 + cs))
            sizes.append((Bn * rows * cols * (1 + rs) * (1 + cs) + 1) * tok)
            toks.append(tok)
    # loop: NOT-WORTH — six small index tables, once per block shape
    sH, qa, y, hh, rows, r = (t[None, :, :, None, None] for t in _axis(nH, jh, w))   # (1, nH, w, 1, 1)
    # loop: NOT-WORTH — six small index tables, once per block shape
    sW, qb, x, ww, cols, c = (t[None, None, None, :, :] for t in _axis(nW, jw, w))   # (1, 1, 1, nW, w)
    bb = torch.arange(Bn)[:, None, None, None, None]
    rho = (((bb * rows + r) * cols + c) * (1 + sH) + qa) * (1 + sW) + qb
    off = sH * (sizes[0] + sizes[1]) + sW * sizes[0] + sH * sW * (sizes[2] - sizes[0])
    back = (off + rho * (hh * ww) + y * ww + x).reshape(-1)          # (Bn, nH, w, nW, w) = grid row order
    n = Bn * Hp * Wp
    fwd = torch.full((sizes[0] + sizes[1] + sizes[2] + sizes[3],), n, dtype=torch.long).scatter(
        0, back, torch.arange(n))
    return fwd, back, sizes, toks


def _grid_rope(rope, T, w, Hp, Wp, t_stride, device):
    """RoPE tables per grid position (rolled order): (Hp*Wp, T, 1, d/2); position = place inside its window."""
    cos, sin = rope.get_cos_sin(T, w, w, device=device, t_stride=t_stride)
    place = torch.arange(w * w).reshape(1, w, 1, w).expand(Hp // w, w, Wp // w, w).reshape(-1)

    def grid(t):
        return t.reshape(T, w * w, -1).index_select(1, place).transpose(0, 1).unsqueeze(2)
    return grid(cos), grid(sin)


def swin_attn3d_forward(self, x, t_stride=1.0, real_hw=None, shift=(0, 0)):
    """SwinAttention3D (full-T windows): regions gathered from the token grid, one gather back."""
    Bn, T, H, W, C = x.shape
    w = self.window_H
    assert w == self.window_W
    Hp, Wp = v2._ceil_to(H, w), v2._ceil_to(W, w)
    pad = (0, 0, 0, Wp - W, 0, Hp - H)
    heads, d = self.num_heads, self.head_dim
    xp = F.pad(x, pad)
    qkv = F.pad(self.qkv_dw(self.qkv.qkv(x)), pad) if self.qkv_dw is not None else self.qkv.qkv(xp)
    # token rows: one per grid position, T frames each
    qkv = qkv.permute(0, 2, 3, 1, 4).reshape(Bn, Hp * Wp, T, 3, heads, d)
    q, k, v = qkv.unbind(3)
    if self.qk_norm:
        q = self.q_norm(q)
        k = self.k_norm(k)
    cos, sin = _cached(("rope3d", id(self.rope), T, w, Hp, Wp, t_stride),
                       lambda: _grid_rope(self.rope, T, w, Hp, Wp, t_stride, x.device))
    q = B.apply_rotary(q, cos, sin)
    k = B.apply_rotary(k, cos, sin)
    Hr, Wr = real_hw if real_hw is not None else (H, W)
    fwd, back, sizes, toks = _cached(("regions3d", Bn, Hp, Wp, Hr, Wr, w, shift),
                                     lambda: region_maps(Bn, Hp, Wp, Hr, Wr, w, shift[0], shift[1]))
    # loop: NOT-WORTH — q, k, v: three gathers, unrolled at export
    parts = [torch.cat([t.reshape(Bn * Hp * Wp, T * C), t.new_zeros(1, T * C)]).index_select(0, fwd).split(sizes)
             for t in (q, k, v)]
    outs = []
    # loop: NOT-WORTH — four region groups, unrolled at export
    for g, s in enumerate(toks):
        # loop: NOT-WORTH — q, k, v of one group
        qg, kg, vg = (p[g].reshape(-1, s * T, heads, d).transpose(1, 2) for p in parts)
        o = F.scaled_dot_product_attention(qg, kg, vg, dropout_p=0.0)
        outs.append(o.transpose(1, 2).reshape(-1, T * C))
    attn = torch.cat(outs).index_select(0, back)                     # (Bn*Hp*Wp, T*C), grid order
    attn = attn.reshape(Bn, Hp, Wp, T, C).permute(0, 3, 1, 2, 4)      # (Bn, T, Hp, Wp, C)
    attn = (attn.reshape(Bn, T, Hp, Wp, heads, d) * self.attn_gate.grid(xp, attn.dtype)).reshape(Bn, T, Hp, Wp, C)
    return self.proj(attn)[:, :, :H, :W, :]


def apply():
    """onnx_patches v2 first, then the onnx.5 Swin attention and RMSNorm."""
    v2.apply()
    B.RMSNorm.forward = rmsnorm_forward
    B.LayerNorm2d.forward = layernorm2d_forward
    # v2's block wrappers (pad, roll, crop) call these module-level attention functions
    v2.swin_attn2d_forward = swin_attn2d_forward
    v2.swin_attn3d_forward = swin_attn3d_forward
