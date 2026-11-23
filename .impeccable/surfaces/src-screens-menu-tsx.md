---
version: 1
slug: "src-screens-menu-tsx"
primary_target: "src/screens/Menu.tsx"
related_targets: ["src/styles/app.css", "src/components/Sheet.tsx", "src/screens/Settings.tsx", "src/screens/AISetup.tsx", "src/screens/Templates.tsx", "src/screens/Connections.tsx", "src/screens/WorktreePaths.tsx", "src/screens/Logs.tsx", "src/components/BranchTypes.tsx"]
---

# Surface: Settings panel (Menu home)

Scope: the settings panel's home view (`src/screens/Menu.tsx` root view, styles in `src/styles/app.css`), visitor mode Operate. Developers open it from the profile button to change how one project or the whole app behaves, then go back to work. Since 2026-11-22 the pages it opens (`SettingsPage` in Menu.tsx) are in scope too: they sit on the same ground, in the same width, built from the same boxes and rows (`src/components/Sheet.tsx`).

## Direction contract

THESIS: Settings as a spec sheet: every setting and its current value readable at once, changed in place. Refuses the incumbent's mix of a long project scroll beside drill-in rows that open nearly empty pages.

OWN-WORLD: The app's Black & White slate world unchanged: ground behind, panel-coloured boxes with 1px line2 hairlines, 3px corners, ink for "yours" (switch fill, segment). Short muted labels, values in fg 500, wide-tracked caps group labels, mono only for paths, prefixes and keys. Switches are new: checkbox corners, square knob, hard snap.

STORY: The user sees who they are and how to reach Gitnetix from the phone, then scans the open project's settings and the app's, flips a switch or picks a value from a menu under it, hovers a short label for its full sentence, and opens a page only for lists (branch types, worktree files, shortcuts, AI, connections).

FIRST VIEWPORT: Profile card (avatar, name with Edit / Duplicate / Delete at top right, identity, note, other profiles) beside the phone card (QR, address, token). Below: the project box over two columns (AI writes in, Merging, Committing, Pictures & HTML | New branches & worktrees, Branch types, Worktree files, Releases & deleting) beside a stacked App box and AI & connections box, all ending on one line. Under them a bottom row: Remove the project, Logs.

FORM: seed: none (pinned) — the owner picked mock "F1 · Boxes" (`.impeccable/mocks/settings/settings-mocks-3.html`) on 2026-11-22 after rounds A–C, D–G and F1–F3: "A: 1. F1, boxes; B: 1. Short labels, full sentence on hover; C: 1. Yes, bottom row", switches over checkboxes, the big profile card kept, the phone card on the first page.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Owner decisions (2026-11-22)

- Switches for on/off settings; the big profile card stays, actions top right beside the name; "Gitnetix on your phone" on the first page.
- Spec sheet framing F1: a box per scope; Remove and Logs in a row under the boxes.
- Short labels with the full sentence on hover.
- After the build: DESIGN.md gains the Switch and the settings sheet (box, row, value); on a touch screen a row's full sentence prints only when it adds words (`restates` rows skip it); the panel header is SETTINGS in Display Title with the version.

## Sub-pages (owner decisions 2026-11-22)

- Mocks: `.impeccable/mocks/settings-subpages/<id>.html`, three per page in three families: A · Sheet (the home's boxes and short-label rows), B · Split (list left, detail right), C · Preview (the result first).
- Picks: Appearance C (the theme on screen drawn large, then every theme drawn as the app), Animations C (each animation playing in its own small stage, with its switch); every other page A: Voice dictation, Shortcuts, AI setup, Templates, Git providers, Ticket trackers, Companion & MCP, Worktrees, Worktree files, Branch types, Logs.
- A page under a page opens in place with its own name in the header: a provider of AI setup (`ai:<provider>`), a template's editor (`templates:<id>`).
- Built with real data only: rows the mocks invented (accounts, counts, project paths) are left out; the log file's size needs an RPC and is not shown.
- Hooks (2026-11-23): picked B · Split from `.impeccable/mocks/settings-subpages/hooks.html` (rounds A Sheet, B Split, C Preview). Per project only, opened from the project box's Hooks row. The moments on the left with their last run; the picked one on the right: where and when it runs, Stop or Keep going, one field per command, variables to click in, the last run's output. Commands run alongside, output in the Logs; worktree removed is the one Gitnetix waits for.
