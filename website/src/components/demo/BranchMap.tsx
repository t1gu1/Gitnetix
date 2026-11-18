import { useId, useLayoutEffect, useRef, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { Icon } from '../../../../src/components/Icon';
import { plural } from '../../../../src/lib/format';
import type { Branch, Commit } from '../HeroDemo';
import { Avatar } from './ui';

/**
 * The demo's copy of src/screens/BranchMap.tsx, drawn from the demo's branches: the same layout, markup and class names,
 * so site.css can keep copying app.css. Simpler where a web page differs: the wheel scrolls the page instead of zooming,
 * and the map sits at the canvas's top left instead of in the middle of empty room.
 */

/** Branches this many commits behind their base count as falling behind. */
export const BEHIND_LIMIT = 25;
/** Commits an unfolded tile lists; the rest are counted, listed once "see all" is open. */
const COMMITS_SHOWN = 6;
/** Merged branches listed under their base before "+N more". */
const MERGED_SHOWN = 4;
const TOP = 48;
const GAP = 8;
const GROUP_GAP = 20;
const SHIPPED_TOP = 70;
const SHIPPED_ROW = 14;
/** Room the floating card takes on the right (its width and gap). */
export const CARD_ROOM = 304;
/** Column `d` of the map: the trunk, then each level of branches under it. */
const colX = (d: number) => (d === 0 ? 24 : 300 + (d - 1) * 292);
const colW = (d: number) => (d === 0 ? 216 : 240);

export type MapPrefs = { who: 'all' | 'me'; commits: 'hidden' | 'latest' | 'list'; merged: boolean; behind: boolean; shipped: boolean };
export const PREFS: MapPrefs = { who: 'all', commits: 'hidden', merged: true, behind: true, shipped: true };
/** A release shipped from the trunk: its tag and the day it shipped. */
export type Shipped = { tag: string; date: string };
export type AgentInfo = { label: string; state?: 'working' | 'waiting' | 'done' };

export type Tile = {
  b: Branch;
  d: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Where edges meet it, down from its top. */
  a: number;
  /** Kept, faded, only for a shown branch below it. */
  ghost: boolean;
  /** Its newest commits listed, and the earlier ones too. */
  open: boolean;
  all: boolean;
  /** Merged branches chipped under it, how many more there are, and the ones a clean up may delete. */
  merged: Branch[];
  more: number;
  removable: Branch[];
};
export type MapLayout = ReturnType<typeof layoutMap>;

/**
 * Lays the branches out left to right, one column per level, like layoutMap in BranchMap.tsx: each parent sits level with
 * the middle of its children, siblings stack 8px apart and cousins 20px. `toggles`: tiles whose commits were folded or
 * unfolded (by name), listed whole (`all:<name>`), and merged groups shown whole (`merged:<name>`).
 */
export function layoutMap(bs: Record<string, Branch>, head: string, prefs: MapPrefs, me: string, toggles: ReadonlyMap<string, boolean>, shipped: Shipped[]) {
  const kids = (n: string) => (bs[n]?.kids ?? []).flatMap((k) => bs[k] ?? []);
  const parent = (n: string) => bs[n]?.base;
  const mine = (b: Branch) => b.author === me;
  const stale = (b: Branch) => b.role === 'branch' && !b.merged && b.behind >= BEHIND_LIMIT;
  const passes = (b: Branch) => (prefs.behind || !stale(b)) && (prefs.who === 'all' || mine(b));
  // A merged branch with nothing live left on it is a chip under its base, not a tile.
  const chip = (b: Branch) => !!b.merged && kids(b.name).every((k) => k.merged);
  const live = (b: Branch) => kids(b.name).filter((k) => !chip(k));
  const vis = new Set<string>();
  const ghost = new Set<string>();
  const walk = (b: Branch): boolean => {
    let any = false;
    for (const k of live(b)) if (walk(k)) any = true;
    if (b.role !== 'branch') {
      vis.add(b.name);
      if (!any && b.role === 'release' && prefs.who !== 'all') ghost.add(b.name);
      return true;
    }
    if (passes(b) || any) vis.add(b.name);
    if (!passes(b) && any) ghost.add(b.name);
    return vis.has(b.name);
  };
  const roots = Object.values(bs).filter((b) => !b.base);
  roots.forEach(walk);

  const open = (b: Branch) => b.ahead > 0 && (toggles.get(b.name) ?? (prefs.commits === 'list' || b.name === head));
  const tileH = (b: Branch) => {
    const base = b.role === 'trunk' ? 64 : 60;
    const n = toggles.get(`all:${b.name}`) ? b.ahead : Math.min(b.ahead, COMMITS_SHOWN);
    if (!n) return base;
    if (open(b)) return base + 15 + n * 18 + (n - 1) * 2 + (b.ahead > COMMITS_SHOWN ? 18 : 0);
    // Latest: the newest commit, then the "see all" row when there are others.
    return prefs.commits === 'latest' ? base + 26 + (b.ahead > 1 ? 23 : 0) : base;
  };
  // Edges meet the title row's middle.
  const anchor = (b: Branch) => (b.role === 'trunk' ? 24 : 20);
  const mergedOf = (b: Branch) => (prefs.merged ? kids(b.name).filter((k) => chip(k) && (prefs.who === 'all' || mine(k))) : []);

  // shortcut: lists every shipped release, oldest on top; the app folds all but the latest 10 behind "see all".
  const rows = prefs.shipped ? [...shipped].reverse() : [];
  const trunkFloor = rows.length ? SHIPPED_TOP + rows.length * SHIPPED_ROW + 22 : TOP;

  const at = new Map<string, Tile>();
  const tiles: Tile[] = [];
  const bottom: number[] = [];
  const last: (string | undefined)[] = [];
  const place = (b: Branch, d: number, floor: number, par: string) => {
    const h = tileH(b);
    const a = anchor(b);
    const gap = last[d] === undefined ? 0 : last[d] === par ? GAP : GROUP_GAP;
    let pMin = Math.max(floor, (bottom[d] ?? TOP) + gap);
    if (b.role === 'trunk') pMin = Math.max(pMin, trunkFloor);
    const ks = live(b).filter((k) => vis.has(k.name));
    let y = pMin;
    if (ks.length) {
      const span = ks.slice(0, -1).reduce((n, k) => n + tileH(k) + GAP, 0);
      const kidFloor = Math.max(floor, pMin + a - (anchor(ks[0]) + span + anchor(ks[ks.length - 1])) / 2);
      for (const k of ks) place(k, d + 1, kidFloor, b.name);
      const f = at.get(ks[0].name)!;
      const l = at.get(ks[ks.length - 1].name)!;
      y = Math.max(pMin, Math.round((f.y + f.a + l.y + l.a) / 2 - a));
    }
    last[d] = par;
    const all = mergedOf(b);
    const shown = toggles.get(`merged:${b.name}`) ? all.length : Math.min(all.length, MERGED_SHOWN);
    // The checked-out branch stays put.
    const removable = all.filter((c) => c.name !== head);
    const foot = all.length > shown || removable.length > 0;
    const t: Tile = { b, d, x: colX(d), y, w: colW(d), h, a, ghost: ghost.has(b.name), open: open(b), all: !!toggles.get(`all:${b.name}`), merged: all.slice(0, shown), more: all.length - shown, removable };
    at.set(b.name, t);
    tiles.push(t);
    bottom[d] = y + h + (all.length ? 8 + (shown + (foot ? 1 : 0)) * 30 - 6 : 0);
  };
  for (const r of roots) if (vis.has(r.name)) place(r, 0, TOP, '');

  const trunk = tiles.find((t) => t.b.role === 'trunk');
  const depth = tiles.reduce((m, t) => Math.max(m, t.d), 0);
  const work = new Map<string, { open: number; merged: number }>();
  for (const r of tiles.filter((t) => t.b.role === 'release')) {
    const c = { open: 0, merged: 0 };
    const count = (n: string) =>
      kids(n).forEach((k) => {
        if (k.role === 'branch') c[k.merged ? 'merged' : 'open']++;
        count(k.name);
      });
    count(r.b.name);
    work.set(r.b.name, c);
  }
  const liveWork = Object.values(bs).filter((b) => b.role === 'branch' && !b.merged);
  return {
    tiles,
    at,
    W: colX(depth) + colW(depth) + 24,
    H: Math.max(TOP, ...bottom.filter((n) => n !== undefined)) + 40,
    depth,
    shipped: trunk ? rows.map((r, i) => ({ r, y: SHIPPED_TOP + i * SHIPPED_ROW })) : [],
    shippedAll: shipped,
    parent,
    kids,
    stale,
    counts: { open: liveWork.length, mine: liveWork.filter(mine).length, merged: Object.values(bs).filter((b) => b.merged && b.role === 'branch').length, behind: liveWork.filter(stale).length },
    work,
  };
}

/** `name` and every branch above it, the root first. */
export function lineageOf(layout: Pick<MapLayout, 'parent'>, name?: string) {
  const out: string[] = [];
  for (let n = name; n && !out.includes(n); n = layout.parent(n)) out.unshift(n);
  return out;
}

/** Whether the map draws `n`, as a tile or as a merged chip under one. */
export const onMap = (layout: MapLayout, n: string) => layout.at.has(n) || layout.tiles.some((t) => t.merged.some((m) => m.name === n));

/** "3 branches", "1 merged branch": plural() would add an "s". */
export const branches = (n: number, what = 'branch') => `${n} ${what}${n === 1 ? '' : 'es'}`;

/** "2h ago" as a tile lists it: "2h". */
const age = (when: string) => when.replace(' ago', '').replace('just now', 'now');

/** What the map's buttons do; the static copy on the home page has none. */
export type MapHandlers = {
  select: (n: string) => void;
  checkout: (n: string) => void;
  /** A fold: a tile's commits (its name), all of them (`all:`), or a merged group (`merged:`). */
  toggle: (key: string, on: boolean) => void;
  /** A commit listed on a tile: look at its code. */
  look: (n: string, c: Commit) => void;
  menu: (n: string, e: MouseEvent) => void;
  rebase: (n: string, onto: string) => void;
  create: (n: string) => void;
  cleanup: (n: string, branches: Branch[]) => void;
  worktree: (n: string) => void;
  stashes: (n: string) => void;
  tag: (tag: string) => void;
};

type LayerProps = {
  layout: MapLayout;
  head: string;
  /** The branch the map shows selected. */
  shown: string;
  commits: MapPrefs['commits'];
  /** The search, lowercased, and the branch its arrows are on. */
  q?: string;
  hit?: string;
  agentOf?: (n: string) => AgentInfo | undefined;
  logOf: (b: Branch) => Commit[];
  labelOf: (n: string) => string;
  on?: MapHandlers;
};

/** `name` with the search marked in it. */
function marked(name: string, q: string | undefined, at: boolean): ReactNode {
  const i = q ? name.toLowerCase().indexOf(q) : -1;
  if (i < 0 || !q) return name;
  return <>{name.slice(0, i)}<mark className={at ? 'map-hit at' : 'map-hit'}>{name.slice(i, i + q.length)}</mark>{name.slice(i + q.length)}</>;
}

type Flags = { head: boolean; lin: boolean; desc: boolean; stale: boolean };
/** A tile's state as data attributes, on the tile, its pill and its "+", so all three draw the same border and glow. */
const tileState = (t: Tile, selected: boolean, current: boolean, f: Flags) => ({
  'data-sel': selected || undefined,
  'data-head': current || undefined,
  'data-lin': (f.lin && !selected) || undefined,
  'data-desc': f.desc || undefined,
  'data-ghost': t.ghost || undefined,
  'data-stale': f.stale || undefined,
});

/** The map itself, inside `.map-layer`: columns, shipped releases, lines, tiles and what hangs off them. */
export function MapLayer({ layout, head, shown, commits, q, hit, agentOf, logOf, labelOf, on }: LayerProps) {
  const { tiles, at } = layout;
  // Several maps on the page (hero, phone, the home page's): each needs its own glow filter.
  const glow = `map-glow${useId().replace(/[^\w-]/g, '')}`;
  const lin = new Set(lineageOf(layout, shown));
  const headLine = new Set(lineageOf(layout, head));
  const desc = new Set<string>();
  if (layout.parent(shown)) {
    const down = (n: string) => layout.kids(n).forEach((k) => (desc.add(k.name), down(k.name)));
    down(shown);
  }
  const flagsOf = (t: Tile): Flags => ({ head: headLine.has(t.b.name), lin: lin.has(t.b.name), desc: desc.has(t.b.name), stale: layout.stale(t.b) });

  // Edges run from a parent's right side to its child's left, in the colour of the line they are on.
  const edges: { d: string; cls: string; delay: number; box: [number, number, number, number] }[] = [];
  const behindTags: { x: number; y: number; b: Branch; onto: string }[] = [];
  for (const t of tiles) {
    const pn = layout.parent(t.b.name);
    const p = pn ? at.get(pn) : undefined;
    if (!p || !pn) continue;
    const [x1, y1, x2, y2] = [p.x + p.w, p.y + p.a, t.x, t.y + t.a];
    const dx = (x2 - x1) / 2;
    const n = t.b.name;
    const cls = headLine.has(n) ? 'head' : lin.has(n) ? 'lin' : desc.has(n) ? 'desc' : layout.stale(t.b) ? 'stale' : t.ghost ? 'far' : '';
    edges.push({ d: `M${x1} ${y1}C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`, cls, delay: lineageOf(layout, n).length - 2, box: [x1, Math.min(y1, y2), x2, Math.max(y1, y2)] });
    if (t.b.behind > 0) behindTags.push({ x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2), b: t.b, onto: pn });
  }
  // The pulse's layer spans only the checked-out branch's line.
  const headEdges = edges.filter((e) => e.cls === 'head');
  const pb = headEdges.length ? [Math.min(...headEdges.map((e) => e.box[0])) - 4, Math.min(...headEdges.map((e) => e.box[1])) - 4, Math.max(...headEdges.map((e) => e.box[2])) + 4, Math.max(...headEdges.map((e) => e.box[3])) + 4] : null;
  const trunk = tiles.find((t) => t.b.role === 'trunk');
  const cols = Array.from({ length: layout.depth + 1 }, (_, d) => (d === 0 ? 'Trunk' : d === 1 ? `Releases & straight to ${trunk?.b.name ?? 'main'}` : d === 2 ? 'Branches' : 'Stacked'));
  const tip = layout.shippedAll[0]?.tag;

  return (
    <>
      {cols.map((c, d) => (
        <span key={d} className="map-col" style={{ left: colX(d) }}>{c}</span>
      ))}

      {trunk && layout.shipped.length > 0 && (
        <>
          <svg className="map-history" width={60} height={trunk.y} aria-hidden="true">
            <path d={`M40 ${SHIPPED_TOP}V${trunk.y}`} />
            {layout.shipped.map(({ y }, i) => (
              <circle key={i} cx={40} cy={y} r={i === layout.shipped.length - 1 ? 4 : 3} data-new={i === layout.shipped.length - 1 || undefined} />
            ))}
          </svg>
          <span className="map-history-head" style={{ top: 40 }}>
            Shipped from {trunk.b.name}
            <span>{layout.shippedAll.length}</span>
          </span>
          {layout.shipped.map(({ r, y }, i) => (
            <button key={r.tag} className="map-ship" style={{ top: y - 7 }} data-new={i === layout.shipped.length - 1 || undefined} title={`Tagged ${r.tag} on ${trunk.b.name}. Double-click to check it out.`} onDoubleClick={() => on?.tag(r.tag)}>
              <span className="mono">{marked(r.tag, q, false)}</span>
              <span className="faint">{r.date}</span>
            </button>
          ))}
        </>
      )}

      <svg className="map-edges" width={layout.W} height={layout.H} aria-hidden="true">
        {pb && (
          <filter id={glow} filterUnits="userSpaceOnUse" x={pb[0] - 20} y={pb[1] - 20} width={pb[2] - pb[0] + 40} height={pb[3] - pb[1] + 40}>
            <feGaussianBlur stdDeviation="1.3" />
          </filter>
        )}
        {edges.map((e, i) => e.cls === 'head' && <path key={`g${i}`} className="map-glow" d={e.d} filter={`url(#${glow})`} />)}
        {edges.map((e, i) => <path key={i} d={e.d} data-line={e.cls || undefined} />)}
        {tiles.map(
          (t) =>
            t.merged.length > 0 && (
              <path
                key={`m${t.b.name}`}
                className="map-merged-line"
                d={
                  t.merged
                    .map((_, i) => {
                      const x0 = t.x + 10;
                      const cy = t.y + t.h + 20 + i * 30;
                      return `M${x0} ${cy - 8}Q${x0} ${cy} ${x0 + 8} ${cy}H${x0 + 14}`;
                    })
                    .join('') + `M${t.x + 10} ${t.y + t.h}V${t.y + t.h + 12 + (t.merged.length - 1) * 30}`
                }
              />
            ),
        )}
      </svg>

      {tiles.map((t) =>
        t.merged.length || t.more || t.removable.length ? (
          <div key={`mg${t.b.name}`} className="map-merged-group">
            {t.merged.map((m, i) => (
              <button
                key={m.name}
                className="map-merged"
                aria-pressed={m.name === shown}
                aria-label={`Select ${m.name}, merged`}
                style={{ left: t.x + 24, top: t.y + t.h + 8 + i * 30 }}
                onClick={() => on?.select(m.name)}
                onContextMenu={(e) => on?.menu(m.name, e)}
              >
                <Icon name="check" size={11} stroke={1.8} />
                <span className="ellipsis">{marked(m.name, q, hit === m.name)}</span>
              </button>
            ))}
            {(t.more > 0 || t.removable.length > 0) && (
              <span className="map-merged-foot" style={{ left: t.x + 24, top: t.y + t.h + 8 + t.merged.length * 30 }}>
                {t.more > 0 && <button className="map-more" onClick={() => on?.toggle(`merged:${t.b.name}`, true)}>+{t.more} more merged</button>}
                {t.merged.length > MERGED_SHOWN && <button className="map-more" onClick={() => on?.toggle(`merged:${t.b.name}`, false)}>Show fewer</button>}
                {t.removable.length > 0 && (
                  <button className="map-clean" title={`Delete the ${branches(t.removable.length, 'merged branch')} under ${labelOf(t.b.name)}, locally and on origin`} onClick={() => on?.cleanup(t.b.name, t.removable)}>
                    <Icon name="brush" size={12} />
                    Clean up
                  </button>
                )}
              </span>
            )}
          </div>
        ) : null,
      )}

      {tiles.map((t) => (
        <TileView
          key={t.b.name}
          t={t}
          head={head}
          selected={t.b.name === shown}
          flags={flagsOf(t)}
          commits={commits}
          q={q}
          hitAt={hit === t.b.name}
          agent={agentOf?.(t.b.name)}
          logOf={logOf}
          labelOf={labelOf}
          tip={t.b.role === 'trunk' ? tip : undefined}
          openReleases={layout.tiles.filter((x) => x.b.role === 'release').length}
          on={on}
        />
      ))}
      {/* The pulse down the checked-out branch's line, on a layer of its own, after the tiles. */}
      {pb && (
        <svg className="map-pulse" width={pb[2] - pb[0]} height={pb[3] - pb[1]} style={{ left: pb[0], top: pb[1] }} viewBox={`${pb[0]} ${pb[1]} ${pb[2] - pb[0]} ${pb[3] - pb[1]}`} aria-hidden="true">
          {headEdges.map((e, i) => <path key={i} d={e.d} style={{ animationDelay: `${e.delay * 10 * (1000 / 12)}ms` }} />)}
        </svg>
      )}
      {behindTags.map((l) => {
        const text = `↓${l.b.behind}`;
        const w = Math.round(12 + text.length * 6.3);
        const style = { left: l.x - w / 2, top: l.y - 9, width: w };
        // A work branch rebases onto the branch on its left; shared ones catch up by merging.
        if (l.b.role !== 'branch' || !on) return <span key={l.b.name} className="map-behind" style={style}>{text}</span>;
        const busy = agentOf?.(l.b.name)?.state === 'working';
        return (
          <button
            key={l.b.name}
            className="map-behind"
            style={style}
            aria-disabled={busy || undefined}
            title={busy ? `Can't rebase ${labelOf(l.b.name)} onto ${labelOf(l.onto)} while its agent is working. Wait until it finishes or asks you a question.` : `Rebase ${labelOf(l.b.name)} onto ${labelOf(l.onto)}`}
            onClick={() => !busy && on.rebase(l.b.name, l.onto)}
          >
            {text}
          </button>
        );
      })}
      {/* Outside the tiles, which clip: each "+" sits where the tile's lines leave on its right. */}
      {tiles.map((t) => (
        <button
          key={`out${t.b.name}`}
          className="map-out"
          {...tileState(t, t.b.name === shown, t.b.name === head, flagsOf(t))}
          aria-label={`Create a branch from ${t.b.name}`}
          title="Create a branch from here"
          style={{ left: t.x + t.w - 9, top: t.y + t.a - 9 }}
          onClick={() => on?.create(t.b.name)}
        >
          <Icon name="plus" size={10} stroke={2.2} />
        </button>
      ))}
    </>
  );
}

