import { Activity, type ReactNode, useRef, useState } from "react";

import { useConfig, useEngineEvents, useProjects } from "./api/hooks";
import { currentRemote, isLocal } from "./api/transport";
import { ContextMenu, type MenuItem } from "./components/ContextMenu";
import { Icon } from "./components/Icon";
import { TooltipLayer } from "./components/Tooltip";
import { isPageRoute, PAGES, TopBar } from "./components/TopBar";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { Loading, useThumb } from "./components/ui";
import { Dictation } from "./lib/dictation";
import { useApplyAnimations } from "./lib/motion";
import { NavProvider, ProjectView, useNav, useVisited, type Route } from "./lib/nav";
import { Toasts } from "./lib/toast";
import { useZoomKeys } from "./lib/zoom";
import { AISetup } from "./screens/AISetup";
import { Analytics } from "./screens/Analytics";
import { Menu } from "./screens/Menu";
import { NewItem } from "./screens/NewItem";
import { Pair } from "./screens/Pair";
import { PullRequests } from "./screens/PullRequests";
import { ReleaseNotes } from "./screens/ReleaseNotes";
import { Settings } from "./screens/Settings";
import { Submodules } from "./screens/Submodules";
import { Templates } from "./screens/Templates";
import { Tickets } from "./screens/Tickets";
import { Welcome } from "./screens/Welcome";
import { Workspace } from "./screens/Workspace";
import { Worktrees } from "./screens/Worktrees";

export function App() {
  const [paired, setPaired] = useState(isLocal || !!currentRemote());
  if (!paired) return <Pair onPaired={() => setPaired(true)} />;
  return <Engine onUnpair={() => setPaired(false)} />;
}

function Engine({ onUnpair }: { onUnpair: () => void }) {
  const cfg = useConfig();
  useEngineEvents();
  useApplyAnimations(cfg.data?.ui.animationsOff);
  useZoomKeys();
  if (cfg.isLoading) return <Loading />;
  // Reload, not refetch: the event stream above is still open to the address that failed.
  if (cfg.error && !isLocal) return <Pair onPaired={() => location.reload()} error={cfg.error.message} />;
  const c = cfg.data;
  const open = c?.projects.filter((p) => !p.hidden) ?? [];
  const last = c?.ui.lastProject && open.some((p) => p.id === c.ui.lastProject) ? c.ui.lastProject : open[0]?.id;
  return (
    <NavProvider initialProject={last ?? undefined} initialTheme={c?.ui.theme}>
      <Shell onUnpair={onUnpair} />
    </NavProvider>
  );
}

const MOBILE_TABS: { route: Route; label: string; icon: string }[] = [
  { route: { name: "workspace" }, label: "Releases", icon: "tag" },
  { route: { name: "worktrees" }, label: "Agents", icon: "layers" },
  { route: { name: "prs" }, label: "PRs", icon: "pr" },
  { route: { name: "tickets" }, label: "Tickets", icon: "ticket" },
];
/** Pages without a bottom tab, listed under "More" since the page tabs are hidden on mobile. */
const MORE_PAGES = PAGES.filter((p) => !MOBILE_TABS.some((t) => t.route.name === p.route.name));

function Shell({ onUnpair }: { onUnpair: () => void }) {
  const nav = useNav();
  const r = nav.route;
  const projects = useProjects().data;
  // Every project opened this session keeps its screens mounted (hidden while another is open),
  // so coming back to it finds the same page, dialog, scroll and filters.
  const open = new Set(projects?.filter((p) => !p.hidden).map((p) => p.id));
  const keys = useVisited().filter((k) => k === (nav.projectId ?? "") || open.has(k));
  const each = (render: () => ReactNode) =>
    keys.map((k) => (
      <Activity key={k} mode={k === (nav.projectId ?? "") ? "visible" : "hidden"}>
        <ProjectView projectKey={k}>{render()}</ProjectView>
      </Activity>
    ));
  const pairing = r.name === "pair";
  return (
    <>
      {/* Pairing takes the whole window, so the camera preview shows behind its see-through page; the app stays mounted, hidden. */}
      <Activity mode={pairing ? "hidden" : "visible"}>
        <div className="ag app">
          <div className="app-main">
            {nav.projectId && isPageRoute(r) && <TopBar />}
            {each(() => <Screen onUnpair={onUnpair} />)}
          </div>
          {nav.projectId && <MobileTabs />}
          {each(() => <NewItemDialog />)}
          <UpdatePrompt />
          <Toasts />
          <Dictation />
          <TooltipLayer />
        </div>
      </Activity>
      {/* Another desktop, or the same one at a new address: reload so events and projects start over against it. */}
      {pairing && <Pair scan onBack={nav.back} onPaired={() => location.reload()} />}
    </>
  );
}

