import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import { useAction, useGraph } from "../api/hooks";
import type { BranchView, Commit, Overview } from "../api/types";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { GRAPH_ROW, GraphCanvas, PreviewBanner, rowCenter, showsBranch } from "../components/GraphCanvas";
import { Icon } from "../components/Icon";
import { ErrorBox } from "../components/ui";
import { above, holds, layout, NEW_BRANCH, ownerOf, reachable, repoOf, simulate, tipOf, type Focus, type GLabel, type GRow, type Node, type Preview, type Repo } from "../lib/graph";
import { intentBranches, releaseHeld, useHeldPreview, useHoveredBranch, usePinnedBranch, usePreviewAction } from "../lib/graphPreview";
import { copyToClipboard } from "../lib/toast";
import type { BranchActions, BranchTarget } from "./BranchMenu";
import { DeleteTagModal, ResetModal, TagModal, type ResetMode } from "./CommitList";

/** A hover has to rest this long before the graph previews it, so passing over a menu doesn't flicker it; leaving waits a little too. */
const ENTER_MS = 70;
const LEAVE_MS = 110;
/** A branch row hovered this long in the tree joins the graph when it isn't in it. */
const BRANCH_DWELL_MS = 220;
/** `value` once it has stayed the same for `ms` (`leaveMs` when it goes back to nothing). */
function useSettled<T>(value: T, ms: number, leaveMs = ms): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (Object.is(value, settled)) return;
    const t = setTimeout(() => setSettled(value), value ? ms : leaveMs);
    return () => clearTimeout(t);
  }, [value, settled, ms, leaveMs]);
  return settled;
}

/** Lane color of a branch: trunks and releases keep their hue from the tree, work branches take one each. */
function colorsFor(o: Overview, lanes: string[]) {
  const work = ["var(--mod-fg)", "var(--prop-fg)", "var(--add-fg)", "var(--del-fg)", "var(--warn-fg)"];
  const byName = new Map(o.branches.map((b) => [b.name, b]));
  const picked = new Map<string, string>();
  let n = 0;
  for (const b of lanes) {
    const v = byName.get(b);
    picked.set(b, v?.role === "trunk" || b === o.defaultBranch ? "var(--trunk-fg)" : v?.role === "release" ? "var(--release-fg)" : work[n++ % work.length]);
  }
  return (b: string) => picked.get(b) ?? (b === NEW_BRANCH ? "var(--accent)" : work[n % work.length]);
}

export interface GraphPaneProps {
  pid: string;
  o: Overview;
  /** Branches shown, left to right: trunks first. */
  lanes: string[];
  /** Branches whose commits come first: the selected one first. */
  first: string[];
  /** Commit open in the files pane. */
  selected?: string;
  /** Uncommitted files in the main checkout. */
  wip: number;
  baseOf: (b: string) => string;
  actions: BranchActions;
  target: (b: string) => BranchTarget;
  tagItems: (tag: string, checkedOut: boolean) => MenuItem[];
  onOpenCommit: (c: Commit, branch: string) => void;
  onOpenWip: () => void;
  onSelectBranch: (b: string) => void;
  onClose: () => void;
}

/**
 * The commit graph of the selected branch, its base, the checked-out branch and a few around them, in a column of its own.
 * Hovering an action shows what the graph would look like once it ran: what changes fades in and pulses, what goes fades out.
 */
