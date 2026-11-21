import { Fragment, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Icon } from '../../../../src/components/Icon';
import { plural } from '../../../../src/lib/format';
import type { Branch, Commit } from '../HeroDemo';
import { Avatar, Modal } from './ui';

/**
 * The demo's copy of src/screens/BranchMap.tsx, drawn from the demo's branches: the same layout, markup and class names, so
 * the app's own rules (demo.css) draw it. Simpler where a web page differs: the wheel scrolls the page instead of zooming,
 * and the map sits at the canvas's top left instead of in the middle of empty room.
 */

/** Branches this many commits behind their base count as falling behind. */
export const BEHIND_LIMIT = 25;
/** Commits a box lists under it; the rest are counted, listed once "see all" is open. */
const COMMITS_SHOWN = 4;
/** Merged branches listed under their base before "+N more". */
const MERGED_SHOWN = 4;
/** Shipped releases listed on the trunk before "+N earlier releases". */
const SHIPPED_SHOWN = 10;
/** The trunk: a hairline at TRUNK_X, shipped releases on it as stations PITCH apart (oldest on top), then the default branch. */
const TRUNK_X = 26;
const PITCH = 36;
const TOP = 48;
const TRUNK_GAP = 16;
/** Between boxes of one parent, and between the groups of different parents. */
const GAP = 28;
const GROUP_GAP = 40;
/** A box: a header row and one info row; releases and trunks have a taller header, for their big name. */
const BOX_H = 60;
const REL_H = 74;
/** Floating commits: this far under their box, one row each (and the "see all" row). */
const FLOAT_TOP = 6;
const ROW = 22;
/** Merged branches: small stations under the commits, MERGED_ROW apart; their foot (more, clean up) after them. */
const MERGED_TOP = 24;
const MERGED_ROW = 26;
const FOOT_H = 26;
/** A shipped release's commits, unfolded under its station: two lines each. */
const SHIPPED_LIST_TOP = 14;
const SHIPPED_COMMIT_H = 32;
/** Room the selected branch's column (its card, and its files under it) takes on the right: its width and gap. */
export const CARD_ROOM = 376;
/** Column `d` of the map: the default branch's box beside the trunk, then each level of branches under it. */
const colX = (d: number) => (d === 0 ? TRUNK_X + 20 : 404 + (d - 1) * 392);
const colW = (d: number) => (d === 0 ? 280 : 320);
const big = (b: Branch) => b.role !== 'branch';
/** Where lines meet a box: its header row's middle. */
const anchorOf = (b: Branch) => (big(b) ? 26 : 19);

export type MapPrefs = { who: 'all' | 'me'; merged: boolean; behind: boolean; shipped: boolean };
export const PREFS: MapPrefs = { who: 'all', merged: true, behind: true, shipped: true };
/** A release shipped from the trunk: its tag, the day it shipped, and the commits it shipped (newest first). */
export type Shipped = { tag: string; date: string; commits: Commit[] };
export type AgentInfo = { label: string; state?: 'working' | 'waiting' | 'done' };

export type Tile = {
  b: Branch;
  d: number;
  x: number;
  y: number;
  w: number;
  /** The box's height: its header and info rows. Its commits float under it. */
  h: number;
  /** Where edges meet it, down from its top. */
  a: number;
  /** Kept, faded, only for a shown branch below it. */
  ghost: boolean;
  /** Its newest commits float under the box, the earlier ones too when `all`. */
  open: boolean;
  all: boolean;
  /** Merged branches hung under it as small stations, how many more there are, and the ones a clean up may delete. */
  merged: Branch[];
  more: number;
  removable: Branch[];
  /** Its first merged station's middle, and the top of the row under the last one (more, clean up). */
  mergedY: number;
  footY: number;
  foot: boolean;
};
export type MapLayout = ReturnType<typeof layoutMap>;

