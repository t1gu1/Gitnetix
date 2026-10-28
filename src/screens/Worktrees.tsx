import { useMemo, useState, type CSSProperties, type MouseEvent } from "react";

import { useAction, useAgents, useFiles, useOverview, useProjects, useWorktrees } from "../api/hooks";
import { rpc } from "../api/transport";
import type { AgentSession, AgentStatus, RebaseResult, WorktreeView } from "../api/types";
import { AgentInput, AgentLog, RequestField, uploads, type Attachment, type Choice, type Upload } from "../components/AgentLog";
import { shownStatus } from "../lib/agentLog";
import { AgentPicker, MenuChoice, useAgentPick } from "../components/AgentPicker";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { Resizer, usePaneWidth } from "../components/Resizer";
import { ShellPane, TermTabs, useTermView } from "../components/Shell";
import { ago, Busy, Confirm, Empty, EmptyState, Header, Modal, Seg } from "../components/ui";
import { plural } from "../lib/format";
import { agentKey, useHidden, wtKey } from "../lib/tasks";
import { copyToClipboard } from "../lib/toast";
import { KINDS, kindOfBranch, type Kind } from "../lib/kinds";
import { useNav } from "../lib/nav";
import { useStored } from "../lib/stored";
import { useBranchActions } from "./BranchMenu";
import { revealBranch } from "./BranchTree";
import { ConflictModal } from "./ConflictModal";
import { clearSession, DiscardWorktreeModal, FinishWorktreeCard, MergeModal, mergeTargets, TargetBranchModal, useFinishHandlers } from "./Workspace";

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
  done: "needs",
  failed: "needs",
};

const match = (s: Row["status"], f: Filter) => f === "all" || GROUP[s] === f;

/** Show `r`'s branch selected in its project's workspace, the tree's sections opened down to it. */
function openInWorkspace(nav: ReturnType<typeof useNav>, r: Row) {
  revealBranch(r.projectId, r.branch);
  nav.setProject(r.projectId);
  nav.selectBranch(r.branch);
  nav.go({ name: "workspace" });
}

