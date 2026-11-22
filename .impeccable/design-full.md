---
name: Gitnetix
description: Slate night. A cool monochrome Git client where ink is the selection colour and, in its default Black & White theme, the only control colour.
colors:
  ground: "#0a0d12"
  ground-top: "#0f151d"
  panel: "#0f141b"
  raised: "#151b24"
  selected: "#1b2330"
  hairline: "#1f2732"
  hairline-strong: "#2c3644"
  link-dim: "#344050"
  ink: "#e9eef4"
  muted: "#a3aebb"
  faint: "#808b9a"
  control: "#f2f5f8"
  on-control: "#0a0d12"
  add: "#5fd39a"
  delete: "#ff7b72"
  warn: "#e8b85a"
  light-ground: "#eef1f5"
  light-ground-top: "#e6eaf0"
  light-panel: "#ffffff"
  light-raised: "#f5f7fa"
  light-selected: "#e8ecf2"
  light-hairline: "#dde2e9"
  light-hairline-strong: "#c9d0da"
  light-link-dim: "#b8c1cd"
  light-ink: "#0b0f14"
  light-muted: "#4f5b6a"
  light-faint: "#5f6a79"
  light-control: "#0b0f14"
  light-on-control: "#ffffff"
  light-add: "#127a4b"
  light-delete: "#c0362c"
  light-warn: "#8a5a00"
  working-amber: "#f7c48a"
  working-violet: "#c4a7ff"
  working-cyan: "#5fd0e0"
  working-green: "#62d6ae"
  light-working-amber: "#a85a12"
  light-working-violet: "#6b46c1"
  light-working-cyan: "#0e7490"
  light-working-green: "#17744d"
typography:
  display:
    fontFamily: "Antonio, Inter, sans-serif"
    fontSize: "30px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.01em"
  display-title:
    fontFamily: "Antonio, Inter, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.06em"
  display-numeral:
    fontFamily: "Antonio, Inter, sans-serif"
    fontSize: "44px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0em"
  body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "18px"
    letterSpacing: "0em"
  body-strong:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: "18px"
    letterSpacing: "0em"
  meta:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
    letterSpacing: "0em"
  label:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: "13px"
    letterSpacing: "0.14em"
  button:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: "13px"
    letterSpacing: "0.12em"
  button-small:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "18px"
    letterSpacing: "0em"
  page-title:
    fontFamily: "Antonio, Inter, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.05em"
  hero-title:
    fontFamily: "Antonio, Inter, sans-serif"
    fontSize: "32px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.04em"
  ref:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: "18px"
    letterSpacing: "0em"
  count:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: "16px"
    letterSpacing: "0em"
  field:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: "18px"
    letterSpacing: "0em"
  code:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "20px"
    letterSpacing: "0em"
  ticket-title:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: "32px"
    letterSpacing: "-0.015em"
  reading:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.65
    letterSpacing: "0em"
rounded:
  none: "0px"
  sm: "2px"
  md: "3px"
  circle: "50%"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.control}"
    textColor: "{colors.on-control}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "30px"
  button-primary-disabled:
    backgroundColor: "transparent"
    textColor: "{colors.faint}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "30px"
  button-small:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.button-small}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "30px"
  tab:
    textColor: "{colors.muted}"
    typography: "{typography.body-strong}"
    padding: "0 12px"
    height: "40px"
  tab-active:
    textColor: "{colors.ink}"
    typography: "{typography.body-strong}"
    padding: "0 12px"
    height: "40px"
  segment:
    textColor: "{colors.muted}"
    typography: "{typography.body-strong}"
    padding: "0 11px"
    height: "28px"
  segment-active:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
    typography: "{typography.body-strong}"
    padding: "0 11px"
    height: "28px"
  status-tag:
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "3px 8px"
  status-tag-active:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "3px 8px"
  check-toggle:
    textColor: "{colors.muted}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
  check-toggle-on:
    textColor: "{colors.ink}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
  icon-button:
    textColor: "{colors.muted}"
    rounded: "{rounded.md}"
    size: "28px"
  branch-box:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 24px 8px 18px"
    height: "60px"
  branch-box-release:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 24px 8px 18px"
    height: "74px"
  branch-box-info:
    textColor: "{colors.muted}"
    typography: "{typography.meta}"
    height: "18px"
  line-chip:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.muted}"
    typography: "{typography.count}"
    rounded: "{rounded.sm}"
    padding: "0 6px"
    height: "18px"
  line-chip-route:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    typography: "{typography.count}"
    rounded: "{rounded.sm}"
    padding: "0 6px"
    height: "18px"
  kbd:
    textColor: "{colors.faint}"
    typography: "{typography.count}"
    rounded: "{rounded.sm}"
    padding: "0 5px"
  branch-box-add:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    size: "20px"
  commit-row:
    textColor: "{colors.muted}"
    typography: "{typography.meta}"
    height: "22px"
  trunk-station:
    backgroundColor: "{colors.ground}"
    rounded: "{rounded.circle}"
    size: "11px"
  trunk-station-main:
    backgroundColor: "{colors.control}"
    rounded: "{rounded.circle}"
    size: "17px"
  trunk-station-merged:
    backgroundColor: "{colors.ground}"
    rounded: "{rounded.circle}"
    size: "7px"
  selected-card:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "16px"
    width: "360px"
  settings-cell:
    textColor: "{colors.muted}"
    width: "44px"
    height: "40px"
  map-legend:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.muted}"
    typography: "{typography.meta}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  kpi:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.display-numeral}"
    rounded: "{rounded.md}"
    padding: "16px"
  rail-section-row:
    textColor: "{colors.faint}"
    typography: "{typography.label}"
    padding: "0 10px 0 16px"
    height: "32px"
  file-row:
    textColor: "{colors.muted}"
    typography: "{typography.field}"
    padding: "0 6px 0 16px"
    height: "30px"
  file-row-selected:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.ink}"
    typography: "{typography.field}"
    padding: "0 6px 0 16px"
    height: "30px"
  input:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    typography: "{typography.field}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  input-multiline:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    typography: "{typography.field}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
    height: "64px"
  agent-panel:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.muted}"
    typography: "{typography.body}"
    width: "460px"
  agent-panel-tab:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.muted}"
    typography: "{typography.meta}"
    padding: "0 12px"
    height: "34px"
  agent-panel-tab-active:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.meta}"
    padding: "0 12px"
    height: "34px"
  agent-panel-icon-tab:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.muted}"
    size: "34px"
  agent-input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "12px"
  agent-input-send:
    backgroundColor: "{colors.control}"
    textColor: "{colors.on-control}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "30px"
  model-picker:
    textColor: "{colors.muted}"
    typography: "{typography.meta}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "28px"
  button-stop:
    backgroundColor: "transparent"
    textColor: "{colors.delete}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "30px"
  map-files:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.muted}"
    typography: "{typography.field}"
    rounded: "{rounded.md}"
    width: "360px"
  pr-row:
    textColor: "{colors.ink}"
    typography: "{typography.body-strong}"
    padding: "9px 12px"
  pr-line-box:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.ref}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "26px"
  pr-gate:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "26px"
  pr-gate-open:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "26px"
  pr-tab:
    textColor: "{colors.muted}"
    typography: "{typography.body-strong}"
    padding: "0 10px"
    height: "38px"
  pr-tab-active:
    textColor: "{colors.ink}"
    typography: "{typography.body-strong}"
    padding: "0 10px"
    height: "38px"
  tk-row:
    textColor: "{colors.muted}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  tk-row-open:
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  tk-row-touch:
    textColor: "{colors.muted}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
    height: "44px"
  tk-ring:
    backgroundColor: "transparent"
    rounded: "{rounded.circle}"
    size: "11px"
  tk-ring-done:
    backgroundColor: "{colors.add}"
    rounded: "{rounded.circle}"
    size: "11px"
  tk-reader:
    textColor: "{colors.ink}"
    typography: "{typography.reading}"
    width: "1180px"
  tk-title:
    textColor: "{colors.ink}"
    typography: "{typography.ticket-title}"
  tk-margin:
    padding: "26px 28px 40px"
    width: "400px"
  tk-stop:
    backgroundColor: "{colors.ground}"
    rounded: "{rounded.circle}"
    size: "11px"
  tk-stop-on:
    backgroundColor: "{colors.control}"
    rounded: "{rounded.circle}"
    size: "11px"
  tk-stop-release:
    backgroundColor: "{colors.ground}"
    rounded: "{rounded.circle}"
    size: "17px"
  tk-release-numeral:
    textColor: "{colors.ink}"
    typography: "{typography.display}"
  tk-kv-row:
    textColor: "{colors.faint}"
    typography: "{typography.meta}"
    height: "40px"
  tk-skel-bar:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.sm}"
    height: "9px"
  avatar:
    backgroundColor: "{colors.hairline-strong}"
    textColor: "{colors.ink}"
    rounded: "{rounded.circle}"
    size: "16px"
  sm-line:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.md}"
    padding: "30px 24px 22px"
  sm-stop:
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    width: "200px"
  sm-glyph:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.circle}"
    size: "14px"
  sm-glyph-head:
    backgroundColor: "{colors.ink}"
    rounded: "{rounded.circle}"
    size: "14px"
  sm-glyph-tip:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.none}"
    size: "11px"
  sm-ring:
    backgroundColor: "transparent"
    rounded: "{rounded.circle}"
    size: "11px"
  sm-ring-ok:
    backgroundColor: "{colors.add}"
    rounded: "{rounded.circle}"
    size: "11px"
  sm-ring-bad:
    backgroundColor: "{colors.delete}"
    rounded: "{rounded.circle}"
    size: "11px"
  sm-note:
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: "10px 14px"
  ctx-hint:
    textColor: "{colors.faint}"
    typography: "{typography.meta}"
