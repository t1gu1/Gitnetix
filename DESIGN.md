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
    width: "288px"
  settings-cell:
    textColor: "{colors.muted}"
    width: "44px"
    height: "40px"
  map-legend:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.muted}"
    typography: "{typography.meta}"
    padding: "8px 16px 10px"
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
- **Add** `#5fd39a`, **Delete** `#ff7b72`, **Warn** `#e8b85a`. Diff backgrounds are the same hue at 10% (light 8 to 9%). Behind counts use Delete (the line chip's ↓, the card's Behind numeral, the code view's "vs" pill). Warn marks a branch that needs you: an agent waiting, an idle branch's alert icon.

### Code
The Black & White pair highlights code in its two inks: keywords and types bold Ink, strings, numbers, functions, literals and properties Muted. Other themes keep their syntax hues.

### Agent working (owner exception)
- **Working Amber** (`#f7c48a`), **Working Violet** (`#c4a7ff`), **Working Cyan** (`#5fd0e0`), **Working Green** (`#62d6ae`); light mode `#a85a12`, `#6b46c1`, `#0e7490`, `#17744d`. In code `--g1` to `--g4`. These are the old Gitnetix role hues, kept for one signal only: an agent is working on this. They never mark a role, a type, a button or a selection.

### Named Rules
**The Control Rule.** Ink (`--fg`) means "this is yours": selection, the active tab, segment and tag, check fills and focus, in every theme. `--accent` means "you can press this" and marks controls only: primary buttons, links and a few control states. In Black & White the accent is white (ink in light), so ink is the only control colour; Gitnetix Dark/Light and the third-party themes keep their own accent as their control colour. Never spend an accent on selection, focus, roles or status.

**The Meaning Rule.** Branch type, trunk, release and props carry no hue. Type reads as a text label (FEAT, FIX); trunk and release read by position and the display face. A hue on screen must answer "added, deleted, warning or conflict", or be the Agent Working rainbow.

**The Agent Working Rule.** Anything an agent is working on flows with the incumbent rainbow, and nothing else may. Text gets weight 600, a 90deg gradient of g1, g2, g3, g4, g1 at 300% size clipped to the text, flowing in 8s `steps(384)`, with no glow (the colour change is enough). Icons cycle their stroke through g1, g2, g3, g4 in 8s `steps(96)` with a `drop-shadow(0 0 5px)` of g2 at 45%; the working dot blinks and cycles the same way, with no glow. It appears on the top bar's Worktrees & agents icon, the project tab's dot while agents run, a branch box's "Claude working" info row, the selected card's Agent value, the focus head's agent pill and the agents panel's session dot. A waiting agent is Warn, never rainbow. Reduced motion stops all three animations and leaves the colours still.

**The Theme Rule.** Black & White is the default and what System follows; every other theme (Gitnetix Dark/Light in `app.css`, the 34 third-party themes through `tokens()` in `src/lib/themes.ts`) keeps its own ground, panel, text and accent, gets the derived steps (`--line2`, `--link`, `--ground`, `--route`, `--g1` to `--g4`) mixed from its colours unless it sets them, and takes the same shapes, type, hairlines and map structure. Role hues are neutral in every theme: no component reads `--trunk-fg`, `--release-fg`, `--prop-fg` or `--mod-fg` for a role (`tokens()` still emits them for the marketing website, syntax highlighting and the agent-working rainbow read them).

## Typography

**Display:** Antonio 600 (Google Fonts / Fontsource), tall condensed.
**UI:** Inter 400/500/600.
**Refs and code:** JetBrains Mono 400/500/600 (already in the project).

Character: one loud condensed voice for the few numbers and versions that matter; everything else is small, even and tabular.

### Hierarchy
- **Display** (Antonio 600, 30px, line-height 1): the next release in its box on the branch map (`v0.6.0`).
- **Display Title** (Antonio 600, 18px, line-height 1, 0.06em tracking, uppercase): screen titles at the left of the toolbar (BRANCH MAP).
- **Page Title** (Antonio 600, 24px, line-height 1, 0.05em tracking, uppercase): the title of a full page (Analytics, Tickets, Templates, AI setup). **Hero Title** (Antonio 600, 32px, 0.04em, uppercase): the welcome screen's heading.
- **Display Numeral** (Antonio 600, 44px, line-height 1): headline counts with a Label caption under them (Ahead / Behind / WIP files on the selected card; KPI values in Analytics, Sprints, Weekly).
- **Body** (Inter 13px/18px, 400; 500 for tabs and segments): all UI text.
- **Meta** (Inter 12px/16px): secondary lines on cards and rows, floating commit subjects, release dates on the trunk.
- **Label** (Inter 600, 11px, 0.14em tracking, uppercase): column headings (TRUNK, BRANCHES), branch type (FEAT), status tags (CHECKED OUT, MERGED, DEFAULT, NEXT), stat labels, the code view's rail sections (STAGED, UNSTAGED, COMMIT MESSAGE; 0.12em there).
- **Button** (Inter 600, 11px, 0.12em tracking, uppercase): regular buttons.
- **Button Small** (Inter 500, 12px/18px, no tracking, sentence case): small toolbar buttons and toggles (Fit, Show all).
- **Ref** (JetBrains Mono 13px, 500; 600 for the current branch and `main`): branch names, refs, shipped versions on the trunk, file paths. Code view crumbs are Mono 13px.
- **Count** (JetBrains Mono 11px, 500): counts after tab and segment labels, the ahead/behind line chip, the Esc key cap. Commit author initials and ages use the same face at 400, faint.
- **Field** (Inter 12.5px/18px): text inputs and the file rows of the code view's rail (file name 500 ink, its folder 11.5px faint).
- **Code** (JetBrains Mono 12px/20px): diffs, logs, terminal.

All numbers use `font-variant-numeric: tabular-nums`. Nothing functional is set below 11px.

### Named Rules
**The One Loud Voice Rule.** Antonio is used only for screen and page titles, the welcome heading, the next release and headline numerals. Shipped versions read in Mono. Never Antonio for body, buttons, labels or branch names.

## Layout

4px grid. Shell rows: repo tab bar 40px (Settings gear cell and profile button flush at its right end), section tabs 40px (the app's six: Workspace, Pull requests, Tickets, Release notes, Submodules, Analytics; no counts), toolbar 48px. Cards pad 12px 14px (16px on the selected-branch card); rows are 32px (rail sections), 30px (rail files), 22px (floating commits) or 20px (diff lines). Map column headings (TRUNK, RELEASES & STRAIGHT TO MAIN, BRANCHES) sit 20px below the toolbar; floating commits indent 18px from their box's left edge (14px under `main`, whose box pads 14px on the left since its station sits on the trunk); trunk stations keep an even 36px pitch. Map geometry (`BranchMap.tsx`): trunk hairline at x 26, the default branch's column at x 46 and 280px wide, branch columns at 404 + 392 per level and 320px wide; boxes 28px apart within a parent, 40px between parents; floating commits start 6px under their box. On open the map keeps its own top left when the selected box shows whole from there, so the trunk stays in view; otherwise it centres the box, leaving 304px for the selected card. Gaps: 8px inside groups, 24 to 32px between groups. Density stays where it is today; the redesign changes surfaces, not layout. The agents panel docks on the right below the toolbar in both views at the app's 460px default, so the map loses that width; the mock frames are 1920x1080 so the panel plus the 288px selected card still leave the branch column clear. The code view's grid is 320px files rail | code | 460px agents panel. Phone layout (max 480px, or 900px with a coarse pointer) keeps its single pane and bottom tab bar; under 720px the map drops its title, legend and toolbar spacer, and the selected card moves above the map instead of over it.

## Elevation & Depth

Flat. Resting surfaces have no shadow: depth is the step from ground to panel to raised plus a 1px hairline. Only floating layers (menus, popovers, modals, toasts) get one shadow, `0 12px 32px -8px rgba(0,0,0,0.6)` with a hairline-strong border (light mode `0 12px 32px -8px rgba(15,20,30,0.18)`). No glows, no coloured halos, no drop-shadow filters, except the Agent Working Rule's soft g2 drop-shadow on agent-work icons.

Focus: `outline: 1px solid` ink, `outline-offset: 2px`. No blurred focus halo. The selected-branch card floats over the map but stays flat: panel plus hairline-strong border, no shadow.

## Shapes

Corners are 3px on controls, boxes, cards and inputs, 2px on status tags, check boxes, the "+" square, the line chip and the key cap, 0 on shell bars and tabs. Circles only for avatars, status dots, trunk stations and the timeline commit marks. No pills: anything that was `border-radius: 999px` becomes 3px unless it is a dot. A dashed border or line means falling behind, idle or uncommitted (falling-behind box, its link and its line chip; the 6px WIP dot).

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
- **Info row** (18px, Inter 12px muted): the branch's non-commit facts, one line. The agent state (blinking dot plus "Claude working"; a waiting agent's dot is Warn: "Codex waiting for you"); the WIP button ("WIP 2 · +48 −12": ink, Inter 500, a 6px dashed ink dot before it, Add/Delete counts in Mono 12px 500, underline on hover, opens the code); "N commits since vX · 1 release open" on the default branch; "release/x · from main · 3h ago" on a release; "no commits yet"; "idle 41 days · falling behind main" after a 12px Warn alert icon.
- **Station and "+":** an 11px ring station sits on the left border at the header row's centre (top 18px; 25px on the release box), filled with the route colour on the route. A 20px "+" square (2px corners, panel fill, hairline-strong border, muted icon; ink on hover) straddles the right edge at the header row (top 8px; 15px on the release box): always shown where lines leave and on the checked-out box, shown on hover or focus elsewhere.
- The checked-out box's border is ink; a falling-behind box's border is dashed.

### Behind line chip
Behind lives on the line, not in the box: a square chip centred on the midpoint of each incoming line whose branch is behind its parent. Ahead is not shown on the line. 18px tall, padding 0 6px, 1px hairline-strong border, 2px corners, ground fill, Count type (Mono 11px 500) in muted, reading "↓behind" in Delete. On the route its border takes the route colour and its text ink; on a falling-behind line its border is dashed. With a behind count it is a button that rebases onto the parent (ink border and text on hover); while the branch's agent works it is `aria-disabled` with a not-allowed cursor and a title saying why. Otherwise (a remote or non-work branch) it is a plain label.

### Floating commits
Commits float under their box with no container, indented 18px. Rows are 22px: subject in Inter 12px muted (ellipsis), author initials and age on the right in Mono 11px faint; the whole row turns ink on hover. Only commits float: the box's situation, agent and WIP live in its info row. The list ends with "See all N" in tracked caps (Inter 600, 11px, 0.12em, faint). Merged stations and "Clean up merged" follow on the trunk or release line below.

### Branch map route
**The Hairline Rule.** Every map line is a hairline. The route from the trunk to the checked-out branch is 1.5px in the route colour (control white, ink in light mode); every other link is a 1px Link Dim curve; a falling-behind branch's link is dashed 3/4. No thick transit lines, no hue on the route, no pulse travelling along it, no glow. A legend band under the canvas (not floating over it; ground fill, padding 8px 16px 10px, Inter 12px muted) repeats the three line styles and a one-line hint.

### Selected-branch card
Floats top right over the map (16px in), 288px wide, panel background, 1px hairline-strong border, 3px corners, 16px padding, 14px gaps, no shadow; it fades in and scrolls itself when too tall. Top: type label and the Mono 14px 600 name with a fold chevron; then status tags; then Ahead / Behind / WIP files in Display Numeral (behind in Delete). A full-width outlined "Look at the code" button with its WIP count right-aligned in Mono 11px muted; a muted 12px sentence on the branch's situation; a Parent / Origin / Ticket / Agent list (faint terms, Mono ink values right-aligned; a working Agent value flows with the rainbow). It ends with the suggested next step as a full-width primary split button (the app's label, such as "Stage & commit all", with a sparkle icon), the overflow part split off by a hairline-strong divider.

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

