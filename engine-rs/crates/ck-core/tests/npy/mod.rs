//! A minimal .npy reader (float16/32/64, uint8/16, C order -> float32) for the parity fixtures. Test-only (the
//! engine never reads .npy); a malformed file is an Err, never a panic.

/// -> (shape, data as float32)
pub fn read(path: &std::path::Path) -> Result<(Vec<usize>, Vec<f32>), String> {
    let buf = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    parse(&buf).map_err(|e| format!("{}: {e}", path.display()))
}

/// The bytes of a .npy file -> (shape, data as float32).
pub fn parse(buf: &[u8]) -> Result<(Vec<usize>, Vec<f32>), String> {
    if buf.len() < 10 || &buf[..6] != b"\x93NUMPY" {
        return Err("not a .npy file".into());
    }
    let (hlen, start): (usize, usize) = match buf[6] {
        1 => (u16::from_le_bytes([buf[8], buf[9]]) as usize, 10),
        2 | 3 if buf.len() >= 12 => (u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]) as usize, 12),
        v => return Err(format!("unsupported .npy version {v} (or a short header)")),
    };
    let end = start.checked_add(hlen).filter(|e| *e <= buf.len()).ok_or("the header is longer than the file")?;
    let header = std::str::from_utf8(&buf[start..end]).map_err(|e| e.to_string())?;
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
    let d = &buf[end..];
    let v: Vec<f32> = if header.contains("'<f4'") {
        // loop: NOT-WORTH — fixture data (tests only)
        d.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
    } else if header.contains("'<f2'") {
        // loop: NOT-WORTH — fixture data (tests only)
        d.chunks_exact(2).map(|c| half::f16::from_le_bytes([c[0], c[1]]).to_f32()).collect()
    } else if header.contains("'<f8'") {
        // loop: NOT-WORTH — fixture data (tests only)
        d.chunks_exact(8).map(|c| f64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]) as f32).collect()
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
        return Err(format!("{} values for shape {shape:?}", v.len()));
    }
    Ok((shape, v))
}

#[test]
fn malformed_files_are_errors_not_panics() {
    let mut ok = b"\x93NUMPY\x01\x00".to_vec();
    let h = "{'descr': '<f4', 'fortran_order': False, 'shape': (2,), }";
    ok.extend((h.len() as u16).to_le_bytes());
    ok.extend(h.as_bytes());
    ok.extend(1.5f32.to_le_bytes());
    ok.extend(2.5f32.to_le_bytes());
    assert_eq!(parse(&ok).unwrap(), (vec![2], vec![1.5, 2.5]));
    // a header length past the end of the file
    let mut long = ok[..8].to_vec();
    long.extend(60000u16.to_le_bytes());
    long.extend(b"{'descr'");
    assert!(parse(&long).is_err());
    // version 2 with no room for its 4-byte length
    assert!(parse(b"\x93NUMPY\x02\x00\x01\x00").is_err());
    // missing values, a bad magic, a short file
    assert!(parse(&ok[..ok.len() - 4]).is_err());
    assert!(parse(b"\x93NUMPX\x01\x00\x00\x00").is_err());
    assert!(parse(b"\x93NUM").is_err());
}