---

# Design System: Gitnetix

## Overview

Slate night. The app is one cool monochrome field, slate fading to black, that a developer keeps open beside their editor all day. Nothing on it is decorative: white (ink, in light mode) is the only control colour of its default theme and the selection and focus colour of every theme, hue appears only when it means something, and the headline objects (release versions, ahead/behind counts) speak in a tall condensed display face. Everything else is quiet Inter and JetBrains Mono on hairline-ruled panels with 2 to 3px corners.

It replaces a look built from per-role hues (trunk orange, release violet, props cyan, selection blue), pills and glows. One piece of that look stays by owner decision: the flowing rainbow on anything an agent is working on, the one signal the owner loves and the one place the old hues and glow survive. The views, layout and behaviour of the app do not change; only this visual layer does.

The palette ships as one theme family, **Gitnetix Black & White** (`gitnetix-bw`) and **Gitnetix Black & White Light** (`gitnetix-bw-light`), in `src/lib/themes.ts`: every step is set exactly in the theme's `own` map. It is the default for new users (`DEFAULT_THEME`) and the pair "System" follows (`SYSTEM`). Gitnetix Dark and Gitnetix Light keep their own palettes in `app.css`, and the 34 third-party themes keep theirs through `tokens()`; all of them take this system's shapes, type, hairlines, map structure and neutral roles. The colour tokens below are the Black & White pair.

The approved reference is `.impeccable/mocks/slate-direction.html` (branch map and branch workspace at 1920x1080, each with the agents panel docked right, dark and light). Inside this world the branch map reads as a line diagram: one hairline trunk carries the shipped releases as stations, branches hang off it as small boxes (a header and one info row), ahead/behind rides on the incoming line as a small chip, and their commits float free beneath them.

Key characteristics:
- Cool slate-to-black ground, panels one step up, 1px hairlines.
- Branch map as a station line: hairline trunk, ring stations, two-row boxes, ahead/behind chips on the lines, floating commits.
- Pull requests read as the same line: ring stations by state in the list, and each pull request's checks, review and conversations as stations on its way to the base.
- Tickets read like a page: one-line rows with a status ring, a 1180px reading column, and the ticket's way to a release as a station line in the margin.
- Submodules read as a pin line: the pinned, checked-out and remote-tip commits as stops on one hairline, each action under the stop it moves the submodule to.
- White controls: solid white primary, 1px outline secondary.
- Hue only for diff add/delete, warnings and conflicts, plus the flowing rainbow on agent work.
- Tall condensed numerals and versions; tracked small-caps labels.
- Thin 1.25px icon strokes; hard, short motion.

## Colors

Restrained strategy: tinted neutrals plus one control colour that is not a hue.

### Primary
- **Control White** (`#f2f5f8`; light mode **Control Ink** `#0b0f14`): the Black & White theme's `--accent`, so its primary buttons and links; also its `--route`, the checked-out route and the `main` station on the branch map. Text on it is `on-control`. The active segment, active status tags, tab underlines, check fills and focus rings are Ink (`--fg`) in every theme.

### Neutral
- **Ground** (`#0a0d12`, top of canvas `#0f151d`; CSS `--bg` and `--ground`): app background; the branch map canvas runs a vertical fade from ground-top to ground over its first 70%. The agents panel and terminal (`--term`) sit on Ground in both modes (light `#eef1f5`).
- **Panel** (`#0f141b`), **Raised** (`#151b24`), **Selected** (`#1b2330`): cards, raised rows and hover, selected rows.
- **Hairline** (`#1f2732`, `--line`) and **Hairline Strong** (`#2c3644`, `--line2`): every divider and card border. **Link Dim** (`#344050`, `--link`): branch map links that are not on your route, and the hairline a release drops to its merged branches. Themes that do not set these get them mixed from their own ink: `--line2` is 17% ink over panel, `--link` 22% ink over ground, `--ground` 3% ink over ground, `--route` is ink.
- **Ink** (`#e9eef4`), **Muted** (`#a3aebb`), **Faint** (`#808b9a`): text tiers. All pass 4.5:1 on ground and panel. Faint also draws the trunk hairline and the resting station rings.

