import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";

import { switchedOverview, useAction, useAgents, useAiOn, useAutoFetch, useBlobs, useDiff, useFiles, useOverview, useProjectPrefs, useProjects } from "../api/hooks";
import { isLocal, revealPath } from "../api/transport";
import type { AgentSession, BranchView, Commit, FileChange, Hunk, MergeResult, Overview, RebaseResult, ReleaseView, Stash } from "../api/types";
import { AgentLog } from "../components/AgentLog";
import { AgentPicker, useAgentPick } from "../components/AgentPicker";
import { DiffView, type DiffMode } from "../components/DiffView";
import { IMAGE_MODES, ImageDiff, comparable, isImage, useImageMode } from "../components/ImageDiff";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { Resizer, usePaneWidth } from "../components/Resizer";
import { Busy, ErrorBox, Loading, Markdown, Modal, Seg } from "../components/ui";
import { ago, plural } from "../lib/format";
import { startCleanup, useCleaning } from "../lib/cleanups";
import { useNav } from "../lib/nav";
import { useStoredChoice, useStoredFlag } from "../lib/stored";
import { copyToClipboard, toast } from "../lib/toast";
import { offersRebase, rebaseMessage, useBranchActions, type BranchDialog, type BranchTarget } from "./BranchMenu";
import { BranchTree } from "./BranchTree";
import { CommitList } from "./CommitList";
import { ConflictModal } from "./ConflictModal";
import { StashList } from "./StashList";

type Mode = "branch" | "wip" | "project";
type Pane = "releases" | "files" | "diff";

