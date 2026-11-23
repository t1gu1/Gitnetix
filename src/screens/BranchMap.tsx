import { useIsFetching, useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";

import { useCleanupLeft } from "../lib/cleanups";
import { useAction, useAgents, useCommits, useConfig, useFiles, useMapCommits, useOverviewProgress, usePrDetails, usePrs, useReleaseCommitLists, useReleaseCommits, useReleaseCounts, useTagV, useTicket } from "../api/hooks";
import { openExternal, rpc } from "../api/transport";
import type { BranchView, Commit, MapCommits, Overview, RebaseRun, ReleaseCount, ReleaseView } from "../api/types";
import { Avatar } from "../components/Avatar";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { FindBar, Modal, releaseTagLabel, Seg, useFindKey } from "../components/ui";
import { shownStatus, type ShownStatus } from "../lib/agentLog";
import { ago, plural, stashCount } from "../lib/format";
import { showKeys, useKeys } from "../lib/keys";
import { useNav } from "../lib/nav";
import { PR_TONE_LABEL, prTone, type PrTone } from "../lib/prStatus";
import { lockTip, showRun, useRebasing } from "../lib/rebaseRuns";
import { useStored, useStoredChoice } from "../lib/stored";
import { copyToClipboard } from "../lib/toast";
import type { BranchActions, BranchTarget } from "./BranchMenu";
import { useCommitMenu } from "./CommitMenu";
import { openPrOf } from "./PullRequests";

/** Branches this many commits behind their base count as falling behind. */
const BEHIND_LIMIT = 25;
/** Commits an unfolded tile lists; the rest are counted, listed once "see all" is open. */
const COMMITS_SHOWN = 4;
/** Commits "see all" lists at most where the count can be a whole history: the default branch with no tag, a first release. */
const HISTORY_MAX = 200;
/** A tile's own commits: those not in its base, or the default branch's not released yet (since its latest tag). */
const ownCommits = (b: BranchView) => b.ahead || (b.unreleased ?? 0);
/** A tile's commit rows: its own, and origin's not pulled yet above them; what a merge brought in folds under its row. */
const commitRows = (b: BranchView) => ownCommits(b) + b.upstreamBehind - (b.folded ?? 0);
/** Commit rows an unfolded tile lists: the newest few, or all once "see all" is open. */
const listedRows = (b: BranchView, all: boolean) => Math.min(commitRows(b), all ? (b.parent ? Infinity : HISTORY_MAX) : COMMITS_SHOWN);
/** The trunk the map starts from: the default branch, or a trunk further behind it (`prod` left of `main`). */
const isRoot = (b: BranchView) => b.role === "trunk" && !b.parent;
/** The default branch's list, when whole, ends on the latest tag: the release its commits came after. */
const endsOnTag = (b: BranchView, listed: number) => !b.parent && !!b.lastTag && listed === commitRows(b);
/** A count as a pill shows it: a whole history counted up to 1000 reads "999+". */
const countLabel = (n: number) => (n >= 1000 ? "999+" : String(n));
/** Shipped releases listed on the trunk before "+N earlier releases". */
const SHIPPED_SHOWN = 10;
/** The trunk: a hairline at TRUNK_X, shipped releases on it as stations PITCH apart (oldest on top), then the default branch. */
const TRUNK_X = 26;
const PITCH = 36;
const TOP = 48;
/** Extra room between the latest shipped release and the default branch's station. */
const TRUNK_GAP = 16;
/** Between boxes of one parent, and between the groups of different parents. */
const GAP = 28;
const GROUP_GAP = 40;
/** A box: a header row and one info row; releases and trunks have a taller header, for their big name. */
const BOX_H = 60;
const REL_H = 74;
const big = (b: BranchView) => b.role === "release" || b.role === "trunk";
/** Floating commits: this far under their box, one row each (and the "see all" and tag rows). */
const FLOAT_TOP = 6;
const ROW = 22;
/** Merged branches: one small station under the commits, folded to "N merged branches"; opened, a row each, MERGED_ROW apart. */
const MERGED_TOP = 24;
const MERGED_ROW = 24;
/** Commits hang this much further right when the merged line runs down past them, so their avatars clear it. */
const RAIL_GAP = 6;
/** Past this many tiles the map draws only those near the view: small maps keep them all, for the keyboard and screen readers. */
const CULL_FROM = 200;
/** A shipped release's commits, unfolded under its station: two lines each, under the row's middle. */
const SHIPPED_LIST_TOP = 14;
const SHIPPED_COMMIT_H = 32;
/** A commit there a branch started from is a box: this much taller than a row, its margins included (see `.map-relrow[data-fork]`). */
const FORK_EXTRA = 20;
/** Room the floating card takes on the right (its width and gap): the map scrolls out from under it. */
const CARD_ROOM = 376;
/** Column `d` of the map: the default branch's box beside the trunk, then each level of branches under it. */
const colX = (d: number) => (d === 0 ? TRUNK_X + 20 : 404 + (d - 1) * 392);
const colW = (d: number) => (d === 0 ? 280 : 320);
/** Where lines meet a box: its header row's middle (border, padding, half the row). */
const anchorOf = (b: BranchView) => (big(b) ? 26 : 19);

/** What the focus view opens on: uncommitted work, all the branch's changes, one commit, or the project's files. */
export type FocusItem = "wip" | "all" | "project" | Commit;

type Who = "all" | "me";
interface MapPrefs {
  who: Who;
  merged: boolean;
  behind: boolean;
  shipped: boolean;
  zoom: number;
  /** What the search looks through: branch and tag names, commits. */
  findBranches: boolean;
  findCommits: boolean;
}
const PREFS: MapPrefs = { who: "me", merged: false, behind: false, shipped: true, zoom: 1, findBranches: true, findCommits: true };

/** The map's filters and zoom, kept between sessions. */
function useMapPrefs() {
  const [p, set] = useStored<MapPrefs>("gnx.map", PREFS, (s) => ({ ...PREFS, ...JSON.parse(s) }));
  return [p, (next: Partial<MapPrefs>, persist = true) => set({ ...p, ...next }, persist)] as const;
}

/** The email "Mine" goes by: the profile's Git identity, else what Git commits with. */
function useMe() {
  const prof = useConfig().data?.profiles[0];
  const git = useQuery({ queryKey: ["gitIdentity"], queryFn: () => rpc<{ name: string; email: string }>("git.identity"), staleTime: Infinity, enabled: !prof?.email }).data;
  return { name: prof?.name || git?.name || "You", email: (prof?.email || git?.email || "").toLowerCase() };
}

/** Per project, a branch to scroll into view once the map shows it (one just created). */
const toReveal = new Map<string, string>();
export function revealBranch(pid: string, branch: string) {
  toReveal.set(pid, branch);
}

/**
 * Who comes from whom: every branch under its parent (a gone parent hands its children to the default branch), in display
 * order: releases (oldest version first, as they ship), trunks, then work by recency. Shipped release branches nothing
 * live still sits on leave for the shipped history.
 */
function familyOf(o: Overview) {
  const names = new Set(o.branches.map((b) => b.name));
  const kids = new Map<string, BranchView[]>();
  const roots: BranchView[] = [];
  for (const b of o.branches) {
    // One started from a shipped release sits on the trunk whatever it merges into: filed under the default branch.
    const p = b.parent ? (names.has(b.parent) && !b.fork ? b.parent : o.defaultBranch) : null;
    if (!p || p === b.name || !names.has(p)) roots.push(b);
    else kids.set(p, [...(kids.get(p) ?? []), b]);
  }
  // Dates carry each committer's own UTC offset, so compare instants, not strings.
  const time = (b: BranchView) => Date.parse(b.date) || 0;
  // o.releases lists the open ones newest first.
  const relOrder = (b: BranchView) => -o.releases.findIndex((r) => r.open && r.branch === b.name);
  // Branches started from a shipped release first, oldest release on top as the trunk lists them: their lines come down
  // from the trunk above, crossing no other.
  const rank = (b: BranchView) => (b.fork ? -1 : b.role === "release" ? 0 : b.role === "trunk" ? 1 : b.exists ? 2 : 3);
  const forkOrder = (b: BranchView) => (b.fork ? -o.releases.findIndex((r) => r.tagName === b.fork!.tag) : 0);
  const order = (a: BranchView, b: BranchView) => rank(a) - rank(b) || forkOrder(a) - forkOrder(b) || relOrder(a) - relOrder(b) || time(b) - time(a) || a.name.localeCompare(b.name);
  const listed = new Set(o.releases.filter((r) => !r.open).map((r) => r.version));
  const inUse = (b: BranchView): boolean => b.name === o.currentBranch || (kids.get(b.name) ?? []).some((c) => !c.merged || inUse(c));
  const shipped = new Map<string, BranchView>();
  for (const b of o.branches) if (b.shipped && listed.has(b.shipped) && !inUse(b)) shipped.set(b.shipped, b);
  const kept = (b: BranchView) => !(b.shipped && shipped.get(b.shipped) === b);
  const parent = new Map<string, string>();
  for (const [p, list] of kids) {
    kids.set(p, list.filter(kept).sort(order));
    for (const c of list) parent.set(c.name, p);
  }
  const tops = roots.filter(kept).sort((a, b) => Number(isRoot(b)) - Number(isRoot(a)) || order(a, b));
  return { roots: tops, shipped, kids: (n: string) => kids.get(n) ?? [], parent: (n: string) => parent.get(n) };
}

export interface Tile {
  b: BranchView;
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
  /** Its newest commits float under the box. */
  open: boolean;
  /** Listed, the earlier ones too. */
  all: boolean;
  /** Height of the commits floating under the box (0: none). */
  list: number;
  /** Merged branches listed under it (none while folded), and the ones a clean up may delete. */
  merged: BranchView[];
  removable: BranchView[];
  /** Every merged branch under it: the folded line counts them, and the search looks through them. */
  mergedAll: BranchView[];
  /** The merged line's station middle, from the map's top; its rows follow MERGED_ROW apart. */
  mergedY: number;
}

export interface MapLayout {
  tiles: Tile[];
  at: Map<string, Tile>;
  W: number;
  H: number;
  depth: number;
  /**
   * Shipped releases on the trunk, oldest first, at their station's middle; with their branch while it is still around, and
   * the commits they shipped once unfolded: how many are listed, of how many, and the height they take under the row.
   */
  shipped: { r: ReleaseView; y: number; b?: BranchView; list?: { n: number; total: number; box: number; h: number; forks: number[] } }[];
  shippedAll: ReleaseView[];
  /** Shipped releases past the latest few, listed only once "see all" unfolds them. */
  shippedEarlier: number;
  shippedLeft: BranchView[];
  /** The trunk the map starts from (see `isRoot`): its box sits on the trunk's hairline. */
  root: string;
  /** Where the trunk's hairline starts and ends. */
  trunkTop: number;
  trunkEnd: number;
  parent: (n: string) => string | undefined;
  kids: (n: string) => BranchView[];
  stale: (b: BranchView) => boolean;
  /** Open work branches, the user's own among them; merged ones; ones falling behind. */
  counts: { open: number; mine: number; merged: number; behind: number };
  /** Per release: its work branches still open and those merged in. */
  work: Map<string, { open: number; merged: number }>;
}

/** The shipped releases, newest first; how many the latest few leave out; and those listed on the trunk, oldest first. */
function shippedRows(o: Overview, shown: boolean, toggles: ReadonlyMap<string, boolean>) {
  const all = o.releases.filter((r) => !r.open);
  const earlier = shown ? Math.max(0, all.length - SHIPPED_SHOWN) : 0;
  const rows = shown ? all.slice(0, toggles.get("shipped:all") ? undefined : SHIPPED_SHOWN).reverse() : [];
  return { all, earlier, rows };
}

/**
 * A shipped release's commits, listed under its station: the newest few, or up to HISTORY_MAX once "see all" is open. One row
 * while its count loads. `forks`: the rows branches started from, by index, boxes FORK_EXTRA taller.
 */
function shippedList(tag: string, toggles: ReadonlyMap<string, boolean>, counts: ReleaseCounts | undefined, forks: number[] = []) {
  const total = counts?.[tag]?.commits ?? 1;
  const n = Math.min(total, toggles.get(`relall:${tag}`) ? HISTORY_MAX : COMMITS_SHOWN);
  // The rows 2px apart, then the "see all" row past the newest few.
  const box = n * SHIPPED_COMMIT_H + (n - 1) * 2 + forks.length * FORK_EXTRA + (total > COMMITS_SHOWN ? ROW : 0);
  // From the station's middle, the list starts SHIPPED_LIST_TOP down; the next station comes a pitch past its foot.
  return { n, total, box, h: SHIPPED_LIST_TOP + box, forks };
}
type ReleaseCounts = Record<string, ReleaseCount>;

/**
 * Lays the map out. The trunk is a vertical line: the shipped releases on it as stations, oldest on top, then the default
 * branch's station, its box beside it. Every other branch is a box in the column of its level, level with the middle of its
 * children; its newest commits float under it, its merged branches hang under those. `toggles`: tiles whose commits the user
 * folded or unfolded (by name), their earlier commits listed too (`all:<name>`), merged groups shown whole (`merged:<name>`),
 * and every shipped release (`shipped:all`). A shipped release's commits unfold under its station (`rel:<tag>`), all of them
 * with `relall:<tag>`; `counts` sizes them, and `forkRows` (by tag) the rows branches started from.
 */
function layoutMap(o: Overview, prefs: Pick<MapPrefs, "who" | "merged" | "behind" | "shipped">, me: string, toggles: ReadonlyMap<string, boolean>, counts?: ReleaseCounts, forkRows: ReadonlyMap<string, number[]> = NO_FORKS): MapLayout {
  const fam = familyOf(o);
  const root = fam.roots.find(isRoot)?.name ?? o.defaultBranch;
  const mine = (b: BranchView) => !!me && b.email.toLowerCase() === me;
  // One started from a shipped release is behind on purpose, to try that release.
  const stale = (b: BranchView) => b.role === "branch" && b.exists && !b.merged && !b.fork && b.behind >= BEHIND_LIMIT;
  // A branch open in a worktree or with an agent session is listed on Worktrees & agents, and one started from a shipped
  // release hangs on the trunk: the map shows them whatever the filters.
  const inUse = (b: BranchView) => !!b.worktree || b.running || b.waiting || !!b.fork;
  const passes = (b: BranchView) => inUse(b) || ((prefs.behind || !stale(b)) && (prefs.who === "all" || mine(b)));
  // A merged branch with nothing live left on it is a station under its base, not a box.
  const chip = (b: BranchView) => b.merged && !inUse(b) && fam.kids(b.name).every((k) => !inUse(k) && k.merged);
  const live = (b: BranchView) => fam.kids(b.name).filter((k) => !chip(k));
  const vis = new Set<string>();
  const ghost = new Set<string>();
  const walk = (b: BranchView): boolean => {
    let any = false;
    for (const k of live(b)) if (walk(k)) any = true;
    if (b.role !== "branch") {
      vis.add(b.name);
      if (!any && b.role === "release" && prefs.who !== "all") ghost.add(b.name);
      return true;
    }
    if (passes(b) || any) vis.add(b.name);
    if (!passes(b) && any) ghost.add(b.name);
    return vis.has(b.name);
  };
  fam.roots.forEach(walk);

  const open = (b: BranchView) => b.exists && ownCommits(b) > 0;
  const boxH = (b: BranchView) => (big(b) ? REL_H : BOX_H);
  // The commits floating under the box: its rows, "see all" past the newest few, and the tag closing the default branch's whole list.
  const listH = (b: BranchView) => {
    const n = listedRows(b, !!toggles.get(`all:${b.name}`));
    if (!n || !open(b)) return 0;
    return FLOAT_TOP + n * ROW + (commitRows(b) > COMMITS_SHOWN ? ROW : 0) + (endsOnTag(b, n) ? ROW : 0);
  };
  const mergedOf = (b: BranchView) => (prefs.merged ? fam.kids(b.name).filter((k) => chip(k) && (prefs.who === "all" || mine(k))) : []);
  // Protected and checked-out branches stay put, and so do the ones only likely merged.
  const removableOf = (all: BranchView[]) => all.filter((c) => !c.protected && !c.checkedOut && !c.likelyMerged);
  const shownMerged = (b: BranchView, all: BranchView[]) => (toggles.get(`merged:${b.name}`) ? all.length : 0);
  // The whole block: the box, its commits, its merged line and the rows it opens to.
  const blockH = (b: BranchView) => {
    const all = mergedOf(b);
    const top = boxH(b) + listH(b);
    if (!all.length) return top;
    return top + MERGED_TOP + shownMerged(b, all) * MERGED_ROW + 12;
  };

  const { all: shippedAll, earlier: shippedEarlier, rows } = shippedRows(o, prefs.shipped, toggles);
  // Under the "Shipped from" label (and "+N earlier releases"), a station per release; an unfolded one pushes the next down by its list.
  let cy = TOP + 40 + (shippedEarlier ? 24 : 0);
  const shippedAt = rows.map((r) => {
    const list = r.tagName && toggles.get(`rel:${r.tagName}`) ? shippedList(r.tagName, toggles, counts, forkRows.get(r.tagName)) : undefined;
    const y = cy;
    cy += PITCH + (list?.h ?? 0);
    return { r, y, b: fam.shipped.get(r.version), list };
  });
  // The default branch's station: a pitch and a gap after the latest shipped one, its box's header level with it.
  const trunkY = rows.length ? cy + TRUNK_GAP - 26 : TOP;

  const at = new Map<string, Tile>();
  const tiles: Tile[] = [];
  const bottom: number[] = [];
  const last: (string | undefined)[] = [];
  const place = (b: BranchView, d: number, floor: number, par: string) => {
    const h = boxH(b);
    const a = anchorOf(b);
    const gap = last[d] === undefined ? 0 : last[d] === par ? GAP : GROUP_GAP;
    let pMin = Math.max(floor, (bottom[d] ?? TOP) + gap);
    const isTrunk = b.name === root;
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
      b, d, x: colX(d), y, w: colW(d), h, a, ghost: ghost.has(b.name), open: list > 0, all: !!toggles.get(`all:${b.name}`), list,
      merged: all.slice(0, shown), removable, mergedAll: all, mergedY,
    };
    at.set(b.name, t);
    tiles.push(t);
    bottom[d] = y + blockH(b);
  };
  for (const r of fam.roots) if (vis.has(r.name)) place(r, 0, TOP, "");

  const trunk = at.get(root);
  const depth = tiles.reduce((m, t) => Math.max(m, t.d), 0);
  const work = new Map<string, { open: number; merged: number }>();
  for (const r of tiles.filter((t) => t.b.role === "release")) {
    const c = { open: 0, merged: 0 };
    const count = (n: string) =>
      fam.kids(n).forEach((k) => {
        if (k.role === "branch") {
          if (k.merged) c.merged++;
          else c.open++;
        }
        count(k.name);
      });
    count(r.b.name);
    work.set(r.b.name, c);
  }
  const live2 = o.branches.filter((b) => b.role === "branch" && b.exists && !b.merged);
  const trunkAnchor = trunk ? trunk.y + trunk.a : TOP;
  return {
    tiles,
    at,
    W: colX(depth) + colW(depth) + 24,
    H: Math.max(TOP, ...bottom.filter((n) => n !== undefined)) + 40,
    depth,
    shipped: trunk ? shippedAt : [],
    shippedAll,
    shippedEarlier,
    shippedLeft: [...fam.shipped.values()].filter((b) => b.exists),
    root,
    trunkTop: trunk && shippedAt.length ? shippedAt[0].y : trunkAnchor,
    // The spine ends just under the default branch's own block (its commits, merged branches), not the map's bottom.
    trunkEnd: trunk ? Math.max(trunkAnchor + 40, trunk.y + blockH(trunk.b) + 24) : trunkAnchor,
    parent: fam.parent,
    kids: fam.kids,
    stale,
    counts: { open: live2.length, mine: live2.filter(mine).length, merged: o.branches.filter((b) => b.merged && b.role === "branch").length, behind: live2.filter(stale).length },
    work,
  };
}

