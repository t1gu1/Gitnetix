import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { rpc } from "../api/transport";

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

export interface NewItemDraft {
  release?: string;
  ticket?: string;
  description?: string;
  kind?: "feat" | "fix";
}

interface Nav {
  route: Route;
  /** `{ name: "menu" }` opens the menu over the current screen; any other route closes it. */
  go: (r: Route) => void;
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

  const setProject = useCallback((id: string | undefined) => {
    setProjectId(id);
    selectBranch(undefined);
    if (id) rpc("ui.set", { lastProject: id }).catch(() => {});
  }, []);

  const go = useCallback((r: Route) => {
    if (r.name === "menu") return setMenuOpen(true);
    setMenuOpen(false);
    setRoute(r);
  }, []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  const setThemePref = useCallback((t: string) => {
    setThemePrefState(t);
    rpc("ui.set", { theme: t }).catch(() => {});
  }, []);

  const value = useMemo<Nav>(
    () => ({
      route,
      go,
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
    }),
    [route, go, menuOpen, closeMenu, projectId, setProject, theme, themePref, setThemePref, newItem, selectedBranch],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNav() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useNav outside NavProvider");
  return v;
}