export function Workspace() {
  const nav = useNav();
  const pid = nav.projectId!;
  const ov = useOverview(pid);
  useAutoFetch(pid, !!ov.data?.remote);
  const [mode, setMode] = useState<Mode>("wip");
  const [file, setFile] = useState<string | undefined>();
  const [diffMode, setDiffMode] = useState<DiffMode>("unified");
  const [preview, setPreview] = useState(false);
  const [imageMode, setImageMode] = useImageMode();
  const [termOpen, setTermOpen] = useStoredFlag("gnx.pane.termOpen");
  const [pane, setPane] = useState<Pane>("releases");
  const [shipping, setShipping] = useState<ReleaseView | null>(null);
  // `then` runs once the merge is done (closing a worktree session after merging it).
  const [dialog, setDialog] = useState<{ kind: BranchDialog; branch: string; onto?: string; then?: () => void; stay?: boolean } | null>(null);
  const [closingSession, setClosingSession] = useState<AgentSession | null>(null);
  const [deletingTag, setDeletingTag] = useState<string | null>(null);
  const checkoutTag = useAction<unknown, { projectId: string; name: string }>("tags.checkout", {
    invalidate: [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid]],
    patch: (qc, v) => qc.setQueryData<Overview>(["overview", pid], (o) => o && switchedOverview(o, null, v.name)),
  });
  const [cleanup, setCleanup] = useState<{ parent: string; label: string; branches: BranchView[] } | null>(null);
  const [cleanupBehind, setCleanupBehind] = useState<{ section: string; base: string; branches: BranchView[] } | null>(null);
  const cleanupLeft = useCleaning(pid);
  // Branch whose commits replace the tree, and the commit picked there (none = all changes).
  const [history, setHistory] = useState<string | null>(null);
  const [commit, setCommit] = useState<Commit | undefined>();
  // File view picked before the commit list took over, put back when it closes.
  const modeBeforeHistory = useRef<Mode>(mode);
  // Stash list in place of the tree: one branch's ("" = every stash), and the stash picked there.
  const [stashesOf, setStashesOf] = useState<string | null>(null);
  const [stash, setStash] = useState<Stash | undefined>();
  const branchesW = usePaneWidth("gnx.pane.branches", 300, 220, 560);
  const filesW = usePaneWidth("gnx.pane.files", 320, 220, 640);
  const [branchesHidden, setBranchesHidden] = useStoredFlag("gnx.pane.branchesHidden");
  const [asTree, setAsTree] = useStoredFlag("gnx.files.tree");
  // Collapse/expand all: a new `n` remounts the file lists, dropping per-folder toggles.
  const [fold, setFold] = useState({ closed: false, n: 0 });
  const actions = useBranchActions(pid, (kind, branch, onto) => setDialog({ kind, branch, onto }));
  const finish = useFinishHandlers(pid, actions.continueOn, (branch, then, stay) => setDialog({ kind: "merge", branch, then, stay }));

  const o = ov.data;
  const byName = useMemo(() => new Map((o?.branches ?? []).map((b) => [b.name, b])), [o]);
  const branch = nav.selectedBranch ?? o?.currentBranch ?? o?.defaultBranch ?? undefined;
  const baseFor = (b: string) => byName.get(b)?.parent ?? "";
  /** Delete `branches` in the background: `section` stays locked in the tree until it is done, whatever screen or project the user is on. */
  const cleanUp = (section: string, branches: string[], opts: { force?: boolean; remote: boolean }, what: string) =>
    startCleanup({ projectId: pid, projectName: o?.project.name ?? "", section, branches, ...opts, what, onDeleted: (gone) => nav.forgetBranches(pid, gone) });
  // Releases and trunks a work branch can be re-targeted to.
  const targets = useMemo(() => (o?.branches ?? []).filter((x) => x.exists && x.role !== "branch"), [o]);
  /** A release branch reads as its version. */
  const labelOf = (b: string) => {
    const v = byName.get(b);
    return v?.role === "release" && v.release ? `v${v.release}` : b;
  };
  const target = (b: string): BranchTarget => {
    const v = byName.get(b) ?? synthetic(b, b === o?.currentBranch);
    const base = v.parent ?? "";
    const rel = v.role === "release" ? o?.releases.find((r) => r.open && r.branch === b) : undefined;
    const shippedRel = v.shipped ? o?.releases.find((r) => !r.open && r.version === v.shipped) : undefined;
    return {
      view: v,
      base,
      baseLabel: labelOf(base),
      isDefault: b === o?.defaultBranch,
      extra: rel
        ? [{ id: "ship", label: <>Ship v{rel.version}…</>, icon: "ship", hint: "fast-forward + tag", run: () => setShipping(rel) }]
        : shippedRel?.tagName
          ? tagItems(shippedRel.tagName, shippedRel.checkedOut)
          : undefined,
      showCommits: v.exists ? () => openHistory(b) : undefined,
      showStashes: v.stashes ? () => openStashes(b) : undefined,
      latestStash: o?.stashes.find((s) => s.branch === b),
      next: rel
        ? { id: "ship", label: `Ship v${rel.version}…`, short: "Ship", tip: `Fast-forward ${o?.defaultBranch} to ${b} and tag v${rel.version}`, icon: "ship", disabled: !v.ahead, run: () => setShipping(rel) }
        : undefined,
      // Work branches can be re-targeted to any release or trunk.
      moveTo:
        v.role === "branch" && v.exists && !b.startsWith("release/")
          ? targets.filter((x) => x.name !== base && x.name !== b).map((x) => ({ branch: x.name, label: labelOf(x.name) }))
          : undefined,
      pickTarget: v.exists && b !== o?.defaultBranch,
    };
  };
  const tagItems = (tag: string, checkedOut: boolean): MenuItem[] => [
    {
      id: "checkoutTag",
      label: <>Check out <span className="mono">{tag}</span></>,
      icon: "swap",
      hint: checkedOut ? "checked out" : "detached HEAD",
      disabled: checkedOut || checkoutTag.isPending,
      run: () => checkoutTag.mutate({ projectId: pid, name: tag }, { onSuccess: () => toast(`Checked out ${tag} (detached HEAD)`, "ok") }),
    },
    { id: "createFromTag", label: "Create a branch from here", icon: "plus", run: () => nav.openNewItem({ tag }) },
    { id: "copyTag", label: "Copy tag name", icon: "edit", run: () => copyToClipboard(tag) },
    "sep",
    { id: "deleteTag", label: <>Delete tag <span className="mono">{tag}</span>…</>, icon: "trash", danger: true, run: () => setDeletingTag(tag) },
  ];
  const openHistory = (b: string) => {
    closeStashes();
    nav.selectBranch(b);
    if (!history) modeBeforeHistory.current = mode;
    setHistory(b);
    setCommit(undefined);
    setMode("branch");
  };
  /** `b` = the stashes made on that branch, none = every stash. */
  const openStashes = (b?: string) => {
    closeHistory();
    if (b) nav.selectBranch(b);
    setStashesOf(b ?? "");
    setStash(undefined);
  };
  const closeStashes = () => {
    setStashesOf(null);
    setStash(undefined);
  };
  const closeHistory = () => {
    if (history) setMode(modeBeforeHistory.current);
    setHistory(null);
    setCommit(undefined);
  };
  const view: BranchView | undefined = branch ? byName.get(branch) : undefined;
  const dialogView = dialog && (byName.get(dialog.branch) ?? synthetic(dialog.branch, dialog.branch === o?.currentBranch));
  const base = branch ? baseFor(branch) : "";
  const checkedOut = view?.checkedOut ?? branch === o?.currentBranch;

  const files = useFiles(pid, branch, mode, commit?.sha, stash?.sha);
  const wipList = useFiles(pid, branch, "wip").data ?? [];
  const wipCount = new Set(wipList.map((f) => f.path)).size;
  const stagedCount = wipList.filter((f) => f.staged).length;
  const branchCount = useFiles(pid, branch, "branch").data?.length ?? 0;
  const list = files.data ?? [];
  const fileCount = new Set(list.map((f) => f.path)).size;
  const current = list.find((f) => fileKey(f) === file) ?? list[0];
  // Project view lists untouched files too: those show as the plain file, no diff.
  const unchanged = mode === "project" && !commit && !stash && current?.status === " ";
  const markdown = /\.(md|markdown|mdx)$/i.test(current?.path ?? "");
  const diff = useDiff(pid, branch, mode, unchanged ? undefined : current?.path, current?.staged, commit?.sha, stash?.sha, diffMode === "full");
  const image = isImage(current?.path);
  const blobs = useBlobs(pid, branch, mode, current?.path, current?.staged, commit?.sha, stash?.sha, image || unchanged || markdown);
  const text = useMemo(() => !image && decodeText(blobs.data?.new ?? blobs.data?.old), [blobs.data, image]);
  // Memoized: a new array would re-render every row and re-measure the heatmap.
  const raw = useMemo<Hunk[] | undefined>(
    () => (unchanged && typeof text === "string" ? [{ header: "", oldStart: 1, newStart: 1, lines: text.replace(/\n$/, "").split("\n").map((t) => ({ kind: " ", text: t })) }] : undefined),
    [unchanged, text],
  );
  const showPreview = markdown && preview && typeof text === "string";
  const [discarding, setDiscarding] = useState<{ staged: boolean; paths: string[] } | null>(null);
  // The main checkout has no worktree path: it lives at the project's own path.
  const projects = useProjects().data;
  const root = view?.worktree ?? projects?.find((p) => p.id === pid)?.path;
  const ignore = useAction<unknown, { projectId: string; branch: string; path: string; dir: boolean }>("workspace.ignore", {
    invalidate: [["files", pid], ["diff", pid], ["overview", pid]],
    success: "Added to .gitignore",
  });
  const fileMenu = (t: FileTarget): MenuItem[] => {
    const notOut = checkedOut ? undefined : "check out first";
    return [
      { id: "copy", label: "Copy path", icon: "copy", run: () => copyToClipboard(t.path) },
      ...(isLocal
        ? [{
            id: "reveal",
            label: "Open in file explorer",
            icon: "folder",
            hint: notOut,
            disabled: !checkedOut || !root || t.files.every((f) => f.status === "D"),
            run: () => revealPath(`${root}/${t.path}`).catch((e) => toast(String(e), "error")),
          }]
        : []),
      {
        id: "ignore",
        label: "Add to .gitignore",
        icon: "edit",
        hint: notOut,
        disabled: !checkedOut || !branch || ignore.isPending,
        run: () => branch && ignore.mutate({ projectId: pid, branch, path: t.path, dir: t.dir }),
      },
    ];
  };

  useEffect(() => setFile(undefined), [branch, mode, commit, stash]);
  // Picking another branch (e.g. from a ticket) leaves its commit or stash list.
  useEffect(() => {
    if (history && branch !== history) closeHistory();
    if (stashesOf && branch !== stashesOf) closeStashes();
  }, [branch, history, stashesOf]);
  // A stash popped or dropped elsewhere is gone: stop showing it.
  useEffect(() => {
    if (stash && o && !o.stashes.some((s) => s.sha === stash.sha)) setStash(undefined);
  }, [o, stash]);

  const inRebase = (branch === o?.currentBranch && o?.rebasing) || !!view?.conflict;

  if (ov.isLoading) return <Loading />;
  return (
    <>
      <div className="pane-switch">
        <Seg<Pane>
          label="Panel"
          grid
          value={pane}
          onChange={setPane}
          options={[
            { value: "releases", label: "Branches" },
            { value: "files", label: `Files${fileCount ? ` ${fileCount}` : ""}` },
            { value: "diff", label: "Diff & agent" },
          ]}
        />
      </div>

      {ov.error && (
        <div style={{ padding: 16 }}>
          <ErrorBox error={ov.error} />
        </div>
      )}

      {o && (
        <main
          className="ws"
          style={{ "--branches-w": `${branchesW.width}px`, "--files-w": `${filesW.width}px` } as CSSProperties}
          data-branches-hidden={branchesHidden || undefined}
        >
          {branchesHidden && (
            <div className="ws-rail hide-narrow">
              <button className="btn btn-sm btn-icon pane-toggle" aria-label="Show branches" onClick={() => setBranchesHidden(false)}>
                <Icon name="sidebar" size={13} />
              </button>
            </div>
          )}
          {stashesOf !== null ? (
            <StashList
              active={pane === "releases"}
              pid={pid}
              stashes={stashesOf ? o.stashes.filter((s) => s.branch === stashesOf) : o.stashes}
              branch={stashesOf || undefined}
              total={o.stashes.length}
              selected={stash?.sha}
              // Back onto its own branch when that is checked out, else onto the main checkout's.
              targetOf={(s) => (s.branch && byName.get(s.branch)?.checkedOut ? s.branch : o.currentBranch ?? undefined)}
              onPick={(s) => {
                setStash(s);
                if (s) setPane("files");
              }}
              onShowAll={() => openStashes()}
              onBack={closeStashes}
            />
          ) : history ? (
            <CommitList
              active={pane === "releases"}
              pid={pid}
              branch={history}
              base={baseFor(history) === history ? "" : labelOf(baseFor(history))}
              selected={commit?.sha}
              checkedOut={byName.get(history)?.checkedOut ?? history === o.currentBranch}
              upstream={!!byName.get(history)?.upstream}
              current={o.currentBranch ?? undefined}
              onPick={(c, auto) => {
                setCommit(c);
                setMode("branch");
                if (!auto) setPane("files");
              }}
              onBack={closeHistory}
            />
          ) : (
            <BranchTree
              onHide={() => setBranchesHidden(true)}
              active={pane === "releases"}
              o={o}
              selected={branch}
              actions={actions}
              target={target}
              onSelect={(b) => {
                nav.selectBranch(b);
                setPane("files");
              }}
              onNewRelease={() => nav.openNewItem({ kind: "release" })}
              onCleanup={(parent, label, branches) => setCleanup({ parent, label, branches })}
              onCleanupBehind={(section, base, branches) => setCleanupBehind({ section, base, branches })}
              isCleaning={(s) => cleanupLeft(s) !== undefined}
              cleanupLeft={cleanupLeft}
              tagItems={tagItems}
              onStashes={() => openStashes()}
              building={ov.isPlaceholderData}
            />
          )}

          {!branchesHidden && <Resizer pane={branchesW} label="Resize branches panel" />}
          <section aria-label="Changed files" className="ws-files" data-pane data-active={pane === "files"}>
            <div className="col" style={{ gap: 10, padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
              <div className="row" style={{ alignItems: "center", minWidth: 0, margin: 0 }}>
                <span className="mono ellipsis" style={{ fontSize: 13, fontWeight: 500 }}>{branch ?? "No branch"}</span>
                {base && branch !== base && <span className="faint" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>{view?.likelyMerged ? "likely merged into" : view?.merged ? "merged into" : "from"} {base}</span>}
                {view?.merged && <span className="c-add row" style={{ marginLeft: 6, flex: "0 0 auto" }} title={view.likelyMerged ? `A pull request carrying its ticket went into ${base} after its last commit` : `All commits are in ${base}`}><Icon name="merged" size={12} stroke={1.6} label="merged" /></span>}
                {asTree && (
                  <button
                    className="btn btn-sm btn-icon"
                    style={{ marginLeft: "auto", flex: "0 0 auto", alignSelf: "center" }}
                    aria-label={fold.closed ? "Expand all folders" : "Collapse all folders"}
                    data-tip={fold.closed ? "Expand all" : "Collapse all"}
                    aria-expanded={!fold.closed}
                    onClick={() => setFold((f) => ({ closed: !f.closed, n: f.n + 1 }))}
                  >
                    <Icon name="chevronDown" size={12} className="chev" />
                  </button>
                )}
                <button
                  className="btn btn-sm btn-icon"
                  style={{ marginLeft: asTree ? 0 : "auto", flex: "0 0 auto", alignSelf: "center" }}
                  aria-label={asTree ? "Show files as a list" : "Show files as a tree"}
                  data-tip={asTree ? "List view" : "Tree view"}
                  onClick={() => setAsTree(!asTree)}
                >
                  <Icon name={asTree ? "menu" : "folder"} size={12} />
                </button>
              </div>
              {stash ? (
                <div className="commit-head">
                  <div className="col" style={{ gap: 3, minWidth: 0, flex: "1 1 auto" }}>
                    <span className="commit-subject row" style={{ gap: 6 }}><Icon name="stash" size={12} stroke={1.6} />{stash.message}</span>
                    <span className="commit-meta">
                      <span className="mono">{stash.sha.slice(0, 7)}</span>
                      {stash.branch && <span className="mono ellipsis">on {stash.branch}</span>}
                      <span style={{ whiteSpace: "nowrap" }}>{ago(stash.date)}</span>
                    </span>
                  </div>
                  <button className="btn btn-sm btn-icon" aria-label="Close stash" data-tip="Back to the branch's files" onClick={() => setStash(undefined)}>
                    <Icon name="close" size={12} />
                  </button>
                </div>
              ) : commit ? (
                <div className="commit-head">
                  <div className="col" style={{ gap: 3, minWidth: 0, flex: "1 1 auto" }}>
                    <span className="commit-subject">{commit.subject}</span>
                    <span className="commit-meta">
                      <span className="mono">{commit.sha.slice(0, 7)}</span>
                      <span className="ellipsis">{commit.author}</span>
                      <span style={{ whiteSpace: "nowrap" }}>{ago(commit.date)}</span>
                    </span>
                  </div>
                </div>
              ) : (
                <Seg<Mode>
                  label="File view"
                  grid
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: "wip", label: wipCount > 0 ? <span className="wip-badge">WIP {wipCount}</span> : <>WIP <span className="faint">{wipCount}</span></> },
                    { value: "branch", label: <>Branch <span className="faint">{branchCount}</span></> },
                    { value: "project", label: "Project" },
                  ]}
                />
              )}
              {branch && view?.worktree && <span className="hint mono ellipsis" title={view.worktree}>{view.worktree}</span>}
            </div>
            {inRebase && (
              <div className="col note-box" style={{ margin: "10px 12px 0" }}>
                <span style={{ fontSize: 12, lineHeight: 1.45 }}>
                  Rebase onto <span className="mono">{base}</span> stopped on {o.conflicts.length || "a"} conflict{o.conflicts.length === 1 ? "" : "s"}.
                </span>
                <button className="btn btn-primary btn-sm" style={{ height: 30 }} onClick={() => branch && setDialog({ kind: "conflicts", branch })}>
                  <Icon name="sparkle" size={12} />
                  <span>Resolve with AI</span>
                </button>
              </div>
            )}
            <ul className="scroll" style={{ flex: "1 1 auto", listStyle: "none", margin: 0, padding: mode === "wip" && list.length > 0 ? "0 0 6px" : "6px 0" }}>
              {files.isLoading && <li className="empty"><span className="spinner" /></li>}
              {files.error && <li style={{ padding: 12 }}><ErrorBox error={files.error} /></li>}
              {mode === "wip" && !commit && !stash && branch && list.length > 0 ? (
                <WipList
                  pid={pid}
                  branch={branch}
                  list={list}
                  current={current}
                  tree={asTree}
                  fold={fold}
                  menu={fileMenu}
                  onPick={(f) => { setFile(fileKey(f)); setPane("diff"); }}
                  onMoved={(f) => current && fileKey(current) === fileKey(f) && setFile(fileKey({ ...f, staged: !f.staged }))}
                  onDiscard={(staged, paths) => setDiscarding({ staged, paths })}
                />
              ) : (
                <FileList key={fold.n} allClosed={fold.closed} list={list} current={current} tree={asTree} menu={fileMenu} onPick={(f) => { setFile(fileKey(f)); setPane("diff"); }} />
              )}
              {!files.isLoading && list.length === 0 && (
                <li className="empty engraved">{stash ? "This stash holds no files." : commit ? "This commit changes no files." : mode === "wip" ? (checkedOut ? "No uncommitted changes." : "This branch is not checked out.") : "No changes on this branch yet."}</li>
              )}
            </ul>
            {branch && !history && <CommitBox pid={pid} branch={branch} enabled={checkedOut} staged={stagedCount} changed={wipCount} />}
          </section>

          <Resizer pane={filesW} label="Resize files panel" />
          <section aria-label="Diff" className="ws-diff" data-pane data-active={pane === "diff"}>
            <div className="pane-head" style={{ background: "var(--panel)" }}>
              <span className="mono ellipsis" style={{ fontSize: 12.5 }}>{current?.path ?? "No file selected"}</span>
              <span className="row mono" style={{ fontSize: 11.5, gap: 6 }}>
                {current?.additions ? <span className="c-add">+{current.additions}</span> : null}
                {current?.deletions ? <span className="c-del">−{current.deletions}</span> : null}
              </span>
              <span className="grow" />
              {image ? (
                comparable(blobs.data) && <Seg value={imageMode} onChange={setImageMode} label="Image comparison" options={IMAGE_MODES} />
              ) : (
                (!unchanged || markdown) && (
                  <Seg<DiffMode | "raw" | "preview">
                    value={markdown && preview ? "preview" : unchanged ? "raw" : diffMode}
                    onChange={(v) => {
                      setPreview(v === "preview");
                      if (v !== "preview" && v !== "raw") setDiffMode(v);
                    }}
                    label="Diff mode"
                    options={[
                      ...(unchanged
                        ? [{ value: "raw" as const, label: "Raw" }]
                        : [{ value: "split" as const, label: "Split" }, { value: "unified" as const, label: "Unified" }, { value: "full" as const, label: "Full" }]),
                      ...(markdown ? [{ value: "preview" as const, label: "Preview" }] : []),
                    ]}
                  />
                )
              )}
            </div>
            <div className="diff">
              {(diff.isLoading || (unchanged && blobs.isLoading)) && current && <Loading />}
              {diff.error && <div style={{ padding: 16 }}><ErrorBox error={diff.error} /></div>}
              {image && current && blobs.data && <ImageDiff path={current.path} blobs={blobs.data} mode={imageMode} />}
              {blobs.error && (image || unchanged) && <div style={{ padding: 16 }}><ErrorBox error={blobs.error} /></div>}
              {showPreview ? (
                <article style={{ maxWidth: 760, margin: "0 auto", padding: "24px 24px 48px", fontFamily: "var(--sans)", fontSize: 14, lineHeight: 1.6 }}>
                  <Markdown text={text} />
                </article>
              ) : (
                <>
                  {raw && <DiffView hunks={raw} mode="full" />}
                  {diff.data && diff.data.length > 0 && <DiffView hunks={diff.data} mode={diffMode} />}
                </>
              )}
              {(!current || (diff.data && diff.data.length === 0 && !image) || (unchanged && !image && blobs.data && text === null)) && (
                <div className={list.length === 0 ? "empty engraved" : "empty"} style={{ fontFamily: "var(--sans)" }}>
                  {list.length === 0 ? "Nothing to show — working tree is clean." : unchanged ? "Binary file." : "No textual changes in this file."}
                </div>
              )}
            </div>
            <Terminal
              pid={pid}
              branch={branch}
              open={termOpen}
              setOpen={setTermOpen}
              onCloseWorktree={setClosingSession}
              finish={finish}
            />
          </section>
        </main>
      )}

      {discarding && branch && (
        <DiscardModal pid={pid} branch={branch} staged={discarding.staged} paths={discarding.paths} total={list.filter((f) => f.staged === discarding.staged).length} onClose={() => setDiscarding(null)} />
      )}
      {shipping && <ShipModal pid={pid} release={shipping} defaultBranch={o?.defaultBranch ?? "main"} onClose={() => setShipping(null)} />}
      {actions.menuEl}
      {dialog?.kind === "conflicts" && <ConflictModal pid={pid} branch={dialog.branch} base={baseFor(dialog.branch)} onClose={() => setDialog(null)} />}
      {dialog?.kind === "merge" && dialogView && (
        <MergeModal
          pid={pid}
          branch={dialog.branch}
          base={baseFor(dialog.branch)}
          // Any other local branch can take it: releases first, then trunks, then work branches.
          others={mergeTargets(o?.branches ?? [], dialog.branch)}
          stay={dialog.stay}
          onClose={() => setDialog(null)} onDeleted={(into) => dialog.branch === branch && nav.selectBranch(into)} onMerged={dialog.then} />
      )}
      {closingSession && (
        <CloseWorktreeModal session={closingSession} finish={finish} onClose={() => setClosingSession(null)} />
      )}
      {cleanup && (
        <CleanupModal
          {...cleanup}
          onClose={() => setCleanup(null)}
          onConfirm={(names) => cleanUp(`merged:${cleanup.parent}`, names, { remote: true }, "merged branch")}
        />
      )}
      {cleanupBehind && (
        <BehindCleanupModal
          base={cleanupBehind.base}
          branches={cleanupBehind.branches}
          onClose={() => setCleanupBehind(null)}
          onConfirm={(names, remote) => cleanUp(cleanupBehind.section, names, { force: true, remote }, "branch")}
        />
      )}
      {dialog?.kind === "forcePush" && dialogView?.upstream && (
        <ForcePushModal pid={pid} view={dialogView} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "reset" && dialogView?.upstream && (
        <ResetBranchModal pid={pid} view={dialogView} onClose={() => setDialog(null)} />
      )}
      {deletingTag && <DeleteTagModal pid={pid} tag={deletingTag} onClose={() => setDeletingTag(null)} />}
      {dialog?.kind === "tag" && <TagBranchModal pid={pid} branch={dialog.branch} onClose={() => setDialog(null)} />}
      {dialog?.kind === "target" && o && (
        <TargetBranchModal
          pid={pid}
          branch={dialog.branch}
          branches={o.branches}
          labelOf={labelOf}
          onClose={() => setDialog(null)}
          onTargeted={(onto) => setDialog(offersRebase(byName.get(dialog.branch)) ? { kind: "rebase", branch: dialog.branch, onto } : null)}
        />
      )}
      {dialog?.kind === "rebase" && dialog.onto && <RebaseOntoModal pid={pid} branch={dialog.branch} onto={labelOf(dialog.onto)} onClose={() => setDialog(null)} />}
      {dialog?.kind === "delete" && dialogView && (
        <DeleteBranchModal
          pid={pid}
          branch={dialog.branch}
          base={baseFor(dialog.branch)}
          local={dialogView.local}
          remote={dialogView.remote}
          worktree={dialogView.worktree ?? undefined}
          onClose={() => setDialog(null)}
          onDeleted={() => dialog.branch === branch && nav.selectBranch(undefined)}
        />
      )}
    </>
  );
}