/** One branch on the map: its name and state, its newest commits when unfolded. Like TileView in BranchMap.tsx. */
function TileView({ t, head, selected, flags, commits, q, hitAt, agent, logOf, labelOf, tip, openReleases, on }: { t: Tile; head: string; selected: boolean; flags: Flags; commits: MapPrefs['commits']; q?: string; hitAt: boolean; agent?: AgentInfo; logOf: (b: Branch) => Commit[]; labelOf: (n: string) => string; tip?: string; openReleases: number; on?: MapHandlers }) {
  const { b } = t;
  const current = b.name === head;
  const parent = b.base ?? '';
  const n = Math.min(b.ahead, COMMITS_SHOWN);
  const log = logOf(b);
  const when = log[0]?.when ?? '';
  const pill = n > 0 && (
    <button
      className="map-pill"
      {...tileState(t, selected, current, flags)}
      aria-expanded={t.open}
      aria-label={`${t.open ? 'Fold' : 'Unfold'} the commits of ${b.name}`}
      title={`${plural(b.ahead, 'commit')}${parent ? ` not in ${labelOf(parent)}` : ''}`}
      onClick={() => {
        on?.toggle(b.name, !t.open);
        on?.select(b.name);
      }}
    >
      <Icon name="commit" size={11} stroke={1.6} />
      <span>{b.ahead}</span>
      <Icon name="chevronDown" size={9} stroke={2} className="chev" />
    </button>
  );
  const wip = b.wip.length > 0 && (
    <span key="wip" className="map-chip wip-badge">
      <span className="map-dot" />
      WIP {b.wip.length}
    </span>
  );
  const chips: ReactNode[] = [];
  if (b.role === 'branch') {
    if (agent?.state === 'working') {
      chips.push(
        <span key="agent" className="map-chip map-agent glow-working">
          <Icon name="layers" size={11} stroke={1.6} />
          <span className="ellipsis">{agent.label}</span>
          <span>working</span>
        </span>,
      );
    } else if (agent?.state) {
      chips.push(
        <span key="agent" className={`map-chip map-agent ${agent.state === 'done' ? 'c-add' : 'c-warn'}`}>
          {agent.state === 'waiting' ? <span className="pulse" /> : <Icon name="check" size={11} stroke={1.8} />}
          <span className="ellipsis">{agent.label}</span>
          {agent.state}
        </span>,
      );
    }
    if (current) chips.push(<span key="out" className="map-chip c-current">checked out</span>);
    else if (b.wt && !agent)
      chips.push(
        <button key="out" className="map-chip" title="Its own worktree. Click to open it in Worktrees & agents." onClick={() => on?.worktree(b.name)}>
          <Icon name="layers" size={11} stroke={1.5} />
          worktree
        </button>,
      );
    if (wip) chips.push(wip);
    if (flags.stale) chips.push(<span key="idle" className="map-chip c-warn" title={`${labelOf(parent)} is ${plural(b.behind, 'commit')} ahead`}><Icon name="alert" size={11} stroke={1.8} />{b.idle && b.idle > 1 ? `idle ${b.idle} days` : `↓${b.behind}`}</span>);
    if (!b.ahead && !b.wip.length && !agent) chips.push(<span key="none" className="map-chip faint">no commits yet</span>);
  }
  if (b.push) chips.push(<span key="push" className="map-chip c-mod">↑{b.push} to push</span>);
  if (b.stashes) chips.push(<button key="stash" className="map-chip" title={`${b.stashes} stashes made on ${b.name}`} onClick={() => on?.stashes(b.name)}><Icon name="stash" size={11} stroke={1.5} />{b.stashes}</button>);

  const name = b.role === 'branch' && b.kind ? b.name.slice(b.kind.length + 1) : b.name;
  return (
    <div
      className="map-tile"
      data-role={b.role}
      {...tileState(t, selected, current, flags)}
      data-hit={hitAt || undefined}
      style={{ left: t.x, top: t.y, width: t.w, height: t.h }}
      onContextMenu={(e) => on?.menu(b.name, e)}
    >
      <button className="map-hitbox" aria-pressed={selected} aria-label={`Select ${b.name}${t.ghost ? ', shown for what is under it' : ''}`} onClick={() => on?.select(b.name)} onDoubleClick={() => !b.wt && on?.checkout(b.name)} />
      <div className="map-tile-in">
        {b.role === 'trunk' ? (
          <>
            <span className="map-row">
              <Icon name="home" size={15} stroke={1.6} className="c-current" />
              <span className="map-trunk mono ellipsis">{marked(b.name, q, hitAt)}</span>
              <span className="tag map-tag-trunk">Default</span>
              <span className="grow" />
              {wip}
              {pill}
            </span>
            <span className="map-sub">{[tip && `tip ${tip}`, when, openReleases ? `${plural(openReleases, 'release')} open` : current ? 'checked out' : ''].filter(Boolean).join(' · ')}</span>
          </>
        ) : b.role === 'release' ? (
          <>
            <span className="map-row">
              <Icon name="tag" size={14} className="c-release" />
              <span className="map-ver mono ellipsis">{marked(labelOf(b.name), q, hitAt)}</span>
              {b.tag && <span className="tag accent">{b.tag}</span>}
              <span className="grow" />
              {wip}
              {pill}
            </span>
            <span className="map-sub ellipsis">{[b.name, parent && `from ${labelOf(parent)}`, current ? 'checked out' : when].filter(Boolean).join(' · ')}</span>
          </>
        ) : (
          <>
            <span className="map-row">
              {b.kind && <span className={`map-kind mono ${b.kind === 'fix' ? 'c-del' : 'c-mod'}`}>{b.kind}</span>}
              <span className="map-name mono ellipsis">{marked(name, q, hitAt)}</span>
              {pill}
            </span>
            <span className="map-chips">{chips.slice(0, agent ? 2 : 3)}</span>
          </>
        )}
        {t.open ? (
          <TileCommits b={b} log={log} list all={t.all} current={current} on={on} />
        ) : (
          commits === 'latest' && n > 0 && <TileCommits b={b} log={log} current={current} on={on} />
        )}
      </div>
    </div>
  );
}

