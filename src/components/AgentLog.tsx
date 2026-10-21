import { type ReactNode, useEffect, useRef } from "react";

import { useAiCatalog, useConfig } from "../api/hooks";
import type { LogLine } from "../api/types";
import { Avatar } from "./Avatar";
import { Markdown } from "./ui";

type Block =
  | { kind: "you"; text: string }
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
        // "$ claude · request" opens the session, "› text" follows up.
        out.push({ kind: "you", text: l.text.replace(/^(\$ \S+ · |› )/, "") });
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

/** Numbered options ("1. **Foo:** bar") in the agent's last reply, when it now waits for you. */
export function choices(lines: LogLine[]): { n: string; label: string }[] {
  const b = blocks(lines);
  if (b.at(-1)?.kind !== "wait") return [];
  const reply = [...b].reverse().find((x) => x.kind === "ai" || x.kind === "you");
  if (reply?.kind !== "ai") return [];
  let out: { n: string; label: string }[] = [];
  for (const line of reply.text.split("\n").reverse()) {
    const m = /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
    if (!m) continue;
    out.unshift({ n: m[1], label: m[2].replace(/\*\*|`/g, "") });
    // Keep only the last list of the reply.
    if (m[1] === "1") break;
  }
  if (out[0]?.n !== "1") out = [];
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

/** `actions` show under "Your turn!" when the agent did not ask a question. */
export function AgentLog({ lines, empty, onAnswer, projectId, actions, thinking, provider }: { lines: LogLine[]; empty?: string; onAnswer?: (text: string) => void; projectId?: string; actions?: ReactNode; thinking?: boolean; provider?: string }) {
  const me = useMe(projectId);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const list = blocks(lines);
  const opts = onAnswer ? choices(lines) : [];
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
                  <div className="ag-bubble">{b.text}</div>
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
                {opts.length > 0 && (
                  <div className="ag-sugg" role="group" aria-labelledby="ag-sugg-label">
                    <span id="ag-sugg-label" className="ag-sugg-label">Suggestions</span>
                    <div className="ag-choices">
                      {opts.map((o) => (
                        <button key={o.n} type="button" className="btn btn-sm" title={o.label} onClick={() => onAnswer?.(o.n)}>
                          <span className="c-acc">{o.n}</span>
                          <span className="ellipsis">{o.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {opts.length === 0 && actions && <div className="ag-choices">{actions}</div>}
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
