import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";

import { useAction, useCommits } from "../api/hooks";
import type { Commit } from "../api/types";
import { AuthorFilter, authorsOf } from "../components/AuthorFilter";
import { Avatar } from "../components/Avatar";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { Empty, ErrorBox, Loading, Modal } from "../components/ui";
import { ago, plural } from "../lib/format";
import { copyToClipboard } from "../lib/toast";

type ResetMode = "soft" | "mixed" | "hard";

/**
 * A branch's own commits, in place of the branch tree. One is always picked,
 * and the files show just its changes.
 */
export function CommitList({
  active,
  pid,
  branch,
  base,
  selected,
  checkedOut,
  upstream,
  current,
  onPick,
  onBack,
}: {
  active: boolean;
  pid: string;
  branch: string;
  /** Branch it is compared with ("" for a trunk: its recent history). */
  base: string;
  /** Picked commit; undefined = all changes. */
  selected?: string;
  /** The branch has a checkout: needed to revert or reset. */
  checkedOut: boolean;
  /** The branch tracks one on origin: a reset can be force pushed there. */
  upstream: boolean;
  /** Branch of the main checkout, where cherry-picks land. */
  current?: string;
  /** `auto` = picked on opening, not by the user. */
  onPick: (c?: Commit, auto?: boolean) => void;
  onBack: () => void;
}) {
  const commits = useCommits(pid, branch);
  const list = commits.data ?? [];
  // Commits of the local branch; origin's unpulled ones are listed too: they can't be reverted, only hard reset to.
  const local = list.filter((c) => !c.unpulled);
  const unpulled = list.filter((c) => c.unpulled);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const authors = useMemo(() => authorsOf(list), [list]);
  const [who, setWho] = useState<string[]>([]);
  // Picked authors still listed: one gone from the list (another branch) filters nothing.
  const mine = authors.filter((a) => who.includes(a.email)).flatMap((a) => a.emails);
  const shown = list.filter(
    (c) =>
      (!q || [c.subject, c.body, c.author, c.email, ...c.tags].some((t) => t.toLowerCase().includes(q)) || c.sha.startsWith(q)) &&
      (mine.length === 0 || mine.includes(c.email.toLowerCase())),
  );
  const [menu, setMenu] = useState<{ x: number; y: number; c: Commit } | null>(null);
  const [reset, setReset] = useState<{ c: Commit; mode: ResetMode } | null>(null);
  const [deletingTag, setDeletingTag] = useState<string | null>(null);
  const [tagging, setTagging] = useState<Commit | null>(null);
  const inv = [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid]];
  const revert = useAction<{ sha: string }>("commits.revert", { invalidate: inv, success: (r) => `Reverted · ${r.sha.slice(0, 7)}` });
  const pick = useAction<{ sha: string }>("commits.cherryPick", { invalidate: inv, success: (r) => `Cherry-picked onto ${current} · ${r.sha.slice(0, 7)}` });

  const openMenu = (c: Commit, e: MouseEvent) => {
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Keyboard-opened context menus report (0, 0): anchor to the row instead.
    const fromKey = e.clientX === 0 && e.clientY === 0;
    setMenu({ x: fromKey ? r.left : e.clientX, y: fromKey ? r.bottom + 2 : e.clientY, c });
  };

  const items = (c: Commit): MenuItem[] => {
    const short = c.sha.slice(0, 7);
    const needCheckout = checkedOut ? undefined : "check out first";
    // Origin's unpulled commits can't be reverted, and a soft or mixed reset forward onto one would
    // leave the commits it brings back as reversed changes: only a hard reset goes there.
    const needLocal = c.unpulled ? "pull first" : needCheckout;
    const onto = !current ? "nothing checked out" : current === branch ? "already on it" : undefined;
    return [
      { id: "copy", label: "Copy SHA", icon: "edit", hint: short, run: () => copyToClipboard(c.sha) },
      "sep",
      { id: "revert", label: "Revert commit", icon: "undo", hint: needLocal, disabled: !!needLocal, run: () => revert.mutate({ projectId: pid, branch, sha: c.sha }) },
      {
        id: "pick",
        label: <>Cherry-pick onto <span className="mono">{current ?? "…"}</span></>,
        icon: "commit",
        hint: onto,
        disabled: !!onto,
        run: () => pick.mutate({ projectId: pid, onto: current, sha: c.sha }),
      },
      "sep",
      { id: "soft", label: "Reset here · soft", icon: "back", hint: needLocal ?? "keep staged", disabled: !!needLocal, run: () => setReset({ c, mode: "soft" }) },
      { id: "mixed", label: "Reset here · mixed", icon: "back", hint: needLocal ?? "keep unstaged", disabled: !!needLocal, run: () => setReset({ c, mode: "mixed" }) },
      { id: "hard", label: "Reset here · hard", icon: "trash", hint: needCheckout ?? "discard", danger: true, disabled: !!needCheckout, run: () => setReset({ c, mode: "hard" }) },
      "sep",
      { id: "tag", label: "Create tag…", icon: "tag", run: () => setTagging(c) },
      ...c.tags.map((t): MenuItem => ({ id: `deleteTag:${t}`, label: <>Delete tag <span className="mono">{t}</span>…</>, icon: "trash", danger: true, run: () => setDeletingTag(t) })),
    ];
  };

  // A commit is always picked: the newest one on opening, or when the picked one leaves the list (reset, revert).
  useEffect(() => {
    if (list[0] && !list.some((c) => c.sha === selected)) onPick(list[0], true);
  }, [list, selected, onPick]);

  // Escape goes back to the branches, unless it is closing something else or typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (e.target as HTMLElement).closest("input, textarea")) return;
      if (document.querySelector("[role=dialog], [role=menu]")) return;
      onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  return (
    <section aria-label={`Commits of ${branch}`} className="ws-releases" data-pane data-active={active}>
      <div className="pane-head">
        <span className="row" style={{ gap: 6, minWidth: 0 }}>
          <button className="btn btn-sm btn-icon pane-toggle" aria-label="Back to branches" data-tip="Back to branches (Esc)" onClick={onBack}>
            <Icon name="back" size={13} />
          </button>
          <span className="mono ellipsis" style={{ fontSize: 12.5 }}>{branch}</span>
        </span>
        {commits.data && <span className="faint" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>{plural(list.length, "commit")}</span>}
      </div>
      <div className="tree-filter">
        <Icon name="search" size={12} className="faint" />
        <input type="search" className="input" placeholder="Filter commits" aria-label="Filter commits" value={query} onChange={(e) => setQuery(e.target.value)} />
        <AuthorFilter authors={authors} who={who} onChange={setWho} tip="Show only the commits of these authors" />
      </div>
      <div className="scroll commits commit-list" style={{ flex: "1 1 auto" }}>
        {commits.isLoading && <Loading />}
        {commits.error && <div style={{ padding: 12 }}><ErrorBox error={commits.error} /></div>}
        {shown.map((c) => (
          <button key={c.sha} className="commit-row" aria-pressed={c.sha === selected} onClick={() => onPick(c)} onContextMenu={(e) => openMenu(c, e)}>
            {(c.tags.length > 0 || c.local || c.origin) && (
              <span className="commit-tags">
                {c.tags.map((t) => (
                  <span key={t} className="commit-tag mono" title={`Tag ${t}`}>
                    <Icon name="tag" size={10} stroke={1.6} />
                    {t}
                  </span>
                ))}
                {c.local && <span className="tag local" title={`${branch} is here locally`}>local</span>}
                {c.origin && <span className="tag accent" title={`${branch} is here on origin`}>origin</span>}
              </span>
            )}
            <span className="commit-subject">{marked(c.subject, q)}</span>
            {c.body && <span className="commit-body">{marked(c.body, q)}</span>}
            <span className="commit-meta">
              <Avatar name={c.author} email={c.email} size={14} />
              <span className="ellipsis">{marked(c.author, q)}</span>
              <span className="mono">{c.sha.slice(0, 7)}</span>
              <span title={new Date(c.date).toLocaleString()} style={{ whiteSpace: "nowrap" }}>{ago(c.date)}</span>
            </span>
          </button>
        ))}
        {list.length > 0 && shown.length === 0 && <Empty>{q ? <>No commit matches “{query}”{mine.length > 0 && " by them"}.</> : "No commit by them."}</Empty>}
        {commits.data && list.length === 0 && <Empty>{base ? <>No commits that <span className="mono">{base}</span> doesn't have.</> : "No commits yet."}</Empty>}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} label={`Actions for ${menu.c.sha.slice(0, 7)}`} items={items(menu.c)} onClose={() => setMenu(null)} />}
      {reset && (
        <ResetModal
          pid={pid}
          branch={branch}
          commit={reset.c}
          dropped={local.findIndex((c) => c.sha === reset.c.sha)}
          restored={reset.c.unpulled ? unpulled.length - unpulled.findIndex((c) => c.sha === reset.c.sha) : 0}
          // Going forward onto origin drops every unpushed commit; going back, the ones above the target.
          lost={(reset.c.unpulled ? local : local.slice(0, local.findIndex((c) => c.sha === reset.c.sha))).filter((c) => c.unpushed)}
          mode={reset.mode}
          upstream={upstream}
          onMode={(mode) => setReset({ ...reset, mode })}
          onDone={() => onPick(undefined)}
          onClose={() => setReset(null)}
        />
      )}
      {deletingTag && <DeleteTagModal pid={pid} tag={deletingTag} onClose={() => setDeletingTag(null)} />}
      {tagging && <TagModal pid={pid} commit={tagging} onClose={() => setTagging(null)} />}
    </section>
  );
}

const RESET_MODES: { mode: ResetMode; label: string; hint: string }[] = [
  { mode: "soft", label: "Soft", hint: "Their changes stay staged, ready to commit again" },
  { mode: "mixed", label: "Mixed", hint: "Their changes stay in your files, unstaged" },
  { mode: "hard", label: "Hard", hint: "Their changes and any uncommitted work are thrown away" },
];

/** `text` with the search marked in it (first match). */
function marked(text: string, q: string): ReactNode {
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) return text;
  return <>{text.slice(0, i)}<mark className="tree-hit">{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

function ResetModal({
  pid,
  branch,
  commit,
  dropped,
  restored,
  lost,
  mode,
  upstream,
  onMode,
  onDone,
  onClose,
}: {
  pid: string;
  branch: string;
  commit: Commit;
  /** Newer commits that leave the branch on a reset back. */
  dropped: number;
  /** Origin's commits a reset forward brings onto the branch (0: a reset back). */
  restored: number;
  /** Never pushed commits that leave the branch: a hard reset loses them. */
  lost: Commit[];
  mode: ResetMode;
  upstream: boolean;
  onMode: (m: ResetMode) => void;
  onDone: () => void;
  onClose: () => void;
}) {
  const short = commit.sha.slice(0, 7);
  const reset = useAction("commits.reset", {
    invalidate: [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid]],
    success: `Reset ${branch} to ${short} (${mode})`,
  });
  const [forcePush, setForcePush] = useState(false);
  // At origin's tip, the branch already matches origin: nothing to push.
  const canPush = upstream && !commit.origin;
  const push = useAction("workspace.push", { invalidate: [["overview", pid], ["commits", pid]], success: `Force pushed ${branch}` });
  const done = () => { onDone(); onClose(); };
  const pending = reset.isPending || push.isPending;
  return (
    <Modal
      title={`Reset ${branch}`}
      sub={<><span className="mono">{short}</span> {commit.subject}</>}
      onClose={onClose}
      footer={
        <>
          <button
            className={`btn btn-md ${mode === "hard" ? "btn-danger" : "btn-primary"}`}
            disabled={pending}
            onClick={() =>
              reset.mutate(
                { projectId: pid, branch, sha: commit.sha, mode },
                // A failed push keeps the modal open on its error; the reset already happened.
                { onSuccess: () => (forcePush && canPush ? push.mutate({ projectId: pid, branch, force: true }, { onSuccess: done }) : done()) },
              )
            }
          >
            {pending && <span className="spinner" />}
            Reset ({mode}){forcePush && canPush && " & force push"}
          </button>
        </>
      }
    >
      {restored > 0 ? (
        <p style={{ margin: 0, lineHeight: 1.55 }}>
          Moves <span className="mono">{branch}</span> forward to this commit, bringing back {plural(restored, "commit")} from origin.
          Uncommitted work is thrown away.
        </p>
      ) : (
        <>
          <p style={{ margin: 0, lineHeight: 1.55 }}>
            Moves <span className="mono">{branch}</span> back to this commit.{" "}
            {dropped > 0 ? <>The {plural(dropped, "newer commit")} leave the branch.</> : "No commits leave the branch."} If they were pushed, the next push must be forced.
          </p>
          <div role="radiogroup" aria-label="Reset mode" className="col" style={{ gap: 6 }}>
            {RESET_MODES.map((m) => (
              <button key={m.mode} className="radio-card" role="radio" aria-checked={mode === m.mode} onClick={() => onMode(m.mode)}>
                <span className="radio-dot" />
                <span className="col" style={{ gap: 2 }}>
                  <span style={{ fontWeight: 500 }} className={m.mode === "hard" ? "c-del" : undefined}>{m.label}</span>
                  <span className="hint">{m.hint}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      {mode === "hard" && lost.length > 0 && (
        <div className="err-box warn">
          {lost.length === 1 ? "This commit was" : `These ${lost.length} commits were`} never pushed: a hard reset loses {lost.length === 1 ? "it" : "them"}.
          <ul className="lost-commits">
            {lost.map((c) => (
              <li key={c.sha} className="ellipsis">
                <span className="mono">{c.sha.slice(0, 7)}</span> {c.subject}
              </li>
            ))}
          </ul>
        </div>
      )}
      {canPush && (
        <label className="check">
          <input type="checkbox" checked={forcePush} onChange={() => setForcePush(!forcePush)} />
          <span>Force push to origin after the reset</span>
        </label>
      )}
      {reset.error && <ErrorBox error={reset.error} />}
      {push.error && <ErrorBox error={push.error} />}
    </Modal>
  );
}

/** Tag a branch's tip, or one commit, and push the tag. */
export function TagModal({ pid, branch, commit, onClose }: { pid: string; branch?: string; commit?: Commit; onClose: () => void }) {
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const what = commit ? commit.sha.slice(0, 7) : branch;
  const tag = useAction(commit ? "commits.tag" : "branches.tag", { invalidate: [["overview", pid], ["commits", pid]], success: `Tagged ${what} as ${name.trim()} and pushed it` });
  const submit = () => name.trim() && tag.mutate({ projectId: pid, ...(commit ? { sha: commit.sha } : { branch }), name: name.trim(), message }, { onSuccess: onClose });
  return (
    <Modal
      title="Create tag"
      sub={commit ? <><span className="mono">{what}</span> {commit.subject}</> : <span className="mono">{branch}</span>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md btn-primary" disabled={!name.trim() || tag.isPending} onClick={submit}>
            {tag.isPending && <span className="spinner" />}
            Create and push
          </button>
        </>
      }
    >
      <form className="col" style={{ gap: 14 }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="field">
          <label htmlFor="tag-name">Name</label>
          <input id="tag-name" className="input mono" placeholder="v1.2.0" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="tag-msg">Message</label>
          <input id="tag-msg" className="input" placeholder="Defaults to the name" value={message} onChange={(e) => setMessage(e.target.value)} />
        </div>
      </form>
      {tag.error && <ErrorBox error={tag.error} />}
    </Modal>
  );
}

export function DeleteTagModal({ pid, tag, onClose }: { pid: string; tag: string; onClose: () => void }) {
  const del = useAction("tags.delete", { invalidate: [["overview", pid], ["commits", pid]], success: `Deleted tag ${tag}` });
  return (
    <Modal
      title="Delete tag"
      sub={<span className="mono">{tag}</span>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md btn-danger" disabled={del.isPending} onClick={() => del.mutate({ projectId: pid, name: tag }, { onSuccess: onClose })}>
            {del.isPending && <span className="spinner" />}
            Delete tag
          </button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        Deletes <span className="mono">{tag}</span> locally and on origin, for everyone who uses it. The commits it points at stay.
      </p>
      {del.error && <ErrorBox error={del.error} />}
    </Modal>
  );
}