### Status (meaning only)
- **Add** `#5fd39a`, **Delete** `#ff7b72`, **Warn** `#e8b85a`. Diff backgrounds are the same hue at 10% (light 8 to 9%). Behind counts use Delete (the line chip's ↓, the card's Behind numeral, the code view's "vs" pill, and the "↓N to pull" text on a branch box, the focus head and the card's Origin row). Warn marks a branch that needs you: an agent waiting, an idle branch's alert icon. On Submodules, Add marks Up to date only, Delete a conflicted or missing pointer, and Warn a submodule off its pin, a URL out of sync or uncommitted files inside it.

### Code
The Black & White pair highlights code in its two inks: keywords and types bold Ink, strings, numbers, functions, literals and properties Muted. Other themes keep their syntax hues.

### Agent working (owner exception)
- **Working Amber** (`#f7c48a`), **Working Violet** (`#c4a7ff`), **Working Cyan** (`#5fd0e0`), **Working Green** (`#62d6ae`); light mode `#a85a12`, `#6b46c1`, `#0e7490`, `#17744d`. In code `--g1` to `--g4`. These are the old Gitnetix role hues, kept for one signal only: an agent is working on this. They never mark a role, a type, a button or a selection.

### Named Rules
**The Control Rule.** Ink (`--fg`) means "this is yours": selection, the active tab, segment and tag, check fills and focus, in every theme. `--accent` means "you can press this" and marks controls only: primary buttons, links and a few control states. In Black & White the accent is white (ink in light), so ink is the only control colour; Gitnetix Dark/Light and the third-party themes keep their own accent as their control colour. Never spend an accent on selection, focus, roles or status.

**The Meaning Rule.** Branch type, trunk, release, props and people carry no hue. Type reads as a text label (FEAT, FIX); trunk and release read by position and the display face. Names carry no hue either, like branch types and labels: an avatar without a picture is the same neutral disc for everyone. A hue on screen must answer "added, deleted, warning or conflict", or be the Agent Working rainbow.

**The Agent Working Rule.** Anything an agent is working on flows with the incumbent rainbow, and nothing else may. Text gets weight 600, a 90deg gradient of g1, g2, g3, g4, g1 at 300% size clipped to the text, flowing in 8s `steps(384)`, with no glow (the colour change is enough). Icons cycle their stroke through g1, g2, g3, g4 in 8s `steps(96)` with a `drop-shadow(0 0 5px)` of g2 at 45%; the working dot blinks and cycles the same way, with no glow. It appears on the top bar's Worktrees & agents icon, the project tab's dot while agents run, a branch box's "Claude working" info row, the selected card's Agent value, the focus head's agent pill and the agents panel's session dot. A waiting agent is Warn, never rainbow. Reduced motion stops all three animations and leaves the colours still.

**The Theme Rule.** Black & White is the default and what System follows; every other theme (Gitnetix Dark/Light in `app.css`, the 34 third-party themes through `tokens()` in `src/lib/themes.ts`) keeps its own ground, panel, text and accent, gets the derived steps (`--line2`, `--link`, `--ground`, `--route`, `--g1` to `--g4`) mixed from its colours unless it sets them, and takes the same shapes, type, hairlines and map structure. A third-party theme sets its raised, selected, hairline and status colours from its own palette in the palette's own roles (`own`); a colour under the floors (muted 4.5:1, faint 4:1, status and link text 4.5:1 on light panels and 4:1 on dark ones) only moves lighter or darker. Role hues are neutral in every theme: no component reads `--trunk-fg`, `--release-fg`, `--prop-fg` or `--mod-fg` for a role (`tokens()` still emits them for the marketing website, syntax highlighting and the agent-working rainbow read them).

## Typography

**Display:** Antonio 600 (Google Fonts / Fontsource), tall condensed.
**UI:** Inter 400/500/600.
**Refs and code:** JetBrains Mono 400/500/600 (already in the project).

Character: one loud condensed voice for the few numbers and versions that matter; everything else is small, even and tabular.

### Hierarchy
- **Display** (Antonio 600, 30px, line-height 1): the next release in its box on the branch map (`v0.6.0`) and on a ticket's Release station.
- **Display Title** (Antonio 600, 18px, line-height 1, 0.06em tracking, uppercase): screen titles at the left of the toolbar (BRANCH MAP).
- **Page Title** (Antonio 600, 24px, line-height 1, 0.05em tracking, uppercase): the title of a full page (Analytics, Tickets, Templates, AI setup). **Hero Title** (Antonio 600, 32px, 0.04em, uppercase): the welcome screen's heading.
- **Display Numeral** (Antonio 600, 44px, line-height 1): headline counts with a Label caption under them (Ahead / Behind / WIP files on the selected card; KPI values in Analytics, Sprints, Weekly).
- **Body** (Inter 13px/18px, 400; 500 for tabs and segments): all UI text.
- **Meta** (Inter 12px/16px): secondary lines on cards and rows, floating commit subjects, release dates on the trunk, context-menu hints (faint).
- **Label** (Inter 600, 11px, 0.14em tracking, uppercase): column headings (TRUNK, BRANCHES), branch type (FEAT), status tags (CHECKED OUT, MERGED, DEFAULT, NEXT), stat labels, the code view's rail sections (STAGED, UNSTAGED, COMMIT MESSAGE; 0.12em there).
- **Button** (Inter 600, 11px, 0.12em tracking, uppercase): regular buttons.
- **Button Small** (Inter 500, 12px/18px, no tracking, sentence case): small toolbar buttons and toggles (Fit, Show all).
- **Ref** (JetBrains Mono 13px, 500; 600 for the current branch and `main`): branch names, refs, shipped versions on the trunk, file paths. Code view crumbs are Mono 13px. A submodule's path heads its detail in Mono 600 22px/28px at -0.01em, wrapping anywhere.
- **Count** (JetBrains Mono 11px, 500): counts after tab and segment labels, the ahead/behind line chip, the Esc key cap. Commit ages use the same face at 400, faint, beside the author's avatar.
- **Field** (Inter 12.5px/18px): text inputs and the file rows of the code view's rail (file name 500 ink, its folder 11.5px faint).
- **Code** (JetBrains Mono 12px/20px): diffs, logs, terminal.
- **Ticket Title** (Inter 600, 26px/32px, -0.015em, balanced wrap): a ticket's title at the head of the reader; 22px/28px when the reader is under 520px wide.
- **Reading** (Inter 14px, line-height 1.65): a ticket's description in the reading column.

