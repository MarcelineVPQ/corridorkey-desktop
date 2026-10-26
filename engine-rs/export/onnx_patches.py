"""Export-friendly replacements for the shape-dependent Swin code paths.

Why: upstream shifted-window attention builds its region groups in Python
(`lru_cache` keyed on H, W + `tolist()` / `nonzero()`), and SwinAttention3D
picks a window batch size from Python arithmetic on the shape. torch.export
cannot trace either with symbolic H/W (error: "unhashable type: non-nested
SymInt").

v2 (production): mask-free region decomposition.
Every Swin block in CorridorKey v2 uses window w=16 and shift 0 or w/2=8 per
axis, and the token grid is a multiple of 8 (frames padded to a multiple of
128 px, /16 grid). Then every upstream region boundary (shift seams, the
Swin label seams at Hp-w and Hp-sh, and the padding edge) falls on an 8-token
cell edge, and along each axis a shifted window is either
  * joined: both 8-token halves are one region (and real), or
  * split:  the two halves are different regions (or one half is padding).
Joined windows are a prefix of the window rows/cols:
  shifted axis:   n_joined = max(n_win - 2, 0)
  unshifted axis: n_joined = H_real // w   (the padded last window is split)
So each block is four rectangular groups (joined/split rows x joined/split
cols); regions are full windows (16x16xT tokens), halves (16x8xT or 8x16xT)
or quarters (8x8xT). Each group runs plain SDPA with NO mask, which lets
ONNX Runtime use its fused/flash MultiHeadAttention (see to_mha.py) instead
of materializing (windows, heads, N, N) score and mask tensors.

Semantics vs upstream (checked in parity_patch.py): identical attention sets
for every real query (same region, real keys only). Queries in padding attend
to their padding half only; they are cropped right after, so outputs at real
pixels are unchanged.

Zero-size batches: CUDA MultiHeadAttention has no empty-batch guard, so each
of the four SDPA batches (JJ / JS / SJ / SS) gets one dummy all-zero
region appended and dropped again (cost: one region per batch).
"""
import torch
import torch.nn.functional as F

from corridorkey import blocks as B
from corridorkey.rope import RoPE3D  # noqa: F401  (kept for clarity)


