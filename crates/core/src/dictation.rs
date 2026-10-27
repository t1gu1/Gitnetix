//! Voice dictation: speech to text on this computer, with whisper.cpp. The models are
//! downloaded once, on first use, and checked against their known hash before they are loaded.

use std::io::Cursor;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use sha2::{Digest, Sha256};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::codecs::CodecParameters;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use tokio::io::AsyncWriteExt;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState, WhisperVadContext, WhisperVadContextParams, WhisperVadParams};

use crate::error::{Error, Result};
use crate::store::Store;

struct Model {
    file: &'static str,
    url: &'static str,
    sha256: &'static str,
    size: u64,
}

/// Whisper "large-v3-turbo", quantized: multilingual, and far more accurate than "base" in French for a few seconds more on a laptop CPU.
// shortcut: whisper.cpp runs on the CPU only, about 5 s per 10 s of speech on a fast laptop; build whisper-rs with its `metal` (macOS) and `vulkan` features for GPU speed.
const SPEECH: Model = Model {
    file: "ggml-large-v3-turbo-q5_0.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    size: 574_041_195,
};
/// Whisper large-v3 tuned on French and cut to 16 decoder layers, for the speech found to be French: where turbo
/// misspells names, drops capitals and repeats itself, this one doesn't, in about the same time. It only writes:
/// turbo still tells the language, as this one takes everything for French.
const FRENCH: Model = Model {
    file: "ggml-large-v3-french-distil-dec16-q5_0.bin",
    // Pinned to the commit the hash is from: a personal repository can change its files.
    url: "https://huggingface.co/bofenghuang/whisper-large-v3-french-distil-dec16/resolve/16bd02185bdaa6b00fb4b0deb46e47ac1b754b8e/ggml-model-q5_0.bin",
    sha256: "a804330f5cd369fb7447ad2935eb7bf5b1d628ba246a067255ac70775df720e4",
    size: 791_369_259,
};
/// Silero voice activity detection: where the recording holds speech, so Whisper never hears a silence it would fill with made-up words.
const VAD: Model = Model {
    file: "ggml-silero-v5.1.2.bin",
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
    sha256: "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
    size: 885_098,
};
/// The speech model earlier versions used, deleted once the new one is in.
const OLD_SPEECH: &str = "ggml-base.bin";
/// Whisper listens at 16 kHz.
const RATE: u32 = 16_000;
/// A pause of half a second: where the speaker may switch language, and the longest silence Whisper is given.
const PAUSE: usize = RATE as usize / 2;
/// Less speech than 2 s is too little to tell its language: it joins its neighbor.
const MIN_STRETCH: usize = 2 * RATE as usize;

/// A recording, as the page made it or as the desktop's microphone gave it.
pub enum Audio {
    /// Encoded as `mime` says.
    Recorded { bytes: Vec<u8>, mime: String },
    /// Mono samples at `rate` Hz.
    Mono { samples: Vec<f32>, rate: u32 },
}

/// The speech models, loaded on first use and kept (about 800 MB of memory each): the multilingual one with the path
/// of the voice detection model, and the French one once French is heard. Then how many times dictations were cancelled.
#[derive(Default)]
pub struct Dictation(tokio::sync::Mutex<Option<(Arc<WhisperContext>, PathBuf)>>, tokio::sync::Mutex<Option<Arc<WhisperContext>>>, Arc<AtomicU64>);

impl Dictation {
    /// Stops the transcriptions under way, from every device: a cancelled one would slow the next one down for seconds.
    pub fn cancel(&self) {
        self.2.fetch_add(1, Ordering::SeqCst);
    }

