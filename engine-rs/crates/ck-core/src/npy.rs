//! A minimal .npy reader (float16/32/64, uint8/16, C order -> float32) for the parity fixtures and tools.

/// -> (shape, data as float32)
pub fn read(path: &std::path::Path) -> Result<(Vec<usize>, Vec<f32>), String> {
    let buf = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if buf.len() < 10 || &buf[..6] != b"\x93NUMPY" {
        return Err(format!("{}: not a .npy file", path.display()));
    }
    let (hlen, start) =
        if buf[6] == 1 { (u16::from_le_bytes([buf[8], buf[9]]) as usize, 10) } else { (u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]) as usize, 12) };
    let header = std::str::from_utf8(&buf[start..start + hlen]).map_err(|e| e.to_string())?;
    if header.contains("'fortran_order': True") {
        return Err("fortran order not supported".into());
    }
    let shape: Vec<usize> = header
        // loop: NOT-WORTH — a fixture header (tests only)
        .split("'shape':")
        .nth(1)
        .and_then(|r| r.split('(').nth(1))
        .and_then(|r| r.split(')').next())
        .map(|r| r.split(',').filter_map(|x| x.trim().parse().ok()).collect())
        .ok_or(format!("no shape in {header}"))?;
    let d = &buf[start + hlen..];
    let v: Vec<f32> = if header.contains("'<f4'") {
        // loop: NOT-WORTH — fixture data (tests only)
        d.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
    } else if header.contains("'<f2'") {
        // loop: NOT-WORTH — fixture data (tests only)
        d.chunks_exact(2).map(|c| half::f16::from_le_bytes([c[0], c[1]]).to_f32()).collect()
    } else if header.contains("'<f8'") {
        // loop: NOT-WORTH — fixture data (tests only)
        d.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap()) as f32).collect()
    } else if header.contains("'|u1'") {
        // loop: NOT-WORTH — fixture data (tests only)
        d.iter().map(|&b| b as f32).collect()
    } else if header.contains("'<u2'") {
        // loop: NOT-WORTH — fixture data (tests only)
        d.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]]) as f32).collect()
    } else {
        return Err(format!("dtype not supported: {header}"));
    };
    // loop: NOT-WORTH — a shape's few dimensions
    if v.len() != shape.iter().product::<usize>() {
        return Err(format!("{}: {} values for shape {shape:?}", path.display(), v.len()));
    }
    Ok((shape, v))
}
