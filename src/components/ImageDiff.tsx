import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";

import type { Blobs } from "../api/types";
import { useStored } from "../lib/stored";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

const ext = (path: string) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();

export const isImage = (path?: string) => !!path && ext(path) in MIME;

export type ImageMode = "side" | "swipe" | "onion" | "difference";

export const IMAGE_MODES: { value: ImageMode; label: string }[] = [
  { value: "side", label: "Side by side" },
  { value: "swipe", label: "Swipe" },
  { value: "onion", label: "Onion skin" },
  { value: "difference", label: "Difference" },
];

/** Remembered comparison mode, shared by the diff header's switch and the preview. */
export const useImageMode = () =>
  useStored<ImageMode>("gnx.diff.imageMode", "side", (s) => (IMAGE_MODES.some((m) => m.value === s) ? (s as ImageMode) : "side"), String);

/** Both sides present and different, so there is something to compare. */
export const comparable = (blobs?: Blobs) => !!blobs?.old && !!blobs.new && blobs.old !== blobs.new;

interface Loaded {
  src: string;
  bytes: number;
  w: number;
  h: number;
}

/** Decodes one side of the blobs and measures it; undefined while loading, null when absent or unreadable. */
function useImage(path: string, b64?: string | null) {
  const [img, setImg] = useState<Loaded | null | undefined>(undefined);
  useEffect(() => {
    if (!b64) return setImg(null);
    setImg(undefined);
    const src = `data:${MIME[ext(path)]};base64,${b64}`;
    const el = new Image();
    el.onload = () => setImg({ src, bytes: Math.floor((b64.length * 3) / 4), w: el.naturalWidth, h: el.naturalHeight });
    el.onerror = () => setImg(null);
    el.src = src;
  }, [path, b64]);
  return img;
}

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);

function Meta({ img, label, cls }: { img: Loaded; label: string; cls: string }) {
  return (
    <span className="img-meta">
      <span className={cls}>{label}</span>
      <span className="faint">{img.w} × {img.h} · {size(img.bytes)}</span>
    </span>
  );
}

/** Preview of an image file's change: one side alone when added or deleted, else both with a few ways to compare. */
export function ImageDiff({ path, blobs, mode }: { path: string; blobs: Blobs; mode: ImageMode }) {
  const old = useImage(path, blobs.old);
  const next = useImage(path, blobs.new);
  const [pos, setPos] = useState(50);

  if (old === undefined || next === undefined) return null;
  if (!old && !next) return <div className="empty" style={{ fontFamily: "var(--sans)" }}>This image can't be previewed.</div>;
  if (!old || !next || old.src === next.src) {
    const img = (next ?? old)!;
    const [label, cls] = !old ? ["Added", "c-add"] : !next ? ["Deleted", "c-del"] : ["Unchanged", "muted"];
    return (
      <div className="img-diff">
        <div className="img-diff-bar"><Meta img={img} label={label} cls={cls} /></div>
        <div className="img-frame"><img src={img.src} alt={path} style={fit(img)} /></div>
      </div>
    );
  }
  return (
    <div className="img-diff">
      <div className="img-diff-bar">
        <Meta img={old} label="Before" cls="c-del" />
        <Meta img={next} label="After" cls="c-add" />
        <span className="grow" />
        {mode === "swipe" && (
          <input className="img-slider" type="range" min={0} max={100} value={pos} onChange={(e) => setPos(Number(e.target.value))} aria-label="Swipe position" />
        )}
        {mode === "onion" && (
          <label className="img-slider">
            <span className="c-del">Before</span>
            <input type="range" min={0} max={100} value={pos} onChange={(e) => setPos(Number(e.target.value))} aria-label="After opacity" />
            <span className="c-add">After</span>
          </label>
        )}
        {mode === "difference" && <span className="faint">Unchanged pixels show black; changes light up.</span>}
      </div>
      {mode === "side" ? (
        <div className="img-side">
          <div className="img-frame before"><img src={old.src} alt={`${path} before`} style={fit(old)} /></div>
          <div className="img-frame after"><img src={next.src} alt={`${path} after`} style={fit(next)} /></div>
        </div>
      ) : (
        <Stacked old={old} next={next} mode={mode} pos={pos} setPos={setPos} />
      )}
    </div>
  );
}

/** Natural size, shrunk to fit; small images (icons) aren't blown up. */
const fit = (img: Loaded): CSSProperties => ({ width: img.w, maxWidth: "100%", height: "auto" });

/** Both images on one canvas the size of the larger, anchored top-left like git would align them. */
function Stacked({ old, next, mode, pos, setPos }: { old: Loaded; next: Loaded; mode: Exclude<ImageMode, "side">; pos: number; setPos: (n: number) => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const w = Math.max(old.w, next.w);
  const h = Math.max(old.h, next.h);
  const place = (img: Loaded): CSSProperties => ({ width: `${(img.w / w) * 100}%`, height: `${(img.h / h) * 100}%` });

  const drag = (e: PointerEvent<HTMLDivElement>) => {
    if (mode !== "swipe" || !(e.buttons & 1)) return;
    const r = stage.current!.getBoundingClientRect();
    setPos(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)));
  };

  return (
    <div className="img-stack-wrap">
      <div
        ref={stage}
        className="img-stage"
        data-mode={mode}
        style={{ width: w, aspectRatio: `${w} / ${h}` }}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag(e); }}
        onPointerMove={drag}
      >
        <img src={old.src} alt="Before" style={place(old)} />
        <img
          src={next.src}
          alt="After"
          className="img-top"
          style={{
            ...place(next),
            ...(mode === "swipe" && { clipPath: `inset(0 0 0 ${pos}%)` }),
            ...(mode === "onion" && { opacity: pos / 100 }),
          }}
        />
        {mode === "swipe" && (
          <>
            <div className="img-handle" style={{ left: `${pos}%` }} />
            <span className="img-tag before">Before</span>
            <span className="img-tag after">After</span>
          </>
        )}
      </div>
    </div>
  );
}
