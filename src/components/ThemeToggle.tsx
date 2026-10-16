import { Icon } from "./Icon";
import { useNav } from "../lib/nav";

export function ThemeToggle() {
  const nav = useNav();
  return (
    <button
      className="btn btn-icon"
      style={{ height: 28 }}
      aria-label="Switch light / dark"
      onClick={() => nav.setThemePref(nav.theme === "dark" ? "light" : "dark")}
    >
      <Icon name={nav.theme === "dark" ? "sun" : "moon"} size={15} stroke={1.4} />
    </button>
  );
}
