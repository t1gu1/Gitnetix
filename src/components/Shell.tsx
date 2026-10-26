import { lazy, Suspense, useState } from "react";

import { useStored } from "../lib/stored";
import { Icon } from "./Icon";

export type TermView = "agent" | "shell";

const parseView = (s: string): TermView => (s === "shell" ? "shell" : "agent");

/** The tab a branch's terminal opens on until one is picked there, in every project. */
export const useTermDefault = () => useStored<TermView>("gnx.term.default", "agent", parseView, String);

// shortcut: picks of deleted branches stay in the config, prune them if the view map grows large.
/**
 * Whether a branch's terminal shows its agent or its checkout's shell. A worktree opens on its agent each time it is shown;
 * another branch keeps its own pick and, until one is made, shows the agent when it has a session (`agent`), else the default tab.
 */
export function useTermView(projectId: string, branch: string | undefined, agent: boolean, worktree: boolean) {
  const key = `gnx.term.view.${projectId}.${branch ?? ""}`;
  const [def] = useTermDefault();
  const kept = useStored<TermView>(key, agent ? "agent" : def, parseView, String);
  // A worktree's pick is never saved and lasts until another branch is shown.
  const [shown, setShown] = useState<{ key: string; view: TermView }>({ key, view: "agent" });
  if (shown.key !== key) setShown({ key, view: "agent" });
  return worktree ? ([shown.view, (view: TermView) => setShown({ key, view })] as const) : kept;
}

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
