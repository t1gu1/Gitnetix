import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAction, useFiles, useOverview, useTicketComments } from "../api/hooks";
import { openExternal, rpc } from "../api/transport";
import type { CommentReaction, FileChange, LinkedLines, Permalink, Ticket, TicketComment } from "../api/types";
import { EMOJI_GROUPS, emojiName, emojiOf, FREQUENT } from "../lib/emoji";
import { plural } from "../lib/format";
import { MAC } from "../lib/keys";
import { useNav } from "../lib/nav";
import { toast } from "../lib/toast";
import { mapFileOf, type Mode } from "../screens/Workspace";
import { FileOver } from "../screens/Worktrees";
import { Adf } from "./Adf";
import { Drafts, paste, uploads, useAttach, type Attachment, type Upload } from "./AgentLog";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { ago, Busy, ErrorBox, Markdown, type Media } from "./ui";

/** What each tracker lets Gitnetix do with comments; what one can't do gets no control. `react`: the emoji it takes,
 *  null for any; an empty list shows reactions without changing them; missing, it has none. */
const CAN: Record<Ticket["source"], { reply: boolean; files: boolean; markdown: boolean; react?: readonly string[] | null }> = {
  // Threads, any emoji, uploads to Linear's storage.
  linear: { reply: true, files: true, markdown: true, react: null },
  // GitHub's API takes its eight reactions and no uploads.
  github: { reply: false, files: false, markdown: true, react: ["👍", "👎", "😄", "🎉", "😕", "❤️", "🚀", "👀"] },
  jira: { reply: false, files: true, markdown: false },
  trello: { reply: false, files: true, markdown: true, react: null },
  asana: { reply: false, files: true, markdown: false },
};

/** "Ana, Bo and Cy". */
const names = (l: string[]) => (l.length < 2 ? l.join("") : `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}`);

/** Who left reaction `r`: "You, Ana and Bo"; by count where the tracker gives no names ("You and 2 others"). The
 *  tracker lists the user first among `people` when `mine`. */
function whoReacted(r: CommentReaction) {
  if (r.people?.length) return names(r.mine ? ["You", ...r.people.slice(1)] : r.people);
  const others = r.count - (r.mine ? 1 : 0);
  const rest = others === 1 ? "1 other" : `${others} others`;
  return r.mine ? (others ? `You and ${rest}` : "You") : others === 1 ? "1 person" : `${others} people`;
}

/** The ticket's comments: each thread in its own box, its first comment then the replies on a line from its avatar, and
 *  Reply as the box's last row where the tracker has threads; then a box for a new comment. */
