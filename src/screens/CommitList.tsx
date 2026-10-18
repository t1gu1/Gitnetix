import { useEffect } from "react";

import { useCommits } from "../api/hooks";
import type { Commit } from "../api/types";
import { Icon } from "../components/Icon";
import { Empty, ErrorBox, Loading } from "../components/ui";
import { ago, plural } from "../lib/format";

/**
 * A branch's own commits, in place of the branch tree. "All changes" on top is
 * the branch's combined diff; picking a commit shows just its files.
 */
export function CommitList({
  active,
  pid,
  branch,
  base,
  selected,
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
  onPick: (c?: Commit) => void;
  onBack: () => void;
}) {
  const commits = useCommits(pid, branch);
  const list = commits.data ?? [];

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
      <div className="scroll commits" style={{ flex: "1 1 auto" }}>
        {commits.isLoading && <Loading />}
        {commits.error && <div style={{ padding: 12 }}><ErrorBox error={commits.error} /></div>}
        {base && list.length > 0 && (
          <button className="commit-row" aria-pressed={!selected} onClick={() => onPick(undefined)}>
            <span className="commit-subject">All changes</span>
            <span className="commit-meta">
              {plural(list.length, "commit")} combined, since <span className="mono">{base}</span>
            </span>
          </button>
        )}
        {list.map((c) => (
          <button key={c.sha} className="commit-row" aria-pressed={c.sha === selected} onClick={() => onPick(c)}>
            <span className="commit-subject">{c.subject}</span>
            {c.body && <span className="commit-body">{c.body}</span>}
            <span className="commit-meta">
              <span className="mono">{c.sha.slice(0, 7)}</span>
              <span className="ellipsis">{c.author}</span>
              <span title={new Date(c.date).toLocaleString()} style={{ whiteSpace: "nowrap" }}>{ago(c.date)}</span>
            </span>
          </button>
        ))}
        {commits.data && list.length === 0 && <Empty>{base ? <>No commits that <span className="mono">{base}</span> doesn't have.</> : "No commits yet."}</Empty>}
      </div>
    </section>
  );
}
