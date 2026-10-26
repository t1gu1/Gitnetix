/** A color theme: its surfaces, text and accent, plus the terminal's 16 colors. The app's other colors are mixed from these. */
export interface Theme {
  id: string;
  name: string;
  /** Versions of one theme share it; the light / dark toggle moves between them. */
  family: string;
  light: boolean;
  /** Behind the panels. */
  bg: string;
  /** Panels and the terminal. */
  panel: string;
  fg: string;
  /** Secondary and faint text; mixed from `fg` when the theme has no tone for them. */
  muted?: string;
  faint?: string;
  accent: string;
  /** Text on the accent; `bg` (dark) or `panel` (light) when unset. */
  onAccent?: string;
  /** The default branch. */
  trunk: string;
  /** ANSI black, red, green, yellow, blue, magenta, cyan, white, then their bright versions: hex without "#". */
  ansi: string;
}

// The two Gitnetix themes keep the ids of the old light / dark preference; their colors live in app.css.
export const THEMES: Theme[] = [
  { id: "dark", name: "Gitnetix Dark", family: "Gitnetix", light: false, bg: "#0e0f11", panel: "#15171a", fg: "#e8e9eb", muted: "#a0a5ae", faint: "#7a808a", accent: "#f0a43a", trunk: "#f7c48a",
    ansi: "1c1f23 ff7b72 62d6ae e3b45a 86aeff c4a7ff 5fd0e0 c9ccd1 7a808a ff9089 7ee8c2 f5b65c a5c3ff d6c0ff 8ae3ef ffffff" },
  { id: "light", name: "Gitnetix Light", family: "Gitnetix", light: true, bg: "#f3f3f1", panel: "#ffffff", fg: "#16171a", muted: "#575c65", faint: "#787d86", accent: "#f6b860", trunk: "#a85a12",
    ansi: "16171a b0271f 17744d 8a5a00 2452c2 6b46c1 0e7490 a0a5ae 575c65 d1352b 1f9463 a86f00 3b6be0 8257e0 1592b0 787d86" },

  { id: "catppuccin-mocha", name: "Catppuccin Mocha", family: "Catppuccin", light: false, bg: "#181825", panel: "#1e1e2e", fg: "#cdd6f4", muted: "#a6adc8", faint: "#7f849c", accent: "#cba6f7", trunk: "#fab387",
    ansi: "45475a f38ba8 a6e3a1 f9e2af 89b4fa f5c2e7 94e2d5 bac2de 585b70 f38ba8 a6e3a1 f9e2af 89b4fa f5c2e7 94e2d5 a6adc8" },
  { id: "catppuccin-macchiato", name: "Catppuccin Macchiato", family: "Catppuccin", light: false, bg: "#1e2030", panel: "#24273a", fg: "#cad3f5", muted: "#a5adcb", faint: "#8087a2", accent: "#c6a0f6", trunk: "#f5a97f",
    ansi: "494d64 ed8796 a6da95 eed49f 8aadf4 f5bde6 8bd5ca b8c0e0 5b6078 ed8796 a6da95 eed49f 8aadf4 f5bde6 8bd5ca a5adcb" },
  { id: "catppuccin-frappe", name: "Catppuccin Frappé", family: "Catppuccin", light: false, bg: "#292c3c", panel: "#303446", fg: "#c6d0f5", muted: "#a5adce", faint: "#838ba7", accent: "#ca9ee6", trunk: "#ef9f76",
    ansi: "51576d e78284 a6d189 e5c890 8caaee f4b8e4 81c8be b5bfe2 626880 e78284 a6d189 e5c890 8caaee f4b8e4 81c8be a5adce" },
  { id: "catppuccin-latte", name: "Catppuccin Latte", family: "Catppuccin", light: true, bg: "#e6e9ef", panel: "#eff1f5", fg: "#4c4f69", muted: "#6c6f85", faint: "#8c8fa1", accent: "#8839ef", trunk: "#fe640b",
    ansi: "5c5f77 d20f39 40a02b df8e1d 1e66f5 ea76cb 179299 acb0be 6c6f85 d20f39 40a02b df8e1d 1e66f5 ea76cb 179299 bcc0cc" },

  { id: "rose-pine", name: "Rosé Pine", family: "Rosé Pine", light: false, bg: "#191724", panel: "#1f1d2e", fg: "#e0def4", muted: "#908caa", faint: "#6e6a86", accent: "#ebbcba", trunk: "#f6c177",
    ansi: "26233a eb6f92 31748f f6c177 9ccfd8 c4a7e7 ebbcba e0def4 6e6a86 eb6f92 31748f f6c177 9ccfd8 c4a7e7 ebbcba e0def4" },
  { id: "rose-pine-moon", name: "Rosé Pine Moon", family: "Rosé Pine", light: false, bg: "#232136", panel: "#2a273f", fg: "#e0def4", muted: "#908caa", faint: "#6e6a86", accent: "#ea9a97", trunk: "#f6c177",
    ansi: "393552 eb6f92 3e8fb0 f6c177 9ccfd8 c4a7e7 ea9a97 e0def4 6e6a86 eb6f92 3e8fb0 f6c177 9ccfd8 c4a7e7 ea9a97 e0def4" },
  // Pine, not rose, for the accent: light text on Dawn's rose is hard to read.
  { id: "rose-pine-dawn", name: "Rosé Pine Dawn", family: "Rosé Pine", light: true, bg: "#faf4ed", panel: "#fffaf3", fg: "#575279", muted: "#797593", faint: "#9893a5", accent: "#286983", trunk: "#d7827e",
    ansi: "f2e9e1 b4637a 286983 ea9d34 56949f 907aa9 d7827e 575279 9893a5 b4637a 286983 ea9d34 56949f 907aa9 d7827e 575279" },

  { id: "tokyo-night", name: "Tokyo Night", family: "Tokyo Night", light: false, bg: "#16161e", panel: "#1a1b26", fg: "#c0caf5", muted: "#a9b1d6", faint: "#737aa2", accent: "#7aa2f7", trunk: "#ff9e64",
    ansi: "15161e f7768e 9ece6a e0af68 7aa2f7 bb9af7 7dcfff a9b1d6 414868 f7768e 9ece6a e0af68 7aa2f7 bb9af7 7dcfff c0caf5" },
  { id: "tokyo-night-storm", name: "Tokyo Night Storm", family: "Tokyo Night", light: false, bg: "#1f2335", panel: "#24283b", fg: "#c0caf5", muted: "#a9b1d6", faint: "#737aa2", accent: "#7aa2f7", trunk: "#ff9e64",
    ansi: "1d202f f7768e 9ece6a e0af68 7aa2f7 bb9af7 7dcfff a9b1d6 414868 f7768e 9ece6a e0af68 7aa2f7 bb9af7 7dcfff c0caf5" },
  { id: "tokyo-night-moon", name: "Tokyo Night Moon", family: "Tokyo Night", light: false, bg: "#1e2030", panel: "#222436", fg: "#c8d3f5", muted: "#828bb8", faint: "#636da6", accent: "#82aaff", trunk: "#ff966c",
    ansi: "1b1d2b ff757f c3e88d ffc777 82aaff c099ff 86e1fc 828bb8 444a73 ff757f c3e88d ffc777 82aaff c099ff 86e1fc c8d3f5" },
  { id: "tokyo-night-day", name: "Tokyo Night Day", family: "Tokyo Night", light: true, bg: "#d0d5e3", panel: "#e1e2e7", fg: "#3760bf", muted: "#6172b0", faint: "#848cb5", accent: "#2e7de9", trunk: "#b15c00",
    ansi: "e9e9ed f52a65 587539 8c6c3e 2e7de9 9854f1 007197 6172b0 a1a6c5 f52a65 587539 8c6c3e 2e7de9 9854f1 007197 3760bf" },

  { id: "dracula", name: "Dracula", family: "Dracula", light: false, bg: "#21222c", panel: "#282a36", fg: "#f8f8f2", faint: "#6272a4", accent: "#bd93f9", trunk: "#ffb86c",
    ansi: "21222c ff5555 50fa7b f1fa8c bd93f9 ff79c6 8be9fd f8f8f2 6272a4 ff6e6e 69ff94 ffffa5 d6acff ff92df a4ffff ffffff" },
  { id: "dracula-alucard", name: "Dracula Alucard", family: "Dracula", light: true, bg: "#f5f0dc", panel: "#fffbeb", fg: "#1f1f1f", faint: "#635d97", accent: "#644ac9", trunk: "#a34d14",
    ansi: "1f1f1f cb3a2a 14710a 846e15 644ac9 a3144d 036a96 6c664b 635d97 cb3a2a 14710a 846e15 644ac9 a3144d 036a96 1f1f1f" },

  { id: "night-owl", name: "Night Owl", family: "Night Owl", light: false, bg: "#010e1a", panel: "#011627", fg: "#d6deeb", faint: "#5f7e97", accent: "#c792ea", trunk: "#f78c6c",
    ansi: "011627 ef5350 22da6e c5e478 82aaff c792ea 21c7a8 ffffff 575656 ef5350 22da6e ffeb95 82aaff c792ea 7fdbca ffffff" },
  { id: "light-owl", name: "Light Owl", family: "Night Owl", light: true, bg: "#f0f0f0", panel: "#fbfbfb", fg: "#403f53", accent: "#994cc3", trunk: "#c96765",
    ansi: "403f53 de3d3b 08916a e0af02 288ed7 d6438a 2aa298 f0f0f0 403f53 de3d3b 08916a daaa01 288ed7 d6438a 2aa298 f0f0f0" },

  { id: "nord", name: "Nord", family: "Nord", light: false, bg: "#272c36", panel: "#2e3440", fg: "#d8dee9", accent: "#88c0d0", trunk: "#d08770",
    ansi: "3b4252 bf616a a3be8c ebcb8b 81a1c1 b48ead 88c0d0 e5e9f0 4c566a bf616a a3be8c ebcb8b 81a1c1 b48ead 8fbcbb eceff4" },

  { id: "ayu-dark", name: "Ayu Dark", family: "Ayu", light: false, bg: "#0b0e14", panel: "#0d1017", fg: "#bfbdb6", accent: "#e6b450", trunk: "#ff8f40",
    ansi: "01060e ea6c73 91b362 f9af4f 53bdfa d2a6ff 90e1c6 c7c7c7 686868 f07178 c2d94c ffb454 59c2ff d2a6ff 95e6cb ffffff" },
  { id: "ayu-mirage", name: "Ayu Mirage", family: "Ayu", light: false, bg: "#1f2430", panel: "#242936", fg: "#cccac2", accent: "#ffcc66", trunk: "#ffad66",
    ansi: "191e2a ed8274 a6cc70 fad07b 6dcbfa cfbafa 90e1c6 c7c7c7 686868 f28779 bae67e ffd580 73d0ff d4bfff 95e6cb ffffff" },
  { id: "ayu-light", name: "Ayu Light", family: "Ayu", light: true, bg: "#f8f9fa", panel: "#fcfcfc", fg: "#5c6166", accent: "#ffaa33", onAccent: "#0b0e14", trunk: "#fa8d3e",
    ansi: "000000 ea6c6d 6cbf43 eca944 3199e1 9e75c7 46ba94 bababa 686868 f07171 86b300 f2ae49 399ee6 a37acc 4cbf99 d1d1d1" },

  // Hard / Medium / Soft only change the backgrounds.
  { id: "everforest-dark-hard", name: "Everforest Dark Hard", family: "Everforest", light: false, bg: "#1e2326", panel: "#272e33", fg: "#d3c6aa", muted: "#9da9a0", faint: "#859289", accent: "#a7c080", trunk: "#e69875",
    ansi: "414b50 e67e80 a7c080 dbbc7f 7fbbb3 d699b6 83c092 d3c6aa 859289 e67e80 a7c080 dbbc7f 7fbbb3 d699b6 83c092 d3c6aa" },
  { id: "everforest-dark", name: "Everforest Dark Medium", family: "Everforest", light: false, bg: "#232a2e", panel: "#2d353b", fg: "#d3c6aa", muted: "#9da9a0", faint: "#859289", accent: "#a7c080", trunk: "#e69875",
    ansi: "475258 e67e80 a7c080 dbbc7f 7fbbb3 d699b6 83c092 d3c6aa 859289 e67e80 a7c080 dbbc7f 7fbbb3 d699b6 83c092 d3c6aa" },
  { id: "everforest-dark-soft", name: "Everforest Dark Soft", family: "Everforest", light: false, bg: "#293136", panel: "#333c43", fg: "#d3c6aa", muted: "#9da9a0", faint: "#859289", accent: "#a7c080", trunk: "#e69875",
    ansi: "4d5960 e67e80 a7c080 dbbc7f 7fbbb3 d699b6 83c092 d3c6aa 859289 e67e80 a7c080 dbbc7f 7fbbb3 d699b6 83c092 d3c6aa" },
  { id: "everforest-light-hard", name: "Everforest Light Hard", family: "Everforest", light: true, bg: "#f2efdf", panel: "#fffbef", fg: "#5c6a72", accent: "#8da101", onAccent: "#2d353b", trunk: "#f57d26",
    ansi: "5c6a72 f85552 8da101 dfa000 3a94c5 df69ba 35a77c a6b0a0 939f91 f85552 8da101 dfa000 3a94c5 df69ba 35a77c 829181" },
  { id: "everforest-light", name: "Everforest Light Medium", family: "Everforest", light: true, bg: "#efebd4", panel: "#fdf6e3", fg: "#5c6a72", accent: "#8da101", onAccent: "#2d353b", trunk: "#f57d26",
    ansi: "5c6a72 f85552 8da101 dfa000 3a94c5 df69ba 35a77c a6b0a0 939f91 f85552 8da101 dfa000 3a94c5 df69ba 35a77c 829181" },
  { id: "everforest-light-soft", name: "Everforest Light Soft", family: "Everforest", light: true, bg: "#e5dfc5", panel: "#f3ead3", fg: "#5c6a72", accent: "#8da101", onAccent: "#2d353b", trunk: "#f57d26",
    ansi: "5c6a72 f85552 8da101 dfa000 3a94c5 df69ba 35a77c a6b0a0 939f91 f85552 8da101 dfa000 3a94c5 df69ba 35a77c 829181" },

  { id: "kanagawa-wave", name: "Kanagawa Wave", family: "Kanagawa", light: false, bg: "#16161d", panel: "#1f1f28", fg: "#dcd7ba", faint: "#727169", accent: "#7e9cd8", trunk: "#ffa066",
    ansi: "16161d c34043 76946a c0a36e 7e9cd8 957fb8 6a9589 c8c093 727169 e82424 98bb6c e6c384 7fb4ca 938aa9 7aa89f dcd7ba" },
  { id: "kanagawa-dragon", name: "Kanagawa Dragon", family: "Kanagawa", light: false, bg: "#12120f", panel: "#181616", fg: "#c5c9c5", muted: "#a6a69c", faint: "#737c73", accent: "#8ba4b0", trunk: "#b6927b",
    ansi: "0d0c0c c4746e 8a9a7b c4b28a 8ba4b0 a292a3 8ea4a2 c8c093 a6a69c e46876 87a987 e6c384 7fb4ca 938aa9 7aa89f c5c9c5" },
  { id: "kanagawa-lotus", name: "Kanagawa Lotus", family: "Kanagawa", light: true, bg: "#e5ddb0", panel: "#f2ecbc", fg: "#545464", muted: "#716e61", faint: "#8a8980", accent: "#4d699b", trunk: "#cc6d00",
    ansi: "1f1f28 c84053 6f894e 77713f 4d699b b35b79 597b75 545464 8a8980 d7474b 6e915f 836f4a 6693bf 624c83 5e857a 43436c" },

  // Gruvbox has no tone darker than Dark Hard's bg0_h: its bg is mixed by hand.
  { id: "gruvbox-dark-hard", name: "Gruvbox Dark Hard", family: "Gruvbox", light: false, bg: "#141617", panel: "#1d2021", fg: "#ebdbb2", muted: "#bdae93", faint: "#928374", accent: "#fabd2f", trunk: "#fe8019",
    ansi: "1d2021 cc241d 98971a d79921 458588 b16286 689d6a a89984 928374 fb4934 b8bb26 fabd2f 83a598 d3869b 8ec07c ebdbb2" },
  { id: "gruvbox-dark", name: "Gruvbox Dark Medium", family: "Gruvbox", light: false, bg: "#1d2021", panel: "#282828", fg: "#ebdbb2", muted: "#bdae93", faint: "#928374", accent: "#fabd2f", trunk: "#fe8019",
    ansi: "282828 cc241d 98971a d79921 458588 b16286 689d6a a89984 928374 fb4934 b8bb26 fabd2f 83a598 d3869b 8ec07c ebdbb2" },
  { id: "gruvbox-dark-soft", name: "Gruvbox Dark Soft", family: "Gruvbox", light: false, bg: "#282828", panel: "#32302f", fg: "#ebdbb2", muted: "#bdae93", faint: "#928374", accent: "#fabd2f", trunk: "#fe8019",
    ansi: "32302f cc241d 98971a d79921 458588 b16286 689d6a a89984 928374 fb4934 b8bb26 fabd2f 83a598 d3869b 8ec07c ebdbb2" },
  { id: "gruvbox-light-hard", name: "Gruvbox Light Hard", family: "Gruvbox", light: true, bg: "#f2e5bc", panel: "#f9f5d7", fg: "#3c3836", muted: "#665c54", faint: "#7c6f64", accent: "#af3a03", trunk: "#d65d0e",
    ansi: "f9f5d7 cc241d 98971a d79921 458588 b16286 689d6a 7c6f64 928374 9d0006 79740e b57614 076678 8f3f71 427b58 3c3836" },
  { id: "gruvbox-light", name: "Gruvbox Light Medium", family: "Gruvbox", light: true, bg: "#f2e5bc", panel: "#fbf1c7", fg: "#3c3836", muted: "#665c54", faint: "#7c6f64", accent: "#af3a03", trunk: "#d65d0e",
    ansi: "fbf1c7 cc241d 98971a d79921 458588 b16286 689d6a 7c6f64 928374 9d0006 79740e b57614 076678 8f3f71 427b58 3c3836" },
  { id: "gruvbox-light-soft", name: "Gruvbox Light Soft", family: "Gruvbox", light: true, bg: "#ebdbb2", panel: "#f2e5bc", fg: "#3c3836", muted: "#665c54", faint: "#7c6f64", accent: "#af3a03", trunk: "#d65d0e",
    ansi: "f2e5bc cc241d 98971a d79921 458588 b16286 689d6a 7c6f64 928374 9d0006 79740e b57614 076678 8f3f71 427b58 3c3836" },
];