export function GraphPane(props: GraphPaneProps) {
  const { pid, o, lanes, first, selected, wip, baseOf, actions, target, tagItems, onOpenCommit, onOpenWip, onSelectBranch, onClose } = props;
  const byName = useMemo(() => new Map(o.branches.map((b) => [b.name, b])), [o.branches]);
  // A release reads as its version, as everywhere in the app; labels in the graph also drop a feature's or fix's type, like the tree's rows.
  const labelOf = useMemo(() => (b: string) => {
    const v = byName.get(b);
    return v?.role === "release" && v.release ? `v${v.release}` : b;
  }, [byName]);
  const hoveredNow = useHoveredBranch();
  const pinned = usePinnedBranch();
  // A branch row hovered long enough, or the branch whose menu is open.
  const hoveredRow = useSettled(hoveredNow, BRANCH_DWELL_MS, 0) ?? pinned;
  const rawIntent = usePreviewAction();
  const intent = useSettled(rawIntent, ENTER_MS, LEAVE_MS);
  const held = useHeldPreview();
  // The branches asked for: the shown ones, the ones the previewed action needs, and a branch hovered in the tree.
  const asked = useMemo(() => {
    const extra = [...intentBranches(intent), ...(hoveredRow ? [hoveredRow] : [])].filter((b) => b !== NEW_BRANCH && !lanes.includes(b) && byName.get(b)?.exists);
    return [...lanes, ...new Set(extra)];
  }, [lanes, intent, hoveredRow, byName]);
  // What the overview says of them: when it changes (a fetch moved origin, a commit landed), the graph is read again.
  const state = useMemo(
    () => asked.map((b) => { const v = byName.get(b); return v ? `${b}:${v.date}:${v.ahead}:${v.behind}:${v.upstreamAhead}:${v.upstreamBehind}:${+v.local}${+v.remote}${+v.checkedOut}` : b; }).join("|") + `|${o.currentBranch ?? ""}`,
    [asked, byName, o.currentBranch],
  );
  const graph = useGraph(pid, asked, state, true);
  // A picked action's preview holds until the graph it led to arrives.
  const updated = graph.dataUpdatedAt;
  useEffect(() => {
    if (held && updated > held.at) releaseHeld();
  }, [held, updated]);

  const repo = useMemo(() => graph.data && repoOf(graph.data, wip), [graph.data, wip]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const color = useMemo(() => colorsFor(o, asked), [o, asked]);
  const short = useMemo(() => (b: string) => {
    const v = byName.get(b);
    return v?.role === "branch" && v.kind ? v.short : labelOf(b);
  }, [byName, labelOf]);
  const focus: Focus = useMemo(() => ({ lanes: asked, first, open, keep: selected, color, label: short }), [asked, first, open, selected, color, short]);
  const base = useMemo(() => repo && layout(repo, focus), [repo, focus]);
  const preview: Preview | null | undefined = useMemo(() => (repo && intent ? simulate(repo, intent, labelOf) : undefined), [repo, intent, labelOf]);
  const shown = useMemo(() => (preview && !preview.noop ? layout(preview.repo, focus) : base), [preview, base, focus]);
  const previewing = !!preview && !preview.noop;

  // The branch to bring forward: a label under the pointer here, else a branch row under it in the tree.
  const [hoverLabel, setHoverLabel] = useState<string | null>(null);
  const hl = hoverLabel ?? (hoveredNow && lanes.includes(hoveredNow) ? hoveredNow : hoveredRow);

  // Where the column sits, for a dialog's scrim to leave it undimmed while the dialog previews in it.
  const section = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = section.current;
    if (!el) return;
    const root = document.documentElement.style;
    const put = () => {
      const r = el.getBoundingClientRect();
      // Root properties restyle the whole page: only when they change.
      for (const [k, v] of [["--graph-left", r.left], ["--graph-cut", r.right], ["--graph-top", r.top]] as const) {
        if (root.getPropertyValue(k) !== `${v}px`) root.setProperty(k, `${v}px`);
      }
    };
    put();
    const ro = new ResizeObserver(put);
    ro.observe(el);
    window.addEventListener("resize", put);
    // The column slides in: where it lands is known once that's done (its rows' own fades bubble up here too).
    const landed = (e: AnimationEvent) => e.target === el && put();
    el.addEventListener("animationend", landed);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", put);
      el.removeEventListener("animationend", landed);
      for (const k of ["--graph-left", "--graph-cut", "--graph-top"]) root.removeProperty(k);
    };
  }, []);

  const scroller = useRef<HTMLDivElement>(null);
  // The commit picked elsewhere (the commit list) scrolls into view here.
  useLayoutEffect(() => {
    const row = selected && shown?.rows.find((r) => r.node?.sha === selected || r.hidden?.some((n) => n.sha === selected));
    const el = scroller.current;
    if (!row || !el) return;
    const y = rowCenter(row.row);
    if (y < el.scrollTop + GRAPH_ROW || y > el.scrollTop + el.clientHeight - GRAPH_ROW) el.scrollTo({ top: y - el.clientHeight / 3, behavior: "smooth" });
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; label: string } | null>(null);
  const [reset, setReset] = useState<{ node: Node; branch: string; mode: ResetMode } | null>(null);
  const [tagging, setTagging] = useState<Node | null>(null);
  const [deletingTag, setDeletingTag] = useState<string | null>(null);
  const inv = [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid]];
  const revert = useAction<{ sha: string }>("commits.revert", { invalidate: inv, success: (r) => `Reverted · ${r.sha.slice(0, 7)}` });
  const pick = useAction<{ sha: string }>("commits.cherryPick", { invalidate: inv, success: (r) => `Cherry-picked onto ${o.currentBranch} · ${r.sha.slice(0, 7)}` });

  const commitOf = (n: Node): Commit => ({ sha: n.sha, author: n.author, email: n.email, date: n.date, subject: n.subject, body: "", tags: n.tags });
  /** Branch a commit opens in, and that its commit actions apply to: its line's branch, else the first shown branch holding it. */
  const ownerFor = (r: GRow): string => {
    const sha = r.node!.sha;
    const named = r.branch && repo && holds(repo, r.branch, sha) ? r.branch : undefined;
    return named ?? (repo && ownerOf(repo, sha, [...first, ...asked], baseOf)) ?? first[0];
  };
  const openRow = (r: GRow) => {
    if (r.kind === "fold") return setOpen((s) => new Set(s).add(r.key));
    if (r.kind === "wip") return onOpenWip();
    if (r.kind === "commit" && r.node && !r.node.sim) onOpenCommit(commitOf(r.node), ownerFor(r));
  };

  const commitItems = (r: GRow): MenuItem[] => {
    const n = r.node!;
    const abbr = n.sha.slice(0, 7);
    const owner = ownerFor(r);
    const ov = byName.get(owner);
    const needCheckout = ov?.checkedOut ? undefined : "check out first";
    // Origin's commits not pulled yet can't be reverted, and only a hard reset goes forward onto one (as in the commit list).
    const localTip = repo?.local.get(owner);
    const needLocal = localTip && repo && !reachable(repo, localTip).has(n.sha) ? "pull first" : needCheckout;
    const cur = o.currentBranch ?? undefined;
    const onCur = !!cur && !!repo && reachable(repo, tipOf(repo, cur)).has(n.sha);
    const pickHint = !cur ? "nothing checked out" : onCur ? "already there" : undefined;
    const resetTo = (mode: ResetMode): MenuItem => ({
      id: `reset-${mode}`,
      label: `Reset here · ${mode}`,
      icon: mode === "hard" ? "trash" : "back",
      hint: (mode === "hard" ? needCheckout : needLocal) ?? (mode === "soft" ? "keep staged" : mode === "mixed" ? "keep unstaged" : "discard"),
      danger: mode === "hard",
      disabled: !!(mode === "hard" ? needCheckout : needLocal),
      preview: { kind: "resetTo", branch: owner, sha: n.sha, mode },
      run: () => setReset({ node: n, branch: owner, mode }),
    });
    return [
      { id: "open", label: "Show its changes", icon: "file", run: () => onOpenCommit(commitOf(n), owner) },
      { id: "copy", label: "Copy SHA", icon: "copy", hint: abbr, run: () => copyToClipboard(n.sha) },
      "sep",
      { id: "revert", label: <>Revert on <span className="mono">{short(owner)}</span></>, icon: "undo", hint: needLocal, disabled: !!needLocal, preview: { kind: "revert", branch: owner, sha: n.sha }, run: () => revert.mutate({ projectId: pid, branch: owner, sha: n.sha }) },
      {
        id: "pick",
        label: <>Cherry-pick onto <span className="mono">{cur ? short(cur) : "…"}</span></>,
        icon: "commit",
        hint: pickHint,
        disabled: !!pickHint,
        preview: cur ? { kind: "cherryPick", onto: cur, sha: n.sha } : undefined,
        run: () => pick.mutate({ projectId: pid, onto: cur, sha: n.sha }),
      },
      "sep",
      resetTo("soft"),
      resetTo("mixed"),
      resetTo("hard"),
      "sep",
      { id: "tag", label: "Create tag…", icon: "tag", preview: { kind: "tag", sha: n.sha }, run: () => setTagging(n) },
      ...n.tags.map((t): MenuItem => ({ id: `deleteTag:${t}`, label: <>Delete tag <span className="mono">{t}</span>…</>, icon: "trash", danger: true, preview: { kind: "deleteTag", tag: t }, run: () => setDeletingTag(t) })),
    ];
  };
  const at = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const fromKey = e.clientX === 0 && e.clientY === 0;
    return { x: fromKey ? r.left : e.clientX, y: fromKey ? r.bottom + 2 : e.clientY };
  };
  const rowMenu = (r: GRow, e: MouseEvent) => {
    if (r.kind !== "commit" || !r.node || r.node.sim) return;
    setMenu({ ...at(e), items: commitItems(r), label: `Actions for ${r.node.sha.slice(0, 7)}` });
  };
  const labelMenu = (l: GLabel, e: MouseEvent) => {
    if (l.made) return;
    if (l.tag) return setMenu({ ...at(e), items: tagItems(l.tag, false), label: `Actions for ${l.tag}` });
    if (l.branch && byName.has(l.branch)) actions.openMenu(target(l.branch), e);
  };

  const hlShown = showsBranch(shown, hl);

  const active = first[0];
  const from = active ? baseOf(active) : "";
  return (
    <section ref={section} className="ws-graph" aria-label="Commit graph" data-preview={previewing || undefined} data-hl={hlShown || undefined}>
      <div className="pane-head">
        <span className="row" style={{ gap: 8, minWidth: 0 }}>
          <span className="label">Graph</span>
          {active && (
            <span className="faint mono ellipsis" style={{ fontSize: 11 }}>
              {labelOf(active)}
              {from && from !== active && <> ← {labelOf(from)}</>}
            </span>
          )}
          {graph.isFetching && !graph.isLoading && <span className="spinner graph-spin" role="status" aria-label="Updating" />}
        </span>
        <button className="btn btn-sm btn-icon" aria-label="Hide the commit graph" data-tip="Hide the graph" onClick={onClose}>
          <Icon name="close" size={12} />
        </button>
      </div>
      <PreviewBanner active={!!intent} preview={preview} loading={!!intent && preview === null && graph.isFetching} />
      <div ref={scroller} className="scroll graph-scroll">
        {graph.isLoading && <div className="empty"><span className="spinner" /></div>}
        {graph.error && <div style={{ padding: 12 }}><ErrorBox error={graph.error} /></div>}
        {shown && (
          <GraphCanvas
            shown={shown}
            base={previewing ? base : null}
            selected={selected}
            hl={hl}
            wip={wip}
            onOpen={openRow}
            onMenu={rowMenu}
            onLabel={(l) => l.branch && !l.made && byName.has(l.branch) && onSelectBranch(l.branch)}
            onLabelSwitch={(l) => l.branch && !l.made && byName.get(l.branch)?.exists && !byName.get(l.branch)?.checkedOut && actions.switchTo(l.branch)}
            onLabelMenu={labelMenu}
            onLabelHover={setHoverLabel}
          />
        )}
        {shown && shown.rows.length === 0 && !graph.isFetching && <div className="empty engraved">No commits to show.</div>}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} label={menu.label} items={menu.items} onClose={() => setMenu(null)} />}
      {reset && repo && (
        <GraphReset pid={pid} repo={repo} node={reset.node} branch={reset.branch} view={byName.get(reset.branch)} mode={reset.mode} commitOf={commitOf} onMode={(mode) => setReset({ ...reset, mode })} onClose={() => setReset(null)} />
      )}
      {tagging && <TagModal pid={pid} commit={commitOf(tagging)} onClose={() => setTagging(null)} />}
      {deletingTag && <DeleteTagModal pid={pid} tag={deletingTag} onClose={() => setDeletingTag(null)} />}
    </section>
  );
}

/** The reset dialog of the commit list, its counts worked out from the graph. */
function GraphReset({ pid, repo, node, branch, view, mode, commitOf, onMode, onClose }: { pid: string; repo: Repo; node: Node; branch: string; view?: BranchView; mode: ResetMode; commitOf: (n: Node) => Commit; onMode: (m: ResetMode) => void; onClose: () => void }) {
  const tip = repo.local.get(branch);
  const up = repo.remote.get(branch);
  const local = !!tip && reachable(repo, tip).has(node.sha);
  const { dropped, unpushed } = tip ? above(repo, tip, node.sha) : { dropped: [], unpushed: [] };
  const restored = !local && up && tip ? above(repo, node.sha, tip).dropped.length : 0;
  return (
    <ResetModal
      pid={pid}
      branch={branch}
      commit={{ ...commitOf(node), unpulled: !local, origin: up === node.sha }}
      dropped={local ? dropped.length : 0}
      restored={restored}
      lost={unpushed.map(commitOf)}
      mode={mode}
      upstream={!!view?.upstream}
      onMode={onMode}
      onDone={() => {}}
      onClose={onClose}
    />
  );
}

