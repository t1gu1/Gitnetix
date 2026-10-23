import { Icon } from "./Icon";
import { useNav } from "../lib/nav";

export function ThemeToggle() {
  const nav = useNav();
  return (
    <button
      className="btn btn-ghost btn-icon theme-toggle"
      // full-height square on the header's right edge; .hdr-tools drops its padding for it (app.css)
      style={{ height: "auto", width: 42, alignSelf: "stretch", border: 0, borderLeft: "1px solid var(--line)", borderRadius: 0 }}
      aria-label="Switch light / dark"
      onClick={() => nav.setThemePref(nav.theme === "dark" ? "light" : "dark")}
    >
      <Icon name={nav.theme === "dark" ? "sun" : "moon"} size={15} stroke={1.4} />
    </button>
  );
}
