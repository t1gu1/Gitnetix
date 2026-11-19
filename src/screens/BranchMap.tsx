import { useIsMutating, useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useAction, useAgents, useCommits, useConfig, useMapCommits, useReleaseCommits, useReleaseCounts, useTagV } from "../api/hooks";
import { rpc } from "../api/transport";
import type { BranchView, Commit, MapCommits, Overview, RebaseRun, ReleaseCount, ReleaseView } from "../api/types";
import { Avatar } from "../components/Avatar";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { FindBar, releaseTagLabel, Seg, useFindKey } from "../components/ui";
import { shownStatus, type ShownStatus } from "../lib/agentLog";
import { ago, plural, stashCount } from "../lib/format";
import { showKeys, useKeys } from "../lib/keys";
import { useNav } from "../lib/nav";
import { lockTip, showRun, useRebasing } from "../lib/rebaseRuns";
import { useStored, useStoredChoice } from "../lib/stored";
import { copyToClipboard } from "../lib/toast";
import type { BranchActions, BranchTarget } from "./BranchMenu";
import { useCommitMenu } from "./CommitMenu";

/** Branches this many commits behind their base count as falling behind. */
const BEHIND_LIMIT = 25;
/** Commits an unfolded tile lists; the rest are counted, listed once "see all" is open. */
const COMMITS_SHOWN = 6;
/** Commits "see all" lists at most where the count can be a whole history: the default branch with no tag, a first release. */
const HISTORY_MAX = 200;
/** A tile's own commits: those not in its base, or the default branch's not released yet (since its latest tag). */
const ownCommits = (b: BranchView) => b.ahead || (b.unreleased ?? 0);
/** A tile's commit rows: its own, and origin's not pulled yet above them. */
const commitRows = (b: BranchView) => ownCommits(b) + b.upstreamBehind;
/** Commit rows an unfolded tile lists: the newest few, or all once "see all" is open. */
const listedRows = (b: BranchView, all: boolean) => Math.min(commitRows(b), all ? (b.parent ? Infinity : HISTORY_MAX) : COMMITS_SHOWN);
/** The default branch's list, when whole, ends on the latest tag: the release its commits came after. */
const endsOnTag = (b: BranchView, listed: number) => !b.parent && !!b.lastTag && listed === commitRows(b);
/** A count as a pill shows it: a whole history counted up to 1000 reads "999+". */
const countLabel = (n: number) => (n >= 1000 ? "999+" : String(n));
/** Merged branches listed under their base before "+N more". */
const MERGED_SHOWN = 4;
/** Shipped releases listed above the trunk before "+N earlier releases". */
const SHIPPED_SHOWN = 10;
const TOP = 48;
const GAP = 8;
const GROUP_GAP = 20;
const SHIPPED_TOP = 70;
const SHIPPED_ROW = 16;
/** A shipped release's commits, unfolded under its row: where the list starts below the row's middle, and the room under it. */
const SHIPPED_LIST_TOP = 11;
const SHIPPED_LIST_FOOT = 8;
/** The unfolded list's box: wider than the history, out over the first column; tiles below it keep clear of it. */
const SHIPPED_LIST_LEFT = 50;
const SHIPPED_LIST_W = 360;
/** One of its commits: the subject, then its date and SHA under it. */
const SHIPPED_COMMIT_H = 32;
/** The shipped history's right edge: the trunk tile's, clear of the lines leaving it. */
const SHIPPED_RIGHT = 240;
/** A shipped release's commit count, on the right of its row. */
const SHIPPED_COUNT_W = 52;
/** Room the floating card takes on the right (its width and gap): the map scrolls out from under it. */
const CARD_ROOM = 304;
/** Column `d` of the map: the trunk, then each level of branches under it. */
const colX = (d: number) => (d === 0 ? 24 : 300 + (d - 1) * 372);
const colW = (d: number) => (d === 0 ? 216 : 320);

/** What the focus view opens on: uncommitted work, all the branch's changes, one commit, or the project's files. */
export type FocusItem = "wip" | "all" | "project" | Commit;

type Who = "all" | "me";
type CommitsShown = "hidden" | "latest" | "list";
interface MapPrefs {
  who: Who;
  commits: CommitsShown;
  merged: boolean;
  behind: boolean;
  shipped: boolean;
  zoom: number;
  /** What the search looks through: branch and tag names, commits. */
  findBranches: boolean;
  findCommits: boolean;
}
const PREFS: MapPrefs = { who: "all", commits: "hidden", merged: true, behind: true, shipped: true, zoom: 1, findBranches: true, findCommits: true };

/** The map's filters and zoom, kept between sessions. */
function useMapPrefs() {
  const [p, set] = useStored<MapPrefs>("gnx.map", PREFS, (s) => ({ ...PREFS, ...JSON.parse(s) }));
  return [p, (next: Partial<MapPrefs>) => set({ ...p, ...next })] as const;
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
    const p = b.parent ? (names.has(b.parent) ? b.parent : o.defaultBranch) : null;
    if (!p || p === b.name || !names.has(p)) roots.push(b);
    else kids.set(p, [...(kids.get(p) ?? []), b]);
  }
  // Dates carry each committer's own UTC offset, so compare instants, not strings.
  const time = (b: BranchView) => Date.parse(b.date) || 0;
  // o.releases lists the open ones newest first.
  const relOrder = (b: BranchView) => -o.releases.findIndex((r) => r.open && r.branch === b.name);
  const rank = (b: BranchView) => (b.role === "release" ? 0 : b.role === "trunk" ? 1 : b.exists ? 2 : 3);
  const order = (a: BranchView, b: BranchView) => rank(a) - rank(b) || relOrder(a) - relOrder(b) || time(b) - time(a) || a.name.localeCompare(b.name);
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
  const tops = roots.filter(kept).sort((a, b) => (a.name === o.defaultBranch ? -1 : b.name === o.defaultBranch ? 1 : order(a, b)));
  return { roots: tops, shipped, kids: (n: string) => kids.get(n) ?? [], parent: (n: string) => parent.get(n) };
}

export interface Tile {
  b: BranchView;
  d: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Where edges meet it, down from its top. */
  a: number;
  /** Kept, faded, only for a shown branch below it. */
  ghost: boolean;
  /** Its newest commits listed. */
  open: boolean;
  /** Listed, the earlier ones too. */
  all: boolean;
  /** Merged branches chipped under it, how many more there are, and the ones a clean up may delete. */
  merged: BranchView[];
  more: number;
  removable: BranchView[];
  /** Every merged branch chipped under it once "+N more" is open: what the search looks through. */
  mergedAll: BranchView[];
}

export interface MapLayout {
  tiles: Tile[];
  at: Map<string, Tile>;
  W: number;
  H: number;
  depth: number;
  /**
   * Shipped releases above the trunk, oldest first, at their y; with their branch while it is still around, and the
   * commits they shipped once unfolded: how many are listed, of how many, and the height they take under the row.
   */
  shipped: { r: ReleaseView; y: number; b?: BranchView; list?: { n: number; total: number; box: number; h: number } }[];
  shippedAll: ReleaseView[];
  /** Shipped releases past the latest few, listed only once "see all" unfolds them. */
  shippedEarlier: number;
  shippedLeft: BranchView[];
  parent: (n: string) => string | undefined;
  kids: (n: string) => BranchView[];
  stale: (b: BranchView) => boolean;
  /** Open work branches, the user's own among them; merged ones; ones falling behind. */
  counts: { open: number; mine: number; merged: number; behind: number };
  /** Per release: its work branches still open and those merged in. */
  work: Map<string, { open: number; merged: number }>;
}

/** The shipped releases, newest first; how many the latest few leave out; and those listed above the trunk, oldest first. */
function shippedRows(o: Overview, shown: boolean, toggles: ReadonlyMap<string, boolean>) {
  const all = o.releases.filter((r) => !r.open);
  const earlier = shown ? Math.max(0, all.length - SHIPPED_SHOWN) : 0;
  const rows = shown ? all.slice(0, toggles.get("shipped:all") ? undefined : SHIPPED_SHOWN).reverse() : [];
  return { all, earlier, rows };
}

/** A shipped release's commits, listed under its row: the newest few, or up to HISTORY_MAX once "see all" is open. One row while its count loads. */
function shippedList(tag: string, toggles: ReadonlyMap<string, boolean>, counts: ReleaseCounts | undefined) {
  const total = counts?.[tag]?.commits ?? 1;
  const n = Math.min(total, toggles.get(`relall:${tag}`) ? HISTORY_MAX : COMMITS_SHOWN);
  // Its box: 4px padding around the rows, and the "see all" row past the newest few.
  const box = 8 + n * SHIPPED_COMMIT_H + (n - 1) * 2 + (total > COMMITS_SHOWN ? 20 : 0);
  // From the row's middle, the box starts SHIPPED_LIST_TOP down; the next row's middle comes half a row past the box's foot.
  return { n, total, box, h: SHIPPED_LIST_TOP + box + SHIPPED_LIST_FOOT - SHIPPED_ROW / 2 };
}
type ReleaseCounts = Record<string, ReleaseCount>;