All numbers use `font-variant-numeric: tabular-nums`. Nothing functional is set below 11px.

### Named Rules
**The One Loud Voice Rule.** Antonio is used only for screen and page titles, the welcome heading, the next release and headline numerals. Shipped versions read in Mono. Never Antonio for body, buttons, labels or branch names.

**The Mono Rule.** Mono is for what a machine hands back: paths, SHAs, refs, URLs and code, plus the Count role's tabular numbers and key caps. Plain words are never Mono: menu hints, captions and sentences are Inter, and a hint or sentence that holds a SHA or path wraps only that string in Mono (the menus' Copy SHA hint, the stale-remote box's submodule names).

## Layout

4px grid. Shell rows: repo tab bar 40px (Settings gear cell and profile button flush at its right end), section tabs 40px (the app's six: Workspace, Pull requests, Tickets, Release notes, Submodules, Analytics; no counts), toolbar 48px. Cards pad 12px 14px (16px on the selected-branch card); rows are 32px (rail sections), 30px (rail files), 22px (floating commits) or 20px (diff lines). Map column headings (TRUNK, RELEASES & STRAIGHT TO MAIN, BRANCHES) sit 20px below the toolbar; floating commits indent 18px from their box's left edge (14px under `main`, whose box pads 14px on the left since its station sits on the trunk); trunk stations keep an even 36px pitch. Map geometry (`BranchMap.tsx`): trunk hairline at x 26, the default branch's column at x 46 and 280px wide, branch columns at 404 + 392 per level and 320px wide; boxes 28px apart within a parent, 40px between parents; floating commits start 6px under their box. On open the map keeps its own top left when the selected box shows whole from there, so the trunk stays in view; otherwise it centres the box, leaving 376px (`CARD_ROOM`) for the selected branch's side column. Gaps: 8px inside groups, 24 to 32px between groups. Density stays where it is today; the redesign changes surfaces, not layout. The agents panel docks on the right below the toolbar in both views at the app's 460px default, so the map loses that width; at 1920x1080 the panel plus the 360px side column still leave the branch column clear. The code view's grid is 320px files rail | code | 460px agents panel. Phone layout (max 480px, or 900px with a coarse pointer) keeps its single pane and bottom tab bar; under 720px the map drops its title, legend and toolbar spacer, and the selected card moves above the map instead of over it.

## Elevation & Depth

Flat. Resting surfaces have no shadow: depth is the step from ground to panel to raised plus a 1px hairline. Only floating layers (menus, popovers, modals, toasts) get one shadow, `0 12px 32px -8px rgba(0,0,0,0.6)` with a hairline-strong border (light mode `0 12px 32px -8px rgba(15,20,30,0.18)`). No glows, no coloured halos, no drop-shadow filters, except the Agent Working Rule's soft g2 drop-shadow on agent-work icons.

Focus: `outline: 1px solid` ink, `outline-offset: 2px`. No blurred focus halo. The selected-branch card floats over the map but stays flat: panel plus hairline-strong border, no shadow.

## Shapes

Corners are 3px on controls, boxes, cards and inputs, 2px on status tags, check boxes, the "+" square, the line chip and the key cap, 0 on shell bars and tabs. Circles only for avatars, status dots, trunk stations and the timeline commit marks. No pills: anything that was `border-radius: 999px` becomes 3px unless it is a dot. A dashed border or line means falling behind, idle, uncommitted, not there yet or not there at all (falling-behind box, its link and its line chip; the 6px WIP dot; a not-cloned submodule's ring, its Not cloned tag, the pin line's rail toward new remote commits and its rail when there is no remote). One square silhouette joins the circles: a submodule's remote tip is an 11px square turned 45deg, so the commit you don't have yet reads apart from the ones you do.

## Components

### Buttons
- **Primary:** solid accent (the control colour), on-accent text, Button type, 30px tall, 3px corners. Hover: 8% toward ground. Disabled: the secondary outline (hairline-strong border, transparent) with a faint label, never a washed-out fill.
- **Secondary:** transparent, 1px hairline-strong border, ink text. Hover: raised background. Disabled: 40% opacity. Pressed: 1px down.
- **Small:** 28px, padding 0 10px, Button Small type (sentence case), muted, ink on hover; toolbar actions and toggles.
- **Icon:** a bare 28px square, muted, ink on hover.
- A button's icon never shrinks: in a tight button the label gives way.
- **Destructive:** secondary shape with delete-coloured text; kept apart from other actions by space, never placed next to the primary.

### Tabs (repo tabs and section tabs)
Muted text; the active one is ink with a 2px ink underline (inset box-shadow). Repo tabs are separated by hairlines and show a 6px ink dot when that repo has activity; while agents run in it the dot follows the Agent Working Rule. The top bar's first cell (52px, hairline on the right) is the "Worktrees & agents" layers icon (18px, muted), not a logo; it flows with the rainbow while an agent runs. At the bar's right end, a 44px Settings gear cell (muted, raised and ink on hover, hairline on its left) sits before the 48px profile button.

### Segmented filters
1px hairline-strong outline, 3px corners, 28px tall, segments split by hairlines. The active segment inverts (ink background, ground text).

### Check toggles
Map filters that switch a set on or off (Merged, Falling behind, Shipped). 28px tall, 1px hairline-strong outline, 3px corners, muted Inter 500 with a Mono 11px faint count. A 12px square box with 2px corners sits before the label: faint outline when off; filled ink with a ground check mark when on, and the label turns ink. A related action joins its toggle as a split (Falling behind | Clean up), sharing one border.

### Toolbar
The 48px row under the section tabs: the screen title in Display Title, then the Everyone/Mine segment, the check toggles, and, pushed right, a 28px icon button for search, a small outlined stash button (stash icon and "N stashes", sentence case; only when the project has stashes), a fetch icon button, and a zoom group (minus, Mono 12px percentage, plus, Fit) in one outlined 3px box.

### Status tags
Label type in a 1px hairline-strong box with 2px corners. One state per screen inverts (ink fill): CHECKED OUT on the current branch, NEXT on the next release. On merged stations the tag tightens to 2px 6px padding.

### Trunk
The leftmost map column. A vertical 1px hairline in Faint runs the map's whole height. Shipped versions sit on it as 11px ring stations (faint ring, ground fill) at an even 36px pitch, oldest at the top; each carries a Mono 13px version, a faint Inter 12px date and a "N commits" unfold button in Mono 11px faint with a chevron. The latest shipped version's ring and text are ink. `main` is a 17px station at the same pitch: a 1.5px ring in the route colour with a filled core, where the white route starts; its header box sits beside it with no ring of its own. Merged branches hang further down the same line as 7px stations, each with a 12px check, the Mono 12px name and a MERGED tag, followed by an outlined "Clean up merged" button. A release carries its own merged branches the same way, on a Link Dim hairline dropping from its ring.

### Branch boxes
A box holds a header row and one info row, never commits. Panel background, 1px hairline-strong border, 3px corners, padding 8px 24px 8px 18px, column layout with a 4px gap (60px tall; the next release 74px).
- **Header row** (20px; 34px on the release box, carrying its Antonio numeral and the NEXT tag): type label (faint), name (Ref), status tags. Nothing else.
- **Info row** (18px, Inter 12px muted): the branch's non-commit facts, one line. The agent state (blinking dot plus "Claude working"; a waiting agent's dot is Warn: "Codex waiting for you"); the WIP button ("WIP 2 · +48 −12": ink, Inter 500, a 6px dashed ink dot before it, Add/Delete counts in Mono 12px 500, underline on hover, opens the code); "N commits since vX · 1 release open" on the default branch; "release/x · from main · 3h ago" on a release; "↓N to pull" in Delete when origin has N commits the branch lacks; "no commits yet"; "idle 41 days · falling behind main" after a 12px Warn alert icon.
- **Station and "+":** an 11px ring station sits on the left border at the header row's centre (top 18px; 25px on the release box), filled with the route colour on the route. A 20px "+" square (2px corners, panel fill, hairline-strong border, muted icon; ink on hover) straddles the right edge at the header row (top 8px; 15px on the release box): always shown where lines leave and on the checked-out box, shown on hover or focus elsewhere.
- The checked-out box's border is ink; a falling-behind box's border is dashed.