### Inputs
Ground fill, 1px hairline-strong border, 3px corners, Field type in ink, faint placeholder. A single line is 32px with 0 10px padding; a textarea is 64px with 8px 10px padding and no resize handle. Focus: the border turns ink (no outline).

### Agent activity
A 6px dot that blinks in two steps (1.5s, no smooth pulse) plus the words "Claude working". While the agent works, dot and words follow the Agent Working Rule. A waiting agent's dot is plain Warn with "Codex waiting for you". Under reduced motion nothing blinks or flows.

### Agents panel
The app's right agents/terminal panel, docked below the toolbar in both views, 460px wide, ground fill, 1px hairline on its left.
- **Tab bar:** 34px, panel fill, 1px bottom hairline. Tabs are Inter 12px 500 muted, padding 0 12px, a 1px hairline on their right; hover ink; the active tab is ink with an inset 2px ink bottom rule. Shell carries a 12px chevron. The session tab follows: the working dot, the branch in Mono 12px ink, then "main checkout" in faint that truncates first. After a spacer, the icon cells: 34px wide and the bar's full height, no border or radius but a 1px hairline on the left, 16px icons in Muted that never shrink (close, expand, collapse; the collapse chevron turns -90deg when the panel docks at the side).
- **Log:** padding 16px, 14px gaps, Inter 13px muted for the assistant. The user's message is ink with a 1px hairline-strong rule on its left and 12px indent. Tool rows are Mono 12px faint with a 12px file icon and Add/Delete counts. Code names inline in Mono 12px ink. Thinking is three 6px muted dots that hop 3px in four steps (1.333s, staggered), off under reduced motion.
- **Input box:** 0 16px 16px from the panel edges, 1px hairline-strong border, 3px corners, panel fill, 12px padding and gaps; the border turns ink on focus-within. Text on top: a borderless 13px textarea (faint placeholder), growing to three lines. Under it one row: attach and dictation icon buttons, the compact model picker (28px, 1px hairline-strong outline, 3px corners, Inter 12px), a spacer, then a labelled action button. While the agent works and the box is empty it is Stop: secondary shape, Delete-coloured text. Typing swaps it to the primary Queue (agent working) or Send, each with its icon and word.

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