export function Worktrees({ initial }: { initial?: string }) {
  const nav = useNav();
  const wts = useWorktrees();
  const agents = useAgents();
  const projects = useProjects().data ?? [];
  const [filter, setFilter] = useState<Filter>("all");
  // Projects left out of the list; ones added later show.
  const [hiddenProjects, setHiddenProjects] = useStored<string[]>("gnx.worktrees.hidden", []);
  const off = projects.filter((p) => hiddenProjects.includes(p.id));
  const shown = projects.filter((p) => !hiddenProjects.includes(p.id));
  const [sel, setSel] = useState<string | undefined>(initial);
  const [pane, setPane] = useState<"list" | "detail">(initial ? "detail" : "list");
  const listW = usePaneWidth("gnx.pane.worktrees", 400, 280, 720);
  // The project the new session modal opens on; undefined while it is closed.
  const [starting, setStarting] = useState<string>();
  // Right-click or "…" selects the row and opens its actions: they and their modals live in its Detail.
  const [menu, setMenu] = useState<{ key: string; x: number; y: number; alignRight?: boolean } | null>(null);
  const openMenu = (r: Row, e: MouseEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // Keyboard-opened context menus report (0, 0): anchor to the element instead.
    const b = e.currentTarget.getBoundingClientRect();
    const fromKey = e.type === "contextmenu" && e.clientX === 0 && e.clientY === 0;
    setSel(r.key);
    if (e.type !== "contextmenu") setMenu({ key: r.key, x: b.right, y: b.bottom + 2, alignRight: true });
    else setMenu({ key: r.key, x: fromKey ? b.left : e.clientX, y: fromKey ? b.bottom + 2 : e.clientY });
  };

  const gone = useHidden();
  // One row per linked worktree; agents elsewhere (main checkout, removed directory) still show up.
  // Worktrees and sessions a background action is taking away are gone from the click on.
  const all: Row[] = useMemo(() => {
    const list: Row[] = (wts.data ?? []).filter((w) => !w.main).map((w) => {
      const a = (agents.data ?? []).find((x) => x.cwd === w.path) ?? w.agent ?? undefined;
      return { key: w.path, wt: w, agent: a, projectId: w.projectId, projectName: w.projectName, branch: w.branch ?? "(detached)", path: w.path, status: a ? shownStatus(a, w) : "idle" };
    });
    for (const a of agents.data ?? []) {
      if (!list.some((r) => r.agent?.id === a.id)) {
        const p = projects.find((x) => x.id === a.projectId);
        const w = wts.data?.find((x) => x.path === a.cwd);
        list.push({ key: a.id, wt: w, agent: a, projectId: a.projectId, projectName: p?.name ?? "?", branch: a.branch, path: a.cwd, status: shownStatus(a, w) });
      }
    }
    return list.filter((r) => !gone.has(wtKey(r.path)) && !(r.agent && gone.has(agentKey(r.agent.id))));
  }, [wts.data, agents.data, projects, gone]);
  // A hidden project's rows are gone, from the counts too. The one opened from elsewhere stays, its project with it.
  const rows = all.filter((r) => !hiddenProjects.includes(r.projectId) || r.key === initial);

  const cur = rows.find((r) => r.key === sel) ?? rows[0];
  // Projects with matching rows first; the rest sink to the bottom as bare headers.
  const groups = [...new Set([...shown.map((p) => p.name), ...rows.map((r) => r.projectName)])]
    .map((name) => ({ name, id: shown.find((p) => p.name === name)?.id, items: rows.filter((r) => r.projectName === name && match(r.status, filter)) }))
    .filter((g) => g.items.length || filter === "all")
    .sort((a, b) => +!a.items.length - +!b.items.length);
  const loading = wts.isLoading || agents.isLoading;
  // Until the fresh list lands (last time's may show meanwhile), the project names glint.
  const refreshing = loading || wts.isPlaceholderData;
  // A closed or merged worktree drops out: on narrow screens go back to the list, not into the next one.
  if (pane === "detail" && !refreshing && !rows.some((r) => r.key === sel)) setPane("list");

  return (
    <>
      <Header title="Worktrees & agents" sub={off.length ? `${shown.length} of ${plural(projects.length, "project")}` : "All projects"} hideWide onBack={pane === "detail" ? () => setPane("list") : undefined} />
      <div className="body split">
        <section className="master" style={{ "--master-w": `${listW.width}px` } as CSSProperties} data-pane data-active={pane === "list"} aria-label="Worktrees">
          <div className="master-tools">
            <div className="row" style={{ margin: 0, gap: 8, alignItems: "stretch" }}>
              <div className="grow" style={{ minWidth: 0 }}>
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
              </div>
              <ProjectFilter projects={projects} hidden={off.map((p) => p.id)} onChange={setHiddenProjects} />
            </div>
          </div>
          <div className="scroll" style={{ flex: "1 1 auto", paddingBottom: 12 }} aria-busy={refreshing || undefined}>
            {groups.map((g, i) => (
              // Loading, every project keeps a full header: the ones with worktrees don't grow when they arrive.
              <div key={g.name} className="wt-group" data-empty={(!loading && !g.items.length) || undefined}>
                <div className="wt-group-head">
                  {/* Not a spinner above the list: nothing moves when the glint stops. */}
                  <span className="ellipsis" data-glint={refreshing || undefined} style={{ "--i": i } as CSSProperties}>{g.name}</span>
                  <span className="grow" />
                  {!loading && <span className="faint">{g.items.length || "No worktrees"}</span>}
                  {g.id && (
                    <button className="btn btn-ghost btn-sm btn-icon" aria-label={`New agent session in ${g.name}`} data-tip="New agent session" onClick={() => setStarting(g.id)}>
                      <Icon name="plus" size={12} />
                    </button>
                  )}
                </div>
                {g.items.map((r) => {
                  const [label, cls] = STATUS[r.status];
                  const sub = !r.wt ? "Directory removed" : r.agent?.request.split("\n")[0];
                  const more = `More actions for ${r.branch}`;
                  const show = `Show ${r.branch} in the workspace`;
                  return (
                    <div key={r.key} className="wt-item" onContextMenu={(e) => openMenu(r, e)}>
                      <button className="item-btn wt-row" aria-pressed={r.key === cur?.key} title={r.path} onClick={() => { setSel(r.key); setPane("detail"); }}>
                        <span className="row" style={{ gap: 8 }}>
                          <span className={`mono ellipsis grow${r.wt ? "" : " faint"}`}>{r.branch}</span>
                          {r.wt && (r.wt.additions > 0 || r.wt.deletions > 0) && (
                            <span className="mono wt-stat"><span className="c-add">+{r.wt.additions}</span> <span className="c-del">−{r.wt.deletions}</span></span>
                          )}
                        </span>
                        {r.wt?.base && (
                          <span className="row wt-base" style={{ gap: 6 }}>
                            <span className="faint ellipsis">from {r.wt.base}</span>
                            {r.wt.behind > 0 && (
                              <span className="c-warn mono" style={{ flex: "none" }} title={`${r.wt.base} has ${plural(r.wt.behind, "commit")} that ${r.branch} doesn't. Update or rebase to catch up.`}>
                                ↓{r.wt.behind}
                              </span>
                            )}
                          </span>
                        )}
                        <span className="row wt-meta">
                          <span className={r.status === "running" ? "pulse" : `wt-dot ${cls}`} />
                          <span className={cls} style={{ flex: "none" }}>{label}</span>
                          {sub && <span className="faint">·</span>}
                          <span className="faint ellipsis grow">{sub}</span>
                          {r.agent && <span className="faint" style={{ flex: "none" }}>{ago(r.agent.updatedAt)}</span>}
                        </span>
                      </button>
                      {/* Stacked like a branch's "+" over its "…"; alone (directory removed), the "…" takes the whole height. */}
                      <span className="tree-acts">
                        <span className="acts act-stack">
                          {r.wt && (
                            <button className="act act-main" aria-label={show} data-tip={show} onClick={() => openInWorkspace(nav, r)}>
                              <Icon name="eye" size={14} />
                            </button>
                          )}
                          <button className="act act-main" aria-label={more} data-tip={more} aria-haspopup="menu" onClick={(e) => openMenu(r, e)}>
                            <Icon name="more" size={14} />
                          </button>
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
            {!loading && !groups.some((g) => g.items.length) && filter !== "all" && <Empty>{filter === "running" ? "No agent running." : "Nothing waiting on you."}</Empty>}
            {!loading && groups.length === 0 && filter === "all" && (
              off.length ? (
                <Empty>
                  Every project is hidden.{" "}
                  <button className="btn btn-sm" onClick={() => setHiddenProjects([])}>Show all projects</button>
                </Empty>
              ) : (
                <Empty>Nothing here right now.</Empty>
              )
            )}
          </div>
          <div className="master-tools" style={{ borderBottom: 0, borderTop: "1px solid var(--line)" }}>
            <button className="btn btn-primary" style={{ height: 48, fontSize: 13.5 }} disabled={!projects.length} onClick={() => setStarting(nav.projectId ?? cur?.projectId ?? projects[0]?.id)}>
              <Icon name="sparkle" size={13} />
              New agent session
            </button>
          </div>
        </section>
        <Resizer pane={listW} label="Resize worktree list" />
        <main className="detail wt-pane" data-pane data-active={pane === "detail"}>
          {cur ? <Detail key={cur.key} r={cur} menu={menu?.key === cur.key ? menu : undefined} onMenuClose={() => setMenu(null)} /> : <EmptyState icon="layers" title="No worktree selected">Pick one from the list, or start a new agent session to give a branch its own folder and agent.</EmptyState>}
        </main>
      </div>
      {starting && <StartModal initial={starting} onClose={() => setStarting(undefined)} />}
    </>
  );
}

/** Dropdown picking the projects to list; unchecked ones (ids in `hidden`) are left out. Hidden with a single project. */
function ProjectFilter({ projects, hidden, onChange }: { projects: { id: string; name: string }[]; hidden: string[]; onChange: (hidden: string[]) => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  if (projects.length < 2 && !hidden.length) return null;
  const check = <Icon name="check" size={13} />;
  return (
    <>
      {/* Same label filtered or not: a wider one cuts "Needs you" short. The accent border tells it is on. */}
      <button
        className="btn"
        style={{ flex: "none", height: "auto", fontSize: 12, ...(hidden.length && { borderColor: "var(--accent)", background: "var(--raised)" }) }}
        aria-haspopup="menu"
        aria-label="Filter by project"
        data-tip={hidden.length ? `${projects.length - hidden.length} of ${plural(projects.length, "project")} shown` : "Show only these projects"}
        onClick={(e) => {
          const b = e.currentTarget.getBoundingClientRect();
          setMenu({ x: b.right, y: b.bottom + 2 });
        }}
      >
        Projects
        <Icon name="chevronDown" size={10} />
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          alignRight
          label="Filter by project"
          onClose={() => setMenu(null)}
          items={[
            { id: "all", label: "All projects", icon: null, hint: !hidden.length && check, keep: true, run: () => onChange([]) },
            "sep",
            ...projects.map((p) => ({
              id: p.id,
              label: p.name,
              icon: null,
              hint: !hidden.includes(p.id) && check,
              keep: true,
              run: () => onChange(hidden.includes(p.id) ? hidden.filter((x) => x !== p.id) : [...hidden, p.id]),
            })),
          ]}
        />
      )}
    </>
  );
}

function Detail({ r, menu, onMenuClose }: { r: Row; menu?: { x: number; y: number; alignRight?: boolean }; onMenuClose: () => void }) {
  const nav = useNav();
  const a = r.agent;
  const inv = [["agents"], ["worktrees"]];
  const pause = useAction("agents.pause", { invalidate: inv });
  const resume = useAction("agents.resume", { invalidate: inv });
  const stop = useAction("agents.stop", { invalidate: inv });
  const msg = useAction("agents.message", { invalidate: inv });
  const configure = useAction("agents.configure", { invalidate: inv });
  const start = useAction("agents.start", { invalidate: inv });
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [picks, setPicks] = useState<Choice[]>([]);
  const actions = useBranchActions(r.projectId, () => {});
  const ov = useOverview(r.projectId);
  // Merging deletes the worktree at `cwd` once done; `stay` leaves the main checkout where it is.
  const [merging, setMerging] = useState<{ cwd: string; stay: boolean; into?: string } | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [targeting, setTargeting] = useState(false);
  const finish = useFinishHandlers(r.projectId, actions.continueOn, (_, cwd, stay, into) => setMerging({ cwd, stay, into }));
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
  const view = ov.data?.branches.find((x) => x.name === r.branch);
  const base = view?.parent ?? "";
  const rebase = useAction<RebaseResult>("workspace.rebase", { invalidate: [...commitInv, ["worktrees"]], success: (x) => (x.conflicts.length ? undefined : `Rebased onto ${base}`) });
  const [resolving, setResolving] = useState(false);
  // Already on origin: the rewritten commits go up forced (with lease: refused if origin has commits never pulled here).
  const afterRebase = (x: RebaseResult) => (x.conflicts.length ? setResolving(true) : x.forcePushTo && push.mutate({ projectId: r.projectId, branch: r.branch, force: true }));
  const update = async () => {
    // Base caught up with origin first; local-only or diverged, it stays as is.
    await rpc("branches.pull", { projectId: r.projectId, branch: base }).catch(() => undefined);
    rebase.mutate({ projectId: r.projectId, branch: r.branch }, { onSuccess: afterRebase });
  };
  const [pick, setPick] = useAgentPick(r.projectId);
  const [termView, setTermView] = useTermView(r.projectId, r.branch, !!a, isWorktree);
  const busy = a?.status === "running" || a?.status === "paused";
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
    if (a) msg.mutate({ id: a.id, text: t, files: up }, done);
    else start.mutate({ projectId: r.projectId, branch: r.wt?.branch ?? undefined, request: t, files: up, ...pick }, done);
  };
  const commitPush = () => commit.mutate({ projectId: r.projectId, branch: r.branch, message: "", all: !staged }, { onSuccess: () => push.mutate({ projectId: r.projectId, branch: r.branch }) });
  const retry = (id: string) => msg.mutate({ id, text: "The last run failed. Read the errors above, fix them and try again." });
  // The row's "…" / right-click menu: the terminal fills the pane, so these are the worktree's only action buttons.
  const items = ([
    a?.status === "waiting" && r.wt && { id: "commit", label: "Commit & Push changes", icon: "sparkle", hint: String(staged || changed), disabled: !changed || commit.isPending || push.isPending, run: commitPush },
    a?.status === "failed" && { id: "retry", label: "Fix and retry with AI", icon: "sparkle", run: () => retry(a.id) },
    a?.status === "running" && { id: "pause", label: "Pause", icon: "pause", run: () => pause.mutate({ id: a.id }) },
    a?.status === "paused" && { id: "resume", label: "Resume", icon: "play", run: () => resume.mutate({ id: a.id }) },
    busy && a && { id: "stop", label: "Stop agent", icon: "stop", run: () => halt(a) },
    r.wt && { id: "open", label: "Open in workspace", icon: "external", run: () => openInWorkspace(nav, r) },
    { id: "copyName", label: "Copy workspace name", icon: "copy", run: () => copyToClipboard(r.path.split(/[\\/]/).pop() ?? r.path) },
    a && !busy && !isWorktree && { id: "clear", label: "Clear session…", icon: "close", danger: true, run: () => setClearing(true) },
    isWorktree && "sep",
    isWorktree && { id: "continue", label: "Continue on branch", icon: "swap", run: () => finish.continue(session, true) },
    isWorktree && view?.conflict && { id: "conflicts", label: "Resolve conflicts…", icon: "sparkle", run: () => setResolving(true) },
    isWorktree && view?.exists && r.branch !== ov.data?.defaultBranch && { id: "target", label: "Change target branch…", icon: "merged", run: () => setTargeting(true) },
    // Work branches only: shared ones (releases, dev) catch up by merging. Not under a working agent.
    isWorktree && !view?.conflict && view?.role === "branch" && !view.protected && !!base && {
      id: "rebase",
      label: <>Rebase onto <span className="mono">{base}</span></>,
      icon: "branch",
      hint: view.behind ? `${view.behind} behind` : undefined,
      disabled: busy || rebase.isPending || push.isPending,
      run: update,
    },
    isWorktree && { id: "merge", label: "Merge…", icon: "merged", run: () => finish.merge(session, true) },
    isWorktree && { id: "discard", label: "Cancel and Delete all…", icon: "trash", danger: true, run: () => setDiscarding(true) },
  ] as (MenuItem | false | undefined)[]).filter((x): x is MenuItem => !!x);
  return (
    <div className="detail-inner" style={{ flex: 1, minHeight: 0 }}>
      <div className="col card term-max" style={{ flex: "1 1 320px", minHeight: 280, gap: 0, overflow: "hidden", background: "var(--term)" }}>
        <div className="term-tabs">
          <TermTabs value={termView} onChange={setTermView} />
          <span className="grow" />
          <span className="hint row hide-narrow" style={{ padding: "0 14px" }}>Keeps running when you switch project</span>
        </div>
        {termView === "shell" ? (
          <ShellPane projectId={r.projectId} path={r.wt ? r.path : undefined} />
        ) : (
          <>
            <AgentLog lines={a?.lines ?? []} session={a?.id} projectId={r.projectId} provider={a ? a.ai?.provider : pick.provider} thinking={a?.status === "running" || msg.isPending || start.isPending} queued={a?.queued} actions={isWorktree && <FinishWorktreeCard session={session} finish={finish} />} picks={picks} onPicks={setPicks} empty={r.wt ? "No agent session on this checkout." : "Directory removed."} />
            <AgentInput
              id="wt-ask"
              label="Message the agent"
              value={text}
              onChange={setText}
              files={files}
              onFiles={setFiles}
              picks={picks}
              onPicks={setPicks}
              onSend={send}
              onStop={busy && a ? () => halt(a) : undefined}
              log={a?.lines}
              disabled={!a && !r.wt}
              pending={msg.isPending || start.isPending}
              picker={a?.ai ? <AgentPicker value={a.ai} onChange={(p) => configure.mutate({ id: a.id, ...p })} compact /> : !a && r.wt && <AgentPicker value={pick} onChange={setPick} compact />}
              placeholder={busy ? "Agent is working… a message now waits for it to finish" : a ? `Message the agent on ${r.branch}…` : "Start a session: describe what the agent should do…"}
            />
          </>
        )}
      </div>
      {merging && (
        <MergeModal
          pid={r.projectId}
          branch={r.branch}
          base={merging.into ?? base}
          others={mergeTargets(ov.data?.branches ?? [], r.branch)}
          worktree={merging.cwd}
          stay={merging.stay}
          onClose={() => setMerging(null)}
        />
      )}
      {targeting && ov.data && (
        // This screen shows branch names as they are, releases included.
        <TargetBranchModal pid={r.projectId} branch={r.branch} branches={ov.data.branches} labelOf={(b) => b} onClose={() => setTargeting(false)} onTargeted={() => setTargeting(false)} />
      )}
      {discarding && <DiscardWorktreeModal branch={r.branch} path={r.path} onClose={() => setDiscarding(false)} onConfirm={() => finish.discard(session)} />}
      {clearing && a && (
        <Confirm
          title="Clear agent session"
          sub={<span className="mono">{r.branch}</span>}
          action="Clear session"
          onBack={() => setClearing(false)}
          onConfirm={() => {
            clearSession(a);
            setClearing(false);
          }}
        >
          The agent stops if it is working, and its conversation is deleted.
        </Confirm>
      )}
      {finish.modal}
      {resolving && <ConflictModal pid={r.projectId} branch={r.branch} base={base} onClose={() => setResolving(false)} onDone={afterRebase} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} alignRight={menu.alignRight} label={`Actions for ${r.branch}`} items={items} onClose={onMenuClose} />}
    </div>
  );
}

function StartModal({ initial, onClose }: { initial?: string; onClose: () => void }) {
  const projects = useProjects().data ?? [];
  const [pid, setPid] = useState(initial ?? "");
  // Each session gets its own worktree (made by the backend if needed); the default branch is reserved.
  const [picked, setBranch] = useState("");
  // "new": branch off `from` into a fresh worktree; the default branch can be the base.
  const [pickedMode, setMode] = useState<"existing" | "new">();
  const [pickedFrom, setFrom] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("feat");
  const [typedTicket, setTicket] = useState<string>();
  const [request, setRequest] = useState("");
  // Files for the agent, like in its prompt box: picked, pasted, or dropped anywhere on the modal.
  const [files, setFiles] = useState<Attachment[]>([]);
  const [pick, setPick] = useAgentPick(pid);
  const ov = useOverview(pid).data;
  const all = (ov?.branches ?? []).filter((b) => b.exists);
  const branches = all.filter((b) => b.name !== ov?.defaultBranch);
  // The checked-out branch is the one picked until another is.
  const current = all.find((b) => b.name === ov?.currentBranch);
  const branch = branches.find((b) => b.name === picked)?.name ?? branches.find((b) => b === current)?.name ?? branches[0]?.name ?? "";
  // Checked out on a trunk (main, master, dev) or release branch: offer a new branch off it.
  const on = current?.role !== "branch" ? current : undefined;
  const mode = pickedMode ?? (on || (ov && !branches.length) ? "new" : "existing");
  const from = all.find((b) => b.name === pickedFrom)?.name ?? on?.name ?? ov?.defaultBranch ?? "";
  const fresh = mode === "new";
  // An existing branch shows the ticket it already carries (linked, or a key in its name) until one is typed.
  const ticket = typedTicket ?? (fresh ? "" : (branches.find((b) => b.name === branch)?.ticket ?? ""));
  const label = (b: { name: string; local: boolean }) => (b.local ? b.name : `${b.name} (origin)`);
  const start = useAction("agents.start", { invalidate: [["agents"], ["worktrees"]], success: "Agent started" });
  const create = useAction<{ branch: string }>("items.create", {
    invalidate: [["overview", pid], ["agents"], ["worktrees"]],
    success: (r) => `Agent started on ${r.branch}`,
  });
  const busy = start.isPending || create.isPending;
  const ready = !!pid && !!(fresh ? from : branch) && !!request.trim() && !busy;
  const go = async () => {
    const up = await uploads(files);
    if (fresh)
      create.mutate(
        // Empty name: the backend names the branch from the request.
        { projectId: pid, from, kind: kindOfBranch(name) ?? kind, description: request, branchName: name.trim() || undefined, ticket: ticket.trim() || undefined, where: "worktree", startAgent: true, files: up, ...pick },
        { onSuccess: onClose },
      );
    else start.mutate({ projectId: pid, branch, request, ticket: ticket.trim() || undefined, files: up, ...pick }, { onSuccess: onClose });
  };
  return (
    <Modal
      title="New agent session"
      sub={fresh ? from && <>Runs in a new worktree on a branch off <strong className="c-acc">{from}</strong></> : branch && <>Runs in its own worktree on <strong className="c-acc">{branch}</strong></>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-primary btn-md" disabled={!ready} onClick={go}>
            <Busy on={busy}><Icon name="play" size={12} /></Busy>
            Start
          </button>
        </>
      }
    >
      <Seg<"existing" | "new"> grid label="Branch" value={mode} onChange={setMode} options={[{ value: "existing", label: "Existing branch" }, { value: "new", label: "New branch" }]} />
      <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
        {/* Set shares, twice as much for the branch: a long picked name gets cut instead of squeezing the project. */}
        <div className="field" style={{ flex: "1 1 0", minWidth: 0 }}>
          <span>Project</span>
          <MenuChoice className="select menu-select" label="Project" value={pid} options={projects.map((p) => ({ value: p.id, label: p.name }))} onChange={(v) => { setPid(v); setBranch(""); setFrom(""); setMode(undefined); setTicket(undefined); }} />
        </div>
        <div className="field" style={{ flex: "2 1 0", minWidth: 0 }}>
          <span>{fresh ? "Branches off" : "Branch"}</span>
          <MenuChoice
            className="select menu-select"
            label={fresh ? "Branches off" : "Branch"}
            search="Filter branches"
            value={fresh ? from : branch}
            options={(fresh ? all : branches).map((b) => ({ value: b.name, label: label(b) }))}
            onChange={fresh ? setFrom : setBranch}
          />
        </div>
        {/* Linked to the branch: the agent gets the ticket's content from Jira, Trello or Asana. */}
        <div className="field" style={{ flex: "0 1 140px", minWidth: 0 }}>
          <label htmlFor="ag-ticket">Ticket <span className="faint" style={{ fontWeight: 400 }}>optional</span></label>
          <input id="ag-ticket" className="input mono" placeholder="ATL-212" value={ticket} onChange={(e) => setTicket(e.target.value)} />
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
      <RequestField value={request} onChange={setRequest} files={files} onFiles={setFiles} onSubmit={() => ready && go()} />
    </Modal>
  );
}
