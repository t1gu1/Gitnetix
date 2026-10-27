import { type CSSProperties, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useConfig } from "../api/hooks";
import { isLocal, rpc } from "../api/transport";
import { base64 } from "../components/AgentLog";
import { Icon } from "../components/Icon";
import { animates } from "./motion";
import { useNav } from "./nav";
import { useStored } from "./stored";
import { toast } from "./toast";

// Voice dictation into any text box: the shortcut (or the mic on phones) records here,
// the desktop turns the recording into text with its local Whisper model, AI rewrites it with the project's context
// when that is on, and the text lands at the box's caret.

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

/** The desktop app records with its own microphone code (src-tauri/src/mic.rs): webview recorders depend on codecs each OS may lack.
 *  Insecure pages (a phone browser on the companion's plain-HTTP address) get no microphone. */
export const canDictate = isLocal || (typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia);
// Only what the desktop can decode (no Opus): PCM in WebM from Chromium-based browsers, AAC in mp4 from Safari and iOS.
// shortcut: Firefox records only Opus, so the companion page in Firefox can't dictate; decode Opus on the desktop if that matters.
const TYPE = canDictate && !isLocal ? ["audio/webm;codecs=pcm", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) : undefined;

const names = new Intl.DisplayNames([navigator.language], { type: "language" });
/** The languages Whisper hears, by name. It writes Javanese "jw". */
export const DICTATION_LANGS = "en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue"
  .split(" ")
  .map((value) => ({ value, label: names.of(value === "jw" ? "jv" : value) ?? value }))
  .sort((a, b) => a.label.localeCompare(b.label));

type Phase = "idle" | "listening" | "transcribing" | "polishing";
/** Where dictations are spoken (the open project and branch), for the names Whisper expects and AI's context. */
let at: { projectId?: string; branch?: string } = {};
let polishOn = true;
/** The speech model's first download, while it runs. */
let download: { done: number; total: number } | null = null;
interface Session {
  field: Field;
  ctx?: AudioContext;
  analyser?: AnalyserNode;
  stream?: MediaStream;
  rec?: MediaRecorder;
  chunks: Blob[];
  /** The desktop app's microphone: its start, and its loudness from 0 to 1. */
  mic?: Promise<unknown>;
  level: number;
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
  if (s.ctx && s.ctx.state !== "closed") s.ctx.close();
}