### Behind line chip
Behind lives on the line, not in the box: a square chip centred on the midpoint of each incoming line whose branch is behind its parent. Ahead is not shown on the line. 18px tall, padding 0 6px, 1px hairline-strong border, 2px corners, ground fill, Count type (Mono 11px 500) in muted, reading "↓behind" in Delete. On the route its border takes the route colour and its text ink; on a falling-behind line its border is dashed. With a behind count it is a button that rebases onto the parent (ink border and text on hover); while the branch's agent works it is `aria-disabled` with a not-allowed cursor and a title saying why. Otherwise (a remote or non-work branch) it is a plain label.

### Floating commits
Commits float under their box with no container, indented 18px. Rows are 22px: subject in Inter 12px muted (ellipsis), the author's 14px avatar and the age on the right (age in Mono 11px faint); the whole row turns ink on hover. Only commits float: the box's situation, agent and WIP live in its info row. The list ends with "See all N" in tracked caps (Inter 600, 11px, 0.12em, faint). Merged stations and "Clean up merged" follow on the trunk or release line below.

### Branch map route
**The Hairline Rule.** Every map line is a hairline. The route from the trunk to the checked-out branch is 1.5px in the route colour (control white, ink in light mode); every other link is a 1px Link Dim curve; a falling-behind branch's link is dashed 3/4. No thick transit lines, no hue on the route, no pulse travelling along it, no glow. A one-line legend box floats at the canvas's bottom left (8px in, 16px up; 1px hairline-strong border, 3px corners, ground at 85%, padding 6px 12px, Inter 12px muted) with the route, other lines, falling behind and the line chip. Keys that don't fit wrap out of sight, never cut in half, and a "See all" link lists them in a 360px modal. It stops short of the selected branch's side column.

### Selected-branch card
Heads the selected branch's side column, floating top right over the map (16px in, 360px wide; 288px when it stands alone), panel background, 1px hairline-strong border, 3px corners, 16px padding, 14px gaps, no shadow; it fades in and, when the column runs out of height, gives way first and scrolls. Top: type label and the Mono 14px 600 name with a fold chevron; then status tags; then Ahead / Behind / WIP files in Display Numeral (behind in Delete). A full-width outlined "Look at the code" button with its WIP count right-aligned in Mono 11px muted; a muted 12px sentence on the branch's situation; a Parent / Origin / Ticket / Agent list (faint terms, Mono ink values right-aligned; a working Agent value flows with the rainbow). It ends with the suggested next step as a full-width primary split button (the app's label, such as "Stage & commit all", with a sparkle icon), the overflow part split off by a hairline-strong divider.

### Map files panel
Under the card in the same column, 12px below it, filling the height the card leaves (at least 180px): panel, 1px hairline-strong border, 3px corners. Head (padding 10px 10px 10px 12px, a hairline under it): a WIP / Branch / Project segmented filter filling the row, then, in tree mode, a collapse/expand-all chevron icon button, then the tree/list toggle. Its rows are the files rail's file rows; the Staged and Unstaged section rows stick to the top on panel. A new list starts expanded, Project collapsed. A picked file floats its diff over the rest of the map with the same 16px margins, stopping 16px short of the column: ground fill, 1px hairline-strong border, 3px corners.

### Pull requests screen
The branch map's grammar applied to a pull request: ring stations in the list, and in the detail one merge line that reads like a branch's route to its base.
- **Toolbar:** the map's 48px toolbar. "PULL REQUESTS" in Display Title, `host · owner/repo` in Mono 12px faint (up to 280px), an Open / To review / Closed segment with faint counts, a Mine / Others / All segment (not on To review); pushed right, a 280px search input 28px tall with a 13px faint search icon inside it, a sync icon button, and the primary New pull request button, its "from branch" tail in 11.5px sentence case at 70% opacity (40% with a not-allowed cursor when it can't open). Under 720px the search takes a row of its own.
- **List rows:** an 11px ring station by state (1px border, ground fill): open an ink ring, draft a dashed muted ring, merged a ring with a filled ink core like a station on the route, closed a faint ring. Beside it the title (Inter 13px 500 ink, one line) over a 12px faint meta line split by "·": `#number` in Mono 11.5px, the author, a Fork tag, the head branch (→ base only when the base is not the default branch). The age sits right in Mono 11px faint. Rows pad 9px 12px; the open one takes an inset 1px ink outline. Group heads are Label type with a Mono count. A legend under the list (hairline above, padding 12px 16px 14px) shows the current tab's two rings.
- **Strip:** the head of the detail, padding 14px 20px 12px, 10px gaps, a hairline under it. The title at 17px/22px with an edit icon button, a 12px muted facts row (`#number` in Mono faint, a 16px avatar with "Opened by … · updated …", a Fork tag), the actions as small buttons (Review, Rewrite with AI, Open on host, a Delete close icon), then the merge line. Under 1100px of detail width the title, facts and actions each take a full row and a ⋯ menu stands in for Open on, Edit and Close.
- **Merge line:** the head branch in a 26px box (panel, 1px ink border, 3px corners, padding 0 10px: its type label, then the Mono 13px 500 name; dashed for a draft), the map's behind chip after it when the branch is behind its base ("↓N" in Delete), then a station per gate joined by hairlines: Checks ("3/4"), Review (approvals over reviewers) and Unresolved conversations. Each gate is a 26px button (transparent border, Hairline Strong on hover; open: ink border on Selected) holding an 11px station, a Label and the value in Mono 13px 600, its total in 12px faint; a running check adds the blinking ink dot. Stations: passed fills with the route colour, failing rings in Delete, the gate the pull request waits at rings in ink, the rest faint. The hairline is solid in the route colour up to the first gate not passed and dashed Hairline Strong after it (solid throughout once merged, dashed throughout once closed). The base is `main`'s 17px station with its Mono 13px 500 name, or a 26px outlined branch picker (ink border on hover) while the base can still change. Then a muted 12px sentence on what holds the merge back, and the action button. Under 1100px the line stands up like the trunk: the box on top, a row per gate, the hairline vertical at 14px so every ring centres on it, then the base, the sentence and the action; under 560px the action fills the width at 36px.
- **Gate popover:** Checks and Review open a 300px panel floating 6px under their station (panel, 1px hairline-strong border, 3px corners, the floating shadow; it scrolls past 360px), closed by a press elsewhere or Escape. Checks list failing and running first, six shown, then "Show all N": a 7px dot (Add passed, Delete failed, a blinking ink dot running, a faint ring waiting), the name, the state word (Delete when failed, muted otherwise) and an external-link icon to its logs. Reviewers list an 18px avatar, the login and the vote: ink with a check when approved, Warn for changes asked, faint otherwise. Unresolved shows those conversations instead of opening a panel.
- **View tabs:** a 38px row under the strip (padding 0 10px, a hairline under it): Conversation and Files changed, each with a 13px icon, Inter 13px 500 muted and a Mono 11px faint count; hover and the selected tab turn ink, the selected one with a 2px inset ink underline.
- **Conversation:** from 760px the description and the talk sit side by side in two columns that scroll on their own, a hairline between them (a short description stacks above the talk instead); narrower, they stack and the pane scrolls as one. Sections pad 18px 24px; their headings (DESCRIPTION, CONVERSATION) are Label type; the description stops at 76ch. Threads hang on a vertical Hairline Strong line (22px indent), each on a 9px ring: ink while unresolved, faint once resolved. The new comment box sticks to the foot of the talk on ground.
- **New pull request modal:** on a fork, the repository it opens on; From → To branch pickers; then its commits, or why it can't open.

