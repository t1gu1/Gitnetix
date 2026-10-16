import { useEffect, useState } from "react";

import { useAction, useOverview, usePr, usePrs } from "../api/hooks";
import { openExternal } from "../api/transport";
import type { PrDetail, PrSummary, PrThread } from "../api/types";
import { Icon } from "../components/Icon";
import { ago, Empty, ErrorBox, Header, initials, Loading, Markdown, Seg } from "../components/ui";
import { useNav } from "../lib/nav";

type Tab = "open" | "review" | "merged";
const EMOJI: [string, string, string][] = [
  ["THUMBS_UP", "👍", "Thumbs up"],
  ["THUMBS_DOWN", "👎", "Thumbs down"],
  ["LAUGH", "😄", "Laugh"],
  ["HOORAY", "🎉", "Hooray"],
  ["HEART", "❤️", "Heart"],
  ["ROCKET", "🚀", "Rocket"],
];

function stateOf(p: PrSummary, d?: PrDetail): [string, string] {
  if (p.state === "merged") return ["Merged", "c-mod"];
  if (p.state === "closed") return ["Closed", "faint"];
  if (d?.conflict) return ["Conflict", "c-del"];
  if (p.state === "draft") return ["Draft", "muted"];
  if (d?.checks.some((c) => c.status === "run")) return ["Checks running", "c-acc"];
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
  const items = prs.data?.items ?? [];
  const inTab = (p: PrSummary, t: Tab) =>
    t === "merged" ? p.state === "merged" : t === "review" ? p.reviewRequested && p.state !== "merged" && p.state !== "closed" : p.mine && (p.state === "open" || p.state === "draft");
  const list = items.filter((p) => inTab(p, tab));
  const current = sel ?? list[0]?.number;
  const create = useAction<PrSummary>("prs.create", { invalidate: [["prs", pid]], success: (r) => `Opened #${r.number}` });
  const branch = nav.selectedBranch ?? ov?.currentBranch;

  return (
    <>
      <Header title="Pull requests" sub={`${ov?.project.name ?? ""}${prs.data ? ` · GitHub ${prs.data.repo.owner}/${prs.data.repo.repo}` : ""}`} />
      {prs.error ? (
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
          <section aria-label="Pull request list" className="master" data-pane data-active={pane === "list"}>
            <div className="master-tools">
              <Seg<Tab>
                grid
                label="Filter"
                value={tab}
                onChange={(t) => { setTab(t); setSel(undefined); }}
                options={(["open", "review", "merged"] as Tab[]).map((t) => ({
                  value: t,
                  label: <>{t === "open" ? "Open" : t === "review" ? "To review" : "Merged"} <span className="faint">{items.filter((p) => inTab(p, t)).length}</span></>,
                }))}
              />
              <button className="btn" disabled={!branch || create.isPending} onClick={() => branch && create.mutate({ projectId: pid, branch }, { onSuccess: (r) => { setSel(r.number); setPane("detail"); } })}>
                {create.isPending ? <span className="spinner" /> : <Icon name="sparkle" size={12} className="c-acc" />}
                <span className="ellipsis">New PR from {branch ?? "current branch"}</span>
              </button>
            </div>
            <div className="scroll col" style={{ flex: "1 1 auto", gap: 2, padding: "8px 0" }}>
              {prs.isLoading && <Loading />}
              {!prs.isLoading && list.length === 0 && <Empty>Nothing here.</Empty>}
              {list.map((p) => {
                const [label, cls] = stateOf(p);
                return (
                  <button key={p.number} className="item-btn" aria-pressed={p.number === current} onClick={() => { setSel(p.number); setPane("detail"); }}>
                    <span className="row" style={{ alignItems: "baseline" }}>
                      <span className="mono faint" style={{ fontSize: 12 }}>#{p.number}</span>
                      <span className="ellipsis" style={{ fontWeight: 500 }}>{p.title}</span>
                    </span>
                    <span className="row">
                      <span className="mono faint ellipsis grow" style={{ fontSize: 11.5 }}>{p.head} → {p.base}</span>
                      <span className={`pill ${cls}`}>{label}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
          <main className="detail" data-pane data-active={pane === "detail"}>
            <button className="btn btn-sm show-narrow" style={{ marginBottom: 12 }} onClick={() => setPane("list")}>
              <Icon name="back" size={12} />
              All pull requests
            </button>
            {current ? <Detail key={current} pid={pid} number={current} /> : <Empty>Select a pull request.</Empty>}
          </main>
        </div>
      )}
    </>
  );
}

function Detail({ pid, number }: { pid: string; number: number }) {
  const nav = useNav();
  const q = usePr(pid, number);
  const inv = [["pr", pid, number], ["prs", pid]];
  const merge = useAction("prs.merge", { invalidate: inv, success: `Merged #${number}` });
  const update = useAction("prs.update", { invalidate: inv, success: "Saved to GitHub" });
  const gen = useAction<{ title: string; body: string }>("prs.generate");
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "open">("all");

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  const open = d.state === "open" || d.state === "draft";
  const [label, cls] = stateOf(d, d);
  const failing = d.checks.filter((c) => c.status === "fail").length;
  const running = d.checks.filter((c) => c.status === "run").length;
  const unresolved = d.threads.filter((t) => t.resolvable && !t.resolved).length;
  const approvals = d.reviewers.filter((r) => r.vote === "approve").length;
  const changes = d.reviewers.filter((r) => r.vote === "changes").length;
  const threads = filter === "open" ? d.threads.filter((t) => t.resolvable && !t.resolved) : d.threads;
  const startEdit = () => {
    setTitle(d.title);
    setBody(d.body);
    setEditing(true);
  };

  return (
    <div className="detail-inner">
      <div className="col" style={{ gap: 10 }}>
        {editing ? (
          <div className="field">
            <label htmlFor="pr-title">Title</label>
            <input id="pr-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
        ) : (
          <div className="row" style={{ alignItems: "flex-start" }}>
            <h1 className="grow">{d.title}</h1>
            {open && (
              <button className="btn btn-ghost btn-icon" aria-label="Edit title and description" onClick={startEdit}>
                <Icon name="edit" />
              </button>
            )}
          </div>
        )}
        <div className="row wrap muted" style={{ fontSize: 12.5 }}>
          <span className={`pill ${cls}`}>{label}</span>
          <span className="mono">#{d.number} · {d.head} → {d.base}</span>
          <span className="faint">·</span>
          <span>{d.mine ? "Opened by you" : `Opened by ${d.author}`} · {ago(d.updatedAt)}</span>
        </div>
      </div>

      <div className="row wrap" style={{ gap: 6 }}>
        {open && !d.conflict && d.state !== "draft" && (
          <button className="btn btn-primary" disabled={merge.isPending || running > 0} onClick={() => merge.mutate({ projectId: pid, number })}>
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
            {gen.isPending ? <span className="spinner" /> : <Icon name="sparkle" size={12} className="c-acc" />}
            Rewrite with AI
          </button>
        )}
        <button className="btn" onClick={() => openExternal(d.url)}>
          <Icon name="external" size={12} />
          Open on GitHub
        </button>
        {unresolved > 0 && open && <span className="c-acc" style={{ fontSize: 12.5 }}>{unresolved} unresolved conversation{unresolved === 1 ? "" : "s"}</span>}
      </div>

      {reviewOpen && <ReviewForm pid={pid} d={d} onDone={() => setReviewOpen(false)} />}

      <div className="kv">
        <div>
          <span>Checks</span>
          <span className={failing ? "c-del" : running ? "c-acc" : "c-add"}>
            {d.checks.length === 0 ? "None" : failing ? `${failing} failing` : running ? `${d.checks.length - running} of ${d.checks.length} passed, ${running} running` : `All ${d.checks.length} passing`}
          </span>
        </div>
        <div>
          <span>Reviews</span>
          <span>{d.state === "draft" ? "Draft" : [approvals && `${approvals} approval${approvals === 1 ? "" : "s"}`, changes && `${changes} changes requested`].filter(Boolean).join(" · ") || "No reviews yet"}</span>
        </div>
      </div>

      <section className="section">
        <h2>Reviewers</h2>
        {d.reviewers.length === 0 ? (
          <span className="muted">No reviewers yet.</span>
        ) : (
          <div className="row wrap" style={{ gap: 12 }}>
            {d.reviewers.map((r) => (
              <span key={r.login} className="row" style={{ gap: 8 }}>
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
                Save to GitHub
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

      <section className="section" aria-label="Conversation">
        <div className="row wrap">
          <h2>Conversation</h2>
          <span className="faint" style={{ fontSize: 12 }}>{d.threads.length ? `${unresolved} unresolved · ${d.threads.length} total` : ""}</span>
          <span className="grow" />
          <Seg label="Show" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "open", label: "Unresolved" }]} />
        </div>
        {threads.map((t) => <ThreadView key={t.id} pid={pid} number={number} t={t} />)}
        {threads.length === 0 && <span className="muted">{d.threads.length === 0 ? "No comments yet." : "Every conversation is resolved."}</span>}
        <NewComment pid={pid} number={number} />
      </section>

      {d.checks.length > 0 && (
        <section className="section">
          <h2>Checks</h2>
          <ul className="list">
            {d.checks.map((c, i) => (
              <li key={i} className="list-row" style={{ minHeight: 40 }}>
                <span className="pulse" style={{ animation: c.status === "run" ? undefined : "none", background: c.status === "pass" ? "var(--add-fg)" : c.status === "fail" ? "var(--del-fg)" : "var(--accent)" }} />
                <span className="grow">{c.name}</span>
                <span className="muted" style={{ fontSize: 12 }}>{c.status === "pass" ? "Passed" : c.status === "fail" ? "Failed" : "Running"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ReviewForm({ pid, d, onDone }: { pid: string; d: PrDetail; onDone: () => void }) {
  const opts: [string, string, string][] = d.mine
    ? [["comment", "Comment", "General feedback, no explicit approval."]]
    : [
        ["comment", "Comment", "General feedback, no explicit approval."],
        ["approve", "Approve", "Ready to merge."],
        ["changes", "Request changes", "Must be addressed before merging."],
      ];
  const [vote, setVote] = useState(opts[0][0]);
  const [text, setText] = useState("");
  const submit = useAction("prs.review", { invalidate: [["pr", pid, d.number]], success: "Review posted to GitHub" });
  const draft = useAction<{ text: string }>("prs.draftReview");
  return (
    <section aria-label="Submit review" className="col card" style={{ padding: 16, gap: 12 }}>
      <div className="row">
        <h2 className="grow">Submit review</h2>
        <span className="hint">Posted to GitHub as a review</span>
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
      {d.mine && <span className="hint">You opened this pull request, so GitHub only lets you comment on it.</span>}
      <div className="row wrap">
        <button className="btn" disabled={draft.isPending} onClick={() => draft.mutate({ projectId: pid, number: d.number }, { onSuccess: (r) => setText(r.text) })}>
          {draft.isPending ? <span className="spinner" /> : <Icon name="sparkle" size={12} className="c-acc" />}
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
  const [open, setOpen] = useState(!t.resolved);
  const [draft, setDraft] = useState("");
  const [picker, setPicker] = useState<string | null>(null);
  useEffect(() => setOpen(!t.resolved), [t.resolved]);
  const inv = [["pr", pid, number]];
  const reply = useAction("prs.reply", { invalidate: inv });
  const comment = useAction("prs.comment", { invalidate: inv });
  const resolve = useAction("prs.resolve", { invalidate: inv });
  const react = useAction("prs.react", { invalidate: inv });
  const ai = useAction<{ text: string }>("prs.draftReply");
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
              <span className="faint" style={{ fontSize: 12 }}>{ago(c.createdAt)}</span>
            </div>
            <div className="comment-body">{c.body}</div>
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
                  {EMOJI.map(([content, e, label]) => (
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
          <button className="btn btn-sm" disabled={ai.isPending} onClick={() => ai.mutate({ projectId: pid, number, threadId: t.id }, { onSuccess: (r) => setDraft(r.text) })}>
            {ai.isPending ? <span className="spinner" /> : <Icon name="sparkle" size={11} className="c-acc" />}
            Draft reply
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
    <div className="col">
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
