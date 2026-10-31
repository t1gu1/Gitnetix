import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode } from "react";

import {
  committed,
  deletedOverview,
  discardedWip,
  droppedBranch,
  droppedWorktree,
  movedWip,
  patchOverview,
  patchWip,
  pushed,
  queryClient,
  resetFilesProgress,
  settle,
  switchedOverview,
  useAction,
  useAgents,
  useAiOn,
  useAutoFetch,
  useBlobs,
  useDiff,
  useFiles,
  useFilesProgress,
  useOverview,
  useOverviewProgress,
  usePendingBranches,
  useProjectPrefs,
  useProjects,
} from "../api/hooks";
import { isLocal, revealPath, rpc } from "../api/transport";
import type { AgentSession, BranchView, Commit, FileChange, Hunk, LinePick, MergeResult, Overview, RebaseResult, ReleaseView, RenameResult, Stash } from "../api/types";
import { AgentInput, AgentLog, type Choice, type Upload } from "../components/AgentLog";
import { AgentPicker, useAgentPick } from "../components/AgentPicker";
import { DiffView, LargeDiff, type DiffMode, type Staging } from "../components/DiffView";
import { IMAGE_MODES, ImageDiff, comparable, isImage, useImageMode, type ImageMode } from "../components/ImageDiff";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { Resizer, usePaneWidth } from "../components/Resizer";
import { ShellPane, TermTabs, useTermView } from "../components/Shell";
import { Busy, Confirm, ErrorBox, Loading, Markdown, Modal, Seg, swipeProps } from "../components/ui";
import { ago, plural, timeLeft } from "../lib/format";
import { shownStatus } from "../lib/agentLog";
import { startCleanup, useCleaning } from "../lib/cleanups";
import { useDraft } from "../lib/drafts";
import { useNav } from "../lib/nav";
import { useStoredChoice, useStoredFlag } from "../lib/stored";
import { agentKey, branchKey, call, runTask, useHidden, wtKey } from "../lib/tasks";
import { copyToClipboard, toast } from "../lib/toast";
import { offersRebase, rebaseMessage, useBranchActions, type BranchDialog, type BranchTarget } from "./BranchMenu";
import { BranchTree } from "./BranchTree";
import { CommitList, DeleteTagModal, TagModal } from "./CommitList";
import { ConflictModal } from "./ConflictModal";
import { StashList } from "./StashList";

type Mode = "branch" | "wip" | "project";
type Pane = "releases" | "files" | "diff";
const PANES: Pane[] = ["releases", "files", "diff"];
/** A file with more changed lines than this waits for "Show anyway" before its diff is even fetched. */
const HUGE_DIFF = 20_000;
/** A tree folder holding more files than this starts closed, and so do the folders inside it. */
const BIG_FOLDER = 200;
/** The flat list draws this many files until "Show all". */
const MAX_ROWS = 1000;

