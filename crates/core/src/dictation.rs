//! Voice dictation: speech to text on this computer, with Parakeet through transcribe.cpp. The model is
//! downloaded once, on first use, and checked against its known hash before it is loaded.

use std::cmp::Ordering;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha2::{Digest, Sha256};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::codecs::CodecParameters;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use tokio::io::AsyncWriteExt;
use transcribe_cpp::{CancelToken, RunOptions, SessionOptions};

use crate::error::{Error, Result};
use crate::store::Store;

struct Model {
    file: &'static str,
    url: &'static str,
    sha256: &'static str,
    size: u64,
}

/// Parakeet Ultra, Moondream's post-training of NVIDIA's Parakeet TDT 0.6B v3, in 8 bits: English, French and 23 more
/// European languages, told apart on its own and punctuated, about 30 times faster than speech on a laptop CPU.
/// It writes only what it hears: no words made up in silences, no phrase said over and over, as Whisper did.
const SPEECH: Model = Model {
    file: "parakeet-ultra-Q8_0.gguf",
    // Pinned to the commit the hash is from.
    url: "https://huggingface.co/handy-computer/parakeet-ultra-gguf/resolve/a1539be1b849ea7463b88343e5277b373d0c4ea9/parakeet-ultra-Q8_0.gguf",
    sha256: "007a59761e9258779f189df396b50d12b83bb5b79e66df4b955c230d2f2a0a59",
    size: 740_363_168,
};
/// The models earlier versions used (Whisper, its French model and voice detection), deleted once the new one is in.
const OLD: [&str; 4] = ["ggml-base.bin", "ggml-large-v3-turbo-q5_0.bin", "ggml-large-v3-french-distil-dec16-q5_0.bin", "ggml-silero-v5.1.2.bin"];
/// The model listens at 16 kHz.
const RATE: u32 = 16_000;

/// A recording, as the page made it or as the desktop's microphone gave it.
pub enum Audio {
    /// Encoded as `mime` says.
    Recorded { bytes: Vec<u8>, mime: String },
    /// Mono samples at `rate` Hz.
    Mono { samples: Vec<f32>, rate: u32 },
}

/// The speech model, loaded on first use and kept (about 750 MB of memory), and what cancels the transcriptions under way.
#[derive(Default)]
pub struct Dictation(tokio::sync::Mutex<Option<Arc<transcribe_cpp::Model>>>, std::sync::Mutex<CancelToken>);

impl Dictation {
    /// Stops the transcriptions under way, from every device: a cancelled one would slow the next one down.
    pub fn cancel(&self) {
        let mut token = self.1.lock().unwrap();
        token.cancel();
        *token = CancelToken::new();
    }

    /// `audio` as text. Its language, when English or French, is kept as the spoken language, which AI can write in.
    /// `progress(done, total)` follows the speech model's first download.
    pub async fn transcribe(&self, dir: &Path, store: &Store, audio: Audio, progress: impl Fn(u64, u64) + Send + Sync) -> Result<String> {
        let samples = match audio {
            // Decoded first: a recording that can't be read fails before any download.
            Audio::Recorded { bytes, mime } => tokio::task::spawn_blocking(move || decode(bytes, &mime)).await.map_err(|e| Error::Other(e.to_string()))??,
            Audio::Mono { samples, rate } => resample(&samples, rate),
        };
        if samples.len() < RATE as usize / 4 {
            return Ok(String::new());
        }
        let cancel = self.1.lock().unwrap().clone();
        let model = self.model(dir, &progress).await?;
        if cancel.is_cancelled() {
            return Err(cancelled());
        }
        let text = tokio::task::spawn_blocking(move || write(&model, &samples, &cancel)).await.map_err(|e| Error::Other(e.to_string()))??;
        let changed = language(&text).filter(|&l| store.read(|c| c.ui.spoken_language.as_deref() != Some(l)));
        if let Some(lang) = changed {
            let saved = store.write(|c| {
                c.ui.spoken_language = Some(lang.into());
                Ok(())
            });
            // The words matter more than the language: a config that can't be saved doesn't lose them.
            if let Err(e) = saved {
                crate::log::error(format!("Could not save the spoken language: {e}"));
            }
        }
        Ok(text)
    }

    async fn model(&self, dir: &Path, progress: impl Fn(u64, u64) + Send) -> Result<Arc<transcribe_cpp::Model>> {
        // Held through the download: a second dictation waits for the same model.
        let mut slot = self.0.lock().await;
        if let Some(loaded) = slot.as_ref() {
            return Ok(loaded.clone());
        }
        let models = dir.join("models");
        let path = models.join(SPEECH.file);
        if !path.exists() {
            download(&path, &SPEECH, progress).await?;
            for old in OLD {
                let _ = tokio::fs::remove_file(models.join(old)).await;
            }
        }
        Ok(slot.insert(load(path).await?).clone())
    }
}

/// The speech model at `path`, loaded.
async fn load(path: PathBuf) -> Result<Arc<transcribe_cpp::Model>> {
    // Without it transcribe.cpp writes its own log to stderr, a few lines per dictation. Its errors come back as errors.
    transcribe_cpp::disable_logging();
    let model = tokio::task::spawn_blocking(move || transcribe_cpp::Model::load(&path))
        .await
        .map_err(|e| Error::Other(e.to_string()))?
        .map_err(|e| Error::Other(format!("Could not load the speech model: {e}")))?;
    Ok(Arc::new(model))
}

