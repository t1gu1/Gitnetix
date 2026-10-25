import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useAiCatalog, useConfig } from "../api/hooks";
import { onPathDrop } from "../api/transport";
import type { LogLine } from "../api/types";
import { bytes } from "../lib/format";
import { toast } from "../lib/toast";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { Markdown } from "./ui";

type Block =
  | { kind: "you"; text: string; files: string[] }
  | { kind: "ai"; text: string }
  | { kind: "steps"; lines: LogLine[] }
  | { kind: "note" | "ok" | "err" | "wait"; text: string };

// "✦ " starts a reply; older logs and plain CLIs continue it line by line.
const REPLY = /^✦ /;
const STATUS = /^\s*[■⏸▶]/;

/** Group raw log lines into chat blocks: your messages, replies, tool steps, status. */
export function blocks(lines: LogLine[]): Block[] {
  const out: Block[] = [];
  for (const l of lines) {
    const last = out.at(-1);
    switch (l.kind) {
      case "cmd": {
        // "$ claude · request" opens the session, "› text" follows up; files sent with it close it, one "- path" per line.
        const [text, list = ""] = l.text.replace(/^(\$ \S+ · |› )/, "").split(/\n*Attached files:\n(?=- )/);
        out.push({ kind: "you", text, files: list.split("\n").flatMap((f) => (f.startsWith("- ") ? [f.slice(2)] : [])) });
        break;
      }
      case "ai": {
        const text = l.text.replace(/^(✦ | {2})/, "");
        if (last?.kind === "ai") last.text += (REPLY.test(l.text) ? "\n\n" : "\n") + text;
        else out.push({ kind: "ai", text });
        break;
      }
      case "dim":
      case "run":
        if (STATUS.test(l.text)) out.push({ kind: "note", text: l.text.trim() });
        else if (last?.kind === "steps") last.lines.push(l);
        else out.push({ kind: "steps", lines: [l] });
        break;
      case "ok":
      case "err":
      case "wait":
        out.push({ kind: l.kind, text: l.text.replace(/^[✓✕◆] /, "") });
        break;
      default:
        out.push({ kind: "note", text: l.text });
    }
  }
  return out;
}

type Opt = { n: string; label: string };
/** A question the agent waits on: its letter ("A") when it has one, its text, and its numbered options. */
export type Question = { id: string; text: string; opts: Opt[] };

// The agent may reply in French ("Quelle option ?", "Réponds 1, 2 ou 3").
const PICK = /\b(which|prefer|choose|pick|quel(le)?s?|lequel|laquelle|choisi\w*|choix|préf[éè]r\w*)\b/i;

