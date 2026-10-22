import { useEffect, useRef, useState } from "react";

import { useAction, useShell } from "../api/hooks";
import type { LogLine } from "../api/types";
import { useStored } from "../lib/stored";
import { AgentInput } from "./AgentLog";
import { Icon } from "./Icon";

export type TermView = "agent" | "shell";

/** Whether the bottom terminal shows the agent or the checkout's shell; one choice for every terminal. */
export const useTermView = () => useStored<TermView>("gnx.term.view", "agent", (s) => (s === "shell" ? "shell" : "agent"), (v) => v);

/** The terminal icon, split into the Agent and Shell tabs. */
export function TermTabs({ value, onChange }: { value: TermView; onChange: (v: TermView) => void }) {
  return (
    <>
      <button type="button" className="term-tab" style={{ borderLeft: 0 }} aria-pressed={value === "agent"} onClick={() => onChange("agent")}>
        <Icon name="sparkle" size={12} />
        Agent
      </button>
      <button type="button" className="term-tab" aria-pressed={value === "shell"} onClick={() => onChange("shell")}>
        <Icon name="terminal" size={12} />
        Shell
      </button>
    </>
  );
}

const CLS: Partial<Record<LogLine["kind"], string>> = { dim: "muted", err: "c-del" };

/** A checkout's terminal: each command runs with the login shell in `path` (no `path`: the checkout is gone). */
export function ShellPane({ id, projectId, path }: { id: string; projectId: string; path?: string }) {
  const term = useShell(path).data;
  const [text, setText] = useState("");
  const run = useAction("shell.run");
  const stop = useAction("shell.stop");
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lines = term?.lines ?? [];
  const running = !!term?.running;
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  const send = () => {
    const t = text.trim();
    if (t && path && !running) run.mutate({ projectId, path, command: t }, { onSuccess: () => setText("") });
  };
  return (
    <>
      <div
        ref={ref}
        className="term-log"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {lines.length === 0 && <div className="ag-empty" style={{ fontFamily: "var(--sans)" }}>{path ? `Commands run in ${path}` : "Directory removed."}</div>}
        {lines.map((l, i) =>
          l.kind === "cmd" ? (
            <div key={i} style={{ marginTop: i ? 8 : 0 }}>
              <span className="c-acc">$ </span>
              {l.text}
            </div>
          ) : (
            <div key={i} className={CLS[l.kind]}>{l.text}</div>
          ),
        )}
      </div>
      <AgentInput
        id={id}
        label="Run a shell command"
        value={text}
        onChange={setText}
        onSend={send}
        disabled={!path || running}
        pending={run.isPending}
        picker={
          running && (
            <button type="button" className="btn btn-sm btn-icon" aria-label="Stop the command" data-tip="Stop the command" onClick={() => stop.mutate({ path })}>
              <Icon name="stop" size={12} />
            </button>
          )
        }
        placeholder={running ? "Command is running…" : "Run a command…"}
      />
    </>
  );
}
