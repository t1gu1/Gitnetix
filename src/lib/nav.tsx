import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { rpc } from "../api/transport";
import type { Kind } from "./kinds";

export type Route =
  | { name: "home" }
  | { name: "workspace" }
  | { name: "menu" }
  | { name: "settings"; section?: string }
  | { name: "ai" }
  | { name: "notes" }
  | { name: "prs"; number?: number }
  | { name: "templates" }
  | { name: "tickets" }
  | { name: "analytics" }
  | { name: "worktrees"; path?: string }
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

const Ctx = createContext<Nav | null>(null);

function systemTheme(): "dark" | "light" {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function NavProvider({ children, initialProject, initialTheme }: { children: ReactNode; initialProject?: string; initialTheme?: string }) {
  const [route, setRoute] = useState<Route>(initialProject ? { name: "workspace" } : { name: "home" });
  const [menuOpen, setMenuOpen] = useState(false);
  const [projectId, setProjectId] = useState<string | undefined>(initialProject);
  const [themePref, setThemePrefState] = useState(initialTheme ?? "system");
  const [sys, setSys] = useState(systemTheme());
  const [newItem, setNewItem] = useState<NewItemDraft | null>(null);
  const [selectedBranch, selectBranch] = useState<string | undefined>();
  const routeRef = useRef(route);
  const returnTo = useRef<Route | null>(null);

  useEffect(() => {
    const m = matchMedia("(prefers-color-scheme: light)");
    const h = () => setSys(systemTheme());
    m.addEventListener("change", h);
    return () => m.removeEventListener("change", h);
  }, []);

  const theme = themePref === "light" || themePref === "dark" ? themePref : sys;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Read by work that finishes after the user moved on (e.g. a background cleanup).
  const projectRef = useRef(projectId);
  const setProject = useCallback((id: string | undefined) => {
    projectRef.current = id;
    setProjectId(id);
    selectBranch(undefined);
    if (id) rpc("ui.set", { lastProject: id }).catch(() => {});
  }, []);

  const go = useCallback((r: Route) => {
    if (r.name === "menu") return setMenuOpen(true);
    setMenuOpen(false);
    if (!DETOURS.has(routeRef.current.name)) returnTo.current = routeRef.current;
    routeRef.current = r;
    setRoute(r);
  }, []);
  const back = useCallback(() => {
    go(returnTo.current ?? (projectId ? { name: "workspace" } : { name: "home" }));
  }, [go, projectId]);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const forgetBranches = useCallback((id: string, branches: string[]) => {
    if (projectRef.current === id) selectBranch((b) => (b && branches.includes(b) ? undefined : b));
  }, []);

  const setThemePref = useCallback((t: string) => {
    setThemePrefState(t);
    rpc("ui.set", { theme: t }).catch(() => {});
  }, []);

  const value = useMemo<Nav>(
    () => ({
      route,
      go,
      back,
      menuOpen,
      closeMenu,
      projectId,
      setProject,
      theme,
      themePref,
      setThemePref,
      newItem,
      openNewItem: (d) => setNewItem(d ?? {}),
      closeNewItem: () => setNewItem(null),
      selectedBranch,
      selectBranch,
      forgetBranches,
    }),
    [route, go, back, menuOpen, closeMenu, projectId, setProject, theme, themePref, setThemePref, newItem, selectedBranch],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNav() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useNav outside NavProvider");
  return v;
}