export function TicketComments({ t, name, html, ask }: { t: Ticket; name: string; html: Media; ask?: ReactNode }) {
  const nav = useNav();
  // Links to code point into the repository holding the ticket's branch.
  const pid = t.branchProject ?? nav.projectId!;
  const q = useTicketComments(t);
  const threads = q.data ?? [];
  const count = threads.reduce((n, c) => n + 1 + c.replies.length, 0);
  // Each open reply keeps its draft until posted or cancelled, whatever other thread gets one.
  const [writing, setWriting] = useState<ReadonlySet<string>>(new Set());
  const box = useRef<HTMLDivElement>(null);
  return (
    <section className="section">
      <h2>Comments {count > 0 && <span className="mono">{count}</span>}</h2>
      {ask}
      {q.isLoading ? (
        <span className="muted">Loading comments…</span>
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : threads.length === 0 ? (
        <span className="muted">No comments in {name}.</span>
      ) : (
        <div className="tk-threads">
          {threads.map((c) => (
            <Thread
              key={c.id}
              t={t}
              c={c}
              pid={pid}
              name={name}
              html={html}
              writing={writing.has(c.id)}
              onWrite={(on) =>
                setWriting((w) => {
                  const n = new Set(w);
                  if (on) n.add(c.id);
                  else n.delete(c.id);
                  return n;
                })
              }
            />
          ))}
        </div>
      )}
      {!q.isLoading && (
        <div ref={box}>
          <Composer key={`${t.source}:${t.id}`} t={t} pid={pid} name={name} drop={() => box.current} />
        </div>
      )}
    </section>
  );
}

/** A thread's box. Files dropped on it open its reply with them. */
function Thread({ t, c, pid, name, html, writing, onWrite }: { t: Ticket; c: TicketComment; pid: string; name: string; html: Media; writing: boolean; onWrite: (on: boolean) => void }) {
  const can = CAN[t.source];
  const box = useRef<HTMLElement>(null);
  const [dropped, setDropped] = useState<Attachment[]>([]);
  // The tool the closed row's icon asked for, run once the reply opens.
  const [start, setStart] = useState<Start>();
  const write = (on: boolean, tool?: Start) => {
    setStart(tool);
    onWrite(on);
  };
  // While the reply is open, it takes the drops itself.
  const { over } = useAttach(
    () => box.current,
    [],
    (f) => {
      setDropped(f);
      write(true);
    },
    !can.reply || !can.files || writing,
  );
  const first = c.author.split(/\s+/)[0];
  return (
    <article ref={box} className="tk-thread" data-writing={writing || undefined} data-over={over || undefined}>
      <div className="tk-thread-in">
        <Comment t={t} c={c} pid={pid} html={html} rail={c.replies.length > 0} />
        {c.replies.length > 0 && (
          <div className="tk-replies">
            {c.replies.map((r) => (
              <Comment key={r.id} t={t} c={r} pid={pid} html={html} reply />
            ))}
          </div>
        )}
      </div>
      {can.reply &&
        (writing ? (
          <Composer
            t={t}
            pid={pid}
            name={name}
            parent={c}
            initial={dropped}
            start={start}
            drop={() => box.current}
            onDone={() => {
              setDropped([]);
              write(false);
            }}
          />
        ) : (
          <div className="tk-reply-row">
            <button type="button" className="tk-reply-open" onClick={() => write(true)}>
              <Icon name={over ? "attach" : "undo"} size={13} />
              {over ? `Drop to reply to ${first} with these files` : `Reply to ${first}…`}
            </button>
            {can.files && (
              <button type="button" className="btn btn-ghost btn-icon" aria-label={`Reply to ${first} with files or pictures`} data-tip="Attach files or pictures" onClick={() => write(true, "attach")}>
                <Icon name="attach" size={14} />
              </button>
            )}
            <button type="button" className="btn btn-ghost btn-icon" aria-label={`Reply to ${first} with a file of the repository`} data-tip="Link a file of the repository" onClick={() => write(true, "link")}>
              <Icon name="fileCode" size={14} />
            </button>
          </div>
        ))}
    </article>
  );
}

/** One comment: Jira's in its own format, the others' as Markdown (HTML only from GitHub); the repository lines it links
 *  to, then its reactions. With none yet, the add button waits at its top right until the pointer is over it. */
function Comment({ t, c, pid, html, rail, reply }: { t: Ticket; c: TicketComment; pid: string; html: Media; rail?: boolean; reply?: boolean }) {
  const can = CAN[t.source];
  const rx = c.reactions ?? [];
  const adds = can.react !== undefined && can.react?.length !== 0;
  return (
    <div className={reply ? "tk-cm tk-reply" : "tk-cm"} data-rail={rail || undefined}>
      <Avatar name={c.author} size={reply ? 24 : 28} decorative />
      <div className="tk-cm-main">
        <div className="tk-cm-head">
          <span className="tk-cm-name">{c.author}</span>
          <span className="faint">{ago(c.createdAt)}</span>
          {adds && !rx.length && <AddReaction t={t} c={c} />}
        </div>
        <div className="comment-body">{c.doc ? <Adf doc={c.doc} /> : <Markdown text={c.body} html={html} breaks />}</div>
        <CodeLinks t={t} pid={pid} text={c.body} />
        {can.react !== undefined && rx.length > 0 && <Reactions t={t} c={c} adds={adds} />}
        {/* Without hover (phones), the add button stands where the reactions will. */}
        {adds && !rx.length && (
          <div className="tk-rx tk-rx-touch">
            <AddReaction t={t} c={c} />
          </div>
        )}
      </div>
    </div>
  );
}

type ReactVars = { source: string; conn: string; id: string; comment: string; emoji: string; add: boolean };
/** A tool to run as a reply opens: the file chooser, or the repository file picker. */
type Start = "attach" | "link";

/** Leaves or takes back a reaction; the comments show it as soon as the tracker took it. */
function useReact(t: Ticket) {
  const key = ["ticketComments", t.source, t.conn, t.id];
  return useAction<unknown, ReactVars>("tickets.react", { invalidate: [key], patch: (qc, v) => qc.setQueryData<TicketComment[]>(key, (l) => l && bump(l, v)) });
}

/** `list` with reaction `v.emoji` added on comment `v.comment`, or taken away. */
function bump(list: TicketComment[], v: ReactVars): TicketComment[] {
  return list.map((c) => {
    if (c.id !== v.comment) return c.replies.length ? { ...c, replies: bump(c.replies, v) } : c;
    const glyph = emojiOf(v.emoji);
    const rx = [...(c.reactions ?? [])];
    const i = rx.findIndex((r) => r.key === v.emoji || (!!glyph && (r.emoji || emojiOf(r.key)) === glyph));
    // The user stands first among the names, whatever theirs is.
    if (i < 0) {
      if (v.add) rx.push({ key: v.emoji, emoji: glyph, count: 1, mine: true, people: [""] });
    } else {
      const r = rx[i];
      const count = r.count + (v.add ? 1 : -1);
      const people = r.people && (v.add ? ["", ...r.people] : r.people.slice(1));
      if (count > 0) rx[i] = { ...r, count, mine: v.add, people };
      else rx.splice(i, 1);
    }
    return { ...c, reactions: rx };
  });
}

function Reactions({ t, c, adds }: { t: Ticket; c: TicketComment; adds: boolean }) {
  const only = CAN[t.source].react;
  const react = useReact(t);
  return (
    <div className="tk-rx">
      {(c.reactions ?? []).map((r) => {
        // A workspace's own emoji has no character: its name stands in.
        const e = r.emoji || emojiOf(r.key);
        const shown = e ?? `:${r.key}:`;
        return (
          <button
            key={r.key}
            type="button"
            className="reaction"
            aria-pressed={r.mine}
            aria-label={`${shown} ${r.count}${r.mine ? ", you reacted" : ""}`}
            data-tip={`${whoReacted(r)} reacted with ${shown}`}
            disabled={only !== null && !(e && only?.includes(e))}
            onClick={() => react.mutate({ source: t.source, conn: t.conn, id: t.id, comment: c.id, emoji: r.key, add: !r.mine })}
          >
            <span className="tk-emoji">{shown}</span>
            <span>{r.count}</span>
          </button>
        );
      })}
      {adds && <AddReaction t={t} c={c} />}
    </div>
  );
}

function AddReaction({ t, c }: { t: Ticket; c: TicketComment }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const react = useReact(t);
  const pick = (e: string) => {
    setOpen(false);
    const had = c.reactions?.find((r) => (r.emoji || emojiOf(r.key)) === e);
    if (!had?.mine) react.mutate({ source: t.source, conn: t.conn, id: t.id, comment: c.id, emoji: had?.key ?? e, add: true });
  };
  return (
    <span ref={wrap} className="tk-rx-add" data-open={open || undefined}>
      <button type="button" className="reaction" aria-label="Add a reaction" aria-expanded={open} data-tip={open ? undefined : "Add a reaction"} onClick={() => setOpen(!open)}>
        <Icon name="smilePlus" size={14} />
      </button>
      {open && <EmojiPicker wrap={wrap} only={CAN[t.source].react ?? null} label="Pick a reaction" onPick={pick} onClose={() => setOpen(false)} />}
    </span>
  );
}

/** Closes a floating panel on Escape, back to its button, or on a press outside `wrap`, which holds that button too. */
function useDismiss(wrap: RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) close.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      wrap.current?.querySelector("button")?.focus();
      close.current();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [wrap]);
}

