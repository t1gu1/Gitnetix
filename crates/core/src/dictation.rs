//! Voice dictation: speech to text on this computer, with whisper.cpp. The model is
//! downloaded once, on first use, and checked against its known hash before it is loaded.

use std::io::Cursor;
use std::path::Path;
use std::sync::Arc;

use sha2::{Digest, Sha256};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::codecs::CodecParameters;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use tokio::io::AsyncWriteExt;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::error::{Error, Result};

/// Whisper "base": multilingual, and quick enough on a laptop CPU.
const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
const MODEL_SHA256: &str = "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe";
const MODEL_SIZE: u64 = 147_951_465;
/// Whisper listens at 16 kHz.
const RATE: u32 = 16_000;

/// The model, loaded on first use and kept (about 200 MB of memory).
#[derive(Default)]
pub struct Dictation(tokio::sync::Mutex<Option<Arc<WhisperContext>>>);

impl Dictation {
    /// `audio` as the page recorded it (`mime`), as text. `progress(done, total)` follows the model's first download.
    pub async fn transcribe(&self, dir: &Path, audio: Vec<u8>, mime: String, progress: impl Fn(u64, u64) + Send) -> Result<String> {
        // Decoded first: a recording that can't be read fails before any download.
        let samples = tokio::task::spawn_blocking(move || decode(audio, &mime)).await.map_err(|e| Error::Other(e.to_string()))??;
        self.recognize(dir, samples, progress).await
    }

    /// Mono `samples` at `rate` Hz, as the desktop's microphone gave them, as text.
    pub async fn transcribe_mono(&self, dir: &Path, samples: Vec<f32>, rate: u32, progress: impl Fn(u64, u64) + Send) -> Result<String> {
        self.recognize(dir, resample(&samples, rate), progress).await
    }

    /// Mono 16 kHz `samples` as text.
    async fn recognize(&self, dir: &Path, samples: Vec<f32>, progress: impl Fn(u64, u64) + Send) -> Result<String> {
        if samples.len() < RATE as usize / 4 {
            return Ok(String::new());
        }
        let ctx = self.model(dir, progress).await?;
        tokio::task::spawn_blocking(move || run(&ctx, &samples)).await.map_err(|e| Error::Other(e.to_string()))?
    }

    async fn model(&self, dir: &Path, progress: impl Fn(u64, u64) + Send) -> Result<Arc<WhisperContext>> {
        // Held through the download: a second dictation waits for the same model.
        let mut slot = self.0.lock().await;
        if let Some(ctx) = slot.as_ref() {
            return Ok(ctx.clone());
        }
        let path = dir.join("models").join("ggml-base.bin");
        if !path.exists() {
            download(&path, progress).await?;
        }
        // Without it whisper.cpp writes its own log to stderr.
        whisper_rs::install_logging_hooks();
        let ctx = tokio::task::spawn_blocking(move || WhisperContext::new_with_params(&path, WhisperContextParameters::default()))
            .await
            .map_err(|e| Error::Other(e.to_string()))?
            .map_err(|e| Error::Other(format!("Could not load the speech model: {e}")))?;
        Ok(slot.insert(Arc::new(ctx)).clone())
    }
}

/// Fetch the model to `path`, through a `.part` file so a cut download is never taken for the model.
async fn download(path: &Path, progress: impl Fn(u64, u64)) -> Result<()> {
    if let Some(d) = path.parent() {
        tokio::fs::create_dir_all(d).await?;
    }
    let part = path.with_extension("part");
    let mut res = crate::net::client().get(MODEL_URL).send().await?.error_for_status()?;
    let mut file = tokio::fs::File::create(&part).await?;
    let (mut hash, mut done, mut shown) = (Sha256::new(), 0u64, u64::MAX);
    while let Some(chunk) = res.chunk().await? {
        hash.update(&chunk);
        file.write_all(&chunk).await?;
        done += chunk.len() as u64;
        // One update per percent is plenty for a progress bar.
        if done * 100 / MODEL_SIZE != shown {
            shown = done * 100 / MODEL_SIZE;
            progress(done, MODEL_SIZE);
        }
    }
    file.flush().await?;
    drop(file);
    if format!("{:x}", hash.finalize()) != MODEL_SHA256 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(Error::Other("The speech model download was damaged, try again".into()));
    }
    tokio::fs::rename(&part, path).await?;
    Ok(())
}