function synthetic(name: string, checkedOut: boolean): BranchView {
  return {
    name,
    kind: "",
    short: name,
    checkedOut,
    running: false,
    waiting: false,
    conflict: false,
    wip: 0,
    stashes: 0,
    ahead: 0,
    behind: 0,
    upstreamAhead: 0,
    upstreamBehind: 0,
    rewritten: false,
    exists: true,
    merged: false,
    likelyMerged: false,
    role: "branch",
    local: true,
    remote: false,
    protected: false,
    date: "",
    author: "",
    email: "",
  };
}

/** WIP files appear once per side, so the side is part of the identity. */
function fileKey(f: FileChange) {
  return f.staged === undefined ? f.path : `${f.staged ? "s" : "u"}:${f.path}`;
}

function WipList({
  pid,
  branch,
  list,
  current,
  tree,
  fold,
  menu,
  onPick,
  onMoved,
  onDiscard,
}: {
  pid: string;
  branch: string;
  list: FileChange[];
  current?: FileChange;
  tree: boolean;
  fold: { closed: boolean; n: number };
  menu: (t: FileTarget) => MenuItem[];
  onPick: (f: FileChange) => void;
  onMoved: (f: FileChange) => void;
  onDiscard: (staged: boolean, paths: string[]) => void;
}) {
  const inv = [["files", pid], ["diff", pid], ["overview", pid]];
  const stage = useAction("workspace.stage", { invalidate: inv });
  const unstage = useAction("workspace.unstage", { invalidate: inv });
  const busy = stage.isPending || unstage.isPending;
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  // No files = the whole side.
  const move = (staged: boolean, fs: FileChange[] = []) =>
    (staged ? unstage : stage).mutate({ projectId: pid, branch, paths: fs.map((f) => f.path) }, { onSuccess: () => fs.forEach(onMoved) });

  return (
    <>
      {[true, false].map((staged) => {
        const side = list.filter((f) => !!f.staged === staged);
        if (!side.length) return null;
        return (
          <li key={String(staged)}>
            <div className="file-sec">
              <button className="file-sec-toggle" aria-expanded={!closed[String(staged)]} onClick={() => setClosed((c) => ({ ...c, [String(staged)]: !c[String(staged)] }))}>
                <Icon name="chevronDown" size={12} className="chev" />
                <span>{staged ? "Staged" : "Unstaged"}</span>
                <span style={{ fontWeight: 400 }}>{side.length}</span>
              </button>
              <span className="file-sec-acts">
                <button
                  className="btn btn-ghost btn-act"
                  title={staged ? "Unstage all" : "Stage all"}
                  aria-label={staged ? "Unstage all files" : "Stage all files"}
                  disabled={busy}
                  onClick={() => move(staged)}
                >
                  <Icon name={staged ? "minus" : "plus"} size={12} />
                </button>
                <button
                  className="btn btn-ghost btn-act btn-danger"
                  title={staged ? "Discard all staged changes" : "Discard all unstaged changes"}
                  aria-label={staged ? "Discard all staged changes" : "Discard all unstaged changes"}
                  disabled={busy}
                  onClick={() => onDiscard(staged, [])}
                >
                  <Icon name="undo" size={12} />
                </button>
              </span>
            </div>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }} hidden={closed[String(staged)]}>
              <FileList
                key={fold.n}
                allClosed={fold.closed}
                list={side}
                current={current}
                tree={tree}
                onPick={onPick}
                menu={(t) => [
                  { id: "move", label: `${staged ? "Unstage" : "Stage"} ${t.dir ? "folder" : "file"}`, icon: staged ? "minus" : "plus", disabled: busy, run: () => move(staged, t.files) },
                  { id: "discard", label: `Discard ${t.dir ? "folder" : "file"}`, icon: "undo", danger: true, disabled: busy, run: () => onDiscard(staged, t.files.map((f) => f.path)) },
                  "sep",
                  ...menu(t),
                ]}
                actions={(t) => (
                  <>
                    <button
                      className="btn btn-ghost btn-act"
                      title={staged ? "Unstage" : "Stage"}
                      aria-label={`${staged ? "Unstage" : "Stage"} ${t.path}`}
                      disabled={busy}
                      onClick={() => move(staged, t.files)}
                    >
                      <Icon name={staged ? "minus" : "plus"} size={12} />
                    </button>
                    <button
                      className="btn btn-ghost btn-act btn-danger"
                      title="Discard changes"
                      aria-label={`Discard ${staged ? "staged" : "unstaged"} changes to ${t.path}`}
                      disabled={busy}
                      onClick={() => onDiscard(staged, t.files.map((f) => f.path))}
                    >
                      <Icon name="undo" size={12} />
                    </button>
                  </>
                )}
              />
            </ul>
          </li>
        );
      })}
    </>
  );
}

