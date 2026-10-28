//! Work done ahead on its own thread: the next items of a sequence (decoded and resized network inputs) are
//! prepared while the graphics card runs the current one. Items come out in order; the producer stops at its
//! end (`Ok(None)`), at its first error (passed on), or when the consumer is dropped. Dropping the consumer waits
//! for the producer to end (at most the item it is making): a failed attempt's thread, and the frames and temporary
//! files it holds, never outlive the attempt (final review 2026-10-28 S3: the window thread kept decoding a whole
//! window while the halve-and-retry's new decode started). A producer must therefore never wait on something the
//! consumer's owner drops after the `Ahead` (declare such a sender after it).
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
    /// None only while dropping (dropped first, so a producer blocked on a send ends)
    rx: Option<Receiver<Result<T, Error>>>,
    /// seconds the producer spent making items
    seconds: Seconds,
    /// the producer thread, joined when its channel closes: a panic there becomes this sequence's error instead of
    /// a silent early end
    producer: Option<std::thread::JoinHandle<()>>,
}

/// Start a named thread (the name shows in panics, debuggers and `top -H`).
pub(crate) fn spawn_named<R: Send + 'static>(name: &str, f: impl FnOnce() -> R + Send + 'static) -> Result<std::thread::JoinHandle<R>, Error> {
    // loop: SERIAL-REQUIRED — the callers' threads, each with its own verdict
    std::thread::Builder::new().name(name.to_string()).spawn(f).map_err(|e| Error::engine(format!("couldn't start the {name} thread: {e}")))
}

/// What a joined thread's panic said, as an error naming the thread.
pub(crate) fn joined<R>(handle: std::thread::JoinHandle<R>) -> Result<R, Error> {
    let name = handle.thread().name().unwrap_or("worker").to_string();
    // loop: SERIAL-REQUIRED — joins a thread whose channel has closed [bounded: the thread has ended or is ending]
    handle.join().map_err(|p| Error::engine(format!("the {name} thread panicked: {}", crate::panic_message(&*p))))
}

impl<T: Send + 'static> Ahead<T> {
    /// Run `next` on a thread named `name`, keeping up to `depth` items ready.
    pub(crate) fn spawn(name: &str, depth: usize, mut next: impl FnMut() -> Result<Option<T>, Error> + Send + 'static) -> Result<Ahead<T>, Error> {
        let (tx, rx) = sync_channel(depth);
        let seconds = Seconds::default();
        let s2 = seconds.clone();
        // loop: SERIAL-REQUIRED — one producer thread per sequence; it ends at the sequence's end, an error, or a dropped consumer
        let producer = spawn_named(name, move || {
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
        })?;
        Ok(Ahead { rx: Some(rx), seconds, producer: Some(producer) })
    }

    /// The next item, or None at the end; Err when the producer failed or panicked.
    pub(crate) fn next_item(&mut self) -> Result<Option<T>, Error> {
        let Some(rx) = self.rx.as_ref() else { return Ok(None) };
        // loop: SERIAL-REQUIRED — the consumer takes items in order [bounded: the producer ends at its sequence's end or first error, which closes the channel]
        match rx.recv() {
            Ok(Ok(v)) => Ok(Some(v)),
            Ok(Err(e)) => Err(e),
            // the channel closed: the producer ended, normally or in a panic
            Err(_) => match self.producer.take() {
                // loop: SERIAL-REQUIRED — joins the producer once its channel closed [bounded: it has returned or unwound]
                Some(h) => joined(h).map(|_| None),
                None => Ok(None),
            },
        }
    }

    pub(crate) fn seconds(&self) -> f64 {
        self.seconds.get()
    }
}

impl<T> Drop for Ahead<T> {
    fn drop(&mut self) {
        // the receiver first: a producer blocked on a send (or at its next one) then ends
        self.rx.take();
        if let Some(h) = self.producer.take() {
            // loop: SERIAL-REQUIRED — joins the producer after its receiver is gone [bounded: it finishes the item it is making, its send fails, it returns]
            let _ = h.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn items_in_order_then_end() {
        let mut i = 0;
        let mut a = Ahead::spawn("test-items", 2, move || {
            i += 1;
            Ok((i <= 5).then_some(i))
        })
        .unwrap();
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
        let mut a = Ahead::spawn("test-items", 2, move || {
            i += 1;
            if i == 3 {
                Err(Error::input("bad frame".into()))
            } else {
                Ok(Some(i))
            }
        })
        .unwrap();
        assert_eq!(a.next_item().unwrap(), Some(1));
        assert_eq!(a.next_item().unwrap(), Some(2));
        assert_eq!(a.next_item().unwrap_err().message, "bad frame");
        assert_eq!(a.next_item().unwrap(), None);
    }

    #[test]
    fn dropping_the_consumer_waits_for_the_producer() {
        // final review 2026-10-28 S3: a failed pass dropped its Ahead and the producer went on with its item (a whole
        // window of frames, the temp files' handles) while the retry started
        use std::sync::atomic::AtomicBool;
        struct Held(Arc<AtomicBool>);
        impl Drop for Held {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let released = Arc::new(AtomicBool::new(false));
        let held = Held(released.clone());
        let mut i = 0;
        let mut a = Ahead::spawn("test-slow", 0, move || {
            let _held = &held;
            i += 1;
            if i > 1 {
                // the item being made when the consumer gives up
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
            Ok(Some(i))
        })
        .unwrap();
        assert_eq!(a.next_item().unwrap(), Some(1));
        drop(a);
        assert!(released.load(Ordering::SeqCst), "the producer (and what it holds) outlived its Ahead");
    }

    #[test]
    fn a_producer_that_panics_is_an_error_naming_its_thread() {
        let mut i = 0;
        let mut a = Ahead::spawn("rvm-inputs", 1, move || {
            i += 1;
            if i == 2 {
                panic!("index out of bounds: the len is 3 but the index is 7");
            }
            Ok(Some(i))
        })
        .unwrap();
        assert_eq!(a.next_item().unwrap(), Some(1));
        let e = a.next_item().unwrap_err();
        assert_eq!(e.code, crate::ErrorCode::Engine);
        assert_eq!(e.message, "the rvm-inputs thread panicked: index out of bounds: the len is 3 but the index is 7");
        // asked again: the end (the thread was joined once)
        assert_eq!(a.next_item().unwrap(), None);
    }
}