/** Start listening for `field`, stop and transcribe when already listening, or cancel while the words are written out. */
export async function toggleDictation(field: Field | null) {
  if (phase === "listening") return finish();
  if (phase !== "idle") return cancelDictation();
  if (!canDictate) return toast("The microphone needs the Gitnetix app, or this page over https", "error");
  if (!isLocal && !TYPE) return toast("This browser can't record in a format Gitnetix reads", "error");
  if (!field) return toast("Click in a text box first");
  if (isLocal) return listen(field);
  // Made inside the key press or tap: WebKit only lets audio start from one.
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  const s: Session = { field, ctx, analyser, chunks: [], level: 0 };
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

/** The desktop app's microphone, for `field`. */
function listen(field: Field) {
  const s: Session = { field, chunks: [], level: 0 };
  // Set at once: a stop pressed meanwhile waits for the start rather than leave the microphone on.
  s.mic = import("@tauri-apps/api/core").then(({ invoke, Channel }) => invoke("dictation_start", { onLevel: new Channel<number>((v) => (s.level = v)) }));
  session = s;
  set("listening");
  s.mic.catch((e) => {
    if (session !== s || phase !== "listening") return; // finish() reports it
    session = null;
    set("idle");
    toast(`No microphone: ${e}`, "error");
  });
}

async function finish() {
  const s = session;
  if (!s || phase !== "listening") return;
  const rec = s.rec;
  if (!rec && !s.mic) {
    // Still at the permission prompt: nothing recorded.
    session = null;
    release(s);
    return set("idle");
  }
  set("transcribing");
  // Each step checks `session` again: cancelDictation() clears it.
  try {
    const heard = (s.mic ? await stopMic(s.mic) : await transcribe(s, rec!)).trim();
    if (session !== s) return;
    const text = heard && polishOn ? await polish(s.field, heard) : heard;
    if (session === s) put(s.field, text);
  } catch (e) {
    if (session === s) toast(e instanceof Error ? e.message : String(e), "error");
  } finally {
    if (session === s) {
      session = null;
      download = null;
      set("idle");
    }
  }
}

// shortcut: a cancelled AI rewrite still runs to its end (30 s at most), its words dropped; stop the AI call too if that costs.
/** Stop listening without writing anything, or stop writing the words out. */
export function cancelDictation() {
  const s = session;
  if (!s) return;
  session = null;
  download = null;
  if (phase === "listening") {
    if (s.rec?.state === "recording") s.rec.stop();
    release(s);
    s.mic?.then(() => import("@tauri-apps/api/core").then(({ invoke }) => invoke("dictation_cancel"))).catch(() => {});
  } else if (phase === "transcribing") rpc("dictation.cancel").catch(() => {});
  set("idle");
}

async function stopMic(started: Promise<unknown>) {
  await started;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("dictation_stop", at);
}

/** What `el` is, for AI: "one-line field “Branch name”". */
function describe(el: Field) {
  const name = el.getAttribute("aria-label") || el.placeholder;
  return `${el.tagName === "INPUT" ? "one-line field" : "multi-line text box"}${name ? ` “${name}”` : ""}`;
}

/** `text` rewritten by AI for `el`, after what it already holds; the words as heard when AI fails. */
async function polish(el: Field, text: string) {
  set("polishing");
  try {
    const typed = el.value.slice(0, el.selectionStart ?? el.value.length).slice(-2000);
    const r = await rpc<{ text: string }>("dictation.polish", { ...at, text, field: describe(el), typed });
    return r.text.trim() || text;
  } catch (e) {
    toast(`AI couldn't rewrite it, so the words went in as heard: ${e instanceof Error ? e.message : e}`, "error");
    return text;
  }
}

/** The page's recording, stopped, as text. */
async function transcribe(s: Session, rec: MediaRecorder) {
  const blob = await new Promise<Blob>((ok) => {
    const done = () => ok(new Blob(s.chunks, { type: rec.mimeType }));
    // Already stopped by itself when the microphone went away.
    if (rec.state === "inactive") return done();
    rec.onstop = done;
    rec.stop();
  });
  release(s);
  const { text } = await rpc<{ text: string }>("dictation.transcribe", { audio: await base64(blob), mime: blob.type, ...at });
  return text;
}

/** Progress of the speech model's first download, from the engine's events. */
export function dictationModel(done: number, total: number) {
  download = { done, total };
  set(phase);
}

function put(el: Field, text: string) {
  if (!text) return toast("No speech heard");
  if (el.tagName === "INPUT") text = text.replace(/\s*\n\s*/g, " ");
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
  const nav = useNav();
  const polish = useConfig().data?.ui.dictationPolish;
  useEffect(() => {
    at = { projectId: nav.projectId, branch: nav.selectedBranch };
    polishOn = polish ?? true;
  }, [nav.projectId, nav.selectedBranch, polish]);
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
      {p !== "idle" && <Wave listening={p === "listening"} polishing={p === "polishing"} keys={keys} />}
      {canDictate && <FieldMic phase={p} keys={coarse ? "" : showKeys(keys)} />}
    </>
  );
}

/** Touch screens, with no keyboard for the shortcut. */
const coarse = matchMedia("(pointer: coarse)").matches;