/** The 16 terminal colors as "#rrggbb". */
export const ansi = (t: Theme) => t.ansi.split(" ").map((h) => `#${h}`);

/** The theme a preference shows: a theme's id, or "system" (or a gone id) for Gitnetix in the computer's mode. */
export const resolveTheme = (pref: string, system: "dark" | "light") => THEMES.find((t) => t.id === pref) ?? THEMES.find((t) => t.id === system)!;

/** The light / dark toggle's next theme: the same theme's other mode, same contrast when it has one (Gruvbox Dark Hard → Light Hard, Catppuccin Mocha → Latte); Gitnetix's when it has none. */
export function otherMode(cur: Theme) {
  const other = THEMES.filter((t) => t.family === cur.family && t.light !== cur.light);
  const bare = (name: string) => name.replace(/Dark|Light/, "");
  return (other.find((t) => bare(t.name) === bare(cur.name)) ?? other[0])?.id ?? (cur.light ? "dark" : "light");
}

/** The app.css tokens a theme replaces; the bright ANSI colors carry the diff and status colors. */
export function tokens(t: Theme): Record<string, string> {
  const a = ansi(t);
  const mix = (c: string, pct: number, over = t.panel) => `color-mix(in srgb, ${c} ${pct}%, ${over})`;
  return {
    bg: t.bg,
    panel: t.panel,
    term: t.panel,
    raised: mix(t.fg, 4),
    sel: mix(t.fg, 8),
    line: mix(t.fg, 10),
    fg: t.fg,
    muted: t.muted ?? mix(t.fg, 72),
    faint: t.faint ?? mix(t.fg, 55),
    accent: t.accent,
    "accent-fg": t.accent,
    "on-accent": t.onAccent ?? (t.light ? t.panel : t.bg),
    "add-fg": a[10],
    "del-fg": a[9],
    "warn-fg": a[11],
    "mod-fg": a[12],
    "release-fg": a[13],
    "prop-fg": a[14],
    "trunk-fg": t.trunk,
    "add-bg": mix(a[10], 14, "transparent"),
    "del-bg": mix(a[9], 14, "transparent"),
    "hunk-bg": mix(a[12], 8, "transparent"),
  };
}

/** Show `t`: app.css's light or dark base, with the theme's own colors over it unless it is a Gitnetix one. */
export function applyTheme(t: Theme) {
  const root = document.documentElement;
  let style = document.getElementById("theme-vars");
  if (!style) {
    style = document.createElement("style");
    style.id = "theme-vars";
    document.head.append(style);
  }
  const own = t.family !== "Gitnetix";
  // `html[data-theme]` outranks app.css's `[data-theme="light"] .ag`, which sets the tokens again on the app's root.
  style.textContent = own ? `html[data-theme], html[data-theme] .ag { ${Object.entries(tokens(t)).map(([k, v]) => `--${k}: ${v};`).join(" ")} }` : "";
  root.dataset.theme = t.light ? "light" : "dark";
  if (own) root.dataset.palette = t.id;
  else delete root.dataset.palette;
}