/** A match of the map's search, and what shows it. */
interface Hit {
  key: string;
  /** A commit, not a branch or tag name. */
  commit: boolean;
  /** Its place on the map as the user left it, for the order: top to bottom, left to right, then within its tile or row. */
  y: number;
  x: number;
  i: number;
  /** A tile's name, a merged chip's (`chip`), or a shipped release's (`r`). */
  b?: BranchView;
  chip?: boolean;
  r?: ReleaseView;
  /** A commit at `index` in the list of tile `tile`, or of shipped tag `tag`. */
  tile?: string;
  tag?: string;
  index?: number;
  /** Toggles unfolding where it is, while the search is on it. */
  needs: [string, boolean][];
}

/** The space a tile takes on the map: its box, the commits floating under it, its merged line and rows (the
 *  default branch's sit on the trunk, left of its box). */
function extent(t: Tile, onTrunk: boolean) {
  const bottom = Math.max(t.y + t.h + FLOAT_TOP + t.list, t.mergedAll.length ? t.mergedY + t.merged.length * MERGED_ROW + 12 : 0);
  return { left: onTrunk ? TRUNK_X : t.x, top: t.y, right: t.x + t.w, bottom };
}

/** Every shipped release listed, as "see all" lists them. */
const ALL_SHIPPED: ReadonlyMap<string, boolean> = new Map([["shipped:all", true]]);

/**
 * What the search finds on map `m` as laid out, in reading order: branch and tag names matching `qb`, commits matching `qc`
 * (read in `found`). Only what the filters show: tiles, merged chips, and shipped releases when `shipped`; a faded tile, there
 * for what is under it, by its name alone. Commits are found folded away too: `needs` unfolds them while the search is there.
 */
function findHits(m: MapLayout, qb: string, qc: string, found: MapCommits | undefined, shipped: boolean, label: (v: string) => string): Hit[] {
  if (!qb && !qc) return [];
  const out: Hit[] = [];
  const named = (...names: string[]) => !!qb && names.some((n) => n.toLowerCase().includes(qb));
  if (shipped) {
    const rowY = new Map(m.shipped.map((x) => [x.r, x.y]));
    // Oldest first, as listed; the earlier ones "see all" hides sit above the rest.
    [...m.shippedAll].reverse().forEach((r, j) => {
      const y = rowY.get(r);
      const hidden: [string, boolean][] = y === undefined ? [["shipped:all", true]] : [];
      const tag = r.tagName;
      if (named(tag ?? "", label(r.version))) out.push({ key: `r:${r.version}:${tag ?? ""}`, commit: false, y: y ?? 0, x: 0, i: j * 1000, r, needs: hidden });
      if (!tag) return;
      (found?.tags[tag] ?? []).forEach((c, k) => {
        if (!commitMatches(c, qc, tag)) return;
        const needs: [string, boolean][] = [...hidden, [`rel:${tag}`, true]];
        if (k >= COMMITS_SHOWN) needs.push([`relall:${tag}`, true]);
        out.push({ key: `rc:${tag}:${c.sha}`, commit: true, y: y ?? 0, x: 0, i: j * 1000 + 1 + k, tag, index: k, needs });
      });
    });
  }
  for (const t of m.tiles) {
    const b = t.b;
    if (named(b.name, b.release ? label(b.release) : "")) out.push({ key: `b:${b.name}`, commit: false, y: t.y, x: t.x, i: 0, b, needs: [] });
    if (!t.ghost) {
      const max = listedRows(b, true);
      (found?.branches[b.name] ?? []).forEach((c, k) => {
        if (k >= max || !commitMatches(c, qc)) return;
        const needs: [string, boolean][] = k >= COMMITS_SHOWN ? [[`all:${b.name}`, true]] : [];
        out.push({ key: `c:${b.name}:${c.sha}`, commit: true, y: t.y, x: t.x, i: 1 + k, tile: b.name, index: k, needs });
      });
    }
    t.mergedAll.forEach((c, k) => {
      if (named(c.name)) out.push({ key: `m:${c.name}`, commit: false, y: t.y, x: t.x, i: 10_000 + k, b: c, chip: true, needs: k < t.merged.length ? [] : [[`merged:${b.name}`, true]] });
    });
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x || a.i - b.i);
}

/** The map as laid out with the saved filters, for the map and the focus view's way back to it. */
export function useMapLayout(o: Overview | undefined, toggles: ReadonlyMap<string, boolean> = NO_TOGGLES, counts?: ReleaseCounts, forkRows: ReadonlyMap<string, number[]> = NO_FORKS) {
  const [prefs] = useMapPrefs();
  const me = useMe().email;
  const { who, merged, behind, shipped } = prefs;
  return useMemo(() => o && layoutMap(o, { who, merged, behind, shipped }, me, toggles, counts, forkRows), [o, who, merged, behind, shipped, me, toggles, counts, forkRows]);
}
const NO_TOGGLES = new Map<string, boolean>();
const NO_FORKS = new Map<string, number[]>();
/** Whether `c` (or a commit folded under it) is one of `shas`. */
const holds = (c: Commit, shas: ReadonlySet<string> | ReadonlyMap<string, boolean>) => shas.has(c.sha) || !!c.merged?.some((m) => shas.has(m.sha));

/** `name` and every branch above it, the root first. */
export function lineageOf(layout: Pick<MapLayout, "parent">, name?: string) {
  const out: string[] = [];
  for (let n = name; n && !out.includes(n); n = layout.parent(n)) out.unshift(n);
  return out;
}

/** What "Look at the code" opens on: the uncommitted work, else the branch's own changes, else the project's files. */
export const lookItem = (b?: BranchView): FocusItem => (b?.wip ? "wip" : b && b.ahead > 0 && b.parent ? "all" : "project");

export type AgentInfo = { label: string; state?: "working" | "waiting" | "done" | "limit"; row?: string };

