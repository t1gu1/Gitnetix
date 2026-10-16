import { useMemo, useState } from "react";

import { useAction, useAgents, useProjects, useWorktrees } from "../api/hooks";
import type { AgentSession, AgentStatus, WorktreeView } from "../api/types";
import { AgentLog } from "../components/AgentLog";
import { Icon } from "../components/Icon";
import { ago, Empty, Header, Loading, Modal, Seg } from "../components/ui";
import { useNav } from "../lib/nav";

const STATUS: Record<AgentStatus | "idle", [string, string]> = {
  running: ["Running", "c-acc"],
  waiting: ["Waiting for you", "c-acc"],
  paused: ["Paused", "muted"],
  failed: ["Failed", "c-del"],
  done: ["Done", "c-add"],
  stopped: ["Stopped", "faint"],
  idle: ["No agent", "faint"],
};

type Filter = "all" | "running" | "needs" | "quiet";

interface Row {
  key: string;
  wt?: WorktreeView;
  agent?: AgentSession;
  projectId: string;
  projectName: string;
  branch: string;
  path: string;
  status: AgentStatus | "idle";
}

const match = (s: Row["status"], f: Filter) =>
  f === "all" || (f === "running" ? s === "running" : f === "needs" ? s === "waiting" || s === "failed" : s === "idle" || s === "done" || s === "paused" || s === "stopped");

