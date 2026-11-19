---
version: 1
slug: "src-styles-app-css"
primary_target: "src/styles/app.css"
related_targets: ["src/lib/themes.ts"]
---

# Surface: Gitnetix app UI (all screens)

Scope: the whole React app (`src/`), visitor mode Operate. Developers keep it open beside their editor; they glance, read branch and agent state, act, return to code. Every view and behaviour stays; only the visual signature changes. All 36 themes must keep working through the token layer (`src/lib/themes.ts` tokens()). Out of scope: the marketing website and its demo.

## Direction contract

THESIS: A slate night where the branch map reads as a line diagram: one hairline trunk carries the releases as stations, branches hang off it as small boxed headers, and their commits float free beneath them. Refuses the category's commit graph, grey-panels-plus-indigo, and the incumbent's rainbow of per-role hues, pills and glows.

OWN-WORLD: Ground slate-to-black, panels one step up, 1px cool hairlines; bone-white text over slate muted tones. Controls are white: solid white primary with ink text, 1px outline secondary. Radii 2 to 3px; circles only for avatars, dots and stations. Hue only for meaning: add, delete, warning, conflict, and the incumbent's flowing rainbow (gradient text, soft glow, colour-cycling dot) on anything an agent is working on. Antonio for screen titles, the next release and headline numerals; Inter for UI; JetBrains Mono for refs and versions; labels in wide-tracked caps.

STORY: From beside the editor the user reads down the trunk to see what shipped, follows the white route to where they are, and reads each branch's latest commits without opening anything; one white button does the suggested next step.

FIRST VIEWPORT: Branch map. Repo tabs, then six section tabs (white underline on Workspace). Toolbar: "Branch map" title, Everyone/Mine segment, Merged / Falling behind + Clean up / Shipped check toggles, search, fetch, zoom. Left: a vertical hairline trunk, shipped versions as ring stations top to bottom, `main` as the large station where the white route starts, merged branches as small stations below it on the same line. Middle: next release as a boxed header with an Antonio numeral, then straight-to-main branches. Right of it: branches. Every box holds a header row (type, mono name, tags) and one info row (WIP, agent state, commits since tag, idle), with a station ring on its left edge and "+" on its right; only commits float under it. Ahead/behind is a small square chip at the midpoint of the incoming line, the rebase button when behind (disabled while an agent works). Code view: the app's focus head (back, crumbs, status) and files rail (WIP/Branch/Project, staged/unstaged, commit box). Checked-out route drawn white, others slate, falling-behind dashed. Selected-branch card top right of the map: Antonio ahead/behind/WIP numerals, the suggested action as a white split button. The agents panel docks on the right below the toolbar (Agent/Shell tabs, session, log, input), as in the app on wide screens.

FORM: seed: none (pinned) — the owner, 2026-11-19: "I want the design generated here by impeccable: http://localhost:5480/.impeccable/mocks/slate-direction.html to be implemented!" The mock pins the world and the first surface; it was built from the loved references ("I Very very love the style of the workspace.png but i very love the vertical line with the releases tags at the starting point and the commits floating in the void undeer the branch of the image vertical-trunk-for-tags-and-floating-commits-are-nice.png"). Signature move: the trunk as a station line. Merge choices confirmed: hairlines everywhere; boxed header, floating commits. Motion is a hard snap, no spring or bounce.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Owner decisions (2026-11-18)

- Theme: the redesign ships as a new theme beside the existing Gitnetix Dark/Light, which stay as they are. This overrides IMPLEMENTATION.md section 1's "replace `:root` / `[data-theme="light"]` values". (Its name and the default theme were settled on 2026-11-19, below.)
- Third-party themes keep their own accent as control colour; per-role hues (trunk, release, prop, mod) go neutral in every theme.
- Charts (Analytics, Sprints): restrained series palette; Sprints status blocks become a single-hue ramp.
- Process: iterate on the mock (`.impeccable/mocks/slate-direction.html`) with live variants before any app code changes.

## Owner decisions (2026-11-19)

- Build (implementation round): the mock's colours ship as a dark + light theme pair, "Gitnetix Black & White" and "Gitnetix Black & White Light" (one family, the light/dark toggle stays inside it). It is the default for new users and what "System" follows. Every other theme (Gitnetix Dark/Light and the third-party ones) keeps its palette but takes the new design rules: shapes, type, hairlines, map structure, no role hues.
- Loved references live in `.impeccable/loved-reference/`: `workspace.png` (the slate style), `vertical-trunk-for-tags-and-floating-commits-are-nice.png` (trunk + floating commits; its red route is not adopted), `code-diff-pannel.png` (focus view).
- Map lines: hairlines everywhere, no thick transit lines. Boxes: header row plus one info row; only commits float below.
- Round 3: the incumbent's rainbow "agent working" effect stays wherever the app shows it (map agent state, card, focus pills, panel session dot, repo tab dot, Worktrees & agents icon); it is the only part of the old look the owner keeps. The app's right agents/terminal panel is in the mock, adapted to this design; frames are 1920x1080 so the docked panel (the app's 460px default) leaves the map room.
- Round 2: WIP, agent state and other non-commit info move into the box; ahead/behind moves to a chip on the incoming line, as the app places its behind chip; the code view's left panel keeps the app's rail content and buttons in the new style.