    /// `audio` as text, in the languages the settings allow, with `vocabulary` (the project's names) as the words to expect.
    /// The language most of it was in is kept as the spoken language, which AI can write in.
    /// `progress(done, total)` follows a speech model's first download.
    pub async fn transcribe(&self, dir: &Path, store: &Store, audio: Audio, vocabulary: String, progress: impl Fn(u64, u64) + Send + Sync) -> Result<String> {
        let samples = match audio {
            // Decoded first: a recording that can't be read fails before any download.
            Audio::Recorded { bytes, mime } => tokio::task::spawn_blocking(move || decode(bytes, &mime)).await.map_err(|e| Error::Other(e.to_string()))??,
            Audio::Mono { samples, rate } => resample(&samples, rate),
        };
        if samples.len() < RATE as usize / 4 {
            return Ok(String::new());
        }
        let (cancels, started) = (self.2.clone(), self.2.load(Ordering::SeqCst));
        let stop = move || cancels.load(Ordering::SeqCst) != started;
        let (ctx, vad) = self.model(dir, &progress).await?;
        let langs = store.read(|c| c.ui.dictation_languages.clone());
        let samples = Arc::new(samples);
        let heard = samples.clone();
        let quit = stop.clone();
        let (state, speech, parts) = tokio::task::spawn_blocking(move || listen(&ctx, &vad, &heard, &langs, &quit)).await.map_err(|e| Error::Other(e.to_string()))??;
        // Fetched the first time French is heard, so speakers of other languages never download it. Turbo writes French
        // too: a French model that can't be fetched now (offline) doesn't lose what was said.
        if stop() {
            return Err(cancelled());
        }
        let french = match parts.iter().any(|(l, _)| whisper_rs::get_lang_str(*l) == Some("fr")) {
            true => self.french(dir, &progress).await.inspect_err(|e| crate::log::error(format!("Could not get the French speech model: {e}"))).ok(),
            false => None,
        };
        let (text, lang) = tokio::task::spawn_blocking(move || write(state, french.as_deref(), &samples, &speech, &parts, &vocabulary, &stop)).await.map_err(|e| Error::Other(e.to_string()))??;
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

    async fn model(&self, dir: &Path, progress: impl Fn(u64, u64) + Send) -> Result<(Arc<WhisperContext>, PathBuf)> {
        // Held through the download: a second dictation waits for the same model.
        let mut slot = self.0.lock().await;
        if let Some(loaded) = slot.as_ref() {
            return Ok(loaded.clone());
        }
        let models = dir.join("models");
        let vad = models.join(VAD.file);
        if !vad.exists() {
            download(&vad, &VAD, |_, _| {}).await?;
        }
        let path = models.join(SPEECH.file);
        if !path.exists() {
            download(&path, &SPEECH, progress).await?;
            let _ = tokio::fs::remove_file(models.join(OLD_SPEECH)).await;
        }
        Ok(slot.insert((load(path).await?, vad)).clone())
    }

    async fn french(&self, dir: &Path, progress: impl Fn(u64, u64) + Send) -> Result<Arc<WhisperContext>> {
        let mut slot = self.1.lock().await;
        if let Some(loaded) = slot.as_ref() {
            return Ok(loaded.clone());
        }
        let path = dir.join("models").join(FRENCH.file);
        if !path.exists() {
            download(&path, &FRENCH, progress).await?;
        }
        Ok(slot.insert(load(path).await?).clone())
    }
}

/// The speech model at `path`, loaded.
async fn load(path: PathBuf) -> Result<Arc<WhisperContext>> {
    // Without it whisper.cpp writes its own log to stderr.
    whisper_rs::install_logging_hooks();
    let ctx = tokio::task::spawn_blocking(move || WhisperContext::new_with_params(&path, WhisperContextParameters::default()))
        .await
        .map_err(|e| Error::Other(e.to_string()))?
        .map_err(|e| Error::Other(format!("Could not load the speech model: {e}")))?;
    Ok(Arc::new(ctx))
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

/// The speech `vad` finds in `samples`, as ranges of them, and its parts, each stretch between pauses
/// told in its own language among `langs` (Whisper codes, "fr"; none: any), as language ids and ranges
/// of indexes into the speech; with `ctx`'s state, for `write`. Whisper alone picks one language
/// from the first 30 s, and drops or translates the rest.
/// Ends early, with an error, once `stop` says so.
fn listen(ctx: &WhisperContext, vad: &Path, samples: &[f32], langs: &[String], stop: &impl Fn() -> bool) -> Result<(WhisperState, Vec<Range<usize>>, Vec<(i32, Range<usize>)>)> {
    let fail = |e: whisper_rs::WhisperError| if stop() { cancelled() } else { Error::Other(format!("Speech recognition failed: {e}")) };
    let threads = threads();
    let speech = speech(vad, samples, threads)?;
    let mut state = ctx.create_state().map_err(fail)?;
    if speech.is_empty() {
        return Ok((state, speech, Vec::new()));
    }
    let mut allowed: Vec<i32> = (0..=whisper_rs::get_lang_max_id()).filter(|&i| langs.iter().any(|l| whisper_rs::get_lang_str(i) == Some(l.as_str()))).collect();
    if allowed.is_empty() {
        allowed = (0..=whisper_rs::get_lang_max_id()).collect();
    }
    let stretches: Vec<(Range<usize>, Vec<f32>)> = stretches(&speech).into_iter().map(|r| (r.clone(), joined(samples, &speech[r]))).collect();
    let longest = stretches.iter().map(|(_, a)| a.as_slice()).max_by_key(|a| a.len()).unwrap_or_default();
    if allowed.len() > 1 && audio_ctx(longest.len()) > 0 {
        // lang_detect encodes as much audio as the last `full` was told to, not the 30 s it would for
        // each stretch: a one-token pass over the longest sets that up.
        let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        p.set_audio_ctx(audio_ctx(longest.len()));
        p.set_single_segment(true);
        p.set_max_tokens(1);
        p.set_n_threads(threads as i32);
        abort_when(&mut p, stop);
        state.full(p, longest).map_err(fail)?;
    }
    // Neighbors in the same language go as one part: Whisper writes better with more context.
    let mut parts: Vec<(i32, Range<usize>)> = Vec::new();
    for (r, audio) in stretches {
        if stop() {
            return Err(cancelled());
        }
        let lang = match allowed[..] {
            [one] => one,
            _ => {
                state.pcm_to_mel(&audio, threads).map_err(fail)?;
                pick(&state.lang_detect(0, threads).map_err(fail)?.1, &allowed)
            }
        };
        match parts.last_mut() {
            Some((l, last)) if *l == lang => last.end = r.end,
            _ => parts.push((lang, r)),
        }
    }
    Ok((state, speech, parts))
}

/// The `parts` of the `speech` as text, and the language most of it was in. French is written by
/// `french` when given, the rest by `state`'s model, with `vocabulary` priming Whisper with the words to expect.
fn write(mut state: WhisperState, french: Option<&WhisperContext>, samples: &[f32], speech: &[Range<usize>], parts: &[(i32, Range<usize>)], vocabulary: &str, stop: &impl Fn() -> bool) -> Result<(String, Option<&'static str>)> {
    let fail = |e: whisper_rs::WhisperError| if stop() { cancelled() } else { Error::Other(format!("Speech recognition failed: {e}")) };
    let threads = threads();
    let mut fr_state = french.map(WhisperContext::create_state).transpose().map_err(fail)?;
    let mut said = Vec::new();
    for (lang, r) in parts {
        let state = match fr_state.as_mut() {
            Some(fr) if whisper_rs::get_lang_str(*lang) == Some("fr") => fr,
            _ => &mut state,
        };
        let audio = joined(samples, &speech[r.clone()]);
        // Best of 5 only when Whisper, unsure, tries again warmer: as quick as before on clear speech.
        let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 5 });
        p.set_audio_ctx(audio_ctx(audio.len()));
        p.set_language(whisper_rs::get_lang_str(*lang));
        if !vocabulary.is_empty() {
            p.set_initial_prompt(vocabulary);
        }
        p.set_n_threads(threads as i32);
        p.set_print_progress(false);
        p.set_print_realtime(false);
        p.set_print_special(false);
        p.set_print_timestamps(false);
        p.set_suppress_nst(true);
        abort_when(&mut p, stop);
        state.full(p, &audio).map_err(fail)?;
        said.extend(state.as_iter().map(|s| s.to_string()));
    }
    let text = clean(said.into_iter());
    let spoken = |l: i32| parts.iter().filter(|(x, _)| *x == l).flat_map(|(_, r)| &speech[r.clone()]).map(|r| r.len()).sum::<usize>();
    let main = parts.iter().map(|(l, _)| *l).max_by_key(|&l| spoken(l)).filter(|_| !text.is_empty());
    Ok((text, main.and_then(whisper_rs::get_lang_str)))
}

