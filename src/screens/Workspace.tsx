import { useEffect, useMemo, useState } from "react";

import { useAction, useAgents, useDiff, useFiles, useOverview } from "../api/hooks";
import type { BranchView, FileChange, ReleaseView } from "../api/types";
import { AgentLog } from "../components/AgentLog";
import { DiffView } from "../components/DiffView";
import { Icon } from "../components/Icon";
import { Busy, ErrorBox, Loading, Modal, releaseTagLabel, Seg } from "../components/ui";
import { useNav } from "../lib/nav";
import { ConflictModal } from "./ConflictModal";

type Mode = "branch" | "wip" | "project";
type Pane = "releases" | "files" | "diff";

export function Workspace() {
  const nav = useNav();
  const pid = nav.projectId!;
  const ov = useOverview(pid);
  const [mode, setMode] = useState<Mode>("branch");
  const [file, setFile] = useState<string | undefined>();
  const [diffMode, setDiffMode] = useState<"unified" | "split">("unified");
  const [termOpen, setTermOpen] = useState(true);
  const [pane, setPane] = useState<Pane>("releases");
  const [newRelease, setNewRelease] = useState(false);
  const [shipping, setShipping] = useState<ReleaseView | null>(null);
  const [conflicts, setConflicts] = useState(false);

  const o = ov.data;
  const allItems = useMemo(() => (o?.releases ?? []).flatMap((r) => r.items), [o]);
  const branch = nav.selectedBranch ?? allItems[0]?.name ?? o?.currentBranch ?? undefined;
  const view: BranchView | undefined = allItems.find((b) => b.name === branch);
  const meta = branch ? o?.project.branches[branch] : undefined;
  const release = o?.releases.find((r) => r.version === meta?.release);
  const base = release?.branch ?? o?.defaultBranch ?? "";
  const checkedOut = view?.checkedOut ?? branch === o?.currentBranch;

  const files = useFiles(pid, branch, mode);
  const wipCount = useFiles(pid, branch, "wip").data?.length ?? 0;
  const branchCount = useFiles(pid, branch, "branch").data?.length ?? 0;
  const list = files.data ?? [];
  const current = list.find((f) => f.path === file) ?? list[0];
  const diff = useDiff(pid, branch, mode, current?.path);

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
            { value: "releases", label: "Releases" },
            { value: "files", label: `Files${list.length ? ` ${list.length}` : ""}` },
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
        <main className="ws">
          <ReleasesPane
            active={pane === "releases"}
            releases={o.releases}
            others={o.otherBranches}
            selected={branch}
            onSelect={(b) => {
              nav.selectBranch(b);
              setPane("files");
            }}
            onNewRelease={() => setNewRelease(true)}
            onShip={setShipping}
          />

          <section aria-label="Changed files" className="ws-files" data-pane data-active={pane === "files"}>
            <div className="col" style={{ gap: 10, padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
              <div className="row" style={{ alignItems: "baseline", minWidth: 0 }}>
                <span className="mono ellipsis" style={{ fontSize: 13, fontWeight: 500 }}>{branch ?? "No branch"}</span>
                {base && branch !== base && <span className="faint" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>from {base}</span>}
              </div>
              <Seg<Mode>
                label="File view"
                grid
                value={mode}
                onChange={setMode}
                options={[
                  { value: "branch", label: <>Branch <span className="faint">{branchCount}</span></> },
                  { value: "wip", label: <>WIP <span className="faint">{wipCount}</span></> },
                  { value: "project", label: "Project" },
                ]}
              />
              {branch && <BranchActions pid={pid} branch={branch} checkedOut={checkedOut} worktree={view?.worktree ?? undefined} isRelease={!!release} />}
            </div>
            {inRebase && (
              <div className="col note-box" style={{ margin: "10px 12px 0" }}>
                <span style={{ fontSize: 12, lineHeight: 1.45 }}>
                  Rebase onto <span className="mono">{base}</span> stopped on {o.conflicts.length || "a"} conflict{o.conflicts.length === 1 ? "" : "s"}.
                </span>
                <button className="btn btn-primary btn-sm" style={{ height: 30 }} onClick={() => setConflicts(true)}>
                  <Icon name="sparkle" size={12} />
                  <span>Resolve with AI</span>
                </button>
              </div>
            )}
            <ul className="scroll" style={{ flex: "1 1 auto", listStyle: "none", margin: 0, padding: "6px 0" }}>
              {files.isLoading && <li className="empty"><span className="spinner" /></li>}
              {files.error && <li style={{ padding: 12 }}><ErrorBox error={files.error} /></li>}
              {list.map((f) => (
                <li key={f.path}>
                  <FileRow f={f} active={f.path === current?.path} onPick={() => { setFile(f.path); setPane("diff"); }} />
                </li>
              ))}
              {!files.isLoading && list.length === 0 && (
                <li className="empty">{mode === "wip" ? (checkedOut ? "No uncommitted changes." : "This branch is not checked out.") : "No changes on this branch yet."}</li>
              )}
            </ul>
            {branch && <CommitBox pid={pid} branch={branch} enabled={checkedOut} wip={wipCount} />}
          </section>

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

      {newRelease && <NewReleaseModal pid={pid} onClose={() => setNewRelease(false)} />}
      {shipping && <ShipModal pid={pid} release={shipping} defaultBranch={o?.defaultBranch ?? "main"} onClose={() => setShipping(null)} />}
      {conflicts && branch && <ConflictModal pid={pid} branch={branch} base={base} onClose={() => setConflicts(false)} />}
    </>
  );
}

function ReleasesPane({
  active,
  releases,
  others,
  selected,
  onSelect,
  onNewRelease,
  onShip,
}: {
  active: boolean;
  releases: ReleaseView[];
  others: string[];
  selected?: string;
  onSelect: (b: string) => void;
  onNewRelease: () => void;
  onShip: (r: ReleaseView) => void;
}) {
  const nav = useNav();
  const [showOthers, setShowOthers] = useState(false);
  const attach = useAction("items.attach", { invalidate: [["overview"]] });
  const open = releases.filter((r) => r.open);
  return (
    <section aria-label="Releases" className="ws-releases" data-pane data-active={active}>
      <div className="pane-head">
        <span className="label">Releases</span>
        <button className="btn btn-sm" onClick={onNewRelease}>
          <Icon name="plus" size={12} stroke={1.6} />
          <span>Release</span>
        </button>
      </div>
      <div className="scroll col" style={{ flex: "1 1 auto", padding: "8px 0", gap: 6 }}>
        {releases.length === 0 && (
          <div className="empty">
            No release yet. Cut one to start: features and fixes branch off it.
            <div style={{ marginTop: 12 }}>
              <button className="btn btn-primary" onClick={onNewRelease}>New release</button>
            </div>
          </div>
        )}
        {releases.map((r) => (
          <div key={`${r.version}-${r.tag}`} className="col" style={{ gap: 2 }}>
            <div className="rel-head">
              <Icon name="tag" size={13} stroke={1.4} className="faint" />
              <span className="mono" style={{ fontSize: 12.5, fontWeight: 500 }}>v{r.version}</span>
              <span className={`tag${r.tag === "next" ? " accent" : ""}`}>{releaseTagLabel(r.tag)}</span>
              <span className="grow" />
              {r.open && (
                <div className="row" style={{ gap: 2 }}>
                  <button className="btn btn-ghost btn-sm btn-icon" aria-label={`New feature or fix in v${r.version}`} onClick={() => nav.openNewItem({ release: r.version })}>
                    <Icon name="plus" size={13} stroke={1.6} />
                  </button>
                  <button className="btn btn-ghost btn-sm btn-icon" aria-label={`Ship v${r.version}: move main and create tag`} onClick={() => onShip(r)}>
                    <Icon name="ship" size={13} />
                  </button>
                </div>
              )}
            </div>
            <div className="rel-base">{r.open ? r.branch : r.base}</div>
            {r.items.map((b) => (
              <button key={b.name} className="branch-btn" aria-pressed={b.name === selected} onClick={() => onSelect(b.name)}>
                <span className={`branch-kind ${b.kind === "fix" ? "c-del" : "c-mod"}`}>{b.kind}</span>
                <span className="col grow" style={{ gap: 3, minWidth: 0 }}>
                  <span className="mono ellipsis" style={{ fontSize: 12 }}>{b.short}</span>
                  <span className="branch-meta">
                    {b.worktree && <span className="row" style={{ gap: 4 }}><Icon name="layers" size={11} stroke={1.4} />worktree</span>}
                    {b.running && <span className="row c-acc" style={{ gap: 4 }}><span className="pulse" style={{ width: 5, height: 5 }} />AI working</span>}
                    {b.conflict && <span className="c-del">conflict</span>}
                    {!b.exists && <span className="c-del">branch deleted</span>}
                    <span>{b.ahead === 1 ? "1 commit" : `${b.ahead} commits`}</span>
                    {b.ticket && <span className="mono">{b.ticket}</span>}
                  </span>
                </span>
              </button>
            ))}
            {r.open && r.items.length === 0 && <div style={{ padding: "2px 16px 6px 37px", fontSize: 12 }} className="muted">No features or fixes yet.</div>}
            {!r.open && r.note && <div style={{ padding: "2px 16px 6px 37px", fontSize: 12 }} className="muted">{r.note}</div>}
          </div>
        ))}
        {others.length > 0 && (
          <div className="col" style={{ gap: 2, marginTop: 8 }}>
            <button className="rel-head btn-ghost" style={{ border: 0, background: "transparent", textAlign: "left" }} aria-expanded={showOthers} onClick={() => setShowOthers(!showOthers)}>
              <Icon name={showOthers ? "chevronUp" : "chevronDown"} size={12} />
              <span className="label">Other branches</span>
              <span className="faint">{others.length}</span>
            </button>
            {showOthers &&
              others.map((b) => (
                <div key={b} className="row" style={{ padding: "4px 12px 4px 24px" }}>
                  <button className="btn btn-ghost btn-sm mono ellipsis grow" style={{ justifyContent: "flex-start" }} onClick={() => onSelect(b)}>{b}</button>
                  {open.length > 0 && (
                    <>
                      <label className="sr-only" htmlFor={`att-${b}`}>Attach {b} to a release</label>
                      <select
                        id={`att-${b}`}
                        className="select"
                        style={{ height: 26, fontSize: 11.5, width: 92 }}
                        value=""
                        onChange={(e) => attach.mutate({ projectId: nav.projectId!, branch: b, release: e.target.value, kind: b.startsWith("fix") ? "fix" : "feat" })}
                      >
                        <option value="">Attach…</option>
                        {open.map((r) => <option key={r.version} value={r.version}>v{r.version}</option>)}
                      </select>
                    </>
                  )}
                </div>
              ))}
          </div>
        )}
      </div>
      <div className="hint" style={{ padding: "10px 16px", borderTop: "1px solid var(--line)" }}>Switching branch carries your uncommitted work with you.</div>
    </section>
  );
}

function FileRow({ f, active, onPick }: { f: FileChange; active: boolean; onPick: () => void }) {
  const cut = f.path.lastIndexOf("/");
  const base = cut >= 0 ? f.path.slice(cut + 1) : f.path;
  const dir = cut >= 0 ? f.path.slice(0, cut) : "";
  const color = { A: "c-add", D: "c-del", C: "c-acc", M: "c-mod", R: "c-mod", " ": "faint" }[f.status] ?? "faint";
  return (
    <button className="file-btn" aria-pressed={active} onClick={onPick}>
      <span className={`file-st ${color}`}>{f.status === " " ? "·" : f.status}</span>
      <span className="grow ellipsis">
        <span style={{ color: f.status === " " ? "var(--muted)" : "var(--fg)" }}>{base}</span> <span className="faint" style={{ fontSize: 11.5 }}>{dir}</span>
      </span>
      <span className="row mono" style={{ gap: 6, fontSize: 11 }}>
        {f.additions > 0 && <span className="c-add">+{f.additions}</span>}
        {f.deletions > 0 && <span className="c-del">−{f.deletions}</span>}
      </span>
    </button>
  );
}

function BranchActions({ pid, branch, checkedOut, worktree, isRelease }: { pid: string; branch: string; checkedOut: boolean; worktree?: string; isRelease: boolean }) {
  const inv = [["overview", pid], ["files", pid]];
  const sw = useAction("workspace.switch", { invalidate: inv, success: `Switched to ${branch}` });
  const wt = useAction<{ path: string }>("worktrees.create", { invalidate: inv, success: (r) => `Worktree at ${r.path}` });
  const rebase = useAction<{ conflicts: string[] }>("workspace.rebase", {
    invalidate: inv,
    success: (r) => (r.conflicts.length ? `Rebase stopped on ${r.conflicts.length} conflict(s)` : "Rebased, no conflicts"),
  });
  if (!checkedOut) {
    return (
      <div className="row wrap" style={{ gap: 6 }}>
        <button className="btn btn-sm" disabled={sw.isPending} onClick={() => sw.mutate({ projectId: pid, branch })}>Switch to branch</button>
        <button className="btn btn-sm" disabled={wt.isPending} onClick={() => wt.mutate({ projectId: pid, branch })}>
          <Icon name="layers" size={12} stroke={1.4} />
          Open in worktree
        </button>
      </div>
    );
  }
  return (
    <div className="row wrap" style={{ gap: 6 }}>
      {worktree && <span className="hint mono ellipsis" title={worktree}>{worktree}</span>}
      {isRelease && (
        <button className="btn btn-sm" disabled={rebase.isPending} onClick={() => rebase.mutate({ projectId: pid, branch })}>
          <Busy on={rebase.isPending}><Icon name="refresh" size={12} /></Busy>
          Rebase onto release
        </button>
      )}
    </div>
  );
}

function CommitBox({ pid, branch, enabled, wip }: { pid: string; branch: string; enabled: boolean; wip: number }) {
  const nav = useNav();
  const [msg, setMsg] = useState("");
  const inv = [["overview", pid], ["files", pid], ["diff", pid]];
  const commit = useAction<{ sha: string; message: string; aiWritten: boolean }>("workspace.commit", {
    invalidate: inv,
    success: (r) => `${r.aiWritten ? "AI wrote: " : "Committed: "}${r.message.split("\n")[0]}`,
  });
  const push = useAction("workspace.push", { invalidate: inv, success: `Pushed ${branch}` });
  const pr = useAction<{ number: number }>("prs.create", { invalidate: [["prs", pid]], success: (r) => `Opened PR #${r.number}` });
  const draft = useAction<{ message: string }>("workspace.commitMessage");
  return (
    <div className="col" style={{ padding: 12, borderTop: "1px solid var(--line)" }}>
      <div className="row faint" style={{ justifyContent: "space-between", fontSize: 11 }}>
        <label htmlFor="ag-msg">Commit message</label>
        <button className="btn btn-ghost btn-sm" style={{ height: 20 }} disabled={!enabled || !wip || draft.isPending} onClick={() => draft.mutate({ projectId: pid, branch }, { onSuccess: (r) => setMsg(r.message) })}>
          <Busy on={draft.isPending}><Icon name="sparkle" size={10} /></Busy>
          Draft
        </button>
      </div>
      <textarea
        id="ag-msg"
        className="textarea"
        rows={2}
        style={{ fontSize: 12.5, padding: "8px 10px", resize: "none" }}
        placeholder={enabled ? "Leave empty — AI writes it from the diff" : "Check out this branch to commit"}
        value={msg}
        disabled={!enabled}
        onChange={(e) => setMsg(e.target.value)}
      />
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr", gap: 6 }}>
        <button className="btn btn-primary" style={{ height: 34 }} disabled={!enabled || !wip || commit.isPending} onClick={() => commit.mutate({ projectId: pid, branch, message: msg }, { onSuccess: () => setMsg("") })}>
          <Busy on={commit.isPending}><Icon name="sparkle" size={12} /></Busy>
          <span>Commit</span>
        </button>
        <button className="btn btn-raised" style={{ height: 34 }} disabled={push.isPending} onClick={() => push.mutate({ projectId: pid, branch })}>
          <Busy on={push.isPending}><Icon name="push" size={12} stroke={1.6} /></Busy>
          <span>Push</span>
        </button>
        <button
          className="btn btn-raised"
          style={{ height: 34 }}
          disabled={pr.isPending}
          onClick={() => pr.mutate({ projectId: pid, branch }, { onSuccess: (r) => nav.go({ name: "prs", number: r.number }) })}
        >
          <Busy on={pr.isPending}><Icon name="sparkle" size={12} className="c-acc" /></Busy>
          <span>PR</span>
        </button>
      </div>
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

function NewReleaseModal({ pid, onClose }: { pid: string; onClose: () => void }) {
  const [version, setVersion] = useState("");
  const [kind, setKind] = useState<"next" | "hotfix">("next");
  const create = useAction("releases.create", { invalidate: [["overview", pid], ["projects"]], success: `Release v${version} created` });
  return (
    <Modal
      title="New release"
      sub={kind === "next" ? "Branches off your default branch" : "Branches off the latest tag"}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-md" disabled={!version || create.isPending} onClick={() => create.mutate({ projectId: pid, version, kind }, { onSuccess: onClose })}>
            Create release/{version.replace(/^v/, "") || "x.y.z"}
          </button>
        </>
      }
    >
      <Seg grid size="lg" label="Release type" value={kind} onChange={setKind} options={[{ value: "next", label: "Next release" }, { value: "hotfix", label: "Hotfix" }]} />
      <div className="field">
        <label htmlFor="rel-v">Version</label>
        <input id="rel-v" className="input mono" placeholder="2.4.0" value={version} onChange={(e) => setVersion(e.target.value.trim())} autoFocus />
      </div>
    </Modal>
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
