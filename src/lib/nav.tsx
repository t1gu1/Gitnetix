import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { rpc } from "../api/transport";
import type { Kind } from "./kinds";
import { applyTheme, resolveTheme } from "./themes";

export type Route =
  | { name: "home" }
  | { name: "workspace" }
  | { name: "menu" }
  | { name: "settings"; section?: string }
  | { name: "ai" }
  | { name: "notes" }
  | { name: "prs"; number?: number }
  | { name: "templates" }
  | { name: "tickets"; key?: string }
  | { name: "analytics" }
  | { name: "worktrees"; path?: string }
  | { name: "submodules" }
  | { name: "pair" };

/** Screens opened from the menu or a link, with no tab bar of their own: leaving them goes back to where the user came from. */
const DETOURS = new Set<Route["name"]>(["settings", "ai", "templates", "pair"]);

export interface NewItemDraft {
  release?: string;
  /** Branch to start from (and merge back into) when not in a release. */
  from?: string;
  /** Tag to start from instead ("Create a branch from here" on a shipped tag); merges into the default branch. */
  tag?: string;
  ticket?: string;
  description?: string;
  /** A branch type, or "release" to cut a release instead. */
  kind?: Kind | "release";
}

interface Nav {
  route: Route;
  /** `{ name: "menu" }` opens the menu over the current screen; any other route closes it. */
  go: (r: Route) => void;
  /** Leave a detour screen (settings, AI setup…) for the page it was opened from. */
  back: () => void;
  menuOpen: boolean;
  closeMenu: () => void;
  projectId?: string;
  setProject: (id: string | undefined) => void;
  theme: "dark" | "light";
  themePref: string;
  setThemePref: (t: string) => void;
  newItem: NewItemDraft | null;
  openNewItem: (d?: NewItemDraft) => void;
  closeNewItem: () => void;
  selectedBranch?: string;
  selectBranch: (b: string | undefined) => void;
  /** Drop the selection if it is one of these deleted branches and `projectId` is still open. */
  forgetBranches: (projectId: string, branches: string[]) => void;
}

/** Where one project was left: its page, open menu or dialog, selected branch. */
interface View {
  route: Route;
  menuOpen: boolean;
  newItem: NewItemDraft | null;
  selectedBranch?: string;
  /** Page a detour screen goes back to. */
  returnTo: Route | null;
}

/** Key of the view shown while no project is open. */
const NONE = "";
const freshView = (key: string): View => ({ route: key ? { name: "workspace" } : { name: "home" }, menuOpen: false, newItem: null, returnTo: null });

const Ctx = createContext<Nav | null>(null);
const ViewsCtx = createContext<{ views: Record<string, View>; base: Nav } | null>(null);

