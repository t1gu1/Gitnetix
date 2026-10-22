import { useMemo, useState, type CSSProperties } from "react";

import { useAction, useAgents, useFiles, useOverview, useProjects, useWorktrees } from "../api/hooks";
import type { AgentSession, AgentStatus, WorktreeView } from "../api/types";
import { AgentInput, AgentLog } from "../components/AgentLog";
import { AgentPicker, MenuChoice, useAgentPick } from "../components/AgentPicker";
import { Icon } from "../components/Icon";
import { Resizer, usePaneWidth } from "../components/Resizer";
import { ShellPane, TermTabs, useTermView } from "../components/Shell";
import { ago, Busy, Empty, Header, Loading, Modal, Seg } from "../components/ui";
import { KINDS, kindOfBranch, type Kind } from "../lib/kinds";
import { useNav } from "../lib/nav";
import { useBranchActions } from "./BranchMenu";
import { DiscardWorktreeModal, FinishWorktreeCard, MergeModal, mergeTargets, useFinishHandlers } from "./Workspace";

const STATUS: Record<AgentStatus | "idle", [string, string]> = {
  running: ["Running", "c-acc"],
  waiting: ["Waiting for you", "c-add"],
  paused: ["Paused", "muted"],
  failed: ["Failed", "c-del"],
  done: ["Done", "c-add"],
  stopped: ["Stopped", "faint"],
  idle: ["No agent", "faint"],
};

type Filter = "all" | "running" | "needs";

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

// Statuses left out only show under "All".
const GROUP: Partial<Record<Row["status"], Exclude<Filter, "all">>> = {
  running: "running",
  waiting: "needs",
  failed: "needs",
};

const match = (s: Row["status"], f: Filter) => f === "all" || GROUP[s] === f;

