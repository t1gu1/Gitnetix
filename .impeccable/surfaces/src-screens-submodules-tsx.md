---
version: 1
slug: "src-screens-submodules-tsx"
primary_target: "src/screens/Submodules.tsx"
related_targets: []
---

# Surface: Submodules screen

Scope: `src/screens/Submodules.tsx` (list, detail, bulk menu, Add/Edit/Remove modals, command output, empty and loading states, phone panes), visitor mode Operate. Developers open it when a submodule is out of step: they see which ones need them, why, and fix each with one action, or update all at once. Every feature stays: All/Needs you filter, check remotes, add, update all, pull latest for all, sync all URLs, per submodule update/clone, pull latest, sync URL, pin this commit, back to pin, edit URL or branch, open as project, view repository, copy URL, remove, command output.

## Direction contract

THESIS: A submodule is three commits on one line (pinned, checked out, remote tip), and every action sits on the station it moves the submodule to. Refuses the key-value grid with a row of seven equal buttons and stacked coloured callout cards.

OWN-WORLD: The app's Black & White slate world unchanged: hairlines, ink selection, white primary, status rings (green only for Up to date, red for Conflict, amber for Off its pin, URL out of sync and uncommitted files), no side bars on boxes, mono only for paths, SHAs and URLs.

STORY: The user sees Needs you first, picks a row, reads the diagram (how far the checkout is from the pin and the remote), presses the button under the station they want, and reads the command output under it.

FIRST VIEWPORT: Toolbar (SUBMODULES title, project and count, All/Needs you, remotes checked time, check remotes, Add submodule, Update all split primary). Left rail 400px of two-line rows grouped Needs you / Up to date. Detail up to 1180px: mono path title with status tag, the pin diagram panel with three stations and their buttons, notes, Details kv beside Last commit checked out, Last command output.

FORM: Pin diagram, position 4 of 7 on the ordered list; seed:210751626d06b529. Signature move: actions under the diagram stations. Mock: .impeccable/mocks/submodules.html (frame A); refinement in .impeccable/mocks/submodules-2.html.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Owner decisions (2026-11-21)

- Direction A, Pin diagram, chosen over B, Pin lines.
- Refine the mock (phone, light theme, empty and loading states, modals) before any app code.
