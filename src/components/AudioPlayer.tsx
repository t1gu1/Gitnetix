import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { useAgentFile } from "../api/hooks";
import { Icon } from "./Icon";

const MIME: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
};

const ext = (path: string) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();

export const isAudio = (path?: string) => !!path && ext(path) in MIME;

/** Bars in a wave, whatever the player's width. */
const BARS = 96;

/** The loudest sample of each of `n` equal slices of `channels`, scaled so the loudest slice is 1. */
export function peaks(channels: Float32Array[], n = BARS) {
  const len = channels[0]?.length ?? 0;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let max = 0;
    for (const c of channels) {
      for (let j = Math.floor((i * len) / n), end = Math.floor(((i + 1) * len) / n); j < end; j++) {
        const v = c[j] < 0 ? -c[j] : c[j];
        if (v > max) max = v;
      }
    }
    out.push(max);
  }
  const top = Math.max(...out) || 1;
  return out.map((v) => v / top);
}

/** "1:05", or "0.7" in a clip under 10 s, where whole seconds would say little. */
const time = (s: number, dur: number) => {
  if (dur < 10) return s.toFixed(1);
  const t = Math.floor(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

/** Audio file `path` agent `session` was sent or shares: play/pause, its wave with the played part lit, and a click or drag
 * on the wave (or the arrow keys, Home and End once focused) to move in it. */
export function AudioPlayer({ session, path }: { session: string; path: string }) {
  const name = path.split(/[\\/]/).pop() ?? path;
  // Asked first: WebKitGTK without GStreamer plugins (the AppImage bundles none) crashes its web process on an <audio>,
  // and never finishes decoding; canPlayType answers "" there without harm.
  const playable = useMemo(() => document.createElement("audio").canPlayType(MIME[ext(path)]) !== "", [path]);
  const file = useAgentFile(session, path, playable);
  const [url, setUrl] = useState<string>();
  // undefined while decoding, null when the file could not be decoded (the bars stay flat).
  const [wave, setWave] = useState<{ bars: number[]; duration: number } | null>();
  const [meta, setMeta] = useState(0);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const box = useRef<HTMLSpanElement>(null);
  const drag = useRef(false);
  const dur = meta || wave?.duration || 0;
  const cant = failed || !playable;

  useEffect(() => {
    if (!file.data) return;
    const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
    // The Blob copies the bytes, so decoding may take (detach) the buffer.
    const u = URL.createObjectURL(new Blob([bytes], { type: MIME[ext(path)] }));
    setUrl(u);
    let live = true;
    // 8 kHz: enough for a wave, and far less to resample and scan than the file's own rate.
    Promise.resolve()
      .then(() => new OfflineAudioContext(1, 1, 8000).decodeAudioData(bytes.buffer))
      .then(
        (b) => live && setWave({ bars: peaks(Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i))), duration: b.duration }),
        () => live && setWave(null),
      );
    return () => {
      live = false;
      URL.revokeObjectURL(u);
    };
  }, [file.data, path]);

  // Where the played part ends, as a CSS variable: written each frame while playing, without redrawing the player.
  const show = (s: number) => box.current?.style.setProperty("--p", String(dur ? Math.min(1, s / dur) : 0));
  useEffect(() => show(audio.current?.currentTime ?? 0), [dur]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!playing) return;
    let id = 0;
    const tick = () => {
      if (!drag.current && audio.current) show(audio.current.currentTime);
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing, dur]); // eslint-disable-line react-hooks/exhaustive-deps

  const d = useMemo(
    () => (wave?.bars ?? Array<number>(BARS).fill(0)).map((h, i) => {
      // Silence still shows as a thin line.
      const y = Math.max(0.04, h) * 48;
      return `M${i + 0.15} ${50 - y}h0.7v${2 * y}h-0.7z`;
    }).join(""),
    [wave],
  );
  const bars = (
    <svg viewBox={`0 0 ${BARS} 100`} preserveAspectRatio="none" aria-hidden>
      <path d={d} />
    </svg>
  );

  const seek = (s: number) => {
    if (audio.current) audio.current.currentTime = s;
    setT(s);
    show(s);
  };
  const at = (e: PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur;
  };
  // Dragging moves the playhead only; the audio jumps there once released, not at each pixel.
  const follow = (e: PointerEvent<HTMLElement>) => {
    const s = at(e);
    setT(s);
    show(s);
  };
  const key = (e: KeyboardEvent) => {
    const now = audio.current?.currentTime ?? 0;
    // A tenth of a short clip, 5 s in a long one.
    const step = Math.min(5, dur / 10);
    const to = ({ ArrowLeft: now - step, ArrowDown: now - step, ArrowRight: now + step, ArrowUp: now + step, Home: 0, End: dur } as Record<string, number | undefined>)[e.key];
    if (to === undefined || !dur) return;
    e.preventDefault();
    seek(Math.max(0, Math.min(dur, to)));
  };
  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    // A file it cannot play fires `error`, which shows why; a pause during the start rejects harmlessly.
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  };

  if (file.isError) return <span className="ag-audio faint">Could not load {name}</span>;
  return (
    <span className="ag-audio" role="group" aria-label={name}>
      <button type="button" className="ag-audio-play" aria-label={playing ? `Pause ${name}` : `Play ${name}`} disabled={!url || cant} onClick={toggle}>
        {url || cant ? <Icon name={playing ? "pause" : "play"} size={14} /> : <span className="spinner" />}
      </button>
      <span className="ag-audio-body">
        <span className="ag-audio-head">
          <span className="ellipsis">{name}</span>
          <span className="ag-audio-time">{cant ? "Can't play this file" : `${time(t, dur)} / ${time(dur, dur)}${dur < 10 ? " s" : ""}`}</span>
        </span>
        <span
          ref={box}
          className="ag-audio-wave"
          role="slider"
          tabIndex={dur ? 0 : -1}
          aria-label={`Position in ${name}`}
          aria-valuemin={0}
          aria-valuemax={Math.round(dur)}
          aria-valuenow={Math.round(t)}
          aria-valuetext={`${time(t, dur)} of ${time(dur, dur)}${dur < 10 ? " seconds" : ""}`}
          onKeyDown={key}
          onPointerDown={(e) => {
            if (!dur || e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = true;
            follow(e);
          }}
          onPointerMove={(e) => drag.current && follow(e)}
          onPointerUp={(e) => {
            if (!drag.current) return;
            drag.current = false;
            seek(at(e));
          }}
          onPointerCancel={() => {
            drag.current = false;
            seek(audio.current?.currentTime ?? 0);
          }}
        >
          {bars}
          <span className="ag-audio-played">{bars}</span>
          {!cant && <span className="ag-audio-line" />}
        </span>
      </span>
      {url && (
        <audio
          ref={audio}
          src={url}
          // Loaded only on the first play: the AppImage's GStreamer 1.20 on PipeWire holds that play back for as long as the
          // file sat loaded before it. The wave gives the length meanwhile. ("metadata" left Chromium stuck after a seek.)
          preload="none"
          onLoadedMetadata={(e) => setMeta(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)}
          onTimeUpdate={(e) => {
            if (drag.current) return;
            setT(e.currentTarget.currentTime);
            show(e.currentTarget.currentTime);
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onError={() => {
            setPlaying(false);
            setFailed(true);
          }}
        />
      )}
    </span>
  );
}