function DiscardModal({ pid, branch, staged, paths, total, onClose }: { pid: string; branch: string; staged: boolean; paths: string[]; total: number; onClose: () => void }) {
  const discard = useAction("workspace.discard", { invalidate: [["files", pid], ["diff", pid], ["overview", pid]], success: "Changes discarded" });
  const what = paths.length === 1 ? <span className="mono">{paths[0]}</span> : <>{paths.length || total} file{(paths.length || total) === 1 ? "" : "s"}</>;
  return (
    <Modal
      title={staged ? "Discard staged changes" : "Discard unstaged changes"}
      sub={what}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-md btn-danger"
            disabled={discard.isPending}
            onClick={() => discard.mutate({ projectId: pid, branch, staged, paths }, { onSuccess: onClose })}
          >
            {discard.isPending && <span className="spinner" />}
            Discard
          </button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        {staged
          ? "Puts these files back to their last commit — staged and unstaged edits are both lost, and files added since are deleted."
          : "Throws away edits that are not staged — staged changes are kept, and untracked files are deleted."}{" "}
        This cannot be undone.
      </p>
      {discard.error && <ErrorBox error={discard.error} />}
    </Modal>
  );
}

type Dir = { dirs: Map<string, Dir>; files: FileChange[] };

function buildTree(list: FileChange[]) {
  const root: Dir = { dirs: new Map(), files: [] };
  for (const f of list) {
    let d = root;
    for (const part of f.path.split("/").slice(0, -1)) {
      let next = d.dirs.get(part);
      if (!next) d.dirs.set(part, (next = { dirs: new Map(), files: [] }));
      d = next;
    }
    d.files.push(f);
  }
  return root;
}

const filesUnder = (d: Dir): FileChange[] => [...d.files, ...[...d.dirs.values()].flatMap(filesUnder)];

/** What a right click landed on: one file, or a folder and every listed file under it. */
type FileTarget = { path: string; dir: boolean; files: FileChange[] };

/** Changed files as a flat list, or nested under their folders. */
function FileList({
  list,
  current,
  tree,
  allClosed,
  onPick,
  actions,
  menu,
}: {
  list: FileChange[];
  current?: FileChange;
  tree: boolean;
  allClosed: boolean;
  onPick: (f: FileChange) => void;
  actions?: (t: FileTarget) => ReactNode;
  menu?: (t: FileTarget) => MenuItem[];
}) {
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [ctx, setCtx] = useState<{ x: number; y: number; t: FileTarget } | null>(null);
  const openMenu = (t: FileTarget, e: MouseEvent) => {
    if (!menu) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Keyboard-opened context menus report (0, 0): anchor to the row instead.
    const fromKey = e.clientX === 0 && e.clientY === 0;
    setCtx({ x: fromKey ? r.left : e.clientX, y: fromKey ? r.bottom + 2 : e.clientY, t });
  };
  const row = (f: FileChange, depth?: number) => {
    const t: FileTarget = { path: f.path, dir: false, files: [f] };
    return (
      <li key={fileKey(f)} onContextMenu={(e) => openMenu(t, e)}>
        <FileRow f={f} depth={depth} active={f === current} onPick={() => onPick(f)} actions={actions?.(t)} />
      </li>
    );
  };
  const ctxMenu = ctx && menu && <ContextMenu x={ctx.x} y={ctx.y} label={ctx.t.path} items={menu(ctx.t)} onClose={() => setCtx(null)} />;
  if (!tree) return <>{list.map((f) => row(f))}{ctxMenu}</>;
  const walk = (d: Dir, path: string, depth: number): ReactNode[] => [
    ...[...d.dirs].sort(([a], [b]) => a.localeCompare(b)).map(([name, sub]) => {
      // Fold folders holding a single folder into one row, like "src/api".
      while (!sub.files.length && sub.dirs.size === 1) {
        const [n, s] = [...sub.dirs][0];
        name += `/${n}`;
        sub = s;
      }
      const key = `${path}${name}/`;
      const t: FileTarget = { path: key.slice(0, -1), dir: true, files: filesUnder(sub) };
      const adds = t.files.reduce((n, f) => n + f.additions, 0);
      const dels = t.files.reduce((n, f) => n + f.deletions, 0);
      const btn = (
        <button
          className="file-btn"
          style={{ paddingLeft: 14 + depth * 14 }}
          aria-expanded={!(closed[key] ?? allClosed)}
          onClick={() => setClosed((c) => ({ ...c, [key]: !(c[key] ?? allClosed) }))}
        >
          <Icon name="chevronDown" size={12} className="chev" />
          <span className="grow ellipsis faint" data-tip={key} data-tip-overflow>{name}</span>
          <span className="row mono file-nums">
            <span className="c-add">{adds > 0 && `+${adds}`}</span>
            <span className="c-del">{dels > 0 && `−${dels}`}</span>
          </span>
        </button>
      );
      return (
        <li key={key}>
          <div onContextMenu={(e) => openMenu(t, e)}>
            {actions ? (
              <div className="file-row">
                {btn}
                <span className="file-acts">{actions(t)}</span>
              </div>
            ) : btn}
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }} hidden={closed[key] ?? allClosed}>{walk(sub, key, depth + 1)}</ul>
        </li>
      );
    }),
    ...d.files.map((f) => row(f, depth)),
  ];
  return <>{walk(buildTree(list), "", 0)}{ctxMenu}</>;
}