function systemTheme(): "dark" | "light" {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function NavProvider({ children, initialProject, initialTheme }: { children: ReactNode; initialProject?: string; initialTheme?: string }) {
  const [projectId, setProjectId] = useState<string | undefined>(initialProject);
  const [views, setViews] = useState<Record<string, View>>(() => ({ [initialProject ?? NONE]: freshView(initialProject ?? NONE) }));
  const [themePref, setThemePrefState] = useState(initialTheme ?? "system");
  const [sys, setSys] = useState(systemTheme());
  // Read by work that finishes after the user moved on (e.g. a background cleanup), and by
  // calls made right after `setProject` in the same handler, which act on the new project.
  const projectRef = useRef(projectId);
  const viewsRef = useRef(views);

  useEffect(() => {
    const m = matchMedia("(prefers-color-scheme: light)");
    const h = () => setSys(systemTheme());
    m.addEventListener("change", h);
    return () => m.removeEventListener("change", h);
  }, []);

  const shown = resolveTheme(themePref, sys);
  const theme = shown.light ? "light" : "dark";
  useEffect(() => applyTheme(shown), [shown]);

  /** Change the view of the open project (or of `key`). */
  const update = useCallback((f: (v: View) => View, key = projectRef.current ?? NONE) => {
    const next = { ...viewsRef.current, [key]: f(viewsRef.current[key] ?? freshView(key)) };
    viewsRef.current = next;
    setViews(next);
  }, []);

  const setProject = useCallback(
    (id: string | undefined) => {
      projectRef.current = id;
      setProjectId(id);
      if (!viewsRef.current[id ?? NONE]) update((v) => v, id ?? NONE);
      if (id) rpc("ui.set", { lastProject: id }).catch(() => {});
    },
    [update],
  );

  const go = useCallback(
    (r: Route) =>
      update((v) => {
        if (r.name === "menu") return { ...v, menuOpen: true };
        return { ...v, menuOpen: false, route: r, returnTo: DETOURS.has(v.route.name) ? v.returnTo : v.route };
      }),
    [update],
  );
  const back = useCallback(() => {
    const v = viewsRef.current[projectRef.current ?? NONE];
    go(v?.returnTo ?? (projectRef.current ? { name: "workspace" } : { name: "home" }));
  }, [go]);
  const closeMenu = useCallback(() => update((v) => ({ ...v, menuOpen: false })), [update]);
  const openNewItem = useCallback((d?: NewItemDraft) => update((v) => ({ ...v, newItem: d ?? {} })), [update]);
  const closeNewItem = useCallback(() => update((v) => ({ ...v, newItem: null })), [update]);
  const selectBranch = useCallback((b: string | undefined) => update((v) => ({ ...v, selectedBranch: b })), [update]);
  const forgetBranches = useCallback(
    (id: string, branches: string[]) => update((v) => (v.selectedBranch && branches.includes(v.selectedBranch) ? { ...v, selectedBranch: undefined } : v), id),
    [update],
  );

  const setThemePref = useCallback((t: string) => {
    setThemePrefState(t);
    rpc("ui.set", { theme: t }).catch(() => {});
  }, []);

  const base = useMemo<Nav>(() => {
    const v = views[projectId ?? NONE] ?? freshView(projectId ?? NONE);
    return {
      route: v.route,
      go,
      back,
      menuOpen: v.menuOpen,
      closeMenu,
      projectId,
      setProject,
      theme,
      themePref,
      setThemePref,
      newItem: v.newItem,
      openNewItem,
      closeNewItem,
      selectedBranch: v.selectedBranch,
      selectBranch,
      forgetBranches,
    };
  }, [views, projectId, go, back, closeMenu, setProject, theme, themePref, setThemePref, openNewItem, closeNewItem, selectBranch, forgetBranches]);
  const all = useMemo(() => ({ views, base }), [views, base]);
  return (
    <ViewsCtx.Provider value={all}>
      <Ctx.Provider value={base}>{children}</Ctx.Provider>
    </ViewsCtx.Provider>
  );
}

/** Keys of the projects whose view has been opened this session ("" for no project). */
export function useVisited() {
  const v = useContext(ViewsCtx);
  if (!v) throw new Error("useVisited outside NavProvider");
  return Object.keys(v.views);
}

/**
 * Show `children` as project `projectKey` was left ("" for no project): its own page,
 * menu, dialog and selection, even while another project is the open one. Actions still
 * go to the open project, which is the only one whose screens can be used.
 */
export function ProjectView({ projectKey, children }: { projectKey: string; children: ReactNode }) {
  const all = useContext(ViewsCtx);
  if (!all) throw new Error("ProjectView outside NavProvider");
  const { views, base } = all;
  const v = views[projectKey] ?? freshView(projectKey);
  const value = useMemo<Nav>(
    () => ({ ...base, projectId: projectKey || undefined, route: v.route, menuOpen: v.menuOpen, newItem: v.newItem, selectedBranch: v.selectedBranch }),
    [base, projectKey, v],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNav() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useNav outside NavProvider");
  return v;
}
