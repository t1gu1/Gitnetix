import { lazy, Suspense, useState } from "react";

import { rpc } from "../api/transport";
import { useStored } from "../lib/stored";
import { ContextMenu } from "./ContextMenu";
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

// shortcut: lists of deleted worktrees stay in the config too, prune them along with the view map.
/** A checkout's terminals (numbers the engine knows them by) and the one its Shell tab shows. */
const useShells = (path = "") => useStored<{ tabs: number[]; cur: number }>(`gnx.term.shells.${path}`, { tabs: [0], cur: 0 });

/** The terminal icon, split into the Agent and Shell tabs; the button after them lists the checkout's terminals (`path`). */
export function TermTabs({ value, onChange, path }: { value: TermView; onChange: (v: TermView) => void; path?: string }) {
  const [{ tabs, cur }, setShells] = useShells(path);
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const pick = (n: number, list = tabs) => {
    setShells({ tabs: list, cur: n });
    onChange("shell");
  };
  const close = () => {
    rpc("shell.close", { path, tab: cur }).catch(() => {});
    const rest = tabs.filter((n) => n !== cur);
    pick(rest[Math.max(0, tabs.indexOf(cur) - 1)], rest);
  };
  const next = Math.max(...tabs) + 1;
  return (
    <>
      <button type="button" className="term-tab" style={{ borderLeft: 0 }} aria-pressed={value === "agent"} onClick={() => onChange("agent")}>
        <Icon name="sparkle" size={12} />
        Agent
      </button>
      <button type="button" className="term-tab" style={path ? { paddingRight: 8 } : { borderRight: "1px solid var(--line)" }} aria-pressed={value === "shell"} onClick={() => onChange("shell")}>
        <Icon name="terminal" size={12} />
        Shell
      </button>
      {path && (
        <button
          type="button"
          className="term-tab term-tab-menu"
          aria-haspopup="menu"
          aria-label="Terminals"
          data-tip="Terminals"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom + 2 });
          }}
        >
          <Icon name="chevronDown" size={11} />
        </button>
      )}
      {menu && (
        <ContextMenu
          {...menu}
          label="Terminals"
          onClose={() => setMenu(undefined)}
          items={[
            ...tabs.map((n, i) => ({ id: `t${n}`, label: `Terminal ${i + 1}`, icon: n === cur ? "check" : undefined, run: () => pick(n) })),
            "sep",
            { id: "new", label: "New terminal", icon: "plus", run: () => pick(next, [...tabs, next]) },
            ...(tabs.length > 1 ? [{ id: "close", label: `Close Terminal ${tabs.indexOf(cur) + 1}`, icon: "close", danger: true, run: close }] : []),
          ]}
        />
      )}
    </>
  );
}

// xterm.js is big; loaded the first time a shell is shown.
const Pane = lazy(() => import("./ShellPane"));

/** The terminal of a checkout picked in its Shell tab: a login shell running in `path` (no `path`: the checkout is gone). */
export function ShellPane(props: { projectId: string; path?: string }) {
  const [{ cur }] = useShells(props.path);
  return (
    <Suspense fallback={<div className="shell-pane" />}>
      <Pane {...props} tab={cur} />
    </Suspense>
  );
}
