import { lazy, Suspense } from "react";

import { useStored } from "../lib/stored";
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
      <button type="button" className="term-tab" style={{ borderRight: "1px solid var(--line)" }} aria-pressed={value === "shell"} onClick={() => onChange("shell")}>
        <Icon name="terminal" size={12} />
        Shell
      </button>
    </>
  );
}

// xterm.js is big; loaded the first time a shell is shown.
const Pane = lazy(() => import("./ShellPane"));

/** A checkout's terminal: the login shell running in `path` (no `path`: the checkout is gone). */
export function ShellPane(props: { projectId: string; path?: string }) {
  return (
    <Suspense fallback={<div className="shell-pane" />}>
      <Pane {...props} />
    </Suspense>
  );
}
