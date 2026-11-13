import { type ClipboardEvent, type CSSProperties, type KeyboardEvent, type ReactNode, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useAction, useAgentBlobs, useAgentDiff, useAgentFile, useAiCatalog, useConfig } from "../api/hooks";
import { clipboardFiles, copyAgentFile, downloadAgentFile, isLocal, localHead, localImage, onPathDrop } from "../api/transport";
import type { AgentAsk, AgentLimit, LogLine } from "../api/types";
import { blocks, errText, folds, questions, said, stepsLabel, took, type Block, type Fold, type Opt, type Question } from "../lib/agentLog";
import { OwnMic } from "../lib/dictation";
import { bytes, clock, plural } from "../lib/format";
import { copyToClipboard, toast } from "../lib/toast";
import { AudioPlayer, isAudio } from "./AudioPlayer";
import { Avatar } from "./Avatar";
import { DiffView } from "./DiffView";
import { Icon } from "./Icon";
import { IMAGE_MODES, ImageDiff, comparable, dataUrl, isImage, useImageMode } from "./ImageDiff";
import { Markdown, Modal, Seg } from "./ui";

// A new line regroups the whole log: every block gets fresh arrays of the same line objects, so compare items.
const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);

const Steps = memo(function Steps({ lines, open }: { lines: LogLine[]; open: boolean }) {
  return (
    <details className="ag-steps" open={open}>
      <summary>
        <span className="ag-steps-n">{lines.length === 1 ? "1 step" : `${lines.length} steps`}</span>
        <span className="ellipsis">{stepsLabel(lines)}</span>
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
}, (a, b) => a.open === b.open && same(a.lines, b.lines));

/** Who "you" are: the profile's Git identity. */
function useMe() {
  const c = useConfig().data;
  const prof = c?.profiles[0];
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
      <svg width={17} height={17} viewBox="0 0 16 16" stroke="#d97757" style={{ strokeWidth: 1.7 }} strokeLinecap="round"><path d={RAYS} /></svg>
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

/** The agent's options as toggles: each pick, several per question if you like, goes to the prompt box, sent with Send. */
function Choices({ qs, picks, onPicks }: { qs: Question[]; picks: Choice[]; onPicks: (c: Choice[]) => void }) {
  const on = (qi: number, n: string) => picks.some((p) => p.qi === qi && p.n === n);
  const toggle = (qi: number, o: Opt) => {
    const key = qs.length > 1 ? qs[qi].id || `Q${qi + 1}` : "";
    onPicks(
      on(qi, o.n)
        ? picks.filter((p) => p.qi !== qi || p.n !== o.n)
        : [...picks, { q: qs[qi].text, qi, key, n: o.n, label: o.label }].sort((a, b) => a.qi - b.qi || Number(a.n) - Number(b.n)),
    );
  };
  return (
    <>
      {qs.map((q, i) => (
        <div key={i} className="ag-q">
          {q.text && <span className="ag-q-text">{q.text}</span>}
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

/** Files in the log, one chip each; images preview from agent `session`, and open full size in a gallery of this group's images. Audio files play in a player instead. */
const Files = memo(function Files({ files, session }: { files: string[]; session?: string }) {
  const [open, setOpen] = useState<number>();
  const shots = files.filter(isImage);
  return files.length > 0 && (
    <span className="ag-files">
      {/* A key on the chip still focused behind the gallery must not jump it back. */}
      {files.map((f) => (session && isAudio(f) ? <AudioPlayer key={f} session={session} path={f} /> : <FileChip key={f} file={f} session={session} onOpen={() => setOpen((o) => o ?? shots.indexOf(f))} />))}
      {open !== undefined && session && <Gallery session={session} paths={shots} at={open} onClose={() => setOpen(undefined)} />}
    </span>
  );
}, (a, b) => a.session === b.session && same(a.files, b.files));

/** A long message of yours stops at about 11 lines, fading out, with a button for the rest. */
function Clamp({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [long, setLong] = useState(false);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || full) return;
    // Measured once laid out: a log drawn in a hidden pane has no size yet.
    const ro = new ResizeObserver(() => setLong(el.scrollHeight > el.clientHeight + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, full]);
  return (
    <>
      <span ref={ref} className={full ? "ag-said" : long ? "ag-said ag-clamp ag-faded" : "ag-said ag-clamp"}>{text}</span>
      {long && (
        <button type="button" className="ag-link ag-more" aria-expanded={full} onClick={() => setFull(!full)}>
          {full ? "Show less" : "Show full message"}
        </button>
      )}
    </>
  );
}

/** What you sent: its text, then the files that went with it. `clamp` cuts a long text (not where it scrolls already). */
function Said({ b, session, clamp = true }: { b: { text: string; files: string[] }; session?: string; clamp?: boolean }) {
  return (
    <>
      {b.text && (clamp ? <Clamp text={b.text} /> : <span>{b.text}</span>)}
      <Files files={b.files} session={session} />
    </>
  );
}

/** When a message came: "14:32" today, else "Nov 2, 14:32"; the full date in its tooltip. */
function When({ at }: { at?: number }) {
  return at ? <span className="ag-when" data-tip={new Date(at).toLocaleString()}>{clock(at)}</span> : null;
}

/** Under a message, shown on hover: when it came, and a button copying `text`. */
function Meta({ at, text }: { at?: number; text: string }) {
  return (
    <div className="ag-meta">
      <When at={at} />
      <button type="button" className="btn btn-ghost ag-meta-copy" aria-label="Copy the message" data-tip="Copy" onClick={() => copyToClipboard(text)}>
        <Icon name="copy" size={12} />
      </button>
    </div>
  );
}

/** A finished turn's work as one row; opened, its blocks (`children`) are drawn under it. */
function FoldRow({ f, mark, children }: { f: Fold; mark?: ReactNode; children: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  const what = f.ms === undefined ? (f.stopped ? "Stopped" : "Worked") : f.stopped ? `Stopped after ${took(f.ms)}` : `Worked for ${took(f.ms)}`;
  return (
    <>
      <div className="ag-act">
        {mark}
        <button type="button" className="ag-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
          <span>{what}</span>
          {f.steps > 0 && <span className="faint">· {plural(f.steps, "step")}</span>}
        </button>
      </div>
      {open && <div className="ag-fold-body">{children()}</div>}
    </>
  );
}

/** "+12 −3", in columns that line up down a list; a count of 0 leaves its column empty. */
function Stat({ add, del }: { add: number; del: number }) {
  return (
    <span className="ag-stat">
      <span className="c-add">{add > 0 && `+${add}`}</span>
      <span className="c-del">{del > 0 && `−${del}`}</span>
    </span>
  );
}

// Listed until "Show all".
const FEW_FILES = 6;

/** What a turn changed: its files and their added and removed lines. A click shows a file's diff for that turn. */
function Changes({ b, session }: { b: Extract<Block, { kind: "files" }>; session?: string }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<number>();
  const add = b.files.reduce((n, f) => n + (f[1] ?? 0), 0);
  const del = b.files.reduce((n, f) => n + (f[2] ?? 0), 0);
  return (
    <div className="ag-changes">
      <div className="ag-changes-head">
        <span>{plural(b.files.length + b.more, "file")} changed</span>
        <Stat add={add} del={del} />
      </div>
      {(all ? b.files : b.files.slice(0, FEW_FILES)).map(([path, a, d], i) => {
        const cut = path.lastIndexOf("/") + 1;
        return (
          <button key={path} type="button" className="ag-change" disabled={!session} title={path} onClick={() => setOpen(i)}>
            <span className="ellipsis">
              <span className="faint">{path.slice(0, cut)}</span>
              {path.slice(cut)}
            </span>
            {a === null ? <span className="faint">{isImage(path) ? "image" : "binary"}</span> : <Stat add={a} del={d ?? 0} />}
          </button>
        );
      })}
      {b.files.length > FEW_FILES && (
        <button type="button" className="ag-link ag-changes-all" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${b.files.length}`}
        </button>
      )}
      {all && b.more > 0 && <span className="faint ag-changes-all">{plural(b.more, "more file")} not listed</span>}
      {open !== undefined && session && <TurnDiff session={session} b={b} at={open} onStep={setOpen} onClose={() => setOpen(undefined)} />}
    </div>
  );
}

/** File `at` of turn `b`'s changes, as that turn changed it; a binary image shows as its preview. The arrows and ←/→ `onStep` through its files, round. */
function TurnDiff({ session, b, at, onStep, onClose }: { session: string; b: Extract<Block, { kind: "files" }>; at: number; onStep: (i: number) => void; onClose: () => void }) {
  const [path, added] = b.files[at];
  const n = b.files.length;
  // An SVG is text: its diff says more than its picture.
  const image = added === null && isImage(path);
  const diff = useAgentDiff(session, b.from, b.to, path, !image);
  const blobs = useAgentBlobs(session, b.from, b.to, path, image);
  const [imageMode, setImageMode] = useImageMode();
  const [anyway, setAnyway] = useState(false);
  const step = (d: number) => onStep((at + d + n) % n);
  useArrows(n, step);
  const modes = image && comparable(blobs.data) && <Seg value={imageMode} onChange={setImageMode} label="Image comparison" options={IMAGE_MODES} />;
  return (
    <Modal
      title={path}
      sub={[n > 1 && `${at + 1} / ${n}`, "As this turn changed it"].filter(Boolean).join(" · ")}
      width={1000}
      onClose={onClose}
      actions={(modes || n > 1) && (
        <>
          {modes}
          {n > 1 && (
            <>
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Previous file" data-tip="Previous file · ←" onClick={() => step(-1)}>
            <Icon name="chevronLeft" />
          </button>
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Next file" data-tip="Next file · →" onClick={() => step(1)}>
            <Icon name="chevronRight" />
          </button>
            </>
          )}
        </>
      )}
    >
      {image ? (
        blobs.data ? (
          <ImageDiff key={path} path={path} blobs={blobs.data} mode={imageMode} />
        ) : (
          <div className="ag-diff">{blobs.isError ? <span className="faint">Could not load the image: {blobs.error.message}</span> : <span className="spinner" />}</div>
        )
      ) : (
      /* The diff fills a sized box: as tall as its rows (21px each, app.css), up to most of the screen. */
      <div className="diff ag-diff" style={{ height: `min(70vh, ${Math.max(120, (diff.data ?? []).reduce((n, h) => n + h.lines.length + 1, 0) * 21 + 20)}px)` }}>
        {diff.isError ? (
          <span className="faint">Could not load the diff: {diff.error.message}</span>
        ) : !diff.data ? (
          <span className="spinner" />
        ) : diff.data.length ? (
          <DiffView key={path} path={path} hunks={diff.data} mode="unified" anyway={anyway} onAnyway={() => setAnyway(true)} />
        ) : (
          <span className="faint">No text changes to show</span>
        )}
      </div>
      )}
    </Modal>
  );
}

/** The time now, again every `every` ms; never again for 0. */
function useNow(every: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!every) return;
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

/** "2d 4h", "2h 14m", "14:05": the time left of `ms`. */
function countdown(ms: number) {
  const s = Math.ceil(ms / 1000);
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A battery with nothing left: what an agent out of credits waits on. */
const NoCredits = (
  <svg width={22} height={22} viewBox="0 0 16 16" fill="none" stroke="currentColor" style={{ strokeWidth: 1.4 }} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 5h10.5a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-.5.5H2a.5.5 0 0 1-.5-.5v-5A.5.5 0 0 1 2 5zM15 7v2" />
    <path d="M4 7.2v1.6" opacity={0.45} />
  </svg>
);

/** A ring filled to `done` (0 to 1), `children` in its middle. */
function Ring({ done, children }: { done: number; children: ReactNode }) {
  const c = 2 * Math.PI * 26;
  return (
    <span className="ag-ring">
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle className="ag-ring-track" cx={32} cy={32} r={26} />
        {done > 0 && <circle className="ag-ring-fill" cx={32} cy={32} r={26} strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(1, done))} />}
      </svg>
      <span className="ag-ring-mid">{children}</span>
    </span>
  );
}

/** The usage limit agent `session`'s last run stopped at, under its log. Waiting for a reset, its ring fills toward the
 * time the agent continues by itself and counts down to it. Without one (out of credits) it waits for you. Continue now
 * goes on at once: credits added, or another agent picked in the prompt box. `onCancel` stops it. */
function LimitCard({ session, limit, onCancel }: { session: string; limit: AgentLimit; onCancel?: () => void }) {
  const go = useAction("agents.continue", { invalidate: [["agents"], ["worktrees"]] });
  const at = limit.continueAt ?? undefined;
  // Counted in minutes an hour or more ahead: no need to redraw each second.
  const now = useNow(!at ? 0 : at - Date.now() > 3_600_000 ? 30_000 : 1000);
  const left = at ? Math.max(0, at - now) : 0;
  const title = at ? "Usage limit reached" : limit.credits ? "Out of credits" : "Usage limit reached";
  return (
    <div className={at ? "ag-limit" : "ag-limit ag-limit-out"} role="group" aria-label={title}>
      <Ring done={at ? 1 - left / Math.max(1, at - limit.since) : 0}>
        {at ? (left ? countdown(left) : "0:00") : NoCredits}
      </Ring>
      <div className="ag-limit-body">
        <span className="ag-limit-title">{title}</span>
        <span className="ag-limit-msg">{errText(limit.message)}</span>
        <span className="ag-limit-when">
          {!at
            ? limit.credits
              ? "Add credits to your account, or pick another agent below, then continue."
              : "Its CLI did not say when the limit resets. Continue once it has, or pick another agent below."
            : left
              ? <>Continues by itself at <strong>{clock(at)}</strong></>
              : "Continuing…"}
        </span>
        <div className="ag-limit-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={go.isPending} onClick={() => go.mutate({ id: session })}>
            {go.isPending ? <span className="spinner" /> : <Icon name="play" size={12} />}
            {at ? "Continue now" : "Continue"}
          </button>
          {onCancel && (
            <button type="button" className="btn btn-sm" disabled={go.isPending} data-tip={at ? "Don't continue when the limit resets" : "Stop the agent"} onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
        {at && <span className="ag-limit-hint">Added credits, or picked another agent below? Continue now.</span>}
      </div>
    </div>
  );
}

/** An action agent `session`'s run waits on you for. Allow runs it; Refuse has the agent look for another way, or say what is blocked. */
function AskCard({ session, ask }: { session: string; ask: AgentAsk }) {
  const answer = useAction("agents.answer", { invalidate: [["agents"]] });
  const go = (allow: boolean) => answer.mutate({ id: session, ask: ask.id, allow });
  return (
    <div className="ag-limit" role="group" aria-label={`Allow ${ask.tool}?`}>
      <Icon name="lock" size={18} />
      <div className="ag-limit-body grow">
        <span className="ag-limit-title">Allow {ask.tool}?</span>
        {ask.description && <span className="ag-limit-when">{ask.description}</span>}
        {ask.detail && <code className="ag-ask-detail">{ask.detail}</code>}
        <div className="ag-limit-actions ag-ask-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={answer.isPending} onClick={() => go(true)}>
            <Icon name="check" size={12} />
            Allow
          </button>
          <button type="button" className="btn btn-danger btn-sm" disabled={answer.isPending} onClick={() => go(false)}>
            <Icon name="close" size={12} />
            Refuse
          </button>
        </div>
      </div>
    </div>
  );
}

/** Images and audio a reply shows, as its prompt asks: the local paths of its Markdown images, `![What it shows](/path.png)`. */
const shown = (text: string) => [...new Set([...text.matchAll(/!\[[^\]]*\]\(<?([^<>)]+?)>?\)/g)].map((m) => m[1].trim()))].filter((p) => (isImage(p) || isAudio(p)) && !/^\w+:\/\//.test(p));

/** Blocks a log draws when opened, and adds each time it is scrolled near its top: drawn whole, a 600-line log froze WebKitGTK
 * ~100 ms on each switch to it, ~40 ms this way. (content-visibility on the blocks gained ~10% more there, but their guessed
 * heights made the log jump while scrolled up: WebKit has no scroll anchoring.) */
const TAIL = 60;

/** `actions` show under "Your turn!" when the agent did not ask a question; `picks` are its options picked for the prompt box; `session` is the agent's id, for the files you sent it; `queued` are your messages waiting for its run to end, and `onEditQueued` gets one taken off to edit.
 * `working`: its run is going (or paused), so the last turn stays unfolded. `canSendNow`: its run can be cut short for the queue (Claude Code, which resumes its task).
 * `limit`: the usage limit its last run stopped at, shown under the log until it continues; `onCancelLimit` stops it instead.
 * `asks`: actions its run waits on you to allow, each as a card at the end of the log.
 */
export function AgentLog({ lines, empty, picks, onPicks, actions, thinking, working, provider, session, queued = [], onEditQueued, canSendNow, limit, onCancelLimit, asks = [] }: { lines: LogLine[]; empty?: string; picks: Choice[]; onPicks: (c: Choice[]) => void; actions?: ReactNode; thinking?: boolean; working?: boolean; provider?: string; session?: string; queued?: string[]; onEditQueued?: (text: string) => void; canSendNow?: boolean; limit?: AgentLimit | null; onCancelLimit?: () => void; asks?: AgentAsk[] }) {
  const me = useMe();
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const list = blocks(lines);
  // Drawn from block `from` on: a session opens on its last TAIL blocks, new ones join after them (the start stays put, so
  // nothing shifts under someone reading back) and older ones come as the log is scrolled up.
  const [tail, setTail] = useState({ session, from: Infinity });
  // Scrolled up from the end: where the log ended then, so the way back counts what came since. Another session's log starts at its end.
  const [away, setAway] = useState<number | null>(null);
  if (tail.session !== session && away !== null) setAway(null);
  if (tail.session !== session || (tail.from === Infinity && list.length)) setTail({ session, from: list.length ? Math.max(0, list.length - TAIL) : Infinity });
  const from = Math.min(tail.session === session ? tail.from : Infinity, Math.max(0, list.length - TAIL));
  // Distance to the bottom kept while blocks are added above, so what is on screen stays put (WebKit has no scroll anchoring).
  const keep = useRef<number | null>(null);
  const more = () => {
    const el = ref.current;
    if (!el || from === 0) return;
    keep.current = el.scrollHeight - el.scrollTop;
    setTail({ session, from: Math.max(0, from - TAIL) });
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (keep.current !== null) el.scrollTop = el.scrollHeight - keep.current;
    keep.current = null;
    // Too short to scroll up: nothing would ask for more.
    if (el.scrollHeight - el.clientHeight < 400) more();
  }, [from]); // eslint-disable-line react-hooks/exhaustive-deps
  const qs = questions(lines);
  // A usage limit holds it: its card shows under the log.
  const held = !!limit && !!session && !working;
  // Picks for questions no longer asked (answered, another session) leave the prompt box.
  const live = picks.filter((p) => qs[p.qi]?.text === p.q && qs[p.qi].opts.some((o) => o.n === p.n));
  useEffect(() => {
    if (live.length !== picks.length) onPicks(live);
  });
  const fold = useMemo(() => folds(list, !!working), [list, working]);
  // One mark per answer: on the first reply, steps or folded work after each message of yours.
  const { opens, fresh } = useMemo(() => {
    const opens = new Set<number>();
    let fresh = true;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const f = fold.get(i);
      if (b.kind === "you") fresh = true;
      else if (fresh && (f || b.kind === "ai" || b.kind === "steps")) {
        opens.add(i);
        fresh = false;
      }
      if (f) i = f.end - 1;
    }
    return { opens, fresh };
  }, [list, fold]);
  // A failed run can go again: the backend asks its last prompt again. Once: hidden while that call is out.
  const retry = useAction("agents.retry", { invalidate: [["agents"]] });
  const canRetry = !!session && !working && !thinking && !retry.isPending && list.at(-1)?.kind === "err";
  const again = useRef<() => void>(undefined);
  again.current = () => session && retry.mutate({ id: session });
  const unqueue = useAction<string>("agents.unqueue", { invalidate: [["agents"], ["worktrees"]] });
  const sendNow = useAction("agents.sendNow", { invalidate: [["agents"], ["worktrees"]] });
  // Blocks drawn since you scrolled up: a wait is drawn as "Your turn!", not as a block.
  const news = away === null ? 0 : list.slice(away).filter((b) => b.kind !== "wait").length;
  const mark = useMemo(() => <AgentMark provider={provider} />, [provider]);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, thinking, queued.length, asks.length]);
  // Your first message is the task: once it scrolls out of the log, it pins to the top; `peek` unfolds it there.
  const task = list.find((b): b is Extract<Block, { kind: "you" }> => b.kind === "you");
  const ti = task ? list.indexOf(task) : -1;
  const first = useRef<HTMLDivElement>(null);
  const [gone, setGone] = useState(false);
  const [peek, setPeek] = useState(false);
  // Not drawn yet: it is above what is, so out of view.
  const taskOut = ti >= 0 && ti < from;
  useEffect(() => {
    setPeek(false);
    const el = first.current;
    if (!el) return setGone(taskOut);
    const io = new IntersectionObserver(([e]) => {
      setGone(!e.isIntersecting);
      if (e.isIntersecting) setPeek(false);
    }, { root: ref.current });
    io.observe(el);
    return () => io.disconnect();
  }, [ti, task?.text, taskOut]);
  // Redrawn only when the log grows: not on each key typed in the box below, nor on another session's output.
  const history = useMemo(() => {
    const one = (b: Block, i: number, marked: boolean): ReactNode => {
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
              <Meta at={b.at} text={b.text} />
            </div>
          );
        case "ai":
          return (
            <div key={i} className="ag-ai">
              {marked && mark}
              <Markdown text={b.text} />
              <Files files={shown(b.text)} session={session} />
              <Meta at={b.at} text={b.text} />
            </div>
          );
        case "steps":
          // The newest steps stay open while the agent works on them.
          return (
            <div key={i} className="ag-act">
              {marked && mark}
              <Steps lines={b.lines} open={i === list.length - 1} />
            </div>
          );
        case "files":
          return (
            <div key={i} className="ag-act">
              <Changes b={b} session={session} />
            </div>
          );
        case "wait":
          // Only the latest wait matters, drawn after the history; older ones are history.
          return null;
        case "err":
          return (
            <div key={i} className="ag-err">
              <span>✕ {errText(b.text)}</span>
              {canRetry && i === list.length - 1 && (
                <button type="button" className="btn btn-sm ag-retry" onClick={() => again.current?.()}>
                  <Icon name="refresh" size={12} />
                  Retry
                </button>
              )}
            </div>
          );
        case "ok":
          return <div key={i} className="ag-note ag-ok">✓ {b.text}</div>;
        case "limit":
          // The latest one shows as its card while it holds the agent.
          return held && i === list.length - 1 ? null : <div key={i} className="ag-note ag-limited">{errText(b.text)}</div>;
        default:
          return <div key={i} className="ag-note">{b.text}</div>;
      }
    };
    const out: ReactNode[] = [];
    for (let i = 0; i < list.length; i++) {
      const f = fold.get(i);
      if (f) {
        const at = i;
        if (f.end > from) out.push(<FoldRow key={`f${at}`} f={f} mark={opens.has(at) ? mark : undefined}>{() => list.slice(at, f.end).map((b, j) => one(b, at + j, false))}</FoldRow>);
        i = f.end - 1;
      } else if (i >= from) out.push(one(list[i], i, opens.has(i)));
    }
    return out;
  }, [list, fold, from, task, opens, mark, me.name, me.email, session, canRetry, held]);
  return (
    <div
      ref={ref}
      className="term-log ag-log"
      onScroll={(e) => {
        const el = e.currentTarget;
        const below = el.scrollHeight - el.scrollTop - el.clientHeight;
        stick.current = below < 24;
        setAway((a) => (below > 300 ? (a ?? list.length) : null));
        if (el.scrollTop < 400) more();
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
                <Said b={task} session={session} clamp={false} />
              </div>
            )}
          </div>
        </div>
      )}
      {lines.length === 0 && <div className="ag-empty">{empty ?? "No output yet."}</div>}
      {history}
      {list.at(-1)?.kind === "wait" && (
        <div className="ag-wait">
          <span className="ag-wait-chip">Your turn!</span>
          {qs.length > 0 && (
            <div className="ag-sugg" role="group" aria-labelledby="ag-sugg-label">
              {mark}
              <span id="ag-sugg-label" className="ag-sugg-label">Suggestions</span>
              <Choices qs={qs} picks={picks} onPicks={onPicks} />
            </div>
          )}
          {qs.length === 0 && actions && <div className="ag-choices">{actions}</div>}
        </div>
      )}
      {session && asks.map((a) => <AskCard key={a.id} session={session} ask={a} />)}
      {thinking && !asks.length && (
        <div className="ag-act" role="status" aria-label="Agent is thinking">
          {fresh && mark}
          <span className="ag-dots" aria-hidden="true"><i /><i /><i /></span>
        </div>
      )}
      {held && <LimitCard session={session} limit={limit} onCancel={onCancelLimit} />}
      {queued.map((t, i) => (
        <div key={i} className="ag-you ag-queued">
          <div className="ag-you-row">
            <Avatar name={me.name} email={me.email} size={22} />
            <div className="ag-bubble">
              <Said b={said(t)} session={session} />
            </div>
          </div>
          <div className="ag-queued-bar">
            {i === queued.length - 1 && <span>{limit ? "Queued · sends when the agent continues" : "Queued · sends when the agent finishes"}</span>}
            {session && (
              <>
                {onEditQueued && (
                  <button type="button" className="ag-link" disabled={unqueue.isPending} onClick={() => unqueue.mutate({ id: session, index: i, text: t }, { onSuccess: (r) => onEditQueued(r) })}>
                    Edit
                  </button>
                )}
                <button type="button" className="ag-link" disabled={unqueue.isPending} onClick={() => unqueue.mutate({ id: session, index: i, text: t })}>
                  Remove
                </button>
                {i === queued.length - 1 && canSendNow && !limit && (
                  <button type="button" className="ag-link" disabled={sendNow.isPending} data-tip="Stop the agent and send this now" onClick={() => sendNow.mutate({ id: session })}>
                    Send now
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      ))}
      {away !== null && (
        <div className="ag-jump">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              const el = ref.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
          >
            <Icon name="chevronDown" size={12} />
            {news > 0 ? `${news} new` : "Jump to the end"}
            {queued.length > 0 && <span className="faint">· {queued.length} queued</span>}
          </button>
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

/** ←/→ `step` back and forth through `n` things shown full size, when there are several. */
function useArrows(n: number, step: (d: number) => void) {
  const latest = useRef(step);
  latest.current = step;
  useEffect(() => {
    if (n < 2) return;
    const k = (e: globalThis.KeyboardEvent) => {
      // A focused slider (an image's swipe) takes its own arrows.
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "ArrowLeft") latest.current(-1);
      else if (e.key === "ArrowRight") latest.current(1);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [n]);
}

/** The previous and next buttons over the edges of what is shown full size. */
function Arrows({ what, step }: { what: string; step: (d: number) => void }) {
  return (
    <>
      <button type="button" className="ag-shot-nav ag-shot-prev" aria-label={`Previous ${what}`} onClick={() => step(-1)}>
        <Icon name="chevronLeft" />
      </button>
      <button type="button" className="ag-shot-nav ag-shot-next" aria-label={`Next ${what}`} onClick={() => step(1)}>
        <Icon name="chevronRight" />
      </button>
    </>
  );
}

type Pt = { x: number; y: number };
/** Where pointers `p` are together: their middle, and how far apart the first two are (0 for one). */
const spread = (p: Pt[]) => ({ x: p.reduce((a, q) => a + q.x, 0) / p.length, y: p.reduce((a, q) => a + q.y, 0) / p.length, d: p.length > 1 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0 });

/** `children` (an image) over the whole screen, zoomed up to 8× by a pinch, the wheel, a double tap or click and + / -, and dragged around once zoomed; 0 fits it again. Escape, the close button or a tap beside it closes it.
 * ←/→, and a one-finger swipe when not zoomed, call `onStep(1)` (→, to the left: next) or `onStep(-1)`; it stays up, the new image fitted. */
function Zoom({ name, onClose, onStep, children }: { name: string; onClose: () => void; onStep?: (d: number) => void; children: ReactNode }) {
  const stage = useRef<HTMLDivElement>(null);
  const pic = useRef<HTMLDivElement>(null);
  const [v, setV] = useState({ s: 1, x: 0, y: 0 });
  const pts = useRef(new Map<number, Pt>());
  // A press that has not moved yet (`bare`: beside the image), and the last tap: a second one there soon after zooms.
  const press = useRef<(Pt & { t: number; bare: boolean }) | null>(null);
  const last = useRef({ x: 0, y: 0, t: 0 });
  // A tap beside the image closes on its click, the last event of a tap: closed sooner, the mousedown after it would land on the gallery and close it too.
  const shut = useRef(false);
  // Where a finger went down on the image at 1×, alone: a swipe from there steps, as long as no second finger joins it.
  const swipe = useRef<Pt | null>(null);
  // From the middle of the screen, where the image's middle stands at 1×.
  const at = (e: { clientX: number; clientY: number }): Pt => {
    const r = stage.current!.getBoundingClientRect();
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
  };
  /** Zooms by `f` (0: back to 1×) with the point under `from` brought to `to`; a zoomed image cannot be dragged off the screen. */
  const go = (from: Pt, to: Pt, f: number) =>
    setV((v) => {
      const s = Math.min(8, Math.max(1, v.s * f));
      const k = s / v.s;
      const mx = Math.max(0, (s * pic.current!.offsetWidth - stage.current!.clientWidth) / 2);
      const my = Math.max(0, (s * pic.current!.offsetHeight - stage.current!.clientHeight) / 2);
      return { s, x: Math.min(mx, Math.max(-mx, to.x - k * (from.x - v.x))), y: Math.min(my, Math.max(-my, to.y - k * (from.y - v.y))) };
    });
  const latest = useRef({ onClose, onStep });
  latest.current = { onClose, onStep };
  const step = (d: number) => {
    setV({ s: 1, x: 0, y: 0 });
    latest.current.onStep?.(d);
  };
  useEffect(() => {
    const mid = { x: 0, y: 0 };
    // Before the gallery's own: Escape closes this alone, ←/→ step here.
    const k = (e: globalThis.KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        latest.current.onClose();
      } else if (latest.current.onStep && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.stopPropagation();
        step(e.key === "ArrowLeft" ? -1 : 1);
      } else if (e.key === "+" || e.key === "=") go(mid, mid, 1.5);
      else if (e.key === "-") go(mid, mid, 1 / 1.5);
      else if (e.key === "0") go(mid, mid, 0);
    };
    // Not passive, so the page does not scroll or zoom too (a trackpad pinch comes as Ctrl + wheel).
    const w = (e: WheelEvent) => {
      e.preventDefault();
      const p = at(e);
      go(p, p, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : e.ctrlKey ? 0.01 : 0.002)));
    };
    const el = stage.current!;
    window.addEventListener("keydown", k, true);
    el.addEventListener("wheel", w, { passive: false });
    return () => {
      window.removeEventListener("keydown", k, true);
      el.removeEventListener("wheel", w);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const lift = (id: number) => {
    pts.current.delete(id);
    press.current = null;
    swipe.current = null;
  };
  return createPortal(
    // Its touches stay here: a drag must not also swipe the page under it to another pane.
    <div className="ag-zoom" role="dialog" aria-modal="true" aria-label={name} onTouchStart={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()}>
      <div
        ref={stage}
        className="ag-zoom-stage"
        style={{ cursor: v.s > 1 ? "grab" : "zoom-in" }}
        onDragStart={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          if (e.button) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const p = at(e);
          pts.current.set(e.pointerId, p);
          press.current = pts.current.size === 1 ? { ...p, t: e.timeStamp, bare: e.target === e.currentTarget } : null;
          shut.current = false;
          swipe.current = pts.current.size === 1 && e.pointerType === "touch" && v.s === 1 ? p : null;
        }}
        onPointerMove={(e) => {
          const p = pts.current;
          if (!p.has(e.pointerId)) return;
          const a = spread([...p.values()]);
          p.set(e.pointerId, at(e));
          const b = spread([...p.values()]);
          if (press.current && Math.hypot(b.x - press.current.x, b.y - press.current.y) > 8) press.current = null;
          go(a, b, a.d ? b.d / a.d : 1);
        }}
        onPointerUp={(e) => {
          const t = press.current;
          const sw = swipe.current;
          lift(e.pointerId);
          if (sw && onStep) {
            const p = at(e);
            // As far and as flat as a swipe between pages (swipeProps).
            if (Math.abs(p.x - sw.x) >= 60 && Math.abs(p.x - sw.x) >= 2 * Math.abs(p.y - sw.y)) return step(p.x < sw.x ? 1 : -1);
          }
          if (!t || e.timeStamp - t.t > 300) return;
          const l = last.current;
          if (e.timeStamp - l.t < 300 && Math.hypot(t.x - l.x, t.y - l.y) < 30) {
            last.current = { x: 0, y: 0, t: 0 };
            go(t, t, v.s > 1 ? 0 : 2.5);
          } else if (t.bare) shut.current = true;
          else last.current = { x: t.x, y: t.y, t: e.timeStamp };
        }}
        onClick={() => shut.current && onClose()}
        onPointerCancel={(e) => lift(e.pointerId)}
      >
        <div ref={pic} style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.s})` }}>
          {children}
        </div>
      </div>
      <button type="button" className="ag-zoom-close" aria-label="Close full screen" autoFocus onClick={onClose}>
        <Icon name="close" />
      </button>
    </div>,
    document.body,
  );
}

/** The images `paths` agent `session` was sent or shows, full size from the `at`th: the arrows and ←/→ step through them, round. On the desktop, Copy puts the file itself on the clipboard (a GIF pasted still moves) and Download saves it in Downloads. The image opens full screen, to zoom into. */
function Gallery({ session, paths, at, onClose }: { session: string; paths: string[]; at: number; onClose: () => void }) {
  const [full, setFull] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const [i, setI] = useState(at);
  const n = paths.length;
  const path = paths[i];
  const name = nameOf(path);
  const step = (d: number) => setI((j) => (j + d + n) % n);
  // The next and previous load meanwhile, so stepping shows them at once.
  useAgentFile(session, paths[(i + 1) % n]);
  useAgentFile(session, paths[(i - 1 + n) % n]);
  useArrows(n, step);
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
        <button ref={opener} type="button" className="ag-shot-open" aria-label={`Zoom into ${name}`} onClick={() => setFull(true)}>
          <Shot session={session} path={path} />
        </button>
        {n > 1 && <Arrows what="image" step={step} />}
      </div>
      {/* Its steps step the gallery under it. */}
      {full && (
        <Zoom
          name={name}
          onStep={n > 1 ? step : undefined}
          onClose={() => {
            setFull(false);
            opener.current?.focus();
          }}
        >
          <Shot session={session} path={path} />
        </Zoom>
      )}
    </Modal>
  );
}

// A text preview shows the first MiB: the most `local_head` (src-tauri) reads.
const TEXT_CAP = 1 << 20;

/** What a file about to be sent shows full size: the image, its text, or why it has none. */
type Peeked = { url: string } | { text: string; cut: boolean } | { none: string };

/** An image as an object URL (revoke it), else the text of a UTF-8 file, its first MiB: a NUL or invalid UTF-8 means it is not text. */
async function peek(file: Attachment): Promise<Peeked> {
  const path = typeof file === "string";
  if (path ? isImage(file) : file.type.startsWith("image/") || isImage(file.name)) {
    try {
      return { url: URL.createObjectURL(path ? await localImage(file) : file) };
    } catch {
      // A dropped SVG: `local_image` turns it down, and its text shows instead.
    }
  }
  const head = new Uint8Array(path ? await localHead(file) : await file.slice(0, TEXT_CAP + 1).arrayBuffer());
  if (!head.length) return { none: "Empty file" };
  const cut = head.length > TEXT_CAP;
  try {
    if (head.includes(0)) throw new Error("binary");
    // Streamed when cut, so a character split at the cap is dropped, not an error.
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, TEXT_CAP), { stream: cut }), cut };
  } catch {
    return { none: "No preview" };
  }
}

/** The files `files` about to be sent, full size from the `at`th: images, text files' text, else "No preview". The arrows and ←/→ `onStep` through them, round; Remove takes the one shown off the message. */
function Peek({ files, at, onStep, onRemove, onClose }: { files: Attachment[]; at: number; onStep: (i: number) => void; onRemove: () => void; onClose: () => void }) {
  const file = files[at];
  const n = files.length;
  const name = nameOf(file);
  const [shown, setShown] = useState<{ file: Attachment; p: Peeked }>();
  useEffect(() => {
    let live = true;
    let url = "";
    peek(file).then(
      (p) => {
        if ("url" in p) url = p.url;
        if (live) setShown({ file, p });
        else if (url) URL.revokeObjectURL(url);
      },
      (e) => live && setShown({ file, p: { none: `Could not read ${name}: ${e}` } }),
    );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file]); // eslint-disable-line react-hooks/exhaustive-deps
  const p = shown?.file === file ? shown.p : undefined;
  const step = (d: number) => onStep((at + d + n) % n);
  useArrows(n, step);
  // It may open over the new session modal: Escape closes this one alone.
  useEffect(() => {
    const k = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);
  const sub = [n > 1 && `${at + 1} / ${n}`, typeof file !== "string" && bytes(file.size), p && "cut" in p && p.cut && `First ${bytes(TEXT_CAP)} shown`].filter(Boolean).join(" · ");
  return (
    <Modal
      title={name}
      sub={sub}
      onClose={onClose}
      actions={
        <button type="button" className="btn btn-ghost btn-icon" aria-label={`Remove ${name}`} data-tip="Remove from the message" onClick={onRemove}>
          <Icon name="trash" />
        </button>
      }
    >
      <div className="ag-shot">
        {!p ? (
          <span className="spinner" />
        ) : "url" in p ? (
          <img src={p.url} alt={name} onError={() => setShown({ file, p: { none: `Could not load ${name}` } })} />
        ) : "text" in p ? (
          <pre className="ag-peek-text">{p.text}</pre>
        ) : (
          <span className="faint">{p.none}</span>
        )}
        {n > 1 && <Arrows what="file" step={step} />}
      </div>
    </Modal>
  );
}

/** Files about to be sent, one chip each: a click opens them full size; × there or Remove in the preview takes one off. */
function Drafts({ files, onFiles }: { files: Attachment[]; onFiles: (f: Attachment[]) => void }) {
  const [open, setOpen] = useState<number>();
  const remove = (i: number) => {
    onFiles(files.filter((_, j) => j !== i));
    // The preview moves on to the next file, or the one before when it showed the last.
    setOpen((o) => (o === undefined || files.length < 2 ? undefined : o > i ? o - 1 : Math.min(o, files.length - 2)));
  };
  return (
    <>
      {files.map((f, i) => (
        <FileChip key={i} file={f} onOpen={() => setOpen(i)} onRemove={() => remove(i)} />
      ))}
      {open !== undefined && open < files.length && <Peek files={files} at={open} onStep={setOpen} onRemove={() => remove(open)} onClose={() => setOpen(undefined)} />}
    </>
  );
}

/** A file sent, or about to be: images in hand show a thumbnail, others their icon; images sent to agent `session` preview on hover or focus. A click runs `onOpen` on those, and on any file about to be sent (no `session`). `onRemove` takes it off the message. */
export function FileChip({ file, session, onOpen, onRemove }: { file: Attachment; session?: string; onOpen?: () => void; onRemove?: () => void }) {
  const name = nameOf(file);
  const [url, setUrl] = useState<string>();
  const sent = typeof file === "string" && !!session && isImage(file) ? file : undefined;
  const opens = !!sent || (!session && !!onOpen);
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
    // A path dropped or pasted on the desktop window loads from it. Pasted files may come untyped.
    const shown = typeof file === "string" ? isLocal && !session && isImage(file) : file.type.startsWith("image/") || isImage(file.name);
    if (!shown) return setUrl(undefined);
    let u = "";
    let live = true;
    (typeof file === "string" ? localImage(file) : Promise.resolve(file)).then(
      (b) => live && setUrl((u = URL.createObjectURL(b))),
      () => live && setUrl(undefined),
    );
    return () => {
      live = false;
      if (u) URL.revokeObjectURL(u);
    };
  }, [file, session]);
  return (
    <span
      className="ag-file"
      // The preview stands where tooltips would.
      title={sent ? undefined : typeof file === "string" ? file : name}
      tabIndex={opens ? 0 : undefined}
      role={opens ? "button" : undefined}
      onClick={() => opens && open()}
      onPointerEnter={(e) => sent && setAt(e.currentTarget)}
      onPointerLeave={() => setAt(null)}
      onFocus={(e) => sent && setAt(e.currentTarget)}
      onBlur={() => setAt(null)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setAt(null);
        // Not from the × inside it.
        else if (opens && e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          open();
        }
      }}
    >
      {url ? <img src={url} alt="" /> : <Icon name={isImage(name) ? "image" : "file"} size={15} />}
      <span className="ellipsis" data-tip-off={sent ? "" : undefined}>{name}</span>
      {typeof file !== "string" && <span className="faint">{bytes(file.size)}</span>}
      {onRemove && (
        <button
          type="button"
          className="ag-file-x"
          aria-label={`Remove ${name}`}
          // Not opening the chip's preview on the way.
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
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

/** Screenshots, copied images and copied files attach instead of pasting nothing. WebKitGTK (the desktop app on Linux) hands the page none of them: they come from the desktop's clipboard. */
function paste(e: ClipboardEvent<HTMLTextAreaElement>, add: (f: Attachment[]) => void) {
  const pasted = [...e.clipboardData.files];
  if (pasted.length) {
    e.preventDefault();
    return add(pasted);
  }
  if (!isLocal || e.clipboardData.getData("text/plain")) return;
  e.preventDefault();
  clipboardFiles().then(add, (err) => toast(`Could not paste: ${err}`, "error"));
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
        onPaste={(e) => paste(e, add)}
        autoFocus
      />
      {files.length > 0 && (
        <div className="ag-files">
          <Drafts files={files} onFiles={onFiles} />
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
  // Lines of text shown: Send stays square up to 3.
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
    // From 2 lines the attach button moves above the mic, which widens the text.
    // Count lines in the narrower layout below, or the text rewraps shorter and drops back at the next key.
    // The wider layout stays while its own count still needs it: the narrower one is only longer, and recounting rewraps the whole text again.
    const row = el.parentElement!.classList;
    // The textarea's 11px padding and 18px lines (app.css).
    const count = () => Math.max(1, Math.round((el.scrollHeight - 22) / 18));
    let n = count();
    if (!(row.contains("term-input-multi") && n >= 2)) {
      row.remove("term-input-multi");
      n = count();
    }
    row.toggle("term-input-multi", n >= 2);
    // A wider layout keeps its 2- or 3-line height even if the text now fits in fewer.
    const h = Math.min(Math.max(el.scrollHeight, n >= 3 ? 76 : n >= 2 ? 58 : 0), cap);
    el.style.height = `${h}px`;
    el.style.overflowY = el.scrollHeight > cap ? "auto" : "hidden";
    setLines(n);
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
            <span key={`${p.qi}.${p.n}`} className="ag-file ag-pick" title={p.q}>
              <span className="c-acc">{p.key ? `${p.key} · ${p.n}` : p.n}</span>
              <span className="ellipsis">{p.label}</span>
              <button type="button" className="ag-file-x" aria-label={`Remove answer ${p.n}`} onClick={() => onPicks(picks.filter((x) => x !== p))}>
                <Icon name="close" size={10} />
              </button>
            </span>
          ))}
          <Drafts files={files} onFiles={onFiles} />
        </div>
      )}
      <div className={`term-input-row${lines >= 2 ? " term-input-multi" : ""}`} style={{ "--lines": Math.min(lines, 3) } as CSSProperties}>
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
          onPaste={(e) => paste(e, add)}
          onChange={(e) => {
            setAt(null);
            onChange(e.target.value);
          }}
          placeholder={placeholder}
        />
        <div className="term-tools">
          <button type="button" className="btn btn-ghost term-attach" aria-label="Attach files" data-tip="Attach files or images" disabled={disabled} onClick={() => chooser.current?.click()}>
            <Icon name="attach" size={14} />
          </button>
          <OwnMic field={input} disabled={disabled} />
        </div>
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
