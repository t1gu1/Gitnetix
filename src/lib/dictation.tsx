import { type CSSProperties, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { rpc } from "../api/transport";
import { base64 } from "../components/AgentLog";
import { Icon } from "../components/Icon";
import { animates } from "./motion";
import { useStored } from "./stored";
import { toast } from "./toast";

// Voice dictation into any text box: the shortcut (or the mic on phones) records here,
// the desktop turns the recording into text with its local Whisper model, and the text lands at the box's caret.

const MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);
const MODS = ["Ctrl", "Alt", "Shift", "Meta"] as const;
/** Modifiers always in this order, so a saved shortcut and a key press compare as strings. */
const combo = (on: boolean[], code: string) => [...MODS.filter((_, i) => on[i]), code].join("+");

export const DEFAULT_KEYS = combo([!MAC, false, false, MAC], "KeyD");
/** Empty when never changed or reset, so each computer keeps its own default (⌘ on macOS, Ctrl elsewhere). */
export const useDictationKeys = () => useStored("gnx.dictation.keys", DEFAULT_KEYS, (s) => s || DEFAULT_KEYS, String);

/** The pressed keys as a shortcut ("Ctrl+Shift+KeyM"), or null when they can't be one: it needs Ctrl, Alt or ⌘ plus a key that isn't a modifier. */
export function comboOf(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.altKey || e.metaKey) || !e.code || /^(Control|Alt|Shift|Meta|OS)/.test(e.code)) return null;
  return combo([e.ctrlKey, e.altKey, e.shiftKey, e.metaKey], e.code);
}

