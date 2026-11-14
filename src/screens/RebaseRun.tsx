import { useEffect, useState } from "react";

import { queryClient, useOverview, useProjects } from "../api/hooks";
import { rpc } from "../api/transport";
import type { RebaseResult, RebaseRun } from "../api/types";
import { Icon } from "../components/Icon";
import { ErrorBox, Modal } from "../components/ui";
import { plural, timeLeft } from "../lib/format";
import { useNav } from "../lib/nav";
import { dismiss, heard, retrying, runKey, setMin, shownRun, startedFromHere, useRuns, type ShownRun } from "../lib/rebaseRuns";
import { call } from "../lib/tasks";
import { toast } from "../lib/toast";
import { AbortModal } from "./AbortModal";

/** Toast for a finished or stopped rebase; none when the run's window tells it (AI could not resolve a file, aborted). */
export const rebaseMessage = (r: RebaseResult) =>
  r.aborted || r.errors.length
    ? undefined
    : r.stashConflicts.length
      ? `Rebased, but your uncommitted changes conflict in ${plural(r.stashConflicts.length, "file")}. They are also in the "autostash" stash${r.forcePushTo ? `. Force push to update ${r.forcePushTo}` : ""}`
      : r.conflicts.length
      ? `Rebase stopped on ${plural(r.conflicts.length, "conflict")}: resolve with AI, or abort`
      : `Rebased${r.resolved ? `, AI resolved ${plural(r.resolved, "conflicted file")}` : ", no conflicts"}${
          // Already on origin: the rewritten commits only go up forced.
          r.forcePushTo ? `. Force push to update ${r.forcePushTo}` : ""
        }`;

/**
 * Rebase `branch` onto `onto` (none: its target), or with `resume` carry its paused rebase on. AI resolves the
 * conflicts of every commit on the way, its progress in a window that opens once it starts. Toasts how it went;
 * undefined once it failed.
 */
export async function startRebase(pid: string, branch: string, opts: { onto?: string; resume?: boolean } = {}): Promise<RebaseResult | undefined> {
  const key = runKey(pid, branch);
  startedFromHere(key, true);
  retrying(key);
  try {
    // A step like a `useAction` of the method: the branch's row shows it busy.
    const r = await call<RebaseResult>(opts.resume ? "workspace.rebaseContinue" : "workspace.rebase", { projectId: pid, branch, onto: opts.onto });
    const msg = rebaseMessage(r);
    if (msg) toast(msg, r.conflicts.length || r.stashConflicts.length ? "info" : "ok");
    return r;
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), "error");
    return undefined;
  } finally {
    startedFromHere(key, false);
    // Refused before it started, or done before AI had anything to do: its last news, if any, comes as an event.
    if (shownRun(key)?.run.state === "running") dismiss(key);
    for (const k of [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid], ["worktrees"]]) queryClient.invalidateQueries({ queryKey: k });
  }
}

/** Every rebase AI is carrying through: its window, or its chip once minimized. Mounted once, in the app shell. */
export function RebaseRuns() {
  const runs = useRuns();
  // Runs going on before this window opened (a reload, another device started them).
  useEffect(() => {
    rpc<RebaseRun[]>("workspace.rebaseRuns").then((l) => l.forEach(heard), () => undefined);
  }, []);
  return (
    <>
      {[...runs.entries()].map(([key, s]) => (
        <Run key={key} id={key} s={s} />
      ))}
    </>
  );
}

/** The time now, again every second. */
function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** "4:05", "1:02:30". */
function duration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60) % 60);
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm.padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

/** How far along the run is, from 0 to 1: the commits done, and the share of this one's files answered for. */
const doneShare = (r: RebaseRun) => (r.steps ? Math.min(1, (Math.max(0, r.step - 1) + (r.files.length ? r.resolved / r.files.length : 0)) / r.steps) : 0);

