---
version: 1
slug: "src-screens-tickets-tsx"
primary_target: "src/screens/Tickets.tsx"
related_targets: []
---

# Surface: Tickets screen

Scope: `src/screens/Tickets.tsx` (list, reader, work margin, empty and loading states, phone panes), visitor mode Operate. Developers glance at their sprint tickets between coding, pick the next one, start a branch from it, plan tickets into releases, and check where a ticket stands. Every tracker feature stays: trackers menu, Mine/Everyone, active sprint or cycle, group by status or release, search, sync, AI triage, status, priority, type, labels, fix versions, release, start a branch, go to branch, pull requests, description, criteria, files, comments and Linear replies.

## Direction contract

THESIS: The ticket reads like a page, and its way to a release is drawn as a station line beside it. Refuses the tracker-clone list of three-line cards with a field grid and stacked filter rows.

OWN-WORLD: The app's Black & White slate world unchanged: hairlines, ink selection, white primary, grey status rings (green only for Ready and Done), red/amber only for urgent/high priority, rainbow only on a branch an agent is working on. Ticket types and labels are text, never hue.

STORY: The user scans one-line keys, sees who owns each ticket when Everyone is on, opens one, reads it in a calm column, and acts from the margin: Start a branch, Go to branch, Open pull request, accept the AI release.

FIRST VIEWPORT: Toolbar (TICKETS title, trackers menu, Mine/Everyone, sprint toggle, group segment, search, sync, Triage). Left rail ~400px of one-line rows: status ring, key, title, priority, and under Everyone the assignee's avatar alone, full name in its tooltip (two lines a row on a phone). Centre: 1180px reading column with title, field menus, description, open hairline criteria, files, open comment threads. Right 420px margin: vertical work line (ticket, branch, pull request, release, shipped), white up to where the ticket stands, the next action on its station, then release and planning fields.

FORM: Focus reader, position 5 of 7 on the ordered list; seed:86a1bea67719426d. Signature move: the vertical work line in the margin. Approved refined mock: .impeccable/mocks/tickets-focus-reader.html. Under 1000px of detail pane the margin narrows to 320px; under 760px (phones) the reader stacks with the work line under the fields, as the pull request phone view does.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Owner decisions (2026-11-21)

- Direction A, Focus reader, chosen over Triage table and Ticket line.
- Jira type colour dots dropped; type shows as text.
- With Everyone on, every ticket shows who it is assigned to.
- Refine the mock (phone, light theme, empty and loading states) before any app code.
- Third answer: build it into the app; under Everyone, rows show only the assignee's avatar, the full name in its hover tooltip (supersedes the mock's avatar plus first name); fetch the ticket's dates from each tracker (opened when, by whom, in its status since when) through `tickets.activity`.
- Pull request station: the PR number only from the list the Pull requests screen already loaded; Tickets never calls prs.list (it can prompt a GitHub sign-in). The mock's "N tickets planned" line is left out (the list is filtered).
- Reading column widened from 620px to 1180px at the owner's request (2026-11-21), so a ticket's pictures and code blocks get the room.