// shortcut: keys are physical positions (e.code), so on AZERTY and other layouts the letter shown is the QWERTY one; map through navigator.keyboard.getLayoutMap() if that bothers anyone.
/** How a shortcut reads on this computer: ⌘D on macOS, Ctrl+D elsewhere. */
export function showKeys(keys: string) {
  const parts = keys.split("+");
  const key = parts.pop()!.replace(/^(Key|Digit)/, "");
  if (MAC) return parts.map((m) => ({ Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" })[m]).join("") + key;
  return [...parts.map((m) => (m === "Meta" ? "Super" : m)), key].join("+");
}

type Field = HTMLInputElement | HTMLTextAreaElement;
// The terminal's hidden textarea is left out: what it gets goes to the shell, not into a box.
const FIELD = "textarea:not(.xterm-helper-textarea), input:is(:not([type]), [type=text], [type=search], [type=url], [type=email])";
const asField = (el: Element | null) => (el?.matches(FIELD) && !(el as Field).readOnly && !(el as Field).disabled ? (el as Field) : null);

/** Insecure pages (a phone browser on the companion's plain-HTTP address) get no microphone. */
export const canDictate = typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
// Only what the desktop can decode (no Opus): PCM in WebM from Chromium-based views, Vorbis from WebKitGTK
// (its base GStreamer plugins; mp4 there needs gst-plugins-good), AAC in mp4 from Safari and iOS.
// shortcut: Firefox records only Opus, so the companion page in Firefox can't dictate; decode Opus on the desktop if that matters.
const TYPE = canDictate ? ["audio/webm;codecs=pcm", "audio/ogg;codecs=vorbis", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) : undefined;

type Phase = "idle" | "listening" | "transcribing";
/** The speech model's first download, while it runs. */
let download: { done: number; total: number } | null = null;
interface Session {
  field: Field;
  ctx: AudioContext;
  analyser: AnalyserNode;
  stream?: MediaStream;
  rec?: MediaRecorder;
  chunks: Blob[];
}

let phase: Phase = "idle";
let session: Session | null = null;
const listeners = new Set<() => void>();
const set = (p: Phase) => {
  phase = p;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function release(s: Session) {
  s.stream?.getTracks().forEach((t) => t.stop());
  if (s.ctx.state !== "closed") s.ctx.close();
}

/** Start listening for `field`, or stop and transcribe when already listening. */
export async function toggleDictation(field: Field | null) {
  if (phase === "listening") return finish();
  if (phase !== "idle") return;
  if (!canDictate) return toast("The microphone needs the Gitnetix app, or this page over https", "error");
  if (!TYPE) return toast("This browser can't record in a format Gitnetix reads", "error");
  if (!field) return toast("Click in a text box first");
  // Made inside the key press or tap: WebKit only lets audio start from one.
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  const s: Session = { field, ctx, analyser, chunks: [] };
  session = s;
  set("listening");
  try {
    // Mono: half the upload for the same words.
    s.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    if (session !== s) return release(s); // stopped while the permission prompt was up
    ctx.createMediaStreamSource(s.stream).connect(analyser);
    s.rec = new MediaRecorder(s.stream, { mimeType: TYPE });
    s.rec.ondataavailable = (e) => s.chunks.push(e.data);
    s.rec.start();
    // No audio output (WebKitGTK without gst-plugins-good) keeps it suspended: the wave then swells on its own.
    ctx.resume().catch(() => {});
  } catch (e) {
    release(s);
    if (session !== s) return;
    session = null;
    set("idle");
    toast(`No microphone: ${e instanceof Error ? e.message : e}`, "error");
  }
}

async function finish() {
  const s = session;
  if (!s || phase !== "listening") return;
  const rec = s.rec;
  if (!rec) {
    // Still at the permission prompt: nothing recorded.
    session = null;
    release(s);
    return set("idle");
  }
  set("transcribing");
  const blob = await new Promise<Blob>((ok) => {
    const done = () => ok(new Blob(s.chunks, { type: rec.mimeType }));
    // Already stopped by itself when the microphone went away.
    if (rec.state === "inactive") return done();
    rec.onstop = done;
    rec.stop();
  });
  release(s);
  try {
    const { text } = await rpc<{ text: string }>("dictation.transcribe", { audio: await base64(blob), mime: blob.type });
    put(s.field, text.trim());
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), "error");
  } finally {
    session = null;
    download = null;
    set("idle");
  }
}

/** Progress of the speech model's first download, from the engine's events. */
export function dictationModel(done: number, total: number) {
  download = { done, total };
  set(phase);
}

function put(el: Field, text: string) {
  if (!text) return toast("No speech heard");
  // The box closed meanwhile (its dialog, say): keep the words rather than drop them.
  if (!el.isConnected) return void navigator.clipboard.writeText(text).then(() => toast("The text box closed, so the text was copied", "ok"), () => toast(text, "info", 15000));
  el.focus();
  const at = el.selectionStart ?? el.value.length;
  const glue = at > 0 && !/\s$/.test(el.value.slice(0, at)) ? " " : "";
  // execCommand keeps the box's undo and React's onChange; setRangeText where a browser dropped it.
  if (!document.execCommand("insertText", false, glue + text)) {
    el.setRangeText(glue + text, at, el.selectionEnd ?? at, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

const BARS = 32;
/** How far a bar is from the middle of the wave: 0 for the two middle ones. */
const fromMiddle = (i: number) => Math.floor(Math.abs(i - (BARS - 1) / 2));

/** The shortcut, anywhere in the app, and the centered card with the live wave while dictating. */
export function Dictation() {
  const p = useSyncExternalStore(subscribe, () => phase);
  const [keys] = useDictationKeys();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Left alone in the terminal, where Ctrl+D ends input, and in the shortcut picker.
      if (comboOf(e) !== keys || (e.target as Element).closest?.(".xterm, [data-keys-input]")) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) toggleDictation(asField(document.activeElement));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [keys]);
  return (
    <>
      {p !== "idle" && <Wave listening={p === "listening"} keys={keys} />}
      {coarse && canDictate && <FieldMic listening={p === "listening"} />}
    </>
  );
}

/** Touch screens, with no keyboard for the shortcut. */
const coarse = matchMedia("(pointer: coarse)").matches;

/** The mic inside the right edge of the text box being typed in, on touch screens. */
function FieldMic({ listening }: { listening: boolean }) {
  const [field, setField] = useState<Field | null>(null);
  const mic = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Read once focus has settled: a webview that blurs the box when the mic is touched must not remove the mic before its click.
    const sync = () => setTimeout(() => setField(asField(document.activeElement)));
    document.addEventListener("focusin", sync);
    document.addEventListener("focusout", sync);
    return () => {
      document.removeEventListener("focusin", sync);
      document.removeEventListener("focusout", sync);
    };
  }, []);
  // shortcut: reads the box's place every frame while it is focused, which follows scrolling, the keyboard and animations alike; use scroll and visualViewport listeners if battery matters.
  useEffect(() => {
    if (!field) return;
    let raf = 0;
    const place = () => {
      const r = field.getBoundingClientRect();
      // Centered in a one-line box, in the bottom corner of a multi-line one.
      const top = field.tagName === "TEXTAREA" ? r.bottom - 32 : r.top + (r.height - 28) / 2;
      if (mic.current) mic.current.style.transform = `translate(${r.right - 32}px, ${top}px)`;
      raf = requestAnimationFrame(place);
    };
    place();
    field.dataset.mic = ""; // room for it on the right, in the stylesheet
    return () => {
      cancelAnimationFrame(raf);
      delete field.dataset.mic;
    };
  }, [field]);
  return (
    field && (
      <button
        ref={mic}
        className="field-mic"
        data-on={listening || undefined}
        aria-label={listening ? "Stop dictating" : "Dictate"}
        // Keeps the box focused, and the keyboard up.
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => toggleDictation(field)}
      >
        <Icon name="mic" size={15} stroke={1.7} />
      </button>
    )
  );
}

