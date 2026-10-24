//! A job's temporary files in temp_dir: the RVM features, the low-VRAM foundation features and stage-1 states.
use crate::runtime::Data;
use crate::Error;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// The job's temporary files (one set per clip name in temp_dir).
pub(crate) struct TempPaths {
    pub(crate) rvm: PathBuf,
    pub(crate) baton: PathBuf,
    pub(crate) cradio: PathBuf,
    pub(crate) moge: PathBuf,
}

impl TempPaths {
    pub(crate) fn new(temp_dir: &Path, clip: &str) -> TempPaths {
        TempPaths {
            rvm: temp_dir.join(format!("{clip}_rvm_feat.f16")),
            baton: temp_dir.join(format!("{clip}_baton.f16")),
            cradio: temp_dir.join(format!("{clip}_foundation_cradio.bin")),
            moge: temp_dir.join(format!("{clip}_foundation_moge.bin")),
        }
    }

    /// The guard that removes them when the attempt ends.
    pub(crate) fn guard(&self) -> Temps {
        Temps(vec![self.rvm.clone(), self.baton.clone(), self.cradio.clone(), self.moge.clone()])
    }
}

/// Temp files of a job, removed when it ends (runtime.run_inference's finally).
pub(crate) struct Temps(Vec<PathBuf>);
impl Drop for Temps {
    fn drop(&mut self) {
        // loop: NOT-WORTH — four temp files at the job's end
        self.0.iter().for_each(|p| {
            let _ = std::fs::remove_file(p);
        });
    }
}

fn open_rw(p: &Path) -> Result<File, Error> {
    std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(true).open(p).map_err(|e| Error::write("a temporary file", p, &e))
}

fn temp_err(e: std::io::Error) -> Error {
    match crate::write_failure(&e) {
        // the temporary folder's disk filled up (the RVM features and states take GBs on long clips)
        Some(why) => Error::new(crate::ErrorCode::Output, format!("Can't write the job's temporary files: {why} ({e})")),
        None => Error::engine(format!("temp file: {e}")),
    }
}

/// A float16 (T, C*H*W) array on disk (the runtime's np.memmap files): written and read as raw float16, no
/// conversion on the way.
pub(crate) struct F16File {
    f: File,
    frame: usize,
}

impl F16File {
    pub(crate) fn create(p: &Path, frame: usize) -> Result<F16File, Error> {
        Ok(F16File { f: open_rw(p)?, frame })
    }
    /// frames from `t` on (`v` holds whole frames)
    pub(crate) fn put(&mut self, t: usize, v: &[half::f16]) -> Result<(), Error> {
        self.f.seek(SeekFrom::Start((t * self.frame * 2) as u64)).and_then(|_| self.f.write_all(bytemuck::cast_slice(v))).map_err(temp_err)
    }
    /// frames t0..t1
    pub(crate) fn get(&mut self, t0: usize, t1: usize) -> Result<Vec<half::f16>, Error> {
        let mut out = vec![half::f16::ZERO; (t1 - t0) * self.frame];
        // loop: HOT-PATH-OK — one RVM window or baton frame from the local temp file, read straight into float16 (this pass: no byte buffer + conversion) [bounded: a local file read]
        self.f.seek(SeekFrom::Start((t0 * self.frame * 2) as u64)).and_then(|_| self.f.read_exact(bytemuck::cast_slice_mut(&mut out))).map_err(temp_err)?;
        Ok(out)
    }
}

/// The low-VRAM foundation features on disk, (T, C*H*W) in the type the network made them (float16 for the fp16
/// models, float32 for fp32): kept exactly, half the bytes of the float32 file for fp16.
pub(crate) struct FeatFile {
    f: File,
    frame: usize,
    /// set by the first `put`: float16 (true) or float32
    half: Option<bool>,
}

impl FeatFile {
    pub(crate) fn create(p: &Path, frame: usize) -> Result<FeatFile, Error> {
        Ok(FeatFile { f: open_rw(p)?, frame, half: None })
    }
    /// frames from `t` on
    pub(crate) fn put(&mut self, t: usize, v: &Data) -> Result<(), Error> {
        let (half, bytes): (bool, &[u8]) = match v {
            Data::F16(x) => (true, bytemuck::cast_slice(x)),
            Data::F32(x) => (false, bytemuck::cast_slice(x)),
            Data::Bf16(_) | Data::F16Ref(_) | Data::F32Ref(_) => return Err(Error::engine("foundation features as bfloat16 or borrowed".into())),
        };
        if *self.half.get_or_insert(half) != half {
            return Err(Error::engine("foundation features changed type".into()));
        }
        let size = if half { 2 } else { 4 };
        self.f.seek(SeekFrom::Start((t * self.frame * size) as u64)).and_then(|_| self.f.write_all(bytes)).map_err(temp_err)
    }
    /// frames t0..t1
    pub(crate) fn get(&mut self, t0: usize, t1: usize) -> Result<Data<'static>, Error> {
        let n = (t1 - t0) * self.frame;
        let half = self.half.ok_or_else(|| Error::engine("foundation features not written".into()))?;
        let size = if half { 2 } else { 4 };
        self.f.seek(SeekFrom::Start((t0 * self.frame * size) as u64)).map_err(temp_err)?;
        Ok(if half {
            let mut out = vec![half::f16::ZERO; n];
            // loop: HOT-PATH-OK — one window's foundation features from the local temp file, in their own type (this pass: float16, half the bytes) [bounded: a local file read]
            self.f.read_exact(bytemuck::cast_slice_mut(&mut out)).map_err(temp_err)?;
            Data::F16(out)
        } else {
            let mut out = vec![0f32; n];
            // loop: HOT-PATH-OK — the float32 (CPU / fp32) case of the same read [bounded: a local file read]
            self.f.read_exact(bytemuck::cast_slice_mut(&mut out)).map_err(temp_err)?;
            Data::F32(out)
        })
    }
}
