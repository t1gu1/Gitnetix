---
version: 1
slug: "src-screens-analytics-tsx"
primary_target: "src/screens/Analytics.tsx"
related_targets: ["src/screens/Sprints.tsx","src/screens/Weekly.tsx"]
---

# Surface: Analytics screen

Scope: `src/screens/Analytics.tsx` with its tickets views `src/screens/Sprints.tsx` (Jira sprints) and `src/screens/Weekly.tsx` (tickets done per week, any tracker), visitor mode Operate. Developers and leads check how a project moves: commits per day, releases and their lead time, how the running sprint goes, who finished what. Every existing feature stays: project and people pickers, time ranges, Commits and tickets tabs, Sprints and Weekly views, board, unit, sprints and weeks shown, sync, Ask AI, CSV export and table views, day and release details, ticket keys linking to their sprint, at-risk tickets, burndown, velocity, hours left over, completion per person, makeup, start to done, done per week, per person and per label.

## Direction contract

THESIS: A rail of things you can pick, each row carrying its own bar, and the pick's whole story inline beside it. Refuses the dashboard of KPI boxes and stacked chart cards with modals for details.

OWN-WORLD: The app's Black & White slate world unchanged: hairlines, ink for the pick, grey for the rest, white primary, Antonio only for headline numerals and the page title, mono for counts and refs. No series hues: green only for on track and done rings, amber only for at risk, red only for an error. Release tags drawn as the map's hairline stations.

STORY: The user scans the rail (days and releases, sprints, or weeks), sees the shape of the period from the bars alone, picks one, and reads who did what in it without a modal; from there they open a commit's ticket, a sprint's at-risk ticket, or the day in the workspace.

FIRST VIEWPORT: One toolbar row (ANALYTICS title, Commits/tracker segment, project, range or sprint controls, people, sync, Ask, Export). Left rail 380px on the ground panel: rows with inline bars, the pick in sel ink. Right: a hairline figures strip (Antonio 40px numerals, no boxes), the period chart with the pick in ink and release stations, then the pick's detail (a day's commits by person and kind; a sprint's pace, meters, burndown, people and tickets; a week's people, labels and tickets).

FORM: Rail (master-detail), position 3 of 6 on the ordered list; seed:31a18d1d31111f59. Signature move: the rail doubles as the chart (sprint rows are the velocity chart with the average marked on each). Phones: the rail is the first pane, a pick slides to the detail with a back row, as the Tickets and Pull requests phone views do.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Owner decisions (2026-11-21)

- Mock A, Rail, chosen over Instrument (one big chart and readout) and Matrix (people by time). Mocks: .impeccable/mocks/analytics-1.html, -2, -3.
- Refine the mock first: Weekly view, phone layout, empty and loading states, before any app code.
- 2026-11-21 round 2, refined mock .impeccable/mocks/analytics-rail.html: Weekly view (rail of weeks with the average marked, slow and running weeks named; a week's people with their 12-week strip, labels over all weeks, tickets done; an unanswered tracker as a one-line banner), states (loading skeleton, no commits in range with longer-range and everyone actions, no tracker connected, tracker refused with Sign in again and Retry), phones (rail as the first pane under compact figures and the chart, a pick opens its detail with a back row, Analytics under More).
- 2026-11-21 round 2 approved as shown: the owner answered "Yes, as shown" to the refined mock .impeccable/mocks/analytics-rail.html and asked to build it into the app (Analytics, Sprints and Weekly screens).
- 2026-11-21 build: deeper sprint charts (makeup, hours left over, velocity and bugs, start to done, completion heat, the full ticket table as "Ticket details") stay below the new top part, unboxed, so no feature is lost. A day's "Open in the workspace" became per-commit branch links (a day spans many branches). Sprint series are ink steps of --fg.
- 2026-11-21 after the finish review (ship): owner wants both a day-level "Open in the workspace" button (the release branch of a version tagged that day, else the branch with the most commits; built) and the per-branch links; keeps the sprint page's unscored differences as built (Completion so far figure, pace wording, burndown fill and behind band, RUNNING tag, On track apart from the burndown's ahead chip); website demo to be synced to the new layout.