### Tickets screen
A ticket reads like a page, and its way to a release is drawn as a station line beside it, in the branch map's grammar.
- **Toolbar:** the map's 48px toolbar. "TICKETS" in Display Title, then a 28px trackers menu (up to 220px: All trackers or one tracker with its count, and Connect another tracker), a Mine / Everyone segment, the "Active sprint" (or cycle) check toggle when Jira or Linear cycles are connected, a By status / By release segment; pushed right, the search input ("Search by key or title"), a sync icon button whose tooltip says when it last synced, and a small "Triage N unplanned" button with a sparkle when open releases have unplanned tickets. Under 720px the toolbar wraps: segments, then the toggle and trackers, then the search with sync and triage at its end; a phone's detail pane goes without it.
- **List rows:** one line a ticket, at least 32px, padding 0 12px, 10px gaps, 1px apart, under Label group heads with a Mono count. An 11px status ring: to do an empty faint ring; in progress an ink ring half full; in review three quarters full; ready to merge an Add ring with an Add dot; done an Add disc with a ground check. Only ready and done are green. Then the key in Mono 12px faint (one width for the whole list), the title in muted Inter 13px with an ellipsis, and the priority as three bars 2.5px wide (Delete urgent, high an orange mixed 60/40 from Warn and Delete, medium faint with a 32% hint of Warn, faint otherwise). With Everyone on, the assignee's 18px avatar alone (neutral, one initial), the full name in its tooltip; nobody's ticket shows an 18px dashed faint ring. An agent on the ticket's branch puts the working dot before the title (Agent Working Rule); a waiting agent's dot is Warn. The open row's key and title turn ink and the row takes an inset 1px ink outline. Ticket types and labels show as text, never hue. On a phone each row takes two lines, 44px, padding 8px 12px: the ring and title, then the key, priority, avatar and the first name beside it (up to 96px, 12px muted), since a phone can't hover for the tooltip.
- **Loading:** "Syncing tickets…" with a spinner (12px muted, padding 12px 18px 8px), then seven 33px skeleton rows: a ring drawn in Hairline Strong, a 46px bar and a title bar, 9px tall in Raised with 2px corners.
- **Empty states:** with no tracker connected, the empty state shows the line a ticket travels above its text: Ticket, Branch, Pull request and Release as faint stations down a Hairline Strong line, the release the 17px station, then "Connect a tracker" as the primary. A filtered-out list says why in a 20px 18px padded block and offers Clear search, Show everyone's tickets or Show all trackers as small buttons.
- **Reader:** the detail pane holds a reading column and a right margin, each scrolling on its own. The column centres at 1180px (padding 40px 32px 64px). Its head is the Ticket Title with the tracker's link button top right, then the fields 14px under it as a wrapping row of 28px field menus at 12.5px (up to 240px): the key in Mono 12px, status with its ring, priority, type (a menu for Jira, plain muted text otherwise), labels for Linear, and the assignee's avatar with the full name. The body follows 28px down, 32px between sections: the description in Reading type, then criteria, files and comments under Label section heads with Mono counts. Criteria and comment threads lie open between hairlines (36px criteria rows), never in panels.
- **Work line:** the margin, 400px with a hairline on its left (padding 26px 28px 40px; 320px under 1000px of detail pane), lists Ticket, Branch, Pull request, Release and Shipped as stations down a Hairline Strong line, 22px apart. Reached stations fill with the route colour and the line between them is 1.5px route; the next station rings in ink; later stations and their line are dashed. Release is the 17px station (1.5px ring). Each station carries a Label name (ink once reached), a 13px line and a 12px muted meta line, and holds what can be done there: the ticket's status and how long it has been in it, with who opened it and when; the branch in Mono 500 with commits, WIP and parent, its agent state (rainbow while working, Warn while waiting), and Start a branch or Go to branch as small primaries; the pull request's Mono number and state with Open pull request; the planned release as a Display numeral with its tag and its branch in Mono, or an AI suggestion box (ink border) with Dismiss and Accept; Shipped "In vX" or a faint "Not yet".
- **Planning rows:** under the work line, a hairline above them: Release, Fix versions (Jira), Parent, Project, Time left and Tracker as 40px rows split by hairlines, the term 104px in 12px faint, the value 12.5px or a full-width 30px menu select.
- **Narrow panes:** under 760px of detail pane the reader stacks and scrolls as one: the title and fields (padding 28px 24px 22px), the work line between hairlines, then the text. Under 520px the title drops to 22px/28px and paddings to 16px.

