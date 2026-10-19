import { useMemo, useReducer, useState, type MouseEvent, type ReactNode } from "react";

import { useAction } from "../api/hooks";
import type { BranchView, Overview, ReleaseView } from "../api/types";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { Empty, releaseTagLabel } from "../components/ui";
import { plural, stashCount } from "../lib/format";
import { BranchSplit, type BranchActions, type BranchTarget } from "./BranchMenu";

/** Branches this many commits behind the default branch count as falling behind. */
const BEHIND_LIMIT = 25;
/** The Falling behind section shows once more than this many branches fall behind. */
const BEHIND_MIN_BRANCHES = 2;

/** Open sections per project, for this run of the app. */
const openSections = new Map<string, Set<string>>();

/**
 * Open sections of a project. The first time it shows in a run of the app, everything starts
 * closed except the sections leading to `initial`'s checked-out branch.
 */
function useToggles(pid: string, initial: () => Set<string>) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  if (!openSections.has(pid)) openSections.set(pid, initial());
  const open = openSections.get(pid)!;
  const isOpen = (id: string) => open.has(id);
  const toggle = (id: string) => {
    const next = new Set(open);
    if (!next.delete(id)) next.add(id);
    openSections.set(pid, next);
    rerender();
  };
  return { isOpen, toggle };
}

/**
 * Children of a branch, in display order: releases, trunks, active work by recency; merged ones apart.
 * Shipped release branches move to the Shipped section, unless that section doesn't list them or
 * the checked-out branch or unmerged work sits below them.
 */
function childrenOf(o: Overview) {
  const names = new Set(o.branches.map((b) => b.name));
  const kids = new Map<string, BranchView[]>();
  const roots: BranchView[] = [];
  for (const b of o.branches) {
    // A parent that no longer exists hands its children to the default branch.
    const p = b.parent ? (names.has(b.parent) ? b.parent : o.defaultBranch) : null;
    if (!p || p === b.name || !names.has(p)) roots.push(b);
    else if (kids.has(p)) kids.get(p)!.push(b);
    else kids.set(p, [b]);
  }
  // Dates carry each committer's own UTC offset, so compare instants, not strings.
  const time = (b: BranchView) => Date.parse(b.date) || 0;
  const relOrder = (b: BranchView) => o.releases.findIndex((r) => r.open && r.branch === b.name);
  const rank = (b: BranchView) => (b.role === "release" ? 0 : b.role === "trunk" ? 1 : b.exists ? 2 : 3);
  const order = (a: BranchView, b: BranchView) => rank(a) - rank(b) || relOrder(a) - relOrder(b) || time(b) - time(a) || a.name.localeCompare(b.name);
  const listed = new Set(o.releases.filter((r) => !r.open).map((r) => r.version));
  const inUse = (b: BranchView): boolean => b.name === o.currentBranch || (kids.get(b.name) ?? []).some((c) => !c.merged || inUse(c));
  const shipped = new Map<string, BranchView>();
  for (const b of o.branches) if (b.shipped && listed.has(b.shipped) && !inUse(b)) shipped.set(b.shipped, b);
  const inTree = (b: BranchView) => !(b.shipped && shipped.get(b.shipped) === b);
  for (const [p, list] of kids) kids.set(p, list.filter(inTree).sort(order));
  const tops = roots.filter(inTree);
  tops.sort((a, b) => (a.name === o.defaultBranch ? -1 : b.name === o.defaultBranch ? 1 : order(a, b)));
  return { roots: tops, shipped, kids: (name: string) => kids.get(name) ?? [] };
}

function look(b: BranchView, isDefault: boolean, shipped: boolean): { icon: string; cls: string } {
  if (!b.exists) return { icon: "close", cls: "c-del" };
  if (shipped) return { icon: "tag", cls: "" };
  if (b.merged) return { icon: "merged", cls: "c-add" };
  if (b.role === "release") return { icon: "tag", cls: "c-acc" };
  if (b.role === "trunk") return { icon: isDefault ? "home" : "commit", cls: "" };
  return { icon: "branch", cls: "" };
}

