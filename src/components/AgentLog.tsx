import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useAgentFile, useAiCatalog, useConfig } from "../api/hooks";
import { copyAgentFile, downloadAgentFile, isLocal, onPathDrop } from "../api/transport";
import type { LogLine } from "../api/types";
import { blocks, questions, said, type Block, type Opt, type Question } from "../lib/agentLog";
import { bytes } from "../lib/format";
import { toast } from "../lib/toast";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { dataUrl, isImage } from "./ImageDiff";
import { Markdown, Modal } from "./ui";

/** "Read ×3 · Edit · Bash ×2" */
function summary(lines: LogLine[]) {
  const counts = new Map<string, number>();
  for (const l of lines) {
    const name = l.text.trim().split(/\s/)[0] || "output";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(" · ");
}

function Steps({ lines, open }: { lines: LogLine[]; open: boolean }) {
  return (
    <details className="ag-steps" open={open}>
      <summary>
        <span className="ag-steps-n">{lines.length === 1 ? "1 step" : `${lines.length} steps`}</span>
        <span className="ellipsis">{summary(lines)}</span>
      </summary>
      <div className="ag-steps-list">
        {lines.map((l, i) => {
          const [name, ...rest] = l.text.trim().split(" ");
          return (
            <div key={i} className={l.kind === "run" ? "ag-step ag-step-run" : "ag-step"}>
              <span className="ag-step-name">{name}</span>
              <span className="ag-step-detail" title={rest.join(" ")}>{rest.join(" ")}</span>
            </div>
          );
        })}
      </div>
    </details>
  );
}

/** Who "you" are: the project's git profile, else the first one. */
function useMe(projectId?: string) {
  const c = useConfig().data;
  const pid = c?.projects.find((p) => p.id === projectId)?.profileId;
  const prof = c?.profiles.find((x) => x.id === pid) ?? c?.profiles[0];
  return { name: prof?.name || c?.integrations.githubUser || "You", email: prof?.email };
}

// Claude's starburst: rays of alternating length around the centre.
const RAYS = Array.from({ length: 12 }, (_, i) => {
  const a = (i * Math.PI) / 6;
  const r = i % 2 ? 5.2 : 6.6;
  return `M${8 + 1.6 * Math.cos(a)} ${8 + 1.6 * Math.sin(a)}L${8 + r * Math.cos(a)} ${8 + r * Math.sin(a)}`;
}).join("");

/** The agent's mark: its maker's logo when we draw one, else the provider's short code. Unset = the routed default. */
function AgentMark({ provider }: { provider?: string }) {
  const c = useAiCatalog().data;
  const id = provider ?? c?.routing.agent?.provider ?? c?.defaultProvider;
  const mark =
    id === "claude" ? (
      <svg width={17} height={17} viewBox="0 0 16 16" stroke="#d97757" strokeWidth={1.7} strokeLinecap="round"><path d={RAYS} /></svg>
    ) : id === "gemini" ? (
      <svg width={17} height={17} viewBox="0 0 16 16" fill="#4796e3"><path d="M8 1c0 3.9 3.1 7 7 7-3.9 0-7 3.1-7 7 0-3.9-3.1-7-7-7 3.9 0 7-3.1 7-7z" /></svg>
    ) : (
      <span className="ag-mono">{c?.providers.find((p) => p.info.id === id)?.info.mono ?? "✦"}</span>
    );
  return <span className="ag-avatar" aria-hidden="true">{mark}</span>;
}

/** An option picked from the agent's suggestions, waiting in the prompt box. `q`/`qi` are its question's text and place; `key` names the question when there are several. */
export type Choice = { q: string; qi: number; key: string; n: string; label: string };

/** "2. Postgres", or "A: 2. Postgres" when the agent asked several questions. */
const choiceText = (c: Choice) => `${c.key ? `${c.key}: ` : ""}${c.n}. ${c.label}`;

/** The agent's options as toggles: one pick per question goes to the prompt box, sent with Send. */
function Choices({ qs, picks, onPicks }: { qs: Question[]; picks: Choice[]; onPicks: (c: Choice[]) => void }) {
  const on = (qi: number, n: string) => picks.some((p) => p.qi === qi && p.n === n);
  const toggle = (qi: number, o: Opt) => {
    const rest = picks.filter((p) => p.qi !== qi);
    const key = qs.length > 1 ? qs[qi].id || `Q${qi + 1}` : "";
    onPicks(on(qi, o.n) ? rest : [...rest, { q: qs[qi].text, qi, key, n: o.n, label: o.label }].sort((a, b) => a.qi - b.qi));
  };
  return (
    <>
      {qs.map((q, i) => (
        <div key={i} className="ag-q">
          {qs.length > 1 && <span className="ag-q-text">{q.text}</span>}
          <div className="ag-choices">
            {q.opts.map((o) => (
              <button key={o.n} type="button" className="btn btn-sm" title={o.label} aria-pressed={on(i, o.n)} onClick={() => toggle(i, o)}>
                <span className="c-acc">{o.n}</span>
                <span className="ellipsis">{o.label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/** Files in the log, one chip each; images preview from agent `session`, and open full size in a gallery of this group's images. */
function Files({ files, session }: { files: string[]; session?: string }) {
  const [open, setOpen] = useState<number>();
  const shots = files.filter(isImage);
  return files.length > 0 && (
    <span className="ag-files">
      {/* A key on the chip still focused behind the gallery must not jump it back. */}
      {files.map((f) => <FileChip key={f} file={f} session={session} onOpen={() => setOpen((o) => o ?? shots.indexOf(f))} />)}
      {open !== undefined && session && <Gallery session={session} paths={shots} at={open} onClose={() => setOpen(undefined)} />}
    </span>
  );
}

/** What you sent: its text, then the files that went with it. */
function Said({ b, session }: { b: { text: string; files: string[] }; session?: string }) {
  return (
    <>
      {b.text && <span>{b.text}</span>}
      <Files files={b.files} session={session} />
    </>
  );
}

/** Images a reply shows, as its prompt asks: the local paths of its Markdown images, `![What it shows](/path.png)`. */
const shown = (text: string) => [...new Set([...text.matchAll(/!\[[^\]]*\]\(<?([^<>)]+?)>?\)/g)].map((m) => m[1].trim()))].filter((p) => isImage(p) && !/^\w+:\/\//.test(p));

/** `actions` show under "Your turn!" when the agent did not ask a question; `picks` are its options picked for the prompt box; `session` is the agent's id, for the files you sent it; `queued` are your messages waiting for its run to end. */
export function AgentLog({ lines, empty, picks, onPicks, projectId, actions, thinking, provider, session, queued = [] }: { lines: LogLine[]; empty?: string; picks: Choice[]; onPicks: (c: Choice[]) => void; projectId?: string; actions?: ReactNode; thinking?: boolean; provider?: string; session?: string; queued?: string[] }) {
  const me = useMe(projectId);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const list = blocks(lines);
  const qs = questions(lines);
  // Picks for questions no longer asked (answered, another session) leave the prompt box.
  const live = picks.filter((p) => qs[p.qi]?.text === p.q && qs[p.qi].opts.some((o) => o.n === p.n));
  useEffect(() => {
    if (live.length !== picks.length) onPicks(live);
  });
  // One mark per answer: on the first reply or steps after each message of yours.
  const opens = new Set<number>();
  let fresh = true;
  list.forEach((b, i) => {
    if (b.kind === "you") fresh = true;
    else if (fresh && (b.kind === "ai" || b.kind === "steps")) {
      opens.add(i);
      fresh = false;
    }
  });
  const mark = <AgentMark provider={provider} />;
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, thinking, queued.length]);
  // Your first message is the task: once it scrolls out of the log, it pins to the top; `peek` unfolds it there.
  const task = list.find((b): b is Extract<Block, { kind: "you" }> => b.kind === "you");
  const ti = task ? list.indexOf(task) : -1;
  const first = useRef<HTMLDivElement>(null);
  const [gone, setGone] = useState(false);
  const [peek, setPeek] = useState(false);
  useEffect(() => {
    setPeek(false);
    const el = first.current;
    if (!el) return setGone(false);
    const io = new IntersectionObserver(([e]) => {
      setGone(!e.isIntersecting);
      if (e.isIntersecting) setPeek(false);
    }, { root: ref.current });
    io.observe(el);
    return () => io.disconnect();
  }, [ti, task?.text]);
  return (
    <div
      ref={ref}
      className="term-log ag-log"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {task && gone && (
        <div className="ag-task">
          <div className="ag-task-card">
            <button type="button" className="ag-task-bar" aria-expanded={peek} data-tip={peek ? "Fold" : "Read the whole task"} onClick={() => setPeek(!peek)}>
              <Avatar name={me.name} email={me.email} size={18} />
              <span className="ag-task-label">Task</span>
              <span className="ellipsis grow">{!peek && (task.text || task.files.join(", "))}</span>
              <Icon name={peek ? "chevronUp" : "chevronDown"} size={12} />
            </button>
            {peek && (
              <div className="ag-task-full">
                <Said b={task} session={session} />
              </div>
            )}
          </div>
        </div>
      )}
      {lines.length === 0 && <div className="ag-empty">{empty ?? "No output yet."}</div>}
      {list.map((b, i) => {
        switch (b.kind) {
          case "you":
            return (
              <div key={i} ref={b === task ? first : undefined} className="ag-you">
                <div className="ag-you-row">
                  <Avatar name={me.name} email={me.email} size={22} />
                  <div className="ag-bubble">
                    <Said b={b} session={session} />
                  </div>
                </div>
              </div>
            );
          case "ai":
            return (
              <div key={i} className="ag-ai">
                {opens.has(i) && mark}
                <Markdown text={b.text} />
                <Files files={shown(b.text)} session={session} />
              </div>
            );
          case "steps":
            // The newest steps stay open while the agent works on them.
            return (
              <div key={i} className="ag-act">
                {opens.has(i) && mark}
                <Steps lines={b.lines} open={i === list.length - 1} />
              </div>
            );
          case "wait":
            // Only the latest wait matters; older ones are history.
            return i !== list.length - 1 ? null : (
              <div key={i} className="ag-wait">
                <span className="ag-wait-chip">Your turn!</span>
                {qs.length > 0 && (
                  <div className="ag-sugg" role="group" aria-labelledby="ag-sugg-label">
                    <span id="ag-sugg-label" className="ag-sugg-label">Suggestions</span>
                    <Choices qs={qs} picks={picks} onPicks={onPicks} />
                  </div>
                )}
                {qs.length === 0 && actions && <div className="ag-choices">{actions}</div>}
              </div>
            );
          case "err":
            return <div key={i} className="ag-err">✕ {b.text}</div>;
          case "ok":
            return <div key={i} className="ag-note ag-ok">✓ {b.text}</div>;
          default:
            return <div key={i} className="ag-note">{b.text}</div>;
        }
      })}
      {thinking && (
        <div className="ag-act" role="status" aria-label="Agent is thinking">
          {fresh && mark}
          <span className="ag-dots" aria-hidden="true"><i /><i /><i /></span>
        </div>
      )}
      {queued.map((t, i) => (
        <div key={i} className="ag-you ag-queued">
          <div className="ag-you-row">
            <Avatar name={me.name} email={me.email} size={22} />
            <div className="ag-bubble">
              <Said b={said(t)} session={session} />
            </div>
          </div>
          {i === queued.length - 1 && <span className="ag-queued-hint">Queued · sends when the agent finishes</span>}
        </div>
      ))}
    </div>
  );
}

/** A file to send with a message: picked, pasted or dropped in the page, or a path dropped on the desktop window. */
export type Attachment = File | string;
/** What `agents.message` and `agents.start` take as `files`. */
export type Upload = { name: string; data?: string; path?: string };

// Files travel base64 in the request, which the companion server caps at 48 MB.
const MAX_UPLOAD = 25 * 1024 * 1024;
const nameOf = (a: Attachment) => (typeof a === "string" ? (a.split(/[\\/]/).pop() ?? a) : a.name);

export function base64(f: Blob) {
  return new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] ?? "");
    r.onerror = () => fail(r.error);
    r.readAsDataURL(f);
  });
}

/** `files` as `agents.message`, `agents.start` and `items.create` take them. */
export const uploads = (files: Attachment[]) =>
  Promise.all(files.map(async (f): Promise<Upload> => (typeof f === "string" ? { name: nameOf(f), path: f } : { name: f.name, data: await base64(f) })));

/** A sent image, large, over the chip `at` (under it in the top half); placed once, so it hides on scroll. */
function Preview({ at, children }: { at: HTMLElement; children: ReactNode }) {
  const r = at.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left, window.innerWidth - 384));
  return createPortal(
    <div className="ag-preview" role="tooltip" style={r.top > window.innerHeight / 2 ? { left, bottom: window.innerHeight - r.top + 6 } : { left, top: r.bottom + 6 }}>
      {children}
    </div>,
    document.body,
  );
}

/** Image `path` agent `session` was sent or shows, loaded when it first appears. */
function Shot({ session, path }: { session: string; path: string }) {
  const shot = useAgentFile(session, path);
  return shot.data ? <img src={dataUrl(path, shot.data)} alt={nameOf(path)} /> : shot.isError ? <span className="faint">Could not load {nameOf(path)}</span> : <span className="spinner" />;
}

/** The images `paths` agent `session` was sent or shows, full size from the `at`th: the arrows and ←/→ step through them, round. On the desktop, Copy puts the file itself on the clipboard (a GIF pasted still moves) and Download saves it in Downloads. */
function Gallery({ session, paths, at, onClose }: { session: string; paths: string[]; at: number; onClose: () => void }) {
  const [i, setI] = useState(at);
  const n = paths.length;
  const path = paths[i];
  const name = nameOf(path);
  const step = (d: number) => setI((j) => (j + d + n) % n);
  // The next and previous load meanwhile, so stepping shows them at once.
  useAgentFile(session, paths[(i + 1) % n]);
  useAgentFile(session, paths[(i - 1 + n) % n]);
  useEffect(() => {
    if (n < 2) return;
    const k = (e: globalThis.KeyboardEvent) => {
      if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [n]);
  const copy = () => copyAgentFile(session, path).then(() => toast("Copied", "ok"), (e) => toast(`Could not copy ${name}: ${e}`, "error"));
  const download = () => downloadAgentFile(session, path).then((to) => toast(`Saved to ${to}`, "ok"), (e) => toast(`Could not save ${name}: ${e}`, "error"));
  return (
    <Modal
      title={name}
      sub={n > 1 && `${i + 1} / ${n}`}
      onClose={onClose}
      actions={isLocal && (
        <>
          <button type="button" className="btn btn-ghost btn-icon" aria-label={`Copy ${name}`} data-tip="Copy the file" onClick={copy}>
            <Icon name="copy" />
          </button>
          <button type="button" className="btn btn-ghost btn-icon" aria-label={`Download ${name}`} data-tip="Save to Downloads" onClick={download}>
            <Icon name="download" />
          </button>
        </>
      )}
    >
      <div className="ag-shot">
        <Shot session={session} path={path} />
        {n > 1 && (
          <>
            <button type="button" className="ag-shot-nav ag-shot-prev" aria-label="Previous image" onClick={() => step(-1)}>
              <Icon name="chevronLeft" />
            </button>
            <button type="button" className="ag-shot-nav ag-shot-next" aria-label="Next image" onClick={() => step(1)}>
              <Icon name="chevronRight" />
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

/** A file sent, or about to be: images in hand show a thumbnail, others their icon; images sent to agent `session` preview on hover or focus, and `onOpen` on click. `onRemove` takes it off the message. */
export function FileChip({ file, session, onOpen, onRemove }: { file: Attachment; session?: string; onOpen?: () => void; onRemove?: () => void }) {
  const name = nameOf(file);
  const [url, setUrl] = useState<string>();
  const sent = typeof file === "string" && !!session && isImage(file) ? file : undefined;
  // The chip of a sent image while it is hovered or focused.
  const [at, setAt] = useState<HTMLElement | null>(null);
  const open = () => {
    setAt(null);
    onOpen?.();
  };
  useEffect(() => {
    if (!at) return;
    const off = () => setAt(null);
    window.addEventListener("scroll", off, true);
    return () => window.removeEventListener("scroll", off, true);
  }, [at]);
  useEffect(() => {
    if (typeof file === "string" || !file.type.startsWith("image/")) {
      setUrl(undefined);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return (
    <span
      className="ag-file"
      // The preview stands where tooltips would.
      title={sent ? undefined : typeof file === "string" ? file : name}
      tabIndex={sent ? 0 : undefined}
      role={sent ? "button" : undefined}
      onClick={() => sent && open()}
      onPointerEnter={(e) => sent && setAt(e.currentTarget)}
      onPointerLeave={() => setAt(null)}
      onFocus={(e) => sent && setAt(e.currentTarget)}
      onBlur={() => setAt(null)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setAt(null);
        else if (sent && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          open();
        }
      }}
    >
      {url ? <img src={url} alt="" /> : <Icon name={isImage(name) ? "image" : "file"} size={15} />}
      <span className="ellipsis" data-tip-off={sent ? "" : undefined}>{name}</span>
      {typeof file !== "string" && <span className="faint">{bytes(file.size)}</span>}
      {onRemove && (
        <button type="button" className="ag-file-x" aria-label={`Remove ${name}`} onClick={onRemove}>
          <Icon name="close" size={10} />
        </button>
      )}
      {at && sent && session && (
        <Preview at={at}>
          <Shot session={session} path={sent} />
        </Preview>
      )}
    </span>
  );
}

/** Adds to `files` within the upload cap, from `add` or a drop on `target()`; `over` while files hover it. */
export function useAttach(target: () => HTMLElement | null | undefined, files: Attachment[], onFiles: (f: Attachment[]) => void, disabled: boolean) {
  // Files are being dragged over the panel.
  const [over, setOver] = useState(false);
  const add = (more: Attachment[]) => {
    if (!more.length) return;
    const all = [...files, ...more];
    if (all.reduce((n, a) => n + (typeof a === "string" ? 0 : a.size), 0) > MAX_UPLOAD) return toast(`Files sent together are limited to ${bytes(MAX_UPLOAD)}`, "error");
    onFiles(all);
  };
  // The drop listeners outlive renders: they call the latest `add`.
  const addRef = useRef(add);
  addRef.current = add;

  useEffect(() => {
    const panel = target();
    if (!panel || disabled) return;
    // What is on top there: a modal over the panel takes its drops.
    const inside = (p: { x: number; y: number }) => panel.contains(document.elementFromPoint(p.x, p.y));
    // In a browser: files dragged in from the desktop. The desktop window hands its drops to `onPathDrop` instead.
    const ac = new AbortController();
    const opts = { signal: ac.signal };
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    let depth = 0;
    panel.addEventListener("dragenter", (e) => hasFiles(e) && depth++ === 0 && setOver(true), opts);
    panel.addEventListener("dragleave", (e) => hasFiles(e) && --depth === 0 && setOver(false), opts);
    panel.addEventListener("dragover", (e) => hasFiles(e) && e.preventDefault(), opts);
    panel.addEventListener(
      "drop",
      (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth = 0;
        setOver(false);
        addRef.current([...(e.dataTransfer?.files ?? [])]);
      },
      opts,
    );
    const un = onPathDrop(
      (paths, p) => inside(p) && addRef.current(paths),
      (on, p) => setOver(on && !!p && inside(p)),
    );
    return () => {
      ac.abort();
      un();
    };
  }, [disabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return { over, add };
}

/** What a new agent session should do, in a modal: files are picked, pasted, or dropped anywhere on it. ⌘↵ runs `onSubmit`. */
export function RequestField({ value, onChange, files, onFiles, onSubmit }: { value: string; onChange: (v: string) => void; files: Attachment[]; onFiles: (f: Attachment[]) => void; onSubmit: () => void }) {
  const field = useRef<HTMLDivElement>(null);
  const chooser = useRef<HTMLInputElement>(null);
  const { over, add } = useAttach(() => field.current?.closest<HTMLElement>(".modal"), files, onFiles, false);
  return (
    <div ref={field} className="field">
      <label htmlFor="ag-req">What should the agent do?</label>
      <textarea
        id="ag-req"
        className="textarea"
        rows={5}
        placeholder="Let users sign in with Google and GitHub."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit(); }}
        onPaste={(e) => {
          // Screenshots and copied images attach instead of pasting nothing.
          const pasted = [...e.clipboardData.files];
          if (!pasted.length) return;
          e.preventDefault();
          add(pasted);
        }}
        autoFocus
      />
      {files.length > 0 && (
        <div className="ag-files">
          {files.map((f, i) => (
            <FileChip key={i} file={f} onRemove={() => onFiles(files.filter((_, j) => j !== i))} />
          ))}
        </div>
      )}
      <div className="row" style={{ justifyContent: "space-between" }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => chooser.current?.click()}>
          <Icon name="attach" size={12} />
          Attach files
        </button>
        <span className="hint">⌘↵ to start · drop files to attach</span>
      </div>
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
      {/* Covers the whole modal: `.modal:has(.ag-drop)` is its positioned parent. */}
      {over && (
        <div className="ag-drop" aria-hidden="true">
          <Icon name="attach" size={18} />
          Drop to attach
        </div>
      )}
    </div>
  );
}

/** The prompt box under an agent log, shared by the workspace terminal and the worktrees page.
 * Enter sends, Shift+Enter or Ctrl+Enter starts a new line. Files come from the clip, a paste, or a drop anywhere on the panel it sits in.
 * `picks` (options picked in the log) go first in the message, the text after them adds to it.
 * `onStop` (while the agent works) swaps Send for Stop until something is typed, which then queues for the run's end; Up/Down on the first or last line walk your past messages in `log`. */
export function AgentInput({ id, label, value, onChange, files, onFiles, picks, onPicks, onSend, onStop, log = [], placeholder, disabled, pending, picker }: { id: string; label: string; value: string; onChange: (v: string) => void; files: Attachment[]; onFiles: (f: Attachment[]) => void; picks: Choice[]; onPicks: (c: Choice[]) => void; onSend: (files: Upload[], text: string) => void; onStop?: () => void; log?: LogLine[]; placeholder: string; disabled: boolean; pending: boolean; picker?: ReactNode }) {
  // Position in the history, and the unsent text it replaced.
  const [at, setAt] = useState<number | null>(null);
  const draft = useRef("");
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const chooser = useRef<HTMLInputElement>(null);
  const { over, add } = useAttach(() => form.current?.parentElement, files, onFiles, disabled);
  // Lines of text shown: Send stays square up to 3, where the picker stacks beside it.
  const [lines, setLines] = useState(1);
  const sent = blocks(log).flatMap((b) => (b.kind === "you" ? [b.text] : []));
  const typed = !!value.trim() || files.length > 0 || picks.length > 0;
  const ready = !disabled && !pending && typed;
  // A pick lands in the box: type the details next, Enter sends.
  useEffect(() => {
    if (picks.length) input.current?.focus();
  }, [picks]);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    // Grows with the text up to half the panel, then scrolls.
    const cap = Math.min(240, (form.current?.parentElement?.clientHeight ?? 480) / 2);
    el.style.height = "auto";
    // Mounted in a hidden pane (mobile detail, inactive tab) it measures 0: keep the one-line height.
    if (!el.scrollHeight) return;
    const h = Math.min(el.scrollHeight, cap);
    el.style.height = `${h}px`;
    el.style.overflowY = el.scrollHeight > cap ? "auto" : "hidden";
    // The textarea's 11px padding and 18px lines (app.css).
    setLines(Math.max(1, Math.round((h - 22) / 18)));
  }, [value]);

  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    // Shift+Enter is the textarea's own new line.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        el.setRangeText("\n", el.selectionStart, el.selectionEnd, "end");
        onChange(el.value);
      } else el.form?.requestSubmit();
      return;
    }
    if (e.shiftKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown") || !sent.length) return;
    // Within a multi-line message the arrows move between its lines.
    if (e.key === "ArrowUp" ? el.value.slice(0, el.selectionStart).includes("\n") : el.value.slice(el.selectionEnd).includes("\n")) return;
    e.preventDefault();
    if (e.key === "ArrowUp") {
      if (at === null) draft.current = value;
      const i = Math.max(0, (at ?? sent.length) - 1);
      setAt(i);
      onChange(sent[i]);
    } else if (at !== null) {
      const i = at + 1;
      setAt(i < sent.length ? i : null);
      onChange(i < sent.length ? sent[i] : draft.current);
    }
  };
  return (
    <form
      ref={form}
      className="term-input"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ready) return;
        setAt(null);
        const text = [picks.map(choiceText).join("\n"), value.trim()].filter(Boolean).join("\n\n");
        onSend(await uploads(files), text);
      }}
    >
      {picks.length + files.length > 0 && (
        <div className="ag-attach">
          {picks.map((p) => (
            <span key={p.qi} className="ag-file ag-pick" title={p.q}>
              <span className="c-acc">{p.key ? `${p.key} · ${p.n}` : p.n}</span>
              <span className="ellipsis">{p.label}</span>
              <button type="button" className="ag-file-x" aria-label={`Remove answer ${p.n}`} onClick={() => onPicks(picks.filter((x) => x !== p))}>
                <Icon name="close" size={10} />
              </button>
            </span>
          ))}
          {files.map((f, i) => (
            <FileChip key={i} file={f} onRemove={() => onFiles(files.filter((_, j) => j !== i))} />
          ))}
        </div>
      )}
      <div className={lines >= 3 ? "term-input-row term-input-tall" : "term-input-row"} style={{ "--lines": Math.min(lines, 3) } as CSSProperties}>
        <button type="button" className="btn btn-ghost term-attach" aria-label="Attach files" data-tip="Attach files or images" disabled={disabled} onClick={() => chooser.current?.click()}>
          <Icon name="attach" size={15} />
        </button>
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
        <label htmlFor={id} className="sr-only">{label}</label>
        <textarea
          id={id}
          ref={input}
          rows={1}
          value={value}
          disabled={disabled}
          onKeyDown={keys}
          onPaste={(e) => {
            // Screenshots and copied images attach instead of pasting nothing.
            const pasted = [...e.clipboardData.files];
            if (!pasted.length) return;
            e.preventDefault();
            add(pasted);
          }}
          onChange={(e) => {
            setAt(null);
            onChange(e.target.value);
          }}
          placeholder={placeholder}
        />
        {picker}
        {onStop && !typed ? (
          <button type="button" className="btn btn-danger term-send" aria-label="Stop the agent" data-tip="Stop" onClick={onStop}>
            <Icon name="stop" size={16} />
          </button>
        ) : (
          <button type="submit" className="btn btn-primary term-send" aria-label={onStop ? "Queue the message" : "Send"} data-tip={onStop ? "Queue · sends when the agent finishes" : "Send · Shift+Enter for a new line"} disabled={!ready}>
            {pending ? <span className="spinner" /> : <Icon name="send" size={20} />}
          </button>
        )}
      </div>
      {over && (
        <div className="ag-drop" aria-hidden="true">
          <Icon name="attach" size={18} />
          Drop to attach
        </div>
      )}
    </form>
  );
}