/// Fetch `model` to `path`, through a `.part` file so a cut download is never taken for the model.
async fn download(path: &Path, model: &Model, progress: impl Fn(u64, u64)) -> Result<()> {
    if let Some(d) = path.parent() {
        tokio::fs::create_dir_all(d).await?;
    }
    let part = path.with_extension("part");
    let mut res = crate::net::client().get(model.url).send().await?.error_for_status()?;
    let mut file = tokio::fs::File::create(&part).await?;
    let (mut hash, mut done, mut shown) = (Sha256::new(), 0u64, u64::MAX);
    while let Some(chunk) = res.chunk().await? {
        hash.update(&chunk);
        file.write_all(&chunk).await?;
        done += chunk.len() as u64;
        // One update per percent is plenty for a progress bar.
        if done * 100 / model.size != shown {
            shown = done * 100 / model.size;
            progress(done, model.size);
        }
    }
    file.flush().await?;
    drop(file);
    if format!("{:x}", hash.finalize()) != model.sha256 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(Error::Other("The speech model download was damaged, try again".into()));
    }
    tokio::fs::rename(&part, path).await?;
    Ok(())
}

/// The recording as mono samples at the model's 16 kHz.
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

/// `samples` as text, by `model`. Ends early, with an error, once `cancel` is cancelled.
fn write(model: &transcribe_cpp::Model, samples: &[f32], cancel: &CancelToken) -> Result<String> {
    let fail = |e: transcribe_cpp::Error| if cancel.is_cancelled() { cancelled() } else { Error::Other(format!("Speech recognition failed: {e}")) };
    // A session per dictation: a few milliseconds, and dictations from two devices don't wait on each other.
    let mut session = model.session_with(&SessionOptions { n_threads: threads(), ..Default::default() }).map_err(fail)?;
    session.set_cancel_token(cancel);
    Ok(session.run(samples, &RunOptions::default()).map_err(fail)?.text.trim().into())
}

fn cancelled() -> Error {
    Error::Other("Dictation cancelled".into())
}

/// The threads the model runs on. transcribe.cpp alone takes 8 at most: half the speed on a 16-core CPU.
fn threads() -> i32 {
    std::thread::available_parallelism().map_or(4, |n| n.get().min(16)) as i32
}

/// The language of `text` among the two AI writes in, by the little words each uses most; None when it can't tell.
/// The model tells languages apart but doesn't say which it heard.
fn language(text: &str) -> Option<&'static str> {
    const FR: [&str; 24] = ["le", "la", "les", "un", "une", "des", "du", "et", "est", "que", "qu", "qui", "je", "il", "ce", "ça", "nous", "vous", "pour", "pas", "dans", "avec", "sur", "mais"];
    const EN: [&str; 20] = ["the", "an", "and", "is", "are", "to", "of", "that", "this", "it", "i", "you", "we", "my", "for", "not", "with", "be", "what", "can"];
    let (mut fr, mut en) = (0, 0);
    for w in text.split(|c: char| !c.is_alphanumeric()).map(str::to_lowercase) {
        fr += FR.contains(&w.as_str()) as u32;
        en += EN.contains(&w.as_str()) as u32;
    }
    match fr.cmp(&en) {
        Ordering::Greater => Some("fr"),
        Ordering::Less => Some("en"),
        Ordering::Equal => None,
    }
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
    fn language_goes_by_the_little_words() {
        assert_eq!(language("Je veux que le bouton de commit soit plus gros, et qu'il devienne vert quand tout est staged."), Some("fr"));
        // English words in French speech don't make it English.
        assert_eq!(language("Nice! Ça semble marcher, mais le diff est encore lent sur les gros fichiers."), Some("fr"));
        assert_eq!(language("Add a close icon to the terminal menu rows, and split long context menus into two columns."), Some("en"));
        assert_eq!(language("Ok, parfait."), None);
        assert_eq!(language(""), None);
    }

    /// Needs the model (`GNX_MODEL`, else ~/.config/gitnetix/models) and a folder of 16 kHz mono f32 clips, jfk.f32 among them:
    /// `GNX_CLIPS=/path/to/clips cargo test --release -p gitnetix-core -- --ignored speech --nocapture`.
    #[test]
    #[ignore]
    fn speech_writes_what_was_said() {
        let path = std::env::var("GNX_MODEL").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap()).join(".config/gitnetix/models").join(SPEECH.file));
        let model = transcribe_cpp::Model::load(&path).unwrap();
        let run = |samples: &[f32]| write(&model, samples, &CancelToken::new()).unwrap();
        let clips = PathBuf::from(std::env::var("GNX_CLIPS").unwrap());
        let clip = |path: &Path| std::fs::read(path).unwrap().chunks(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect::<Vec<f32>>();
        for entry in std::fs::read_dir(&clips).unwrap() {
            let path = entry.unwrap().path();
            let t = std::time::Instant::now();
            let text = run(&clip(&path));
            println!("{} in {:.2}s: {text}", path.file_stem().unwrap().to_string_lossy(), t.elapsed().as_secs_f32());
        }
        let jfk = clip(&clips.join("jfk.f32"));
        assert!(run(&jfk).contains("ask not what your country can do for you"));
        // Silence alone is no speech, not a made-up sentence.
        assert_eq!(run(&[0.0; 3 * RATE as usize]), "");
        // A cancel stops it.
        let cancel = CancelToken::new();
        cancel.cancel();
        assert_eq!(write(&model, &jfk, &cancel).unwrap_err().to_string(), "Dictation cancelled");
    }
}
