import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { useAction, useAgents, useAiCatalog, useDiff, useFiles, useOverview } from "../api/hooks";
import type { BranchView, FileChange, MergeResult, ReleaseView } from "../api/types";
import { AgentLog } from "../components/AgentLog";
import { DiffView } from "../components/DiffView";
import { Icon } from "../components/Icon";
import { Resizer, usePaneWidth } from "../components/Resizer";
import { Busy, ErrorBox, Loading, Modal, Seg } from "../components/ui";
import { useNav } from "../lib/nav";
import { useStoredChoice, useStoredFlag } from "../lib/stored";
import { useBranchActions, type BranchDialog, type BranchTarget } from "./BranchMenu";
import { BranchTree } from "./BranchTree";
import { ConflictModal } from "./ConflictModal";

type Mode = "branch" | "wip" | "project";
type Pane = "releases" | "files" | "diff";

export function Workspace() {
  const nav = useNav();
  const pid = nav.projectId!;
  const ov = useOverview(pid);
  const [mode, setMode] = useState<Mode>("wip");
  const [file, setFile] = useState<string | undefined>();
  const [diffMode, setDiffMode] = useState<"unified" | "split">("unified");
  const [termOpen, setTermOpen] = useState(true);
  const [pane, setPane] = useState<Pane>("releases");
  const [shipping, setShipping] = useState<ReleaseView | null>(null);
  const [dialog, setDialog] = useState<{ kind: BranchDialog; branch: string } | null>(null);
  const branchesW = usePaneWidth("gnx.pane.branches", 300, 220, 560);
  const filesW = usePaneWidth("gnx.pane.files", 320, 220, 640);
  const [branchesHidden, setBranchesHidden] = useStoredFlag("gnx.pane.branchesHidden");
  const actions = useBranchActions(pid, (kind, branch) => setDialog({ kind, branch }));

  const o = ov.data;
  const byName = useMemo(() => new Map((o?.branches ?? []).map((b) => [b.name, b])), [o]);
  const branch = nav.selectedBranch ?? o?.currentBranch ?? o?.defaultBranch ?? undefined;
  const baseFor = (b: string) => byName.get(b)?.parent ?? "";
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
    return {
      view: v,
      base,
      baseLabel: labelOf(base),
      isDefault: b === o?.defaultBranch,
      isRelease: !!rel,
      extra: rel
        ? [
            { id: "new-item", label: <>New feature or fix in v{rel.version}…</>, icon: "plus", run: () => nav.openNewItem({ release: rel.version }) },
            { id: "ship", label: <>Ship v{rel.version}…</>, icon: "ship", hint: "fast-forward + tag", run: () => setShipping(rel) },
          ]
        : v.role === "trunk" && v.exists
          ? [{ id: "new-branch", label: <>New branch off <span className="mono">{b}</span>…</>, icon: "plus", run: () => nav.openNewItem({ from: b }) }]
          : undefined,
      next: rel
        ? { id: "ship", label: `Ship v${rel.version}…`, short: "Ship", tip: `Fast-forward ${o?.defaultBranch} to ${b} and tag v${rel.version}`, icon: "ship", disabled: !v.ahead, run: () => setShipping(rel) }
        : undefined,
      // Work branches can be re-targeted to any release or trunk.
      moveTo:
        v.role === "branch" && v.exists && !b.startsWith("release/")
          ? targets.filter((x) => x.name !== base && x.name !== b).map((x) => ({ branch: x.name, label: labelOf(x.name) }))
          : undefined,
    };
  };
  const view: BranchView | undefined = branch ? byName.get(branch) : undefined;
  const dialogView = dialog && (byName.get(dialog.branch) ?? synthetic(dialog.branch, dialog.branch === o?.currentBranch));
  const base = branch ? baseFor(branch) : "";
  const checkedOut = view?.checkedOut ?? branch === o?.currentBranch;

  const files = useFiles(pid, branch, mode);
  const wipList = useFiles(pid, branch, "wip").data ?? [];
  const wipCount = new Set(wipList.map((f) => f.path)).size;
  const stagedCount = wipList.filter((f) => f.staged).length;
  const branchCount = useFiles(pid, branch, "branch").data?.length ?? 0;
  const list = files.data ?? [];
  const fileCount = new Set(list.map((f) => f.path)).size;
  const current = list.find((f) => fileKey(f) === file) ?? list[0];
  const diff = useDiff(pid, branch, mode, current?.path, current?.staged);
  const [discarding, setDiscarding] = useState<{ staged: boolean; paths: string[] } | null>(null);

  useEffect(() => setFile(undefined), [branch, mode]);

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
          />

          {!branchesHidden && <Resizer pane={branchesW} label="Resize branches panel" />}
          <section aria-label="Changed files" className="ws-files" data-pane data-active={pane === "files"}>
            <div className="col" style={{ gap: 10, padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
              <div className="row" style={{ alignItems: "baseline", minWidth: 0 }}>
                <span className="mono ellipsis" style={{ fontSize: 13, fontWeight: 500 }}>{branch ?? "No branch"}</span>
                {base && branch !== base && <span className="faint" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>{view?.merged ? "merged into" : "from"} {base}</span>}
                {view?.merged && <span className="c-add row" style={{ marginLeft: 6, flex: "0 0 auto" }} title={`All commits are in ${base}`}><Icon name="merged" size={12} stroke={1.6} label="merged" /></span>}
              </div>
              <Seg<Mode>
                label="File view"
                grid
                value={mode}
                onChange={setMode}
                options={[
                  { value: "wip", label: <>WIP <span className="faint">{wipCount}</span></> },
                  { value: "branch", label: <>Branch <span className="faint">{branchCount}</span></> },
                  { value: "project", label: "Project" },
                ]}
              />
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
              {mode === "wip" && branch && list.length > 0 ? (
                <WipList
                  pid={pid}
                  branch={branch}
                  list={list}
                  current={current}
                  onPick={(f) => { setFile(fileKey(f)); setPane("diff"); }}
                  onMoved={(f) => current && fileKey(current) === fileKey(f) && setFile(fileKey({ ...f, staged: !f.staged }))}
                  onDiscard={(staged, paths) => setDiscarding({ staged, paths })}
                />
              ) : (
                list.map((f) => (
                  <li key={fileKey(f)}>
                    <FileRow f={f} active={f === current} onPick={() => { setFile(fileKey(f)); setPane("diff"); }} />
                  </li>
                ))
              )}
              {!files.isLoading && list.length === 0 && (
                <li className="empty">{mode === "wip" ? (checkedOut ? "No uncommitted changes." : "This branch is not checked out.") : "No changes on this branch yet."}</li>
              )}
            </ul>
            {branch && <CommitBox pid={pid} branch={branch} enabled={checkedOut} staged={stagedCount} changed={wipCount} />}
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
              <Seg value={diffMode} onChange={setDiffMode} label="Diff mode" options={[{ value: "unified", label: "Unified" }, { value: "split", label: "Split" }]} />
            </div>
            <div className="diff">
              {diff.isLoading && current && <Loading />}
              {diff.error && <div style={{ padding: 16 }}><ErrorBox error={diff.error} /></div>}
              {diff.data && diff.data.length > 0 && <DiffView hunks={diff.data} mode={diffMode} />}
              {(!current || (diff.data && diff.data.length === 0)) && (
                <div className="empty" style={{ fontFamily: "var(--sans)" }}>
                  {list.length === 0 ? "Nothing to show — working tree is clean." : "No textual changes in this file."}
                </div>
              )}
            </div>
            <Terminal pid={pid} branch={branch} checkedOut={checkedOut} open={termOpen} setOpen={setTermOpen} />
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
        <MergeModal pid={pid} branch={dialog.branch} base={baseFor(dialog.branch)} onClose={() => setDialog(null)} checkedOut={dialogView.checkedOut && !dialogView.worktree} onDeleted={(into) => dialog.branch === branch && nav.selectBranch(into)} />
      )}
      {dialog?.kind === "delete" && dialogView && (
        <DeleteBranchModal
          pid={pid}
          branch={dialog.branch}
          base={baseFor(dialog.branch)}
          exists={dialogView.local}
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
    conflict: false,
    ahead: 0,
    behind: 0,
    upstreamAhead: 0,
    upstreamBehind: 0,
    exists: true,
    merged: false,
    role: "branch",
    local: true,
    remote: false,
    date: "",
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
  onPick,
  onMoved,
  onDiscard,
}: {
  pid: string;
  branch: string;
  list: FileChange[];
  current?: FileChange;
  onPick: (f: FileChange) => void;
  onMoved: (f: FileChange) => void;
  onDiscard: (staged: boolean, paths: string[]) => void;
}) {
  const inv = [["files", pid], ["diff", pid], ["overview", pid]];
  const stage = useAction("workspace.stage", { invalidate: inv });
  const unstage = useAction("workspace.unstage", { invalidate: inv });
  const busy = stage.isPending || unstage.isPending;
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const move = (staged: boolean, f?: FileChange) =>
    (staged ? unstage : stage).mutate({ projectId: pid, branch, paths: f ? [f.path] : [] }, { onSuccess: () => f && onMoved(f) });

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
              {side.map((f) => (
                <li key={fileKey(f)}>
                  <FileRow
                    f={f}
                    active={f === current}
                    onPick={() => onPick(f)}
                    actions={
                      <>
                        <button
                          className="btn btn-ghost btn-act"
                          title={staged ? "Unstage" : "Stage"}
                          aria-label={`${staged ? "Unstage" : "Stage"} ${f.path}`}
                          disabled={busy}
                          onClick={() => move(staged, f)}
                        >
                          <Icon name={staged ? "minus" : "plus"} size={12} />
                        </button>
                        <button
                          className="btn btn-ghost btn-act btn-danger"
                          title="Discard changes"
                          aria-label={`Discard ${staged ? "staged" : "unstaged"} changes to ${f.path}`}
                          disabled={busy}
                          onClick={() => onDiscard(staged, [f.path])}
                        >
                          <Icon name="undo" size={12} />
                        </button>
                      </>
                    }
                  />
                </li>
              ))}
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

function FileRow({ f, active, onPick, actions }: { f: FileChange; active: boolean; onPick: () => void; actions?: ReactNode }) {
  const cut = f.path.lastIndexOf("/");
  const base = cut >= 0 ? f.path.slice(cut + 1) : f.path;
  const dir = cut >= 0 ? f.path.slice(0, cut) : "";
  const color = { A: "c-add", D: "c-del", C: "c-acc", M: "c-mod", R: "c-mod", " ": "faint" }[f.status] ?? "faint";
  const btn = (
    <button className="file-btn" aria-pressed={active} onClick={onPick}>
      <span className={`file-st ${color}`}>{f.status === " " ? "·" : f.status}</span>
      <span className="grow ellipsis" data-tip={f.path} data-tip-overflow>
        <span style={{ color: f.status === " " ? "var(--muted)" : "var(--fg)" }}>{base}</span> <span className="faint" style={{ fontSize: 11.5 }}>{dir}</span>
      </span>
      <span className="row mono file-nums" style={{ gap: 6, fontSize: 11 }}>
        {f.additions > 0 && <span className="c-add">+{f.additions}</span>}
        {f.deletions > 0 && <span className="c-del">−{f.deletions}</span>}
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

function MergeModal({ pid, branch, base, checkedOut, onClose, onDeleted }: { pid: string; branch: string; base: string; checkedOut: boolean; onClose: () => void; onDeleted: (into: string) => void }) {
  const [del, setDel] = useState(false);
  const merge = useAction<MergeResult>("branches.merge", {
    invalidate: [["overview", pid], ["files", pid], ["diff", pid]],
    success: (r) => `${r.alreadyMerged ? `${branch} was already in ${r.into}` : `Merged ${branch} into ${r.into}`}${r.switched ? ` · switched to ${r.into}` : ""}${r.deleted ? " · branch deleted" : ""}`,
  });
  return (
    <Modal
      title="Merge branch"
      sub={<span className="mono">{branch} → {base}</span>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary btn-md"
            disabled={merge.isPending}
            onClick={() => merge.mutate({ projectId: pid, branch, deleteBranch: del }, { onSuccess: (r) => { if (r.deleted) onDeleted(r.into); onClose(); } })}
          >
            {merge.isPending && <span className="spinner" />}
            Merge into {base}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        Creates a merge commit on <span className="mono">{base}</span> — no need to check it out. If {base} is checked out, it must have no uncommitted changes.
        Nothing changes when the merge would conflict: rebase onto {base} and resolve first.
      </p>
      {merge.error && <ErrorBox error={merge.error} />}
      <label className="check">
        <input type="checkbox" checked={del} onChange={() => setDel(!del)} />
        <span>Delete <span className="mono">{branch}</span> after merging{checkedOut ? <> and switch to <span className="mono">{base}</span></> : null}</span>
      </label>
    </Modal>
  );
}

function DeleteBranchModal({
  pid,
  branch,
  base,
  exists,
  worktree,
  onClose,
  onDeleted,
}: {
  pid: string;
  branch: string;
  base: string;
  exists: boolean;
  worktree?: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [force, setForce] = useState(false);
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
            onClick={() => del.mutate({ projectId: pid, branch, force }, { onSuccess: () => { onDeleted(); onClose(); } })}
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
            Deletes the local branch <span className="mono">{branch}</span>
            {worktree && <> and its worktree at <span className="mono">{worktree}</span></>}. The remote branch is kept.
          </p>
          {del.error && <ErrorBox error={del.error} />}
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

const MSG_OPEN_KEY = "gitnetix.commitMessageOpen";

function CommitBox({ pid, branch, enabled, staged, changed }: { pid: string; branch: string; enabled: boolean; staged: number; changed: number }) {
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const ai = useAiCatalog().data;
  // Same lookup the backend does for the "commit" task: its route's provider, else the default.
  const aiProvider = ai && (ai.routing.commit?.provider || ai.defaultProvider);
  const aiOn = !ai || !!ai.providers.find((p) => p.info.id === aiProvider)?.conf;
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
  const inv = [["overview", pid], ["files", pid], ["diff", pid]];
  const commit = useAction<{ sha: string; message: string; aiWritten: boolean }>("workspace.commit", {
    invalidate: inv,
    success: (r) => `${r.aiWritten ? "AI wrote: " : "Committed: "}${r.message.split("\n")[0]}`,
  });
  const draft = useAction<{ message: string }>("workspace.commitMessage");
  return (
    <div className="col" style={{ padding: 12, borderTop: "1px solid var(--line)" }}>
      <div className="row faint" style={{ justifyContent: "space-between", fontSize: 11 }}>
        <button className="row" style={{ gap: 6, padding: 0, border: 0, background: "transparent", color: "inherit", font: "inherit", cursor: "pointer" }} aria-expanded={open} aria-controls="ag-msg" onClick={toggle}>
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
      <button className="btn btn-primary" style={{ height: 34, width: "100%" }} disabled={!canType || orphanBody || commit.isPending}
        title={orphanBody ? "Add a summary to go with the description" : undefined}
        onClick={() => commit.mutate({ projectId: pid, branch, message, all }, { onSuccess: clear })}>
        <Busy on={commit.isPending}><Icon name="sparkle" size={12} /></Busy>
        <span>{all ? "Stage all & Commit" : "Commit"}<span style={{ fontWeight: 400, opacity: 0.75, marginLeft: 6 }}>{all ? changed || null : staged}</span></span>
      </button>
    </div>
  );
}

function Terminal({ pid, branch, checkedOut, open, setOpen }: { pid: string; branch?: string; checkedOut: boolean; open: boolean; setOpen: (b: boolean) => void }) {
  const agents = useAgents();
  const sessions = (agents.data ?? []).filter((a) => a.projectId === pid);
  const [active, setActive] = useState<string | "new" | undefined>();
  const [text, setText] = useState("");
  const forBranch = sessions.find((s) => s.branch === branch);
  const cur = active === "new" ? undefined : sessions.find((s) => s.id === active) ?? forBranch ?? sessions[0];
  const start = useAction<{ id: string }>("agents.start", { invalidate: [["agents"]] });
  const message = useAction("agents.message", { invalidate: [["agents"]] });
  const running = sessions.filter((s) => s.status === "running").length;

  if (!open) {
    return (
      <button className="row" style={{ height: 34, flex: "0 0 34px", padding: "0 14px", border: 0, borderTop: "1px solid var(--line)", background: "var(--panel)", color: "var(--muted)", textAlign: "left" }} onClick={() => setOpen(true)}>
        <Icon name="terminal" />
        <span>Agents · {sessions.length} {sessions.length === 1 ? "session" : "sessions"}</span>
        {running > 0 && <span className="pulse" />}
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
        { projectId: pid, branch: checkedOut ? branch : undefined, request: t },
        { onSuccess: (s) => { setText(""); setActive(s.id); } },
      );
    }
  };
  return (
    <div className="term">
      <div className="term-tabs">
        <div className="row muted" style={{ padding: "0 10px 0 14px" }}>
          <Icon name="terminal" label="Agents" />
        </div>
        {sessions.map((s) => (
          <button key={s.id} className="term-tab" aria-pressed={s.id === cur?.id} onClick={() => setActive(s.id)}>
            {s.status === "running" && <span className="pulse" />}
            <span className="mono" style={{ fontSize: 11.5 }}>{s.branch}</span>
            <span className="faint" style={{ fontSize: 11 }}>{s.worktree ? "worktree" : "branch"}</span>
          </button>
        ))}
        <button className="term-tab" aria-label="New agent session" aria-pressed={active === "new"} onClick={() => setActive("new")}>
          <Icon name="plus" size={12} stroke={1.6} />
        </button>
        <span className="grow" />
        <span className="row faint hide-narrow" style={{ padding: "0 10px", fontSize: 11.5, whiteSpace: "nowrap" }}>{cur?.agentLabel ?? "New session"}</span>
        <button className="btn btn-ghost" style={{ width: 36, height: "auto", border: 0, borderRadius: 0 }} aria-label="Collapse agents" onClick={() => setOpen(false)}>
          <Icon name="chevronDown" size={13} />
        </button>
      </div>
      <AgentLog
        lines={cur?.lines ?? []}
        empty={
          cur
            ? undefined
            : checkedOut
              ? `Start an agent on ${branch}: describe what it should do below.`
              : "This branch is not checked out — the agent will run on the main checkout. Open the branch in a worktree to give it its own."
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
          placeholder={busy ? "Agent is working…" : cur ? "Reply to the agent…" : "Ask the agent anything — “squash my last 3 commits”, “add tests for the CSV export”…"}
        />
        {(start.isPending || message.isPending) && <span className="spinner" />}
      </form>
    </div>
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