/// The threads Whisper runs on.
/// Has whisper.cpp end `p`'s run, with an error, once `stop` says so. `p` must not outlive `stop`.
// whisper-rs 0.16's set_abort_callback_safe calls its closure through the wrong type, which aborts every run.
fn abort_when<F: Fn() -> bool>(p: &mut FullParams, stop: &F) {
    unsafe extern "C" fn call<F: Fn() -> bool>(stop: *mut std::ffi::c_void) -> bool {
        // SAFETY: the `&F` given below, alive for as long as `p`.
        unsafe { (*(stop as *const F))() }
    }
    // SAFETY: `call::<F>` reads the pointer as the `F` it is.
    unsafe {
        p.set_abort_callback(Some(call::<F>));
        p.set_abort_callback_user_data(stop as *const F as *mut std::ffi::c_void);
    }
}

fn cancelled() -> Error {
    Error::Other("Dictation cancelled".into())
}

fn threads() -> usize {
    std::thread::available_parallelism().map_or(4, |n| n.get().min(16))
}

/// How much Whisper encodes for `n` samples, in its 20 ms steps: it encodes 30 s whatever the length
/// unless told less, and its time follows. A second more keeps the last words.
fn audio_ctx(n: usize) -> i32 {
    const FULL: usize = 1500;
    if n >= 30 * RATE as usize {
        return 0;
    }
    (n * FULL / (30 * RATE as usize) + 50).min(FULL) as i32
}

