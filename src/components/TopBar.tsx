import { useAgents, useProjects } from "../api/hooks";
import { useNav, type Route } from "../lib/nav";
import { Icon } from "./Icon";
import { ThemeToggle } from "./ThemeToggle";

export const PAGES: { label: string; icon: string; route: Route }[] = [
  { label: "Workspace", icon: "home", route: { name: "workspace" } },
  { label: "Release notes", icon: "tag", route: { name: "notes" } },
  { label: "Pull requests", icon: "pr", route: { name: "prs" } },
  { label: "Tickets", icon: "ticket", route: { name: "tickets" } },
  { label: "Worktrees & agents", icon: "layers", route: { name: "worktrees" } },
  { label: "AI templates", icon: "sparkle", route: { name: "templates" } },
  { label: "Analytics", icon: "chart", route: { name: "analytics" } },
];

export const isPageRoute = (r: Route) => PAGES.some((p) => p.route.name === r.name);

/** Project tabs plus the page tabs, shown above the workspace and every tool page. */
export function TopBar() {
  const nav = useNav();
  const projects = useProjects();
  const agents = useAgents();
  const runningAll = (agents.data ?? []).filter((a) => a.status === "running").length;

  return (
    <>
      <header className="hdr">
        <button className="hdr-icon" aria-label="Open menu" onClick={() => nav.go({ name: "menu" })}>
          <Icon name="menu" size={18} stroke={1.4} />
        </button>
        <nav aria-label="Projects" className="tabs-projects">
          {(projects.data ?? []).map((p) => (
            <button key={p.id} className="tab-project" aria-pressed={p.id === nav.projectId} onClick={() => nav.setProject(p.id)}>
              {p.runningAgents > 0 && <span className="pulse" title="AI task running" />}
              <span>{p.name}</span>
            </button>
          ))}
          <button className="btn btn-ghost btn-icon" style={{ height: "auto", width: 40, border: 0, borderRadius: 0 }} aria-label="Add project" onClick={() => nav.go({ name: "home" })}>
            <Icon name="plus" />
          </button>
        </nav>
        <div className="hdr-tools">
          {runningAll > 0 && (
            <button className="btn hide-narrow" style={{ height: 28 }} onClick={() => nav.go({ name: "worktrees" })}>
              <span className="pulse" />
              <span className="muted">{runningAll} {runningAll === 1 ? "agent" : "agents"} running</span>
            </button>
          )}
          <ThemeToggle />
        </div>
      </header>
      <nav aria-label="Pages" className="tabs-pages">
        {PAGES.map((p) => {
          const active = nav.route.name === p.route.name;
          return (
            <button key={p.label} className="tab-page" aria-current={active ? "page" : undefined} onClick={() => nav.go(p.route)}>
              <Icon name={p.icon} size={14} />
              {p.label}
            </button>
          );
        })}
      </nav>
    </>
  );
}