function Run({ id, s }: { id: string; s: ShownRun }) {
  const { run, min } = s;
  const nav = useNav();
  const ov = useOverview(run.projectId).data;
  const project = useProjects().data?.find((p) => p.id === run.projectId)?.name;
  const [aborting, setAborting] = useState(false);
  const now = useNow();
  const failed = run.state === "failed";
  const elapsed = (s.endedAt ?? now) - (Date.parse(run.startedAt) || now);
  // A release branch reads as its version.
  const onto = ((b) => (b?.role === "release" && b.release ? `v${b.release}` : run.onto))(ov?.branches.find((b) => b.name === run.onto));
  const share = doneShare(run);
  // Rough: commits without conflicts go by in a blink, those with some take minutes.
  const left = !failed && share > 0.05 && elapsed > 20_000 ? timeLeft((elapsed / share - elapsed) / 1000) : undefined;
  const at = run.steps ? `${run.step}/${run.steps}` : undefined;
  const other = run.projectId !== nav.projectId && project;

  if (aborting)
    return (
      <AbortModal
        pid={run.projectId}
        branch={run.branch}
        op="rebase"
        base={onto}
        onBack={() => setAborting(false)}
        onDone={() => {
          setAborting(false);
          dismiss(id);
        }}
      />
    );
  if (min)
    return (
      <button className={`btn start-chip run-chip${failed ? " run-chip-failed" : ""}`} data-tip={failed ? "The rebase stopped: see why" : `AI is rebasing ${run.branch} onto ${onto}: show progress`} onClick={() => setMin(id, false)}>
        {failed ? <Icon name="alert" size={13} /> : <span className="spinner" />}
        <span className="mono ellipsis" style={{ maxWidth: 220 }}>{run.branch}</span>
        <span className="faint">{failed ? "stopped" : [at, duration(elapsed)].filter(Boolean).join(" · ")}</span>
      </button>
    );
  return (
    <Modal
      title={failed ? "Rebase stopped" : "Resolving the rebase with AI"}
      sub={
        <>
          {other && <>{other} · </>}
          <span className="mono">{run.branch}</span> onto <span className="mono">{onto}</span>
        </>
      }
      // Running, it only goes to the corner; stopped, the WIP panel still offers to try again or abort.
      minimize={!failed}
      onClose={failed ? () => dismiss(id) : () => setMin(id, true)}
      width={560}
      footer={
        <>
          <button className="btn btn-md btn-danger" onClick={() => setAborting(true)}>
            Abort rebase
          </button>
          {failed ? (
            <button className="btn btn-md btn-primary" autoFocus onClick={() => void startRebase(run.projectId, run.branch, { resume: true })}>
              <Icon name="sparkle" size={13} />
              Try again
            </button>
          ) : (
            <button className="btn btn-md btn-primary" autoFocus onClick={() => setMin(id, true)}>
              Keep working
            </button>
          )}
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        {failed && <ErrorBox error={run.error ?? "The rebase stopped."} />}
        <div className="col" style={{ gap: 8 }}>
          <div className="row" style={{ justifyContent: "space-between", fontSize: 12.5 }}>
            <span>{run.steps ? <>Commit <b>{run.step}</b> of {run.steps}</> : "Replaying commits"}</span>
            <span className="faint mono">
              {duration(elapsed)}
              {left && ` · ${left}`}
            </span>
          </div>
          <div className="run-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} data-failed={failed || undefined}>
            <span style={{ width: `${Math.max(3, share * 100)}%` }} />
          </div>
          {run.subject && <span className="mono ellipsis faint" style={{ fontSize: 12 }} title={run.subject}>{run.subject}</span>}
        </div>
        {run.files.length > 0 && (
          <div className="col" style={{ gap: 6 }}>
            <span className="hint">
              {failed ? "Conflicted files in this commit" : `AI resolving ${plural(run.files.length, "conflicted file")}`} · {run.resolved} done
              {run.resolvedTotal > run.resolved && ` · ${run.resolvedTotal - run.resolved} resolved in earlier commits`}
            </span>
            <ul className="run-files">
              {run.files.map((f) => (
                <li key={f} className="row" title={f} style={{ gap: 8 }}>
                  <span className="mono ellipsis grow">{f}</span>
                  {run.secondPass.includes(f) && <span className="c-warn" style={{ flex: "none" }}>second pass</span>}
                </li>
              ))}
            </ul>
            {!failed && run.secondPass.length > 0 && (
              <span className="hint">
                The first {run.secondPass.length === 1 ? "answer for this file" : "answers for these files"} could not be used: AI goes over{" "}
                {run.secondPass.length === 1 ? "it" : "them"} again and has to settle {run.secondPass.length === 1 ? "it" : "them"}.
              </span>
            )}
          </div>
        )}
        <p className="hint" style={{ margin: 0 }}>
          {failed ? (
            <>Nothing is lost: the commits rebased and the files resolved so far stay. Try again, or abort to put <span className="mono">{run.branch}</span> back as it was.</>
          ) : (
            <>Every commit goes through without you. Click outside to keep working: it carries on from the chip in the corner, and <span className="mono">{run.branch}</span> stays locked until it is done.</>
          )}
        </p>
      </div>
    </Modal>
  );
}