function Wave({ listening, keys }: { listening: boolean; keys: string }) {
  const wave = useRef<HTMLDivElement>(null);
  const got = useSyncExternalStore(subscribe, () => download);
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!listening) return;
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [listening]);
  // Bars follow the voice: the middle ones the low frequencies, the outer ones the higher.
  useEffect(() => {
    const a = session?.analyser;
    if (!listening || !a || !animates("wave")) return;
    const data = new Uint8Array(a.frequencyBinCount);
    let raf = 0;
    const draw = () => {
      const live = a.context.state === "running";
      wave.current?.toggleAttribute("data-idle", !live);
      if (live) {
        a.getByteFrequencyData(data);
        wave.current?.querySelectorAll("span").forEach((b, i) => {
          const v = Math.max(0, data[1 + fromMiddle(i)] - 60) / 195;
          b.style.height = `${16 + 84 * v}%`;
        });
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [listening]);
  return (
    <div className="dictation" role="status" aria-live="polite">
      <div className="dictation-head">
        <span className="dictation-mic" data-on={listening || undefined}>
          <Icon name="mic" size={14} stroke={1.7} />
        </span>
        <span className="grow">
          {listening ? "Listening" : got && got.done < got.total ? `Downloading the speech model · ${Math.floor((got.done / got.total) * 100)}%` : "Transcribing…"}
        </span>
        {listening && (
          <span className="mono faint" aria-hidden>
            {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
          </span>
        )}
      </div>
      <div ref={wave} className="dictation-wave" data-busy={!listening || undefined} aria-hidden>
        {Array.from({ length: BARS }, (_, i) => (
          <span key={i} style={{ "--d": fromMiddle(i) } as CSSProperties} />
        ))}
      </div>
      <div className="dictation-foot">
        <span className="hint dictation-keys">{listening && `${showKeys(keys)} again to finish`}</span>
        {/* No focus change on press: the text goes back into the box being typed in. */}
        <button className="btn btn-primary btn-sm" disabled={!listening} onPointerDown={(e) => e.preventDefault()} onClick={finish}>
          <Icon name="stop" size={11} stroke={2} />
          Stop
        </button>
      </div>
    </div>
  );
}