/// The likeliest of the `allowed` language ids, by Whisper's `probs`.
fn pick(probs: &[f32], allowed: &[i32]) -> i32 {
    allowed.iter().copied().max_by(|&a, &b| probs[a as usize].total_cmp(&probs[b as usize])).unwrap_or(0)
}

/// Where `samples` hold speech, as ranges of them, by the Silero model at `vad`.
fn speech(vad: &Path, samples: &[f32], threads: usize) -> Result<Vec<Range<usize>>> {
    let fail = |e: whisper_rs::WhisperError| Error::Other(format!("Voice detection failed: {e}"));
    let path = vad.to_str().ok_or_else(|| Error::Other(format!("Can't read the voice detection model at {}", vad.display())))?;
    let mut params = WhisperVadContextParams::new();
    params.set_n_threads(threads as i32);
    let mut ctx = WhisperVadContext::new(path, params).map_err(fail)?;
    // In hundredths of a second.
    let at = |cs: f32| ((cs * RATE as f32 / 100.0) as usize).min(samples.len());
    Ok(ctx.segments_from_samples(WhisperVadParams::new(), samples).map_err(fail)?.map(|s| at(s.start)..at(s.end)).filter(|r| !r.is_empty()).collect())
}

/// The `speech` ranges in stretches cut at pauses of half a second or more, as ranges of
/// indexes into `speech`. A stretch with less than 2 s of speech joins its neighbor.
fn stretches(speech: &[Range<usize>]) -> Vec<Range<usize>> {
    let said = |s: &Range<usize>| speech[s.clone()].iter().map(|r| r.len()).sum::<usize>();
    let mut out: Vec<Range<usize>> = Vec::new();
    for (i, r) in speech.iter().enumerate() {
        match out.last_mut() {
            Some(last) if r.start - speech[i - 1].end < PAUSE || said(last) < MIN_STRETCH => last.end = i + 1,
            _ => out.push(i..i + 1),
        }
    }
    if out.len() > 1 && said(&out[out.len() - 1]) < MIN_STRETCH {
        let short = out.pop().unwrap();
        out.last_mut().unwrap().end = short.end;
    }
    out
}