/** Numbered options ("1. **Foo:** bar") in the agent's last reply, when it now waits for you to pick: one entry per question. */
export function questions(lines: LogLine[]): Question[] {
  const b = blocks(lines);
  if (b.at(-1)?.kind !== "wait") return [];
  const reply = [...b].reverse().find((x) => x.kind === "ai" || x.kind === "you");
  if (reply?.kind !== "ai") return [];
  const rows = reply.text.split("\n");
  // A list starts at "1." and runs while the numbers follow; lines between items (sub-bullets) are skipped.
  const lists: { start: number; end: number; opts: Opt[] }[] = [];
  let fence = false;
  rows.forEach((row, i) => {
    if (/^\s*```/.test(row)) fence = !fence;
    // The number may sit inside the bold: "**1. Foo** bar".
    const m = fence ? null : /^\s*(?:\*\*)?(\d+)[.)]\s+(.+)$/.exec(row);
    if (!m) return;
    const opt = { n: m[1], label: m[2].replace(/\*\*|`/g, "") };
    const last = lists.at(-1);
    if (m[1] === "1") lists.push({ start: i, end: i + 1, opts: [opt] });
    else if (last && Number(m[1]) === last.opts.length + 1) {
      last.opts.push(opt);
      last.end = i + 1;
    }
  });
  const out: Question[] = [];
  for (const [k, l] of lists.entries()) {
    const final = k === lists.length - 1;
    // Items that are questions ("What text? …") ask you to answer each one, not to pick one.
    const ask = !l.opts.some((o) => o.label.includes("?"));
    // A plain list (steps, findings, changes) is not a question: only offer it when the text around it asks you to pick.
    // The intro may be bold or a heading: "**A. Which one?**".
    const intro = (rows.slice(0, l.start).filter((r) => r.trim()).at(-1) ?? "").replace(/\*\*|`/g, "").replace(/^\s*#+\s*/, "").trim();
    const after = final ? rows.slice(l.end).join("\n") : "";
    const asks = ask && (/\?$/.test(intro) || PICK.test(intro) || PICK.test(after) || /\b\d+\s+(or|ou)\s+\d+\b/i.test(after));
    // The questions close the reply: when the last list asks nothing, the earlier ones were not questions either.
    if (final && !asks) return [];
    if (asks) out.push({ id: /^([A-Z])[.)]\s/.exec(intro)?.[1] ?? "", text: intro, opts: l.opts });
  }
  return out;
}

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

/** `actions` show under "Your turn!" when the agent did not ask a question; `picks` are its options picked for the prompt box. */
export function AgentLog({ lines, empty, picks, onPicks, projectId, actions, thinking, provider }: { lines: LogLine[]; empty?: string; picks: Choice[]; onPicks: (c: Choice[]) => void; projectId?: string; actions?: ReactNode; thinking?: boolean; provider?: string }) {
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
  }, [lines.length, thinking]);
  return (
    <div
      ref={ref}
      className="term-log ag-log"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {lines.length === 0 && <div className="ag-empty">{empty ?? "No output yet."}</div>}
      {list.map((b, i) => {
        switch (b.kind) {
          case "you":
            return (
              <div key={i} className="ag-you">
                <div className="ag-you-row">
                  <Avatar name={me.name} email={me.email} size={22} />
                  <div className="ag-bubble">
                    {b.text && <span>{b.text}</span>}
                    {b.files.length > 0 && (
                      <span className="ag-files">
                        {b.files.map((f) => <FileChip key={f} file={f} />)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          case "ai":
            return (
              <div key={i} className="ag-ai">
                {opens.has(i) && mark}
                <Markdown text={b.text} />
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
    </div>
  );
}

/** A file to send with a message: picked, pasted or dropped in the page, or a path dropped on the desktop window. */
export type Attachment = File | string;
/** What `agents.message` and `agents.start` take as `files`. */
export type Upload = { name: string; data?: string; path?: string };

// Files travel base64 in the request, which the companion server caps at 48 MB.
const MAX_UPLOAD = 25 * 1024 * 1024;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;
const nameOf = (a: Attachment) => (typeof a === "string" ? (a.split(/[\\/]/).pop() ?? a) : a.name);

function base64(f: File) {
  return new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] ?? "");
    r.onerror = () => fail(r.error);
    r.readAsDataURL(f);
  });
}

/** A file sent, or about to be: images in hand show a thumbnail, others their icon. `onRemove` takes it off the message. */
function FileChip({ file, onRemove }: { file: Attachment; onRemove?: () => void }) {
  const name = nameOf(file);
  const [url, setUrl] = useState<string>();
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
    <span className="ag-file" title={typeof file === "string" ? file : name}>
      {url ? <img src={url} alt="" /> : <Icon name={IMAGE.test(name) ? "image" : "file"} size={15} />}
      <span className="ellipsis">{name}</span>
      {typeof file !== "string" && <span className="faint">{bytes(file.size)}</span>}
      {onRemove && (
        <button type="button" className="ag-file-x" aria-label={`Remove ${name}`} onClick={onRemove}>
          <Icon name="close" size={10} />
        </button>
      )}
    </span>
  );
}

/** The prompt box under an agent log, shared by the workspace terminal and the worktrees page.
 * Enter sends, Shift+Enter or Ctrl+Enter starts a new line. Files come from the clip, a paste, or a drop anywhere on the panel it sits in.
 * `picks` (options picked in the log) go first in the message, the text after them adds to it.
 * `onStop` (while the agent works) swaps Send for Stop; Up/Down on the first or last line walk your past messages in `log`. */
export function AgentInput({ id, label, value, onChange, files, onFiles, picks, onPicks, onSend, onStop, log = [], placeholder, disabled, pending, picker }: { id: string; label: string; value: string; onChange: (v: string) => void; files: Attachment[]; onFiles: (f: Attachment[]) => void; picks: Choice[]; onPicks: (c: Choice[]) => void; onSend: (files: Upload[], text: string) => void; onStop?: () => void; log?: LogLine[]; placeholder: string; disabled: boolean; pending: boolean; picker?: ReactNode }) {
  // Position in the history, and the unsent text it replaced.
  const [at, setAt] = useState<number | null>(null);
  const draft = useRef("");
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const chooser = useRef<HTMLInputElement>(null);
  // Files are being dragged over the panel.
  const [over, setOver] = useState(false);
  // Lines of text shown: Send stays square up to 3, where the picker stacks beside it.
  const [lines, setLines] = useState(1);
  const sent = blocks(log).flatMap((b) => (b.kind === "you" ? [b.text] : []));
  const ready = !disabled && !pending && !onStop && (!!value.trim() || files.length > 0 || picks.length > 0);
  // A pick lands in the box: type the details next, Enter sends.
  useEffect(() => {
    if (picks.length) input.current?.focus();
  }, [picks]);

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
    const panel = form.current?.parentElement;
    if (!panel || disabled) return;
    const inside = (p: { x: number; y: number }) => {
      const r = panel.getBoundingClientRect();
      return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
    };
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
  }, [disabled]);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    // Grows with the text up to half the panel, then scrolls.
    const cap = Math.min(240, (form.current?.parentElement?.clientHeight ?? 480) / 2);
    el.style.height = "auto";
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
        onSend(await Promise.all(files.map(async (f) => (typeof f === "string" ? { name: nameOf(f), path: f } : { name: f.name, data: await base64(f) }))), text);
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
        {onStop ? (
          <button type="button" className="btn btn-danger term-send" aria-label="Stop the agent" data-tip="Stop" onClick={onStop}>
            <Icon name="stop" size={16} />
          </button>
        ) : (
          <button type="submit" className="btn btn-primary term-send" aria-label="Send" data-tip="Send · Shift+Enter for a new line" disabled={!ready}>
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