/**
 * Lays the map out like layoutMap in BranchMap.tsx. The trunk is a vertical line: the shipped releases on it as stations,
 * oldest on top, then the default branch's station, its box beside it. Every other branch is a box in the column of its
 * level, level with the middle of its children; its newest commits float under it, its merged branches hang under those.
 * `toggles`: boxes listing all their commits (`all:<name>`), merged groups shown whole (`merged:<name>`), every shipped
 * release (`shipped:all`), a shipped release's commits unfolded (`rel:<tag>`).
 */
export function layoutMap(bs: Record<string, Branch>, head: string, prefs: MapPrefs, me: string, toggles: ReadonlyMap<string, boolean>, shipped: Shipped[]) {
  const kids = (n: string) => (bs[n]?.kids ?? []).flatMap((k) => bs[k] ?? []);
  const parent = (n: string) => bs[n]?.base;
  const mine = (b: Branch) => b.author === me;
  const stale = (b: Branch) => b.role === 'branch' && !b.merged && b.behind >= BEHIND_LIMIT;
  const passes = (b: Branch) => (prefs.behind || !stale(b)) && (prefs.who === 'all' || mine(b));
  // A merged branch with nothing live left on it is a station under its base, not a box.
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

  const boxH = (b: Branch) => (big(b) ? REL_H : BOX_H);
  const listed = (b: Branch) => (toggles.get(`all:${b.name}`) ? b.ahead : Math.min(b.ahead, COMMITS_SHOWN));
  // The commits floating under the box: its rows, and "see all" past the newest few.
  const listH = (b: Branch) => (listed(b) ? FLOAT_TOP + listed(b) * ROW + (b.ahead > COMMITS_SHOWN ? ROW : 0) : 0);
  const mergedOf = (b: Branch) => (prefs.merged ? kids(b.name).filter((k) => chip(k) && (prefs.who === 'all' || mine(k))) : []);
  // The checked-out branch stays put.
  const removableOf = (all: Branch[]) => all.filter((c) => c.name !== head);
  const shownMerged = (b: Branch, all: Branch[]) => (toggles.get(`merged:${b.name}`) ? all.length : Math.min(all.length, MERGED_SHOWN));
  // The whole block: the box, its commits, its merged stations and their foot.
  const blockH = (b: Branch) => {
    const all = mergedOf(b);
    const shown = shownMerged(b, all);
    const foot = all.length > shown || removableOf(all).length > 0;
    const top = boxH(b) + listH(b);
    return all.length ? top + MERGED_TOP + (shown - 1) * MERGED_ROW + 12 + (foot ? 4 + FOOT_H : 0) : top;
  };

  // Under the "Shipped from" label (and "+N earlier releases"), a station per release; an unfolded one pushes the next down by its list.
  const earlier = prefs.shipped ? Math.max(0, shipped.length - SHIPPED_SHOWN) : 0;
  const rows = prefs.shipped ? shipped.slice(0, toggles.get('shipped:all') ? undefined : SHIPPED_SHOWN).reverse() : [];
  let cy = TOP + 40 + (earlier ? 24 : 0);
  const shippedAt = rows.map((r) => {
    const n = toggles.get(`rel:${r.tag}`) ? r.commits.length : 0;
    const box = n ? n * SHIPPED_COMMIT_H + (n - 1) * 2 : 0;
    const y = cy;
    cy += PITCH + (n ? SHIPPED_LIST_TOP + box : 0);
    return { r, y, list: n ? { box } : undefined };
  });
  // The default branch's station: a pitch and a gap after the latest shipped one, its box's header level with it.
  const trunkY = rows.length ? cy + TRUNK_GAP - 26 : TOP;

  const at = new Map<string, Tile>();
  const tiles: Tile[] = [];
  const bottom: number[] = [];
  const last: (string | undefined)[] = [];
  const place = (b: Branch, d: number, floor: number, par: string) => {
    const h = boxH(b);
    const a = anchorOf(b);
    const gap = last[d] === undefined ? 0 : last[d] === par ? GAP : GROUP_GAP;
    let pMin = Math.max(floor, (bottom[d] ?? TOP) + gap);
    const isTrunk = b.role === 'trunk';
    if (isTrunk) pMin = Math.max(pMin, trunkY);
    const ks = live(b).filter((k) => vis.has(k.name));
    let y = pMin;
    if (ks.length) {
      const span = ks.slice(0, -1).reduce((n, k) => n + blockH(k) + GAP, 0);
      const kidFloor = Math.max(TOP, floor, pMin + a - (anchorOf(ks[0]) + span + anchorOf(ks[ks.length - 1])) / 2);
      for (const k of ks) place(k, d + 1, kidFloor, b.name);
      // The default branch stays on its station; any other parent sits level with the middle of its children.
      if (!isTrunk) {
        const f = at.get(ks[0].name)!;
        const l = at.get(ks[ks.length - 1].name)!;
        y = Math.max(pMin, Math.round((f.y + f.a + l.y + l.a) / 2 - a));
      }
    }
    last[d] = par;
    const all = mergedOf(b);
    const shown = shownMerged(b, all);
    const removable = removableOf(all);
    const list = listH(b);
    const mergedY = y + h + list + MERGED_TOP;
    const t: Tile = {
      b, d, x: colX(d), y, w: colW(d), h, a, ghost: ghost.has(b.name), open: list > 0, all: !!toggles.get(`all:${b.name}`),
      merged: all.slice(0, shown), more: all.length - shown, removable,
      mergedY, footY: mergedY + (shown - 1) * MERGED_ROW + 16, foot: all.length > shown || removable.length > 0,
    };
    at.set(b.name, t);
    tiles.push(t);
    bottom[d] = y + blockH(b);
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
  const lowest = Math.max(TOP, ...bottom.filter((n) => n !== undefined));
  const trunkAnchor = trunk ? trunk.y + trunk.a : TOP;
  return {
    tiles,
    at,
    W: colX(depth) + colW(depth) + 24,
    H: lowest + 40,
    depth,
    shipped: trunk ? shippedAt : [],
    shippedAll: shipped,
    shippedEarlier: earlier,
    trunkTop: trunk && shippedAt.length ? shippedAt[0].y : trunkAnchor,
    // The spine ends just under the default branch's own block (its commits, merged branches), not the map's bottom.
    trunkEnd: trunk ? Math.max(trunkAnchor + 40, trunk.y + blockH(trunk.b) + 24) : trunkAnchor,
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

/** Whether the map draws `n`, as a box or as a merged station under one. */
export const onMap = (layout: MapLayout, n: string) => layout.at.has(n) || layout.tiles.some((t) => t.merged.some((m) => m.name === n));

/** "3 branches", "1 merged branch": plural() would add an "s". */
export const branches = (n: number, what = 'branch') => `${n} ${what}${n === 1 ? '' : 'es'}`;

/** "2h ago" as a box lists it: "2h". */
const age = (when: string) => when.replace(' ago', '').replace('just now', 'now');

/** What the map's buttons do; the static copy on the home page has none. */
export type MapHandlers = {
  select: (n: string) => void;
  checkout: (n: string) => void;
  /** A fold: all of a box's commits (`all:`), a merged group (`merged:`), a shipped release's commits (`rel:`), every release (`shipped:all`). */
  toggle: (key: string, on: boolean) => void;
  /** A commit listed under a box, or shipped with a release (on the trunk): look at its code. */
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
  /** Folds as the map shows them: the shipped releases unfolded. */
  toggles?: ReadonlyMap<string, boolean>;
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

const agentWords = (a: AgentInfo) => (a.state === 'working' ? 'working' : a.state === 'waiting' ? 'waiting for you' : a.state === 'done' ? 'done, ready to review' : 'idle');

/** The map itself, inside `.map-layer`: columns, the trunk and its stations, lines, boxes and what hangs off them. */
export function MapLayer({ layout, head, shown, toggles, q, hit, agentOf, logOf, labelOf, on }: LayerProps) {
  const { tiles, at } = layout;
  // The route: the checked-out branch's line, from the trunk's station to it.
  const route = new Set(lineageOf(layout, head));
  const trunk = tiles.find((t) => t.b.role === 'trunk');
  // Edges run from a parent's right side to its child's left: hairlines, the route's a little heavier. Behind its parent, a branch's line carries a chip.
  const edges: { d: string; cls: string }[] = [];
  const chips: { x: number; y: number; b: Branch; onto: string; cls: string }[] = [];
  for (const t of tiles) {
    const pn = layout.parent(t.b.name);
    const p = pn ? at.get(pn) : undefined;
    if (!p || !pn) continue;
    const [x1, y1, x2, y2] = [p.x + p.w, p.y + p.a, t.x, t.y + t.a];
    const dx = (x2 - x1) / 2;
    const cls = route.has(t.b.name) ? 'head' : layout.stale(t.b) ? 'stale' : t.ghost ? 'far' : '';
    edges.push({ d: `M${x1} ${y1}C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`, cls });
    if (t.b.behind > 0 && !t.b.merged) chips.push({ x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2), b: t.b, onto: pn, cls });
  }
  const cols = Array.from({ length: layout.depth + 1 }, (_, d) => (d === 0 ? 'Trunk' : d === 1 ? `Releases & straight to ${trunk?.b.name ?? 'main'}` : d === 2 ? 'Branches' : 'Stacked'));
  const tip = layout.shippedAll[0]?.tag;
  const releases = tiles.filter((x) => x.b.role === 'release').length;

  return (
    <>
      {cols.map((c, d) => (
        <span key={d} className="map-col" style={{ left: d === 0 ? TRUNK_X - 6 : colX(d) }}>{c}</span>
      ))}

      <svg className="map-edges" width={layout.W} height={layout.H} aria-hidden="true">
        {/* The trunk: one hairline down through the shipped releases, the default branch and its merged branches, ending on a tick. */}
        {trunk && <path className="map-trunk-line" d={`M${TRUNK_X} ${layout.trunkTop}V${layout.trunkEnd}`} />}
        {trunk && <path className="map-trunk-line" d={`M${TRUNK_X - 10} ${layout.trunkEnd - 10}l20 20`} />}
        {/* The route starts at the default branch's station: across to its box. */}
        {trunk && <path d={`M${TRUNK_X} ${trunk.y + trunk.a}H${trunk.x}`} data-line="head" />}
        {edges.map((e, i) => <path key={i} d={e.d} data-line={e.cls || undefined} />)}
        {/* A box's merged branches hang on a hairline dropping from its station; the default branch's sit on the trunk. */}
        {tiles.map((t) => t.merged.length > 0 && t.b.role !== 'trunk' && <path key={`m${t.b.name}`} d={`M${t.x} ${t.y + t.a}V${t.mergedY + (t.merged.length - 1) * MERGED_ROW}`} />)}
      </svg>

      {trunk && layout.shipped.length > 0 && (
        <>
          <span className="map-history-head" style={{ left: TRUNK_X - 6, top: TOP - 6 }}>Shipped from {trunk.b.name} · {layout.shippedAll.length}</span>
          {layout.shippedEarlier > 0 && (
            <button className="map-more" style={{ left: TRUNK_X - 10, top: TOP + 22 }} aria-expanded={!!toggles?.get('shipped:all')} onClick={() => on?.toggle('shipped:all', !toggles?.get('shipped:all'))}>
              {toggles?.get('shipped:all') ? 'Show the latest' : `+${plural(layout.shippedEarlier, 'earlier release')}`}
            </button>
          )}
          {layout.shipped.map(({ r, y, list }, i) => {
            const latest = i === layout.shipped.length - 1;
            const words = `the ${plural(r.commits.length, 'commit')} ${r.tag} shipped`;
            return (
              <Fragment key={r.tag}>
                <span className="map-stn" data-lit={latest || undefined} style={{ left: TRUNK_X, top: y }} />
                <div className="map-ship-row" style={{ left: TRUNK_X + 14, top: y - 12 }}>
                  <button className="map-ship" data-new={latest || undefined} title={`Tagged ${r.tag} on ${trunk.b.name}. Double-click to check it out.`} onClick={(e) => e.detail < 2 && on?.toggle(`rel:${r.tag}`, !list)} onDoubleClick={() => on?.tag(r.tag)}>
                    <span className="mono ellipsis">{marked(r.tag, q, false)}</span>
                    <span className="map-ship-date">{r.date}</span>
                  </button>
                  <button className="map-ship-count" aria-expanded={!!list} aria-label={`${list ? 'Hide' : 'See'} the commits in ${r.tag}`} title={`${list ? 'Hide' : 'See'} ${words}`} onClick={() => on?.toggle(`rel:${r.tag}`, !list)}>
                    {plural(r.commits.length, 'commit')}
                    <Icon name="chevronDown" size={12} className="chev" />
                  </button>
                </div>
                {list && (
                  <div className="map-ship-list" role="group" aria-label={`Commits in ${r.tag}`} style={{ top: y + SHIPPED_LIST_TOP, left: TRUNK_X + 18, width: colX(0) + colW(0) - TRUNK_X - 18, height: list.box }}>
                    {r.commits.map((c) => (
                      <div key={c.sha} className="map-relrow">
                        <button className="map-hitbox" aria-label={`Look at commit ${c.sha}, ${c.subject}`} onClick={() => on?.look(trunk.b.name, c)} />
                        <span className="map-relrow-subject ellipsis">{c.subject}</span>
                        <span className="map-relrow-meta">
                          <span className="map-who"><Avatar name={c.author} size={14} />{c.when}</span>
                          <span className="map-sha mono">{c.sha}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Fragment>
            );
          })}
        </>
      )}
      {/* The default branch's station: where the route starts. */}
      {trunk && <span className="map-stn" data-main="" style={{ left: TRUNK_X, top: trunk.y + trunk.a }} />}

      {tiles.map((t) => {
        if (!t.merged.length && !t.foot) return null;
        // The default branch's merged branches sit on the trunk; any other box's on the hairline under its station.
        const sx = t.b.role === 'trunk' ? TRUNK_X : t.x;
        return (
          <Fragment key={`mg${t.b.name}`}>
            {t.merged.map((m, i) => (
              <Fragment key={m.name}>
                <span className="map-stn" data-small="" style={{ left: sx, top: t.mergedY + i * MERGED_ROW }} />
                <button
                  className="map-merged"
                  aria-pressed={m.name === shown}
                  aria-label={`Select ${m.name}, merged`}
                  style={{ left: sx + 14, top: t.mergedY + i * MERGED_ROW - 12, maxWidth: t.x + t.w - sx - 14 }}
                  onClick={() => on?.select(m.name)}
                  onContextMenu={(e) => on?.menu(m.name, e)}
                >
                  <Icon name="check" size={12} />
                  <span className="mono ellipsis">{marked(m.name, q, hit === m.name)}</span>
                  <span className="tag">Merged</span>
                </button>
              </Fragment>
            ))}
            {t.foot && (
              <span className="map-merged-foot" style={{ left: sx + 14, top: t.footY }}>
                {t.more > 0 && <button className="map-more" onClick={() => on?.toggle(`merged:${t.b.name}`, true)}>+{t.more} more merged</button>}
                {t.merged.length > MERGED_SHOWN && <button className="map-more" onClick={() => on?.toggle(`merged:${t.b.name}`, false)}>Show fewer</button>}
                {t.removable.length > 0 && (
                  <button className="btn map-clean-big" title={`Delete the ${branches(t.removable.length, 'merged branch')} under ${labelOf(t.b.name)}, locally and on origin`} onClick={() => on?.cleanup(t.b.name, t.removable)}>
                    Clean up merged
                  </button>
                )}
              </span>
            )}
          </Fragment>
        );
      })}

      {tiles.map((t) => (
        <Fragment key={t.b.name}>
          <TileView
            t={t}
            head={head}
            selected={t.b.name === shown}
            onRoute={route.has(t.b.name)}
            stale={layout.stale(t.b)}
            q={q}
            hitAt={hit === t.b.name}
            agent={agentOf?.(t.b.name)}
            log={logOf(t.b)}
            labelOf={labelOf}
            tip={t.b.role === 'trunk' ? tip : undefined}
            releases={releases}
            quietAdd={!route.has(t.b.name) && !layout.kids(t.b.name).length}
            on={on}
          />
          {t.open && (
            <div className="map-float" style={{ left: t.x + (t.b.role === 'trunk' ? 14 : 18), top: t.y + t.h + FLOAT_TOP, width: t.w - (t.b.role === 'trunk' ? 14 : 18) }}>
              <TileCommits b={t.b} log={logOf(t.b)} all={t.all} current={t.b.name === head} on={on} />
            </div>
          )}
        </Fragment>
      ))}
      {chips.map(({ x, y, b, onto, cls }) => {
        const text = <span className="c-del">↓{b.behind}</span>;
        const props = { className: 'map-line-chip', 'data-line': cls || undefined, style: { left: x, top: y } };
        const words = `${b.ahead ? `${plural(b.ahead, 'commit')} ahead of ${labelOf(onto)}, ` : ''}${b.behind} behind`;
        // A work branch rebases onto its parent from its chip, unless its agent works; shared ones catch up by merging.
        if (b.role !== 'branch' || !on) return <span key={b.name} {...props} title={words}>{text}</span>;
        const busy = agentOf?.(b.name)?.state === 'working';
        return (
          <button
            key={b.name}
            {...props}
            aria-disabled={busy || undefined}
            aria-label={busy ? `Can't rebase ${labelOf(b.name)} onto ${labelOf(onto)} while its agent is working` : `Rebase ${labelOf(b.name)} onto ${labelOf(onto)}`}
            title={busy ? `${words}. Can't rebase ${labelOf(b.name)} onto ${labelOf(onto)} while its agent is working. Wait until it finishes or asks you a question.` : `${words}. Click to rebase onto ${labelOf(onto)}.`}
            onClick={() => !busy && on.rebase(b.name, onto)}
          >
            {text}
          </button>
        );
      })}
    </>
  );
}

/**
 * One branch on the map, like TileView in BranchMap.tsx: a box with a header row (its type, name and the state worth a tag)
 * and one info row (its agent, uncommitted work and other facts, never commits). Its station sits on its left border where
 * its line comes in, its "+" on its right where lines leave; its commits float under it, drawn apart (TileCommits).
 */
function TileView({ t, head, selected, onRoute, stale, q, hitAt, agent, log, labelOf, tip, releases, quietAdd, on }: { t: Tile; head: string; selected: boolean; onRoute: boolean; stale: boolean; q?: string; hitAt: boolean; agent?: AgentInfo; log: Commit[]; labelOf: (n: string) => string; tip?: string; releases: number; quietAdd: boolean; on?: MapHandlers }) {
  const { b } = t;
  const current = b.name === head;
  const trunk = b.role === 'trunk';
  const parent = b.base ?? '';
  // The info row: the agent, then the uncommitted work, then the rest.
  const info: ReactNode[] = [];
  if (agent?.state === 'working')
    info.push(
      <span key="agent">
        <span className="pulse glow-dot" />
        <span className="glow-working"><span>{agent.label} working</span></span>
      </span>,
    );
  else if (agent?.state)
    info.push(
      <span key="agent">
        {agent.state === 'waiting' ? <span className="pulse map-wait" /> : <Icon name="check" size={12} className="c-add" />}
        {agent.label} {agentWords(agent)}
      </span>,
    );
  if (b.wip.length)
    info.push(
      <span key="wip" className="map-wip">
        <span className="map-wip-dot" />
        WIP {b.wip.length}
        {' · '}
        <b className="c-add">+{b.wip.reduce((n, f) => n + f.add, 0)}</b> <b className="c-del">−{b.wip.reduce((n, f) => n + f.del, 0)}</b>
      </span>,
    );
  if (trunk) {
    if (tip) info.push(b.ahead ? `${plural(b.ahead, 'commit')} since ${tip}` : `at ${tip}`);
    if (releases) info.push(`${plural(releases, 'release')} open`);
  } else if (b.role === 'release') {
    info.push(b.name);
    if (parent) info.push(`from ${labelOf(parent)}`);
    if (log[0]) info.push(log[0].when);
  } else {
    if (b.wt && !agent && !current)
      info.push(
        <button key="wt" className="map-info-btn" title="Its own worktree. Click to open it in Worktrees & agents." onClick={() => on?.worktree(b.name)}>
          <Icon name="layers" size={12} />
          worktree
        </button>,
      );
    if (stale)
      info.push(
        <span key="idle" title={`${labelOf(parent)} is ${plural(b.behind, 'commit')} ahead`}>
          <Icon name="alert" size={12} className="c-warn" />
          {b.idle && b.idle > 1 ? `idle ${b.idle} days · ` : ''}falling behind {labelOf(parent)}
        </span>,
      );
    if (!b.ahead && !b.wip.length && !agent) info.push('no commits yet');
  }
  if (b.push) info.push(`↑${b.push} to push`);
  if (b.stashes)
    info.push(
      <button key="stash" className="map-info-btn" title={`${b.stashes} stashes made on ${b.name}`} onClick={() => on?.stashes(b.name)}>
        <Icon name="stash" size={12} />
        {b.stashes}
      </button>,
    );
  // Nothing else to say: when it last moved.
  if (!info.length && log[0]) info.push(log[0].when);

  const name = b.role === 'branch' && b.kind ? b.name.slice(b.kind.length + 1) : b.name;
  return (
    <div
      className="map-tile"
      data-role={b.role}
      data-trunk={trunk || undefined}
      data-sel={selected || undefined}
      data-head={current || undefined}
      data-ghost={t.ghost || undefined}
      data-stale={stale || undefined}
      data-hit={hitAt || undefined}
      style={{ left: t.x, top: t.y, width: t.w, height: t.h }}
      onContextMenu={(e) => on?.menu(b.name, e)}
    >
      <button className="map-hitbox" aria-pressed={selected} aria-label={`Select ${b.name}${t.ghost ? ', shown for what is under it' : ''}`} onClick={() => on?.select(b.name)} onDoubleClick={() => !b.wt && on?.checkout(b.name)} />
      {/* The default branch's station is on the trunk; every other box's on its left border, where its line comes in. */}
      {!trunk && <span className="map-stn" data-on={onRoute ? (current ? '' : 'via') : undefined} />}
      <div className="map-tile-in">
        <span className="map-row">
          {big(b) ? (
            <span className="map-ver">{marked(labelOf(b.name), q, hitAt)}</span>
          ) : (
            <>
              {b.kind && <span className="map-kind">{b.kind}</span>}
              <span className="map-name mono ellipsis">{marked(name, q, hitAt)}</span>
            </>
          )}
          {trunk && !current && <span className="tag">Default</span>}
          {b.tag && <span className={b.tag === 'Next' ? 'tag inv' : 'tag'}>{b.tag}</span>}
        </span>
        <span className="map-info">
          {info.map((x, i) => (
            <Fragment key={i}>
              {i > 0 && ' · '}
              {x}
            </Fragment>
          ))}
        </span>
      </div>
      {/* Starts a branch off it, where its lines leave. */}
      <button className="map-out" data-quiet={quietAdd || undefined} aria-label={`Create a branch from ${b.name}`} title="Create a branch from here" onClick={() => on?.create(b.name)}>
        <Icon name="plus" size={12} />
      </button>
    </div>
  );
}

/** A box's newest commits, floating under it with no container, like TileCommits in BranchMap.tsx; the earlier ones once "see all" is open. */
function TileCommits({ b, log, all, current, on }: { b: Branch; log: Commit[]; all?: boolean; current: boolean; on?: MapHandlers }) {
  const total = b.ahead;
  // A commit's own menu, not the box's under it.
  const menu = (e: MouseEvent) => {
    e.stopPropagation();
    on?.menu(b.name, e);
  };
  return (
    <>
      {log.slice(0, all ? total : Math.min(total, COMMITS_SHOWN)).map((c, i) => (
        // The commit checked out: the newest one, here.
        <button key={c.sha} className="map-crow" data-on={(current && i === 0) || undefined} aria-label={`Look at commit ${c.sha}, ${c.subject}`} onClick={() => on?.look(b.name, c)} onContextMenu={menu}>
          <Avatar name={c.author} size={12} />
          <span className="ellipsis">{c.subject}</span>
          <i>{age(c.when)}</i>
        </button>
      ))}
      {total > COMMITS_SHOWN && (
        <button className="map-crow-more" aria-expanded={!!all} onClick={() => on?.toggle(`all:${b.name}`, !all)}>
          {all ? 'Show fewer' : `See all ${total}`}
        </button>
      )}
    </>
  );
}

/** What the lines mean, in a band under the map (the home page's); `behind`: the falling-behind line too, `hint`: what a click on the map does. */
export function MapLegend({ hint = true, behind = true }: { hint?: boolean; behind?: boolean }) {
  return (
    <div className="map-legend">
      <span><svg width="20" height="8" aria-hidden="true"><path d="M2 4h16" className="map-key-head" /></svg>You are here</span>
      <span><svg width="20" height="8" aria-hidden="true"><path d="M2 4h16" /></svg>Other lines</span>
      {behind && <span><svg width="20" height="8" aria-hidden="true"><path d="M2 4h16" className="map-key-stale" /></svg>Falling behind</span>}
      {hint && <span className="faint">Click a commit to look at its code · click ↓ on a line to rebase</span>}
    </div>
  );
}

/** The line styles and chips, a mark then its words, as LEGEND_KEYS in BranchMap.tsx says them. */
const LEGEND_KEYS: [ReactNode, string][] = [
  [<svg width="20" height="8" aria-hidden="true"><path d="M2 4h16" className="map-key-head" /></svg>, 'You are here'],
  [<svg width="20" height="8" aria-hidden="true"><path d="M2 4h16" /></svg>, 'Other lines'],
  [<svg width="20" height="8" aria-hidden="true"><path d="M2 4h16" className="map-key-stale" /></svg>, 'Falling behind'],
  [<span className="map-line-chip"><span className="c-del">↓</span></span>, 'on a line, click to rebase'],
];

/** The demo's legend, as the app's MapLegend: a box over the map's bottom left, on one line; keys past its width wrap out of
 *  sight, and "See all" lists every one. */
export function MapLegendBox() {
  const keys = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState(false);
  const [all, setAll] = useState(false);
  useLayoutEffect(() => {
    const el = keys.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCut(el.scrollHeight > el.clientHeight + 1));
    [el, ...el.children].forEach((c) => ro.observe(c));
    return () => ro.disconnect();
  }, []);
  return (
    <div className="map-legend map-legend-box">
      <div ref={keys} className="map-legend-keys">
        {LEGEND_KEYS.map(([mark, words]) => (
          <span key={words}>{mark}{words}</span>
        ))}
      </div>
      {cut && (
        <button className="link-btn map-legend-all" aria-haspopup="dialog" onClick={() => setAll(true)}>
          See all
        </button>
      )}
      {all && (
        <Modal title="Legend" width={360} onClose={() => setAll(false)}>
          <ul className="map-legend-list">
            {LEGEND_KEYS.map(([mark, words]) => (
              <li key={words}>{mark}{words}</li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  );
}
