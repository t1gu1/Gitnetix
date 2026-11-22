---
version: 1
slug: "src-components-ui-tsx"
primary_target: "src/components/ui.tsx"
related_targets: ["src/styles/app.css","src/screens/NewItem.tsx","src/screens/Workspace.tsx"]
---

# Modals (every dialog through `Modal` / `Confirm`)

Scope: Operate. Every dialog the app opens: create (branch, release, tag, PR, agent session, profile), act with options (merge, rebase, target, force push, reset, publish), confirm a loss (delete, drop, discard, abort), ask (sign in, fork, consent, update), running work (AI rebase), viewers (file peek, images, legend).

Audience and task: developers mid-flow who opened the dialog from the map or a menu, read what it will do, adjust one or two options and confirm, then go back to code. Frequent; most opens are confirmed with defaults.

Owner decisions (2026-11-22): direction A of `.impeccable/mocks/modals-a.html` (route sheet), destructive confirm buttons filled red, no git command shown (plain sentences only).

## Direction contract

THESIS: A dialog shows the operation before its form: what moves where, then the stops it runs, in order. It refuses the stacked label-above form with an explanatory paragraph and equal-width footer buttons.

OWN-WORLD: The shipped Black & White slate: panel on hairlines, 3px radius, no shadow, Inter 15/600 titles, mono refs. A head route (hairline, solid 9px station for what exists, hollow station for what will exist, red station and line for what is lost, a small Inter label on the line). Labelled rows (100px muted label column, room for "Repository URL" on one line, hairline between rows). A stop list: hairline rail, 7px ink squares for fixed steps, checkboxes on the rail for optional ones.

STORY: The visitor reads the route, sees every consequence as a stop before confirming, and confirms with one white primary (filled red when it destroys work).

FIRST VIEWPORT: Head: title row with icon actions, route below, hairline. Body: labelled rows. Foot: a faint note at the left (Ctrl/⌘ ↵ and its verb where the primary takes it, or what cannot be undone), Back then the primary at natural width on the right.

FORM: Direction A of two (route sheet), chosen over a right-docked sheet. seed: none (pinned) "A: 1. A, fenêtre centrée avec ligne de route".

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
