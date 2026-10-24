import { useEffect, useState, type CSSProperties } from "react";

import { useAction, useOverview, usePendingBranches, usePr, usePrs } from "../api/hooks";
import { openExternal, RpcError } from "../api/transport";
import type { PrDetail, PrSummary, PrThread } from "../api/types";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { Resizer, usePaneWidth } from "../components/Resizer";
import { ago, Busy, Empty, EmptyState, ErrorBox, Header, initials, Loading, Markdown, Modal, Seg } from "../components/ui";
import { plural } from "../lib/format";
import { useNav } from "../lib/nav";
import { toast } from "../lib/toast";

type Tab = "open" | "review" | "closed";
const GROUPS: PrSummary["state"][] = ["open", "draft", "merged", "closed"];
const EMOJI: [string, string, string][] = [
  ["THUMBS_UP", "👍", "Thumbs up"],
  ["THUMBS_DOWN", "👎", "Thumbs down"],
  ["LAUGH", "😄", "Laugh"],
  ["HOORAY", "🎉", "Hooray"],
  ["HEART", "❤️", "Heart"],
  ["ROCKET", "🚀", "Rocket"],
];

/** Name of the host the project's pull requests live on, from the cached list. */
function useHost(pid: string) {
  return usePrs(pid).data?.provider === "azure" ? "Azure DevOps" : "GitHub";
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
  const prs = usePrs(pid);
  const ov = useOverview(pid).data;
  const [tab, setTab] = useState<Tab>("open");
  const [sel, setSel] = useState<number | undefined>(initial);
  const [pane, setPane] = useState<"list" | "detail">(initial ? "detail" : "list");
  const listW = usePaneWidth("gnx.pane.prs", 460, 280, 720);
  const items = prs.data?.items ?? [];
  const inTab = (p: PrSummary, t: Tab) =>
    t === "closed" ? p.state === "merged" || (p.mine && p.state === "closed") : t === "review" ? p.reviewRequested && p.state !== "merged" && p.state !== "closed" : p.mine && (p.state === "open" || p.state === "draft");
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

  return (
    <>
      <Header title="Pull requests" sub={`${ov?.project.name ?? ""}${prs.data ? ` · ${prs.data.provider === "azure" ? "Azure DevOps" : "GitHub"} ${prs.data.repo.owner}/${prs.data.repo.repo}` : ""}`} />
      {prs.error instanceof RpcError && (prs.error.code === "not_connected" || prs.error.code === "unsupported") ? (
        <EmptyState
          icon="pr"
          title={prs.error.code === "unsupported" ? "Git provider not supported" : "No Git provider connected"}
          action={<button className="btn btn-primary btn-md" onClick={() => nav.go({ name: "settings", section: "git" })}>Open Git providers</button>}
        >
          {prs.error.message}
        </EmptyState>
      ) : prs.error ? (
        <div className="page">
          <div className="page-inner">
            <ErrorBox error={prs.error} />
            <div>
              <button className="btn" onClick={() => nav.go({ name: "settings", section: "git" })}>Open Git providers</button>
            </div>
          </div>
        </div>
      ) : (
        <div className="body split">
          <section aria-label="Pull request list" className="master" style={{ "--master-w": `${listW.width}px` } as CSSProperties} data-pane data-active={pane === "list"}>
            <div className="master-tools">
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
              {unpushed && <div className="err-box warn">{unpushed}</div>}
              <button className="btn" disabled={!branch || creating || !!unpushed} onClick={() => branch && create.mutate({ projectId: pid, branch }, { onSuccess: (r) => { setSel(r.number); setPane("detail"); } })}>
                <Busy on={creating}><Icon name="sparkle" size={12} className="c-acc" /></Busy>
                <span className="ellipsis">New PR from {branch ?? "current branch"}</span>
              </button>
            </div>
            <div className="scroll" style={{ flex: "1 1 auto", paddingBottom: 12 }}>
              {prs.isLoading && <Loading />}
              {!prs.isLoading && list.length === 0 && <Empty>Nothing here.</Empty>}
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
          </section>
          <Resizer pane={listW} label="Resize pull request list" />
          <main className="detail" data-pane data-active={pane === "detail"}>
            <button className="btn btn-sm show-narrow" style={{ marginBottom: 12 }} onClick={() => setPane("list")}>
              <Icon name="back" size={12} />
              All pull requests
            </button>
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
  const inv = [["pr", pid, number], ["prs", pid]];
  const merge = useAction("prs.merge", { invalidate: inv, success: `Merged #${number}` });
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

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
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
  const startEdit = () => {
    setTitle(d.title);
    setBody(d.body);
    setEditing(true);
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
          <button className="btn btn-primary" disabled={merge.isPending || running + waiting > 0} onClick={() => merge.mutate({ projectId: pid, number })}>
            {merge.isPending && <span className="spinner" />}
            Merge into {d.base}
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

      {confirmClose && (
        <Modal
          title={`Close #${number}?`}
          onClose={() => setConfirmClose(false)}
          footer={
            <>
              <button className="btn btn-md" onClick={() => setConfirmClose(false)}>Cancel</button>
              <button className="btn btn-md btn-danger" disabled={close.isPending} onClick={() =>
                  close.mutate(
                    { projectId: pid, number, ...(deleteBranch && { deleteBranch: d.head }) },
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
          <label className="check" style={{ marginTop: 12 }}>
            <input type="checkbox" checked={deleteBranch} onChange={() => setDeleteBranch(!deleteBranch)} />
            <span>Also delete <span className="mono">{d.head}</span>, locally and on origin</span>
          </label>
        </Modal>
      )}

      {reviewOpen && <ReviewForm pid={pid} d={d} onDone={() => setReviewOpen(false)} />}

      {d.checks.length > 0 && (
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
            <Markdown text={d.body} />
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
        {threads.map((t) => <ThreadView key={t.id} pid={pid} number={number} t={t} />)}
        {threads.length === 0 && <span className="muted">{d.threads.length === 0 ? "No comments yet." : "Every conversation is resolved."}</span>}
        <NewComment pid={pid} number={number} />
      </section>

    </div>
  );
}

function ReviewForm({ pid, d, onDone }: { pid: string; d: PrDetail; onDone: () => void }) {
  const host = useHost(pid);
  // GitHub refuses votes from a PR's author; Azure DevOps takes them.
  const authorOnly = d.mine && host === "GitHub";
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
      <div className="row">
        <h2 className="grow">Submit review</h2>
        <span className="hint">{host === "GitHub" ? "Posted to GitHub as a review" : "Posted to Azure DevOps as your vote and a comment"}</span>
      </div>
      <div className="field">
        <label htmlFor="pr-review-text">Summary <span className="faint" style={{ fontWeight: 400 }}>optional</span></label>
        <textarea id="pr-review-text" className="textarea" rows={3} placeholder="Overall feedback for the author…" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <fieldset className="col" style={{ margin: 0, padding: 0, border: 0, gap: 6 }}>
        <legend className="muted" style={{ fontSize: 12, paddingBottom: 6 }}>Review type</legend>
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
      <div className="row wrap">
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

function ThreadView({ pid, number, t }: { pid: string; number: number; t: PrThread }) {
  // Azure DevOps comments only take likes.
  const emoji = useHost(pid) === "GitHub" ? EMOJI : EMOJI.slice(0, 1);
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
      <article className="thread row" style={{ padding: "8px 14px", gap: 10 }}>
        <span className="pill c-add">Resolved</span>
        {file && <span className="mono faint" style={{ fontSize: 11.5 }}>{file}</span>}
        <span className="ellipsis grow muted">{first ? `${first.author}: ${first.body}` : ""}</span>
        <button className="btn btn-sm" onClick={() => setOpen(true)}>Show</button>
      </article>
    );
  }
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    const done = { onSuccess: () => setDraft("") };
    if (t.resolvable && first?.databaseId) reply.mutate({ projectId: pid, number, commentId: first.databaseId, body: text }, done);
    else comment.mutate({ projectId: pid, number, body: text }, done);
  };
  return (
    <article className="thread">
      {file && (
        <>
          <div className="thread-file">
            <Icon name="branch" size={12} />
            {file}
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
              <div className="comment-body">{c.body}</div>
            )}
            <div className="row wrap" style={{ gap: 6, position: "relative" }}>
              {c.reactions.map((r) => (
                <button key={r.content} className="reaction" aria-pressed={r.mine} aria-label={`${r.content} ${r.count}${r.mine ? ", you reacted" : ""}`} onClick={() => react.mutate({ projectId: pid, subjectId: c.id, content: r.content, add: !r.mine })}>
                  <span>{r.emoji}</span>
                  <span>{r.count}</span>
                </button>
              ))}
              <button className="reaction" aria-label="Add reaction" aria-expanded={picker === c.id} onClick={() => setPicker(picker === c.id ? null : c.id)}>
                <Icon name="smile" size={13} stroke={1.3} />
              </button>
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
          {t.resolvable && !t.resolved && (
            <button className="btn btn-sm" onClick={() => resolve.mutate({ projectId: pid, threadId: t.id, resolved: true })}>
              <Icon name="check" size={11} />
              Resolve
            </button>
          )}
          {t.resolved && (
            <>
              <button className="btn btn-sm" onClick={() => setOpen(false)}>Hide</button>
              <button className="btn btn-sm" onClick={() => resolve.mutate({ projectId: pid, threadId: t.id, resolved: false })}>Reopen</button>
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
