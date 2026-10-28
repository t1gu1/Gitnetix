import { useEffect, useMemo, useReducer, useRef, type CSSProperties, type MouseEvent, type ReactNode } from "react";

import { ago, plural } from "../lib/format";
import type { GLabel, GPiece, GRow, Layout, Node, Preview } from "../lib/graph";
import { Icon } from "./Icon";

// The commit graph as drawn: rows of commits and their labels over an SVG of lanes, rows sliding to their new place,
// what comes fading in, what goes fading out. Shared by the app's graph column and the website's demo of it.

/** Row height and lane width, in pixels; the first lane's center sits LEFT from the edge. */
const ROW = 28;
const LANE = 14;
const LEFT = 16;
const TOP = 8;
/** How long what leaves the graph takes to fade out. */
const FADE_MS = 300;

const cx = (lane: number) => LEFT + lane * LANE;
const cy = (row: number) => TOP + row * ROW + ROW / 2;

/** Where row `row`'s middle sits from the top of the canvas, and a row's height, in pixels. */
export const rowCenter = cy;
export const GRAPH_ROW = ROW;

/** Whether branch `b` shows in `l`: on a line of its own or as a label. */
export const showsBranch = (l: Layout | null | undefined, b: string | null | undefined) => !!b && !!l?.rows.some((r) => r.branch === b || r.labels.some((x) => x.branch === b));

/** `items` plus the ones just gone, kept `ms` with `gone` set so they can fade out where they were. */
function usePresence<T extends { key: string }>(items: T[], ms: number): { item: T; gone: boolean }[] {
  const kept = useRef(new Map<string, { item: T; goneAt?: number }>());
  const [tick, bump] = useReducer((n: number) => n + 1, 0);
  const list = useMemo(() => {
    const now = performance.now();
    const m = kept.current;
    const live = new Set<string>();
    for (const it of items) {
      live.add(it.key);
      m.set(it.key, { item: it });
    }
    for (const [k, v] of m) {
      if (live.has(k)) continue;
      if (v.goneAt === undefined) v.goneAt = now;
      else if (now - v.goneAt >= ms) m.delete(k);
    }
    return [...m.values()].map((v) => ({ item: v.item, gone: v.goneAt !== undefined }));
  }, [items, tick, ms]);
  const fading = list.some((x) => x.gone);
  useEffect(() => {
    if (!fading) return;
    const t = setTimeout(bump, ms + 20);
    return () => clearTimeout(t);
  }, [list, fading, ms]);
  return list;
}


export interface GraphCanvasProps {
  /** What to draw: the graph as it is, or as a previewed action would leave it. */
  shown: Layout;
  /** The graph as it is while `shown` previews an action: what differs from it pulses. */
  base?: Layout | null;
  /** Commit picked (its row stands out). */
  selected?: string;
  /** Branch brought forward: the rest steps back. */
  hl?: string | null;
  /** Uncommitted files in the main checkout. */
  wip: number;
  /** How old a commit reads; `ago` of its date by default. */
  age?: (n: Node) => string;
  onOpen?: (r: GRow) => void;
  onMenu?: (r: GRow, e: MouseEvent) => void;
  onLabel?: (l: GLabel) => void;
  onLabelSwitch?: (l: GLabel) => void;
  onLabelMenu?: (l: GLabel, e: MouseEvent) => void;
  onLabelHover?: (b: string | null) => void;
}

const nothing = () => {};
const dateOf = (n: Node) => ago(n.date);