def _ceil_to(n, w):
    return ((n + w - 1) // w) * w


def _n_joined(n_win, n_real, w, shift):
    if shift:
        assert shift * 2 == w, f"region decomposition needs shift == w/2, got {shift} for w={w}"
        return torch.sym_max(n_win - 2, 0)
    return n_real // w


def _regions(x, Bn, r, c, heads, T, w, d, sh, sw):
    """(Bn, r, c, heads, T, w, w, d) block -> (Bn*r*c*a*b, heads, T*(w/a)*(w/b), d)."""
    a, b = (2 if sh else 1), (2 if sw else 1)
    hh, ww = w // a, w // b
    # (Bn, r, c) and (heads, T) move together, so they are merged: 7 dims instead of 10 (TensorRT allows 8);
    # the same element order as reshape(Bn, r, c, heads, T, a, hh, b, ww, d).permute(0,1,2,5,7,3,4,6,8,9)
    x = x.reshape(Bn * r * c, heads * T, a, hh, b, ww, d)
    x = x.permute(0, 2, 4, 1, 3, 5, 6)
    return x.reshape(Bn * r * c * a * b, heads, T * hh * ww, d)


def _unregions(y, Bn, r, c, heads, T, w, d, sh, sw):
    a, b = (2 if sh else 1), (2 if sw else 1)
    hh, ww = w // a, w // b
    # merged as in _regions (7 dims): same order as reshape(Bn, r, c, a, b, heads, T, hh, ww, d)
    # .permute(0,1,2,5,6,3,7,4,8,9)
    y = y.reshape(Bn * r * c, a, b, heads * T, hh, ww, d)
    y = y.permute(0, 3, 1, 4, 2, 5, 6)
    return y.reshape(Bn, r, c, heads, T, w, w, d)


def _sdpa_padded(q, k, v):
    """SDPA over a batch that may be empty: append one zero region, drop it."""
    # Dummy goes first and is dropped with [1:]: the symbolic shape solver
    # proves that size exactly (o[:n] after a cat fails on Max() sizes).
    z = q.new_zeros((1,) + tuple(q.shape[1:]))
    o = F.scaled_dot_product_attention(torch.cat([z, q]), torch.cat([z, k]), torch.cat([z, v]),
                                       dropout_p=0.0)
    return o[1:]


def region_sdpa(q, k, v, Bn, nH, nW, T, w, H, W, sh, sw):
    """Mask-free shifted-window attention.

    q, k, v: (Bn*nH*nW, heads, T*w*w, d) in window_partition order (RoPE applied).
    H, W: real (unpadded) token extent; sh, sw: block shift (0 or w/2).
    """
    heads, d = q.shape[1], q.shape[3]
    jh = _n_joined(nH, H, w, sh)
    jw = _n_joined(nW, W, w, sw)
    sh_n, sw_n = nH - jh, nW - jw
    # loop: NOT-WORTH — q, k, v: three reshapes, unrolled into the graph at export
    grids = [t.reshape(Bn, nH, nW, heads, T, w, w, d) for t in (q, k, v)]
    # (rows, cols, split_h, split_w, slice) for the four groups
    groups = [
        ("JJ", jh, jw, False, False, (slice(None, jh), slice(None, jw))),
        ("JS", jh, sw_n, False, True, (slice(None, jh), slice(jw, None))),
        ("SJ", sh_n, jw, True, False, (slice(jh, None), slice(None, jw))),
        ("SS", sh_n, sw_n, True, True, (slice(jh, None), slice(jw, None))),
    ]
    regs = {}
    # loop: NOT-WORTH — four region groups, unrolled into the graph at export
    for name, r, c, a, b, (rs, cs) in groups:
        # loop: NOT-WORTH — q, k, v per group, unrolled into the graph at export
        regs[name] = [_regions(g[:, rs, cs], Bn, r, c, heads, T, w, d, a, b) for g in grids]
    # loop: NOT-WORTH — four groups' attention, unrolled into the graph at export
    out = {name: _sdpa_padded(*regs[name]) for name in ("JJ", "JS", "SJ", "SS")}
    blk = {name: _unregions(out[name], Bn, r, c, heads, T, w, d, a, b)
           for name, r, c, a, b, _ in groups}
    top = torch.cat([blk["JJ"], blk["JS"]], dim=2)
    bot = torch.cat([blk["SJ"], blk["SS"]], dim=2)
    o = torch.cat([top, bot], dim=1)                     # (Bn, nH, nW, heads, T, w, w, d)
    return o.reshape(Bn * nH * nW, heads, T * w * w, d)


# ---------------------------------------------------------------------------
# 2D (stage 2)
# ---------------------------------------------------------------------------

def swin_block2d_forward(self, x):
    sh, sw = self.shift_h, self.shift_w
    shortcut = x
    x = self.norm1(x)
    if sh or sw:
        H, W = x.shape[1], x.shape[2]
        w = self.window_size
        Hp, Wp = _ceil_to(H, w), _ceil_to(W, w)
        x = F.pad(x, (0, 0, 0, Wp - W, 0, Hp - H))
        x = B._cyclic_shift_2d(x, (-sh, -sw))
        x = swin_attn2d_forward(self.attn, x, real_hw=(H, W), shift=(sh, sw))
        x = B._cyclic_shift_2d(x, (sh, sw))
        x = x[:, :H, :W, :]
    else:
        x = swin_attn2d_forward(self.attn, x)
    x = shortcut + x
    if self.local_mix is not None:
        x = x + self.local_mix(x)
    shortcut = x
    x = self.norm2(x)
    x = self.mlp(x)
    return shortcut + x


def swin_attn2d_forward(self, x, real_hw=None, shift=(0, 0)):
    """Mask-free SwinAttention2D. x is already padded+shifted when shift != 0."""
    Bn, H, W, C = x.shape
    w = self.window_size
    Hp, Wp = _ceil_to(H, w), _ceil_to(W, w)
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
    attn = region_sdpa(q, k, v, Bn, Hp // w, Wp // w, 1, w, Hr, Wr, shift[0], shift[1])
    attn = self.attn_gate(gate_tokens, attn)
    attn = self.proj(attn.transpose(1, 2).reshape(nW_total, N, C))
    out = B.window_unpartition_2d(attn.reshape(nW_total, w, w, C), w, (Hp, Wp), Bn)
    return out[:, :H, :W, :]


# ---------------------------------------------------------------------------
# 3D (stage 1)
# ---------------------------------------------------------------------------

def swin_block3d_forward(self, x, t_stride=1.0, adaln_cond=None):
    if self.adaln is not None and adaln_cond is None:
        adaln_cond = x.new_zeros(x.shape[0], x.shape[1])
    if self.adaln is not None:
        shift1, scale1, gate1, shift2, scale2, gate2 = self.adaln(adaln_cond, x)
    else:
        shift1 = scale1 = gate1 = shift2 = scale2 = gate2 = None
    sh, sw = self.shift_h, self.shift_w
    shortcut = x
    x = self.norm1(x)
    if shift1 is not None:
        x = x * (1.0 + scale1) + shift1
    if sh or sw:
        H, W = x.shape[2], x.shape[3]
        w = self.window_H
        Hp, Wp = _ceil_to(H, w), _ceil_to(W, w)
        x = F.pad(x, (0, 0, 0, Wp - W, 0, Hp - H))
        x = B._cyclic_shift_3d(x, (0, -sh, -sw))
        x = swin_attn3d_forward(self.attn, x, t_stride=t_stride, real_hw=(H, W), shift=(sh, sw))
        x = B._cyclic_shift_3d(x, (0, sh, sw))
        x = x[:, :, :H, :W, :]
    else:
        x = swin_attn3d_forward(self.attn, x, t_stride=t_stride)
    x = shortcut + (x * gate1 if gate1 is not None else x)
    x = self._local_mix_frames(x)
    shortcut = x
    x = self.norm2(x)
    if shift2 is not None:
        x = x * (1.0 + scale2) + shift2
    x = self.mlp(x)
    return shortcut + (x * gate2 if gate2 is not None else x)


def swin_attn3d_forward(self, x, t_stride=1.0, real_hw=None, shift=(0, 0)):
    """Single-shot, mask-free SwinAttention3D (full-T windows)."""
    Bn, T, H, W, C = x.shape
    Hw, Ww = self.window_H, self.window_W
    assert Hw == Ww
    Hp, Wp = _ceil_to(H, Hw), _ceil_to(W, Ww)
    x_orig = x
    pad = (0, 0, 0, Wp - W, 0, Hp - H)
    S = Hw * Ww
    N = T * S
    if self.qkv_dw is not None:
        y = self.qkv_dw(self.qkv.qkv(x_orig))
        y = F.pad(y, pad)
        windows, _ = B.window_partition_3d(y, T, Hw, Ww)
        nW_total = windows.shape[0]
        qkv = windows.reshape(nW_total, N, 3, self.num_heads, self.head_dim)
        q, k, v = qkv.permute(2, 0, 3, 1, 4).unbind(0)
        gw, _ = B.window_partition_3d(F.pad(x_orig, pad), T, Hw, Ww)
        gate_tokens = gw.reshape(nW_total, N, C)
    else:
        windows, _ = B.window_partition_3d(F.pad(x, pad), T, Hw, Ww)
        nW_total = windows.shape[0]
        gate_tokens = windows.reshape(nW_total, N, C)
        q, k, v = self.qkv(gate_tokens)
    if self.qk_norm:
        q = self.q_norm(q)
        k = self.k_norm(k)
    cos, sin = self.rope.get_cos_sin(T, Hw, Ww, device=x.device, t_stride=t_stride)
    q = B.apply_rotary(q, cos, sin)
    k = B.apply_rotary(k, cos, sin)
    Hr, Wr = real_hw if real_hw is not None else (H, W)
    attn = region_sdpa(q, k, v, Bn, Hp // Hw, Wp // Ww, T, Hw, Hr, Wr, shift[0], shift[1])
    attn = self.attn_gate(gate_tokens, attn)
    attn = attn.transpose(1, 2).reshape(nW_total, N, C)
    attn = self.proj(attn)
    out = B.window_unpartition_3d(attn.reshape(nW_total, T, Hw, Ww, C), T, Hw, Ww, (T, Hp, Wp), Bn)
    return out[:, :, :H, :W, :]


# ---------------------------------------------------------------------------
# MoGe (DINOv2) positional-embedding interpolation
# ---------------------------------------------------------------------------
# Upstream calls F.interpolate(bicubic, scale_factor=((h0+0.1)/M, (w0+0.1)/M)).
# The scale factor is a Python float computed from the input size, so
# torch.export bakes it in as a constant: the exported graph only works for
# the trace resolution (ORT error "Attempting to broadcast an axis by a
# dimension other than 1. 25 by 241" at another size). Below is the same
# PyTorch bicubic (A=-0.75, align_corners=False, source index computed from
# the given scale, border-clamped taps) expressed as two in-graph weight
# matrices, so it stays exact and dynamic.

def _bicubic_matrix(n_out, n_in, scale, device):
    dst = torch.arange(n_out, device=device, dtype=torch.float32)
    src = (dst + 0.5) / scale - 0.5
    i0 = torch.floor(src)
    t = (src - i0)[:, None]
    A = -0.75
    tt = torch.cat([t + 1, t, 1 - t, 2 - t], dim=1)  # distances to taps -1..2
    near = ((A + 2) * tt - (A + 3)) * tt * tt + 1
    far = ((A * tt - 5 * A) * tt + 8 * A) * tt - 4 * A
    coef = torch.where(tt <= 1, near, far)              # (n_out, 4)
    taps = (i0[:, None] + torch.arange(-1, 3, device=device, dtype=torch.float32)[None, :])
    taps = taps.clamp(0, n_in - 1).to(torch.int64)      # (n_out, 4)
    onehot = (taps[..., None] == torch.arange(n_in, device=device)[None, None, :]).to(torch.float32)
    return (coef[..., None] * onehot).sum(1)            # (n_out, n_in)


def dinov2_interpolate_pos_encoding(self, x, h, w):
    previous_dtype = x.dtype
    N = self.pos_embed.shape[1] - 1
    pos_embed = self.pos_embed.float()
    class_pos_embed = pos_embed[:, 0, :]
    patch_pos_embed = pos_embed[:, 1:, :]
    dim = x.shape[-1]
    h0, w0 = h // self.patch_size, w // self.patch_size
    M = int(round(N ** 0.5))
    grid = patch_pos_embed.reshape(M, M, dim)
    off = float(self.interpolate_offset)
    Wh = _bicubic_matrix(h0, M, (h0 + off) / M, x.device)
    Ww = _bicubic_matrix(w0, M, (w0 + off) / M, x.device)
    out = torch.einsum("ym,mnd,xn->yxd", Wh, grid, Ww).reshape(1, -1, dim)
    return torch.cat((class_pos_embed[:, None, :], out), dim=1).to(previous_dtype)


_APPLIED = False


def cradio_pos_embeddings(self, batch_size, input_dims):
    """C-RADIO's eval-mode CPE position grid with both crops in the graph.

    Upstream (vit_patch_generator.py, eval + cpe_mode) resizes the stored
    128x128 grid bilinearly to (M, M) with M = max(rows, cols) and then
    window_select crops rows if rows < M and cols if cols < M. Those two
    Python ifs are guards: the export (traced at 768x1280, 12x20 patches)
    kept only the row crop. M itself stayed symbolic (a Max node), so a
    portrait input got an M x M = rows x rows grid: 400 position tokens
    against 240 patches at 1280x768 padded (ORT: "240 by 400" in add_52).
    Here both crops are unconditional slices ([:rows, :cols] is a no-op on
    the side that equals M), M is torch.sym_max, and upstream's last resize
    (only when the shape still differs, which it never does after the crops)
    is left out. Same ops, same order: bit-identical to upstream in PyTorch.
    """
    if self.training or not self.cpe_mode:
        return _ORIG_CRADIO_POS(self, batch_size, input_dims)
    rows, cols = input_dims
    pe = self.pos_embed.reshape(1, self.num_rows, self.num_cols, -1).permute(0, 3, 1, 2)
    m = torch.sym_max(rows, cols)
    pe = F.interpolate(pe.float(), size=(m, m), align_corners=False, mode="bilinear").to(pe.dtype)
    pe = pe[..., :rows, :cols]
    return pe.flatten(2).permute(0, 2, 1)


_ORIG_CRADIO_POS = None


def apply_cradio():
    """Patch C-RADIO's position grid (load the model first: the class lives in
    the snapshot module that corridorkey.foundations imports at load time)."""
    global _ORIG_CRADIO_POS
    import sys
    cls = sys.modules["_corridorkey_cradio_snapshot.vit_patch_generator"].ViTPatchGenerator
    if _ORIG_CRADIO_POS is None:
        _ORIG_CRADIO_POS = cls._get_pos_embeddings
        cls._get_pos_embeddings = cradio_pos_embeddings


def apply():
    global _APPLIED
    if _APPLIED:
        return
    B.SwinBlock2D.forward = swin_block2d_forward
    B.SwinBlock3D.forward = swin_block3d_forward
    from moge.model.dinov2.models.vision_transformer import DinoVisionTransformer
    assert not DinoVisionTransformer.interpolate_antialias if hasattr(
        DinoVisionTransformer, "interpolate_antialias") else True
    DinoVisionTransformer.interpolate_pos_encoding = dinov2_interpolate_pos_encoding
    apply_cradio()
    _APPLIED = True