/** The agent working on each branch of the project, by branch (and by worktree path). Only what the map shows is selected, so a new log line redraws nothing. */
export function useAgentOf(pid: string) {
  const list = useAgents((l) =>
    l.filter((a) => a.projectId === pid).map((a) => ({ id: a.id, branch: a.branch, cwd: a.cwd, label: a.agentLabel, shown: shownStatus(a, true) as ShownStatus })),
  ).data;
  return (b: BranchView): AgentInfo | undefined => {
    // Off a worktree, the agent works in the main checkout.
    const a = list?.find((x) => (b.worktree ? x.cwd === b.worktree : x.branch === b.name));
    const state = b.running ? "working" : b.waiting ? (a?.shown === "done" ? "done" : a?.shown === "limited" ? "limit" : "waiting") : undefined;
    if (!a && !state) return undefined;
    return { label: a?.label || "Agent", state, row: b.worktree ?? a?.id };
  };
}

/** Tags naming a branch's place: the one checked out, the default branch (unless checked out), a release's kind, and where it lives. */
export function BranchTags({ o, b }: { o: Overview; b: BranchView }) {
  const rel = b.role === "release" ? o.releases.find((r) => r.open && r.branch === b.name) : undefined;
  return (
    <>
      {b.name === o.currentBranch && <span className="tag inv">Checked out</span>}
      {b.name === o.defaultBranch && b.name !== o.currentBranch && <span className="tag">Default</span>}
      {rel && <span className={rel.tag === "next" ? "tag inv" : "tag"}>{releaseTagLabel(rel.tag)}</span>}
      {b.likelyMerged && <span className="tag" title="A pull request carrying its ticket went into its base after its last commit. Not proof: it is never cleaned up as merged.">likely merged</span>}
      {b.local && !b.remote && b.exists && o.remote && <span className="tag" title={`${b.name} doesn't exist on origin. Push it to share it.`}>local</span>}
      {b.remote && !b.local && <span className="tag" title={`${b.name} was never fetched into a local branch. Check it out to work on it locally.`}>origin</span>}
      {!b.exists && <span className="tag c-del">deleted</span>}
    </>
  );
}

/** Where the branch stands with origin, in a few words, and its colour. */
export function originOf(b: BranchView, remote: boolean): [string, string] {
  if (!remote) return ["no origin", "faint"];
  if (b.local && !b.remote) return ["local only, never pushed", ""];
  if (b.remote && !b.local) return ["only on origin, never fetched", ""];
  if (b.upstreamAhead && b.upstreamBehind) return [`diverged: ↑${b.upstreamAhead} ↓${b.upstreamBehind}`, "c-warn"];
  if (b.upstreamAhead) return [`↑${b.upstreamAhead} to push`, ""];
  if (b.upstreamBehind) return [`↓${b.upstreamBehind} to pull`, "c-del"];
  return [b.upstream ? "synced with origin" : "not tracking origin", b.upstream ? "" : "faint"];
}

export const agentWords = (a: AgentInfo) =>
  a.state === "working" ? "working" : a.state === "waiting" ? "waiting for you" : a.state === "done" ? "done, ready to review" : a.state === "limit" ? "at a usage limit" : "idle";

/** "5m", "3h", "2d": how old a commit is, short. */
const age = (iso: string) => ago(iso).replace(" ago", "").replace("just now", "now");
const branches = (n: number, what = "branch") => `${n} ${what}${n === 1 ? "" : "es"}`;

/** `name` with the search marked in it. */
function marked(name: string, q: string, at: boolean): ReactNode {
  const i = q ? name.toLowerCase().indexOf(q) : -1;
  if (i < 0) return name;
  return <>{name.slice(0, i)}<mark className={at ? "map-hit at" : "map-hit"}>{name.slice(i, i + q.length)}</mark>{name.slice(i + q.length)}</>;
}

/** "Updating…" while the overview is read again (after an action, a fetch, a change in git), with how far a rebuild is.
 *  Its own component: a rebuild reports every ten branches, and each report redrew the whole map. */
function MapUpdating({ pid }: { pid: string }) {
  const progress = useOverviewProgress(pid);
  const fetching = useIsFetching({ queryKey: ["overview", pid] }) > 0;
  if (!fetching) return null;
  return (
    <span className="map-updating faint" role="status">
      <span className="spinner" />
      {progress && progress.done < progress.total ? `Updating ${progress.done}/${progress.total}…` : "Updating…"}
    </span>
  );
}

/** A section's "Clean up": a spinner and what is left while its cleanup runs in the background. `big`: an outlined button of its own. */
function CleanupButton({ pid, section, title, onClick, text }: { pid: string; section: string; title: string; onClick: () => void; text?: string }) {
  const left = useCleanupLeft(pid, section);
  const busy = left !== undefined;
  return (
    <button className="map-clean" aria-label={busy ? `Cleaning up, ${branches(left)} left` : title} data-tip={busy ? `Deleting branches… ${branches(left)} left` : title} disabled={busy} aria-busy={busy || undefined} onClick={onClick}>
      {busy ? <span className="spinner" /> : <Icon name="brush" size={12} />}
      {busy ? left : text}
    </button>
  );
}