/** `depth` set = shown in a tree, where the folder rows already name the directory. */
function FileRow({ f, active, onPick, actions, depth }: { f: FileChange; active: boolean; onPick: () => void; actions?: ReactNode; depth?: number }) {
  const cut = f.path.lastIndexOf("/");
  const base = cut >= 0 ? f.path.slice(cut + 1) : f.path;
  const dir = cut >= 0 && depth === undefined ? f.path.slice(0, cut) : "";
  const color = { A: "c-add", D: "c-del", C: "c-acc", M: "c-mod", R: "c-mod", " ": "faint" }[f.status] ?? "faint";
  const btn = (
    <button className="file-btn" style={depth ? { paddingLeft: 14 + depth * 14 } : undefined} aria-pressed={active} onClick={onPick}>
      <span className={`file-st ${color}`}>{f.status === " " ? "·" : f.status}</span>
      <span className="grow ellipsis" data-tip={f.path} data-tip-overflow>
        <span style={{ color: f.status === " " ? "var(--muted)" : "var(--fg)" }}>{base}</span> <span className="faint" style={{ fontSize: 11.5 }}>{dir}</span>
      </span>
      <span className="row mono file-nums">
        <span className="c-add">{f.additions > 0 && `+${f.additions}`}</span>
        <span className="c-del">{f.deletions > 0 && `−${f.deletions}`}</span>
      </span>
    </button>
  );
  if (!actions) return btn;
  return (
    <div className="file-row">
      {btn}
      <span className="file-acts">{actions}</span>
    </div>
  );
}

/** Any other local branch can take `branch`: releases first, then trunks, then work branches. */
export const mergeTargets = (branches: BranchView[], branch: string) =>
  branches
    .filter((x) => x.local && x.name !== branch)
    .sort((a, b) => ["release", "trunk", "branch"].indexOf(a.role) - ["release", "trunk", "branch"].indexOf(b.role))
    .map((x) => x.name);

