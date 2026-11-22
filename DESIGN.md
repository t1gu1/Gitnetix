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
  switch:
    backgroundColor: "transparent"
    textColor: "{colors.faint}"
    rounded: "{rounded.md}"
    width: "28px"
    height: "16px"
  switch-on:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
    rounded: "{rounded.md}"
    width: "28px"
    height: "16px"
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
  modal:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    width: "560px"
  modal-head:
    padding: "16px 14px 14px 20px"
  modal-body:
    padding: "16px 20px 20px"
  modal-foot:
    padding: "12px 16px 12px 20px"
  modal-hint:
    textColor: "{colors.faint}"
    typography: "{typography.meta}"
  route-station:
    backgroundColor: "{colors.ink}"
    rounded: "{rounded.circle}"
    size: "9px"
  route-station-lost:
    backgroundColor: "{colors.delete}"
    rounded: "{rounded.circle}"
    size: "9px"
  route-name:
    textColor: "{colors.ink}"
  modal-row-label:
    textColor: "{colors.muted}"
    typography: "{typography.meta}"
    width: "100px"
  stop:
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    height: "32px"
  stop-fixed-mark:
    backgroundColor: "{colors.ink}"
    rounded: "{rounded.none}"
    size: "7px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.delete}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "30px"
  button-danger-filled:
    backgroundColor: "{colors.delete}"
    textColor: "{colors.panel}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "30px"
  settings-box:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.md}"
  settings-row:
    textColor: "{colors.muted}"
    typography: "{typography.body}"
    height: "30px"
  settings-value:
    textColor: "{colors.ink}"
    typography: "{typography.body-strong}"
    rounded: "{rounded.sm}"
    padding: "2px 6px"
  theme-tile:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.muted}"
    rounded: "{rounded.md}"
    height: "92px"
  anim-card:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
  effort-pip:
    backgroundColor: "transparent"
    rounded: "1px"
    size: "6px 10px"
  effort-pip-on:
    backgroundColor: "{colors.ink}"
    rounded: "1px"
    size: "6px 10px"
---

# Design System: Gitnetix

<!-- impeccable:design-map -->
Name: Gitnetix
Colors: primary: control #f2f5f8; neutral: ground #0a0d12; status: add #5fd39a; agent-working: working-amber #f7c48a; primary: light-control #0b0f14; neutral: ground-top #0f151d (+34 more in the frontmatter)
Fonts: Antonio (display, display-title, display-numeral, page-title, hero-title); Inter (body, body-strong, meta, label, button, button-small, field, ticket-title, reading, dialog titles 15px 600); JetBrains Mono (ref, count, code)
Spacing: xs 4px, sm 8px, md 12px, lg 16px, xl 24px, 2xl 32px
Radius: none 0px, sm 2px, md 3px, circle 50%
Rules:
- The Control Rule. Ink (`--fg`) means "this is yours": selection, the active tab, segment and tag, check fills and focus, in every theme; `--accent` marks controls only (white in Black & White).
- The Meaning Rule. Branch type, trunk, release, props and people carry no hue; a hue answers added, deleted, warning or conflict, or is the Agent Working rainbow.
- The Agent Working Rule. Anything an agent is working on flows with the incumbent rainbow (`--g1` to `--g4`), and nothing else may, except a skill called in a prompt box; this includes the current commit's station in the AI rebase dialog. A waiting agent is Warn.
- The Theme Rule. Black & White is the default and what System follows; the other 36 themes keep their own ground, panel, text and accent, get the derived steps mixed from their colours, and take the same shapes, type, hairlines and map structure.
- The One Loud Voice Rule. Antonio is used only for screen and page titles, the welcome heading, the next release, headline numerals and the current theme's name on Appearance; dialog titles are Inter 15px 600.
- The Hairline Rule. Every map line is a hairline: 1.5px route, 1px other links, dashed 3/4 when falling behind.
- The Mono Rule. Mono is for what a machine hands back: paths, SHAs, refs, URLs and code, plus the Count role's tabular numbers and key caps; plain words (menu hints, captions, route labels) are Inter.
- The Station Action Rule. On a station line each action sits under the stop it moves the subject to, and exactly one white primary goes on the stop that fixes the state.
- The Route Rule. A dialog shows the operation before its form: the route of what moves where in its head, the steps it runs as stops, then labelled rows, and exactly one loud control, last in the footer.
Don't:
- Don't use gradient text, glows, coloured halos or drop-shadow filters, except the rainbow on agent work and called skills under the Agent Working Rule.
- Don't use the working hues for anything but an agent working; a waiting agent is Warn.
- Don't use pills (999px radius) or radii above 3px on rectangles.
- Don't give branch types, roles or sections their own hue.
- Don't use spring or bounce easing; motion is short ease-out, under 200ms.
- Don't put a shadow on a resting surface or on a modal; a modal is a hairline panel over the scrim.
- Don't set functional text below 11px.
- Don't draw thick transit lines or a coloured route on the branch map.
- Don't put commits inside a branch box or wrap them in a card on the map.
- Don't put a coloured side bar on a box, note or callout; a note is a hairline row with a leading icon.
- Don't stretch dialog footer buttons to equal widths or stack field labels above their controls in a dialog, except on phones.
- Don't fill a red button anywhere but the last place in a dialog footer; elsewhere destructive stays the outline with red text.
Do:
- Do use ink for selection and focus in every theme, and `--accent` only for controls.
- Do show a disabled primary as the outline with a faint label.
- Do draw a dialog's operation as a route under its title (solid station for what exists, hollow for what will, red and struck for what is lost, dashed line for not yet), its steps as stops, and its form as labelled rows with a 100px label column.
- Do end a dialog footer with a faint note at the left and Back then one loud control at natural width on the right.
- (+14 more in the full file)
Map: src/lib/themes.ts
Map: src/components/ui.tsx
Map: src/components/Sheet.tsx
Map: .impeccable/mocks/slate-direction.html
Map: .impeccable/mocks/modals-a.html
Full: .impeccable/design-full.md (read a section when you need its detail)
