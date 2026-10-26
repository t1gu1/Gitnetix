//! The desktop microphone, for voice dictation. A webview records in the codecs its OS ships:
//! WebKitGTK writes only MP4 or WebM, and many Linux installs lack the GStreamer plugins for them.
//! So the desktop app records here and hands Whisper plain samples.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};

/// The default microphone, recording until `finish` (or until dropped).
pub struct Recording {
    /// Dropped to stop the recording thread.
    stop: mpsc::Sender<()>,
    thread: JoinHandle<(Vec<f32>, u32)>,
}

impl Recording {
    /// `level` gets the voice's loudness, 0 to 1, 20 times a second.
    pub fn start(level: impl Fn(f32) + Send + 'static) -> Result<Self, String> {
        let (stop, stopped) = mpsc::channel::<()>();
        let (ready, started) = mpsc::channel();
        // The stream lives on its own thread: it isn't Send on every platform.
        let thread = std::thread::spawn(move || {
            let samples = Arc::new(Mutex::new(Vec::new()));
            let loudest = Arc::new(AtomicU32::new(0));
            let (stream, rate) = match open(samples.clone(), loudest.clone()) {
                Ok(s) => {
                    let _ = ready.send(Ok(()));
                    s
                }
                Err(e) => {
                    let _ = ready.send(Err(e));
                    return (Vec::new(), 0);
                }
            };
            while let Err(RecvTimeoutError::Timeout) = stopped.recv_timeout(Duration::from_millis(50)) {
                // Square root: speech sits around 0.01 to 0.2 in plain loudness, too low to see.
                level((f32::from_bits(loudest.swap(0, Ordering::Relaxed)).sqrt() * 2.0).min(1.0));
            }
            drop(stream);
            let samples = std::mem::take(&mut *samples.lock().unwrap());
            (samples, rate)
        });
        started.recv().map_err(|_| "The microphone stopped unexpectedly".to_string())??;
        Ok(Recording { stop, thread })
    }

    /// Stops, and gives the mono samples and their rate in Hz.
    pub fn finish(self) -> (Vec<f32>, u32) {
        drop(self.stop);
        self.thread.join().unwrap_or_default()
    }
}

fn open(samples: Arc<Mutex<Vec<f32>>>, loudest: Arc<AtomicU32>) -> Result<(cpal::Stream, u32), String> {
    let device = cpal::default_host().default_input_device().ok_or("No microphone found")?;
    let config = device.default_input_config().map_err(|e| format!("Can't use the microphone: {e}"))?;
    let rate = config.sample_rate();
    let stream = match config.sample_format() {
        SampleFormat::F32 => listen::<f32>(&device, config.into(), samples, loudest),
        SampleFormat::I16 => listen::<i16>(&device, config.into(), samples, loudest),
        SampleFormat::I32 => listen::<i32>(&device, config.into(), samples, loudest),
        SampleFormat::U16 => listen::<u16>(&device, config.into(), samples, loudest),
        f => return Err(format!("The microphone records {f} samples, which Gitnetix can't read")),
    }
    .map_err(|e| format!("Can't use the microphone: {e}"))?;
    stream.play().map_err(|e| format!("Can't start the microphone: {e}"))?;
    Ok((stream, rate))
}

/// Appends each buffer, mixed to mono, to `samples`, and keeps the loudest buffer's level (RMS) in `loudest`.
fn listen<T: SizedSample>(device: &cpal::Device, config: cpal::StreamConfig, samples: Arc<Mutex<Vec<f32>>>, loudest: Arc<AtomicU32>) -> Result<cpal::Stream, cpal::Error>
where
    f32: FromSample<T>,
{
    let channels = config.channels.max(1) as usize;
    let on_data = move |data: &[T], _: &cpal::InputCallbackInfo| {
        let mut all = samples.lock().unwrap();
        let from = all.len();
        all.extend(data.chunks(channels).map(|c| c.iter().map(|s| s.to_sample::<f32>()).sum::<f32>() / channels as f32));
        let new = &all[from..];
        let rms = (new.iter().map(|s| s * s).sum::<f32>() / new.len().max(1) as f32).sqrt();
        // A non-negative float's bits order like the float: the max of the bits is the loudest.
        loudest.fetch_max(rms.to_bits(), Ordering::Relaxed);
    };
    device.build_input_stream(config, on_data, |e| tracing::warn!("microphone: {e}"), None)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs a microphone: `cargo test -p gitnetix -- --ignored mic`.
    #[test]
    #[ignore]
    fn mic_records_from_the_default_input() {
        let levels = Arc::new(Mutex::new(Vec::new()));
        let seen = levels.clone();
        let rec = Recording::start(move |l| seen.lock().unwrap().push(l)).unwrap();
        std::thread::sleep(Duration::from_millis(1000));
        let (samples, rate) = rec.finish();
        let levels = levels.lock().unwrap();
        println!("{} samples at {rate} Hz, levels {levels:?}", samples.len());
        assert!(rate >= 8_000 && samples.len() as u32 > rate / 2);
        assert!(levels.len() >= 10 && levels.iter().all(|l| (0.0..=1.0).contains(l)));
    }
}