export function Workspace() {
  const nav = useNav();
  const pid = nav.projectId!;
  const ov = useOverview(pid);
  const progress = useOverviewProgress(pid);
  useAutoFetch(pid, !!ov.data?.remote);
  const [mode, setMode] = useState<Mode>("wip");
  const [file, setFile] = useState<string | undefined>();
  const [diffMode, setDiffMode] = useState<DiffMode>("unified");
  const [preview, setPreview] = useState(false);
  const [svgCode, setSvgCode] = useState(false);
  const [imageMode, setImageMode] = useImageMode();
  const [termOpen, setTermOpen] = useStoredFlag("gnx.pane.termOpen");
  const [pane, setPane] = useState<Pane>("releases");
  // Which way the narrow layout slides the new pane in; none until the first switch.
  const [slide, setSlide] = useState<{ pane: Pane; dir?: "next" | "prev" }>({ pane });
  if (slide.pane !== pane) setSlide({ pane, dir: PANES.indexOf(pane) > PANES.indexOf(slide.pane) ? "next" : "prev" });
  const [shipping, setShipping] = useState<ReleaseView | null>(null);
  // `cwd`: the worktree a merge deletes once done (closing a worktree session after merging it).
  const [dialog, setDialog] = useState<{ kind: BranchDialog; branch: string; onto?: string; cwd?: string; stay?: boolean; into?: string } | null>(null);
  const [closingSession, setClosingSession] = useState<AgentSession | null>(null);
  const [deletingTag, setDeletingTag] = useState<string | null>(null);
  const checkoutTag = useAction<unknown, { projectId: string; name: string }>("tags.checkout", {
    invalidate: [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid]],
    patch: (qc, v) => qc.setQueryData<Overview>(["overview", pid], (o) => o && switchedOverview(o, null, v.name)),
  });
  const [cleanup, setCleanup] = useState<{ parent: string; label: string; branches: BranchView[] } | null>(null);
  const [cleanupBehind, setCleanupBehind] = useState<{ section: string; base: string; branches: BranchView[] } | null>(null);
  const [cleanupShipped, setCleanupShipped] = useState<BranchView[] | null>(null);
  const cleanupLeft = useCleaning(pid);
  // Branch whose commits replace the tree, and the commit picked there (none = all changes).
  const [history, setHistory] = useState<string | null>(null);
  const [commit, setCommit] = useState<Commit | undefined>();
  // File view picked before the commit list took over, put back when it closes.
  const modeBeforeHistory = useRef<Mode>(mode);
  // Stash list in place of the tree: one branch's ("" = every stash), and the stash picked there.
  const [stashesOf, setStashesOf] = useState<string | null>(null);
  const [stash, setStash] = useState<Stash | undefined>();
  // Left pane (branches, or the diff over them) as a percent of the workspace: two thirds by default.
  const leftW = usePaneWidth("gnx.pane.left", 67, 20, 80);
  const [asTree, setAsTree] = useStoredFlag("gnx.files.tree");
  // Collapse/expand all: a new `n` remounts the file lists, dropping per-folder toggles.
  const [fold, setFold] = useState({ closed: false, n: 0 });
  const actions = useBranchActions(pid, (kind, branch, onto) => {
    // A worktree's branch ends the way its worktree session does: delete is "Cancel and Delete all", merge drops the worktree once merged.
    const wt = byName.get(branch)?.worktree;
    if (wt && kind === "merge") finish.merge({ projectId: pid, branch, cwd: wt }, true);
    else setDialog({ kind, branch, onto });
  });
  const finish = useFinishHandlers(pid, actions.continueOn, (branch, cwd, stay, into) => setDialog({ kind: "merge", branch, cwd, stay, into }));

  const hidden = useHidden();
  // Branches a background action is deleting leave the tree at the click; they come back if it fails.
  const o = useMemo(() => {
    const prefix = branchKey(pid, "");
    return [...hidden].filter((k) => k.startsWith(prefix)).reduce((x, k) => x && deletedOverview(x, k.slice(prefix.length), true), ov.data);
  }, [ov.data, hidden, pid]);
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
  const current = list.find((f) => fileKey(f) === file);
  // Project view lists untouched files too: those show as the plain file, no diff.
  const unchanged = mode === "project" && !commit && !stash && current?.status === " ";
  const markdown = /\.(md|markdown|mdx)$/i.test(current?.path ?? "");
  // The file whose large diff the user asked to see anyway. One with a huge known line count isn't even fetched before that.
  const [anyway, setAnyway] = useState<string>();
  const forced = !!current && anyway === fileKey(current);
  const changedLines = current ? current.additions + current.deletions : 0;
  const huge = !forced && changedLines > HUGE_DIFF;
  const showAnyway = () => current && setAnyway(fileKey(current));
  const diff = useDiff(pid, branch, mode, unchanged || huge ? undefined : current?.path, current?.staged, commit?.sha, stash?.sha, diffMode === "full");
  const svg = /\.svg$/i.test(current?.path ?? "");
  // An SVG is text too: its Code view drops the image preview and shows it like any other file.
  const image = isImage(current?.path) && !(svg && svgCode);
  const blobs = useBlobs(pid, branch, mode, current?.path, current?.staged, commit?.sha, stash?.sha, image || unchanged || markdown);
  const text = useMemo(() => !image && decodeText(blobs.data?.new ?? blobs.data?.old), [blobs.data, image]);
  // Memoized: a new array would re-render every row and re-measure the heatmap.
  const raw = useMemo<Hunk[] | undefined>(
    () => (unchanged && typeof text === "string" ? [{ header: "", oldStart: 1, newStart: 1, lines: text.replace(/\n$/, "").split("\n").map((t) => ({ kind: " ", text: t })) }] : undefined),
    [unchanged, text],
  );
  const showPreview = markdown && preview && typeof text === "string";
  // A WIP file's diff stages or unstages some of its lines. Like whole files, that moves no ref (see WipList).
  type LineMove = { projectId: string; branch: string; path: string; lines: LinePick[] };
  const lineInv = [["files", pid], ["diff", pid], ["blobs", pid], ...(o?.inProgress || view?.conflict ? [["overview", pid]] : [])];
  const stageLines = useAction<unknown, LineMove>("workspace.stageLines", { invalidate: lineInv });
  const unstageLines = useAction<unknown, LineMove>("workspace.unstageLines", { invalidate: lineInv });
  // Discarding a file's last lines takes it out of the WIP count the overview shows.
  const discardLines = useAction<unknown, LineMove>("workspace.discardLines", {
    invalidate: [["files", pid], ["diff", pid], ["blobs", pid], ["overview", pid]],
    success: "Changes discarded",
  });
  const staging: Staging | undefined =
    mode === "wip" && !commit && !stash && branch && checkedOut && current?.staged !== undefined && current.status !== "C"
      ? {
          staged: current.staged,
          busy: stageLines.isPending || unstageLines.isPending || discardLines.isPending,
          apply: (lines) => (current.staged ? unstageLines : stageLines).mutateAsync({ projectId: pid, branch, path: current.path, lines }),
          discard: current.staged ? undefined : (lines) => discardLines.mutateAsync({ projectId: pid, branch, path: current.path, lines }),
        }
      : undefined;
  const [discarding, setDiscarding] = useState<{ staged: boolean; paths: string[] } | null>(null);
  // The main checkout has no worktree path: it lives at the project's own path.
  const projects = useProjects().data;
  const root = view?.worktree ?? projects?.find((p) => p.id === pid)?.path;
  const ignore = useAction<unknown, { projectId: string; branch: string; path: string; dir: boolean }>("workspace.ignore", {
    invalidate: [["files", pid], ["diff", pid], ["overview", pid]],
    success: "Added to .gitignore",
  });
  const junk = useMemo(() => (mode === "wip" && !commit && !stash && checkedOut ? junkFolder(list) : undefined), [mode, commit, stash, checkedOut, list]);
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
  // A WIP file whose last lines on its side were staged (or unstaged) lives on the other side now: follow it there.
  useEffect(() => {
    if (current || !file || mode !== "wip") return;
    const moved = list.find((f) => f.staged !== undefined && fileKey({ ...f, staged: !f.staged }) === file);
    if (moved) setFile(fileKey(moved));
  }, [current, file, mode, list]);
  // Escape closes the diff, unless it is closing something else (or letting go of selected lines) or typing; captured so
  // the commit or stash list under it stays open.
  const fileOpen = !!current;
  useEffect(() => {
    if (!fileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (e.target as HTMLElement).closest("input, textarea")) return;
      if (document.querySelector("[role=dialog], [role=menu], .diff-picks")) return;
      e.stopImmediatePropagation();
      setFile(undefined);
      setPane("files");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [fileOpen]);
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
  /** Where `b` is being replayed: the checked-out branch's paused rebase may go elsewhere than its target. */
  const rebasingOnto = (b: string) => labelOf(b === o?.currentBranch && o?.rebaseOnto ? o.rebaseOnto : baseFor(b));

  if (ov.isLoading) return <Loading />;
  return (
    <>
      {ov.error && (
        <div style={{ padding: 16 }}>
          <ErrorBox error={ov.error} />
        </div>
      )}

      {o && (
        <main
          className="ws"
          style={{ "--branches-w": `${leftW.width}%` } as CSSProperties}
          data-file-open={current ? true : undefined}
          data-slide={slide.dir}
          {...swipeProps((dir) => {
            // Past the first pane, a commit or stash list steps back to the branches, like its back button.
            if (dir < 0 && pane === PANES[0] && history) return closeHistory();
            if (dir < 0 && pane === PANES[0] && stashesOf !== null) return closeStashes();
            const next = PANES[PANES.indexOf(pane) + dir];
            if (next) setPane(next);
          })}
        >
          <div className="ws-left" data-pane data-active={pane !== "files"}>
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
                upstream={!!byName.get(history)?.upstream}                current={o.currentBranch ?? undefined}
                onPick={(c, auto) => {
                  setCommit(c);
                  setMode("branch");
                  if (!auto) setPane("files");
                }}
                onBack={closeHistory}
              />
            ) : (
              <BranchTree
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
                onCleanupShipped={setCleanupShipped}
                isCleaning={(s) => cleanupLeft(s) !== undefined}
                cleanupLeft={cleanupLeft}
                tagItems={tagItems}
                onStashes={() => openStashes()}
                building={ov.isPlaceholderData}
                updating={ov.isFetching && !ov.isPlaceholderData}
                progress={progress}
              />
            )}

            <section aria-label="Diff" className="ws-diff" data-pane data-active={pane === "diff"}>
              <div className="pane-head" style={{ background: "var(--panel)" }}>
                <span className="mono ellipsis" style={{ fontSize: 12.5 }}>{current?.path ?? "No file selected"}</span>
                <span className="row mono" style={{ fontSize: 11.5, gap: 6 }}>
                  {current?.additions ? <span className="c-add">+{current.additions}</span> : null}
                  {current?.deletions ? <span className="c-del">−{current.deletions}</span> : null}
                </span>
                <span className="grow" />
                {image ? (
                  (comparable(blobs.data) || svg) && (
                    <Seg<ImageMode | "code">
                      value={imageMode}
                      onChange={(v) => (v === "code" ? setSvgCode(true) : setImageMode(v))}
                      label="Image comparison"
                      options={[
                        ...(comparable(blobs.data) ? IMAGE_MODES : [{ value: imageMode, label: "Image" }]),
                        ...(svg ? [{ value: "code" as const, label: "Code" }] : []),
                      ]}
                    />
                  )
                ) : (
                  (!unchanged || markdown || svg) && (
                    <Seg<DiffMode | "raw" | "preview" | "image">
                      value={markdown && preview ? "preview" : unchanged ? "raw" : diffMode}
                      onChange={(v) => {
                        setPreview(v === "preview");
                        if (v === "image") setSvgCode(false);
                        else if (v !== "preview" && v !== "raw") setDiffMode(v);
                      }}
                      label="Diff mode"
                      options={[
                        ...(unchanged
                          ? [{ value: "raw" as const, label: "Raw" }]
                          : [{ value: "split" as const, label: "Split" }, { value: "unified" as const, label: "Unified" }, { value: "full" as const, label: "Full" }]),
                        ...(markdown ? [{ value: "preview" as const, label: "Preview" }] : []),
                        ...(svg ? [{ value: "image" as const, label: "Image" }] : []),
                      ]}
                    />
                  )
                )}
                {current && (
                  <button className="btn btn-sm btn-icon pane-back pane-close" aria-label="Close file" data-tip="Back to branches" onClick={() => { setFile(undefined); setPane("files"); }}>
                    <Icon name="close" size={13} />
                  </button>
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
                    {huge && !image && <LargeDiff lines={changedLines} onShow={showAnyway} />}
                    {raw && current && <DiffView path={current.path} hunks={raw} mode="full" anyway={forced} onAnyway={showAnyway} />}
                    {!image && current && diff.data && diff.data.length > 0 && <DiffView path={current.path} hunks={diff.data} mode={diffMode} staging={staging} anyway={forced} onAnyway={showAnyway} />}
                  </>
                )}
                {(!current || (diff.data && diff.data.length === 0 && !image) || (unchanged && !image && blobs.data && text === null)) && (
                  <div className={list.length === 0 ? "empty engraved" : "empty"} style={{ fontFamily: "var(--sans)" }}>
                    {list.length === 0 ? "Nothing to show — working tree is clean." : !current ? "No file selected." : unchanged ? "Binary file." : "No textual changes in this file."}
                  </div>
                )}
              </div>
            </section>
            <Terminal
              pid={pid}
              branch={branch}
              cwd={root}
              worktree={!!view?.worktree}
              open={termOpen}
              setOpen={setTermOpen}
              onCloseWorktree={setClosingSession}
              finish={finish}
            />
          </div>
          <Resizer pane={leftW} label="Resize panels" percent />
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
            {junk && (
              <div className="col note-box" style={{ margin: "10px 12px 0" }}>
                <span style={{ fontSize: 12, lineHeight: 1.45 }}>
                  <span className="mono">{junk}/</span> isn't ignored: its files fill the list and slow the app down.
                </span>
                <button className="btn btn-sm" style={{ height: 30 }} disabled={ignore.isPending} onClick={() => branch && ignore.mutate({ projectId: pid, branch, path: junk, dir: true })}>
                  {ignore.isPending ? <span className="spinner" /> : <Icon name="edit" size={12} />}
                  <span>Add to .gitignore</span>
                </button>
              </div>
            )}
            {inRebase && (
              <div className="col note-box" style={{ margin: "10px 12px 0" }}>
                <span style={{ fontSize: 12, lineHeight: 1.45 }}>
                  Rebase onto <span className="mono">{rebasingOnto(branch!)}</span> stopped on {o.conflicts.length || "a"} conflict{o.conflicts.length === 1 ? "" : "s"}.
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
                  midOp={!!o.inProgress || !!view?.conflict}
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
            {branch && !history && <CommitBox key={branch} pid={pid} branch={branch} enabled={checkedOut} staged={stagedCount} changed={wipCount} />}
          </section>

        </main>
      )}

      {/* After main so it sits at the bottom, just above the mobile tabs. */}
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

      {discarding && branch && (
        <DiscardModal pid={pid} branch={branch} staged={discarding.staged} paths={discarding.paths} total={list.filter((f) => f.staged === discarding.staged).length} onClose={() => setDiscarding(null)} />
      )}
      {shipping && <ShipModal pid={pid} release={shipping} defaultBranch={o?.defaultBranch ?? "main"} onClose={() => setShipping(null)} />}
      {actions.menuEl}
      {dialog?.kind === "conflicts" && <ConflictModal pid={pid} branch={dialog.branch} base={rebasingOnto(dialog.branch)} onClose={() => setDialog(null)} />}
      {dialog?.kind === "merge" && dialogView && (
        <MergeModal
          pid={pid}
          branch={dialog.branch}
          base={dialog.into ?? baseFor(dialog.branch)}
          // Any other local branch can take it: releases first, then trunks, then work branches.
          others={mergeTargets(o?.branches ?? [], dialog.branch)}
          worktree={dialog.cwd}
          stay={dialog.stay}
          onClose={() => setDialog(null)}
        />
      )}
      {closingSession && (
        <CloseWorktreeModal session={closingSession} finish={finish} onClose={() => setClosingSession(null)} />
      )}
      {cleanup && (
        <CleanupModal
          title="Clean up merged branches"
          sub={<>merged into <span className="mono">{cleanup.label}</span></>}
          note={<>Their commits are all in <span className="mono">{cleanup.label}</span>, so nothing is lost.</>}
          branches={cleanup.branches}
          onClose={() => setCleanup(null)}
          onConfirm={(names) => cleanUp(`merged:${cleanup.parent}`, names, { remote: true }, "merged branch")}
        />
      )}
      {cleanupShipped && (
        <CleanupModal
          title="Clean up shipped release branches"
          sub="their tags stay"
          note="Their releases stay tagged, and a branch with commits its base lacks is kept, so nothing is lost. Branches merged into them file under where they landed."
          branches={cleanupShipped}
          onClose={() => setCleanupShipped(null)}
          onConfirm={(names) => cleanUp("shipped", names, { remote: true }, "release branch")}
        />
      )}
      {cleanupBehind && (
        <BehindCleanupModal
          pid={pid}
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
      {dialog?.kind === "tag" && <TagModal pid={pid} branch={dialog.branch} onClose={() => setDialog(null)} />}
      {dialog?.kind === "rename" && dialogView && (
        <RenameBranchModal pid={pid} view={dialogView} onClose={() => setDialog(null)} onRenamed={(to) => dialog.branch === branch && nav.selectBranch(to)} />
      )}
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
      {dialog?.kind === "rebaseOnto" && o && (
        <RebaseOntoBranchModal pid={pid} branch={dialog.branch} onto={dialog.onto} branches={o.branches} labelOf={labelOf} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "delete" && dialogView?.worktree && (
        <DiscardWorktreeModal branch={dialog.branch} path={dialogView.worktree} onClose={() => setDialog(null)} onConfirm={() => finish.discard({ projectId: pid, branch: dialog.branch, cwd: dialogView.worktree! })} />
      )}
      {dialog?.kind === "abortSwitch" && o?.inProgress && (
        <AbortSwitchModal op={o.inProgress} branch={dialog.branch} path={o.project.path} onClose={() => setDialog(null)} onConfirm={() => actions.abortAndSwitch(dialog.branch)} />
      )}
      {dialog?.kind === "switchWip" && o && (
        <SwitchWipModal from={o.currentBranch} branch={dialog.branch} onClose={() => setDialog(null)} onConfirm={(wip) => actions.switchWith(dialog.branch, wip)} />
      )}
      {dialog?.kind === "pullWip" && (
        <PullWipModal branch={dialog.branch} upstream={dialogView?.upstream} onClose={() => setDialog(null)} onConfirm={(wip) => actions.pullWith(dialog.branch, wip)} />
      )}
      {dialog?.kind === "continue" && dialogView?.worktree && (
        <ContinueOnBranchModal branch={dialog.branch} path={dialogView.worktree} onClose={() => setDialog(null)} onConfirm={() => finish.continue({ projectId: pid, branch: dialog.branch, cwd: dialogView.worktree! }, true)} />
      )}
      {finish.modal}
      {dialog?.kind === "delete" && dialogView && !dialogView.worktree && (
        <DeleteBranchModal
          pid={pid}
          branch={dialog.branch}
          base={baseFor(dialog.branch)}
          local={dialogView.local}
          remote={dialogView.remote}
          worktree={dialogView.worktree ?? undefined}
          onClose={() => setDialog(null)}
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
  midOp,
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
  /** Mid rebase or merge: staging settles conflicts, which the overview shows. */
  midOp: boolean;
  list: FileChange[];
  current?: FileChange;
  tree: boolean;
  fold: { closed: boolean; n: number };
  menu: (t: FileTarget) => MenuItem[];
  onPick: (f: FileChange) => void;
  onMoved: (f: FileChange) => void;
  onDiscard: (staged: boolean, paths: string[]) => void;
}) {
  // Staging moves no ref and no file count: the overview only needs asking again mid rebase or merge.
  const inv = [["files", pid], ["diff", pid], ...(midOp ? [["overview", pid]] : [])];
  type Move = { projectId: string; branch: string; paths: string[] };
  const stage = useAction<unknown, Move>("workspace.stage", { invalidate: inv, patch: (qc, v) => patchWip(qc, pid, v.branch, (l) => movedWip(l, v.paths, true)) });
  const unstage = useAction<unknown, Move>("workspace.unstage", { invalidate: inv, patch: (qc, v) => patchWip(qc, pid, v.branch, (l) => movedWip(l, v.paths, false)) });
  const busy = stage.isPending || unstage.isPending;
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  // No files = the whole side.
  const move = (staged: boolean, fs: FileChange[] = []) => {
    resetFilesProgress(queryClient, pid);
    (staged ? unstage : stage).mutate({ projectId: pid, branch, paths: fs.map((f) => f.path) }, { onSuccess: () => fs.forEach(onMoved) });
  };

  return (
    <>
      {[true, false].map((staged) => {
        const side = list.filter((f) => !!f.staged === staged);
        if (!side.length) return null;
        const leaving = staged ? unstage : stage;
        const moving = leaving.isPending ? leaving.variables?.paths.length || side.length : 0;
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
            {moving >= MANY_FILES ? (
              <FilesBusy pid={pid} verb={staged ? "Unstaging" : "Staging"} count={moving} />
            ) : (
              side.length > UNCOUNTED_PAST && (
                <div className="files-note faint" data-tip={`Past ${UNCOUNTED_PAST.toLocaleString()} files, lines are not counted: it would slow the list down.`}>
                  {UNCOUNTED_PAST.toLocaleString()}+ files · line counts skipped
                </div>
              )
            )}
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
  const discard = useAction("workspace.discard", {
    invalidate: [["files", pid], ["diff", pid], ["overview", pid]],
    patch: (qc) => patchWip(qc, pid, branch, (l) => discardedWip(l, paths, staged)),
    success: "Changes discarded",
  });
  const count = paths.length || total;
  const what = paths.length === 1 ? <span className="mono">{paths[0]}</span> : <>{count} file{count === 1 ? "" : "s"}</>;
  return (
    <Modal
      title={staged ? "Discard staged changes" : "Discard unstaged changes"}
      sub={what}
      onClose={discard.isPending ? undefined : onClose}
      footer={
        <>
          <button
            className="btn btn-md btn-danger"
            disabled={discard.isPending}
            onClick={() => {
              resetFilesProgress(queryClient, pid);
              discard.mutate({ projectId: pid, branch, staged, paths }, { onSuccess: onClose });
            }}
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
      {discard.isPending && count >= MANY_FILES && <FilesBusy pid={pid} verb="Discarding" count={count} />}
      {discard.error && <ErrorBox error={discard.error} />}
    </Modal>
  );
}

/** From here the engine reports how far a stage or discard is (`files_progress` in app.rs). */
const MANY_FILES = 1000;
/** Past this many files on a side the engine counts no lines (`MAX_COUNTED` in git.rs). */
const UNCOUNTED_PAST = 2000;

/** Spinner and how far a long stage, unstage or discard is, with the time left once the pace shows. */
function FilesBusy({ pid, verb, count }: { pid: string; verb: string; count: number }) {
  const p = useFilesProgress(pid);
  const n = (x: number) => x.toLocaleString();
  const text = !p
    ? `${verb} ${n(count)} files…`
    : p.done >= p.total
      ? `${verb} ${n(p.total)} files · finishing…`
      : `${verb} ${n(p.done)} of ${n(p.total)} files${p.left === undefined ? "…" : ` · ${timeLeft(p.left)}`}`;
  return (
    <div className="files-busy faint" role="status">
      <span className="spinner" />
      {text}
    </div>
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

/** Folders of installed packages or caches, which a repository should ignore. */
const JUNK_DIRS = new Set(["node_modules", ".bun"]);

/** The first such folder holding untracked files, outermost. */
function junkFolder(list: FileChange[]): string | undefined {
  for (const f of list) {
    if (f.staged !== false || f.status !== "A") continue;
    const parts = f.path.split("/");
    const i = parts.findIndex((p, j) => j < parts.length - 1 && JUNK_DIRS.has(p));
    if (i >= 0) return parts.slice(0, i + 1).join("/");
  }
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
  const [all, setAll] = useState(false);
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
  if (!tree) {
    const more = all ? 0 : list.length - MAX_ROWS;
    return (
      <>
        {(more > 0 ? list.slice(0, MAX_ROWS) : list).map((f) => row(f))}
        {more > 0 && (
          <li className="row" style={{ gap: 8, padding: "6px 14px", fontSize: 12, color: "var(--muted)" }}>
            <span className="grow">{plural(more, "more file")}</span>
            <button className="btn btn-sm btn-ghost" onClick={() => setAll(true)}>Show all</button>
          </li>
        )}
        {ctxMenu}
      </>
    );
  }
  // A big folder (an unignored node_modules) and the folders inside it start closed: their rows are only drawn once opened.
  const walk = (d: Dir, path: string, depth: number, inBig = false): ReactNode[] => [
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
      const big = inBig || t.files.length > BIG_FOLDER;
      const shut = closed[key] ?? (allClosed || big);
      const btn = (
        <button
          className="file-btn"
          style={{ paddingLeft: 14 + depth * 14 }}
          aria-expanded={!shut}
          onClick={() => setClosed((c) => ({ ...c, [key]: !(c[key] ?? (allClosed || big)) }))}
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
          {!shut && <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{walk(sub, key, depth + 1, big)}</ul>}
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
  worktree,
  stay,
  inline,
}: {
  pid: string;
  branch: string;
  base: string;
  /** Every other branch it could merge into instead. */
  others: string[];
  onClose: () => void;
  /** Worktree to delete once merged: a worktree session ending. */
  worktree?: string;
  /** Leave the main checkout where it is after merging. */
  stay?: boolean;
  /** Show it in the agent chat instead of a modal, these buttons in place of Cancel. */
  inline?: ReactNode;
}) {
  // The options picked last time, saved with the project.
  const { merge: opts, setMerge: set } = useProjectPrefs(pid);
  const [base, setBase] = useState(defaultBase);
  const [pick, setPick] = useState<{ x: number; y: number } | null>(null);
  const nav = useNav();
  // Uncommitted work on the branch would be left out of the merge: commit or discard it first.
  const wip = useOverview(pid).data?.branches.find((x) => x.name === branch)?.wip ?? 0;
  const [asking, setAsking] = useState(false);
  // In the background: the dialog closes and what the merge deletes leaves the lists at once; a toast tells how it goes.
  const run = () => {
    const into = base;
    const deleting = opts.deleteBranch;
    onClose();
    // No base known: the engine works out where it goes.
    if (deleting) nav.forgetBranches(pid, [branch], into || undefined);
    void runTask({
      label: into ? `Merging ${branch} into ${into}…` : `Merging ${branch}…`,
      conflictsIn: pid,
      hide: [...(deleting ? [branchKey(pid, branch)] : []), ...(worktree ? [wtKey(worktree)] : [])],
      invalidate: [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid], ...(worktree ? [["worktrees"], ["agents"]] : [])],
      run: async (say) => {
        const r = await call<MergeResult>("branches.merge", { projectId: pid, branch, into, deleteBranch: deleting, squash: opts.squash, squashAi: opts.squashMessage === "ai", rebase: opts.rebase, push: opts.push, stay });
        if (r.deleted) await droppedBranch(queryClient, pid, branch, true);
        let wtError: string | undefined;
        // Deleting the branch took its worktree along.
        if (worktree && !r.deleted) {
          say(`Merged ${branch} into ${r.into}, deleting its worktree…`);
          wtError = await call("worktrees.remove", { projectId: pid, branch, path: worktree }).then(() => undefined, (e: Error) => e.message);
        }
        if (worktree && !wtError) await droppedWorktree(queryClient, pid, branch, worktree);
        return { ...r, wtError };
      },
      done: (r) =>
        `${r.alreadyMerged ? `${branch} was already in ${r.into}` : `Merged ${branch} into ${r.into}`}${r.switched ? ` · switched to ${r.into}` : ""}${r.deleted ? " · branch deleted" : ""}${worktree && !r.wtError ? " · worktree deleted" : ""}${r.pushed ? " · pushed" : ""}${r.retagged ? ` · ${r.retagged} moved` : ""}${r.stayed ? ` · stayed put: ${r.stayed}` : ""}`,
    }).then((r) => {
      if (!r) return;
      // The merge went through but a step after it did not: each stays until clicked, like a failed merge.
      const failed = [
        r.pushError && `Merged, but pushing ${r.into} failed: ${r.pushError}`,
        r.tagError && `Merged, but moving its release tag failed: ${r.tagError}`,
        r.deleteError && `Merged, but deleting ${branch} failed: ${r.deleteError}`,
        r.wtError && `Merged, but deleting the worktree failed: ${r.wtError}`,
      ];
      for (const e of failed) if (e) toast(e, "error", Infinity);
      // The selection follows the main checkout to where the work landed.
      if (r.switched) nav.forgetBranches(pid, [branch], r.into);
    });
  };
  const footer = (
    <>
      {inline}
      <span className="split-btn">
        <button className="btn btn-primary btn-md split-main" onClick={() => (wip ? setAsking(true) : run())}>
          Merge into {base}
        </button>
        <button
          className="btn btn-primary btn-md btn-icon split-more"
          aria-label="Merge into another branch"
          data-tip="Merge into another branch"
          aria-haspopup="menu"
          disabled={!others.length}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setPick({ x: r.right, y: r.bottom + 2 });
          }}
        >
          <Icon name="chevronDown" size={16} />
        </button>
      </span>
      {pick && (
        <ContextMenu
          x={pick.x}
          y={pick.y}
          alignRight
          label="Merge into"
          search="Filter branches"
          items={others.map((b) => ({ id: b, label: <span className="mono">{b}</span>, text: b, icon: b === base ? "check" : undefined, hint: b === defaultBase ? "its base" : undefined, run: () => setBase(b) }))}
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
        {base} catches up with origin first. {stay ? "" : `Then switches to ${base}. `}Uncommitted changes where {base} is checked out stay, unless the merge changes those files{opts.rebase ? `; where ${branch} is checked out, it must have none` : ""}.
        {opts.resolveConflicts
          ? "Conflicts are resolved with AI, which can take a few minutes; if it can't, nothing changes."
          : `Nothing changes when the merge would conflict: rebase onto ${base} and resolve first.`}
      </p>
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
  // Cancelling brings the merge options back; once the work is committed or discarded, the merge runs.
  if (asking) return <WipModal pid={pid} branch={branch} files={wip} op="Merge" onClose={() => setAsking(false)} onClean={() => { setAsking(false); run(); }} />;
  if (inline) return <div className="ag-finish">{body}<div className="ag-finish-foot">{footer}</div></div>;
  return (
    <Modal title="Merge branch" sub={<span className="mono">{branch} → {base}</span>} onClose={onClose} footer={footer}>
      {body}
    </Modal>
  );
}

/** Before merging a branch, or deleting its worktree to continue on it, with uncommitted changes: stage all & commit them, or discard them. `onClean` runs once that is done. */
function WipModal({ pid, branch, files, op, onClose, onClean }: { pid: string; branch: string; files: number; op: "Merge" | "Continue"; onClose: () => void; onClean: () => void }) {
  const [summary, setSummary] = useState("");
  const [confirming, setConfirming] = useState(false);
  const aiOn = useAiOn("commit");
  const inv = [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid]];
  const commit = useAction<{ sha: string; message: string; aiWritten: boolean }>("workspace.commit", {
    invalidate: inv,
    success: (r) => `${r.aiWritten ? "AI wrote: " : "Committed: "}${r.message.split("\n")[0]}`,
  });
  const discard = useAction("workspace.discard", { invalidate: inv, success: "Changes discarded" });
  const busy = commit.isPending || discard.isPending;
  const error = commit.error ?? discard.error;
  const stageAndCommit = () => commit.mutateAsync({ projectId: pid, branch, message: summary.trim(), all: true }).then(onClean, () => {});
  // Unstaged edits first (back to what is staged, untracked files deleted), then the staged ones (back to the last commit).
  const throwAway = () =>
    discard
      .mutateAsync({ projectId: pid, branch, staged: false, paths: [] })
      .then(() => discard.mutateAsync({ projectId: pid, branch, staged: true, paths: [] }))
      .then(onClean, () => {});
  // Replaces this modal rather than stacking on it: one Escape would close both. Back keeps the typed summary.
  if (confirming)
    return (
      <Confirm
        title="Discard uncommitted changes"
        sub={<span className="mono">{branch} · {plural(files, "file")}</span>}
        action={`Discard & ${op}`}
        busy={discard.isPending}
        onBack={() => setConfirming(false)}
        onConfirm={throwAway}
      >
        Every uncommitted change on <span className="mono">{branch}</span> is thrown away, untracked files included, then {op === "Merge" ? "the merge starts" : "the worktree is deleted"}.
      </Confirm>
    );
  return (
    <Modal
      title="Uncommitted changes"
      sub={<span className="mono">{branch} · {plural(files, "file")}</span>}
      width={520}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <button className="btn btn-md btn-danger" disabled={busy} data-tip={`Throw away every uncommitted change on ${branch}, then ${op.toLowerCase()}`} onClick={() => setConfirming(true)}>
            Discard & {op}
          </button>
          <button className="btn btn-md btn-primary" disabled={busy || (!aiOn && !summary.trim())} data-tip={`Commit every change on ${branch}, then ${op.toLowerCase()}`} onClick={stageAndCommit}>
            {commit.isPending && <span className="spinner" />}
            Stage all, Commit & {op}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        <span className="mono">{branch}</span> has uncommitted changes {op === "Merge" ? "the merge would leave out" : "in the worktree about to be deleted"}. Commit them all first, or discard them;{" "}
        {op === "Merge" ? "the merge starts" : "the worktree is deleted"} once that is done.
      </p>
      <input
        className="input"
        style={{ height: 32, fontSize: 12.5, padding: "0 10px" }}
        placeholder={aiOn ? "Commit summary — leave empty for AI" : "Commit summary"}
        aria-label="Commit summary"
        value={summary}
        disabled={busy}
        onChange={(e) => setSummary(e.target.value)}
      />
      <p className="c-warn" style={{ margin: 0, lineHeight: 1.55 }}>Discarding deletes untracked files too. This cannot be undone.</p>
      {error && <ErrorBox error={error} />}
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
  const push = useAction("workspace.push", {
    invalidate: [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid]],
    patch: (qc) => patchOverview(qc, pid, branch, (b) => pushed(b, true)),
    success: `Force pushed ${branch}`,
  });
  return (
    <Modal
      title="Force push"
      sub={<span className="mono">{branch}</span>}
      onClose={onClose}
      footer={
        <>
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
          ? <> They were on {branch} before it was rewritten (rebased or reset), so nothing you haven't seen is lost.</>
          : <> Some were never on {branch}: someone else may have pushed them. Git refuses those, so pull or reset first.</>}
      </p>
      {push.error && <ErrorBox error={push.error} />}
    </Modal>
  );
}

/** Rename a branch, on origin too for everyone by default; an open release gets a new version instead. */
function RenameBranchModal({ pid, view, onClose, onRenamed }: { pid: string; view: BranchView; onClose: () => void; onRenamed: (to: string) => void }) {
  const release = view.role === "release" ? view.release : null;
  const [name, setName] = useState(release ?? view.name);
  // Origin-only branches can only be renamed there.
  const [alsoOrigin, setAlsoOrigin] = useState(true);
  const onOrigin = view.remote && (!view.local || alsoOrigin);
  const to = release ? `release/${name.trim().replace(/^v/, "")}` : name.trim();
  const rename = useAction<RenameResult, { projectId: string; branch: string; name: string; remote: boolean }>("branches.rename", {
    invalidate: [["overview", pid], ["files", pid], ["commits", pid], ["worktrees"], ["agents"]],
    success: (r) => `Renamed ${view.name} to ${to}${r.changelog ? ". CHANGELOG.md updated in a commit: push it to share it" : ""}`,
  });
  const submit = () =>
    to !== view.name &&
    name.trim() &&
    rename.mutate({ projectId: pid, branch: view.name, name: to, remote: onOrigin }, {
      onSuccess: (r) => {
        if (r.changelogError) toast(`Renamed, but committing CHANGELOG.md failed: ${r.changelogError}`, "error");
        onRenamed(to);
        onClose();
      },
    });
  return (
    <Modal
      title={release ? "Rename release" : "Rename branch"}
      sub={<span className="mono">{view.name}</span>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md btn-primary" disabled={!name.trim() || to === view.name || rename.isPending} onClick={submit}>
            {rename.isPending && <span className="spinner" />}
            Rename
          </button>
        </>
      }
    >
      <form className="col" style={{ gap: 14 }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="field">
          <label htmlFor="rename-to">{release ? "Version" : "New name"}</label>
          <input id="rename-to" className="input mono" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <p style={{ margin: 0, lineHeight: 1.55 }}>
          {release && <>The branch becomes <span className="mono">{to}</span>, and the branches and tickets planned in {release} move to it. A CHANGELOG.md section for {release} is renamed in a commit. </>}
          {onOrigin ? (
            <>Renamed on origin for everyone: they see <span className="mono">{to}</span> on their next fetch. On GitHub, open pull requests follow it.</>
          ) : view.remote ? (
            <><span className="mono">origin/{view.name}</span> keeps its name.</>
          ) : (
            "Not on origin: renamed here only."
          )}
        </p>
        {view.local && view.remote && (
          <label className="check">
            <input type="checkbox" checked={alsoOrigin} onChange={() => setAlsoOrigin(!alsoOrigin)} />
            <span>Also rename it on origin, for everyone</span>
          </label>
        )}
      </form>
      {rename.error && <ErrorBox error={rename.error} />}
    </Modal>
  );
}

/** Pick any branch for `branch` to merge into: not itself, its current base, or a branch below it. */
export function TargetBranchModal({
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
    return branches.filter((b) => b.exists && b.name !== branch && b.name !== base && !below(b.name));
  }, [branches, branch, base]);
  const submit = () => picked && move.mutate({ projectId: pid, branch, parent: picked }, { onSuccess: () => onTargeted(picked) });
  return (
    <Modal
      title="Target a specific branch"
      sub={<><span className="mono">{labelOf(branch)}</span> merges into it from now on</>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md btn-primary" disabled={!picked || move.isPending} onClick={submit}>
            {move.isPending && <span className="spinner" />}
            Target {picked ? labelOf(picked) : "it"}
          </button>
        </>
      }
    >
      <BranchPicker choices={choices} labelOf={labelOf} picked={picked} onPick={setPicked} />
      {move.error && <ErrorBox error={move.error} />}
    </Modal>
  );
}

/** Filterable radio list of branches: trunks first, then releases, then the rest by name. */
function BranchPicker({ choices, labelOf, picked, onPick }: { choices: BranchView[]; labelOf: (b: string) => string; picked: string | null; onPick: (b: string) => void }) {
  const [query, setQuery] = useState("");
  const sorted = useMemo(() => {
    const rank = (b: BranchView) => (b.role === "trunk" ? 0 : b.role === "release" ? 1 : 2);
    return [...choices].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [choices]);
  const q = query.trim().toLowerCase();
  const shown = q ? sorted.filter((b) => b.name.toLowerCase().includes(q) || labelOf(b.name).toLowerCase().includes(q)) : sorted;
  return (
    <>
      <input className="input" placeholder="Filter branches" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul className="col" style={{ margin: 0, padding: 0, listStyle: "none", gap: 4, maxHeight: 320, overflowY: "auto" }}>
        {shown.map((b) => (
          <li key={b.name}>
            <label className="check">
              <input type="radio" name="branch" checked={picked === b.name} onChange={() => onPick(b.name)} />
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
    </>
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

/** Replays the checked-out `branch` on top of `onto`, or of a branch picked here; its target stays. */
function RebaseOntoBranchModal({ pid, branch, onto, branches, labelOf, onClose }: { pid: string; branch: string; onto?: string; branches: BranchView[]; labelOf: (b: string) => string; onClose: () => void }) {
  const [picked, setPicked] = useState<string | null>(onto ?? null);
  const rebase = useAction<RebaseResult, { projectId: string; branch: string; onto: string }>("workspace.rebase", {
    invalidate: [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid]],
    success: rebaseMessage,
  });
  const choices = useMemo(() => branches.filter((b) => b.exists && b.name !== branch), [branches, branch]);
  const parent = branches.find((b) => b.name === branch)?.parent;
  const name = labelOf(branch);
  const to = picked ? labelOf(picked) : undefined;
  return (
    <Modal
      title={onto ? `Rebase onto ${labelOf(onto)}?` : "Rebase onto a specific branch"}
      sub={<><span className="mono">{name}</span> is checked out</>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md btn-primary" autoFocus={!!onto} disabled={!picked || rebase.isPending} onClick={() => picked && rebase.mutate({ projectId: pid, branch, onto: picked }, { onSuccess: onClose })}>
            {rebase.isPending && <span className="spinner" />}
            Rebase {name} onto {to ?? "it"}
          </button>
        </>
      }
    >
      {!onto && <BranchPicker choices={choices} labelOf={labelOf} picked={picked} onPick={setPicked} />}
      <p className="muted" style={{ margin: 0 }}>
        Replays the commits of {name} on top of {to ?? "the branch picked"}.{parent && <> {name} keeps targeting {labelOf(parent)}.</>} Already pushed: it then needs a force push.
      </p>
      {rebase.error && <ErrorBox error={rebase.error} />}
    </Modal>
  );
}

/** Confirms "Cancel and Delete all" for a worktree's branch. */
export function DiscardWorktreeModal({ branch, path, onClose, onConfirm }: { branch: string; path: string; onClose: () => void; onConfirm: () => void }) {
  return (
    <Modal
      title="Delete worktree and branch"
      sub={<span className="mono">{branch}</span>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md btn-danger" onClick={() => { onConfirm(); onClose(); }}>Cancel and Delete all</button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        The agent stops and the worktree at <span className="mono">{path}</span> is deleted with its uncommitted changes, then the local branch <span className="mono">{branch}</span>, even unmerged. The branch on origin is kept.
      </p>
    </Modal>
  );
}

/** Confirms checking a worktree's branch out here, which deletes the worktree. */
function AbortSwitchModal({ op, branch, path, onClose, onConfirm }: { op: string; branch: string; path: string; onClose: () => void; onConfirm: () => void }) {
  return (
    <Modal
      title={`Abort the ${op}?`}
      sub={<span className="mono">{branch}</span>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md btn-danger" onClick={() => { onConfirm(); onClose(); }}>Abort {op} and switch</button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        The checkout at <span className="mono">{path}</span> is stopped in the middle of a {op}, so git can't switch to <span className="mono">{branch}</span>.
        Aborting puts it back as it was before the {op}, then switches. <span className="c-warn">Every change made to its files since the {op} started is lost, conflict fixes included.</span>
      </p>
    </Modal>
  );
}

function SwitchWipModal({ from, branch, onClose, onConfirm }: { from?: string | null; branch: string; onClose: () => void; onConfirm: (wip: "stash" | "carry") => void }) {
  const pick = (wip: "stash" | "carry") => {
    onConfirm(wip);
    onClose();
  };
  return (
    <Modal
      title="Uncommitted changes in the way"
      sub={<span className="mono">{branch}</span>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" onClick={() => pick("stash")}>Stash and switch</button>
          <button className="btn btn-md btn-primary" onClick={() => pick("carry")}>Bring them along</button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        Some files you changed {from ? <>on <span className="mono">{from}</span> </> : ""}are also different on <span className="mono">{branch}</span>, so git can't switch with your changes as they are.
      </p>
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        <b>Bring them along</b>: they're stashed, then put back on <span className="mono">{branch}</span>. If they clash with its version, you resolve the conflicts and the stash stays until then.
      </p>
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        <b>Stash and switch</b>: they wait in a stash{from ? <> made on <span className="mono">{from}</span></> : ""}, and <span className="mono">{branch}</span> opens clean. Pop it when you're back.
      </p>
    </Modal>
  );
}

function PullWipModal({ branch, upstream, onClose, onConfirm }: { branch: string; upstream?: string | null; onClose: () => void; onConfirm: (wip: "stash" | "carry") => void }) {
  const pick = (wip: "stash" | "carry") => {
    onConfirm(wip);
    onClose();
  };
  const from = upstream ? <span className="mono">{upstream}</span> : "origin";
  return (
    <Modal
      title="Uncommitted changes in the way"
      sub={<span className="mono">{branch}</span>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" onClick={() => pick("stash")}>Stash and pull</button>
          <button className="btn btn-md btn-primary" onClick={() => pick("carry")}>Pull and keep them</button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        Some files you changed on <span className="mono">{branch}</span> are also changed on {from}, so git can't pull with your changes as they are.
      </p>
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        <b>Pull and keep them</b>: they're stashed, <span className="mono">{branch}</span> is pulled, then they're put back. If they clash with what came in, you resolve the conflicts and the stash stays until then.
      </p>
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        <b>Stash and pull</b>: they wait in a stash, and <span className="mono">{branch}</span> is pulled clean. Pop it when you're ready.
      </p>
    </Modal>
  );
}

function ContinueOnBranchModal({ branch, path, onClose, onConfirm }: { branch: string; path: string; onClose: () => void; onConfirm: () => void }) {
  return (
    <Modal
      title="Continue on branch"
      sub={<span className="mono">{branch}</span>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md btn-primary" onClick={() => { onConfirm(); onClose(); }}>Delete worktree and switch</button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        The agent stops and the worktree at <span className="mono">{path}</span> is deleted, then <span className="mono">{branch}</span> is checked out here with all its commits. Uncommitted changes there get committed or discarded first: you pick.
      </p>
      <div className="col" style={{ gap: 6 }}>
        <h2 className="label">Tip!</h2>
        <p style={{ margin: 0, lineHeight: 1.55 }}>
          To keep working on it without switching, select <span className="mono">{branch}</span> in the tree: its changes show here and its agent runs in the panel below, where you can keep asking it for changes.
        </p>
      </div>
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
}: {
  pid: string;
  branch: string;
  base: string;
  local: boolean;
  /** Exists on origin. */
  remote: boolean;
  worktree?: string;
  onClose: () => void;
}) {
  const [force, setForce] = useState(false);
  // Origin-only branches can only go from origin; otherwise origin keeps its copy unless the project's settings or the user ask.
  const [alsoOrigin, setAlsoOrigin] = useState(useProjectPrefs(pid).dialogs.deleteOrigin);
  const onOrigin = remote && (!local || alsoOrigin);
  const exists = local || remote;
  const nav = useNav();
  // In the background: the dialog closes and the row leaves the tree at once, unless origin keeps a copy (it stays, busy).
  const del = () => {
    onClose();
    nav.forgetBranches(pid, [branch]);
    void runTask({
      label: `Deleting ${branch}…`,
      hide: remote && !onOrigin ? [] : [branchKey(pid, branch)],
      invalidate: [["overview", pid], ["files", pid], ["worktrees"]],
      run: async () => {
        await call("branches.delete", { projectId: pid, branch, force, remote: onOrigin });
        await droppedBranch(queryClient, pid, branch, onOrigin);
      },
      done: () => `Deleted ${branch}`,
    });
  };
  return (
    <Modal
      title="Delete branch"
      sub={<span className="mono">{branch}</span>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md btn-danger" onClick={del}>
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

/** Confirm deleting branches whose work is kept elsewhere (merged children, shipped releases); the delete itself runs in the background. */
function CleanupModal({
  title,
  sub,
  note,
  branches,
  onClose,
  onConfirm,
}: {
  title: string;
  sub: ReactNode;
  /** Why deleting them loses nothing. */
  note: ReactNode;
  branches: BranchView[];
  onClose: () => void;
  onConfirm: (branches: string[]) => void;
}) {
  return (
    <Modal
      title={title}
      sub={sub}
      onClose={onClose}
      footer={
        <>
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
        {note} They are deleted locally and on origin, and worktrees they have go too.
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
  pid,
  base,
  branches,
  onClose,
  onConfirm,
}: {
  pid: string;
  base: string;
  branches: BranchView[];
  onClose: () => void;
  onConfirm: (branches: string[], remote: boolean) => void;
}) {
  // Nothing is picked up front: these hold work that isn't merged anywhere.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [remote, setRemote] = useState(useProjectPrefs(pid).dialogs.cleanupOrigin);
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
    // The WIP list, badge and push count follow the commit at once instead of waiting for the full overview.
    patch: (qc, v) => {
      patchWip(qc, pid, v.branch, (l) => (v.all ? [] : l.filter((f) => !f.staged)));
      patchOverview(qc, pid, v.branch, committed);
    },
    success: (r) => `${r.aiWritten ? "AI wrote: " : "Committed: "}${r.message.split("\n")[0]}`,
  });
  const draft = useAction<{ message: string }>("workspace.commitMessage");
  const nav = useNav();
  // Saved with the project, like the merge options.
  const { commit: prefs, setCommit } = useProjectPrefs(pid);
  const autoPush = prefs.autoPush;
  const push = useAction<unknown, { projectId: string; branch: string }>("workspace.push", { invalidate: inv, patch: (qc, v) => patchOverview(qc, pid, v.branch, pushed), success: `Pushed ${branch}` });
  // Per branch, from the shared cache: a commit running on another worktree doesn't block this one.
  const busy = [...usePendingBranches("workspace.commit", pid), ...usePendingBranches("workspace.push", pid)].includes(branch);
  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  const canCommit = canType && !orphanBody && !busy;
  // mutateAsync, not mutate callbacks: those are dropped if the user switches branch before the commit ends.
  const doCommit = () => commit.mutateAsync({ projectId: pid, branch, message, all }).then(() => { clear(); if (autoPush) push.mutate({ projectId: pid, branch }); }, () => {});
  // Ctrl/⌘+Enter in the message commits, like most editors' "submit".
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canCommit) {
      e.preventDefault();
      doCommit();
    }
  };
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
          onKeyDown={onKey}
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
          onKeyDown={onKey}
        />
      </div>}
      <span className="split-btn" style={{ display: "flex", width: "100%" }}>
        <button className="btn btn-primary split-main commit-btn" style={{ flex: "1 1 auto" }} disabled={!canCommit}
          title={orphanBody ? "Add a summary to go with the description" : open ? "Commit (Ctrl+Enter in the message)" : undefined}
          onClick={doCommit}>
          <Busy on={busy}><Icon name="sparkle" size={12} /></Busy>
          <span>{all ? "Stage all & Commit" : "Commit"}<span style={{ fontWeight: 400, opacity: 0.75, marginLeft: 6 }}>{all ? changed || null : staged}</span></span>
        </button>
        <button
          className="btn btn-primary btn-icon split-more commit-btn"
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

/** The agent of the selected branch, or the shell of its checkout (`cwd`). Several agents at once are managed on the Worktrees & agents page. */
function Terminal({ pid, branch, cwd, worktree, open, setOpen, onCloseWorktree, finish }: { pid: string; branch?: string; cwd?: string; worktree: boolean; open: boolean; setOpen: (b: boolean) => void; onCloseWorktree: (s: AgentSession) => void; finish: FinishHandlers }) {
  const hidden = useHidden();
  // A session being cleared, or whose worktree is being deleted, is gone already.
  const cur = useAgents((l) => l.find((a) => a.projectId === pid && a.branch === branch && !hidden.has(agentKey(a.id)) && !hidden.has(wtKey(a.cwd)))).data;
  // Its worktree is being deleted (merged, closed): nothing new starts there meanwhile.
  const leaving = worktree && !!cwd && hidden.has(wtKey(cwd));
  const curBranch = useOverview(pid).data?.branches.find((b) => b.name === cur?.branch);
  const { text, setText, files, setFiles } = useDraft(`${pid}:${branch ?? ""}`);
  const [picks, setPicks] = useState<Choice[]>([]);
  const [pick, setPick] = useAgentPick(pid);
  // Starting on a branch makes its worktree and may move the main checkout off it.
  const start = useAction<{ id: string }>("agents.start", { invalidate: [["agents"], ["worktrees"], ["overview", pid]] });
  const message = useAction("agents.message", { invalidate: [["agents"]] });
  const configure = useAction("agents.configure", { invalidate: [["agents"]] });
  const stop = useAction("agents.stop", { invalidate: [["agents"]] });
  const height = usePaneWidth("gnx.pane.term", 248, 120, 900);
  const [view, setView] = useTermView(pid, branch, !!cur, worktree);
  const shell = view === "shell";
  // Maximized, the terminal takes the branch tree's place in its column.
  const [max, setMax] = useState(false);
  const [clearing, setClearing] = useState<AgentSession | null>(null);

  if (!open) {
    return (
      <button className="row term-bar" style={{ height: 37, flex: "0 0 37px", margin: 0, padding: "0 14px 3px", border: 0, borderTop: "1px solid var(--line)", background: "var(--panel)", color: "var(--muted)", textAlign: "left" }} onClick={() => setOpen(true)}>
        <Icon name="terminal" />
        <span>{shell ? "Shell" : cur ? `Agent · ${shownStatus(cur, curBranch)}` : "Agent"}</span>
        {!shell && cur?.status === "running" && <span className="pulse" />}
        <span className="grow" />
        <Icon name="chevronUp" size={13} />
      </button>
    );
  }
  const busy = cur?.status === "running" || cur?.status === "paused";
  // Stopping drops what was queued for the run's end: it comes back to the prompt box.
  const halt = (s: AgentSession) => stop.mutate({ id: s.id }, { onSuccess: () => setText((t) => [...s.queued, t].filter(Boolean).join("\n\n")) });
  const send = (up: Upload[], t: string) => {
    if (!t && !up.length) return;
    const done = {
      onSuccess: () => {
        setText("");
        setFiles([]);
        setPicks([]);
      },
    };
    if (cur) message.mutate({ id: cur.id, text: t, files: up }, done);
    else start.mutate({ projectId: pid, branch, request: t, files: up, ...pick }, done);
  };
  return (
    <>
      {!max && <Resizer pane={height} label="Resize agents panel" top />}
      <div className={max ? "term term-max" : "term"} style={{ "--term-h": `${height.width}px` } as CSSProperties}>
        {/* Empty parts of the bar collapse it, like the closed bar opens it. */}
        <div className="term-tabs term-bar" style={{ cursor: "pointer" }} onClick={(e) => !(e.target as HTMLElement).closest("button, select, input") && setOpen(false)}>
          {/* Only the right side grows, so the session label sits left, after the tabs. */}
          <div className="term-side" style={{ flex: "none" }}>
            <TermTabs value={view} onChange={setView} path={cwd} />
          </div>
          {!shell && cur && (
            <>
              <span className="term-tab" style={{ fontSize: 11.5, borderLeft: 0 }}>
                {cur.status === "running" && <span className="pulse" />}
                <span className="mono">{cur.branch}</span>
                <span className="faint">{cur.worktree ? "worktree" : "main checkout"}</span>
              </span>
              <button className="term-tab term-tab-x" aria-label={`Close ${cur.branch} session`} onClick={() => (cur.worktree ? onCloseWorktree(cur) : setClearing(cur))}>
                <Icon name="close" size={11} />
              </button>
            </>
          )}
          <div className="term-side" style={{ justifyContent: "flex-end" }}>
            {!shell && cur && !cur.ai && <span className="row faint hide-narrow" style={{ padding: "0 10px", fontSize: 11.5, whiteSpace: "nowrap" }}>{cur.agentLabel}</span>}
            <button className="btn btn-ghost" style={{ width: 36, height: "auto", border: 0, borderLeft: "1px solid var(--line)", borderRadius: 0 }} aria-label={max ? "Restore terminal size" : "Expand terminal"} aria-pressed={max} data-tip={max ? "Restore" : "Expand"} onClick={() => setMax(!max)}>
              <Icon name={max ? "minimize" : "maximize"} size={13} />
            </button>
            <button className="btn btn-ghost term-collapse" style={{ width: 36, height: "auto", border: 0, borderLeft: "1px solid var(--line)", borderRadius: 0 }} aria-label="Collapse agents" onClick={() => setOpen(false)}>
              <Icon name="chevronDown" size={13} />
            </button>
          </div>
        </div>
        {shell ? (
          <ShellPane projectId={pid} path={cwd} />
        ) : (
          <>
            <AgentLog
              lines={cur?.lines ?? []}
              session={cur?.id}
              projectId={pid}
              provider={cur ? cur.ai?.provider : pick.provider}
              thinking={cur?.status === "running" || start.isPending || message.isPending}
              queued={cur?.queued}
              actions={
                cur?.worktree && <FinishWorktreeCard session={cur} finish={finish} />
              }
              picks={picks}
              onPicks={setPicks}
              empty={
                cur
                  ? undefined
                  : leaving
                    ? "Deleting this worktree…"
                    : branch
                      ? `Start an agent on ${branch}: it gets its own worktree, so it keeps working while you switch branches.`
                      : "Start an agent on the main checkout: describe what it should do below."
              }
            />
            <AgentInput
              id="ag-ask"
              label="Ask the agent"
              value={text}
              onChange={setText}
              files={files}
              onFiles={setFiles}
              picks={picks}
              onPicks={setPicks}
              onSend={send}
              onStop={busy && cur ? () => halt(cur) : undefined}
              log={cur?.lines}
              disabled={leaving}
              pending={start.isPending || message.isPending}
              picker={!cur ? <AgentPicker value={pick} onChange={setPick} compact /> : cur.ai && <AgentPicker value={cur.ai} onChange={(p) => configure.mutate({ id: cur.id, ...p })} compact />}
              placeholder={busy ? "Agent is working… a message now waits for it to finish" : cur ? "Reply to the agent…" : "Ask the agent anything…"}
            />
          </>
        )}
      </div>
      {clearing && (
        <Confirm
          title="Clear agent session"
          sub={<span className="mono">{clearing.branch}</span>}
          action="Clear session"
          onBack={() => setClearing(null)}
          onConfirm={() => {
            clearSession(clearing);
            setClearing(null);
          }}
        >
          The agent stops if it is working, and its conversation is deleted.
        </Confirm>
      )}
    </>
  );
}

/** Deletes agent session `a` in the background: its row and log go at once, and come back if that fails. */
export function clearSession(a: AgentSession) {
  void runTask({
    label: `Clearing the session on ${a.branch}…`,
    hide: [agentKey(a.id)],
    invalidate: [["agents"], ["worktrees"]],
    run: async () => {
      await call("agents.remove", { id: a.id });
      await settle(queryClient, [["agents"]], () => queryClient.setQueryData<AgentSession[]>(["agents"], (l) => l?.filter((x) => x.id !== a.id)));
    },
    done: () => `Cleared the session on ${a.branch}`,
  });
}

/** The worktree a session runs in; a worktree without an agent closes the same way. */
type WtSession = Pick<AgentSession, "projectId" | "branch" | "cwd">;
/** How a worktree session ends; each gets the session and whether to switch to where the code lands. */
type FinishHandlers = { discard: (s: WtSession) => void; continue: (s: WtSession, sw: boolean) => void; merge: (s: WtSession, sw: boolean, into?: string) => void };

/** `continueOn` deletes the worktree and checks its branch out; `openMerge` shows the merge options (into `into`, else the base) for a merge that deletes worktree `cwd` once done.
 * Each runs in the background, the worktree's row going at once. `modal` asks to commit or discard uncommitted changes before a continue: render it. */
export function useFinishHandlers(
  pid: string,
  continueOn: (branch: string, path: string) => void,
  openMerge: (branch: string, cwd: string, stay: boolean, into?: string) => void,
): FinishHandlers & { modal: ReactNode } {
  const branches = useOverview(pid).data?.branches;
  // Deleting the worktree is refused with uncommitted changes there.
  const [dirty, setDirty] = useState<{ s: WtSession; sw: boolean; files: number } | null>(null);
  const keepOn = (s: WtSession, sw: boolean) => (sw ? continueOn(s.branch, s.cwd) : drop(s));
  // Removing the worktree also removes its agent session. `branch` only marks the row busy.
  const drop = (s: WtSession) =>
    void runTask({
      label: `Deleting the worktree of ${s.branch}…`,
      hide: [wtKey(s.cwd)],
      invalidate: [["agents"], ["worktrees"], ["overview", s.projectId]],
      run: async () => {
        await call("worktrees.remove", { projectId: s.projectId, branch: s.branch, path: s.cwd });
        await droppedWorktree(queryClient, s.projectId, s.branch, s.cwd);
      },
      done: () => `Deleted the worktree of ${s.branch}`,
    });
  const nav = useNav();
  return {
    // Throws the session's work away: the worktree even with uncommitted changes, then its local branch even unmerged
    // (origin's copy stays, and so does its row).
    discard: (s) => {
      const gone = !branches?.find((b) => b.name === s.branch)?.remote;
      nav.forgetBranches(s.projectId, [s.branch]);
      void runTask({
        label: `Deleting ${s.branch} and its worktree…`,
        hide: [wtKey(s.cwd), ...(gone ? [branchKey(s.projectId, s.branch)] : [])],
        invalidate: [["agents"], ["worktrees"], ["overview", s.projectId], ["commits", s.projectId]],
        run: async () => {
          await call("worktrees.remove", { projectId: s.projectId, branch: s.branch, path: s.cwd, force: true });
          await droppedWorktree(queryClient, s.projectId, s.branch, s.cwd);
          await call("branches.delete", { projectId: s.projectId, branch: s.branch, force: true }).catch((e: Error) => {
            throw new Error(`Worktree deleted, but deleting ${s.branch} failed: ${e.message}`);
          });
          await droppedBranch(queryClient, s.projectId, s.branch, false);
        },
        done: () => `Deleted ${s.branch} and its worktree`,
      });
    },
    continue: (s, sw) => {
      const files = branches?.find((b) => b.name === s.branch)?.wip ?? 0;
      if (files) setDirty({ s, sw, files });
      else keepOn(s, sw);
    },
    merge: (s, sw, into) => openMerge(s.branch, s.cwd, !sw, into),
    modal: dirty && (
      <WipModal pid={dirty.s.projectId} branch={dirty.s.branch} files={dirty.files} op="Continue" onClose={() => setDirty(null)} onClean={() => { setDirty(null); keepOn(dirty.s, dirty.sw); }} />
    ),
  };
}

/** Ends a worktree session: the agent stops and the worktree goes, its branch either kept to continue on or merged first. `inline` shows it in the agent chat instead of a modal. */
function CloseWorktreeModal({ session: s, finish, onClose, inline }: { session: WtSession; finish: FinishHandlers; onClose: () => void; inline?: boolean }) {
  const { dialogs } = useProjectPrefs(s.projectId);
  const [chosen, setThen] = useState(dialogs.finish);
  const [sw, setSw] = useState(dialogs.finishSwitch);
  const [discarding, setDiscarding] = useState(false);
  const branches = useOverview(s.projectId).data?.branches ?? [];
  const b = branches.find((x) => x.name === s.branch);
  const base = b?.parent ?? "";
  // Nothing committed or edited (the agent only answered or asked): nothing to merge, only closing.
  const empty = !!b && !b.ahead && !b.wip;
  const then = empty ? "continue" : chosen;
  const others = mergeTargets(branches, s.branch);
  const [into, setInto] = useState<string | undefined>();
  const [pick, setPick] = useState<{ x: number; y: number } | null>(null);
  const target = into ?? base;
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
      {empty ? (
        <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>Nothing to merge: no commits or changes on <span className="mono">{s.branch}</span>.</p>
      ) : (
        <>
          <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>Uncommitted changes in it get committed or discarded first: you pick.</p>
          <Seg
            grid
            label="Then"
            value={then}
            onChange={setThen}
            options={[{ value: "continue", label: "Continue on branch" }, { value: "merge", label: "Merge it" }]}
          />
        </>
      )}
      <label className="check">
        <input type="checkbox" checked={sw} onChange={() => setSw(!sw)} />
        <span>Switch to {then === "merge" ? "the branch it merges into" : <span className="mono">{s.branch}</span>}</span>
      </label>
    </>
  );
  const buttons = (
    <>
      <button type="button" className="btn btn-md btn-danger" style={{ flex: "1 1 0" }} data-tip={`Delete the worktree, its uncommitted changes and the local ${s.branch} branch`} onClick={() => setDiscarding(true)}>Cancel and Delete all</button>
      {/* Each button takes half the footer. */}
      <span className="split-btn" style={{ display: "flex", flex: "1 1 0" }}>
        <button type="button" className={`btn btn-md btn-primary${then === "merge" ? " split-main" : ""}`} style={{ flex: "1 1 auto" }} onClick={() => { finish[then](s, sw, into); onClose(); }}>
          {then === "merge" && target ? `Finish and merge into ${target}…` : `Finish with the agent / worktree${then === "merge" ? "…" : ""}`}
        </button>
        {then === "merge" && (
          <button
            type="button"
            className="btn btn-primary btn-md btn-icon split-more"
            aria-label="Merge into another branch"
            data-tip="Merge into another branch"
            aria-haspopup="menu"
            disabled={!others.length}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setPick({ x: r.right, y: r.bottom + 2 });
            }}
          >
            <Icon name="chevronDown" size={16} />
          </button>
        )}
      </span>
      {pick && (
        <ContextMenu
          x={pick.x}
          y={pick.y}
          alignRight
          label="Merge into"
          search="Filter branches"
          items={others.map((b) => ({ id: b, label: <span className="mono">{b}</span>, text: b, icon: b === target ? "check" : undefined, hint: b === base ? "its base" : undefined, run: () => setInto(b) }))}
          onClose={() => setPick(null)}
        />
      )}
    </>
  );
  // Cancelling the confirmation brings these close options back.
  if (discarding) return <DiscardWorktreeModal branch={s.branch} path={s.cwd} onClose={() => setDiscarding(false)} onConfirm={() => { finish.discard(s); onClose(); }} />;
  if (inline) return <div className="ag-finish">{body}<div className="ag-finish-foot">{buttons}</div></div>;
  return (
    <Modal title="Close worktree session" sub={<span className="mono">{s.branch}</span>} width={520} onClose={onClose} footer={buttons}>
      {body}
    </Modal>
  );
}

/** Under the agent's last reply: the close options for the worktree, a click away. */
export function FinishWorktreeCard({ session: s, finish }: { session: WtSession; finish: FinishHandlers }) {
  const branches = useOverview(s.projectId).data?.branches;
  const aiOn = useAiOn("commit");
  const wip = (branches?.find((x) => x.name === s.branch)?.wip ?? 0) > 0;
  // The session is done: the AI commit message a merge or commit here would wait seconds for gets written meanwhile.
  useEffect(() => {
    if (aiOn && wip) rpc("workspace.prepareCommitMessage", { projectId: s.projectId, branch: s.branch }).catch(() => {});
  }, [aiOn, wip, s.projectId, s.branch]);
  if (!branches) return null;
  // Not in the overview: no base to merge into.
  if (!branches.some((x) => x.name === s.branch)) return null;
  return <CloseWorktreeModal session={s} finish={finish} onClose={() => {}} inline />;
}

function ShipModal({ pid, release, defaultBranch, onClose }: { pid: string; release: ReleaseView; defaultBranch: string; onClose: () => void }) {
  const prefs = useProjectPrefs(pid).dialogs;
  const [push, setPush] = useState(prefs.shipPush);
  const hasChangelog = !!useOverview(pid).data?.hasChangelog;
  // Same gate as "Update changelog" in the branch menu.
  const canChangelog = useAiOn("release") && hasChangelog;
  const [updateLog, setUpdateLog] = useState(prefs.shipChangelog);
  const changelog = useAction<{ message: string }, { projectId: string; branch: string }>("changelog.update", { invalidate: [["overview", pid], ["commits", pid]], success: (r) => r.message });
  const ship = useAction<{ tag: string }>("releases.ship", { invalidate: [["overview", pid], ["projects"]], success: (r) => `Shipped ${r.tag}` });
  const shipIt = () => ship.mutate({ projectId: pid, version: release.version, push }, { onSuccess: onClose });
  const busy = changelog.isPending || ship.isPending;
  return (
    <Modal
      title={`Ship v${release.version}`}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn btn-primary btn-md"
            disabled={busy}
            onClick={() => (canChangelog && updateLog ? changelog.mutate({ projectId: pid, branch: release.branch }, { onSuccess: shipIt }) : shipIt())}
          >
            {busy && <span className="spinner" />}
            {changelog.isPending ? "Updating changelog…" : `Ship v${release.version}`}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        Moves <span className="mono">{defaultBranch}</span> to <span className="mono">{release.branch}</span> (fast-forward only) and creates the tag <span className="mono">v{release.version}</span>.
        It stops if {defaultBranch} has commits the release does not.
        {hasChangelog && <> The Unreleased section of CHANGELOG.md becomes v{release.version}, dated today.</>}
      </p>
      {release.items.length > 0 && (
        <div className="note-box">
          Make sure these are merged into {release.branch}: {release.items.map((b) => b.name).join(", ")}.
        </div>
      )}
      {canChangelog && (
        <label className="check">
          <input type="checkbox" checked={updateLog} onChange={() => setUpdateLog(!updateLog)} />
          <span>First let AI add what {release.branch} changes to the changelog</span>
        </label>
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
