//! NumPy's `np.random.default_rng(seed).integers(lo, hi + 1)` for one draw, bit for bit: the original's
//! `--start_mode random_middle` picks its start frame with it (video_io.probe_video_meta). SeedSequence (the
//! entropy pool and its hash), PCG64 (128-bit LCG, XSL-RR output, its 32-bit halves buffered) and the bounded
//! draw (Lemire's method on 32-bit draws for a range below 2^32, 64-bit draws above), as NumPy 1.26 / 2.x write
//! them (numpy/random/bit_generator.pyx, _pcg64, distributions.c). Checked against NumPy itself: tests/parity.rs
//! `numpy_integers`.

const INIT_A: u32 = 0x43b0_d7e5;
const MULT_A: u32 = 0x931e_8875;
const INIT_B: u32 = 0x8b51_f9dd;
const MULT_B: u32 = 0x58f3_8ded;
const MIX_MULT_L: u32 = 0xca01_f9dd;
const MIX_MULT_R: u32 = 0x4973_f715;
const XSHIFT: u32 = 16;
const POOL_SIZE: usize = 4;
const PCG_MULT: u128 = (0x2360_ed05_1fc6_5da4u128 << 64) | 0x4385_df64_9fcc_f645;

fn hashmix(value: u32, hash_const: &mut u32) -> u32 {
    let mut v = value ^ *hash_const;
    *hash_const = hash_const.wrapping_mul(MULT_A);
    v = v.wrapping_mul(*hash_const);
    v ^ (v >> XSHIFT)
}

fn mix(x: u32, y: u32) -> u32 {
    let r = MIX_MULT_L.wrapping_mul(x).wrapping_sub(MIX_MULT_R.wrapping_mul(y));
    r ^ (r >> XSHIFT)
}

/// SeedSequence(seed).generate_state(4, uint64).
fn seed_state(seed: u64) -> [u64; 2 * 2] {
    // _coerce_to_uint32_array: the integer as little-endian 32-bit words (0 -> [0])
    let entropy: Vec<u32> = if seed >> 32 == 0 { vec![seed as u32] } else { vec![seed as u32, (seed >> 32) as u32] };
    let mut pool = [0u32; POOL_SIZE];
    let mut hc = INIT_A;
    // loop: NOT-WORTH — the 4-word pool, once per draw
    for (i, p) in pool.iter_mut().enumerate() {
        *p = hashmix(entropy.get(i).copied().unwrap_or(0), &mut hc);
    }
    // loop: NOT-WORTH — 4 x 4 pool words, once per draw
    for src in 0..POOL_SIZE {
        // loop: NOT-WORTH — as above
        for dst in 0..POOL_SIZE {
            if src != dst {
                let h = hashmix(pool[src], &mut hc);
                pool[dst] = mix(pool[dst], h);
            }
        }
    }
    // (an entropy longer than the pool would be mixed in here: a u64 seed is at most two words)
    let mut hb = INIT_B;
    let mut words = [0u32; 8];
    // loop: NOT-WORTH — eight state words, once per draw
    for (i, w) in words.iter_mut().enumerate() {
        let mut v = pool[i % POOL_SIZE] ^ hb;
        hb = hb.wrapping_mul(MULT_B);
        v = v.wrapping_mul(hb);
        *w = v ^ (v >> XSHIFT);
    }
    std::array::from_fn(|i| words[2 * i] as u64 | ((words[2 * i + 1] as u64) << 32))
}

/// NumPy's PCG64 with its 32-bit buffer.
struct Pcg64 {
    state: u128,
    inc: u128,
    half: Option<u32>,
}

impl Pcg64 {
    fn new(seed: u64) -> Pcg64 {
        let s = seed_state(seed);
        let initstate = ((s[0] as u128) << 64) | s[1] as u128;
        let initseq = ((s[2] as u128) << 64) | s[3] as u128;
        let mut g = Pcg64 { state: 0, inc: (initseq << 1) | 1, half: None };
        g.step();
        g.state = g.state.wrapping_add(initstate);
        g.step();
        g
    }
    fn step(&mut self) {
        self.state = self.state.wrapping_mul(PCG_MULT).wrapping_add(self.inc);
    }
    fn next_u64(&mut self) -> u64 {
        self.step();
        let rot = (self.state >> 122) as u32;
        (((self.state >> 64) as u64) ^ (self.state as u64)).rotate_right(rot)
    }
    fn next_u32(&mut self) -> u32 {
        if let Some(h) = self.half.take() {
            return h;
        }
        let n = self.next_u64();
        self.half = Some((n >> 32) as u32);
        n as u32
    }
}

/// `np.random.default_rng(seed).integers(lo, hi + 1)`: a uniform integer in [lo, hi] (lo <= hi).
pub fn numpy_integers(seed: u64, lo: i64, hi: i64) -> i64 {
    assert!(lo <= hi, "numpy_integers: empty range");
    let rng = hi.wrapping_sub(lo) as u64;
    if rng == 0 {
        return lo;
    }
    let mut g = Pcg64::new(seed);
    let off = if rng < u32::MAX as u64 {
        // buffered_bounded_lemire_uint32
        let excl = rng as u32 + 1;
        let mut m = g.next_u32() as u64 * excl as u64;
        let mut left = m as u32;
        if left < excl {
            let threshold = (u32::MAX - rng as u32) % excl;
            // loop: NOT-WORTH — Lemire's rejection: expected under one extra draw [bounded: each retry is accepted with probability > 1/2]
            while left < threshold {
                m = g.next_u32() as u64 * excl as u64;
                left = m as u32;
            }
        }
        m >> 32
    } else if rng == u32::MAX as u64 {
        g.next_u32() as u64
    } else if rng == u64::MAX {
        g.next_u64()
    } else {
        // bounded_lemire_uint64
        let excl = rng + 1;
        let mut m = g.next_u64() as u128 * excl as u128;
        let mut left = m as u64;
        if left < excl {
            let threshold = (u64::MAX - rng) % excl;
            // loop: NOT-WORTH — as above [bounded: each retry is accepted with probability > 1/2]
            while left < threshold {
                m = g.next_u64() as u128 * excl as u128;
                left = m as u64;
            }
        }
        (m >> 64) as u64
    };
    lo.wrapping_add(off as i64)
}
