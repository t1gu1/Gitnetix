import { useEffect, useRef, useState } from "react";

import { useFileHistory } from "../api/hooks";
import type { FileCommit } from "../api/types";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { Empty, ErrorBox, Loading } from "../components/ui";
import { ago, plural } from "../lib/format";

/** Commits fetched at a time: scrolling near the end of the list asks for this many more. */
const PAGE = 200;

/**
 * The commits of a branch that changed one file, renames followed, in place of the file list. One is always picked
 * (`want` once listed, else the newest) and the diff shows what it did to the file.
 */
export function FileHistory({
  pid,
  branch,
  path,
  selected,
  want,
  onPick,
  onBack,
}: {
  pid: string;
  branch: string;
  path: string;
  selected?: string;
  /** A commit to pick once listed (a blame label's): older commits load until it is. */
  want?: string;
  /** `auto` = picked on opening, not by the user. */
  onPick: (c: FileCommit, auto?: boolean) => void;
  onBack: () => void;
}) {
  const [limit, setLimit] = useState(PAGE);
  const log = useFileHistory(pid, branch, path, limit);
  const list = log.data ?? [];
  // Fewer than asked for: the list reached the file's first commit.
  const more = !log.isPlaceholderData && list.length >= limit;
  const end = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = end.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setLimit((l) => l + PAGE), { root: el.parentElement, rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [more]);

  useEffect(() => {
    if (log.isPlaceholderData || !list[0]) return;
    const wanted = want ? list.find((c) => c.sha === want) : undefined;
    if (want && !wanted && more) setLimit((l) => l + PAGE);
    // A merge's lines aren't in the file's history: the pick stays.
    else if (wanted || want || !list.some((c) => c.sha === selected)) onPick(wanted ?? list.find((c) => c.sha === selected) ?? list[0], true);
  }, [list, selected, want, more, log.isPlaceholderData, onPick]);

  // Escape goes back to the files when no diff is open to take it first (see Workspace).
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
    <>
      <div className="pane-head">
        <span className="row" style={{ gap: 6, minWidth: 0 }}>
          <button className="btn btn-sm btn-icon pane-back" aria-label="Back to files" data-tip="Back to files (Esc)" onClick={onBack}>
            <Icon name="back" size={13} />
          </button>
          <Icon name="history" size={13} className="faint" />
          <span className="mono ellipsis" style={{ fontSize: 12.5 }}>{path}</span>
        </span>
        {log.data && <span className="faint" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>{plural(list.length, "commit")}</span>}
      </div>
      <div className="scroll commits commit-list" style={{ flex: "1 1 auto" }}>
        {log.isLoading && <Loading />}
        {log.error && <div style={{ padding: 12 }}><ErrorBox error={log.error} /></div>}
        {list.map((c) => (
          <button key={c.sha} className="commit-row" aria-pressed={c.sha === selected} onClick={() => onPick(c)}>
            {(c.status !== "M" || c.tags.length > 0) && (
              <span className="commit-tags">
                {c.tags.map((t) => (
                  <span key={t} className="commit-tag mono" title={`Tag ${t}`}>
                    <Icon name="tag" size={10} stroke={1.6} />
                    {t}
                  </span>
                ))}
                {c.status === "A" && <span className="tag accent">created</span>}
                {c.status === "D" && <span className="tag">deleted</span>}
                {c.status === "R" && (
                  <>
                    <span className="tag">renamed</span>
                    <span className="mono faint ellipsis" style={{ fontSize: 11, minWidth: 0 }}>from {c.from}</span>
                  </>
                )}
              </span>
            )}
            <span className="commit-subject">{c.subject}</span>
            <span className="commit-meta">
              <Avatar name={c.author} email={c.email} size={14} />
              <span className="ellipsis">{c.author}</span>
              <span className="mono">{c.sha.slice(0, 7)}</span>
              <span title={new Date(c.date).toLocaleString()} style={{ whiteSpace: "nowrap" }}>{ago(c.date)}</span>
              <span className="grow" />
              <span className="mono" style={{ whiteSpace: "nowrap" }}>
                {c.additions > 0 && <span className="c-add">+{c.additions}</span>} {c.deletions > 0 && <span className="c-del">−{c.deletions}</span>}
              </span>
            </span>
          </button>
        ))}
        {log.data && list.length === 0 && <Empty>No commit on <span className="mono">{branch}</span> changed this file yet.</Empty>}
        {log.isPlaceholderData && <Loading />}
        {more && (
          <button ref={end} className="btn btn-ghost btn-sm" style={{ alignSelf: "center", margin: 8 }} onClick={() => setLimit((l) => l + PAGE)}>
            Load older commits
          </button>
        )}
      </div>
    </>
  );
}
