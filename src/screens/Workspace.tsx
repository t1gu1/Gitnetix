import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode } from "react";

import {
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
  useBlame,
  useBlobs,
  useDiff,
  useFiles,
  useFilesProgress,
  useOverview,
  usePendingBranches,
  useProjectPrefs,
  useProjects,
  useTagV,
} from "../api/hooks";
import { isLocal, revealPath, rpc } from "../api/transport";
import type { AgentSession, Blobs, BranchView, Commit, FileChange, FileCommit, Hunk, LinePick, MergeResult, Overview, RenameResult, Stash } from "../api/types";
import { AgentInput, AgentLog, type Choice, type Upload } from "../components/AgentLog";
import { AgentPicker, useAgentPick, type AgentPick } from "../components/AgentPicker";
import { Avatar } from "../components/Avatar";
import { DiffView, LargeDiff, type DiffMode, type Staging } from "../components/DiffView";
import { IMAGE_MODES, ImageDiff, comparable, dataUrl, isImage, useImageMode, type ImageMode } from "../components/ImageDiff";
import { PictureSource } from "../components/Picture";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { Resizer, usePaneWidth } from "../components/Resizer";
import { ShellPane, TermTabs, useTermView } from "../components/Shell";
import { Busy, Confirm, ErrorBox, Loading, Markdown, MediaAsk, Modal, Seg, swipeProps } from "../components/ui";
import { ago, plural, timeLeft } from "../lib/format";
import { limitLabel, shownStatus, STATUS_SHOWN, tasksLabel } from "../lib/agentLog";
import { startCleanup, useCleaning } from "../lib/cleanups";
import { useDraft } from "../lib/drafts";
import { useIdle } from "../lib/motion";
import { useNav } from "../lib/nav";
import { showRun, useLocks, useRebasing } from "../lib/rebaseRuns";
import { useStoredChoice, useStoredFlag } from "../lib/stored";
import { agentKey, branchKey, call, runTask, useHidden, wtKey } from "../lib/tasks";
import { copyToClipboard, toast } from "../lib/toast";
import { AbortModal } from "./AbortModal";
import { agentWords, BranchMap, BranchTags, lineageOf, lookItem, originOf, revealBranch, useAgentOf, useMapLayout, type FocusItem } from "./BranchMap";
import { offersRebase, useBranchActions, useCommit, type BranchDialog, type BranchTarget } from "./BranchMenu";
import { DeleteTagModal } from "./CommitMenu";
import { FileHistory } from "./FileHistory";
import { PublishModal } from "./Publish";
import { startRebase } from "./RebaseRun";
import { StashList } from "./StashList";
import { childrenOf, UpdateChildrenModal } from "./UpdateChildren";

type Mode = "branch" | "wip" | "project";
/** On a phone, the focus view shows one at a time: the branch's timeline, or the code with the agent. */
type Pane = "rail" | "code";
const PANES: Pane[] = ["rail", "code"];
/** A file with more changed lines than this waits for "Show anyway" before its diff is even fetched. */
const HUGE_DIFF = 20_000;
/** A tree folder holding more files than this starts closed, and so do the folders inside it. */
const BIG_FOLDER = 200;
/** The flat list draws this many files until "Show all". */
const MAX_ROWS = 1000;

/** Loads the checked-out branch's uncommitted files even while another branch is shown: each refetch keeps its
 *  "WIP n" right (syncWipCount). Draws nothing, so a save redraws nothing else. */
function KeepWipCount({ pid, branch }: { pid: string; branch?: string }) {
  useFiles(pid, branch, "wip");
  return null;
}