export function BranchTree({
  active,
  o,
  selected,
  actions,
  target,
  onSelect,
  onNewRelease,
  onHide,
  onCleanup,
  onCleanupBehind,
  tagItems,
  onStashes,
}: {
  active: boolean;
  o: Overview;
  selected?: string;
  actions: BranchActions;
  target: (b: string) => BranchTarget;
  onSelect: (b: string) => void;
  onNewRelease: () => void;
  onHide: () => void;
  /** Clean up the merged children of `parent`, shown as `label`. */
  onCleanup: (parent: string, label: string, branches: BranchView[]) => void;
  /** Clean up (delete) the branches falling behind the default branch. */
  onCleanupBehind: (branches: BranchView[]) => void;
  /** Actions for a shipped release's tag; the first one (check out) also runs on double-click. */
  tagItems: (tag: string, checkedOut: boolean) => MenuItem[];
  /** Opens every stash of the project. */
  onStashes: () => void;
}) {
  const pid = o.project.id;
  const [query, setQuery] = useState("");
  const [tagMenu, setTagMenu] = useState<{ x: number; y: number; alignRight: boolean; tag: string; checkedOut: boolean } | null>(null);
  const openTagMenu = (tag: string, checkedOut: boolean, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Same anchoring as the branch menu: the pointer on right-click, under the button (or element, from the keyboard) otherwise.
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const fromKey = e.type === "contextmenu" && e.clientX === 0 && e.clientY === 0;
    if (e.type !== "contextmenu") setTagMenu({ x: r.right, y: r.bottom + 2, alignRight: true, tag, checkedOut });
    else setTagMenu({ x: fromKey ? r.left : e.clientX, y: fromKey ? r.bottom + 2 : e.clientY, alignRight: false, tag, checkedOut });
  };
  const fetchOrigin = useAction("branches.fetch", { invalidate: [["overview", pid]], success: () => "Fetched origin" });
  const { roots, shipped: shippedBranches, kids } = useMemo(() => childrenOf(o), [o]);
  // Shipped releases: the branch row (with what merged into it) while it is still around, else a plain entry.
  const shipped = o.releases.filter((r) => !r.open);
  const tops = useMemo(() => [...roots, ...shippedBranches.values()], [roots, shippedBranches]);

  // Live branches off the default branch that have drifted far from it, furthest behind first.
  const behind = useMemo(() => {
    const names = new Set(o.branches.map((b) => b.name));
    const list = o.branches.filter((b) => {
      const parent = b.parent && names.has(b.parent) ? b.parent : o.defaultBranch;
      return b.name !== o.defaultBranch && parent === o.defaultBranch && b.exists && !b.merged && b.behind >= BEHIND_LIMIT;
    });
    return list.length > BEHIND_MIN_BRANCHES ? list.sort((a, b) => b.behind - a.behind || a.name.localeCompare(b.name)) : [];
  }, [o]);
  // Protected, checked-out, busy or dirty branches stay put.
  const behindRemovable = behind.filter((b) => !b.protected && !b.checkedOut && !b.running && b.wip === 0);

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return null;
    const hit = new Set<string>();
    const walk = (b: BranchView): boolean => {
      const child = kids(b.name).map(walk).some(Boolean);
      const self = b.name.toLowerCase().includes(q) || (b.release ?? "").includes(q);
      if (self || child) hit.add(b.name);
      return self || child;
    };
    tops.forEach(walk);
    return hit;
  }, [q, tops, kids]);
  const shown = (b: BranchView) => !matches || matches.has(b.name);
  // The checked-out branch and every branch above it, marked whether or not their children are showing.
  const path = useMemo(() => {
    const on = new Set<string>();
    const walk = (b: BranchView): boolean => {
      const hit = kids(b.name).map(walk).some(Boolean) || b.name === o.currentBranch;
      if (hit) on.add(b.name);
      return hit;
    };
    tops.forEach(walk);
    return on;
  }, [tops, kids, o.currentBranch]);
  // Only the groups the path runs through start open: live children or the merged ones.
  const { isOpen, toggle } = useToggles(pid, () => {
    const open = new Set<string>();
    for (const name of path) {
      for (const c of kids(name)) if (path.has(c.name)) open.add(c.merged ? `merged:${name}` : name);
    }
    return open;
  });

  // Uncommitted files anywhere below a branch, surfaced on its toggle while its children are hidden.
  const hiddenWip = (b: BranchView): number => kids(b.name).reduce((n, c) => n + c.wip + hiddenWip(c), 0);

  const node = (b: BranchView): ReactNode => {
    if (!shown(b)) return null;
    const children = kids(b.name).filter(shown);
    const live = children.filter((c) => !c.merged);
    const merged = children.filter((c) => c.merged);
    const hasKids = children.length > 0;
    const open = !!q || isOpen(b.name);
    const wipBelow = open ? 0 : live.reduce((n, c) => n + c.wip + hiddenWip(c), 0);
    const mergedKey = `merged:${b.name}`;
    const mergedOpen = !!q || isOpen(mergedKey);
    const version = b.role === "release" ? b.release : b.shipped;
    const mergedLabel = version ? `v${version}` : b.name;
    // Protected and checked-out branches stay put.
    const removable = merged.filter((c) => !c.protected && !c.checkedOut);
    // Where the orange path leaves this branch: into a merged child, or past the merged group to a live one.
    const pathLive = live.some((c) => path.has(c.name));
    const pathMerged = merged.some((c) => path.has(c.name));
    return (
      <div key={b.name} role="group" className="tree-node">
        <Row
          b={b}
          t={target(b.name)}
          isDefault={b.name === o.defaultBranch}
          tag={releaseTag(o.releases, b)}
          shipped={b.shipped ?? undefined}
          selected={b.name === selected}
          current={b.name === o.currentBranch}
          onPath={path.has(b.name)}
          actions={actions}
          onSelect={() => onSelect(b.name)}
        />
        {hasKids && (
          // Merged children come first, then the show/hide toggle for the live ones; the nesting line starts below it.
          <div className="tree-sub">
            {merged.length > 0 && (
              <>
                <div className="tree-row tree-group tree-merged" data-path={pathLive || pathMerged || undefined}>
                  <button className="tree-merged-toggle" aria-expanded={mergedOpen} onClick={() => toggle(mergedKey)}>
                    <span className="tree-twist"><Icon name="chevronDown" size={12} className="chev" /></span>
                    <span>Merged into {mergedLabel}</span>
                    <span className="faint">{merged.length}</span>
                  </button>
                  {removable.length > 0 && (
                    <button className="btn btn-sm tree-cleanup" title={`Delete the ${removable.length} merged branch${removable.length === 1 ? "" : "es"} under ${mergedLabel}, locally and on origin`} onClick={() => onCleanup(b.name, mergedLabel, removable)}>
                      Clean up
                    </button>
                  )}
                </div>
                {mergedOpen && <div className="tree-kids" data-path={pathMerged ? "in" : pathLive ? "past" : undefined}>{merged.map((c) => node(c))}</div>}
              </>
            )}
            {live.length > 0 && !q && (
              <button className="tree-row tree-group tree-toggle" data-path={pathLive || undefined} aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} the child branches of ${b.name}`} onClick={() => toggle(b.name)}>
                <span className="tree-twist"><Icon name="chevronDown" size={12} className="chev" /></span>
                <span className="child-label">Child branches</span>
                <span className="faint">{live.length}</span>
                {wipBelow > 0 && <span className="wip-badge" title={`${plural(wipBelow, "file")} with uncommitted changes in hidden branches`}>(WIP {wipBelow})</span>}
              </button>
            )}
            {live.length > 0 && open && (
              <div className="tree-open">
                <div className="tree-kids">{live.map((c) => node(c))}</div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <section aria-label="Branches" className="ws-releases" data-pane data-active={active}>
      <div className="pane-head">
        <span className="row" style={{ gap: 6 }}>
          <button className="btn btn-sm btn-icon hide-narrow pane-toggle" aria-label="Hide branches" onClick={onHide}>
            <Icon name="sidebar" size={13} />
          </button>
          <span className="label">Branches</span>
        </span>
        <span className="row" style={{ gap: 4 }}>
          {o.stashes.length > 0 && (
            <button className="btn btn-sm" aria-label={`Show ${stashCount(o.stashes.length)}`} data-tip={`${stashCount(o.stashes.length)} set aside`} onClick={onStashes}>
              <Icon name="stash" size={12} stroke={1.6} />
              <span>{o.stashes.length}</span>
            </button>
          )}
          <button className="btn btn-sm btn-icon" aria-label="Fetch origin" disabled={fetchOrigin.isPending || !o.remote} onClick={() => fetchOrigin.mutate({ projectId: pid })}>
            {fetchOrigin.isPending ? <span className="spinner" /> : <Icon name="refresh" size={12} />}
          </button>
          <button className="btn btn-sm" onClick={onNewRelease}>
            <Icon name="plus" size={12} stroke={1.6} />
            <span>Release</span>
          </button>
        </span>
      </div>
      {(o.branches.length > 6 || query) && (
        <div className="tree-filter">
          <Icon name="search" size={12} className="faint" />
          <input type="search" className="input" placeholder="Filter branches" aria-label="Filter branches" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      )}
      <div className="scroll tree" style={{ flex: "1 1 auto" }}>
        {(q ? tops : roots).map((b) => node(b))}
        {matches?.size === 0 && <Empty>No branch matches “{query}”.</Empty>}
        {behind.length > 0 && !q && (
          <>
            <div className="tree-row tree-group tree-merged tree-behind" style={{ marginTop: 8 }}>
              <button className="tree-merged-toggle" aria-expanded={isOpen("behind")} title={`Branches ${BEHIND_LIMIT} or more commits behind ${o.defaultBranch}. Update or rebase them to catch up.`} onClick={() => toggle("behind")}>
                <span className="tree-twist"><Icon name="chevronDown" size={12} className="chev" /></span>
                <span>Branches falling behind</span>
                <span className="faint">{behind.length}</span>
              </button>
              {behindRemovable.length > 0 && (
                <button className="btn btn-sm tree-cleanup" title={`Pick which of the ${plural(behindRemovable.length, "branch")} falling behind ${o.defaultBranch} to delete`} onClick={() => onCleanupBehind(behindRemovable)}>
                  Clean up
                </button>
              )}
            </div>
            {isOpen("behind") &&
              behind.map((b) => (
                <Row
                  key={`behind:${b.name}`}
                  b={b}
                  t={target(b.name)}
                  isDefault={false}
                  tag={releaseTag(o.releases, b)}
                  selected={b.name === selected}
                  current={b.name === o.currentBranch}
                  onPath={false}
                  actions={actions}
                  onSelect={() => onSelect(b.name)}
                />
              ))}
          </>
        )}
        {shipped.length > 0 && !q && (
          <>
            <button className="tree-row tree-group" style={{ marginTop: 8 }} aria-expanded={isOpen("shipped")} onClick={() => toggle("shipped")}>
              <span className="tree-twist"><Icon name="chevronDown" size={12} className="chev" /></span>
              <span className="shipped-label">Shipped</span>
              <span className="faint">{shipped.length}</span>
            </button>
            {isOpen("shipped") &&
              shipped.map((r) => {
                const b = shippedBranches.get(r.version);
                if (b) return node(b);
                const tag = r.tagName;
                const checkout = tag ? tagItems(tag, r.checkedOut)[0] : undefined;
                return (
                  <div
                    key={`${r.version}-${r.tag}`}
                    className="tree-row tree-static"
                    data-role="release"
                    data-current={r.checkedOut || undefined}
                    onContextMenu={tag ? (e) => openTagMenu(tag, r.checkedOut, e) : undefined}
                    onDoubleClick={checkout && checkout !== "sep" && !checkout.disabled ? checkout.run : undefined}
                  >
                    <span className="tree-btn">
                      <span className="tree-icon"><Icon name="tag" size={13} stroke={1.4} /></span>
                      <span className="tree-main">
                        <span className="tree-name"><span className="mono ellipsis">v{r.version}</span><span className={`tag${r.tag === "released" ? " released" : ""}`}>{releaseTagLabel(r.tag)}</span></span>
                        <span className="branch-meta">
                          <span className="mono">{r.base}</span>
                          {r.checkedOut && <span className="c-current">checked out</span>}
                          {r.note && <span>{r.note}</span>}
                        </span>
                      </span>
                    </span>
                    {tag && checkout && checkout !== "sep" && (
                      <span className="tree-acts">
                        <span className="acts" onDoubleClick={(e) => e.stopPropagation()}>
                          <button className="act act-main" disabled={checkout.disabled} aria-label={`Check out ${tag}`} data-tip={`Check out the commit ${tag} points at (detached HEAD)`} onClick={checkout.run}>
                            <Icon name="swap" size={14} />
                          </button>
                          <span className="act-stack">
                            <button className="act" aria-label={`More actions for ${tag}`} data-tip={`More actions for ${tag}`} aria-haspopup="menu" onClick={(e) => openTagMenu(tag, r.checkedOut, e)}>
                              <Icon name="more" size={13} />
                            </button>
                          </span>
                        </span>
                      </span>
                    )}
                  </div>
                );
              })}
          </>
        )}
      </div>
      {tagMenu && <ContextMenu x={tagMenu.x} y={tagMenu.y} alignRight={tagMenu.alignRight} label={`Actions for ${tagMenu.tag}`} items={tagItems(tagMenu.tag, tagMenu.checkedOut)} onClose={() => setTagMenu(null)} />}
      <div className="hint" style={{ padding: "10px 16px", borderTop: "1px solid var(--line)" }}>Double-click a branch to switch to it, right-click for every action, click its commit count (or "all commits" on main) to browse them. Your uncommitted work comes along.</div>
    </section>
  );
}

function releaseTag(releases: ReleaseView[], b: BranchView) {
  const r = b.role === "release" ? releases.find((x) => x.open && x.branch === b.name) : undefined;
  return r ? <span className={`tag${r.tag === "next" ? " accent" : ""}`}>{releaseTagLabel(r.tag)}</span> : null;
}

/** One branch, laid out the same whatever its role: icon, name + status line, actions. */
function Row({
  b,
  t,
  isDefault,
  tag,
  shipped,
  selected,
  current,
  onPath,
  actions,
  onSelect,
}: {
  b: BranchView;
  t: BranchTarget;
  isDefault: boolean;
  tag: ReactNode;
  /** Version this (shipped) release branch went out as. */
  shipped?: string;
  selected: boolean;
  current: boolean;
  /** It is, or holds somewhere below it, the checked-out branch. */
  onPath: boolean;
  actions: BranchActions;
  onSelect: () => void;
}) {
  const { icon, cls } = look(b, isDefault, !!shipped);
  const name = shipped ? `v${shipped}` : b.role === "release" && b.release ? `v${b.release}` : b.role === "branch" && b.kind ? b.short : b.name;
  return (
    <div
      className="tree-row"
      data-current={current || undefined}
      data-path={onPath || undefined}
      data-dim={b.merged || !b.exists || undefined}
      data-role={shipped ? "release" : b.role}
      onContextMenu={(e) => actions.openMenu(t, e)}
    >
      <button className="tree-btn" aria-pressed={selected} onClick={onSelect} onDoubleClick={() => b.exists && !b.checkedOut && actions.switchTo(b.name)}>
        <span className={`tree-icon ${cls}`}><Icon name={icon} size={13} stroke={1.5} /></span>
        <span className="tree-main">
          <span className="tree-name">
            <span className="mono ellipsis">{name}</span>
            {shipped ? <span className="tag released">{releaseTagLabel("released")}</span> : tag}
          </span>
          <BranchMeta b={b} parent={t.baseLabel} current={current} showName={!!shipped} onCommits={t.showCommits} onStashes={t.showStashes} />
        </span>
      </button>
      <span className="tree-acts">
        <BranchSplit t={t} actions={actions} />
      </span>
    </div>
  );
}

/** Status line under a branch, same order for every role. */
function BranchMeta({
  b,
  parent,
  current,
  showName,
  onCommits,
  onStashes,
}: {
  b: BranchView;
  parent: string;
  current: boolean;
  showName?: boolean;
  onCommits?: () => void;
  onStashes?: () => void;
}) {
  const tracked = b.exists && !b.merged && !!parent;
  return (
    <span className="branch-meta">
      {b.role === "branch" && b.kind && <span className={`kind-chip ${b.kind === "fix" ? "c-del" : "c-mod"}`}>{b.kind}</span>}
      {(b.role === "release" || showName) && <span className="mono">{b.name}</span>}
      {current && <span className="c-current">checked out</span>}
      {b.worktree && <span className="row" style={{ gap: 4 }}><Icon name="layers" size={11} stroke={1.4} />worktree</span>}
      {b.running && <span className="row c-acc" style={{ gap: 4 }}><span className="pulse" style={{ width: 5, height: 5 }} />AI working</span>}
      {b.conflict && <span className="c-del">conflict</span>}
      {b.wip > 0 && <span className="wip-badge" title={`${plural(b.wip, "file")} with uncommitted changes`}>WIP {b.wip}</span>}
      {!b.exists && <span className="c-del">branch deleted</span>}
      {b.merged && (
        <span className="pill c-add" title={`All its commits are in ${parent}`}>
          <Icon name="merged" size={10} stroke={1.6} />
          merged
        </span>
      )}
      {tracked && b.ahead > 0 && (
        // Inside the row's button, so a span: the context menu offers the same for keyboards.
        <span
          className={onCommits ? "meta-link" : undefined}
          data-tip={`${plural(b.ahead, "commit")} not in ${parent} yet${onCommits ? ". Click to list them." : ""}`}
          onClick={onCommits && ((e) => { e.stopPropagation(); onCommits(); })}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {plural(b.ahead, "commit")}
        </span>
      )}
      {tracked && b.ahead === 0 && b.role === "branch" && <span>no commits yet</span>}
      {b.exists && !parent && onCommits && (
        // A trunk has no base to count against: offer its recent history instead.
        <span
          className="meta-link"
          data-tip={`Browse the recent commits of ${b.name}`}
          onClick={(e) => { e.stopPropagation(); onCommits(); }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          all commits
        </span>
      )}
      {b.stashes > 0 && (
        <span
          className={`row${onStashes ? " meta-link meta-link-icon" : ""}`}
          style={{ gap: 3 }}
          data-tip={`${stashCount(b.stashes)} made on ${b.name}${onStashes ? ". Click to list them." : ""}`}
          onClick={onStashes && ((e) => { e.stopPropagation(); onStashes(); })}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <Icon name="stash" size={11} stroke={1.5} />
          {b.stashes}
        </span>
      )}
      {tracked && b.behind > 0 && (
        <span className="c-warn" title={`${parent} has ${plural(b.behind, "commit")} that ${b.name} doesn't. Update or rebase to catch up.`}>
          ↓{b.behind} from {parent}
        </span>
      )}
      {b.local && !b.remote && <span className="tag" title={`${b.name} doesn't exist on origin. Push it to share it.`}>local</span>}
      {b.remote && !b.local && <span className="tag" title={`${b.name} was never fetched into a local branch. Check it out to work on it locally.`}>origin</span>}
      {b.upstreamBehind > 0 && (
        <span className="tag c-warn" title={`${plural(b.upstreamBehind, "commit")} on origin not in the local ${b.name}. Pull to catch up.`}>
          local ↓{b.upstreamBehind}
        </span>
      )}
      {b.upstreamAhead > 0 && (
        <span className="tag c-warn" title={`${plural(b.upstreamAhead, "local commit")} never pushed: origin is behind. Push to update it.`}>
          origin ↓{b.upstreamAhead}
        </span>
      )}
      {b.ticket && <span className="mono">{b.ticket}</span>}
    </span>
  );
}