### Submodules screen
A submodule is three commits on one line, pinned, checked out and remote tip, and every action sits on the stop it moves the submodule to.
- **Toolbar:** the map's 48px toolbar. "SUBMODULES" in Display Title, the project and count, an All / Needs you segment, when remotes were last checked in 12px faint, a check-remotes icon button, Add submodule, and Update all as a primary split. On a phone the detail pane goes without the toolbar and Update all moves under the rows as a full-width 40px split, a hairline above it.
- **List rows:** two lines a submodule under Needs you / Up to date group heads: an 11px status ring, the path in 12.5px 500 ink and the status word at the right in 12px (muted; ink for something new, Warn, Delete or Add with its ring), then the last commit's subject in 12px faint with the commit in Mono 11.5px. While it updates a spinner stands in for the ring and the word reads "Updating". Loading reads ".gitmodules" with a spinner over skeleton rows: a ring drawn in Hairline Strong and 9px Raised bars.
- **Status rings:** 11px, 1.5px stroke. Up to date fills Add; something new to take (new on the remote, a new pin staged) is an ink ring with a 2px ink centre dot; a drift (off its pin, URL out of sync, uncommitted files) is a Warn ring; a conflicted or missing pointer fills Delete; not cloned is a dashed faint ring. Green means Up to date and nothing else.
- **Status tags:** the same tones on the status tag: Add, Warn and Delete text with their hue mixed about half into a Hairline Strong border (Add 45%, the others 50%), an ink border and text for something new, a dashed border for not cloned.
- **Detail:** up to 1180px, 28px gaps. The Mono path title with its status tag and a 12.5px muted sub-line (Mono values 12px), its actions top right; the pin line; notes; then Details (a 120px-term key-value list between hairlines, 13px/20px, muted terms, Mono values 12px, links underlined in Hairline Strong) beside Last commit checked out (a 14px 500 subject over a 12px muted author line), 1.15 to 1 columns 28px apart; then the last command's output in a 280px-tall scrolling pre. Under 760px of detail the two columns stack.
- **Pin line:** a panel (1px hairline, 3px corners, padding 30px 24px 22px) holding the stops on one hairline, centred. Each stop is 200px wide and centred: a 14px glyph, its Label name in ink (Delete when the stop is broken), the commit in Mono 14px 500 (faint "none" or "no pin" when there is none), a 12px/17px muted caption, and its action 8px under it. Glyphs: pinned is an ink ring on panel; checked out a filled ink dot; pinned and checked out together (the stops merge when they are the same commit) a ring with a 2.5px centre dot; the remote tip the turned square in Muted; not cloned or no remote a dashed faint ring; a broken stop rings in Delete. The rail runs from the centre of one stop to the centre of the next, 1px, its count centred above it in Inter 12px 500 muted (plain words, so not Mono; the remote ref inside it in Mono 11.5px): Warn with a tick per commit (up to nine) while the checkout drifts off the pin ("2 ahead of the pin"); dashed Muted with ticks toward new commits on the remote ("3 new on origin/main"); solid Hairline Strong when there is nothing new; dashed Hairline Strong when there is no remote. A checkout only behind its pin comes first on the line.
- **Stop actions:** small buttons under their stops (Back to pin under Pinned, Pin this commit under Checked out, Pull latest under Remote, Clone on a not-cloned pin, Go commit on a staged pin, Remove entry in Delete on a missing pointer). Exactly one is the white primary: the one on the stop that fixes the state.

**The Station Action Rule.** On a station line each action sits under the stop it moves the subject to, and exactly one white primary goes on the stop that fixes the state; every other action there is a small outlined button.

- **Narrow pin line:** under 620px of detail the line stands up: stops run top to bottom in a 22px glyph column, the label, commit and caption beside it left-aligned, each button at the right of its stop; the rail is vertical at 10.5px, its count left-aligned under the stop, and each stop's segment down to the next rail takes that rail's style.
- **Notes:** under the pin line, a 1px-hairline 3px box of hairline-split rows (padding 10px 14px, 13px at 1.45, 12px gaps): a leading 14px Warn icon, the sentence (Mono 12px for URLs and paths), and an optional small action at the right (Sync URL), white only when the pin line above has no white button of its own. Never a coloured side bar.
- **Stale remotes:** when a remote check can't reach some remotes, the list stays and an error box over it (Delete border and wash, text in ink, 12px gaps, 10px from the pane edges) says "Could not reach N remotes.", names those submodules in Mono 12px and says their new counts are from the check before, with Try again as a small button inside the box on the right. A list that can't be read at all uses the same box with the reason and Try again.
- **Empty and add:** no submodules shows a mini pin line (Pinned, Checked out, Remote in Label type, faint, glyphs drawn in Hairline Strong on a dashed rail) over the usual empty state with Add submodule as the primary. The add modal says where the submodule lands before it clones, in a 1px-hairline box with a 12px pin glyph, Mono 12px ink paths in 12.5px muted text. Its footers follow the app's full-width modal footer and uppercase button.

### Focus head (code view)
A 48px bar above the code view. Left: a "Branch map" back control (check-toggle shape with a back icon) carrying an Esc key cap (Count type, faint, 1px hairline-strong border, 2px corners, padding 0 5px). Then crumbs in Mono 13px muted with faint › separators, the current one ink 500, followed by the CHECKED OUT tag. Pushed right, status pills in Mono 12px muted, 18px apart: "↑4 ↓2 vs v0.6.0" (↓ in Delete), the agent state with its dot (rainbow while working), "↑1 to push".

### Code header
Above a diff: the file or commit title (Inter 13px 600) with what it is in a 12px meta line beside it (the kind in faint first, then muted facts), wrapping under the title when narrow; actions on the right. No kicker or eyebrow above the title.

### Files rail (code view)
The app's left rail in the new style, 320px, hairline on the right.
- **Head:** padding 14px 16px, 12px gap. The branch name (Ref 500) with "from v0.6.0" in 12px faint and a tree/list icon toggle on the right; under it a WIP / Branch / Project segmented filter in three equal columns.
- **Section rows:** 32px. A tracked-caps toggle (Inter 600, 11px, 0.12em, faint, ink on hover) with a 12px chevron and a Mono 500 count ("STAGED 1"); icon actions on the right as 24px buttons with 13px icons (stage all or unstage all, discard all; discard turns Delete on hover).
- **File rows:** 30px, Field type. A Mono 600 status letter (A in Add, M muted), the file name in ink 500 then its folder in 11.5px faint, +/− counts in Mono 12px Add/Delete. Per-row stage and discard icons show on hover, focus or selection. Hover and the selected row sit on the Selected background.
- **Commit box:** at the bottom, a hairline above it, padding 10px 16px 14px, 8px gaps. A "COMMIT MESSAGE" section toggle with a small outlined "Draft" button (24px check-toggle shape, sparkle icon, AI drafts from staged files); a Summary input ("Summary — leave empty for AI"); a Description textarea; and a full-width primary split "Commit 1" with a sparkle, the count at 70% opacity, and an options part.