export function Workspace() {
  const nav = useNav();
  const pid = nav.projectId!;
  const ov = useOverview(pid);
  const idle = useIdle();
  useAutoFetch(pid, !!ov.data?.remote && !idle);
  const [mode, setMode] = useState<Mode>("wip");
  const [file, setFile] = useState<string | undefined>();
  const [diffMode, setDiffMode] = useState<DiffMode>("unified");
  const [preview, setPreview] = useState(false);
  const [svgCode, setSvgCode] = useState(false);
  const [imageMode, setImageMode] = useImageMode();
  const [termOpen, setTermOpen] = useStoredFlag("gnx.pane.termOpen");
  // The branch map's toolbar renders here, above both the map and the agent panel.
  const [mapBar, setMapBar] = useState<HTMLDivElement | null>(null);
  // The branch map, or the selected branch full screen: its timeline beside its code.
  const [focused, setFocused] = useState(false);
  const [pane, setPane] = useState<Pane>("rail");
  // Which way the narrow layout slides the new pane in; none until the first switch.
  const [slide, setSlide] = useState<{ pane: Pane; dir?: "next" | "prev" }>({ pane });
  if (slide.pane !== pane) setSlide({ pane, dir: PANES.indexOf(pane) > PANES.indexOf(slide.pane) ? "next" : "prev" });
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
  const cleaning = useCleaning(pid);
  // The commit picked in the timeline (none = all the branch's changes).
  const [commit, setCommit] = useState<Commit | undefined>();
  // Stash list in place of the timeline: one branch's ("" = every stash), and the stash picked there.
  const [stashesOf, setStashesOf] = useState<string | null>(null);
  const [stash, setStash] = useState<Stash | undefined>();
  // One file's history in place of the file list (its path), the commit picked there, and one to pick once listed (a blamed line's).
  const [fileLog, setFileLog] = useState<string | null>(null);
  const [logPick, setLogPick] = useState<FileCommit | undefined>();
  const [logWant, setLogWant] = useState<string>();
  // The file the pointer reached the diff of: its blame loads then, not for every file clicked through.
  const [blameFor, setBlameFor] = useState<string>();
  // The focus view's timeline, beside the code.
  const railW = usePaneWidth("gnx.pane.rail", 360, 260, 720);
  const [asTree, setAsTree] = useStoredFlag("gnx.files.tree");
  // Collapse/expand all: a new `n` remounts the file lists, dropping per-folder toggles.
  const [fold, setFold] = useState({ closed: false, n: 0 });
  // The map's files panel: for which branch, WIP, Branch or Project (none = WIP while there is some), and the file open over the map.
  const [mapAt, setMapAt] = useState<{ branch: string; mode?: Mode; file?: string }>({ branch: "" });
  const actions = useBranchActions(pid, (kind, branch, onto) => {
    // Committing everything with no AI to write the message: the branch's uncommitted work, its message box open.
    if (kind === "commit") return openFocus(branch, "wip");
    // A worktree's branch ends the way its worktree session does: delete is "Cancel and Delete all", merge drops the worktree once merged.
    const wt = byName.get(branch)?.worktree;
    if (wt && kind === "merge") finish.merge({ projectId: pid, branch, cwd: wt }, true);
    else setDialog({ kind, branch, onto });
  });
  const finish = useFinishHandlers(pid, actions.continueOn, (branch, cwd, stay, into) => setDialog({ kind: "merge", branch, cwd, stay, into }));
  const rebasing = useRebasing(pid);
  const locks = useLocks(pid);
  // Asked to rebase or resolve, before AI has anything to say.
  const startingRebase = usePendingBranches(["workspace.rebase", "workspace.rebaseContinue"], pid);

  const hidden = useHidden();
  // Branches a background action is deleting leave the map at the click; they come back if it fails.
  const o = useMemo(() => {
    const prefix = branchKey(pid, "");
    return [...hidden].filter((k) => k.startsWith(prefix)).reduce((x, k) => x && deletedOverview(x, k.slice(prefix.length), true), ov.data);
  }, [ov.data, hidden, pid]);
  const byName = useMemo(() => new Map((o?.branches ?? []).map((b) => [b.name, b])), [o]);
  const tagV = useTagV(pid);
  // The map as the focus view's way back draws it, and where the branch sits in it.
  const layout = useMapLayout(focused ? o : undefined);
  const agentOf = useAgentOf(pid);
  const branch = nav.selectedBranch ?? o?.currentBranch ?? o?.defaultBranch ?? undefined;
  /** What a branch's actions merge into and rebase onto: its parent. Not for the default branch, even filed under a less
   * advanced trunk (main under prod); that trunk, the map's root, keeps the default branch. */
  const baseFor = (b: string) => {
    const v = byName.get(b);
    return b === o?.defaultBranch ? "" : (v?.parent ?? (v?.role === "trunk" ? (o?.defaultBranch ?? "") : ""));
  };
  /** Delete `branches` in the background: `section` stays locked on the map until it is done, whatever screen or project the user is on. */
  const cleanUp = (section: string, branches: string[], opts: { force?: boolean; remote: boolean }, what: string) =>
    startCleanup({ projectId: pid, projectName: o?.project.name ?? "", section, branches, ...opts, what, onDeleted: (gone) => nav.forgetBranches(pid, gone) });
  // Releases and trunks a work branch can be re-targeted to.
  const targets = useMemo(() => (o?.branches ?? []).filter((x) => x.exists && x.role !== "branch"), [o]);
  /** A release branch reads as its version. */
  const labelOf = (b: string) => {
    const v = byName.get(b);
    return v?.role === "release" && v.release ? tagV.label(v.release) : b;
  };
  const target = (b: string): BranchTarget => {
    const v = byName.get(b) ?? synthetic(b, b === o?.currentBranch);
    const base = baseFor(b);
    const shippedRel = v.shipped ? o?.releases.find((r) => !r.open && r.version === v.shipped) : undefined;
    return {
      view: v,
      base,
      baseLabel: labelOf(base),
      isDefault: b === o?.defaultBranch,
      extra: shippedRel?.tagName ? tagItems(shippedRel.tagName, shippedRel.checkedOut) : undefined,
      showStashes: v.stashes ? () => openStashes(b) : undefined,
      latestStash: o?.stashes.find((s) => s.branch === b),
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
  /** Branch `b` full screen, on `item`. */
  const openFocus = (b: string, item: FocusItem) => {
    closeStashes();
    closeFileLog();
    nav.selectBranch(b);
    setCommit(typeof item === "object" ? item : undefined);
    setMode(item === "wip" ? "wip" : item === "project" ? "project" : "branch");
    setFocused(true);
    setPane("rail");
  };
  const closeFocus = () => {
    closeFileLog();
    closeStashes();
    setFocused(false);
  };
  /** `b` = the stashes made on that branch, none = every stash. */
  const openStashes = (b?: string) => {
    closeFileLog();
    if (b) nav.selectBranch(b);
    setStashesOf(b ?? "");
    setStash(undefined);
    setFocused(true);
    setPane("rail");
  };
  const closeStashes = () => {
    setStashesOf(null);
    setStash(undefined);
  };
  /** `want`: the commit to pick in it once listed. */
  const openFileLog = (path: string, want?: string) => {
    if (path !== fileLog) setLogPick(undefined);
    setFileLog(path);
    setLogWant(want);
  };
  const closeFileLog = () => {
    setFileLog(null);
    setLogPick(undefined);
    setLogWant(undefined);
  };
  const view: BranchView | undefined = branch ? byName.get(branch) : undefined;
  const dialogView = dialog && (byName.get(dialog.branch) ?? synthetic(dialog.branch, dialog.branch === o?.currentBranch));
  const base = branch ? baseFor(branch) : "";
  const checkedOut = view?.checkedOut ?? branch === o?.currentBranch;

  // The map needs no file lists: only the focus view loads them.
  const files = useFiles(pid, focused ? branch : undefined, mode, commit?.sha, stash?.sha);
  // Only the focus view lists them: on the map, each save would redraw every tile.
  const wipList = useFiles(pid, focused ? branch : undefined, "wip").data ?? [];
  const wipCount = new Set(wipList.map((f) => f.path)).size;
  const stagedCount = wipList.filter((f) => f.staged).length;
  const branchFiles = useFiles(pid, focused ? branch : undefined, "branch").data ?? [];
  const list = files.data ?? [];
  const isWip = mode === "wip" && !commit && !stash;
  // The files in the order the list shows them, for [ and ].
  const listed = useMemo(() => fileOrder(list, asTree), [list, asTree]);
  const picked = list.find((f) => fileKey(f) === file);
  // Until a file is picked, the focus view shows the first one: in the project's files, a changed one, else the README.
  const current =
    picked ??
    (focused && !file
      ? mode === "project" && !stash
        ? (listed.find((f) => f.status !== " ") ?? listed.find((f) => /^readme\.md$/i.test(f.path)) ?? listed[0])
        : listed[0]
      : undefined);
  const fileAt = current ? listed.indexOf(current) : -1;
  // The diff shows the commit picked in a file's history, else the file picked in the list.
  const logged = fileLog !== null ? logPick : undefined;
  const shown: FileChange | undefined = logged ? { path: logged.path, status: logged.status, additions: logged.additions, deletions: logged.deletions } : current;
  const shownCommit = logged ? logged.sha : commit?.sha;
  const shownStash = logged ? undefined : stash?.sha;
  // Project view lists untouched files too: those show as the plain file, no diff.
  const unchanged = mode === "project" && !shownCommit && !shownStash && shown?.status === " ";
  const markdown = /\.(md|markdown|mdx)$/i.test(shown?.path ?? "");
  // The file whose large diff the user asked to see anyway. One with a huge known line count isn't even fetched before that.
  const [anyway, setAnyway] = useState<string>();
  const forced = !!shown && anyway === fileKey(shown);
  const changedLines = shown ? shown.additions + shown.deletions : 0;
  const huge = !forced && changedLines > HUGE_DIFF;
  const showAnyway = () => shown && setAnyway(fileKey(shown));
  const diff = useDiff(pid, branch, mode, unchanged || huge ? undefined : shown?.path, shown?.staged, shownCommit, shownStash, diffMode === "full", logged?.from);
  const svg = /\.svg$/i.test(shown?.path ?? "");
  // An SVG is text too: its Code view drops the image preview and shows it like any other file.
  const image = isImage(shown?.path) && !(svg && svgCode);
  const blobs = useBlobs(pid, branch, mode, shown?.path, shown?.staged, shownCommit, shownStash, image || unchanged || markdown);
  const text = useMemo(() => !image && decodeText(blobs.data?.new ?? blobs.data?.old), [blobs.data, image]);
  // Memoized: a new array would re-render every row and re-measure the heatmap.
  const raw = useMemo<Hunk[] | undefined>(
    () => (unchanged && typeof text === "string" ? [{ header: "", oldStart: 1, newStart: 1, lines: text.replace(/\n$/, "").split("\n").map((t) => ({ kind: " ", text: t })) }] : undefined),
    [unchanged, text],
  );
  // No textual diff: binary, unless a rename that changed nothing else.
  const binary = unchanged ? text === null : diff.data?.length === 0 && shown?.status !== "R";
  // Blame needs a text diff of a file outside a stash. The new side needs the file still there; the old side, removed lines.
  const canBlame = !!shown && !image && !shownStash && !binary && blameFor === fileKey(shown);
  const removed = useMemo(() => !!diff.data?.some((h) => h.lines.some((l) => l.kind === "-")), [diff.data]);
  const newOk = canBlame && shown.status !== "D";
  const oldOk = canBlame && removed;
  const blamedNew = useBlame(pid, branch, mode, shown?.path, shownCommit, shown?.staged, false, newOk);
  const blamedOld = useBlame(pid, branch, mode, logged?.from ?? shown?.path, shownCommit, shown?.staged, true, oldOk);
  // Gated again: a disabled query still hands back what it cached. A blamed line's author opens its commit in the file's history.
  const newBlame = newOk ? blamedNew.data : undefined;
  const oldBlame = oldOk ? blamedOld.data : undefined;
  const blame = newBlame || oldBlame ? { blame: newBlame, old: oldBlame, onPick: (sha: string) => openFileLog(fileLog ?? shown?.path ?? "", sha) } : undefined;
  const showPreview = markdown && preview && typeof text === "string";
  const prefs = useProjectPrefs(pid);
  // A README's own pictures load from the repository at the same version. Like a pull request's, none show until the project allows them.
  const pictures = useMemo(() => {
    const at = { projectId: pid, branch, mode, staged: shown?.staged, commit: shownCommit };
    return {
      key: `md:${JSON.stringify([at, shownStash, shown?.path])}`,
      hidden: !prefs.dialogs.prMedia,
      load: async (src: string) => {
        const path = repoPath(shown?.path ?? "", src);
        if (!path || !isImage(path)) throw new Error("Not a picture of the repository");
        const b = await (shownStash ? rpc<Blobs>("stashes.blobs", { projectId: pid, sha: shownStash, path }) : rpc<Blobs>("workspace.blobs", { ...at, path }));
        const b64 = b.new ?? b.old;
        if (!b64) throw new Error("Picture not found");
        return dataUrl(path, b64);
      },
    };
  }, [pid, branch, mode, shown?.path, shown?.staged, shownCommit, shownStash, prefs.dialogs.prMedia]);
  const hiddenPictures = showPreview && !prefs.dialogs.prMedia && ANY_PICTURE.test(text || "");
  // A WIP file's diff stages or unstages some of its lines. Like whole files, that moves no ref (see WipList).
  type LineMove = { projectId: string; branch: string; path: string; lines: LinePick[] };
  const lineInv = [["files", pid], ["diff", pid], ["blobs", pid], ...(o?.inProgress || view?.inProgress ? [["overview", pid]] : [])];
  const stageLines = useAction<unknown, LineMove>("workspace.stageLines", { invalidate: lineInv });
  const unstageLines = useAction<unknown, LineMove>("workspace.unstageLines", { invalidate: lineInv });
  // Discarding a file's last lines takes it out of the WIP count the overview shows.
  const discardLines = useAction<unknown, LineMove>("workspace.discardLines", {
    invalidate: [["files", pid], ["diff", pid], ["blobs", pid], ["overview", pid]],
    success: "Changes discarded",
  });
  const staging: Staging | undefined =
    mode === "wip" && !commit && !stash && branch && checkedOut && shown?.staged !== undefined && shown.status !== "C"
      ? {
          staged: shown.staged,
          busy: stageLines.isPending || unstageLines.isPending || discardLines.isPending,
          apply: (lines) => (shown.staged ? unstageLines : stageLines).mutateAsync({ projectId: pid, branch, path: shown.path, lines }),
          discard: shown.staged ? undefined : (lines) => discardLines.mutateAsync({ projectId: pid, branch, path: shown.path, lines }),
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
    const open = () => setFile(fileKey(t.files[0]));
    return [
      ...(t.dir
        ? []
        : ([
            { id: "history", label: "File history", icon: "history", run: () => { open(); openFileLog(t.path, commit?.sha); } },
            "sep",
          ] satisfies MenuItem[])),
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

  useEffect(() => {
    setFile(undefined);
    closeFileLog();
  }, [branch, mode, commit, stash]);
  // A WIP file whose last lines on its side were staged (or unstaged) lives on the other side now: follow it there.
  useEffect(() => {
    if (picked || !file || mode !== "wip") return;
    const moved = list.find((f) => f.staged !== undefined && fileKey({ ...f, staged: !f.staged }) === file);
    if (moved) setFile(fileKey(moved));
  }, [picked, file, mode, list]);
  const logOpen = fileLog !== null;
  // The focus view's keys, outside a field, the terminal, a dialog or a menu: [ and ] move through the files, S switches split and unified. Escape closes the file's history or the stashes, else goes back to the map (unless it is letting go of
  // selected lines or closing a find); captured, so the lists' own Escape doesn't run too.
  const keys = useRef({ file: (_: 1 | -1) => {}, split: () => {}, back: () => {} });
  keys.current = {
    file: (d) => {
      const f = listed[fileAt + d];
      if (f) setFile(fileKey(f));
    },
    split: () => setDiffMode(diffMode === "split" ? "unified" : "split"),
    back: () => (logOpen ? closeFileLog() : stashesOf !== null ? closeStashes() : closeFocus()),
  };
  useEffect(() => {
    if (!focused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable], .xterm")) return;
      if (document.querySelector("[role=dialog], [role=menu]")) return;
      const k = e.key.toLowerCase();
      if (k === "escape") {
        if (document.querySelector(".diff-picks, .diff-find")) return;
        e.stopImmediatePropagation();
        keys.current.back();
      } else if (k === "[" || k === "]") keys.current.file(k === "]" ? 1 : -1);
      else if (k === "s") keys.current.split();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [focused]);
  // Picking another branch (e.g. from a ticket) leaves its stash list.
  useEffect(() => {
    if (stashesOf && branch !== stashesOf) closeStashes();
  }, [branch, stashesOf]);
  // A stash popped or dropped elsewhere is gone: stop showing it.
  useEffect(() => {
    if (stash && o && !o.stashes.some((s) => s.sha === stash.sha)) setStash(undefined);
  }, [o, stash]);

  /** The rebase, merge, cherry-pick or revert `b`'s checkout is stopped in the middle of. */
  const opOf = (b: string) => byName.get(b)?.inProgress ?? (b === o?.currentBranch ? o?.inProgress : null) ?? null;
  const op = branch ? opOf(branch) : null;
  // The main checkout's conflicts; another checkout's aren't counted.
  const opConflicts = branch === o?.currentBranch ? (o?.conflicts.length ?? 0) : 0;
  // AI carrying the branch's rebase through: its files stay as they are until it is done.
  const running = branch ? rebasing.get(branch) : undefined;
  // The branch another one is being rebased onto: locked as well, so what it replays onto stays put.
  const held = branch && !running ? locks.get(branch) : undefined;
  const starting = !!branch && startingRebase.includes(branch);
  /** Where `b` is being replayed: the checked-out branch's paused rebase may go elsewhere than its target. */
  const rebasingOnto = (b: string) => labelOf(b === o?.currentBranch && o?.rebaseOnto ? o.rebaseOnto : baseFor(b));

  if (ov.isLoading) return <Loading />;
  const t = branch ? target(branch) : undefined;
  const agent = view ? agentOf(view) : undefined;
  const chain = layout && branch ? lineageOf(layout, branch).flatMap((n) => byName.get(n) ?? []) : [];
  const hasBase = !!base && base !== branch;
  const sum = (l: FileChange[], k: "additions" | "deletions") => l.reduce((n, f) => n + f[k], 0);
  const nums = (l: FileChange[]) => [
    <span key="add" className="mono c-add">+{sum(l, "additions")}</span>,
    <span key="del" className="mono c-del">−{sum(l, "deletions")}</span>,
  ];
  const where = view?.worktree ? "in its own worktree" : checkedOut ? "checked out here" : "not checked out";
  const pickFile = (f: FileChange) => {
    setFile(fileKey(f));
    setPane("code");
  };
  // Another branch on the map's card: its files start over, on WIP while it has some or when it has no base to compare with.
  const mapOf = (b: BranchView) => {
    const at = mapAt.branch === b.name ? mapAt : { branch: b.name };
    const base = baseFor(b.name);
    const hasBase = !!base && base !== b.name;
    return { ...at, hasBase, mode: at.mode ?? (b.wip || !hasBase ? "wip" : "branch") } as const;
  };
  const [originText, originCls] = view ? originOf(view, !!o?.remote) : ["", ""];

  const filesEl = (
    <ul className="scroll rail-files" data-wip={(isWip && list.length > 0) || undefined}>
      {files.isLoading && <li className="empty"><span className="spinner" /></li>}
      {files.error && <li style={{ padding: 12 }}><ErrorBox error={files.error} /></li>}
      {isWip && branch && list.length > 0 ? (
        <WipList
          pid={pid}
          branch={branch}
          midOp={!!o?.inProgress || !!op}
          locked={!!running || !!held}
          list={list}
          current={current}
          tree={asTree}
          fold={fold}
          menu={fileMenu}
          onPick={pickFile}
          onMoved={(f) => current && fileKey(current) === fileKey(f) && setFile(fileKey({ ...f, staged: !f.staged }))}
          onDiscard={(staged, paths) => setDiscarding({ staged, paths })}
        />
      ) : (
        <FileList key={fold.n} allClosed={fold.closed} list={list} current={current} tree={asTree} menu={fileMenu} onPick={pickFile} />
      )}
      {!files.isLoading && list.length === 0 && (
        <li className="empty engraved">
          {stash
            ? "This stash holds no files."
            : commit
              ? "This commit changes no files."
              : mode === "wip"
                ? checkedOut
                  ? "No uncommitted changes."
                  : "This branch is not checked out."
                : "No changes on this branch yet."}
        </li>
      )}
    </ul>
  );

  // What the code shows, above it: the item picked, and what can be done with it.
  const stashAct = t && actions.action(t, "stash");
  const prAct = t && hasBase && !view?.worktree && o?.remote ? actions.action(t, "pr") : undefined;
  let eyebrow = "";
  let title: ReactNode = "";
  let meta: ReactNode[] = [];
  let acts: ReactNode = null;
  if (logged) {
    eyebrow = "File history";
    title = logged.subject;
    meta = [<span key="who" className="row code-who"><Avatar name={logged.author} email={logged.email} size={18} />{logged.author}</span>, <span key="when">{ago(logged.date)}</span>, <span key="sha" className="mono">{logged.sha.slice(0, 7)}</span>];
  } else if (stash) {
    eyebrow = "Stash";
    title = stash.message;
    meta = [<span key="sha" className="mono">{stash.sha.slice(0, 7)}</span>, stash.branch ? <span key="on" className="mono">on {stash.branch}</span> : null, <span key="when">{ago(stash.date)}</span>];
  } else if (commit) {
    // No header (eyebrow stays empty): the files panel already shows the commit.
  } else if (mode === "wip") {
    eyebrow = "Not committed";
    title = agent?.state === "working" ? `${agent.label} is still changing these files` : agent?.state ? `${agent.label} changed these files` : "Your changes since the last commit";
    meta = [<span key="n">{plural(wipCount, "file")}</span>, ...nums(wipList), <span key="where">{where}</span>];
    acts = stashAct && (
      <button className="btn btn-sm" disabled={stashAct.disabled} data-tip={stashAct.tip} onClick={stashAct.run}>
        <Icon name="stash" size={12} />
        Stash
      </button>
    );
  } else if (mode === "branch") {
    eyebrow = hasBase ? "All changes on this branch" : "History";
    title = branch ? labelOf(branch) : "";
    meta = [
      <span key="c">{plural(view?.ahead ?? 0, "commit")}</span>,
      <span key="f">{plural(list.length, "file")}</span>,
      ...nums(list),
      hasBase ? <span key="m">what merging into <span className="mono">{labelOf(base)}</span> brings</span> : null,
    ];
    acts = prAct && (
      <button className="btn btn-sm" disabled={prAct.disabled} data-tip={`Open a pull request into ${labelOf(base)}`} onClick={prAct.run}>
        <Icon name="pr" size={12} />
        Open PR
      </button>
    );
  } else {
    eyebrow = "Project · files at this branch";
    title = shown?.path ?? "Files";
    meta = [<span key="as">as it is on <span className="mono">{branch}</span>{checkedOut ? ", with your changes" : ""}</span>];
    acts = shown && (
      <button className="btn btn-sm" onClick={() => copyToClipboard(shown.path)}>
        <Icon name="copy" size={12} />
        Copy path
      </button>
    );
  }
  const cut = shown ? shown.path.lastIndexOf("/") : -1;
  const note = !shown
    ? ""
    : logged
      ? `as of ${logged.sha.slice(0, 7)}`
      : stash
        ? `in the stash`
        : commit
          ? `in ${commit.sha.slice(0, 7)}`
          : mode === "wip"
            ? shown.staged
              ? "staged"
              : "not staged"
            : mode === "branch"
              ? `all ${plural(view?.ahead ?? 0, "commit")}${hasBase ? ` vs ${labelOf(base)}` : ""}`
              : unchanged
                ? "unchanged on this branch"
                : "changed on this branch";

  return (
    <>
      <KeepWipCount pid={pid} branch={o?.currentBranch ?? undefined} />
      {ov.error && (
        <div style={{ padding: 16 }}>
          <ErrorBox error={ov.error} />
        </div>
      )}

      {o && (
        <main
          className="ws"
          data-slide={focused ? slide.dir : undefined}
          {...(focused
            ? swipeProps((dir) => {
                // Back from the timeline: out of a file's history or the stashes, else back to the map.
                if (dir < 0 && pane === PANES[0]) return logOpen ? closeFileLog() : stashesOf !== null ? closeStashes() : closeFocus();
                const next = PANES[PANES.indexOf(pane) + dir];
                if (next) setPane(next);
              })
            : {})}
        >
          <div className="ws-head">
            {focused ? (
              <div className="focus-head">
                <button className="btn btn-sm focus-back" data-tip="Back to the branch map (Esc)" onClick={closeFocus}>
                  <Icon name="back" size={14} />
                  <span className="hide-narrow">Branch map</span>
                  <kbd className="hide-narrow">Esc</kbd>
                </button>
                <nav className="focus-crumbs" aria-label="Where it comes from">
                  {chain.map((c, i) => (
                    <Fragment key={c.name}>
                      {i > 0 && <span className="faint" aria-hidden>›</span>}
                      <button
                        className="mono"
                        aria-current={c.name === branch || undefined}
                        onClick={() => c.name !== branch && openFocus(c.name, lookItem(c))}
                      >
                        {labelOf(c.name)}
                      </button>
                    </Fragment>
                  ))}
                  {view && <BranchTags o={o} b={view} />}
                </nav>
                <span className="grow" />
                {view && (
                  <span className="focus-pills hide-narrow">
                    {view.role === "branch" && hasBase && !view.merged && view.exists && (
                      <span>
                        ↑{view.ahead}
                        {view.behind > 0 && <span className="c-del"> ↓{view.behind}</span>} vs {labelOf(base)}
                      </span>
                    )}
                    {view.conflict && <span className="c-del">{op ?? "operation"} stopped on a conflict</span>}
                    {agent &&
                      (agent.state === "working" ? (
                        <span>
                          <span className="pulse glow-dot" />
                          <span className="glow-working">
                            <span>{agent.label} working</span>
                          </span>
                        </span>
                      ) : (
                        <span className={agent.state === "waiting" || agent.state === "limit" ? "c-warn" : undefined}>
                          {agent.state === "waiting" && <span className="pulse map-wait" />}
                          {agent.label} {agentWords(agent)}
                        </span>
                      ))}
                    {view.merged && <span>merged into {labelOf(base)}</span>}
                    {view.exists && !view.merged && <span className={originCls}>{originText}</span>}
                  </span>
                )}
              </div>
            ) : (
              <div ref={setMapBar} />
            )}
          </div>
          <div className="ws-body">
            {!focused ? (
              <BranchMap
                o={o}
                selected={branch}
                actions={actions}
                target={target}
                onSelect={(b) => nav.selectBranch(b)}
                onFocus={openFocus}
                onCleanup={(parent, label, branches) => setCleanup({ parent, label, branches })}
                onCleanupBehind={(section, base, branches) => setCleanupBehind({ section, base, branches })}
                onCleanupShipped={setCleanupShipped}
                cleaning={cleaning}
                tagItems={tagItems}
                onStashes={openStashes}
                building={ov.isPlaceholderData}
                bar={mapBar}
                files={(b) => {
                  if (!b.exists) return null;
                  const m = mapOf(b);
                  return (
                    <MapFiles
                      pid={pid}
                      b={b}
                      checkedOut={b.checkedOut || b.name === o.currentBranch}
                      hasBase={m.hasBase}
                      midOp={!!o.inProgress || !!b.inProgress}
                      locked={rebasing.get(b.name) ? "AI is rebasing this branch" : locks.get(b.name) ? "Locked while AI rebases a branch onto this one" : undefined}
                      mode={m.mode}
                      open={m.file}
                      onMode={(mode) => setMapAt({ branch: b.name, mode })}
                      // Open, the list keeps its mode: the file doesn't swap lists when the last WIP is committed.
                      onOpen={(f) => setMapAt({ branch: b.name, mode: m.mode, file: fileKey(f) })}
                    />
                  );
                }}
                fileDiff={(b) => {
                  const m = mapOf(b);
                  return m.file && <MapDiff pid={pid} branch={b.name} mode={m.mode} file={m.file} onPick={(f) => setMapAt({ branch: b.name, mode: m.mode, file: fileKey(f) })} onClose={() => setMapAt({ branch: b.name, mode: m.mode })} />;
                }}
              />
            ) : (
              <section className="focus" aria-label={`${branch} full screen`}>
                <div className="focus-body">
                  <aside className="rail" aria-label="Changed files" style={{ "--rail-w": `${railW.width}px` } as CSSProperties} data-pane data-active={pane === "rail"}>
                    {fileLog !== null && branch ? (
                      <FileHistory
                        key={fileLog}
                        pid={pid}
                        branch={branch}
                        path={fileLog}
                        selected={logPick?.sha}
                        want={logWant}
                        onPick={(c, auto) => {
                          setLogPick(c);
                          setLogWant(undefined);
                          if (!auto) setPane("code");
                        }}
                        onBack={closeFileLog}
                      />
                    ) : stashesOf !== null ? (
                      <>
                        <StashList
                          active
                          pid={pid}
                          stashes={stashesOf ? o.stashes.filter((s) => s.branch === stashesOf) : o.stashes}
                          branch={stashesOf || undefined}
                          total={o.stashes.length}
                          selected={stash?.sha}
                          // Back onto its own branch when that is checked out, else onto the main checkout's.
                          targetOf={(s) => (s.branch && byName.get(s.branch)?.checkedOut ? s.branch : (o.currentBranch ?? undefined))}
                          onPick={setStash}
                          onShowAll={() => openStashes()}
                          onBack={closeStashes}
                        />
                        {stash && filesEl}
                      </>
                    ) : (
                      <>
                        <div className="col rail-head">
                          <div className="row" style={{ alignItems: "center", minWidth: 0, margin: 0 }}>
                            <span className="mono ellipsis" style={{ fontSize: 13, fontWeight: 500 }}>{branch ?? "No branch"}</span>
                            {hasBase && <span className="faint" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>{view?.likelyMerged ? "likely merged into" : view?.merged ? "merged into" : "from"} {labelOf(base)}</span>}
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
                          {commit ? (
                            // Opened from a commit on the map: its files, until closed back to the branch's.
                            <div className="commit-head">
                              <div className="col" style={{ gap: 3, minWidth: 0, flex: "1 1 auto" }}>
                                <span className="commit-subject">{commit.subject}</span>
                                <span className="commit-meta">
                                  <button className="link-btn mono" data-tip="Copy SHA" onClick={() => copyToClipboard(commit.sha)}>
                                    {commit.sha.slice(0, 7)}
                                  </button>
                                  {commit.tags.map((t) => (
                                    <span key={t} className="commit-tag mono" data-tip={`Tag ${t}`}>
                                      <Icon name="tag" size={10} stroke={1.6} />
                                      {t}
                                    </span>
                                  ))}
                                  <span className="ellipsis">{commit.author}</span>
                                  <span style={{ whiteSpace: "nowrap" }}>{ago(commit.date)}</span>
                                  <span style={{ whiteSpace: "nowrap" }}>{plural(new Set(list.map((f) => f.path)).size, "file")}</span>
                                  {nums(list)}
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
                                { value: "branch", label: <>Branch <span className="faint">{branchFiles.length}</span></> },
                                { value: "project", label: "Project" },
                              ]}
                            />
                          )}
                          {branch && view?.worktree && <span className="hint mono ellipsis" title={view.worktree}>{view.worktree}</span>}
                        </div>
                        {isWip && junk && (
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
                        {filesEl}
                        {branch && !commit && (
                          <CommitBox
                            key={branch}
                            pid={pid}
                            branch={branch}
                            enabled={checkedOut && !running && !held}
                            locked={running ? "AI is rebasing this branch" : held ? "Locked while AI rebases a branch onto this one" : undefined}
                            staged={stagedCount}
                            changed={wipCount}
                          />
                        )}
                      </>
                    )}
                  </aside>
                  <Resizer pane={railW} label="Resize the files panel" />
                  <section aria-label="Code" className="focus-code" data-pane data-active={pane === "code"}>
                    {eyebrow && (
                      <div className="code-top">
                        <div className="code-title">
                          <h2>{title}</h2>
                          <div className="code-meta">
                            <span className="faint">{eyebrow}</span>
                            {meta}
                          </div>
                        </div>
                        <div className="code-acts">
                          {acts}
                        </div>
                      </div>
                    )}
                    {running && branch ? (
                      <div className="code-banner c-acc">
                        <span className="spinner" />
                        <span className="grow">
                          AI is rebasing onto <span className="mono">{labelOf(running.onto)}</span>
                          {running.steps ? `, commit ${running.step} of ${running.steps}` : ""}. Its files stay as they are until it is done.
                        </span>
                        <button className="btn btn-sm" onClick={() => showRun(pid, branch)}>
                          <Icon name="sparkle" size={12} />
                          Show progress
                        </button>
                      </div>
                    ) : held ? (
                      <div className="code-banner">
                        <Icon name="lock" size={13} />
                        <span className="grow">
                          AI is rebasing <span className="mono">{labelOf(held.branch)}</span> onto this branch: it stays locked until that is done.
                        </span>
                        <button className="btn btn-sm" onClick={() => showRun(held.projectId, held.branch)}>
                          <Icon name="sparkle" size={12} />
                          Show progress
                        </button>
                      </div>
                    ) : (
                      op &&
                      branch && (
                        <div className={`code-banner ${opConflicts || view?.conflict ? "c-del" : "c-warn"}`}>
                          <Icon name="alert" size={13} />
                          <span className="grow">
                            {op === "rebase" ? <>The rebase onto <span className="mono">{rebasingOnto(branch)}</span></> : `The ${op}`}
                            {opConflicts ? ` stopped on ${plural(opConflicts, "conflict")}.` : view?.conflict ? " stopped on conflicts." : " is paused."}
                          </span>
                          <button className="btn btn-sm" disabled={starting} data-tip={`Put ${branch} back to where it was before the ${op}`} onClick={() => setDialog({ kind: "abort", branch })}>
                            <Icon name="undo" size={12} />
                            Abort {op}
                          </button>
                          {op === "rebase" && (
                            <button className="btn btn-primary btn-sm" disabled={starting} data-tip="AI resolves every conflict and carries the rebase through every commit" onClick={() => void startRebase(pid, branch, { resume: true })}>
                              {starting ? <span className="spinner" /> : <Icon name="sparkle" size={12} />}
                              Resolve with AI
                            </button>
                          )}
                        </div>
                      )
                    )}
                    <div className="code-file">
                      {shown ? (
                        <>
                          <span className={`file-st ${{ A: "c-add", D: "c-del", C: "c-acc", M: "c-mod", R: "c-mod", " ": "faint" }[shown.status] ?? "faint"}`}>{shown.status === " " ? "·" : shown.status}</span>
                          <span className="code-path mono ellipsis" data-tip={shown.path} data-tip-overflow>
                            {cut >= 0 && <span className="faint">{shown.path.slice(0, cut + 1)}</span>}
                            <b>{shown.path.slice(cut + 1)}</b>
                          </span>
                          <span className="row mono hide-narrow" style={{ gap: 6, margin: 0 }}>
                            {shown.additions ? <span className="c-add">+{shown.additions}</span> : null}
                            {shown.deletions ? <span className="c-del">−{shown.deletions}</span> : null}
                          </span>
                          <span className="faint ellipsis hide-narrow code-note">{note}</span>
                        </>
                      ) : (
                        <span className="faint">No file selected</span>
                      )}
                      <span className="grow" />
                      {!logged && listed.length > 1 && (
                        <span className="code-files" role="group" aria-label="Files">
                          <button className="btn btn-ghost btn-sm btn-icon" aria-label="Previous file ([)" data-tip="Previous file ([)" disabled={fileAt <= 0} onClick={() => keys.current.file(-1)}>
                            <Icon name="chevronLeft" size={12} />
                          </button>
                          <span className="hide-narrow">{fileAt >= 0 ? `File ${fileAt + 1} of ${listed.length}` : `${listed.length} files`}</span>
                          <button className="btn btn-ghost btn-sm btn-icon" aria-label="Next file (])" data-tip="Next file (])" disabled={fileAt >= listed.length - 1} onClick={() => keys.current.file(1)}>
                            <Icon name="chevronRight" size={12} />
                          </button>
                        </span>
                      )}
                      {image ? (
                        (comparable(blobs.data) || svg) && (
                          <Seg<ImageMode | "code">
                            value={imageMode}
                            onChange={(v) => (v === "code" ? setSvgCode(true) : setImageMode(v))}
                            label="Image comparison"
                            options={[...(comparable(blobs.data) ? IMAGE_MODES : [{ value: imageMode, label: "Image" }]), ...(svg ? [{ value: "code" as const, label: "Code" }] : [])]}
                          />
                        )
                      ) : (
                        (!unchanged || markdown || svg) &&
                        shown && (
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
                                : [
                                    { value: "split" as const, label: "Split" },
                                    { value: "unified" as const, label: "Unified" },
                                    { value: "full" as const, label: "Full" },
                                  ]),
                              ...(markdown ? [{ value: "preview" as const, label: "Preview" }] : []),
                              ...(svg ? [{ value: "image" as const, label: "Image" }] : []),
                            ]}
                          />
                        )
                      )}
                      {shown && branch && (
                        <button
                          className="btn btn-sm"
                          aria-label="File history"
                          aria-pressed={logOpen}
                          data-tip={logOpen ? "Back to the timeline (Esc)" : "Commits that changed this file"}
                          onClick={() => {
                            if (logOpen) return closeFileLog();
                            // From a commit: that commit, picked in the file's history.
                            openFileLog(shown.path, commit?.sha);
                            setPane("rail");
                          }}
                        >
                          <Icon name="history" size={12} />
                          <span className="hide-narrow">History</span>
                        </button>
                      )}
                    </div>
                    {/* Blame loads once the pointer is over the file's lines. */}
                    <div className="diff" onPointerOver={() => shown && blameFor !== fileKey(shown) && setBlameFor(fileKey(shown))}>
                      {(diff.isLoading || (unchanged && blobs.isLoading)) && shown && <Loading />}
                      {diff.error && <div style={{ padding: 16 }}><ErrorBox error={diff.error} /></div>}
                      {image && shown && blobs.data && <ImageDiff path={shown.path} blobs={blobs.data} mode={imageMode} />}
                      {blobs.error && (image || unchanged) && <div style={{ padding: 16 }}><ErrorBox error={blobs.error} /></div>}
                      {showPreview ? (
                        <article style={{ maxWidth: 760, margin: "0 auto", padding: "24px 24px 48px", fontFamily: "var(--sans)", fontSize: 14, lineHeight: 1.6 }}>
                          {hiddenPictures && <MediaAsk html={false} onShow={() => prefs.setDialogs({ prMedia: true })} />}
                          <PictureSource.Provider value={pictures}>
                            <Markdown text={text} html />
                          </PictureSource.Provider>
                        </article>
                      ) : (
                        <>
                          {huge && !image && <LargeDiff lines={changedLines} onShow={showAnyway} />}
                          {raw && shown && <DiffView path={shown.path} hunks={raw} mode="full" blame={blame} anyway={forced} onAnyway={showAnyway} />}
                          {!image && shown && diff.data && diff.data.length > 0 && <DiffView path={shown.path} hunks={diff.data} mode={diffMode} staging={staging} blame={blame} anyway={forced} onAnyway={showAnyway} />}
                        </>
                      )}
                      {(!shown || (diff.data && diff.data.length === 0 && !image) || (unchanged && !image && blobs.data && text === null)) && (
                        <div className={list.length === 0 ? "empty engraved" : "empty"} style={{ fontFamily: "var(--sans)" }}>
                          {list.length === 0
                            ? isWip
                              ? "Nothing to show — working tree is clean."
                              : "Nothing to show for this."
                            : !shown
                              ? "No file selected."
                              : unchanged
                                ? "Binary file."
                                : logged?.from
                                  ? `Renamed from ${logged.from}, no other changes.`
                                  : "No textual changes in this file."}
                        </div>
                      )}
                    </div>
                    <div className="code-foot">
                      <span><kbd>[</kbd><kbd>]</kbd>previous and next file</span>
                      <span><kbd>S</kbd>split or unified</span>
                      <span><kbd>Esc</kbd>back to the map</span>
                    </div>
                  </section>
                </div>
              </section>
            )}
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
        </main>
      )}

      {/* After main so it sits at the bottom, just above the mobile tabs. */}
      {focused && (
        <div className="pane-switch">
          <Seg<Pane>
            label="Panel"
            grid
            value={pane}
            onChange={setPane}
            options={[
              { value: "rail", label: logOpen ? "History" : stashesOf !== null ? "Stashes" : "Files" },
              { value: "code", label: listed.length ? `Code ${fileAt >= 0 ? `${fileAt + 1}/${listed.length}` : listed.length}` : "Code & agent" },
            ]}
          />
        </div>
      )}

      {discarding && branch && (
        <DiscardModal pid={pid} branch={branch} staged={discarding.staged} paths={discarding.paths} total={list.filter((f) => f.staged === discarding.staged).length} onClose={() => setDiscarding(null)} />
      )}
      {actions.menuEl}
      {dialog?.kind === "abort" && (
        <AbortModal key={dialog.branch} pid={pid} branch={dialog.branch} op={opOf(dialog.branch)} base={rebasingOnto(dialog.branch)} onBack={() => setDialog(null)} onDone={() => setDialog(null)} />
      )}
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
      {dialog?.kind === "publish" && dialogView && <PublishModal pid={pid} view={dialogView} onClose={() => setDialog(null)} />}
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
        <RebaseOntoBranchModal pid={pid} branch={dialog.branch} onto={dialog.onto} branches={o.branches} defaultBranch={o.defaultBranch} labelOf={labelOf} onClose={() => setDialog(null)} onChildren={(b) => setDialog({ kind: "children", branch: b })} />
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
      {dialog?.kind === "children" && o && <UpdateChildrenModal pid={pid} branch={dialog.branch} branches={o.branches} defaultBranch={o.defaultBranch} labelOf={labelOf} onClose={() => setDialog(null)} />}
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
          checkedOut={dialogView.checkedOut}
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
    upstreamRewritten: false,
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
  locked,
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
  /** AI is rebasing the branch: its files are left alone meanwhile. */
  locked: boolean;
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
  const busy = locked || stage.isPending || unstage.isPending;
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

/** The files in the order their list shows them: staged ones before unstaged, and in a tree, folders before files at each level. */
function fileOrder(list: FileChange[], tree: boolean): FileChange[] {
  const walk = (d: Dir): FileChange[] => [...[...d.dirs].sort(([a], [b]) => a.localeCompare(b)).flatMap(([, s]) => walk(s)), ...d.files];
  return [true, false, undefined].flatMap((s) => {
    const side = list.filter((f) => f.staged === s);
    return tree ? walk(buildTree(side)) : side;
  });
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

/** `key`'s file in `list`: on the same side, else on the other one once staged or unstaged. */
const findFile = (list: FileChange[], key?: string) => {
  const at = list.findIndex((f) => fileKey(f) === key);
  return at >= 0 ? at : list.findIndex((f) => f.staged !== undefined && fileKey({ ...f, staged: !f.staged }) === key);
};

/** The branch's files under its card on the map, WIP, Branch or Project; a click opens one over the map. WIP files stage, unstage,
 *  discard and commit as in the focus view. Its own component: a save redraws this list, not the map. */
function MapFiles({
  pid,
  b,
  checkedOut,
  hasBase,
  midOp,
  locked,
  mode,
  open,
  onMode,
  onOpen,
}: {
  pid: string;
  b: BranchView;
  checkedOut: boolean;
  hasBase: boolean;
  midOp: boolean;
  /** Why its files are left alone: AI rebasing it, or onto it. */
  locked?: string;
  mode: Mode;
  open?: string;
  onMode: (m: Mode) => void;
  onOpen: (f: FileChange) => void;
}) {
  const files = useFiles(pid, b.name, mode);
  const list = files.data ?? [];
  const current = list[findFile(list, open)];
  const wip = mode === "wip" && list.length > 0;
  const [discarding, setDiscarding] = useState<{ staged: boolean; paths: string[] } | null>(null);
  const [asTree, setAsTree] = useStoredFlag("gnx.files.tree");
  return (
    <section className="map-files" aria-label={`Files of ${b.name}`}>
      <div className="map-files-head">
        <Seg<Mode>
          label="Files"
          grid
          value={mode}
          onChange={onMode}
          options={[
            { value: "wip", label: b.wip > 0 ? <span className="wip-badge">WIP {b.wip}</span> : <>WIP <span className="faint">0</span></> },
            { value: "branch", label: "Branch" },
            { value: "project", label: "Project" },
          ]}
        />
        <button className="btn btn-sm btn-icon" aria-label={asTree ? "Show files as a list" : "Show files as a tree"} data-tip={asTree ? "List view" : "Tree view"} onClick={() => setAsTree(!asTree)}>
          <Icon name={asTree ? "menu" : "folder"} size={12} />
        </button>
      </div>
      <ul className="scroll map-files-list" data-wip={wip || undefined}>
        {files.isLoading && <li className="empty"><span className="spinner" /></li>}
        {files.error && <li style={{ padding: 12 }}><ErrorBox error={files.error} /></li>}
        {wip ? (
          <WipList
            pid={pid}
            branch={b.name}
            midOp={midOp}
            locked={!!locked}
            list={list}
            current={current}
            tree={asTree}
            fold={{ closed: false, n: 0 }}
            menu={(t) => [{ id: "copy", label: "Copy path", icon: "copy", run: () => copyToClipboard(t.path) }]}
            onPick={onOpen}
            onMoved={(f) => open === fileKey(f) && onOpen({ ...f, staged: !f.staged })}
            onDiscard={(staged, paths) => setDiscarding({ staged, paths })}
          />
        ) : (
          <FileList list={list} current={current} tree={asTree} allClosed={false} onPick={onOpen} />
        )}
        {files.data && list.length === 0 && (
          <li className="empty">
            {mode === "wip" ? (checkedOut ? "No uncommitted changes." : "Not checked out: nothing uncommitted here.") : mode === "project" ? "No files." : hasBase ? "No changes on this branch yet." : "Nothing to compare: it is the base branch."}
          </li>
        )}
      </ul>
      {mode === "wip" && checkedOut && (
        <CommitBox
          key={b.name}
          pid={pid}
          branch={b.name}
          enabled={!locked}
          locked={locked}
          staged={list.filter((f) => f.staged).length}
          changed={new Set(list.map((f) => f.path)).size}
        />
      )}
      {discarding && (
        <DiscardModal pid={pid} branch={b.name} staged={discarding.staged} paths={discarding.paths} total={list.filter((f) => f.staged === discarding.staged).length} onClose={() => setDiscarding(null)} />
      )}
    </section>
  );
}

/** A file of the map's files panel, floating over the map. [ and ] go through the list, S switches split and unified,
 *  Esc or the close button puts it away. */
function MapDiff({ pid, branch, mode, file, onPick, onClose }: { pid: string; branch: string; mode: Mode; file: string; onPick: (f: FileChange) => void; onClose: () => void }) {
  const [asTree] = useStoredFlag("gnx.files.tree");
  const files = useFiles(pid, branch, mode).data;
  const listed = useMemo(() => fileOrder(files ?? [], asTree), [files, asTree]);
  const at = findFile(listed, file);
  const f = at >= 0 ? listed[at] : undefined;
  const [diffMode, setDiffMode] = useState<DiffMode>("unified");
  const [imageMode, setImageMode] = useImageMode();
  const [anyway, setAnyway] = useState<string>();
  const forced = anyway === file;
  const lines = f ? f.additions + f.deletions : 0;
  const huge = !forced && lines > HUGE_DIFF;
  const image = isImage(f?.path);
  // Project lists untouched files too: those show as the plain file, no diff.
  const unchanged = f?.status === " ";
  const diff = useDiff(pid, branch, mode, f && !huge && !image && !unchanged ? f.path : undefined, f?.staged, undefined, undefined, diffMode === "full");
  const blobs = useBlobs(pid, branch, mode, f?.path, f?.staged, undefined, undefined, image || unchanged);
  const text = useMemo(() => !image && decodeText(blobs.data?.new ?? blobs.data?.old), [blobs.data, image]);
  const raw = useMemo<Hunk[] | undefined>(
    () => (unchanged && typeof text === "string" ? [{ header: "", oldStart: 1, newStart: 1, lines: text.replace(/\n$/, "").split("\n").map((t) => ({ kind: " ", text: t })) }] : undefined),
    [unchanged, text],
  );
  const keys = useRef({ file: (_: 1 | -1) => {}, split: () => {}, close: onClose });
  keys.current = {
    file: (d) => listed[at + d] && onPick(listed[at + d]),
    split: () => setDiffMode(diffMode === "split" ? "unified" : "split"),
    close: onClose,
  };
  // Captured, so the map's own keys don't run too; not from a field, a dialog, a menu, or a diff letting go of picked lines.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable], .xterm")) return;
      if (document.querySelector("[role=dialog], [role=menu], .diff-picks, .diff-find")) return;
      const k = e.key.toLowerCase();
      if (k === "escape") keys.current.close();
      else if (k === "[" || k === "]") keys.current.file(k === "]" ? 1 : -1);
      else if (k === "s") keys.current.split();
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const cut = f ? f.path.lastIndexOf("/") : -1;
  return (
    <section className="map-diff" aria-label={f ? `Changes to ${f.path}` : "File"}>
      <div className="code-file">
        {f && (
          <>
            <span className={`file-st ${{ A: "c-add", D: "c-del", C: "c-acc", M: "c-mod", R: "c-mod", " ": "faint" }[f.status] ?? "faint"}`}>{unchanged ? "·" : f.status}</span>
            <span className="code-path mono ellipsis" data-tip={f.path} data-tip-overflow>
              {cut >= 0 && <span className="faint">{f.path.slice(0, cut + 1)}</span>}
              <b>{f.path.slice(cut + 1)}</b>
            </span>
            <span className="row mono" style={{ gap: 6, margin: 0 }}>
              {f.additions ? <span className="c-add">+{f.additions}</span> : null}
              {f.deletions ? <span className="c-del">−{f.deletions}</span> : null}
            </span>
            {mode !== "branch" && <span className="faint code-note">{mode === "wip" ? (f.staged ? "staged" : "not staged") : unchanged ? "unchanged on this branch" : "changed on this branch"}</span>}
          </>
        )}
        <span className="grow" />
        {listed.length > 1 && (
          <span className="code-files" role="group" aria-label="Files">
            <button className="btn btn-ghost btn-sm btn-icon" aria-label="Previous file ([)" data-tip="Previous file ([)" disabled={at <= 0} onClick={() => keys.current.file(-1)}>
              <Icon name="chevronLeft" size={12} />
            </button>
            <span>{at >= 0 ? `File ${at + 1} of ${listed.length}` : `${listed.length} files`}</span>
            <button className="btn btn-ghost btn-sm btn-icon" aria-label="Next file (])" data-tip="Next file (])" disabled={at >= listed.length - 1} onClick={() => keys.current.file(1)}>
              <Icon name="chevronRight" size={12} />
            </button>
          </span>
        )}
        {image
          ? comparable(blobs.data) && <Seg<ImageMode> value={imageMode} onChange={setImageMode} label="Image comparison" options={IMAGE_MODES} />
          : f &&
            !unchanged && (
              <Seg<DiffMode>
                value={diffMode}
                onChange={setDiffMode}
                label="Diff mode"
                options={[
                  { value: "split", label: "Split" },
                  { value: "unified", label: "Unified" },
                  { value: "full", label: "Full" },
                ]}
              />
            )}
        <button className="btn btn-sm btn-icon" aria-label="Close the file (Esc)" data-tip="Close (Esc)" onClick={onClose}>
          <Icon name="close" size={12} />
        </button>
      </div>
      <div className="diff">
        {(diff.isLoading || blobs.isLoading) && <Loading />}
        {diff.error && <div style={{ padding: 16 }}><ErrorBox error={diff.error} /></div>}
        {blobs.error && <div style={{ padding: 16 }}><ErrorBox error={blobs.error} /></div>}
        {image && f && blobs.data && <ImageDiff path={f.path} blobs={blobs.data} mode={imageMode} />}
        {huge && !image && <LargeDiff lines={lines} onShow={() => setAnyway(file)} />}
        {raw && f && <DiffView path={f.path} hunks={raw} mode="full" anyway={forced} onAnyway={() => setAnyway(file)} />}
        {!image && f && diff.data && diff.data.length > 0 && <DiffView path={f.path} hunks={diff.data} mode={diffMode} anyway={forced} onAnyway={() => setAnyway(file)} />}
        {(files && !f) || (!image && diff.data?.length === 0) || (unchanged && !image && text === null) ? (
          <div className="empty" style={{ fontFamily: "var(--sans)" }}>
            {!f ? "This file has no changes here anymore." : unchanged ? "Binary file." : f.status === "R" ? "Renamed, no other changes." : "No textual changes in this file."}
          </div>
        ) : null}
      </div>
    </section>
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
        {view.upstreamAhead > 0 && <> The {plural(view.upstreamAhead, "local commit")} not on origin {view.upstreamAhead === 1 ? "is" : "are"} dropped{view.upstreamRewritten && <>: {view.upstreamAhead === 1 ? "it was" : "they were"} on origin before someone force pushed it</>}.</>}
        {view.checkedOut && view.wip > 0 && <> Uncommitted changes in its checkout are lost ({plural(view.wip, "file")}).</>} This cannot be undone.
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

/** Filterable radio list of branches, newest last commit first. */
function BranchPicker({ choices, labelOf, picked, onPick }: { choices: BranchView[]; labelOf: (b: string) => string; picked: string | null; onPick: (b: string) => void }) {
  const [query, setQuery] = useState("");
  const sorted = useMemo(() => {
    const time = (b: BranchView) => Date.parse(b.date) || 0;
    return [...choices].sort((a, b) => time(b) - time(a) || a.name.localeCompare(b.name));
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
  return (
    <Modal
      title="Rebase onto the new target?"
      sub={<><span className="mono">{branch}</span> now targets <span className="mono">{onto}</span></>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md btn-primary" autoFocus onClick={() => { void startRebase(pid, branch); onClose(); }}>
            Rebase onto {onto}
          </button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>Replays the commits of {branch} on top of {onto}, AI resolving the conflicts on the way. Already pushed: it then needs a force push.</p>
    </Modal>
  );
}

/** Replays the checked-out `branch` on top of `onto`, or of a branch picked here; its target stays. */
/** Once it went through: pushed when asked to, then `onChildren` asks about the branches under it. */
function RebaseOntoBranchModal({ pid, branch, onto, branches, defaultBranch, labelOf, onClose, onChildren }: { pid: string; branch: string; onto?: string; branches: BranchView[]; defaultBranch: string; labelOf: (b: string) => string; onClose: () => void; onChildren: (b: string) => void }) {
  const [picked, setPicked] = useState<string | null>(onto ?? null);
  const [push, setPush] = useState(true);
  const choices = useMemo(() => branches.filter((b) => b.exists && b.name !== branch), [branches, branch]);
  const view = branches.find((b) => b.name === branch);
  const parent = view?.parent;
  const name = labelOf(branch);
  const to = picked ? labelOf(picked) : undefined;
  const upstream = view?.upstream;
  const go = async (target: string) => {
    onClose();
    const r = await startRebase(pid, branch, { onto: target, resolve: true });
    // Stopped on conflicts, or aborted: nothing moved for good yet.
    if (!r || r.aborted || r.conflicts.length) return;
    if (push && upstream) {
      const force = !!r.forcePushTo;
      const ok = await call("workspace.push", { projectId: pid, branch, force }).then(
        () => (toast(`${force ? "Force pushed" : "Pushed"} ${name} to ${upstream}`, "ok"), true),
        (e: Error) => (toast(`Rebased ${name}, but pushing it failed: ${e.message}`, "error"), false),
      );
      queryClient.invalidateQueries({ queryKey: ["overview", pid] });
      if (!ok) return;
    }
    if (childrenOf(branches, branch, defaultBranch).length) onChildren(branch);
  };
  return (
    <Modal
      title={onto ? `Rebase onto ${labelOf(onto)}?` : "Rebase onto a specific branch"}
      sub={view?.checkedOut ? <><span className="mono">{name}</span> is checked out</> : <><span className="mono">{name}</span> is rebased aside: your checkout stays as it is</>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md btn-primary" autoFocus={!!onto} disabled={!picked} onClick={() => picked && void go(picked)}>
            Rebase {name} onto {to ?? "it"}
          </button>
        </>
      }
    >
      {!onto && <BranchPicker choices={choices} labelOf={labelOf} picked={picked} onPick={setPicked} />}
      <p className="muted" style={{ margin: 0 }}>
        Replays the commits of {name} on top of {to ?? "the branch picked"}, AI resolving the conflicts on the way.{!view?.checkedOut && " Any it can't resolve put it back as it was."}{parent && <> {name} keeps targeting {labelOf(parent)}.</>}
        {upstream && push ? <> Then it is force pushed: anyone with work on it rebases it too. Origin refuses it if it has commits {name} never had.</> : " Already pushed: it then needs a force push."}
      </p>
      {upstream && (
        <label className="check">
          <input type="checkbox" checked={push} onChange={() => setPush(!push)} />
          <span>Force push to <span className="mono">{upstream}</span> after</span>
        </label>
      )}
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
  checkedOut,
  onClose,
}: {
  pid: string;
  branch: string;
  base: string;
  local: boolean;
  /** Exists on origin. */
  remote: boolean;
  worktree?: string;
  /** Checked out in the main checkout: git refuses to delete it, so the delete switches to `base` first. */
  checkedOut: boolean;
  onClose: () => void;
}) {
  const [force, setForce] = useState(false);
  // Origin-only branches can only go from origin; otherwise origin keeps its copy unless the project's settings or the user ask.
  const [alsoOrigin, setAlsoOrigin] = useState(useProjectPrefs(pid).dialogs.deleteOrigin);
  const onOrigin = remote && (!local || alsoOrigin);
  const exists = local || remote;
  const nav = useNav();
  // In the background: the dialog closes and the tile leaves the map at once, unless origin keeps a copy (it stays, busy).
  const del = () => {
    onClose();
    nav.forgetBranches(pid, [branch]);
    void runTask({
      label: `Deleting ${branch}…`,
      hide: remote && !onOrigin ? [] : [branchKey(pid, branch)],
      invalidate: [["overview", pid], ["files", pid], ["worktrees"]],
      run: async (say) => {
        if (checkedOut) {
          say(`Switching to ${base}…`);
          await call("workspace.switch", { projectId: pid, branch: base }).catch((e: Error) => {
            throw new Error(`Couldn't switch to ${base}, ${branch} is kept: ${e.message}`);
          });
          await settle(queryClient, [["overview", pid]], () => queryClient.setQueryData<Overview>(["overview", pid], (o) => o && switchedOverview(o, base)));
          say(`Deleting ${branch}…`);
        }
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
          {checkedOut ? (
            <button className="btn btn-lg btn-danger" onClick={del} disabled={!base}>
              Switch to <span className="mono">{base}</span> and delete
            </button>
          ) : (
            <button className="btn btn-md btn-danger" onClick={del}>
              {exists ? "Delete branch" : "Forget branch"}
            </button>
          )}
        </>
      }
    >
      {exists ? (
        <>
          {checkedOut && (
            <p style={{ margin: 0, lineHeight: 1.55 }}>
              <span className="mono">{branch}</span> is checked out, so git can't delete it.{" "}
              {base ? (
                <>
                  Gitnetix can switch you to its parent, <span className="mono">{base}</span>, then delete it. Uncommitted changes come along unless they clash with{" "}
                  <span className="mono">{base}</span>.
                </>
              ) : (
                "It has no parent to switch to: switch to another branch first."
              )}
            </p>
          )}
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

/** `locked`: why nothing gets committed for now (AI rebasing the branch, or a branch onto it). */
function CommitBox({ pid, branch, enabled, locked, staged, changed }: { pid: string; branch: string; enabled: boolean; locked?: string; staged: number; changed: number }) {
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
  const commit = useCommit(pid);
  const draft = useAction<{ message: string }>("workspace.commitMessage");
  const nav = useNav();
  // Saved with the project, like the merge options.
  const { commit: prefs, setCommit } = useProjectPrefs(pid);
  const autoPush = prefs.autoPush;
  // Per branch, from the shared cache: a commit running on another worktree doesn't block this one.
  const busy = [...usePendingBranches("workspace.commit", pid), ...usePendingBranches("workspace.push", pid)].includes(branch);
  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  const canCommit = canType && !orphanBody && !busy;
  const doCommit = () => commit(branch, message, all).then(clear, () => {});
  // Ctrl/⌘+Enter in the message commits, like most editors' "submit".
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canCommit) {
      e.preventDefault();
      doCommit();
    }
  };
  return (
    <div className="col" style={{ padding: "10px 16px 14px", gap: 8, borderTop: "1px solid var(--line)" }}>
      <div className="row" style={{ justifyContent: "space-between", minHeight: 24, margin: 0 }}>
        <button className="commit-sec" aria-expanded={open} aria-controls="ag-msg" onClick={toggle}>
          <Icon name="chevronDown" size={12} className="chev" />
          <span>Commit message</span>
        </button>
        {open && <button className="btn btn-sm" style={{ height: 24, padding: "0 8px" }} disabled={!enabled || !staged || draft.isPending}
          title={staged ? "AI drafts a message from the staged files" : "Stage files first"} onClick={() => draft.mutate({ projectId: pid, branch }, { onSuccess: (r) => {
            const [first, ...rest] = r.message.split("\n");
            setSummary(first);
            setBody(rest.join("\n").trim());
          } })}>
          <Busy on={draft.isPending}><Icon name="sparkle" size={12} /></Busy>
          Draft
        </button>}
      </div>
      {open && <div id="ag-msg" className="col">
        <input
          id="ag-summary"
          className="input"
          style={{ height: 32, fontSize: 12.5, padding: "0 10px" }}
          placeholder={locked ?? (!enabled ? "Check out this branch to commit" : !changed ? "No changes to commit" : "Summary — leave empty for AI")}
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
          <span>{all ? "Stage all & Commit" : "Commit"}<span style={{ fontWeight: 400, opacity: 0.7, marginLeft: 6 }}>{all ? changed || null : staged}</span></span>
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
            { id: "templates", label: "Show AI templates", icon: "sparkle", run: () => nav.go({ name: "menu", section: "templates" }) },
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
  const reserved = useReservedStart(pid);
  const nav = useNav();
  const message = useAction("agents.message", { invalidate: [["agents"]] });
  const configure = useAction("agents.configure", { invalidate: [["agents"]] });
  const stop = useAction("agents.stop", { invalidate: [["agents"]] });
  const width = usePaneWidth("gnx.pane.termW", 460, 320, 1400);
  const [view, setView] = useTermView(pid, branch, !!cur, worktree);
  const shell = view === "shell";
  // Maximized, the terminal takes the map's or the focus view's place.
  const [max, setMax] = useState(false);
  const [clearing, setClearing] = useState<AgentSession | null>(null);

  if (!open) {
    const st = cur && shownStatus(cur, curBranch);
    return (
      <button className="row term-bar term-closed" onClick={() => setOpen(true)}>
        <Icon name="terminal" />
        <span>
          {shell || !st ? (
            shell ? "Shell" : "Agent"
          ) : (
            <>
              Agent ·{" "}
              {/* Coloured as on Worktrees & agents: the running glow, else the status colour. */}
              <span className={st === "running" ? "glow-working" : STATUS_SHOWN[st][1]}>
                <span>{cur.limit && st === "limited" ? limitLabel(cur.limit).replace(/^./, (c) => c.toLowerCase()) : st}</span>
              </span>
              {cur.status === "running" && cur.tasks?.length ? ` · ${tasksLabel(cur.tasks)} in the background` : ""}
            </>
          )}
        </span>
        {!shell && cur?.status === "running" && <span className="pulse glow-dot" />}
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
    // The panel follows the agent to its new branch.
    else if (reserved.is(branch)) reserved.offer({ request: t, files: up, pick, done: (b) => (done.onSuccess(), revealBranch(pid, b), nav.selectBranch(b)) });
    else start.mutate({ projectId: pid, branch, request: t, files: up, ...pick }, done);
  };
  return (
    <>
      {!max && <Resizer pane={width} label="Resize agents panel" right />}
      <div className={max ? "term term-max" : "term"} style={{ "--term-w": `${width.width}px` } as CSSProperties}>
        {/* Empty parts of the bar collapse it, like the closed bar opens it. */}
        <div className="term-tabs term-bar" style={{ cursor: "pointer" }} onClick={(e) => !(e.target as HTMLElement).closest("button, select, input") && setOpen(false)}>
          {/* Only the right side grows, so the session label sits left, after the tabs. */}
          <div className="term-side" style={{ flex: "none" }}>
            <TermTabs value={view} onChange={setView} path={cwd} />
          </div>
          {!shell && cur && (
            <>
              <span className="term-tab" style={{ borderLeft: 0 }}>
                {cur.status === "running" && <span className="pulse glow-dot" />}
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
            <button className="btn btn-ghost btn-icon" style={{ width: 34, height: "auto", border: 0, borderLeft: "1px solid var(--line)", borderRadius: 0 }} aria-label={max ? "Restore terminal size" : "Expand terminal"} aria-pressed={max} data-tip={max ? "Restore" : "Expand"} onClick={() => setMax(!max)}>
              <Icon name={max ? "minimize" : "maximize"} size={16} />
            </button>
            <button className="btn btn-ghost btn-icon term-collapse" style={{ width: 34, height: "auto", border: 0, borderLeft: "1px solid var(--line)", borderRadius: 0 }} aria-label="Collapse agents" onClick={() => setOpen(false)}>
              <Icon name="chevronDown" size={16} />
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
              provider={cur ? cur.ai?.provider : pick.provider}
              thinking={cur?.status === "running" || start.isPending || reserved.pending || message.isPending}
              working={busy}
              queued={cur?.queued}
              onEditQueued={(q) => setText((t) => [q, t].filter(Boolean).join("\n\n"))}
              canSendNow={cur?.ai?.provider === "claude" && !!cur.resumeId}
              limit={cur?.limit}
              asks={cur?.asks}
              tasks={cur?.tasks}
              onCancelLimit={cur ? () => halt(cur) : undefined}
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
                    : reserved.is(branch)
                      ? `${branch} is reserved: describe the work below and the agent starts on a new branch off it, in its own worktree.`
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
              pending={start.isPending || reserved.pending || message.isPending}
              picker={!cur ? <AgentPicker value={pick} onChange={setPick} compact /> : cur.ai && <AgentPicker value={cur.ai} onChange={(p) => configure.mutate({ id: cur.id, ...p })} compact />}
              placeholder={busy ? "Agent is working… a message now waits for it to finish" : cur?.limit ? "Stopped at a usage limit… a message continues the agent now" : cur ? "Reply to the agent…" : "Ask the agent anything…"}
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
      {reserved.modal}
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

/** The default branch takes no agent (the backend refuses it): `offer` asks instead to start the agent on a new branch off it, in its own worktree.
 * `done` gets the new branch once the agent runs there. `modal` is that question: render it. */
export function useReservedStart(pid: string) {
  const main = useOverview(pid).data?.defaultBranch;
  // Config: a prefix the AI used for the first time joined the project's branch types.
  const create = useAction<{ branch: string }>("items.create", { invalidate: [["agents"], ["worktrees"], ["overview", pid], ["config"]], success: (r) => `Agent started on ${r.branch}` });
  const [ask, setAsk] = useState<{ request: string; files: Upload[]; pick: AgentPick; done: (branch: string) => void } | null>(null);
  const close = () => setAsk(null);
  // Empty name: the backend names the branch from the request, so a request is needed.
  const ready = !!ask?.request.trim();
  const go = () => {
    if (!ask || !ready) return;
    close();
    create.mutate({ projectId: pid, from: main, description: ask.request, where: "worktree", startAgent: true, files: ask.files, ...ask.pick }, { onSuccess: (r) => ask.done(r.branch) });
  };
  return {
    is: (branch?: string) => !!branch && branch === main,
    offer: setAsk,
    pending: create.isPending,
    modal: ask && main && (
      <Modal
        title={`${main} is reserved`}
        onClose={close}
        footer={
          <>
            <button className="btn btn-md" onClick={close}>Back</button>
            <button className="btn btn-primary btn-md" autoFocus disabled={!ready} onClick={go}>
              <Icon name="branch" size={12} />
              Create branch and start
            </button>
          </>
        }
      >
        <p style={{ margin: 0, lineHeight: 1.55 }}>
          Agents don't work on <strong className="c-acc">{main}</strong>. Everything is ready to start this one on a new branch off <strong className="c-acc">{main}</strong>, in its own worktree. The branch is named from your request.
        </p>
        {!ready && <p className="hint c-del">Type a request first: the new branch is named from it.</p>}
      </Modal>
    ),
  };
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
      <span className="split-btn" style={{ display: "flex", flex: "1 1 0", minWidth: 0 }}>
        <button type="button" className={`btn btn-md btn-primary${then === "merge" ? " split-main" : ""}`} style={{ flex: "1 1 auto", minWidth: 0 }} onClick={() => { finish[then](s, sw, into); onClose(); }}>
          <span className="ellipsis">{then === "merge" && target ? `Finish and merge into ${target}…` : `Finish with the agent / worktree${then === "merge" ? "…" : ""}`}</span>
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

/** A base64 blob as UTF-8 text; null when it is binary (holds a NUL byte). */
// A picture in Markdown or an <img>.
const ANY_PICTURE = /!\[[^\]]*\]\(|<img\s/i;

/** Where a picture link of the Markdown file at `file` points in the repository: next to the file, or from the root with
 * a leading "/", as on GitHub. Undefined for a web link or one that climbs out of the repository. */
export function repoPath(file: string, src: string): string | undefined {
  if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(src)) return undefined;
  let link = src.replace(/[?#].*$/, "");
  try {
    link = decodeURIComponent(link);
  } catch {
    // A stray "%" stays as written.
  }
  const parts = link.startsWith("/") ? [] : file.split("/").slice(0, -1);
  for (const p of link.split("/")) {
    if (p === "..") {
      if (!parts.pop()) return undefined;
    } else if (p && p !== ".") parts.push(p);
  }
  return parts.join("/") || undefined;
}

function decodeText(b64: string | null | undefined): string | null | undefined {
  if (b64 == null) return b64;
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return bytes.includes(0) ? null : new TextDecoder().decode(bytes);
}