export function Worktrees({ initial }: { initial?: string }) {
  const nav = useNav();
  const wts = useWorktrees();
  const agents = useAgents();
  const projects = useProjects().data ?? [];
  const [filter, setFilter] = useState<Filter>("all");
  const [sel, setSel] = useState<string | undefined>(initial);
  const [pane, setPane] = useState<"list" | "detail">(initial ? "detail" : "list");
  const listW = usePaneWidth("gnx.pane.worktrees", 400, 280, 720);
  const [starting, setStarting] = useState(false);

  // One row per linked worktree; agents elsewhere (main checkout, removed directory) still show up.
  const rows: Row[] = useMemo(() => {
    const list: Row[] = (wts.data ?? []).filter((w) => !w.main).map((w) => {
      const a = (agents.data ?? []).find((x) => x.cwd === w.path) ?? w.agent ?? undefined;
      return { key: w.path, wt: w, agent: a, projectId: w.projectId, projectName: w.projectName, branch: w.branch ?? "(detached)", path: w.path, status: a?.status ?? "idle" };
    });
    for (const a of agents.data ?? []) {
      if (!list.some((r) => r.agent?.id === a.id)) {
        const p = projects.find((x) => x.id === a.projectId);
        const w = wts.data?.find((x) => x.path === a.cwd);
        list.push({ key: a.id, wt: w, agent: a, projectId: a.projectId, projectName: p?.name ?? "?", branch: a.branch, path: a.cwd, status: a.status });
      }
    }
    return list;
  }, [wts.data, agents.data, projects]);

  const running = rows.filter((r) => r.status === "running").length;
  const needs = rows.filter((r) => match(r.status, "needs")).length;
  const wtCount = rows.filter((r) => r.wt && !r.wt.main).length;
  const cur = rows.find((r) => r.key === sel) ?? rows[0];
  const names = [...new Set([...projects.map((p) => p.name), ...rows.map((r) => r.projectName)])];

  return (
    <>
      <Header title="Worktrees & agents" sub="All projects" />
      <div className="body split">
        <section className="master" style={{ "--master-w": `${listW.width}px` } as CSSProperties} data-pane data-active={pane === "list"} aria-label="Worktrees">
          <div className="master-tools">
            <Seg<Filter>
              grid
              label="Filter"
              value={filter}
              onChange={setFilter}
              options={(["all", "running", "needs"] as Filter[]).map((f) => ({
                value: f,
                label: <>{{ all: "All", running: "Running", needs: "Needs you" }[f]} <span className="faint">{rows.filter((r) => match(r.status, f)).length}</span></>,
              }))}
            />
            <span className="hint">{running} running · {needs} need you · {wtCount} worktrees</span>
            <button className="btn btn-primary" style={{ height: 48, fontSize: 13.5 }} disabled={!projects.length} onClick={() => setStarting(true)}>
              New agent session
            </button>
          </div>
          <div className="scroll" style={{ flex: "1 1 auto", paddingBottom: 12 }}>
            {(wts.isLoading || agents.isLoading) && <Loading />}
            {names.map((name) => {
              const items = rows.filter((r) => r.projectName === name && match(r.status, filter));
              const n = rows.filter((r) => r.projectName === name && r.wt && !r.wt.main).length;
              return (
                <div key={name}>
                  <div className="group-head" style={{ padding: "22px 14px 6px" }}>
                    <span>{name}</span>
                    <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }} className="faint">{n === 1 ? "1 worktree" : `${n} worktrees`}</span>
                  </div>
                  {!items.length && <p className="hint" style={{ padding: "0 14px 4px" }}>None currently running</p>}
                  <div className="col" style={{ gap: 2 }}>
                    {items.map((r) => (
                      <button key={r.key} className="item-btn" style={{ width: "100%", margin: 0, borderRadius: 0, padding: "10px 14px" }} aria-pressed={r.key === cur?.key} title={`${STATUS[r.status][0]} · ${r.path}`} onClick={() => { setSel(r.key); setPane("detail"); }}>
                        <span className="row" style={{ gap: 8, fontSize: 11.5 }}>
                          {r.status === "running" ? <span className="pulse" style={{ flex: "0 0 8px", width: 8, height: 8, borderRadius: 4 }} /> : <span className={STATUS[r.status][1]} style={{ flex: "0 0 8px", height: 8, borderRadius: 4, background: "currentColor" }} />}
                          <span className="sr-only">{STATUS[r.status][0]}</span>
                          <span className={`mono ellipsis grow${r.wt ? "" : " faint"}`} style={{ fontSize: 12.5 }}>{r.branch}</span>
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
            {!wts.isLoading && names.length === 0 && <Empty>Nothing here right now.</Empty>}
          </div>
        </section>
        <Resizer pane={listW} label="Resize worktree list" />
        <main className="detail" data-pane data-active={pane === "detail"} style={{ display: "flex", flexDirection: "column" }}>
          <button className="btn btn-sm show-narrow" style={{ marginBottom: 12, alignSelf: "flex-start" }} onClick={() => setPane("list")}>
            <Icon name="back" size={12} />
            All worktrees
          </button>
          {cur ? <Detail key={cur.key} r={cur} /> : <Empty>Select a worktree.</Empty>}
        </main>
      </div>
      {starting && <StartModal initial={cur?.projectId ?? nav.projectId ?? projects[0]?.id} onClose={() => setStarting(false)} />}
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
  const configure = useAction("agents.configure", { invalidate: inv });
  const start = useAction("agents.start", { invalidate: inv });
  const removeAgent = useAction("agents.remove", { invalidate: inv });
  const [text, setText] = useState("");
  const actions = useBranchActions(r.projectId, () => {});
  const ov = useOverview(r.projectId);
  // Merging closes the worktree once done (`then`); `stay` leaves the main checkout where it is.
  const [merging, setMerging] = useState<{ then: () => void; stay: boolean; into?: string } | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const finish = useFinishHandlers(r.projectId, actions.continueOn, (_, then, stay, into) => setMerging({ then, stay, into }));
  const isWorktree = !!r.wt && !r.wt.main;
  const session = { projectId: r.projectId, branch: r.branch, cwd: r.path };
  // Commits like the Workspace commit box with an empty summary: AI writes the message, staged files only if any, else everything.
  const wip = useFiles(r.projectId, r.wt ? r.branch : undefined, "wip").data ?? [];
  const changed = new Set(wip.map((f) => f.path)).size;
  const staged = wip.filter((f) => f.staged).length;
  const commitInv = [["overview", r.projectId], ["files", r.projectId], ["diff", r.projectId], ["commits", r.projectId]];
  const commit = useAction<{ message: string; aiWritten: boolean }>("workspace.commit", {
    invalidate: commitInv,
    success: (c) => `${c.aiWritten ? "AI wrote: " : "Committed: "}${c.message.split("\n")[0]}`,
  });
  const push = useAction("workspace.push", { invalidate: commitInv, success: `Pushed ${r.branch}` });
  const [pick, setPick] = useAgentPick(r.projectId);
  const [termView, setTermView] = useTermView();
  // Maximized, the terminal card takes the whole detail pane.
  const [max, setMax] = useState(false);
  const busy = a?.status === "running" || a?.status === "paused";
  const send = () => {
    const t = text.trim();
    if (!t) return;
    const done = { onSuccess: () => setText("") };
    if (a && !busy) msg.mutate({ id: a.id, text: t }, done);
    else if (!a) start.mutate({ projectId: r.projectId, branch: r.wt?.branch ?? undefined, request: t, ...pick }, done);
  };
  const [label, cls] = STATUS[r.status];
  return (
    <div className="detail-inner" style={{ flex: 1, minHeight: 0 }}>
      {!max && (
        <>
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
                disabled={!changed || commit.isPending || push.isPending}
                onClick={() => commit.mutate({ projectId: r.projectId, branch: r.branch, message: "", all: !staged }, { onSuccess: () => push.mutate({ projectId: r.projectId, branch: r.branch }) })}
              >
                <Busy on={commit.isPending || push.isPending}><Icon name="sparkle" size={12} /></Busy>
                <span>Commit &amp; Push changes<span style={{ fontWeight: 400, opacity: 0.75, marginLeft: 6 }}>{staged || changed}</span></span>
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
            {a && !busy && !isWorktree && <button className="btn btn-ghost" onClick={() => removeAgent.mutate({ id: a.id })}>Clear session</button>}
            {isWorktree && (
              <>
                <button className="btn" data-tip={`Delete the worktree and switch to ${r.branch}; refused with uncommitted changes`} onClick={() => finish.continue(session, true)}>Continue on branch</button>
                <button className="btn" data-tip="Pick the merge options; the worktree is deleted once merged" onClick={() => finish.merge(session, true)}>Merge…</button>
                <button className="btn btn-danger" data-tip={`Delete the worktree, its uncommitted changes and the local ${r.branch} branch`} onClick={() => setDiscarding(true)}>
                  <Icon name="trash" size={12} />
                  Cancel and Delete all
                </button>
                {discarding && <DiscardWorktreeModal branch={r.branch} path={r.path} onClose={() => setDiscarding(false)} onConfirm={() => finish.discard(session)} />}
              </>
            )}
          </div>
        </>
      )}
      <div className={max ? "col card term-max" : "col card"} style={{ flex: "1 1 320px", minHeight: 280, gap: 0, overflow: "hidden", background: "var(--term)" }}>
        <div className="term-tabs">
          <TermTabs value={termView} onChange={setTermView} />
          <span className="grow" />
          <span className="hint row" style={{ padding: "0 14px" }}>Keeps running when you switch project</span>
          <button className="btn btn-ghost" style={{ width: 36, height: "auto", border: 0, borderLeft: "1px solid var(--line)", borderRadius: 0 }} aria-label={max ? "Restore terminal size" : "Expand terminal"} aria-pressed={max} data-tip={max ? "Restore" : "Expand"} onClick={() => setMax(!max)}>
            <Icon name={max ? "minimize" : "maximize"} size={13} />
          </button>
        </div>
        {termView === "shell" ? (
          <ShellPane projectId={r.projectId} path={r.wt ? r.path : undefined} />
        ) : (
          <>
            <AgentLog lines={a?.lines ?? []} projectId={r.projectId} provider={a ? a.ai?.provider : pick.provider} thinking={a?.status === "running" || msg.isPending || start.isPending} actions={isWorktree && <FinishWorktreeCard session={session} finish={finish} />} onAnswer={a && ((t) => msg.mutate({ id: a.id, text: t }))} empty={r.wt ? "No agent session on this checkout." : "Directory removed."} />
            <AgentInput
              id="wt-ask"
              label="Message the agent"
              value={text}
              onChange={setText}
              onSend={send}
              onStop={busy && a ? () => stop.mutate({ id: a.id }) : undefined}
              log={a?.lines}
              disabled={!a && !r.wt}
              pending={msg.isPending || start.isPending}
              picker={a?.ai ? <AgentPicker value={a.ai} onChange={(p) => configure.mutate({ id: a.id, ...p })} compact /> : !a && r.wt && <AgentPicker value={pick} onChange={setPick} compact />}
              placeholder={busy ? "Agent is working…" : a ? `Message the agent on ${r.branch}…` : "Start a session: describe what the agent should do…"}
            />
          </>
        )}
      </div>
      {merging && (
        <MergeModal
          pid={r.projectId}
          branch={r.branch}
          base={merging.into ?? ov.data?.branches.find((x) => x.name === r.branch)?.parent ?? ""}
          others={mergeTargets(ov.data?.branches ?? [], r.branch)}
          stay={merging.stay}
          onClose={() => setMerging(null)}
          onDeleted={(into) => nav.projectId === r.projectId && nav.selectedBranch === r.branch && nav.selectBranch(into)}
          onMerged={merging.then}
        />
      )}
    </div>
  );
}

function StartModal({ initial, onClose }: { initial?: string; onClose: () => void }) {
  const projects = useProjects().data ?? [];
  const [pid, setPid] = useState(initial ?? "");
  // Each session gets its own worktree (made by the backend if needed); the default branch is reserved.
  const [picked, setBranch] = useState("");
  // "new": branch off `from` into a fresh worktree; the default branch can be the base.
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [pickedFrom, setFrom] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("feat");
  const [request, setRequest] = useState("");
  const [pick, setPick] = useAgentPick(pid);
  const ov = useOverview(pid).data;
  const all = (ov?.branches ?? []).filter((b) => b.exists);
  const branches = all.filter((b) => b.name !== ov?.defaultBranch);
  const branch = branches.find((b) => b.name === picked)?.name ?? branches[0]?.name ?? "";
  const from = all.find((b) => b.name === pickedFrom)?.name ?? ov?.defaultBranch ?? "";
  const fresh = mode === "new";
  const label = (b: { name: string; local: boolean }) => (b.local ? b.name : `${b.name} (origin)`);
  const start = useAction("agents.start", { invalidate: [["agents"], ["worktrees"]], success: "Agent started" });
  const create = useAction<{ branch: string }>("items.create", {
    invalidate: [["overview", pid], ["agents"], ["worktrees"]],
    success: (r) => `Agent started on ${r.branch}`,
  });
  const busy = start.isPending || create.isPending;
  const ready = !!pid && !!(fresh ? from : branch) && !!request.trim() && !busy;
  const go = () =>
    fresh
      ? create.mutate(
          // Empty name: the backend names the branch from the request.
          { projectId: pid, from, kind: kindOfBranch(name) ?? kind, description: request, branchName: name.trim() || undefined, where: "worktree", startAgent: true, ...pick },
          { onSuccess: onClose },
        )
      : start.mutate({ projectId: pid, branch, request, ...pick }, { onSuccess: onClose });
  return (
    <Modal
      title="New agent session"
      sub={fresh ? from && `Runs in a new worktree on a branch off ${from}` : branch && `Runs in its own worktree on ${branch}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-md" disabled={!ready} onClick={go}>
            <Busy on={busy}><Icon name="play" size={12} /></Busy>
            Start
          </button>
        </>
      }
    >
      <Seg<"existing" | "new"> grid label="Branch" value={mode} onChange={setMode} options={[{ value: "existing", label: "Existing branch" }, { value: "new", label: "New branch" }]} />
      <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
        <div className="field grow">
          <span>Project</span>
          <MenuChoice className="select menu-select" label="Project" value={pid} options={projects.map((p) => ({ value: p.id, label: p.name }))} onChange={(v) => { setPid(v); setBranch(""); setFrom(""); }} />
        </div>
        <div className="field grow">
          <span>{fresh ? "Branches off" : "Branch"}</span>
          <MenuChoice
            className="select menu-select"
            label={fresh ? "Branches off" : "Branch"}
            value={fresh ? from : branch}
            options={(fresh ? all : branches).map((b) => ({ value: b.name, label: label(b) }))}
            onChange={fresh ? setFrom : setBranch}
          />
        </div>
      </div>
      {fresh && <Seg<Kind> grid cols={6} label="Type" value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k.id, label: k.label }))} />}
      {fresh && (
        <div className="field">
          <label htmlFor="ag-name">Branch name <span className="faint" style={{ fontWeight: 400 }}>optional</span></label>
          <input
            id="ag-name"
            className="input mono"
            placeholder="Leave empty to name it from the request"
            value={name}
            // Git names can't hold spaces: each one becomes a dash as you type.
            onChange={(e) => setName(e.target.value.replace(/\s/g, "-"))}
          />
        </div>
      )}
      {ov && !fresh && !branches.length && <p className="hint c-del">{ov.defaultBranch} is reserved: create a new branch to start an agent session.</p>}
      {!fresh && branch && branch === ov?.currentBranch && (
        <p className="hint">{branch} is checked out in the main checkout: it is switched off it first, which needs no uncommitted changes there.</p>
      )}
      <div className="field">
        <span>Agent</span>
        <AgentPicker value={pick} onChange={setPick} />
      </div>
      <div className="field">
        <label htmlFor="ag-req">What should the agent do?</label>
        <textarea
          id="ag-req"
          className="textarea"
          rows={5}
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && ready) go(); }}
          autoFocus
        />
        <span className="hint">⌘↵ to start</span>
      </div>
    </Modal>
  );
}