/** Emoji to pick from, floating by its button: a search, the frequent ones, then each group. `only`: the ones the tracker
 *  takes; eight or fewer show as one row. */
function EmojiPicker({ wrap, only, label, onPick, onClose }: { wrap: RefObject<HTMLElement | null>; only: readonly string[] | null; label: string; onPick: (e: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  useDismiss(wrap, onClose);
  const button = (e: string) => (
    <button key={e} type="button" className="tk-pick-e" aria-label={emojiName(e).replace(/_/g, " ") || e} data-tip={`:${emojiName(e)}:`} onClick={() => onPick(e)}>
      {e}
    </button>
  );
  if (only && only.length <= 8) {
    return (
      <div className="tk-pop tk-pick-row" role="dialog" aria-label={label}>
        {only.map(button)}
      </div>
    );
  }
  const fits = (e: string) => !only || only.includes(e);
  const term = q.trim().toLowerCase().replace(/^:|:$/g, "");
  const groups: [string, string[]][] = term
    ? [["", EMOJI_GROUPS.flatMap(([, l]) => l.filter(([, ...n]) => n.some((x) => x.includes(term))).map(([e]) => e)).filter(fits)]]
    : [["Frequent", FREQUENT.filter(fits)], ...EMOJI_GROUPS.map(([g, l]): [string, string[]] => [g, l.map(([e]) => e).filter(fits)])];
  const first = groups[0][1][0];
  return (
    <div className="tk-pop tk-pick" role="dialog" aria-label={label}>
      <input
        className="input"
        placeholder="Search emoji"
        aria-label="Search emoji"
        value={q}
        autoFocus
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && first) {
            e.preventDefault();
            onPick(first);
          }
        }}
      />
      <div className="tk-pick-scroll">
        {groups
          .filter(([, l]) => l.length)
          .map(([g, l]) => (
            <div key={g}>
              {g && <h3>{g}</h3>}
              <div className="tk-pick-grid">{l.map(button)}</div>
            </div>
          ))}
        {!first && <p className="faint">No emoji named “{q.trim()}”.</p>}
      </div>
    </div>
  );
}