/** The rows and lanes of a laid-out graph. Its column (`.ws-graph`) says whether a preview shows (`data-preview`) and a branch is brought forward (`data-hl`). */
export function GraphCanvas({ shown, base, selected, hl, wip, age = dateOf, onOpen = nothing, onMenu = nothing, onLabel = nothing, onLabelSwitch = nothing, onLabelMenu = nothing, onLabelHover = nothing }: GraphCanvasProps) {
  // What changed against the graph as it is: drawn pulsing while the preview shows.
  const changed = useMemo(() => {
    if (!base || base === shown) return null;
    const sig = (r: GRow, l: GLabel) => `${r.key}|${l.key}|${+!!l.local}${+!!l.remote}${+!!l.head}`;
    const rows = new Set(base.rows.map((r) => r.key));
    const labels = new Set(base.rows.flatMap((r) => r.labels.map((l) => sig(r, l))));
    const pieces = new Set(base.pieces.map((p) => p.key));
    return {
      row: (r: GRow) => !rows.has(r.key),
      label: (r: GRow, l: GLabel) => !labels.has(sig(r, l)),
      piece: (p: GPiece) => !pieces.has(p.key),
    };
  }, [base, shown]);
  const rows = usePresence(shown.rows, FADE_MS);
  const pieces = usePresence(shown.pieces, FADE_MS);
  const textX = cx(shown.lanes - 1) + LANE;
  const height = TOP * 2 + shown.rows.length * ROW;
  const onLine = (line: number, branch?: string) => !!hl && (branch ?? shown.lineBranch[line]) === hl;
  return (
    <div className="graph-canvas" style={{ height, "--text-x": `${textX}px` } as CSSProperties}>
      {rows.map(({ item: r, gone }) => (
        <GraphRowView
          key={r.key}
          r={r}
          gone={gone}
          isNew={!!changed?.row(r) && !gone}
          changedLabel={(l) => !!changed?.label(r, l)}
          selected={!!selected && (r.node?.sha === selected || !!r.hidden?.some((n) => n.sha === selected))}
          on={onLine(r.line, r.branch)}
          hl={hl ?? null}
          wip={wip}
          onOpen={() => onOpen(r)}
          onMenu={(e) => onMenu(r, e)}
          onLabel={onLabel}
          onLabelSwitch={onLabelSwitch}
          onLabelMenu={onLabelMenu}
          onLabelHover={onLabelHover}
          age={age}
        />
      ))}
      <svg className="graph-svg" width={textX} height={height} aria-hidden>
        <g>
          {pieces.map(({ item: p, gone }) => (
            <PieceView key={p.key} p={p} gone={gone} isNew={!!changed?.piece(p) && !gone} on={onLine(p.line)} />
          ))}
        </g>
        <g>
          {rows.map(({ item: r, gone }) => (
            <Dot key={r.key} r={r} gone={gone} isNew={!!changed?.row(r) && !gone} on={onLine(r.line, r.branch)} />
          ))}
        </g>
      </svg>
    </div>
  );
}

/** What the hovered action would do, in words, over the top of the graph. */
export function PreviewBanner({ active, preview, loading }: { active: boolean; preview: Preview | null | undefined; loading?: boolean }) {
  // The last one shown stays while the banner fades out.
  const last = useRef<{ title: string; note?: string; noop?: boolean; warn?: boolean } | null>(null);
  const on = active && (!!preview || !!loading);
  if (on) last.current = preview ? { title: preview.title, note: preview.note, noop: preview.noop, warn: preview.warn } : { title: "Reading the branches…" };
  const p = last.current;
  return (
    <div className="graph-banner" data-on={on || undefined} data-noop={p?.noop || undefined} data-warn={p?.warn || undefined} role="status" aria-live="polite">
      {p && (
        <>
          <span className="graph-banner-icon">{loading && !preview ? <span className="spinner" /> : <Icon name={p.noop ? "check" : "eye"} size={12} />}</span>
          <span className="col" style={{ minWidth: 0, gap: 1 }}>
            <span className="graph-banner-title ellipsis">{p.noop ? p.title : `Preview · ${p.title}`}</span>
            {p.note && <span className="graph-banner-note">{p.note}</span>}
          </span>
        </>
      )}
    </div>
  );
}

function PieceView({ p, gone, isNew, on }: { p: GPiece; gone: boolean; isNew: boolean; on: boolean }) {
  const style = { "--c": p.color } as CSSProperties;
  const flags = { "data-gone": gone || undefined, "data-new": isNew || undefined, "data-on": on || undefined };
  if (p.kind === "rail") {
    const y1 = cy(p.y1);
    const h = cy(p.y2) - y1;
    if (p.dashed) return <line className="g-el g-rail g-dashed" x1={0} y1={0} x2={0} y2={h} style={{ ...style, transform: `translate(${cx(p.x)}px, ${y1}px)` }} {...flags} />;
    return <rect className="g-el g-rail" x={-1} y={0} width={2} height={1} style={{ ...style, transform: `translate(${cx(p.x)}px, ${y1}px) scaleY(${h})` }} {...flags} />;
  }
  if (p.kind === "stub") {
    return <path className="g-el g-stub" d={`M0 0 L${p.dx * LANE * 0.6} ${ROW * 0.6}`} style={{ ...style, transform: `translate(${cx(p.x)}px, ${cy(p.y)}px)` }} {...flags} />;
  }
  const w = p.dx * LANE;
  return (
    <path
      className={`g-el g-elbow${p.dashed ? " g-dashed" : ""}`}
      d={`M0 0 C0 ${ROW * 0.55} ${w} ${ROW * 0.45} ${w} ${ROW}`}
      style={{ ...style, transform: `translate(${cx(p.x)}px, ${cy(p.y)}px)` }}
      {...flags}
    />
  );
}

function Dot({ r, gone, isNew, on }: { r: GRow; gone: boolean; isNew: boolean; on: boolean }) {
  const style = { "--c": r.color, transform: `translate(${cx(r.lane)}px, ${cy(r.row)}px)` } as CSSProperties;
  const flags = { "data-gone": gone || undefined, "data-new": isNew || undefined, "data-on": on || undefined };
  if (r.kind === "gap") return null;
  if (r.kind === "fold") return <g className="g-el g-fold" style={style} {...flags}><circle r={1.6} cy={-5} /><circle r={1.6} /><circle r={1.6} cy={5} /></g>;
  if (r.kind === "wip") return <circle className="g-el g-wip" r={5.5} style={style} {...flags} />;
  if (r.kind === "stash") return <rect className="g-el g-stash" x={-5} y={-5} width={10} height={10} rx={2.5} style={style} {...flags} />;
  return (
    <g className="g-el g-dot" style={style} data-merge={r.merge || undefined} data-sim={r.node?.sim || undefined} data-head={r.head || undefined} {...flags}>
      {r.head && <circle className="g-head" r={8} />}
      <circle r={r.merge ? 3.6 : 4.6} />
    </g>
  );
}