### Avatars
A person is a small neutral circle, or their picture. `Avatar` (`src/components/Avatar.tsx`, class `.user-avatar`) draws the person's picture when there is one: their Gravatar when it is turned on in the profile, and for your own commits your profile's photo or Gravatar. Otherwise it shows initials on one disc for everyone: Hairline Strong (`--line2`) with the initials in ink, Inter 600 whatever face the row around it uses, slightly tight (-0.02em), the capitals centred; no per-person hue, in any theme (Meaning Rule). From 22px it holds two initials at 42% of its size, never under 11px; under 22px the first initial alone at 11px, or 3px under the dot's size when the dot can't hold 11px (the 12px commit avatar in the focus timeline, 9px). Sizes in use: 12, 14, 16, 18, 20, 24 and 28px. The full name is its tooltip and label; where the name already shows beside it (Analytics, ticket comment authors) it is decorative, hidden from assistive tech and without a tooltip. Not part of this rule: your own profile picture (`ProfileAvatar`), which keeps the colour and emoji you chose for it, and the agent provider's logo mark (`.ag-avatar`).

### Inputs
Ground fill, 1px hairline-strong border, 3px corners, Field type in ink, faint placeholder. A single line is 32px with 0 10px padding; a textarea is 64px with 8px 10px padding and no resize handle. Focus: the border turns ink (no outline).

### Agent activity
A 6px dot that blinks in two steps (1.5s, no smooth pulse) plus the words "Claude working". While the agent works, dot and words follow the Agent Working Rule. A waiting agent's dot is plain Warn with "Codex waiting for you". Under reduced motion nothing blinks or flows.

### Agents panel
The app's right agents/terminal panel, docked below the toolbar in both views, 460px wide, ground fill, 1px hairline on its left.
- **Tab bar:** 34px, panel fill, 1px bottom hairline. Tabs are Inter 12px 500 muted, padding 0 12px, a 1px hairline on their right; hover ink; the active tab is ink with an inset 2px ink bottom rule. Shell carries a 12px chevron. The session tab follows: the working dot, the branch in Mono 12px ink, then "main checkout" in faint that truncates first. After a spacer, the icon cells: 34px wide and the bar's full height, no border or radius but a 1px hairline on the left, 16px icons in Muted that never shrink (close, expand, collapse; the collapse chevron turns -90deg when the panel docks at the side).
- **Log:** padding 16px, 14px gaps, Inter 13px muted for the assistant. The user's message is plain ink text beside their 22px profile avatar (10px gap), with no rule or bubble; one sent while the agent works stays muted until it goes out. A meta line (Inter 11.5px faint) appears under a message on hover, 32px in, past the avatar. Tool rows are Mono 12px faint with a 12px file icon and Add/Delete counts. Code names inline in Mono 12px ink. Thinking is three 6px muted dots that hop 3px in four steps (1.333s, staggered), off under reduced motion.
- **Input box:** 0 16px 16px from the panel edges, 1px hairline-strong border, 3px corners, panel fill, 12px padding and gaps; the border turns ink on focus-within. Text on top: a borderless 13px textarea (faint placeholder), growing to three lines. Under it one row: attach and dictation icon buttons, the compact model picker (28px, 1px hairline-strong outline, 3px corners, Inter 12px), a spacer, then a labelled action button. While the agent works and the box is empty it is Stop: secondary shape, Delete-coloured text. Typing swaps it to the primary Queue (agent working) or Send, each with its icon and word.

### Context menus
A menu item's hint sits at the right end of its row, 12px from the label, in Inter 12px faint (Meta type), clipped with an ellipsis at half the row so the label keeps its room. Plain words stay in Inter; a hint holding a SHA wraps the SHA in Mono (Copy SHA in the commit and stash menus). The Mono Rule.

### Deliberate omissions from the mock
Not built, by choice, and not components: counts on the section tabs, "fetched Xm ago" by the fetch control, the 44px icon rail beside the diff, and the agent's duration on map boxes.

## Do's and Don'ts

### Do:
- **Do** use ink for selection and focus in every theme, and `--accent` only for controls (white in Black & White).
- **Do** show a disabled primary as the outline with a faint label.
- **Do** show branch type, trunk and release by label, position and type, not hue.
- **Do** keep colour for add, delete, warn and conflict only.
- **Do** set screen and page titles, the next release and headline numbers in Antonio, everything else (shipped versions included) in Inter and JetBrains Mono.
- **Do** keep every view, control and behaviour exactly where it is today.
- **Do** draw the branch map in hairlines: 1.5px route, 1px other links, dashed 3/4 when falling behind, 1px faint trunk.
- **Do** keep branch boxes to a header row and one info row, and let commits float beneath them with no container.
- **Do** put ahead/behind on the incoming line as a chip, a rebase button when there is a behind count.
- **Do** put shipped releases on the trunk as ring stations at an even 36px pitch, `main` as the large station where the route starts.
- **Do** mark everything an agent is working on with the flowing rainbow (the Agent Working Rule), and stop it under reduced motion.
- **Do** dock the agents panel right at 460px in both views.
- **Do** put each action under the station it moves the subject to, with exactly one white primary on the station that fixes the state.
- **Do** set menu hints, captions and sentences in Inter, and wrap only a SHA, path, ref or URL inside them in Mono.

### Don't:
- **Don't** use gradient text, glows, coloured halos or drop-shadow filters, except the rainbow on agent work under the Agent Working Rule.
- **Don't** use the working hues for anything but an agent working; a waiting agent is Warn.
- **Don't** use pills (999px radius) or radii above 3px on rectangles.
- **Don't** give branch types, roles or sections their own hue.
- **Don't** use spring or bounce easing; motion is short ease-out, under 200ms.
- **Don't** put a shadow on a resting surface.
- **Don't** set functional text below 11px.
- **Don't** draw thick transit lines or a coloured route on the branch map; the red route of the trunk reference is not adopted.
- **Don't** put commits inside a branch box or wrap them in a card on the map.
- **Don't** put ahead/behind inside the box, or a separate rebase button under the commits.
- **Don't** put a coloured side bar on a box, note or callout; a note is a hairline row with a leading icon.
