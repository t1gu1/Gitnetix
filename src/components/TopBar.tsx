import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type PointerEvent } from "react";

import { useAction, useAgents, useProjects } from "../api/hooks";
import type { ProjectSummary } from "../api/types";
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

/** Pointer travel before a press on a project tab becomes a drag. */
const DRAG_THRESHOLD = 5;

function moveTo<T extends { id: string }>(list: T[], id: string, index: number): T[] {
  const item = list.find((x) => x.id === id);
  if (!item) return list;
  const rest = list.filter((x) => x.id !== id);
  return [...rest.slice(0, index), item, ...rest.slice(index)];
}

/** Project tabs plus the page tabs, shown above the workspace and every tool page. */
export function TopBar() {
  const nav = useNav();
  const projects = useProjects();
  const agents = useAgents();
  const runningAll = (agents.data ?? []).filter((a) => a.status === "running").length;
  const hide = useAction("projects.setHidden", { invalidate: [["projects"], ["config"]] });
  const open = (projects.data ?? []).filter((p) => !p.hidden);

  // Tabs are reordered with pointer events: HTML5 drag-and-drop clashes with the webview's folder drop.
  const qc = useQueryClient();
  const reorder = useAction("projects.reorder", { invalidate: [["projects"], ["config"]] });
  const [drag, setDrag] = useState<{ id: string; x0: number; index: number; active: boolean } | null>(null);
  const tabs = useRef(new Map<string, HTMLElement>());
  const dragged = useRef(false);
  const shown = drag?.active ? moveTo(open, drag.id, drag.index) : open;
  const dragging = !!drag?.active;

  // Keep the grabbing cursor wherever the pointer goes during a drag.
  useEffect(() => {
    document.body.classList.toggle("dragging-tab", dragging);
    return () => document.body.classList.remove("dragging-tab");
  }, [dragging]);

  const onDragMove = (e: PointerEvent) => {
    if (!drag || (!drag.active && Math.abs(e.clientX - drag.x0) < DRAG_THRESHOLD)) return;
    const index = shown.filter((p) => {
      const r = p.id !== drag.id && tabs.current.get(p.id)?.getBoundingClientRect();
      return r && r.left + r.width / 2 < e.clientX;
    }).length;
    if (!drag.active || index !== drag.index) setDrag({ ...drag, index, active: true });
  };

  const onDragEnd = () => {
    if (drag?.active) {
      dragged.current = true;
      setTimeout(() => (dragged.current = false));
      const ids = [...shown, ...(projects.data ?? []).filter((p) => p.hidden)].map((p) => p.id);
      if (ids.join() !== (projects.data ?? []).map((p) => p.id).join()) {
        qc.setQueryData<ProjectSummary[]>(["projects"], (old) => old && ids.map((id) => old.find((p) => p.id === id)!).filter(Boolean));
        reorder.mutate({ ids }, { onError: () => qc.invalidateQueries({ queryKey: ["projects"] }) });
      }
    }
    setDrag(null);
  };

  const close = (id: string) => {
    hide.mutate(
      { projectId: id, hidden: true },
      {
        onSuccess: () => {
          if (id !== nav.projectId) return;
          const i = open.findIndex((p) => p.id === id);
          const next = open[i + 1] ?? open[i - 1];
          nav.setProject(next?.id);
          if (!next) nav.go({ name: "home" });
        },
      },
    );
  };

  return (
    <>
      <header className="hdr">
        <button className="hdr-icon" aria-label="Open menu" onClick={() => nav.go({ name: "menu" })}>
          <Icon name="menu" size={18} stroke={1.4} />
        </button>
        <nav aria-label="Projects" className="tabs-projects">
          {shown.map((p) => (
            <div
              key={p.id}
              ref={(el) => void (el ? tabs.current.set(p.id, el) : tabs.current.delete(p.id))}
              className="tab-project"
              data-active={p.id === nav.projectId || undefined}
              data-dragging={(drag?.active && drag.id === p.id) || undefined}
            >
              <button
                className="tab-project-open"
                aria-pressed={p.id === nav.projectId}
                title="Drag to reorder"
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDrag({ id: p.id, x0: e.clientX, index: 0, active: false });
                }}
                onPointerMove={onDragMove}
                onPointerUp={onDragEnd}
                onPointerCancel={() => setDrag(null)}
                onClick={() => !dragged.current && nav.setProject(p.id)}
              >
                {p.runningAgents > 0 && <span className="pulse" title="AI task running" />}
                <span>{p.name}</span>
              </button>
              <button className="tab-project-close" aria-label={`Close ${p.name}`} title="Close tab (project stays saved)" disabled={hide.isPending} onClick={() => close(p.id)}>
                <Icon name="close" size={12} />
              </button>
            </div>
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