/** The mic inside the right edge of the text box being typed in, with the shortcut beside it where there's a keyboard. */
function FieldMic({ phase, keys }: { phase: Phase; keys: string }) {
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
    // What scrolls the box (a dialog's body, say) hides part of it: the mic stays in the part in view, not over the dialog's footer.
    const clips: HTMLElement[] = [];
    for (let el = field.parentElement; el; el = el.parentElement) if (getComputedStyle(el).overflowY !== "visible") clips.push(el);
    let raf = 0;
    const place = () => {
      const r = field.getBoundingClientRect();
      const b = mic.current!;
      let [lo, hi] = [-Infinity, Infinity];
      for (const c of clips) {
        const top = c.getBoundingClientRect().top + c.clientTop;
        lo = Math.max(lo, top);
        hi = Math.min(hi, top + c.clientHeight);
      }
      // Centered in a one-line box, in the bottom corner of a multi-line one (or of its part in view), with the bottom of its resize grip left to grab.
      const top = field.tagName === "TEXTAREA" ? Math.max(r.top, Math.min(r.bottom, hi) - b.offsetHeight - 8) : r.top + (r.height - b.offsetHeight) / 2;
      b.style.transform = `translate(${r.right - b.offsetWidth - 4}px, ${top}px)`;
      // Cut where the box is cut, clicks included.
      b.style.clipPath = `inset(${Math.max(0, lo - top)}px 0 ${Math.max(0, top + b.offsetHeight - hi)}px)`;
      raf = requestAnimationFrame(place);
    };
    place();
    field.dataset.mic = ""; // room for it on the right, in the stylesheet
    field.style.setProperty("--mic-w", `${mic.current!.offsetWidth}px`);
    return () => {
      cancelAnimationFrame(raf);
      delete field.dataset.mic;
      field.style.removeProperty("--mic-w");
    };
  }, [field]);
  return (
    field && (
      <button
        ref={mic}
        className="field-mic"
        data-on={phase === "listening" || undefined}
        aria-label={`${phase === "idle" ? "Dictate" : phase === "listening" ? "Stop dictating" : "Cancel dictation"} ${keys}`.trim()}
        // Keeps the box focused, and the keyboard up.
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => toggleDictation(field)}
      >
        <Icon name="mic" size={15} stroke={1.7} />
        {keys && <span>{keys}</span>}
      </button>
    )
  );
}

function Wave({ listening, polishing, keys }: { listening: boolean; polishing: boolean; keys: string }) {
  const wave = useRef<HTMLDivElement>(null);
  const got = useSyncExternalStore(subscribe, () => download);
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!listening) return;
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [listening]);
  useEffect(() => {
    const s = session;
    if (!listening || !s || !animates("wave")) return;
    const a = s.analyser;
    const data = new Uint8Array(a?.frequencyBinCount ?? 0);
    // Bars follow the voice: the middle ones the low frequencies, the outer ones the higher.
    // The desktop app's microphone gives only its loudness: the middle bars rise the most.
    const bar = a ? (i: number) => Math.max(0, data[1 + fromMiddle(i)] - 60) / 195 : (i: number) => s.level * (1 - fromMiddle(i) / BARS);
    let raf = 0;
    const draw = () => {
      const live = !a || a.context.state === "running";
      wave.current?.toggleAttribute("data-idle", !live);
      if (live) {
        a?.getByteFrequencyData(data);
        wave.current?.querySelectorAll("span").forEach((b, i) => (b.style.height = `${16 + 84 * bar(i)}%`));
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
          {listening
            ? "Listening"
            : polishing
              ? "Rewriting with AI…"
              : got && got.done < got.total
                ? `Downloading the speech model · ${Math.floor((got.done / got.total) * 100)}%`
                : "Transcribing…"}
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
        <span className="hint dictation-keys grow">{`${showKeys(keys)} again to ${listening ? "finish" : "cancel"}`}</span>
        <button className="btn btn-sm" onPointerDown={(e) => e.preventDefault()} onClick={cancelDictation}>
          Cancel
        </button>
        {/* No focus change on press: the text goes back into the box being typed in. */}
        <button className="btn btn-primary btn-sm" disabled={!listening} onPointerDown={(e) => e.preventDefault()} onClick={finish}>
          <Icon name="stop" size={11} stroke={2} />
          Stop
        </button>
      </div>
    </div>
  );
}
