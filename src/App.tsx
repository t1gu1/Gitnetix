import { useState } from "react";

import { useConfig, useEngineEvents } from "./api/hooks";
import { currentRemote, isLocal } from "./api/transport";
import { Icon } from "./components/Icon";
import { TooltipLayer } from "./components/Tooltip";
import { isPageRoute, TopBar } from "./components/TopBar";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { Loading } from "./components/ui";
import { NavProvider, useNav, type Route } from "./lib/nav";
import { Toasts } from "./lib/toast";
import { AISetup } from "./screens/AISetup";
import { Analytics } from "./screens/Analytics";
import { Menu } from "./screens/Menu";
import { NewItem } from "./screens/NewItem";
import { Pair } from "./screens/Pair";
import { PullRequests } from "./screens/PullRequests";
import { ReleaseNotes } from "./screens/ReleaseNotes";
import { Settings } from "./screens/Settings";
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
  if (cfg.isLoading) return <Loading />;
  if (cfg.error && !isLocal) return <Pair onPaired={() => cfg.refetch()} error={cfg.error.message} />;
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
  { route: { name: "menu" }, label: "More", icon: "menu" },
];

function Shell({ onUnpair }: { onUnpair: () => void }) {
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
      screen = <Tickets />;
      break;
    case "analytics":
      screen = <Analytics />;
      break;
    case "worktrees":
      screen = <Worktrees initial={r.path} />;
      break;
    case "pair":
      screen = <Pair onPaired={() => nav.go({ name: "workspace" })} />;
      break;
  }
  return (
    <div className="ag app">
      <div className="app-main">
        {nav.projectId && isPageRoute(r) && <TopBar />}
        {screen}
        {nav.menuOpen && <Menu onUnpair={onUnpair} />}
      </div>
      {nav.projectId && (
        <nav className="mobile-tabs" aria-label="Sections">
          {MOBILE_TABS.map((t) => (
            <button key={t.label} aria-pressed={t.route.name === "menu" ? nav.menuOpen : !nav.menuOpen && r.name === t.route.name} onClick={() => nav.go(t.route)}>
              <Icon name={t.icon} size={18} />
              {t.label}
            </button>
          ))}
        </nav>
      )}
      {nav.newItem && <NewItem draft={nav.newItem} onClose={nav.closeNewItem} />}
      <UpdatePrompt />
      <Toasts />
      <TooltipLayer />
    </div>
  );
}
