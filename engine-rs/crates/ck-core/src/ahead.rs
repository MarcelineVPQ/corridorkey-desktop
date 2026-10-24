//! Work done ahead on its own thread: the next items of a sequence (decoded and resized network inputs) are
//! prepared while the graphics card runs the current one. Items come out in order; the producer stops at its
//! end (`Ok(None)`), at its first error (passed on), or when the consumer is dropped.
use crate::Error;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver};
use std::sync::Arc;

/// Seconds measured on one thread and read on another: an f64's bits in an atomic (no lock for a timing number).
#[derive(Clone, Default)]
pub(crate) struct Seconds(Arc<AtomicU64>);

impl Seconds {
    pub(crate) fn get(&self) -> f64 {
        f64::from_bits(self.0.load(Ordering::Relaxed))
    }
    pub(crate) fn set(&self, v: f64) {
        self.0.store(v.to_bits(), Ordering::Relaxed);
    }
    /// Add `v` (only the thread that measures writes, so a load and a store are enough).
    pub(crate) fn add(&self, v: f64) {
        self.set(self.get() + v);
    }
}

pub(crate) struct Ahead<T> {
    rx: Receiver<Result<T, Error>>,
    /// seconds the producer spent making items
    seconds: Seconds,
}

impl<T: Send + 'static> Ahead<T> {
    /// Run `next` on a thread, keeping up to `depth` items ready.
    pub(crate) fn spawn(depth: usize, mut next: impl FnMut() -> Result<Option<T>, Error> + Send + 'static) -> Ahead<T> {
        let (tx, rx) = sync_channel(depth);
        let seconds = Seconds::default();
        let s2 = seconds.clone();
        // loop: SERIAL-REQUIRED — one producer thread per sequence; it ends at the sequence's end, an error, or a dropped consumer
        std::thread::spawn(move || {
            // loop: SERIAL-REQUIRED — items in order; ends at the producer's end, an error, or a dropped consumer
            loop {
                let t = std::time::Instant::now();
                let item = next();
                s2.add(t.elapsed().as_secs_f64());
                let msg = match item {
                    Ok(Some(v)) => Ok(v),
                    Ok(None) => break,
                    Err(e) => Err(e),
                };
                let stop = msg.is_err();
                if tx.send(msg).is_err() || stop {
                    break;
                }
            }
        });
        Ahead { rx, seconds }
    }

    /// The next item, or None at the end.
    pub(crate) fn next_item(&mut self) -> Result<Option<T>, Error> {
        // loop: SERIAL-REQUIRED — the consumer takes items in order [bounded: the producer ends at its sequence's end or first error, which closes the channel]
        match self.rx.recv() {
            Ok(Ok(v)) => Ok(Some(v)),
            Ok(Err(e)) => Err(e),
            Err(_) => Ok(None),
        }
    }

    pub(crate) fn seconds(&self) -> f64 {
        self.seconds.get()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn items_in_order_then_end() {
        let mut i = 0;
        let mut a = Ahead::spawn(2, move || {
            i += 1;
            Ok((i <= 5).then_some(i))
        });
        let mut got = Vec::new();
        // loop: NOT-WORTH — five items
        while let Some(v) = a.next_item().unwrap() {
            got.push(v);
        }
        assert_eq!(got, vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn errors_are_passed_on() {
        let mut i = 0;
        let mut a = Ahead::spawn(2, move || {
            i += 1;
            if i == 3 {
                Err(Error::input("bad frame".into()))
            } else {
                Ok(Some(i))
            }
        });
        assert_eq!(a.next_item().unwrap(), Some(1));
        assert_eq!(a.next_item().unwrap(), Some(2));
        assert_eq!(a.next_item().unwrap_err().message, "bad frame");
        assert_eq!(a.next_item().unwrap(), None);
    }
}
