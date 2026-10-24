import { useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";

import { useAction, useAgents, useProjects } from "../api/hooks";
import type { ProjectSummary } from "../api/types";
import { animates } from "../lib/motion";
import { useNav, type Route } from "../lib/nav";
import { Icon } from "./Icon";
import { ThemeToggle } from "./ThemeToggle";
import { FixedWidth, useThumb } from "./ui";

export const PAGES: { label: string; icon: string; route: Route }[] = [
  { label: "Workspace", icon: "home", route: { name: "workspace" } },
  { label: "Release notes", icon: "tag", route: { name: "notes" } },
  { label: "Pull requests", icon: "pr", route: { name: "prs" } },
  { label: "Tickets", icon: "ticket", route: { name: "tickets" } },
  { label: "Worktrees & agents", icon: "layers", route: { name: "worktrees" } },
  { label: "Submodules", icon: "box", route: { name: "submodules" } },
  { label: "Analytics", icon: "chart", route: { name: "analytics" } },
];

export const isPageRoute = (r: Route) =>
  PAGES.some((p) => p.route.name === r.name);

/** Pointer travel before a press on a project tab becomes a drag; until then the tab stretches toward the pointer. */
const DRAG_THRESHOLD = 32;
/** Share of the pointer travel the tab stretches by before it snaps loose. */
const STRETCH = 0.6;
/** Hold time before a touch press on a project tab picks it up; a shorter press is a tap or a scroll. */
const LONG_PRESS = 400;
/** Distance from the bar's edge where a dragged tab scrolls the bar, and the scroll speed per pixel into it. */
const EDGE = 40;
const EDGE_SPEED = 0.3;

interface Drag {
  id: string;
  /** Press point, and where on the tab it was grabbed. */
  x0: number;
  ox: number;
  /** Tab box at press time. */
  top: number;
  w: number;
  h: number;
  /** Horizontal range the held tab may slide in (the project bar). */
  minLeft: number;
  maxLeft: number;
  /** Current pointer x. */
  x: number;
  index: number;
  /** Past the threshold: the tab has popped loose and follows the pointer. */
  active: boolean;
}

function moveTo<T extends { id: string }>(
  list: T[],
  id: string,
  index: number,
): T[] {
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
  const runningAll = (agents.data ?? []).filter(
    (a) => a.status === "running",
  ).length;
  const hide = useAction("projects.setHidden", {
    invalidate: [["projects"], ["config"]],
  });
  const open = (projects.data ?? []).filter((p) => !p.hidden);

  // Tabs are reordered with pointer events: HTML5 drag-and-drop clashes with the webview's folder drop.
  const qc = useQueryClient();
  const reorder = useAction("projects.reorder", {
    invalidate: [["projects"], ["config"]],
  });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [landed, setLanded] = useState<string>();
  const tabs = useRef(new Map<string, HTMLElement>());
  const bar = useRef<HTMLElement>(null);
  // Touch: a swipe scrolls the bar natively and a tap clicks; only a long press picks the tab up.
  const touch = useRef(false);
  const hold = useRef<ReturnType<typeof setTimeout>>(undefined);
  const held = useRef(false);
  const cancelHold = () => clearTimeout(hold.current);
  const shown = drag?.active ? moveTo(open, drag.id, drag.index) : open;
  const pagesBar = useRef<HTMLElement>(null);
  const page = PAGES.findIndex((p) => p.route.name === nav.route.name);
  const ink = useThumb(pagesBar, page, PAGES.length);
  // On a narrow window the page bar scrolls: keep the current page's tab in sight.
  useEffect(() => {
    pagesBar.current?.querySelectorAll(".tab-page")[page]?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: animates("seg") ? "smooth" : "auto" });
  }, [page]);
  const dragging = !!drag?.active;

  // A held tab blocks the native scroll so the finger moves the tab instead of the bar.
  useEffect(() => {
    const el = bar.current;
    const block = (e: TouchEvent) => held.current && e.preventDefault();
    el?.addEventListener("touchmove", block, { passive: false });
    return () => el?.removeEventListener("touchmove", block);
  }, []);

  // Keep the grabbing cursor wherever the pointer goes during a drag.
  useEffect(() => {
    document.body.classList.toggle("dragging-tab", dragging);
    return () => document.body.classList.remove("dragging-tab");
  }, [dragging]);

  /** Slot for the dragged tab: how many other tabs sit left of the pointer. */
  const indexAt = (id: string, x: number) =>
    open.filter((p) => {
      const r = p.id !== id && tabs.current.get(p.id)?.getBoundingClientRect();
      return r && r.left + r.width / 2 < x;
    }).length;

  const onDragMove = (e: PointerEvent) => {
    if (!drag) return;
    const x = e.clientX;
    if (!drag.active && Math.abs(x - drag.x0) < DRAG_THRESHOLD)
      return setDrag({ ...drag, x });
    setDrag({ ...drag, x, index: indexAt(drag.id, x), active: true });
  };

  // Near an edge the bar scrolls under the held tab, faster the closer the pointer, even while it stays still.
  const dragX = drag?.active ? drag.x : null;
  useEffect(() => {
    if (dragX === null) return;
    let raf = 0;
    const tick = () => {
      const el = bar.current!;
      const b = el.getBoundingClientRect();
      const into =
        dragX < b.left + EDGE
          ? dragX - b.left - EDGE
          : Math.max(0, dragX - b.right + EDGE);
      const step = Math.max(-EDGE, Math.min(EDGE, into)) * EDGE_SPEED;
      const before = el.scrollLeft;
      el.scrollLeft += step;
      if (el.scrollLeft === before) return;
      setDrag((d) => d && { ...d, index: indexAt(d.id, dragX) });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [dragX]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Rubber-band pull toward the pointer while pressed; springs back (CSS transition) once released or dragging. */
  const stretch = (id: string): CSSProperties | undefined => {
    if (
      !drag ||
      drag.id !== id ||
      drag.active ||
      drag.x === drag.x0 ||
      !animates("tabs")
    )
      return undefined;
    const pull = (drag.x - drag.x0) * STRETCH;
    const k = Math.abs(pull) / (tabs.current.get(id)?.offsetWidth || 100);
    return {
      transform: `translateX(${pull / 2}px) scale(${1 + k}, ${1 - k * 0.25})`,
      transition: "none",
      zIndex: 1,
      background: "var(--raised)",
    };
  };

  const startDrag = (
    id: string,
    pointerId: number,
    x: number,
    active: boolean,
  ) => {
    bar.current!.setPointerCapture(pointerId);
    const r = tabs.current.get(id)!.getBoundingClientRect();
    const b = bar.current!.getBoundingClientRect();
    setDrag({
      id,
      x0: x,
      x,
      ox: x - r.left,
      top: r.top,
      w: r.width,
      h: r.height,
      minLeft: b.left,
      maxLeft: b.right - r.width,
      index: open.findIndex((p) => p.id === id),
      active,
    });
  };

  const onDragEnd = () => {
    held.current = false;
    if (drag && !drag.active) {
      // Captured on the bar, so the button gets no click: a press released over its tab opens it.
      const r = tabs.current.get(drag.id)?.getBoundingClientRect();
      if (r && drag.x >= r.left && drag.x <= r.right) nav.setProject(drag.id);
    }
    if (drag?.active) {
      setLanded(drag.id);
      setTimeout(() => setLanded(undefined), 400);
      const ids = [
        ...shown,
        ...(projects.data ?? []).filter((p) => p.hidden),
      ].map((p) => p.id);
      if (ids.join() !== (projects.data ?? []).map((p) => p.id).join()) {
        qc.setQueryData<ProjectSummary[]>(
          ["projects"],
          (old) =>
            old &&
            ids.map((id) => old.find((p) => p.id === id)!).filter(Boolean),
        );
        reorder.mutate(
          { ids },
          { onError: () => qc.invalidateQueries({ queryKey: ["projects"] }) },
        );
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
        <button
          className="hdr-icon"
          aria-label="Open menu"
          onClick={() => nav.go({ name: "menu" })}
        >
          <Icon name="menu" size={18} stroke={1.4} />
        </button>
        <nav
          ref={bar}
          aria-label="Projects"
          className="tabs-projects"
          // Pointer capture lives on the bar, not the tab: reordering moves the tab's DOM node, which would drop
          // capture mid-drag. Capture keeps events coming outside the window; losing it (release, cancel) ends the drag.
          onPointerMove={onDragMove}
          onLostPointerCapture={onDragEnd}
        >
          {shown.map((p) => (
            <div
              key={p.id}
              ref={(el) =>
                void (el
                  ? tabs.current.set(p.id, el)
                  : tabs.current.delete(p.id))
              }
              className="tab-project"
              data-active={p.id === nav.projectId || undefined}
              data-dragging={(drag?.active && drag.id === p.id) || undefined}
              data-landed={landed === p.id || undefined}
              style={stretch(p.id)}
            >
              <button
                className="tab-project-open"
                aria-pressed={p.id === nav.projectId}
                title="Drag to reorder"
                onPointerDown={(e) => {
                  touch.current = e.pointerType === "touch";
                  if (e.button !== 0) return;
                  if (!touch.current)
                    return startDrag(p.id, e.pointerId, e.clientX, false);
                  const { pointerId, clientX } = e;
                  cancelHold();
                  hold.current = setTimeout(() => {
                    held.current = true;
                    startDrag(p.id, pointerId, clientX, true);
                    navigator.vibrate?.(10);
                  }, LONG_PRESS);
                }}
                // A scroll cancels the pointer; lifting before the hold time is a tap.
                onPointerUp={cancelHold}
                onPointerCancel={cancelHold}
                onContextMenu={(e) => touch.current && e.preventDefault()}
                // Mouse clicks are handled on release (onDragEnd); this covers keyboard and touch.
                onClick={(e) =>
                  (e.detail === 0 || touch.current) && nav.setProject(p.id)
                }
              >
                {p.runningAgents > 0 && (
                  <span className="pulse" title="AI task running" />
                )}
                <FixedWidth>{p.name}</FixedWidth>
              </button>
              <button
                className="tab-project-close"
                aria-label={`Close ${p.name}`}
                title="Close tab (project stays saved)"
                disabled={hide.isPending}
                onClick={() => close(p.id)}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
          {drag?.active && (
            <DragGhost
              drag={drag}
              project={open.find((p) => p.id === drag.id)}
              active={drag.id === nav.projectId}
            />
          )}
          <button
            className="btn btn-ghost btn-icon"
            style={{ height: "auto", width: 42, flex: "none", border: 0, borderRadius: 0 }}
            aria-label="Add project"
            onClick={() => nav.go({ name: "home" })}
          >
            <Icon name="plus" />
          </button>
        </nav>
        <div className="hdr-tools">
          {runningAll > 0 && (
            <button
              className="btn hide-narrow"
              style={{ height: 28 }}
              onClick={() => nav.go({ name: "worktrees" })}
            >
              <span className="pulse" />
              <span className="muted">
                {runningAll} {runningAll === 1 ? "agent" : "agents"} running
              </span>
            </button>
          )}
          <ThemeToggle />
        </div>
      </header>
      <nav ref={pagesBar} aria-label="Pages" className="tabs-pages">
        {/* The accent underline, sliding from the previous page's tab to the new one. */}
        {ink && <span className="tabs-ink" style={ink} aria-hidden />}
        {PAGES.map((p) => {
          const active = nav.route.name === p.route.name;
          return (
            <button
              key={p.label}
              className="tab-page"
              aria-current={active ? "page" : undefined}
              onClick={() => nav.go(p.route)}
            >
              <Icon name={p.icon} size={14} />
              <FixedWidth>{p.label}</FixedWidth>
            </button>
          );
        })}
      </nav>
    </>
  );
}

/** The tab held in the hand while dragging: slides along the bar only, its slot stays as a placeholder. */
function DragGhost({
  drag,
  project,
  active,
}: {
  drag: Drag;
  project?: ProjectSummary;
  active: boolean;
}) {
  if (!project) return null;
  const left = Math.min(
    Math.max(drag.x - drag.ox, drag.minLeft),
    Math.max(drag.minLeft, drag.maxLeft),
  );
  const style: CSSProperties = {
    left,
    top: drag.top,
    width: drag.w,
    height: drag.h,
  };
  return createPortal(
    <div
      className="tab-project tab-ghost"
      data-active={active || undefined}
      style={style}
      aria-hidden
    >
      <span className="tab-project-open">
        {project.runningAgents > 0 && <span className="pulse" />}
        <FixedWidth>{project.name}</FixedWidth>
      </span>
      <span className="tab-project-close">
        <Icon name="close" size={12} />
      </span>
    </div>,
    document.body,
  );
}