/** Where a comment is written: its text and the files going with it, then attach, link a repository file, emoji and
 *  post. `parent`: a reply in that thread, with Cancel. Files dropped on `drop()` or pasted join it; `initial`: the ones
 *  dropped on the thread before it opened. They upload when it posts, so a reply left unsent leaves nothing behind. */
function Composer({ t, pid, name, parent, initial = [], start, drop, onDone }: { t: Ticket; pid: string; name: string; parent?: TicketComment; initial?: Attachment[]; start?: Start; drop: () => HTMLElement | null | undefined; onDone?: () => void }) {
  const can = CAN[t.source];
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Attachment[]>(initial);
  const [reading, setReading] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const chooser = useRef<HTMLInputElement>(null);
  // Opened from the reply row's paperclip: the file chooser at once, still within that click's permission.
  useEffect(() => {
    if (start === "attach") chooser.current?.click();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // The box grows with its text, up to a screenful; past that it scrolls.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, 360)}px`;
  }, [text]);
  const { over, add } = useAttach(drop, files, setFiles, !can.files);
  const post = useAction<unknown, { source: string; conn: string; id: string; body: string; parentId?: string; files: Upload[] }>("tickets.comment", {
    invalidate: [["ticketComments", t.source, t.conn, t.id], ["ticketFiles", t.source, t.conn, t.id]],
  });
  const busy = post.isPending || reading;
  const ready = (!!text.trim() || files.length > 0) && !busy;
  const send = () => {
    if (!ready) return;
    setReading(true);
    uploads(files)
      .then(
        (up) =>
          post.mutate(
            { source: t.source, conn: t.conn, id: t.id, body: text.trim(), parentId: parent?.id, files: up },
            {
              onSuccess: () => {
                setText("");
                setFiles([]);
                onDone?.();
              },
            },
          ),
        (e) => toast(`Could not read the files: ${e}`, "error"),
      )
      .finally(() => setReading(false));
  };
  // At the caret, read when it lands: a repository link comes back after the user may have typed on.
  const insert = (s: string) => {
    const el = field.current;
    const v = el?.value ?? text;
    const [a, b] = el ? [el.selectionStart, el.selectionEnd] : [v.length, v.length];
    setText(v.slice(0, a) + s + v.slice(b));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(a + s.length, a + s.length);
    });
  };
  const first = parent?.author.split(/\s+/)[0];
  const id = parent ? `tk-reply-${parent.id}` : "tk-new-comment";
  const hint = [can.markdown && "Markdown", can.files && "drop or paste files"].filter(Boolean).join(" · ");
  return (
    <div className="tk-compose" data-over={over || undefined}>
      <label htmlFor={id} className="sr-only">{parent ? `Reply to ${parent.author}` : `New comment in ${name}`}</label>
      <textarea
        id={id}
        ref={field}
        rows={parent ? 2 : 3}
        placeholder={parent ? `Reply to ${first}…` : `Comment in ${name}…`}
        value={text}
        autoFocus={!!parent}
        onChange={(e) => setText(e.target.value)}
        onPaste={can.files ? (e) => paste(e, files, add) : undefined}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            send();
          } else if (e.key === "Escape" && parent && !text.trim() && !files.length) onDone?.();
        }}
      />
      {files.length > 0 && (
        <div className="ag-files tk-compose-files">
          <Drafts files={files} onFiles={setFiles} />
        </div>
      )}
      <div className="tk-compose-tools">
        {can.files && (
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Attach files or pictures" data-tip="Attach files or pictures" onClick={() => chooser.current?.click()}>
            <Icon name="attach" size={14} />
          </button>
        )}
        <LinkFile t={t} pid={pid} markdown={can.markdown} startOpen={start === "link"} onLink={insert} />
        <EmojiInsert onPick={insert} />
        {hint && <span className="hint hide-narrow">{hint}</span>}
        <span className="grow" />
        <span className="hint hide-narrow">{MAC ? "⌘" : "Ctrl"} ↵</span>
        {parent && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={onDone}>
            Cancel
          </button>
        )}
        <button type="button" className="btn btn-sm btn-primary" disabled={!ready} onClick={send}>
          <Busy on={busy}>{null}</Busy>
          {parent ? "Reply" : "Comment"}
        </button>
      </div>
      {can.files && (
        <input
          ref={chooser}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            add([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      )}
      {over && (
        <div className="tk-drop" aria-hidden="true">
          <Icon name="attach" size={14} />
          Drop to attach
        </div>
      )}
    </div>
  );
}