export function Worktrees({ initial }: { initial?: string }) {
  const nav = useNav();
  const wts = useWorktrees();
  const agents = useAgents();
  const projects = useProjects().data ?? [];
  const [filter, setFilter] = useState<Filter>("all");
  const [sel, setSel] = useState<string | undefined>(initial);
  const [pane, setPane] = useState<"list" | "detail">(initial ? "detail" : "list");
  const [starting, setStarting] = useState(false);

  // One row per worktree; agents whose directory is gone still show up.
  const rows: Row[] = useMemo(() => {
    const list: Row[] = (wts.data ?? []).map((w) => {
      const a = (agents.data ?? []).find((x) => x.cwd === w.path) ?? w.agent ?? undefined;
      return { key: w.path, wt: w, agent: a, projectId: w.projectId, projectName: w.projectName, branch: w.branch ?? "(detached)", path: w.path, status: a?.status ?? "idle" };
    });
    for (const a of agents.data ?? []) {
      if (!list.some((r) => r.agent?.id === a.id)) {
        const p = projects.find((x) => x.id === a.projectId);
        list.push({ key: a.id, agent: a, projectId: a.projectId, projectName: p?.name ?? "?", branch: a.branch, path: a.cwd, status: a.status });
      }
    }
    return list;
  }, [wts.data, agents.data, projects]);

  const running = rows.filter((r) => r.status === "running").length;
  const needs = rows.filter((r) => match(r.status, "needs")).length;
  const wtCount = rows.filter((r) => r.wt && !r.wt.main).length;
  const cur = rows.find((r) => r.key === sel) ?? rows[0];
  const names = [...new Set(rows.map((r) => r.projectName))];

  return (
    <>
      <Header title="Worktrees & agents" sub="All projects" />
      <div className="body split">
        <section className="master" data-pane data-active={pane === "list"} aria-label="Worktrees">
          <div className="master-tools">
            <Seg<Filter>
              grid
              label="Filter"
              value={filter}
              onChange={setFilter}
              options={(["all", "running", "needs", "quiet"] as Filter[]).map((f) => ({
                value: f,
                label: <>{{ all: "All", running: "Running", needs: "Needs you", quiet: "Idle" }[f]} <span className="faint">{rows.filter((r) => match(r.status, f)).length}</span></>,
              }))}
            />
            <span className="hint">{running} running · {needs} need you · {wtCount} worktrees</span>
            <button className="btn" disabled={!nav.projectId} onClick={() => setStarting(true)}>
              <Icon name="plus" size={12} />
              New agent session
            </button>
          </div>
          <div className="scroll" style={{ flex: "1 1 auto", paddingBottom: 12 }}>
            {(wts.isLoading || agents.isLoading) && <Loading />}
            {names.map((name) => {
              const items = rows.filter((r) => r.projectName === name && match(r.status, filter));
              if (!items.length) return null;
              const n = rows.filter((r) => r.projectName === name && r.wt && !r.wt.main).length;
              return (
                <div key={name}>
                  <div className="group-head">
                    <span>{name}</span>
                    <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }} className="faint">{n === 1 ? "1 worktree" : `${n} worktrees`}</span>
                  </div>
                  <div className="col" style={{ gap: 2 }}>
                    {items.map((r) => (
                      <button key={r.key} className="item-btn" aria-pressed={r.key === cur?.key} onClick={() => { setSel(r.key); setPane("detail"); }}>
                        <span className="row">
                          {r.status === "running" ? <span className="pulse" /> : <span style={{ width: 6 }} />}
                          <span className="mono ellipsis grow" style={{ fontSize: 12.5 }}>{r.branch}</span>
                          <span className="faint" style={{ fontSize: 11 }}>{r.wt ? (r.wt.main ? "main checkout" : "worktree") : "gone"}</span>
                        </span>
                        <span className="row" style={{ gap: 8, fontSize: 11.5, paddingLeft: 14 }}>
                          <span className={STATUS[r.status][1]}>{STATUS[r.status][0]}</span>
                          <span className="faint ellipsis grow">{r.agent?.lines.at(-1)?.text.trim() ?? r.path}</span>
                          {r.wt && (r.wt.additions > 0 || r.wt.deletions > 0) && (
                            <span className="mono"><span className="c-add">+{r.wt.additions}</span> <span className="c-del">−{r.wt.deletions}</span></span>
                          )}
                          {r.agent && <span className="faint">{ago(r.agent.updatedAt)}</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            {!wts.isLoading && rows.length === 0 && <Empty>Nothing here right now.</Empty>}
          </div>
        </section>
        <main className="detail" data-pane data-active={pane === "detail"} style={{ display: "flex", flexDirection: "column" }}>
          <button className="btn btn-sm show-narrow" style={{ marginBottom: 12, alignSelf: "flex-start" }} onClick={() => setPane("list")}>
            <Icon name="back" size={12} />
            All worktrees
          </button>
          {cur ? <Detail key={cur.key} r={cur} /> : <Empty>Select a worktree.</Empty>}
        </main>
      </div>
      {starting && nav.projectId && <StartModal pid={nav.projectId} onClose={() => setStarting(false)} />}
    </>
  );
}

function Detail({ r }: { r: Row }) {
  const nav = useNav();
  const a = r.agent;
  const inv = [["agents"], ["worktrees"]];
  const pause = useAction("agents.pause", { invalidate: inv });
  const resume = useAction("agents.resume", { invalidate: inv });
  const stop = useAction("agents.stop", { invalidate: inv });
  const msg = useAction("agents.message", { invalidate: inv });
  const start = useAction("agents.start", { invalidate: inv });
  const removeWt = useAction("worktrees.remove", { invalidate: inv, success: "Worktree removed" });
  const removeAgent = useAction("agents.remove", { invalidate: inv });
  const [text, setText] = useState("");
  const [confirm, setConfirm] = useState(false);
  const busy = a?.status === "running" || a?.status === "paused";
  const send = () => {
    const t = text.trim();
    if (!t) return;
    const done = { onSuccess: () => setText("") };
    if (a && !busy) msg.mutate({ id: a.id, text: t }, done);
    else if (!a) start.mutate({ projectId: r.projectId, branch: r.wt?.branch ?? undefined, request: t }, done);
  };
  const [label, cls] = STATUS[r.status];
  return (
    <div className="detail-inner" style={{ flex: 1, minHeight: 0, maxWidth: 960 }}>
      <div className="col" style={{ gap: 6 }}>
        <div className="row wrap" style={{ fontSize: 12.5 }}>
          <span className={`pill ${cls}`}>{label}</span>
          <span className="muted">{r.projectName} · {r.wt ? (r.wt.main ? "Main checkout" : "Worktree") : "Directory removed"}</span>
        </div>
        <h1 className="mono" style={{ fontSize: 18 }}>{r.branch}</h1>
      </div>
      <div className="kv">
        <div><span>Path</span><span className="mono ellipsis" title={r.path} style={{ fontSize: 12 }}>{r.path}</span></div>
        <div><span>Base</span><span className="mono">{r.wt?.base ?? "—"}</span></div>
        <div><span>Agent</span><span>{a?.agentLabel ?? "None"}</span></div>
        <div><span>Ticket</span><span className="mono">{r.wt?.ticket ?? "—"}</span></div>
        <div><span>Started</span><span>{a ? ago(a.startedAt) : "—"}</span></div>
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        {a?.status === "waiting" && r.wt && (
          <button
            className="btn btn-primary"
            onClick={() => {
              nav.setProject(r.projectId);
              nav.selectBranch(r.branch);
              nav.go({ name: "workspace" });
            }}
          >
            Review &amp; commit
          </button>
        )}
        {a?.status === "failed" && (
          <button className="btn btn-primary" onClick={() => msg.mutate({ id: a.id, text: "The last run failed. Read the errors above, fix them and try again." })}>
            <Icon name="sparkle" size={12} />
            Fix and retry with AI
          </button>
        )}
        {a?.status === "running" && <button className="btn" onClick={() => pause.mutate({ id: a.id })}><Icon name="pause" size={12} />Pause</button>}
        {a?.status === "paused" && <button className="btn" onClick={() => resume.mutate({ id: a.id })}><Icon name="play" size={12} />Resume</button>}
        {busy && a && <button className="btn" onClick={() => stop.mutate({ id: a.id })}><Icon name="stop" size={12} />Stop agent</button>}
        {r.wt && (
          <button
            className="btn"
            onClick={() => {
              nav.setProject(r.projectId);
              nav.selectBranch(r.branch);
              nav.go({ name: "workspace" });
            }}
          >
            Open in workspace
          </button>
        )}
        <span className="grow" />
        {a && !busy && <button className="btn btn-ghost" onClick={() => removeAgent.mutate({ id: a.id })}>Clear session</button>}
        {r.wt && !r.wt.main && <button className="btn btn-danger" onClick={() => setConfirm(true)}><Icon name="trash" size={12} />Remove worktree</button>}
      </div>
      <div className="col card" style={{ flex: "1 1 320px", minHeight: 280, gap: 0, overflow: "hidden", background: "var(--term)" }}>
        <div className="row" style={{ height: 34, padding: "0 14px", borderBottom: "1px solid var(--line)", background: "var(--panel)" }}>
          <Icon name="terminal" />
          <span className="muted">Session log</span>
          <span className="grow" />
          <span className="hint">Keeps running when you switch project</span>
        </div>
        <AgentLog lines={a?.lines ?? []} empty={r.wt ? "No agent session on this checkout." : "Directory removed."} />
        <form className="term-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <span className="mono c-acc" aria-hidden="true">›</span>
          <label htmlFor="wt-ask" className="sr-only">Message the agent</label>
          <input
            id="wt-ask"
            value={text}
            disabled={busy || (!a && !r.wt)}
            onChange={(e) => setText(e.target.value)}
            placeholder={busy ? "Agent is working…" : a ? `Message the agent on ${r.branch}…` : "Start a session: describe what the agent should do…"}
          />
          {(msg.isPending || start.isPending) && <span className="spinner" />}
        </form>
      </div>
      {confirm && r.wt && (
        <Modal
          title="Remove worktree?"
          onClose={() => setConfirm(false)}
          footer={
            <>
              <button className="btn btn-md" onClick={() => setConfirm(false)}>Cancel</button>
              <button className="btn btn-md btn-danger" onClick={() => removeWt.mutate({ projectId: r.projectId, path: r.path, force: true }, { onSuccess: () => setConfirm(false) })}>Remove, discard uncommitted changes</button>
              <button className="btn btn-md btn-primary" onClick={() => removeWt.mutate({ projectId: r.projectId, path: r.path }, { onSuccess: () => setConfirm(false) })}>Remove</button>
            </>
          }
        >
          <p style={{ margin: 0, lineHeight: 1.55 }}>
            Deletes the folder <span className="mono">{r.path}</span>. The branch <span className="mono">{r.branch}</span> and its commits stay. “Remove” refuses if there are uncommitted changes.
          </p>
        </Modal>
      )}
    </div>
  );
}

function StartModal({ pid, onClose }: { pid: string; onClose: () => void }) {
  const [request, setRequest] = useState("");
  const start = useAction("agents.start", { invalidate: [["agents"]], success: "Agent started" });
  return (
    <Modal
      title="New agent session"
      sub="Runs on the main checkout of the current project"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-md" disabled={!request.trim() || start.isPending} onClick={() => start.mutate({ projectId: pid, request }, { onSuccess: onClose })}>Start</button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="ag-req">What should the agent do?</label>
        <textarea id="ag-req" className="textarea" rows={4} value={request} onChange={(e) => setRequest(e.target.value)} placeholder="Squash my last 3 commits on this branch" autoFocus />
      </div>
      <p className="hint">To give an agent its own folder, create the feature with “Open in a new worktree” or open a branch in a worktree from the workspace.</p>
    </Modal>
  );
}