/// The `speech` ranges of `samples` end to end, each pause between them kept up to half a second, in silence.
fn joined(samples: &[f32], speech: &[Range<usize>]) -> Vec<f32> {
    let mut out = Vec::new();
    for (i, r) in speech.iter().enumerate() {
        if i > 0 {
            out.resize(out.len() + (r.start - speech[i - 1].end).min(PAUSE), 0.0);
        }
        out.extend_from_slice(&samples[r.clone()]);
    }
    out
}

/// The segments as one line, without the tags Whisper writes for silence or noise ("[BLANK_AUDIO]", "(music)"),
/// nor a segment said again right after itself, as Whisper does when it loses its place.
fn clean(segments: impl Iterator<Item = String>) -> String {
    let tag = |s: &str| s.starts_with('[') && s.ends_with(']') || s.starts_with('(') && s.ends_with(')');
    let mut out: Vec<String> = Vec::new();
    for s in segments.map(|s| s.trim().to_string()) {
        if s.is_empty() || tag(&s) || out.last() == Some(&s) {
            continue;
        }
        out.push(s);
    }
    out.join(" ")
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
        assert_eq!(seg(&[" Ask what you can do.", " Ask what you can do.", " Then go."]), "Ask what you can do. Then go.");
    }

    /// Speech ranges from (start, end) times in seconds.
    fn at(times: &[(f32, f32)]) -> Vec<Range<usize>> {
        times.iter().map(|&(a, b)| (a * RATE as f32) as usize..(b * RATE as f32) as usize).collect()
    }

    #[test]
    fn stretches_cut_at_long_pauses_only() {
        // 3 s of speech, a 1 s pause, 3 s, a short breath, 3 s: one cut, at the long pause.
        assert_eq!(stretches(&at(&[(0.0, 3.0), (4.0, 7.0), (7.2, 10.2)])), vec![0..1, 1..3]);
        // Half a second before a pause is too short to tell a language: it joins what follows.
        assert_eq!(stretches(&at(&[(0.0, 0.5), (1.5, 4.5)])), vec![0..2]);
        // And a short last one joins what comes before.
        assert_eq!(stretches(&at(&[(0.0, 3.0), (4.0, 4.5)])), vec![0..2]);
        assert_eq!(stretches(&at(&[(0.0, 1.0)])), vec![0..1]);
        assert_eq!(stretches(&[]), Vec::<Range<usize>>::new());
    }

    #[test]
    fn joined_keeps_speech_and_shortens_pauses() {
        let samples: Vec<f32> = (0..10 * RATE).map(|i| i as f32).collect();
        // A 0.2 s breath is kept whole, a 5 s pause shrinks to half a second, the silence before and after goes.
        let out = joined(&samples, &at(&[(1.0, 2.0), (2.2, 3.0), (8.0, 9.0)]));
        assert_eq!(out.len(), 56_000); // 1 s + 0.2 + 0.8 + 0.5 + 1 s
        assert_eq!(out[0], 16_000.0);
        assert_eq!(out[16_000..19_200], [0.0; 3_200]);
        assert_eq!(out[19_200], 35_200.0);
        assert_eq!(*out.last().unwrap(), 143_999.0);
    }

    #[test]
    fn audio_ctx_follows_the_length() {
        assert_eq!(audio_ctx(15 * RATE as usize), 800);
        assert_eq!(audio_ctx(RATE as usize * 299 / 10), 1500);
        assert_eq!(audio_ctx(30 * RATE as usize), 0);
    }

    #[test]
    fn pick_keeps_to_the_allowed_languages() {
        let mut probs = vec![0.0; 100];
        (probs[0], probs[2], probs[6]) = (0.6, 0.1, 0.3); // en, de, fr
        assert_eq!(pick(&probs, &[0, 2, 6]), 0);
        assert_eq!(pick(&probs, &[2, 6]), 6);
    }

    /// `listen` then `write`, as `transcribe` does once the models are in.
    fn run(ctx: &WhisperContext, french: Option<&WhisperContext>, vad: &Path, samples: &[f32], langs: &[String]) -> (String, Option<&'static str>) {
        let (state, speech, parts) = listen(ctx, vad, samples, langs, &|| false).unwrap();
        write(state, french, samples, &speech, &parts, "", &|| false).unwrap()
    }

    /// Needs the models in ~/.config/gitnetix/models and 16 kHz mono f32 clips:
    /// `GNX_CLIPS=/tmp/gnx-voice cargo test --release -p gitnetix-core -- --ignored speech --nocapture`.
    #[test]
    #[ignore]
    fn speech_follows_the_spoken_language() {
        let models = PathBuf::from(std::env::var("HOME").unwrap() + "/.config/gitnetix/models");
        let load = |file: &str| WhisperContext::new_with_params(models.join(file).to_str().unwrap(), WhisperContextParameters::default()).unwrap();
        // GNX_MODEL=ggml-base.bin compares with another model, GNX_FRENCH=0 without the French one.
        let ctx = load(&std::env::var("GNX_MODEL").unwrap_or(SPEECH.file.into()));
        let french = (std::env::var("GNX_FRENCH").as_deref() != Ok("0")).then(|| load(FRENCH.file));
        let french = french.as_ref();
        let vad = models.join(VAD.file);
        let clip = |name: &str| {
            let raw = std::fs::read(format!("{}/{name}.f32", std::env::var("GNX_CLIPS").unwrap())).unwrap();
            raw.chunks(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect::<Vec<f32>>()
        };
        let fr_en = ["fr".to_string(), "en".to_string()];
        for (name, langs) in [("fr4", &fr_en[..]), ("fr12", &fr_en[..]), ("jfk", &fr_en[..]), ("mixed", &fr_en[..]), ("mixed", &[][..])] {
            let t = std::time::Instant::now();
            let (text, lang) = run(&ctx, french, &vad, &clip(name), langs);
            println!("{name} {langs:?} → {lang:?} in {:.1}s: {text}", t.elapsed().as_secs_f32());
        }
        assert_eq!(run(&ctx, french, &vad, &clip("fr4"), &fr_en).1, Some("fr"));
        assert_eq!(run(&ctx, french, &vad, &clip("jfk"), &fr_en).1, Some("en"));
        // Silence alone is no speech, not a made-up sentence.
        assert_eq!(run(&ctx, french, &vad, &[0.0; 3 * RATE as usize], &fr_en).0, "");
        let (mixed, _) = run(&ctx, french, &vad, &clip("mixed"), &fr_en);
        assert!(mixed.contains("polonium") && mixed.contains("ask not what your country"), "{mixed}");
        // A cancel stops Whisper mid-run.
        let jfk = clip("jfk");
        let (state, speech, parts) = listen(&ctx, &vad, &jfk, &fr_en, &|| false).unwrap();
        assert_eq!(write(state, french, &jfk, &speech, &parts, "", &|| true).unwrap_err().to_string(), "Dictation cancelled");
        if french.is_some() {
            // Turbo writes this one as "né à warsovie ... tiffus", without capitals.
            assert!(run(&ctx, french, &vad, &clip("fr12"), &fr_en).0.contains("Varsovie"));
        }
    }
}