/**
 * Lays the branches out left to right, one column per level: each parent sits level with the middle of its children,
 * siblings stack 8px apart and cousins 20px. `toggles`: tiles whose commits the user folded or unfolded (by name), their
 * earlier commits listed too (`all:<name>`, `peek:<name>` when "see all" unfolded a folded tile), merged groups shown whole (`merged:<name>`), and every shipped release (`shipped:all`).
 * A shipped release's commits unfold under its row (`rel:<tag>`), all of them with `relall:<tag>`; `counts` sizes them.
 */
function layoutMap(o: Overview, prefs: Pick<MapPrefs, "who" | "commits" | "merged" | "behind" | "shipped">, me: string, toggles: ReadonlyMap<string, boolean>, counts?: ReleaseCounts): MapLayout {
  const fam = familyOf(o);
  const mine = (b: BranchView) => !!me && b.email.toLowerCase() === me;
  const stale = (b: BranchView) => b.role === "branch" && b.exists && !b.merged && b.behind >= BEHIND_LIMIT;
  const passes = (b: BranchView) => (prefs.behind || !stale(b)) && (prefs.who === "all" || mine(b));
  // A merged branch with nothing live left on it is a chip under its base, not a tile.
  const chip = (b: BranchView) => b.merged && fam.kids(b.name).every((k) => k.merged);
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

  const open = (b: BranchView) => b.exists && ownCommits(b) > 0 && (toggles.get(b.name) ?? (prefs.commits === "list" || b.name === o.currentBranch));
  const tileH = (b: BranchView) => {
    const base = b.role === "trunk" ? 64 : 60;
    const total = commitRows(b);
    const n = listedRows(b, !!toggles.get(`all:${b.name}`));
    if (!n || !b.exists) return base;
    if (open(b)) return base + 15 + n * 18 + (n - 1) * 2 + (total > COMMITS_SHOWN ? 18 : 0) + (endsOnTag(b, n) ? 20 : 0);
    // Latest: the newest commit, then the "see all" row when there are others.
    return prefs.commits === "latest" ? base + 26 + (total > 1 ? 23 : 0) : base;
  };
  // Edges meet the title row's middle: border 1 + `.map-tile-in` top padding + half the 20px `.map-row`.
  const anchor = (b: BranchView) => (b.role === "trunk" ? 24 : 20);
  const mergedOf = (b: BranchView) => (prefs.merged ? fam.kids(b.name).filter((k) => chip(k) && (prefs.who === "all" || mine(k))) : []);

  const { all: shippedAll, earlier: shippedEarlier, rows } = shippedRows(o, prefs.shipped, toggles);
  // The "+N earlier releases" row sits on top, above the oldest one listed.
  const rowsTop = SHIPPED_TOP + (shippedEarlier ? SHIPPED_ROW + 4 : 0);
  // Each row a step down, and an unfolded one the height of its commits more.
  let rowY = rowsTop;
  const shippedAt = rows.map((r) => {
    const list = r.tagName && toggles.get(`rel:${r.tagName}`) ? shippedList(r.tagName, toggles, counts) : undefined;
    const y = rowY;
    rowY += SHIPPED_ROW + (list?.h ?? 0);
    return { r, y, b: fam.shipped.get(r.version), list };
  });
  const trunkFloor = rows.length ? rowY + 22 : TOP;
  // An open list reaches out over the first column: what hangs off the trunk starts below the lowest one, its lines too.
  const listsFoot = Math.max(0, ...shippedAt.map((x) => (x.list ? x.y + SHIPPED_LIST_TOP + x.list.box + GROUP_GAP : 0)));

  const at = new Map<string, Tile>();
  const tiles: Tile[] = [];
  const bottom: number[] = [];
  const last: (string | undefined)[] = [];
  const place = (b: BranchView, d: number, floor: number, par: string) => {
    const h = tileH(b);
    const a = anchor(b);
    const gap = last[d] === undefined ? 0 : last[d] === par ? GAP : GROUP_GAP;
    let pMin = Math.max(floor, (bottom[d] ?? TOP) + gap);
    if (b.name === o.defaultBranch) pMin = Math.max(pMin, trunkFloor);
    const ks = live(b).filter((k) => vis.has(k.name));
    let y = pMin;
    if (ks.length) {
      const span = ks.slice(0, -1).reduce((n, k) => n + tileH(k) + GAP, 0);
      const kidFloor = Math.max(floor, b.name === o.defaultBranch ? listsFoot : 0, pMin + a - (anchor(ks[0]) + span + anchor(ks[ks.length - 1])) / 2);
      for (const k of ks) place(k, d + 1, kidFloor, b.name);
      const f = at.get(ks[0].name)!;
      const l = at.get(ks[ks.length - 1].name)!;
      y = Math.max(pMin, Math.round((f.y + f.a + l.y + l.a) / 2 - a));
    }
    last[d] = par;
    const all = mergedOf(b);
    const shown = toggles.get(`merged:${b.name}`) ? all.length : Math.min(all.length, MERGED_SHOWN);
    // Protected and checked-out branches stay put, and so do the ones only likely merged.
    const removable = all.filter((c) => !c.protected && !c.checkedOut && !c.likelyMerged);
    const foot = all.length > shown || removable.length > 0;
    const t: Tile = { b, d, x: colX(d), y, w: colW(d), h, a, ghost: ghost.has(b.name), open: open(b), all: !!toggles.get(`all:${b.name}`), merged: all.slice(0, shown), more: all.length - shown, removable, mergedAll: all };
    at.set(b.name, t);
    tiles.push(t);
    bottom[d] = y + h + (all.length ? 8 + (shown + (foot ? 1 : 0)) * 30 - 6 : 0);
  };
  for (const r of fam.roots) if (vis.has(r.name)) place(r, 0, TOP, "");

  const trunk = at.get(o.defaultBranch);
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
        const needs: [string, boolean][] = [[b.name, true]];
        if (k >= COMMITS_SHOWN) needs.push([`all:${b.name}`, true]);
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
export function useMapLayout(o: Overview | undefined, toggles: ReadonlyMap<string, boolean> = NO_TOGGLES, counts?: ReleaseCounts) {
  const [prefs] = useMapPrefs();
  const me = useMe().email;
  const { who, commits, merged, behind, shipped } = prefs;
  return useMemo(() => o && layoutMap(o, { who, commits, merged, behind, shipped }, me, toggles, counts), [o, who, commits, merged, behind, shipped, me, toggles, counts]);
}
const NO_TOGGLES = new Map<string, boolean>();

/** `name` and every branch above it, the root first. */
export function lineageOf(layout: Pick<MapLayout, "parent">, name?: string) {
  const out: string[] = [];
  for (let n = name; n && !out.includes(n); n = layout.parent(n)) out.unshift(n);
  return out;
}

/** What "Look at the code" opens on: the uncommitted work, else the branch's own changes, else the project's files. */
export const lookItem = (b?: BranchView): FocusItem => (b?.wip ? "wip" : b && b.ahead > 0 && b.parent ? "all" : "project");

/** The colour a branch's role reads in: trunks orange, releases purple, work in blue (fixes red). */
export const roleCls = (b: BranchView) => (b.role === "trunk" ? "c-current" : b.role === "release" ? "c-release" : b.kind === "fix" ? "c-del" : "c-mod");

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

/** Tags naming a branch's place: the default branch, the one checked out, a release's kind, and where it lives. */
export function BranchTags({ o, b }: { o: Overview; b: BranchView }) {
  const rel = b.role === "release" ? o.releases.find((r) => r.open && r.branch === b.name) : undefined;
  return (
    <>
      {b.name === o.defaultBranch && <span className="tag map-tag-trunk">Default</span>}
      {b.name === o.currentBranch && <span className="tag map-tag-trunk">Head</span>}
      {rel && <span className={`tag ${rel.tag === "hotfix" ? "c-warn" : "accent"}`}>{releaseTagLabel(rel.tag)}</span>}
      {b.likelyMerged && <span className="tag" title="A pull request carrying its ticket went into its base after its last commit. Not proof: it is never cleaned up as merged.">likely merged</span>}
      {b.local && !b.remote && b.exists && o.remote && <span className="tag local" title={`${b.name} doesn't exist on origin. Push it to share it.`}>local</span>}
      {b.remote && !b.local && <span className="tag accent" title={`${b.name} was never fetched into a local branch. Check it out to work on it locally.`}>origin</span>}
      {!b.exists && <span className="tag c-del">deleted</span>}
    </>
  );
}

/** Where the branch stands with origin, in a few words, and its colour. */
export function originOf(b: BranchView, remote: boolean): [string, string] {
  if (!remote) return ["no origin", "faint"];
  if (b.local && !b.remote) return ["local only, never pushed", "c-mod"];
  if (b.remote && !b.local) return ["only on origin, never fetched", "c-mod"];
  if (b.upstreamAhead && b.upstreamBehind) return [`diverged: ↑${b.upstreamAhead} ↓${b.upstreamBehind}`, "c-warn"];
  if (b.upstreamAhead) return [`↑${b.upstreamAhead} to push`, "c-mod"];
  if (b.upstreamBehind) return [`↓${b.upstreamBehind} to pull`, "c-mod"];
  return [b.upstream ? "synced with origin" : "not tracking origin", b.upstream ? "c-add" : "faint"];
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

/** How long after a merge ends the commit animations it held back play, so they land once the dialog is gone and the map has settled. */
const MERGE_SETTLE_MS = 450;

/**
 * Counts each time `value` grows past what was last seen (0 until then), so a key from it replays a CSS animation. Never fires on mount.
 * While `hold` is on, growth is kept back and counted once it turns off, after MERGE_SETTLE_MS.
 */
function useGrowth(value: number, hold: boolean): number {
  const last = useRef(value);
  const held = useRef(false);
  const [grew, setGrew] = useState(0);
  useEffect(() => {
    if (value > last.current) {
      if (hold || held.current) held.current = true;
      else setGrew((n) => n + 1);
    }
    last.current = value;
  }, [value, hold]);
  useEffect(() => {
    if (hold || !held.current) return;
    const id = setTimeout(() => {
      held.current = false;
      setGrew((n) => n + 1);
    }, MERGE_SETTLE_MS);
    return () => clearTimeout(id);
  }, [hold]);
  return grew;
}

/** A section's "Clean up": a spinner and what is left while its cleanup runs in the background. */
function CleanupButton({ left, title, onClick, text }: { left: number | undefined; title: string; onClick: () => void; text?: string }) {
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
  cleanupLeft,
  tagItems,
  onStashes,
  building,
  updating,
  progress,
  bar,
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
  /** Branches a running cleanup has left on a section ("merged:<parent>", "behind", "shipped"); undefined when none runs. */
  cleanupLeft: (section: string) => number | undefined;
  /** Actions for a shipped release's tag; the first one (check out) also runs on double-click. */
  tagItems: (tag: string, checkedOut: boolean) => MenuItem[];
  /** The stashes made on `b`, or every one. */
  onStashes: (b?: string) => void;
  /** First look at the project: branches are not filed under their parents yet. */
  building?: boolean;
  /** The overview is being read again (after an action, a fetch, a change in git). */
  updating?: boolean;
  progress?: { done: number; total: number } | null;
  /** Where the toolbar goes: a row above the map and the agent panel beside it. */
  bar: HTMLElement | null;
}) {
  const pid = o.project.id;
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
  const layout = useMapLayout(o, shownToggles, counts)!;
  const { tiles, at, W, H } = layout;
  const byName = useMemo(() => new Map(o.branches.map((b) => [b.name, b])), [o.branches]);
  const labelOf = (n: string) => {
    const b = byName.get(n);
    return b?.role === "release" && b.release ? label(b.release) : n;
  };
  const agentOf = useAgentOf(pid);
  const rebasing = useRebasing(pid);
  const merging = useIsMutating({ mutationKey: ["branches.merge"] }) > 0;
  const fetchOrigin = useAction("branches.fetch", { invalidate: [["overview", pid]], success: () => "Fetched origin" });

  // A filter hiding the selected branch: the map shows the checked-out one as selected instead.
  const onMap = (n?: string) => !!n && (at.has(n) || tiles.some((t) => t.merged.some((m) => m.name === n)) || layout.shipped.some((x) => x.b?.name === n));
  const shown = onMap(selected) ? selected : o.currentBranch && at.has(o.currentBranch) ? o.currentBranch : o.defaultBranch;
  // The selected branch's line up to the trunk, what grows from it, and the checked-out branch's line.
  const lin = new Set(lineageOf(layout, shown));
  const head = new Set(o.currentBranch ? lineageOf(layout, o.currentBranch) : []);
  const desc = new Set<string>();
  if (shown && shown !== o.defaultBranch) {
    const down = (n: string) => layout.kids(n).forEach((k) => (desc.add(k.name), down(k.name)));
    down(shown);
  }
  const flagsOf = (t: Tile): TileFlags => ({ head: head.has(t.b.name), lin: lin.has(t.b.name), desc: desc.has(t.b.name), stale: layout.stale(t.b) });

  const scroller = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLSpanElement>(null);
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
  // Tiles near the view: only those fetch the commits they list.
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const mini = Math.min(156 / W, 102 / H);
  const look = () => {
    const el = scroller.current;
    if (!el) return;
    const vx = (el.scrollLeft - pad.x) / zoom;
    const vy = (el.scrollTop - pad.y) / zoom;
    const vw = el.clientWidth / zoom;
    const vh = el.clientHeight / zoom;
    const f = frame.current;
    if (f) {
      // The overview frames only the part of the view over the map.
      const fx = Math.max(0, vx);
      const fy = Math.max(0, vy);
      f.style.left = `${10 + fx * mini}px`;
      f.style.top = `${8 + fy * mini}px`;
      f.style.width = `${Math.max(0, Math.min(W, vx + vw) - fx) * mini}px`;
      f.style.height = `${Math.max(0, Math.min(H, vy + vh) - fy) * mini}px`;
    }
    const m = 300;
    setSeen((s) => {
      const add = tiles.filter((t) => !s.has(t.b.name) && t.x < vx + vw + m && t.x + t.w > vx - m && t.y < vy + vh + m && t.y + t.h > vy - m);
      return add.length ? new Set([...s, ...add.map((t) => t.b.name)]) : s;
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
    const inView = left >= el.scrollLeft && left + t.w * zoom <= el.scrollLeft + el.clientWidth - room && top >= el.scrollTop && top + t.h * zoom <= el.scrollTop + el.clientHeight;
    if (inView) return;
    el.scrollTo({ left: left + (t.w * zoom) / 2 - (el.clientWidth - room) / 2, top: top + (t.h * zoom) / 2 - el.clientHeight / 2, behavior: smooth ? "smooth" : "auto" });
  };
  /** Brings `el`, on the map, into view unless it is already, out from under the card; a tall one from its top. */
  const bringIntoView = (el: Element) => {
    const s = scroller.current;
    if (!s) return;
    const r = el.getBoundingClientRect();
    const v = s.getBoundingClientRect();
    const w = s.clientWidth - (s.clientWidth > 720 ? CARD_ROOM : 0);
    if (r.left >= v.left && r.right <= v.left + w && r.top >= v.top && r.bottom <= v.top + s.clientHeight) return;
    const dy = r.height > s.clientHeight - 40 ? r.top - v.top - 20 : r.top + r.height / 2 - (v.top + s.clientHeight / 2);
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
  const keep = useRef<{ x: number; y: number; sx: number; sy: number } | null>(null);
  const setZoom = (z: number, sx?: number, sy?: number, fine = false) => {
    const el = scroller.current;
    if (el) {
      sx ??= el.clientWidth / 2;
      sy ??= el.clientHeight / 2;
      keep.current = { x: (el.scrollLeft + sx - pad.x) / zoom, y: (el.scrollTop + sy - pad.y) / zoom, sx, sy };
    }
    setPrefs({ zoom: Math.max(0.4, Math.min(1.4, fine ? z : Math.round(z * 10) / 10)) });
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
    return () => {
      v.removeEventListener("wheel", w);
      cancelAnimationFrame(s.raf);
    };
  }, []);

  // A mouse drag anywhere on the map pans it; under 5 px it stays a click. Touch keeps its native scroll.
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
    const z = Math.max(0.4, Math.min(1, Math.floor(Math.min((el.clientWidth - room) / W, el.clientHeight / H) * 10) / 10));
    // The map's top left corner at the view's, once zoomed.
    keep.current = z === zoom ? null : { x: 0, y: 0, sx: 0, sy: 0 };
    setPrefs({ zoom: z });
    el.scrollTo({ left: pad.x, top: pad.y });
  };

  const [tagMenu, setTagMenu] = useState<{ x: number; y: number; tag: string; checkedOut: boolean } | null>(null);
  // A commit listed on a tile, right-clicked: the same menu as in the focus view's timeline, for that tile's branch.
  // One a shipped release listed (`shipped`) is history: no resets, counted from a list it is not part of.
  const [menuOn, setMenuOn] = useState<{ b: BranchView; list: Commit[]; shipped?: boolean } | null>(null);
  const commitMenu = useCommitMenu({
    pid,
    branch: menuOn?.b.name ?? "",
    base: menuOn?.b.parent ? labelOf(menuOn.b.parent) : "",
    checkedOut: !!menuOn && (menuOn.b.checkedOut || menuOn.b.name === o.currentBranch),
    upstream: !!menuOn?.b.upstream,
    current: o.currentBranch ?? undefined,
    list: menuOn?.list ?? [],
    shipped: menuOn?.shipped,
  });
  const toggle = (key: string, on: boolean) => setToggles((m) => new Map(m).set(key, on));
  const defaultView = byName.get(o.defaultBranch);
  const select = (name: string) => {
    picked.current = name;
    onSelect(name);
  };

  // Edges run from a parent's right side to its child's left, in the colour of the line they are on.
  const edges: { d: string; cls: string; delay: number; box: [number, number, number, number] }[] = [];
  const behindTags: { x: number; y: number; n: number; b: BranchView; onto: string }[] = [];
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
    const cls = head.has(n) ? "head" : lin.has(n) ? "lin" : desc.has(n) ? "desc" : layout.stale(t.b) ? "stale" : t.ghost || (t.b.remote && !t.b.local) ? "far" : "";
    edges.push({ d: `M${x1} ${y1}C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`, cls, delay: lineageOf(layout, n).length - 2, box: [x1, Math.min(y1, y2), x2, Math.max(y1, y2)] });
    if (t.b.behind > 0 && t.b.exists) behindTags.push({ x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2), n: t.b.behind, b: t.b, onto: pn! });
  }

  // The pulse's layer spans only the checked-out branch's line: a big one would cost a texture as large as the map.
  const headEdges = edges.filter((e) => e.cls === "head");
  const pb = headEdges.length ? [Math.min(...headEdges.map((e) => e.box[0])) - 4, Math.min(...headEdges.map((e) => e.box[1])) - 4, Math.max(...headEdges.map((e) => e.box[2])) + 4, Math.max(...headEdges.map((e) => e.box[3])) + 4] : null;
  const trunk = at.get(o.defaultBranch);
  const shippedName = (r: ReleaseView) => r.tagName ?? label(r.version);
  const shippedDate = (r: ReleaseView) => {
    const iso = o.project.releases.find((x) => x.version === r.version)?.shippedAt ?? /tagged (\d{4}-\d{2}-\d{2})/.exec(r.base)?.[1];
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isNaN(t) ? "" : new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
  };
  const staleLeft = o.branches.filter((b) => layout.stale(b) && !b.protected && !b.checkedOut && !b.running && b.wip === 0);
  const sel = shown ? byName.get(shown) : undefined;
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
        <div className="map-group" role="group" aria-label="Commits on the map">
          <span className="map-group-label"><Icon name="commit" size={13} /><span className="map-label">Commits</span></span>
          <Seg<CommitsShown>
            label="Commits on the map"
            value={prefs.commits}
            onChange={(commits) => {
              setToggles(NO_TOGGLES);
              setPrefs({ commits });
            }}
            options={[
              { value: "hidden", label: "Hidden" },
              { value: "latest", label: "Latest" },
              { value: "list", label: "List" },
            ]}
          />
        </div>
        <div className="map-toggles" role="group" aria-label="Show on the map">
          {toggleBtn("merged", "Merged", layout.counts.merged)}
          {staleLeft.length > 0 || cleanupLeft("behind") !== undefined ? (
            // Its Clean up as the toggle's right side: one control.
            <span className="map-toggle-split">
              {toggleBtn("behind", "Falling behind", layout.counts.behind)}
              <CleanupButton left={cleanupLeft("behind")} title={`Pick which of the ${branches(staleLeft.length)} falling behind to delete`} onClick={() => onCleanupBehind("behind", "their base", staleLeft)} />
            </span>
          ) : (
            toggleBtn("behind", "Falling behind", layout.counts.behind)
          )}
          {toggleBtn("shipped", "Shipped", layout.shippedAll.length)}
        </div>
        {updating && !building && (
          <span className="map-updating faint" role="status">
            <span className="spinner" />
            {progress && progress.done < progress.total ? `Updating ${progress.done}/${progress.total}…` : "Updating…"}
          </span>
        )}
        <span className="grow" />
        <span className="map-acts">
          <button className="btn btn-sm btn-icon" aria-label="Search the map" data-tip={`Search branches, tags and commits (${showKeys(keys.find)})`} onClick={openFind}>
            <Icon name="search" size={14} />
          </button>
          {o.stashes.length > 0 && (
            <button className="btn btn-sm" aria-label={`Show ${stashCount(o.stashes.length)}`} data-tip={`${stashCount(o.stashes.length)} set aside`} onClick={() => onStashes()}>
              <Icon name="stash" size={13} />
              {o.stashes.length}
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
      <div ref={view} className="map-view">
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
                <span key={d} className="map-col" style={{ left: colX(d) }}>{c}</span>
              ))}

              {trunk && layout.shipped.length > 0 && (
                <>
                  <svg className="map-history" width={60} height={trunk.y} aria-hidden>
                    <path d={`M40 ${SHIPPED_TOP}V${trunk.y}`} />
                    {layout.shipped.map(({ y }, i) => (
                      <circle key={i} cx={40} cy={y} r={i === layout.shipped.length - 1 ? 4 : 3} data-new={i === layout.shipped.length - 1 || undefined} />
                    ))}
                  </svg>
                  <span className="map-history-head" style={{ top: 40 }}>
                    Shipped from {o.defaultBranch}
                    <span>{layout.shippedAll.length}</span>
                    {(layout.shippedLeft.length > 0 || cleanupLeft("shipped") !== undefined) && (
                      <CleanupButton
                        left={cleanupLeft("shipped")}
                        title={`Delete the ${branches(layout.shippedLeft.length, "shipped release branch")}, locally and on origin. Their tags stay.`}
                        onClick={() => onCleanupShipped(layout.shippedLeft)}
                      />
                    )}
                  </span>
                  {layout.shippedEarlier > 0 && (
                    <button
                      className="map-ship map-crow-more"
                      style={{ top: SHIPPED_TOP - 7 }}
                      aria-expanded={!!toggles.get("shipped:all")}
                      onClick={() => toggle("shipped:all", !toggles.get("shipped:all"))}
                    >
                      <span>{`${toggles.get("shipped:all") ? "" : "+"}${plural(layout.shippedEarlier, "earlier release")}`}</span>
                      <span className="map-crow-act">
                        {toggles.get("shipped:all") ? "Hide" : "See all"}
                        <Icon name="chevronDown" size={10} stroke={2} className="chev" />
                      </span>
                    </button>
                  )}
                  {layout.shipped.map(({ r, y, b, list }, i) => {
                    const tag = r.tagName;
                    const checkout = tag ? tagItems(tag, r.checkedOut)[0] : undefined;
                    const count = tag ? counts?.[tag] : undefined;
                    const name = shippedName(r);
                    // Its commits fold and unfold from the count on its right, or from the row itself when no branch is left to select.
                    const unfold = () => tag && toggle(`rel:${tag}`, !list);
                    const words = count ? `the ${plural(count.commits, "commit")} ${name} shipped${count.since ? `, since ${count.since}` : ", its whole history"}` : `the commits ${name} shipped`;
                    return (
                      <Fragment key={`${r.version}-${r.tag}`}>
                        <button
                          className="map-ship"
                          style={{ top: y - 7, maxWidth: SHIPPED_RIGHT - 50 - SHIPPED_COUNT_W - 4 }}
                          data-new={i === layout.shipped.length - 1 || undefined}
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
                          <span className="faint">{shippedDate(r)}</span>
                          {r.checkedOut && <span className="c-current">checked out</span>}
                        </button>
                        {tag && (
                          <button
                            className="map-ship-count"
                            style={{ top: y - 7, left: SHIPPED_RIGHT - SHIPPED_COUNT_W, width: SHIPPED_COUNT_W }}
                            aria-expanded={!!list}
                            aria-label={`${list ? "Hide" : "See"} the commits in ${name}`}
                            data-tip={`${list ? "Hide" : "See"} ${words}`}
                            onClick={unfold}
                          >
                            <Icon name="commit" size={10} stroke={1.6} />
                            <span className="map-ship-n">{count ? countLabel(count.commits) : "…"}</span>
                            <Icon name="chevronDown" size={9} stroke={2} className="chev" />
                          </button>
                        )}
                        {tag && list && (
                          <div className="map-ship-list" role="group" aria-label={`Commits in ${name}`} style={{ top: y + SHIPPED_LIST_TOP, left: SHIPPED_LIST_LEFT, width: SHIPPED_LIST_W, height: list.box }}>
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
                              onMenu={(c, shippedList, e) => {
                                if (!defaultView) return;
                                setMenuOn({ b: defaultView, list: shippedList, shipped: true });
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

              <svg className="map-edges" width={W} height={H} aria-hidden>
                {/* In user space: a straight line's box has no height, and a filter sized on it would hide it. */}
                {pb && (
                  <filter id="map-glow" filterUnits="userSpaceOnUse" x={pb[0] - 20} y={pb[1] - 20} width={pb[2] - pb[0] + 40} height={pb[3] - pb[1] + 40}>
                    <feGaussianBlur stdDeviation="1.3" />
                  </filter>
                )}
                {edges.map((e, i) => e.cls === "head" && <path key={`g${i}`} className="map-glow" d={e.d} filter="url(#map-glow)" />)}
                {edges.map((e, i) => <path key={i} d={e.d} data-line={e.cls || undefined} />)}
                {tiles.map(
                  (t) =>
                    t.merged.length > 0 && (
                      <path
                        key={`m${t.b.name}`}
                        className="map-merged-line"
                        d={t.merged
                          .map((_, i) => {
                            const x0 = t.x + 10;
                            const cy = t.y + t.h + 20 + i * 30;
                            return `M${x0} ${cy - 8}Q${x0} ${cy} ${x0 + 8} ${cy}H${x0 + 14}`;
                          })
                          .join("") + `M${t.x + 10} ${t.y + t.h}V${t.y + t.h + 12 + (t.merged.length - 1) * 30}`}
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
                        data-likely={m.likelyMerged || undefined}
                        aria-pressed={m.name === shown}
                        data-find-at={atHit?.b === m || undefined}
                        aria-label={`Select ${m.name}, ${m.likelyMerged ? "likely merged" : "merged"}`}
                        style={{ left: t.x + 24, top: t.y + t.h + 8 + i * 30 }}
                        onClick={() => select(m.name)}
                        onContextMenu={(e) => actions.openMenu(target(m.name), e)}
                      >
                        <Icon name={m.likelyMerged ? "merged" : "check"} size={11} stroke={1.8} />
                        <span className="ellipsis">{marked(m.name, qb, atHit?.b === m)}</span>
                      </button>
                    ))}
                    {(t.more > 0 || t.removable.length > 0 || cleanupLeft(`merged:${t.b.name}`) !== undefined) && (
                      <span className="map-merged-foot" style={{ left: t.x + 24, top: t.y + t.h + 8 + t.merged.length * 30 }}>
                        {t.more > 0 && (
                          <button className="map-more" onClick={() => toggle(`merged:${t.b.name}`, true)}>
                            +{t.more} more merged
                          </button>
                        )}
                        {t.merged.length > MERGED_SHOWN && (
                          <button className="map-more" onClick={() => toggle(`merged:${t.b.name}`, false)}>
                            Show fewer
                          </button>
                        )}
                        {(t.removable.length > 0 || cleanupLeft(`merged:${t.b.name}`) !== undefined) && (
                          <CleanupButton
                            left={cleanupLeft(`merged:${t.b.name}`)}
                            text="Clean up"
                            title={`Delete the ${branches(t.removable.length, "merged branch")} under ${labelOf(t.b.name)}, locally and on origin`}
                            onClick={() => onCleanup(t.b.name, labelOf(t.b.name), t.removable)}
                          />
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
                  o={o}
                  pid={pid}
                  label={label}
                  labelOf={labelOf}
                  selected={t.b.name === shown}
                  flags={flagsOf(t)}
                  commits={prefs.commits}
                  seen={seen.has(t.b.name)}
                  q={qb}
                  hitAt={atHit?.b === t.b && !atHit.chip}
                  find={t.ghost ? "" : qc}
                  findAt={atHit?.tile === t.b.name ? atHit.index : undefined}
                  agent={agentOf(t.b)}
                  run={rebasing.get(t.b.name)}
                  actions={actions}
                  target={target}
                  onSelect={select}
                  onFocus={onFocus}
                  onStashes={onStashes}
                  onCommitMenu={(c, list, e) => {
                    setMenuOn({ b: t.b, list });
                    commitMenu.open(c, e);
                  }}
                  onToggle={(open) => {
                    toggle(t.b.name, open);
                    toggle(`peek:${t.b.name}`, false);
                    select(t.b.name);
                  }}
                  onAll={(on) => {
                    toggle(`all:${t.b.name}`, on);
                    // "See all" on a folded tile unfolds it only for the full list: "Hide" folds it back to its newest commit.
                    if (!t.open) toggle(`peek:${t.b.name}`, on);
                    else if (!on && toggles.get(`peek:${t.b.name}`)) {
                      toggle(t.b.name, false);
                      toggle(`peek:${t.b.name}`, false);
                    }
                  }}
                  shippedTip={t.b.name === o.defaultBranch && layout.shippedAll[0] ? shippedName(layout.shippedAll[0]) : undefined}
                  merging={merging}
                />
              ))}
              {/* The pulse down the checked-out branch's line, on a layer of its own: each step repaints only it. After the tiles: under them,
                  WebKit put every tile its box overlaps on a layer too, and drew the checked-out one with square corners and a cut top. */}
              {pb && (
                <svg className="map-pulse" width={pb[2] - pb[0]} height={pb[3] - pb[1]} style={{ left: pb[0], top: pb[1] }} viewBox={`${pb[0]} ${pb[1]} ${pb[2] - pb[0]} ${pb[3] - pb[1]}`} aria-hidden>
                  {headEdges.map((e, i) => <path key={i} d={e.d} style={{ animationDelay: `${e.delay * 10 * (1000 / 12)}ms` }} />)}
                </svg>
              )}
              {behindTags.map((l, i) => {
                const text = `↓${l.n}`;
                const w = Math.round(12 + text.length * 6.3);
                const style = { left: l.x - w / 2, top: l.y - 9, width: w };
                // A local work branch, checked out or not (rebased aside then), not under a working agent. Shared branches catch up by merging.
                if (l.b.role === "branch" && l.b.local && l.b.running)
                  // Still focusable so keyboard users get the reason too.
                  return (
                    <button
                      key={i}
                      className="map-behind"
                      style={style}
                      aria-disabled="true"
                      data-tip={`Can't rebase ${labelOf(l.b.name)} onto ${labelOf(l.onto)} while its agent is working.`}
                      data-tip-strong="Wait until the agent finishes or asks you a question."
                    >
                      {text}
                    </button>
                  );
                return l.b.role === "branch" && l.b.local ? (
                  <button key={i} className="map-behind" style={style} data-tip={`Rebase ${labelOf(l.b.name)} onto ${labelOf(l.onto)}`} onClick={() => actions.askRebase(l.b.name, l.onto)}>
                    {text}
                  </button>
                ) : (
                  <span key={i} className="map-behind" style={style}>
                    {text}
                  </span>
                );
              })}
              {/* Outside the tiles, which clip: each "+" sits where the tile's lines leave on its right. */}
              {tiles.map((t) => {
                const add = actions.create(target(t.b.name));
                return (
                  add && (
                    <button key={`out${t.b.name}`} className="map-out" {...tileState(t, t.b.name === shown, t.b.name === o.currentBranch, flagsOf(t))} aria-label={`Create a branch from ${t.b.name}`} data-tip={add.tip} style={{ left: t.x + t.w - 9, top: t.y + t.a - 9 }} onClick={add.run}>
                      <Icon name="plus" size={10} stroke={2.2} />
                    </button>
                  )
                );
              })}
            </div>
          </div>
        </div>

        <div className="map-legend">
          <span><svg width="20" height="8" aria-hidden><path d="M2 4h16" className="map-key-head" /></svg>You are here</span>
          <span><svg width="20" height="8" aria-hidden><path d="M2 4h16" className="map-key-lin" /></svg>Selected line</span>
          <span><svg width="20" height="8" aria-hidden><path d="M2 4h16" className="map-key-stale" /></svg>Falling behind</span>
          <span className="faint">Click a commit or a WIP count to look at its code</span>
        </div>

        {sel && (
          <SelectedCard
            o={o}
            b={sel}
            t={target(sel.name)}
            chain={lineageOf(layout, sel.name).map((n) => byName.get(n)).filter((x): x is BranchView => !!x)}
            labelOf={labelOf}
            work={layout.work.get(sel.name)}
            stale={layout.stale(sel)}
            agent={agentOf(sel)}
            run={rebasing.get(sel.name)}
            actions={actions}
            onFocus={onFocus}
            onStashes={onStashes}
            shippedTip={layout.shippedAll[0]}
            shippedName={shippedName}
            shippedDate={shippedDate}
          />
        )}

        <button
          className="map-mini"
          aria-label="Map overview: click to go there"
          onClick={(e) => {
            const el = scroller.current;
            if (!el) return;
            const r = e.currentTarget.getBoundingClientRect();
            const x = (e.clientX - r.left - 10) / mini;
            const y = (e.clientY - r.top - 8) / mini;
            el.scrollTo({ left: pad.x + x * zoom - el.clientWidth / 2, top: pad.y + y * zoom - el.clientHeight / 2, behavior: "smooth" });
          }}
        >
          <MiniMap layout={layout} selected={shown} lin={lin} scale={mini} />
          <span ref={frame} className="map-mini-frame" />
        </button>
      </div>
      {tagMenu && <ContextMenu x={tagMenu.x} y={tagMenu.y} label={`Actions for ${tagMenu.tag}`} items={tagItems(tagMenu.tag, tagMenu.checkedOut)} onClose={() => setTagMenu(null)} />}
      {commitMenu.el}
    </section>
  );
}

/** The map in small: tiles as blocks, the selected one lit. */
export function MiniMap({ layout, selected, lin, scale, pad = [10, 8] }: { layout: MapLayout; selected?: string; lin: Set<string>; scale: number; pad?: [number, number] }) {
  return (
    <span className="map-mini-in" aria-hidden>
      {layout.tiles.map((t) => (
        <span
          key={t.b.name}
          data-k={t.b.name === selected ? "sel" : lin.has(t.b.name) ? "lin" : t.b.role}
          style={{ left: Math.round(pad[0] + t.x * scale), top: Math.round(pad[1] + t.y * scale), width: Math.max(3, Math.round(t.w * scale)), height: Math.max(2, Math.round(t.h * scale)) }}
        />
      ))}
    </span>
  );
}

/** One branch on the map: its name and state, its newest commits when unfolded. */
type TileFlags = { head: boolean; lin: boolean; desc: boolean; stale: boolean };

/** A tile's state as data attributes, on the tile and on its "+" so both draw the same border and glow. */
function tileState(t: Tile, selected: boolean, current: boolean, flags: TileFlags) {
  const b = t.b;
  return {
    "data-sel": selected || undefined,
    "data-head": current || undefined,
    "data-lin": (flags.lin && !selected) || undefined,
    "data-desc": flags.desc || undefined,
    "data-ghost": t.ghost || undefined,
    "data-stale": flags.stale || undefined,
    "data-far": (b.remote && !b.local) || undefined,
    "data-gone": !b.exists || undefined,
  };
}

function TileView({
  t,
  o,
  pid,
  label,
  labelOf,
  selected,
  flags,
  commits,
  seen,
  q,
  hitAt,
  find,
  findAt,
  agent,
  run,
  actions,
  target,
  onSelect,
  onFocus,
  onStashes,
  onToggle,
  onAll,
  onCommitMenu,
  shippedTip,
  merging,
}: {
  t: Tile;
  o: Overview;
  pid: string;
  label: (v: string) => string;
  labelOf: (n: string) => string;
  selected: boolean;
  flags: TileFlags;
  commits: CommitsShown;
  seen: boolean;
  q: string;
  hitAt: boolean;
  /** What the search marks in its commits, and the one it is on. */
  find: string;
  findAt?: number;
  agent?: AgentInfo;
  run?: RebaseRun;
  actions: BranchActions;
  target: (b: string) => BranchTarget;
  onSelect: (b: string) => void;
  onFocus: (b: string, item: FocusItem) => void;
  onStashes: (b?: string) => void;
  onToggle: (open: boolean) => void;
  onAll: (on: boolean) => void;
  /** A listed commit right-clicked: `list` holds the commits the tile lists. */
  onCommitMenu: (c: Commit, list: Commit[], e: MouseEvent) => void;
  shippedTip?: string;
  /** A merge is running: new commits wait for it to end before they pop. */
  merging: boolean;
}) {
  const nav = useNav();
  const { b } = t;
  const current = b.name === o.currentBranch;
  const lock = actions.locks.get(b.name);
  const parent = b.parent ?? "";
  const own = ownCommits(b);
  const n = Math.min(own, COMMITS_SHOWN);
  // A new commit landed: its count pops and glows, once a merge refreshing the map several times is over.
  const grew = useGrowth(own, merging);
  // The default branch counts what it has not released yet.
  const pillTip = parent
    ? `${plural(own, "commit")} not in ${labelOf(parent)}`
    : b.lastTag
      ? `${plural(own, "commit")} since ${b.lastTag}, not released yet`
      : `${plural(own, "commit")}, none released yet`;
  const pill = n > 0 && b.exists && (
    <button
      className="map-pill"
      {...tileState(t, selected, current, flags)}
      aria-expanded={t.open}
      aria-label={`${t.open ? "Fold" : "Unfold"} the commits of ${b.name}`}
      data-tip={pillTip}
      onClick={() => onToggle(!t.open)}
    >
      <Icon name="commit" size={11} stroke={1.6} />
      <span key={grew} className={grew > 0 ? "meta-link-grow" : undefined}>{countLabel(own)}</span>
      <Icon name="chevronDown" size={9} stroke={2} className="chev" />
    </button>
  );
  const chips: ReactNode[] = [];
  if (b.role === "branch") {
    if (agent?.state === "working") {
      chips.push(
        <span key="agent" className="map-chip map-agent glow-working">
          <Icon name="layers" size={11} stroke={1.6} />
          <span className="ellipsis">{agent.label}</span>
          <span>working</span>
        </span>,
      );
    } else if (agent?.state) {
      const cls = agent.state === "done" ? "c-add" : "c-warn";
      chips.push(
        <span key="agent" className={`map-chip map-agent ${cls}`}>
          {agent.state === "waiting" ? <span className="pulse" /> : <Icon name={agent.state === "done" ? "check" : "pause"} size={11} stroke={1.8} />}
          <span className="ellipsis">{agent.label}</span>
          {agent.state === "limit" ? "at limit" : agent.state}
        </span>,
      );
    }
    if (run) {
      chips.push(
        <button key="run" className="map-chip c-acc" data-tip={`AI is rebasing it onto ${run.onto}. Click to see how far it is.`} onClick={() => showRun(run.projectId, run.branch)}>
          <span className="spinner" />
          AI rebase{run.steps ? ` ${run.step}/${run.steps}` : ""}
        </button>,
      );
    } else if (b.conflict) {
      chips.push(<span key="op" className="map-chip c-del" title={`Its ${b.inProgress ?? "operation"} stopped on conflicts`}><Icon name="alert" size={11} stroke={1.8} />conflict</span>);
    } else if (b.inProgress) {
      chips.push(<span key="op" className="map-chip c-warn">mid-{b.inProgress}</span>);
    }
    if (current) chips.push(<span key="out" className="map-chip c-current">checked out</span>);
    else if (b.worktree && !agent) chips.push(<button key="out" className="map-chip" data-tip={`${b.worktree}. Click to open it in Worktrees & agents.`} onClick={() => nav.go({ name: "worktrees", key: b.worktree! })}><Icon name="layers" size={11} stroke={1.5} />worktree</button>);
  }
  const wip = b.wip > 0 && (
    <span key="wip" className="map-chip wip-badge">
      <span className="map-dot" />
      WIP {b.wip}
    </span>
  );
  if (b.role === "branch") {
    if (wip) chips.push(wip);
    if (!b.exists) chips.push(<span key="gone" className="map-chip c-del">deleted</span>);
    if (flags.stale) {
      const days = Math.floor((Date.now() - Date.parse(b.date)) / 86_400_000);
      chips.push(<span key="idle" className="map-chip c-warn" title={`${labelOf(parent)} is ${plural(b.behind, "commit")} ahead`}><Icon name="alert" size={11} stroke={1.8} />{days > 1 ? `idle ${days} days` : `↓${b.behind}`}</span>);
    }
    if (b.exists && !b.ahead && !b.wip && !agent) chips.push(<span key="none" className="map-chip faint">no commits yet</span>);
  }
  if (b.local && !b.remote && b.exists && o.remote) chips.push(<span key="sync" className="tag local">local</span>);
  if (b.remote && !b.local) chips.push(<span key="sync" className="tag accent">origin</span>);
  if (b.upstreamAhead > 0) chips.push(<span key="push" className="map-chip c-mod">↑{b.upstreamAhead} to push</span>);
  if (b.upstreamBehind > 0) chips.push(<span key="pull" className="map-chip c-mod">↓{b.upstreamBehind} to pull</span>);
  if (b.stashes > 0) chips.push(<button key="stash" className="map-chip" data-tip={`${stashCount(b.stashes)} made on ${b.name}`} onClick={() => onStashes(b.name)}><Icon name="stash" size={11} stroke={1.5} />{b.stashes}</button>);
  if (b.ticket) chips.push(<span key="ticket" className="map-chip mono faint">{b.ticket}</span>);

  const name = b.role === "branch" && b.kind ? b.short : b.name;
  const rel = b.role === "release" ? o.releases.find((r) => r.open && r.branch === b.name) : undefined;
  const openReleases = o.releases.filter((r) => r.open).length;
  return (
    <div
      className="map-tile"
      data-role={b.role}
      {...tileState(t, selected, current, flags)}
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
      <div className="map-tile-in">
        {b.role === "trunk" ? (
          <>
            <span className="map-row">
              <Icon name={b.name === o.defaultBranch ? "home" : "commit"} size={15} stroke={1.6} className="c-current" />
              <span className="map-trunk mono ellipsis">{marked(b.name, q, hitAt)}</span>
              {b.name === o.defaultBranch && <span className="tag map-tag-trunk">Default</span>}
              <span className="grow" />
              {wip}
              {pill}
            </span>
            <span className="map-sub">
              {[b.lastTag ? `${own ? "since" : "at"} ${b.lastTag}` : shippedTip && `tip ${shippedTip}`, ago(b.date), b.name === o.defaultBranch && openReleases ? `${plural(openReleases, "release")} open` : current ? "checked out" : ""].filter(Boolean).join(" · ")}
            </span>
          </>
        ) : b.role === "release" ? (
          <>
            <span className="map-row">
              <Icon name="tag" size={14} className="c-release" />
              <span className="map-ver mono ellipsis">{marked(b.release ? label(b.release) : b.name, q, hitAt)}</span>
              {rel && <span className={`tag ${rel.tag === "hotfix" ? "c-warn" : "accent"}`}>{releaseTagLabel(rel.tag)}</span>}
              <span className="grow" />
              {wip}
              {pill}
            </span>
            <span className="map-sub ellipsis">
              {[b.name, parent && `from ${labelOf(parent)}`, current ? "checked out" : ago(b.date)].filter(Boolean).join(" · ")}
            </span>
          </>
        ) : (
          <>
            <span className="map-row">
              {b.kind && <span className={`map-kind mono ${b.kind === "fix" ? "c-del" : "c-mod"}`}>{b.kind}</span>}
              <span className="map-name mono ellipsis">{marked(name, q, hitAt)}</span>
              {pill}
            </span>
            <span className="map-chips">{chips.slice(0, agent ? 2 : 3)}</span>
          </>
        )}
        {t.open ? (
          <TileCommits pid={pid} b={b} enabled={seen} onFocus={onFocus} onMenu={onCommitMenu} list all={t.all} onAll={onAll} current={current} find={find} at={findAt} />
        ) : (
          commits === "latest" &&
          n > 0 &&
          b.exists && (
            <TileCommits
              pid={pid}
              b={b}
              enabled={seen}
              onFocus={onFocus}
              onMenu={onCommitMenu}
              current={current}
              find={find}
              onAll={() => {
                // Unfold first: unfolding clears the peek mark that onAll then sets.
                onToggle(true);
                onAll(true);
              }}
            />
          )
        )}
      </div>
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
 * A tile's newest commits: all it lists when unfolded (origin's not pulled yet on top, the earlier ones once "see all" is
 * open), the newest local one alone otherwise. Fetched once the tile comes near the view.
 */
function TileCommits({
  pid,
  b,
  enabled,
  onFocus,
  onMenu,
  list,
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
  list?: boolean;
  all?: boolean;
  onAll?: (on: boolean) => void;
  /** Checked out here: the commit it's on gets a ring. */
  current?: boolean;
  /** What the search marks in the subjects and tags; `at`: the row the search is on. */
  find?: string;
  at?: number;
}) {
  const total = commitRows(b);
  const n = listedRows(b, !!all);
  // The default branch lists what it has not released; once whole, the tagged commit they came after closes the list.
  const unreleased = !b.parent;
  const tagged = !!list && endsOnTag(b, n);
  // The newest alone skips origin's not pulled yet, so it asks for those too. The tagged commit comes as one more.
  const q = useCommits(pid, enabled ? b.name : undefined, list ? n + (tagged ? 1 : 0) : b.upstreamBehind + 1, unreleased);
  const commits = q.data?.filter((c) => !c.base);
  const since = tagged ? q.data?.find((c) => c.base) : undefined;
  // Unfolded, the rows past the first six; folded, every row past the newest, and "see all" unfolds the tile with them all.
  const shown = list ? COMMITS_SHOWN : 1;
  const more = total > shown && onAll && (
    <button className="map-crow map-crow-more" aria-expanded={!!all} onClick={() => onAll(!all)}>
      <span>{all && total > n ? `${plural(total - n, "older commit")} not listed` : `${all ? "" : "+"}${plural(total - shown, "earlier commit")}`}</span>
      <span className="map-crow-act">
        {all ? "Hide" : "See all"}
        <Icon name="chevronDown" size={10} stroke={2} className="chev" />
      </span>
    </button>
  );
  // A commit's own menu, not the tile's branch menu under it.
  const menu = (c: Commit | undefined) => (e: MouseEvent) => {
    e.stopPropagation();
    if (c && commits) onMenu(c, commits, e);
  };
  // Found by its SHA: the row shows it, as it otherwise doesn't.
  const sha = (c: Commit, here: boolean) => find.length >= 4 && c.sha.startsWith(find) && <span className="mono map-crow-sha">{marked(c.sha.slice(0, 7), find, here)}</span>;
  if (!list) {
    const c = commits?.find((x) => !x.unpulled);
    return (
      <>
        <button className="map-latest" disabled={!c} onClick={() => c && onFocus(b.name, c)} onContextMenu={menu(c)}>
          {/* Ringed green only when checked out at the newest commit, nothing to pull. */}
          <span className="map-crow-who" data-on={current && c?.local && !b.upstreamBehind ? "latest" : undefined}>
            {c && <Avatar name={c.author} email={c.email} size={14} />}
          </span>
          <span className="ellipsis">{c ? marked(c.subject, find, false) : "…"}</span>
          {c && sha(c, false)}
          {c && <TagChips tags={c.tags} q={find} />}
          <span className="faint">{c && age(c.date)}</span>
        </button>
        {more}
      </>
    );
  }
  // The latest release, as a milestone under the commits that came after it.
  const tagRow = tagged && (
    <button
      className="map-crow map-crow-tag"
      disabled={!since}
      aria-label={`Look at ${b.lastTag}'s commit${since ? `, ${since.subject}` : ""}`}
      data-tip={`${b.lastTag}, the latest release: ${since ? `"${since.subject}", ${ago(since.date)}. ` : ""}The commits above came after it.`}
      onClick={() => since && onFocus(b.name, since)}
      onContextMenu={menu(since)}
    >
      <span className="map-crow-who map-crow-mark">
        <Icon name="tag" size={9} stroke={1.8} />
      </span>
      <span className="map-tagchip mono">{b.lastTag}</span>
      <span className="map-crow-rule" />
      <span className="faint">{since && age(since.date)}</span>
    </button>
  );
  return (
    <span className="map-commits">
      {Array.from({ length: n }, (_, i) => {
        const c = commits?.[i];
        // Loaded and shorter than counted: no row waits for a commit that won't come.
        if (commits && !q.isPlaceholderData && !c) return null;
        // The commit checked out: green when it's the newest, yellow when origin has newer ones to pull.
        const on = current && c?.local ? (b.upstreamBehind > 0 ? "behind" : "latest") : undefined;
        return (
          <button
            key={c?.sha ?? i}
            className="map-crow"
            disabled={!c}
            data-find-at={i === at || undefined}
            aria-label={c ? `Look at commit ${c.sha.slice(0, 7)}, ${c.subject}${c.unpulled ? ", not pulled yet" : ""}` : undefined}
            onClick={() => c && onFocus(b.name, c)}
            onContextMenu={menu(c)}
          >
            <span className="map-crow-who" data-on={on}>
              {c && <Avatar name={c.author} email={c.email} size={14} />}
            </span>
            <span className="ellipsis">{c ? marked(c.subject, find, i === at) : "…"}</span>
            {c && sha(c, i === at)}
            {c && <TagChips tags={c.tags} q={find} />}
            <span className="faint">{c && age(c.date)}</span>
          </button>
        );
      })}
      {tagRow}
      {more}
    </span>
  );
}

/** A commit the search finds: by its subject, the start of its SHA (4 characters or more), or a tag (but `skip`, its list's own). */
const commitMatches = (c: { sha: string; subject: string; tags: string[] }, q: string, skip?: string) =>
  !!q && (c.subject.toLowerCase().includes(q) || (q.length >= 4 && c.sha.startsWith(q)) || c.tags.some((t) => t !== skip && t.toLowerCase().includes(q)));

/** The tags on a commit, as chips: the first named (one the search `q` finds, if any), the others counted. `skip`: one the list already names (its release's). */
function TagChips({ tags, skip, q = "" }: { tags: string[]; skip?: string; q?: string }) {
  const found = (t: string) => !!q && t.toLowerCase().includes(q);
  const shown = tags.filter((t) => t !== skip).sort((a, b) => Number(found(b)) - Number(found(a)));
  if (!shown.length) return null;
  return (
    <span className="map-tags" data-tip={shown.length > 1 ? `Tags ${shown.join(", ")}` : `Tag ${shown[0]}`}>
      <span className="map-tagchip mono">
        <Icon name="tag" size={9} stroke={1.8} />
        <span className="ellipsis">{marked(shown[0], q, false)}</span>
      </span>
      {shown.length > 1 && <span className="map-tagchip">+{shown.length - 1}</span>}
    </span>
  );
}

/**
 * The commits a shipped release holds, newest first, under its row: the newest few, then "see all". `n` of `total` are
 * listed, each on two lines: its subject, then its date and its SHA, which copies on a click. Its own tag goes unsaid
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
        return (
          // The row opens the commit from a button behind it; its SHA is a button of its own on top.
          <div key={c?.sha ?? i} className="map-relrow" data-find-at={here || undefined}>
            <button className="map-hitbox" disabled={!c} aria-label={c ? `Look at commit ${c.sha.slice(0, 7)}, ${c.subject}` : "Loading"} onClick={() => c && onFocus(c)} onContextMenu={menu(c)} />
            <span className="map-crow-who">{c && <Avatar name={c.author} email={c.email} size={18} />}</span>
            <span className="map-relrow-text">
              <span className="map-relrow-subject ellipsis">{c ? marked(c.subject, q, here) : "…"}</span>
              {c && (
                <span className="map-relrow-meta">
                  <span>{ago(c.date)}</span>
                  <button className="map-sha mono" data-tip="Copy SHA" aria-label={`Copy SHA ${c.sha.slice(0, 7)}`} onClick={() => copyToClipboard(c.sha)}>
                    {marked(c.sha.slice(0, 7), q.length >= 4 ? q : "", here)}
                  </button>
                  <TagChips tags={c.tags} skip={tag} q={q} />
                </span>
              )}
            </span>
          </div>
        );
      })}
      {total > COMMITS_SHOWN && (
        <button className="map-crow map-crow-more" aria-expanded={all} onClick={() => onAll(!all)}>
          <span>{all && total > n ? `${plural(total - n, "older commit")} not listed` : `${all ? "" : "+"}${plural(total - COMMITS_SHOWN, "earlier commit")}`}</span>
          <span className="map-crow-act">
            {all ? "Hide" : "See all"}
            <Icon name="chevronDown" size={10} stroke={2} className="chev" />
          </span>
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
  chain,
  labelOf,
  work,
  stale,
  agent,
  run,
  actions,
  onFocus,
  onStashes,
  shippedTip,
  shippedName,
  shippedDate,
}: {
  o: Overview;
  b: BranchView;
  t: BranchTarget;
  chain: BranchView[];
  labelOf: (n: string) => string;
  work?: { open: number; merged: number };
  stale: boolean;
  agent?: AgentInfo;
  run?: RebaseRun;
  actions: BranchActions;
  onFocus: (b: string, item: FocusItem) => void;
  onStashes: (b?: string) => void;
  shippedTip?: ReleaseView;
  shippedName: (r: ReleaseView) => string;
  shippedDate: (r: ReleaseView) => string;
}) {
  // Folding or unfolding the card holds for every branch, across restarts.
  const [chosen, setFolded] = useStoredChoice("gnx.map.cardFolded");
  // Until then, on a phone the card starts folded, out of the map's way; picking another branch unfolds it.
  const [phone, setPhone] = useState(() => matchMedia("(max-width: 720px)").matches);
  const [was, setWas] = useState(b.name);
  if (was !== b.name) {
    setWas(b.name);
    setPhone(false);
  }
  const folded = chosen ?? phone;
  const parent = t.base;
  // Once the worktree's agent is done, suggest wrapping it up: merge into the parent and delete the worktree.
  const finish = b.worktree && agent?.state === "done" ? actions.action(t, "merge") : undefined;
  const p = finish && !finish.disabled ? finish : actions.primary(t);
  const tone = p.danger ? "btn-danger" : "btn-primary";
  const busy = actions.busy.has(b.name) || actions.rebasing.has(b.name);
  const checkedOut = b.checkedOut || b.name === o.currentBranch;
  const trunk = b.role === "trunk";
  const kind = b.role === "branch" && b.kind;
  const name = b.role === "release" && b.release ? `${labelOf(b.name)} · ${b.name}` : kind ? b.short : b.name;

  const look = lookItem(b);

  const root = chain.find((x) => x.role !== "branch");
  const sentence = (() => {
    if (trunk) {
      if (b.name !== o.defaultBranch) return `Long-lived branch${parent ? ` that merges into ${t.baseLabel}` : ""}.`;
      const at = b.lastTag ? (b.unreleased ? `, ${plural(b.unreleased, "commit")} past ${b.lastTag}` : `, at ${b.lastTag}`) : shippedTip ? `, at ${shippedName(shippedTip)}` : "";
      return `The default branch${at}. Releases are cut from it; shipping one merges it back and tags the version.`;
    }
    if (b.role === "release") {
      const rel = o.releases.find((r) => r.open && r.branch === b.name);
      const w = work ?? { open: 0, merged: 0 };
      return `${rel?.tag === "hotfix" ? "Hotfix release" : "Release"} cut from ${t.baseLabel}. ${branches(w.open, "open branch")}${w.merged ? ` and ${w.merged} merged in` : ""}. Shipping it merges it into ${o.defaultBranch} and tags ${b.release ? labelOf(b.name) : "the version"}.`;
    }
    if (!b.exists) return "Deleted here and on origin. Gitnetix still remembers it: delete it to forget it.";
    if (b.merged) return b.likelyMerged ? `Looks merged into ${t.baseLabel}: a pull request carrying its ticket went in after its last commit. It is never cleaned up as merged.` : `All its commits are in ${t.baseLabel}, so it ships with it. Safe to delete.`;
    const pv = chain[chain.length - 2];
    let s = `Merges into ${t.baseLabel}`;
    if (pv?.role === "branch" && root) s += `, which ships with ${labelOf(root.name)}`;
    else if (pv?.role === "release") s += " and ships with it";
    s += ".";
    if (stale) s += ` ${t.baseLabel} is ${plural(b.behind, "commit")} ahead and nothing moved here since ${ago(b.date)}.`;
    else if (b.behind) s += ` ${t.baseLabel} moved ${plural(b.behind, "commit")} ahead: update before merging.`;
    else if (b.ahead) s += ` ${plural(b.ahead, "commit")} ahead, nothing to pull.`;
    else s += " No commits yet.";
    return s;
  })();

  const nav = useNav();
  const [originText, originCls] = originOf(b, !!o.remote);
  const rows: [string, ReactNode, string?][] = [];
  if (run) rows.push(["Rebase", `AI rebasing onto ${labelOf(run.onto)}${run.steps ? `, ${run.step} of ${run.steps}` : ""}`, "c-acc"]);
  else if (b.conflict) rows.push([b.inProgress ? b.inProgress[0].toUpperCase() + b.inProgress.slice(1) : "Operation", "stopped on conflicts", "c-del"]);
  else if (b.inProgress) rows.push([b.inProgress[0].toUpperCase() + b.inProgress.slice(1), "paused in the middle", "c-warn"]);
  if (b.merged) rows.push([b.likelyMerged ? "Likely in" : "Merged into", t.baseLabel, "c-add"]);
  else if (b.role === "release" && b.release) rows.push(["Ships as", labelOf(b.name), "c-release"]);
  else if (trunk && b.name === o.defaultBranch && shippedTip) rows.push(["Tip", `${shippedName(shippedTip)}${shippedDate(shippedTip) ? ` · shipped ${shippedDate(shippedTip)}` : ""}`]);
  // What the next release ships from it so far.
  if (trunk && !b.parent && b.exists) {
    const n = b.unreleased ?? 0;
    rows.push(["Unreleased", b.lastTag ? (n ? `${plural(n, "commit")} since ${b.lastTag}` : `none since ${b.lastTag}`) : `${n >= 1000 ? "999+ commits" : plural(n, "commit")}, no tag yet`, n ? "c-mod" : "faint"]);
  }
  if (b.exists) {
    rows.push(["Checkout", checkedOut && !b.worktree ? "checked out here" : b.worktree ? "open in a worktree" : "not checked out", checkedOut && !b.worktree ? "c-current" : undefined]);
    rows.push(["Origin", originText, originCls]);
  }
  if (b.role === "branch" && b.exists && !b.merged) {
    if (b.behind) rows.push(["Behind", `${plural(b.behind, "commit")} from ${t.baseLabel}`, "c-warn"]);
    const text = agent && `${agent.label} · ${agentWords(agent)}`;
    // While its agent works, the row wears the agent chip's flowing colours.
    const words = agent?.state === "working" ? <span className="glow-working"><span>{text}</span></span> : text;
    rows.push([
      "Agent",
      agent?.row ? (
        <button className="link-btn" style={{ color: "inherit", textAlign: "left" }} data-tip="Open its session in Worktrees & agents" onClick={() => nav.go({ name: "worktrees", key: agent.row })}>
          {words}
        </button>
      ) : (
        (words ?? "none")
      ),
      agent?.state === "working" ? "c-release" : agent?.state === "done" ? "c-add" : agent?.state === "waiting" ? "c-warn ai-fade" : agent?.state ? "c-warn" : undefined]);
  }
  if (b.stashes) rows.push(["Stashes", <button className="link-btn" onClick={() => onStashes(b.name)}>{stashCount(b.stashes)}</button>]);
  if (b.ticket) rows.push(["Ticket", <span className="mono">{b.ticket}</span>]);

  return (
    <aside className="map-card" aria-label={`Selected branch ${b.name}`} data-folded={folded || undefined}>
      <div className="map-card-sec">
        <span className="map-eyebrow row" style={{ margin: 0 }}>
          Selected
          <span className="grow" />
          <button className="btn btn-ghost btn-sm btn-icon map-card-fold" aria-expanded={!folded} aria-label={folded ? "Show the selected branch" : "Fold the selected branch"} onClick={() => setFolded(!folded)}>
            <Icon name="chevronDown" size={12} className="chev" />
          </button>
        </span>
        <div className="map-card-name">
          {kind && <span className={`map-kind mono ${b.kind === "fix" ? "c-del" : "c-mod"}`}>{b.kind}</span>}
          {/* The name opens the branch full screen too; folded, the eye says so, as the hidden "Look at the code" did. */}
          <h3 className={`mono ${b.role === "branch" ? "" : roleCls(b)}`}>
            <button className="map-card-look" disabled={!b.exists} data-tip="Look at the code" onClick={() => onFocus(b.name, look)}>
              {name}
              {folded && <Icon name="eye" size={13} className="map-card-eye" />}
            </button>
          </h3>
          <BranchTags o={o} b={b} />
        </div>
      </div>
      {!folded && (
        <>
          <button className="btn btn-md btn-tint map-look" disabled={!b.exists} data-tip="Opens this branch full screen. Esc brings you back here." onClick={() => onFocus(b.name, look)}>
            <Icon name="eye" size={14} />
            <span>Look at the code</span>
            {look === "wip" ? (
              <span className="map-chip wip-badge">
                <span className="map-dot" />
                WIP · {plural(b.wip, "file")}
              </span>
            ) : (
              <span className="faint ellipsis">{look === "all" ? `Branch · ${plural(b.ahead, "commit")}` : "Project"}</span>
            )}
          </button>
          <p className="map-sentence">{sentence}</p>
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
        <button className={`btn btn-md ${tone} split-main grow`} disabled={p.disabled || busy} data-tip={p.tip} onClick={p.run}>
          {busy ? <span className="spinner" /> : <Icon name={p.icon ?? "check"} size={13} />}
          <span className="ellipsis">{p.short ?? p.label}</span>
        </button>
        <button className={`btn btn-md btn-icon ${tone} split-more`} aria-label={`More actions for ${b.name}`} data-tip={`More actions for ${b.name}`} aria-haspopup="menu" onClick={(e) => actions.openMenu(t, e)}>
          <Icon name="more" size={14} />
        </button>
      </div>
    </aside>
  );
}
