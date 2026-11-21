import { useMutationState, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { useAction, useOverview, usePendingBranches, usePr, usePrDiff, usePrFiles, useProjectPrefs, usePrs } from "../api/hooks";
import { openExternal, rpc, RpcError } from "../api/transport";
import type { FileChange, PrDetail, PrSummary, PrThread } from "../api/types";
import { Avatar } from "../components/Avatar";
import { DiffView, type DiffAt, type Review } from "../components/DiffView";
import { Icon } from "../components/Icon";
import { PictureSource } from "../components/Picture";
import { Resizer, usePaneWidth } from "../components/Resizer";
import { ago, Busy, Empty, EmptyState, ErrorBox, Header, initials, Loading, Markdown, MEDIA, MediaAsk, Modal, Seg, swipeProps } from "../components/ui";
import { plural } from "../lib/format";
import { useNav } from "../lib/nav";
import { useStored } from "../lib/stored";
import { toast } from "../lib/toast";

type Tab = "open" | "review" | "closed";
type View = "conversation" | "files";
type Who = "mine" | "others" | "all";
const GROUPS: PrSummary["state"][] = ["open", "draft", "merged", "closed"];
const EMOJI: [string, string, string][] = [
  ["THUMBS_UP", "👍", "Thumbs up"],
  ["THUMBS_DOWN", "👎", "Thumbs down"],
  ["LAUGH", "😄", "Laugh"],
  ["HOORAY", "🎉", "Hooray"],
  ["HEART", "❤️", "Heart"],
  ["ROCKET", "🚀", "Rocket"],
];

const HOSTS: Record<string, string> = { github: "GitHub", azure: "Azure DevOps", gitlab: "GitLab", bitbucket: "Bitbucket", gitea: "Gitea" };

/** Name of the host the project's pull requests live on, from the cached list. */
function useHost(pid: string) {
  return HOSTS[usePrs(pid).data?.provider ?? ""] ?? "GitHub";
}

function stateOf(p: PrSummary, d?: PrDetail): [string, string] {
  if (p.state === "merged") return ["Merged", "c-mod"];
  if (p.state === "closed") return ["Closed", "faint"];
  if (d?.conflict) return ["Conflict", "c-del"];
  if (p.state === "draft") return ["Draft", "muted"];
  if (d?.checks.some((c) => c.status === "run")) return ["Checks running", "c-acc"];
  if (d?.checks.some((c) => c.status === "wait")) return ["Checks waiting", "c-acc"];
  if (d && d.reviewers.some((r) => r.vote === "approve") && !d.checks.some((c) => c.status === "fail")) return ["Ready to merge", "c-add"];
  return ["Open", "c-add"];
}

export function PullRequests({ initial }: { initial?: number }) {
  const nav = useNav();
  const pid = nav.projectId!;
  const qc = useQueryClient();
  const prs = usePrs(pid);
  const ov = useOverview(pid).data;
  const [tab, setTab] = useState<Tab>("open");
  const [who, setWho] = useStored<Who>("gnx.prs.who", "mine", (s) => (s === "others" || s === "all" ? s : "mine"), String);
  const [search, setSearch] = useStored("gnx.prs.search", "");
  const [sel, setSel] = useState<number | undefined>(initial);
  const [pane, setPane] = useState<"list" | "detail">(initial ? "detail" : "list");
  const listW = usePaneWidth("gnx.pane.prs", 460, 280, 720);
  const all = prs.data?.items ?? [];
  const term = search.trim().toLowerCase();
  const items = all.filter((p) => !term || `#${p.number} ${p.title} ${p.head} ${p.author}`.toLowerCase().includes(term));
  // The open pull request's checks and reviews are fetched on their own, so a sync refreshes them too.
  const sync = () => {
    prs.refetch();
    qc.invalidateQueries({ queryKey: ["pr", pid] });
  };
  // Review requests are always on someone else's pull requests, so the author filter skips them.
  const inTab = (p: PrSummary, t: Tab) =>
    t === "review"
      ? p.reviewRequested && p.state !== "merged" && p.state !== "closed"
      : (who === "all" || p.mine === (who === "mine")) && (t === "closed" ? p.state === "merged" || p.state === "closed" : p.state === "open" || p.state === "draft");
  const list = items.filter((p) => inTab(p, tab));
  const current = sel ?? list[0]?.number;
  const create = useAction<PrSummary>("prs.create", { invalidate: [["prs", pid]], success: (r) => `Opened #${r.number}` });
  const branch = nav.selectedBranch ?? ov?.currentBranch;
  // From the mutation cache, so it still shows after leaving the page and coming back.
  const creating = usePendingBranches("prs.create", pid).includes(branch ?? "");
  const bv = ov?.branches.find((b) => b.name === branch);
  // Pushed commits = commits ahead of its base that origin already has.
  const unpushed = !bv
    ? undefined
    : bv.ahead === 0
      ? `${branch} has no commits ahead of its base yet.`
      : !bv.remote || bv.ahead - bv.upstreamAhead <= 0
        ? `Push commits to ${branch} before opening a pull request.`
        : undefined;
  const errCode = prs.error instanceof RpcError ? prs.error.code : undefined;

  return (
    <>
      <Header title="Pull requests" sub={`${ov?.project.name ?? ""}${prs.data ? ` · ${HOSTS[prs.data.provider] ?? "GitHub"} ${prs.data.repo.owner}/${prs.data.repo.repo}` : ""}`} hideWide onBack={pane === "detail" ? () => setPane("list") : undefined} />
      {prs.error ? (
        <EmptyState
          icon="pr"
          title={errCode === "unsupported" ? "Git provider not supported" : errCode === "not_connected" ? "No Git provider connected" : "Couldn't load pull requests"}
          action={<button className="btn btn-primary btn-md" onClick={() => nav.go({ name: "menu", section: "git" })}>Open Git providers</button>}
        >
          {prs.error.message}
        </EmptyState>
      ) : (
        <div className="body split">
          <section aria-label="Pull request list" className="master" style={{ "--master-w": `${listW.width}px` } as CSSProperties} data-pane data-active={pane === "list"}>
            <div className="master-tools">
              <label htmlFor="pr-q" className="sr-only">Search pull requests</label>
              <div className="row" style={{ gap: 6, margin: 0 }}>
                <input id="pr-q" className="input grow" placeholder="Search by number, title, branch or author" value={search} onChange={(e) => setSearch(e.target.value, false)} onBlur={() => setSearch(search)} />
                <button className="btn btn-icon" aria-label="Sync now" data-tip={prs.dataUpdatedAt ? `Sync now · synced ${ago(new Date(prs.dataUpdatedAt).toISOString())}` : "Sync now"} onClick={sync}>
                  <Busy on={prs.isFetching}><Icon name="refresh" size={13} /></Busy>
                </button>
              </div>
              <Seg<Tab>
                grid
                label="Filter"
                value={tab}
                onChange={(t) => { setTab(t); setSel(undefined); }}
                options={(["open", "review", "closed"] as Tab[]).map((t) => ({
                  value: t,
                  label: <>{t === "open" ? "Open" : t === "review" ? "To review" : "Closed"} <span className="faint">{items.filter((p) => inTab(p, t)).length}</span></>,
                }))}
              />
              {tab !== "review" && (
                <Seg<Who>
                  grid
                  label="Author"
                  value={who}
                  onChange={(w) => { setWho(w); setSel(undefined); }}
                  options={[{ value: "mine", label: "Mine" }, { value: "others", label: "Others" }, { value: "all", label: "All" }]}
                />
              )}
            </div>
            <div className="scroll" style={{ flex: "1 1 auto", paddingBottom: 12 }}>
              {prs.isLoading && <Loading />}
              {!prs.isLoading && list.length === 0 && <Empty>{term && all.length ? "No pull requests match this search." : "Nothing here."}</Empty>}
              {GROUPS.map((s) => ({ s, items: list.filter((p) => p.state === s) }))
                .filter((g) => g.items.length)
                .map(({ s, items }) => {
                  const [label, cls] = stateOf(items[0]);
                  return (
                    <div key={s}>
                      <div className="group-head" style={{ fontSize: 13, fontWeight: 700 }}>
                        <span className={cls}>{label}</span>
                        <span>{items.length}</span>
                      </div>
                      <div className="col" style={{ gap: 2 }}>
                        {items.map((p) => (
                          <button key={p.number} className="item-btn" style={{ gap: 1, padding: "7px 12px" }} aria-pressed={p.number === current} onClick={() => { setSel(p.number); setPane("detail"); }}>
                            <span className="row" style={{ gap: 8, margin: "0 0 2px", fontSize: 11.5 }}>
                              <Avatar name={p.author} />
                              <span className="mono faint">#{p.number}</span>
                              <span className={cls} style={{ fontSize: 13 }}>{label}</span>
                              <span className="faint ellipsis grow">{p.mine ? "You" : p.author}</span>
                              <span className="faint">{ago(p.updatedAt)}</span>
                            </span>
                            <span className="ellipsis" style={{ fontWeight: 500 }}>{p.title}</span>
                            <span className="mono faint ellipsis" style={{ fontSize: 11.5, marginTop: 8 }}>{p.head} → {p.base}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
            </div>
            <div className="master-tools" style={{ borderBottom: 0, borderTop: "1px solid var(--line)" }}>
              {unpushed && <div className="err-box warn">{unpushed}</div>}
              <button className="btn btn-primary" style={{ height: 48, fontSize: 13.5 }} disabled={!branch || creating || !!unpushed} onClick={() => branch && create.mutate({ projectId: pid, branch }, { onSuccess: (r) => { setSel(r.number); setPane("detail"); } })}>
                <Busy on={creating}><Icon name="sparkle" size={13} /></Busy>
                <span className="ellipsis">New PR from {branch ?? "current branch"}</span>
              </button>
            </div>
          </section>
          <Resizer pane={listW} label="Resize pull request list" />
          <main className="detail" data-pane data-active={pane === "detail"} {...swipeProps((dir) => dir < 0 && setPane("list"))}>
            {current ? <Detail key={current} pid={pid} number={current} /> : <EmptyState icon="pr" title="No pull request selected">Pick one from the list to read its description, checks and reviews.</EmptyState>}
          </main>
        </div>
      )}
    </>
  );
}

function Detail({ pid, number }: { pid: string; number: number }) {
  const nav = useNav();
  const q = usePr(pid, number);
  const host = useHost(pid);
  const prefs = useProjectPrefs(pid);
  const media = prefs.dialogs.prMedia;
  // Pictures behind the host's sign-in (private repository, GitLab or Gitea upload, Azure DevOps attachment) load through the app.
  const pictures = useMemo(() => ({ key: `pr:${pid}`, load: (url: string) => rpc<string>("prs.picture", { projectId: pid, url }) }), [pid]);
  const source = media ? pictures : null;
  const inv = [["pr", pid, number], ["prs", pid]];
  // The branch map refreshes on its own: the merge fetches origin, which says the project changed.
  const merge = useAction("prs.merge", {
    invalidate: inv,
    // Shows it merged at once (out of the open list), while the refetches come back.
    patch: (qc) => {
      qc.setQueryData<PrDetail>(["pr", pid, number], (p) => p && { ...p, state: "merged" });
      qc.setQueryData<{ items: PrSummary[] }>(["prs", pid], (l) => l && { ...l, items: l.items.map((p) => (p.number === number ? { ...p, state: "merged" } : p)) });
    },
    success: `Merged #${number}`,
  });
  // From the mutation cache, so it still shows after picking another pull request and coming back.
  const merging = useMutationState({
    filters: { mutationKey: ["prs.merge"], status: "pending" },
    select: (m) => m.state.variables as { projectId?: string; number?: number } | undefined,
  }).some((v) => v?.projectId === pid && v.number === number);
  const update = useAction("prs.update", { invalidate: inv, success: `Saved to ${host}` });
  const close = useAction<{ deleteError: string | null }>("prs.close", {
    invalidate: [...inv, ["overview", pid], ["files", pid], ["worktrees"]],
    success: (r) => (r.deleteError ? undefined : `Closed #${number}`),
  });
  const reopen = useAction("prs.close", { invalidate: inv, success: `Reopened #${number}` });
  const gen = useAction<{ title: string; body: string }>("prs.generate");
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [filter, setFilter] = useState<"all" | "open">("all");
  const [checksOpen, setChecksOpen] = useState(false);
  const [view, setView] = useState<View>("conversation");
  // A conversation to see in the code: the files view opens on its file and line.
  const [focus, setFocus] = useState<PrThread | null>(null);
  const files = usePrFiles(pid, q.data);

  if (q.isLoading) return <Loading />;
  if (q.error) return <EmptyState icon="pr" title="Couldn't load pull request">{q.error.message}</EmptyState>;
  const d = q.data!;
  const open = d.state === "open" || d.state === "draft";
  const [label, cls] = stateOf(d, d);
  const failing = d.checks.filter((c) => c.status === "fail").length;
  const running = d.checks.filter((c) => c.status === "run").length;
  const waiting = d.checks.filter((c) => c.status === "wait").length;
  const pending = [running && `${running} running`, waiting && `${waiting} waiting`].filter(Boolean).join(", ");
  const unresolved = d.threads.filter((t) => t.resolvable && !t.resolved).length;
  const approvals = d.reviewers.filter((r) => r.vote === "approve").length;
  const changes = d.reviewers.filter((r) => r.vote === "changes").length;
  const votes = [approvals && plural(approvals, "approval"), changes && `${changes} changes requested`].filter(Boolean).join(" · ");
  const threads = filter === "open" ? d.threads.filter((t) => t.resolvable && !t.resolved) : d.threads;
  const hidden = !media && (MEDIA.test(d.body) || d.threads.some((t) => t.comments.some((c) => MEDIA.test(c.body))));
  const startEdit = () => {
    setTitle(d.title);
    setBody(d.body);
    setEditing(true);
  };
  const showCode = (t: PrThread) => {
    setFocus(t);
    setView("files");
  };

  return (
    <div className="detail-inner">
      {/* Cancels the page's 24px section gap so the action buttons sit right below. */}
      <div className="col" style={{ gap: 2, marginBottom: -4 }}>
        {editing ? (
          <div className="field">
            <label htmlFor="pr-title">Title</label>
            <input id="pr-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
        ) : (
          <div className="row" style={{ alignItems: "flex-start", margin: 0 }}>
            <h1 className="grow">{d.title}</h1>
            {open && (
              <button className="btn btn-ghost btn-icon" style={{ marginBlock: -3 }} aria-label="Edit title and description" onClick={startEdit}>
                <Icon name="edit" />
              </button>
            )}
          </div>
        )}
        <div className="row wrap muted" style={{ fontSize: 12.5, margin: 0 }}>
          <span className={`pill ${cls}`}>{label}</span>
          <span className="mono">#{d.number} · {d.head} → {d.base}</span>
          <span className="faint">·</span>
          <span>{d.mine ? "Opened by you" : `Opened by ${d.author}`} · {ago(d.updatedAt)}</span>
        </div>
      </div>

      <div className="row wrap" style={{ gap: 6, margin: 0 }}>
        {open && !d.conflict && d.state !== "draft" && (
          <button className="btn btn-primary" disabled={merging || running + waiting > 0} onClick={() => merge.mutate({ projectId: pid, number })}>
            {merging && <span className="spinner" />}
            {merging ? `Merging into ${d.base}…` : `Merge into ${d.base}`}
          </button>
        )}
        {d.conflict && (
          <button
            className="btn btn-primary"
            onClick={() => {
              nav.selectBranch(d.head);
              nav.go({ name: "workspace" });
            }}
          >
            <Icon name="sparkle" size={12} />
            Resolve conflicts with AI
          </button>
        )}
        {open && (
          <button className="btn" aria-expanded={reviewOpen} onClick={() => setReviewOpen(!reviewOpen)}>Review</button>
        )}
        {open && (
          <button
            className="btn"
            disabled={gen.isPending}
            onClick={() =>
              gen.mutate(
                { projectId: pid, branch: d.head },
                {
                  onSuccess: (r) => {
                    setTitle(r.title);
                    setBody(r.body);
                    setEditing(true);
                  },
                },
              )
            }
          >
            <Busy on={gen.isPending}><Icon name="sparkle" size={12} className="c-acc" /></Busy>
            Rewrite with AI
          </button>
        )}
        <button className="btn" onClick={() => openExternal(d.url)}>
          <Icon name="external" size={12} />
          Open on {host}
        </button>
        {open && (
          <button className="btn btn-danger" disabled={close.isPending} onClick={() => setConfirmClose(true)}>
            <Icon name="close" size={12} />
            Close pull request
          </button>
        )}
        {d.state === "closed" && (
          <button className="btn" disabled={reopen.isPending} onClick={() => reopen.mutate({ projectId: pid, number, reopen: true })}>
            {reopen.isPending && <span className="spinner" />}
            Reopen
          </button>
        )}
        {unresolved > 0 && open && <span className="c-acc" style={{ fontSize: 12.5 }}>{plural(unresolved, "unresolved conversation")}</span>}
      </div>

      <div className="row" style={{ margin: 0 }}>
        <Seg<View>
          label="Show"
          value={view}
          onChange={(v) => {
            setView(v);
            setFocus(null);
          }}
          options={[
            { value: "conversation", label: <>Conversation <span className="faint">{d.threads.length}</span></> },
            { value: "files", label: <>Files changed <span className="faint">{files.data?.length ?? ""}</span></> },
          ]}
        />
      </div>

      {confirmClose && (
        <Modal
          title={`Close #${number}?`}
          onClose={() => setConfirmClose(false)}
          footer={
            <>
              <button className="btn btn-md btn-danger" disabled={close.isPending} onClick={() =>
                  close.mutate(
                    { projectId: pid, number, ...(deleteBranch && !d.fork && { deleteBranch: d.head }) },
                    {
                      onSuccess: (r) => {
                        if (r.deleteError) toast(`Closed #${number}, but the branch was kept: ${r.deleteError}`, "error");
                        setConfirmClose(false);
                      },
                    },
                  )
                }
              >
                {close.isPending && <span className="spinner" />}
                {deleteBranch ? "Close and delete branch" : "Close without merging"}
              </button>
            </>
          }
        >
          <p style={{ margin: 0, lineHeight: 1.55 }}>
            {deleteBranch ? (
              <>Abandons the pull request on {host} and deletes <span className="mono">{d.head}</span> here and on origin, with its worktree. Commits not merged elsewhere are lost.</>
            ) : (
              <>Abandons the pull request on {host}. The branch <span className="mono">{d.head}</span> and its commits stay, and you can reopen it later.</>
            )}
          </p>
          {/* A fork's branch lives in the fork: one of that name here is someone else's work. */}
          {!d.fork && (
            <label className="check" style={{ marginTop: 12 }}>
              <input type="checkbox" checked={deleteBranch} onChange={() => setDeleteBranch(!deleteBranch)} />
              <span>Also delete <span className="mono">{d.head}</span>, locally and on origin</span>
            </label>
          )}
        </Modal>
      )}

      {reviewOpen && <ReviewForm pid={pid} d={d} onDone={() => setReviewOpen(false)} />}

      {view === "files" && (
        <PictureSource.Provider value={source}>
          <PrFiles key={focus?.id} pid={pid} d={d} media={media} focus={focus} />
        </PictureSource.Provider>
      )}

      {view === "conversation" && d.checks.length > 0 && (
        <section className="section">
          <div className="row" style={{ margin: 0 }}>
            <h2>Checks</h2>
            <span className={failing ? "c-del" : pending ? "c-acc" : "c-add"} style={{ fontSize: 12.5 }}>
              {failing ? `${failing} failing` : pending ? `${d.checks.length - running - waiting} of ${d.checks.length} passed, ${pending}` : `All ${d.checks.length} passing`}
            </span>
            <span className="grow" />
            <button className="btn btn-sm" aria-expanded={checksOpen} onClick={() => setChecksOpen(!checksOpen)}>
              <Icon name="chevronDown" size={12} className="chev" />
              {checksOpen ? "Hide" : "Show all"}
            </button>
          </div>
          {checksOpen && (
            <ul className="list">
              {d.checks.map((c, i) => {
                const row = (
                  <>
                    <span className="pulse" style={{ animation: c.status === "run" ? undefined : "none", background: c.status === "pass" ? "var(--add-fg)" : c.status === "fail" ? "var(--del-fg)" : c.status === "wait" ? "var(--faint)" : "var(--accent)" }} />
                    <span className="grow">{c.name}</span>
                    {c.url && <Icon name="external" size={12} className="faint" />}
                    <span className="muted" style={{ fontSize: 12 }}>{c.status === "pass" ? "Passed" : c.status === "fail" ? "Failed" : c.status === "wait" ? "Waiting" : "Running"}</span>
                  </>
                );
                return (
                  <li key={i}>
                    {c.url ? (
                      <button className="list-row list-link" style={{ minHeight: 40 }} onClick={() => openExternal(c.url!)}>{row}</button>
                    ) : (
                      <div className="list-row" style={{ minHeight: 40 }}>{row}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {view === "conversation" && (
        <>
          <section className="section">
            <h2>
              Reviewers
              {votes && <span className="faint" style={{ fontSize: 13, fontWeight: 400, marginLeft: 8 }}>({votes})</span>}
            </h2>
            {d.reviewers.length === 0 ? (
              <span className="muted">No reviewers yet.</span>
            ) : (
              <div className="row wrap" style={{ gap: 12, margin: "4px 0 0" }}>
                {d.reviewers.map((r) => (
                  <span key={r.login} className="row" style={{ gap: 8, margin: 0 }}>
                    <span className="avatar" aria-hidden="true">{initials(r.login)}</span>
                    <span>{r.login}</span>
                    <span className={r.vote === "approve" ? "c-add" : r.vote === "changes" ? "c-acc" : "faint"} style={{ fontSize: 12 }}>
                      {{ approve: "Approved", changes: "Changes requested", comment: "Commented", pending: "Review requested" }[r.vote]}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </section>

          <section className="section">
            <div className="row">
              <h2>Description</h2>
              <span className="grow" />
              {open && !editing && (
                <button className="btn btn-sm" onClick={startEdit}>
                  <Icon name="edit" size={12} />
                  Edit
                </button>
              )}
            </div>
            {hidden && !editing && <MediaAsk onShow={() => prefs.setDialogs({ prMedia: true })} />}
            {editing ? (
              <div className="col">
                <label htmlFor="pr-body" className="sr-only">Description</label>
                <textarea id="pr-body" className="textarea mono" rows={14} style={{ fontSize: 12.5 }} value={body} onChange={(e) => setBody(e.target.value)} />
                <div className="row wrap">
                  <span className="grow" />
                  <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
                  <button className="btn btn-primary" disabled={!title.trim() || update.isPending} onClick={() => update.mutate({ projectId: pid, number, title, body }, { onSuccess: () => setEditing(false) })}>
                    Save to {host}
                  </button>
                </div>
              </div>
            ) : d.body ? (
              <div className="card" style={{ padding: "6px 16px" }}>
                <PictureSource.Provider value={source}>
                  <Markdown text={d.body} html={media} breaks />
                </PictureSource.Provider>
              </div>
            ) : (
              <span className="muted">No description.</span>
            )}
          </section>

          <section className="section" aria-label="Conversation" style={{ gap: 6 }}>
            <div className="row wrap" style={{ marginBottom: 6 }}>
              <h2>Conversation</h2>
              <span className="faint" style={{ fontSize: 12 }}>{d.threads.length ? `${unresolved} unresolved · ${d.threads.length} total` : ""}</span>
              <span className="grow" />
              <Seg label="Show" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "open", label: "Unresolved" }]} />
            </div>
            <PictureSource.Provider value={source}>
              {threads.map((t) => <ThreadView key={t.id} pid={pid} number={number} t={t} media={media} onShowCode={t.path ? () => showCode(t) : undefined} />)}
            </PictureSource.Provider>
            {threads.length === 0 && <span className="muted">{d.threads.length === 0 ? "No comments yet." : "Every conversation is resolved."}</span>}
            <NewComment pid={pid} number={number} />
          </section>
        </>
      )}

    </div>
  );
}

/** The lines picked in the open file, first and last in diff order, and the comment being written on them. */
interface Note {
  path: string;
  /** The commits the diff was drawn at, `base...head`: once the pull request moves on, the lines no longer stand. */
  drawn: string;
  from: DiffAt;
  to: DiffAt;
  text: string;
}

/** Hosts whose comments take a suggestion block, which the author applies in one click. */
const SUGGESTS = ["GitHub", "GitLab"];

/** A suggestion block holding `lines`, the current text of the lines a comment is on: the change starts as them, to
 * edit. GitLab counts the lines it replaces up from the commented one, the last. The fence outgrows any run of
 * backticks in the code. */
function suggestionBlock(host: string, lines: string[]): string {
  const ticks = Math.max(2, ...lines.flatMap((l) => (l.match(/`+/g) ?? []).map((m) => m.length)));
  const fence = "`".repeat(ticks + 1);
  const info = host === "GitLab" ? `suggestion:-${lines.length - 1}+0` : "suggestion";
  return `${fence}${info}\n${lines.join("\n")}\n${fence}`;
}

const NO_THREADS: PrThread[] = [];

/** A conversation's line in a file's diff, in the version it numbers: `o12` in the base, `n12` in the head. */
const lineKey = (t: PrThread) => `${t.old ? "o" : "n"}${t.line}`;

/** The pull request's changed files and the diff of one, its conversations under their lines. Pressing a line number
 * starts a comment there; on hosts that take ranges, shift-click or a drag takes in more lines. */
function PrFiles({ pid, d, media, focus }: { pid: string; d: PrDetail; media: boolean; focus: PrThread | null }) {
  const host = useHost(pid);
  // Bitbucket's and Gitea's APIs put a comment on one line only.
  const ranges = host === "GitHub" || host === "GitLab" || host === "Azure DevOps";
  const qc = useQueryClient();
  const files = usePrFiles(pid, d);
  const list = files.data ?? [];
  const [sel, setSel] = useState(focus?.path ?? undefined);
  const file = list.find((f) => f.path === sel) ?? list[0];
  const diff = usePrDiff(pid, d, file);
  const [mode, setMode] = useStored<"unified" | "split">("gnx.prs.diff", "unified", (s) => (s === "split" ? "split" : "unified"), String);
  const [anyway, setAnyway] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const post = useAction("prs.lineComment", { invalidate: [["pr", pid, d.number]], success: `Comment posted to ${host}` });
  const byFile = useMemo(() => {
    const m = new Map<string, PrThread[]>();
    for (const t of d.threads) if (t.path) m.set(t.path, [...(m.get(t.path) ?? []), t]);
    return m;
  }, [d.threads]);
  const here = (file && byFile.get(file.path)) || NO_THREADS;
  const onLines = useMemo(() => {
    const m = new Map<string, PrThread[]>();
    for (const t of here) if (t.line != null && !t.outdated) m.set(lineKey(t), [...(m.get(lineKey(t)) ?? []), t]);
    return m;
  }, [here]);
  // Lines the diff draws, so the conversations on others (outdated, or out of its hunks) show above it.
  const drawn = useMemo(() => {
    const keys = new Set<string>();
    for (const h of diff.data ?? []) {
      let [o, n] = [h.oldStart, h.newStart];
      for (const l of h.lines) {
        if (l.kind !== "+") keys.add(`o${o++}`);
        if (l.kind !== "-") keys.add(`n${n++}`);
      }
    }
    return keys;
  }, [diff.data]);
  const elsewhere = diff.data ? here.filter((t) => t.line == null || t.outdated || !drawn.has(lineKey(t))) : [];
  // The conversation picked in the conversation list, brought into view once its file's diff is drawn.
  const [toFocus, setToFocus] = useState(focus?.id);
  useEffect(() => {
    if (!toFocus || !diff.data) return;
    const el = document.getElementById(`pr-thread-${toFocus}`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    // Again once the lines above it are laid out: off screen they only had an estimated height.
    requestAnimationFrame(() => el.scrollIntoView({ block: "center" }));
    setToFocus(undefined);
  }, [toFocus, diff.data, anyway]);

  const at = `${d.baseSha}...${d.headSha}`;
  const picked = note && file && note.path === file.path && note.drawn === at ? { from: note.from, to: note.to } : null;
  // A suggestion replaces lines of the head: both ends of the picked lines must be there (lines removed in between
  // are left out).
  const suggestion =
    picked && SUGGESTS.includes(host) && picked.from.kind !== "-" && picked.to.kind !== "-"
      ? () => {
          const lines = diff.data?.[picked.from.hunk]?.lines.slice(picked.from.i, picked.to.i + 1).filter((l) => l.kind !== "-");
          return lines?.length ? suggestionBlock(host, lines.map((l) => l.text)) : null;
        }
      : undefined;
  // Only the comment box sends, and it shows only while the lines stand at `d`'s commits.
  const send = () => {
    if (!note || !file || !note.text.trim()) return;
    const pos = (a: DiffAt) => ({ kind: a.kind, old: a.old, new: a.new });
    const one = note.from.hunk === note.to.hunk && note.from.i === note.to.i;
    post.mutate(
      { projectId: pid, number: d.number, path: file.path, from: file.from, head: d.headSha, start: one ? undefined : pos(note.from), end: pos(note.to), endLen: note.to.len, body: note.text },
      {
        onSuccess: () => setNote(null),
        // A push since the diff loaded: the pull request comes back with its new head, and its diff with it.
        onError: () => void qc.invalidateQueries({ queryKey: ["pr", pid, d.number] }),
      },
    );
  };
  const review: Review = {
    ranges,
    picked,
    onPick: (from, to) => file && setNote((n) => ({ path: file.path, drawn: at, from, to, text: n?.path === file.path ? n.text : "" })),
    below: (at) => {
      const ts = [...(at.kind !== "+" ? (onLines.get(`o${at.old}`) ?? []) : []), ...(at.kind !== "-" ? (onLines.get(`n${at.new}`) ?? []) : [])];
      const writing = note && picked && picked.to.hunk === at.hunk && picked.to.i === at.i;
      if (!ts.length && !writing) return null;
      return (
        <div className="col" style={{ gap: 8 }}>
          {ts.map((t) => <ThreadView key={t.id} pid={pid} number={d.number} t={t} media={media} inline />)}
          {writing && <NoteForm host={host} note={note} ranges={ranges} busy={post.isPending} suggestion={suggestion} onText={(text) => setNote({ ...note, text })} onCancel={() => setNote(null)} onSend={send} />}
        </div>
      );
    },
  };

  if (!d.headSha) return <EmptyState icon="pr" title="Couldn't read the changes">{host} named no head commit for this pull request.</EmptyState>;
  if (files.isLoading) return <Loading />;
  if (files.error) return <EmptyState icon="pr" title="Couldn't read the changes">{files.error.message}</EmptyState>;
  if (!file) return <EmptyState icon="pr" title="No changes">This pull request changes no files.</EmptyState>;
  const cut = file.path.lastIndexOf("/");
  return (
    <section className="pr-files" aria-label="Files changed">
      <nav className="pr-files-list" aria-label="Changed files">
        {list.map((f) => (
          <PrFileRow key={f.path} f={f} active={f === file} threads={byFile.get(f.path)?.length ?? 0} onPick={() => { setSel(f.path); setAnyway(false); }} />
        ))}
      </nav>
      <div className="pr-code">
        <div className="code-file pr-code-bar">
          <span className="code-path mono ellipsis grow" data-tip={file.from ? `${file.from} → ${file.path}` : file.path} data-tip-overflow>
            {file.from && <span className="faint">{file.from} → </span>}
            <span className="faint">{file.path.slice(0, cut + 1)}</span>
            <b>{file.path.slice(cut + 1)}</b>
          </span>
          <span className="hint ellipsis hide-narrow">{ranges ? "Click or drag line numbers, or a hunk's Comment, to comment" : "Click a line number to comment"}</span>
          <Seg<"unified" | "split"> label="Diff mode" value={mode} onChange={setMode} options={[{ value: "unified", label: "Unified" }, { value: "split", label: "Split" }]} />
        </div>
        {elsewhere.length > 0 && (
          <div className="pr-elsewhere">
            {elsewhere.map((t) => <ThreadView key={t.id} pid={pid} number={d.number} t={t} media={media} />)}
          </div>
        )}
        <div className="diff">
          {diff.isLoading && <Loading />}
          {diff.error && <div style={{ padding: 16 }}><ErrorBox error={diff.error} /></div>}
          {diff.data && diff.data.length > 0 && <DiffView path={file.path} hunks={diff.data} mode={mode} review={review} anyway={anyway} onAnyway={() => setAnyway(true)} />}
          {diff.data && diff.data.length === 0 && (
            <div className="empty" style={{ fontFamily: "var(--sans)" }}>{file.from ? `Renamed from ${file.from}, no other changes.` : "Binary file, or no changes to its text."}</div>
          )}
        </div>
      </div>
    </section>
  );
}

function PrFileRow({ f, active, threads, onPick }: { f: FileChange; active: boolean; threads: number; onPick: () => void }) {
  const cut = f.path.lastIndexOf("/");
  const color = ({ A: "c-add", D: "c-del", C: "c-acc", M: "c-mod", R: "c-mod" } as Record<string, string>)[f.status] ?? "faint";
  return (
    <button className="file-btn" aria-pressed={active} onClick={onPick}>
      <span className={`file-st ${color}`}>{f.status}</span>
      <span className="grow ellipsis" data-tip={f.from ? `${f.from} → ${f.path}` : f.path} data-tip-overflow>
        <span>{f.path.slice(cut + 1)}</span> <span className="faint" style={{ fontSize: 11.5 }}>{f.path.slice(0, Math.max(cut, 0))}</span>
      </span>
      {threads > 0 && (
        <span className="pr-file-threads" aria-label={plural(threads, "conversation")}>
          <Icon name="comment" size={11} />
          {threads}
        </span>
      )}
      <span className="row mono file-nums">
        <span className="c-add">{f.additions > 0 && `+${f.additions}`}</span>
        <span className="c-del">{f.deletions > 0 && `−${f.deletions}`}</span>
      </span>
    </button>
  );
}

/** The comment being written on the picked lines, under the last one. `suggestion` gives the block "Suggest change"
 * puts in, when the host takes one on these lines. */
function NoteForm({
  host,
  note,
  ranges,
  busy,
  suggestion,
  onText,
  onCancel,
  onSend,
}: {
  host: string;
  note: Note;
  ranges: boolean;
  busy: boolean;
  suggestion?: () => string | null;
  onText: (text: string) => void;
  onCancel: () => void;
  onSend: () => void;
}) {
  const num = (a: DiffAt) => (a.kind === "-" ? a.old : a.new);
  const one = note.from.hunk === note.to.hunk && note.from.i === note.to.i;
  const what = one ? `${note.to.kind === "-" ? "removed line" : "line"} ${num(note.to)}` : `lines ${num(note.from)} to ${num(note.to)}`;
  // Opened under lines near the bottom of the view: brought in whole, buttons too.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView({ block: "nearest" });
  }, []);
  const area = useRef<HTMLTextAreaElement>(null);
  // The block goes where the caret is (over a selection), on lines of its own; the caret then ends its code, to edit.
  const suggest = () => {
    const block = suggestion?.();
    const el = area.current;
    if (!block || !el) return;
    const [before, after] = [note.text.slice(0, el.selectionStart), note.text.slice(el.selectionEnd)];
    const head = before + (before && !before.endsWith("\n") ? "\n" : "");
    onText(head + block + (after && !after.startsWith("\n") ? "\n" : "") + after);
    const caret = head.length + block.lastIndexOf("\n");
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };
  return (
    <div ref={box} className="note-form">
      <label htmlFor="pr-note" className="sr-only">Comment on {what}</label>
      <textarea
        ref={area}
        id="pr-note"
        className="textarea"
        // Tall enough to show a suggestion's code, up to 14 lines.
        rows={Math.min(14, Math.max(3, note.text.split("\n").length))}
        autoFocus
        placeholder={`Comment on ${what}…`}
        value={note.text}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSend();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="row wrap" style={{ margin: 0, gap: 6 }}>
        {suggestion && (
          <button className="btn btn-sm" data-tip={`Put in the picked lines as a change the author can apply on ${host}`} onClick={suggest}>
            <Icon name="suggest" size={12} />
            Suggest change
          </button>
        )}
        <span className="hint grow">
          {what[0].toUpperCase() + what.slice(1)}
          {ranges ? " · shift-click or drag line numbers for more" : ` · ${host} comments on one line at a time`}
        </span>
        <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
        <button className="btn btn-sm btn-primary" disabled={!note.text.trim() || busy} onClick={onSend}>
          <Busy on={busy}>{null}</Busy>
          Comment
        </button>
      </div>
    </div>
  );
}

function ReviewForm({ pid, d, onDone }: { pid: string; d: PrDetail; onDone: () => void }) {
  const host = useHost(pid);
  // GitHub and Gitea refuse votes from a PR's author; the others take them.
  const authorOnly = d.mine && (host === "GitHub" || host === "Gitea");
  const opts: [string, string, string][] = authorOnly
    ? [["comment", "Comment", "General feedback, no explicit approval."]]
    : [
        ["comment", "Comment", "General feedback, no explicit approval."],
        ["approve", "Approve", "Ready to merge."],
        ["changes", "Request changes", "Must be addressed before merging."],
      ];
  const [vote, setVote] = useState(opts[0][0]);
  const [text, setText] = useState("");
  const submit = useAction("prs.review", { invalidate: [["pr", pid, d.number]], success: `Review posted to ${host}` });
  const draft = useAction<{ text: string }>("prs.draftReview");
  return (
    <section aria-label="Submit review" className="col card" style={{ padding: 16, gap: 12 }}>
      {/* Not a .section, so the h2's browser margins and .row's 10px margin are reset here. */}
      <div className="row wrap" style={{ margin: "0 0 4px", alignItems: "baseline", rowGap: 2 }}>
        <h2 className="grow" style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Submit review</h2>
        <span className="hint">{host === "GitHub" || host === "Gitea" ? `Posted to ${host} as a review` : `Posted to ${host} as your vote and a comment`}</span>
      </div>
      <div className="field">
        <label htmlFor="pr-review-text">Summary <span className="faint" style={{ fontWeight: 400 }}>optional</span></label>
        <textarea id="pr-review-text" className="textarea" rows={3} placeholder="Overall feedback for the author…" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <fieldset className="col" style={{ margin: 0, padding: 0, border: 0, gap: 6 }}>
        <legend className="muted" style={{ fontSize: 12, fontWeight: 500, padding: "0 0 6px" }}>Review type</legend>
        {opts.map(([v, t, s]) => (
          <button key={v} type="button" className="radio-card" aria-pressed={vote === v} onClick={() => setVote(v)}>
            <span className="radio-dot" />
            <span className="col" style={{ gap: 2 }}>
              <span style={{ fontWeight: 500 }}>{t}</span>
              <span className="muted" style={{ fontSize: 12 }}>{s}</span>
            </span>
          </button>
        ))}
      </fieldset>
      {authorOnly && <span className="hint">You opened this pull request, so GitHub only lets you comment on it.</span>}
      <div className="row wrap" style={{ margin: 0 }}>
        <button className="btn" disabled={draft.isPending} onClick={() => draft.mutate({ projectId: pid, number: d.number }, { onSuccess: (r) => setText(r.text) })}>
          <Busy on={draft.isPending}><Icon name="sparkle" size={12} className="c-acc" /></Busy>
          Draft with AI
        </button>
        <span className="grow" />
        <button className="btn" onClick={onDone}>Cancel</button>
        <button className="btn btn-primary" disabled={submit.isPending || (vote === "comment" && !text.trim())} onClick={() => submit.mutate({ projectId: pid, number: d.number, vote, body: text }, { onSuccess: onDone })}>
          Submit review
        </button>
      </div>
    </section>
  );
}

/** `inline`: drawn in the diff under its line, so without its file and code. `onShowCode` opens it in the files view. */
function ThreadView({ pid, number, t, media, inline, onShowCode }: { pid: string; number: number; t: PrThread; media: boolean; inline?: boolean; onShowCode?: () => void }) {
  const host = useHost(pid);
  // Azure DevOps comments only take likes, Bitbucket's none.
  const emoji = host === "Azure DevOps" ? EMOJI.slice(0, 1) : host === "Bitbucket" ? [] : EMOJI;
  // Gitea's API can't resolve a conversation.
  const resolvable = t.resolvable && host !== "Gitea";
  const [open, setOpen] = useState(!t.resolved);
  const [draft, setDraft] = useState("");
  const [picker, setPicker] = useState<string | null>(null);
  useEffect(() => setOpen(!t.resolved), [t.resolved]);
  const inv = [["pr", pid, number]];
  const reply = useAction("prs.reply", { invalidate: inv });
  const comment = useAction("prs.comment", { invalidate: inv });
  const resolve = useAction("prs.resolve", { invalidate: inv });
  const react = useAction("prs.react", { invalidate: inv });
  const save = useAction("prs.editComment", { invalidate: inv });
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const ai = useAction<{ text: string }>("prs.draftReply");
  const improve = useAction<{ text: string }>("prs.draftReply");
  const first = t.comments[0];
  const file = t.path ? `${t.path}${t.line ? `:${t.line}` : ""}` : null;

  if (!open) {
    return (
      <article id={`pr-thread-${t.id}`} className="thread row" style={{ padding: "8px 14px", gap: 10 }}>
        <span className="pill c-add">Resolved</span>
        {file && !inline && <span className="mono faint" style={{ fontSize: 11.5 }}>{file}</span>}
        <span className="ellipsis grow muted">{first ? `${first.author}: ${first.body}` : ""}</span>
        <button className="btn btn-sm" onClick={() => setOpen(true)}>Show</button>
      </article>
    );
  }
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    const done = { onSuccess: () => setDraft("") };
    if (t.resolvable && first?.databaseId) reply.mutate({ projectId: pid, number, threadId: t.id, commentId: first.databaseId, body: text }, done);
    else comment.mutate({ projectId: pid, number, body: text }, done);
  };
  return (
    <article id={`pr-thread-${t.id}`} className="thread">
      {file && !inline && (
        <>
          <div className="thread-file">
            <Icon name="branch" size={12} />
            <span className="grow ellipsis">{file}</span>
            {t.outdated && <span className="pill faint">Outdated</span>}
            {onShowCode && (
              <button className="btn btn-ghost btn-sm" onClick={onShowCode}>
                <Icon name="file" size={11} />
                Show in code
              </button>
            )}
          </div>
          {t.snippet.length > 0 && (
            <div className="snippet">
              {t.snippet.map((l, i) => (
                <div key={i} className={l.startsWith("+") ? "c-add" : l.startsWith("-") ? "c-del" : "muted"}>{l}</div>
              ))}
            </div>
          )}
        </>
      )}
      {t.comments.map((c) => (
        <div key={c.id} className="comment">
          <span className="avatar" aria-hidden="true">{initials(c.author)}</span>
          <div className="col grow" style={{ gap: 6, minWidth: 0 }}>
            <div className="row" style={{ gap: 8 }}>
              <span style={{ fontWeight: 500 }}>{c.author}</span>
              {t.review && (
                <span className={`pill ${t.review === "approve" ? "c-add" : t.review === "changes" ? "c-acc" : "faint"}`}>
                  {{ approve: "Approved", changes: "Requested changes", comment: "Reviewed" }[t.review]}
                </span>
              )}
              <span className="faint grow" style={{ fontSize: 12 }}>{ago(c.createdAt)}</span>
              {c.canEdit && editing?.id !== c.id && (
                <button className="btn btn-ghost btn-icon btn-sm" aria-label="Edit comment" onClick={() => setEditing({ id: c.id, text: c.body })}>
                  <Icon name="edit" size={12} />
                </button>
              )}
            </div>
            {editing?.id === c.id ? (
              <div className="col" style={{ gap: 6 }}>
                <label htmlFor={`edit-${c.id}`} className="sr-only">Edit comment</label>
                <textarea id={`edit-${c.id}`} className="textarea" rows={3} autoFocus value={editing.text} onChange={(e) => setEditing({ id: c.id, text: e.target.value })} />
                <div className="row" style={{ gap: 6 }}>
                  <button
                    className="btn btn-sm"
                    disabled={!editing.text.trim() || improve.isPending}
                    title="Fix spelling and grammar and smooth the wording"
                    onClick={() =>
                      improve.mutate(
                        { projectId: pid, number, threadId: t.id, draft: editing.text, editing: c.id },
                        { onSuccess: (r) => setEditing((e) => (e?.id === c.id ? { id: c.id, text: r.text } : e)) },
                      )
                    }
                  >
                    <Busy on={improve.isPending}><Icon name="sparkle" size={11} className="c-acc" /></Busy>
                    Improve
                  </button>
                  <span className="grow" />
                  <button className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={!editing.text.trim() || editing.text === c.body || save.isPending}
                    onClick={() => save.mutate({ projectId: pid, commentId: c.id, body: editing.text }, { onSuccess: () => setEditing(null) })}
                  >
                    <Busy on={save.isPending}>{null}</Busy>
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <div className="comment-body"><Markdown text={c.body} html={media} breaks /></div>
            )}
            <div className="row wrap" style={{ gap: 6, position: "relative" }}>
              {c.reactions.map((r) => (
                <button key={r.content} className="reaction" aria-pressed={r.mine} aria-label={`${r.content} ${r.count}${r.mine ? ", you reacted" : ""}`} onClick={() => react.mutate({ projectId: pid, subjectId: c.id, content: r.content, add: !r.mine })}>
                  <span>{r.emoji}</span>
                  <span>{r.count}</span>
                </button>
              ))}
              {emoji.length > 0 && (
                <button className="reaction" aria-label="Add reaction" aria-expanded={picker === c.id} onClick={() => setPicker(picker === c.id ? null : c.id)}>
                  <Icon name="smile" size={13} stroke={1.3} />
                </button>
              )}
              {picker === c.id && (
                <div role="group" aria-label="Pick a reaction" className="row card" style={{ gap: 2, padding: 4 }}>
                  {emoji.map(([content, e, label]) => (
                    <button key={content} className="btn btn-ghost btn-sm" aria-label={label} onClick={() => { react.mutate({ projectId: pid, subjectId: c.id, content, add: true }); setPicker(null); }}>
                      {e}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
      <div className="col" style={{ padding: "10px 14px 14px", borderTop: "1px solid var(--line)" }}>
        <label htmlFor={`reply-${t.id}`} className="sr-only">Reply</label>
        <textarea id={`reply-${t.id}`} className="textarea" rows={2} placeholder="Reply…" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <div className="row wrap">
          <button
            className="btn btn-sm"
            disabled={ai.isPending}
            title={draft.trim() ? "Fix spelling and grammar and smooth the wording of your reply" : undefined}
            onClick={() => ai.mutate({ projectId: pid, number, threadId: t.id, draft }, { onSuccess: (r) => setDraft(r.text) })}
          >
            <Busy on={ai.isPending}><Icon name="sparkle" size={11} className="c-acc" /></Busy>
            {draft.trim() ? "Improve reply" : "Draft reply"}
          </button>
          <span className="grow" />
          {resolvable && !t.resolved && (
            <button className="btn btn-sm" onClick={() => resolve.mutate({ projectId: pid, threadId: t.id, resolved: true })}>
              <Icon name="check" size={11} />
              Resolve
            </button>
          )}
          {t.resolved && (
            <>
              <button className="btn btn-sm" onClick={() => setOpen(false)}>Hide</button>
              {resolvable && <button className="btn btn-sm" onClick={() => resolve.mutate({ projectId: pid, threadId: t.id, resolved: false })}>Reopen</button>}
            </>
          )}
          <button className="btn btn-sm btn-primary" disabled={!draft.trim() || reply.isPending || comment.isPending} onClick={send}>Reply</button>
        </div>
      </div>
    </article>
  );
}

function NewComment({ pid, number }: { pid: string; number: number }) {
  const [text, setText] = useState("");
  const comment = useAction("prs.comment", { invalidate: [["pr", pid, number]] });
  return (
    <div className="col" style={{ marginTop: 10 }}>
      <label htmlFor="pr-new-comment" className="sr-only">New comment</label>
      <textarea id="pr-new-comment" className="textarea" rows={3} placeholder="Leave a comment on this pull request…" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-primary" disabled={!text.trim() || comment.isPending} onClick={() => comment.mutate({ projectId: pid, number, body: text }, { onSuccess: () => setText("") })}>
          Comment
        </button>
      </div>
    </div>
  );
}