/** A tile's newest commits: all it lists when unfolded, the newest alone otherwise, like TileCommits in BranchMap.tsx. */
function TileCommits({ b, log, list, all, current, on }: { b: Branch; log: Commit[]; list?: boolean; all?: boolean; current: boolean; on?: MapHandlers }) {
  const total = b.ahead;
  const shown = list ? COMMITS_SHOWN : 1;
  const more = total > shown && (
    <button
      className="map-crow map-crow-more"
      aria-expanded={!!all}
      onClick={() => {
        // "See all" on a folded tile unfolds it with every commit listed.
        if (!list) on?.toggle(b.name, true);
        on?.toggle(`all:${b.name}`, !all);
      }}
    >
      <span>{`${all ? '' : '+'}${plural(total - shown, 'earlier commit')}`}</span>
      <span className="map-crow-act">
        {all ? 'Hide' : 'See all'}
        <Icon name="chevronDown" size={10} stroke={2} className="chev" />
      </span>
    </button>
  );
  // A commit's own menu, not the tile's under it.
  const menu = (e: MouseEvent) => {
    e.stopPropagation();
    on?.menu(b.name, e);
  };
  // Ringed green on the commit checked out: the newest, here.
  const ring = (i: number) => (current && i === 0 ? 'latest' : undefined);
  if (!list) {
    const c = log[0];
    return (
      <>
        <button className="map-latest" disabled={!c} onClick={() => c && on?.look(b.name, c)} onContextMenu={menu}>
          <span className="map-crow-who" data-on={ring(0)}>{c && <Avatar name={c.author} size={14} />}</span>
          <span className="ellipsis">{c?.subject ?? '…'}</span>
          <span className="faint">{c && age(c.when)}</span>
        </button>
        {more}
      </>
    );
  }
  return (
    <span className="map-commits">
      {log.slice(0, all ? total : Math.min(total, COMMITS_SHOWN)).map((c, i) => (
        <button key={c.sha} className="map-crow" aria-label={`Look at commit ${c.sha}, ${c.subject}`} onClick={() => on?.look(b.name, c)} onContextMenu={menu}>
          <span className="map-crow-who" data-on={ring(i)}>
            <Avatar name={c.author} size={14} />
          </span>
          <span className="ellipsis">{c.subject}</span>
          <span className="faint">{age(c.when)}</span>
        </button>
      ))}
      {more}
    </span>
  );
}