export function MergeModal({
  pid,
  branch,
  base: defaultBase,
  others,
  onClose,
  onDeleted,
  onMerged,
  stay,
  inline,
}: {
  pid: string;
  branch: string;
  base: string;
  /** Every other branch it could merge into instead. */
  others: string[];
  onClose: () => void;
  onDeleted: (into: string) => void;
  onMerged?: () => void;
  /** Leave the main checkout where it is after merging. */
  stay?: boolean;
  /** Show it in the agent chat instead of a modal, these buttons in place of Cancel. */
  inline?: ReactNode;
}) {
  // The options picked last time, saved with the project.
  const { merge: opts, setMerge: set } = useProjectPrefs(pid);
  const [base, setBase] = useState(defaultBase);
  const [pick, setPick] = useState<{ x: number; y: number } | null>(null);
  const merge = useAction<MergeResult>("branches.merge", {
    invalidate: [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid]],
    success: (r) =>
      `${r.alreadyMerged ? `${branch} was already in ${r.into}` : `Merged ${branch} into ${r.into}`}${r.switched ? ` · switched to ${r.into}` : ""}${r.deleted ? " · branch deleted" : ""}${r.pushed ? " · pushed" : ""}${r.retagged ? ` · ${r.retagged} moved` : ""}${r.stayed ? ` · stayed put: ${r.stayed}` : ""}`,
  });
  const run = () =>
    merge.mutate(
      { projectId: pid, branch, into: base, deleteBranch: opts.deleteBranch, squash: opts.squash, squashAi: opts.squashMessage === "ai", rebase: opts.rebase, push: opts.push, stay },
      {
        onSuccess: (r) => {
          if (r.pushError) toast(`Merged, but pushing ${r.into} failed: ${r.pushError}`, "error");
          if (r.tagError) toast(`Merged, but moving its release tag failed: ${r.tagError}`, "error");
          if (r.deleteError) toast(`Merged, but deleting ${branch} failed: ${r.deleteError}`, "error");
          if (r.deleted || r.switched) onDeleted(r.into);
          onMerged?.();
          onClose();
        },
      },
    );
  const footer = (
    <>
      {inline ?? <button className="btn btn-md" onClick={onClose}>Cancel</button>}
      <span className="split-btn">
        <button
          className="btn btn-primary btn-md split-main"
          disabled={merge.isPending}
          onClick={run}
        >
          {merge.isPending && <span className="spinner" />}
          Merge into {base}
        </button>
        <button
          className="btn btn-primary btn-md btn-icon split-more"
          aria-label="Merge into another branch"
          data-tip="Merge into another branch"
          aria-haspopup="menu"
          disabled={merge.isPending || !others.length}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setPick({ x: r.right, y: r.bottom + 2 });
          }}
        >
          <Icon name="chevronDown" size={13} />
        </button>
      </span>
      {pick && (
        <ContextMenu
          x={pick.x}
          y={pick.y}
          alignRight
          label="Merge into"
          items={others.map((b) => ({ id: b, label: <span className="mono">{b}</span>, icon: b === base ? "check" : undefined, hint: b === defaultBase ? "its base" : undefined, run: () => setBase(b) }))}
          onClose={() => setPick(null)}
        />
      )}
    </>
  );
  const body = (
    <>
      <Seg
        grid
        label="How to merge"
        value={opts.rebase ? "rebase" : "merge"}
        onChange={(v) => set({ rebase: v === "rebase" })}
        options={[{ value: "merge", label: "Merge commit" }, { value: "rebase", label: "Rebase & fast-forward" }]}
      />
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        {opts.rebase ? (
          <>Replays <span className="mono">{branch}</span> on top of <span className="mono">{base}</span>, then fast-forwards {base} to it: no merge commit.</>
        ) : (
          <>Creates a merge commit on <span className="mono">{base}</span>.</>
        )}{" "}
        {stay ? "" : `Then switches to ${base}. `}Where {base}{opts.rebase ? ` or ${branch}` : ""} is checked out, it must have no uncommitted changes.
        Nothing changes when the merge would conflict: rebase onto {base} and resolve first.
      </p>
      {merge.error && <ErrorBox error={merge.error} />}
      <div className="col" style={{ gap: 0 }}>
        <label className="check">
          <input type="checkbox" checked={opts.squash} onChange={() => set({ squash: !opts.squash })} />
          <span>Squash <span className="mono">{branch}</span> into one renamed commit first</span>
        </label>
        {opts.squash && (
          <div style={{ margin: "2px 0 6px 26px" }}>
            <Seg
              grid
              label="Squashed commit summary"
              value={opts.squashMessage}
              onChange={(v) => set({ squashMessage: v })}
              options={[
                { value: "branch", label: <span className="mono ellipsis">squash | {branch.replace(/-/g, " ")}</span> },
                { value: "ai", label: <span className="row" style={{ gap: 6, justifyContent: "center" }}><Icon name="sparkle" size={11} />AI writes it</span> },
              ]}
            />
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={opts.deleteBranch} onChange={() => set({ deleteBranch: !opts.deleteBranch })} />
          <span>Delete <span className="mono">{branch}</span> after merging, locally and on origin</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={opts.push} onChange={() => set({ push: !opts.push })} />
          <span>Push <span className="mono">{base}</span> to origin after merging</span>
        </label>
      </div>
    </>
  );
  if (inline) return <div className="ag-finish">{body}<div className="ag-finish-foot">{footer}</div></div>;
  return (
    <Modal title="Merge branch" sub={<span className="mono">{branch} → {base}</span>} onClose={onClose} footer={footer}>
      {body}
    </Modal>
  );
}

function ResetBranchModal({ pid, view, onClose }: { pid: string; view: BranchView; onClose: () => void }) {
  const { name: branch, upstream } = view;
  const reset = useAction("branches.reset", { invalidate: [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid]], success: `Reset ${branch} to ${upstream}` });
  return (
    <Modal
      title="Reset to origin"
      sub={<span className="mono">{branch}</span>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" onClick={onClose}>Cancel</button>
          <button className="btn btn-md btn-danger" disabled={reset.isPending} onClick={() => reset.mutate({ projectId: pid, branch }, { onSuccess: onClose })}>
            {reset.isPending && <span className="spinner" />}
            Reset branch
          </button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        Moves <span className="mono">{branch}</span> to exactly where <span className="mono">{upstream}</span> is
        {view.upstreamBehind > 0 && <>, taking its {plural(view.upstreamBehind, "new commit")}</>}.
        {view.upstreamAhead > 0 && <> The {plural(view.upstreamAhead, "local commit")} not on origin {view.upstreamAhead === 1 ? "is" : "are"} dropped.</>}
        {view.checkedOut && <> Uncommitted changes in its checkout are lost{view.wip > 0 && <> ({plural(view.wip, "file")})</>}.</>} This cannot be undone.
      </p>
      {reset.error && <ErrorBox error={reset.error} />}
    </Modal>
  );
}

function ForcePushModal({ pid, view, onClose }: { pid: string; view: BranchView; onClose: () => void }) {
  const { name: branch, upstream } = view;
  const push = useAction("workspace.push", { invalidate: [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid]], success: `Force pushed ${branch}` });
  return (
    <Modal
      title="Force push"
      sub={<span className="mono">{branch}</span>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" onClick={onClose}>Cancel</button>
          <button className="btn btn-md btn-danger" disabled={push.isPending} onClick={() => push.mutate({ projectId: pid, branch, force: true }, { onSuccess: onClose })}>
            {push.isPending && <span className="spinner" />}
            Force push
          </button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        Replaces <span className="mono">{upstream}</span> with <span className="mono">{branch}</span>
        {view.upstreamBehind > 0 && <>: the {plural(view.upstreamBehind, "commit")} only on origin {view.upstreamBehind === 1 ? "goes" : "go"} away</>}.
        {view.rewritten
          ? <> They were on {branch} before it was rewritten (rebased), so nothing you haven't seen is lost.</>
          : <> Some were never on {branch}: someone else may have pushed them. Git refuses those, so pull or reset first.</>}
      </p>
      {push.error && <ErrorBox error={push.error} />}
    </Modal>
  );
}

function TagBranchModal({ pid, branch, onClose }: { pid: string; branch: string; onClose: () => void }) {
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const tag = useAction("branches.tag", { invalidate: [["overview", pid], ["commits", pid]], success: `Tagged ${branch} as ${name.trim()} and pushed it` });
  const submit = () => name.trim() && tag.mutate({ projectId: pid, branch, name: name.trim(), message }, { onSuccess: onClose });
  return (
    <Modal
      title="Create tag"
      sub={<span className="mono">{branch}</span>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" onClick={onClose}>Cancel</button>
          <button className="btn btn-md btn-primary" disabled={!name.trim() || tag.isPending} onClick={submit}>
            {tag.isPending && <span className="spinner" />}
            Create and push
          </button>
        </>
      }
    >
      <form className="col" style={{ gap: 14 }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="field">
          <label htmlFor="tag-name">Name</label>
          <input id="tag-name" className="input mono" placeholder="v1.2.0" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="tag-msg">Message</label>
          <input id="tag-msg" className="input" placeholder="Defaults to the name" value={message} onChange={(e) => setMessage(e.target.value)} />
        </div>
      </form>
      {tag.error && <ErrorBox error={tag.error} />}
    </Modal>
  );
}

/** Pick any branch for `branch` to merge into: not itself, its current base, or a branch below it. */
function TargetBranchModal({
  pid,
  branch,
  branches,
  labelOf,
  onClose,
  onTargeted,
}: {
  pid: string;
  branch: string;
  branches: BranchView[];
  labelOf: (b: string) => string;
  onClose: () => void;
  onTargeted: (parent: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const move = useAction("branches.setParent", { invalidate: [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid]], success: () => `${branch} now targets ${labelOf(picked ?? "")}` });
  const base = branches.find((b) => b.name === branch)?.parent ?? "";
  const choices = useMemo(() => {
    const parentOf = new Map(branches.map((b) => [b.name, b.parent ?? null]));
    // Under `branch` somewhere: targeting it would loop the tree.
    const below = (name: string) => {
      const seen = new Set<string>();
      for (let p = parentOf.get(name); p && !seen.has(p); p = parentOf.get(p)) {
        if (p === branch) return true;
        seen.add(p);
      }
      return false;
    };
    const rank = (b: BranchView) => (b.role === "trunk" ? 0 : b.role === "release" ? 1 : 2);
    return branches
      .filter((b) => b.exists && b.name !== branch && b.name !== base && !below(b.name))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [branches, branch, base]);
  const q = query.trim().toLowerCase();
  const shown = q ? choices.filter((b) => b.name.toLowerCase().includes(q) || labelOf(b.name).toLowerCase().includes(q)) : choices;
  const submit = () => picked && move.mutate({ projectId: pid, branch, parent: picked }, { onSuccess: () => onTargeted(picked) });
  return (
    <Modal
      title="Target a specific branch"
      sub={<><span className="mono">{labelOf(branch)}</span> merges into it from now on</>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" onClick={onClose}>Cancel</button>
          <button className="btn btn-md btn-primary" disabled={!picked || move.isPending} onClick={submit}>
            {move.isPending && <span className="spinner" />}
            Target {picked ? labelOf(picked) : "it"}
          </button>
        </>
      }
    >
      <input className="input" placeholder="Filter branches" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul className="col" style={{ margin: 0, padding: 0, listStyle: "none", gap: 4, maxHeight: 320, overflowY: "auto" }}>
        {shown.map((b) => (
          <li key={b.name}>
            <label className="check">
              <input type="radio" name="target" checked={picked === b.name} onChange={() => setPicked(b.name)} />
              <span className="mono ellipsis">{labelOf(b.name)}</span>
              {b.role === "trunk" && <span className="tag">trunk</span>}
              {b.role === "release" && <span className="tag">release</span>}
              {b.shipped && <span className="tag released">released</span>}
              {!b.local && <span className="tag" title="Only on origin">origin</span>}
            </label>
          </li>
        ))}
        {!shown.length && <li className="faint">No branch matches “{query}”.</li>}
      </ul>
      {move.error && <ErrorBox error={move.error} />}
    </Modal>
  );
}

/** Asked right after `branch` got a new target: replay it on top of that target now? */
function RebaseOntoModal({ pid, branch, onto, onClose }: { pid: string; branch: string; onto: string; onClose: () => void }) {
  const rebase = useAction<RebaseResult, { projectId: string; branch: string }>("workspace.rebase", {
    invalidate: [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid]],
    success: rebaseMessage,
  });
  return (
    <Modal
      title="Rebase onto the new target?"
      sub={<><span className="mono">{branch}</span> now targets <span className="mono">{onto}</span></>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" onClick={onClose}>Not now</button>
          <button className="btn btn-md btn-primary" autoFocus disabled={rebase.isPending} onClick={() => rebase.mutate({ projectId: pid, branch }, { onSuccess: onClose })}>
            {rebase.isPending && <span className="spinner" />}
            Rebase onto {onto}
          </button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>Replays the commits of {branch} on top of {onto}. Already pushed: it then needs a force push.</p>
      {rebase.error && <ErrorBox error={rebase.error} />}
    </Modal>
  );
}

function DeleteTagModal({ pid, tag, onClose }: { pid: string; tag: string; onClose: () => void }) {
  const del = useAction("tags.delete", { invalidate: [["overview", pid], ["commits", pid]], success: `Deleted tag ${tag}` });
  return (
    <Modal
      title="Delete tag"
      sub={<span className="mono">{tag}</span>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" onClick={onClose}>Cancel</button>
          <button className="btn btn-md btn-danger" disabled={del.isPending} onClick={() => del.mutate({ projectId: pid, name: tag }, { onSuccess: onClose })}>
            {del.isPending && <span className="spinner" />}
            Delete tag
          </button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        Deletes <span className="mono">{tag}</span> locally and on origin, for everyone who uses it. The commits it points at stay.
      </p>
      {del.error && <ErrorBox error={del.error} />}
    </Modal>
  );
}

function DeleteBranchModal({
  pid,
  branch,
  base,
  local,
  remote,
  worktree,
  onClose,
  onDeleted,
}: {
  pid: string;
  branch: string;
  base: string;
  local: boolean;
  /** Exists on origin. */
  remote: boolean;
  worktree?: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [force, setForce] = useState(false);
  // Origin-only branches can only go from origin; otherwise origin keeps its copy unless asked (remembered).
  const [alsoOrigin, setAlsoOrigin] = useStoredFlag("gnx.delete.alsoOrigin");
  const onOrigin = remote && (!local || alsoOrigin);
  const exists = local || remote;
  const del = useAction("branches.delete", { invalidate: [["overview", pid], ["files", pid], ["worktrees"]], success: `Deleted ${branch}` });
  return (
    <Modal
      title="Delete branch"
      sub={<span className="mono">{branch}</span>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-md btn-danger"
            disabled={del.isPending}
            onClick={() => del.mutate({ projectId: pid, branch, force, remote: onOrigin }, { onSuccess: () => { onDeleted(); onClose(); } })}
          >
            {del.isPending && <span className="spinner" />}
            {exists ? "Delete branch" : "Forget branch"}
          </button>
        </>
      }
    >
      {exists ? (
        <>
          <p style={{ margin: 0, lineHeight: 1.55 }}>
            {local ? (
              <>
                Deletes the local branch <span className="mono">{branch}</span>
                {worktree && <> and its worktree at <span className="mono">{worktree}</span></>}
                {remote ? (alsoOrigin ? <>, and <span className="mono">origin/{branch}</span> for everyone.</> : <>. The branch on origin is kept.</>) : "."}
              </>
            ) : (
              <>Deletes <span className="mono">{branch}</span> on origin, for everyone who uses it.</>
            )}
          </p>
          {del.error && <ErrorBox error={del.error} />}
          {local && remote && (
            <label className="check">
              <input type="checkbox" checked={alsoOrigin} onChange={() => setAlsoOrigin(!alsoOrigin)} />
              <span>Also delete it on origin</span>
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={force} onChange={() => setForce(!force)} />
            <span>Delete even if not merged into <span className="mono">{base}</span> (its commits are lost)</span>
          </label>
        </>
      ) : (
        <p style={{ margin: 0, lineHeight: 1.55 }}>The branch no longer exists. This removes it from its release.</p>
      )}
    </Modal>
  );
}

/** Confirm deleting the merged children of a branch; the delete itself runs in the background. */
function CleanupModal({
  label,
  branches,
  onClose,
  onConfirm,
}: {
  parent: string;
  /** How to show the branch they were merged into. */
  label: string;
  branches: BranchView[];
  onClose: () => void;
  onConfirm: (branches: string[]) => void;
}) {
  return (
    <Modal
      title="Clean up merged branches"
      sub={<>merged into <span className="mono">{label}</span></>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-md btn-danger"
            disabled={!branches.length}
            onClick={() => {
              onConfirm(branches.map((b) => b.name));
              onClose();
            }}
          >
            Delete {branches.length} branch{branches.length === 1 ? "" : "es"}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        Their commits are all in <span className="mono">{label}</span>, so nothing is lost. They are deleted locally and on origin, and worktrees they have go too.
      </p>
      <ul className="col" style={{ margin: 0, padding: 0, listStyle: "none", gap: 4 }}>
        {branches.map((b) => (
          <li key={b.name} className="row" style={{ gap: 8 }}>
            <span className="mono ellipsis">{b.name}</span>
            {!b.local && <span className="tag" title="Only on origin">origin</span>}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/** Pick branches that fell far behind `base` to delete, unmerged commits and all; the delete runs in the background. */
function BehindCleanupModal({
  base,
  branches,
  onClose,
  onConfirm,
}: {
  base: string;
  branches: BranchView[];
  onClose: () => void;
  onConfirm: (branches: string[], remote: boolean) => void;
}) {
  // Nothing is picked up front: these hold work that isn't merged anywhere.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [remote, setRemote] = useState(true);
  const flip = (name: string) => {
    const next = new Set(picked);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setPicked(next);
  };
  const all = picked.size === branches.length;
  const lost = branches.filter((b) => picked.has(b.name)).reduce((n, b) => n + b.ahead, 0);
  return (
    <Modal
      title="Clean up branches falling behind"
      sub={<>far behind <span className="mono">{base}</span></>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-md btn-danger"
            disabled={!picked.size}
            onClick={() => {
              onConfirm([...picked], remote);
              onClose();
            }}
          >
            Delete {picked.size} branch{picked.size === 1 ? "" : "es"}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        These branches are not merged: deleting them throws away their commits{remote ? ", on origin too" : ""}. Worktrees they have go too. Pick the ones you no longer need.
      </p>
      <label className="check">
        <input type="checkbox" checked={all} onChange={() => setPicked(all ? new Set() : new Set(branches.map((b) => b.name)))} />
        <span>All {branches.length}</span>
      </label>
      <ul className="col" style={{ margin: 0, padding: 0, listStyle: "none", gap: 4 }}>
        {branches.map((b) => (
          <li key={b.name}>
            <label className="check">
              <input type="checkbox" checked={picked.has(b.name)} onChange={() => flip(b.name)} />
              <span className="mono ellipsis">{b.name}</span>
              <span className="c-warn">↓{b.behind}</span>
              {b.ahead > 0 && <span className="c-del">{plural(b.ahead, "commit")} lost</span>}
              {!b.local && <span className="tag" title="Only on origin">origin</span>}
              {!b.remote && <span className="tag" title="Not on origin">local</span>}
            </label>
          </li>
        ))}
      </ul>
      <label className="check">
        <input type="checkbox" checked={remote} onChange={() => setRemote(!remote)} />
        <span>Delete them on origin too</span>
      </label>
      {lost > 0 && <span className="c-del">{plural(lost, "unmerged commit")} will be deleted{remote ? "" : " locally"}.</span>}
    </Modal>
  );
}

const MSG_OPEN_KEY = "gitnetix.commitMessageOpen";

function CommitBox({ pid, branch, enabled, staged, changed }: { pid: string; branch: string; enabled: boolean; staged: number; changed: number }) {
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const aiOn = useAiOn("commit");
  // null until the user toggles it; then their last choice wins over the AI-based default.
  const [picked, setPicked] = useStoredChoice(MSG_OPEN_KEY);
  const open = picked ?? !aiOn;
  const toggle = () => setPicked(!open);
  const all = !staged;
  const canType = enabled && !!changed;
  // An empty summary lets AI write the whole message, so a description alone has nowhere to go.
  const orphanBody = !summary.trim() && !!body.trim();
  const message = summary.trim() ? [summary.trim(), body.trim()].filter(Boolean).join("\n\n") : "";
  const clear = () => { setSummary(""); setBody(""); };
  const inv = [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid]];
  const commit = useAction<{ sha: string; message: string; aiWritten: boolean }, { projectId: string; branch: string; message: string; all: boolean }>("workspace.commit", {
    invalidate: inv,
    // The WIP list and badge drop the committed files at once instead of waiting for the full overview.
    patch: (qc, v) => {
      const key = ["files", pid, v.branch, "wip", undefined, undefined];
      const left = v.all ? [] : (qc.getQueryData<FileChange[]>(key) ?? []).filter((f) => !f.staged);
      qc.setQueryData(key, left);
      const wip = new Set(left.map((f) => f.path)).size;
      const mark = (b: BranchView): BranchView => (b.name === v.branch ? { ...b, wip } : b);
      qc.setQueryData<Overview>(["overview", pid], (o) => o && { ...o, branches: o.branches.map(mark), otherBranches: o.otherBranches.map(mark), defaultView: o.defaultView && mark(o.defaultView) });
    },
    success: (r) => `${r.aiWritten ? "AI wrote: " : "Committed: "}${r.message.split("\n")[0]}`,
  });
  const draft = useAction<{ message: string }>("workspace.commitMessage");
  const nav = useNav();
  // Saved with the project, like the merge options.
  const { commit: prefs, setCommit } = useProjectPrefs(pid);
  const autoPush = prefs.autoPush;
  const push = useAction("workspace.push", { invalidate: inv, success: `Pushed ${branch}` });
  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  return (
    <div className="col" style={{ padding: "6px 12px 10px", gap: 6, borderTop: "1px solid var(--line)" }}>
      <div className="row faint" style={{ justifyContent: "space-between", fontSize: 11, margin: 0 }}>
        <button className="row" style={{ gap: 6, margin: "1px 0", padding: 0, border: 0, background: "transparent", color: "inherit", font: "inherit", cursor: "pointer" }} aria-expanded={open} aria-controls="ag-msg" onClick={toggle}>
          <Icon name="chevronDown" size={12} className="chev" />
          <span>Commit message</span>
        </button>
        {open && <button className="btn btn-ghost btn-sm" style={{ height: 20 }} disabled={!enabled || !staged || draft.isPending}
          title={staged ? "AI drafts a message from the staged files" : "Stage files first"} onClick={() => draft.mutate({ projectId: pid, branch }, { onSuccess: (r) => {
            const [first, ...rest] = r.message.split("\n");
            setSummary(first);
            setBody(rest.join("\n").trim());
          } })}>
          <Busy on={draft.isPending}><Icon name="sparkle" size={10} /></Busy>
          Draft
        </button>}
      </div>
      {open && <div id="ag-msg" className="col">
        <input
          id="ag-summary"
          className="input"
          style={{ height: 32, fontSize: 12.5, padding: "0 10px" }}
          placeholder={!enabled ? "Check out this branch to commit" : !changed ? "No changes to commit" : "Summary — leave empty for AI"}
          aria-label="Summary"
          value={summary}
          disabled={!canType}
          onChange={(e) => setSummary(e.target.value)}
        />
        <textarea
          className="textarea"
          rows={3}
          style={{ fontSize: 12.5, padding: "8px 10px", resize: "none" }}
          placeholder="Description (optional)"
          aria-label="Description"
          value={body}
          disabled={!canType}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>}
      <span className="split-btn" style={{ display: "flex", width: "100%" }}>
        <button className="btn btn-primary split-main" style={{ height: 34, flex: "1 1 auto" }} disabled={!canType || orphanBody || commit.isPending || push.isPending}
          title={orphanBody ? "Add a summary to go with the description" : undefined}
          onClick={() => commit.mutate({ projectId: pid, branch, message, all }, { onSuccess: () => { clear(); if (autoPush) push.mutate({ projectId: pid, branch }); } })}>
          <Busy on={commit.isPending || push.isPending}><Icon name="sparkle" size={12} /></Busy>
          <span>{all ? "Stage all & Commit" : "Commit"}<span style={{ fontWeight: 400, opacity: 0.75, marginLeft: 6 }}>{all ? changed || null : staged}</span></span>
        </button>
        <button
          className="btn btn-primary btn-icon split-more"
          style={{ height: 34, width: 34 }}
          aria-label="Commit options"
          data-tip="Commit options"
          aria-haspopup="menu"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMore({ x: r.right, y: r.bottom + 2 });
          }}
        >
          <Icon name="more" size={14} />
        </button>
      </span>
      {more && (
        <ContextMenu
          x={more.x}
          y={more.y}
          alignRight
          label="Commit options"
          items={[
            { id: "push", label: "Auto push commits", icon: autoPush ? "check" : undefined, hint: autoPush ? "on" : "off", run: () => setCommit({ autoPush: !autoPush }) },
            "sep",
            { id: "templates", label: "Show AI templates", icon: "sparkle", run: () => nav.go({ name: "templates" }) },
          ]}
          onClose={() => setMore(null)}
        />
      )}
    </div>
  );
}

/** The agent of the selected branch. Several agents at once are managed on the Worktrees & agents page. */
function Terminal({ pid, branch, open, setOpen, onCloseWorktree, finish }: { pid: string; branch?: string; open: boolean; setOpen: (b: boolean) => void; onCloseWorktree: (s: AgentSession) => void; finish: FinishHandlers }) {
  const agents = useAgents();
  const cur = (agents.data ?? []).find((a) => a.projectId === pid && a.branch === branch);
  const [text, setText] = useState("");
  const [pick, setPick] = useAgentPick(pid);
  // Starting on a branch makes its worktree and may move the main checkout off it.
  const start = useAction<{ id: string }>("agents.start", { invalidate: [["agents"], ["worktrees"], ["overview", pid]] });
  const message = useAction("agents.message", { invalidate: [["agents"]] });
  const configure = useAction("agents.configure", { invalidate: [["agents"]] });
  const remove = useAction("agents.remove", { invalidate: [["agents"]] });
  const height = usePaneWidth("gnx.pane.term", 248, 120, 900);

  if (!open) {
    return (
      <button className="row term-bar" style={{ height: 37, flex: "0 0 37px", margin: 0, padding: "0 14px 3px", border: 0, borderTop: "1px solid var(--line)", background: "var(--panel)", color: "var(--muted)", textAlign: "left" }} onClick={() => setOpen(true)}>
        <Icon name="terminal" />
        <span>{cur ? `Agent · ${cur.status}` : "Agent"}</span>
        {cur?.status === "running" && <span className="pulse" />}
        <span className="grow" />
        <Icon name="chevronUp" size={13} />
      </button>
    );
  }
  const busy = cur?.status === "running" || cur?.status === "paused";
  const send = () => {
    const t = text.trim();
    if (!t || busy) return;
    if (cur) {
      message.mutate({ id: cur.id, text: t }, { onSuccess: () => setText("") });
    } else {
      start.mutate(
        { projectId: pid, branch, request: t, ...pick },
        { onSuccess: () => setText("") },
      );
    }
  };
  return (
    <>
      <Resizer pane={height} label="Resize agents panel" top />
      <div className="term" style={{ "--term-h": `${height.width}px` } as CSSProperties}>
        {/* Empty parts of the bar collapse it, like the closed bar opens it. */}
        <div className="term-tabs term-bar" style={{ cursor: "pointer" }} onClick={(e) => !(e.target as HTMLElement).closest("button, select, input") && setOpen(false)}>
          {/* Equal-width sides keep the session label centered in the bar. */}
          <div className="term-side">
            <div className="row muted" style={{ padding: "0 10px 0 14px" }}>
              <Icon name="terminal" label="Agents" />
            </div>
            {!cur && <AgentPicker value={pick} onChange={setPick} compact />}
            {cur?.ai && <AgentPicker value={cur.ai} onChange={(p) => configure.mutate({ id: cur.id, ...p })} compact />}
          </div>
          {cur && (
            <>
              <span className="term-tab" style={{ fontSize: 11.5 }}>
                {cur.status === "running" && <span className="pulse" />}
                <span className="mono">{cur.branch}</span>
                <span className="faint">{cur.worktree ? "worktree" : "main checkout"}</span>
              </span>
              <button className="term-tab term-tab-x" aria-label={`Close ${cur.branch} session`} onClick={() => (cur.worktree ? onCloseWorktree(cur) : remove.mutate({ id: cur.id }))}>
                <Icon name="close" size={11} />
              </button>
            </>
          )}
          <div className="term-side" style={{ justifyContent: "flex-end" }}>
            {cur && !cur.ai && <span className="row faint hide-narrow" style={{ padding: "0 10px", fontSize: 11.5, whiteSpace: "nowrap" }}>{cur.agentLabel}</span>}
            <button className="btn btn-ghost" style={{ width: 36, height: "auto", border: 0, borderRadius: 0 }} aria-label="Collapse agents" onClick={() => setOpen(false)}>
              <Icon name="chevronDown" size={13} />
            </button>
          </div>
        </div>
        <AgentLog
          lines={cur?.lines ?? []}
          projectId={pid}
          provider={cur ? cur.ai?.provider : pick.provider}
          thinking={cur?.status === "running" || start.isPending || message.isPending}
          actions={
            cur?.worktree && <FinishWorktreeCard session={cur} finish={finish} />
          }
          onAnswer={cur && ((t) => message.mutate({ id: cur.id, text: t }))}
          empty={
            cur
              ? undefined
              : branch
                ? `Start an agent on ${branch}: it gets its own worktree, so it keeps working while you switch branches.`
                : "Start an agent on the main checkout: describe what it should do below."
          }
        />
        <form
          className="term-input"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <span className="mono c-acc" aria-hidden="true">›</span>
          <label htmlFor="ag-ask" className="sr-only">Ask the agent</label>
          <input
            id="ag-ask"
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            placeholder={busy ? "Agent is working…" : cur ? "Reply to the agent…" : "Ask the agent anything…"}
          />
          <button type="submit" className="btn btn-sm btn-primary btn-icon" aria-label="Send" data-tip="Send" disabled={busy || !text.trim() || start.isPending || message.isPending}>
            {start.isPending || message.isPending ? <span className="spinner" /> : <Icon name="send" size={13} />}
          </button>
        </form>
      </div>
    </>
  );
}

/** The worktree a session runs in; a worktree without an agent closes the same way. */
type WtSession = Pick<AgentSession, "projectId" | "branch" | "cwd">;
/** How a worktree session ends; each gets the session and whether to switch to where the code lands. */
type FinishHandlers = { discard: (s: WtSession) => void; continue: (s: WtSession, sw: boolean) => void; merge: (s: WtSession, sw: boolean) => void };

/** `continueOn` deletes the worktree and checks its branch out; `openMerge` shows the merge options, `then` running once merged. */
export function useFinishHandlers(
  pid: string,
  continueOn: (branch: string, path: string) => void,
  openMerge: (branch: string, then: () => void, stay: boolean) => void,
): FinishHandlers {
  const removeWt = useAction("worktrees.remove", { invalidate: [["agents"], ["worktrees"], ["overview", pid]], success: "Worktree removed" });
  // Removing the worktree also removes its agent session.
  const drop = (s: WtSession) => removeWt.mutate({ projectId: s.projectId, path: s.cwd });
  const deleteBranch = useAction("branches.delete", { invalidate: [["overview", pid], ["commits", pid]], success: "Branch deleted" });
  const nav = useNav();
  return {
    // Throws the session's work away: the worktree even with uncommitted changes, then its local branch even unmerged (origin's copy stays).
    discard: (s) =>
      removeWt.mutate(
        { projectId: s.projectId, path: s.cwd, force: true },
        { onSuccess: () => deleteBranch.mutate({ projectId: s.projectId, branch: s.branch, force: true }, { onSuccess: () => nav.forgetBranches(s.projectId, [s.branch]) }) },
      ),
    continue: (s, sw) => (sw ? continueOn(s.branch, s.cwd) : drop(s)),
    merge: (s, sw) => openMerge(s.branch, () => drop(s), !sw),
  };
}

/** Ends a worktree session: the agent stops and the worktree goes, its branch either kept to continue on or merged first. */
function CloseWorktreeModal({ session: s, finish, onClose }: { session: AgentSession; finish: FinishHandlers; onClose: () => void }) {
  const [then, setThen] = useState<"continue" | "merge">("continue");
  const [sw, setSw] = useState(true);
  const body = (
    <>
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        The agent will stop and the worktree folder will be deleted.
        <br />
        {then === "merge" ? (
          <>
            You will pick the merge options next; the folder will be deleted once <span className="mono">{s.branch}</span> is merged
            {sw ? ", and you will switch to the branch it went into" : ""}.
          </>
        ) : (
          <>
            <span className="mono">{s.branch}</span> and its commits will stay
            {sw ? <>, and you will switch to <span className="mono">{s.branch}</span></> : ""}.
          </>
        )}
      </p>
      <p style={{ margin: 0, lineHeight: 1.55 }}>Deleting the folder will be refused if it has uncommitted changes.</p>
      <Seg
        grid
        label="Then"
        value={then}
        onChange={setThen}
        options={[{ value: "continue", label: "Continue on branch" }, { value: "merge", label: "Merge it" }]}
      />
      <label className="check">
        <input type="checkbox" checked={sw} onChange={() => setSw(!sw)} />
        <span>Switch to {then === "merge" ? "the branch it merges into" : <span className="mono">{s.branch}</span>}</span>
      </label>
    </>
  );
  const buttons = (
    <>
      <button type="button" className="btn btn-md btn-danger" data-tip={`Delete the worktree, its uncommitted changes and the local ${s.branch} branch`} onClick={() => { finish.discard(s); onClose(); }}>Cancel and Delete all</button>
      <button type="button" className="btn btn-md btn-primary" onClick={() => { finish[then](s, sw); onClose(); }}>
        Finish with the agent / worktree{then === "merge" ? "…" : ""}
      </button>
    </>
  );
  return (
    <Modal title="Close worktree session" sub={<span className="mono">{s.branch}</span>} width={520} onClose={onClose} footer={buttons}>
      {body}
    </Modal>
  );
}

/** Under the agent's last reply: proposes merging the worktree's branch, continuing on it or discarding it a click away. */
export function FinishWorktreeCard({ session: s, finish }: { session: WtSession; finish: FinishHandlers }) {
  const nav = useNav();
  const branches = useOverview(s.projectId).data?.branches;
  // MergeModal reads its base once, on mount: wait for the branches.
  if (!branches) return null;
  const b = branches.find((x) => x.name === s.branch);
  // Nothing committed or edited yet (the agent only answered or asked): nothing to merge.
  // Not in the overview: no base to merge into.
  if (!b || (!b.ahead && !b.wip)) return null;
  return (
    <MergeModal
      pid={s.projectId}
      branch={s.branch}
      base={b.parent ?? ""}
      others={mergeTargets(branches, s.branch)}
      onClose={() => {}}
      onDeleted={(into) => nav.projectId === s.projectId && nav.selectedBranch === s.branch && nav.selectBranch(into)}
      // Not switching, `continue` only deletes the worktree, as `finish.merge` does once merged.
      onMerged={() => finish.continue(s, false)}
      inline={
        <>
          <button type="button" className="btn btn-md btn-danger" data-tip={`Delete the worktree, its uncommitted changes and the local ${s.branch} branch`} onClick={() => finish.discard(s)}>Cancel and Delete all</button>
          <button type="button" className="btn btn-md" data-tip={`Delete the worktree and switch to ${s.branch}; refused with uncommitted changes`} onClick={() => finish.continue(s, true)}>Continue on branch</button>
        </>
      }
    />
  );
}

function ShipModal({ pid, release, defaultBranch, onClose }: { pid: string; release: ReleaseView; defaultBranch: string; onClose: () => void }) {
  const [push, setPush] = useState(true);
  const ship = useAction<{ tag: string }>("releases.ship", { invalidate: [["overview", pid], ["projects"]], success: (r) => `Shipped ${r.tag}` });
  return (
    <Modal
      title={`Ship v${release.version}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-md" disabled={ship.isPending} onClick={() => ship.mutate({ projectId: pid, version: release.version, push }, { onSuccess: onClose })}>
            {ship.isPending && <span className="spinner" />}
            Ship v{release.version}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        Moves <span className="mono">{defaultBranch}</span> to <span className="mono">{release.branch}</span> (fast-forward only) and creates the tag <span className="mono">v{release.version}</span>.
        It stops if {defaultBranch} has commits the release does not.
      </p>
      {release.items.length > 0 && (
        <div className="note-box">
          Make sure these are merged into {release.branch}: {release.items.map((b) => b.name).join(", ")}.
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={push} onChange={() => setPush(!push)} />
        <span>Push {defaultBranch} and the tag to origin</span>
      </label>
    </Modal>
  );
}

/** A base64 blob as UTF-8 text; null when it is binary (holds a NUL byte). */
function decodeText(b64: string | null | undefined): string | null | undefined {
  if (b64 == null) return b64;
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return bytes.includes(0) ? null : new TextDecoder().decode(bytes);
}
