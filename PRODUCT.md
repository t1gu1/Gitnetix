# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Desktop app in a Tauri 2 shell (macOS, Windows, Linux); the same React UI also runs in a browser and on a paired phone through the companion server.

## Users

Developers who run many release, feature and fix branches at once, often in separate worktrees, with an AI agent (Claude Code, Codex, Gemini, Copilot, Ollama) working on several of them in parallel. The app stays open all day next to their editor and terminal; they glance at it, act, and go back to code. They also check on and drive it from their phone.

## Product Purpose

A Git client with no commit graph. It shows work as branches, releases and agents instead of commits, and turns release chores (cutting `release/x.y.z`, tagging, changelog, publishing) into one action. Success: the user knows at a glance what every branch is, where it stands against its parent and release, and what each agent is doing, without reading history.

## Positioning

"See your work, not your commits." Branches on a map inferred from intent (parent detection, release sections, falling behind, shipped, likely merged), releases as a button, an agent on every branch. Neighbouring Git clients center the commit graph; Gitnetix does not have one. Commits appear only inside the branch or release they belong to, never as a global graph.

## Operating Context

- Project tabs, in order: Workspace, Pull requests, Tickets, Release notes, Submodules, Analytics.
- Workspace is the branch map (since 0.23.0 it replaced the branch tree): one column per nesting level, `main` and releases as trunk, shipped releases listed above the trunk and unfolding into the commits they shipped. Each tile lists its 4 newest commits with "See all". Filters for person, merged, falling behind and shipped; search across branch names, tag names and commit subjects; zoom at pointer and drag to pan. Selecting a branch opens its card (suggested action as a split button) and a focus view with a files panel (WIP, Branch, Project) and code. A terminal / agent run panel docks on the right on wide screens.
- Branch actions from the map: rebase (also in a temporary worktree for branches checked out nowhere), stage & commit all, publish, create tag & update changelog, finish and merge for worktrees, delete (switches to the parent first when checked out).
- Pull requests: diffs read from the local clone, line comments pinned to the diffed commit, on GitHub, GitLab, Azure DevOps, Bitbucket and Gitea.
- Tickets: Jira, Trello, Asana, Linear and GitHub issues, with comment threads, files, priority, and editable priority/type/labels on Jira and Linear.
- Analytics, with Sprints and Weekly views when a tracker is connected.
- Also: worktrees, stash, file history (author avatar over the line number, click to the commit), logs, templates, settings, onboarding (theme, then required Agent setup), phone pairing by QR code.
- Agents: a signed-in agent CLI is required (`claude`, `codex`, `agy`, `copilot` or `ollama`); runs have permission modes (Bypass by default) and in-chat Allow / Refuse cards.
- AI writes commit messages, branch names, PR descriptions, release notes, conflict resolutions and ticket triage from editable templates with per-task model routing.
- Every client (desktop, phone/browser, MCP agents) goes through one RPC surface (`crates/core/src/rpc.rs`).

## Capabilities and Constraints

- Frontend: React 19 + Vite, one stylesheet `src/styles/app.css`, theme tokens applied from `src/lib/themes.ts`.
- 36 color themes must all keep working: Gitnetix Dark/Light plus the Tokyo Night, Catppuccin, Rosé Pine, Dracula, Night Owl, Nord, Ayu, Everforest, Kanagawa and Gruvbox families. The app's colors are mixed from each theme's surfaces, text and accent. Default theme for new users is Tokyo Night Storm.
- Branch types (`src/lib/kinds.ts`: feat, fix, refactor, perf, style, test, docs, chore, ci, a11y, build, poc, release) are user-configurable per project; an unlisted prefix such as `wip/` joins the list.
- Must stay usable at phone width: under 900 px the layout is single-pane with a bottom tab bar.
- Desktop runs on WebKitGTK on Linux (bundled 2.50.4 in the AppImage); rendering cost there matters for animations, shadows and blur.
- Branch view results are cached by `VIEW_CACHE_VERSION` (`crates/core/src/app.rs`).

## Brand Commitments

- Name: Gitnetix. Tagline: "See your work, not your commits."
- Logo: gold faceted "G" (`gitnetix-logo.jpg`, `src/lib/logo.ts`) stays. The UI accent color is not bound to the logo's gold.
- Redesign direction from the owner (2026-11-18): modern and clean; less multi-colored, less rounded; current look reads as generic. Keep every view and what it does; replace the visual signature.
- Branch type reads by its label, not by its own hue. Color is reserved for meaning (added, deleted, warning, selection, status).

## Evidence on Hand

- Marketing screenshots: `website/public/og.png` (desktop branch map) and `website/public/phone.jpg` (mobile layout), both refreshed 2026-11-18.
- Product writing: `CHANGELOG.md` (most current), `README.md`, `website_idea/why-gitnetix.md`, `website_idea/design-brief.md`. README and `website_idea/` still describe a branch tree; the map replaced it in 0.23.0, so prefer the CHANGELOG where they disagree.
- No testimonials, user counts or benchmarks exist; do not invent them.

## Product Principles

- Intent over history: show what work is and where it stands, never raw commit topology.
- Glanceable: the state of every branch and agent readable in one look from beside an editor.
- One action per chore: releases, tags and changelogs are buttons, with git's safety kept (nothing pushed half-done).
- Same product everywhere: desktop, browser, phone and MCP agents share one surface.
- The user's colors: any of the supported themes must look intentional, not just tolerated.

## Accessibility & Inclusion

- Text and controls meet WCAG AA contrast in every shipped theme.
- No other formal standard is set.