export function BranchMap({
  o,
  selected,
  actions,
  target,
  onSelect,
  onFocus,
  onCleanup,
  onCleanupBehind,
  onCleanupShipped,
  cleaning,
  tagItems,
  onStashes,
  building,
  bar,
  files,
  fileDiff,
  filesButton,
}: {
  o: Overview;
  selected?: string;
  actions: BranchActions;
  target: (b: string) => BranchTarget;
  onSelect: (b: string) => void;
  /** Opens the branch full screen on `item`. */
  onFocus: (b: string, item: FocusItem) => void;
  /** Clean up the merged children of `parent`, shown as `label`. */
  onCleanup: (parent: string, label: string, branches: BranchView[]) => void;
  /** Clean up (delete) branches falling behind `base`; `section` stays locked meanwhile. */
  onCleanupBehind: (section: string, base: string, branches: BranchView[]) => void;
  /** Clean up (delete) shipped release branches still around; their tags stay. */
  onCleanupShipped: (branches: BranchView[]) => void;
  /** Whether a cleanup runs on a section ("merged:<parent>", "behind", "shipped"). */
  cleaning: (section: string) => boolean;
  /** Actions for a shipped release's tag; the first one (check out) also runs on double-click. */
  tagItems: (tag: string, checkedOut: boolean) => MenuItem[];
  /** The stashes made on `b`, or every one. */
  onStashes: (b?: string) => void;
  /** First look at the project: branches are not filed under their parents yet. */
  building?: boolean;
  /** Where the toolbar goes: a row above the map and the agent panel beside it. */
  bar: HTMLElement | null;
  /** The selected branch's files, under its card. */
  files?: (b: BranchView) => ReactNode;
  /** The file picked there, floating over the map. */
  fileDiff?: (b: BranchView) => ReactNode;
  /** Beside the card's action: shows or hides its files when the panel isn't there on its own. */
  filesButton?: (b: BranchView) => ReactNode;
}) {
  const pid = o.project.id;
  const prList = usePrs(pid);
  const openPrs = useMemo(
    () =>
      new Map(
        o.branches.flatMap((b) => {
          const p = openPrOf(prList.data?.items, b.name);
          return p ? [[b.name, p] as const] : [];
        }),
      ),
    [o.branches, prList.data],
  );
  const prNumbers = useMemo(() => [...openPrs.values()].map((p) => p.number), [openPrs]);
  const prDetails = usePrDetails(pid, prNumbers);
  const prOf = (name: string): BranchPr | undefined => {
    const p = openPrs.get(name);
    return p && { number: p.number, url: p.url, tone: prTone(p, prDetails.get(p.number)) };
  };
  const keys = useKeys();
  const { label, v: tagV } = useTagV(pid);
  const [prefs, setPrefs] = useMapPrefs();
  const me = useMe();
  const zoom = prefs.zoom;
  const [toggles, setToggles] = useState<ReadonlyMap<string, boolean>>(NO_TOGGLES);

  // The search, on Ctrl+F (Cmd+F): it marks what matches, branch and tag names, commits, and steps through them, hiding none.
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [hitKey, setHitKey] = useState<string>();
  const findInput = useRef<HTMLInputElement>(null);
  const openFind = () => {
    setFinding(true);
    findInput.current?.focus();
    findInput.current?.select();
  };
  useFindKey(openFind);
  const q = finding ? query.trim().toLowerCase() : "";
  const qb = prefs.findBranches ? q : "";
  const qc = prefs.findCommits ? q : "";

  // How many commits each shipped release listed above the trunk holds: shown on its row, and the height its list unfolds to.
  // While searching, every one: a match can open any of them.
  const shippedTags = useMemo(() => shippedRows(o, prefs.shipped, q ? ALL_SHIPPED : toggles).rows.flatMap((r) => (r.tagName ? [r.tagName] : [])), [o, prefs.shipped, toggles, !!q]);
  const counts = useReleaseCounts(pid, shippedTags).data;
  // The map as the user left it: where the matches are, in their order.
  const base = useMapLayout(o, toggles, counts)!;
  const lists = useMemo(() => (qc ? base.tiles.filter((t) => !t.ghost && t.b.exists && ownCommits(t.b) > 0).map((t) => ({ name: t.b.name, base: t.b.parent ?? null })) : []), [!!qc, base]);
  const listedTags = useMemo(() => (qc && prefs.shipped ? base.shippedAll.flatMap((r) => (r.tagName ? [r.tagName] : [])) : []), [!!qc, prefs.shipped, base.shippedAll]);
  const found = useMapCommits(pid, lists, listedTags, !!qc);
  const hits = useMemo(() => findHits(base, qb, qc, qc ? found.data : undefined, prefs.shipped, label), [base, qb, qc, found.data, prefs.shipped, tagV]);
  const atHit = hits.find((h) => h.key === hitKey) ?? hits[0];
  // The map as shown: unfolded where the match the search is on has to be.
  const shownToggles = useMemo(() => (atHit?.needs.length ? new Map([...toggles, ...atHit.needs]) : toggles), [toggles, atHit?.key]);
  // The open lists of releases a branch started from: the commit's row is a box there, and the branch's line leaves from it.
  const forkTags = new Set(o.branches.flatMap((b) => (b.fork ? [b.fork.tag] : [])));
  const openForks = shippedRows(o, prefs.shipped, shownToggles).rows.flatMap((r) =>
    r.tagName && forkTags.has(r.tagName) && shownToggles.get(`rel:${r.tagName}`) ? [{ tag: r.tagName, n: shippedList(r.tagName, shownToggles, counts).n }] : [],
  );
  const forkLists = useReleaseCommitLists(pid, openForks);
  const rowsNow = new Map(
    openForks.flatMap(({ tag }) => {
      const shas = new Set(o.branches.flatMap((b) => (b.fork?.tag === tag ? [b.fork.sha] : [])));
      const rows = (forkLists.get(tag) ?? []).flatMap((c, i) => (holds(c, shas) ? [i] : []));
      return rows.length ? [[tag, rows] as const] : [];
    }),
  );
  // Kept while the rows stay the same: a new map each render would lay the map out again each time.
  const forkRowsKey = JSON.stringify([...rowsNow]);
  const forkRows = useMemo(() => rowsNow, [forkRowsKey]);
  const layout = useMapLayout(o, shownToggles, counts, forkRows)!;
  const { tiles, at, W, H } = layout;
  const byName = useMemo(() => new Map(o.branches.map((b) => [b.name, b])), [o.branches]);
  const labelOf = (n: string) => {
    const b = byName.get(n);
    return b?.role === "release" && b.release ? label(b.release) : n;
  };
  const agentOf = useAgentOf(pid);
  const rebasing = useRebasing(pid);
  const fetchOrigin = useAction("branches.fetch", { invalidate: [["overview", pid]], success: () => "Fetched origin" });

  // A filter hiding the selected branch: the map shows the checked-out one as selected instead.
  // Where a box's commits start: further right when its merged line runs down past their avatars.
  const floatX = (t: Tile) => (t.b.name === layout.root ? 14 : t.mergedAll.length ? 18 + RAIL_GAP : 18);
  const onMap = (n?: string) => !!n && (at.has(n) || tiles.some((t) => t.merged.some((m) => m.name === n)) || layout.shipped.some((x) => x.b?.name === n));
  const shown = onMap(selected) ? selected : o.currentBranch && at.has(o.currentBranch) ? o.currentBranch : o.defaultBranch;
  // The route: the checked-out branch's line, from the trunk's station to it.
  const head = new Set(o.currentBranch ? lineageOf(layout, o.currentBranch) : []);
  const flagsOf = (t: Tile): TileFlags => ({ head: head.has(t.b.name), stale: layout.stale(t.b) });

  const scroller = useRef<HTMLDivElement>(null);
  const legend = useRef<HTMLDivElement>(null);
  /** The view's height above the legend pinned over its bottom. */
  const viewH = (el: HTMLElement) => el.clientHeight - (legend.current?.offsetHeight ?? 0);
  // Empty room around the map, half the view on each side: any tile can be dragged or zoomed to the middle.
  // Its size changing (opening, resizing) moves the scroll with it, so the map stays put.
  const [pad, setPad] = useState({ x: 0, y: 0 });
  const padWas = useRef(pad);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setPad((p) => (p.x === Math.round(el.clientWidth / 2) && p.y === Math.round(el.clientHeight / 2) ? p : { x: Math.round(el.clientWidth / 2), y: Math.round(el.clientHeight / 2) }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = scroller.current;
    const was = padWas.current;
    padWas.current = pad;
    if (!el) return;
    el.scrollLeft += pad.x - was.x;
    el.scrollTop += pad.y - was.y;
  }, [pad]);
  // Tiles near the view now (anything of theirs: box, commits, merged stations): only those fetch the commits they list
  // and refetch them when the project changes, and on a big map only those are drawn. One scrolled past stops, else a
  // big map panned once kept thousands of lists refetching on every change.
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const look = () => {
    const el = scroller.current;
    if (!el) return;
    const vx = (el.scrollLeft - pad.x) / zoom;
    const vy = (el.scrollTop - pad.y) / zoom;
    const vw = el.clientWidth / zoom;
    const vh = el.clientHeight / zoom;
    const m = 300;
    setSeen((s) => {
      const near = tiles.filter((t) => {
        const e = extent(t, t.b.name === layout.root);
        return e.left < vx + vw + m && e.right > vx - m && e.top < vy + vh + m && e.bottom > vy - m;
      });
      return near.length === s.size && near.every((t) => s.has(t.b.name)) ? s : new Set(near.map((t) => t.b.name));
    });
  };
  const ticking = useRef(false);
  const onScroll = () => {
    if (ticking.current) return;
    ticking.current = true;
    requestAnimationFrame(() => {
      ticking.current = false;
      look();
    });
  };
  useLayoutEffect(look);

  /** Brings tile `name` into view, unless it is already, out from under the card. */
  const scrollTo = (name: string, smooth = false) => {
    const el = scroller.current;
    const t = at.get(name) ?? (layout.parent(name) ? at.get(layout.parent(name)!) : undefined);
    if (!el || !t) return;
    const room = el.clientWidth > 720 ? CARD_ROOM : 0;
    const left = pad.x + t.x * zoom;
    const top = pad.y + t.y * zoom;
    const inView = left >= el.scrollLeft && left + t.w * zoom <= el.scrollLeft + el.clientWidth - room && top >= el.scrollTop && top + t.h * zoom <= el.scrollTop + viewH(el);
    if (inView) return;
    // The map's own top left when the tile shows whole from there, so the trunk stays in view; else the tile in the middle.
    const w = el.clientWidth - room;
    const x = left + t.w * zoom <= pad.x + w - 24 ? pad.x : left + (t.w * zoom) / 2 - w / 2;
    const h = viewH(el);
    const y = top + t.h * zoom <= pad.y + h - 24 ? pad.y : top + (t.h * zoom) / 2 - h / 2;
    el.scrollTo({ left: x, top: y, behavior: smooth ? "smooth" : "auto" });
  };
  /** Brings `el`, on the map, into view unless it is already, out from under the card; a tall one from its top. */
  const bringIntoView = (el: Element) => {
    const s = scroller.current;
    if (!s) return;
    const r = el.getBoundingClientRect();
    const v = s.getBoundingClientRect();
    const w = s.clientWidth - (s.clientWidth > 720 ? CARD_ROOM : 0);
    const h = viewH(s);
    if (r.left >= v.left && r.right <= v.left + w && r.top >= v.top && r.bottom <= v.top + h) return;
    const dy = r.height > h - 40 ? r.top - v.top - 20 : r.top + r.height / 2 - (v.top + h / 2);
    s.scrollTo({ left: s.scrollLeft + r.left + r.width / 2 - (v.left + w / 2), top: s.scrollTop + dy, behavior: "smooth" });
  };
  // Opening: the selected branch in view. Later, one selected elsewhere (a ticket, a new branch) scrolls in too; a click here doesn't.
  const picked = useRef<string | undefined>(undefined);
  const opened = useRef(false);
  useLayoutEffect(() => {
    if (!tiles.length) return;
    if (!opened.current) {
      opened.current = true;
      picked.current = selected;
      return scrollTo(selected ?? o.currentBranch ?? o.defaultBranch);
    }
    if (selected && selected !== picked.current) scrollTo(selected, true);
    picked.current = selected;
  }, [selected, tiles.length]);
  const reveal = toReveal.get(pid);
  useLayoutEffect(() => {
    if (!reveal || !at.has(reveal)) return;
    toReveal.delete(pid);
    scrollTo(reveal, true);
  }, [reveal, at]);
  // The match the search is on, brought into view once the map shows it, unfolded where it had to be.
  useLayoutEffect(() => {
    const el = atHit && scroller.current?.querySelector("[data-find-at]");
    if (el) bringIntoView(el);
  }, [atHit?.key]);

  // Zooming keeps the point at (sx, sy) in the view in place: the pointer's for the wheel, else the middle.
  // `from`, a point on the map (unzoomed), goes to (sx, sy) instead: a pinch's start, following the fingers.
  // `persist` false: not saved yet (mid-pinch, saved once the fingers lift).
  const keep = useRef<{ x: number; y: number; sx: number; sy: number } | null>(null);
  const setZoom = (z: number, sx?: number, sy?: number, fine = false, from?: { x: number; y: number }, persist = true) => {
    const el = scroller.current;
    z = Math.max(0.4, Math.min(1.4, fine ? z : Math.round(z * 10) / 10));
    if (el) {
      sx ??= el.clientWidth / 2;
      sy ??= viewH(el) / 2;
      const k = { ...(from ?? { x: (el.scrollLeft + sx - pad.x) / zoom, y: (el.scrollTop + sy - pad.y) / zoom }), sx, sy };
      // Same zoom (a pinch only moving, or at a limit): no render to wait for.
      if (z === zoom) {
        el.scrollLeft = pad.x + k.x * zoom - sx;
        el.scrollTop = pad.y + k.y * zoom - sy;
      } else keep.current = k;
    }
    setPrefs({ zoom: z }, persist);
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    const k = keep.current;
    if (!el || !k) return;
    keep.current = null;
    el.scrollLeft = pad.x + k.x * zoom - k.sx;
    el.scrollTop = pad.y + k.y * zoom - k.sy;
  }, [zoom]);

  // A mouse wheel zooms anywhere on the map (a trackpad pinch comes as Ctrl + wheel), but scrolls a selected card too long to fit; one zoom per frame.
  // A two-finger trackpad scroll pans the map instead, as the page's own scroll.
  const view = useRef<HTMLDivElement>(null);
  const zoomNow = useRef(zoom);
  zoomNow.current = zoom;
  const zoomAt = useRef(setZoom);
  zoomAt.current = setZoom;
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const s = { z: 0, x: 0, y: 0, raf: 0, acc: 0, pad: -Infinity };
    const w = (e: WheelEvent) => {
      // The files and the open file scroll as pages do.
      if ((e.target as Element).closest(".map-files, .map-diff")) return;
      const card = (e.target as Element).closest(".map-card");
      if (card && card.scrollHeight > card.clientHeight) return;
      // shortcut: guesses a trackpad from its events (WebKit and Chromium give it wheelDeltaY = -3 × deltaY; a mouse wheel has
      // no sideways delta), so a free-spinning high-resolution wheel may pan too; add a "wheel pans" setting if someone asks.
      const wd = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
      if (!e.ctrlKey && !e.deltaMode && (e.deltaX !== 0 || (wd !== undefined && wd === -3 * e.deltaY))) s.pad = e.timeStamp;
      // The rest of that gesture, its glide included, keeps panning even when one event misses the pattern.
      if (!e.ctrlKey && e.timeStamp - s.pad < 200) return;
      const el = scroller.current;
      if (!el) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (!s.raf) s.z = zoomNow.current;
      if (e.ctrlKey) s.z *= Math.exp(-e.deltaY * 0.01);
      else {
        // 5 % per wheel notch: one event of 40 px or more (or a line) is a notch; smaller ones (high-resolution wheels
        // send a notch in pieces, trackpads) add up to 60 px, a notch under Wayland.
        const d = e.deltaMode ? Math.sign(e.deltaY) * 60 : e.deltaY;
        if (Math.abs(d) >= 40) s.acc = d;
        else if (Math.abs((s.acc += d)) < 60) return;
        s.z = Math.round(s.z * 20 - Math.sign(s.acc)) / 20;
        s.acc = 0;
      }
      s.z = Math.max(0.4, Math.min(1.4, s.z));
      s.x = e.clientX - r.left;
      s.y = e.clientY - r.top;
      s.raf ||= requestAnimationFrame(() => {
        s.raf = 0;
        zoomAt.current(s.z, s.x, s.y, true);
      });
    };
    v.addEventListener("wheel", w, { passive: false });

    // Two fingers on the map pinch it, the point between them following them; one finger keeps the native scroll.
    // Not passive, so the page does not zoom (iOS ignores the viewport's user-scalable=no) nor scroll under it.
    const c = scroller.current!;
    const p = { on: false, d: 0, z: 0, from: { x: 0, y: 0 }, raf: 0, nz: 0, x: 0, y: 0 };
    const mid = (t: TouchList) => {
      const r = c.getBoundingClientRect();
      return { x: (t[0].clientX + t[1].clientX) / 2 - r.left, y: (t[0].clientY + t[1].clientY) / 2 - r.top, d: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) };
    };
    const tStart = (e: TouchEvent) => {
      p.on = e.touches.length === 2;
      if (!p.on) return;
      if (e.cancelable) e.preventDefault();
      const m = mid(e.touches);
      p.d = Math.max(m.d, 1);
      p.z = zoomNow.current;
      p.from = { x: (c.scrollLeft + m.x - padWas.current.x) / p.z, y: (c.scrollTop + m.y - padWas.current.y) / p.z };
      Object.assign(p, { nz: p.z, x: m.x, y: m.y });
    };
    const tMove = (e: TouchEvent) => {
      if (!p.on || e.touches.length !== 2) return;
      if (e.cancelable) e.preventDefault();
      const m = mid(e.touches);
      p.nz = (p.z * m.d) / p.d;
      p.x = m.x;
      p.y = m.y;
      p.raf ||= requestAnimationFrame(() => {
        p.raf = 0;
        zoomAt.current(p.nz, p.x, p.y, true, p.from, false);
      });
    };
    // A finger lifted ends the pinch, its zoom saved; the one left scrolls natively.
    const tEnd = (e: TouchEvent) => {
      if (!p.on || e.touches.length > 1) return;
      p.on = false;
      cancelAnimationFrame(p.raf);
      p.raf = 0;
      zoomAt.current(p.nz, p.x, p.y, true, p.from);
    };
    c.addEventListener("touchstart", tStart, { passive: false });
    c.addEventListener("touchmove", tMove, { passive: false });
    c.addEventListener("touchend", tEnd);
    c.addEventListener("touchcancel", tEnd);
    return () => {
      v.removeEventListener("wheel", w);
      cancelAnimationFrame(s.raf);
      c.removeEventListener("touchstart", tStart);
      c.removeEventListener("touchmove", tMove);
      c.removeEventListener("touchend", tEnd);
      c.removeEventListener("touchcancel", tEnd);
      cancelAnimationFrame(p.raf);
    };
  }, []);

  // A mouse drag anywhere on the map pans it; under 5 px it stays a click. Touch keeps its native scroll, two fingers pinch.
  const pan = useRef<{ x: number; y: number; l: number; t: number; on: boolean } | null>(null);
  const panned = useRef(false);
  const endPan = (e: PointerEvent<HTMLDivElement>) => {
    if (pan.current?.on) {
      panned.current = true;
      delete e.currentTarget.dataset.panning;
    }
    pan.current = null;
  };

  const fit = () => {
    const el = scroller.current;
    if (!el) return;
    const room = el.clientWidth > 720 ? CARD_ROOM : 0;
    const z = Math.max(0.4, Math.min(1, Math.floor(Math.min((el.clientWidth - room) / W, viewH(el) / H) * 10) / 10));
    // The map's top left corner at the view's, once zoomed.
    keep.current = z === zoom ? null : { x: 0, y: 0, sx: 0, sy: 0 };
    setPrefs({ zoom: z });
    el.scrollTo({ left: pad.x, top: pad.y });
  };

  const [tagMenu, setTagMenu] = useState<{ x: number; y: number; tag: string; checkedOut: boolean } | null>(null);
  // A commit listed on a tile, right-clicked: the same menu as in the focus view's timeline, for that tile's branch.
  // One a shipped release listed (`shipped`, its tag) is history: its resets move the checked-out branch there, to try it.
  const [menuOn, setMenuOn] = useState<{ b: BranchView; list: Commit[]; shipped?: string } | null>(null);
  const commitMenu = useCommitMenu({
    pid,
    branch: menuOn?.b.name ?? "",
    base: menuOn?.b.parent ? labelOf(menuOn.b.parent) : "",
    checkedOut: !!menuOn && (menuOn.b.checkedOut || menuOn.b.name === o.currentBranch),
    upstream: !!menuOn?.b.upstream,
    current: o.currentBranch ?? undefined,
    currentView: o.currentBranch ? byName.get(o.currentBranch) : undefined,
    list: menuOn?.list ?? [],
    shipped: menuOn?.shipped,
  });
  const toggle = (key: string, on: boolean) => setToggles((m) => new Map(m).set(key, on));
  const defaultView = byName.get(o.defaultBranch);
  const select = (name: string) => {
    picked.current = name;
    onSelect(name);
  };

  // Edges run from a parent's right side to its child's left: hairlines, the route's a little heavier. Where a branch is ahead
  // of or behind its parent, a chip sits on the middle of its line; behind, it rebases.
  const edges: { d: string; cls: string }[] = [];
  const lineChips: { x: number; y: number; t: Tile; onto: string; cls: string }[] = [];
  // A branch started from a shipped release leaves the trunk at the commit's row when that release's list shows it, else
  // in the gap under the release (under its list when open: the older commits); none when the release is not on the trunk
  // (earlier ones folded, shipped hidden).
  const forkFrom = (b: BranchView) => {
    const f = b.fork;
    const s = f && layout.shipped.find((x) => x.r.tagName === f.tag);
    if (!f || !s) return undefined;
    if (!s.list) return { gap: s.y + 18 };
    const i = forkLists.get(f.tag)?.findIndex((c) => holds(c, new Set([f.sha]))) ?? -1;
    if (i < 0 || i >= s.list.n) return { gap: s.y + s.list.h + 10 };
    // Its box's middle: the boxes above it push it down, and its own margin and padding.
    const above = s.list.forks.filter((j) => j < i).length;
    return { row: s.y + SHIPPED_LIST_TOP + i * (SHIPPED_COMMIT_H + 2) + above * FORK_EXTRA + (SHIPPED_COMMIT_H + FORK_EXTRA) / 2 };
  };
  for (const t of tiles) {
    const pn = layout.parent(t.b.name);
    const p = pn ? at.get(pn) : undefined;
    if (!p) continue;
    const x1 = p.x + p.w;
    const y1 = p.y + p.a;
    const x2 = t.x;
    const y2 = t.y + t.a;
    const dx = (x2 - x1) / 2;
    const n = t.b.name;
    const cls = head.has(n) ? "head" : layout.stale(t.b) ? "stale" : t.ghost || (t.b.remote && !t.b.local) ? "far" : "";
    const from = pn === layout.root ? forkFrom(t.b) : undefined;
    if (from) {
      // Off the trunk into the gap, then out past the trunk's column. From a commit: a tick off the trunk to its row, the
      // line out from the row's end. No behind chip: it sits back there on purpose.
      const fy = from.row ?? from.gap;
      const out = from.row === undefined ? `M${TRUNK_X} ${fy - 18}C${TRUNK_X} ${fy - 6} ${TRUNK_X + 4} ${fy} ${TRUNK_X + 18} ${fy}H${x1}` : `M${TRUNK_X} ${fy}H${TRUNK_X + 18}M${x1} ${fy}`;
      edges.push({ d: `${out}C${x1 + dx} ${fy} ${x2 - dx} ${y2} ${x2} ${y2}`, cls });
      continue;
    }
    edges.push({ d: `M${x1} ${y1}C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`, cls });
    // The default branch under a less advanced trunk (main under prod) is not rebased onto it.
    if (t.b.behind > 0 && t.b.exists && !t.b.merged && n !== o.defaultBranch) lineChips.push({ x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2), t, onto: pn!, cls });
  }
  const trunk = at.get(layout.root);
  /** The commits of `tag` branches started from, and whether the checked-out branch's route runs through each. */
  const forksIn = (tag: string) => {
    const m = new Map<string, boolean>();
    for (const b of o.branches) if (b.fork?.tag === tag) m.set(b.fork.sha, !!m.get(b.fork.sha) || head.has(b.name));
    return m;
  };
  const shippedName = (r: ReleaseView) => r.tagName ?? label(r.version);
  const shippedDate = (r: ReleaseView) => {
    const iso = o.project.releases.find((x) => x.version === r.version)?.shippedAt ?? /tagged (\d{4}-\d{2}-\d{2})/.exec(r.base)?.[1];
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isNaN(t) ? "" : new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
  };
  const staleLeft = o.branches.filter((b) => layout.stale(b) && !b.protected && !b.checkedOut && !b.running && b.wip === 0);
  const sel = shown ? byName.get(shown) : undefined;
  const openFile = sel && fileDiff?.(sel);
  // A big map draws the tiles near the view, plus the selected one and the search's hit, which the code scrolls to.
  const pinned = new Set([shown, atHit?.tile, atHit?.b && (atHit.chip ? layout.parent(atHit.b.name) : atHit.b.name)]);
  const drawn = tiles.length > CULL_FROM ? tiles.filter((t) => seen.has(t.b.name) || pinned.has(t.b.name)) : tiles;
  const cols = Array.from({ length: layout.depth + 1 }, (_, d) => (d === 0 ? "Trunk" : d === 1 ? `Releases & straight to ${o.defaultBranch}` : d === 2 ? "Branches" : "Stacked"));
  // What the search looks through, one at least: a filter beside its box, with what it found there.
  const findKind = (key: "findBranches" | "findCommits", text: string, n: number, busy = false) => {
    const last = prefs[key] && !prefs[key === "findBranches" ? "findCommits" : "findBranches"];
    return (
      <button key={key} className="map-toggle" aria-pressed={prefs[key]} data-tip={last ? "The search needs one of them at least" : undefined} onClick={() => !last && setPrefs({ [key]: !prefs[key] })}>
        <span className="map-box" aria-hidden>
          <Icon name="check" size={10} stroke={2.4} />
        </span>
        <span>{text}</span>
        {busy ? <span className="spinner" /> : q && prefs[key] ? <span className="faint">{n}</span> : null}
      </button>
    );
  };
  const toggleBtn = (key: "merged" | "behind" | "shipped", text: string, n: number) => (
    <button key={key} className="map-toggle" aria-pressed={prefs[key]} onClick={() => setPrefs({ [key]: !prefs[key] })}>
      <span className="map-box" aria-hidden><Icon name="check" size={10} stroke={2.4} /></span>
      <span>{text}</span>
      <span className="faint">{n}</span>
    </button>
  );

  return (
    <section className="map" aria-label="Branch map" aria-busy={building || undefined}>
      {building && (
        <div className="map-building" role="status">
          <span className="spinner" />
          <span>Sorting branches…</span>
        </div>
      )}
      {bar && createPortal(
      <div className="map-bar">
        <h2 className="map-title">Branch map</h2>
        <Seg<Who>
          label="Branches by person"
          value={prefs.who}
          onChange={(who) => setPrefs({ who })}
          options={[
            { value: "all", label: <>Everyone <span className="faint">{layout.counts.open}</span></> },
            { value: "me", label: <><Avatar name={me.name} email={me.email} size={16} />Mine <span className="faint">{layout.counts.mine}</span></> },
          ]}
        />
        <div className="map-toggles" role="group" aria-label="Show on the map">
          {toggleBtn("merged", "Merged", layout.counts.merged)}
          {staleLeft.length > 0 || cleaning("behind") ? (
            // Its Clean up as the toggle's right side: one control.
            <span className="map-toggle-split">
              {toggleBtn("behind", "Falling behind", layout.counts.behind)}
              <CleanupButton pid={pid} section="behind" title={`Pick which of the ${branches(staleLeft.length)} falling behind to delete`} onClick={() => onCleanupBehind("behind", "their base", staleLeft)} />
            </span>
          ) : (
            toggleBtn("behind", "Falling behind", layout.counts.behind)
          )}
          {toggleBtn("shipped", "Shipped", layout.shippedAll.length)}
        </div>
        {!building && <MapUpdating pid={pid} />}
        <span className="grow" />
        <span className="map-acts">
          <button className="btn btn-sm btn-icon" aria-label="Search the map" data-tip={`Search branches, tags and commits (${showKeys(keys.find)})`} onClick={openFind}>
            <Icon name="search" size={14} />
          </button>
          {o.stashes.length > 0 && (
            <button className="btn btn-sm" aria-label={`Show ${stashCount(o.stashes.length)}`} data-tip={`${stashCount(o.stashes.length)} set aside`} onClick={() => onStashes()}>
              <Icon name="stash" size={14} />
              {stashCount(o.stashes.length)}
            </button>
          )}
          <button className="btn btn-sm btn-icon" aria-label="Fetch origin" data-tip="Fetch origin" disabled={fetchOrigin.isPending || !o.remote} onClick={() => fetchOrigin.mutate({ projectId: pid })}>
            {fetchOrigin.isPending ? <span className="spinner" /> : <Icon name="refresh" size={14} />}
          </button>
        </span>
        <div className="map-group map-zoom" role="group" aria-label="Zoom">
          <button className="btn btn-ghost btn-sm btn-icon" aria-label="Zoom out" disabled={zoom <= 0.4} onClick={() => setZoom(zoom - 0.1)}>
            <Icon name="minus" size={13} />
          </button>
          <span aria-live="polite">{Math.round(zoom * 100)}%</span>
          <button className="btn btn-ghost btn-sm btn-icon" aria-label="Zoom in" disabled={zoom >= 1.4} onClick={() => setZoom(zoom + 0.1)}>
            <Icon name="plus" size={13} />
          </button>
          <button className="btn btn-ghost btn-sm" data-tip="Fit the whole map in view" onClick={fit}>Fit</button>
        </div>
      </div>,
      bar,
      )}
      {finding && (
        <FindBar
          className="map-find"
          label="Search branches, tags and commits"
          icon={<Icon name="search" size={14} className="faint" />}
          query={query}
          onQuery={(v) => {
            setQuery(v);
            setHitKey(undefined);
          }}
          hits={q ? { i: atHit ? hits.indexOf(atHit) : 0, n: hits.length } : undefined}
          onStep={(back) => {
            if (!hits.length) return;
            const i = atHit ? hits.indexOf(atHit) : 0;
            setHitKey(hits[(i + (back ? -1 : 1) + hits.length) % hits.length].key);
          }}
          // Closing leaves the map as the search showed it: the match it was on stays unfolded.
          onClose={() => {
            setToggles(shownToggles);
            setFinding(false);
          }}
          inputRef={findInput}
          escapeAnywhere
          filters={
            <span className="map-find-kinds" role="group" aria-label="Search in">
              {findKind("findBranches", "Branches", hits.filter((h) => !h.commit).length)}
              {findKind("findCommits", "Commits", hits.filter((h) => h.commit).length, !!qc && found.isFetching)}
            </span>
          }
        />
      )}
      <div ref={view} className="map-view" data-file-open={openFile ? "" : undefined}>
        <div
          ref={scroller}
          className="map-canvas"
          role="region"
          aria-label="Branches"
          onScroll={onScroll}
          onDragStart={(e) => e.preventDefault()}
          onPointerDown={(e) => {
            const el = e.currentTarget;
            panned.current = false;
            // Not on the canvas's own scrollbars, past its client box.
            if (e.button || e.pointerType === "touch" || (e.target === el && (e.nativeEvent.offsetX >= el.clientWidth || e.nativeEvent.offsetY >= el.clientHeight))) return;
            pan.current = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop, on: false };
          }}
          onPointerMove={(e) => {
            const p = pan.current;
            if (!p) return;
            const el = e.currentTarget;
            // The release went missing (outside the window, WebKitGTK).
            if (!(e.buttons & 1)) return endPan(e);
            const dx = e.clientX - p.x;
            const dy = e.clientY - p.y;
            if (!p.on) {
              if (Math.hypot(dx, dy) < 5) return;
              p.on = true;
              el.setPointerCapture(e.pointerId);
              el.dataset.panning = "";
            }
            el.scrollLeft = p.l - dx;
            el.scrollTop = p.t - dy;
          }}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          // The click that ends a drag picks nothing.
          onClickCapture={(e) => {
            if (!panned.current) return;
            panned.current = false;
            e.stopPropagation();
          }}
        >
          {/* Room on the right for the card too, and always a view's worth past the left room: a small map still fits at the top left. */}
          <div
            className="map-size"
            style={{ width: pad.x + W * zoom + Math.max(pad.x, CARD_ROOM + 16, 2 * pad.x - W * zoom), height: pad.y + H * zoom + Math.max(pad.y, 2 * pad.y - H * zoom) }}
          >
            <div className="map-layer" style={{ left: pad.x, top: pad.y, width: W, height: H, transform: zoom === 1 ? undefined : `scale(${zoom})` }}>
              {cols.map((c, d) => (
                <span key={d} className="map-col" style={{ left: d === 0 ? TRUNK_X - 6 : colX(d) }}>{c}</span>
              ))}

              <svg className="map-edges" width={W} height={H} aria-hidden>
                {/* The trunk: one hairline down through the shipped releases and the default branch, ending under its commits and merged branches. */}
                {trunk && <path className="map-trunk-line" d={`M${TRUNK_X} ${layout.trunkTop}V${layout.trunkEnd}`} />}
                {/* Its end: a short 45° tick, top left to bottom right. */}
                {trunk && <path className="map-trunk-line" d={`M${TRUNK_X - 10} ${layout.trunkEnd - 10}l20 20`} />}
                {/* The route starts at the default branch's station: across to its box. */}
                {trunk && <path d={`M${TRUNK_X} ${trunk.y + trunk.a}H${trunk.x}`} data-line={o.currentBranch ? "head" : undefined} />}
                {edges.map((e, i) => <path key={i} d={e.d} data-line={e.cls || undefined} />)}
                {/* A box's merged branches hang on a hairline dropping from its station; the default branch's sit on the trunk. */}
                {tiles.map((t) => t.mergedAll.length > 0 && t.b.name !== layout.root && <path key={`m${t.b.name}`} d={`M${t.x} ${t.y + t.a}V${t.mergedY}`} />)}
              </svg>

              {trunk && layout.shipped.length > 0 && (
                <>
                  <span className="map-history-head" style={{ left: TRUNK_X - 6, top: TOP - 6 }}>
                    Shipped from {layout.root} · {layout.shippedAll.length}
                    {(layout.shippedLeft.length > 0 || cleaning("shipped")) && (
                      <CleanupButton
                        pid={pid}
                        section="shipped"
                        title={`Delete the ${branches(layout.shippedLeft.length, "shipped release branch")}, locally and on origin. Their tags stay.`}
                        onClick={() => onCleanupShipped(layout.shippedLeft)}
                      />
                    )}
                  </span>
                  {layout.shippedEarlier > 0 && (
                    <button
                      className="map-more"
                      style={{ left: TRUNK_X - 10, top: TOP + 22 }}
                      aria-expanded={!!toggles.get("shipped:all")}
                      onClick={() => toggle("shipped:all", !toggles.get("shipped:all"))}
                    >
                      {toggles.get("shipped:all") ? "Show the latest" : `+${plural(layout.shippedEarlier, "earlier release")}`}
                    </button>
                  )}
                  {layout.shipped.map(({ r, y, b, list }, i) => {
                    const tag = r.tagName;
                    const checkout = tag ? tagItems(tag, r.checkedOut)[0] : undefined;
                    const count = tag ? counts?.[tag] : undefined;
                    const name = shippedName(r);
                    const latest = i === layout.shipped.length - 1;
                    // Its commits fold and unfold from the count on its right, or from the row itself when no branch is left to select.
                    const unfold = () => tag && toggle(`rel:${tag}`, !list);
                    const words = count ? `the ${plural(count.commits, "commit")} ${name} shipped${count.since ? `, since ${count.since}` : ", its whole history"}` : `the commits ${name} shipped`;
                    return (
                      <Fragment key={`${r.version}-${r.tag}`}>
                        <span className="map-stn" data-lit={latest || undefined} style={{ left: TRUNK_X, top: y }} />
                        <div className="map-ship-row" style={{ left: TRUNK_X + 14, top: y - 12 }}>
                          <button
                            className="map-ship"
                            data-new={latest || undefined}
                            data-find-at={atHit?.r === r || undefined}
                            aria-pressed={!!b && b.name === shown}
                            data-tip={`${r.base}${r.note ? ` · ${r.note}` : ""}${r.checkedOut ? " · checked out" : ""}`}
                            // A double-click checks the tag out: its second click leaves the list as the first one set it.
                            onClick={(e) => e.detail < 2 && (b ? select(b.name) : unfold())}
                            onDoubleClick={() => checkout && checkout !== "sep" && !checkout.disabled && checkout.run()}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              if (tag) setTagMenu({ x: e.clientX, y: e.clientY, tag, checkedOut: r.checkedOut });
                              else if (b) actions.openMenu(target(b.name), e);
                            }}
                          >
                            <span className="mono ellipsis">{marked(name, qb, atHit?.r === r)}</span>
                            <span className="map-ship-date">{shippedDate(r)}</span>
                          </button>
                          {tag && (
                            <button className="map-ship-count" aria-expanded={!!list} aria-label={`${list ? "Hide" : "See"} the commits in ${name}`} data-tip={`${list ? "Hide" : "See"} ${words}`} onClick={unfold}>
                              {count ? `${countLabel(count.commits)} commit${count.commits === 1 ? "" : "s"}` : "…"}
                              <Icon name="chevronDown" size={12} className="chev" />
                            </button>
                          )}
                          {r.checkedOut && <span className="tag inv">Checked out</span>}
                        </div>
                        {tag && list && (
                          <div className="map-ship-list" role="group" aria-label={`Commits in ${name}`} style={{ top: y + SHIPPED_LIST_TOP, left: TRUNK_X + 18, width: colX(0) + colW(0) - TRUNK_X - 18, height: list.box }}>
                            <ShippedCommits
                              pid={pid}
                              tag={tag}
                              n={list.n}
                              total={list.total}
                              all={!!toggles.get(`relall:${tag}`)}
                              onAll={(on) => toggle(`relall:${tag}`, on)}
                              onFocus={(c) => onFocus(o.defaultBranch, c)}
                              q={qc}
                              at={atHit?.tag === tag ? atHit.index : undefined}
                              forks={forksIn(tag)}
                              onMenu={(c, shippedList, e) => {
                                if (!defaultView) return;
                                setMenuOn({ b: defaultView, list: shippedList, shipped: tag });
                                commitMenu.open(c, e);
                              }}
                            />
                          </div>
                        )}
                      </Fragment>
                    );
                  })}
                </>
              )}
              {/* The default branch's station: where the route starts. */}
              {trunk && <span className="map-stn" data-main="" style={{ left: TRUNK_X, top: trunk.y + trunk.a }} />}

              {drawn.map((t) => {
                const key = `merged:${t.b.name}`;
                if (!t.mergedAll.length && !cleaning(key)) return null;
                // The default branch's merged branches sit on the trunk; any other box's on the hairline under its station.
                const sx = t.b.name === layout.root ? TRUNK_X : t.x;
                const open = t.merged.length > 0;
                const likely = t.mergedAll.filter((m) => m.likelyMerged).length;
                const w = t.x + t.w - sx - 14;
                return (
                  <Fragment key={`mg${t.b.name}`}>
                    <span className="map-stn" data-small="" style={{ left: sx, top: t.mergedY }} />
                    <div className="map-merged-head" style={{ left: sx + 14, top: t.mergedY - 12, width: w }}>
                      {t.mergedAll.length > 0 && (
                        <button className="map-merged-fold" aria-expanded={open} onClick={() => toggle(key, !open)}>
                          <Icon name="check" size={12} />
                          {branches(t.mergedAll.length, "merged branch")}
                          <Icon name="chevronDown" size={12} className="chev" />
                          {likely > 0 && <span className="map-merged-likely">· {likely} likely</span>}
                        </button>
                      )}
                      {(t.removable.length > 0 || cleaning(key)) && (
                        <CleanupButton
                          pid={pid}
                          section={key}
                          text="Clean up"
                          title={`Delete the ${branches(t.removable.length, "merged branch")} under ${labelOf(t.b.name)}, locally and on origin`}
                          onClick={() => onCleanup(t.b.name, labelOf(t.b.name), t.removable)}
                        />
                      )}
                    </div>
                    {t.merged.map((m, i) => (
                      <button
                        key={m.name}
                        className="map-merged"
                        data-likely={m.likelyMerged || undefined}
                        aria-pressed={m.name === shown}
                        data-find-at={atHit?.b === m || undefined}
                        aria-label={`Select ${m.name}, ${m.likelyMerged ? "likely merged" : "merged"}`}
                        style={{ left: sx + 14, top: t.mergedY + (i + 1) * MERGED_ROW - 12, width: w }}
                        onClick={() => select(m.name)}
                        onContextMenu={(e) => actions.openMenu(target(m.name), e)}
                      >
                        <span className="mono ellipsis">{marked(m.name, qb, atHit?.b === m)}</span>
                        {m.likelyMerged && <span className="tag">Likely</span>}
                        <i>{age(m.date)}</i>
                      </button>
                    ))}
                  </Fragment>
                );
              })}

              {drawn.map((t) => (
                <Fragment key={t.b.name}>
                  <TileView
                    t={t}
                    o={o}
                    label={label}
                    labelOf={labelOf}
                    selected={t.b.name === shown}
                    flags={flagsOf(t)}
                    pr={prOf(t.b.name)}
                    q={qb}
                    hitAt={atHit?.b === t.b && !atHit.chip}
                    agent={agentOf(t.b)}
                    run={rebasing.get(t.b.name)}
                    actions={actions}
                    target={target}
                    onSelect={select}
                    onStashes={onStashes}
                    quietAdd={!head.has(t.b.name) && !layout.kids(t.b.name).length}
                    shippedTip={t.b.name === layout.root && layout.shippedAll[0] ? shippedName(layout.shippedAll[0]) : undefined}
                  />
                  {t.open && (
                    <div className="map-float" style={{ left: t.x + floatX(t), top: t.y + t.h + FLOAT_TOP, width: t.w - floatX(t) }}>
                      <TileCommits
                        pid={pid}
                        b={t.b}
                        enabled={seen.has(t.b.name)}
                        onFocus={onFocus}
                        onMenu={(c, list, e) => {
                          setMenuOn({ b: t.b, list });
                          commitMenu.open(c, e);
                        }}
                        all={t.all}
                        onAll={(on) => toggle(`all:${t.b.name}`, on)}
                        current={t.b.name === o.currentBranch}
                        find={t.ghost ? "" : qc}
                        at={atHit?.tile === t.b.name ? atHit.index : undefined}
                      />
                    </div>
                  )}
                </Fragment>
              ))}
              {lineChips.map(({ x, y, t, onto, cls }) => {
                const b = t.b;
                const text = <span className="c-del">↓{b.behind}</span>;
                const words = `${b.ahead ? `${plural(b.ahead, "commit")} ahead of ${labelOf(onto)}` : ""}${b.ahead && b.behind ? ", " : ""}${b.behind ? `${b.behind} behind` : ""}`;
                const props = { className: "map-line-chip", "data-line": cls || undefined, style: { left: x, top: y } };
                // A local branch behind its parent, a release too, rebases from its chip (checked out or not: rebased aside then), unless its agent works.
                if (b.behind > 0 && b.local) {
                  if (b.running)
                    // Still focusable so keyboard users get the reason too.
                    return (
                      <button key={b.name} {...props} aria-disabled="true" aria-label={`Can't rebase ${labelOf(b.name)} onto ${labelOf(onto)} while its agent is working`} data-tip={`${words}. Can't rebase ${labelOf(b.name)} onto ${labelOf(onto)} while its agent is working.`} data-tip-strong="Wait until the agent finishes or asks you a question.">
                        {text}
                      </button>
                    );
                  return (
                    <button key={b.name} {...props} aria-label={`Rebase ${labelOf(b.name)} onto ${labelOf(onto)}`} data-tip={`${words}. Click to rebase onto ${labelOf(onto)}.`} onClick={() => actions.askRebase(b.name, onto)}>
                      {text}
                    </button>
                  );
                }
                return (
                  <span key={b.name} {...props} data-tip={words}>
                    {text}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
        {/* Floating over the view's bottom left, level with the card's column at the right. */}
        <MapLegend ref={legend} />

        {sel && (
          // The card, and the branch's files under it in the room it leaves.
          <div className="map-side">
            <SelectedCard
              o={o}
              b={sel}
              t={target(sel.name)}
              labelOf={labelOf}
              agent={agentOf(sel)}
              run={rebasing.get(sel.name)}
              actions={actions}
              onFocus={onFocus}
              onStashes={onStashes}
              pr={prOf(sel.name)}
              extra={filesButton?.(sel)}
            />
            {files?.(sel)}
          </div>
        )}
        {openFile}
      </div>
      {tagMenu && <ContextMenu x={tagMenu.x} y={tagMenu.y} label={`Actions for ${tagMenu.tag}`} items={tagItems(tagMenu.tag, tagMenu.checkedOut)} onClose={() => setTagMenu(null)} />}
      {commitMenu.el}
    </section>
  );
}

type TileFlags = { head: boolean; stale: boolean };

/** What the map's line styles and chips mean, a mark then its words. */
const LEGEND_KEYS: [ReactNode, string][] = [
  [<svg width="20" height="8" aria-hidden><path d="M2 4h16" className="map-key-head" /></svg>, "You are here"],
  [<svg width="20" height="8" aria-hidden><path d="M2 4h16" /></svg>, "Other lines"],
  [<svg width="20" height="8" aria-hidden><path d="M2 4h16" className="map-key-stale" /></svg>, "Falling behind"],
  [<span className="map-line-chip"><span className="c-del">↓</span></span>, "on a line, click to rebase"],
];

/** The legend on one line: keys past its width wrap out of sight, and "See all" lists every one in a modal. */
function MapLegend({ ref }: { ref: Ref<HTMLDivElement> }) {
  const keys = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState(false);
  const [all, setAll] = useState(false);
  useLayoutEffect(() => {
    const el = keys.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCut(el.scrollHeight > el.clientHeight + 1));
    // The keys too: a bigger font widens them while the row keeps its size.
    [el, ...el.children].forEach((c) => ro.observe(c));
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="map-legend map-legend-box">
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

/** The uncommitted work's lines, added and deleted, once the branch's WIP files are read (the checked-out branch's already are). */
function WipLines({ pid, b, enabled }: { pid: string; b: BranchView; enabled: boolean }) {
  const files = useFiles(enabled ? pid : undefined, enabled ? b.name : undefined, "wip").data;
  if (!files?.length) return null;
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <>
      {" · "}
      <b className="c-add">+{add}</b> <b className="c-del">−{del}</b>
    </>
  );
}

/** A branch's open pull request and its status (see `prTone`). */
type BranchPr = { number: number; url: string; tone: PrTone };

/**
 * One branch on the map: a box with a header row (its type, name and the state worth a tag) and one info row (its agent,
 * uncommitted work and other facts, never commits). Its station sits on its left border where its line comes in, its "+"
 * on its right where lines leave; its commits float under it, drawn apart (TileCommits).
 */
function TileView({
  t,
  o,
  label,
  labelOf,
  selected,
  flags,
  pr,
  q,
  hitAt,
  agent,
  run,
  actions,
  target,
  onSelect,
  onStashes,
  quietAdd,
  shippedTip,
}: {
  t: Tile;
  o: Overview;
  label: (v: string) => string;
  labelOf: (n: string) => string;
  selected: boolean;
  flags: TileFlags;
  /** The branch's open pull request, if any. */
  pr?: BranchPr;
  q: string;
  hitAt: boolean;
  agent?: AgentInfo;
  run?: RebaseRun;
  actions: BranchActions;
  target: (b: string) => BranchTarget;
  onSelect: (b: string) => void;
  onStashes: (b?: string) => void;
  /** No line leaves it and it is not on the route: its "+" shows on hover or focus only. */
  quietAdd: boolean;
  shippedTip?: string;
}) {
  const nav = useNav();
  const { b } = t;
  const current = b.name === o.currentBranch;
  const lock = actions.locks.get(b.name);
  const parent = b.parent ?? "";
  const own = ownCommits(b);
  const trunk = isRoot(b);
  const rel = b.role === "release" ? o.releases.find((r) => r.open && r.branch === b.name) : undefined;
  const openReleases = o.releases.filter((r) => r.open).length;

  // The info row: what stands out first (a rebase, a conflict, the agent), then the uncommitted work, then the rest.
  const info: ReactNode[] = [];
  if (run)
    info.push(
      <button key="run" className="map-info-btn" data-tip={`AI is rebasing it onto ${run.onto}. Click to see how far it is.`} onClick={() => showRun(run.projectId, run.branch)}>
        <span className="spinner" />
        AI rebase{run.steps ? ` ${run.step}/${run.steps}` : ""}
      </button>,
    );
  else if (b.conflict)
    info.push(
      <span key="op" className="c-del" title={`Its ${b.inProgress ?? "operation"} stopped on conflicts`}>
        <Icon name="alert" size={12} />
        conflict
      </span>,
    );
  else if (b.inProgress) info.push(<span key="op" className="c-warn">mid-{b.inProgress}</span>);
  if (agent?.state === "working")
    info.push(
      <span key="agent">
        <span className="pulse glow-dot" />
        <span className="glow-working">
          <span>{agent.label} working</span>
        </span>
      </span>,
    );
  else if (agent?.state)
    info.push(
      <span key="agent">
        {agent.state === "waiting" ? <span className="pulse map-wait" /> : <Icon name={agent.state === "done" ? "check" : "pause"} size={12} className={agent.state === "limit" ? "c-warn" : agent.state === "done" ? "c-add" : undefined} />}
        {agent.label} {agentWords(agent)}
      </span>,
    );
  if (b.wip > 0)
    info.push(
      <span key="wip" className="map-wip">
        <span className="map-wip-dot" />
        WIP {b.wip}
        <WipLines pid={o.project.id} b={b} enabled={b.checkedOut || current} />
      </span>,
    );
  if (trunk) {
    if (b.lastTag) info.push(own ? `${countLabel(own)} commit${own === 1 ? "" : "s"} since ${b.lastTag}` : `at ${b.lastTag}`);
    else if (shippedTip) info.push(`tip ${shippedTip}`);
    if (openReleases) info.push(`${plural(openReleases, "release")} open`);
  } else if (b.role === "release") {
    info.push(b.name);
    if (parent) info.push(`from ${labelOf(parent)}`);
    info.push(ago(b.date));
  } else if (b.role === "trunk") info.push(ago(b.date));
  if (b.role === "branch") {
    if (b.worktree && !agent && !current)
      info.push(
        <button key="wt" className="map-info-btn" data-tip={`${b.worktree}. Click to open it in Worktrees & agents.`} onClick={() => nav.go({ name: "worktrees", key: b.worktree! })}>
          <Icon name="layers" size={12} />
          worktree
        </button>,
      );
    if (!b.exists) info.push(<span key="gone" className="c-del">deleted</span>);
    if (flags.stale) {
      const days = Math.floor((Date.now() - Date.parse(b.date)) / 86_400_000);
      info.push(
        <span key="idle" title={`${labelOf(parent)} is ${plural(b.behind, "commit")} ahead`}>
          <Icon name="alert" size={12} className="c-warn" />
          {days > 1 ? `idle ${days} days · ` : ""}falling behind {labelOf(parent)}
        </span>,
      );
    }
    if (b.exists && !b.ahead && !b.wip && !agent) info.push("no commits yet");
  }
  if (b.upstreamAhead > 0) info.push(`↑${b.upstreamAhead} to push`);
  if (b.upstreamBehind > 0) info.push(<span className="c-del">↓{b.upstreamBehind} to pull</span>);
  if (b.stashes > 0)
    info.push(
      <button key="stash" className="map-info-btn" data-tip={`${stashCount(b.stashes)} made on ${b.name}`} onClick={() => onStashes(b.name)}>
        <Icon name="stash" size={12} />
        {b.stashes}
      </button>,
    );
  if (b.ticket) info.push(<span key="ticket" className="mono">{b.ticket}</span>);
  if (b.remote && !b.local) info.push("only on origin");
  else if (b.local && !b.remote && b.exists && o.remote && b.role === "branch") info.push("local only");
  // Nothing else to say: when it last moved.
  if (!info.length) info.push(ago(b.date));

  const add = actions.create(target(b.name));
  return (
    <div
      className="map-tile"
      data-role={b.role}
      data-trunk={trunk || undefined}
      data-sel={selected || undefined}
      data-head={current || undefined}
      data-ghost={t.ghost || undefined}
      data-stale={flags.stale || undefined}
      data-far={(b.remote && !b.local) || undefined}
      data-gone={!b.exists || undefined}
      data-locked={lock ? "" : undefined}
      data-hit={hitAt || undefined}
      data-find-at={hitAt || undefined}
      style={{ left: t.x, top: t.y, width: t.w, height: t.h }}
      onContextMenu={(e) => actions.openMenu(target(b.name), e)}
    >
      <button
        className="map-hitbox"
        aria-pressed={selected}
        aria-label={`Select ${b.name}${t.ghost ? ", shown for what is under it" : ""}`}
        onClick={() => onSelect(b.name)}
        onDoubleClick={() => b.exists && !b.checkedOut && actions.switchTo(b.name)}
      />
      {/* The default branch's station is on the trunk; every other box's on its left border, where its line comes in. */}
      {!trunk && <span className="map-stn" data-on={flags.head ? (current ? "" : "via") : undefined} />}
      <div className="map-tile-in">
        <span className="map-row">
          {big(b) ? (
            <span className="map-ver">{marked(b.role === "release" && b.release ? label(b.release) : b.name, q, hitAt)}</span>
          ) : (
            <>
              {b.role === "branch" && b.kind && <span className="map-kind">{b.kind}</span>}
              <span className="map-name mono ellipsis">{marked(b.role === "branch" && b.kind ? b.short : b.name, q, hitAt)}</span>
            </>
          )}
          {b.name === o.defaultBranch && !current && <span className="tag">Default</span>}
          {rel && <span className={rel.tag === "next" ? "tag inv" : "tag"}>{releaseTagLabel(rel.tag)}</span>}
        </span>
        <span className="map-foot">
          <span className="map-info">
            {info.map((x, i) => (
              <Fragment key={i}>
                {i > 0 && " · "}
                {x}
              </Fragment>
            ))}
          </span>
          {pr && (
            <button className="map-pr" data-tip={`PR #${pr.number}, ${PR_TONE_LABEL[pr.tone]}. Click to open it.`} aria-label={`Open PR #${pr.number}, ${PR_TONE_LABEL[pr.tone]}`} onClick={() => openExternal(pr.url)}>
              <i className="pr-dot" data-tone={pr.tone} />
              PR #{pr.number}
            </button>
          )}
        </span>
      </div>
      {/* Starts a branch off it, where its lines leave. */}
      {add && (
        <button className="map-out" data-quiet={quietAdd || undefined} aria-label={`Create a branch from ${b.name}`} data-tip={add.tip} onClick={add.run}>
          <Icon name="plus" size={12} />
        </button>
      )}
      {lock && (
        <span className="lock-veil" data-tip={lockTip(lock, b.name, lock.onto === b.name ? labelOf(b.name) : labelOf(lock.onto))} onClick={() => showRun(lock.projectId, lock.branch)} onDoubleClick={(e) => e.stopPropagation()}>
          <span className="lock-badge">
            <Icon name="lock" size={12} />
            Locked
          </span>
        </span>
      )}
    </div>
  );
}

/**
 * A box's newest commits, floating under it with no container: origin's not pulled yet on top, the earlier ones once "see all"
 * is open; the default branch's whole list closes on the latest tag. Fetched once the box comes near the view.
 */
function TileCommits({
  pid,
  b,
  enabled,
  onFocus,
  onMenu,
  all,
  onAll,
  current,
  find = "",
  at,
}: {
  pid: string;
  b: BranchView;
  enabled: boolean;
  onFocus: (b: string, item: FocusItem) => void;
  onMenu: (c: Commit, list: Commit[], e: MouseEvent) => void;
  all?: boolean;
  onAll?: (on: boolean) => void;
  /** Checked out here: the commit it's on reads in ink. */
  current?: boolean;
  /** What the search marks in the subjects and tags; `at`: the row the search is on. */
  find?: string;
  at?: number;
}) {
  const total = commitRows(b);
  const n = listedRows(b, !!all);
  // The default branch lists what it has not released; once whole, the tagged commit they came after closes the list.
  const unreleased = !b.parent;
  const tagged = endsOnTag(b, n);
  const q = useCommits(pid, enabled ? b.name : undefined, n + (tagged ? 1 : 0), unreleased, b.parent);
  const commits = q.data?.filter((c) => !c.base);
  const since = tagged ? q.data?.find((c) => c.base) : undefined;
  // A commit's own menu, not the box's branch menu.
  const menu = (c: Commit | undefined) => (e: MouseEvent) => {
    e.stopPropagation();
    if (c && commits) onMenu(c, commits, e);
  };
  // Found by its SHA: the row shows it, as it otherwise doesn't.
  const sha = (c: Commit, here: boolean) => find.length >= 4 && c.sha.startsWith(find) && <span className="mono map-crow-sha">{marked(c.sha.slice(0, 7), find, here)}</span>;
  return (
    <>
      {Array.from({ length: n }, (_, i) => {
        const c = commits?.[i];
        // Loaded and shorter than counted: no row waits for a commit that won't come.
        if (commits && !q.isPlaceholderData && !c) return null;
        return (
          <button
            key={c?.sha ?? i}
            className="map-crow"
            disabled={!c}
            // The commit checked out: the newest local one.
            data-on={(current && c?.local) || undefined}
            data-find-at={i === at || undefined}
            aria-label={c ? `Look at commit ${c.sha.slice(0, 7)}, ${c.subject}${c.merged?.length ? `, bringing in ${plural(c.merged.length, "commit")}` : ""}${c.unpulled ? ", not pulled yet" : ""}` : undefined}
            onClick={() => c && onFocus(b.name, c)}
            onContextMenu={menu(c)}
          >
            {c && <Avatar name={c.author} email={c.email} size={12} />}
            {c?.unpulled && <span className="c-warn" title="On origin, not pulled yet">↓</span>}
            <span className="ellipsis">{c ? marked(c.subject, find, i === at) : "…"}</span>
            {c && sha(c, i === at)}
            {!!c?.merged?.length && (
              <span className="map-tagchip map-fold" data-tip={foldTip(c.merged)}>
                <Icon name="merged" size={11} stroke={1.4} />
                {c.merged.length}
              </span>
            )}
            {c && <TagChips tags={c.tags} q={find} />}
            <i>{c && age(c.date)}</i>
          </button>
        );
      })}
      {/* The latest release, as a milestone under the commits that came after it. */}
      {tagged && (
        <button
          className="map-crow map-crow-tag"
          disabled={!since}
          aria-label={`Look at ${b.lastTag}'s commit${since ? `, ${since.subject}` : ""}`}
          data-tip={`${b.lastTag}, the latest release: ${since ? `"${since.subject}", ${ago(since.date)}. ` : ""}The commits above came after it.`}
          onClick={() => since && onFocus(b.name, since)}
          onContextMenu={menu(since)}
        >
          <span className="mono">{b.lastTag}</span>
          <span className="map-crow-rule" />
          <i>{since && age(since.date)}</i>
        </button>
      )}
      {total > COMMITS_SHOWN && onAll && (
        <button className="map-crow-more" aria-expanded={!!all} onClick={() => onAll(!all)}>
          {all ? (total > n ? `Show fewer · ${plural(total - n, "older commit")} not listed` : "Show fewer") : `See all ${countLabel(total)}`}
        </button>
      )}
    </>
  );
}

/** Subjects a tooltip lists of what a merge brought in; past them, a count. */
const FOLD_TIP_MAX = 8;
/** A merge row's fold: the commits it brought in, newest first. */
const foldTip = (merged: Commit[]) =>
  [
    `Brought in ${plural(merged.length, "commit")}, folded under this merge:`,
    ...merged.slice(0, FOLD_TIP_MAX).map((m) => `• ${m.subject}`),
    ...(merged.length > FOLD_TIP_MAX ? [`and ${merged.length - FOLD_TIP_MAX} more`] : []),
  ].join("\n");

/** A commit the search finds: by its subject, the start of its SHA (4 characters or more), or a tag (but `skip`, its list's own). */
const commitMatches = (c: { sha: string; subject: string; tags: string[] }, q: string, skip?: string) =>
  !!q && (c.subject.toLowerCase().includes(q) || (q.length >= 4 && c.sha.startsWith(q)) || c.tags.some((t) => t !== skip && t.toLowerCase().includes(q)));

/** The tags on a commit: the first named (one the search `q` finds, if any), the others counted. `skip`: one the list already names (its release's). */
function TagChips({ tags, skip, q = "" }: { tags: string[]; skip?: string; q?: string }) {
  const found = (t: string) => !!q && t.toLowerCase().includes(q);
  const shown = tags.filter((t) => t !== skip).sort((a, b) => Number(found(b)) - Number(found(a)));
  if (!shown.length) return null;
  return (
    <span className="map-tags" data-tip={shown.length > 1 ? `Tags ${shown.join(", ")}` : `Tag ${shown[0]}`}>
      <span className="map-tagchip mono">
        <span className="ellipsis">{marked(shown[0], q, false)}</span>
      </span>
      {shown.length > 1 && <span className="map-tagchip">+{shown.length - 1}</span>}
    </span>
  );
}

/**
 * The commits a shipped release holds, newest first, under its station: the newest few, then "see all". `n` of `total` are
 * listed, each on two lines: its subject, then its author, date and SHA, which copies on a click. Its own tag goes unsaid
 * on them, its row names it. `q`: what the search marks; `at`: the commit the search is on.
 */
function ShippedCommits({
  pid,
  tag,
  n,
  total,
  all,
  onAll,
  onFocus,
  onMenu,
  q,
  at,
  forks,
}: {
  pid: string;
  tag: string;
  n: number;
  total: number;
  all: boolean;
  onAll: (on: boolean) => void;
  onFocus: (c: Commit) => void;
  onMenu: (c: Commit, list: Commit[], e: MouseEvent) => void;
  q: string;
  at?: number;
  /** Commits branches were reset onto or made from (their lines leave from these rows), and whether the checked-out branch's route runs through. */
  forks: ReadonlyMap<string, boolean>;
}) {
  const list = useReleaseCommits(pid, tag, n);
  const commits = list.data;
  const menu = (c: Commit | undefined) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (c && commits) onMenu(c, commits, e);
  };
  return (
    <>
      {Array.from({ length: n }, (_, i) => {
        const c = commits?.[i];
        if (commits && !list.isPlaceholderData && !c) return null;
        const here = i === at;
        const fork = c && [c.sha, ...(c.merged ?? []).map((m) => m.sha)].find((s) => forks.has(s));
        return (
          // The row opens the commit from a button behind it; its SHA is a button of its own on top.
          <div key={c?.sha ?? i} className="map-relrow" data-find-at={here || undefined} data-fork={fork ? "" : undefined}>
            {/* Where the line from the trunk comes in, as on a box's left border. */}
            {fork && <span className="map-stn" data-on={forks.get(fork) ? "via" : undefined} />}
            <button className="map-hitbox" disabled={!c} aria-label={c ? `Look at commit ${c.sha.slice(0, 7)}, ${c.subject}` : "Loading"} onClick={() => c && onFocus(c)} onContextMenu={menu(c)} />
            <span className="map-relrow-subject ellipsis">{c ? marked(c.subject, q, here) : "…"}</span>
            {c && (
              <span className="map-relrow-meta">
                <span className="map-who"><Avatar name={c.author} email={c.email} size={14} />{ago(c.date)}</span>
                <button className="map-sha mono" data-tip="Copy SHA" aria-label={`Copy SHA ${c.sha.slice(0, 7)}`} onClick={() => copyToClipboard(c.sha)}>
                  {marked(c.sha.slice(0, 7), q.length >= 4 ? q : "", here)}
                </button>
                <TagChips tags={c.tags} skip={tag} q={q} />
              </span>
            )}
          </div>
        );
      })}
      {total > COMMITS_SHOWN && (
        <button className="map-crow-more" aria-expanded={all} onClick={() => onAll(!all)}>
          {all ? (total > n ? `Show fewer · ${plural(total - n, "older commit")} not listed` : "Show fewer") : `See all ${countLabel(total)}`}
        </button>
      )}
    </>
  );
}

/** The selected branch, floating over the map: what it is, how it stands, and what to do next. */
function SelectedCard({
  o,
  b,
  t,
  labelOf,
  agent,
  run,
  actions,
  onFocus,
  onStashes,
  pr,
  extra,
}: {
  o: Overview;
  b: BranchView;
  t: BranchTarget;
  labelOf: (n: string) => string;
  agent?: AgentInfo;
  run?: RebaseRun;
  actions: BranchActions;
  onFocus: (b: string, item: FocusItem) => void;
  onStashes: (b?: string) => void;
  /** The branch's open pull request, if any. */
  pr?: BranchPr;
  /** After the suggested action, on its row. */
  extra?: ReactNode;
}) {
  // Folding or unfolding the card holds for every branch, across restarts.
  const [chosen, setFolded] = useStoredChoice("gnx.map.cardFolded");
  const ticketUrl = useTicket(o.project.id, b.ticket ?? undefined).data?.url || undefined;
  // Until then, on a phone the card starts folded, out of the map's way; picking another branch unfolds it.
  const [phone, setPhone] = useState(() => matchMedia("(max-width: 720px)").matches);
  const [was, setWas] = useState(b.name);
  if (was !== b.name) {
    setWas(b.name);
    setPhone(false);
  }
  const folded = chosen ?? phone;
  // Once the worktree's agent is done, suggest wrapping it up: merge into the parent and delete the worktree.
  const finish = b.worktree && agent?.state === "done" ? actions.action(t, "merge") : undefined;
  const p = finish && !finish.disabled ? finish : actions.primary(t);
  const tone = p.danger ? "btn-danger" : "btn-primary";
  const busy = actions.busy.has(b.name) || actions.rebasing.has(b.name);
  const trunk = b.role === "trunk";
  const kind = b.role === "branch" && b.kind;
  const name = b.role === "release" && b.release ? `${labelOf(b.name)} · ${b.name}` : kind ? b.short : b.name;

  const look = lookItem(b);

  const nav = useNav();
  const rows: [string, ReactNode, string?][] = [];
  if (b.parent) rows.push(["Parent", labelOf(b.parent)]);
  if (run) rows.push(["Rebase", `AI rebasing onto ${labelOf(run.onto)}${run.steps ? `, ${run.step} of ${run.steps}` : ""}`]);
  else if (b.conflict) rows.push([b.inProgress ? b.inProgress[0].toUpperCase() + b.inProgress.slice(1) : "Operation", "stopped on conflicts", "c-del"]);
  else if (b.inProgress) rows.push([b.inProgress[0].toUpperCase() + b.inProgress.slice(1), "paused in the middle", "c-warn"]);
  if (b.merged) rows.push([b.likelyMerged ? "Likely in" : "Merged into", t.baseLabel]);
  else if (b.role === "release" && b.release) rows.push(["Ships as", labelOf(b.name)]);
  if (b.role === "branch" && b.exists && !b.merged) {
    const text = agent && `${agent.label} · ${agentWords(agent)}`;
    // While its agent works, the row wears the agent chip's flowing colours.
    const words = agent?.state === "working" ? <span className="glow-working"><span>{text}</span></span> : text;
    rows.push([
      "Agent",
      agent?.row ? (
        <button className="link-btn agent-link" style={{ color: "inherit", textAlign: "left" }} data-tip="Open its session in Worktrees & agents" onClick={() => nav.go({ name: "worktrees", key: agent.row })}>
          {words}
        </button>
      ) : (
        (words ?? "none")
      ),
      agent?.state === "waiting" || agent?.state === "limit" ? "c-warn" : undefined]);
  }
  if (b.stashes) rows.push(["Stashes", <button className="link-btn" onClick={() => onStashes(b.name)}>{stashCount(b.stashes)}</button>]);

  // Its headline numbers, in the display face: how far it is from its base and what is uncommitted on it; for the default
  // branch, what the next release ships and how many are open.
  const big: [string, number, string?][] =
    trunk && !b.parent
      ? [["Unreleased", b.unreleased ?? 0], ["Releases open", o.releases.filter((r) => r.open).length], ["WIP files", b.wip]]
      : [["Ahead", b.ahead], ["Behind", b.behind, b.behind ? "c-del" : undefined], ["WIP files", b.wip]];

  return (
    <aside className="map-card" aria-label={`Selected branch ${b.name}`} data-folded={folded || undefined}>
      <div className="map-card-head">
        {/* Its kind and tags on one line above the name. */}
        <div className="map-card-tags">
          {kind && <span className="map-kind">{b.kind}</span>}
          <BranchTags o={o} b={b} />
        </div>
        {/* The name opens the branch full screen too; folded, the eye says so, as the hidden "Look at the code" did. */}
        <h3 className="mono">
          <button className="map-card-look" disabled={!b.exists} data-tip="Look at the code" onClick={() => onFocus(b.name, look)}>
            {folded ? (
              // The eye wraps with the name's last letters, never alone on a line.
              <>
                {name.slice(0, -4)}
                <span className="map-card-tail">
                  {name.slice(-4)}
                  <Icon name="eye" size={13} className="map-card-eye" />
                </span>
              </>
            ) : (
              name
            )}
          </button>
        </h3>
        <button className="btn btn-icon map-card-fold" aria-expanded={!folded} aria-label={folded ? "Show the selected branch" : "Fold the selected branch"} onClick={() => setFolded(!folded)}>
          <Icon name="chevronDown" size={14} className="chev" />
        </button>
      </div>
      {(pr || b.ticket) && (
        <div className="map-card-keys">
          {pr && (
            <button className="map-card-pr" aria-label={`Open PR #${pr.number}, ${PR_TONE_LABEL[pr.tone]}`} data-tip={`PR #${pr.number}, ${PR_TONE_LABEL[pr.tone]}. Click to open it.`} onClick={() => openExternal(pr.url)}>
              <span className="map-card-pr-n">#{pr.number}</span>
              <span className="map-card-pr-s">
                <i className="pr-dot" data-tone={pr.tone} />
                {PR_TONE_LABEL[pr.tone]}
              </span>
              <Icon name="eye" size={12} className="map-card-open" />
            </button>
          )}
          {b.ticket &&
            (ticketUrl ? (
              <button className="map-card-key" aria-label={`Open ticket ${b.ticket}`} data-tip={`Ticket ${b.ticket}. Click to open it.`} onClick={() => openExternal(ticketUrl)}>
                <span className="map-card-pr-n">{b.ticket}</span>
                Ticket
                <Icon name="eye" size={12} className="map-card-open" />
              </button>
            ) : (
              <span className="map-card-key">
                <span className="map-card-pr-n">{b.ticket}</span>
                Ticket
              </span>
            ))}
        </div>
      )}
      {!folded && (
        <>
          {b.exists && (
            <div className="map-big">
              {big.map(([k, n, cls]) => (
                <div key={k}>
                  <b className={cls}>{countLabel(n)}</b>
                  <span className="label">{k}</span>
                </div>
              ))}
            </div>
          )}
          {rows.length > 0 && (
            <dl className="map-status">
              {rows.map(([k, v, cls]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd className={cls}>{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
      {/* Folded, the card still offers the suggested action. */}
      <div className="map-card-acts">
        <button className={`btn ${tone} split-main grow`} disabled={p.disabled || busy} data-tip={p.tip} onClick={p.run}>
          {busy ? <span className="spinner" /> : <Icon name={p.icon ?? "check"} size={14} />}
          <span className="ellipsis">{p.short ?? p.label}</span>
        </button>
        <button className={`btn btn-icon ${tone} split-more`} aria-label={`More actions for ${b.name}`} data-tip={`More actions for ${b.name}`} aria-haspopup="menu" onClick={(e) => actions.openMenu(t, e)}>
          <Icon name="more" size={14} />
        </button>
        {extra}
      </div>
    </aside>
  );
}