/// The recording as mono samples at Whisper's 16 kHz.
fn decode(audio: Vec<u8>, mime: &str) -> Result<Vec<f32>> {
    let bad = |e: symphonia::core::errors::Error| Error::Invalid(format!("can't read the recording ({mime}): {e}"));
    let mut hint = Hint::new();
    hint.mime_type(mime);
    let source = MediaSourceStream::new(Box::new(Cursor::new(audio)), Default::default());
    let mut format = symphonia::default::get_probe().probe(&hint, source, FormatOptions::default(), MetadataOptions::default()).map_err(bad)?;
    let track = format.default_track(TrackType::Audio).ok_or_else(|| Error::Invalid("no sound in the recording".into()))?;
    let (id, Some(CodecParameters::Audio(params))) = (track.id, track.codec_params.clone()) else {
        return Err(Error::Invalid("no sound in the recording".into()));
    };
    let mut decoder = symphonia::default::get_codecs().make_audio_decoder(&params, &AudioDecoderOptions::default()).map_err(bad)?;
    let (mut mono, mut rate, mut frame) = (Vec::new(), RATE, Vec::<f32>::new());
    while let Some(packet) = format.next_packet().map_err(bad)? {
        if packet.track_id != id {
            continue;
        }
        let buf = decoder.decode(&packet).map_err(bad)?;
        rate = buf.spec().rate();
        let channels = buf.spec().channels().count().max(1);
        buf.copy_to_vec_interleaved(&mut frame);
        mono.extend(frame.chunks(channels).map(|c| c.iter().sum::<f32>() / channels as f32));
    }
    Ok(resample(&mono, rate))
}

/// Mono `samples` at `rate` Hz to 16 kHz. Each output sample averages the input it spans,
/// which also keeps pitches above 8 kHz from folding back into the speech.
fn resample(samples: &[f32], rate: u32) -> Vec<f32> {
    if rate == RATE {
        return samples.to_vec();
    }
    let step = rate as f64 / RATE as f64;
    let n = (samples.len() as f64 / step) as usize;
    (0..n)
        .map(|i| {
            let a = (i as f64 * step) as usize;
            let b = (((i + 1) as f64 * step) as usize).clamp(a + 1, samples.len());
            samples[a..b].iter().sum::<f32>() / (b - a) as f32
        })
        .collect()
}

fn run(ctx: &WhisperContext, samples: &[f32]) -> Result<String> {
    let fail = |e: whisper_rs::WhisperError| Error::Other(format!("Speech recognition failed: {e}"));
    let mut state = ctx.create_state().map_err(fail)?;
    let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    p.set_language(Some("auto"));
    p.set_n_threads(std::thread::available_parallelism().map_or(4, |n| n.get().min(8)) as i32);
    p.set_print_progress(false);
    p.set_print_realtime(false);
    p.set_print_special(false);
    p.set_print_timestamps(false);
    p.set_suppress_nst(true);
    state.full(p, samples).map_err(fail)?;
    Ok(clean(state.as_iter().map(|s| s.to_string())))
}

/// The segments as one line, without the tags Whisper writes for silence or noise ("[BLANK_AUDIO]", "(music)").
fn clean(segments: impl Iterator<Item = String>) -> String {
    segments
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && !(s.starts_with('[') && s.ends_with(']')) && !(s.starts_with('(') && s.ends_with(')')))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resample_keeps_length_and_level() {
        let tone: Vec<f32> = (0..48_000).map(|i| (i as f32 * 0.01).sin()).collect();
        let out = resample(&tone, 48_000);
        assert_eq!(out.len(), 16_000);
        // A slow wave survives: each output is close to the input at the same moment.
        assert!(out.iter().enumerate().all(|(i, v)| (v - tone[i * 3 + 1]).abs() < 0.02));
        assert_eq!(resample(&[0.5; 441], 44_100), vec![0.5; 160]);
        assert_eq!(resample(&tone[..10], 16_000), tone[..10]);
    }

    #[test]
    fn clean_drops_silence_tags() {
        let seg = |v: &[&str]| clean(v.iter().map(|s| s.to_string()));
        assert_eq!(seg(&[" And so my fellow Americans,", " ask not."]), "And so my fellow Americans, ask not.");
        assert_eq!(seg(&[" [BLANK_AUDIO]"]), "");
        assert_eq!(seg(&["(music)", " Hello"]), "Hello");
    }
}
