import { useState } from "react";

import { useAction, useFiles } from "../api/hooks";
import type { InProgress, RebaseResult } from "../api/types";
import { Icon } from "../components/Icon";
import { Busy, Confirm, Modal } from "../components/ui";
import { rebaseMessage } from "./BranchMenu";

/** Confirms aborting the rebase, merge, cherry-pick or revert `branch`'s checkout is stopped in. `base`: where a rebase goes. */
export function AbortModal({ pid, branch, op: opened, base, onBack, onDone }: { pid: string; branch: string; op?: InProgress | null; base?: string; onBack: () => void; onDone: () => void }) {
  // The one it opened on: once aborted, the refreshed overview has none left before this closes.
  const [op] = useState(opened);
  const abort = useAction("workspace.abort", { invalidate: [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid]], success: `Aborted the ${op} of ${branch}` });
  if (!op) return null;
  return (
    <Confirm
      title={`Abort ${op}`}
      sub={op === "rebase" && base ? <>Rebasing <span className="mono">{branch}</span> onto <span className="mono">{base}</span></> : <span className="mono">{branch}</span>}
      action={`Abort ${op}`}
      busy={abort.isPending}
      onBack={onBack}
      onConfirm={() => abort.mutate({ projectId: pid, branch }, { onSuccess: onDone })}
    >
      <span className="mono">{branch}</span> goes back to where it was before the {op}
      {op === "rebase" && ", with the uncommitted changes it had then"}. Every conflict resolved so far is lost.
    </Confirm>
  );
}

export function ConflictModal({ pid, branch, base, onClose, onDone }: { pid: string; branch: string; base: string; onClose: () => void; onDone?: (r: RebaseResult) => void }) {
  const files = useFiles(pid, branch, "wip");
  const conflicted = (files.data ?? []).filter((f) => f.status === "C");
  const [sel, setSel] = useState<string | undefined>();
  const [proposal, setProposal] = useState<Record<string, string>>({});
  const [aborting, setAborting] = useState(false);
  const path = sel ?? conflicted[0]?.path;
  const inv = [["overview", pid], ["files", pid], ["diff", pid]];
  const propose = useAction<{ content: string }>("workspace.conflictPropose");
  const apply = useAction("workspace.conflictApply", { invalidate: inv, success: `Resolved ${path}` });
  const cont = useAction<RebaseResult>("workspace.rebaseContinue", {
    invalidate: inv,
    success: (r) => (r.conflicts.length ? `Next commit has ${r.conflicts.length} conflict(s)` : rebaseMessage(r)),
  });

  // Replaces this modal rather than stacking on it: one Escape would close both. Back keeps the AI proposals.
  if (aborting) return <AbortModal pid={pid} branch={branch} op="rebase" base={base} onBack={() => setAborting(false)} onDone={onClose} />;
  return (
    <Modal
      title="Resolve conflicts"
      sub={<>Rebasing <span className="mono">{branch}</span> onto <span className="mono">{base}</span></>}
      onClose={onClose}
      width={880}
      footer={
        <>
          <button className="btn btn-md btn-danger" onClick={() => setAborting(true)}>Abort rebase</button>
          <button
            className="btn btn-primary btn-md"
            disabled={conflicted.length > 0 || cont.isPending}
            onClick={() =>
              cont.mutate({ projectId: pid, branch }, {
                onSuccess: (r) => {
                  if (r.conflicts.length) return;
                  onDone?.(r);
                  onClose();
                },
              })
            }
          >
            {cont.isPending && <span className="spinner" />}
            Continue rebase
          </button>
        </>
      }
    >
      {files.isLoading && <span className="spinner" />}
      {conflicted.length === 0 && !files.isLoading && <div className="note-box">No conflicted files left. Continue the rebase.</div>}
      {conflicted.length > 0 && (
        <div className="row" style={{ alignItems: "stretch", gap: 16, minHeight: 360 }}>
          <ul className="list" style={{ flex: "0 0 240px", alignSelf: "flex-start" }}>
            {conflicted.map((f) => (
              <li key={f.path}>
                <button className="file-btn" aria-pressed={f.path === path} onClick={() => setSel(f.path)}>
                  <span className="file-st c-acc">C</span>
                  <span className="ellipsis mono" style={{ fontSize: 12 }}>{f.path}</span>
                </button>
              </li>
            ))}
          </ul>
          {path && (
            <div className="col grow" style={{ minWidth: 0 }}>
              <div className="row">
                <span className="mono ellipsis grow">{path}</span>
                <button className="btn" disabled={propose.isPending} onClick={() => propose.mutate({ projectId: pid, branch, path }, { onSuccess: (r) => setProposal({ ...proposal, [path]: r.content }) })}>
                  <Busy on={propose.isPending}><Icon name="sparkle" size={12} /></Busy>
                  {proposal[path] ? "Propose again" : "Propose with AI"}
                </button>
              </div>
              {proposal[path] !== undefined ? (
                <>
                  <label htmlFor="cf-body" className="hint">Review and edit the resolved file, then apply. It is staged, not committed.</label>
                  <textarea id="cf-body" className="textarea mono" style={{ fontSize: 12, minHeight: 320, flex: 1 }} value={proposal[path]} onChange={(e) => setProposal({ ...proposal, [path]: e.target.value })} />
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    <button
                      className="btn btn-primary"
                      disabled={apply.isPending || /^(<<<<<<<|>>>>>>>)/m.test(proposal[path])}
                      onClick={() => apply.mutate({ projectId: pid, branch, path, content: proposal[path] }, { onSuccess: () => setSel(undefined) })}
                    >
                      <Icon name="check" size={12} />
                      Apply and stage
                    </button>
                  </div>
                </>
              ) : (
                <div className="empty card">The AI reads the file with its conflict markers and proposes a resolution using your conflict template. You review it before anything is written.</div>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
