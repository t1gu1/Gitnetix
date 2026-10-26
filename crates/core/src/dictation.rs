//! Voice dictation: speech to text on this computer, with whisper.cpp. The model is
//! downloaded once, on first use, and checked against its known hash before it is loaded.

use std::io::Cursor;
use std::ops::Range;
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
use crate::store::Store;

/// Whisper "base": multilingual, and quick enough on a laptop CPU.
const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
const MODEL_SHA256: &str = "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe";
const MODEL_SIZE: u64 = 147_951_465;
/// Whisper listens at 16 kHz.
const RATE: u32 = 16_000;
/// 20 ms of samples: the step pauses are looked for in.
const FRAME: usize = RATE as usize / 50;
/// A pause of half a second (in frames): where the speaker may switch language.
const PAUSE: usize = 25;
/// Less speech than 2 s is too little to tell its language: it joins its neighbor.
const MIN_STRETCH: usize = 2 * RATE as usize;

/// The model, loaded on first use and kept (about 200 MB of memory).
#[derive(Default)]
pub struct Dictation(tokio::sync::Mutex<Option<Arc<WhisperContext>>>);

impl Dictation {
    /// `audio` as the page recorded it (`mime`), as text. `progress(done, total)` follows the model's first download.
    pub async fn transcribe(&self, dir: &Path, store: &Store, audio: Vec<u8>, mime: String, progress: impl Fn(u64, u64) + Send) -> Result<String> {
        // Decoded first: a recording that can't be read fails before any download.
        let samples = tokio::task::spawn_blocking(move || decode(audio, &mime)).await.map_err(|e| Error::Other(e.to_string()))??;
        self.recognize(dir, store, samples, progress).await
    }

    /// Mono `samples` at `rate` Hz, as the desktop's microphone gave them, as text.
    pub async fn transcribe_mono(&self, dir: &Path, store: &Store, samples: Vec<f32>, rate: u32, progress: impl Fn(u64, u64) + Send) -> Result<String> {
        self.recognize(dir, store, resample(&samples, rate), progress).await
    }