/** The map in small, the view's frame over it, like MiniMap in BranchMap.tsx: a click goes there. */
export function MiniMap({ layout, shown, canvas, zoom }: { layout: MapLayout; shown: string; canvas: RefObject<HTMLDivElement | null>; zoom: number }) {
  const frame = useRef<HTMLSpanElement>(null);
  const scale = Math.min(156 / layout.W, 102 / layout.H);
  const lin = new Set(lineageOf(layout, shown));
  // The frame follows the canvas's scroll and size, outside React: a scroll redraws nothing else.
  useLayoutEffect(() => {
    const el = canvas.current;
    const f = frame.current;
    if (!el || !f) return;
    const place = () => {
      const [vx, vy, vw, vh] = [el.scrollLeft / zoom, el.scrollTop / zoom, el.clientWidth / zoom, el.clientHeight / zoom];
      f.style.left = `${10 + vx * scale}px`;
      f.style.top = `${8 + vy * scale}px`;
      f.style.width = `${Math.max(0, Math.min(layout.W, vx + vw) - vx) * scale}px`;
      f.style.height = `${Math.max(0, Math.min(layout.H, vy + vh) - vy) * scale}px`;
    };
    place();
    el.addEventListener('scroll', place, { passive: true });
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', place);
      ro.disconnect();
    };
  }, [canvas, zoom, scale, layout.W, layout.H]);
  return (
    <button
      className="map-mini"
      aria-label="Map overview: click to go there"
      onClick={(e) => {
        const el = canvas.current;
        if (!el) return;
        const r = e.currentTarget.getBoundingClientRect();
        el.scrollTo({ left: ((e.clientX - r.left - 10) / scale) * zoom - el.clientWidth / 2, top: ((e.clientY - r.top - 8) / scale) * zoom - el.clientHeight / 2, behavior: 'smooth' });
      }}
    >
      <span className="map-mini-in" aria-hidden="true">
        {layout.tiles.map((t) => (
          <span
            key={t.b.name}
            data-k={t.b.name === shown ? 'sel' : lin.has(t.b.name) ? 'lin' : t.b.role}
            style={{ left: Math.round(10 + t.x * scale), top: Math.round(8 + t.y * scale), width: Math.max(3, Math.round(t.w * scale)), height: Math.max(2, Math.round(t.h * scale)) }}
          />
        ))}
      </span>
      <span ref={frame} className="map-mini-frame" />
    </button>
  );
}

/** What the lines' colours mean; `hint` adds what a click on the map does. */
export function MapLegend({ hint = true }: { hint?: boolean }) {
  return (
    <div className="map-legend">
      <span><svg width="20" height="8" aria-hidden="true"><path d="M2 4h16" className="map-key-head" /></svg>You are here</span>
      <span><svg width="20" height="8" aria-hidden="true"><path d="M2 4h16" className="map-key-lin" /></svg>Selected line</span>
      <span><svg width="20" height="8" aria-hidden="true"><path d="M2 4h16" className="map-key-stale" /></svg>Falling behind</span>
      {hint && <span className="faint">Click a commit or a WIP count to look at its code</span>}
    </div>
  );
}
