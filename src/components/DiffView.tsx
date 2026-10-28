import { Fragment, startTransition, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type ReactElement, type ReactNode } from "react";

import type { Hunk, LinePick } from "../api/types";
import { plural } from "../lib/format";
import type { Token, Tokens } from "../lib/highlight.worker";
import { Icon } from "./Icon";
import { ErrorBox, Modal } from "./ui";

const MARKER = /^(<<<<<<<|=======|>>>>>>>)/;
// #rgb, #rgba, #rrggbb or #rrggbbaa; not inside a word or an `&#123;` entity.
const HEX = /((?<![\w&])#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{3,4})\b)/i;

/** The text with a swatch of each hex colour before it. */
function swatched(text: string): ReactNode {
  const parts = text.split(HEX);
  if (parts.length === 1) return text;
  return parts.map((p, i) => (i % 2 ? <Fragment key={i}><span className="swatch" style={{ background: p }} />{p}</Fragment> : p));
}

/** A line's text, in its syntax colors once they have come. */
function code(text: string, toks: Token[] | null | undefined): ReactNode {
  if (!toks) return swatched(text);
  return toks.map(([s, cls], i) => (cls ? <span key={i} className={cls}>{swatched(s)}</span> : swatched(s)));
}

let worker: Worker | undefined;
let asked = 0;
const answers = new Map<number, (tokens: Tokens) => void>();

/** The hunks to draw and their syntax tokens, from a worker. A new file shows plain until they come; a new
 * version of the same file (a refresh, another mode) keeps the colored previous one meanwhile, so it doesn't flicker. */
function useTokens(path: string, hunks: Hunk[]): { hunks: Hunk[]; tokens?: Tokens } {
  const [got, setGot] = useState<{ id: number; path: string; hunks: Hunk[]; tokens: Tokens }>();
  useEffect(() => {
    if (!worker) {
      worker = new Worker(new URL("../lib/highlight.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = ({ data }) => {
        answers.get(data.id)?.(data.tokens);
        answers.delete(data.id);
      };
    }
    const id = ++asked;
    // A late answer still moves the view forward, so steady edits can't stall it on an old version. A transition
    // draws the colors in slices, so a big file doesn't freeze while they land.
    answers.set(id, (tokens) => startTransition(() => setGot((g) => (g && g.id > id ? g : { id, path, hunks, tokens }))));
    worker.postMessage({ id, path, hunks });
  }, [path, hunks]);
  return got && (got.hunks === hunks || (got.path === path && got.tokens)) ? got : { hunks };
}

/** "full" is unified with the whole file as context (the hunks must be fetched that way). */
export type DiffMode = "unified" | "split" | "full";

/** Staging from the diff of one side of a WIP file. */
export interface Staging {
  /** The diff is the staged side: its lines get unstaged. */
  staged: boolean;
  busy: boolean;
  apply: (lines: LinePick[]) => Promise<unknown>;
  /** Unstaged side only: throws the lines away from the working tree. */
  discard?: (lines: LinePick[]) => Promise<unknown>;
}

export function DiffView({ path, hunks, mode, staging }: { path: string; hunks: Hunk[]; mode: DiffMode; staging?: Staging }) {
  const shown = useTokens(path, hunks);
  const picking = usePicking(path, shown.hunks, staging);
  return (
    <>
      <Heatmapped hunks={shown.hunks} split={mode === "split"}>
        {mode === "split" ? (
          <Split hunks={shown.hunks} tokens={shown.tokens} picking={picking} />
        ) : (
          <Unified hunks={shown.hunks} tokens={shown.tokens} headers={mode === "unified"} picking={picking} />
        )}
      </Heatmapped>
      {picking && picking.picked.size > 0 && <PickBar picking={picking} />}
      {picking?.discarding && <DiscardLines path={path} picking={picking} />}
    </>
  );
}

interface Picking {
  staging: Staging;
  /** Each line's pick by hunk, none for context lines. */
  lines: (LinePick | undefined)[][];
  picked: ReadonlyMap<string, LinePick>;
  /** Mouse handlers for a changed line's row. */
  row: (p: LinePick) => { onMouseDown: (e: MouseEvent<HTMLElement>) => void; onMouseEnter: (e: MouseEvent<HTMLElement>) => void };
  /** Stages or unstages `lines`, then lets go of every pick. */
  apply: (lines: LinePick[]) => void;
  clear: () => void;
  /** Lines waiting for their discard to be confirmed. */
  discarding: LinePick[] | null;
  askDiscard: (lines: LinePick[] | null) => void;
  /** Throws `lines` away (unstaged side only), then lets go of every pick. */
  discard: (lines: LinePick[]) => Promise<void>;
}

const keyOf = (p: LinePick) => p.kind + p.n;

/** Each line's pick by hunk: its kind, its number on its side and its text; none for context lines. */
function linePicks(hunks: Hunk[]): (LinePick | undefined)[][] {
  return hunks.map((h) => {
    let o = h.oldStart;
    let n = h.newStart;
    return h.lines.map((l) => {
      const p: LinePick | undefined = l.kind === "-" ? { kind: "-", n: o, text: l.text } : l.kind === "+" ? { kind: "+", n, text: l.text } : undefined;
      if (l.kind !== "+") o++;
      if (l.kind !== "-") n++;
      return p;
    });
  });
}

/** Changed lines picked in the gutter, when the diff can stage. A click toggles one and dragging on sets the lines it
 * passes the same way; shift-click picks the range from the line last clicked. A pick keeps its text, so it drops out
 * once its line changes. */
function usePicking(path: string, hunks: Hunk[], staging?: Staging): Picking | undefined {
  const lines = useMemo(() => linePicks(hunks), [hunks]);
  const order = useMemo(() => lines.flat().filter((p) => p !== undefined), [lines]);
  // Picks belong to one side of one file.
  const scope = `${staging?.staged}:${path}`;
  const [keys, setKeys] = useState({ scope, texts: new Map<string, string>() });
  if (keys.scope !== scope) setKeys({ scope, texts: new Map() });
  const picked = useMemo(() => {
    const m = new Map<string, LinePick>();
    if (keys.scope === scope) for (const p of order) if (keys.texts.get(keyOf(p)) === p.text) m.set(keyOf(p), p);
    return m;
  }, [order, keys, scope]);
  const set = (ps: LinePick[], on: boolean) =>
    setKeys((k) => {
      const texts = new Map(k.texts);
      for (const p of ps) {
        if (on) texts.set(keyOf(p), p.text);
        else texts.delete(keyOf(p));
      }
      return { ...k, texts };
    });
  const clear = () => setKeys((k) => ({ ...k, texts: new Map() }));
  // The lines from the one keyed `from` to `to`, in diff order.
  const between = (from: string, to: LinePick) => {
    const i = order.findIndex((p) => keyOf(p) === from);
    const j = order.indexOf(to);
    return i < 0 ? [to] : order.slice(Math.min(i, j), Math.max(i, j) + 1);
  };
  const [discarding, setDiscarding] = useState<LinePick[] | null>(null);
  const anchor = useRef("");
  // A drag under way: what it sets lines to, and the last line it passed.
  const drag = useRef<{ on: boolean; at: string } | null>(null);
  useEffect(() => {
    const end = () => (drag.current = null);
    window.addEventListener("mouseup", end);
    return () => window.removeEventListener("mouseup", end);
  }, []);
  // Escape lets go of the picks before it closes the diff.
  const any = picked.size > 0;
  useEffect(() => {
    if (!any) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (e.target as HTMLElement).closest("input, textarea") || document.querySelector("[role=dialog], [role=menu]")) return;
      e.stopImmediatePropagation();
      setKeys((k) => ({ ...k, texts: new Map() }));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [any]);
  if (!staging) return undefined;
  return {
    staging,
    lines,
    picked,
    // The gutter picks; the text stays selectable. A tap comes as a mouse press too, a swipe doesn't: it scrolls.
    row: (p) => ({
      onMouseDown: (e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest(".tx")) return;
        e.preventDefault();
        if (e.shiftKey && anchor.current) return set(between(anchor.current, p), true);
        const on = !picked.has(keyOf(p));
        set([p], on);
        anchor.current = keyOf(p);
        drag.current = { on, at: keyOf(p) };
      },
      onMouseEnter: (e) => {
        const d = drag.current;
        if (!d || !(e.buttons & 1)) return;
        // Lines a fast drag skipped over are passed too.
        set(between(d.at, p), d.on);
        d.at = keyOf(p);
      },
    }),
    apply: (ls) => void staging.apply(ls).then(clear, () => {}),
    clear,
    discarding,
    askDiscard: setDiscarding,
    discard: (ls) =>
      staging.discard!(ls).then(() => {
        clear();
        setDiscarding(null);
      }),
  };
}

/** Class and handlers of a line's row: a changed line can be picked when the diff can stage. */
function rowPick(picking: Picking | undefined, p: LinePick | undefined) {
  if (!picking || !p) return { cls: "", props: {} };
  return { cls: picking.picked.has(keyOf(p)) ? " pick picked" : " pick", props: picking.row(p) };
}

/** Stages, unstages or discards a whole hunk, from its header. */
function HunkAction({ picking, hunk }: { picking: Picking; hunk: number }) {
  const { staging } = picking;
  const what = staging.staged ? "Unstage" : "Stage";
  const lines = picking.lines[hunk].filter((p) => p !== undefined);
  return (
    <span className="hunk-acts">
      <button
        className="btn btn-ghost hunk-act"
        disabled={staging.busy}
        data-tip={`${what} this hunk. To ${what.toLowerCase()} only some lines, select them in the line numbers`}
        onClick={() => picking.apply(lines)}
      >
        <Icon name={staging.staged ? "minus" : "plus"} size={11} />
        {what} hunk
      </button>
      {staging.discard && (
        <button className="btn btn-ghost btn-act btn-danger hunk-act" disabled={staging.busy} aria-label="Discard hunk" data-tip="Discard this hunk" onClick={() => picking.askDiscard(lines)}>
          <Icon name="undo" size={11} />
        </button>
      )}
    </span>
  );
}

/** What to do with the selected lines, floating over the foot of the diff. */
function PickBar({ picking }: { picking: Picking }) {
  const { staging, picked } = picking;
  return (
    <div className="diff-picks" role="toolbar" aria-label="Selected lines">
      <span>{plural(picked.size, "line")} selected</span>
      <button className="btn btn-sm btn-primary" disabled={staging.busy} onClick={() => picking.apply([...picked.values()])}>
        {staging.busy ? <span className="spinner" /> : <Icon name={staging.staged ? "minus" : "plus"} size={12} />}
        {staging.staged ? "Unstage" : "Stage"}
      </button>
      {staging.discard && (
        <button className="btn btn-ghost btn-act btn-danger" disabled={staging.busy} aria-label="Discard selected lines" data-tip="Discard lines" onClick={() => picking.askDiscard([...picked.values()])}>
          <Icon name="undo" size={12} />
        </button>
      )}
      <button className="btn btn-ghost btn-act" aria-label="Clear selection" data-tip="Clear selection (Esc)" onClick={picking.clear}>
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

/** Asks before throwing lines away, like discarding whole files. */
function DiscardLines({ path, picking }: { path: string; picking: Picking }) {
  const [error, setError] = useState<unknown>();
  const lines = picking.discarding ?? [];
  return (
    <Modal
      title={`Discard ${plural(lines.length, "unstaged line")}`}
      sub={<span className="mono">{path}</span>}
      onClose={() => picking.askDiscard(null)}
      footer={
        <button className="btn btn-md btn-danger" disabled={picking.staging.busy} onClick={() => picking.discard(lines).catch(setError)}>
          {picking.staging.busy && <span className="spinner" />}
          Discard
        </button>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        Throws away the selected edits — staged changes are kept, and an untracked file left with no lines is deleted. This cannot be undone.
      </p>
      <ErrorBox error={error} />
    </Modal>
  );
}

function Unified({ hunks, tokens, headers = true, picking }: { hunks: Hunk[]; tokens: Tokens | undefined; headers?: boolean; picking?: Picking }) {
  const rows: ReactElement[] = [];
  hunks.forEach((h, hi) => {
    if (headers)
      rows.push(
        <div key={`h${hi}`} className="diff-row hunk">
          <span className="ln" />
          <span className="ln" />
          <span className="sg" />
          {picking ? (
            <span className="tx hunk-tx">
              <span>{h.header}</span>
              <HunkAction picking={picking} hunk={hi} />
            </span>
          ) : (
            <span className="tx">{h.header}</span>
          )}
        </div>,
      );
    let o = h.oldStart;
    let n = h.newStart;
    h.lines.forEach((l, li) => {
      const cls = l.kind === "+" ? "add" : l.kind === "-" ? "del" : "";
      const marker = MARKER.test(l.text) ? " marker" : "";
      const pick = rowPick(picking, picking?.lines[hi][li]);
      rows.push(
        <div key={`${hi}-${li}`} className={`diff-row ${cls}${marker}${pick.cls}`} {...pick.props}>
          <span className="ln">{l.kind === "+" ? "" : o}</span>
          <span className="ln">{l.kind === "-" ? "" : n}</span>
          <span className="sg">{l.kind === " " ? "" : l.kind === "-" ? "−" : "+"}</span>
          <span className="tx">{code(l.text, tokens?.[hi][li])}</span>
        </div>,
      );
      if (l.kind !== "+") o++;
      if (l.kind !== "-") n++;
    });
  });
  return <div className={picking ? "diff-u picking" : "diff-u"}>{chunked(rows)}</div>;
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
  toks?: Token[] | null;
  cls: string;
  pick?: LinePick;
  /** On the right of a hunk's header row: that hunk. */
  hunk?: number;
}

const empty: Half = { num: "", sign: "", text: "", cls: "blank" };

function Split({ hunks, tokens, picking }: { hunks: Hunk[]; tokens: Tokens | undefined; picking?: Picking }) {
  const rows: [Half, Half][] = [];
  hunks.forEach((h, hi) => {
    rows.push([{ num: "", sign: "", text: h.header, cls: "hunk" }, { num: "", sign: "", text: "", cls: "hunk", hunk: hi }]);
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
    h.lines.forEach((l, li) => {
      const toks = tokens?.[hi][li];
      const pick = picking?.lines[hi][li];
      if (l.kind === "-") dels.push({ num: String(o++), sign: "−", text: l.text, toks, cls: "del", pick });
      else if (l.kind === "+") adds.push({ num: String(n++), sign: "+", text: l.text, toks, cls: "add", pick });
      else {
        flush();
        rows.push([
          { num: String(o++), sign: "", text: l.text, toks, cls: "" },
          { num: String(n++), sign: "", text: l.text, toks, cls: "" },
        ]);
      }
    });
    flush();
  });
  return (
    <div className={picking ? "diff-split picking" : "diff-split"}>
      {chunked(rows.map(([l, r], i) => (
        <div key={i} className="diff-split-row">
          {[l, r].map((x, j) => {
            const pick = rowPick(picking, x.pick);
            return (
              <div key={j} className={`diff-half ${x.cls}${pick.cls}`} {...pick.props}>
                <span className="ln">{x.num}</span>
                <span className="sg">{x.sign}</span>
                {picking && x.hunk !== undefined ? (
                  <span className="tx hunk-tx">
                    <span />
                    <HunkAction picking={picking} hunk={x.hunk} />
                  </span>
                ) : (
                  <span className="tx">{code(x.text, x.toks)}</span>
                )}
              </div>
            );
          })}
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
