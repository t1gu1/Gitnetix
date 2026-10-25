import { Icon } from "./Icon";
import { useNav } from "../lib/nav";
import { resolveTheme, THEMES } from "../lib/themes";

export function ThemeToggle() {
  const nav = useNav();
  const cur = resolveTheme(nav.themePref, nav.theme);
  // The same theme's other mode, same contrast when it has one (Gruvbox Dark Hard → Light Hard, Catppuccin Mocha → Latte); Gitnetix's when it has none.
  const other = THEMES.filter((t) => t.family === cur.family && t.light !== cur.light);
  const bare = (name: string) => name.replace(/Dark|Light/, "");
  const next = (other.find((t) => bare(t.name) === bare(cur.name)) ?? other[0])?.id ?? (cur.light ? "dark" : "light");
  return (
    <button
      className="btn btn-ghost btn-icon theme-toggle"
      // full-height square on the header's right edge; .hdr-tools drops its padding for it (app.css)
      style={{ height: "auto", width: 42, alignSelf: "stretch", border: 0, borderLeft: "1px solid var(--line)", borderRadius: 0 }}
      aria-label="Switch light / dark"
      onClick={() => nav.setThemePref(next)}
    >
      <Icon name={nav.theme === "dark" ? "sun" : "moon"} size={15} stroke={1.4} />
    </button>
  );
}
