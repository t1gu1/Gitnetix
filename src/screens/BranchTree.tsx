import { useMemo, useState, type ReactNode } from "react";

import { useAction } from "../api/hooks";
import type { BranchView, Overview, ReleaseView } from "../api/types";
import { Icon } from "../components/Icon";
import { Empty, releaseTagLabel } from "../components/ui";
import { plural } from "../lib/format";
import { useNav } from "../lib/nav";
import { useStored } from "../lib/stored";
import { BranchSplit, type BranchActions, type BranchTarget } from "./BranchMenu";

/** Sections that start closed; every other section starts open. */
const CLOSED_BY_DEFAULT = new Set(["shipped"]);

/** Collapsed sections, remembered per project in this browser. */
function useToggles(pid: string) {
  const [flipped, setFlipped] = useStored<Record<string, boolean>>(`gnx.tree.${pid}`, {});
  const isOpen = (id: string) => CLOSED_BY_DEFAULT.has(id) === !!flipped[id];
  const toggle = (id: string) => setFlipped({ ...flipped, [id]: !flipped[id] });
  return { isOpen, toggle };
}

/** Children of a branch, in display order: releases, trunks, active work by recency; merged ones apart. */
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
  for (const list of kids.values()) list.sort(order);
  roots.sort((a, b) => (a.name === o.defaultBranch ? -1 : b.name === o.defaultBranch ? 1 : order(a, b)));
  return { roots, kids: (name: string) => kids.get(name) ?? [] };
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
}: {
  active: boolean;
  o: Overview;
  selected?: string;
  actions: BranchActions;
  target: (b: string) => BranchTarget;
  onSelect: (b: string) => void;
  onNewRelease: () => void;
  onHide: () => void;
}) {
  const nav = useNav();
  const pid = o.project.id;
  const { isOpen, toggle } = useToggles(pid);
  const [query, setQuery] = useState("");
  const fetchOrigin = useAction("branches.fetch", { invalidate: [["overview", pid]], success: () => "Fetched origin" });
  const { roots, kids } = useMemo(() => childrenOf(o), [o]);
  // Shipped releases whose branch is gone; the others show in the tree with what they shipped.
  const shipped = o.releases.filter((r) => !r.open && !o.branches.some((b) => b.shipped === r.version));

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
    roots.forEach(walk);
    return hit;
  }, [q, roots, kids]);
  const shown = (b: BranchView) => !matches || matches.has(b.name);

  const ghost = (b: BranchView) => {
    const release = b.role === "release" ? b.release : undefined;
    return (
      <div key={`new-${b.name}`} className="tree-row tree-ghost">
        <span className="tree-twist" />
        <button className="btn btn-primary btn-sm" onClick={() => nav.openNewItem(release ? { release } : { from: b.name })}>
          <Icon name="plus" size={12} stroke={1.8} />
          <span className="ellipsis">{release ? "New feature or fix" : <>New branch off <span className="mono">{b.name}</span></>}</span>
        </button>
      </div>
    );
  };

  const node = (b: BranchView): ReactNode => {
    if (!shown(b)) return null;
    const children = kids(b.name).filter(shown);
    const live = children.filter((c) => !c.merged);
    const merged = children.filter((c) => c.merged);
    const canGrow = b.exists && (b.role === "release" || b.role === "trunk") && !q;
    const hasKids = children.length > 0 || canGrow;
    const open = !!q || isOpen(b.name);
    const mergedKey = `merged:${b.name}`;
    const mergedOpen = !!q || isOpen(mergedKey);
    const version = b.role === "release" ? b.release : b.shipped;
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
          twist={hasKids ? { open, toggle: () => toggle(b.name) } : undefined}
          actions={actions}
          onSelect={() => onSelect(b.name)}
        />
        {open && (
          <>
            {/* Trunks offer a new branch first, its + under the trunk's own icon; a release lists its work, then the way to add more. */}
            {canGrow && b.role === "trunk" && ghost(b)}
            <div className="tree-kids">
              {live.map((c) => node(c))}
              {canGrow && b.role === "release" && ghost(b)}
              {merged.length > 0 && (
                <>
                  <button className="tree-row tree-group tree-merged" aria-expanded={mergedOpen} onClick={() => toggle(mergedKey)}>
                    <span className="tree-twist"><Icon name="chevronDown" size={12} className="chev" /></span>
                    <span>Merged into {version ? `v${version}` : b.name}</span>
                    <span className="faint">{merged.length}</span>
                  </button>
                  {mergedOpen && <div className="tree-kids">{merged.map((c) => node(c))}</div>}
                </>
              )}
            </div>
          </>
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
        {roots.map((b) => node(b))}
        {matches?.size === 0 && <Empty>No branch matches “{query}”.</Empty>}
        {shipped.length > 0 && !q && (
          <>
            <button className="tree-row tree-group" style={{ marginTop: 8 }} aria-expanded={isOpen("shipped")} onClick={() => toggle("shipped")}>
              <span className="tree-twist"><Icon name="chevronDown" size={12} className="chev" /></span>
              <span>Shipped</span>
              <span className="faint">{shipped.length}</span>
            </button>
            {isOpen("shipped") &&
              shipped.map((r) => (
                <div key={`${r.version}-${r.tag}`} className="tree-row tree-static" data-role="release">
                  <span className="tree-twist" />
                  <span className="tree-btn">
                    <span className="tree-icon"><Icon name="tag" size={13} stroke={1.4} /></span>
                    <span className="tree-main">
                      <span className="tree-name"><span className="mono ellipsis">v{r.version}</span><span className={`tag${r.tag === "released" ? " released" : ""}`}>{releaseTagLabel(r.tag)}</span></span>
                      <span className="branch-meta">
                        <span className="mono">{r.base}</span>
                        {r.note && <span>{r.note}</span>}
                      </span>
                    </span>
                  </span>
                </div>
              ))}
          </>
        )}
      </div>
      <div className="hint" style={{ padding: "10px 16px", borderTop: "1px solid var(--line)" }}>Double-click a branch to switch to it, right-click for every action, click its commit count to browse them. Your uncommitted work comes along.</div>
    </section>
  );
}

function releaseTag(releases: ReleaseView[], b: BranchView) {
  const r = b.role === "release" ? releases.find((x) => x.open && x.branch === b.name) : undefined;
  return r ? <span className={`tag${r.tag === "next" ? " accent" : ""}`}>{releaseTagLabel(r.tag)}</span> : null;
}

/** One branch, laid out the same whatever its role: twist, icon, name + status line, actions. */
function Row({
  b,
  t,
  isDefault,
  tag,
  shipped,
  selected,
  current,
  twist,
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
  twist?: { open: boolean; toggle: () => void };
  actions: BranchActions;
  onSelect: () => void;
}) {
  const { icon, cls } = look(b, isDefault, !!shipped);
  const name = shipped ? `v${shipped}` : b.role === "release" && b.release ? `v${b.release}` : b.role === "branch" && b.kind ? b.short : b.name;
  return (
    <div
      className="tree-row"
      data-current={current || undefined}
      data-dim={b.merged || !b.exists || undefined}
      data-role={shipped ? "release" : b.role}
      onContextMenu={(e) => actions.openMenu(t, e)}
    >
      {twist ? (
        <button className="tree-twist" aria-expanded={twist.open} aria-label={`${twist.open ? "Collapse" : "Expand"} ${b.name}`} onClick={twist.toggle}>
          <Icon name="chevronDown" size={12} className="chev" />
        </button>
      ) : (
        <span className="tree-twist" />
      )}
      <button className="tree-btn" aria-pressed={selected} onClick={onSelect} onDoubleClick={() => b.exists && !b.checkedOut && actions.switchTo(b.name)}>
        <span className={`tree-icon ${cls}`}><Icon name={icon} size={13} stroke={1.5} /></span>
        <span className="tree-main">
          <span className="tree-name">
            <span className="mono ellipsis">{name}</span>
            {shipped ? <span className="tag released">{releaseTagLabel("released")}</span> : tag}
          </span>
          <BranchMeta b={b} parent={t.baseLabel} current={current} showName={!!shipped} onCommits={t.showCommits} />
        </span>
      </button>
      <span className="tree-acts">
        <BranchSplit t={t} actions={actions} />
      </span>
    </div>
  );
}

/** Status line under a branch, same order for every role. */
function BranchMeta({ b, parent, current, showName, onCommits }: { b: BranchView; parent: string; current: boolean; showName?: boolean; onCommits?: () => void }) {
  const tracked = b.exists && !b.merged && !!parent;
  return (
    <span className="branch-meta">
      {b.role === "branch" && b.kind && <span className={`kind-chip ${b.kind === "fix" ? "c-del" : "c-mod"}`}>{b.kind}</span>}
      {(b.role === "release" || showName) && <span className="mono">{b.name}</span>}
      {current && <span className="c-current">checked out</span>}
      {b.worktree && <span className="row" style={{ gap: 4 }}><Icon name="layers" size={11} stroke={1.4} />worktree</span>}
      {b.running && <span className="row c-acc" style={{ gap: 4 }}><span className="pulse" style={{ width: 5, height: 5 }} />AI working</span>}
      {b.conflict && <span className="c-del">conflict</span>}
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
      {tracked && b.behind > 0 && (
        <span className="c-warn" title={`${parent} has ${plural(b.behind, "commit")} that ${b.name} doesn't. Update or rebase to catch up.`}>
          ↓{b.behind} from {parent}
        </span>
      )}
      {(b.upstreamAhead > 0 || b.upstreamBehind > 0) && (
        <span className="mono" title={`${b.upstreamAhead} to push, ${b.upstreamBehind} to pull`}>
          {b.upstreamAhead > 0 && `↑${b.upstreamAhead}`}
          {b.upstreamAhead > 0 && b.upstreamBehind > 0 && " "}
          {b.upstreamBehind > 0 && `↓${b.upstreamBehind}`}
        </span>
      )}
      {b.remote && !b.local && <span className="tag" title="Only on origin. Check it out to work on it locally.">origin</span>}
      {b.local && !b.upstream && b.role === "branch" && b.ahead > 0 && <span title="Not pushed to origin yet">local</span>}
      {b.ticket && <span className="mono">{b.ticket}</span>}
    </span>
  );
}