function GraphRowView({
  r,
  gone,
  isNew,
  changedLabel,
  selected,
  on,
  hl,
  wip,
  onOpen,
  onMenu,
  onLabel,
  onLabelSwitch,
  onLabelMenu,
  onLabelHover,
  age,
}: {
  r: GRow;
  gone: boolean;
  isNew: boolean;
  changedLabel: (l: GLabel) => boolean;
  selected: boolean;
  on: boolean;
  hl: string | null;
  wip: number;
  onOpen: () => void;
  onMenu: (e: MouseEvent) => void;
  onLabel: (l: GLabel) => void;
  onLabelSwitch: (l: GLabel) => void;
  onLabelMenu: (l: GLabel, e: MouseEvent) => void;
  onLabelHover: (b: string | null) => void;
  age: (n: Node) => string;
}) {
  const n = r.node;
  let body: ReactNode;
  let tip: string | undefined;
  if (r.kind === "wip") body = <span className="g-note">{wip > 0 ? `Uncommitted changes · ${plural(wip, "file")}` : "Uncommitted changes"}</span>;
  else if (r.kind === "stash") body = <span className="g-note">Stashed changes</span>;
  else if (r.kind === "fold") {
    body = <span className="g-more">{plural(r.hidden!.length, "commit")}</span>;
    tip = "Show them";
  } else if (r.kind === "gap") body = <span className="g-note">{n?.gap ? `${plural(n.gap, "more commit")} not shown` : "Older history"}</span>;
  else {
    body = <span className="g-subject">{n?.subject || "(no message)"}</span>;
    if (n && !n.sim) tip = `${n.subject} · ${n.sha.slice(0, 7)} · ${n.author} · ${age(n)}`;
  }
  const interactive = r.kind === "commit" || r.kind === "fold" || r.kind === "wip";
  return (
    <div
      className="g-row"
      data-kind={r.kind}
      data-gone={gone || undefined}
      data-new={isNew || undefined}
      data-sel={selected || undefined}
      data-on={on || undefined}
      data-sim={n?.sim || undefined}
      style={{ transform: `translateY(${TOP + r.row * ROW}px)`, height: ROW, "--c": r.color } as CSSProperties}
      role={interactive && !n?.sim ? "button" : undefined}
      tabIndex={interactive && !n?.sim && !gone ? 0 : undefined}
      onClick={gone ? undefined : onOpen}
      onKeyDown={(e) => !gone && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
      onContextMenu={gone ? undefined : onMenu}
    >
      <span className="g-text" data-tip={tip} data-tip-place="bottom">
        {r.labels.map((l) => (
          <span
            key={l.key}
            className="g-label"
            data-kind={l.tag ? "tag" : l.remote && !l.local ? "remote" : "local"}
            data-head={l.head || undefined}
            data-made={l.made || undefined}
            data-new={changedLabel(l) || undefined}
            data-hl={!!hl && l.branch === hl ? true : undefined}
            style={l.color ? ({ "--c": l.color } as CSSProperties) : undefined}
            data-tip={labelTip(l)}
            onClick={(e) => {
              e.stopPropagation();
              onLabel(l);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onLabelSwitch(l);
            }}
            onContextMenu={(e) => onLabelMenu(l, e)}
            onPointerEnter={() => l.branch && onLabelHover(l.branch)}
            onPointerLeave={() => onLabelHover(null)}
          >
            {l.tag ? <Icon name="tag" size={10} stroke={1.6} /> : l.head ? <Icon name="check" size={10} stroke={2} /> : !l.local ? <Icon name="cloud" size={11} stroke={1.5} /> : null}
            <span className="ellipsis">{l.text}</span>
            {l.local && l.remote && <Icon name="cloud" size={11} stroke={1.5} />}
          </span>
        ))}
        {body}
        {n && !n.sim && r.kind === "commit" && <span className="g-when">{age(n)}</span>}
      </span>
    </div>
  );
}

function labelTip(l: GLabel) {
  if (l.made) return l.tag ? "The tag you would create" : "The branch you would create";
  if (l.tag) return `Tag ${l.text}`;
  if (l.key === "HEAD") return "HEAD (detached)";
  const where = l.local && l.remote ? "here and on origin" : l.remote ? "on origin" : "here only";
  return `${l.text} · ${where}${l.head ? " · checked out" : ""}. Click to select it, double-click to check it out.`;
}