    /// Mono 16 kHz `samples` as text, in the languages the settings allow. The language most of it
    /// was in is kept as the spoken language, which AI can write in.
    async fn recognize(&self, dir: &Path, store: &Store, samples: Vec<f32>, progress: impl Fn(u64, u64) + Send) -> Result<String> {
        if samples.len() < RATE as usize / 4 {
            return Ok(String::new());
        }
        let ctx = self.model(dir, progress).await?;
        let langs = store.read(|c| c.ui.dictation_languages.clone());
        let (text, lang) = tokio::task::spawn_blocking(move || run(&ctx, &samples, &langs)).await.map_err(|e| Error::Other(e.to_string()))??;
        let changed = lang.filter(|&l| store.read(|c| c.ui.spoken_language.as_deref() != Some(l)));
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

/// The speech as text, each stretch between pauses written in its own language among `langs`
/// (Whisper codes, "fr"; none: any), and the language most of it was in.
/// Whisper alone picks one language from the first 30 s, and drops or translates the rest.
fn run(ctx: &WhisperContext, samples: &[f32], langs: &[String]) -> Result<(String, Option<&'static str>)> {
    let fail = |e: whisper_rs::WhisperError| Error::Other(format!("Speech recognition failed: {e}"));
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get().min(8));
    let mut state = ctx.create_state().map_err(fail)?;
    let mut allowed: Vec<i32> = (0..=whisper_rs::get_lang_max_id()).filter(|&i| langs.iter().any(|l| whisper_rs::get_lang_str(i) == Some(l.as_str()))).collect();
    if allowed.is_empty() {
        allowed = (0..=whisper_rs::get_lang_max_id()).collect();
    }
    // Neighbors in the same language go as one part: Whisper writes better with more context.
    let mut parts: Vec<(i32, Range<usize>)> = Vec::new();
    for r in stretches(samples) {
        let lang = match allowed[..] {
            [one] => one,
            _ => {
                state.pcm_to_mel(&samples[r.clone()], threads).map_err(fail)?;
                pick(&state.lang_detect(0, threads).map_err(fail)?.1, &allowed)
            }
        };
        match parts.last_mut() {
            Some((l, last)) if *l == lang => last.end = r.end,
            _ => parts.push((lang, r)),
        }
    }
    let mut said = Vec::new();
    for (lang, r) in &parts {
        let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        p.set_language(whisper_rs::get_lang_str(*lang));
        p.set_n_threads(threads as i32);
        p.set_print_progress(false);
        p.set_print_realtime(false);
        p.set_print_special(false);
        p.set_print_timestamps(false);
        p.set_suppress_nst(true);
        state.full(p, &samples[r.clone()]).map_err(fail)?;
        said.extend(state.as_iter().map(|s| s.to_string()));
    }
    let text = clean(said.into_iter());
    let spoken = |l: i32| parts.iter().filter(|(x, _)| *x == l).map(|(_, r)| r.len()).sum::<usize>();
    let main = parts.iter().map(|(l, _)| *l).max_by_key(|&l| spoken(l)).filter(|_| !text.is_empty());
    Ok((text, main.and_then(whisper_rs::get_lang_str)))
}

/// The likeliest of the `allowed` language ids, by Whisper's `probs`.
fn pick(probs: &[f32], allowed: &[i32]) -> i32 {
    allowed.iter().copied().max_by(|&a, &b| probs[a as usize].total_cmp(&probs[b as usize])).unwrap_or(0)
}

/// `samples` cut in the middle of each pause, as ranges that cover them all.
/// Quiet is under a tenth of the loudest moment, so the microphone's level doesn't matter.
fn stretches(samples: &[f32]) -> Vec<Range<usize>> {
    let rms: Vec<f32> = samples.chunks(FRAME).map(|c| (c.iter().map(|s| s * s).sum::<f32>() / c.len() as f32).sqrt()).collect();
    let quiet = rms.iter().copied().fold(0.0, f32::max) / 10.0;
    let (mut cuts, mut run) = (vec![0], 0);
    for (i, &r) in rms.iter().enumerate() {
        if r < quiet {
            run += 1;
            continue;
        }
        if run >= PAUSE {
            cuts.push((i - run / 2) * FRAME);
        }
        run = 0;
    }
    cuts.push(samples.len());
    let mut out: Vec<Range<usize>> = Vec::new();
    for w in cuts.windows(2) {
        match out.last_mut() {
            Some(last) if last.len() < MIN_STRETCH || w[1] - w[0] < MIN_STRETCH => last.end = w[1],
            _ => out.push(w[0]..w[1]),
        }
    }
    out
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

    #[test]
    fn stretches_cut_at_long_pauses_only() {
        let s = |secs: f32, v: f32| vec![v; (secs * RATE as f32) as usize];
        // 3 s of speech, a 1 s pause, 3 s, a short breath, 3 s: one cut, mid-pause.
        let talk = [s(3.0, 0.3), s(1.0, 0.0), s(3.0, 0.3), s(0.2, 0.0), s(3.0, 0.3)].concat();
        assert_eq!(stretches(&talk), vec![0..56_000, 56_000..talk.len()]);
        // Half a second before a pause is too short to tell a language: it joins what follows.
        let short = [s(0.5, 0.3), s(1.0, 0.0), s(3.0, 0.3)].concat();
        assert_eq!(stretches(&short), vec![0..short.len()]);
        assert_eq!(stretches(&s(1.0, 0.0)), vec![0..16_000]);
    }

    #[test]
    fn pick_keeps_to_the_allowed_languages() {
        let mut probs = vec![0.0; 100];
        (probs[0], probs[2], probs[6]) = (0.6, 0.1, 0.3); // en, de, fr
        assert_eq!(pick(&probs, &[0, 2, 6]), 0);
        assert_eq!(pick(&probs, &[2, 6]), 6);
    }

    /// Needs the speech model in ~/.config/gitnetix/models and 16 kHz mono f32 clips:
    /// `GNX_CLIPS=/tmp/gnx-voice cargo test --release -p gitnetix-core -- --ignored speech --nocapture`.
    #[test]
    #[ignore]
    fn speech_follows_the_spoken_language() {
        let model = std::env::var("HOME").unwrap() + "/.config/gitnetix/models/ggml-base.bin";
        let ctx = WhisperContext::new_with_params(&model, WhisperContextParameters::default()).unwrap();
        let clip = |name: &str| {
            let raw = std::fs::read(format!("{}/{name}.f32", std::env::var("GNX_CLIPS").unwrap())).unwrap();
            raw.chunks(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect::<Vec<f32>>()
        };
        let fr_en = ["fr".to_string(), "en".to_string()];
        for (name, langs) in [("fr4", &fr_en[..]), ("jfk", &fr_en[..]), ("mixed", &fr_en[..]), ("mixed", &[][..])] {
            let t = std::time::Instant::now();
            let (text, lang) = run(&ctx, &clip(name), langs).unwrap();
            println!("{name} {langs:?} → {lang:?} in {:.1}s: {text}", t.elapsed().as_secs_f32());
        }
        assert_eq!(run(&ctx, &clip("fr4"), &fr_en).unwrap().1, Some("fr"));
        assert_eq!(run(&ctx, &clip("jfk"), &fr_en).unwrap().1, Some("en"));
        let (mixed, _) = run(&ctx, &clip("mixed"), &fr_en).unwrap();
        assert!(mixed.contains("Varsovie") && mixed.contains("ask not what your country"), "{mixed}");
    }
}
