import { useId, useLayoutEffect, useRef, useState, type PointerEvent, type ReactElement, type ReactNode } from "react";

import type { Hunk } from "../api/types";

const MARKER = /^(<<<<<<<|=======|>>>>>>>)/;

/** "full" is unified with the whole file as context (the hunks must be fetched that way). */
export type DiffMode = "unified" | "split" | "full";

export function DiffView({ hunks, mode }: { hunks: Hunk[]; mode: DiffMode }) {
  return (
    <Heatmapped hunks={hunks} split={mode === "split"}>
      {mode === "split" ? <Split hunks={hunks} /> : <Unified hunks={hunks} headers={mode === "unified"} />}
    </Heatmapped>
  );
}

function Unified({ hunks, headers = true }: { hunks: Hunk[]; headers?: boolean }) {
  const rows: ReactElement[] = [];
  hunks.forEach((h, hi) => {
    if (headers)
      rows.push(
        <div key={`h${hi}`} className="diff-row hunk">
          <span className="ln" />
          <span className="ln" />
          <span className="sg" />
          <span className="tx">{h.header}</span>
        </div>,
      );
    let o = h.oldStart;
    let n = h.newStart;
    h.lines.forEach((l, li) => {
      const cls = l.kind === "+" ? "add" : l.kind === "-" ? "del" : "";
      const marker = MARKER.test(l.text) ? " marker" : "";
      rows.push(
        <div key={`${hi}-${li}`} className={`diff-row ${cls}${marker}`}>
          <span className="ln">{l.kind === "+" ? "" : o}</span>
          <span className="ln">{l.kind === "-" ? "" : n}</span>
          <span className="sg">{l.kind === " " ? "" : l.kind === "-" ? "−" : "+"}</span>
          <span className="tx">{l.text}</span>
        </div>,
      );
      if (l.kind !== "+") o++;
      if (l.kind !== "-") n++;
    });
  });
  return <div className="diff-u">{chunked(rows)}</div>;
}

const CHUNK = 200;

/** Rows in blocks the browser skips laying out while off screen, so big files open fast. */
function chunked(rows: ReactElement[]) {
  const out: ReactElement[] = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    // Rows are 21px (the .diff line-height) until wrapped; `auto` keeps the real size once seen.
    out.push(<div key={i} className="diff-chunk" style={{ containIntrinsicBlockSize: `auto ${part.length * 21}px` }}>{part}</div>);
  }
  return out;
}

interface Half {
  num: string;
  sign: string;
  text: string;
  cls: string;
}

const empty: Half = { num: "", sign: "", text: "", cls: "empty" };

function Split({ hunks }: { hunks: Hunk[] }) {
  const rows: [Half, Half][] = [];
  for (const h of hunks) {
    rows.push([{ num: "", sign: "", text: h.header, cls: "hunk" }, { num: "", sign: "", text: "", cls: "hunk" }]);
    let o = h.oldStart;
    let n = h.newStart;
    let dels: Half[] = [];
    let adds: Half[] = [];
    const flush = () => {
      const m = Math.max(dels.length, adds.length);
      for (let i = 0; i < m; i++) rows.push([dels[i] ?? empty, adds[i] ?? empty]);
      dels = [];
      adds = [];
    };
    for (const l of h.lines) {
      if (l.kind === "-") dels.push({ num: String(o++), sign: "−", text: l.text, cls: "del" });
      else if (l.kind === "+") adds.push({ num: String(n++), sign: "+", text: l.text, cls: "add" });
      else {
        flush();
        rows.push([
          { num: String(o++), sign: "", text: l.text, cls: "" },
          { num: String(n++), sign: "", text: l.text, cls: "" },
        ]);
      }
    }
    flush();
  }
  return (
    <div className="diff-split">
      {chunked(rows.map(([l, r], i) => (
        <div key={i} className="diff-split-row">
          {[l, r].map((x, j) => (
            <div key={j} className={`diff-half ${x.cls}`}>
              <span className="ln">{x.num}</span>
              <span className="sg">{x.sign}</span>
              <span className="tx">{x.text}</span>
            </div>
          ))}
        </div>
      )))}
    </div>
  );
}

interface Mark {
  kind: "add" | "del";
  top: number;
  height: number;
}

/** A diff view beside a heatmap of its changes that also scrolls it. In split mode removals
 * sit on the bar's left half and additions on its right, like the columns. */
function Heatmapped({ hunks, split, children }: { hunks: Hunk[]; split: boolean; children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const id = useId();
  const [marks, setMarks] = useState<Mark[]>([]);
  const [view, setView] = useState({ top: 0, height: 1 });

  // Marks come from the rendered rows (wrapped lines are taller), as fractions of the content.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      const total = el.scrollHeight || 1;
      // Rows sit inside contained chunks, so offsetTop would be chunk-relative.
      const origin = el.getBoundingClientRect().top - el.scrollTop;
      const out: Mark[] = [];
      // Split rows can hold a removal and an addition, so each kind merges on its own.
      const last: Partial<Record<Mark["kind"], Mark>> = {};
      el.querySelectorAll<HTMLElement>(".diff-row.add, .diff-row.del, .diff-half.add, .diff-half.del").forEach((r) => {
        const kind = r.classList.contains("add") ? "add" : "del";
        const box = r.getBoundingClientRect();
        const top = (box.top - origin) / total;
        const height = box.height / total;
        const prev = last[kind];
        if (prev && Math.abs(prev.top + prev.height - top) < 1e-6) prev.height += height;
        else out.push((last[kind] = { kind, top, height }));
      });
      setMarks(out);
      setView({ top: el.scrollTop / total, height: el.clientHeight / total });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hunks, split]);
  const onScroll = () => {
    const el = scroller.current!;
    setView({ top: el.scrollTop / el.scrollHeight, height: el.clientHeight / el.scrollHeight });
  };

  // The bar is the scrollbar: dragging the view band keeps the grab point under the
  // pointer; pressing elsewhere first centres the view there.
  const grab = useRef(0);
  const frac = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return (e.clientY - r.top) / r.height;
  };
  const seek = (e: PointerEvent<HTMLDivElement>) => {
    const el = scroller.current!;
    el.scrollTop = (frac(e) - grab.current) * el.scrollHeight;
  };

  return (
    <div className="diff-pane">
      <div ref={scroller} id={id} className="diff-pane-scroll" onScroll={onScroll}>
        {children}
      </div>
      <div
        className={`diff-heatmap${split ? " split" : ""}`}
        role="scrollbar"
        aria-controls={id}
        aria-orientation="vertical"
        aria-valuenow={Math.round((view.top / Math.max(1 - view.height, 1e-6)) * 100)}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const f = frac(e);
          grab.current = f >= view.top && f <= view.top + view.height ? f - view.top : view.height / 2;
          seek(e);
        }}
        onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && seek(e)}
        onWheel={(e) => (scroller.current!.scrollTop += e.deltaY)}
      >
        {marks.map((m, i) => (
          <span key={i} className={`hm ${m.kind}`} style={{ top: `${m.top * 100}%`, height: `${m.height * 100}%` }} />
        ))}
        {view.height < 1 && <span className="hm-view" style={{ top: `${view.top * 100}%`, height: `${view.height * 100}%` }} />}
      </div>
    </div>
  );
}