function EmojiInsert({ onPick }: { onPick: (e: string) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  return (
    <span ref={wrap} className="tk-tool-pop">
      <button type="button" className="btn btn-ghost btn-icon" aria-label="Insert an emoji" aria-expanded={open} data-tip={open ? undefined : "Insert an emoji"} onClick={() => setOpen(!open)}>
        <Icon name="smile" size={14} />
      </button>
      {open && (
        <EmojiPicker
          wrap={wrap}
          only={null}
          label="Insert an emoji"
          onPick={(e) => {
            setOpen(false);
            onPick(e);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}

/** Links a file of the repository, or some of its lines, as origin has it on the ticket's branch (else the default
 *  branch): a Markdown link where the tracker reads Markdown, the bare address elsewhere. */
function LinkFile({ t, pid, markdown, startOpen, onLink }: { t: Ticket; pid: string; markdown: boolean; startOpen?: boolean; onLink: (s: string) => void }) {
  const [open, setOpen] = useState(!!startOpen);
  const [busy, setBusy] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const ov = useOverview(open ? pid : undefined).data;
  const branch = t.branch || ov?.defaultBranch;
  const link = (path: string, lines?: [number, number]) => {
    setOpen(false);
    setBusy(true);
    rpc<Permalink>("workspace.permalink", { projectId: pid, branch: branch ?? "", path, start: lines?.[0], end: lines?.[1] })
      .then(
        (p) => {
          const at = lines ? `:${lines[0]}${lines[1] !== lines[0] ? `-${lines[1]}` : ""}` : "";
          onLink(markdown ? `[${path.split("/").pop()}${at}](${p.url})` : p.url);
          if (branch && p.branch !== branch) toast(`Linked ${path} as it is on ${p.branch}: origin has no ${branch} with it yet`);
        },
        (e) => toast(`Could not link ${path}: ${e instanceof Error ? e.message : e}`, "error"),
      )
      .finally(() => setBusy(false));
  };
  return (
    <span ref={wrap} className="tk-tool-pop">
      <button type="button" className="btn btn-ghost btn-icon" aria-label="Link a file of the repository" aria-expanded={open} data-tip={open ? undefined : "Link a file of the repository"} disabled={busy} onClick={() => setOpen(!open)}>
        <Busy on={busy}>
          <Icon name="fileCode" size={14} />
        </Busy>
      </button>
      {open && <FilePick wrap={wrap} pid={pid} branch={branch} onPick={link} onClose={() => setOpen(false)} />}
    </span>
  );
}

/** The repository's files to link one: those the branch changed first. "name:12" or "name:12-20" points at lines. */
function FilePick({ wrap, pid, branch, onPick, onClose }: { wrap: RefObject<HTMLElement | null>; pid: string; branch?: string; onPick: (path: string, lines?: [number, number]) => void; onClose: () => void }) {
  useDismiss(wrap, onClose);
  const q = useFiles(pid, branch, "project");
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const m = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(query.trim());
  const term = (m?.[1] ?? "").toLowerCase();
  const lines = m?.[2] ? ([Number(m[2]), Number(m[3] ?? m[2])].sort((a, b) => a - b) as [number, number]) : undefined;
  const hit = (f: FileChange) => !term || f.path.toLowerCase().includes(term);
  const all = q.data ?? [];
  // A deleted file has nothing left to link.
  const changed = all.filter((f) => f.status !== " " && f.status !== "D" && hit(f)).slice(0, 50);
  const others = all.filter((f) => f.status === " " && hit(f)).slice(0, 50 - changed.length);
  const rows = [...changed, ...others];
  useEffect(() => {
    list.current?.querySelector("[data-at]")?.scrollIntoView({ block: "nearest" });
  }, [at]);
  const row = (f: FileChange, i: number) => {
    const cut = f.path.lastIndexOf("/") + 1;
    return (
      <button key={f.path} type="button" className="tk-file" data-at={i === at || undefined} onMouseEnter={() => setAt(i)} onClick={() => onPick(f.path, lines)}>
        <Icon name="fileCode" size={13} />
        <span className="ellipsis">
          <span className="faint">{f.path.slice(0, cut)}</span>
          {f.path.slice(cut)}
        </span>
        {f.status !== " " && (
          <span className="mono tk-file-n">
            {f.additions > 0 && <span className="c-add">+{f.additions}</span>} {f.deletions > 0 && <span className="c-del">−{f.deletions}</span>}
          </span>
        )}
      </button>
    );
  };
  return (
    <div className="tk-pop tk-files" role="dialog" aria-label="Link a file of the repository">
      <input
        className="input"
        autoFocus
        placeholder="Search files"
        aria-label="Search files, then :12 or :12-20 for lines"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setAt(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setAt((a) => Math.max(0, Math.min(rows.length - 1, a + (e.key === "ArrowDown" ? 1 : -1))));
          } else if (e.key === "Enter" && rows[at]) {
            e.preventDefault();
            onPick(rows[at].path, lines);
          }
        }}
      />
      <div ref={list} className="tk-files-list">
        {!branch || q.isLoading ? (
          <span className="spinner" aria-label="Loading files" />
        ) : !rows.length ? (
          <p className="faint">{term ? `No file matches “${m?.[1]}”.` : "No files."}</p>
        ) : (
          <>
            {changed.length > 0 && <h3>Changed on {branch}</h3>}
            {changed.map(row)}
            {others.length > 0 && <h3>{changed.length ? "Other files" : `Files on ${branch}`}</h3>}
            {others.map((f, i) => row(f, i + changed.length))}
          </>
        )}
      </div>
      <p className="tk-files-hint">{lines ? `Links lines ${lines[0]}${lines[1] !== lines[0] ? ` to ${lines[1]}` : ""}` : "Type :12 or :12-20 after the name to link lines"} · ↵ to link</p>
    </div>
  );
}

/** A link to a file at a commit, as GitHub, GitLab, Gitea, Bitbucket and Azure DevOps write it. */
const FILE_LINK = /https?:\/\/[^\s<>()[\]"'`]+(?:\/blob\/|\/src\/|\/_git\/)[^\s<>()[\]"'`]+/g;

/** The repository lines `text` links to, under it (four links at most). */
function CodeLinks({ t, pid, text }: { t: Ticket; pid: string; text: string }) {
  const urls = useMemo(() => [...new Set((text.match(FILE_LINK) ?? []).map((u) => u.replace(/[.,;:!?]+$/, "")))].slice(0, 4), [text]);
  return urls.map((u) => <CodeLink key={u} t={t} pid={pid} url={u} />);
}

/** Lines of the repository a comment links to, read from this clone: the path opens the file over the page, the arrow
 *  the host's page. Nothing for a link elsewhere or a commit the clone doesn't have. */
function CodeLink({ t, pid, url }: { t: Ticket; pid: string; url: string }) {
  const q = useQuery({ queryKey: ["linkedLines", pid, url], queryFn: () => rpc<LinkedLines | null>("workspace.linkedLines", { projectId: pid, url }), staleTime: Infinity, retry: false });
  const ov = useOverview(pid).data;
  const [over, setOver] = useState<{ branch: string; at: { mode: Mode; file: string; preview?: boolean } }>();
  const l = q.data;
  if (!l) return null;
  const open = async () => {
    const branch = t.branch || ov?.defaultBranch;
    const at = branch ? await mapFileOf(pid, branch, l.path).catch(() => null) : null;
    if (branch && at) setOver({ branch, at });
    else openExternal(url);
  };
  return (
    <figure className="tk-code">
      <figcaption className="tk-code-head">
        <Icon name="fileCode" size={13} />
        <button type="button" className="tk-code-path" data-tip="Open the file" onClick={open}>
          {l.path}
        </button>
        <span className="mono faint">{l.start === l.end ? `line ${l.start}` : `lines ${l.start}-${l.end}`}</span>
        <span className="grow" />
        <span className="mono faint hide-narrow">{l.sha}</span>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Open in the browser" data-tip="Open in the browser" onClick={() => openExternal(url)}>
          <Icon name="external" size={12} />
        </button>
      </figcaption>
      <div className="tk-code-lines">
        {l.lines.map((x, i) => (
          <div key={i}>
            <i>{l.start + i}</i>
            <span>{x || " "}</span>
          </div>
        ))}
      </div>
      {l.more > 0 && <div className="tk-code-more">{plural(l.more, "more line")}</div>}
      {over && <FileOver pid={pid} branch={over.branch} at={over.at} onPick={(file) => setOver((o) => o && { ...o, at: { ...o.at, file } })} onClose={() => setOver(undefined)} />}
    </figure>
  );
}
