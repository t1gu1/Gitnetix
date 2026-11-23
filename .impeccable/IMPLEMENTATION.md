# Implementation notes

Where the redesign lands in the Gitnetix codebase. Line numbers are from `main` at v0.24.0 (commit 81e2b58).

## Scope

- In: the React app in `src/`. All visual changes, nearly all in `src/styles/app.css` (one 9,450-line stylesheet) plus a few token and font hooks.
- Out: the marketing site in `website/` (it has its own demo components and styles).
- Unchanged: every view, control, layout and behaviour. This is a visual-layer swap.
- No `VIEW_CACHE_VERSION` bump needed (`crates/core/src/app.rs`): nothing about `BranchView` changes.

## 1. Tokens

`src/styles/app.css` lines 1 to 90:
- `:root, .ag` holds Gitnetix Dark, `[data-theme="light"]` holds Gitnetix Light. Replace their values with the DESIGN.md colours (`--bg` = ground, `--panel`, `--raised`, `--sel` = selected, `--line` = hairline, `--fg` = ink, `--muted`, `--faint`, `--accent` and `--accent-fg` = control, `--on-accent` = on-control, `--add-*`, `--del-*`, `--warn-fg`).
- Role hues `--trunk-fg`, `--release-fg`, `--prop-fg`: point them at `var(--fg)` / `var(--muted)`. `--mod-fg` (modified file status, hunk tint): use `var(--muted)`.
- `--r-sm: 2px; --r: 3px; --r-lg: 3px`.
- `--ring`: replace the blurred accent halo with nothing; focus is the 1px outline in DESIGN.md.
- `--shadow`, `--shadow-pop`, `--shadow-lg`: the single floating-layer shadow from DESIGN.md; no shadow on resting surfaces.
- `--ease-spring`, `--ease-drawer`: replace with a plain ease-out (`cubic-bezier(0.2, 0, 0, 1)`); keep durations at or under 0.2s.
- `--tick` (checkbox tick SVG) has its stroke colour hard-coded to the old on-accent `%231b1205`; update it to on-control.
- `--sans`: `"Inter", system-ui, sans-serif`. Add `--display: "Antonio", "Inter", sans-serif`.

`src/lib/themes.ts`:
- `tokens(t)` (around line 134) maps the other 34 themes onto the same CSS variables. Change `"release-fg"`, `"prop-fg"` and `"trunk-fg"` to the theme's `fg` / muted text, and `"mod-fg"` to muted. That removes per-role hues from every theme at once. Each third-party theme keeps its own `accent` as its control colour (open decision 2 in README).
- `Theme.trunk` then has no reader; remove the field from the interface and all entries.
- Gitnetix Dark/Light entries (`id: "dark"` / `"light"`): update `bg`, `panel`, `fg`, `muted`, `faint`, `accent` to match DESIGN.md, and their `ansi` strings so the terminal matches.
- Default theme (open decision 1 in README): `SYSTEM = { dark: "dark", light: "light" }`, `DEFAULT_THEME = "dark"`, and keep the backend default in step: `crates/core/src/store.rs` line ~545 `UiPrefs { ... theme: "tokyo-night-storm" ... }`.

## 2. Fonts

`src/main.tsx` lines 5 to 10 import `@fontsource/instrument-sans` (400 to 700) and `@fontsource/jetbrains-mono` (400, 500).
- Add `@fontsource-variable/inter` and `@fontsource/antonio` (600), plus `@fontsource/jetbrains-mono/600.css`.
- Remove the Instrument Sans imports and the package from `package.json` (the website keeps its own copy).

## 3. Things to remove or flatten in app.css

Measured on v0.24.0:
- 194 `border-radius` declarations. Tokens handle most (52 `var(--r)`, 23 `var(--r-sm)`, 16 `var(--r-lg)`). The 15 `999px` and the literal 8, 9, 10, 12 and 14px values: 3px for rectangles, keep 50%/999px only for true dots and avatars (26 `50%` uses are mostly those).
- 34 `gradient` uses. Delete all decorative ones. Keep only the branch map canvas fade (ground-top to ground).
- The rainbow agent glow at lines ~975 to 1000: `.glow-name`, `.glow-working`, `.pulse.glow-dot` (gradient text across trunk/release/prop/add hues plus drop-shadow glows, `glow-name` / `glow-stroke` keyframes). Replace with plain ink text and the two-step blinking dot.
- Branch map tokens at lines ~1712 to 1736: `--map-sel` is selection blue (`--mod-fg`) and `--map-pulse` is a trunk-orange pulse along the route. New: route = 2px `var(--accent)`, other links `--map-line` at link-dim, no travelling pulse, selection = selected background + ink border.
- Any `drop-shadow(...)` filter or zero-offset coloured `box-shadow` (halos): delete.
- `.kind-chip` (line ~3257): 10px mono. Becomes the Label style (Inter 600, 11px, 0.14em, uppercase, faint).
- Search for `--trunk-fg`, `--release-fg`, `--prop-fg`, `--mod-fg` uses (about 60) and check each still reads right once those tokens are neutral.

## 4. Smaller hooks

- `src/components/Icon.tsx` line ~73: default `stroke = 1.5`; set to 1.25.
- `src/components/Profiles.tsx` / `--p-hue`: the user-chosen profile colour. It is personal identity, not a role, so it stays.
- `src/components/Charts.tsx`, `src/screens/Sprints.tsx`: data series colours. Charts may keep a restrained series palette (data is meaning); status blocks can become a single-hue ramp. Judge in context.
- Display face: apply `var(--display)` to release versions on the branch map, headline numbers (branch workspace ahead/behind/changed, Analytics, Sprints and Weekly KPI values) and screen titles. Nowhere else.

## 5. Verify

- `bun run app` runs the desktop app (Tauri dev). Check Gitnetix Dark, Gitnetix Light, Tokyo Night Storm, Catppuccin Latte and one high-contrast theme.
- Static pages: `firefox --headless --screenshot out.png --window-size 1520,1960 file:///path/to/page.html` works on Linux; no Chromium is installed on the original machine.
- Phone width (390px): the single-pane layout with the bottom tab bar must still hold.