function MobileTabs() {
  const nav = useNav();
  const r = nav.route;
  const bar = useRef<HTMLElement>(null);
  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  const inMore = MORE_PAGES.some((p) => p.route.name === r.name);
  const tab = inMore ? MOBILE_TABS.length : MOBILE_TABS.findIndex((t) => t.route.name === r.name);
  // The bubble behind the current tab's icon, sliding from the previous one; none while the menu is open.
  const bubble = useThumb(bar, nav.menuOpen ? -1 : tab, MOBILE_TABS.length + 1, ":scope > button > span");
  // Off the desktop: re-pair, e.g. once the desktop's address or port changed.
  const pair: MenuItem[] = isLocal ? [] : ["sep", { id: "pair", label: "Scan pairing QR code", icon: "qr", run: () => nav.go({ name: "pair" }) }];
  return (
    <nav
      ref={bar}
      className="mobile-tabs"
      aria-label="Sections"
      // Dragging across the bar opens the tab under the pointer, like Seg.
      // Touch captures the pressed button, whose click on release would undo the drag.
      onPointerDown={(e) => (e.target as Element).releasePointerCapture(e.pointerId)}
      onPointerMove={(e) => {
        if (!e.buttons) return;
        const btn = document.elementFromPoint(e.clientX, e.clientY)?.closest(".mobile-tabs > button");
        const t = btn && MOBILE_TABS[[...e.currentTarget.querySelectorAll(":scope > button")].indexOf(btn)];
        if (t && (nav.menuOpen || r.name !== t.route.name)) nav.go(t.route);
      }}
    >
      {bubble && <span className="mobile-tabs-bubble" style={bubble} aria-hidden />}
      {MOBILE_TABS.map((t) => (
        <button key={t.label} aria-pressed={!nav.menuOpen && r.name === t.route.name} onClick={() => nav.go(t.route)}>
          <span>
            <Icon name={t.icon} size={18} />
          </span>
          {t.label}
        </button>
      ))}
      <button
        aria-haspopup="menu"
        aria-pressed={!nav.menuOpen && inMore}
        onClick={(e) => {
          const b = e.currentTarget.getBoundingClientRect();
          // Inset from the screen edge, which the menu would otherwise hug at its 8px minimum.
          setMore({ x: b.right - 16, y: b.top - 2 });
        }}
      >
        <span>
          <Icon name="more" size={18} />
        </span>
        More
      </button>
      {more && (
        <ContextMenu
          {...more}
          alignRight
          label="More pages"
          items={[...MORE_PAGES.map((p): MenuItem => ({ id: p.route.name, label: p.label, icon: p.icon, run: () => nav.go(p.route) })), ...pair]}
          onClose={() => setMore(null)}
        />
      )}
    </nav>
  );
}

function NewItemDialog() {
  const nav = useNav();
  return nav.newItem && <NewItem draft={nav.newItem} onClose={nav.closeNewItem} />;
}

/** The page of the project this sits under, with its menu when open. */
function Screen({ onUnpair }: { onUnpair: () => void }) {
  const nav = useNav();
  const r = nav.route;
  let screen;
  switch (r.name) {
    case "home":
      screen = <Welcome />;
      break;
    case "workspace":
      screen = nav.projectId ? <Workspace /> : <Welcome />;
      break;
    case "settings":
      screen = <Settings key={r.section} section={r.section} />;
      break;
    case "ai":
      screen = <AISetup />;
      break;
    case "notes":
      screen = <ReleaseNotes />;
      break;
    case "prs":
      screen = <PullRequests initial={r.number} />;
      break;
    case "templates":
      screen = <Templates />;
      break;
    case "tickets":
      screen = <Tickets initial={r.key} />;
      break;
    case "analytics":
      screen = <Analytics />;
      break;
    case "worktrees":
      screen = <Worktrees initial={r.key} />;
      break;
    case "submodules":
      screen = nav.projectId ? <Submodules /> : <Welcome />;
      break;
  }
  return (
    <>
      {screen}
      {nav.menuOpen && <Menu onUnpair={onUnpair} />}
    </>
  );
}
